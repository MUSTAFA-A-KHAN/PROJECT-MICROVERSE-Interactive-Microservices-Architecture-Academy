/* ==========================================================================
   Microverse — Architecture Lab.

   A draggable architecture canvas with a request simulator. Each simulated
   request runs on its own virtual clock with Go-style context deadlines:
   timeouts propagate down the call chain and cancel nested work, retries
   back off with jitter, circuit breakers trip and recover, fallbacks
   degrade gracefully, and the transactional outbox protects events.

   Nothing here performs real network I/O — every latency, status code and
   log line is produced by the model below and labelled as simulated.
   ========================================================================== */
window.MV = window.MV || {};

(function (MV) {
  'use strict';
  const { $, $$, esc, icon, toast, inlineMd } = MV.ui;
  const LAB = MV.data.lab;
  const NS = 'http://www.w3.org/2000/svg';

  const KIND_ICON = { client: 'monitor-smartphone', gateway: 'door-open', service: 'server', worker: 'mail-check', db: 'database', cache: 'zap', broker: 'mail' };
  const NAMES = Object.fromEntries(LAB.nodes.map((n) => [n.id, n.name]));
  const BREAKER = { threshold: 3, cooldownMs: 8000 };
  const RATE = { capacity: 20, refillPerSec: 5 };
  const CLIENT_PATIENCE = 30000;

  /* ======================================================================
     Shared world state (survives navigation within a session)
     ====================================================================== */
  const world = {
    failures: new Set(),
    resilience: new Set(LAB.resilience.filter((r) => r.default).map((r) => r.id)),
    breakers: {},          // key -> { state, fails, openedAt }
    cache: { profile: false },
    outboxBacklog: 0,
    lostEvents: 0,
    queueDepth: 0,
    tokens: RATE.capacity,
    lastRefill: Date.now(),
    metrics: {},           // nodeId -> { req, err }
    speed: 1,
  };
  (function restore() {
    const cfg = MV.store.get().lab.config;
    if (cfg) {
      world.failures = new Set(cfg.failures || []);
      world.resilience = new Set(cfg.resilience || [...world.resilience]);
      world.speed = cfg.speed || 1;
    }
  })();
  function saveConfig() {
    MV.store.update((s) => { s.lab.config = { failures: [...world.failures], resilience: [...world.resilience], speed: world.speed }; }, 'lab');
  }
  const has = (f) => world.failures.has(f);
  const on = (r) => world.resilience.has(r);

  function breaker(key) {
    if (!world.breakers[key]) world.breakers[key] = { state: 'closed', fails: 0, openedAt: 0 };
    const b = world.breakers[key];
    if (b.state === 'open' && Date.now() - b.openedAt >= BREAKER.cooldownMs) b.state = 'half-open';
    return b;
  }

  /* ======================================================================
     Context with deadlines (models Go's context.Context)
     ====================================================================== */
  class DeadlineExceeded extends Error {
    constructor(ctx) { super('context deadline exceeded'); this.ctx = ctx; }
  }
  function rootCtx() { const c = { deadline: CLIENT_PATIENCE, owner: 'client' }; c.defining = c; return c; }
  function withTimeout(run, parent, ms, owner) {
    if (!on('timeouts')) return parent;
    const d = run.t + ms;
    if (d >= parent.deadline) return parent;
    const c = { deadline: d, owner, parent, timeout: ms };
    c.defining = c;
    return c;
  }

  /* ======================================================================
     One simulated request
     ====================================================================== */
  let runCounter = 0;
  class Run {
    constructor(lab, scenario, opts = {}) {
      this.lab = lab;
      this.sc = scenario;
      this.fast = !!opts.fast;
      this.n = ++runCounter;
      this.rid = Math.random().toString(16).slice(2, 6);
      this.t = 0;
      this.wallStart = Date.now();
      this.insights = new Map();
      this.fx = {};
    }

    /* ---------- timing & animation ---------- */
    animMs(base) { return (MV.reducedMotion ? 0 : base) / world.speed; }
    netLatency() {
      if (has('slow-network')) return Math.round(250 + (Math.random() * 200 - 100));
      return Math.round(1 + Math.random() * 2);
    }

    /** Advance the virtual clock by dt (ms), respecting the ctx deadline. */
    async advance(ctx, dt, realMs, onPartial) {
      const remaining = ctx.deadline - this.t;
      if (dt > remaining) {
        const frac = Math.max(0, remaining) / (dt || 1);
        if (onPartial) await onPartial(frac);
        else await MV.sleep(realMs * frac);
        this.t = ctx.deadline;
        throw new DeadlineExceeded(ctx.defining);
      }
      if (!onPartial) await MV.sleep(realMs);
      this.t += dt;
    }

    async hop(ctx, from, to, opts = {}) {
      if (this.lab.disposed) throw new Error('lab disposed');
      const lat = this.netLatency();
      const base = (this.fast ? 170 : 480) + Math.min(lat, 400) * (this.fast ? 0.3 : 0.9);
      const real = this.animMs(base);
      const remaining = ctx.deadline - this.t;
      if (lat > remaining) {
        const frac = Math.max(0, remaining) / lat;
        await this.lab.packet(from, to, { color: 'err', duration: real, stopAt: Math.max(0.05, frac), label: opts.label });
        this.t = ctx.deadline;
        throw new DeadlineExceeded(ctx.defining);
      }
      await this.lab.packet(from, to, { color: opts.color || 'blue', duration: real, label: opts.label, fail: opts.fail });
      this.t += lat;
      return lat;
    }

    async work(ctx, node, ms, desc, opts = {}) {
      this.lab.busy(node, true);
      try {
        const real = this.animMs(Math.max(this.fast ? 60 : 180, Math.min(ms * 0.55, 2600)));
        await this.advance(ctx, ms, real);
        if (desc) this.log({ src: node, desc, latency: ms, level: opts.level || 'info', status: opts.status });
      } finally {
        this.lab.busy(node, false);
      }
    }

    log(e) { this.lab.log({ ...e, t: this.t, rid: this.rid, run: this }); }

    insight(key, data) { if (!this.insights.has(key)) this.insights.set(key, { key, ...data }); }

    stage(id, state) { this.lab.stage(this, id, state); }

    metric(node, err) {
      const m = world.metrics[node] || (world.metrics[node] = { req: 0, err: 0 });
      m.req++; if (err) m.err++;
      this.lab.updateNodeMetrics(node);
    }

    /* ---------- resilient upstream call ---------- */
    async call(ctx, from, to, opts, handler) {
      const { method, path, idempotent, timeout, key } = opts;
      const maxAttempts = on('retries') && idempotent ? 3 : 1;
      let res;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // Circuit breaker gate
        if (on('breaker')) {
          const b = breaker(key);
          this.lab.renderBreaker(key);
          if (b.state === 'open') {
            const wait = Math.ceil((BREAKER.cooldownMs - (Date.now() - b.openedAt)) / 1000);
            await this.work(ctx, from, 0.05, `circuit ${key} is OPEN — failing fast without calling ${NAMES[to]} (half-open in ${wait}s)`, { level: 'warn', status: 503 });
            this.lab.flashBreaker(key);
            this.insight('breaker-fastfail-' + key, {
              level: 'warn', title: `Circuit breaker ${key} is open — calls fail fast`,
              what: `The request was rejected in microseconds at ${NAMES[from]} without touching ${NAMES[to]}.`,
              why: `The last ${BREAKER.threshold} calls to ${NAMES[to]} failed. Sending more traffic to a failing dependency wastes goroutines, sockets and timeout budgets — and can stop it from recovering.`,
              fix: `Wait for the half-open probe (${BREAKER.cooldownMs / 1000}s cool-down). Pair the breaker with a fallback so users get a degraded answer rather than an error.`,
              lesson: 'm07/pattern-circuit-breaker',
            });
            return { status: 503, fastFail: true, reason: 'circuit open' };
          }
          if (b.state === 'half-open') this.log({ src: from, dst: to, desc: `circuit ${key} HALF-OPEN — allowing one probe request`, level: 'warn' });
        }

        const callCtx = withTimeout(this, ctx, timeout, `${NAMES[from]} → ${NAMES[to]}`);
        const t0 = this.t;
        try {
          res = await this.attempt(callCtx, from, to, method, path, handler);
        } catch (err) {
          if (!(err instanceof DeadlineExceeded) || callCtx === ctx || err.ctx !== callCtx) {
            if (err instanceof DeadlineExceeded && on('timeouts') && err.ctx.owner !== 'client') this.insight('budget-' + key, {
              level: 'warn', title: `An upstream deadline cancelled ${NAMES[from]} → ${NAMES[to]}`,
              what: `${NAMES[from]} was still waiting on ${NAMES[to]} when an outer deadline expired, so the call was cancelled mid-flight.`,
              why: 'Deadlines propagate down the call chain through ctx. Inner timeouts × retry attempts added up to more than the outer budget.',
              fix: 'Budget timeouts top-down: inner timeout × attempts + backoff must fit inside the caller’s deadline. Retry at one layer only.',
              lesson: 'm05/timeouts-retries',
            });
            throw err;
          }
          // Our own timeout fired
          this.lab.edgeFlash(from, to);
          this.log({ src: from, dst: to, method, status: 504, latency: this.t - t0, desc: `timeout after ${timeout} ms — context deadline exceeded; request to ${NAMES[to]} cancelled`, level: 'error' });
          this.metric(to, true);
          this.insight('timeout-' + key, {
            level: 'error', title: `${NAMES[from]} timed out waiting for ${NAMES[to]}`,
            what: `No response within ${timeout} ms, so ${NAMES[from]} cancelled the call and freed its goroutine and connection.`,
            why: has('slow-network') ? 'Network latency (+250 ms per hop) pushed the round trip past the deadline.' : `${NAMES[to]} is blocked (simulated lock contention), so it never answered in time.`,
            fix: 'Keep timeouts — they are what turned an indefinite hang into a fast, visible failure. Budget them so inner timeout × attempts fits inside the outer deadline, and propagate ctx so cancelled work stops downstream.',
            lesson: 'm05/timeouts-retries',
          });
          res = { status: 504, timeout: true };
        }
        this.recordBreaker(key, res.status >= 500);
        if (res.status < 500) {
          if (attempt > 1) this.insight('retry-ok-' + key, {
            level: 'success', title: `Retry recovered the call to ${NAMES[to]}`,
            what: `Attempt ${attempt} succeeded after ${attempt - 1} failure(s).`,
            why: 'The failure was transient. Exponential backoff with jitter spaced the attempts out so they did not pile onto the dependency.',
            fix: 'Keep retries bounded (max attempts + overall deadline) and only for idempotent operations — this request carried an Idempotency-Key or was a GET.',
            lesson: 'm07/pattern-retry',
          });
          return res;
        }
        if (attempt < maxAttempts) {
          if (on('breaker') && breaker(key).state === 'open') continue; // next loop iteration fails fast
          const backoff = Math.round(Math.random() * 100 * Math.pow(2, attempt - 1));
          this.log({ src: from, dst: to, desc: `attempt ${attempt} failed (${res.status}) — retrying in ${backoff} ms (exponential backoff, full jitter)`, level: 'warn' });
          await this.advance(ctx, backoff, this.animMs(this.fast ? 80 : 260));
        }
      }
      if (maxAttempts > 1) this.insight('retry-exhausted-' + key, {
        level: 'error', title: `Retries to ${NAMES[to]} exhausted`,
        what: `All ${maxAttempts} attempts failed.`,
        why: 'Retries only help with transient faults. A crashed process or a dead database fails every attempt — and each retry adds load and latency.',
        fix: 'Combine retries with a circuit breaker so persistent failures stop being retried, and with a fallback for a graceful answer.',
        lesson: 'm05/timeouts-retries',
      });
      else if (!idempotent && on('retries') && res.status >= 500) this.insight('no-retry-' + key, {
        level: 'info', title: `${method} ${path} was not retried`,
        what: 'The retry policy skipped this request.',
        why: 'It is a non-idempotent request without an Idempotency-Key. Retrying could perform the side effect twice.',
        fix: 'Add an Idempotency-Key to writes that must be retryable; the server de-duplicates by key.',
        lesson: 'm07/pattern-idempotency',
      });
      return res;
    }

    async attempt(ctx, from, to, method, path, handler) {
      const t0 = this.t;
      // Connection refused when the target process is down
      if ((to === 'user' && has('user-down'))) {
        await this.hop(ctx, from, to, { label: method, fail: true });
        const res = { status: from === 'gateway' ? 502 : 503, refused: true };
        this.log({ src: from, dst: to, method, status: res.status, latency: this.t - t0, desc: `dial tcp ${to}-service:8081: connect: connection refused`, level: 'error' });
        this.metric(to, true);
        this.insight('refused-' + to, {
          level: 'error', title: `${NAMES[to]} is down — connection refused`,
          what: `${NAMES[from]} could not open a TCP connection to ${NAMES[to]}.`,
          why: 'The process has crashed or every replica is restarting. Connection refusals fail fast, unlike hangs.',
          fix: 'Run at least two replicas behind a Service with readiness probes so a single crash never removes all capacity; retry idempotent calls and protect callers with a breaker.',
          lesson: 'm07/pattern-circuit-breaker',
        });
        return res;
      }
      await this.hop(ctx, from, to, { label: method });
      const res = await handler(ctx);
      const ok = res.status < 400;
      await this.hop(ctx, to, from, { color: res.status >= 500 ? 'err' : res.status >= 400 ? 'warn' : 'green', label: String(res.status) });
      this.log({ src: from, dst: to, method, path, status: res.status, latency: this.t - t0, desc: res.desc || '', level: res.status >= 500 ? 'error' : res.status >= 400 ? 'warn' : 'ok' });
      this.metric(to, !ok && res.status >= 500);
      return res;
    }

    recordBreaker(key, failed) {
      if (!on('breaker')) return;
      const b = breaker(key);
      if (failed) {
        b.fails++;
        if (b.state === 'half-open' || b.fails >= BREAKER.threshold) {
          if (b.state !== 'open') {
            b.state = 'open'; b.openedAt = Date.now();
            this.log({ src: key.split('→')[0], desc: `circuit ${key} OPENED after ${b.fails} consecutive failures (cool-down ${BREAKER.cooldownMs / 1000}s)`, level: 'error' });
            this.insight('breaker-open-' + key, {
              level: 'warn', title: `Circuit breaker ${key} opened`,
              what: `${b.fails} consecutive failures tripped the breaker.`,
              why: 'From now on calls fail immediately instead of waiting on a dependency that is very likely still broken.',
              fix: `After ${BREAKER.cooldownMs / 1000}s one probe is allowed (HALF-OPEN). Fix the dependency, then run another request to watch it close.`,
              lesson: 'm07/pattern-circuit-breaker',
            });
            this.lab.scheduleBreakerRefresh(key);
          }
        }
      } else {
        if (b.state === 'half-open') this.log({ src: key.split('→')[0], desc: `probe succeeded — circuit ${key} CLOSED`, level: 'ok' });
        b.state = 'closed'; b.fails = 0;
      }
      this.lab.renderBreaker(key);
    }

    /* ---------- databases, cache, broker ---------- */
    async db(ctx, from, db, sql, ms) {
      const t0 = this.t;
      const down = (db === 'usersdb' && has('usersdb-down')) || (db === 'ordersdb' && has('ordersdb-down'));
      if (down) {
        await this.hop(ctx, from, db, { label: 'SQL', fail: true });
        this.log({ src: from, dst: db, method: 'SQL', status: 'ERR', latency: this.t - t0, desc: `failed to connect to \`host=${db} user=app database=${db.replace('db', '')}\`: dial error (connection refused)`, level: 'error' });
        this.metric(db, true);
        this.insight(db + '-down', {
          level: 'error', title: `${NAMES[db]} is unreachable`,
          what: `${NAMES[from]} could not get a database connection.`,
          why: 'Postgres is failing over or down. Every request that needs this data fails — retrying immediately does not help.',
          fix: `Return 503 quickly and fail the readiness probe; use managed Postgres with automatic failover; serve cached data where staleness is acceptable.`,
          lesson: 'm09/health-probes',
        });
        return { ok: false };
      }
      await this.hop(ctx, from, db, { label: 'SQL', color: 'cyan' });
      await this.work(ctx, db, ms, null);
      await this.hop(ctx, db, from, { color: 'green' });
      this.log({ src: from, dst: db, method: 'SQL', status: 'OK', latency: this.t - t0, desc: sql, level: 'ok' });
      this.metric(db, false);
      return { ok: true };
    }

    async redis(ctx, from, cmd, desc) {
      const t0 = this.t;
      if (has('redis-down')) {
        this.log({ src: from, dst: 'redis', method: 'REDIS', status: 'ERR', latency: 1, desc: `${cmd}: dial tcp redis:6379: connect: connection refused`, level: 'warn' });
        this.metric('redis', true);
        return { ok: false };
      }
      await this.hop(ctx, from, 'redis', { label: cmd.split(' ')[0], color: 'warn' });
      await this.hop(ctx, 'redis', from, { color: 'green' });
      this.log({ src: from, dst: 'redis', method: 'REDIS', status: 'OK', latency: this.t - t0, desc: desc || cmd, level: 'ok' });
      this.metric('redis', false);
      return { ok: true };
    }

    /* ---------- the request ---------- */
    async exec() {
      const sc = this.sc;
      const ctx = rootCtx();
      let res;
      this.lab.beginRun(this);
      try {
        res = await this.gateway(ctx);
      } catch (err) {
        if (!(err instanceof DeadlineExceeded)) throw err;
        // The client's own patience ran out (no timeouts configured anywhere)
        this.stage('response', 'fail');
        this.log({ src: 'client', dst: 'gateway', method: sc.method, status: 'ERR', latency: this.t, desc: `client gave up after ${CLIENT_PATIENCE / 1000}s — net::ERR_TIMED_OUT`, level: 'error' });
        this.insight('no-timeout', {
          level: 'critical', title: 'No timeouts: the request hung for 30 seconds',
          what: 'Nothing in the chain had a deadline, so the gateway waited until the client itself gave up.',
          why: 'Go’s default `http.Client` and `httputil.ReverseProxy` have no timeout. Each hung request holds a goroutine, a socket and memory; at 500 req/s that is 15,000 stuck requests — the gateway exhausts resources and fails for every route, not just this one.',
          fix: 'Enable timeouts: set `http.Server` read/write timeouts, a per-route upstream timeout, and pass ctx to every outbound call.',
          lesson: 'm07/pattern-timeout',
        });
        res = { status: 'timeout', clientTimeout: true };
      }
      this.result = res;
      this.lab.endRun(this);
      // Asynchronous tail (outbox relay / consumers) runs after the client has its answer
      await this.asyncTail();
      return res;
    }

    async gateway(ctx) {
      const sc = this.sc;
      const t0 = this.t;
      this.stage('edge', 'active');
      await this.hop(ctx, 'client', 'gateway', { label: sc.method });
      this.log({ src: 'client', dst: 'gateway', method: sc.method, path: sc.path, desc: `TLS terminated · assigned X-Request-ID: ${this.rid}`, level: 'info' });
      this.metric('gateway', false);
      this.stage('edge', 'ok');

      // Rate limiting (token bucket in Redis)
      this.stage('ratelimit', 'active');
      const now = Date.now();
      world.tokens = Math.min(RATE.capacity, world.tokens + ((now - world.lastRefill) / 1000) * RATE.refillPerSec);
      world.lastRefill = now;
      const rl = await this.redis(ctx, 'gateway', 'EVAL token_bucket.lua 1 ratelimit:user:42', `token bucket: ${Math.max(0, Math.floor(world.tokens - 1))}/${RATE.capacity} tokens left`);
      if (!rl.ok) {
        this.stage('ratelimit', 'warn');
        this.log({ src: 'gateway', desc: on('fallback') ? 'rate limiter: Redis unavailable → falling back to in-process token bucket (per-instance limits)' : 'rate limiter: Redis unavailable → FAILING OPEN (request allowed without a limit check)', level: 'warn' });
        this.insight('redis-ratelimit', {
          level: 'warn', title: on('fallback') ? 'Rate limiting degraded to per-instance limits' : 'Rate limiting failed open',
          what: 'The gateway could not reach Redis to check the token bucket.',
          why: 'Rate-limit state lives in Redis so every gateway replica shares it. Without Redis the gateway must choose: block everything (fail closed) or allow everything (fail open).',
          fix: on('fallback') ? 'The in-process fallback keeps approximate limits (N replicas → up to N× the limit). Alert on Redis health.' : 'Failing open preserves availability but removes abuse protection. Consider a local in-memory fallback limiter (enable Fallbacks) and alert on Redis health.',
          lesson: 'm04/rate-limiting',
        });
      } else {
        world.tokens -= 1;
        if (world.tokens < 0) {
          world.tokens = 0;
          this.stage('ratelimit', 'fail');
          await this.hop(ctx, 'gateway', 'client', { color: 'warn', label: '429' });
          this.log({ src: 'gateway', dst: 'client', method: sc.method, status: 429, latency: this.t - t0, desc: 'rate limit exceeded · Retry-After: 1', level: 'warn' });
          return { status: 429 };
        }
        this.stage('ratelimit', 'ok');
      }

      // Authentication
      if (sc.id === 'login') {
        this.stage('auth', 'skip');
        this.log({ src: 'gateway', desc: 'public route — JWT not required', level: 'info' });
      } else {
        this.stage('auth', 'active');
        await this.work(ctx, 'gateway', 0.3, 'JWT verified locally (HS256, exp in 11m) · sub=42 role=customer · set X-User-ID: 42');
        this.stage('auth', 'ok');
      }

      // Routing
      this.stage('route', 'active');
      const upstream = sc.id === 'login' || sc.id === 'get-profile' ? 'user' : 'order';
      const upPath = sc.path.replace('/api', '');
      this.log({ src: 'gateway', desc: `route matched ${sc.method} ${sc.path.replace(/\d{3,}/, ':id')} → ${upstream}-service${upPath}`, level: 'info' });
      this.stage('route', 'ok');

      // Upstream call
      this.stage('service', 'active');
      const idempotent = sc.method === 'GET' || sc.id === 'create-order' || sc.id === 'cancel-order';
      let res = await this.call(ctx, 'gateway', upstream, { method: sc.method, path: upPath, idempotent, timeout: 2000, key: `gateway→${upstream}` }, (c) => this.handle(c, upstream));
      this.stage('service', res.status < 400 ? 'ok' : 'fail');

      if (res.timeout && this.fx.orderCommitted) {
        this.insight('late-success', {
          level: 'critical', title: 'The client saw 504 — but the order was created',
          what: 'Order Service committed the order after the gateway had already given up on it.',
          why: 'A timeout tells you nothing about whether the work happened. If the client now retries without an Idempotency-Key, the customer gets two orders.',
          fix: 'Clients retry with the same Idempotency-Key; the server returns the stored result. Also keep inner timeouts × retries smaller than the outer deadline.',
          lesson: 'm07/pattern-idempotency',
        });
      }

      // Response to client
      this.stage('response', 'active');
      const status = res.status;
      await this.hop(ctx, 'gateway', 'client', { color: status >= 500 ? 'err' : status >= 400 ? 'warn' : 'green', label: String(status) });
      const desc = status === 504 ? 'Gateway Timeout' : status === 502 ? 'Bad Gateway — upstream unreachable' : status === 503 ? (res.fastFail ? 'Service Unavailable · Retry-After: 8 (circuit open)' : 'Service Unavailable') : res.desc || '';
      this.log({ src: 'gateway', dst: 'client', method: sc.method, status, latency: this.t - t0, desc, level: status >= 500 ? 'error' : status >= 400 ? 'warn' : 'ok' });
      this.stage('response', status < 400 ? 'ok' : 'fail');
      return res;
    }

    handle(ctx, svc) {
      const sc = this.sc;
      if (svc === 'user') return sc.id === 'login' ? this.userLogin(ctx) : this.userProfile(ctx);
      if (sc.id === 'create-order') return this.orderCreate(ctx);
      if (sc.id === 'cancel-order') return this.orderCancel(ctx);
      return this.orderGet(ctx);
    }

    /* ---------- User Service ---------- */
    async userLogin(ctx) {
      this.stage('db', 'active');
      const q = await this.db(ctx, 'user', 'usersdb', 'SELECT id, password_hash, status FROM users WHERE email = $1', 2);
      if (!q.ok) { this.stage('db', 'fail'); return { status: 503, desc: 'users-db unavailable' }; }
      this.stage('db', 'ok');
      await this.work(ctx, 'user', 72, 'bcrypt.CompareHashAndPassword (cost 12) — slow by design to resist brute force');
      await this.work(ctx, 'user', 1, 'signed access token (HS256, exp 15m)');
      return { status: 200, desc: '{"access_token":"eyJhbGciOi…","expires_in":900}' };
    }

    async userProfile(ctx) {
      this.stage('cache', 'active');
      const c = await this.redis(ctx, 'user', 'GET user:42', world.cache.profile ? 'GET user:42 → HIT' : 'GET user:42 → MISS');
      if (c.ok && world.cache.profile) {
        this.stage('cache', 'ok'); this.stage('db', 'skip');
        if (has('usersdb-down')) this.insight('cache-masked', {
          level: 'success', title: 'The cache masked the database outage',
          what: 'users-db is down, but the profile was served from Redis.',
          why: 'Cache-aside returns hits without touching Postgres. The data may be up to one TTL (5 min) stale.',
          fix: 'Decide per endpoint whether stale data is acceptable during an outage (stale-if-error). It is for a profile page; it is not for an account balance.',
          lesson: 'm06/redis-caching',
        });
        return { status: 200, desc: 'profile (from cache)' };
      }
      if (!c.ok) {
        this.stage('cache', 'warn');
        this.insight('redis-cache', {
          level: 'warn', title: 'Cache unavailable — reads fall through to Postgres',
          what: 'User Service could not reach Redis, so every profile read hit users-db.',
          why: 'Caches are an optimisation, so this degrades latency rather than correctness — but under real load the extra queries can overwhelm the database.',
          fix: 'Size the database for cache-miss load or rate-limit cache rebuilds; alert on cache hit ratio.',
          lesson: 'm06/redis-caching',
        });
      } else this.stage('cache', 'ok');
      this.stage('db', 'active');
      const q = await this.db(ctx, 'user', 'usersdb', 'SELECT id, email, name, status FROM users WHERE id = $1', 2);
      if (!q.ok) {
        this.stage('db', 'fail');
        if (on('fallback')) {
          this.log({ src: 'user', desc: 'fallback: building a partial profile from verified JWT claims (id, email, role) · "degraded": true', level: 'warn' });
          this.insight('fallback-profile', {
            level: 'success', title: 'Fallback served a degraded profile',
            what: 'Postgres was down and the cache was cold, so User Service returned the fields it already knew from the JWT.',
            why: 'A partial answer is often better than an error page — the UI can hide fields it did not get.',
            fix: 'Mark degraded responses explicitly (a field or header) so clients and dashboards can tell.',
            lesson: 'm07/pattern-circuit-breaker',
          });
          return { status: 200, desc: 'partial profile (degraded fallback)' };
        }
        return { status: 503, desc: 'users-db unavailable' };
      }
      this.stage('db', 'ok');
      if (c.ok) {
        await this.redis(ctx, 'user', 'SET user:42 EX 300', 'SET user:42 (TTL 300s)');
        world.cache.profile = true;
      }
      return { status: 200, desc: 'profile' };
    }

    async userInternal(ctx) {
      const q = await this.db(ctx, 'user', 'usersdb', 'SELECT status FROM users WHERE id = $1', 1);
      if (!q.ok) return { status: 503, desc: 'users-db unavailable' };
      return { status: 200, desc: '{"id":42,"status":"active"}' };
    }

    /* ---------- Order Service ---------- */
    async orderFaults(ctx) {
      if (has('order-500') && Math.random() < 0.6) {
        await this.work(ctx, 'order', 3, 'panic: runtime error: invalid memory address or nil pointer dereference (pricing.Calculate) — recovered by middleware', { level: 'error' });
        this.insight('order-500', {
          level: 'error', title: 'Order Service returned HTTP 500',
          what: 'A nil-pointer bug panicked; the Recovery middleware converted it into a 500 instead of crashing the process.',
          why: '500 means “our bug”. It can be intermittent (depends on input or timing) — this one fails ~60% of requests.',
          fix: 'Retries may mask an intermittent bug but triple the load for a deterministic one. Alert on 5xx rate, roll back the deploy, fix with a regression test.',
          lesson: 'm02/errors',
        });
        return { status: 500, desc: 'internal error' };
      }
      if (has('order-timeout')) {
        this.log({ src: 'order', desc: 'waiting for row lock on inventory_reservations (held by a long migration)…', level: 'warn' });
        this.lab.busy('order', true);
        try {
          await this.advance(ctx, 30000, this.animMs(this.fast ? 900 : 2600));
        } finally { this.lab.busy('order', false); }
      }
      return null;
    }

    async orderCreate(ctx) {
      const fault = await this.orderFaults(ctx);
      if (fault) return fault;
      await this.work(ctx, 'order', 0.4, 'Idempotency-Key 7f3a… not seen before — processing');
      // Validate the customer synchronously
      this.stage('upstream', 'active');
      const u = await this.call(ctx, 'order', 'user', { method: 'GET', path: '/internal/users/42', idempotent: true, timeout: 800, key: 'order→user' }, (c) => this.userInternal(c));
      let pendingVerification = false;
      if (u.status !== 200) {
        if (on('fallback')) {
          pendingVerification = true;
          this.stage('upstream', 'warn');
          this.log({ src: 'order', desc: 'fallback: User Service unavailable — accepting order as PENDING_VERIFICATION (identity already verified by the gateway JWT)', level: 'warn' });
          this.insight('fallback-order', {
            level: 'success', title: 'Order accepted in a degraded mode',
            what: 'Order Service could not validate the customer, so it accepted the order as PENDING_VERIFICATION and returned 202.',
            why: 'The JWT already proves who the user is; account status can be checked asynchronously. Losing the sale is worse than a short delay.',
            fix: 'A background job re-validates pending orders and cancels them if the account is suspended. This is a business decision — document it.',
            lesson: 'm03/inter-service',
          });
        } else {
          this.stage('upstream', 'fail');
          this.insight('propagation', {
            level: 'error', title: 'A dependency failure propagated to the client',
            what: `User Service failed, so Order Service returned 503 and the gateway passed it on.`,
            why: 'Synchronous calls couple availability: the order path is only as available as every service it calls in series.',
            fix: 'Add a fallback (enable Fallbacks), cache the data you need, or replicate it via events so the order path does not depend on User Service at request time.',
            lesson: 'm05/sync-vs-async',
          });
          return { status: 503, desc: 'cannot validate customer: user-service unavailable' };
        }
      } else this.stage('upstream', 'ok');

      // Single transaction: order + items + outbox + idempotency key
      this.stage('db', 'active');
      const stmts = on('outbox')
        ? 'BEGIN; INSERT orders; INSERT order_items ×2; INSERT outbox(order.created); INSERT idempotency_keys; COMMIT'
        : 'BEGIN; INSERT orders; INSERT order_items ×2; INSERT idempotency_keys; COMMIT';
      const tx = await this.db(ctx, 'order', 'ordersdb', stmts, 6);
      if (!tx.ok) { this.stage('db', 'fail'); return { status: 503, desc: 'orders-db unavailable' }; }
      this.fx.orderCommitted = true;
      this.fx.event = 'order.created';
      this.stage('db', 'ok');

      if (!on('outbox')) await this.directPublish(ctx, 'order.created');
      return { status: pendingVerification ? 202 : 201, desc: pendingVerification ? '{"id":8812,"status":"PENDING_VERIFICATION"}' : '{"id":8812,"status":"PENDING"}' };
    }

    async orderGet(ctx) {
      const fault = await this.orderFaults(ctx);
      if (fault) return fault;
      this.stage('db', 'active');
      const q = await this.db(ctx, 'order', 'ordersdb', 'SELECT … FROM orders WHERE id = $1 AND user_id = $2', 2);
      if (!q.ok) { this.stage('db', 'fail'); return { status: 503, desc: 'orders-db unavailable' }; }
      this.stage('db', 'ok');
      return { status: 200, desc: '{"id":8812,"status":"PENDING","total_cents":4200}' };
    }

    async orderCancel(ctx) {
      const fault = await this.orderFaults(ctx);
      if (fault) return fault;
      this.stage('db', 'active');
      const stmts = on('outbox')
        ? "BEGIN; UPDATE orders SET status='CANCELLED' WHERE id=$1 AND status IN ('PENDING','CONFIRMED'); INSERT outbox(order.cancelled); COMMIT"
        : "UPDATE orders SET status='CANCELLED' WHERE id=$1 AND status IN ('PENDING','CONFIRMED')";
      const tx = await this.db(ctx, 'order', 'ordersdb', stmts, 4);
      if (!tx.ok) { this.stage('db', 'fail'); return { status: 503, desc: 'orders-db unavailable' }; }
      this.fx.orderCommitted = true;
      this.fx.event = 'order.cancelled';
      this.stage('db', 'ok');
      if (!on('outbox')) await this.directPublish(ctx, 'order.cancelled');
      return { status: 200, desc: '{"id":8812,"status":"CANCELLED"}' };
    }

    async directPublish(ctx, event) {
      this.stage('event', 'active');
      if (has('broker-down')) {
        await this.hop(ctx, 'order', 'broker', { label: 'publish', fail: true });
        this.log({ src: 'order', dst: 'broker', method: 'AMQP', status: 'ERR', desc: `publish ${event} failed: dial tcp rabbitmq:5672: connect: connection refused — EVENT LOST (order already committed)`, level: 'error' });
        world.lostEvents++;
        this.lab.updateBadges();
        this.stage('event', 'fail');
        this.insight('dual-write', {
          level: 'critical', title: `Event lost: ${event} was never published`,
          what: 'The order committed to Postgres, then publishing to RabbitMQ failed. The customer gets no confirmation and downstream services never learn about the order.',
          why: 'This is the dual-write problem: a database commit and a broker publish cannot be made atomic. Retrying in-process does not survive a crash either.',
          fix: 'Enable the Transactional outbox: write the event in the same transaction and let a relay publish it with retries.',
          lesson: 'm07/pattern-outbox',
        });
        this.fx.event = null;
        return;
      }
      await this.hop(ctx, 'order', 'broker', { label: 'publish', color: 'purple' });
      this.log({ src: 'order', dst: 'broker', method: 'AMQP', status: 'OK', desc: `published ${event} directly after COMMIT (no outbox — a crash between the two would lose it)`, level: 'ok' });
      this.fx.directPublished = true;
      this.stage('event', 'ok');
    }

    /* ---------- async tail: outbox relay + consumer ---------- */
    async asyncTail() {
      const actx = { deadline: Infinity, owner: 'async' }; actx.defining = actx;
      let events = 0;
      if (on('outbox')) {
        if (this.fx.orderCommitted && this.fx.event) world.outboxBacklog++;
        if (world.outboxBacklog > 0) {
          this.lab.updateBadges();
          await this.work(actx, 'order', 500, null);
          if (has('broker-down')) {
            await this.hop(actx, 'order', 'broker', { label: 'publish', fail: true });
            this.log({ src: 'order', dst: 'broker', method: 'AMQP', status: 'ERR', desc: `outbox relay: publish failed (connection refused) — ${world.outboxBacklog} event(s) remain pending in the outbox, will retry`, level: 'warn', async: true });
            this.stage('event', 'warn');
            this.insight('outbox-backlog', {
              level: 'success', title: 'Broker down — the event is safe in the outbox',
              what: `The order committed with its event row. The relay could not publish, so ${world.outboxBacklog} event(s) wait in the outbox table.`,
              why: 'Because the event was written in the same transaction as the order, nothing is lost. Delivery is delayed, not dropped.',
              fix: 'Restore the broker (toggle the failure off) and send another request — the relay drains the backlog. Alert on outbox age.',
              lesson: 'm07/pattern-outbox',
            });
            return;
          }
          events = world.outboxBacklog;
          await this.hop(actx, 'order', 'broker', { label: events > 1 ? `×${events}` : 'publish', color: 'purple' });
          this.log({ src: 'order', dst: 'broker', method: 'AMQP', status: 'OK', desc: `outbox relay published ${events} event(s) with publisher confirms; marked published_at`, level: 'ok', async: true });
          if (events > 1) this.insight('outbox-flushed', {
            level: 'success', title: `Outbox drained ${events} delayed events`,
            what: 'The broker is reachable again, so the relay published every pending event in order.',
            why: 'The outbox turned a broker outage into a delay instead of data loss.',
            fix: 'Consumers must be idempotent: a relay crash between publish and marking can re-publish an event.',
            lesson: 'm07/pattern-outbox',
          });
          world.outboxBacklog = 0;
          this.lab.updateBadges();
          this.stage('event', 'ok');
        }
      } else if (this.fx.directPublished) {
        events = 1;
      }
      if (!events) return;
      // Consumer
      await this.hop(actx, 'broker', 'notify', { label: 'deliver', color: 'purple' });
      this.metric('notify', false);
      await this.work(actx, 'notify', 140, `consumed ${events > 1 ? events + ' events' : this.fx.event || 'event'} · dedupe check passed · confirmation email sent · ack`, { level: 'ok' });
      this.metric('broker', false);
    }
  }

  /* ======================================================================
     Lab UI
     ====================================================================== */
  const LIFECYCLE = {
    'create-order': [['edge', 'Client → gateway'], ['ratelimit', 'Rate limit'], ['auth', 'JWT auth'], ['route', 'Route'], ['service', 'Order Service'], ['upstream', 'Validate user'], ['db', 'orders-db tx'], ['event', 'Publish event'], ['response', 'Response']],
    'get-profile': [['edge', 'Client → gateway'], ['ratelimit', 'Rate limit'], ['auth', 'JWT auth'], ['route', 'Route'], ['service', 'User Service'], ['cache', 'Redis cache'], ['db', 'users-db'], ['response', 'Response']],
    login: [['edge', 'Client → gateway'], ['ratelimit', 'Rate limit'], ['auth', 'Public route'], ['route', 'Route'], ['service', 'User Service'], ['db', 'users-db'], ['response', 'Response']],
    'get-order': [['edge', 'Client → gateway'], ['ratelimit', 'Rate limit'], ['auth', 'JWT auth'], ['route', 'Route'], ['service', 'Order Service'], ['db', 'orders-db'], ['response', 'Response']],
    'cancel-order': [['edge', 'Client → gateway'], ['ratelimit', 'Rate limit'], ['auth', 'JWT auth'], ['route', 'Route'], ['service', 'Order Service'], ['db', 'orders-db tx'], ['event', 'Publish event'], ['response', 'Response']],
  };
  const SEVERITY = { critical: 0, error: 1, warn: 2, info: 3, success: 4 };
  const SEV_ICON = { critical: 'siren', error: 'circle-x', warn: 'triangle-alert', info: 'info', success: 'circle-check' };
  const STATUS_TEXT = { 200: 'OK', 201: 'Created', 202: 'Accepted', 429: 'Too Many Requests', 500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

  class Lab {
    constructor(view, query) {
      this.view = view;
      this.query = query;
      this.view$ = { x: 0, y: 0, k: 1 };
      this.layout = {};
      this.geom = {};
      this.edgeActive = {};
      this.logs = [];
      this.logFilter = 'all';
      this.running = 0;
      this.timers = [];
      this.disposed = false;
      this.scenario = LAB.scenarios[0].id;
      this.render();
    }

    /* ---------- layout ---------- */
    render() {
      MV.shell.setCrumbs([{ label: 'Practice', href: '#/challenges' }, { label: 'Architecture Lab' }]);
      const saved = MV.store.get().lab.layout || {};
      LAB.nodes.forEach((n) => { this.layout[n.id] = saved[n.id] ? { ...saved[n.id] } : { x: n.x, y: n.y }; });

      this.view.innerHTML = `<div class="lab">
        <div class="lab-toolbar">
          <div class="lab-title"><span class="icon-tile sm" style="--c:var(--cyan)">${icon('workflow')}</span><div><div class="font-semibold text-[14px]" style="color:var(--fg)">Architecture Lab</div><div class="text-[11.5px] text-mutedc">Order Management System</div></div>
            <span class="badge badge-sim" data-tip="Every request, latency and log line here is generated by an in-browser model. No real services are called.">${icon('flask-conical')}Simulated</span></div>
          <div class="lab-actions">
            <label class="sr-only" for="lab-scenario">Request</label>
            <select class="select lab-scenario" id="lab-scenario">${LAB.scenarios.map((s) => `<option value="${s.id}">${s.method} ${s.path} — ${esc(s.label)}</option>`).join('')}</select>
            <button class="btn btn-primary" type="button" id="lab-run" data-tip="Simulate request" data-tip-kbd="Space">${icon('play')}<span>Simulate Request</span></button>
            <button class="btn" type="button" id="lab-burst" data-tip="Send 10 requests, 250 ms apart — watch breakers trip">${icon('repeat')}<span class="hide-sm">Send 10×</span></button>
          </div>
          <div class="lab-view-ctl">
            <div class="segmented" role="group" aria-label="Simulation speed">${[0.5, 1, 2].map((s) => `<button type="button" data-speed="${s}" aria-pressed="${world.speed === s}">${s}×</button>`).join('')}</div>
            <button class="btn btn-icon btn-sm" type="button" data-zoom="out" aria-label="Zoom out" data-tip="Zoom out">${icon('minus')}</button>
            <button class="btn btn-icon btn-sm" type="button" data-zoom="in" aria-label="Zoom in" data-tip="Zoom in">${icon('plus')}</button>
            <button class="btn btn-icon btn-sm" type="button" data-fit aria-label="Fit to view" data-tip="Fit to view" data-tip-kbd="F">${icon('maximize')}</button>
            <button class="btn btn-icon btn-sm" type="button" data-reset-layout aria-label="Reset layout" data-tip="Reset layout">${icon('layout-grid')}</button>
          </div>
        </div>
        <div class="lab-body">
          <div class="lab-stage">
            <div class="lab-canvas dot-bg no-smooth" id="lab-canvas" tabindex="-1">
              <div class="lab-world" id="lab-world">
                <svg class="lab-svg" id="lab-svg" width="1500" height="820" aria-hidden="true">
                  <defs><marker id="lab-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="lab-arrow"/></marker>
                  <filter id="lab-glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="3.5" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter></defs>
                  <g id="lab-edges"></g><g id="lab-breakers"></g><g id="lab-packets"></g>
                </svg>
                ${LAB.nodes.map((n) => this.nodeHtml(n)).join('')}
              </div>
            </div>
            <div class="lab-lifecycle" id="lab-lifecycle" aria-live="polite"></div>
            <div class="lab-hint text-mutedc">${icon('mouse-pointer-2', '', 13)}Drag nodes · scroll to zoom · drag the background to pan · click a node to inspect</div>
            <section class="lab-analysis card" id="lab-analysis" hidden aria-live="polite"></section>
            <aside class="lab-inspector" id="lab-inspector" hidden aria-label="Node inspector"></aside>
          </div>
          <div class="lab-side scroll-thin" data-lenis-prevent>
            <details class="lab-panel" open>
              <summary class="lab-panel-head">${icon('chevron-right', 'chev')}<span>Failure injection</span><span class="badge badge-err" id="fail-count" hidden></span><button type="button" class="btn btn-ghost btn-sm ml-auto" id="fail-clear">Clear</button></summary>
              <div class="lab-chips">${LAB.failures.map((f) => `<button type="button" class="lab-chip is-fail" data-failure="${f.id}" aria-pressed="${world.failures.has(f.id)}" data-tip="${esc(f.label)} — ${esc(f.desc)}" data-tip-side="top">${icon(f.icon)}<span>${esc(f.short || f.label)}</span></button>`).join('')}</div>
            </details>
            <details class="lab-panel" open>
              <summary class="lab-panel-head">${icon('chevron-right', 'chev')}<span>Resilience patterns</span></summary>
              <div class="lab-chips">${LAB.resilience.map((r) => `<button type="button" class="lab-chip is-res" data-resilience="${r.id}" aria-pressed="${world.resilience.has(r.id)}" data-tip="${esc(r.label)} — ${esc(r.desc)}" data-tip-side="top">${icon(r.id === 'timeouts' ? 'timer' : r.id === 'retries' ? 'refresh-cw' : r.id === 'breaker' ? 'toggle-right' : r.id === 'fallback' ? 'life-buoy' : 'inbox')}<span>${esc(r.short || r.label)}</span></button>`).join('')}</div>
            </details>
            <section class="lab-panel lab-log-panel">
              <div class="lab-panel-head"><span>${icon('scroll-text', '', 15)}</span><span>Event log</span><span class="text-[11px] text-mutedc mono" id="log-count">0</span>
                <div class="segmented ml-auto" role="group" aria-label="Filter log"><button type="button" data-logf="all" aria-pressed="true">All</button><button type="button" data-logf="errors" aria-pressed="false">Issues</button></div>
                <button class="btn btn-ghost btn-icon btn-sm" type="button" id="log-copy" aria-label="Copy log as JSON" data-tip="Copy log as JSON">${icon('copy')}</button>
                <button class="btn btn-ghost btn-icon btn-sm" type="button" id="log-clear" aria-label="Clear log" data-tip="Clear log">${icon('trash-2')}</button></div>
              <div class="lab-log scroll-thin" id="lab-log" data-lenis-prevent role="log" aria-label="Simulated event log">
                <div class="lab-log-empty">${icon('radio')}<div><strong>No events yet</strong><br>Press <span class="kbd">Space</span> or <em>Simulate Request</em>. Then switch on a failure and run it again.</div></div>
              </div>
            </section>
          </div>
        </div>
      </div>`;

      this.$canvas = $('#lab-canvas', this.view);
      this.$world = $('#lab-world', this.view);
      this.$svg = $('#lab-svg', this.view);
      this.$edges = $('#lab-edges', this.view);
      this.$packets = $('#lab-packets', this.view);
      this.$breakers = $('#lab-breakers', this.view);
      this.$log = $('#lab-log', this.view);
      $('#lab-scenario', this.view).value = this.scenario;

      this.applyNodeLayout();
      this.renderEdges();
      this.renderLifecycle();
      this.refreshStatuses();
      this.bind();
      requestAnimationFrame(() => {
        if (this.disposed) return;
        this.measure();
        this.renderEdges();
        this.fit();
        LAB.nodes.forEach((n) => this.updateNodeMetrics(n.id));
        this.updateBadges();
        Object.keys(world.breakers).forEach((k) => this.renderBreaker(k));
        if (this.query && this.query.run) setTimeout(() => this.runOnce(), 350);
      });
    }

    nodeHtml(n) {
      const conns = LAB.edges.filter((e) => e.from === n.id || e.to === n.id).length;
      return `<div class="lab-node" data-node="${n.id}" data-kind="${n.kind}" data-status="healthy" tabindex="0" role="button" aria-label="${esc(n.name)}. Press Enter to inspect, arrow keys to move.">
        <div class="ln-head"><span class="ln-icon">${icon(KIND_ICON[n.kind] || 'server')}</span>
          <div class="ln-titles"><div class="ln-name">${esc(n.name)}</div><div class="ln-tech">${esc(n.tech)}</div></div>
          <span class="ln-status" data-status-label><span class="dot"></span><span>Healthy</span></span></div>
        <div class="ln-resp">${esc(n.responsibility)}</div>
        <div class="ln-foot"><span>${icon('git-commit-horizontal', '', 12)}${conns} connection${conns === 1 ? '' : 's'}</span><span class="ln-metrics mono" data-metrics></span><span class="ln-badge" data-badge hidden></span></div>
      </div>`;
    }

    applyNodeLayout() {
      $$('.lab-node', this.$world).forEach((el) => {
        const p = this.layout[el.dataset.node];
        el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      });
    }

    measure() {
      $$('.lab-node', this.$world).forEach((el) => {
        const id = el.dataset.node;
        const p = this.layout[id];
        this.geom[id] = { x: p.x, y: p.y, w: el.offsetWidth, h: el.offsetHeight };
      });
    }

    endpoints(e) {
      const a = this.geom[e.from], b = this.geom[e.to];
      if (!a || !b) return null;
      const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }, bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
      const clip = (r, c, tx, ty) => {
        const dx = tx - c.x, dy = ty - c.y;
        const t = Math.min((r.w / 2 + 6) / Math.abs(dx || 1e-6), (r.h / 2 + 6) / Math.abs(dy || 1e-6));
        return { x: c.x + dx * t, y: c.y + dy * t };
      };
      const p1 = clip(a, ac, bc.x, bc.y), p2 = clip(b, bc, ac.x, ac.y);
      return { x1: p1.x, y1: p1.y, x2: p2.x, y2: p2.y };
    }

    renderEdges() {
      this.$edges.innerHTML = LAB.edges.map((e) => {
        const p = this.endpoints(e);
        if (!p) return '';
        const la = e.labelAt || 0.5;
        const mx = p.x1 + (p.x2 - p.x1) * la, my = p.y1 + (p.y2 - p.y1) * la;
        const w = e.label.length * 6.4 + 14;
        return `<g class="lab-edge" data-edge="${e.id}">
          <line class="le-line" x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}" marker-end="url(#lab-arrow)"/>
          <line class="le-flow" x1="${p.x1}" y1="${p.y1}" x2="${p.x2}" y2="${p.y2}"/>
          <g class="le-label" transform="translate(${mx},${my})"><rect x="${-w / 2}" y="-9" width="${w}" height="18" rx="5"/><text text-anchor="middle" dy="3.5">${esc(e.label)}</text></g>
        </g>`;
      }).join('');
      this.refreshEdgeStates();
      Object.keys(world.breakers).forEach((k) => this.renderBreaker(k));
    }

    edgeBetween(a, b) {
      return LAB.edges.find((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a));
    }

    /* ---------- statuses ---------- */
    nodeStatus(id) {
      const f = LAB.failures.find((x) => x.node === id && world.failures.has(x.id));
      if (!f) return { s: 'healthy', label: 'Healthy' };
      if (f.id === 'order-timeout') return { s: 'degraded', label: 'Slow' };
      if (f.id === 'order-500') return { s: 'degraded', label: '5xx errors' };
      return { s: 'down', label: 'Down' };
    }

    refreshStatuses() {
      LAB.nodes.forEach((n) => {
        const el = $(`.lab-node[data-node="${n.id}"]`, this.$world);
        if (!el) return;
        const st = this.nodeStatus(n.id);
        el.dataset.status = st.s;
        $('[data-status-label] span:last-child', el).textContent = st.label;
      });
      this.$canvas.classList.toggle('is-slow-net', has('slow-network'));
      const fc = $('#fail-count', this.view);
      fc.hidden = world.failures.size === 0;
      fc.textContent = `${world.failures.size} active`;
      this.refreshEdgeStates();
    }

    refreshEdgeStates() {
      LAB.edges.forEach((e) => {
        const g = $(`[data-edge="${e.id}"]`, this.$edges);
        if (!g) return;
        const broken = this.nodeStatus(e.from).s === 'down' || this.nodeStatus(e.to).s === 'down';
        g.classList.toggle('is-broken', broken);
        g.classList.toggle('is-slow', has('slow-network'));
      });
    }

    updateNodeMetrics(id) {
      const el = this.$world && $(`.lab-node[data-node="${id}"] [data-metrics]`, this.$world);
      if (!el) return;
      const m = world.metrics[id];
      el.textContent = m ? `${m.req} req · ${m.err} err` : '';
      el.classList.toggle('has-err', !!(m && m.err));
    }

    updateBadges() {
      const set = (id, text, cls) => {
        const el = this.$world && $(`.lab-node[data-node="${id}"] [data-badge]`, this.$world);
        if (!el) return;
        el.hidden = !text;
        el.textContent = text || '';
        el.className = 'ln-badge ' + (cls || '');
      };
      set('order', world.outboxBacklog ? `outbox: ${world.outboxBacklog} pending` : world.lostEvents ? `${world.lostEvents} event${world.lostEvents > 1 ? 's' : ''} lost` : '', world.outboxBacklog ? 'is-warn' : 'is-err');
    }

    busy(id, isBusy) {
      const el = this.$world && $(`.lab-node[data-node="${id}"]`, this.$world);
      if (!el) return;
      const n = +(el.dataset.busy || 0) + (isBusy ? 1 : -1);
      el.dataset.busy = Math.max(0, n);
      el.classList.toggle('is-busy', n > 0);
    }

    pulse(id, color) {
      const el = this.$world && $(`.lab-node[data-node="${id}"]`, this.$world);
      if (!el) return;
      el.style.setProperty('--pulse', `var(--${color === 'err' ? 'err' : color === 'green' ? 'green' : color === 'purple' ? 'purple' : color === 'warn' ? 'warn' : color === 'cyan' ? 'cyan' : 'blue'})`);
      el.classList.remove('is-pulse'); void el.offsetWidth; el.classList.add('is-pulse');
    }

    /* ---------- breakers ---------- */
    breakerEdge(key) {
      const [from, to] = key.split('→');
      return this.edgeBetween(from, to);
    }
    renderBreaker(key) {
      if (!this.$breakers) return;
      const e = this.breakerEdge(key);
      if (!e) return;
      const b = world.breakers[key];
      let g = $(`[data-breaker="${CSS.escape(key)}"]`, this.$breakers);
      if (!on('breaker') || !b || (b.state === 'closed' && b.fails === 0)) { if (g) g.remove(); return; }
      const p = this.endpoints(e);
      if (!p) return;
      const [from] = key.split('→');
      const fromIsStart = e.from === from;
      const t = 0.22;
      const x = fromIsStart ? p.x1 + (p.x2 - p.x1) * t : p.x2 + (p.x1 - p.x2) * t;
      const y = fromIsStart ? p.y1 + (p.y2 - p.y1) * t : p.y2 + (p.y1 - p.y2) * t;
      const label = b.state === 'open' ? 'OPEN' : b.state === 'half-open' ? 'HALF-OPEN' : `${b.fails}/${BREAKER.threshold} fails`;
      const w = label.length * 6.6 + 30;
      if (!g) { g = document.createElementNS(NS, 'g'); g.setAttribute('data-breaker', key); this.$breakers.appendChild(g); }
      g.setAttribute('class', `lab-breaker is-${b.state}`);
      g.setAttribute('transform', `translate(${x},${y})`);
      g.innerHTML = `<rect x="${-w / 2}" y="-11" width="${w}" height="22" rx="11"/>${MV.diagram.svgIcon(b.state === 'open' ? 'toggle-left' : 'toggle-right', -w / 2 + 6, -6, 12, 'currentColor')}<text x="${-w / 2 + 22}" y="4">${label}</text><title>Circuit breaker ${key}: ${b.state}</title>`;
    }
    flashBreaker(key) {
      const g = $(`[data-breaker="${CSS.escape(key)}"]`, this.$breakers);
      if (!g) return;
      g.classList.remove('is-flash'); void g.getBBox(); g.classList.add('is-flash');
    }
    scheduleBreakerRefresh(key) {
      const t = setTimeout(() => {
        if (this.disposed) return;
        breaker(key);
        this.renderBreaker(key);
        const b = world.breakers[key];
        if (b && b.state === 'half-open') toast(`Circuit ${key} is half-open`, { type: 'info', desc: 'The next request will be allowed through as a probe.', duration: 2600 });
      }, BREAKER.cooldownMs + 50);
      this.timers.push(t);
    }

    /* ---------- packets ---------- */
    packet(from, to, { color = 'blue', duration = 500, stopAt = 1, label, fail } = {}) {
      const e = this.edgeBetween(from, to);
      if (!e || this.disposed) return MV.sleep(duration);
      const reverse = e.from !== from;
      const c = { blue: 'var(--blue)', green: 'var(--green)', err: 'var(--err)', warn: 'var(--warn)', purple: 'var(--purple)', cyan: 'var(--cyan)' }[color] || color;
      const g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'lab-packet');
      g.innerHTML = `<circle r="11" fill="${c}" opacity=".16"/><circle r="5.5" fill="${c}" filter="url(#lab-glow)"/>${label ? `<text y="-13" text-anchor="middle" fill="${c}">${esc(label)}</text>` : ''}`;
      this.$packets.appendChild(g);
      const edgeEl = $(`[data-edge="${e.id}"]`, this.$edges);
      this.edgeActive[e.id] = (this.edgeActive[e.id] || 0) + 1;
      if (edgeEl) { edgeEl.classList.add('is-active'); edgeEl.style.setProperty('--ec', c); }
      const limit = fail ? 0.9 : stopAt;
      const start = performance.now();
      const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
      return new Promise((resolve) => {
        const finish = () => {
          this.edgeActive[e.id]--;
          if (edgeEl && this.edgeActive[e.id] <= 0) { edgeEl.classList.remove('is-active'); edgeEl.style.removeProperty('--ec'); }
          if (limit < 1) {
            g.classList.add('is-fail');
            const circ = g.querySelectorAll('circle');
            circ.forEach((ci) => ci.setAttribute('fill', 'var(--err)'));
            setTimeout(() => g.remove(), MV.reducedMotion ? 0 : 420);
            this.pulse(reverse ? e.from : e.to, 'err');
          } else {
            g.remove();
            this.pulse(to, color);
          }
          resolve();
        };
        if (duration <= 0) { finish(); return; }
        const step = (now) => {
          if (this.disposed) { g.remove(); resolve(); return; }
          const p = this.endpoints(e);
          const raw = Math.min(1, (now - start) / (duration * limit));
          const tt = ease(raw) * limit;
          const f = reverse ? 1 - tt : tt;
          if (p) g.setAttribute('transform', `translate(${p.x1 + (p.x2 - p.x1) * f},${p.y1 + (p.y2 - p.y1) * f})`);
          if (raw < 1) requestAnimationFrame(step); else finish();
        };
        requestAnimationFrame(step);
      });
    }

    edgeFlash(from, to) {
      const e = this.edgeBetween(from, to);
      const el = e && $(`[data-edge="${e.id}"]`, this.$edges);
      if (!el) return;
      el.classList.remove('is-flash'); void el.getBBox(); el.classList.add('is-flash');
    }

    /* ---------- lifecycle strip ---------- */
    renderLifecycle() {
      const sc = LAB.scenarios.find((s) => s.id === this.scenario);
      const stages = LIFECYCLE[this.scenario];
      $('#lab-lifecycle', this.view).innerHTML = `<div class="lc-desc"><span class="lc-method mono" data-m="${sc.method}">${sc.method}</span><span class="mono lc-path">${esc(sc.path)}</span><span class="lc-text">${esc(sc.desc)}</span><span class="lc-clock mono tabular" id="lab-clock"></span></div>
        <ol class="lc-stages">${stages.map(([id, label], i) => `<li class="lc-stage" data-stage="${id}" data-state="idle">${i ? `<span class="lc-sep">${icon('chevron-right', '', 12)}</span>` : ''}<span class="lc-chip"><span class="lc-ico"></span>${esc(label)}</span></li>`).join('')}</ol>`;
    }

    stage(run, id, state) {
      if (run !== this.focusRun) return;
      const el = $(`.lc-stage[data-stage="${id}"]`, this.view);
      if (!el) return;
      el.dataset.state = state;
      const ico = $('.lc-ico', el);
      ico.innerHTML = state === 'ok' ? icon('check', '', 12) : state === 'fail' ? icon('x', '', 12) : state === 'warn' ? icon('triangle-alert', '', 11) : state === 'skip' ? icon('minus', '', 12) : state === 'active' ? '<span class="spinner" style="width:10px;height:10px;border-width:1.5px"></span>' : '';
    }

    beginRun(run) {
      this.running++;
      if (!this.focusRun || !this.focusRun.active) {
        this.focusRun = run;
        run.active = true;
        $$('.lc-stage', this.view).forEach((el) => { el.dataset.state = 'idle'; $('.lc-ico', el).innerHTML = ''; });
      }
      this.syncButtons();
      this.tickClock(run);
    }
    tickClock(run) {
      const clock = $('#lab-clock', this.view);
      const loop = () => {
        if (this.disposed || run !== this.focusRun) return;
        if (clock) clock.textContent = `t = ${run.t >= 1000 ? (run.t / 1000).toFixed(2) + ' s' : Math.round(run.t) + ' ms'}`;
        if (run.active) requestAnimationFrame(loop);
      };
      loop();
    }
    endRun(run) {
      run.active = false;
      this.running--;
      if (this.disposed) return;
      const clock = $('#lab-clock', this.view);
      if (clock && run === this.focusRun) clock.textContent = `${typeof run.result.status === 'number' ? run.result.status : 'timeout'} in ${run.t >= 1000 ? (run.t / 1000).toFixed(2) + ' s' : Math.round(run.t) + ' ms'}`;
      if (!run.batch) this.showAnalysis([run]);
      this.syncButtons();
      MV.store.update((s) => {
        s.lab.runs = (s.lab.runs || 0) + 1;
        world.failures.forEach((f) => { s.lab.failuresSeen[f] = true; });
      }, 'lab');
    }

    syncButtons() {
      const runBtn = $('#lab-run', this.view), burstBtn = $('#lab-burst', this.view);
      if (!runBtn) return;
      const busy = this.running > 0;
      runBtn.disabled = busy; burstBtn.disabled = busy;
      runBtn.innerHTML = busy ? `<span class="spinner"></span><span>Running…</span>` : `${icon('play')}<span>Simulate Request</span>`;
      $('.lab-stage', this.view).classList.toggle('is-running', busy);
    }

    /* ---------- event log ---------- */
    log(e) {
      if (this.disposed) return;
      const ts = new Date(e.run.wallStart + e.t);
      const time = ts.toTimeString().slice(0, 8) + '.' + String(ts.getMilliseconds()).padStart(3, '0');
      const entry = { ...e, time, run: undefined, n: e.run.n };
      this.logs.push(entry);
      if (this.logs.length > 500) this.logs.shift();
      const empty = $('.lab-log-empty', this.$log);
      if (empty) empty.remove();
      if (this.logFilter === 'errors' && !['error', 'warn'].includes(entry.level)) { this.updateLogCount(); return; }
      this.$log.insertAdjacentHTML('beforeend', this.logRow(entry));
      while (this.$log.children.length > 500) this.$log.firstElementChild.remove();
      this.$log.scrollTop = this.$log.scrollHeight;
      this.updateLogCount();
    }
    updateLogCount() { const c = $('#log-count', this.view); if (c) c.textContent = this.logs.length; }
    logRow(e) {
      const st = e.status;
      const cls = typeof st === 'number' ? (st >= 500 ? 'err' : st >= 400 ? 'warn' : 'ok') : st === 'ERR' ? 'err' : st === 'OK' ? 'ok' : '';
      const route = e.dst ? `${esc(NAMES[e.src] || e.src)} <span class="text-mutedc">→</span> ${esc(NAMES[e.dst] || e.dst)}` : esc(NAMES[e.src] || e.src);
      const lat = e.latency !== undefined ? (e.latency >= 1000 ? (e.latency / 1000).toFixed(2) + 's' : (e.latency < 1 ? e.latency.toFixed(1) : Math.round(e.latency)) + 'ms') : '';
      return `<div class="log-row is-${e.level}${e.async ? ' is-async' : ''}">
        <div class="log-l1"><span class="log-time mono">${e.time}</span><span class="log-rid mono" title="Request #${e.n}">#${e.n}</span><span class="log-route">${route}</span>
          ${e.method ? `<span class="log-method mono">${esc(e.method)}</span>` : ''}${st !== undefined ? `<span class="log-status mono is-${cls}">${esc(st)}</span>` : ''}<span class="log-lat mono">${lat}</span></div>
        ${e.desc ? `<div class="log-desc">${e.async ? '<span class="log-async">async</span>' : ''}${esc(e.desc)}</div>` : ''}</div>`;
    }
    redrawLog() {
      const rows = this.logs.filter((e) => this.logFilter === 'all' || ['error', 'warn'].includes(e.level));
      this.$log.innerHTML = rows.length ? rows.map((e) => this.logRow(e)).join('') : `<div class="lab-log-empty">${icon('radio')}<div><strong>${this.logs.length ? 'No issues logged' : 'No events yet'}</strong><br>${this.logs.length ? 'Errors and warnings will appear here.' : 'Press <span class="kbd">Space</span> or <em>Simulate Request</em>.'}</div></div>`;
      this.$log.scrollTop = this.$log.scrollHeight;
      this.updateLogCount();
    }

    /* ---------- analysis ---------- */
    showAnalysis(runs) {
      if (this.disposed) return;
      const el = $('#lab-analysis', this.view);
      const all = new Map();
      runs.forEach((r) => r.insights.forEach((v, k) => { if (!all.has(k)) all.set(k, v); }));
      const list = [...all.values()].sort((a, b) => SEVERITY[a.level] - SEVERITY[b.level]);
      const single = runs.length === 1 ? runs[0] : null;
      let head;
      if (single) {
        const st = single.result.status;
        const ok = typeof st === 'number' && st < 400;
        const lat = single.t >= 1000 ? (single.t / 1000).toFixed(2) + ' s' : Math.round(single.t) + ' ms';
        head = `<span class="an-status ${ok ? 'is-ok' : st === 429 ? 'is-warn' : 'is-err'}">${icon(ok ? 'circle-check' : 'circle-x')}${typeof st === 'number' ? `${st} ${STATUS_TEXT[st] || ''}` : 'Client timeout'}</span><span class="text-fg2 text-[12.5px]">${esc(single.sc.method)} ${esc(single.sc.path)} · ${lat} client-perceived</span>`;
        if (!list.length) {
          list.push(ok ? {
            level: 'success', title: 'Healthy request path',
            what: has('slow-network') ? 'The request succeeded, but slow network hops dominated its latency.' : `Every hop succeeded. Watch the event log: ${single.sc.id === 'create-order' ? 'rate limit check, local JWT verification, the synchronous user check, one database transaction, then the outbox relay publishing asynchronously after the client already had its 201' : 'rate limit check, JWT verification, routing, data access and the response'}.`,
            why: 'Nothing is failing. This is the baseline to compare against when you inject faults.',
            fix: 'Switch on a failure (try “User Service unavailable” or “Message broker unavailable”), run the same request, and compare the log and this analysis.',
            lesson: 'm03/oms-overview',
          } : { level: 'info', title: 'Request rejected', what: 'See the event log for the reason.', why: '', fix: '' });
        }
        if (has('slow-network') && !all.has('slow-network')) list.push({
          level: 'info', title: 'Slow network inflated every hop',
          what: `Each network hop added ~250 ms; this request made many hops, so latency reached ${lat}.`,
          why: 'Chatty call chains multiply network latency. Timeouts that were comfortable on a fast network start firing.',
          fix: 'Reduce hops (cache, batch, denormalise), keep timeout budgets realistic, and colocate chatty services.',
          lesson: 'm01/distributed-fundamentals',
        });
      } else {
        const counts = {};
        runs.forEach((r) => { const s = typeof r.result.status === 'number' ? r.result.status : 'timeout'; counts[s] = (counts[s] || 0) + 1; });
        head = `<span class="an-status ${Object.keys(counts).every((k) => +k < 400) ? 'is-ok' : 'is-err'}">${icon('repeat')}${runs.length} requests</span><span class="flex flex-wrap gap-1.5">${Object.entries(counts).map(([s, c]) => `<span class="badge badge-square ${+s < 400 ? 'badge-green' : +s === 429 ? 'badge-warn' : 'badge-err'}">${c}× ${s}</span>`).join('')}</span>`;
        if (!list.length) list.push({ level: 'success', title: 'All requests succeeded', what: 'No failures were injected, so every request took the healthy path.', why: '', fix: 'Turn on “HTTP 500 from Order Service” or “User Service unavailable” and send 10× again to watch the circuit breaker open.', lesson: 'm07/pattern-circuit-breaker' });
      }
      el.innerHTML = `<div class="an-head"><div class="flex flex-wrap items-center gap-2.5 min-w-0">${head}</div>
          <button class="btn btn-ghost btn-icon btn-sm" type="button" data-an-close aria-label="Close analysis">${icon('x')}</button></div>
        <div class="an-body scroll-thin" data-lenis-prevent>${list.map((i) => `<div class="an-item is-${i.level}">
          <div class="an-title">${icon(SEV_ICON[i.level])}<span>${esc(i.title)}</span></div>
          ${i.what ? `<div class="an-row"><span>What happened</span><p>${inlineMd(i.what)}</p></div>` : ''}
          ${i.why ? `<div class="an-row"><span>Why</span><p>${inlineMd(i.why)}</p></div>` : ''}
          ${i.fix ? `<div class="an-row"><span>How to fix</span><p>${inlineMd(i.fix)}</p></div>` : ''}
          ${i.lesson && MV.catalog.lesson(i.lesson) ? `<a class="an-learn" href="${MV.catalog.lesson(i.lesson).route}">${icon('book-open', '', 13)}${esc(MV.catalog.lesson(i.lesson).title)}${icon('arrow-right', '', 13)}</a>` : ''}
        </div>`).join('')}</div>`;
      el.hidden = false;
      if (window.Motion && !MV.reducedMotion) Motion.animate(el, { opacity: [0, 1], transform: ['translateY(10px)', 'none'] }, { type: 'spring', bounce: 0.2, duration: 0.45 });
      $('[data-an-close]', el).addEventListener('click', () => { el.hidden = true; });
    }

    /* ---------- running ---------- */
    async runOnce() {
      if (this.running) return;
      $('#lab-analysis', this.view).hidden = true;
      const sc = LAB.scenarios.find((s) => s.id === this.scenario);
      const run = new Run(this, sc);
      try { await run.exec(); } catch (e) { if (!this.disposed) console.error(e); }
    }

    async runBurst() {
      if (this.running) return;
      $('#lab-analysis', this.view).hidden = true;
      const sc = LAB.scenarios.find((s) => s.id === this.scenario);
      this.running++;
      this.syncButtons();
      const runs = [];
      const promises = [];
      for (let i = 0; i < 10; i++) {
        if (this.disposed) break;
        const r = new Run(this, sc, { fast: true });
        r.batch = true;
        runs.push(r);
        promises.push(r.exec().catch((e) => { if (!this.disposed) console.error(e); }));
        await MV.sleep(250 / world.speed);
      }
      await Promise.all(promises);
      this.running--;
      this.syncButtons();
      if (!this.disposed) this.showAnalysis(runs);
    }

    /* ---------- view transform ---------- */
    applyView() {
      const v = this.view$;
      this.$world.style.transform = `translate(${v.x}px, ${v.y}px) scale(${v.k})`;
    }
    fit() {
      const ids = Object.keys(this.geom);
      if (!ids.length) return;
      const r = this.$canvas.getBoundingClientRect();
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      ids.forEach((id) => { const g = this.geom[id]; minX = Math.min(minX, g.x); minY = Math.min(minY, g.y); maxX = Math.max(maxX, g.x + g.w); maxY = Math.max(maxY, g.y + g.h); });
      const pad = 36;
      const bottomReserve = 64;
      const k = Math.max(0.3, Math.min(1.25, Math.min((r.width - pad * 2) / (maxX - minX), (r.height - pad * 2 - bottomReserve) / (maxY - minY))));
      this.view$ = { k, x: (r.width - (maxX - minX) * k) / 2 - minX * k, y: (r.height - bottomReserve - (maxY - minY) * k) / 2 - minY * k };
      this.applyView();
    }
    zoom(factor, cx, cy) {
      const r = this.$canvas.getBoundingClientRect();
      const px = cx === undefined ? r.width / 2 : cx, py = cy === undefined ? r.height / 2 : cy;
      const v = this.view$;
      const k = Math.max(0.3, Math.min(2.2, v.k * factor));
      v.x = px - (px - v.x) * (k / v.k);
      v.y = py - (py - v.y) * (k / v.k);
      v.k = k;
      this.applyView();
    }

    saveLayout() {
      MV.store.update((s) => { s.lab.layout = JSON.parse(JSON.stringify(this.layout)); }, 'lab-layout');
    }

    /* ---------- inspector ---------- */
    inspect(id) {
      const n = LAB.nodes.find((x) => x.id === id);
      if (!n) return;
      $$('.lab-node', this.$world).forEach((el) => el.classList.toggle('is-selected', el.dataset.node === id));
      const el = $('#lab-inspector', this.view);
      const st = this.nodeStatus(id);
      const m = world.metrics[id];
      const conns = LAB.edges.filter((e) => e.from === id || e.to === id).map((e) => (e.from === id ? { dir: 'out', other: e.to, label: e.label } : { dir: 'in', other: e.from, label: e.label }));
      el.innerHTML = `<div class="insp-head">
          <span class="icon-tile" style="--c:var(--k-${n.kind})">${icon(KIND_ICON[n.kind] || 'server')}</span>
          <div class="min-w-0 flex-1"><div class="font-semibold" style="color:var(--fg)">${esc(n.name)}</div><div class="text-[12px] text-mutedc truncate">${esc(n.tech)}</div></div>
          <span class="badge ${st.s === 'healthy' ? 'badge-green' : st.s === 'down' ? 'badge-err' : 'badge-warn'}"><span class="dot"></span>${st.label}</span>
          <button class="btn btn-ghost btn-icon btn-sm" type="button" data-insp-close aria-label="Close inspector">${icon('x')}</button></div>
        <div class="tabs px-3" role="tablist">${['Overview', 'APIs', 'Data', 'Code', 'Failures'].map((t, i) => `<button class="tab" role="tab" type="button" data-itab="${t}" aria-selected="${i === 0}">${t}</button>`).join('')}</div>
        <div class="insp-body scroll-thin" data-lenis-prevent>
          <div data-ipanel="Overview">
            <p class="text-[13.5px] text-fg2 leading-relaxed">${esc(n.purpose)}</p>
            <div class="insp-kv"><span>Responsibility</span><p>${esc(n.responsibility)}</p></div>
            ${m ? `<div class="insp-kv"><span>This session</span><p class="mono">${m.req} requests · ${m.err} errors</p></div>` : ''}
            <div class="insp-kv"><span>Connected services</span><div class="grid gap-1.5 mt-1">${conns.map((c) => `<button type="button" class="mini-link" data-goto="${c.other}">${icon(c.dir === 'out' ? 'arrow-up-right' : 'arrow-down-left', '', 14)}<span class="flex-1 text-left">${esc(NAMES[c.other])}</span><span class="text-[11px] text-mutedc mono">${esc(c.label)}</span></button>`).join('')}</div></div>
            <div class="insp-kv"><span>Request flow</span><ol class="insp-flow">${n.flow.map((f) => `<li>${esc(f)}</li>`).join('')}</ol></div>
          </div>
          <div data-ipanel="APIs" hidden>${n.apis.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Method</th><th>Path</th><th>Notes</th></tr></thead><tbody>${n.apis.map((a) => `<tr><td><span class="lc-method mono" data-m="${a.method}">${a.method}</span></td><td><code>${esc(a.path)}</code></td><td>${esc(a.desc)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="text-[13px] text-mutedc">The client exposes no API — it consumes the gateway.</p>'}</div>
          <div data-ipanel="Data" hidden><div class="insp-kv"><span>Data ownership</span><p>${esc(n.database)}</p></div>
            <div class="insp-kv"><span>Dependencies</span><p>${n.dependencies.length ? n.dependencies.map((d) => esc(NAMES[d])).join(', ') : 'None'}</p></div></div>
          <div data-ipanel="Code" hidden><div class="text-[12.5px] text-mutedc mb-2">${n.code.note ? esc(n.code.note) + ' ' : ''}Excerpt from <code>${esc(n.code.file)}</code> — real source in this repository, shown statically (not executed).</div><div data-code>${MV.ui.skeleton(5)}</div>
            <a class="btn btn-sm mt-3" href="#/playground?file=${encodeURIComponent(n.code.file)}">${icon('square-terminal')}Open in Code Playground</a></div>
          <div data-ipanel="Failures" hidden><div class="grid gap-3">${n.failures.map((f) => `<div class="well"><div class="font-semibold text-[13.5px] flex items-center gap-2" style="color:var(--fg)">${icon('triangle-alert', '', 14)}${esc(f.title)}</div><p class="text-[13px] text-fg2 mt-1"><strong style="color:var(--fg)">Impact:</strong> ${esc(f.impact)}</p><p class="text-[13px] text-fg2 mt-1"><strong style="color:var(--fg)">Mitigation:</strong> ${esc(f.mitigation)}</p></div>`).join('')}</div>
            ${LAB.failures.filter((f) => f.node === id).map((f) => `<button class="btn btn-sm mt-3 ${world.failures.has(f.id) ? 'btn-success' : 'btn-danger'}" type="button" data-insp-fail="${f.id}">${icon(world.failures.has(f.id) ? 'heart-pulse' : 'zap')}${world.failures.has(f.id) ? 'Recover: ' : 'Inject: '}${esc(f.label)}</button>`).join(' ')}</div>
        </div>`;
      el.hidden = false;
      if (window.Motion && !MV.reducedMotion) Motion.animate(el, { opacity: [0, 1], transform: ['translateX(16px)', 'none'] }, { type: 'spring', bounce: 0.15, duration: 0.4 });
      el.querySelector('[data-insp-close]').addEventListener('click', () => this.closeInspector());
      el.addEventListener('click', (ev) => {
        const tab = ev.target.closest('[data-itab]');
        if (tab) {
          $$('[data-itab]', el).forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
          $$('[data-ipanel]', el).forEach((p) => { p.hidden = p.dataset.ipanel !== tab.dataset.itab; });
          if (tab.dataset.itab === 'Code') this.loadCode(n, el);
        }
        const g = ev.target.closest('[data-goto]');
        if (g) this.inspect(g.dataset.goto);
        const f = ev.target.closest('[data-insp-fail]');
        if (f) {
          const fid = f.dataset.inspFail;
          this.setFailure(fid, !world.failures.has(fid));
          this.inspect(id);
          $$('[data-itab]', $('#lab-inspector', this.view)).forEach((t) => { if (t.dataset.itab === 'Failures') t.click(); });
        }
      });
    }
    async loadCode(n, el) {
      const box = $('[data-code]', el);
      if (!box || box.dataset.loaded) return;
      box.dataset.loaded = '1';
      try {
        const text = await MV.ui.fetchText(MV.playground.codePath(n.code.file));
        const lines = text.split('\n');
        let start = lines.findIndex((l) => l.includes(n.code.from));
        if (start < 0) start = 0;
        const excerpt = lines.slice(start, start + (n.code.lines || 30)).join('\n');
        box.innerHTML = MV.ui.codeBlock(excerpt, { lang: n.code.lang || 'go', title: n.code.file, startLine: start + 1, maxHeight: '380px' });
      } catch (err) {
        box.innerHTML = MV.ui.loadError(err);
      }
    }
    closeInspector() {
      const el = $('#lab-inspector', this.view);
      el.hidden = true;
      $$('.lab-node', this.$world).forEach((n) => n.classList.remove('is-selected'));
    }

    setFailure(id, value) {
      if (value) world.failures.add(id); else world.failures.delete(id);
      const cb = $(`[data-failure="${id}"]`, this.view);
      if (cb) cb.setAttribute('aria-pressed', String(value));
      this.refreshStatuses();
      saveConfig();
    }

    /* ---------- events ---------- */
    bind() {
      const v = this.view;
      $('#lab-scenario', v).addEventListener('change', (e) => { this.scenario = e.target.value; this.renderLifecycle(); });
      $('#lab-run', v).addEventListener('click', () => this.runOnce());
      $('#lab-burst', v).addEventListener('click', () => this.runBurst());
      $$('[data-speed]', v).forEach((b) => b.addEventListener('click', () => {
        world.speed = +b.dataset.speed;
        $$('[data-speed]', v).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        saveConfig();
      }));
      $('[data-zoom="in"]', v).addEventListener('click', () => this.zoom(1.2));
      $('[data-zoom="out"]', v).addEventListener('click', () => this.zoom(1 / 1.2));
      $('[data-fit]', v).addEventListener('click', () => this.fit());
      $('[data-reset-layout]', v).addEventListener('click', () => {
        LAB.nodes.forEach((n) => { this.layout[n.id] = { x: n.x, y: n.y }; });
        this.applyNodeLayout(); this.measure(); this.renderEdges(); this.fit(); this.saveLayout();
        toast('Layout reset', { type: 'info', duration: 1500 });
      });
      $$('[data-failure]', v).forEach((b) => b.addEventListener('click', () => {
        const value = b.getAttribute('aria-pressed') !== 'true';
        this.setFailure(b.dataset.failure, value);
        const f = LAB.failures.find((x) => x.id === b.dataset.failure);
        toast(value ? `Injected: ${f.label}` : `Recovered: ${f.label}`, { type: value ? 'warn' : 'success', duration: 1800 });
      }));
      $('#fail-clear', v).addEventListener('click', (e) => {
        e.preventDefault();
        [...world.failures].forEach((f) => this.setFailure(f, false));
      });
      $$('[data-resilience]', v).forEach((b) => b.addEventListener('click', () => {
        const value = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(value));
        if (value) world.resilience.add(b.dataset.resilience); else world.resilience.delete(b.dataset.resilience);
        if (b.dataset.resilience === 'breaker') Object.keys(world.breakers).forEach((k) => this.renderBreaker(k));
        saveConfig();
      }));
      $$('[data-logf]', v).forEach((b) => b.addEventListener('click', () => {
        this.logFilter = b.dataset.logf;
        $$('[data-logf]', v).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        this.redrawLog();
      }));
      $('#log-clear', v).addEventListener('click', () => { this.logs = []; this.redrawLog(); });
      $('#log-copy', v).addEventListener('click', async () => {
        const ok = await MV.ui.copyText(JSON.stringify(this.logs.map(({ time, n, src, dst, method, path, status, latency, desc, level }) => ({ time, request: n, src, dst, method, path, status, latency_ms: latency, desc, level, simulated: true })), null, 2));
        toast(ok ? 'Log copied as JSON' : 'Copy failed', { type: ok ? 'success' : 'error', duration: 1600 });
      });

      // Canvas: pan, zoom, drag nodes
      const canvas = this.$canvas;
      let drag = null;
      canvas.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        const nodeEl = e.target.closest('.lab-node');
        canvas.setPointerCapture(e.pointerId);
        if (nodeEl) {
          const id = nodeEl.dataset.node;
          drag = { type: 'node', id, el: nodeEl, sx: e.clientX, sy: e.clientY, ox: this.layout[id].x, oy: this.layout[id].y, moved: false };
          nodeEl.classList.add('is-dragging');
        } else {
          drag = { type: 'pan', sx: e.clientX, sy: e.clientY, ox: this.view$.x, oy: this.view$.y, moved: false };
          canvas.classList.add('is-panning');
        }
      });
      canvas.addEventListener('pointermove', (e) => {
        if (!drag) return;
        const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
        if (drag.type === 'node') {
          const p = this.layout[drag.id];
          p.x = Math.round(drag.ox + dx / this.view$.k);
          p.y = Math.round(drag.oy + dy / this.view$.k);
          drag.el.style.transform = `translate(${p.x}px, ${p.y}px)`;
          this.geom[drag.id].x = p.x; this.geom[drag.id].y = p.y;
          this.renderEdges();
        } else {
          this.view$.x = drag.ox + dx; this.view$.y = drag.oy + dy;
          this.applyView();
        }
      });
      const end = () => {
        if (!drag) return;
        if (drag.type === 'node') {
          drag.el.classList.remove('is-dragging');
          if (drag.moved) this.saveLayout(); else this.inspect(drag.id);
        } else {
          canvas.classList.remove('is-panning');
          if (!drag.moved) this.closeInspector();
        }
        drag = null;
      };
      canvas.addEventListener('pointerup', end);
      canvas.addEventListener('pointercancel', end);
      canvas.addEventListener('wheel', (e) => {
        e.preventDefault();
        const r = canvas.getBoundingClientRect();
        this.zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
      }, { passive: false });
      canvas.addEventListener('keydown', (e) => {
        const nodeEl = e.target.closest && e.target.closest('.lab-node');
        if (!nodeEl) return;
        const id = nodeEl.dataset.node;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); this.inspect(id); return; }
        const step = e.shiftKey ? 40 : 10;
        const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
        if (d) {
          e.preventDefault();
          const p = this.layout[id];
          p.x += d[0]; p.y += d[1];
          nodeEl.style.transform = `translate(${p.x}px, ${p.y}px)`;
          this.geom[id].x = p.x; this.geom[id].y = p.y;
          this.renderEdges();
          clearTimeout(this.saveT); this.saveT = setTimeout(() => this.saveLayout(), 400);
        }
      });

      this.onResize = () => { clearTimeout(this.resizeT); this.resizeT = setTimeout(() => { if (!this.disposed) this.fit(); }, 150); };
      window.addEventListener('resize', this.onResize);
      this.onKey = (e) => { if (e.key === 'Escape' && !$('#lab-inspector', v).hidden) this.closeInspector(); };
      document.addEventListener('keydown', this.onKey);

      MV.shortcuts.page = {
        ' ': () => this.runOnce(),
        f: () => this.fit(),
      };
    }

    dispose() {
      this.disposed = true;
      this.timers.forEach(clearTimeout);
      window.removeEventListener('resize', this.onResize);
      document.removeEventListener('keydown', this.onKey);
    }
  }

  function render(view, query) {
    const lab = new Lab(view, query || {});
    MV.router.onLeave(() => lab.dispose());
    MV.store.pushRecent({ route: '#/lab', title: 'Architecture Lab', kind: 'Practice' });
  }

  MV.lab = { render, world };
})(window.MV);
