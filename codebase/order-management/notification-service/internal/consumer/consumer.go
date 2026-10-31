// Package consumer processes order events from RabbitMQ.
//
// Delivery is at-least-once: the same event can arrive twice (publisher
// retries, relay crashes, consumer crashes before ack). The consumer is
// therefore idempotent — it remembers processed event IDs — and it only
// acknowledges a message after the side effect (sending the email) succeeded.
package consumer

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
)

// OrderEvent is the subset of the Order Service event contract this service reads.
// Unknown fields are ignored, so producers can add fields without breaking us.
type OrderEvent struct {
	EventID    string `json:"event_id"`
	EventType  string `json:"event_type"`
	OrderID    int64  `json:"order_id"`
	UserID     int64  `json:"user_id"`
	Status     string `json:"status"`
	TotalCents int64  `json:"total_cents"`
	Currency   string `json:"currency"`
}

// Sender delivers a notification (SMTP, SES, SendGrid…).
type Sender interface {
	Send(ctx context.Context, userID int64, subject, body string) error
}

// Deduper remembers which events were already handled.
type Deduper interface {
	Seen(ctx context.Context, eventID string) (bool, error)
	MarkSeen(ctx context.Context, eventID string) error
}

// Consumer reads deliveries and dispatches them to handle.
type Consumer struct {
	ch      *amqp.Channel
	queue   string
	sender  Sender
	dedupe  Deduper
	log     *slog.Logger
	workers int
}

// New returns a consumer that processes up to workers messages concurrently.
func New(ch *amqp.Channel, queue string, sender Sender, dedupe Deduper, workers int, log *slog.Logger) *Consumer {
	return &Consumer{ch: ch, queue: queue, sender: sender, dedupe: dedupe, workers: workers, log: log}
}

// Run consumes until ctx is cancelled, then waits for in-flight messages.
func (c *Consumer) Run(ctx context.Context) error {
	deliveries, err := c.ch.ConsumeWithContext(ctx, c.queue, "notification-service",
		false, // autoAck=false: we ack manually after the work succeeds
		false, false, false, nil)
	if err != nil {
		return fmt.Errorf("consume %s: %w", c.queue, err)
	}

	var wg sync.WaitGroup
	for i := 0; i < c.workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for d := range deliveries {
				// Each message gets its own deadline, detached from shutdown so
				// a message being processed when SIGTERM arrives can finish.
				msgCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 30*time.Second)
				c.handle(msgCtx, d)
				cancel()
			}
		}()
	}
	wg.Wait() // the deliveries channel closes when ctx is cancelled
	return nil
}

func (c *Consumer) handle(ctx context.Context, d amqp.Delivery) {
	log := c.log.With("message_id", d.MessageId, "routing_key", d.RoutingKey, "redelivered", d.Redelivered)

	var evt OrderEvent
	if err := json.Unmarshal(d.Body, &evt); err != nil || evt.EventID == "" {
		// A malformed message will never succeed: reject without requeue so the
		// dead-letter exchange moves it to the DLQ for inspection.
		log.Error("poison message rejected", "err", err)
		_ = d.Reject(false)
		return
	}

	seen, err := c.dedupe.Seen(ctx, evt.EventID)
	if err != nil {
		// Redis is down: process anyway. Worst case is a duplicate email,
		// which is better than no email. (A payment would choose differently.)
		log.Warn("dedupe check failed; processing anyway", "err", err)
	}
	if seen {
		log.Info("duplicate event skipped")
		_ = d.Ack(false)
		return
	}

	subject, body := render(evt)
	if err := c.sender.Send(ctx, evt.UserID, subject, body); err != nil {
		if d.Redelivered {
			log.Error("send failed twice; dead-lettering", "err", err)
			_ = d.Reject(false)
			return
		}
		log.Warn("send failed; requeueing once", "err", err)
		_ = d.Nack(false, true)
		return
	}

	if err := c.dedupe.MarkSeen(ctx, evt.EventID); err != nil {
		log.Warn("could not record processed event", "err", err)
	}
	if err := d.Ack(false); err != nil {
		log.Error("ack failed; message will be redelivered", "err", err)
		return
	}
	log.Info("notification sent", "order_id", evt.OrderID, "event_type", evt.EventType)
}

func render(e OrderEvent) (subject, body string) {
	amount := fmt.Sprintf("%.2f %s", float64(e.TotalCents)/100, e.Currency)
	switch e.EventType {
	case "order.cancelled":
		return fmt.Sprintf("Order #%d cancelled", e.OrderID), "Your order was cancelled. Any payment will be refunded."
	default:
		return fmt.Sprintf("Order #%d confirmed", e.OrderID), "Thanks for your order of " + amount + "."
	}
}
