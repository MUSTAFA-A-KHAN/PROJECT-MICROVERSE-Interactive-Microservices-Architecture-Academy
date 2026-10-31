// Package cache implements a Redis cache-aside store for user profiles.
//
// Redis is an optimisation, never the source of truth: every method may fail
// and callers must fall back to Postgres. Values carry a TTL so a missed
// invalidation can only serve stale data for a bounded time.
package cache

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"time"

	"github.com/redis/go-redis/v9"

	"github.com/microverse/order-management/user-service/internal/model"
)

// ProfileCache stores serialised users under user:{id}.
type ProfileCache struct {
	rdb *redis.Client
	ttl time.Duration
}

// NewProfileCache returns a cache with the given TTL.
func NewProfileCache(rdb *redis.Client, ttl time.Duration) *ProfileCache {
	return &ProfileCache{rdb: rdb, ttl: ttl}
}

func key(id int64) string { return "user:" + strconv.FormatInt(id, 10) }

// Get returns (nil, nil) on a cache miss so callers can tell "not cached"
// apart from "Redis is broken".
func (c *ProfileCache) Get(ctx context.Context, id int64) (*model.User, error) {
	b, err := c.rdb.Get(ctx, key(id)).Bytes()
	if errors.Is(err, redis.Nil) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("cache get: %w", err)
	}
	var u model.User
	if err := json.Unmarshal(b, &u); err != nil {
		return nil, fmt.Errorf("cache decode: %w", err)
	}
	return &u, nil
}

// Set stores the profile. PasswordHash is tagged json:"-" so it never
// reaches Redis.
func (c *ProfileCache) Set(ctx context.Context, u *model.User) error {
	b, err := json.Marshal(u)
	if err != nil {
		return err
	}
	return c.rdb.Set(ctx, key(u.ID), b, c.ttl).Err()
}

// Delete invalidates a profile after a write. Deleting (rather than
// overwriting) avoids a race where a slow writer re-caches an old value.
func (c *ProfileCache) Delete(ctx context.Context, id int64) error {
	return c.rdb.Del(ctx, key(id)).Err()
}
