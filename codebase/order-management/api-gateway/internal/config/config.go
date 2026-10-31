// Package config loads the gateway configuration, including its route table.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/microverse/order-management/api-gateway/internal/proxy"
)

// Config holds every gateway setting.
type Config struct {
	HTTPAddr        string
	RedisAddr       string
	JWTSecret       []byte
	JWTIssuer       string
	JWTAudience     string
	RateCapacity    int
	RatePerSecond   float64
	MaxBodyBytes    int64
	Routes          []proxy.RouteConfig
	ShutdownTimeout time.Duration
	LogLevel        string
}

// Load reads and validates the environment.
func Load() (Config, error) {
	userURL := getEnv("USER_SERVICE_URL", "http://user-service:8081")
	orderURL := getEnv("ORDER_SERVICE_URL", "http://order-service:8082")
	cfg := Config{
		HTTPAddr:        getEnv("HTTP_ADDR", ":8080"),
		RedisAddr:       getEnv("REDIS_ADDR", "redis:6379"),
		JWTSecret:       []byte(os.Getenv("JWT_SECRET")),
		JWTIssuer:       getEnv("JWT_ISSUER", "user-service"),
		JWTAudience:     getEnv("JWT_AUDIENCE", "oms-api"),
		MaxBodyBytes:    1 << 20,
		ShutdownTimeout: 20 * time.Second,
		LogLevel:        getEnv("LOG_LEVEL", "info"),
		// The route table. Longest prefix wins; "/api" is stripped so services
		// expose clean paths like /v1/orders.
		Routes: []proxy.RouteConfig{
			{Prefix: "/api/v1/auth", Upstream: userURL, StripPrefix: "/api", Public: true, Timeout: 3 * time.Second},
			{Prefix: "/api/v1/users", Upstream: userURL, StripPrefix: "/api", PublicCalls: []string{"POST /api/v1/users"}, Timeout: 2 * time.Second},
			{Prefix: "/api/v1/orders", Upstream: orderURL, StripPrefix: "/api", Timeout: 2 * time.Second},
		},
	}
	var problems []error
	var err error
	if cfg.RateCapacity, err = strconv.Atoi(getEnv("RATE_LIMIT_BURST", "20")); err != nil {
		problems = append(problems, fmt.Errorf("RATE_LIMIT_BURST: %w", err))
	}
	if cfg.RatePerSecond, err = strconv.ParseFloat(getEnv("RATE_LIMIT_PER_SECOND", "5"), 64); err != nil {
		problems = append(problems, fmt.Errorf("RATE_LIMIT_PER_SECOND: %w", err))
	}
	if len(cfg.JWTSecret) < 32 {
		problems = append(problems, errors.New("JWT_SECRET must be at least 32 bytes"))
	}
	return cfg, errors.Join(problems...)
}

func getEnv(key, def string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return def
}
