// Package repository is the User Service's only gateway to PostgreSQL.
// It translates between SQL rows and domain types, and between driver
// errors and domain errors, so the service layer never sees pgx types.
package repository

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/microverse/order-management/user-service/internal/model"
)

// pgUniqueViolation is the SQLSTATE for a unique-constraint violation.
const pgUniqueViolation = "23505"

const userColumns = `id, email, name, password_hash, role, status, created_at, updated_at`

// UserRepository implements persistence for users on top of a pgx pool.
type UserRepository struct {
	pool *pgxpool.Pool
}

// NewUserRepository returns a repository backed by pool.
func NewUserRepository(pool *pgxpool.Pool) *UserRepository {
	return &UserRepository{pool: pool}
}

func scanUser(row pgx.Row) (*model.User, error) {
	var u model.User
	err := row.Scan(&u.ID, &u.Email, &u.Name, &u.PasswordHash, &u.Role, &u.Status, &u.CreatedAt, &u.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, model.ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// Create inserts a new user and fills in the generated ID and timestamps.
// A duplicate email is reported as model.ErrEmailTaken — the unique index is
// the source of truth, which is race-free unlike a "SELECT then INSERT".
func (r *UserRepository) Create(ctx context.Context, u *model.User) error {
	const q = `
		INSERT INTO users (email, name, password_hash, role, status)
		VALUES ($1, $2, $3, $4, $5)
		RETURNING id, created_at, updated_at`
	err := r.pool.QueryRow(ctx, q, u.Email, u.Name, u.PasswordHash, u.Role, u.Status).
		Scan(&u.ID, &u.CreatedAt, &u.UpdatedAt)
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == pgUniqueViolation {
		return model.ErrEmailTaken
	}
	if err != nil {
		return fmt.Errorf("insert user: %w", err)
	}
	return nil
}

// GetByEmail is used by login. The email column has a unique index, so this
// is a single index lookup.
func (r *UserRepository) GetByEmail(ctx context.Context, email string) (*model.User, error) {
	u, err := scanUser(r.pool.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE email = $1`, email))
	if err != nil && !errors.Is(err, model.ErrNotFound) {
		return nil, fmt.Errorf("get user by email: %w", err)
	}
	return u, err
}

// GetByID loads a user by primary key.
func (r *UserRepository) GetByID(ctx context.Context, id int64) (*model.User, error) {
	u, err := scanUser(r.pool.QueryRow(ctx, `SELECT `+userColumns+` FROM users WHERE id = $1`, id))
	if err != nil && !errors.Is(err, model.ErrNotFound) {
		return nil, fmt.Errorf("get user %d: %w", id, err)
	}
	return u, err
}

// UpdateName changes the display name and returns the updated row.
func (r *UserRepository) UpdateName(ctx context.Context, id int64, name string) (*model.User, error) {
	const q = `UPDATE users SET name = $2, updated_at = now() WHERE id = $1 RETURNING ` + userColumns
	u, err := scanUser(r.pool.QueryRow(ctx, q, id, name))
	if err != nil && !errors.Is(err, model.ErrNotFound) {
		return nil, fmt.Errorf("update user %d: %w", id, err)
	}
	return u, err
}

// Ping is used by the readiness probe.
func (r *UserRepository) Ping(ctx context.Context) error {
	return r.pool.Ping(ctx)
}
