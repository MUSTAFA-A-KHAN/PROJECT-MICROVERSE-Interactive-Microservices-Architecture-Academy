package events

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"

	"github.com/microverse/order-management/order-service/internal/model"
)

// RabbitPublisher publishes events to a topic exchange with publisher
// confirms, reconnecting lazily after a broker outage.
type RabbitPublisher struct {
	url      string
	exchange string

	mu   sync.Mutex
	conn *amqp.Connection
	ch   *amqp.Channel
}

// NewRabbitPublisher returns a publisher. It does not connect yet, so Order
// Service can start (and accept orders into the outbox) while RabbitMQ is down.
func NewRabbitPublisher(url, exchange string) *RabbitPublisher {
	return &RabbitPublisher{url: url, exchange: exchange}
}

func (p *RabbitPublisher) channel() (*amqp.Channel, error) {
	if p.ch != nil && !p.ch.IsClosed() {
		return p.ch, nil
	}
	p.closeLocked()
	conn, err := amqp.DialConfig(p.url, amqp.Config{Heartbeat: 10 * time.Second, Dial: amqp.DefaultDial(5 * time.Second)})
	if err != nil {
		return nil, fmt.Errorf("dial rabbitmq: %w", err)
	}
	ch, err := conn.Channel()
	if err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("open channel: %w", err)
	}
	// Declarations are idempotent: every service declares what it relies on.
	if err := ch.ExchangeDeclare(p.exchange, "topic", true, false, false, false, nil); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("declare exchange: %w", err)
	}
	if err := ch.Confirm(false); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("enable confirms: %w", err)
	}
	p.conn, p.ch = conn, ch
	return ch, nil
}

// Publish sends e and waits for the broker's confirm. Messages are
// persistent and carry the event ID as MessageId so consumers can dedupe.
func (p *RabbitPublisher) Publish(ctx context.Context, e model.Event) error {
	p.mu.Lock()
	defer p.mu.Unlock()

	ch, err := p.channel()
	if err != nil {
		return err
	}
	conf, err := ch.PublishWithDeferredConfirmWithContext(ctx, p.exchange, e.Type,
		true,  // mandatory: return the message if no queue is bound
		false, // immediate (unsupported by RabbitMQ)
		amqp.Publishing{
			ContentType:  "application/json",
			DeliveryMode: amqp.Persistent,
			MessageId:    e.ID.String(),
			Type:         e.Type,
			Timestamp:    e.OccurredAt,
			Body:         e.Payload,
		})
	if err != nil {
		p.closeLocked()
		return fmt.Errorf("publish %s: %w", e.Type, err)
	}
	ok, err := conf.WaitContext(ctx)
	if err != nil {
		return fmt.Errorf("await confirm for %s: %w", e.ID, err)
	}
	if !ok {
		return errors.New("broker nacked event " + e.ID.String())
	}
	return nil
}

// Close releases the connection during shutdown.
func (p *RabbitPublisher) Close() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closeLocked()
}

func (p *RabbitPublisher) closeLocked() {
	if p.conn != nil {
		_ = p.conn.Close()
	}
	p.conn, p.ch = nil, nil
}
