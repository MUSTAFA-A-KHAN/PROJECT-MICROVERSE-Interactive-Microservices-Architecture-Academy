// Package middleware contains the Gin middleware every request passes through.
//
// Order matters. main() installs them as:
//
//	RequestID → Logger → Recovery → handlers
//
// so the logger can include the request ID, and a panic inside a handler is
// recovered and still logged with that ID and the final 500 status.
package middleware

import (
	"io"
	"log/slog"
	"net/http"
	"runtime/debug"
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/google/uuid"

	"github.com/microverse/order-management/order-service/internal/reqctx"
)

// HeaderRequestID is propagated across every service hop.
const HeaderRequestID = "X-Request-ID"

// RequestID reuses the caller's X-Request-ID (set by the gateway) or creates
// one, echoes it in the response and stores it in the request context.
func RequestID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id := c.GetHeader(HeaderRequestID)
		if id == "" || len(id) > 64 {
			id = uuid.NewString()
		}
		c.Header(HeaderRequestID, id)
		c.Request = c.Request.WithContext(reqctx.WithRequestID(c.Request.Context(), id))
		c.Next()
	}
}

// Logger emits one structured log line per request and attaches a
// request-scoped logger (already carrying request_id) to the context.
func Logger(base *slog.Logger) gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		l := base.With("request_id", reqctx.RequestID(c.Request.Context()))
		c.Request = c.Request.WithContext(reqctx.WithLogger(c.Request.Context(), l))

		c.Next()

		path := c.FullPath() // route template, e.g. /v1/users/:id — low cardinality
		if path == "/healthz" || path == "/readyz" {
			return // probes every few seconds would drown the useful logs
		}
		status := c.Writer.Status()
		level := slog.LevelInfo
		switch {
		case status >= 500:
			level = slog.LevelError
		case status >= 400:
			level = slog.LevelWarn
		}
		l.Log(c.Request.Context(), level, "http request",
			"method", c.Request.Method,
			"route", path,
			"status", status,
			"duration_ms", time.Since(start).Milliseconds(),
			"bytes", c.Writer.Size(),
		)
	}
}

// Recovery turns a panic into a 500 response instead of a crashed process,
// and logs the stack trace with the request ID.
func Recovery(base *slog.Logger) gin.HandlerFunc {
	return gin.CustomRecoveryWithWriter(io.Discard, func(c *gin.Context, rec any) {
		reqctx.Logger(c.Request.Context(), base).Error("panic recovered",
			"panic", rec, "stack", string(debug.Stack()))
		c.AbortWithStatusJSON(http.StatusInternalServerError, gin.H{
			"type": "about:blank", "title": "Internal Server Error", "status": http.StatusInternalServerError,
			"request_id": reqctx.RequestID(c.Request.Context()),
		})
	})
}

// ctxUserID is the gin context key for the authenticated user.
const ctxUserID = "user_id"

// RequireUserID reads the identity the API Gateway injected after verifying
// the JWT. Services trust X-User-ID only because the gateway strips any
// client-supplied value and only the gateway is reachable from outside
// (network policy / mTLS enforce that in production).
func RequireUserID() gin.HandlerFunc {
	return func(c *gin.Context) {
		id, err := strconv.ParseInt(c.GetHeader("X-User-ID"), 10, 64)
		if err != nil || id <= 0 {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
				"type": "about:blank", "title": "Unauthorized", "status": http.StatusUnauthorized,
				"detail": "missing or invalid X-User-ID; requests must come through the API gateway",
			})
			return
		}
		c.Set(ctxUserID, id)
		c.Next()
	}
}

// UserID returns the identity set by RequireUserID.
func UserID(c *gin.Context) int64 { return c.GetInt64(ctxUserID) }

// RequireRole allows the request only if the gateway-verified role matches.
// Authentication happened at the edge; authorisation still happens here,
// next to the data it protects.
func RequireRole(role string) gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetHeader("X-User-Role") != role {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{
				"type": "about:blank", "title": "Forbidden", "status": http.StatusForbidden,
				"detail": "this operation requires the " + role + " role",
			})
			return
		}
		c.Next()
	}
}
