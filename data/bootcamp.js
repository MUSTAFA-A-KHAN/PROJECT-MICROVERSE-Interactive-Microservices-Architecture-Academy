/* ==========================================================================
   Microverse — the guided three-hour bootcamp (6 × 30 minutes).
   Each session reuses lessons, widgets, diagrams, real source files and a
   challenge, and ends with a five-question quiz.
   ========================================================================== */
window.MV = window.MV || {};
MV.data = MV.data || {};

MV.data.bootcamp = [
  {
    id: 's1', num: 1, title: 'Foundations', icon: 'blocks',
    summary: 'Monoliths, microservices, service boundaries and what changes when calls cross a network.',
    objectives: [
      'Explain the three properties that make a service a microservice',
      'Compare the failure behaviour of a monolith, a modular monolith and microservices',
      'Draw boundaries around business capabilities, not tables',
      'Describe partial failure and why a timeout tells you nothing about the outcome',
    ],
    widget: 'arch-compare',
    lessons: ['m01/microservices', 'm01/comparison', 'm01/boundaries', 'm01/distributed-fundamentals'],
    diagram: 'microservices',
    code: { file: 'order-service/internal/model/order.go', at: 'var transitions = map[Status][]Status{', text: 'An aggregate protecting its own invariants: the order lifecycle lives entirely inside Order Service.' },
    challenge: 'shared-db',
    quiz: [
      { concept: 'microservices', question: 'Which property is essential for a microservice?', options: ['It is written in its own language', 'It can be deployed independently and owns its data', 'It has fewer than 500 lines', 'It runs on Kubernetes'], answer: 1, explain: 'Independent deployability plus data ownership (around a business capability) define a microservice.' },
      { concept: 'modular-monolith', question: 'A module crashes in a modular monolith. What fails?', options: ['Only that module’s endpoints', 'Everything — it is still one process', 'Nothing, modules restart independently', 'Only database writes'], answer: 1, explain: 'Module boundaries improve design, not fault isolation: it is one process.' },
      { concept: 'service-boundaries', question: 'Which split is most likely to create a distributed monolith?', options: ['Orders and Billing reacting to each other’s events', 'One service per table, called synchronously together on every request', 'A notification consumer', 'A search service fed by events'], answer: 1, explain: 'Entity services force synchronous coordination for every business operation.' },
      { concept: 'distributed-fundamentals', question: 'A call to Payment Service times out. What do you know?', options: ['It failed', 'It succeeded', 'Nothing certain — it may have completed', 'Payment Service is down'], answer: 2, explain: 'A timeout reports the caller’s waiting, not the callee’s outcome. Use idempotency.' },
      { concept: 'database-per-service', question: 'Analytics asks for read-only access to orders-db. Best response?', options: ['Grant it — read-only is safe', 'Publish events into a warehouse with a documented schema', 'Give them the admin password', 'Copy the database nightly over FTP'], answer: 1, explain: 'Read access still couples them to your schema and load. Events provide a contract.' },
    ],
  },
  {
    id: 's2', num: 2, title: 'Go Project Architecture', icon: 'code-xml',
    summary: 'Project layout, interfaces, dependency injection, handlers, services, repositories and errors.',
    objectives: [
      'Navigate a Go service: cmd/, internal/, handler → service → repository',
      'Declare small interfaces where they are consumed',
      'Wire dependencies explicitly in main() and test with fakes',
      'Map domain errors to HTTP status codes with errors.Is',
    ],
    widget: null,
    lessons: ['m02/project-structure', 'm02/structs-interfaces', 'm02/dependency-injection', 'm02/errors'],
    diagram: 'go-layers',
    code: { file: 'order-service/cmd/server/main.go', at: '// Wiring', text: 'The composition root: every concrete type is created here and injected — read it as the service’s dependency graph.' },
    trace: 'lifecycle',
    challenge: 'double-click', exercise: 'http-middleware',
    quiz: [
      { concept: 'go-structure', question: 'What does placing code under internal/ guarantee?', options: ['Faster compilation', 'Only code in the same module tree can import it', 'It is excluded from tests', 'It runs in a separate goroutine'], answer: 1, explain: 'The Go toolchain enforces internal/ visibility, protecting your freedom to change it.' },
      { concept: 'interfaces', question: 'Where should OrderService’s Repository interface be declared?', options: ['In the repository package', 'In the service package that uses it', 'In a shared interfaces module', 'Nowhere — use concrete types'], answer: 1, explain: 'Consumer-side interfaces stay small and don’t couple the consumer to the implementation.' },
      { concept: 'dependency-injection', question: 'Why accept a UserDirectory interface in NewOrderService?', options: ['Interfaces are faster', 'So tests and main can supply any implementation', 'Go requires it', 'To avoid importing context'], answer: 1, explain: 'Constructor injection keeps dependencies explicit and swappable.' },
      { concept: 'error-handling', question: 'Which check detects a wrapped ErrNotFound?', options: ['err == ErrNotFound', 'errors.Is(err, ErrNotFound)', 'err.Error() == "not found"', 'err != nil'], answer: 1, explain: 'errors.Is walks the chain built by %w.' },
      { concept: 'error-handling', question: 'A dependency is down. Which status lets clients know a retry may work?', options: ['400', '404', '500', '503 with Retry-After'], answer: 3, explain: '503 + Retry-After signals a temporary condition worth retrying later.' },
    ],
  },
  {
    id: 's3', num: 3, title: 'Service Communication', icon: 'arrow-left-right',
    summary: 'How User Service and Order Service talk: synchronous REST, events, timeouts and retries.',
    objectives: [
      'Decide per interaction between synchronous calls and events',
      'Configure a Go HTTP client with deadlines and connection reuse',
      'Explain how sync chains multiply unavailability',
      'Follow an order from the gateway to the notification email',
    ],
    widget: 'comm-sim',
    lessons: ['m03/oms-overview', 'm03/inter-service', 'm05/sync-vs-async', 'm05/rest-http'],
    diagram: 'oms',
    code: { file: 'order-service/internal/client/user_client.go', at: 'func (c *UserClient) getOnce(', text: 'One attempt of the Order → User call: per-attempt deadline, request-ID propagation, body draining and status translation.' },
    trace: 'create-order',
    challenge: 'user-down', exercise: 'retry-backoff',
    quiz: [
      { concept: 'sync-communication', question: 'Order Service needs the customer’s status to accept an order. Which style?', options: ['Async event', 'Synchronous call (with timeout and fallback)', 'Nightly batch', 'Shared database read'], answer: 1, explain: 'The answer is needed to decide, so it’s synchronous — protected by timeouts, retries and a breaker.' },
      { concept: 'event-driven', question: 'Sending the confirmation email should be…', options: ['Synchronous, inside the request', 'An event consumed asynchronously', 'Done by the gateway', 'Skipped'], answer: 1, explain: 'It’s a side effect: publish an event so the request doesn’t depend on email availability.' },
      { concept: 'timeouts', question: 'What does http.DefaultClient use as its timeout?', options: ['30 s', '10 s', 'None', '1 s'], answer: 2, explain: 'No timeout at all — always configure your own client and use context deadlines.' },
      { concept: 'sync-communication', question: 'Four services at 99.9% in a synchronous chain give roughly…', options: ['99.9%', '99.6%', '96%', '99.99%'], answer: 1, explain: '0.999⁴ ≈ 99.6% — four times the downtime of one service.' },
      { concept: 'messaging', question: 'With RabbitMQ, when should a consumer ack a message?', options: ['On delivery', 'After the work succeeded', 'Before parsing it', 'Never'], answer: 1, explain: 'Acking after success gives at-least-once delivery; auto-ack can lose messages.' },
    ],
  },
  {
    id: 's4', num: 4, title: 'API Gateway and Security', icon: 'shield-check',
    summary: 'Routing, JWT authentication, authorisation in services, middleware and rate limiting.',
    objectives: [
      'Trace a request through every gateway stage and explain each status code',
      'Verify JWTs locally and propagate identity safely',
      'Keep authorisation in the service that owns the data',
      'Implement distributed rate limiting with a token bucket',
    ],
    widget: 'gateway-sim',
    lessons: ['m04/gateway-intro', 'm04/gateway-auth', 'm04/rate-limiting', 'm02/middleware'],
    diagram: 'jwt-flow',
    code: { file: 'api-gateway/middleware/auth.go', at: 'func JWTAuth(', text: 'Strict JWT verification at the edge: pinned algorithm, issuer, audience, expiry and clock-skew leeway.' },
    challenge: 'traffic-10k', exercise: 'token-bucket',
    quiz: [
      { concept: 'jwt-auth', question: 'Why can the gateway authenticate without calling User Service?', options: ['It caches the users table', 'It verifies the token’s signature locally', 'JWTs are encrypted', 'User Service pushes sessions'], answer: 1, explain: 'Signature verification is a local cryptographic check.' },
      { concept: 'authorization', question: 'Who must check that order 9000 belongs to the caller?', options: ['The gateway', 'Order Service', 'User Service', 'The client'], answer: 1, explain: 'Authorisation depends on data owned by Order Service.' },
      { concept: 'reverse-proxy', question: 'Why strip client-supplied X-User-ID at the gateway?', options: ['To save bytes', 'Services trust it; clients could impersonate users', 'HTTP/2 forbids it', 'Gin rejects it'], answer: 1, explain: 'Identity headers must only come from the verified token.' },
      { concept: 'rate-limiting', question: 'Why use a Lua script for the Redis token bucket?', options: ['Lua is faster than Go', 'It makes read-modify-write atomic across replicas', 'Redis requires Lua', 'To encrypt counters'], answer: 1, explain: 'Separate GET/SET commands race; a script runs atomically.' },
      { concept: 'middleware', question: 'Why does RequestID run before Logger?', options: ['Alphabetical order', 'So every log line carries the request ID', 'Logger needs the JWT', 'It doesn’t matter'], answer: 1, explain: 'Middleware order is part of correctness.' },
    ],
  },
  {
    id: 's5', num: 5, title: 'Distributed Systems', icon: 'network',
    summary: 'Messaging, retries, circuit breakers, the outbox and sagas — making failure safe.',
    objectives: [
      'Combine timeouts, retries with jitter and circuit breakers correctly',
      'Publish events atomically with the transactional outbox',
      'Coordinate multi-service workflows with sagas and compensation',
      'Make consumers idempotent under at-least-once delivery',
    ],
    widget: 'circuit-breaker',
    lessons: ['m07/pattern-circuit-breaker', 'm07/pattern-retry', 'm07/pattern-outbox', 'm07/pattern-saga'],
    diagram: 'p-outbox',
    code: { file: 'order-service/internal/repository/order_repository.go', at: 'func (r *OrderRepository) PublishPending(', text: 'The outbox relay’s claim: FOR UPDATE SKIP LOCKED, ordered publishing, stop at the first failure, mark the rest.' },
    challenge: 'lost-emails', exercise: 'outbox',
    quiz: [
      { concept: 'circuit-breaker', question: 'What happens to calls while a breaker is open?', options: ['Queued', 'Fail immediately', 'Retried', 'Sent with a shorter timeout'], answer: 1, explain: 'Failing fast protects the caller and gives the dependency room to recover.' },
      { concept: 'retries', question: 'Why add jitter to backoff?', options: ['To retry faster', 'To desynchronise clients and avoid waves', 'To guarantee success', 'Because timers are imprecise'], answer: 1, explain: 'Without jitter, clients that failed together retry together.' },
      { concept: 'outbox', question: 'What does the transactional outbox solve?', options: ['Slow queries', 'The dual write of DB + broker', 'Authentication', 'Pagination'], answer: 1, explain: 'The event is committed with the state change, so it can’t be lost.' },
      { concept: 'saga', question: 'Inventory fails after payment succeeded. The saga…', options: ['Rolls back the DB', 'Runs the refund compensation and cancels the order', 'Retries forever', 'Ignores it'], answer: 1, explain: 'Compensations semantically undo completed steps in reverse order.' },
      { concept: 'idempotency', question: 'Why must consumers be idempotent with an outbox?', options: ['They aren’t required to be', 'The relay can re-publish after a crash (at-least-once)', 'RabbitMQ duplicates every message', 'For speed'], answer: 1, explain: 'A crash between publish and marking re-publishes the batch.' },
    ],
  },
  {
    id: 's6', num: 6, title: 'Deployment and Observability', icon: 'ship-wheel',
    summary: 'Docker, Compose, Kubernetes rollouts and autoscaling, probes, logs, metrics and traces.',
    objectives: [
      'Build small, secure images with multi-stage Dockerfiles',
      'Design liveness and readiness probes that help instead of harm',
      'Roll out without downtime and scale within downstream limits',
      'Use RED metrics, structured logs and traces to diagnose incidents',
    ],
    widget: 'k8s-sim',
    lessons: ['m08/dockerfiles', 'm09/structured-logging', 'm09/health-probes', 'm10/scaling-rollouts'],
    diagram: 'k8s-objects',
    code: { file: 'deploy/k8s/order-service.yaml', at: 'kind: Deployment', text: 'The Deployment: rolling-update strategy, probes, resource requests and limits, GOMEMLIMIT and a hardened security context.', lang: 'yaml' },
    challenge: 'slow-db',
    quiz: [
      { concept: 'dockerfile', question: 'Why copy go.mod/go.sum before the source?', options: ['Required by Go', 'To cache the dependency layer', 'Smaller image', 'Faster runtime'], answer: 1, explain: 'Code-only changes then skip module downloads.' },
      { concept: 'probes', question: 'The database blips. Which probe should fail?', options: ['Liveness', 'Readiness', 'Both', 'Neither'], answer: 1, explain: 'Remove the pod from traffic; don’t restart it.' },
      { concept: 'rolling-deploys', question: 'With maxUnavailable: 0, a broken v2 never becomes ready. Result?', options: ['Outage', 'The rollout stalls; v1 keeps serving', 'Automatic rollback', '50/50 split'], answer: 1, explain: 'Old pods are removed only after new ones are ready.' },
      { concept: 'metrics', question: 'Which label is safe on a request counter?', options: ['user_id', 'raw URL path', 'route template', 'request ID'], answer: 2, explain: 'Route templates have bounded cardinality.' },
      { concept: 'autoscaling', question: 'What limits how far Order Service can scale out?', options: ['Nothing', 'Downstream limits such as Postgres connections', 'The number of namespaces', 'The Docker version'], answer: 1, explain: 'replicas × pool size must fit max_connections.' },
    ],
  },
];
