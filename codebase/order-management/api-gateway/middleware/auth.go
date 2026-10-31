package middleware

import (
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	"github.com/microverse/order-management/api-gateway/internal/identity"
)

// Claims mirrors the token issued by User Service.
type Claims struct {
	Role string `json:"role"`
	jwt.RegisteredClaims
}

// JWTAuth verifies bearer tokens locally — signature, expiry, issuer and
// audience — with no network call to User Service per request.
// Routes for which isPublic returns true are passed through untouched.
func JWTAuth(secret []byte, issuer, audience string, isPublic func(*gin.Context) bool) gin.HandlerFunc {
	parser := jwt.NewParser(
		jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}), // reject "alg":"none" and algorithm confusion
		jwt.WithIssuer(issuer),
		jwt.WithAudience(audience),
		jwt.WithExpirationRequired(),
		jwt.WithLeeway(30*time.Second), // tolerate small clock skew between machines
	)
	keyFunc := func(*jwt.Token) (any, error) { return secret, nil }

	return func(c *gin.Context) {
		if isPublic(c) {
			c.Next()
			return
		}
		raw, ok := strings.CutPrefix(c.GetHeader("Authorization"), "Bearer ")
		if !ok || raw == "" {
			unauthorized(c, "invalid_request", "missing bearer token")
			return
		}
		claims := &Claims{}
		if _, err := parser.ParseWithClaims(raw, claims, keyFunc); err != nil {
			if errors.Is(err, jwt.ErrTokenExpired) {
				unauthorized(c, "invalid_token", "token expired")
				return
			}
			unauthorized(c, "invalid_token", "token invalid")
			return
		}
		if claims.Subject == "" {
			unauthorized(c, "invalid_token", "token has no subject")
			return
		}
		ctx := identity.With(c.Request.Context(), identity.Identity{UserID: claims.Subject, Role: claims.Role})
		c.Request = c.Request.WithContext(ctx)
		c.Next()
	}
}

func unauthorized(c *gin.Context, code, desc string) {
	c.Header("WWW-Authenticate", `Bearer error="`+code+`", error_description="`+desc+`"`)
	c.Header("Content-Type", "application/problem+json")
	c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{
		"type": "about:blank", "title": "Unauthorized", "status": http.StatusUnauthorized, "detail": desc,
		"request_id": identity.RequestID(c.Request.Context()),
	})
}
