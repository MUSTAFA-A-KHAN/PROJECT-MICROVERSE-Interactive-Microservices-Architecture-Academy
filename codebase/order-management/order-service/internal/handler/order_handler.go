// Package handler is the HTTP transport layer of the Order Service.
package handler

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/gin-gonic/gin"
	"github.com/sony/gobreaker/v2"

	"github.com/microverse/order-management/order-service/internal/middleware"
	"github.com/microverse/order-management/order-service/internal/model"
	"github.com/microverse/order-management/order-service/internal/reqctx"
	"github.com/microverse/order-management/order-service/internal/service"
)

// Service is the subset of the order service the handlers call.
type Service interface {
	CreateOrder(ctx context.Context, in service.CreateOrderInput) (*model.Order, bool, error)
	GetOrder(ctx context.Context, userID, orderID int64) (*model.Order, error)
	ListOrders(ctx context.Context, userID int64, limit int, beforeID int64) ([]model.Order, error)
	CancelOrder(ctx context.Context, userID, orderID int64) (*model.Order, error)
	UpdateStatus(ctx context.Context, orderID int64, to model.Status) (*model.Order, error)
}

// OrderHandler serves /v1/orders.
type OrderHandler struct {
	svc Service
	log *slog.Logger
}

// NewOrderHandler returns a handler backed by svc.
func NewOrderHandler(svc Service, log *slog.Logger) *OrderHandler {
	return &OrderHandler{svc: svc, log: log}
}

// Routes registers the endpoints. Every route requires the identity headers
// injected by the gateway.
func (h *OrderHandler) Routes(r *gin.Engine) {
	v1 := r.Group("/v1/orders", middleware.RequireUserID())
	v1.POST("", h.Create)
	v1.GET("", h.List)
	v1.GET("/:id", h.Get)
	v1.POST("/:id/cancel", h.Cancel)
	v1.PATCH("/:id/status", middleware.RequireRole("admin"), h.UpdateStatus)
}

type createOrderRequest struct {
	Currency string `json:"currency" binding:"required,len=3"`
	Items    []struct {
		ProductID      string `json:"product_id" binding:"required,max=64"`
		Quantity       int    `json:"quantity" binding:"required,min=1,max=1000"`
		UnitPriceCents int64  `json:"unit_price_cents" binding:"min=0"`
	} `json:"items" binding:"required,min=1,max=50,dive"`
}

// Create handles POST /v1/orders. An Idempotency-Key header is mandatory so
// that clients can retry safely after a timeout.
func (h *OrderHandler) Create(c *gin.Context) {
	key := c.GetHeader("Idempotency-Key")
	if key == "" || len(key) > 128 {
		problem(c, http.StatusBadRequest, "Idempotency-Key header required",
			"send a unique value (for example a UUID) per logical order and reuse it on retries")
		return
	}
	var req createOrderRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		problem(c, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}
	items := make([]model.Item, len(req.Items))
	for i, it := range req.Items {
		items[i] = model.Item{ProductID: it.ProductID, Quantity: it.Quantity, UnitPriceCents: it.UnitPriceCents}
	}

	order, replayed, err := h.svc.CreateOrder(c.Request.Context(), service.CreateOrderInput{
		UserID: middleware.UserID(c), IdempotencyKey: key, Currency: req.Currency, Items: items,
	})
	if err != nil {
		h.fail(c, err)
		return
	}
	if replayed {
		c.Header("Idempotent-Replayed", "true")
	}
	c.Header("Location", fmt.Sprintf("/v1/orders/%d", order.ID))
	c.JSON(http.StatusCreated, order)
}

// Get handles GET /v1/orders/:id.
func (h *OrderHandler) Get(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	o, err := h.svc.GetOrder(c.Request.Context(), middleware.UserID(c), id)
	if err != nil {
		h.fail(c, err)
		return
	}
	c.JSON(http.StatusOK, o)
}

