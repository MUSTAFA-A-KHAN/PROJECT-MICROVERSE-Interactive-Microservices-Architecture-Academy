/* ==========================================================================
   Microverse — scenario-based engineering challenges.
   Each challenge: business problem → architecture → your proposal (checked
   against a rubric) → candidate approaches with verdicts → the engineering
   approach, Go implementation and trade-offs (content/challenges.md).
   ========================================================================== */
window.MV = window.MV || {};
MV.data = MV.data || {};

MV.data.challenges = [
  {
    id: 'double-click', level: 'Beginner', minutes: 12,
    title: 'Three clicks, three orders?',
    tagline: 'A customer taps “Place order” three times because the first request looks stuck.',
    concepts: ['idempotency', 'retries'],
    diagram: 'p-idempotency',
    problem: 'On a slow mobile connection, a customer taps **Place order** three times in four seconds. Support finds **three orders and three card charges** for one basket. The checkout button is already disabled after the first tap on the web, but the iOS app retries automatically on timeout, and Android users can tap again after leaving and re-opening the screen.',
    context: [
      'POST /api/v1/orders creates an order and charges the card via Payment Service.',
      'The mobile app retries automatically after a 10 s timeout.',
      'Peak traffic: 300 orders per minute.',
    ],
    rubric: [
      { label: 'Use an idempotency key that identifies the customer’s intent', words: ['idempotency', 'idempotent', 'request id', 'dedup', 'de-dup', 'unique key'] },
      { label: 'Reuse the same key on every retry of the same checkout', words: ['same key', 'reuse', 'retry', 'retries', 'per checkout', 'per order attempt'] },
      { label: 'Enforce uniqueness atomically in the database', words: ['unique', 'constraint', 'primary key', 'on conflict', 'transaction', 'atomic'] },
      { label: 'Return the original response for a duplicate', words: ['return the original', 'same response', 'stored response', 'replay', 'existing order', 'previous result'] },
      { label: 'Pass the key on to Payment Service', words: ['payment', 'stripe', 'charge'] },
    ],
    approaches: [
      { text: 'Disable the button after the first tap.', verdict: 'partial', why: 'Good UX, but it cannot stop automatic retries, a second device, or a re-opened screen. Client-side prevention is never sufficient for money.' },
      { text: 'Check whether the customer created an identical order in the last 60 seconds and reject it.', verdict: 'poor', why: 'A heuristic that blocks legitimate repeat purchases and still races: two concurrent requests can both see “no recent order”.' },
      { text: 'Require an Idempotency-Key per checkout; claim it with a unique constraint in the same transaction as the order; replay the stored result on duplicates; forward the key to Payment Service.', verdict: 'best', why: 'Race-free, works for any retry source, and makes the whole chain (including the charge) exactly-once in effect.' },
      { text: 'Use a distributed lock in Redis around order creation.', verdict: 'poor', why: 'Locks serialise concurrent requests but don’t remember completed ones — a retry after the lock is released creates a second order. Redis failure semantics add new edge cases.' },
    ],
  },
  {
    id: 'shared-db', level: 'Beginner', minutes: 10,
    title: 'Reporting wants to read our tables',
    tagline: 'The analytics team asks for read-only credentials to orders-db.',
    concepts: ['database-per-service', 'event-driven'],
    diagram: 'db-per-service',
    problem: 'The Analytics team needs daily revenue per customer segment. They ask the Order team for **read-only credentials to orders-db** so they can join `orders` with their own data. "It\'s read-only, what could go wrong?"',
    context: [
      'orders-db is sized for transactional load; peak checkout is 18:00–21:00.',
      'The Order team plans to split `orders.total_cents` into net, tax and shipping next quarter.',
      'Analytics needs data within 15 minutes, not real time.',
    ],
    rubric: [
      { label: 'Keep the database private to Order Service', words: ['private', 'own', 'ownership', 'database per service', 'no direct access', 'credentials'] },
      { label: 'Explain the schema coupling risk', words: ['schema', 'column', 'rename', 'break', 'coupl', 'contract'] },
      { label: 'Explain the runtime/load risk', words: ['load', 'lock', 'slow query', 'performance', 'connection', 'peak'] },
      { label: 'Provide data via events, CDC or an export', words: ['event', 'cdc', 'debezium', 'warehouse', 'export', 'stream', 'pipeline', 'replica'] },
    ],
    approaches: [
      { text: 'Grant read-only credentials; analytics queries only SELECT.', verdict: 'poor', why: 'Read-only still couples them to the schema (next quarter’s split breaks their reports) and their heavy queries compete with checkout for CPU, I/O and connections.' },
      { text: 'Give them a read replica of orders-db.', verdict: 'partial', why: 'Removes runtime load, but the schema is still an undeclared contract — the column split still breaks them.' },
      { text: 'Publish order events (or CDC through the outbox) into the analytics warehouse, with a documented schema the Order team supports.', verdict: 'best', why: 'Analytics gets fresh data in minutes, the event schema is an explicit, versioned contract, and orders-db stays private.' },
    ],
  },
  {
    id: 'lost-emails', level: 'Beginner', minutes: 12,
    title: '“I never got a confirmation email”',
    tagline: 'About 0.2% of orders never trigger the confirmation email.',
    concepts: ['outbox', 'messaging'],
    diagram: 'p-outbox',
    problem: 'Support reports that roughly **1 in 500 customers** never receives an order confirmation. The orders exist in the database and look normal. Order Service publishes `order.created` to RabbitMQ right after committing the order. The missing emails cluster around deploys and around a RabbitMQ maintenance window last Tuesday.',
    context: [
      'Code: `tx.Commit()` then `publisher.Publish(order.created)`.',
      'Deploys happen ~10 times a day with rolling updates.',
      'Notification Service consumes from a durable queue with manual acks.',
    ],
    rubric: [
      { label: 'Identify the dual-write problem (commit and publish are not atomic)', words: ['dual write', 'dual-write', 'atomic', 'crash between', 'not atomic', 'after commit', 'two writes'] },
      { label: 'Use a transactional outbox (or CDC)', words: ['outbox', 'cdc', 'change data capture', 'debezium'] },
      { label: 'Publish with retries and broker confirms', words: ['confirm', 'retry', 'relay', 'acknowledg'] },
      { label: 'Make consumers idempotent (at-least-once)', words: ['idempotent', 'dedup', 'duplicate', 'at-least-once', 'at least once'] },
    ],
    approaches: [
      { text: 'Retry the publish up to 3 times before returning the response.', verdict: 'partial', why: 'Helps with brief broker blips, but a crash or SIGKILL between commit and publish (exactly what deploys cause) still loses the event.' },
      { text: 'Publish first, then commit.', verdict: 'poor', why: 'Now a failed commit emails customers about orders that don’t exist.' },
      { text: 'Write the event to an outbox table in the order’s transaction; a relay publishes with confirms and marks rows sent; consumers de-duplicate by event ID.', verdict: 'best', why: 'The event is durable the moment the order is. Crashes and broker outages only delay delivery.' },
    ],
  },
  {
    id: 'user-down', level: 'Intermediate', minutes: 15,
    title: 'Order Service can’t reach User Service',
    tagline: 'User Service is down; checkout is failing and the gateway is struggling.',
    concepts: ['circuit-breaker', 'timeouts', 'retries', 'sync-communication'],
    diagram: 'oms-comm',
    problem: 'A bad config push crashed every User Service pod. Order Service calls `GET /internal/users/{id}` on every order. Its HTTP client uses `http.DefaultClient`. Within two minutes, checkout fails, **the gateway’s memory doubles**, and even unrelated routes become slow. User Service is fixed after 12 minutes, but checkout takes another 6 minutes to recover because of a flood of requests.',
    context: [
      'Order Service: 400 orders/min at peak; 12 replicas.',
      'Customer validation only needs to know whether the account is active.',
      'Product says: losing orders is worse than accepting an order from a suspended account for a few minutes.',
    ],
    rubric: [
      { label: 'Add timeouts (per attempt and overall deadline)', words: ['timeout', 'deadline', 'context.withtimeout', 'ctx'] },
      { label: 'Retry transient failures with backoff and jitter, bounded', words: ['backoff', 'jitter', 'retry', 'retries', 'exponential'] },
      { label: 'Use a circuit breaker to fail fast and let it recover', words: ['circuit', 'breaker', 'fail fast'] },
      { label: 'Provide a fallback / degraded mode', words: ['fallback', 'degrad', 'pending verification', 'cache', 'jwt claim', 'accept'] },
      { label: 'Reduce the synchronous dependency (cache, replica via events, claims)', words: ['event', 'replica', 'local copy', 'cache', 'claims', 'async'] },
    ],
    approaches: [
      { text: 'Increase the HTTP client timeout to 30 s so slow responses still succeed.', verdict: 'poor', why: 'Longer waits hold more goroutines and connections — the cause of the gateway’s memory growth. It makes the cascade worse.' },
      { text: 'Retry every failed call 5 times immediately.', verdict: 'poor', why: 'Multiplies load by 5× on a dependency that is down, and the retry flood is what delayed recovery after the fix.' },
      { text: 'Per-attempt timeouts (800 ms) within the request deadline, 3 jittered retries, a circuit breaker, and a fallback that accepts the order as pending verification when the breaker is open.', verdict: 'best', why: 'Bounded resource use, fast failure while the dependency is down, gentle probing during recovery, and orders keep flowing in a documented degraded mode.' },
      { text: 'Merge User Service into Order Service.', verdict: 'partial', why: 'Removes the network call but couples two capabilities and teams. Sometimes right, but a big change to fix a missing timeout.' },
    ],
  },
  {
    id: 'slow-db', level: 'Intermediate', minutes: 15,
    title: 'The database is responding slowly',
    tagline: 'orders-db p99 went from 5 ms to 900 ms. What happens across the system?',
    concepts: ['connection-pooling', 'timeouts', 'probes', 'bulkhead'],
    diagram: 'p-timeout',
    problem: 'A new analytics query without an index runs every minute against orders-db, holding locks and saturating I/O. Query p99 rises from **5 ms to 900 ms**. Within minutes: Order Service latency climbs, the gateway returns 504s, Kubernetes restarts Order Service pods, and User Service — which never touches orders-db — starts timing out too.',
    context: [
      'Order Service pool: 10 connections per replica; 6 replicas.',
      'Order Service liveness probe runs `SELECT 1` against orders-db.',
      'User Service and Order Service share the gateway’s goroutine budget; the gateway has no per-route timeout.',
    ],
    rubric: [
      { label: 'Explain pool exhaustion: requests queue for connections', words: ['pool', 'connection', 'queue', 'waiting', 'exhaust', 'saturat'] },
      { label: 'Bound waits: statement/query timeouts and request deadlines', words: ['timeout', 'statement_timeout', 'deadline', 'ctx'] },
      { label: 'Fix the probe design: liveness must not check the database', words: ['liveness', 'readiness', 'probe', 'restart'] },
      { label: 'Isolate resources so other routes are unaffected (bulkheads, per-route timeouts)', words: ['bulkhead', 'isolat', 'per-route', 'per route', 'separate pool', 'circuit'] },
      { label: 'Find and fix the root cause (the query / index / lock)', words: ['index', 'explain', 'pg_stat', 'kill', 'query', 'lock'] },
    ],
    approaches: [
      { text: 'Increase the pool to 50 connections per replica.', verdict: 'poor', why: '6 × 50 = 300 connections overwhelms Postgres (max_connections) and adds more concurrent load to an already saturated database.' },
      { text: 'Move liveness to a process-only check, use readiness for the DB, add statement and per-route timeouts, alert on pool wait time — and fix the unindexed query.', verdict: 'best', why: 'Stops the restart storm, bounds every wait so the slowness can’t spread, makes the saturation visible, and removes the cause.' },
      { text: 'Add a Redis cache in front of every order query.', verdict: 'partial', why: 'May reduce read load later, but does nothing for writes, adds staleness, and doesn’t address the cascading failure.' },
    ],
  },
  {
    id: 'breaking-api', level: 'Intermediate', minutes: 12,
    title: 'An incompatible User Service release',
    tagline: 'v2 renames a field Order Service depends on. Ship it without breaking anyone.',
    concepts: ['api-contracts', 'independent-deployment', 'rolling-deploys'],
    diagram: 'api-versioning',
    problem: 'User Service v2 changes `GET /internal/users/{id}`: `status: "active"` becomes `state: { active: true, reason: null }`. Order Service reads `status`. Both teams deploy independently with rolling updates. Last time a field was renamed, checkout was down for 40 minutes during the deploy window.',
    context: [
      'During a rolling update, v1 and v2 User Service pods serve traffic simultaneously.',
      'Order Service deploys on its own schedule, usually weekly.',
      'Two other services also call this endpoint; one is owned by another org.',
    ],
    rubric: [
      { label: 'Keep it backward compatible: add the new field, keep the old one (expand/contract)', words: ['expand', 'contract', 'backward', 'both fields', 'keep the old', 'additive', 'add the new'] },
      { label: 'Or version the API and serve both versions', words: ['version', '/v2', 'v1', 'header'] },
      { label: 'Use consumer-driven contract tests in CI', words: ['contract test', 'pact', 'consumer-driven', 'consumer driven', 'ci'] },
      { label: 'Deprecate with headers/communication and remove only when traffic is zero', words: ['deprecat', 'sunset', 'metric', 'traffic', 'remove later', 'announce'] },
    ],
    approaches: [
      { text: 'Coordinate a simultaneous deploy of User Service and every consumer.', verdict: 'poor', why: 'Rolling updates guarantee a window where old and new run together, and you can’t coordinate an external org’s deploys. This is how the 40-minute outage happened.' },
      { text: 'Add `state` alongside `status` (expand), migrate consumers, verify with contract tests and metrics, then remove `status` (contract).', verdict: 'best', why: 'Every intermediate state is compatible, deploy order doesn’t matter, and removal is driven by evidence.' },
      { text: 'Serve `/v2/users/{id}` with the new shape and keep `/v1` until consumers migrate.', verdict: 'best', why: 'Equally valid for larger changes: explicit versions, deprecation headers, and removal once v1 traffic is zero.' },
      { text: 'Make Order Service tolerate both shapes and deploy User Service v2 right away.', verdict: 'partial', why: 'Works for consumers you control — but only after they deploy first, and not for the external org’s service.' },
    ],
  },
  {
    id: 'payment-crash', level: 'Advanced', minutes: 18,
    title: 'Paid, but the order never updated',
    tagline: 'Payment succeeds, then Order Service crashes before updating the order.',
    concepts: ['saga', 'outbox', 'idempotency', 'distributed-transactions'],
    diagram: 'p-saga',
    problem: 'Checkout calls Payment Service synchronously, then sets the order to `CONFIRMED`. During a deploy, an Order Service pod is killed **after Payment Service charged the card but before the status update committed**. The customer is charged; the order stays `PENDING` forever; no email is sent; the warehouse never ships.',
    context: [
      'Payment Service is an external provider wrapper; charges are idempotent by key.',
      'There is no global transaction across Order Service and the payment provider.',
      'Finance reconciles payments against orders monthly — too late for customers.',
    ],
    rubric: [
      { label: 'Model the flow as a saga with persisted state', words: ['saga', 'orchestrat', 'state machine', 'workflow', 'persist'] },
      { label: 'Make payment idempotent with a key derived from the order', words: ['idempotency', 'idempotent', 'key', 'order id'] },
      { label: 'Resume or retry after crashes (recovery job / durable workflow)', words: ['resume', 'recover', 'reconcil', 'retry', 'background', 'temporal', 'sweeper'] },
      { label: 'Use events + outbox (e.g. payment.captured) instead of in-memory sequencing', words: ['outbox', 'event', 'payment.captured', 'webhook', 'message'] },
      { label: 'Define compensation (refund) if the order can’t be completed', words: ['compensat', 'refund', 'rollback', 'cancel'] },
    ],
    approaches: [
      { text: 'Wrap the payment call and the status update in one database transaction.', verdict: 'poor', why: 'The payment provider is not in your database transaction; rolling back the DB doesn’t un-charge the card.' },
      { text: 'Persist the saga step before calling Payment Service (with an idempotency key = order ID); a recovery worker resumes PENDING sagas by re-querying or re-sending the idempotent charge, then confirms the order and publishes via the outbox; refund if the order can’t be fulfilled.', verdict: 'best', why: 'Every step is durable and repeatable, crashes become delays, and inconsistent states are detected and repaired automatically within minutes.' },
      { text: 'Rely on the monthly finance reconciliation.', verdict: 'poor', why: 'Customers wait weeks; support load explodes; it treats a design flaw as an accounting problem.' },
      { text: 'Use a durable workflow engine (Temporal, Step Functions) to orchestrate payment and confirmation.', verdict: 'best', why: 'Same design with persistence, retries and timers provided by the engine — a strong choice once several such workflows exist.' },
    ],
  },
  {
    id: 'traffic-10k', level: 'Advanced', minutes: 18,
    title: '10,000 requests per second',
    tagline: 'One service suddenly receives 10k req/s. Keep the whole system available.',
    concepts: ['rate-limiting', 'autoscaling', 'caching', 'bulkhead', 'circuit-breaker'],
    diagram: 'oms',
    problem: 'A partner integration ships with a bug that polls `GET /api/v1/orders/{id}` in a tight loop. Order Service traffic jumps from 300 to **10,000 requests per second**. Order Service saturates, its pool exhausts orders-db connections, the gateway queues requests, and checkout for regular customers starts failing.',
    context: [
      'Each Order Service pod handles ~400 req/s; HPA max is 12.',
      'orders-db max_connections = 200.',
      'The partner authenticates with its own API key.',
    ],
    rubric: [
      { label: 'Rate-limit per client/API key at the gateway (429 + Retry-After)', words: ['rate limit', 'rate-limit', '429', 'throttl', 'token bucket', 'per client', 'api key', 'quota'] },
      { label: 'Shed load / prioritise critical traffic', words: ['shed', 'priorit', 'critical', 'drop', 'reject'] },
      { label: 'Cache hot reads (CDN, Redis, ETag/304)', words: ['cache', 'redis', 'etag', 'cdn', '304'] },
      { label: 'Autoscale within downstream limits (pool budget)', words: ['autoscal', 'hpa', 'scale', 'replica', 'max_connections', 'pool'] },
      { label: 'Isolate with bulkheads/breakers so checkout survives', words: ['bulkhead', 'isolat', 'circuit', 'separate', 'checkout'] },
    ],
    approaches: [
      { text: 'Raise HPA maxReplicas to 40.', verdict: 'poor', why: '40 × 10 connections = 400 > orders-db’s 200: scaling out the service just moves the failure into the database — and rewards the buggy client with more capacity.' },
      { text: 'Per-API-key rate limits at the gateway, a short-TTL cache with ETags for order reads, load shedding that protects checkout, and autoscaling capped by the DB connection budget.', verdict: 'best', why: 'Stops the abusive client at the edge, makes legitimate reads cheap, and keeps critical paths available even under overload.' },
      { text: 'Block the partner’s IP address.', verdict: 'partial', why: 'A valid emergency stop, but blunt: partners share IPs with others, and a rate limit with a clear 429 lets them fix their client without an outage.' },
    ],
  },
];

MV.data.challengeLevels = ['Beginner', 'Intermediate', 'Advanced'];
