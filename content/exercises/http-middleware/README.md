Every service needs the same plumbing: request IDs for tracing, panic recovery, logging, auth. Middleware wraps a handler so that plumbing is written once. Gin's `r.Use(...)` is this same idea; here you build it with plain `net/http`.

```text
 request → RequestID → Recover → handler
 response ←──────────←─────────←
```

## Your task

1. **`Chain(h, A, B)`** must run `A → B → h`: the first middleware listed is the outermost.
2. **`RequestID(newID)`**: reuse an incoming `X-Request-ID` or generate one; set it on the request *and* the response.
3. **`Recover(logf)`**: `recover()` a panic, log it (include the path), reply `500` with `{"error":"internal"}`.

## Hints

- `http.HandlerFunc(func(w, r) { ... })` turns a function into an `http.Handler`.
- `recover()` only works inside a deferred function in the same goroutine.
- Header values must be set **before** `WriteHeader`.

Compare with the gateway's Gin middleware in the [Code Playground](#/playground?file=api-gateway/middleware/requestid.go).

Background: [Gin middleware](#/lesson/m02/middleware).
