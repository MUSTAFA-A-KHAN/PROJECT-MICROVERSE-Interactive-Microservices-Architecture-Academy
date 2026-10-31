"Save the order, then publish `order.created`" is two writes to two systems. If the process dies between them, or the broker is down, the order exists and nobody hears about it. The **transactional outbox** writes the event to an `outbox` table *in the same transaction* as the order. A relay publishes it later.

```text
 BEGIN
   INSERT INTO orders …
   INSERT INTO outbox (topic, payload) …     ← same transaction
 COMMIT
                 relay: SELECT pending → publish → mark published
```

## Your task

The read-only `support.go` tab gives you an in-memory database with `Begin`, `InsertOrder`, `InsertOutbox`, `Commit`, `Rollback`, `Pending` and `MarkPublished`.

1. **`CreateOrder`**: write the order and an `order.created` row (JSON `OrderCreated` payload) in **one** transaction. On any error nothing is written, and no transaction is left open.
2. **`PublishPending`**: publish up to `batch` pending rows oldest first. Mark a row published only **after** the broker accepts it. Stop at the first failure and return it, so delivery stays in order and nothing is lost.

## Hints

- `defer tx.Rollback()` right after `Begin()` is the idiomatic way to never leak a transaction; it is a no-op after `Commit`.
- This gives **at-least-once** delivery: a crash after publishing but before marking means a duplicate later. Consumers must be idempotent.

See the real relay (with `FOR UPDATE SKIP LOCKED`) in the [Code Playground](#/playground?file=order-service/internal/events/relay.go).

Background: [Transactional Outbox](#/lesson/m07/pattern-outbox).
