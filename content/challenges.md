@@challenge double-click

## The engineering approach

Treat "place this basket" as **one intent** with a client-generated identifier, and make the server process each intent exactly once:

1. The app creates an `Idempotency-Key` (a UUID) when the checkout screen opens and **persists it** with the draft order, so a re-opened screen or an automatic retry reuses it.
2. Order Service claims the key with a **unique constraint** in the **same transaction** that creates the order. A concurrent duplicate blocks on the constraint, then sees the key already exists.
3. Duplicates get the **stored result** (`201`, same order ID, `Idempotent-Replayed: true`).
4. The key — or one derived from the order ID — is passed to Payment Service, so the charge is de-duplicated too.
5. A key reused with a **different body** is rejected with `422`.

Disabling the button is still good UX; it just isn't the safety mechanism.

## Go implementation

The reference Order Service does exactly this:

```go title="order-service/internal/repository/order_repository.go (excerpt)"
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
		return nil, false, model.ErrIdempotencyMismatch // same key, different body → 422
	}
	existing, err := getByID(ctx, tx, *existingID)
	return existing, true, err // replay the original order
}
```

And the service checks the key **before** calling any dependency, so retries never repeat side effects:

```go title="order-service/internal/service/order_service.go (excerpt)"
if existing, storedHash, err := s.repo.FindByIdempotencyKey(ctx, in.UserID, in.IdempotencyKey); err != nil {
	return nil, false, err
} else if existing != nil {
	if storedHash != hash {
		return nil, false, model.ErrIdempotencyMismatch
	}
	return existing, true, nil
}
```

## Trade-offs

| Decision | Trade-off |
|---|---|
| Key per checkout session | The client must persist it; forgetting to reuse it silently disables protection |
| Store keys in the same DB | Atomic with the order; table grows — expire keys after 24–72 h |
| Request hash | Detects key misuse; requires a canonical serialisation |
| Replaying stored responses | Clients get consistent answers; you must store enough to rebuild the response |

@@challenge shared-db

## The engineering approach

Say **no to credentials, yes to the data**. Order Service's schema is an implementation detail; analytics needs a supported contract.

1. **Publish domain events** (`order.created`, `order.cancelled`, later `order.refunded`) through the existing outbox — or stream changes with CDC (Debezium) from a dedicated outbox/reporting table, not from internal tables.
2. **Load them into the warehouse** (BigQuery, Snowflake, ClickHouse) where analysts can join freely without affecting checkout.
3. **Document and version the event schema**; when `total_cents` is split into net/tax/shipping, add fields (`net_cents`, `tax_cents`) and keep `total_cents` until consumers migrate.

This meets the 15-minute freshness requirement with no load on orders-db and no hidden dependency on its schema.

## Go implementation

Events already carry the analytics-relevant fields and a schema version:

```go title="order-service/internal/model/order.go (excerpt)"
type OrderEventPayload struct {
	EventID    string    `json:"event_id"`
	EventType  string    `json:"event_type"`
	Version    int       `json:"schema_version"`
	OrderID    int64     `json:"order_id"`
	UserID     int64     `json:"user_id"`
	Status     Status    `json:"status"`
	TotalCents int64     `json:"total_cents"`
	Currency   string    `json:"currency"`
	OccurredAt time.Time `json:"occurred_at"`
}
```

A small loader consumes the queue and writes to the warehouse in batches:

```go
func (l *Loader) Run(ctx context.Context, deliveries <-chan amqp.Delivery) error {
	batch := make([]OrderEvent, 0, 500)
	flush := time.NewTicker(30 * time.Second)
	defer flush.Stop()
	for {
		select {
		case d := <-deliveries:
			var e OrderEvent
			if err := json.Unmarshal(d.Body, &e); err != nil {
				_ = d.Reject(false)
				continue
			}
			batch = append(batch, e)
			if len(batch) == cap(batch) {
				if err := l.write(ctx, batch, d); err != nil {
					return err
				}
				batch = batch[:0]
			}
		case <-flush.C:
			if len(batch) > 0 {
				// write, then ack up to the last delivery tag (multiple=true)
			}
		case <-ctx.Done():
			return nil
		}
	}
}
```

