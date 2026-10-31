Every call that leaves your process needs a deadline, and when the caller gives up, the work it started should stop. In Go both travel through `context.Context`.

## Your task

**1. `FetchWithTimeout(ctx, timeout, fetch)`**
Derive a context that expires after `timeout`, pass it to `fetch`, and always release it. When the deadline passes, the error must satisfy `errors.Is(err, context.DeadlineExceeded)`; when the parent is cancelled, `context.Canceled`.

**2. `FirstResponse(ctx, replicas)` — request hedging**
Call every replica concurrently and return the first successful answer. Then:

- cancel the calls that are still running (they observe `ctx.Done()`);
- if every replica fails, return `errors.Join` of their errors;
- make sure goroutines that finish late can still exit (no leaks).

## Hints

- `context.WithTimeout` / `context.WithCancel` return a `cancel` func — `defer` it.
- A channel buffered to `len(replicas)` means late senders never block.

Background: [Context propagation](#/lesson/m02/context), [Goroutines and channels](#/lesson/m02/concurrency).
