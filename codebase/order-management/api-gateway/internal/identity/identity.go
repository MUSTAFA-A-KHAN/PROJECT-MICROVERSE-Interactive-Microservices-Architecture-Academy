// Package identity carries the authenticated caller through the request
// context, from the JWT middleware to the reverse proxy.
package identity

import "context"

// Identity is what the gateway learned from a verified token.
type Identity struct {
	UserID string
	Role   string
}

type ctxKey struct{}

// With returns a copy of ctx carrying id.
func With(ctx context.Context, id Identity) context.Context {
	return context.WithValue(ctx, ctxKey{}, id)
}

// From returns the identity, if the request was authenticated.
func From(ctx context.Context) (Identity, bool) {
	id, ok := ctx.Value(ctxKey{}).(Identity)
	return id, ok
}

type requestIDKey struct{}

// WithRequestID stores the request ID for propagation upstream.
func WithRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey{}, id)
}

// RequestID returns the request ID or "".
func RequestID(ctx context.Context) string {
	id, _ := ctx.Value(requestIDKey{}).(string)
	return id
}