## Trade-offs

| Option | Freshness | Coupling | Load on orders-db |
|---|---|---|---|
| Read-only credentials | Real time | Hidden schema coupling | High, unpredictable |
| Read replica | Seconds | Hidden schema coupling | None |
| Events → warehouse | Minutes | Explicit, versioned contract | None |
| CDC on internal tables | Seconds | Schema coupling via the stream | Low |

@@challenge lost-emails

## The engineering approach

The bug is the **dual write**: committing to Postgres and publishing to RabbitMQ are two operations with no atomicity. A pod killed between them (every rolling deploy sends SIGTERM, sometimes SIGKILL) or a broker outage loses the event — silently.

1. **Transactional outbox**: insert the event into an `outbox` table inside the order's transaction.
2. A **relay** reads pending rows (`FOR UPDATE SKIP LOCKED`), publishes with **publisher confirms**, and marks them published.
3. **Consumers de-duplicate** by event ID, because the relay can re-publish after a crash (at-least-once).
4. **Alert** on the age of the oldest unpublished event.
5. **Backfill**: find orders from the incident window without a matching sent email and re-emit their events.

## Go implementation

```go title="order-service/internal/repository/order_repository.go (excerpt)"
// 5. The event, in the same transaction. A relay publishes it later.
if err := insertOutbox(ctx, tx, "order.created", o); err != nil {
	return nil, false, err
}
if err := tx.Commit(ctx); err != nil {
	return nil, false, fmt.Errorf("commit: %w", err)
}
```

```go title="order-service/internal/events/rabbitmq.go (excerpt)"
ok, err := conf.WaitContext(ctx)
if err != nil {
	return fmt.Errorf("await confirm for %s: %w", e.ID, err)
}
if !ok {
	return errors.New("broker nacked event " + e.ID.String())
}
```

```go title="notification-service/internal/consumer/consumer.go (excerpt)"
seen, err := c.dedupe.Seen(ctx, evt.EventID)
...
if seen {
	log.Info("duplicate event skipped")
	_ = d.Ack(false)
	return
}
```

## Trade-offs

| Decision | Trade-off |
|---|---|
| Polling relay | Simple; adds up to one interval of latency and some DB load |
| CDC (Debezium) instead | Lower latency; more infrastructure |
| At-least-once delivery | Requires idempotent consumers everywhere |
| Holding row locks while publishing | Keep batches small so locks are brief |

@@challenge user-down

## The engineering approach

Three problems compounded: **no timeouts** (the cascade), **no breaker** (no fast failure), and **aggressive retries** (the slow recovery). Fix all three, then decide on degraded behaviour.

1. **Bound every wait**: a per-attempt timeout (800 ms) derived from the request context, so the gateway's 2 s budget is respected.
2. **Bounded, jittered retries** for transient errors only (3 attempts, full jitter).
3. **Circuit breaker** around the client: after consecutive failures, fail in microseconds; probe after a cool-down.
4. **Fallback** chosen with Product: when the breaker is open, accept the order as `PENDING_VERIFICATION` (identity is already proven by the JWT) and verify asynchronously.
5. **Reduce coupling** over time: put `account_status` in the JWT, or keep a local replica updated by `user.status_changed` events.
6. **Gateway hygiene**: per-route timeouts and breakers so one upstream can't exhaust the gateway.

## Go implementation

The reference client already combines timeouts, retries and a breaker:

```go title="order-service/internal/client/user_client.go (excerpt)"
func (c *UserClient) GetUser(ctx context.Context, id int64) (*model.Customer, error) {
	return c.cb.Execute(func() (*model.Customer, error) { return c.getWithRetry(ctx, id) })
}
```