// List handles GET /v1/orders?limit=20&before=123 (keyset pagination).
func (h *OrderHandler) List(c *gin.Context) {
	limit, _ := strconv.Atoi(c.DefaultQuery("limit", "20"))
	before, _ := strconv.ParseInt(c.Query("before"), 10, 64)
	orders, err := h.svc.ListOrders(c.Request.Context(), middleware.UserID(c), limit, before)
	if err != nil {
		h.fail(c, err)
		return
	}
	resp := gin.H{"orders": orders}
	if n := len(orders); n > 0 {
		resp["next_before"] = orders[n-1].ID
	}
	c.JSON(http.StatusOK, resp)
}

// Cancel handles POST /v1/orders/:id/cancel.
func (h *OrderHandler) Cancel(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	o, err := h.svc.CancelOrder(c.Request.Context(), middleware.UserID(c), id)
	if err != nil {
		h.fail(c, err)
		return
	}
	c.JSON(http.StatusOK, o)
}

// UpdateStatus handles PATCH /v1/orders/:id/status (admin only).
func (h *OrderHandler) UpdateStatus(c *gin.Context) {
	id, ok := pathID(c)
	if !ok {
		return
	}
	var req struct {
		Status model.Status `json:"status" binding:"required"`
	}
	if err := c.ShouldBindJSON(&req); err != nil {
		problem(c, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}
	o, err := h.svc.UpdateStatus(c.Request.Context(), id, req.Status)
	if err != nil {
		h.fail(c, err)
		return
	}
	c.JSON(http.StatusOK, o)
}

func pathID(c *gin.Context) (int64, bool) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		problem(c, http.StatusBadRequest, "Invalid order id", "id must be a positive integer")
		return 0, false
	}
	return id, true
}

// fail maps domain errors to HTTP responses.
func (h *OrderHandler) fail(c *gin.Context, err error) {
	ctx := c.Request.Context()
	l := reqctx.Logger(ctx, h.log)
	switch {
	case errors.Is(err, model.ErrValidation):
		problem(c, http.StatusUnprocessableEntity, "Validation failed", err.Error())
	case errors.Is(err, model.ErrNotFound):
		problem(c, http.StatusNotFound, "Order not found", "")
	case errors.Is(err, model.ErrInvalidTransition):
		problem(c, http.StatusConflict, "Invalid status transition", err.Error())
	case errors.Is(err, model.ErrConcurrentUpdate):
		problem(c, http.StatusConflict, "Order was modified concurrently", "reload the order and retry")
	case errors.Is(err, model.ErrIdempotencyMismatch):
		problem(c, http.StatusUnprocessableEntity, "Idempotency key reused", "this key was already used with a different request body")
	case errors.Is(err, model.ErrCustomerInactive):
		problem(c, http.StatusForbidden, "Account cannot place orders", "")
	case errors.Is(err, gobreaker.ErrOpenState), errors.Is(err, gobreaker.ErrTooManyRequests):
		l.WarnContext(ctx, "dependency circuit open", "err", err)
		c.Header("Retry-After", "30")
		problem(c, http.StatusServiceUnavailable, "Service temporarily unavailable", "a dependency is failing; retry later")
	case errors.Is(err, model.ErrDependencyUnavailable), errors.Is(err, context.DeadlineExceeded):
		l.WarnContext(ctx, "dependency unavailable", "err", err)
		c.Header("Retry-After", "5")
		problem(c, http.StatusServiceUnavailable, "Service temporarily unavailable", "")
	default:
		l.ErrorContext(ctx, "request failed", "err", err)
		problem(c, http.StatusInternalServerError, "Internal Server Error", "")
	}
}

// problem writes an RFC 9457 problem-details response.
func problem(c *gin.Context, status int, title, detail string) {
	body := gin.H{"type": "about:blank", "title": title, "status": status, "instance": c.Request.URL.Path,
		"request_id": reqctx.RequestID(c.Request.Context())}
	if detail != "" {
		body["detail"] = detail
	}
	c.Header("Content-Type", "application/problem+json")
	c.AbortWithStatusJSON(status, body)
}
