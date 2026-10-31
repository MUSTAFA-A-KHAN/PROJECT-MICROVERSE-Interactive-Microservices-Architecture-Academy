// Package client contains Order Service's clients for other services.
//
// UserClient is a production-shaped HTTP client: it reuses connections, puts
// a deadline on every attempt, retries only transient failures with
// exponential backoff and full jitter, and wraps the whole operation in a
// circuit breaker so a dead User Service is not hammered.
package client

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"strconv"
	"time"

	"github.com/sony/gobreaker/v2"

	"github.com/microverse/order-management/order-service/internal/model"
	"github.com/microverse/order-management/order-service/internal/reqctx"
)

// UserClientConfig tunes timeouts and retries.
type UserClientConfig struct {
	BaseURL        string        // e.g. http://user-service:8081
	AttemptTimeout time.Duration // per HTTP attempt
	MaxAttempts    int           // including the first attempt
	BaseBackoff    time.Duration // first retry waits up to this long
}

// UserClient looks up customers in User Service.
type UserClient struct {
	cfg  UserClientConfig
	http *http.Client
	cb   *gobreaker.CircuitBreaker[*model.Customer]
	log  *slog.Logger
}

// statusError is a non-2xx response.
type statusError struct{ code int }

func (e *statusError) Error() string { return "user-service responded " + strconv.Itoa(e.code) }

// NewUserClient builds a client with a tuned transport and a circuit breaker.
func NewUserClient(cfg UserClientConfig, log *slog.Logger) *UserClient {
	transport := &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 500 * time.Millisecond, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:          100,
		MaxIdleConnsPerHost:   20, // default is 2 — far too low for service-to-service traffic
		IdleConnTimeout:       90 * time.Second,
		TLSHandshakeTimeout:   2 * time.Second,
		ResponseHeaderTimeout: cfg.AttemptTimeout,
	}
	c := &UserClient{
		cfg: cfg,
		// No Client.Timeout: each attempt gets its own context deadline instead,
		// so retries and the caller's deadline compose correctly.
		http: &http.Client{Transport: transport},
		log:  log,
	}
	c.cb = gobreaker.NewCircuitBreaker[*model.Customer](gobreaker.Settings{
		Name:        "user-service",
		MaxRequests: 1,                // probes allowed while half-open
		Interval:    60 * time.Second, // reset counts periodically while closed
		Timeout:     30 * time.Second, // stay open this long before probing
		ReadyToTrip: func(c gobreaker.Counts) bool { return c.ConsecutiveFailures >= 5 },
		// "Not found" and cancellations are not signs of an unhealthy dependency.
		IsSuccessful: func(err error) bool { return err == nil || errors.Is(err, model.ErrCustomerNotFound) },
		IsExcluded:   func(err error) bool { return errors.Is(err, context.Canceled) },
		OnStateChange: func(name string, from, to gobreaker.State) {
			log.Warn("circuit breaker state changed", "breaker", name, "from", from.String(), "to", to.String())
		},
	})
	return c
}

// GetUser returns the customer or model.ErrCustomerNotFound. When the breaker
// is open it fails immediately with gobreaker.ErrOpenState.
func (c *UserClient) GetUser(ctx context.Context, id int64) (*model.Customer, error) {
	return c.cb.Execute(func() (*model.Customer, error) { return c.getWithRetry(ctx, id) })
}

func (c *UserClient) getWithRetry(ctx context.Context, id int64) (*model.Customer, error) {
	var lastErr error
	for attempt := 1; attempt <= c.cfg.MaxAttempts; attempt++ {
		cust, err := c.getOnce(ctx, id)
		if err == nil || !retryable(err) {
			return cust, err
		}
		lastErr = err
		if attempt == c.cfg.MaxAttempts {
			break
		}
		wait := backoff(c.cfg.BaseBackoff, attempt)
		reqctx.Logger(ctx, c.log).Warn("user-service call failed, retrying",
			"attempt", attempt, "wait_ms", wait.Milliseconds(), "err", err)
		timer := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err() // the caller gave up — stop retrying
		case <-timer.C:
		}
	}
	return nil, fmt.Errorf("after %d attempts: %w", c.cfg.MaxAttempts, lastErr)
}

func (c *UserClient) getOnce(ctx context.Context, id int64) (*model.Customer, error) {
	ctx, cancel := context.WithTimeout(ctx, c.cfg.AttemptTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.cfg.BaseURL+"/internal/users/"+strconv.FormatInt(id, 10), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if rid := reqctx.RequestID(ctx); rid != "" {
		req.Header.Set("X-Request-ID", rid) // correlation across services
	}

	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	// Drain so the connection can be reused by the pool.
	defer func() { _, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10)) }()

	switch {
	case resp.StatusCode == http.StatusOK:
		var cust model.Customer
		if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&cust); err != nil {
			return nil, fmt.Errorf("decode user: %w", err)
		}
		return &cust, nil
	case resp.StatusCode == http.StatusNotFound:
		return nil, model.ErrCustomerNotFound
	default:
		return nil, &statusError{code: resp.StatusCode}
	}
}

// retryable reports whether another attempt might succeed. 4xx responses
// (other than 429) are the caller's fault and will fail again.
func retryable(err error) bool {
	if errors.Is(err, context.Canceled) {
		return false
	}
	var se *statusError
	if errors.As(err, &se) {
		return se.code == http.StatusTooManyRequests || se.code >= 500
	}
	return true // timeouts and network errors are usually transient
}

// backoff returns a random duration in [0, base·2^(attempt-1)] ("full jitter"),
// which spreads retries out so clients do not retry in synchronised waves.
func backoff(base time.Duration, attempt int) time.Duration {
	ceiling := base << (attempt - 1)
	return time.Duration(rand.Int64N(int64(ceiling) + 1))
}