The fallback lives in the service, where the business decision belongs:

```go
cust, err := s.users.GetUser(ctx, in.UserID)
switch {
case errors.Is(err, gobreaker.ErrOpenState), errors.Is(err, model.ErrDependencyUnavailable):
	// Documented degraded mode: identity is verified by the gateway's JWT;
	// account status is re-checked by a background job.
	o.Status = model.StatusPendingVerification
	s.metrics.DegradedOrders.Inc()
case errors.Is(err, model.ErrCustomerNotFound), err == nil && cust.Status != "active":
	return nil, false, model.ErrCustomerInactive
case err != nil:
	return nil, false, err
}
```

## Trade-offs

| Decision | Trade-off |
|---|---|
| Short timeouts | Bounded resources; occasional false failures under normal latency spikes |
| Retries | Mask blips; must be budgeted inside the caller's deadline |
| Breaker | Fast failure; per-instance state means each replica learns separately |
| Accept-as-pending fallback | Orders keep flowing; a suspended account may order briefly — Product accepted this risk |
| Status in JWT / local replica | Removes the runtime dependency; data can be minutes stale |

@@challenge slow-db

## The engineering approach

Slowness spreads through **shared, bounded resources**:

1. Queries take 180× longer, so each request holds its pool connection longer. The 10-connection pools empty; new requests **wait** for a connection.
2. Waiting requests hold goroutines in Order Service *and* the gateway (no per-route timeout), so the gateway's resources drain — which is why User Service routes slowed too.
3. The liveness probe (`SELECT 1`) times out, so Kubernetes **restarts** healthy-but-waiting pods — adding cold starts and reconnect storms.

Fixes, in order of urgency:

- **Mitigate now**: find and cancel the offending query (`pg_stat_activity`, `pg_cancel_backend`), or disable the job.
- **Liveness checks the process only**; database checks belong in **readiness**.
- **Bound every wait**: `statement_timeout` on the role, pool acquire timeouts, request deadlines, and **per-route timeouts + breakers at the gateway** (bulkheads between routes).
- **Make saturation visible**: alert on pool wait time and acquired/max ratio, not just errors.
- **Fix the cause**: add the index; move analytics to a replica or the warehouse.

## Go implementation

```go
// Readiness, not liveness, reflects the database.
r.GET("/healthz", func(c *gin.Context) { c.JSON(http.StatusOK, gin.H{"status": "ok"}) })
r.GET("/readyz", func(c *gin.Context) {
	ctx, cancel := context.WithTimeout(c.Request.Context(), time.Second)
	defer cancel()
	if err := pool.Ping(ctx); err != nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"status": "database unavailable"})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ready"})
})

// Server-side statement timeout for every connection in the pool.
pc.ConnConfig.RuntimeParams["statement_timeout"] = "2000"   // ms
pc.ConnConfig.RuntimeParams["lock_timeout"] = "1000"        // ms

// Export pool saturation as metrics.
go func() {
	for range time.Tick(10 * time.Second) {
		st := pool.Stat()
		poolAcquired.Set(float64(st.AcquiredConns()))
		poolMax.Set(float64(st.MaxConns()))
		poolWaitTotal.Add(st.EmptyAcquireCount()) // acquisitions that had to wait
	}
}()
```

## Trade-offs

