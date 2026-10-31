Handlers translate domain errors into HTTP status codes. Get the mapping wrong and clients retry things that will never succeed — or give up on things that would.

## Your task

1. Make `FindOrder` return an error that **wraps** `ErrNotFound` and mentions the id.
2. Implement `StatusFor`:

| Error | Status |
|---|---|
| `nil` | 200 |
| wraps `ErrNotFound` | 404 |
| wraps `ErrInvalidTransition` | 409 |
| contains a `*ValidationError` | 422 |
| anything else | 500 |

## Rules

- Use `fmt.Errorf("...: %w", err)` to wrap.
- Use `errors.Is` for sentinel errors and `errors.As` for typed errors. Never compare `err.Error()` strings — one test checks this.

Background: [Error handling](#/lesson/m02/errors).
