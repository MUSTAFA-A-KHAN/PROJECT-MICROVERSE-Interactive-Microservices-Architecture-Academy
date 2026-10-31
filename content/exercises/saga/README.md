An order touches three services, and there is no distributed transaction. A **saga** runs a local transaction in each service and, if a later step fails, runs **compensating actions** to undo the earlier ones.

```text
 reserve stock ✓ → charge card ✓ → ship ✗
                    undo charge ← undo reserve ←
```

## Your task

Make `Run` a real saga orchestrator:

1. Run steps in order. On failure, compensate the **completed** steps, newest first. The failed step is not compensated.
2. Return an error that wraps the cause and names the step.
3. Retry each compensation up to **3 attempts**. If it still fails, wrap `ErrCompensationFailed` (naming the step) and **keep compensating** the other steps.
4. Skip steps whose `Compensate` is `nil`.
5. If `ctx` is cancelled, don't start the next step, but still compensate. Give compensations `context.WithoutCancel(ctx)` so they can finish.

## Hints

- `errors.Join(a, b)` wraps both errors; `errors.Join(a, nil)` is just `a`.
- `fmt.Errorf("%w: %w", ErrCompensationFailed, err)` wraps two errors at once (Go 1.20+).

Compensations must be idempotent too: a retried "refund" must not refund twice.

Background: [Saga pattern](#/lesson/m07/pattern-saga).
