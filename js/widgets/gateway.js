/* ==========================================================================
   Widgets: token-bucket (rate limiting) and gateway-sim (full request
   lifecycle through the API Gateway's middleware pipeline).
   ========================================================================== */
(function (MV) {
  'use strict';
  const { $, $$, esc, icon } = MV.ui;

  /* ======================================================================
     token-bucket
     ====================================================================== */
  MV.widgets['token-bucket'] = function (el) {
    const ui = MV.wkit.frame(el, {
      title: 'Token bucket',
      sub: 'refill r tokens/s up to capacity b; each request takes one',
      ico: 'gauge',
      controls: `<label class="field-inline">Capacity (b) <input type="range" min="1" max="20" value="10" data-cap><span class="mono" data-cap-v>10</span></label>
        <label class="field-inline">Refill (r/s) <input type="range" min="1" max="10" value="2" data-rate><span class="mono" data-rate-v>2</span></label>
        <button class="btn btn-sm btn-primary" type="button" data-one>${icon('send')}1 request</button>
        <button class="btn btn-sm" type="button" data-burst>${icon('zap')}Burst of 15</button>
        <label class="switch"><input type="checkbox" data-steady><span class="switch-track"></span>Steady 5 req/s</label>`,
    });
    ui.body.innerHTML = `<div class="tb-wrap">
        <div><div class="tb-bucket" data-bucket aria-label="Tokens in the bucket"></div><div class="text-center mono text-[12px] mt-2" data-level></div></div>
        <div class="grid gap-3 content-start">
          <div class="wg-stats">
            <div class="wg-stat"><div class="wg-stat-label">Allowed</div><div class="wg-stat-value is-ok" data-ok>0</div></div>
            <div class="wg-stat"><div class="wg-stat-label">Rejected (429)</div><div class="wg-stat-value is-err" data-rej>0</div></div>
            <div class="wg-stat"><div class="wg-stat-label">Long-run max</div><div class="wg-stat-value" data-max>2/s</div></div>
          </div>
          <div class="wg-panel"><div class="wg-panel-title">Last requests</div><div class="tb-strip" data-strip></div></div>
          <div class="wg-note" data-note>Capacity sets the largest burst you allow; the refill rate sets the sustained throughput. A client can send <strong>b</strong> requests at once, then <strong>r</strong> per second forever.</div>
        </div>
      </div>`;
    const T = MV.wkit.timers();
    let tokens = 10, ok = 0, rej = 0, last = performance.now(), steadyAcc = 0;
    const strip = [];
    const cap = () => +$('[data-cap]', el).value;
    const rate = () => +$('[data-rate]', el).value;
    function refill() {
      const now = performance.now();
      tokens = Math.min(cap(), tokens + ((now - last) / 1000) * rate());
      last = now;
    }
    function request() {
      refill();
      const allowed = tokens >= 1;
      if (allowed) { tokens -= 1; ok++; } else rej++;
      strip.push(allowed);
      if (strip.length > 60) strip.shift();
      if (!allowed) {
        const wait = Math.ceil((1 - tokens) / rate() * 10) / 10;
        $('[data-note]', ui.body).innerHTML = `<strong>429 Too Many Requests</strong> · <code>Retry-After: ${Math.max(1, Math.ceil(wait))}</code> — the bucket is empty; the next token arrives in ${wait.toFixed(1)} s.`;
        $('[data-note]', ui.body).className = 'wg-note is-err';
      } else {
        $('[data-note]', ui.body).innerHTML = `<strong>200</strong> · <code>RateLimit-Remaining: ${Math.floor(tokens)}</code>`;
        $('[data-note]', ui.body).className = 'wg-note is-ok';
      }
      draw();
    }
    function draw() {
      const c = cap();
      const full = Math.floor(tokens);
      const frac = tokens - full;
      $('[data-bucket]', ui.body).innerHTML = Array.from({ length: full }, () => '<span class="tb-token"></span>').join('') + (frac > 0.05 && full < c ? '<span class="tb-token is-partial"></span>' : '');
      $('[data-level]', ui.body).textContent = `${tokens.toFixed(1)} / ${c} tokens`;
      $('[data-ok]', ui.body).textContent = ok;
      $('[data-rej]', ui.body).textContent = rej;
      $('[data-max]', ui.body).textContent = `${rate()}/s`;
      $('[data-strip]', ui.body).innerHTML = strip.map((a) => `<span class="tb-req ${a ? 'is-ok' : 'is-rej'}"></span>`).join('');
    }
    T.interval(() => {
      refill();
      if ($('[data-steady]', el).checked) {
        steadyAcc += 0.1 * 5;
        while (steadyAcc >= 1) { steadyAcc -= 1; request(); }
      }
      draw();
    }, 100);
    $('[data-cap]', el).addEventListener('input', (e) => { $('[data-cap-v]', el).textContent = e.target.value; tokens = Math.min(tokens, cap()); draw(); });
    $('[data-rate]', el).addEventListener('input', (e) => { $('[data-rate-v]', el).textContent = e.target.value; draw(); });
    $('[data-one]', el).addEventListener('click', request);
    $('[data-burst]', el).addEventListener('click', () => { for (let i = 0; i < 15; i++) request(); });
    draw();
    return () => T.clear();
  };

  /* ======================================================================
     gateway-sim
     ====================================================================== */
  const ROUTES = [
    { prefix: '/api/v1/auth', upstream: 'user-service:8081', public: true, timeout: '3s' },
    { prefix: '/api/v1/users', upstream: 'user-service:8081', publicCalls: ['POST /api/v1/users'], timeout: '2s' },
    { prefix: '/api/v1/orders', upstream: 'order-service:8082', timeout: '2s' },
  ];
  const ENDPOINTS = [
    { m: 'POST', p: '/api/v1/auth/login', label: 'Log in' },
    { m: 'POST', p: '/api/v1/users', label: 'Register' },
    { m: 'GET', p: '/api/v1/users/me', label: 'My profile' },
    { m: 'POST', p: '/api/v1/orders', label: 'Create order' },
    { m: 'GET', p: '/api/v1/orders/8812', label: 'Get order' },
    { m: 'PATCH', p: '/api/v1/orders/8812/status', label: 'Set status (admin)' },
    { m: 'GET', p: '/api/v1/payments/31', label: 'Unknown route' },
  ];
  const TOKENS = {
    customer: { label: 'Valid token (customer, sub=42)', sub: '42', role: 'customer' },
    admin: { label: 'Valid token (admin, sub=7)', sub: '7', role: 'admin' },
    expired: { label: 'Expired token', err: 'token expired' },
    tampered: { label: 'Tampered signature', err: 'token invalid' },
    none: { label: 'No Authorization header', err: 'missing bearer token' },
  };
  const STAGES = [
    ['rid', 'Request ID', 'fingerprint'],
    ['body', 'Body size limit', 'scale'],
    ['route', 'Route match', 'route'],
    ['auth', 'JWT authentication', 'shield-check'],
    ['rate', 'Rate limit', 'gauge'],
    ['breaker', 'Circuit breaker', 'toggle-right'],
    ['proxy', 'Reverse proxy', 'arrow-right-left'],
    ['upstream', 'Upstream service', 'server'],
    ['resp', 'Response', 'corner-down-left'],
  ];

  MV.widgets['gateway-sim'] = function (el) {
    const ui = MV.wkit.frame(el, {
      title: 'API Gateway request lifecycle',
      sub: 'The same pipeline as api-gateway/cmd/gateway/main.go',
      ico: 'door-open',
      controls: `<label class="field-inline">Endpoint <select class="select mono" data-ep>${ENDPOINTS.map((e, i) => `<option value="${i}">${e.m} ${e.p}</option>`).join('')}</select></label>
        <label class="field-inline">Token <select class="select" data-tok>${Object.entries(TOKENS).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join('')}</select></label>
        <label class="field-inline" data-body-wrap>Body <select class="select" data-body><option value="ok">valid JSON</option><option value="bad">invalid (no items)</option><option value="huge">2 MB payload</option></select></label>
        <label class="switch is-danger"><input type="checkbox" data-down><span class="switch-track"></span>Order Service down</label>
        <button class="btn btn-sm btn-primary" type="button" data-send>${icon('send')}Send</button>
        <button class="btn btn-sm" type="button" data-burst>${icon('zap')}Send 25 fast</button>`,
    });
    ui.body.innerHTML = `<div class="wg-grid">
        <div class="gs-stages" data-stages>${STAGES.map(([id, name, ic]) => `<div class="gs-stage" data-stage="${id}" data-state="idle"><span class="gs-ico">${icon(ic)}</span><div class="min-w-0"><div class="gs-stage-name">${name}</div><div class="gs-stage-detail" data-d></div></div><span data-t class="mono text-[11px] text-mutedc"></span></div>`).join('')}</div>
        <div class="grid gap-3 content-start">
          <div class="wg-stats">
            <div class="wg-stat"><div class="wg-stat-label">Status</div><div class="wg-stat-value" data-status>—</div></div>
            <div class="wg-stat"><div class="wg-stat-label">Tokens left</div><div class="wg-stat-value" data-tokens>20</div></div>
            <div class="wg-stat"><div class="wg-stat-label">order-service breaker</div><div class="wg-stat-value" data-cb>closed</div></div>
          </div>
          <div class="tabs" role="tablist"><button class="tab" role="tab" type="button" data-itab="up" aria-selected="true">Upstream request</button><button class="tab" role="tab" type="button" data-itab="res" aria-selected="false">Response</button><button class="tab" role="tab" type="button" data-itab="routes" aria-selected="false">Route table</button></div>
          <div data-ipanel="up" class="gs-headers"><span class="text-mutedc">Send a request to see what the gateway forwards upstream.</span></div>
          <div data-ipanel="res" hidden></div>
          <div data-ipanel="routes" hidden></div>
        </div>
      </div>`;

    const T = MV.wkit.timers();
    let alive = true, busy = false;
    let tokens = 20, lastRefill = performance.now();
    const cb = { state: 'closed', fails: 0, openedAt: 0 };
    const CAP = 20, RATE = 5, THRESH = 5, COOLDOWN = 15000;

    const setStage = (id, state, detail, t) => {
      const s = $(`[data-stage="${id}"]`, ui.body);
      s.dataset.state = state;
      if (detail !== undefined) $('[data-d]', s).innerHTML = MV.ui.inlineMd(detail);
      $('[data-t]', s).textContent = t || '';
    };
    const resetStages = () => STAGES.forEach(([id]) => setStage(id, 'idle', '', ''));
    const refill = () => { const now = performance.now(); tokens = Math.min(CAP, tokens + ((now - lastRefill) / 1000) * RATE); lastRefill = now; };
    const cbState = () => { if (cb.state === 'open' && Date.now() - cb.openedAt >= COOLDOWN) cb.state = 'half-open'; return cb.state; };

    function renderRoutes(match) {
      $('[data-ipanel="routes"]', ui.body).innerHTML = `<div class="table-wrap"><table class="table"><thead><tr><th>Prefix</th><th>Upstream</th><th>Auth</th><th>Timeout</th></tr></thead><tbody>
        ${ROUTES.map((r) => `<tr style="${match === r ? 'background:color-mix(in srgb,var(--blue) 10%,transparent)' : ''}"><td><code>${r.prefix}</code></td><td><code>${r.upstream}</code></td><td>${r.public ? 'public' : r.publicCalls ? 'JWT (POST public)' : 'JWT'}</td><td>${r.timeout}</td></tr>`).join('')}</tbody></table></div>
        <p class="text-[12px] text-mutedc mt-2">Longest prefix wins. <code>/api</code> is stripped before forwarding.</p>`;
    }

    /** Pure evaluation of the pipeline: returns the per-stage outcome list and response. */
    function evaluate(ep, tokKey, body, down, consumeToken = true) {
      const steps = [];
      const rid = Math.random().toString(16).slice(2, 10) + '-' + Math.random().toString(16).slice(2, 6);
      const tok = TOKENS[tokKey];
      const add = (id, state, detail, t) => steps.push({ id, state, detail, t });
      const respond = (status, title, extra = {}) => ({ steps, status, title, rid, ...extra });
      add('rid', 'ok', `generated \`X-Request-ID: ${rid}\``, '0.01ms');
      if (body === 'huge' && ep.m !== 'GET') { add('body', 'fail', '2 MB > 1 MB limit — `http.MaxBytesReader` rejects it'); return respond(413, 'Payload Too Large'); }
      add('body', 'ok', ep.m === 'GET' ? 'no body' : 'within 1 MB limit');
      const route = ROUTES.filter((r) => ep.p === r.prefix || ep.p.startsWith(r.prefix + '/')).sort((a, b) => b.prefix.length - a.prefix.length)[0];
      if (!route) { add('route', 'fail', `no route matches \`${ep.p}\` → 404 before any auth work`); return respond(404, 'Not Found', { route: null }); }
      add('route', 'ok', `\`${route.prefix}\` → \`${route.upstream}\``, '0.01ms');
      const isPublic = route.public || (route.publicCalls || []).includes(`${ep.m} ${ep.p}`);
      if (isPublic) add('auth', 'skip', 'public route — no token required');
      else if (tok.err) { add('auth', 'fail', `${tok.err} → \`WWW-Authenticate: Bearer error="invalid_${tokKey === 'none' ? 'request' : 'token'}"\``); return respond(401, 'Unauthorized', { route, wwwAuth: true, detail: tok.err }); }
      else add('auth', 'ok', `HS256 signature, \`exp\`, \`iss\`, \`aud\` valid · sub=${tok.sub} role=${tok.role}`, '0.04ms');
      if (consumeToken) {
        refill();
        if (tokens < 1) { add('rate', 'fail', `bucket \`ratelimit:${isPublic ? 'ip:203.0.113.9' : 'user:' + tok.sub}\` is empty`); return respond(429, 'Too Many Requests', { route, retryAfter: 1 }); }
        tokens -= 1;
      }
      add('rate', 'ok', `token taken · ${Math.floor(tokens)}/${CAP} left`, '0.4ms');
      const isOrders = route.upstream.startsWith('order');
      const st = isOrders ? cbState() : 'closed';
      if (isOrders && st === 'open') {
        const wait = Math.ceil((COOLDOWN - (Date.now() - cb.openedAt)) / 1000);
        add('breaker', 'fail', `circuit OPEN for order-service — failing fast (half-open in ${wait}s)`);
        return respond(503, 'Service Unavailable', { route, retryAfter: wait, fast: true });
      }
      add('breaker', 'ok', isOrders && st === 'half-open' ? 'HALF-OPEN — this request is the probe' : 'closed');
      const upPath = ep.p.replace('/api', '');
      add('proxy', 'ok', `${ep.m} \`http://${route.upstream}${upPath}\` · timeout ${route.timeout}`);
      // Upstream behaviour
      if (isOrders && down) {
        add('upstream', 'fail', '`dial tcp order-service:8082: connect: connection refused`');
        return respond(502, 'Bad Gateway', { route, upPath, upstreamFailed: true });
      }
      const svcName = route.upstream.split(':')[0];
      if (ep.p.endsWith('/status') && tok.role !== 'admin') { add('upstream', 'fail', `${svcName}: \`RequireRole("admin")\` → 403 (authorisation happens in the service)`); return respond(403, 'Forbidden', { route, upPath }); }
      if (ep.m === 'POST' && ep.p === '/api/v1/orders' && body === 'bad') { add('upstream', 'fail', `${svcName}: binding failed — \`items\` is required → 400`); return respond(400, 'Invalid request body', { route, upPath }); }
      const okStatus = ep.m === 'POST' && (ep.p.endsWith('/orders') || ep.p.endsWith('/users')) ? 201 : 200;
      add('upstream', 'ok', `${svcName} handled it in ${isOrders ? 38 : 12} ms`, isOrders ? '38ms' : '12ms');
      return respond(okStatus, okStatus === 201 ? 'Created' : 'OK', { route, upPath, tok });
    }

    function recordBreaker(res) {
      if (!res.route || !res.route.upstream.startsWith('order') || res.fast) return;
      if (res.status >= 500) {
        cb.fails++;
        if (cb.state === 'half-open' || cb.fails >= THRESH) { cb.state = 'open'; cb.openedAt = Date.now(); }
      } else if (res.status < 500 && res.steps.some((s) => s.id === 'upstream')) { cb.state = 'closed'; cb.fails = 0; }
    }

    function showInspector(ep, tokKey, res) {
      const tok = TOKENS[tokKey];
      const up = $('[data-ipanel="up"]', ui.body);
      if (!res.upPath) up.innerHTML = '<span class="text-mutedc">The request never reached an upstream service — it was rejected at the edge.</span>';
      else {
        const h = (cls, k, v) => `<div class="gs-h is-${cls}"><b>${esc(k)}:</b> ${esc(v)}</div>`;
        up.innerHTML = `<div class="mono text-[12px] mb-1" style="color:var(--fg)">${ep.m} ${esc(res.upPath)} HTTP/1.1</div>
          ${h('keep', 'Host', res.route.upstream)}
          ${tok.sub && !TOKENS[tokKey].err ? h('del', 'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIs…') : ''}
          ${h('del', 'X-User-ID', '1 (sent by the client — never trusted)')}
          ${h('add', 'X-Request-ID', res.rid)}
          ${tok.sub && !tok.err ? h('add', 'X-User-ID', tok.sub) + h('add', 'X-User-Role', tok.role) : ''}
          ${h('add', 'X-Forwarded-For', '203.0.113.9')}
          ${h('add', 'X-Forwarded-Proto', 'https')}`;
      }
      const headers = [`Content-Type: ${res.status >= 400 ? 'application/problem+json' : 'application/json'}`, `X-Request-ID: ${res.rid}`];
      if (res.steps.some((s) => s.id === 'rate' && s.state === 'ok')) headers.push(`RateLimit-Limit: ${CAP}`, `RateLimit-Remaining: ${Math.floor(tokens)}`);
      if (res.retryAfter) headers.push(`Retry-After: ${res.retryAfter}`);
      if (res.wwwAuth) headers.push(`WWW-Authenticate: Bearer error="invalid_token", error_description="${res.detail}"`);
      if (res.status === 201) headers.push(`Location: ${res.upPath.endsWith('orders') ? '/v1/orders/8813' : '/v1/users/me'}`);
      const bodyJson = res.status < 400
        ? (ep.p.endsWith('login') ? '{"access_token":"eyJhbGciOiJIUzI1NiIs…","token_type":"Bearer","expires_in":900}' : ep.p.includes('orders') ? '{"id":8812,"user_id":42,"status":"PENDING","total_cents":4200,"currency":"USD"}' : '{"id":42,"email":"ada@example.com","name":"Ada Lovelace","role":"customer","status":"active"}')
        : JSON.stringify({ type: 'about:blank', title: res.title, status: res.status, request_id: res.rid }, null, 0);
      $('[data-ipanel="res"]', ui.body).innerHTML = MV.ui.codeBlock(`HTTP/1.1 ${res.status} ${res.title}\n${headers.join('\n')}\n\n${bodyJson}`, { lang: 'http', lineNumbers: false, title: 'response' });
      renderRoutes(res.route);
    }

    function renderStatus(res) {
      const s = $('[data-status]', ui.body);
      s.textContent = res.status;
      s.className = 'wg-stat-value ' + (res.status < 300 ? 'is-ok' : res.status === 429 || res.status === 404 || res.status === 403 || res.status === 400 || res.status === 401 || res.status === 413 ? 'is-warn' : 'is-err');
      refill();
      $('[data-tokens]', ui.body).textContent = Math.floor(tokens);
      const c = $('[data-cb]', ui.body);
      const st = cbState();
      c.textContent = st === 'closed' && cb.fails ? `closed (${cb.fails}/${THRESH})` : st;
      c.className = 'wg-stat-value ' + (st === 'open' ? 'is-err' : st === 'half-open' ? 'is-warn' : '');
    }

    async function send() {
      if (busy) return;
      busy = true;
      const ep = ENDPOINTS[+$('[data-ep]', el).value];
      const tokKey = $('[data-tok]', el).value;
      const res = evaluate(ep, tokKey, $('[data-body]', el).value, $('[data-down]', el).checked);
      recordBreaker(res);
      resetStages();
      try {
        for (const s of res.steps) {
          setStage(s.id, 'active', s.detail, s.t);
          await MV.wkit.sleep(170, () => alive);
          setStage(s.id, s.state, s.detail, s.t);
        }
        const failed = res.status >= 400;
        setStage('resp', failed ? 'fail' : 'ok', `**${res.status} ${res.title}** returned to the client`);
        showInspector(ep, tokKey, res);
        renderStatus(res);
      } catch (e) { /* disposed */ }
      busy = false;
    }

    function burst() {
      const ep = ENDPOINTS[+$('[data-ep]', el).value];
      const tokKey = $('[data-tok]', el).value;
      const counts = {};
      let lastRes;
      for (let i = 0; i < 25; i++) {
        const r = evaluate(ep, tokKey, $('[data-body]', el).value, $('[data-down]', el).checked);
        recordBreaker(r);
        counts[r.status] = (counts[r.status] || 0) + 1;
        lastRes = r;
      }
      resetStages();
      lastRes.steps.forEach((s) => setStage(s.id, s.state, s.detail, s.t));
      setStage('resp', lastRes.status >= 400 ? 'fail' : 'ok', `25 requests in ~50 ms: ${Object.entries(counts).map(([s, n]) => `**${n}× ${s}**`).join(', ')}`);
      showInspector(ep, tokKey, lastRes);
      renderStatus(lastRes);
    }

    $('[data-send]', el).addEventListener('click', send);
    $('[data-burst]', el).addEventListener('click', burst);
    $('[data-ep]', el).addEventListener('change', () => { $('[data-body-wrap]', el).style.opacity = ENDPOINTS[+$('[data-ep]', el).value].m === 'GET' ? '0.45' : '1'; });
    $$('[data-itab]', ui.body).forEach((t) => t.addEventListener('click', () => {
      $$('[data-itab]', ui.body).forEach((x) => x.setAttribute('aria-selected', String(x === t)));
      $$('[data-ipanel]', ui.body).forEach((p) => { p.hidden = p.dataset.ipanel !== t.dataset.itab; });
    }));
    $('[data-ep]', el).value = '3';
    renderRoutes(null);
    T.interval(() => { refill(); $('[data-tokens]', ui.body).textContent = Math.floor(tokens); const st = cbState(); const c = $('[data-cb]', ui.body); if (st === 'half-open' && c.textContent === 'open') { c.textContent = 'half-open'; c.className = 'wg-stat-value is-warn'; } }, 500);
    return () => { alive = false; T.clear(); };
  };
})(window.MV);
