A token bucket lets a client burst up to `Capacity` requests, then holds them to a steady `Rate`. It is what the API Gateway uses to answer `429 Too Many Requests` before a noisy client can overload the services behind it.

```text
 refill: +Rate tokens/second, never above Capacity
             ↓
   ┌─────────────────┐
   │ ● ● ● ○ ○       │  Capacity = 5, tokens = 3
   └─────────────────┘
             ↓ each request spends one token — none left → 429
```

## Your task

1. `NewBucket` starts **full**.
2. `Allow`: add `elapsed seconds × Rate` tokens (capped at `Capacity`), then spend one if you have at least one.
3. `RetryAfter`: how long until one whole token is available — `0` if one is available now.
4. `Limiter.Allow(key)`: one bucket per key, created full on first use.

## Rules

- Don't run a ticker goroutine to add tokens: compute the refill lazily from the elapsed time. It costs nothing while idle and works with the injected clock.
- Both types must be safe for concurrent use; the last test fires 400 requests from 20 goroutines and expects **exactly** 100 to succeed.

See the gateway's own limiter in the [Code Playground](#/playground?file=api-gateway/middleware/ratelimit.go).

Background: [Rate Limiting](#/lesson/m07/pattern-rate-limiting).
