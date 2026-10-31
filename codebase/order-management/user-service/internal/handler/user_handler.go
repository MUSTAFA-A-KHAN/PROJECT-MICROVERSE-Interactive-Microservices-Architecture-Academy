// Package handler is the HTTP transport layer of the User Service.
//
// Handlers decode and validate input, call the service, and map domain
// errors to HTTP status codes. They contain no SQL and no business rules.
package handler

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/microverse/order-management/user-service/internal/middleware"
	"github.com/microverse/order-management/user-service/internal/model"
	"github.com/microverse/order-management/user-service/internal/reqctx"
	"github.com/microverse/order-management/user-service/internal/service"
)

// Service is the subset of the user service the handlers call.
type Service interface {
	Register(ctx context.Context, in service.RegisterInput) (*model.User, error)
	Authenticate(ctx context.Context, email, password string) (string, time.Duration, error)
	GetProfile(ctx context.Context, id int64) (*model.User, error)
	UpdateName(ctx context.Context, id int64, name string) (*model.User, error)
}

// UserHandler serves the public (/v1) and internal (/internal) APIs.
type UserHandler struct {
	svc Service
	log *slog.Logger
}

// NewUserHandler returns a handler backed by svc.
func NewUserHandler(svc Service, log *slog.Logger) *UserHandler {
	return &UserHandler{svc: svc, log: log}
}

// Routes registers every endpoint on r.
func (h *UserHandler) Routes(r *gin.Engine) {
	v1 := r.Group("/v1")
	v1.POST("/users", h.CreateUser)
	v1.POST("/auth/login", h.Login)

	me := v1.Group("/users/me", middleware.RequireUserID())
	me.GET("", h.Me)
	me.PATCH("", h.UpdateMe)

	// Service-to-service API. Not routed by the gateway; reachable only
	// inside the cluster network.
	r.GET("/internal/users/:id", h.InternalGet)
}

type createUserRequest struct {
	Email    string `json:"email" binding:"required,email,max=254"`
	Name     string `json:"name" binding:"required,min=1,max=100"`
	Password string `json:"password" binding:"required,min=12,max=72"` // bcrypt reads at most 72 bytes
}

type loginRequest struct {
	Email    string `json:"email" binding:"required,email"`
	Password string `json:"password" binding:"required"`
}

type updateMeRequest struct {
	Name string `json:"name" binding:"required,min=1,max=100"`
}

type tokenResponse struct {
	AccessToken string `json:"access_token"`
	TokenType   string `json:"token_type"`
	ExpiresIn   int    `json:"expires_in"`
}

// CreateUser handles POST /v1/users.
func (h *UserHandler) CreateUser(c *gin.Context) {
	var req createUserRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		problem(c, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}
	u, err := h.svc.Register(c.Request.Context(), service.RegisterInput{Email: req.Email, Name: req.Name, Password: req.Password})
	if err != nil {
		h.fail(c, err)
		return
	}
	c.Header("Location", "/v1/users/me")
	c.JSON(http.StatusCreated, u)
}

// Login handles POST /v1/auth/login.
func (h *UserHandler) Login(c *gin.Context) {
	var req loginRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		problem(c, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}
	token, ttl, err := h.svc.Authenticate(c.Request.Context(), req.Email, req.Password)
	if err != nil {
		h.fail(c, err)
		return
	}
	c.Header("Cache-Control", "no-store")
	c.JSON(http.StatusOK, tokenResponse{AccessToken: token, TokenType: "Bearer", ExpiresIn: int(ttl.Seconds())})
}

// Me handles GET /v1/users/me.
func (h *UserHandler) Me(c *gin.Context) {
	u, err := h.svc.GetProfile(c.Request.Context(), middleware.UserID(c))
	if err != nil {
		h.fail(c, err)
		return
	}
	c.JSON(http.StatusOK, u)
}

// UpdateMe handles PATCH /v1/users/me.
func (h *UserHandler) UpdateMe(c *gin.Context) {
	var req updateMeRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		problem(c, http.StatusBadRequest, "Invalid request body", err.Error())
		return
	}
	u, err := h.svc.UpdateName(c.Request.Context(), middleware.UserID(c), req.Name)
	if err != nil {
		h.fail(c, err)
		return
	}
	c.JSON(http.StatusOK, u)
}

// internalUser is the contract Order Service depends on. It is deliberately
// smaller than model.User: expose only what consumers need, so internal
// fields can change without breaking them.
type internalUser struct {
	ID     int64        `json:"id"`
	Email  string       `json:"email"`
	Status model.Status `json:"status"`
}

// InternalGet handles GET /internal/users/:id for other services.
func (h *UserHandler) InternalGet(c *gin.Context) {
	id, err := strconv.ParseInt(c.Param("id"), 10, 64)
	if err != nil || id <= 0 {
		problem(c, http.StatusBadRequest, "Invalid user id", "id must be a positive integer")
		return
	}
	u, err := h.svc.GetProfile(c.Request.Context(), id)
	if err != nil {
		h.fail(c, err)
		return
	}
	c.JSON(http.StatusOK, internalUser{ID: u.ID, Email: u.Email, Status: u.Status})
}

// fail maps domain errors to responses. Unknown errors become a generic 500
// so internal details (SQL, hostnames) never leak to clients; the real error
// is logged with the request ID for operators.
func (h *UserHandler) fail(c *gin.Context, err error) {
	ctx := c.Request.Context()
	switch {
	case errors.Is(err, model.ErrNotFound):
		problem(c, http.StatusNotFound, "User not found", "")
	case errors.Is(err, model.ErrEmailTaken):
		problem(c, http.StatusConflict, "Email already registered", "")
	case errors.Is(err, model.ErrInvalidCredentials):
		problem(c, http.StatusUnauthorized, "Invalid email or password", "")
	case errors.Is(err, model.ErrSuspended):
		problem(c, http.StatusForbidden, "Account suspended", "")
	case errors.Is(err, context.DeadlineExceeded), errors.Is(err, context.Canceled):
		reqctx.Logger(ctx, h.log).WarnContext(ctx, "request cancelled or timed out", "err", err)
		problem(c, http.StatusServiceUnavailable, "Request timed out", "")
	default:
		reqctx.Logger(ctx, h.log).ErrorContext(ctx, "request failed", "err", err)
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
