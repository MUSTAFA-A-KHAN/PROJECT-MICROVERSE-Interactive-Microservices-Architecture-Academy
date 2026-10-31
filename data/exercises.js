/* ==========================================================================
   Microverse — hands-on Go coding exercises (Code Lab).
   Each exercise lives in content/exercises/<id>/:
     README.md        the brief (rendered with the lesson markdown renderer)
     starter.go.txt   what the learner edits (sent as exercise.go)
     tests.go.txt     read-only test program (sent as main.go)
     solution.go.txt  reference solution, revealed on request
     support.go.txt   optional read-only helpers (sent as support.go; set support: true)
   All exercises share content/exercises/testkit.go.txt (sent as testkit.go).
   tools/check-exercises.mjs proves every starter fails and every solution
   passes with a real Go toolchain.
   ========================================================================== */
window.MV = window.MV || {};
MV.data = MV.data || {};

MV.data.exercises = [
  {
    id: 'errors-to-status', level: 'Beginner', minutes: 15,
    title: 'Errors → HTTP status codes',
    summary: 'Wrap domain errors with %w and map them to 404/409/422/500 using errors.Is and errors.As.',
    concepts: ['error-handling'], lesson: 'm02/errors',
    hints: [
      'FindOrder: `return fmt.Errorf("order %d: %w", id, ErrNotFound)` — the %w verb keeps ErrNotFound in the chain.',
      'StatusFor: check `err == nil` first, then `errors.Is(err, ErrNotFound)`, then `errors.Is(err, ErrInvalidTransition)`.',
      'For the typed error: `var ve *ValidationError; if errors.As(err, &ve) { return 422 }`.',
    ],
  },
  {
    id: 'order-state-machine', level: 'Beginner', minutes: 15,
    title: 'Order lifecycle state machine',
    summary: 'Encode legal order transitions as data, reject illegal moves with a wrapped error and bump the version.',
    concepts: ['service-design'], lesson: 'm03/order-service',
    hints: [
      'Declare `var transitions = map[Status][]Status{ Pending: {Confirmed, Cancelled}, ... }` and loop over the slice in CanTransition.',
      'In Transition, `o.Status == to` is a no-op that returns nil: a retried "cancel" must not fail or bump the version.',
      'Return `fmt.Errorf("%w: %s → %s", ErrInvalidTransition, o.Status, to)` and only mutate the order after the check passes.',
    ],
  },
  {
    id: 'http-middleware', level: 'Beginner', minutes: 20,
    title: 'HTTP middleware chain',
    summary: 'Build Chain, RequestID and Recover with net/http — the plumbing every service shares.',
    concepts: ['middleware'], lesson: 'm02/middleware',
    hints: [
      'Chain: loop from the last middleware to the first, `h = mws[i](h)`, so mws[0] wraps everything.',
      'Every middleware returns `http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { ...; next.ServeHTTP(w, r) })`.',
      'Recover: `defer func() { if v := recover(); v != nil { ... } }()` before calling next. Set headers, then `w.WriteHeader(500)`, then write the body.',
    ],
  },
  {
    id: 'context-deadlines', level: 'Intermediate', minutes: 20,
    title: 'Deadlines and hedged requests',
    summary: 'Bound a call with context.WithTimeout, then race replicas and cancel the losers.',
    concepts: ['context', 'timeouts'], lesson: 'm02/context',
    hints: [
      'FetchWithTimeout: `ctx, cancel := context.WithTimeout(ctx, timeout); defer cancel(); return fetch(ctx)`.',
      'FirstResponse: derive one cancellable ctx, start a goroutine per replica, and send results on a channel buffered to len(replicas) so no goroutine blocks forever.',
      'Read results until the first success (then cancel) or until every replica has failed — collect the failures and return errors.Join(errs...).',
    ],
  },
  {
    id: 'retry-backoff', level: 'Intermediate', minutes: 20,
    title: 'Retries with exponential backoff',
    summary: 'Retry transient failures with capped exponential backoff and jitter; never retry permanent errors.',
    concepts: ['retries', 'timeouts'], lesson: 'm05/timeouts-retries',
    hints: [
      'Backoff: attempt 1 waits `base`, then double per attempt. Cap at `max` inside the loop, so a large attempt can never overflow.',
      'Retry: stop immediately when `errors.Is(err, ErrBadRequest)` — a permanent error never succeeds on retry.',
      'Between attempts call `sleep(ctx, jitter(Backoff(...)))` and return early if it reports ctx is done. After the last attempt: `fmt.Errorf("after %d attempts: %w", n, err)`.',
    ],
  },
  {
    id: 'worker-pool', level: 'Intermediate', minutes: 25,
    title: 'Bounded worker pool',
    summary: 'Process jobs with at most N goroutines, keep results in order and cancel everything on the first error.',
    concepts: ['concurrency', 'context'], lesson: 'm02/concurrency',
    hints: [
      'Feed job indexes into a channel; start `workers` goroutines that range over it and write `results[i]` — each index is written by exactly one goroutine, so no mutex is needed for the slice.',
      'Use `ctx, cancel := context.WithCancel(parent)` and a `sync.Once` to record only the first error and call cancel.',
      'Close the index channel after feeding (stop feeding early when ctx is done), then `wg.Wait()`. If the parent was cancelled, return `parent.Err()`.',
    ],
  },
  {
    id: 'token-bucket', level: 'Intermediate', minutes: 20,
    title: 'Token-bucket rate limiter',
    summary: 'Allow bursts up to a capacity, refill at a steady rate, and keep one bucket per client.',
    concepts: ['rate-limiting'], lesson: 'm07/pattern-rate-limiting',
    hints: [
      'Store `tokens float64` and `last time.Time`. On every call: `tokens = min(Capacity, tokens + elapsed.Seconds()*Rate)`, then `last = now`.',
      'RetryAfter is the time to earn the missing fraction: `(1 - tokens) / Rate` seconds.',
      'Limiter: lock only to find or create the bucket; the bucket has its own mutex for Allow.',
    ],
  },
  {
    id: 'idempotency', level: 'Intermediate', minutes: 25,
    title: 'Idempotency keys',
    summary: 'Make POST /orders safe to retry: replay stored responses and run concurrent duplicates once.',
    concepts: ['idempotency'], lesson: 'm07/pattern-idempotency',
    hints: [
      'Keep `map[string]*entry`, where entry holds the fingerprint, the response, the error and a `done chan struct{}`.',
      'If the key exists: compare fingerprints (ErrKeyReused on mismatch), unlock, then `<-e.done` and return the stored result with replayed=true.',
      'Otherwise insert the entry, unlock, run fn, delete the entry if fn failed, and close(done) last.',
    ],
  },
  {
    id: 'circuit-breaker', level: 'Advanced', minutes: 25,
    title: 'Circuit breaker',
    summary: 'Closed → open → half-open: fail fast while a dependency is down and probe it safely.',
    concepts: ['circuit-breaker'], lesson: 'm07/pattern-circuit-breaker',
    hints: [
      'Fields: `mu sync.Mutex`, `state State`, `failures int`, `openedAt time.Time`, `probing bool`.',
      'Write one helper that turns Open into HalfOpen once `Now().Sub(openedAt) >= Cooldown`, and call it at the top of Allow and State.',
      'In HalfOpen, Allow sets probing=true for the first caller and returns ErrOpen for the rest. Record clears probing and either closes or re-opens (resetting openedAt).',
    ],
  },
  {
    id: 'saga', level: 'Advanced', minutes: 25,
    title: 'Saga orchestrator',
    summary: 'Run multi-service steps and compensate completed ones in reverse when a later step fails.',
    concepts: ['saga', 'distributed-transactions'], lesson: 'm07/pattern-saga',
    hints: [
      'Track the index of the failing step; the completed steps are `steps[:i]`. Walk them backwards.',
      'Retry each compensation in a small loop (3 attempts). Collect the ones that still fail and keep going.',
      'Return `errors.Join(stepErr, compErr)`. Check `ctx.Err()` before each action, and compensate with `context.WithoutCancel(ctx)`.',
    ],
  },
  {
    id: 'outbox', level: 'Advanced', minutes: 25,
    title: 'Transactional outbox',
    summary: 'Write the order and its event atomically, then relay events in order without losing any.',
    concepts: ['outbox', 'transactions'], lesson: 'm07/pattern-outbox', support: true,
    hints: [
      'One transaction: `tx := db.Begin(); defer tx.Rollback()`, then InsertOrder, InsertOutbox, and `return tx.Commit()`.',
      'Marshal the payload before you begin the transaction — keep transactions short.',
      'In PublishPending, return as soon as publish fails (with the count so far). Call MarkPublished only after publish returns nil.',
    ],
  },
];

/* The free-form scratchpad: no tests, just `go run`. */
MV.data.scratch = {
  id: 'scratch', title: 'Go scratchpad',
  summary: 'A free-form Go program you can edit and run — try an idea from a lesson.',
  examples: [
    { file: 'starter.go.txt', title: 'Fan-out with a deadline', desc: 'Goroutines, WaitGroup and context.WithTimeout.' },
    { file: 'http-handler.go.txt', title: 'JSON handler + httptest', desc: 'Decode, validate and respond — tested without a network.' },
    { file: 'json-events.go.txt', title: 'Versioned event envelopes', desc: 'json.RawMessage and tolerant readers.' },
  ],
};
