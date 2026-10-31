// Package service contains the User Service's business logic.
//
// It depends on small interfaces declared here (by the consumer), not on
// concrete Postgres or Redis types. main() wires the real implementations;
// tests pass fakes.
package service

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/microverse/order-management/user-service/internal/model"
)

// UserRepository is the persistence the service needs — nothing more.
type UserRepository interface {
	Create(ctx context.Context, u *model.User) error
	GetByEmail(ctx context.Context, email string) (*model.User, error)
	GetByID(ctx context.Context, id int64) (*model.User, error)
	UpdateName(ctx context.Context, id int64, name string) (*model.User, error)
}

// ProfileCache is an optional read-through cache. Get returns (nil, nil) on a miss.
type ProfileCache interface {
	Get(ctx context.Context, id int64) (*model.User, error)
	Set(ctx context.Context, u *model.User) error
	Delete(ctx context.Context, id int64) error
}

// TokenIssuer creates access tokens.
type TokenIssuer interface {
	Issue(u *model.User) (token string, ttl time.Duration, err error)
}

// UserService implements registration, authentication and profiles.
type UserService struct {
	repo       UserRepository
	cache      ProfileCache
	tokens     TokenIssuer
	log        *slog.Logger
	bcryptCost int
	dummyHash  []byte
}

// NewUserService wires the service. bcrypt cost 12 takes ~70–250 ms per hash
// depending on hardware — deliberately slow to resist offline brute force.
func NewUserService(repo UserRepository, cache ProfileCache, tokens TokenIssuer, log *slog.Logger) (*UserService, error) {
	const cost = 12
	// Compared against when an email does not exist, so login takes the same
	// time whether or not the account exists (no user enumeration by timing).
	dummy, err := bcrypt.GenerateFromPassword([]byte("timing-equaliser"), cost)
	if err != nil {
		return nil, fmt.Errorf("generate dummy hash: %w", err)
	}
	return &UserService{repo: repo, cache: cache, tokens: tokens, log: log, bcryptCost: cost, dummyHash: dummy}, nil
}

// RegisterInput is validated by the handler before it reaches the service.
type RegisterInput struct {
	Email    string
	Name     string
	Password string
}

func normaliseEmail(e string) string { return strings.ToLower(strings.TrimSpace(e)) }

// Register creates an active customer account.
func (s *UserService) Register(ctx context.Context, in RegisterInput) (*model.User, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(in.Password), s.bcryptCost)
	if err != nil {
		return nil, fmt.Errorf("hash password: %w", err)
	}
	u := &model.User{
		Email:        normaliseEmail(in.Email),
		Name:         strings.TrimSpace(in.Name),
		PasswordHash: string(hash),
		Role:         "customer",
		Status:       model.StatusActive,
	}
	if err := s.repo.Create(ctx, u); err != nil {
		return nil, err // already a domain error or wrapped with context
	}
	s.log.InfoContext(ctx, "user registered", "user_id", u.ID)
	return u, nil
}

// Authenticate verifies credentials and returns a signed access token.
func (s *UserService) Authenticate(ctx context.Context, email, password string) (string, time.Duration, error) {
	u, err := s.repo.GetByEmail(ctx, normaliseEmail(email))
	if errors.Is(err, model.ErrNotFound) {
		_ = bcrypt.CompareHashAndPassword(s.dummyHash, []byte(password))
		return "", 0, model.ErrInvalidCredentials
	}
	if err != nil {
		return "", 0, fmt.Errorf("authenticate: %w", err)
	}
	if err := bcrypt.CompareHashAndPassword([]byte(u.PasswordHash), []byte(password)); err != nil {
		return "", 0, model.ErrInvalidCredentials
	}
	if u.Status != model.StatusActive {
		return "", 0, model.ErrSuspended
	}
	return s.tokens.Issue(u)
}

// GetProfile reads through the cache. A broken cache degrades latency, not
// correctness: errors are logged and the database is used instead.
func (s *UserService) GetProfile(ctx context.Context, id int64) (*model.User, error) {
	cached, err := s.cache.Get(ctx, id)
	switch {
	case err != nil:
		s.log.WarnContext(ctx, "profile cache read failed; using database", "user_id", id, "err", err)
	case cached != nil:
		return cached, nil
	}

	u, err := s.repo.GetByID(ctx, id)
	if err != nil {
		return nil, err
	}
	if err := s.cache.Set(ctx, u); err != nil {
		s.log.WarnContext(ctx, "profile cache write failed", "user_id", id, "err", err)
	}
	return u, nil
}

// UpdateName changes the display name, then invalidates the cached profile.
func (s *UserService) UpdateName(ctx context.Context, id int64, name string) (*model.User, error) {
	u, err := s.repo.UpdateName(ctx, id, strings.TrimSpace(name))
	if err != nil {
		return nil, err
	}
	if err := s.cache.Delete(ctx, id); err != nil {
		// The TTL bounds how long a stale profile can be served.
		s.log.WarnContext(ctx, "profile cache invalidation failed", "user_id", id, "err", err)
	}
	return u, nil
}
