// Package middleware holds the gateway's edge policies: request IDs, access
// logging, panic recovery, JWT authentication and rate limiting.
package middleware

import (
	"io"
	"log/slog"
	"net/http"
	"runtime/debug"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/microverse/order-management/api-gateway/internal/identity"
)

// RequestID assigns every request a correlation ID. The gateway is the edge,
// so it always generates a fresh one: client-supplied IDs could be forged to
// collide with other requests in the logs.
func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := uuid.NewString()
		c.Header("X-Request-ID", id)
		c.Request = c.Request.WithContext(identity.WithRequestID(c.Request.Context(), id))
		c.Next()
	}
}

// AccessLog writes one structured line per request.
func AccessLog(log *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		if c.Request.URL.Path == "/healthz" {
			return
		}
		status := c.Writer.Status()
		level := slog.LevelInfo
		if status >= 500 {
			level = slog.LevelError
		} else if status >= 400 {
			level = slog.LevelWarn
		}
		attrs := []any{
			"request_id", identity.RequestID(c.Request.Context()),
			"method", c.Request.Method,
			"path", c.Request.URL.Path,
			"status", status,
			"duration_ms", time.Since(start).Milliseconds(),
			"client_ip", c.ClientIP(),
		}
		if id, ok := identity.From(c.Request.Context()); ok {
			attrs = append(attrs, "user_id", id.UserID)
		}
		log.Log(c.Request.Context(), level, "access", attrs...)
	}
}

// Recovery converts panics into 500 responses.
func Recovery(log *slog.Logger) gin.HandlerFunc {
	return gin.CustomRecoveryWithWriter(io.Discard, func(c *gin.Context, rec any) {
		log.Error("panic recovered", "request_id", identity.RequestID(c.Request.Context()), "panic", rec, "stack", string(debug.Stack()))
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{"type": "about:blank", "title": "Internal Server Error", "status": 500})
	})
}

// BodyLimit rejects request bodies larger than n bytes before they reach an upstream.
func BodyLimit(n int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.Request.ContentLength > n {
			c.AbortWithStatusJSON(http.StatusRequestEntityTooLarge, gin.H{"type": "about:blank", "title": "Payload Too Large", "status": 413})
			return
		}
		c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, n)
		c.Next()
	}
}
