// Package repository persists orders in PostgreSQL.
//
// The key idea is atomicity: an order, its items, its idempotency record and
// the event announcing it are written in ONE transaction. Either all of them
// exist or none do — there is no window where an order exists without its
// event (the dual-write problem the transactional outbox solves).
package repository

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/microverse/order-management/order-service/internal/model"
)

// OrderRepository implements order persistence on a pgx pool.
type OrderRepository struct {
	pool *pgxpool.Pool
}

// NewOrderRepository returns a repository backed by pool.
func NewOrderRepository(pool *pgxpool.Pool) *OrderRepository {
	return &OrderRepository{pool: pool}
}

// FindByIdempotencyKey is the fast path for client retries: if this key was
// already used, return the order it produced without doing any work.
// It returns (nil, "", nil) when the key is unknown.
func (r *OrderRepository) FindByIdempotencyKey(ctx context.Context, userID int64, key string) (*model.Order, string, error) {
	var orderID int64
	var hash string
	err := r.pool.QueryRow(ctx,
		`SELECT order_id, request_hash FROM idempotency_keys WHERE user_id = $1 AND key = $2 AND order_id IS NOT NULL`,
		userID, key).Scan(&orderID, &hash)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", nil
	}
	if err != nil {
		return nil, "", fmt.Errorf("lookup idempotency key: %w", err)
	}
	o, err := r.GetByID(ctx, orderID)
	return o, hash, err
}

// CreateWithOutbox atomically writes the order, its items, the idempotency
// record and an "order.created" outbox event. If a concurrent request with
// the same key won the race, it returns that request's order and replayed=true.
func (r *OrderRepository) CreateWithOutbox(ctx context.Context, p model.CreateOrderParams) (order *model.Order, replayed bool, err error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return nil, false, fmt.Errorf("begin: %w", err)
	}
	// Rollback is a no-op once Commit has succeeded, so it is always safe to defer.
	defer func() { _ = tx.Rollback(ctx) }()

	o := p.Order

	// 1. Claim the idempotency key. The primary key (user_id, key) makes this
	//    race-free: a concurrent insert of the same key blocks until we finish.
	tag, err := tx.Exec(ctx,
		`INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1, $2, $3)
		 ON CONFLICT (user_id, key) DO NOTHING`,
		o.UserID, p.IdempotencyKey, p.RequestHash)
	if err != nil {
		return nil, false, fmt.Errorf("claim idempotency key: %w", err)
	}
	if tag.RowsAffected() == 0 {
		var existingID *int64
		var existingHash string
		if err := tx.QueryRow(ctx,
			`SELECT order_id, request_hash FROM idempotency_keys WHERE user_id = $1 AND key = $2`,
			o.UserID, p.IdempotencyKey).Scan(&existingID, &existingHash); err != nil {
			return nil, false, fmt.Errorf("read idempotency key: %w", err)
		}
		if existingHash != p.RequestHash {
			return nil, false, model.ErrIdempotencyMismatch
		}
		if existingID == nil {
			return nil, false, fmt.Errorf("idempotency key %q has no order", p.IdempotencyKey)
		}
		existing, err := getByID(ctx, tx, *existingID)
		return existing, true, err
	}

	// 2. The order row.
	if err := tx.QueryRow(ctx,
		`INSERT INTO orders (user_id, status, total_cents, currency)
		 VALUES ($1, $2, $3, $4)
		 RETURNING id, version, created_at, updated_at`,
		o.UserID, o.Status, o.TotalCents, o.Currency,
	).Scan(&o.ID, &o.Version, &o.CreatedAt, &o.UpdatedAt); err != nil {
		return nil, false, fmt.Errorf("insert order: %w", err)
	}

	// 3. Items, using the COPY protocol (fast for many rows).
	rows := make([][]any, len(o.Items))
	for i, it := range o.Items {
		rows[i] = []any{o.ID, it.ProductID, it.Quantity, it.UnitPriceCents}
	}
	if _, err := tx.CopyFrom(ctx, pgx.Identifier{"order_items"},
		[]string{"order_id", "product_id", "quantity", "unit_price_cents"}, pgx.CopyFromRows(rows)); err != nil {
		return nil, false, fmt.Errorf("insert items: %w", err)
	}

	// 4. Link the idempotency key to the order it produced.
	if _, err := tx.Exec(ctx,
		`UPDATE idempotency_keys SET order_id = $1 WHERE user_id = $2 AND key = $3`,
		o.ID, o.UserID, p.IdempotencyKey); err != nil {
		return nil, false, fmt.Errorf("link idempotency key: %w", err)
	}

	// 5. The event, in the same transaction. A relay publishes it later.
	if err := insertOutbox(ctx, tx, "order.created", o); err != nil {
		return nil, false, err
	}

	if err := tx.Commit(ctx); err != nil {
		return nil, false, fmt.Errorf("commit: %w", err)
	}
	return o, false, nil
}

