// Package model holds the User Service's domain types and domain errors.
// It has no dependencies on HTTP, SQL or Redis so every other layer can use it.
package model

import (
	"errors"
	"time"
)

// Status is the lifecycle state of an account.
type Status string

const (
	StatusActive    Status = "active"
	StatusSuspended Status = "suspended"
)

// User is the aggregate this service owns. No other service may read the
// users table directly — they ask this service through its API.
type User struct {
	ID           int64     `json:"id"`
	Email        string    `json:"email"`
	Name         string    `json:"name"`
	PasswordHash string    `json:"-"` // never serialised: not in responses, not in the cache
	Role         string    `json:"role"`
	Status       Status    `json:"status"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

// Domain errors. Lower layers return these; the HTTP handler maps them to
// status codes. Callers compare with errors.Is, so they survive wrapping.
var (
	ErrNotFound           = errors.New("user not found")
	ErrEmailTaken         = errors.New("email already registered")
	ErrInvalidCredentials = errors.New("invalid email or password")
	ErrSuspended          = errors.New("account suspended")
)
