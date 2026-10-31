// Package service holds the Order Service's business logic: validation, the
// order lifecycle, ownership rules and orchestration of dependencies.
package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/microverse/order-management/order-service/internal/model"
	"github.com/microverse/order-management/order-service/internal/reqctx"
)

// Repository is the persistence this service needs.
type Repository interface {
	FindByIdempotencyKey(ctx context.Context, userID int64, key string) (*model.Order, string, error)
	CreateWithOutbox(ctx context.Context, p model.CreateOrderParams) (*model.Order, bool, error)
	GetByID(ctx context.Context, id int64) (*model.Order, error)
	ListByUser(ctx context.Context, userID int64, limit int, beforeID int64) ([]model.Order, error)
	UpdateStatus(ctx context.Context, o *model.Order, to model.Status, eventType string) error
}

// UserDirectory answers questions about customers (implemented by an HTTP
// client for User Service; by a fake in tests).
type UserDirectory interface {
	GetUser(ctx context.Context, id int64) (*model.Customer, error)
}

// OrderService implements order use cases.
type OrderService struct {
	repo  Repository
	users UserDirectory
	log   *slog.Logger
}

// NewOrderService wires the service.
func NewOrderService(repo Repository, users UserDirectory, log *slog.Logger) *OrderService {
	return &OrderService{repo: repo, users: users, log: log}
}

// CreateOrderInput is a validated request to place an order.
type CreateOrderInput struct {
	UserID         int64
	IdempotencyKey string
	Currency       string
	Items          []model.Item
}

// CreateOrder places an order exactly once per idempotency key.
// replayed is true when the key was seen before and the original order is returned.
func (s *OrderService) CreateOrder(ctx context.Context, in CreateOrderInput) (order *model.Order, replayed bool, err error) {
	if err := validate(in); err != nil {
		return nil, false, err
	}
	hash := requestHash(in)

	// Fast path: a client retry of a request we already completed.
	if existing, storedHash, err := s.repo.FindByIdempotencyKey(ctx, in.UserID, in.IdempotencyKey); err != nil {
		return nil, false, err
	} else if existing != nil {
		if storedHash != hash {
			return nil, false, model.ErrIdempotencyMismatch
		}
		return existing, true, nil
	}

	// We need User Service's answer to decide, so this call is synchronous.
	// If availability mattered more than strict validation, a fallback could
	// accept the order as pending verification and re-check asynchronously.
	cust, err := s.users.GetUser(ctx, in.UserID)
	switch {
	case errors.Is(err, model.ErrCustomerNotFound):
		return nil, false, model.ErrCustomerInactive
	case err != nil:
		return nil, false, fmt.Errorf("%w: user-service: %v", model.ErrDependencyUnavailable, err)
	case cust.Status != "active":
		return nil, false, model.ErrCustomerInactive
	}

	o := &model.Order{
		UserID:     in.UserID,
		Status:     model.StatusPending,
		Currency:   strings.ToUpper(in.Currency),
		Items:      in.Items,
		TotalCents: model.Total(in.Items),
	}
	created, replayed, err := s.repo.CreateWithOutbox(ctx, model.CreateOrderParams{
		Order: o, IdempotencyKey: in.IdempotencyKey, RequestHash: hash,
	})
	if err != nil {
		return nil, false, err
	}
	l := reqctx.Logger(ctx, s.log)
	if replayed {
		l.InfoContext(ctx, "idempotent replay of concurrent request", "order_id", created.ID)
	} else {
		l.InfoContext(ctx, "order created", "order_id", created.ID, "total_cents", created.TotalCents)
	}
	return created, replayed, nil
}

// GetOrder returns an order owned by userID. Someone else's order is reported
// as not found, so the API does not reveal which order IDs exist.
func (s *OrderService) GetOrder(ctx context.Context, userID, orderID int64) (*model.Order, error) {
	o, err := s.repo.GetByID(ctx, orderID)
	if err != nil {
		return nil, err
	}
	if o.UserID != userID {
		return nil, model.ErrNotFound
	}
	return o, nil
}

// ListOrders returns a page of the user's orders.
func (s *OrderService) ListOrders(ctx context.Context, userID int64, limit int, beforeID int64) ([]model.Order, error) {
	if limit <= 0 || limit > 100 {
		limit = 20
	}
	return s.repo.ListByUser(ctx, userID, limit, beforeID)
}

// CancelOrder cancels the user's order if its state allows it.
func (s *OrderService) CancelOrder(ctx context.Context, userID, orderID int64) (*model.Order, error) {
	o, err := s.GetOrder(ctx, userID, orderID)
	if err != nil {
		return nil, err
	}
	if o.Status == model.StatusCancelled {
		return o, nil // cancelling twice is a no-op: the operation is idempotent
	}
	return o, s.transition(ctx, o, model.StatusCancelled)
}

// UpdateStatus is the operator/back-office path (for example "SHIPPED").
func (s *OrderService) UpdateStatus(ctx context.Context, orderID int64, to model.Status) (*model.Order, error) {
	if !to.Valid() {
		return nil, fmt.Errorf("%w: unknown status %q", model.ErrValidation, to)
	}
	o, err := s.repo.GetByID(ctx, orderID)
	if err != nil {
		return nil, err
	}
	return o, s.transition(ctx, o, to)
}

func (s *OrderService) transition(ctx context.Context, o *model.Order, to model.Status) error {
	if !o.Status.CanTransitionTo(to) {
		return fmt.Errorf("%w: %s → %s", model.ErrInvalidTransition, o.Status, to)
	}
	event := "order." + strings.ToLower(string(to))
	if err := s.repo.UpdateStatus(ctx, o, to, event); err != nil {
		return err
	}
	reqctx.Logger(ctx, s.log).InfoContext(ctx, "order status changed", "order_id", o.ID, "status", to)
	return nil
}

func validate(in CreateOrderInput) error {
	var problems []string
	if len(in.Currency) != 3 {
		problems = append(problems, "currency must be a 3-letter ISO 4217 code")
	}
	if len(in.Items) == 0 || len(in.Items) > 50 {
		problems = append(problems, "an order needs between 1 and 50 items")
	}
	seen := map[string]bool{}
	for i, it := range in.Items {
		switch {
		case it.ProductID == "":
			problems = append(problems, fmt.Sprintf("items[%d].product_id is required", i))
		case seen[it.ProductID]:
			problems = append(problems, fmt.Sprintf("items[%d]: duplicate product %s", i, it.ProductID))
		}
		seen[it.ProductID] = true
		if it.Quantity <= 0 || it.Quantity > 1000 {
			problems = append(problems, fmt.Sprintf("items[%d].quantity must be 1–1000", i))
		}
		if it.UnitPriceCents < 0 {
			problems = append(problems, fmt.Sprintf("items[%d].unit_price_cents must not be negative", i))
		}
	}
	if len(problems) > 0 {
		return fmt.Errorf("%w: %s", model.ErrValidation, strings.Join(problems, "; "))
	}
	return nil
}

// requestHash fingerprints the request body so a reused idempotency key with
// a different payload can be rejected instead of silently returning the
// wrong order.
func requestHash(in CreateOrderInput) string {
	b, _ := json.Marshal(struct {
		Currency string       `json:"c"`
		Items    []model.Item `json:"i"`
	}{strings.ToUpper(in.Currency), in.Items})
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
