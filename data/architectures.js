/* ==========================================================================
   Microverse — architecture data.
   1. MV.data.lab       — the Architecture Lab topology, scenarios, failures
   2. MV.data.diagrams  — declarative SVG diagrams used inside lessons
   Coordinates for diagram nodes are centres; group boxes are top-left.
   ========================================================================== */
window.MV = window.MV || {};
MV.data = MV.data || {};

/* ======================================================================
   1. Architecture Lab
   ====================================================================== */
MV.data.lab = {
  nodes: [
    {
      id: 'client', name: 'Client', tech: 'Browser · Mobile app', kind: 'client', x: 0, y: 300,
      responsibility: 'Sends HTTPS requests with a JWT bearer token and an Idempotency-Key for writes.',
      purpose: 'Represents the web or mobile front end. It only knows one hostname — the gateway — and never talks to internal services directly. It is responsible for retrying safely (with the same Idempotency-Key) when a request times out.',
      apis: [],
      database: 'None. Stores the access token in memory and a refresh token in an HttpOnly cookie.',
      dependencies: ['gateway'],
      flow: ['Build request with Authorization: Bearer <JWT>', 'Generate an Idempotency-Key (UUID) for POST requests', 'Send over HTTPS to api.example.com', 'Retry on network error or 503 with the same key'],
      code: { file: 'order-service/internal/handler/order_handler.go', from: 'func (h *OrderHandler) Create(', lines: 34, note: 'The server side of what the client sends: the handler reads the Idempotency-Key header.' },
      failures: [
        { title: 'Double submit', impact: 'A user clicks "Place order" twice while the first request is slow.', mitigation: 'Send the same Idempotency-Key on every attempt; the Order Service returns the original response instead of creating a second order.' },
        { title: 'Aggressive client retries', impact: 'Thousands of clients retrying immediately after an outage create a thundering herd.', mitigation: 'Exponential backoff with jitter on the client and honour Retry-After headers.' },
      ],
    },
    {
      id: 'gateway', name: 'API Gateway', tech: 'Go · Gin · httputil.ReverseProxy', kind: 'gateway', x: 270, y: 300,
      responsibility: 'Single entry point: request IDs, rate limiting, JWT verification, routing, timeouts and circuit breaking.',
      purpose: 'Terminates client traffic and applies cross-cutting policies once, so services do not each re-implement them. It verifies JWT signatures locally (no call to User Service), injects X-User-ID and X-Request-ID headers, and proxies to the right upstream with a per-route timeout and circuit breaker.',
      apis: [
        { method: 'POST', path: '/api/v1/auth/login', desc: 'Public → user-service' },
        { method: 'POST', path: '/api/v1/users', desc: 'Public (registration) → user-service' },
        { method: 'GET', path: '/api/v1/users/me', desc: 'JWT → user-service' },
        { method: 'POST', path: '/api/v1/orders', desc: 'JWT → order-service' },
        { method: 'GET', path: '/api/v1/orders/:id', desc: 'JWT → order-service' },
        { method: 'POST', path: '/api/v1/orders/:id/cancel', desc: 'JWT → order-service' },
      ],
      database: 'Stateless. Rate-limit buckets live in Redis so every gateway replica shares the same counters.',
      dependencies: ['redis', 'user', 'order'],
      flow: ['RequestID middleware (generate or propagate X-Request-ID)', 'Structured access log', 'Rate limiter: token bucket in Redis (fails open)', 'JWT verification for protected routes', 'Route table lookup', 'Circuit breaker check for the upstream', 'Reverse proxy with timeout'],
      code: { file: 'api-gateway/internal/proxy/proxy.go', from: 'func (p *Proxy) Forward(', lines: 46 },
      failures: [
        { title: 'Gateway is a single point of failure', impact: 'If the only gateway instance dies, everything is down.', mitigation: 'Run several stateless replicas behind a cloud load balancer; keep state (rate limits) in Redis.' },
        { title: 'No upstream timeouts', impact: 'A hung service holds gateway goroutines and connections until the gateway itself runs out of resources.', mitigation: 'Per-route timeouts and a circuit breaker per upstream.' },
      ],
    },
    {
      id: 'user', name: 'User Service', tech: 'Go · Gin · pgx · bcrypt', kind: 'service', x: 560, y: 100,
      responsibility: 'Owns identity: registration, password hashing, login (issues JWTs) and user profiles.',
      purpose: 'The only service allowed to read or write user data. Other services ask it questions through its API (for example, "is user 42 active?") rather than querying users-db. Profiles are cached in Redis with cache-aside.',
      apis: [
        { method: 'POST', path: '/v1/auth/login', desc: 'Verify bcrypt hash, sign JWT (15 min)' },
        { method: 'POST', path: '/v1/users', desc: 'Register' },
        { method: 'GET', path: '/v1/users/me', desc: 'Profile for X-User-ID (cache-aside)' },
        { method: 'GET', path: '/internal/users/:id', desc: 'Service-to-service lookup (status, email)' },
      ],
      database: 'users-db (PostgreSQL): users(id, email UNIQUE, password_hash, name, status, created_at, updated_at)',
      dependencies: ['usersdb', 'redis'],
      flow: ['Handler binds and validates JSON', 'Service applies business rules', 'Repository runs parameterised SQL with ctx', 'Domain errors are mapped to HTTP status codes'],
      code: { file: 'user-service/internal/service/user_service.go', from: 'func (s *UserService) Authenticate(', lines: 36 },
      failures: [
        { title: 'Crash or deploy restart', impact: 'Login and profile requests fail; Order Service cannot validate customers.', mitigation: 'Multiple replicas, readiness probes, and callers with timeouts, retries and breakers.' },
        { title: 'users-db unavailable', impact: 'Every request needing the database returns 503.', mitigation: 'Readiness probe reports not-ready; cached profiles can still be served from Redis.' },
      ],
    },
    {
      id: 'order', name: 'Order Service', tech: 'Go · Gin · pgx · amqp091', kind: 'service', x: 560, y: 500,
      responsibility: 'Owns orders: create (idempotent), read, status transitions and cancellation. Publishes order events via an outbox.',
      purpose: 'Implements the order lifecycle as a state machine. On create it validates the customer with User Service (synchronous, 800 ms timeout), then writes the order and an outbox event in a single Postgres transaction. A background relay publishes outbox rows to RabbitMQ.',
      apis: [
        { method: 'POST', path: '/v1/orders', desc: 'Create (requires Idempotency-Key)' },
        { method: 'GET', path: '/v1/orders/:id', desc: 'Get one order (owner only)' },
        { method: 'GET', path: '/v1/orders', desc: 'List my orders (paginated)' },
        { method: 'PATCH', path: '/v1/orders/:id/status', desc: 'Transition status (admin)' },
        { method: 'POST', path: '/v1/orders/:id/cancel', desc: 'Cancel if PENDING or CONFIRMED' },
      ],
      database: 'orders-db (PostgreSQL): orders, order_items, outbox, idempotency_keys',
      dependencies: ['ordersdb', 'user', 'broker'],
      flow: ['Handler requires Idempotency-Key', 'Service validates customer via UserClient (timeout + retry + breaker)', 'Repository: BEGIN → insert order, items, outbox event, idempotency key → COMMIT', 'Relay goroutine publishes pending outbox rows'],
      code: { file: 'order-service/internal/service/order_service.go', from: 'func (s *OrderService) CreateOrder(', lines: 52 },
      failures: [
        { title: 'Slow handler (lock contention)', impact: 'Requests pile up; without timeouts the gateway waits indefinitely.', mitigation: 'Timeouts at the gateway and on DB queries; context cancellation all the way down.' },
        { title: 'Crash after commit, before publish', impact: 'Without an outbox the event is lost and the notification is never sent.', mitigation: 'Transactional outbox: the event is committed with the order and published later.' },
      ],
    },
    {
      id: 'notify', name: 'Notification Service', tech: 'Go · amqp091 · SMTP', kind: 'worker', x: 560, y: 700,
      responsibility: 'Consumes order events and sends emails. Idempotent: duplicate deliveries are detected and skipped.',
      purpose: 'A pure event consumer with no public API. It acknowledges a message only after the email provider accepts it, so crashes cause redelivery rather than lost emails. Poison messages go to a dead-letter queue after retries.',
      apis: [{ method: 'AMQP', path: 'queue: notifications.order-events', desc: 'Bound to order.created, order.cancelled' }],
      database: 'None of its own in this system. Processed event IDs are tracked in Redis (SETNX with TTL) for de-duplication.',
      dependencies: ['broker'],
      flow: ['Receive delivery (prefetch 20)', 'Check event ID against processed set', 'Render and send email', 'Ack on success; Nack (requeue=false) → DLQ on permanent failure'],
      code: { file: 'notification-service/internal/consumer/consumer.go', from: 'func (c *Consumer) handle(', lines: 38 },
      failures: [
        { title: 'Consumer down', impact: 'Messages accumulate in the queue; nothing is lost.', mitigation: 'Alert on queue depth and consumer count; messages drain on recovery.' },
        { title: 'Poison message', impact: 'A malformed event fails forever and blocks the queue if requeued.', mitigation: 'Reject without requeue after N attempts; inspect the DLQ.' },
      ],
    },
    {
      id: 'usersdb', name: 'users-db', tech: 'PostgreSQL 16', kind: 'db', x: 850, y: 0,
      responsibility: 'Private data store of User Service.',
      purpose: 'Only User Service holds credentials for this database. Schema changes are made with versioned migrations owned by the User Service team.',
      apis: [{ method: 'SQL', path: 'SELECT … FROM users WHERE email = $1', desc: 'Login lookup (unique index on email)' }],
      database: 'Tables: users. Indexes: users_email_key (unique).',
      dependencies: [],
      flow: ['Connections come from User Service pgxpool (max 10 per replica)'],
      code: { file: 'user-service/migrations/000001_create_users.up.sql', from: 'CREATE TABLE', lines: 20, lang: 'sql' },
      failures: [{ title: 'Connection refused / failover', impact: 'User Service cannot authenticate users.', mitigation: 'Managed Postgres with automatic failover; pool health checks; readiness probe.' }],
    },
    {
      id: 'redis', name: 'Redis', tech: 'Redis 7', kind: 'cache', x: 850, y: 300,
      responsibility: 'Shared fast state: gateway rate-limit buckets and the user-profile cache.',
      purpose: 'An in-memory store used for data that can be rebuilt. Nothing in Redis is the source of truth, so losing it degrades performance and rate limiting — it does not lose orders.',
      apis: [
        { method: 'EVAL', path: 'token_bucket.lua', desc: 'Atomic rate-limit check' },
        { method: 'GET/SET', path: 'user:{id}', desc: 'Profile cache, TTL 5 minutes' },
      ],
      database: 'Keys: ratelimit:{user}, user:{id}, notif:processed:{eventId}',
      dependencies: [],
      flow: ['Gateway → EVAL token bucket per request', 'User Service → GET user:{id} before hitting Postgres'],
      code: { file: 'api-gateway/middleware/ratelimit.go', from: 'var tokenBucketScript', lines: 30 },
      failures: [{ title: 'Redis unavailable', impact: 'Rate limiting cannot be evaluated; cache misses go to Postgres.', mitigation: 'Decide fail-open vs fail-closed explicitly; protect Postgres from the extra load.' }],
    },
    {
      id: 'ordersdb', name: 'orders-db', tech: 'PostgreSQL 16', kind: 'db', x: 850, y: 450,
      responsibility: 'Private data store of Order Service, including the outbox table.',
      purpose: 'Orders, items, the outbox and idempotency keys live in one database so they can be written in one ACID transaction.',
      apis: [{ method: 'SQL', path: 'INSERT INTO orders … ; INSERT INTO outbox …', desc: 'Single transaction' }],
      database: 'Tables: orders, order_items, outbox, idempotency_keys',
      dependencies: [],
      flow: ['Connections from Order Service pgxpool', 'Outbox relay uses SELECT … FOR UPDATE SKIP LOCKED'],
      code: { file: 'order-service/migrations/000001_create_orders.up.sql', from: 'CREATE TABLE orders', lines: 44, lang: 'sql' },
      failures: [{ title: 'Connection failure', impact: 'Order creation fails with 503; the breaker opens.', mitigation: 'Failover, readiness probes, and retries for transient errors only.' }],
    },
    {
      id: 'broker', name: 'RabbitMQ', tech: 'RabbitMQ 3.13', kind: 'broker', x: 850, y: 620,
      responsibility: 'Durable message broker for order events (topic exchange "orders").',
      purpose: 'Decouples Order Service from consumers in time: the publisher does not wait for notifications to be sent, and consumers can be down without losing events.',
      apis: [{ method: 'AMQP', path: 'exchange: orders (topic)', desc: 'Routing keys: order.created, order.cancelled' }],
      database: 'Durable queues with persistent messages; dead-letter exchange "orders.dlx".',
      dependencies: ['notify'],
      flow: ['Publisher confirms from the outbox relay', 'Routing by key to bound queues', 'Delivery to consumers with manual ack'],
      code: { file: 'order-service/internal/events/rabbitmq.go', from: 'func (p *RabbitPublisher) Publish(', lines: 42 },
      failures: [{ title: 'Broker unavailable', impact: 'Events cannot be published.', mitigation: 'With an outbox, events wait in Postgres and are published when the broker returns.' }],
    },
  ],
  edges: [
    { id: 'c-g', from: 'client', to: 'gateway', label: 'HTTPS' },
    { id: 'g-r', from: 'gateway', to: 'redis', label: 'rate limit' },
    { id: 'g-u', from: 'gateway', to: 'user', label: '/users/*' },
    { id: 'g-o', from: 'gateway', to: 'order', label: '/orders/*' },
    { id: 'u-db', from: 'user', to: 'usersdb', label: 'SQL' },
    { id: 'u-r', from: 'user', to: 'redis', label: 'cache' },
    { id: 'o-u', from: 'order', to: 'user', label: 'GET /internal/users', labelAt: 0.28 },
    { id: 'o-db', from: 'order', to: 'ordersdb', label: 'SQL tx' },
    { id: 'o-b', from: 'order', to: 'broker', label: 'publish' },
    { id: 'b-n', from: 'broker', to: 'notify', label: 'consume' },
  ],
  scenarios: [
    { id: 'create-order', method: 'POST', path: '/api/v1/orders', label: 'Create an order', desc: 'Authenticated write. Validates the customer, commits order + outbox event, publishes order.created.' },
    { id: 'get-profile', method: 'GET', path: '/api/v1/users/me', label: 'Get my profile', desc: 'Authenticated read with Redis cache-aside in User Service.' },
    { id: 'login', method: 'POST', path: '/api/v1/auth/login', label: 'Log in', desc: 'Public route. bcrypt comparison and JWT signing in User Service.' },
    { id: 'get-order', method: 'GET', path: '/api/v1/orders/8812', label: 'Get an order', desc: 'Authenticated read; Order Service checks ownership.' },
    { id: 'cancel-order', method: 'POST', path: '/api/v1/orders/8812/cancel', label: 'Cancel an order', desc: 'State transition + order.cancelled event.' },
  ],
  failures: [
    { id: 'user-down', label: 'User Service unavailable', short: 'User Service down', node: 'user', icon: 'server-off', desc: 'Process crashed — connections are refused.' },
    { id: 'order-timeout', label: 'Order Service timeout', short: 'Order Service timeout', node: 'order', icon: 'hourglass', desc: 'Handler blocks for ~30s on a row lock.' },
    { id: 'order-500', label: 'HTTP 500 from Order Service', short: 'Order Service 500s', node: 'order', icon: 'bug', desc: 'A bug fails ~60% of requests.' },
    { id: 'usersdb-down', label: 'PostgreSQL failure (users-db)', short: 'users-db down', node: 'usersdb', icon: 'database-zap', desc: 'Connection refused during failover.' },
    { id: 'ordersdb-down', label: 'PostgreSQL failure (orders-db)', short: 'orders-db down', node: 'ordersdb', icon: 'database-zap', desc: 'Connection refused during failover.' },
    { id: 'redis-down', label: 'Redis unavailable', short: 'Redis down', node: 'redis', icon: 'zap-off', desc: 'Cache and rate-limit store unreachable.' },
    { id: 'broker-down', label: 'Message broker unavailable', short: 'RabbitMQ down', node: 'broker', icon: 'mail-x', desc: 'RabbitMQ refuses connections.' },
    { id: 'slow-network', label: 'Slow network', short: 'Slow network', node: null, icon: 'wifi-low', desc: '+250 ms (±100) on every network hop.' },
  ],
  resilience: [
    { id: 'timeouts', label: 'Timeouts', desc: 'Gateway: 2 s per upstream. Order → User client: 800 ms.', default: true },
    { id: 'retries', label: 'Retries with backoff', short: 'Retries + backoff', desc: 'Up to 3 attempts, exponential backoff + jitter, only for idempotent requests.', default: true },
    { id: 'breaker', label: 'Circuit breakers', desc: 'Open after 3 consecutive failures; half-open probe after 8 s.', default: true },
    { id: 'fallback', label: 'Fallbacks', desc: 'Serve stale cache, or accept orders as PENDING_VERIFICATION.', default: false },
    { id: 'outbox', label: 'Transactional outbox', short: 'Outbox', desc: 'Events are committed with the order and published by a relay.', default: true },
  ],
};

