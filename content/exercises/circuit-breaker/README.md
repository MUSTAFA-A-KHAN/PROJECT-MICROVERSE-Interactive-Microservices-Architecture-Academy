When a dependency is failing, waiting on it for every request wastes your resources and keeps it from recovering. A circuit breaker remembers recent failures and fails fast.

```text
          Threshold consecutive failures
 CLOSED ───────────────────────────────► OPEN
   ▲                                       │ Cooldown elapsed
   │ probe succeeds                        ▼
   └──────────────────────────────── HALF-OPEN ──► probe fails → OPEN
```

## Your task

Implement `Allow`, `Record` and `State` on `Breaker` (add whatever fields you need):

- **Closed**: allow calls; count *consecutive* failures; a success resets the count; `Threshold` failures → **Open**.
- **Open**: `Allow` returns `ErrOpen` until `Cooldown` has passed since opening; then the breaker is **Half-open**.
- **Half-open**: allow **one** probe at a time. Success → **Closed**; failure → **Open** with a fresh cooldown.
- Use the injected `Now()` for time, and make it safe for concurrent use (`sync.Mutex`).

Compare your result with the gateway's hand-written breaker in the [Code Playground](#/playground?file=api-gateway/internal/breaker/breaker.go).

Background: [Circuit Breaker](#/lesson/m07/pattern-circuit-breaker).
