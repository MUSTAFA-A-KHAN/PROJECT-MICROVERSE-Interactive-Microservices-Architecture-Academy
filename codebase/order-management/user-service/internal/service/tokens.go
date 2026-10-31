package service

import (
	"fmt"
	"strconv"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"

	"github.com/microverse/order-management/user-service/internal/model"
)

// Claims is the JWT payload shared with the API Gateway. Keep it small:
// tokens travel on every request and cannot be revoked before they expire.
type Claims struct {
	Role string `json:"role"`
	jwt.RegisteredClaims
}

// JWTIssuer signs short-lived access tokens.
//
// HS256 uses one shared secret, so the gateway could also mint tokens.
// In production prefer an asymmetric algorithm (RS256 or EdDSA): only this
// service holds the private key and verifiers fetch the public key (JWKS).
type JWTIssuer struct {
	secret   []byte
	issuer   string
	audience string
	ttl      time.Duration
	now      func() time.Time
}

// NewJWTIssuer returns an issuer for tokens valid for ttl.
func NewJWTIssuer(secret []byte, issuer, audience string, ttl time.Duration) *JWTIssuer {
	return &JWTIssuer{secret: secret, issuer: issuer, audience: audience, ttl: ttl, now: time.Now}
}

// Issue returns a signed token for u and how long it is valid.
func (j *JWTIssuer) Issue(u *model.User) (string, time.Duration, error) {
	now := j.now()
	claims := Claims{
		Role: u.Role,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   strconv.FormatInt(u.ID, 10),
			Issuer:    j.issuer,
			Audience:  jwt.ClaimStrings{j.audience},
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(j.ttl)),
			ID:        uuid.NewString(),
		},
	}
	signed, err := jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString(j.secret)
	if err != nil {
		return "", 0, fmt.Errorf("sign token: %w", err)
	}
	return signed, j.ttl, nil
}
