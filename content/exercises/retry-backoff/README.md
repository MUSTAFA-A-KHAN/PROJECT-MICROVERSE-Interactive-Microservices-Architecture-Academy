Retries recover from transient failures — and, done carelessly, turn a small outage into a big one. Build a retry helper with the guard rails production systems need.

## Your task

**1. `Backoff(attempt, base, max)`** — the maximum wait before retry `attempt`: `base × 2^(attempt-1)`, capped at `max`.

**2. `Retry(ctx, maxAttempts, base, max, jitter, sleep, op)`**

- Return as soon as `op` succeeds.
- **Don't retry permanent errors** (anything wrapping `ErrBadRequest`).
- Between attempts wait `jitter(Backoff(attempt, base, max))` via `sleep`. No sleep after the final attempt.
- Stop when the context is done (`sleep` returns its error).
- After the last failure, return `"after N attempts: <last error>"` wrapping the last error.

`jitter` and `sleep` are injected so the tests are instant and deterministic. In production you'd pass `func(d) time.Duration { return time.Duration(rand.Int64N(int64(d)+1)) }` (full jitter) and a sleep that selects on a timer and `ctx.Done()`.

Background: [Timeouts and retries](#/lesson/m05/timeouts-retries), [Retry pattern](#/lesson/m07/pattern-retry).
