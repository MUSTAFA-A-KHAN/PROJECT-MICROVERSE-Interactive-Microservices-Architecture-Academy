// Package proxy routes requests to upstream services.
//
// Each route maps a public path prefix to an upstream service and owns its
// own reverse proxy, timeout and circuit breaker, so one failing upstream
// cannot affect routes to the others.
package proxy

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"

	"github.com/microverse/order-management/api-gateway/internal/breaker"
	"github.com/microverse/order-management/api-gateway/internal/identity"
)

// RouteConfig declares one route.
type RouteConfig struct {
	Prefix      string        // public path prefix, e.g. /api/v1/orders
	Upstream    string        // e.g. http://order-service:8082
	StripPrefix string        // removed before forwarding, e.g. /api
	Public      bool          // true = no JWT required for any method
	PublicCalls []string      // exact public endpoints, e.g. "POST /api/v1/users" (registration)
	Timeout     time.Duration // upper bound for the whole upstream exchange
}

// Route is a compiled RouteConfig.
type Route struct {
	RouteConfig
	target  *url.URL
	proxy   *httputil.ReverseProxy
	breaker *breaker.Breaker
}

// Proxy matches requests to routes and forwards them.
type Proxy struct {
	routes []*Route
	log    *slog.Logger
}

const ctxRoute = "gateway.route"

// New compiles routes. Upstreams share one tuned transport so connections
// are pooled and reused instead of opened per request.
func New(cfgs []RouteConfig, log *slog.Logger) (*Proxy, error) {
	transport := &http.Transport{
		DialContext:           (&net.Dialer{Timeout: 2 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
		MaxIdleConns:          200,
		MaxIdleConnsPerHost:   50,
		IdleConnTimeout:       90 * time.Second,
		ExpectContinueTimeout: time.Second,
	}
	p := &Proxy{log: log}
	for _, c := range cfgs {
		target, err := url.Parse(c.Upstream)
		if err != nil || target.Scheme == "" || target.Host == "" {
			return nil, fmt.Errorf("route %s: invalid upstream %q", c.Prefix, c.Upstream)
		}
		r := &Route{RouteConfig: c, target: target}
		r.breaker = breaker.New(target.Host, 5, 15*time.Second, func(name string, from, to breaker.State) {
			log.Warn("circuit breaker state changed", "upstream", name, "from", from.String(), "to", to.String())
		})
		r.proxy = &httputil.ReverseProxy{
			Transport: transport,
			Rewrite: func(pr *httputil.ProxyRequest) {
				pr.Out.URL.Scheme = r.target.Scheme
				pr.Out.URL.Host = r.target.Host
				pr.Out.URL.Path = strings.TrimPrefix(pr.In.URL.Path, r.StripPrefix)
				pr.Out.URL.RawPath = ""
				pr.Out.Host = r.target.Host
				pr.SetXForwarded() // X-Forwarded-For/-Host/-Proto for upstream logs

				// Never trust identity headers from the internet: strip them,
				// then set them only from the verified token.
				pr.Out.Header.Del("X-User-ID")
				pr.Out.Header.Del("X-User-Role")
				if id, ok := identity.From(pr.In.Context()); ok {
					pr.Out.Header.Set("X-User-ID", id.UserID)
					pr.Out.Header.Set("X-User-Role", id.Role)
				}
				if rid := identity.RequestID(pr.In.Context()); rid != "" {
					pr.Out.Header.Set("X-Request-ID", rid)
				}
				pr.Out.Header.Del("Authorization") // services rely on X-User-ID, not the raw token
			},
			ErrorHandler: func(w http.ResponseWriter, req *http.Request, err error) {
				status, title := http.StatusBadGateway, "Bad Gateway"
				if errors.Is(err, context.DeadlineExceeded) {
					status, title = http.StatusGatewayTimeout, "Gateway Timeout"
				}
				log.Warn("upstream request failed", "upstream", r.target.Host, "request_id", identity.RequestID(req.Context()), "err", err)
				writeProblem(w, status, title, "upstream "+r.target.Host+" did not respond successfully", identity.RequestID(req.Context()))
			},
		}
		p.routes = append(p.routes, r)
	}
	return p, nil
}

// Resolve is middleware that matches the route (longest prefix wins) and
// stores it for later middleware. Unknown paths get 404 before any auth work.
func (p *Proxy) Resolve() gin.HandlerFunc {
	return func(c *gin.Context) {
		var best *Route
		path := c.Request.URL.Path
		for _, r := range p.routes {
			if (path == r.Prefix || strings.HasPrefix(path, r.Prefix+"/")) && (best == nil || len(r.Prefix) > len(best.Prefix)) {
				best = r
			}
		}
		if best == nil {
			c.Header("Content-Type", "application/problem+json")
			c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"type": "about:blank", "title": "Not Found", "status": http.StatusNotFound, "instance": path})
			return
		}
		c.Set(ctxRoute, best)
		c.Next()
	}
}

// IsPublic reports whether the matched route skips authentication.
func IsPublic(c *gin.Context) bool {
	v, ok := c.Get(ctxRoute)
	if !ok {
		return false
	}
	r := v.(*Route)
	if r.Public {
		return true
	}
	call := c.Request.Method + " " + c.Request.URL.Path
	for _, pc := range r.PublicCalls {
		if pc == call {
			return true
		}
	}
	return false
}

// Forward proxies the request to the matched route's upstream, enforcing the
// route timeout and circuit breaker.
func (p *Proxy) Forward(c *gin.Context) {
	v, ok := c.Get(ctxRoute)
	if !ok {
		c.AbortWithStatus(http.StatusNotFound)
		return
	}
	route := v.(*Route)

	if err := route.breaker.Allow(); err != nil {
		retry := int(route.breaker.RetryAfter().Seconds()) + 1
		c.Header("Retry-After", strconv.Itoa(retry))
		writeProblem(c.Writer, http.StatusServiceUnavailable, "Service Unavailable",
			"circuit open for "+route.target.Host+"; failing fast", identity.RequestID(c.Request.Context()))
		c.Abort()
		return
	}

	// The deadline travels with the request context: when it fires the
	// upstream connection is closed and the upstream handler's ctx is cancelled.
	ctx, cancel := context.WithTimeout(c.Request.Context(), route.Timeout)
	defer cancel()
	route.proxy.ServeHTTP(c.Writer, c.Request.WithContext(ctx))

	status := c.Writer.Status()
	route.breaker.Record(status >= 500)
}

func writeProblem(w http.ResponseWriter, status int, title, detail, requestID string) {
	w.Header().Set("Content-Type", "application/problem+json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"type": "about:blank", "title": title, "status": status, "detail": detail, "request_id": requestID,
	})
}
