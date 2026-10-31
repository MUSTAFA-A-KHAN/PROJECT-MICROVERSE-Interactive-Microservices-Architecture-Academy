/* ==========================================================================
   Widgets: trace-waterfall (read a distributed trace) and obs-dashboard
   (simulated RED metrics + incident investigation).
   All telemetry here is generated in the browser and labelled as simulated.
   ========================================================================== */
(function (MV) {
  'use strict';
  const { $, $$, esc, icon } = MV.ui;

  /* ======================================================================
     trace-waterfall
     ====================================================================== */
  function traceFor(scenario) {
    const s = [];
    const add = (o) => { s.push(o); return o; };
    const slow = scenario === 'slow', retry = scenario === 'retry';
    const userDur = slow ? 1812 : 7.4;
    const getUserStart = 3.6;
    const getUserDur = retry ? 74 : slow ? 1818 : 9.2;
    const txStart = getUserStart + getUserDur + 0.6;
    const ordDur = txStart - 2 + 28.4;
    const total = ordDur + 4;
    add({ name: 'POST /api/v1/orders', svc: 'api-gateway', start: 0, dur: total, depth: 0, attrs: { 'http.method': 'POST', 'http.route': '/api/v1/orders', 'http.status_code': 201, 'user.id': '42' } });
    add({ name: 'jwt.verify', svc: 'api-gateway', start: 0.3, dur: 0.06, depth: 1, attrs: { 'jwt.alg': 'HS256', 'jwt.sub': '42' } });
    add({ name: 'redis EVALSHA token_bucket', svc: 'api-gateway', start: 0.5, dur: 0.48, depth: 1, attrs: { 'db.system': 'redis', 'ratelimit.remaining': 17 } });
    add({ name: 'proxy → order-service', svc: 'api-gateway', start: 1.2, dur: total - 2, depth: 1, attrs: { 'net.peer.name': 'order-service', 'http.url': 'http://order-service:8082/v1/orders' } });
    add({ name: 'POST /v1/orders', svc: 'order-service', start: 2, dur: ordDur, depth: 2, attrs: { 'http.route': '/v1/orders', 'idempotency.key': '7f3a9c1e', 'http.status_code': 201 } });
    add({ name: 'SELECT idempotency_keys', svc: 'order-service', start: 2.4, dur: 0.8, depth: 3, db: true, attrs: { 'db.statement': 'SELECT order_id, request_hash FROM idempotency_keys WHERE user_id = $1 AND key = $2' } });
    if (retry) {
      add({ name: 'GET user-service (attempt 1)', svc: 'order-service', start: 3.6, dur: 3.1, depth: 3, err: true, attrs: { 'http.status_code': 503, 'retry.attempt': 1, error: 'user-service responded 503 (pod terminating)' } });
      add({ name: 'backoff sleep', svc: 'order-service', start: 6.8, dur: 61, depth: 3, wait: true, attrs: { 'backoff.ms': 61, strategy: 'full jitter' } });
      add({ name: 'GET user-service (attempt 2)', svc: 'order-service', start: 67.9, dur: 9.6, depth: 3, attrs: { 'http.status_code': 200, 'retry.attempt': 2 } });
      add({ name: 'GET /internal/users/:id', svc: 'user-service', start: 68.6, dur: 8.1, depth: 4, attrs: { 'http.status_code': 200 } });
      add({ name: 'SELECT users', svc: 'user-service', start: 69.4, dur: 6.2, depth: 5, db: true, attrs: { 'db.statement': 'SELECT … FROM users WHERE id = $1' } });
    } else {
      add({ name: 'GET user-service /internal/users/42', svc: 'order-service', start: getUserStart, dur: getUserDur, depth: 3, attrs: { 'http.status_code': 200, 'net.peer.name': 'user-service' } });
      add({ name: 'GET /internal/users/:id', svc: 'user-service', start: 4.5, dur: userDur, depth: 4, attrs: { 'http.status_code': 200 } });
      add({ name: 'redis GET user:42', svc: 'user-service', start: 4.8, dur: 0.4, depth: 5, attrs: { 'cache.hit': false } });
      add({ name: 'SELECT users', svc: 'user-service', start: 5.4, dur: slow ? 1805 : 5.9, depth: 5, db: true, err: false, slow, attrs: slow ? { 'db.statement': "SELECT … FROM users WHERE lower(email) = $1", 'db.rows_examined': 1200000, note: 'new query uses lower(email) — not served by users_email_key' } : { 'db.statement': 'SELECT … FROM users WHERE id = $1' } });
    }
    const tx = add({ name: 'pg tx CreateWithOutbox', svc: 'order-service', start: txStart, dur: 27.8, depth: 3, db: true, attrs: { 'db.system': 'postgresql', 'db.operation': 'transaction' } });
    let t = tx.start + 0.4;
    [['INSERT idempotency_keys', 1.1], ['INSERT orders', 2.3], ['COPY order_items', 3.4], ['UPDATE idempotency_keys', 1.2], ['INSERT outbox', 1.6], ['COMMIT', 15.8]].forEach(([n, d]) => {
      add({ name: n, svc: 'order-service', start: t, dur: d, depth: 4, db: true, attrs: { 'db.statement': n === 'COMMIT' ? 'COMMIT (fsync WAL)' : n } });
      t += d + 0.3;
    });
    add({ name: 'outbox.publishBatch', svc: 'order-service', start: total + 470, dur: 8.6, depth: 0, async: true, attrs: { 'messaging.system': 'rabbitmq', 'messaging.destination': 'orders', 'link': 'follows-from POST /v1/orders' } });
    add({ name: 'consume order.created', svc: 'notification-service', start: total + 481, dur: 151, depth: 1, async: true, attrs: { 'messaging.operation': 'process', 'messaging.message_id': '0b6f3c3e', 'email.provider_ms': 143 } });
    return s;
  }

  MV.widgets['trace-waterfall'] = function (el) {
    const ui = MV.wkit.frame(el, {
      title: 'Trace 4bf92f3577b34da6a3ce929d0e0e4736',
      sub: 'POST /api/v1/orders · click a span for its attributes',
      ico: 'waypoints',
      controls: `<label class="field-inline">Scenario <select class="select" data-sc><option value="normal">Normal request</option><option value="slow">Slow checkout (2 s)</option><option value="retry">Retry after a 503</option></select></label>
        <label class="switch"><input type="checkbox" data-async><span class="switch-track"></span>Show async spans (outbox → consumer)</label>`,
    });
    ui.body.innerHTML = `<div class="wg-grid"><div><div class="flex justify-between text-[11px] text-mutedc mono mb-1"><span>0 ms</span><span data-total></span></div><div class="tw" data-tw></div></div>
      <div class="grid gap-3 content-start"><div class="wg-panel" data-detail></div><div class="wg-note" data-note></div></div></div>`;
    let sel = 0;
    function render() {
      const spans = traceFor($('[data-sc]', el).value).filter((s) => $('[data-async]', el).checked || !s.async);
      const end = Math.max(...spans.map((s) => s.start + s.dur));
      $('[data-total]', ui.body).textContent = `${end.toFixed(end < 100 ? 1 : 0)} ms`;
      $('[data-tw]', ui.body).innerHTML = spans.map((s, i) => {
        const left = (s.start / end) * 100, width = Math.max(0.4, (s.dur / end) * 100);
        const durTxt = s.dur < 1 ? `${(s.dur * 1000).toFixed(0)} µs` : `${s.dur.toFixed(s.dur < 10 ? 1 : 0)} ms`;
        return `<button type="button" class="tw-row${i === sel ? ' is-sel' : ''}" data-i="${i}" style="--depth:${s.depth}">
          <span class="tw-name"><span class="tw-svc">${esc(s.svc.replace('-service', ''))}</span><span>${esc(s.name)}</span></span>
          <span class="tw-track"><span class="tw-bar${s.err ? ' is-err' : s.async ? ' is-async' : ''}" style="left:${left}%;width:${width}%;${s.wait ? 'opacity:.35' : ''}${s.slow ? ';background:var(--chart-2)' : ''}"></span><span class="tw-dur" style="left:min(calc(${left + width}% + 4px), calc(100% - 52px))">${durTxt}</span></span></button>`;
      }).join('');
      const s = spans[Math.min(sel, spans.length - 1)];
      $('[data-detail]', ui.body).innerHTML = `<div class="wg-panel-title">${icon('scan-search', '', 13)}Span</div><div class="font-semibold" style="color:var(--fg)">${esc(s.name)}</div>
        <div class="text-[12px] text-mutedc mono">${esc(s.svc)} · start +${s.start.toFixed(1)} ms · ${s.dur.toFixed(2)} ms ${s.err ? '· <span style="color:var(--err)">status ERROR</span>' : ''}</div>
        <div class="table-wrap mt-2"><table class="table">${Object.entries(s.attrs || {}).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td class="mono" style="color:var(--fg)">${esc(String(v))}</td></tr>`).join('')}</table></div>`;
      const sc = $('[data-sc]', el).value;
      const note = $('[data-note]', ui.body);
      note.className = 'wg-note' + (sc === 'slow' ? ' is-err' : sc === 'retry' ? ' is-warn' : '');
      note.innerHTML = MV.ui.inlineMd(sc === 'slow' ? 'The waterfall points straight at it: almost all of the 1.9 s is **SELECT users** inside User Service. Its attributes show 1.2 M rows examined — a new `lower(email)` predicate that the index does not serve.'
        : sc === 'retry' ? 'Attempt 1 hit a terminating pod and got **503**. The client backed off 61 ms (full jitter) and attempt 2 succeeded — visible as two sibling spans plus the backoff gap.'
        : 'Most of the request is the database transaction, and most of that is **COMMIT** (WAL fsync). The user lookup is a small, cached-miss call. Toggle async spans to see the outbox relay and the email consumer, linked to this trace.');
    }
    $('[data-tw]', ui.body).addEventListener('click', (e) => { const r = e.target.closest('[data-i]'); if (r) { sel = +r.dataset.i; render(); } });
    $('[data-sc]', el).addEventListener('change', () => { sel = 0; render(); });
    $('[data-async]', el).addEventListener('change', render);
    render();
  };

  /* ======================================================================
     obs-dashboard
     ====================================================================== */
  const INCIDENTS = {
    none: 'No incident',
    'user-crash': 'Incident A',
    'slow-db': 'Incident B',
    broker: 'Incident C',
    'bad-deploy': 'Incident D',
    spike: 'Incident E',
  };
  const CAUSES = [
    ['user-crash', 'User Service crashed'],
    ['slow-db', 'orders-db is slow (long-running queries / locks)'],
    ['broker', 'RabbitMQ is down'],
    ['bad-deploy', 'A bad Order Service deploy is returning 500s'],
    ['spike', 'A traffic spike'],
  ];
  const DEBRIEF = {
    'user-crash': 'User Service request rate dropped to zero at the incident marker while Order Service 5xx rose at the same moment — the upstream symptom of a downstream crash. **Mitigate**: restart/scale User Service; Order Service\'s breaker already fails fast. **Prevent**: ≥2 replicas, PodDisruptionBudget, and a fallback for customer validation.',
    'slow-db': 'Latency rose before errors did, and the orders-db pool shows requests **waiting** for connections — saturation. User Service stayed healthy, isolating the problem to Order Service\'s database. Gateway 504s appeared once p99 crossed the 2 s route timeout. **Mitigate**: find and kill the long query or lock (`pg_stat_activity`); **prevent**: statement timeouts, indexes, keep transactions short.',
    broker: 'No errors and normal latency — the outbox absorbed the outage. The signal is **outbox pending events** climbing linearly and notification throughput at zero. **Mitigate**: restore RabbitMQ; the relay drains the backlog. **Prevent**: alert on the age of the oldest pending event.',
    'bad-deploy': 'A step change in Order Service errors at the deploy marker, with normal latency and healthy dependencies — the signature of a code bug. **Mitigate**: roll back first (`kubectl rollout undo`), debug second. **Prevent**: canary releases with automatic error-rate analysis.',
    spike: 'Request rate quadrupled; latency and pool usage rose with it and rate-limit 429s appeared, but 5xx stayed low. **Mitigate**: let the HPA scale (check maxReplicas vs DB connections); **prevent**: load tests, rate limits per client, load shedding for low-priority traffic.',
  };

  MV.widgets['obs-dashboard'] = function (el) {
    const ui = MV.wkit.frame(el, {
      title: 'Order Management System — production (simulated)',
      sub: 'Synthetic telemetry generated in your browser · 1 point = 10 s',
      ico: 'activity',
      controls: `<label class="field-inline">Inject <select class="select" data-inc>${Object.entries(INCIDENTS).map(([k, v]) => `<option value="${k}">${esc(v)}${k === 'none' ? '' : ' (unknown cause)'}</option>`).join('')}</select></label>
        <button class="btn btn-sm btn-danger" type="button" data-inject>${icon('zap')}Inject</button>
        <button class="btn btn-sm" type="button" data-resolve>${icon('heart-pulse')}Resolve</button>
        <label class="switch"><input type="checkbox" data-pause><span class="switch-track"></span>Pause</label>
        <span class="text-[12px] text-mutedc ml-auto">Range: last 5 minutes</span>`,
    });
    ui.body.innerHTML = `<div class="grid gap-3">
        <div class="od-tiles" data-tiles></div>
        <div class="wg-panel"><div class="wg-panel-title">${icon('server', '', 13)}Services</div><div class="table-wrap"><table class="table od-svc" data-svc></table></div></div>
        <div class="od-charts">
          <div class="wg-panel"><div class="wg-panel-title">Gateway latency (ms)</div><div class="ch-legend mb-2"><span><span class="ch-key" style="background:var(--chart-1)"></span>p50</span><span><span class="ch-key" style="background:var(--chart-2)"></span>p99</span></div><div data-c-lat></div></div>
          <div class="wg-panel"><div class="wg-panel-title">Gateway 5xx error rate (%)</div><div data-c-err></div></div>
          <div class="wg-panel"><div class="wg-panel-title">orders-db connection pool</div><div class="ch-legend mb-2"><span><span class="ch-key" style="background:var(--chart-1)"></span>acquired (max 10)</span><span><span class="ch-key" style="background:var(--chart-2)"></span>waiting for a connection</span></div><div data-c-pool></div></div>
          <div class="wg-panel"><div class="wg-panel-title">Outbox pending events</div><div data-c-outbox></div></div>
        </div>
        <div class="wg-grid">
          <div class="wg-panel"><div class="wg-panel-title">${icon('circle-x', '', 13)}Recent failed requests</div><div class="table-wrap"><table class="table" data-failed></table></div></div>
          <div class="wg-panel"><div class="wg-panel-title">${icon('search-check', '', 13)}Your diagnosis</div>
            <div class="grid gap-2"><select class="select" data-guess><option value="">What is the root cause?</option>${CAUSES.map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select>
            <button class="btn btn-sm btn-primary" type="button" data-check>${icon('check')}Check diagnosis</button><div class="wg-note" data-verdict>Inject an incident, watch the signals, then diagnose.</div></div></div>
        </div>
      </div>`;

    const T = MV.wkit.timers();
    const N = 30;
    const r = (a, b) => a + Math.random() * (b - a);
    let incident = 'none', since = -1, step = 0, markerAt = -1;
    const series = { rps: [], err: [], p50: [], p99: [], acq: [], wait: [], outbox: [], svc: {}, failed: [], limited: [] };
    const SVC = ['api-gateway', 'user-service', 'order-service', 'notification-service'];
    SVC.forEach((s) => { series.svc[s] = { rps: [], err: [], p99: [] }; });

    function sample() {
      const k = since >= 0 ? step - since : -1; // points since incident start
      const ramp = (n) => Math.min(1, Math.max(0, (k + 1) / n));
      let rps = r(110, 130), errPct = r(0.05, 0.3), p50 = r(19, 25), p99 = r(70, 95), acq = r(2, 4), wait = 0, outbox = r(0, 3), limited = r(0, 1);
      const svc = {
        'api-gateway': { rps, err: errPct, p99 },
        'user-service': { rps: rps * 0.75, err: r(0, 0.2), p99: r(18, 30) },
        'order-service': { rps: rps * 0.4, err: r(0, 0.3), p99: r(55, 80) },
        'notification-service': { rps: rps * 0.12, err: 0, p99: r(140, 190) },
      };
      if (incident === 'user-crash' && k >= 0) {
        svc['user-service'] = { rps: 0, err: 100, p99: 0 };
        const bo = k < 3 ? 1 : 0; // retries before the breaker opens
        svc['order-service'] = { rps: rps * 0.4, err: r(92, 99), p99: bo ? r(800, 1200) : r(3, 6) };
        errPct = r(60, 70); p99 = bo ? r(900, 1300) : r(30, 45); p50 = r(4, 8);
      }
      if (incident === 'slow-db' && k >= 0) {
        const g = ramp(6);
        const op99 = 70 + g * 1900;
        svc['order-service'] = { rps: rps * 0.4, err: g > 0.8 ? r(25, 40) : r(0, 2), p99: op99 };
        p99 = 90 + g * 1950; p50 = 22 + g * 120; acq = 3 + g * 7; wait = g * r(18, 30);
        errPct = g > 0.8 ? r(10, 16) : r(0, 1);
      }
      if (incident === 'broker' && k >= 0) {
        outbox = (k + 1) * r(55, 65);
        svc['notification-service'] = { rps: 0, err: 0, p99: 0 };
      }
      if (incident === 'bad-deploy' && k >= 0) {
        svc['order-service'] = { rps: rps * 0.4, err: r(55, 62), p99: r(55, 85) };
        errPct = r(21, 26);
      }
      if (incident === 'spike' && k >= 0) {
        const g = ramp(3);
        rps = rps * (1 + 3 * g);
        p99 = 90 + g * r(250, 320); p50 = 22 + g * 30; acq = 3 + g * 6.5; wait = g * r(2, 6); limited = g * r(35, 50);
        Object.keys(svc).forEach((s) => { svc[s].rps *= 1 + 3 * g; });
        svc['api-gateway'].p99 = p99; svc['order-service'].p99 = 70 + g * 260;
      }
      svc['api-gateway'].rps = rps; svc['api-gateway'].err = errPct; svc['api-gateway'].p99 = p99;
      const push = (arr, v) => { arr.push(v); while (arr.length > N) arr.shift(); };
      push(series.rps, rps); push(series.err, errPct); push(series.p50, p50); push(series.p99, p99);
      push(series.acq, acq); push(series.wait, wait); push(series.outbox, outbox); push(series.limited, limited);
      SVC.forEach((s) => { push(series.svc[s].rps, svc[s].rps); push(series.svc[s].err, svc[s].err); push(series.svc[s].p99, svc[s].p99); });
      // failed requests
      const now = new Date();
      const ts = now.toTimeString().slice(0, 8);
      const rid = () => Math.random().toString(16).slice(2, 10);
      const f = (route, status, svcName, detail) => series.failed.unshift({ ts, route, status, svc: svcName, detail, trace: rid() });
      if (incident === 'user-crash' && k >= 0) { f('POST /api/v1/orders', 503, 'order-service', k < 3 ? 'user-service: connection refused (after 3 attempts)' : 'circuit open: user-service'); f('GET /api/v1/users/me', 502, 'api-gateway', 'dial tcp user-service:8081: connection refused'); }
      if (incident === 'slow-db' && k >= 4) f('POST /api/v1/orders', 504, 'api-gateway', 'upstream timeout after 2s (order-service)');
      if (incident === 'bad-deploy' && k >= 0) f('POST /api/v1/orders', 500, 'order-service', 'panic: nil pointer dereference (pricing.Calculate) — recovered');
      series.failed = series.failed.slice(0, 7);
      step++;
    }

    function render() {
      const last = (a) => a[a.length - 1] || 0;
      const labels = Array.from({ length: series.rps.length }, (_, i) => { const s = (series.rps.length - 1 - i) * 10; return s === 0 ? 'now' : `−${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`; });
      const markers = markerAt >= 0 && step - markerAt <= N ? [{ index: Math.max(0, series.rps.length - (step - markerAt)), text: 'incident start' }] : [];
      const failedCount = series.failed.length ? Math.round(series.err.reduce((s, v, i) => s + (v / 100) * series.rps[i] * 10, 0)) : 0;
      const tile = (label, value, spark, cls = '') => `<div class="od-tile"><div class="stat-label">${label}</div><div class="od-tile-row"><div class="stat-value ${cls}" style="font-size:22px">${value}</div>${spark}</div></div>`;
      const errNow = last(series.err), p99Now = last(series.p99);
      $('[data-tiles]', ui.body).innerHTML =
        tile('Request rate', `${Math.round(last(series.rps))}<span class="text-[13px] text-mutedc font-medium"> req/s</span>`, MV.wkit.sparkline(series.rps)) +
        tile('5xx error rate', `${errNow.toFixed(errNow < 1 ? 2 : 1)}%`, MV.wkit.sparkline(series.err), errNow > 5 ? 'od-err' : '') +
        tile('p99 latency', `${Math.round(p99Now)}<span class="text-[13px] text-mutedc font-medium"> ms</span>`, MV.wkit.sparkline(series.p99), p99Now > 500 ? 'od-err' : '') +
        tile('Failed requests (5 min)', failedCount.toLocaleString(), MV.wkit.sparkline(series.err.map((v, i) => (v / 100) * series.rps[i]))) +
        tile('Rate-limited (429/s)', last(series.limited).toFixed(1), MV.wkit.sparkline(series.limited));
      $$('.od-err', ui.body).forEach((e) => { e.style.color = 'var(--err)'; });
      $('[data-svc]', ui.body).innerHTML = `<thead><tr><th>Service</th><th>Status</th><th>req/s</th><th>Errors</th><th>p99</th><th>p99 trend</th></tr></thead><tbody>${SVC.map((s) => {
        const d = series.svc[s];
        const e = last(d.err), rp = last(d.rps), p = last(d.p99);
        const st = rp === 0 && s !== 'api-gateway' ? (s === 'notification-service' && incident === 'broker' ? ['is-warn', 'triangle-alert', 'Idle (no messages)'] : ['is-err', 'circle-x', 'Down']) : e > 5 ? ['is-err', 'circle-x', 'Failing'] : p > 500 ? ['is-warn', 'triangle-alert', 'Degraded'] : ['is-ok', 'circle-check', 'Healthy'];
        return `<tr><td>${s}</td><td><span class="pill ${st[0]}">${icon(st[1])}${st[2]}</span></td><td class="tabular">${rp.toFixed(1)}</td><td class="tabular">${e.toFixed(1)}%</td><td class="tabular">${Math.round(p)} ms</td><td>${MV.wkit.sparkline(d.p99, { w: 90, h: 22 })}</td></tr>`;
      }).join('')}</tbody>`;
      const fms = (v) => v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}`;
      MV.wkit.lineChart($('[data-c-lat]', ui.body), { series: [{ name: 'p50', values: series.p50, color: 'var(--chart-1)' }, { name: 'p99', values: series.p99, color: 'var(--chart-2)' }], labels, format: fms, markers, label: 'Gateway latency p50 and p99' });
      MV.wkit.lineChart($('[data-c-err]', ui.body), { series: [{ name: '5xx %', values: series.err, color: 'var(--chart-1)' }], labels, format: (v) => `${v.toFixed(v < 10 ? 1 : 0)}%`, area: true, markers, yMax: Math.max(5, MV.wkit.niceMax(Math.max(...series.err) * 1.1)), label: 'Gateway 5xx error rate' });
      MV.wkit.lineChart($('[data-c-pool]', ui.body), { series: [{ name: 'acquired', values: series.acq, color: 'var(--chart-1)' }, { name: 'waiting', values: series.wait, color: 'var(--chart-2)' }], labels, format: (v) => String(Math.round(v)), markers, label: 'orders-db pool' });
      MV.wkit.lineChart($('[data-c-outbox]', ui.body), { series: [{ name: 'pending', values: series.outbox, color: 'var(--chart-1)' }], labels, format: (v) => String(Math.round(v)), area: true, markers, yMax: Math.max(10, MV.wkit.niceMax(Math.max(...series.outbox) * 1.1)), label: 'Outbox pending events' });
      $('[data-failed]', ui.body).innerHTML = `<thead><tr><th>Time</th><th>Request</th><th>Status</th><th>Detail</th></tr></thead><tbody>${series.failed.length ? series.failed.map((f) => `<tr><td class="mono">${f.ts}</td><td class="mono">${esc(f.route)}</td><td><span class="pill is-err">${f.status}</span></td><td>${esc(f.detail)} <span class="mono text-mutedc">trace ${f.trace}</span></td></tr>`).join('') : '<tr><td colspan="4" class="text-mutedc">No failed requests in the window.</td></tr>'}</tbody>`;
    }

    for (let i = 0; i < N; i++) sample();
    render();
    T.interval(() => { if (!$('[data-pause]', el).checked) { sample(); render(); } }, 1500);
    $('[data-inject]', el).addEventListener('click', () => {
      const v = $('[data-inc]', el).value;
      incident = v; since = step; markerAt = step;
      $('[data-verdict]', ui.body).className = 'wg-note';
      $('[data-verdict]', ui.body).innerHTML = v === 'none' ? 'No incident injected.' : 'Incident in progress. Which signals moved first? Diagnose below.';
      sample(); render();
    });
    $('[data-resolve]', el).addEventListener('click', () => { incident = 'none'; since = -1; $('[data-verdict]', ui.body).className = 'wg-note is-ok'; $('[data-verdict]', ui.body).textContent = 'Resolved. Watch the metrics return to baseline.'; });
    $('[data-check]', el).addEventListener('click', () => {
      const g = $('[data-guess]', el).value;
      const v = $('[data-verdict]', ui.body);
      if (incident === 'none') { v.className = 'wg-note'; v.textContent = 'Inject an incident first.'; return; }
      if (!g) { v.className = 'wg-note'; v.textContent = 'Pick a root cause first.'; return; }
      if (g === incident) { v.className = 'wg-note is-ok'; v.innerHTML = `<strong>Correct.</strong> ${MV.ui.inlineMd(DEBRIEF[incident])}`; }
      else { v.className = 'wg-note is-err'; v.innerHTML = `<strong>Not quite.</strong> ${MV.ui.inlineMd(g === 'user-crash' ? 'Check the User Service row — is its request rate actually zero?' : g === 'slow-db' ? 'Look at the pool chart — are requests waiting for connections?' : g === 'broker' ? 'Is the outbox backlog growing?' : g === 'bad-deploy' ? 'Is latency normal while one service\'s errors jumped at the marker?' : 'Did the request rate actually rise?')}`; }
    });
    const onResize = () => render();
    window.addEventListener('resize', onResize);
    return () => { T.clear(); window.removeEventListener('resize', onResize); };
  };
})(window.MV);
