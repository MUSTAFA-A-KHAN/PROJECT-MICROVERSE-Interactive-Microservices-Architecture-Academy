package middleware

import (
	"context"
	"log/slog"
	"net/http"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"

	"github.com/microverse/order-management/api-gateway/internal/identity"
)

// tokenBucketScript refills and takes one token atomically inside Redis, so
// every gateway replica shares the same bucket and no two requests can race.
// It reads time from Redis itself to avoid clock skew between replicas.
var tokenBucketScript = redis.NewScript(`
local key      = KEYS[1]
local capacity = tonumber(ARGV[1])
local rate     = tonumber(ARGV[2])          -- tokens per second
local t        = redis.call('TIME')
local now      = t[1] * 1000 + math.floor(t[2] / 1000)

local bucket = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(bucket[1]) or capacity
local ts     = tonumber(bucket[2]) or now

tokens = math.min(capacity, tokens + (math.max(0, now - ts) / 1000) * rate)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, math.ceil(capacity / rate * 1000) + 1000)
return { allowed, math.floor(tokens) }
`)

// RateLimitConfig configures the token bucket.
type RateLimitConfig struct {
	Capacity  int     // maximum burst
	PerSecond float64 // sustained rate
}

// RateLimit enforces a per-user (or per-IP for anonymous callers) token bucket.
//
// If Redis is unavailable the limiter FAILS OPEN: requests are allowed and a
// warning is logged. That favours availability over abuse protection — a
// deliberate trade-off that should be documented and alerted on.
func RateLimit(rdb *redis.Client, cfg RateLimitConfig, log *slog.Logger) gin.HandlerFunc {
	limit := strconv.Itoa(cfg.Capacity)
	return func(c *gin.Context) {
		key := "ratelimit:ip:" + c.ClientIP()
		if id, ok := identity.From(c.Request.Context()); ok {
			key = "ratelimit:user:" + id.UserID
		}

		ctx, cancel := context.WithTimeout(c.Request.Context(), 50*time.Millisecond)
		defer cancel()
		res, err := tokenBucketScript.Run(ctx, rdb, []string{key}, cfg.Capacity, cfg.PerSecond).Int64Slice()
		if err != nil || len(res) != 2 {
			log.Warn("rate limiter unavailable; failing open", "request_id", identity.RequestID(c.Request.Context()), "err", err)
			c.Next()
			return
		}

		c.Header("RateLimit-Limit", limit)
		c.Header("RateLimit-Remaining", strconv.FormatInt(res[1], 10))
		if res[0] == 0 {
			c.Header("Retry-After", "1")
			c.Header("Content-Type", "application/problem+json")
			c.AbortWithStatusJSON(http.StatusTooManyRequests, gin.H{
				"type": "about:blank", "title": "Too Many Requests", "status": http.StatusTooManyRequests,
				"request_id": identity.RequestID(c.Request.Context()),
			})
			return
		}
		c.Next()
	}
}
