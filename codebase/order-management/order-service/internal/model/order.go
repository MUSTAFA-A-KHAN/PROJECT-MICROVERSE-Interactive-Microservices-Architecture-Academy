// Package model contains the Order Service's domain: the Order aggregate, its
// lifecycle state machine, the events it publishes and its domain errors.
package model

import (
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
)

// Status is a state in the order lifecycle.
type Status string

const (
	StatusPending   Status = "PENDING"
	StatusConfirmed Status = "CONFIRMED"
	StatusShipped   Status = "SHIPPED"
	StatusDelivered Status = "DELIVERED"
	StatusCancelled Status = "CANCELLED"
)

// transitions is the state machine. Anything not listed is illegal, which
// makes the allowed lifecycle explicit and testable.
var transitions = map[Status][]Status{
	StatusPending:   {StatusConfirmed, StatusCancelled},
	StatusConfirmed: {StatusShipped, StatusCancelled},
	StatusShipped:   {StatusDelivered},
}

// CanTransitionTo reports whether moving from s to next is allowed.
func (s Status) CanTransitionTo(next Status) bool {
	for _, allowed := range transitions[s] {
		if allowed == next {
			return true
		}
	}
	return false
}

// Valid reports whether s is a known status.
func (s Status) Valid() bool {
	switch s {
	case StatusPending, StatusConfirmed, StatusShipped, StatusDelivered, StatusCancelled:
		return true
	}
	return false
}

// Item is one order line. Prices are integer cents: never use floats for money.
type Item struct {
	ProductID      string `json:"product_id"`
	Quantity       int    `json:"quantity"`
	UnitPriceCents int64  `json:"unit_price_cents"`
}

// Order is the aggregate root owned by this service.
type Order struct {
	ID         int64     `json:"id"`
	UserID     int64     `json:"user_id"`
	Status     Status    `json:"status"`
	TotalCents int64     `json:"total_cents"`
	Currency   string    `json:"currency"`
	Items      []Item    `json:"items"`
	Version    int       `json:"version"` // optimistic concurrency token
	CreatedAt  time.Time `json:"created_at"`
	UpdatedAt  time.Time `json:"updated_at"`
}

// Total computes the order total from its lines.
func Total(items []Item) int64 {
	var sum int64
	for _, it := range items {
		sum += int64(it.Quantity) * it.UnitPriceCents
	}
	return sum
}

// Customer is what Order Service needs to know about a user. It is a local,
// minimal view of another service's data — not a shared model.
type Customer struct {
	ID     int64  `json:"id"`
	Email  string `json:"email"`
	Status string `json:"status"`
}

// Event is an integration event stored in the outbox and published to RabbitMQ.
type Event struct {
	ID          uuid.UUID
	Type        string // routing key, e.g. "order.created"
	AggregateID int64
	Payload     []byte
	OccurredAt  time.Time
}

// OrderEventPayload is the published contract. Add fields freely; never
// remove or rename one without a new event version — consumers depend on it.
type OrderEventPayload struct {
	EventID    string    `json:"event_id"`
	EventType  string    `json:"event_type"`
	Version    int       `json:"schema_version"`
	OrderID    int64     `json:"order_id"`
	UserID     int64     `json:"user_id"`
	Status     Status    `json:"status"`
	TotalCents int64     `json:"total_cents"`
	Currency   string    `json:"currency"`
	OccurredAt time.Time `json:"occurred_at"`
}

// NewOrderEvent builds an event describing the current state of o.
func NewOrderEvent(eventType string, o *Order) (Event, error) {
	e := Event{ID: uuid.New(), Type: eventType, AggregateID: o.ID, OccurredAt: time.Now().UTC()}
	payload, err := json.Marshal(OrderEventPayload{
		EventID: e.ID.String(), EventType: eventType, Version: 1,
		OrderID: o.ID, UserID: o.UserID, Status: o.Status,
		TotalCents: o.TotalCents, Currency: o.Currency, OccurredAt: e.OccurredAt,
	})
	if err != nil {
		return Event{}, err
	}
	e.Payload = payload
	return e, nil
}

// CreateOrderParams is everything that must be written in one transaction.
type CreateOrderParams struct {
	Order          *Order
	IdempotencyKey string
	RequestHash    string
}

// Domain errors, mapped to HTTP status codes by the handler.
var (
	ErrNotFound              = errors.New("order not found")
	ErrInvalidTransition     = errors.New("invalid status transition")
	ErrConcurrentUpdate      = errors.New("order was modified concurrently")
	ErrIdempotencyMismatch   = errors.New("idempotency key reused with a different request")
	ErrValidation            = errors.New("validation failed")
	ErrCustomerNotFound      = errors.New("customer not found")
	ErrCustomerInactive      = errors.New("customer account is not active")
	ErrDependencyUnavailable = errors.New("a required dependency is unavailable")
)