// UpdateStatus applies a transition the service has already validated.
// It uses optimistic concurrency: the UPDATE matches only if the version is
// unchanged since the order was read, so two concurrent cancels cannot both win.
func (r *OrderRepository) UpdateStatus(ctx context.Context, o *model.Order, to model.Status, eventType string) error {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	tag, err := tx.Exec(ctx,
		`UPDATE orders SET status = $1, version = version + 1, updated_at = now()
		 WHERE id = $2 AND version = $3`,
		to, o.ID, o.Version)
	if err != nil {
		return fmt.Errorf("update status: %w", err)
	}
	if tag.RowsAffected() == 0 {
		return model.ErrConcurrentUpdate
	}
	o.Status = to
	o.Version++
	if err := insertOutbox(ctx, tx, eventType, o); err != nil {
		return err
	}
	if err := tx.Commit(ctx); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

func insertOutbox(ctx context.Context, tx pgx.Tx, eventType string, o *model.Order) error {
	e, err := model.NewOrderEvent(eventType, o)
	if err != nil {
		return fmt.Errorf("build %s event: %w", eventType, err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO outbox (event_id, event_type, aggregate_id, payload, created_at) VALUES ($1, $2, $3, $4, $5)`,
		e.ID, e.Type, e.AggregateID, e.Payload, e.OccurredAt); err != nil {
		return fmt.Errorf("insert outbox: %w", err)
	}
	return nil
}

// GetByID loads an order and its items.
func (r *OrderRepository) GetByID(ctx context.Context, id int64) (*model.Order, error) {
	return getByID(ctx, r.pool, id)
}

// querier is satisfied by both *pgxpool.Pool and pgx.Tx.
type querier interface {
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
}

func getByID(ctx context.Context, q querier, id int64) (*model.Order, error) {
	var o model.Order
	err := q.QueryRow(ctx,
		`SELECT id, user_id, status, total_cents, currency, version, created_at, updated_at
		 FROM orders WHERE id = $1`, id).
		Scan(&o.ID, &o.UserID, &o.Status, &o.TotalCents, &o.Currency, &o.Version, &o.CreatedAt, &o.UpdatedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, model.ErrNotFound
	}
	if err != nil {
		return nil, fmt.Errorf("get order %d: %w", id, err)
	}
	rows, err := q.Query(ctx,
		`SELECT product_id, quantity, unit_price_cents FROM order_items WHERE order_id = $1 ORDER BY product_id`, id)
	if err != nil {
		return nil, fmt.Errorf("get items for order %d: %w", id, err)
	}
	items, err := pgx.CollectRows(rows, pgx.RowToStructByPos[model.Item])
	if err != nil {
		return nil, fmt.Errorf("scan items for order %d: %w", id, err)
	}
	o.Items = items
	return &o, nil
}

// ListByUser returns a page of a user's orders, newest first. Keyset
// pagination (id < $2) stays fast at any depth, unlike OFFSET, and is served
// by the (user_id, id DESC) index.
func (r *OrderRepository) ListByUser(ctx context.Context, userID int64, limit int, beforeID int64) ([]model.Order, error) {
	if beforeID <= 0 {
		beforeID = 1<<63 - 1
	}
	rows, err := r.pool.Query(ctx,
		`SELECT id, user_id, status, total_cents, currency, version, created_at, updated_at
		 FROM orders WHERE user_id = $1 AND id < $2
		 ORDER BY id DESC LIMIT $3`, userID, beforeID, limit)
	if err != nil {
		return nil, fmt.Errorf("list orders: %w", err)
	}
	return pgx.CollectRows(rows, func(row pgx.CollectableRow) (model.Order, error) {
		var o model.Order
		err := row.Scan(&o.ID, &o.UserID, &o.Status, &o.TotalCents, &o.Currency, &o.Version, &o.CreatedAt, &o.UpdatedAt)
		return o, err
	})
}

// PublishPending claims up to limit unpublished outbox rows, hands each to
// publish in order, and marks the successfully published ones.
//
// FOR UPDATE SKIP LOCKED lets several relay instances run at once: each
// claims a different batch instead of blocking or double-publishing.
// Publishing stops at the first failure so events keep their order; the rest
// are retried on the next tick. A crash after publishing but before COMMIT
// re-publishes the batch — delivery is at-least-once, consumers must dedupe.
func (r *OrderRepository) PublishPending(ctx context.Context, limit int, publish func(context.Context, model.Event) error) (int, error) {
	tx, err := r.pool.Begin(ctx)
	if err != nil {
		return 0, fmt.Errorf("begin: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()

	rows, err := tx.Query(ctx,
		`SELECT id, event_id, event_type, aggregate_id, payload, created_at
		 FROM outbox WHERE published_at IS NULL
		 ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`, limit)
	if err != nil {
		return 0, fmt.Errorf("claim outbox: %w", err)
	}
	type pending struct {
		rowID int64
		event model.Event
	}
	batch, err := pgx.CollectRows(rows, func(row pgx.CollectableRow) (pending, error) {
		var p pending
		err := row.Scan(&p.rowID, &p.event.ID, &p.event.Type, &p.event.AggregateID, &p.event.Payload, &p.event.OccurredAt)
		return p, err
	})
	if err != nil {
		return 0, fmt.Errorf("scan outbox: %w", err)
	}

	published := make([]int64, 0, len(batch))
	var publishErr error
	for _, p := range batch {
		if publishErr = publish(ctx, p.event); publishErr != nil {
			break
		}
		published = append(published, p.rowID)
	}
	if len(published) > 0 {
		if _, err := tx.Exec(ctx, `UPDATE outbox SET published_at = now() WHERE id = ANY($1)`, published); err != nil {
			return 0, fmt.Errorf("mark published: %w", err)
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return 0, fmt.Errorf("commit: %w", err)
	}
	if publishErr != nil {
		return len(published), fmt.Errorf("publish: %w", publishErr)
	}
	return len(published), nil
}

// Ping is used by the readiness probe.
func (r *OrderRepository) Ping(ctx context.Context) error { return r.pool.Ping(ctx) }