/* ======================================================================
   2. Lesson diagrams
   ====================================================================== */
MV.data.diagrams = {
  /* ---------- Module 01 ---------- */
  monolith: {
    title: 'Monolithic architecture', w: 800, h: 320,
    groups: [{ label: 'monolith — one process · one deployable · one release', x: 330, y: 18, w: 300, h: 284, color: 'blue' }],
    nodes: [
      { id: 'client', label: 'Client', sub: 'browser / app', x: 75, y: 160, kind: 'client', w: 130 },
      { id: 'lb', label: 'Load balancer', sub: 'any instance', x: 228, y: 160, kind: 'infra', icon: 'split', w: 140 },
      { id: 'users', label: 'users', sub: 'package users', x: 480, y: 78, kind: 'module', w: 190, h: 48 },
      { id: 'orders', label: 'orders', sub: 'package orders', x: 480, y: 140, kind: 'module', w: 190, h: 48 },
      { id: 'pay', label: 'payments', sub: 'package payments', x: 480, y: 202, kind: 'module', w: 190, h: 48 },
      { id: 'notify', label: 'notifications', sub: 'package notify', x: 480, y: 264, kind: 'module', w: 190, h: 48 },
      { id: 'db', label: 'PostgreSQL', sub: 'one shared schema', x: 720, y: 160, kind: 'db', w: 140 },
    ],
    edges: [
      { id: 'e1', from: 'client', to: 'lb' },
      { id: 'e2', from: 'lb', to: 'orders', label: 'HTTP' },
      { id: 'e3', from: 'orders', to: 'users' },
      { id: 'e4', from: 'orders', to: 'pay' },
      { id: 'e5', from: 'pay', to: 'notify' },
      { id: 'e6', from: 'orders', to: 'db', label: 'one transaction' },
    ],
    steps: [
      { title: 'A request arrives', text: '`POST /orders` reaches the load balancer, which picks any instance. Every instance contains every module.', flow: ['e1', 'e2'], focus: ['orders'] },
      { title: 'In-process calls', text: '`orders` calls `users.Get()` and `payments.Charge()` as ordinary function calls — nanoseconds, no serialisation, no network failures.', flow: ['e3', '-e3', 'e4', 'e5', '-e5', '-e4'], focus: ['orders', 'users', 'pay'] },
      { title: 'One ACID transaction', text: 'Order, payment and stock rows commit in a single database transaction. Either all of it happens or none of it does.', flow: ['e6', '-e6'], focus: ['db'] },
      { title: 'Response', text: 'Simple to build, test, debug and deploy — the right default for a small team or a young product.', flow: ['-e2', '-e1'], color: 'green' },
      { title: 'Shared fate', text: 'A memory leak in `notifications` crashes the process — and takes users, orders and payments down with it. One process means no fault isolation.', states: { notify: 'down', users: 'down', orders: 'down', pay: 'down' }, color: 'err' },
    ],
  },

  microservices: {
    title: 'Microservices architecture', w: 800, h: 390,
    nodes: [
      { id: 'client', label: 'Client', sub: 'browser / app', x: 70, y: 200, kind: 'client', w: 120 },
      { id: 'gw', label: 'API Gateway', sub: 'auth · routing', x: 230, y: 200, kind: 'gateway', w: 150 },
      { id: 'users', label: 'User Service', sub: 'Go · :8081', x: 450, y: 75, kind: 'service' },
      { id: 'orders', label: 'Order Service', sub: 'Go · :8082', x: 450, y: 200, kind: 'service' },
      { id: 'broker', label: 'RabbitMQ', sub: 'order events', x: 450, y: 325, kind: 'broker' },
      { id: 'usersdb', label: 'users-db', sub: 'PostgreSQL', x: 680, y: 75, kind: 'db' },
      { id: 'ordersdb', label: 'orders-db', sub: 'PostgreSQL', x: 680, y: 200, kind: 'db' },
      { id: 'notify', label: 'Notification Svc', sub: 'consumer', x: 680, y: 325, kind: 'worker' },
    ],
    edges: [
      { id: 'e1', from: 'client', to: 'gw' },
      { id: 'e2', from: 'gw', to: 'users' },
      { id: 'e3', from: 'gw', to: 'orders', label: '/orders' },
      { id: 'e4', from: 'users', to: 'usersdb' },
      { id: 'e5', from: 'orders', to: 'ordersdb' },
      { id: 'e6', from: 'orders', to: 'broker' },
      { id: 'e7', from: 'orders', to: 'users', label: 'REST / gRPC' },
      { id: 'e8', from: 'broker', to: 'notify', label: 'order.created' },
    ],
    steps: [
      { title: 'The gateway routes by path', text: '`/api/v1/orders/*` goes to Order Service. Clients never learn internal hostnames.', flow: ['e1', 'e3'], focus: ['gw', 'orders'] },
      { title: 'A network call replaces a function call', text: 'Order Service asks User Service whether the customer may order — over HTTP with a timeout. It can now fail in ways a function call never could.', flow: ['e7', '-e7'], focus: ['orders', 'users'] },
      { title: 'Each service owns its database', text: 'Order Service writes to orders-db. No other service has credentials for it.', flow: ['e5', '-e5'], focus: ['ordersdb'] },
      { title: 'Side effects become events', text: '`order.created` goes to RabbitMQ. Notification Service consumes it later; Order Service does not wait.', flow: ['e6', 'e8'], color: 'purple' },
      { title: 'Response', text: '201 Created returns to the client.', flow: ['-e3', '-e1'], color: 'green' },
      { title: 'Failure is contained', text: 'Notification Service crashes: orders keep flowing, events queue in RabbitMQ and emails go out when it recovers. Compare that with the monolith.', states: { notify: 'down' }, badges: { broker: '+128' } },
    ],
  },

  'bounded-contexts': {
    title: 'Bounded contexts', w: 860, h: 330,
    groups: [
      { label: 'Sales context', x: 18, y: 26, w: 254, h: 280, color: 'blue' },
      { label: 'Shipping context', x: 303, y: 26, w: 254, h: 280, color: 'green' },
      { label: 'Billing context', x: 588, y: 26, w: 254, h: 280, color: 'purple' },
    ],
    nodes: [
      { id: 'cust', label: 'Customer', sub: 'cart · loyalty tier', x: 145, y: 110, kind: 'logic', icon: 'user' },
      { id: 'order', label: 'Order', sub: 'lines · prices', x: 145, y: 225, kind: 'logic', icon: 'receipt' },
      { id: 'recip', label: 'Recipient', sub: 'address · phone', x: 430, y: 110, kind: 'logic', icon: 'map-pin' },
      { id: 'ship', label: 'Shipment', sub: 'parcels · carrier', x: 430, y: 225, kind: 'logic', icon: 'truck' },
      { id: 'payer', label: 'Payer', sub: 'billing addr · VAT', x: 715, y: 110, kind: 'logic', icon: 'wallet' },
      { id: 'inv', label: 'Invoice', sub: 'tax lines', x: 715, y: 225, kind: 'logic', icon: 'file-text' },
    ],
    edges: [
      { id: 'e1', from: 'order', to: 'ship', label: 'OrderPlaced' },
      { id: 'e2', from: 'order', to: 'inv', label: 'OrderPlaced', curve: 70 },
      { id: 'e3', from: 'cust', to: 'recip', label: 'ACL', dashed: true },
    ],
    steps: [
      { title: 'Same person, three models', text: 'Sales calls them a **Customer** (cart, loyalty). Shipping cares about a **Recipient** (address). Billing needs a **Payer** (VAT number). One shared `Customer` table would serve none of them well.', focus: ['cust', 'recip', 'payer'] },
      { title: 'Contexts communicate through events', text: 'Sales publishes `OrderPlaced`. Each context translates it into its own model — a Shipment, an Invoice.', flow: [['e1', 'e2']], color: 'purple' },
      { title: 'Anti-corruption layer', text: 'When Shipping must read Sales data, an ACL translates Sales terms into Shipping terms so the foreign model cannot leak in.', flow: ['e3'], focus: ['recip'] },
    ],
  },

  'db-per-service': {
    title: 'Database per service', w: 760, h: 310,
    nodes: [
      { id: 'orders', label: 'Order Service', sub: 'owns orders', x: 170, y: 85, kind: 'service' },
      { id: 'users', label: 'User Service', sub: 'owns users', x: 590, y: 85, kind: 'service' },
      { id: 'ordersdb', label: 'orders-db', sub: 'private', x: 170, y: 240, kind: 'db' },
      { id: 'usersdb', label: 'users-db', sub: 'private', x: 590, y: 240, kind: 'db' },
    ],
    edges: [
      { id: 'e1', from: 'orders', to: 'ordersdb' },
      { id: 'e2', from: 'users', to: 'usersdb' },
      { id: 'e3', from: 'orders', to: 'usersdb', label: 'SELECT * FROM users ✗', dashed: true },
      { id: 'e4', from: 'orders', to: 'users', label: 'GET /internal/users/{id}' },
      { id: 'e5', from: 'users', to: 'orders', label: 'user.updated event', dashed: true, curve: 60 },
    ],
    steps: [
      { title: 'Each service owns its data', text: 'Only the owning service holds credentials for its database.', flow: [['e1', 'e2']] },
      { title: 'The tempting shortcut', text: 'Reading users-db directly couples Order Service to User Service’s schema, connection limits and release schedule. Renaming a column now breaks a service the User team does not own.', flow: ['e3'], color: 'err', states: { usersdb: 'warn' } },
      { title: 'Ask the owner', text: 'Order Service calls User Service’s API. The schema can change freely behind a stable contract.', flow: ['e4', 'e2', '-e2', '-e4'] },
      { title: 'Or keep a local copy via events', text: 'For read-heavy needs, Order Service keeps a small replica (`customer_id`, `name`, `status`) updated from `user.updated` events — eventually consistent, but no runtime dependency.', flow: ['e5'], color: 'purple' },
    ],
  },

  'partial-failure': {
    title: 'Partial failure and ambiguity', w: 760, h: 220,
    nodes: [
      { id: 'caller', label: 'Order Service', sub: 'POST /charges', x: 110, y: 110, kind: 'service' },
      { id: 'net', label: 'Network', sub: 'packets, not promises', x: 380, y: 110, kind: 'infra', icon: 'wifi' },
      { id: 'callee', label: 'Payment Service', sub: 'charges cards', x: 650, y: 110, kind: 'service' },
    ],
    edges: [{ id: 'e1', from: 'caller', to: 'net' }, { id: 'e2', from: 'net', to: 'callee' }],
    steps: [
      { title: 'Request sent', text: 'Order Service asks Payment Service to charge $42.', flow: ['e1', 'e2'] },
      { title: 'The work succeeds', text: 'The card is charged and the payment row is committed.', states: { callee: 'ok' }, subs: { callee: 'charged $42' } },
      { title: 'The response is lost', text: 'A switch drops the response packet.', flow: ['-e2'], color: 'err', states: { net: 'down' } },
      { title: 'Ambiguity', text: 'After a timeout the caller cannot distinguish “never arrived” from “succeeded, response lost”. Retrying risks a double charge; giving up loses a paid order. Idempotency keys resolve this.', states: { caller: 'warn' }, subs: { caller: 'timeout — did it work?' } },
    ],
  },

  /* ---------- Module 02 ---------- */
  'go-layers': {
    title: 'Layers inside a Go service', w: 900, h: 260,
    nodes: [
      { id: 'req', label: 'HTTP request', sub: 'POST /v1/orders', x: 75, y: 130, kind: 'client', w: 130 },
      { id: 'mw', label: 'Middleware', sub: 'request ID · log · auth', x: 230, y: 130, kind: 'logic', icon: 'layers', w: 150 },
      { id: 'handler', label: 'Handler', sub: 'decode · validate', x: 395, y: 130, kind: 'service', icon: 'webhook', w: 150 },
      { id: 'svc', label: 'Service', sub: 'business rules', x: 560, y: 130, kind: 'service', icon: 'brain', w: 150 },
      { id: 'repo', label: 'Repository', sub: 'SQL via pgx', x: 780, y: 70, kind: 'db', icon: 'database', w: 170 },
      { id: 'client', label: 'UserClient', sub: 'HTTP to user-service', x: 780, y: 190, kind: 'service', icon: 'plug', w: 170 },
    ],
    edges: [
      { id: 'e1', from: 'req', to: 'mw' }, { id: 'e2', from: 'mw', to: 'handler' }, { id: 'e3', from: 'handler', to: 'svc' },
      { id: 'e4', from: 'svc', to: 'repo', label: 'interface' }, { id: 'e5', from: 'svc', to: 'client', label: 'interface' },
    ],
    steps: [
      { title: 'Middleware: cross-cutting concerns', text: 'Request IDs, logging, panic recovery and auth wrap every handler — written once.', flow: ['e1'], focus: ['mw'] },
      { title: 'Handler: transport only', text: 'Decodes JSON, validates input, calls the service and maps domain errors to HTTP codes. No SQL, no business rules.', flow: ['e2'], focus: ['handler'] },
      { title: 'Service: business logic', text: 'Enforces rules (“a cancelled order cannot be shipped”) and orchestrates dependencies through interfaces.', flow: ['e3'], focus: ['svc'] },
      { title: 'Adapters behind interfaces', text: 'The repository and the HTTP client implement interfaces declared by the service, so tests can swap in fakes.', flow: [['e4', 'e5'], ['-e4', '-e5']], focus: ['repo', 'client'] },
      { title: 'Response', text: 'Errors bubble up wrapped with context; the handler decides the status code.', flow: ['-e3', '-e2', '-e1'], color: 'green' },
    ],
  },

  'context-propagation': {
    title: 'Context propagation', w: 900, h: 230,
    nodes: [
      { id: 'client', label: 'Client', sub: 'HTTP/1.1', x: 75, y: 115, kind: 'client', w: 120 },
      { id: 'gw', label: 'Gateway', sub: 'deadline 2s', x: 245, y: 115, kind: 'gateway', w: 150 },
      { id: 'handler', label: 'Handler', sub: 'c.Request.Context()', x: 430, y: 115, kind: 'service', w: 170 },
      { id: 'svc', label: 'OrderService', sub: 'ctx passed down', x: 615, y: 115, kind: 'service', w: 160 },
      { id: 'db', label: 'Postgres', sub: 'QueryRow(ctx, …)', x: 805, y: 115, kind: 'db', w: 160 },
    ],
    edges: [{ id: 'e1', from: 'client', to: 'gw' }, { id: 'e2', from: 'gw', to: 'handler' }, { id: 'e3', from: 'handler', to: 'svc' }, { id: 'e4', from: 'svc', to: 'db' }],
    steps: [
      { title: 'Deadline set at the edge', text: 'The gateway wraps the request in `context.WithTimeout(ctx, 2*time.Second)`.', flow: ['e1'], focus: ['gw'] },
      { title: 'The same ctx flows down', text: 'Every function that does I/O takes `ctx context.Context` as its first parameter and passes it on.', flow: ['e2', 'e3', 'e4'] },
      { title: 'The client disconnects', text: 'The user closes the tab. Go’s HTTP server cancels the request context.', states: { client: 'down' } },
      { title: 'Cancellation propagates', text: '`ctx.Done()` closes, pgx sends a cancel request to Postgres, and the goroutine returns `context.Canceled`. No wasted work, no leaked connections.', flow: ['e2', 'e3', 'e4'], color: 'err', states: { client: 'down', db: 'warn' }, subs: { db: 'query cancelled' } },
    ],
  },

  'middleware-chain': {
    title: 'Middleware chain (onion model)', w: 900, h: 220,
    nodes: [
      { id: 'req', label: 'Request', x: 70, y: 110, kind: 'client', w: 110, h: 44 },
      { id: 'rec', label: 'Recovery', sub: 'panics → 500', x: 215, y: 110, kind: 'logic', icon: 'life-buoy', w: 140 },
      { id: 'rid', label: 'RequestID', sub: 'X-Request-ID', x: 370, y: 110, kind: 'logic', icon: 'fingerprint', w: 140 },
      { id: 'log', label: 'Logger', sub: 'status · latency', x: 525, y: 110, kind: 'logic', icon: 'scroll-text', w: 140 },
      { id: 'auth', label: 'Auth', sub: 'verify JWT', x: 680, y: 110, kind: 'logic', icon: 'shield-check', w: 140 },
      { id: 'h', label: 'Handler', x: 830, y: 110, kind: 'service', w: 110, h: 44 },
    ],
    edges: [{ id: 'e1', from: 'req', to: 'rec' }, { id: 'e2', from: 'rec', to: 'rid' }, { id: 'e3', from: 'rid', to: 'log' }, { id: 'e4', from: 'log', to: 'auth' }, { id: 'e5', from: 'auth', to: 'h' }],
    steps: [
      { title: 'Inward: code before c.Next()', text: 'Each middleware runs its “before” code, then calls `c.Next()` to hand control inward.', flow: ['e1', 'e2', 'e3', 'e4', 'e5'] },
      { title: 'Outward: code after c.Next()', text: 'Control unwinds in reverse order — the logger now knows the status code and latency.', flow: ['-e5', '-e4', '-e3', '-e2', '-e1'], color: 'green' },
      { title: 'Short-circuit', text: 'An invalid token: Auth calls `c.AbortWithStatusJSON(401, …)` and the handler never runs — but Logger still records the 401 on the way out.', flow: ['e1', 'e2', 'e3', 'e4', '-e4', '-e3', '-e2', '-e1'], color: 'err', states: { auth: 'down' } },
    ],
  },

  'graceful-shutdown': {
    title: 'Graceful shutdown sequence', w: 860, h: 290,
    nodes: [
      { id: 'kubelet', label: 'kubelet', sub: 'sends SIGTERM', x: 120, y: 70, kind: 'infra', icon: 'ship-wheel' },
      { id: 'proc', label: 'order-service', sub: 'main()', x: 430, y: 145, kind: 'service' },
      { id: 'ep', label: 'Service endpoints', sub: 'load balancer pool', x: 120, y: 220, kind: 'infra', icon: 'list' },
      { id: 'inflight', label: 'In-flight requests', sub: '17 active', x: 740, y: 70, kind: 'client', icon: 'loader' },
      { id: 'pool', label: 'pgxpool · AMQP', sub: 'open connections', x: 740, y: 220, kind: 'db' },
    ],
    edges: [
      { id: 'e1', from: 'kubelet', to: 'proc', label: 'SIGTERM' },
      { id: 'e2', from: 'proc', to: 'ep', label: 'readiness → 503' },
      { id: 'e3', from: 'proc', to: 'inflight', label: 'srv.Shutdown(ctx)' },
      { id: 'e4', from: 'proc', to: 'pool', label: 'Close()' },
    ],
    steps: [
      { title: 'SIGTERM', text: '`signal.NotifyContext` cancels the root context. The process has `terminationGracePeriodSeconds` (default 30 s) before SIGKILL.', flow: ['e1'], focus: ['proc'] },
      { title: 'Stop receiving new traffic', text: 'Readiness starts failing and the pod is removed from the Service endpoints. Keep serving for a few seconds — endpoint removal propagates asynchronously.', flow: ['e2'], states: { ep: 'warn' }, subs: { ep: 'pod removed' } },
      { title: 'Drain in-flight requests', text: '`http.Server.Shutdown(ctx)` closes listeners and waits for active requests to finish (bounded by a timeout).', flow: ['e3', '-e3'], subs: { inflight: '0 active' }, states: { inflight: 'ok' } },
      { title: 'Close resources in reverse order', text: 'Stop consumers and the outbox relay, flush logs and traces, close the DB pool. Then exit 0.', flow: ['e4'], states: { pool: 'ok', proc: 'ok' }, subs: { pool: 'closed', proc: 'exit 0' } },
    ],
  },

  /* ---------- Module 03 ---------- */
  oms: {
    title: 'Order Management System', w: 1020, h: 460,
    nodes: [
      { id: 'client', label: 'Client', sub: 'web · mobile', x: 70, y: 230, kind: 'client', w: 120 },
      { id: 'gw', label: 'API Gateway', sub: ':8080 · JWT · limits', x: 250, y: 230, kind: 'gateway', w: 170 },
      { id: 'redis', label: 'Redis', sub: 'rate limits · cache', x: 250, y: 385, kind: 'cache', w: 170 },
      { id: 'users', label: 'User Service', sub: ':8081 · identity', x: 500, y: 95, kind: 'service', w: 170 },
      { id: 'orders', label: 'Order Service', sub: ':8082 · orders', x: 500, y: 300, kind: 'service', w: 170 },
      { id: 'usersdb', label: 'users-db', sub: 'PostgreSQL 16', x: 745, y: 95, kind: 'db' },
      { id: 'ordersdb', label: 'orders-db', sub: 'orders · outbox', x: 745, y: 250, kind: 'db' },
      { id: 'broker', label: 'RabbitMQ', sub: 'exchange: orders', x: 745, y: 390, kind: 'broker' },
      { id: 'notify', label: 'Notification', sub: 'consumer', x: 935, y: 390, kind: 'worker', w: 140 },
    ],
    edges: [
      { id: 'e1', from: 'client', to: 'gw', label: 'HTTPS' },
      { id: 'e2', from: 'gw', to: 'redis', label: 'token bucket' },
      { id: 'e3', from: 'gw', to: 'users', label: '/users/*' },
      { id: 'e4', from: 'gw', to: 'orders', label: '/orders/*' },
      { id: 'e5', from: 'users', to: 'usersdb' },
      { id: 'e6', from: 'orders', to: 'ordersdb', label: '1 transaction' },
      { id: 'e7', from: 'orders', to: 'users', label: 'validate user' },
      { id: 'e8', from: 'orders', to: 'broker', label: 'outbox relay' },
      { id: 'e9', from: 'broker', to: 'notify' },
    ],
    steps: [
      { title: 'At the edge', text: 'TLS terminates at the gateway, which checks the caller’s rate limit with an atomic token-bucket script in Redis.', flow: ['e1', 'e2', '-e2'], focus: ['gw'] },
      { title: 'Authenticate and route', text: 'The gateway verifies the JWT signature locally, then proxies `/api/v1/orders/*` to Order Service with `X-User-ID` and `X-Request-ID` headers.', flow: ['e4'], focus: ['orders'] },
      { title: 'Validate the customer', text: 'Order Service calls `GET /internal/users/42` with an 800 ms timeout to confirm the account is active.', flow: ['e7', 'e5', '-e5', '-e7'] },
      { title: 'One transaction', text: '`BEGIN; INSERT orders; INSERT order_items; INSERT outbox; INSERT idempotency_keys; COMMIT;`', flow: ['e6', '-e6'], focus: ['ordersdb'] },
      { title: 'Respond fast', text: '`201 Created` — the client is done in ~40 ms. Nothing slow (email) sits on the request path.', flow: ['-e4', '-e1'], color: 'green' },
      { title: 'Asynchronous side effects', text: 'The outbox relay publishes `order.created`; Notification Service sends the confirmation email whenever it is ready.', flow: ['e8', 'e9'], color: 'purple' },
    ],
  },

  'order-lifecycle': {
    title: 'Order lifecycle state machine', w: 900, h: 300,
    nodes: [
      { id: 'pending', label: 'PENDING', x: 105, y: 110, kind: 'logic', icon: 'circle-dashed', w: 150, h: 50 },
      { id: 'confirmed', label: 'CONFIRMED', x: 330, y: 110, kind: 'logic', icon: 'circle-check', w: 150, h: 50 },
      { id: 'shipped', label: 'SHIPPED', x: 555, y: 110, kind: 'logic', icon: 'truck', w: 150, h: 50 },
      { id: 'delivered', label: 'DELIVERED', x: 780, y: 110, kind: 'logic', icon: 'package-check', w: 150, h: 50 },
      { id: 'cancelled', label: 'CANCELLED', x: 330, y: 245, kind: 'error', icon: 'circle-x', w: 150, h: 50 },
    ],
    edges: [
      { id: 'e1', from: 'pending', to: 'confirmed', label: 'payment ok' },
      { id: 'e2', from: 'confirmed', to: 'shipped', label: 'dispatched' },
      { id: 'e3', from: 'shipped', to: 'delivered', label: 'signed' },
      { id: 'e4', from: 'pending', to: 'cancelled', label: 'cancel' },
      { id: 'e5', from: 'confirmed', to: 'cancelled', label: 'cancel + refund' },
    ],
    steps: [
      { title: 'Created as PENDING', text: 'New orders start in `PENDING` while payment is processed.', focus: ['pending'] },
      { title: 'Happy path', text: 'Each transition is an explicit, validated operation — never a raw `UPDATE … SET status = $1`.', flow: ['e1', 'e2', 'e3'], color: 'green', states: { delivered: 'ok' } },
      { title: 'Cancellation is allowed early', text: '`PENDING → CANCELLED` and `CONFIRMED → CANCELLED` (which triggers a refund).', flow: [['e4', 'e5']], color: 'err' },
      { title: 'Illegal transitions are rejected', text: '`SHIPPED → CANCELLED` is not an edge, so the service returns `409 Conflict` with `ErrInvalidTransition`. The state machine is the documentation.', focus: ['shipped'], states: { shipped: 'warn' } },
    ],
  },

  'service-discovery': {
    title: 'Service discovery', w: 860, h: 340,
    nodes: [
      { id: 'caller', label: 'Order Service', sub: 'needs user-service', x: 105, y: 170, kind: 'service' },
      { id: 'dns', label: 'Registry / DNS', sub: 'user-service → IPs', x: 380, y: 60, kind: 'infra', icon: 'book-marked', w: 170 },
      { id: 'vip', label: 'Service VIP', sub: 'ClusterIP 10.96.4.12', x: 380, y: 260, kind: 'infra', icon: 'split', w: 170 },
      { id: 'p1', label: 'user-service', sub: 'pod 10.1.0.12', x: 720, y: 90, kind: 'service' },
      { id: 'p2', label: 'user-service', sub: 'pod 10.1.0.31', x: 720, y: 180, kind: 'service' },
      { id: 'p3', label: 'user-service', sub: 'pod 10.1.0.47', x: 720, y: 270, kind: 'service' },
    ],
    edges: [
      { id: 'e6', from: 'p1', to: 'dns', label: 'register + health', dashed: true },
      { id: 'e1', from: 'caller', to: 'dns', label: 'resolve' },
      { id: 'e2', from: 'caller', to: 'vip' },
      { id: 'e3', from: 'vip', to: 'p1' }, { id: 'e4', from: 'vip', to: 'p2' }, { id: 'e5', from: 'vip', to: 'p3' },
    ],
    steps: [
      { title: 'Instances register', text: 'In Kubernetes this is automatic: ready pods are added to the Service’s EndpointSlice. In Consul, instances register themselves with a health check.', flow: ['e6'], focus: ['dns'] },
      { title: 'Resolve a stable name', text: '`http://user-service:8081` resolves through cluster DNS to a virtual IP.', flow: ['e1', '-e1'] },
      { title: 'Server-side load balancing', text: 'kube-proxy (iptables/IPVS) forwards the connection to one healthy pod.', flow: ['e2', 'e4', '-e4', '-e2'] },
      { title: 'An instance fails', text: 'Its readiness probe fails and it is removed from the endpoints. Callers keep using the same name.', states: { p2: 'down' } },
      { title: 'Traffic avoids it', text: 'New connections go to healthy pods only.', flow: ['e2', 'e5', '-e5', '-e2'], states: { p2: 'down' }, color: 'green' },
    ],
  },

  'api-versioning': {
    title: 'Serving two API versions', w: 860, h: 270,
    nodes: [
      { id: 'orders', label: 'Order Service', sub: 'client of v1', x: 120, y: 75, kind: 'service' },
      { id: 'app', label: 'New mobile app', sub: 'client of v2', x: 120, y: 200, kind: 'client' },
      { id: 'v1', label: 'GET /v1/users/{id}', sub: 'name: "Ada Lovelace"', x: 440, y: 75, kind: 'logic', icon: 'route', w: 200 },
      { id: 'v2', label: 'GET /v2/users/{id}', sub: 'given_name, family_name', x: 440, y: 200, kind: 'logic', icon: 'route', w: 200 },
      { id: 'core', label: 'User Service core', sub: 'one data model', x: 740, y: 137, kind: 'service' },
    ],
    edges: [{ id: 'e1', from: 'orders', to: 'v1' }, { id: 'e2', from: 'app', to: 'v2' }, { id: 'e3', from: 'v1', to: 'core', label: 'adapter' }, { id: 'e4', from: 'v2', to: 'core' }],
    steps: [
      { title: 'A breaking change is needed', text: 'User Service wants to split `name` into `given_name` and `family_name`. Order Service still reads `name`.', focus: ['orders', 'v1'] },
      { title: 'Serve both versions', text: 'v1 is implemented as an adapter over the new model; both versions share one database and one codebase.', flow: [['e1', 'e2'], ['e3', 'e4']] },
      { title: 'Deprecate, measure, remove', text: 'v1 responses carry `Deprecation` and `Sunset` headers. When metrics show zero v1 traffic, delete it.', states: { v1: 'warn' }, subs: { v1: 'Sunset: 2027-03-01' } },
    ],
  },

  'oms-comm': {
    title: 'Choosing sync vs async per interaction', w: 860, h: 280,
    nodes: [
      { id: 'orders', label: 'Order Service', sub: 'POST /v1/orders', x: 140, y: 140, kind: 'service' },
      { id: 'users', label: 'User Service', sub: 'synchronous query', x: 480, y: 60, kind: 'service' },
      { id: 'broker', label: 'RabbitMQ', sub: 'exchange: orders', x: 480, y: 220, kind: 'broker' },
      { id: 'notify', label: 'Notification Svc', sub: 'async consumer', x: 770, y: 220, kind: 'worker' },
    ],
    edges: [
      { id: 'e1', from: 'orders', to: 'users', label: 'GET /internal/users/42 · 800ms' },
      { id: 'e2', from: 'orders', to: 'broker', label: 'order.created' },
      { id: 'e3', from: 'broker', to: 'notify' },
    ],
    steps: [
      { title: 'Synchronous: needed for the decision', text: 'Order Service cannot accept the order until it knows the account is active, so it must wait for the answer.', flow: ['e1', '-e1'] },
      { title: 'Asynchronous: a side effect', text: 'The confirmation email does not change whether the order is valid. Publishing an event keeps it off the request path.', flow: ['e2', 'e3'], color: 'purple' },
      { title: 'Different failure behaviour', text: 'If User Service is down, order creation fails (or degrades). If Notification Service is down, orders succeed and emails are delayed.', states: { notify: 'down' }, badges: { broker: '+42' } },
    ],
  },

  'deploy-pipelines': {
    title: 'Independent deployment pipelines', w: 940, h: 290,
    nodes: [
      { id: 'ru', label: 'user-service', sub: 'git push main', x: 100, y: 75, kind: 'external', icon: 'git-branch', w: 150 },
      { id: 'cu', label: 'CI', sub: 'test · contract · build', x: 320, y: 75, kind: 'infra', icon: 'hammer', w: 160 },
      { id: 'reg', label: 'Image registry', sub: 'immutable tags', x: 560, y: 145, kind: 'infra', icon: 'package', w: 160 },
      { id: 'du', label: 'Deploy', sub: 'user-service:1.8.0', x: 810, y: 75, kind: 'infra', icon: 'rocket', w: 170 },
      { id: 'ro', label: 'order-service', sub: 'git push main', x: 100, y: 215, kind: 'external', icon: 'git-branch', w: 150 },
      { id: 'co', label: 'CI', sub: 'test · contract · build', x: 320, y: 215, kind: 'infra', icon: 'hammer', w: 160 },
      { id: 'do', label: 'Deploy', sub: 'order-service:2.3.1', x: 810, y: 215, kind: 'infra', icon: 'rocket', w: 170 },
    ],
    edges: [
      { id: 'e1', from: 'ru', to: 'cu' }, { id: 'e2', from: 'cu', to: 'reg' }, { id: 'e3', from: 'reg', to: 'du' },
      { id: 'e4', from: 'ro', to: 'co' }, { id: 'e5', from: 'co', to: 'reg' }, { id: 'e6', from: 'reg', to: 'do' },
    ],
    steps: [
      { title: 'User Service ships on its own', text: 'A merge triggers only the user-service pipeline. Contract tests confirm it still satisfies what Order Service expects.', flow: ['e1', 'e2', 'e3'], states: { du: 'ok' } },
      { title: 'Order Service ships independently', text: 'Different cadence, different team, no coordinated release.', flow: ['e4', 'e5', 'e6'], states: { do: 'ok' } },
      { title: 'A failing contract blocks only its own deploy', text: 'If order-service removes a field user-service needs, *its* CI fails — production is untouched.', flow: ['e4', 'e5'], color: 'err', states: { co: 'down' } },
    ],
  },

  /* ---------- Module 04 ---------- */
  gateway: {
    title: 'API Gateway', w: 880, h: 330,
    nodes: [
      { id: 'web', label: 'Web app', sub: 'SPA', x: 85, y: 100, kind: 'client', w: 130 },
      { id: 'mobile', label: 'Mobile app', sub: 'iOS · Android', x: 85, y: 230, kind: 'client', icon: 'smartphone', w: 130 },
      { id: 'gw', label: 'API Gateway', sub: 'TLS · auth · limits · routing', x: 340, y: 165, kind: 'gateway', w: 200 },
      { id: 'users', label: 'User Service', sub: '/users/*', x: 680, y: 70, kind: 'service' },
      { id: 'orders', label: 'Order Service', sub: '/orders/*', x: 680, y: 165, kind: 'service' },
      { id: 'catalog', label: 'Catalog Service', sub: '/products/*', x: 680, y: 260, kind: 'service' },
    ],
    edges: [
      { id: 'e1', from: 'web', to: 'gw' }, { id: 'e2', from: 'mobile', to: 'gw' },
      { id: 'e3', from: 'gw', to: 'users' }, { id: 'e4', from: 'gw', to: 'orders' }, { id: 'e5', from: 'gw', to: 'catalog' },
    ],
    steps: [
      { title: 'One public entry point', text: 'Clients know one hostname. Internal topology can change without app releases.', flow: [['e1', 'e2']], focus: ['gw'] },
      { title: 'Policies applied once', text: 'TLS termination, JWT verification, rate limiting, request size limits and CORS happen here, not in every service.', focus: ['gw'] },
      { title: 'Routing', text: 'A route table maps path prefixes to upstream services.', flow: [['e3', 'e4', 'e5']] },
      { title: 'Responses', text: 'The gateway adds headers (request ID, rate-limit remaining) and returns the upstream response.', flow: [['-e3', '-e4', '-e5'], ['-e1', '-e2']], color: 'green' },
    ],
  },

  'jwt-flow': {
    title: 'JWT authentication flow', w: 920, h: 330,
    nodes: [
      { id: 'client', label: 'Client', sub: 'stores token', x: 85, y: 165, kind: 'client', w: 130 },
      { id: 'gw', label: 'API Gateway', sub: 'verifies signature', x: 330, y: 165, kind: 'gateway', w: 170 },
      { id: 'users', label: 'User Service', sub: 'issues tokens', x: 610, y: 70, kind: 'service' },
      { id: 'orders', label: 'Order Service', sub: 'checks ownership', x: 610, y: 260, kind: 'service' },
      { id: 'usersdb', label: 'users-db', sub: 'bcrypt hashes', x: 830, y: 70, kind: 'db', w: 140 },
    ],
    edges: [
      { id: 'e1', from: 'client', to: 'gw' }, { id: 'e2', from: 'gw', to: 'users', label: '/auth/login' },
      { id: 'e3', from: 'users', to: 'usersdb' }, { id: 'e4', from: 'gw', to: 'orders', label: 'X-User-ID: 42' },
    ],
    steps: [
      { title: 'Log in', text: 'User Service verifies the bcrypt hash and signs a JWT: `{"sub":"42","role":"customer","exp":…}`, valid for 15 minutes.', flow: ['e1', 'e2', 'e3', '-e3', '-e2', '-e1'] },
      { title: 'Call an API with the token', text: '`Authorization: Bearer eyJhbGciOi…` on every request.', flow: ['e1'], focus: ['gw'] },
      { title: 'Verify locally', text: 'The gateway checks the signature, `exp`, `iss` and `aud` with the shared key — no network call per request.', focus: ['gw'], states: { gw: 'ok' } },
      { title: 'Propagate identity', text: 'The gateway strips any client-supplied `X-User-ID` and sets its own from the verified `sub` claim.', flow: ['e4'] },
      { title: 'Authorise in the service', text: 'Order Service checks `order.user_id == X-User-ID`. Authentication at the edge does not replace authorisation in the service.', focus: ['orders'], states: { orders: 'ok' } },
    ],
  },

  'rate-limit': {
    title: 'Rate limiting with a token bucket', w: 820, h: 260,
    nodes: [
      { id: 'client', label: 'Client', sub: 'user 42', x: 90, y: 130, kind: 'client', w: 130 },
      { id: 'gw', label: 'Gateway', sub: 'rate limiter', x: 340, y: 130, kind: 'gateway' },
      { id: 'redis', label: 'Redis', sub: 'bucket: 5 tokens', x: 640, y: 60, kind: 'cache' },
      { id: 'svc', label: 'Order Service', x: 640, y: 200, kind: 'service' },
    ],
    edges: [{ id: 'e1', from: 'client', to: 'gw' }, { id: 'e2', from: 'gw', to: 'redis', label: 'EVAL token_bucket' }, { id: 'e3', from: 'gw', to: 'svc' }],
    steps: [
      { title: 'Allowed', text: 'The Lua script refills tokens based on elapsed time, takes one, and returns “allowed” — atomically, for every gateway replica.', flow: ['e1', 'e2', '-e2', 'e3', '-e3', '-e1'], subs: { redis: 'bucket: 4 tokens' } },
      { title: 'Burst', text: 'The client fires 4 more requests in 100 ms and drains the bucket.', subs: { redis: 'bucket: 0 tokens' }, states: { redis: 'warn' } },
      { title: 'Rejected', text: '`429 Too Many Requests` with `Retry-After: 1`. The upstream never sees the request.', flow: ['e1', 'e2', '-e2', '-e1'], color: 'err', subs: { redis: 'bucket: 0 tokens' } },
    ],
  },

  /* ---------- Module 05 ---------- */
  'sync-chain': {
    title: 'Availability of a synchronous chain', w: 900, h: 200,
    nodes: [
      { id: 'a', label: 'Gateway', sub: '99.9%', x: 110, y: 100, kind: 'gateway' },
      { id: 'b', label: 'Order Service', sub: '99.9%', x: 330, y: 100, kind: 'service' },
      { id: 'c', label: 'User Service', sub: '99.9%', x: 550, y: 100, kind: 'service' },
      { id: 'd', label: 'Fraud Service', sub: '99.9%', x: 770, y: 100, kind: 'service' },
    ],
    edges: [{ id: 'e1', from: 'a', to: 'b' }, { id: 'e2', from: 'b', to: 'c' }, { id: 'e3', from: 'c', to: 'd' }],
    steps: [
      { title: 'One service', text: '99.9% availability ≈ 8.8 hours of downtime a year.', focus: ['a'], subs: { a: 'chain: 99.9%' } },
      { title: 'Two in series', text: 'A request succeeds only if both are up: 0.999 × 0.999 = 99.8%.', flow: ['e1'], subs: { a: 'chain: 99.9%', b: 'chain: 99.80%' } },
      { title: 'Three', text: '0.999³ = 99.70%.', flow: ['e1', 'e2'], subs: { b: 'chain: 99.80%', c: 'chain: 99.70%' } },
      { title: 'Four', text: '0.999⁴ = 99.60% ≈ 35 hours a year — four times worse than any single service. Every synchronous hop multiplies risk; async messaging and caching break the chain.', flow: ['e1', 'e2', 'e3'], color: 'warn', subs: { d: 'chain: 99.60%' }, states: { d: 'warn' } },
    ],
  },

  grpc: {
    title: 'gRPC call', w: 860, h: 270,
    nodes: [
      { id: 'proto', label: 'user.proto', sub: 'the contract', x: 430, y: 50, kind: 'logic', icon: 'file-code', w: 160 },
      { id: 'orders', label: 'Order Service', sub: 'generated client', x: 130, y: 190, kind: 'service' },
      { id: 'conn', label: 'HTTP/2 connection', sub: 'multiplexed streams', x: 430, y: 190, kind: 'infra', icon: 'cable', w: 180 },
      { id: 'users', label: 'User Service', sub: 'UserServiceServer', x: 730, y: 190, kind: 'service' },
    ],
    edges: [
      { id: 'p1', from: 'proto', to: 'orders', label: 'protoc', dashed: true }, { id: 'p2', from: 'proto', to: 'users', label: 'protoc', dashed: true },
      { id: 'e1', from: 'orders', to: 'conn' }, { id: 'e2', from: 'conn', to: 'users' },
    ],
    steps: [
      { title: 'The contract generates code', text: '`protoc` generates a typed client stub and a server interface from the same `.proto` file.', flow: [['p1', 'p2']], color: 'purple' },
      { title: 'A call with a deadline', text: '`client.GetUser(ctx, &pb.GetUserRequest{Id: 42})` — the deadline from ctx travels in the `grpc-timeout` header.', flow: ['e1', 'e2'] },
      { title: 'Binary response', text: 'Protobuf is compact and fast to decode; many calls share one TCP connection.', flow: ['-e2', '-e1'], color: 'green' },
      { title: 'Deadline exceeded', text: 'If User Service is slow, the client gets `codes.DeadlineExceeded` and the server’s ctx is cancelled too.', flow: ['e1', 'e2', '-e2', '-e1'], color: 'err', states: { users: 'warn' } },
    ],
  },

  rabbitmq: {
    title: 'RabbitMQ topology', w: 940, h: 340,
    nodes: [
      { id: 'prod', label: 'Order Service', sub: 'publisher confirms', x: 100, y: 150, kind: 'service' },
      { id: 'ex', label: 'Exchange: orders', sub: 'type: topic', x: 340, y: 150, kind: 'broker', icon: 'shuffle', w: 170 },
      { id: 'q1', label: 'q.notifications', sub: 'binding: order.*', x: 590, y: 75, kind: 'queue', w: 170 },
      { id: 'q2', label: 'q.analytics', sub: 'binding: order.created', x: 590, y: 225, kind: 'queue', w: 170 },
      { id: 'c1', label: 'Notification Svc', sub: 'prefetch 20', x: 830, y: 75, kind: 'worker', w: 160 },
      { id: 'c2', label: 'Analytics', sub: 'batch consumer', x: 830, y: 225, kind: 'worker', w: 160 },
      { id: 'dlq', label: 'q.notifications.dlq', sub: 'dead letters', x: 340, y: 295, kind: 'error', icon: 'inbox', w: 190, h: 48 },
    ],
    edges: [
      { id: 'e1', from: 'prod', to: 'ex', label: 'order.created' },
      { id: 'e2', from: 'ex', to: 'q1' }, { id: 'e3', from: 'ex', to: 'q2' },
      { id: 'e4', from: 'q1', to: 'c1' }, { id: 'e5', from: 'q2', to: 'c2' },
      { id: 'e6', from: 'q1', to: 'dlq', label: 'reject, requeue=false', dashed: true },
    ],
    steps: [
      { title: 'Publish', text: 'The publisher sends to an exchange (not a queue) with routing key `order.created`, and waits for a broker confirm.', flow: ['e1'] },
      { title: 'Route', text: 'The topic exchange copies the message to every queue whose binding pattern matches.', flow: [['e2', 'e3']], color: 'purple' },
      { title: 'Deliver and acknowledge', text: 'The consumer processes the message, then sends `ack`. Until then the message is unacked and will be redelivered if the consumer dies.', flow: ['e4', '-e4'], color: 'green' },
      { title: 'Poison message', text: 'A message that always fails is rejected with `requeue=false` and routed by the dead-letter exchange to the DLQ for inspection.', flow: ['e4', '-e4', 'e6'], color: 'err', badges: { dlq: '1' } },
    ],
  },

  kafka: {
    title: 'Kafka partitions and consumer groups', w: 920, h: 330,
    nodes: [
      { id: 'prod', label: 'Order Service', sub: 'key = order_id', x: 110, y: 165, kind: 'service' },
      { id: 'p0', label: 'orders · P0', sub: 'offset 1042', x: 430, y: 70, kind: 'queue', icon: 'rows-3' },
      { id: 'p1', label: 'orders · P1', sub: 'offset 977', x: 430, y: 165, kind: 'queue', icon: 'rows-3' },
      { id: 'p2', label: 'orders · P2', sub: 'offset 1130', x: 430, y: 260, kind: 'queue', icon: 'rows-3' },
      { id: 'c1', label: 'consumer-1', sub: 'group: billing', x: 770, y: 110, kind: 'worker' },
      { id: 'c2', label: 'consumer-2', sub: 'group: billing', x: 770, y: 240, kind: 'worker' },
    ],
    edges: [
      { id: 'e1', from: 'prod', to: 'p0' }, { id: 'e2', from: 'prod', to: 'p1', label: 'hash(key) % 3' }, { id: 'e3', from: 'prod', to: 'p2' },
      { id: 'e4', from: 'p0', to: 'c1' }, { id: 'e5', from: 'p1', to: 'c1' }, { id: 'e6', from: 'p2', to: 'c2' },
      { id: 'e7', from: 'p2', to: 'c1', label: 'after rebalance', dashed: true },
    ],
    steps: [
      { title: 'Keys pick partitions', text: 'All events for order 8812 hash to the same partition, so they stay in order.', flow: ['e2', 'e2', 'e2'], subs: { p1: 'offset 980' } },
      { title: 'Consumer groups share partitions', text: 'Each partition is read by exactly one consumer in a group. Parallelism is capped by the partition count.', flow: [['e4', 'e5', 'e6']] },
      { title: 'Offsets are the bookmark', text: 'Consumers commit offsets after processing. The log is retained (days or forever), so new consumers can replay history.', subs: { p1: 'committed 980' } },
      { title: 'Rebalance', text: 'consumer-2 dies; its partition is reassigned to consumer-1, which resumes from the last committed offset — possibly re-processing a few events.', flow: ['e7'], states: { c2: 'down' }, color: 'warn' },
    ],
  },

  'event-driven': {
    title: 'Event-driven fan-out', w: 900, h: 320,
    nodes: [
      { id: 'orders', label: 'Order Service', sub: 'publishes OrderPlaced', x: 130, y: 160, kind: 'service', w: 180 },
      { id: 'bus', label: 'Event bus', sub: 'RabbitMQ / Kafka', x: 400, y: 160, kind: 'broker' },
      { id: 'notify', label: 'Notification', sub: 'send email', x: 690, y: 60, kind: 'worker' },
      { id: 'analytics', label: 'Analytics', sub: 'revenue dashboards', x: 690, y: 160, kind: 'worker' },
      { id: 'loyalty', label: 'Loyalty Service', sub: 'award points', x: 690, y: 260, kind: 'worker' },
    ],
    edges: [{ id: 'e1', from: 'orders', to: 'bus' }, { id: 'e2', from: 'bus', to: 'notify' }, { id: 'e3', from: 'bus', to: 'analytics' }, { id: 'e4', from: 'bus', to: 'loyalty' }],
    steps: [
      { title: 'Publish a fact', text: '`OrderPlaced` describes something that happened. The publisher does not know or care who listens.', flow: ['e1'] },
      { title: 'Fan out', text: 'Each subscriber gets its own copy and processes it independently.', flow: [['e2', 'e3', 'e4']], color: 'purple' },
      { title: 'Add consumers without touching the producer', text: 'Loyalty was added last quarter with zero changes to Order Service — the main benefit of event-driven design. The cost: the overall flow is no longer visible in one place.', focus: ['loyalty'], states: { loyalty: 'ok' } },
    ],
  },

  /* ---------- Module 06 ---------- */
  'two-phase-commit': {
    title: 'Two-phase commit', w: 860, h: 300,
    nodes: [
      { id: 'coord', label: 'Coordinator', sub: 'transaction manager', x: 430, y: 60, kind: 'logic', icon: 'git-merge', w: 180 },
      { id: 'a', label: 'orders-db', sub: 'participant', x: 170, y: 230, kind: 'db' },
      { id: 'b', label: 'payments-db', sub: 'participant', x: 430, y: 230, kind: 'db' },
      { id: 'c', label: 'inventory-db', sub: 'participant', x: 690, y: 230, kind: 'db' },
    ],
    edges: [{ id: 'e1', from: 'coord', to: 'a' }, { id: 'e2', from: 'coord', to: 'b' }, { id: 'e3', from: 'coord', to: 'c' }],
    steps: [
      { title: 'Phase 1: prepare', text: 'The coordinator asks every participant to prepare. Each one writes its changes durably and takes locks.', flow: [['e1', 'e2', 'e3']], subs: { a: 'prepared · locked', b: 'prepared · locked', c: 'prepared · locked' } },
      { title: 'Votes', text: 'All vote YES.', flow: [['-e1', '-e2', '-e3']], color: 'green', subs: { a: 'prepared · locked', b: 'prepared · locked', c: 'prepared · locked' } },
      { title: 'The coordinator crashes', text: 'Before sending COMMIT. Participants cannot commit or abort on their own — they are “in doubt”.', states: { coord: 'down', a: 'warn', b: 'warn', c: 'warn' }, subs: { a: 'in doubt · locked', b: 'in doubt · locked', c: 'in doubt · locked' } },
      { title: 'Why microservices avoid 2PC', text: 'Locks are held across services until the coordinator recovers, availability is the product of every participant, and most brokers and NoSQL stores do not support XA. Sagas trade atomicity for availability instead.', states: { coord: 'down', a: 'warn', b: 'warn', c: 'warn' } },
    ],
  },

  'cache-aside': {
    title: 'Cache-aside with Redis', w: 820, h: 280,
    nodes: [
      { id: 'svc', label: 'User Service', sub: 'GetProfile(42)', x: 140, y: 140, kind: 'service' },
      { id: 'redis', label: 'Redis', sub: 'user:42', x: 470, y: 60, kind: 'cache' },
      { id: 'db', label: 'users-db', sub: 'source of truth', x: 470, y: 220, kind: 'db' },
    ],
    edges: [{ id: 'e1', from: 'svc', to: 'redis', label: 'GET / SET' }, { id: 'e2', from: 'svc', to: 'db', label: 'SELECT' }],
    steps: [
      { title: 'Cache miss', text: '`GET user:42` returns nil.', flow: ['e1', '-e1'], color: 'err' },
      { title: 'Read the source of truth', text: '`SELECT … FROM users WHERE id = $1` — about 2 ms.', flow: ['e2', '-e2'] },
      { title: 'Populate with a TTL', text: '`SET user:42 <json> EX 300`. The TTL bounds staleness if an invalidation is ever missed.', flow: ['e1'], color: 'purple', subs: { redis: 'user:42 · TTL 300s' } },
      { title: 'Cache hit', text: 'The next read returns in ~0.3 ms without touching Postgres.', flow: ['e1', '-e1'], color: 'green', subs: { redis: 'user:42 · hit' } },
      { title: 'Writes invalidate', text: '`UPDATE users …` then `DEL user:42`. Delete rather than update the cache, so concurrent writers cannot leave an old value behind.', flow: ['e2', 'e1'], color: 'warn', subs: { redis: 'user:42 · deleted' } },
    ],
  },

  'connection-pool': {
    title: 'Connection limits across replicas', w: 880, h: 280,
    nodes: [
      { id: 'rs', label: 'order-service', sub: '6 replicas × 20 conns', x: 130, y: 140, kind: 'service', w: 190 },
      { id: 'pgb', label: 'PgBouncer', sub: 'transaction pooling', x: 440, y: 205, kind: 'infra', icon: 'funnel', w: 170 },
      { id: 'pg', label: 'PostgreSQL', sub: 'max_connections = 100', x: 750, y: 140, kind: 'db', w: 190 },
    ],
    edges: [
      { id: 'e1', from: 'rs', to: 'pg', label: '120 connections ✗', curve: -60, dashed: true },
      { id: 'e2', from: 'rs', to: 'pgb', label: '120 client conns' },
      { id: 'e3', from: 'pgb', to: 'pg', label: '25 server conns' },
    ],
    steps: [
      { title: 'Scale out the service', text: 'An autoscaler adds replicas. Each opens its own pool of 20. 6 × 20 = 120 > 100.', flow: ['e1'], color: 'err', states: { pg: 'down' }, subs: { pg: 'FATAL: too many clients' } },
      { title: 'Pool in front of Postgres', text: 'PgBouncer multiplexes many client connections onto a small number of server connections. Each Postgres connection is a process using ~5–10 MB, so fewer is better.', flow: ['e2', 'e3'], color: 'green', states: { pg: 'ok' } },
    ],
  },

  /* ---------- Module 07 patterns ---------- */
  'p-circuit-breaker': {
    title: 'Circuit breaker', w: 860, h: 250,
    nodes: [
      { id: 'caller', label: 'Order Service', sub: 'UserClient', x: 120, y: 125, kind: 'service' },
      { id: 'cb', label: 'Circuit breaker', sub: 'CLOSED', x: 430, y: 125, kind: 'logic', icon: 'toggle-right', w: 180 },
      { id: 'dep', label: 'User Service', sub: 'dependency', x: 740, y: 125, kind: 'service' },
    ],
    edges: [{ id: 'e1', from: 'caller', to: 'cb' }, { id: 'e2', from: 'cb', to: 'dep' }],
    steps: [
      { title: 'CLOSED: calls pass through', text: 'The breaker counts results in a rolling window.', flow: ['e1', 'e2', '-e2', '-e1'], color: 'green' },
      { title: 'Failures accumulate', text: 'User Service starts timing out. Each call costs the full 800 ms timeout and a goroutine.', flow: ['e1', 'e2', '-e2', '-e1'], color: 'err', states: { dep: 'down' }, subs: { cb: 'CLOSED · 5/5 failed' } },
      { title: 'OPEN: fail fast', text: 'The threshold trips. Calls return `ErrCircuitOpen` in microseconds; the struggling dependency gets breathing room.', flow: ['e1', '-e1'], color: 'err', states: { dep: 'down', cb: 'warn' }, subs: { cb: 'OPEN · cooling 30s' } },
      { title: 'HALF-OPEN: probe', text: 'After the cool-down, a limited number of trial calls are allowed through.', flow: ['e1', 'e2'], states: { cb: 'warn', dep: 'ok' }, subs: { cb: 'HALF-OPEN · 1 probe' } },
      { title: 'CLOSED again', text: 'The probes succeed, so the breaker closes. If they had failed it would re-open for another cool-down.', flow: ['-e2', '-e1'], color: 'green', states: { dep: 'ok', cb: 'ok' }, subs: { cb: 'CLOSED' } },
    ],
  },

  'p-retry': {
    title: 'Retry with exponential backoff and jitter', w: 820, h: 230,
    nodes: [
      { id: 'caller', label: 'Order Service', sub: 'GET /internal/users/42', x: 140, y: 115, kind: 'service', w: 190 },
      { id: 'dep', label: 'User Service', sub: 'rolling deploy', x: 680, y: 115, kind: 'service' },
    ],
    edges: [{ id: 'e1', from: 'caller', to: 'dep' }],
    steps: [
      { title: 'Attempt 1', text: 'Hits a pod that is shutting down: `503`.', flow: ['e1', '-e1'], color: 'err', subs: { caller: 'attempt 1 → 503' } },
      { title: 'Back off', text: 'Wait `base × 2^0` = 100 ms, randomised (full jitter) to 0–100 ms so many clients do not retry in lock-step.', subs: { caller: 'sleep 73ms' }, states: { caller: 'warn' } },
      { title: 'Attempt 2', text: 'Still failing: `503`.', flow: ['e1', '-e1'], color: 'err', subs: { caller: 'attempt 2 → 503' } },
      { title: 'Back off more', text: '`100 ms × 2^1` → random 0–200 ms.', subs: { caller: 'sleep 161ms' }, states: { caller: 'warn' } },
      { title: 'Attempt 3 succeeds', text: 'A healthy pod answers `200`. Stop at a max attempt count and an overall deadline; never retry 4xx validation errors.', flow: ['e1', '-e1'], color: 'green', subs: { caller: 'attempt 3 → 200' }, states: { caller: 'ok' } },
    ],
  },

  'p-timeout': {
    title: 'Timeouts', w: 820, h: 230,
    nodes: [
      { id: 'gw', label: 'Gateway', sub: 'timeout 2s', x: 120, y: 115, kind: 'gateway' },
      { id: 'svc', label: 'Order Service', sub: 'handler', x: 410, y: 115, kind: 'service' },
      { id: 'db', label: 'orders-db', sub: 'waiting on row lock', x: 700, y: 115, kind: 'db' },
    ],
    edges: [{ id: 'e1', from: 'gw', to: 'svc' }, { id: 'e2', from: 'svc', to: 'db' }],
    steps: [
      { title: 'Request starts', text: 'The gateway starts a 2 s timer via the request context.', flow: ['e1', 'e2'] },
      { title: 'Dependency hangs', text: 'A long-running migration holds a lock; the query waits.', states: { db: 'warn' } },
      { title: 'Timer fires', text: 'At 2 s the gateway returns `504 Gateway Timeout` and frees its goroutine and connection.', flow: ['-e1'], color: 'err', states: { db: 'warn' }, subs: { gw: '504 after 2.0s' } },
      { title: 'Cancellation propagates', text: 'Because ctx was passed down, the handler’s query is cancelled too. Without that, the work would continue for nobody.', flow: ['e1', 'e2'], color: 'err', states: { db: 'ok' }, subs: { db: 'query cancelled' } },
    ],
  },

  'p-bulkhead': {
    title: 'Bulkhead isolation', w: 880, h: 310,
    nodes: [
      { id: 'svc', label: 'Order Service', sub: '200 goroutines', x: 130, y: 155, kind: 'service', w: 170 },
      { id: 'pa', label: 'Pool: user-client', sub: '10 slots', x: 440, y: 80, kind: 'logic', icon: 'boxes', w: 180 },
      { id: 'pb', label: 'Pool: payment-client', sub: '10 slots', x: 440, y: 230, kind: 'logic', icon: 'boxes', w: 180 },
      { id: 'user', label: 'User Service', sub: 'healthy', x: 750, y: 80, kind: 'service' },
      { id: 'pay', label: 'Payment Service', sub: 'healthy', x: 750, y: 230, kind: 'service' },
    ],
    edges: [{ id: 'e1', from: 'svc', to: 'pa' }, { id: 'e2', from: 'svc', to: 'pb' }, { id: 'e3', from: 'pa', to: 'user' }, { id: 'e4', from: 'pb', to: 'pay' }],
    steps: [
      { title: 'Separate compartments', text: 'Each dependency gets its own bounded pool (a semaphore) instead of sharing one.', flow: [['e1', 'e2'], ['e3', 'e4']] },
      { title: 'One dependency slows down', text: 'User Service takes 5 s per call. Its pool fills up.', states: { user: 'warn', pa: 'warn' }, subs: { user: 'p99 5s', pa: '10/10 busy' } },
      { title: 'Excess calls are rejected', text: 'New user lookups fail fast with `ErrBulkheadFull` instead of queueing forever.', flow: ['e1', '-e1'], color: 'err', states: { user: 'warn', pa: 'warn' }, subs: { pa: '10/10 busy' } },
      { title: 'The rest of the ship stays dry', text: 'Payment calls have their own slots and keep working. Without the bulkhead, slow user calls would have consumed every goroutine and connection.', flow: ['e2', 'e4', '-e4', '-e2'], color: 'green', states: { user: 'warn', pa: 'warn', pay: 'ok' } },
    ],
  },

  'p-saga': {
    title: 'Orchestrated saga with compensation', w: 900, h: 330,
    nodes: [
      { id: 'orch', label: 'Order saga', sub: 'orchestrator', x: 130, y: 165, kind: 'logic', icon: 'workflow', w: 170 },
      { id: 'pay', label: 'Payment Service', sub: 'Charge / Refund', x: 470, y: 60, kind: 'service', w: 170 },
      { id: 'inv', label: 'Inventory Service', sub: 'Reserve / Release', x: 470, y: 165, kind: 'service', w: 170 },
      { id: 'ship', label: 'Shipping Service', sub: 'Schedule', x: 470, y: 270, kind: 'service', w: 170 },
      { id: 'log', label: 'saga_state', sub: 'orders-db', x: 780, y: 300, kind: 'db' },
    ],
    edges: [
      { id: 'e1', from: 'orch', to: 'pay' }, { id: 'e2', from: 'orch', to: 'inv' }, { id: 'e3', from: 'orch', to: 'ship' },
      { id: 'e4', from: 'orch', to: 'log', dashed: true },
    ],
    steps: [
      { title: 'Start', text: 'Order created as `PENDING`; the saga state is persisted so it survives crashes.', flow: ['e4'], subs: { log: 'step: STARTED' } },
      { title: 'Step 1: charge payment', text: 'A local transaction in Payment Service.', flow: ['e1', '-e1'], color: 'green', states: { pay: 'ok' }, subs: { pay: 'charged $42', log: 'step: PAID' } },
      { title: 'Step 2 fails', text: 'Inventory has no stock. There is no global rollback — payment already committed.', flow: ['e2', '-e2'], color: 'err', states: { pay: 'ok', inv: 'down' }, subs: { pay: 'charged $42', inv: 'out of stock' } },
      { title: 'Compensate in reverse', text: 'The orchestrator calls `Refund` — a new, semantic undo. Compensations must be idempotent and retried until they succeed.', flow: ['e1', '-e1'], color: 'purple', states: { inv: 'down', pay: 'warn' }, subs: { pay: 'refunded $42', inv: 'out of stock', log: 'step: COMPENSATING' } },
      { title: 'Consistent end state', text: 'Order → `CANCELLED`. Between steps the system was temporarily inconsistent (paid, no stock) — that is the price of sagas.', flow: ['e4'], states: { inv: 'down', pay: 'warn' }, subs: { log: 'step: CANCELLED', pay: 'refunded $42' } },
    ],
  },

  'p-outbox': {
    title: 'Transactional outbox', w: 980, h: 320,
    groups: [{ label: 'orders-db — one transaction', x: 250, y: 30, w: 270, h: 260, color: 'green' }],
    nodes: [
      { id: 'svc', label: 'Order Service', sub: 'CreateOrder', x: 110, y: 160, kind: 'service', w: 160 },
      { id: 'orders', label: 'orders', sub: 'id 8812 · PENDING', x: 385, y: 100, kind: 'db', w: 220 },
      { id: 'outbox', label: 'outbox', sub: 'order.created · pending', x: 385, y: 225, kind: 'db', w: 220 },
      { id: 'relay', label: 'Outbox relay', sub: 'every 500 ms', x: 680, y: 225, kind: 'worker', w: 160 },
      { id: 'broker', label: 'RabbitMQ', sub: 'exchange: orders', x: 885, y: 225, kind: 'broker', w: 160 },
    ],
    edges: [
      { id: 'e1', from: 'svc', to: 'orders', label: 'INSERT' }, { id: 'e2', from: 'svc', to: 'outbox', label: 'INSERT' },
      { id: 'e3', from: 'relay', to: 'outbox', label: 'claim' }, { id: 'e4', from: 'relay', to: 'broker' },
    ],
    steps: [
      { title: 'The dual-write problem', text: 'Writing to the DB and then publishing to the broker are two operations; a crash between them loses the event (or publishes an event for a rolled-back order).', focus: ['svc'] },
      { title: 'Write both in one transaction', text: 'The order row and the event row commit together — or neither does.', flow: [['e1', 'e2']] },
      { title: 'Relay claims pending rows', text: '`SELECT … FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED` lets several relay instances work without double-claiming.', flow: ['e3', '-e3'] },
      { title: 'Publish with confirms', text: 'Only after the broker confirms is the row marked published.', flow: ['e4', '-e4'], color: 'purple', subs: { outbox: 'order.created · published' } },
      { title: 'Broker down? Nothing is lost', text: 'The row stays pending and is retried. A crash after publishing but before marking means a re-publish — at-least-once delivery, so consumers must be idempotent.', states: { broker: 'down' }, subs: { outbox: 'order.created · pending (retry)' } },
    ],
  },

  'p-cqrs': {
    title: 'CQRS', w: 920, h: 320,
    nodes: [
      { id: 'client', label: 'Client', x: 80, y: 160, kind: 'client', w: 110 },
      { id: 'cmd', label: 'Command side', sub: 'POST /orders', x: 320, y: 75, kind: 'service' },
      { id: 'wdb', label: 'orders-db', sub: 'normalised, constraints', x: 590, y: 75, kind: 'db', w: 180 },
      { id: 'proj', label: 'Projector', sub: 'consumes events', x: 820, y: 160, kind: 'worker', w: 150 },
      { id: 'q', label: 'Query side', sub: 'GET /orders?status=…', x: 320, y: 245, kind: 'service', w: 170 },
      { id: 'rdb', label: 'order_summaries', sub: 'denormalised / search', x: 590, y: 245, kind: 'db', w: 180 },
    ],
    edges: [
      { id: 'e1', from: 'client', to: 'cmd' }, { id: 'e2', from: 'cmd', to: 'wdb' }, { id: 'e3', from: 'wdb', to: 'proj', label: 'events' },
      { id: 'e4', from: 'proj', to: 'rdb', label: 'upsert' }, { id: 'e5', from: 'client', to: 'q' }, { id: 'e6', from: 'q', to: 'rdb' },
    ],
    steps: [
      { title: 'Commands change state', text: 'The write model enforces invariants with transactions and constraints.', flow: ['e1', 'e2'] },
      { title: 'Changes become events', text: 'Via the outbox or change data capture (Debezium).', flow: ['e3'], color: 'purple' },
      { title: 'Projections build read models', text: 'Shaped for each query: pre-joined, pre-aggregated, maybe in Elasticsearch.', flow: ['e4'], color: 'purple' },
      { title: 'Queries read the projection', text: 'Fast and simple — but eventually consistent. A user may not see their own write for a few hundred milliseconds unless you design for it.', flow: ['e5', 'e6', '-e6', '-e5'], color: 'green' },
    ],
  },

  'p-event-sourcing': {
    title: 'Event sourcing', w: 900, h: 300,
    nodes: [
      { id: 'cmd', label: 'Command', sub: 'CancelOrder(8812)', x: 100, y: 150, kind: 'client', w: 160 },
      { id: 'agg', label: 'Order aggregate', sub: 'state from events', x: 340, y: 150, kind: 'logic', icon: 'box', w: 170 },
      { id: 'store', label: 'Event store', sub: 'append-only stream', x: 600, y: 150, kind: 'db', w: 170 },
      { id: 'rm', label: 'Read model', sub: 'orders view', x: 820, y: 80, kind: 'worker', w: 140 },
      { id: 'audit', label: 'Audit / BI', sub: 'full history', x: 820, y: 220, kind: 'worker', w: 140 },
    ],
    edges: [{ id: 'e1', from: 'cmd', to: 'agg' }, { id: 'e2', from: 'agg', to: 'store' }, { id: 'e3', from: 'store', to: 'rm' }, { id: 'e4', from: 'store', to: 'audit' }],
    steps: [
      { title: 'Load by replaying', text: 'The aggregate rebuilds state from `OrderCreated`, `ItemAdded`, `OrderPaid` (or from a snapshot plus later events).', flow: ['e1', '-e2'], subs: { agg: 'status = PAID · v3' } },
      { title: 'Decide', text: 'Business rules run against the rebuilt state: a PAID order may be cancelled.', focus: ['agg'], states: { agg: 'ok' } },
      { title: 'Append, with optimistic concurrency', text: 'Append `OrderCancelled` with expected version 3. A concurrent writer gets a version conflict and retries.', flow: ['e2'], color: 'purple', subs: { store: 'v4: OrderCancelled' } },
      { title: 'Project', text: 'Read models and audit consumers subscribe to the stream. Events are never updated or deleted — they are the source of truth.', flow: [['e3', 'e4']], color: 'purple' },
    ],
  },

  'p-idempotency': {
    title: 'Idempotency keys', w: 900, h: 300,
    nodes: [
      { id: 'client', label: 'Client', sub: 'Idempotency-Key: 7f3a…', x: 105, y: 150, kind: 'client', w: 180 },
      { id: 'gw', label: 'Gateway', x: 330, y: 150, kind: 'gateway', w: 130 },
      { id: 'svc', label: 'Order Service', sub: 'CreateOrder', x: 545, y: 150, kind: 'service', w: 160 },
      { id: 'keys', label: 'idempotency_keys', sub: 'UNIQUE(user_id, key)', x: 790, y: 80, kind: 'db', w: 190 },
      { id: 'orders', label: 'orders', sub: '0 rows', x: 790, y: 220, kind: 'db', w: 190 },
    ],
    edges: [{ id: 'e1', from: 'client', to: 'gw' }, { id: 'e2', from: 'gw', to: 'svc' }, { id: 'e3', from: 'svc', to: 'keys' }, { id: 'e4', from: 'svc', to: 'orders' }],
    steps: [
      { title: 'First attempt', text: 'In one transaction: insert the key, insert the order, store the response body against the key.', flow: ['e1', 'e2', ['e3', 'e4']], subs: { orders: '1 row: #8812', keys: '7f3a → 201 #8812' } },
      { title: 'The response is lost', text: 'The client times out and does not know the order exists.', flow: ['-e2'], color: 'err', states: { client: 'warn' } },
      { title: 'Retry with the same key', text: 'The insert hits the unique constraint; the service returns the stored `201 #8812` instead of creating a second order.', flow: ['e1', 'e2', 'e3', '-e3', '-e2', '-e1'], color: 'green', subs: { orders: '1 row: #8812' }, states: { client: 'ok' } },
      { title: 'Same key, different body', text: 'If the payload hash differs from the stored one, respond `422` — the client reused a key for a different request.', focus: ['keys'] },
    ],
  },

  'p-tracing': {
    title: 'Distributed tracing', w: 940, h: 320,
    nodes: [
      { id: 'gw', label: 'Gateway', sub: 'span: POST /orders', x: 120, y: 90, kind: 'gateway', w: 170 },
      { id: 'orders', label: 'Order Service', sub: 'span: CreateOrder', x: 400, y: 90, kind: 'service', w: 170 },
      { id: 'users', label: 'User Service', sub: 'span: GetUser', x: 690, y: 90, kind: 'service', w: 170 },
      { id: 'db', label: 'orders-db', sub: 'span: INSERT orders', x: 400, y: 240, kind: 'db', w: 170 },
      { id: 'col', label: 'OTel Collector', sub: 'batch · sample', x: 650, y: 240, kind: 'observe', icon: 'waypoints', w: 160 },
      { id: 'be', label: 'Tempo / Jaeger', sub: 'trace storage', x: 850, y: 240, kind: 'observe', w: 150 },
    ],
    edges: [
      { id: 'e1', from: 'gw', to: 'orders', label: 'traceparent' }, { id: 'e2', from: 'orders', to: 'users', label: 'traceparent' },
      { id: 'e3', from: 'orders', to: 'db' }, { id: 'e4', from: 'orders', to: 'col', label: 'OTLP', dashed: true }, { id: 'e5', from: 'col', to: 'be' },
    ],
    steps: [
      { title: 'A trace starts at the edge', text: 'The gateway creates trace ID `4bf92f35…` and a root span.', focus: ['gw'] },
      { title: 'Context travels in headers', text: '`traceparent: 00-4bf92f35…-00f067aa0ba902b7-01` is injected on every outgoing call; each service creates child spans.', flow: ['e1', 'e2'] },
      { title: 'Database spans', text: 'Instrumented pgx records each query as a span with timing.', flow: ['e3', '-e3'] },
      { title: 'Export and assemble', text: 'Spans are exported asynchronously to a collector and assembled into one waterfall by trace ID.', flow: ['e4', 'e5'], color: 'purple' },
    ],
  },

  'p-load-balancing': {
    title: 'Load balancing', w: 820, h: 300,
    nodes: [
      { id: 'client', label: 'Clients', x: 90, y: 150, kind: 'client', w: 120 },
      { id: 'lb', label: 'Load balancer', sub: 'least connections', x: 320, y: 150, kind: 'infra', icon: 'split', w: 170 },
      { id: 'i1', label: 'order-service #1', sub: '3 active', x: 640, y: 60, kind: 'service', w: 180 },
      { id: 'i2', label: 'order-service #2', sub: '1 active', x: 640, y: 150, kind: 'service', w: 180 },
      { id: 'i3', label: 'order-service #3', sub: '2 active', x: 640, y: 240, kind: 'service', w: 180 },
    ],
    edges: [{ id: 'e1', from: 'client', to: 'lb' }, { id: 'e2', from: 'lb', to: 'i1' }, { id: 'e3', from: 'lb', to: 'i2' }, { id: 'e4', from: 'lb', to: 'i3' }],
    steps: [
      { title: 'Round robin', text: 'Requests go to instances in turn — simple, but blind to how busy each one is.', flow: ['e1', 'e2', 'e1', 'e3', 'e1', 'e4'] },
      { title: 'Health checks', text: 'Instance #3 fails its health check and is taken out of rotation.', states: { i3: 'down' }, subs: { i3: 'unhealthy' } },
      { title: 'Least connections', text: 'The balancer sends the next request to the instance with the fewest in-flight requests: #2.', flow: ['e1', 'e3'], color: 'green', states: { i3: 'down' }, subs: { i2: '2 active' } },
    ],
  },

  /* ---------- Module 08 ---------- */
  'docker-build': {
    title: 'Multi-stage Docker build', w: 900, h: 260,
    groups: [
      { label: 'stage 1 · builder · golang:1.24-alpine (~300 MB)', x: 18, y: 26, w: 530, h: 210, color: 'blue' },
      { label: 'stage 2 · runtime · distroless (~2 MB + binary)', x: 580, y: 26, w: 302, h: 210, color: 'green' },
    ],
    nodes: [
      { id: 'mod', label: 'go.mod / go.sum', sub: 'COPY first', x: 105, y: 135, kind: 'module', icon: 'file-cog', w: 150 },
      { id: 'dl', label: 'go mod download', sub: 'cached layer', x: 285, y: 135, kind: 'module', icon: 'download', w: 150 },
      { id: 'build', label: 'go build', sub: 'CGO_ENABLED=0', x: 460, y: 135, kind: 'module', icon: 'hammer', w: 140 },
      { id: 'bin', label: '/order-service', sub: 'static · USER nonroot', x: 730, y: 135, kind: 'service', w: 200 },
    ],
    edges: [{ id: 'e1', from: 'mod', to: 'dl' }, { id: 'e2', from: 'dl', to: 'build', label: 'COPY . .' }, { id: 'e3', from: 'build', to: 'bin', label: 'COPY --from=builder' }],
    steps: [
      { title: 'Dependencies first', text: 'Copying only `go.mod`/`go.sum` before the source means `go mod download` is cached until dependencies change.', flow: ['e1'], focus: ['dl'] },
      { title: 'Compile a static binary', text: '`CGO_ENABLED=0 go build -trimpath -ldflags="-s -w"` produces a binary with no libc dependency.', flow: ['e2'], focus: ['build'] },
      { title: 'Ship only the binary', text: 'The final image contains the binary, CA certificates and a non-root user — no shell, no compiler, a tiny attack surface.', flow: ['e3'], color: 'green', states: { bin: 'ok' } },
    ],
  },

  compose: {
    title: 'Docker Compose network', w: 960, h: 380,
    groups: [{ label: 'network: oms (bridge) — containers reach each other by service name', x: 160, y: 18, w: 782, h: 344, color: 'cyan' }],
    nodes: [
      { id: 'host', label: 'Your machine', sub: 'localhost', x: 75, y: 190, kind: 'client', w: 130 },
      { id: 'gw', label: 'api-gateway', sub: '8080:8080 published', x: 300, y: 190, kind: 'gateway', w: 170 },
      { id: 'redis', label: 'redis', sub: 'internal :6379', x: 300, y: 310, kind: 'cache', w: 170 },
      { id: 'users', label: 'user-service', sub: 'internal :8081', x: 535, y: 90, kind: 'service', w: 170 },
      { id: 'orders', label: 'order-service', sub: 'internal :8082', x: 535, y: 290, kind: 'service', w: 170 },
      { id: 'usersdb', label: 'users-db', sub: 'volume users-data', x: 790, y: 70, kind: 'db', w: 170 },
      { id: 'ordersdb', label: 'orders-db', sub: 'volume orders-data', x: 790, y: 190, kind: 'db', w: 170 },
      { id: 'mq', label: 'rabbitmq', sub: '15672 UI published', x: 790, y: 310, kind: 'broker', w: 170 },
    ],
    edges: [
      { id: 'e1', from: 'host', to: 'gw', label: ':8080' }, { id: 'e2', from: 'gw', to: 'users' }, { id: 'e3', from: 'gw', to: 'orders' },
      { id: 'e4', from: 'gw', to: 'redis' }, { id: 'e5', from: 'users', to: 'usersdb' }, { id: 'e6', from: 'orders', to: 'ordersdb' },
      { id: 'e7', from: 'orders', to: 'mq' }, { id: 'e8', from: 'orders', to: 'users' },
    ],
    steps: [
      { title: 'Only the gateway is published', text: '`ports: ["8080:8080"]` maps a host port. Everything else is reachable only inside the network.', flow: ['e1'], focus: ['gw'] },
      { title: 'DNS by service name', text: 'Compose’s embedded DNS resolves `user-service` and `order-service` to container IPs.', flow: [['e2', 'e3']] },
      { title: 'Databases on named volumes', text: 'Data in `users-data` and `orders-data` survives `docker compose down` (but not `down -v`).', flow: [['e5', 'e6']], color: 'green' },
      { title: 'Service-to-service calls', text: '`http://user-service:8081/internal/users/42` from order-service — the same URL works in Kubernetes with a Service named `user-service`.', flow: ['e8', '-e8', 'e7'] },
    ],
  },

  /* ---------- Module 09 ---------- */
  'obs-pipeline': {
    title: 'Observability pipeline', w: 940, h: 330,
    nodes: [
      { id: 'svc', label: 'Go services', sub: 'slog · /metrics · OTel', x: 120, y: 165, kind: 'service', w: 180 },
      { id: 'loki', label: 'Loki', sub: 'logs', x: 430, y: 60, kind: 'observe', icon: 'scroll-text' },
      { id: 'prom', label: 'Prometheus', sub: 'scrapes /metrics', x: 430, y: 165, kind: 'observe', icon: 'chart-line' },
      { id: 'col', label: 'OTel Collector', sub: 'traces', x: 430, y: 270, kind: 'observe', icon: 'waypoints' },
      { id: 'tempo', label: 'Tempo', sub: 'trace store', x: 640, y: 270, kind: 'observe', w: 130 },
      { id: 'graf', label: 'Grafana', sub: 'dashboards · alerts', x: 840, y: 165, kind: 'observe', icon: 'layout-dashboard', w: 160 },
    ],
    edges: [
      { id: 'e1', from: 'svc', to: 'loki', label: 'stdout JSON' }, { id: 'e2', from: 'prom', to: 'svc', label: 'pull' },
      { id: 'e3', from: 'svc', to: 'col', label: 'OTLP push' }, { id: 'e4', from: 'col', to: 'tempo' },
      { id: 'e5', from: 'loki', to: 'graf' }, { id: 'e6', from: 'prom', to: 'graf' }, { id: 'e7', from: 'tempo', to: 'graf' },
    ],
    steps: [
      { title: 'Logs', text: 'Services write JSON to stdout; an agent ships them to Loki (or Elasticsearch).', flow: ['e1'] },
      { title: 'Metrics', text: 'Prometheus pulls `/metrics` every 15 s and stores time series.', flow: ['e2', '-e2'] },
      { title: 'Traces', text: 'Spans are pushed over OTLP to a collector that batches, samples and exports them.', flow: ['e3', 'e4'], color: 'purple' },
      { title: 'One pane of glass', text: 'Grafana links them: a latency spike → exemplar trace → the logs for that trace ID.', flow: [['e5', 'e6', 'e7']], color: 'green' },
    ],
  },

  probes: {
    title: 'Readiness and liveness probes', w: 860, h: 280,
    nodes: [
      { id: 'kubelet', label: 'kubelet', sub: 'every 5–10 s', x: 115, y: 140, kind: 'infra', icon: 'ship-wheel' },
      { id: 'pod', label: 'order-service pod', sub: '/livez · /readyz', x: 430, y: 140, kind: 'service', w: 180 },
      { id: 'ep', label: 'Service endpoints', sub: 'receives traffic', x: 745, y: 70, kind: 'infra', icon: 'list', w: 170 },
      { id: 'restart', label: 'Restart container', sub: 'liveness action', x: 745, y: 210, kind: 'error', icon: 'rotate-ccw', w: 170 },
    ],
    edges: [{ id: 'e1', from: 'kubelet', to: 'pod', label: 'GET /readyz' }, { id: 'e2', from: 'pod', to: 'ep', label: 'ready' }, { id: 'e3', from: 'pod', to: 'restart', label: 'liveness fails ×3', dashed: true }],
    steps: [
      { title: 'Ready', text: '`/readyz` returns 200 when the service can do useful work: config loaded, DB pool reachable, caches warm.', flow: ['e1', '-e1', 'e2'], color: 'green', states: { ep: 'ok' } },
      { title: 'Dependency down → not ready', text: 'orders-db is unreachable: `/readyz` returns 503 and the pod is removed from endpoints. No restart — restarting would not fix the database.', flow: ['e1', '-e1'], color: 'err', states: { ep: 'warn' }, subs: { ep: 'pod removed' } },
      { title: 'Liveness only for a wedged process', text: '`/livez` checks the process itself (event loop responsive, no deadlock). Never check dependencies in liveness, or a DB blip restarts every pod at once.', flow: ['e3'], color: 'err', states: { restart: 'warn' } },
    ],
  },

  /* ---------- Module 10 ---------- */
  'k8s-objects': {
    title: 'Kubernetes objects for one service', w: 980, h: 380,
    groups: [{ label: 'Deployment order-service · ReplicaSet · replicas: 3', x: 430, y: 24, w: 300, h: 330, color: 'blue' }],
    nodes: [
      { id: 'ing', label: 'Ingress', sub: 'api.example.com', x: 100, y: 190, kind: 'infra', icon: 'globe', w: 150 },
      { id: 'svc', label: 'Service', sub: 'ClusterIP :80', x: 300, y: 190, kind: 'infra', icon: 'split', w: 150 },
      { id: 'p1', label: 'Pod', sub: 'order-service-7d9f-a1', x: 580, y: 100, kind: 'service', w: 200 },
      { id: 'p2', label: 'Pod', sub: 'order-service-7d9f-b7', x: 580, y: 190, kind: 'service', w: 200 },
      { id: 'p3', label: 'Pod', sub: 'order-service-7d9f-c3', x: 580, y: 280, kind: 'service', w: 200 },
      { id: 'cm', label: 'ConfigMap', sub: 'non-secret config', x: 865, y: 100, kind: 'infra', icon: 'file-cog', w: 160 },
      { id: 'sec', label: 'Secret', sub: 'DATABASE_URL', x: 865, y: 190, kind: 'infra', icon: 'key-round', w: 160 },
      { id: 'hpa', label: 'HPA', sub: 'target CPU 70%', x: 865, y: 280, kind: 'infra', icon: 'gauge', w: 160 },
    ],
    edges: [
      { id: 'e1', from: 'ing', to: 'svc' }, { id: 'e2', from: 'svc', to: 'p1' }, { id: 'e3', from: 'svc', to: 'p2' }, { id: 'e4', from: 'svc', to: 'p3' },
      { id: 'e5', from: 'cm', to: 'p1', label: 'envFrom', dashed: true }, { id: 'e6', from: 'sec', to: 'p2', label: 'secretKeyRef', dashed: true }, { id: 'e7', from: 'hpa', to: 'p3', label: 'scales', dashed: true },
    ],
    steps: [
      { title: 'Ingress → Service', text: 'The Ingress controller routes `api.example.com/api/v1/orders` to the `order-service` Service.', flow: ['e1'] },
      { title: 'Service → Pods', text: 'The Service selects pods by label (`app: order-service`) and balances across the ready ones.', flow: [['e2', 'e3', 'e4']] },
      { title: 'Configuration is injected', text: 'ConfigMaps and Secrets become environment variables or files. The image stays the same in every environment.', flow: [['e5', 'e6']], color: 'purple' },
      { title: 'Autoscaling', text: 'The HPA adjusts `replicas` on the Deployment based on observed CPU (or custom metrics).', flow: ['e7'], color: 'warn' },
    ],
  },
};
