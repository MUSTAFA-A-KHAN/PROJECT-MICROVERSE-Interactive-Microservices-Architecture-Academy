An order's lifecycle is a state machine. Encoding it explicitly makes illegal states impossible to reach by accident — and makes the rules reviewable at a glance.

```text
PENDING ──► CONFIRMED ──► SHIPPED ──► DELIVERED
   │             │
   └──► CANCELLED ◄┘
```

## Your task

1. `CanTransition(from, to)` — return whether the move is on the diagram above. Encode the allowed moves as a **map**, not a chain of `if`s.
2. `Transition(o, to)`:
   - legal move → update `Status` and increment `Version`;
   - same status → no-op (no error, no version bump) so retried "cancel" requests are safe;
   - illegal move → return an error wrapping `ErrInvalidTransition` that names both statuses, and leave the order untouched.

Background: [Designing the Order Service](#/lesson/m03/order-service).
