// Package events publishes integration events from the transactional outbox.
package events

import (
	"context"
	"log/slog"
	"time"

	"github.com/microverse/order-management/order-service/internal/model"
)

// Publisher sends one event to the broker and returns only after the broker
// has confirmed it.
type Publisher interface {
	Publish(ctx context.Context, e model.Event) error
}

// OutboxStore claims pending events and marks the published ones.
type OutboxStore interface {
	PublishPending(ctx context.Context, limit int, publish func(context.Context, model.Event) error) (int, error)
}

// Relay polls the outbox and publishes pending events in order.
//
// It runs as a goroutine inside Order Service. Running several replicas is
// safe: the store uses FOR UPDATE SKIP LOCKED so each claims different rows.
type Relay struct {
	store    OutboxStore
	pub      Publisher
	interval time.Duration
	batch    int
	log      *slog.Logger
}

// NewRelay returns a relay that publishes up to batch events per interval.
func NewRelay(store OutboxStore, pub Publisher, interval time.Duration, batch int, log *slog.Logger) *Relay {
	return &Relay{store: store, pub: pub, interval: interval, batch: batch, log: log}
}

// Run blocks until ctx is cancelled. Failures are logged and retried on the
// next tick: while the broker is down, events simply wait in Postgres.
func (r *Relay) Run(ctx context.Context) {
	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()
	r.log.Info("outbox relay started", "interval", r.interval.String(), "batch", r.batch)
	for {
		select {
		case <-ctx.Done():
			r.log.Info("outbox relay stopped")
			return
		case <-ticker.C:
			// Drain quickly when there is a backlog instead of waiting a tick per batch.
			for {
				n, err := r.publishBatch(ctx)
				if err != nil {
					r.log.Warn("outbox publish failed; will retry", "published", n, "err", err)
					break
				}
				if n < r.batch {
					break
				}
			}
		}
	}
}

func (r *Relay) publishBatch(ctx context.Context) (int, error) {
	// Bound each batch so a hung broker cannot block the relay forever.
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	n, err := r.store.PublishPending(ctx, r.batch, r.pub.Publish)
	if n > 0 {
		r.log.Debug("outbox events published", "count", n)
	}
	return n, err
}