| Decision | Trade-off |
|---|---|
| Statement timeouts | Kill runaway queries; legitimate long queries need a different role |
| Readiness on DB | Removes pods from rotation during DB outages — all pods if the DB is down (correct: they can't serve) |
| Per-route gateway timeouts | Contain slowness; must exceed the route's normal p99.9 |
| Bigger pools | Rarely the answer — they increase database load when it is already saturated |

@@challenge breaking-api

## The engineering approach

Make every intermediate state compatible, because during rolling updates **old and new versions always coexist**, and you don't control every consumer's deploy schedule.

**Expand and contract** (for field-level changes):

1. **Expand**: v2 returns both `status` and the new `state` object.
2. **Migrate consumers**: Order Service reads `state` (with a fallback to `status` while old pods exist).
3. **Verify**: consumer-driven contract tests show no consumer needs `status`; access logs or a metric on field usage confirm it.
4. **Contract**: remove `status` in a later release, after a published deprecation period.

**Versioned endpoint** (for larger reshapes): serve `/internal/v2/users/{id}` beside v1, add `Deprecation` and `Sunset` headers to v1 responses, and remove v1 when its traffic reaches zero.

## Go implementation

```go
// v2 response keeps the old field during the migration window.
type internalUserV2 struct {
	ID     int64        `json:"id"`
	Email  string       `json:"email"`
	Status model.Status `json:"status"`                // deprecated: remove after 2027-03-01
	State  struct {
		Active bool    `json:"active"`
		Reason *string `json:"reason"`
	} `json:"state"`
}

// Deprecation headers on the old endpoint.
func deprecated(sunset string) gin.HandlerFunc {
	return func(c *gin.Context) {
		c.Header("Deprecation", "true")
		c.Header("Sunset", sunset) // RFC 8594
		c.Header("Link", `</internal/v2/users/{id}>; rel="successor-version"`)
		c.Next()
	}
}
```

The consumer reads tolerantly:

```go
type customerWire struct {
	ID     int64  `json:"id"`
	Status string `json:"status"`
	State  *struct {
		Active bool `json:"active"`
	} `json:"state"`
}

func (w customerWire) Active() bool {
	if w.State != nil {
		return w.State.Active
	}
	return w.Status == "active"
}
```

## Trade-offs

| Approach | Trade-off |
|---|---|
| Expand/contract | Several releases; temporary duplicate fields |
| Versioned endpoints | Two code paths to maintain until v1 is gone |
| Coordinated deploy | Impossible across orgs; fails during rolling updates |
| Contract tests | Upfront effort; catches breaks before production |

@@challenge payment-crash

## The engineering approach

Sequencing two remote operations in memory (`charge(); update()`) is not a transaction. Make the workflow **durable, idempotent and resumable** — a saga:

1. **Persist intent first**: in one local transaction, set the order to `PAYMENT_PENDING` and record the saga step (`charge_requested`) — via the outbox if the charge is requested by message.
2. **Charge idempotently**: the payment key is derived from the order (`order-8812-charge`), so re-sending after a crash can't double-charge.
3. **Record the outcome durably**: on success, in one transaction set `CONFIRMED`, advance the saga, and write `order.confirmed` to the outbox.
4. **Recover automatically**: a sweeper finds sagas stuck in `charge_requested` for more than N minutes, re-queries the payment by key (or re-sends the idempotent charge), and continues — or compensates with a **refund** if the order can't be fulfilled.
5. Prefer **provider webhooks** (`payment.captured`) as an additional, idempotent signal.

Durable workflow engines (Temporal, AWS Step Functions) implement steps 1–4 for you.

## Go implementation

```go
// Step 1: persist intent before calling out.
func (s *Checkout) Start(ctx context.Context, orderID int64) error {
	return s.repo.InTx(ctx, func(tx Tx) error {
		if err := tx.SetStatus(ctx, orderID, model.StatusPaymentPending); err != nil {
			return err
		}
		return tx.SaveSagaStep(ctx, orderID, "charge_requested")
	})
}

// Step 2–3: idempotent charge, then durable outcome. Safe to call repeatedly.
func (s *Checkout) Advance(ctx context.Context, orderID int64) error {
	res, err := s.payments.Charge(ctx, payments.ChargeRequest{
		IdempotencyKey: fmt.Sprintf("order-%d-charge", orderID),
		AmountCents:    s.amount(orderID),
	})
	if err != nil {
		return err // transient: the sweeper will retry
	}
	if res.Declined {
		return s.cancel(ctx, orderID, "payment declined")
	}
	return s.repo.InTx(ctx, func(tx Tx) error {
		if err := tx.SetStatus(ctx, orderID, model.StatusConfirmed); err != nil {
			return err
		}
		if err := tx.SaveSagaStep(ctx, orderID, "confirmed"); err != nil {
			return err
		}
		return tx.InsertOutbox(ctx, "order.confirmed", orderID)
	})
}

// Step 4: recovery sweeper.
func (s *Checkout) Sweep(ctx context.Context) {
	stuck, _ := s.repo.SagasInStep(ctx, "charge_requested", 2*time.Minute)
	for _, id := range stuck {
		if err := s.Advance(ctx, id); err != nil {
			s.log.Warn("saga still stuck", "order_id", id, "err", err)
		}
	}
}
```

## Trade-offs

| Decision | Trade-off |
|---|---|
| Saga with persisted steps | More states and code; crashes become delays instead of corruption |
| Idempotent provider calls | Requires provider support (most payment APIs offer it) |
| Sweeper | Bounded inconsistency window (minutes) instead of indefinite |
| Workflow engine | Less custom code; a new platform dependency |
| Compensation (refund) | Customer-visible; needs clear messaging |

@@challenge traffic-10k

## The engineering approach

Protect the system **at the edge first**, then make legitimate load cheap, then scale within real limits.

1. **Per-client rate limits** at the gateway keyed by API key: the buggy partner gets `429` with `Retry-After` while everyone else is unaffected.
2. **Load shedding with priorities**: when Order Service is near capacity, reject low-priority reads before checkout writes.
3. **Make reads cheap**: short-TTL cache (Redis) for `GET /orders/{id}`, plus `ETag`/`If-None-Match` so polling clients get `304 Not Modified` without touching the database.
4. **Autoscale within the downstream budget**: `maxReplicas × pool size < max_connections`; add PgBouncer if you need more replicas than connections allow.
5. **Bulkheads and breakers** so the read path can't exhaust resources the checkout path needs.
6. Contact the partner — the limit buys time; the fix is in their client.

## Go implementation

Per-key limits are a matter of what the gateway keys the bucket on:

```go
key := "ratelimit:ip:" + c.ClientIP()
if apiKey := c.GetHeader("X-Api-Key"); apiKey != "" {
	key = "ratelimit:key:" + hashKey(apiKey) // partner plans get their own capacity
} else if id, ok := identity.From(c.Request.Context()); ok {
	key = "ratelimit:user:" + id.UserID
}
```

Conditional GETs make polling cheap:

```go
func (h *OrderHandler) Get(c *gin.Context) {
	o, err := h.svc.GetOrder(c.Request.Context(), middleware.UserID(c), id)
	if err != nil {
		h.fail(c, err)
		return
	}
	etag := fmt.Sprintf(`W/"%d-%d"`, o.ID, o.Version)
	if c.GetHeader("If-None-Match") == etag {
		c.Status(http.StatusNotModified)
		return
	}
	c.Header("ETag", etag)
	c.Header("Cache-Control", "private, max-age=5")
	c.JSON(http.StatusOK, o)
}
```

Priority-aware load shedding:

```go
var inFlight atomic.Int64

func Shed(limit int64) gin.HandlerFunc {
	return func(c *gin.Context) {
		critical := c.Request.Method == http.MethodPost // checkout
		n := inFlight.Add(1)
		defer inFlight.Add(-1)
		if n > limit && !critical {
			c.Header("Retry-After", "2")
			c.AbortWithStatus(http.StatusServiceUnavailable)
			return
		}
		c.Next()
	}
}
```

## Trade-offs

| Decision | Trade-off |
|---|---|
| Rate limits per key | Fair and targeted; needs shared state and a fail-open/closed decision |
| Caching reads | Huge load reduction; a few seconds of staleness |
| Load shedding | Keeps critical paths alive; some requests are rejected deliberately |
| Scaling out | Only works up to the narrowest downstream limit |
