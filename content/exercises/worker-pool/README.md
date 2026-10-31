Spawning one goroutine per item is easy; it also lets a 50,000-item request open 50,000 concurrent calls to a dependency. A worker pool bounds concurrency, and a shared context stops the work when it's no longer wanted.

## Your task

Rewrite `Process(ctx, jobs, workers, fn)` so that it:

1. runs `fn` on every job with **at most `workers`** calls in flight;
2. returns results **in input order** (`out[i]` belongs to `jobs[i]`);
3. on the **first error**, returns it and **cancels** the context passed to the other calls;
4. leaks no goroutines — every worker exits before `Process` returns.

Only the standard library is available.

## Hints

- Send job **indexes** over a channel; each worker writes `out[i]` for the indexes it receives, so no two goroutines write the same element.
- `close` the jobs channel when you're done sending so `for i := range ch` ends; `sync.WaitGroup` waits for the workers.
- `sync.Once` is a neat way to record only the first error.

Background: [Goroutines and channels](#/lesson/m02/concurrency).
