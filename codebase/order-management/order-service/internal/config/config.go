// Package config loads and validates Order Service configuration from the
// environment. Invalid configuration stops the process at startup.
package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"
)

// Config holds every Order Service setting.
type Config struct {
	HTTPAddr        string
	DatabaseURL     string
	RabbitURL       string
	Exchange        string
	UserServiceURL  string
	UserTimeout     time.Duration // per attempt
	UserMaxAttempts int
	RelayInterval   time.Duration
	RelayBatch      int
	DBMaxConns      int32
	ShutdownTimeout time.Duration
	DrainDelay      time.Duration
	LogLevel        string
}

// Load reads and validates the environment.
func Load() (Config, error) {
	cfg := Config{
		HTTPAddr:       getEnv("HTTP_ADDR", ":8082"),
		DatabaseURL:    os.Getenv("DATABASE_URL"),
		RabbitURL:      os.Getenv("RABBITMQ_URL"),
		Exchange:       getEnv("EVENTS_EXCHANGE", "orders"),
		UserServiceURL: getEnv("USER_SERVICE_URL", "http://user-service:8081"),
		LogLevel:       getEnv("LOG_LEVEL", "info"),
		DBMaxConns:     10,
	}
	var problems []error
	collect := func(err error) {
		if err != nil {
			problems = append(problems, err)
		}
	}
	var err error
	cfg.UserTimeout, err = getDuration("USER_SERVICE_TIMEOUT", 800*time.Millisecond)
	collect(err)
	cfg.RelayInterval, err = getDuration("OUTBOX_RELAY_INTERVAL", 500*time.Millisecond)
	collect(err)
	cfg.ShutdownTimeout, err = getDuration("SHUTDOWN_TIMEOUT", 20*time.Second)
	collect(err)
	cfg.DrainDelay, err = getDuration("DRAIN_DELAY", 5*time.Second)
	collect(err)
	cfg.UserMaxAttempts, err = getInt("USER_SERVICE_MAX_ATTEMPTS", 3)
	collect(err)
	cfg.RelayBatch, err = getInt("OUTBOX_RELAY_BATCH", 100)
	collect(err)

	if cfg.DatabaseURL == "" {
		problems = append(problems, errors.New("DATABASE_URL is required"))
	}
	if cfg.RabbitURL == "" {
		problems = append(problems, errors.New("RABBITMQ_URL is required"))
	}
	if cfg.UserMaxAttempts < 1 || cfg.UserMaxAttempts > 5 {
		problems = append(problems, errors.New("USER_SERVICE_MAX_ATTEMPTS must be between 1 and 5"))
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
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return def, fmt.Errorf("%s: %w", key, err)
	}
	return d, nil
}

func getInt(key string, def int) (int, error) {
	v := os.Getenv(key)
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return def, fmt.Errorf("%s: %w", key, err)
	}
	return n, nil
}
