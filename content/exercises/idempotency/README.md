Networks fail *after* the server did the work: the client times out, retries `POST /v1/orders`, and the customer is charged twice. An **Idempotency-Key** turns the retry into a replay of the first response.

```text
 POST /orders  Idempotency-Key: k1  → run → 201 ord_1   (stored)
 POST /orders  Idempotency-Key: k1  → replay → 201 ord_1  Idempotent-Replayed: true
 POST /orders  Idempotency-Key: k1 (different body) → 422 key reused
```

## Your task

Implement `Store.Do(key, fingerprint, fn)`:

1. First call for a key runs `fn` → `replayed=false`.
2. A repeat with the same fingerprint returns the stored response → `replayed=true`, `fn` not called.
3. Same key, different fingerprint → `ErrKeyReused`.
4. **Concurrent** duplicates (a double-click) wait for the in-flight call and share its outcome — `fn` runs once.
5. If `fn` fails, forget the key so a retry can try again.
6. Don't hold the mutex while `fn` runs.

## Hint

Store a pointer to an entry with a `done chan struct{}`. The first caller creates it and closes `done` when `fn` returns; everyone else waits on `<-e.done`.

The real service stores keys in PostgreSQL inside the order's transaction — see `CreateWithOutbox` in the [Code Playground](#/playground?file=order-service/internal/repository/order_repository.go).

Background: [Idempotency](#/lesson/m07/pattern-idempotency).
