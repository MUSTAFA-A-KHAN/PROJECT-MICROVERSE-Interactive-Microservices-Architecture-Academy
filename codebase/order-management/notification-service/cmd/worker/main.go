// Command worker runs the Notification Service: a RabbitMQ consumer with no
// public HTTP API (only a health endpoint).
package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	"github.com/redis/go-redis/v9"

	"github.com/microverse/order-management/notification-service/internal/consumer"
)

const (
	exchange   = "orders"
	dlx        = "orders.dlx"
	queue      = "notifications.order-events"
	dlq        = "notifications.order-events.dlq"
	bindingKey = "order.*"
	prefetch   = 20
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("service", "notification-service")
	slog.SetDefault(log)
	if err := run(log); err != nil {
		log.Error("notification-service exited with error", "err", err)
		os.Exit(1)
	}
}

func run(log *slog.Logger) error {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	conn, err := amqp.DialConfig(env("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/"), amqp.Config{Heartbeat: 10 * time.Second})
	if err != nil {
		return fmt.Errorf("dial rabbitmq: %w", err)
	}
	defer conn.Close()
	ch, err := conn.Channel()
	if err != nil {
		return fmt.Errorf("open channel: %w", err)
	}
	if err := declareTopology(ch); err != nil {
		return err
	}
	// Prefetch bounds unacknowledged messages per consumer: back-pressure, and
	// fair distribution across replicas.
	if err := ch.Qos(prefetch, 0, false); err != nil {
		return fmt.Errorf("set qos: %w", err)
	}

	rdb := redis.NewClient(&redis.Options{Addr: env("REDIS_ADDR", "redis:6379"), DialTimeout: 500 * time.Millisecond})
	defer rdb.Close()

	// Liveness only: the worker is alive if this goroutine can answer.
	health := &http.Server{Addr: ":8083", ReadHeaderTimeout: 2 * time.Second, Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if conn.IsClosed() {
			http.Error(w, "rabbitmq connection closed", http.StatusServiceUnavailable)
			return
		}
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})}
	go func() {
		if err := health.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("health server failed", "err", err)
		}
	}()

	c := consumer.New(ch, queue, logSender{log}, redisDeduper{rdb}, 4, log)
	log.Info("consuming", "queue", queue, "binding", bindingKey, "prefetch", prefetch)
	err = c.Run(ctx) // returns after ctx is cancelled and in-flight messages finish

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = health.Shutdown(shutdownCtx)
	log.Info("stopped cleanly")
	return err
}

// declareTopology is idempotent; every service declares what it depends on.
func declareTopology(ch *amqp.Channel) error {
	if err := ch.ExchangeDeclare(exchange, "topic", true, false, false, false, nil); err != nil {
		return fmt.Errorf("declare exchange: %w", err)
	}
	if err := ch.ExchangeDeclare(dlx, "fanout", true, false, false, false, nil); err != nil {
		return fmt.Errorf("declare dlx: %w", err)
	}
	if _, err := ch.QueueDeclare(dlq, true, false, false, false, nil); err != nil {
		return fmt.Errorf("declare dlq: %w", err)
	}
	if err := ch.QueueBind(dlq, "", dlx, false, nil); err != nil {
		return fmt.Errorf("bind dlq: %w", err)
	}
	args := amqp.Table{"x-dead-letter-exchange": dlx, "x-queue-type": "quorum"}
	if _, err := ch.QueueDeclare(queue, true, false, false, false, args); err != nil {
		return fmt.Errorf("declare queue: %w", err)
	}
	return ch.QueueBind(queue, bindingKey, exchange, false, nil)
}

// logSender stands in for an email provider in local development.
type logSender struct{ log *slog.Logger }

func (s logSender) Send(_ context.Context, userID int64, subject, _ string) error {
	s.log.Info("email sent (simulated provider)", "user_id", userID, "subject", subject)
	return nil
}

// redisDeduper records processed event IDs for 7 days.
type redisDeduper struct{ rdb *redis.Client }

func (d redisDeduper) Seen(ctx context.Context, id string) (bool, error) {
	n, err := d.rdb.Exists(ctx, "notif:processed:"+id).Result()
	return n == 1, err
}

func (d redisDeduper) MarkSeen(ctx context.Context, id string) error {
	return d.rdb.Set(ctx, "notif:processed:"+id, 1, 7*24*time.Hour).Err()
}

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
