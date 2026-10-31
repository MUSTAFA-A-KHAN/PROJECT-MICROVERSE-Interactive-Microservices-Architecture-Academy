// Package config loads and validates the service configuration.
//
// Configuration comes from environment variables (twelve-factor style) so the
// same container image runs unchanged in every environment. Everything is
// validated once at startup: a service that starts with a bad config fails
// loudly in seconds instead of misbehaving for hours.
package config

import (
	"errors"
	"fmt"
	"os"
	"time"
)

// Config holds every setting the User Service needs.
type Config struct {
	HTTPAddr        string
	DatabaseURL     string
	RedisAddr       string
	JWTSecret       []byte
	JWTIssuer       string
	JWTAudience     string
	AccessTokenTTL  time.Duration
	ProfileCacheTTL time.Duration
	DBMaxConns      int32
	ShutdownTimeout time.Duration
	DrainDelay      time.Duration
	LogLevel        string
}

// Load reads the environment and returns a validated Config. All problems
// are reported together so an operator can fix them in one pass.
func Load() (Config, error) {
	cfg := Config{
		HTTPAddr:    getEnv("HTTP_ADDR", ":8081"),
		DatabaseURL: os.Getenv("DATABASE_URL"),
		RedisAddr:   getEnv("REDIS_ADDR", "redis:6379"),
		JWTSecret:   []byte(os.Getenv("JWT_SECRET")),
		JWTIssuer:   getEnv("JWT_ISSUER", "user-service"),
		JWTAudience: getEnv("JWT_AUDIENCE", "oms-api"),
		LogLevel:    getEnv("LOG_LEVEL", "info"),
		DBMaxConns:  10,
	}

	var problems []error
	durations := []struct {
		dst  *time.Duration
		key  string
		def  time.Duration
	}{
		{&cfg.AccessTokenTTL, "ACCESS_TOKEN_TTL", 15 * time.Minute},
		{&cfg.ProfileCacheTTL, "PROFILE_CACHE_TTL", 5 * time.Minute},
		{&cfg.ShutdownTimeout, "SHUTDOWN_TIMEOUT", 20 * time.Second},
		{&cfg.DrainDelay, "DRAIN_DELAY", 5 * time.Second},
	}
	for _, d := range durations {
		v, err := getDuration(d.key, d.def)
		if err != nil {
			problems = append(problems, err)
		}
		*d.dst = v
	}

	if cfg.DatabaseURL == "" {
		problems = append(problems, errors.New("DATABASE_URL is required"))
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

func getDuration(key string, def time.Duration) (time.Duration, error) {
	v, ok := os.LookupEnv(key)
	if !ok || v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def, fmt.Errorf("%s: %w", key, err)
	}
	return d, nil
}
