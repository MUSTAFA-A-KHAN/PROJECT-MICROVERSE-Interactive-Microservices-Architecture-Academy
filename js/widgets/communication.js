/* ==========================================================================
   Widgets: retry-backoff (retry strategies vs a recovering dependency)
   and comm-sim (REST vs gRPC vs asynchronous messaging).
   ========================================================================== */
(function (MV) {
  'use strict';
  const { $, $$, esc, icon } = MV.ui;

  /* ======================================================================
     retry-backoff
     ====================================================================== */
  const STRATS = {
    immediate: { label: 'Immediate', wait: () => 10 },
    fixed: { label: 'Fixed 500 ms', wait: () => 500 },
    exp: { label: 'Exponential', wait: (n) => 100 * Math.pow(2, n - 1) },
    jitter: { label: 'Exp. + full jitter', wait: (n) => Math.random() * 100 * Math.pow(2, n - 1) },
  };

  function simulateRetries({ clients, strategy, maxAttempts, outageMs, capacity }) {
    const BUCKET = 100, HORIZON = 6000;
    const buckets = new Array(HORIZON / BUCKET).fill(0);
    const events = [];
    for (let i = 0; i < clients; i++) events.push({ t: Math.random() * 100, client: i, attempt: 1 });
    let attempts = 0, succeeded = 0, gaveUp = 0, lastSuccess = 0;
    const served = new Map(); // bucket -> served count
    while (events.length) {
      events.sort((a, b) => a.t - b.t);
      const e = events.shift();
      if (e.t >= HORIZON) { gaveUp++; continue; }
      attempts++;
      const b = Math.floor(e.t / BUCKET);
      buckets[b]++;
      let ok = false;
      if (e.t >= outageMs) {
        const s = served.get(b) || 0;
        if (s < capacity) { ok = true; served.set(b, s + 1); }
      }
      if (ok) { succeeded++; lastSuccess = Math.max(lastSuccess, e.t); continue; }
      if (e.attempt >= maxAttempts) { gaveUp++; continue; }
      events.push({ t: e.t + 5 + STRATS[strategy].wait(e.attempt), client: e.client, attempt: e.attempt + 1 });
    }
    return { buckets, attempts, succeeded, gaveUp, lastSuccess, peak: Math.max(...buckets) };
  }

  MV.widgets['retry-backoff'] = function (el) {
    const ui = MV.wkit.frame(el, {
      title: 'Retry strategies against a recovering dependency',
      sub: 'Clients fail during an outage, then retry; the dependency serves at most 25 requests per 100 ms',
      ico: 'refresh-cw',
      controls: `<div class="segmented" role="group" aria-label="Retry strategy">${Object.entries(STRATS).map(([k, s]) => `<button type="button" data-strat="${k}" aria-pressed="${k === 'jitter'}">${s.label}</button>`).join('')}</div>
        <label class="field-inline">Clients <input type="range" min="10" max="120" value="60" step="10" data-clients><span class="mono" data-clients-v>60</span></label>
        <label class="field-inline">Max attempts <select class="select" data-max><option>3</option><option selected>5</option><option>8</option></select></label>
        <label class="field-inline">Outage <select class="select" data-outage><option value="800">0.8 s</option><option value="1500" selected>1.5 s</option><option value="3000">3 s</option></select></label>
        <button class="btn btn-sm btn-primary" type="button" data-run>${icon('play')}Run</button>`,
    });
    ui.body.innerHTML = `<div class="grid gap-3">
        <div class="wg-stats">
          <div class="wg-stat"><div class="wg-stat-label">Total attempts</div><div class="wg-stat-value" data-a>—</div></div>
          <div class="wg-stat"><div class="wg-stat-label">Peak / 100 ms</div><div class="wg-stat-value" data-p>—</div></div>
          <div class="wg-stat"><div class="wg-stat-label">Succeeded</div><div class="wg-stat-value is-ok" data-s>—</div></div>
          <div class="wg-stat"><div class="wg-stat-label">Gave up</div><div class="wg-stat-value is-err" data-g>—</div></div>
          <div class="wg-stat"><div class="wg-stat-label">All recovered by</div><div class="wg-stat-value" data-l>—</div></div>
        </div>
        <div class="wg-panel"><div class="wg-panel-title">${icon('chart-column', '', 13)}Requests reaching the dependency per 100 ms</div><div data-chart></div></div>
        <div class="wg-note" data-note></div>
      </div>`;
    let strategy = 'jitter';
    const NOTES = {
      immediate: 'Immediate retries hammer the dependency hundreds of times during the outage — and most clients **exhaust their attempts before it recovers**. In a real outage, this load can keep the dependency down.',
      fixed: 'Fixed delays are better, but every client that failed together retries **together**: synchronised waves that hit the capacity limit and fail again.',
      exp: 'Exponential backoff reduces total attempts, but without jitter clients still move in lock-step — notice the tall, regular spikes.',
      jitter: 'Full jitter spreads retries across the whole backoff window, so the recovering dependency sees a smooth load below its capacity. This is the default to use.',
    };
    function run() {
      const res = simulateRetries({
        clients: +$('[data-clients]', el).value, strategy,
        maxAttempts: +$('[data-max]', el).value, outageMs: +$('[data-outage]', el).value, capacity: 25,
      });
      const outage = +$('[data-outage]', el).value;
      $('[data-a]', ui.body).textContent = res.attempts.toLocaleString();
      $('[data-p]', ui.body).textContent = res.peak;
      $('[data-p]', ui.body).className = 'wg-stat-value' + (res.peak > 25 ? ' is-err' : '');
      $('[data-s]', ui.body).textContent = res.succeeded;
      $('[data-g]', ui.body).textContent = res.gaveUp;
      $('[data-l]', ui.body).textContent = res.succeeded ? `${(res.lastSuccess / 1000).toFixed(2)} s` : 'never';
      MV.wkit.columnChart($('[data-chart]', ui.body), {
        bars: res.buckets.map((v, i) => ({ label: `${(i / 10).toFixed(1)}–${((i + 1) / 10).toFixed(1)} s`, value: v, color: v > 25 ? 'var(--chart-2)' : 'var(--chart-1)' })),
        format: (v) => String(Math.round(v)),
        label: 'Requests per 100 ms',
        bands: [{ from: 0, to: outage / 100, text: 'dependency down' }],
      });
      $('[data-note]', ui.body).innerHTML = MV.ui.inlineMd(NOTES[strategy]) + ' <span class="text-mutedc">Orange bars exceed the dependency\'s capacity (25 per 100 ms).</span>';
      $('[data-note]', ui.body).className = 'wg-note' + (strategy === 'jitter' ? ' is-ok' : strategy === 'immediate' ? ' is-err' : ' is-warn');
    }
    $$('[data-strat]', el).forEach((b) => b.addEventListener('click', () => { strategy = b.dataset.strat; $$('[data-strat]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); run(); }));
    $('[data-clients]', el).addEventListener('input', (e) => { $('[data-clients-v]', el).textContent = e.target.value; });
    ['[data-clients]', '[data-max]', '[data-outage]'].forEach((s) => $(s, el).addEventListener('change', run));
    $('[data-run]', el).addEventListener('click', run);
    const onResize = () => run();
    window.addEventListener('resize', onResize);
    requestAnimationFrame(run);
    return () => window.removeEventListener('resize', onResize);
  };

  /* ======================================================================
     comm-sim
     ====================================================================== */
  const MODES = {
    rest: { label: 'REST (sync)', user: 6, notify: 182, userBytes: 312, notifyBytes: 486, edge: 'REST · JSON' },
    grpc: { label: 'gRPC (sync)', user: 3, notify: 176, userBytes: 64, notifyBytes: 122, edge: 'gRPC · protobuf' },
    async: { label: 'Messaging (async)', user: 6, notify: 0, userBytes: 312, notifyBytes: 318, edge: 'REST · JSON' },
  };

  function commSpec(mode) {
    const nodes = [
      { id: 'client', label: 'Client', x: 70, y: 150, kind: 'client', w: 110 },
      { id: 'gw', label: 'API Gateway', x: 215, y: 150, kind: 'gateway', w: 140 },
      { id: 'orders', label: 'Order Service', x: 410, y: 150, kind: 'service', w: 160 },
      { id: 'users', label: 'User Service', x: 690, y: 55, kind: 'service', w: 160 },
      { id: 'notify', label: 'Notification Svc', sub: mode === 'async' ? 'consumer' : 'HTTP API', x: 760, y: 245, kind: mode === 'async' ? 'worker' : 'service', w: 170 },
    ];
    const edges = [
      { id: 'cg', from: 'client', to: 'gw' }, { id: 'go', from: 'gw', to: 'orders' },
      { id: 'ou', from: 'orders', to: 'users', label: MODES[mode].edge },
    ];
    if (mode === 'async') {
      nodes.push({ id: 'broker', label: 'RabbitMQ', sub: 'queue', x: 560, y: 245, kind: 'broker', w: 130 });
      edges.push({ id: 'ob', from: 'orders', to: 'broker', label: 'order.created' }, { id: 'bn', from: 'broker', to: 'notify' });
    } else edges.push({ id: 'on', from: 'orders', to: 'notify', label: mode === 'grpc' ? 'gRPC SendConfirmation' : 'POST /notifications' });
    return { w: 860, h: 300, nodes, edges };
  }

  MV.widgets['comm-sim'] = function (el) {
    const ui = MV.wkit.frame(el, {
      title: 'REST vs gRPC vs messaging',
      sub: 'Order → User (validation) and Order → Notification (confirmation email)',
      ico: 'arrow-left-right',
      controls: `<div class="segmented" role="group" aria-label="Communication style">${Object.entries(MODES).map(([k, m], i) => `<button type="button" data-mode="${k}" aria-pressed="${i === 0}">${m.label}</button>`).join('')}</div>
        <label class="switch is-danger"><input type="checkbox" data-ndown><span class="switch-track"></span>Notification Service down</label>
        <label class="switch is-danger"><input type="checkbox" data-uslow><span class="switch-track"></span>User Service slow (+600 ms)</label>
        <button class="btn btn-sm btn-primary" type="button" data-one>${icon('send')}Place order</button>
        <button class="btn btn-sm" type="button" data-ten>${icon('repeat')}Place 10</button>`,
    });
    ui.body.innerHTML = `<div class="grid gap-3">
        <div data-dg></div>
        <div class="wg-grid">
          <div class="wg-panel"><div class="wg-panel-title">${icon('table', '', 13)}Results by style</div><div class="table-wrap"><table class="table" data-table></table></div></div>
          <div class="grid gap-3 content-start"><div class="wg-note" data-note></div><div class="wg-panel"><div class="wg-panel-title">${icon('scroll-text', '', 13)}Events</div><div data-log></div></div></div>
        </div>
      </div>`;
    const T = MV.wkit.timers();
    let alive = true, busy = false, mode = 'rest', dg = null, queued = 0;
    const log = MV.wkit.logger($('[data-log]', ui.body), 50);
    const stats = Object.fromEntries(Object.keys(MODES).map((k) => [k, { sent: 0, ok: 0, failed: 0, latSum: 0, bytes: 0 }]));

    function draw() {
      if (dg) dg.destroy();
      dg = MV.diagram.create($('[data-dg]', ui.body), commSpec(mode), { minScale: 0.6 });
      if ($('[data-ndown]', el).checked) dg.setState('notify', 'down');
      if ($('[data-uslow]', el).checked) dg.setState('users', 'warn');
      if (mode === 'async' && queued) dg.setBadge('broker', String(queued));
      renderTable();
      renderNote();
    }
    function renderTable() {
      $('[data-table]', ui.body).innerHTML = `<thead><tr><th>Style</th><th>Orders</th><th>Succeeded</th><th>Avg latency</th><th>Bytes / order</th></tr></thead><tbody>${Object.entries(MODES).map(([k, m]) => {
        const s = stats[k];
        return `<tr style="${k === mode ? 'background:color-mix(in srgb,var(--blue) 8%,transparent)' : ''}"><td style="color:var(--fg)">${m.label}</td><td class="tabular">${s.sent}</td><td class="tabular">${s.sent ? `${s.ok}/${s.sent}` : '—'}</td><td class="tabular">${s.ok ? Math.round(s.latSum / s.ok) + ' ms' : '—'}</td><td class="tabular">${s.sent ? Math.round(s.bytes / s.sent) + ' B' : '—'}</td></tr>`;
      }).join('')}</tbody>`;
    }
    function renderNote() {
      const nd = $('[data-ndown]', el).checked, us = $('[data-uslow]', el).checked;
      let t, cls = '';
      if (mode === 'async') {
        t = nd ? `Orders still succeed. Events wait in RabbitMQ (**${queued} queued**) and are delivered when Notification Service returns — switch it back on to watch the queue drain.` : 'The email is a side effect, so it is published as an event. The client gets `201` without waiting for the email provider (~180 ms saved per order).';
        cls = nd ? ' is-warn' : ' is-ok';
      } else {
        t = nd ? 'The confirmation call is on the request path, so a Notification Service outage **fails order creation**. Faster serialisation (gRPC) does not change that coupling.' : `Every order waits for the email provider (~180 ms) because the call is synchronous.${mode === 'grpc' ? ' gRPC shrinks payloads ~4–5× and shaves a few ms, but the coupling is identical.' : ''}`;
        cls = nd ? ' is-err' : '';
      }
      if (us) t += ' **User Service is slow** — every style suffers, because validating the customer is synchronous in all of them. Messaging only decouples work you do not need to decide.';
      const n = $('[data-note]', ui.body);
      n.innerHTML = MV.ui.inlineMd(t);
      n.className = 'wg-note' + (us ? ' is-warn' : cls);
    }

    async function hop(edge, reverse, color, dur = 380) {
      if (!alive) throw new Error('disposed');
      await dg.packet(edge, { reverse, color: color || (reverse ? 'green' : 'blue'), duration: dur });
    }

    async function order(fast) {
      const m = MODES[mode], s = stats[mode];
      const nd = $('[data-ndown]', el).checked, us = $('[data-uslow]', el).checked;
      const d = fast ? 160 : 380;
      s.sent++;
      let lat = 3;
      await hop('cg', false, null, d); await hop('go', false, null, d);
      await hop('ou', false, null, d + (us ? 300 : 0)); await hop('ou', true, null, d);
      lat += m.user + (us ? 600 : 0) + 5;
      let bytes = m.userBytes;
      if (mode === 'async') {
        await hop('go', true, null, d); await hop('cg', true, null, d);
        lat += 2;
        s.ok++; s.latSum += lat; s.bytes += bytes + m.notifyBytes;
        log.add(`201 Created in **${lat} ms** · order.created written to the outbox`, 'ok');
        await hop('ob', false, 'purple', d);
        if (nd) { queued++; dg.setBadge('broker', String(queued)); log.add(`Notification Service down — event queued (${queued} waiting)`, 'warn'); }
        else { await hop('bn', false, 'purple', d); log.add('email sent asynchronously (+182 ms, not on the request path)', 'async'); }
      } else {
        if (nd) {
          await dg.packet('on', { color: 'err', duration: d });
          await MV.wkit.sleep(fast ? 60 : 200, () => alive);
          await dg.packet('on', { color: 'err', duration: d });
          s.failed++;
          s.bytes += bytes;
          await hop('go', true, 'err', d); await hop('cg', true, 'err', d);
          log.add('POST /notifications: connection refused (retried once) → order creation failed with **503**', 'err');
        } else {
          await hop('on', false, null, d + 150); await hop('on', true, null, d);
          lat += m.notify;
          bytes += m.notifyBytes;
          await hop('go', true, null, d); await hop('cg', true, null, d);
          s.ok++; s.latSum += lat; s.bytes += bytes;
          log.add(`201 Created in **${lat} ms** (${mode === 'grpc' ? 'gRPC' : 'REST'}: waited for the email provider)`, 'ok');
        }
      }
      renderTable();
      renderNote();
    }

    async function runN(n) {
      if (busy) return;
      busy = true;
      $$('[data-one],[data-ten]', el).forEach((b) => { b.disabled = true; });
      try { for (let i = 0; i < n; i++) await order(n > 1); } catch (e) { /* disposed */ }
      busy = false;
      $$('[data-one],[data-ten]', el).forEach((b) => { b.disabled = false; });
    }

    async function drain() {
      if (mode !== 'async' || !queued || busy) return;
      busy = true;
      log.add(`Notification Service is back — draining ${queued} queued event(s)`, 'ok');
      try {
        while (queued > 0 && alive) {
          await hop('bn', false, 'purple', 200);
          queued--; dg.setBadge('broker', queued ? String(queued) : null);
        }
        log.add('queue drained — every confirmation email was sent', 'async');
      } catch (e) { /* disposed */ }
      busy = false;
      renderNote();
    }

    $$('[data-mode]', el).forEach((b) => b.addEventListener('click', () => {
      if (busy) return;
      mode = b.dataset.mode;
      $$('[data-mode]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      draw();
    }));
    $('[data-ndown]', el).addEventListener('change', (e) => {
      dg.setState('notify', e.target.checked ? 'down' : 'idle');
      renderNote();
      if (!e.target.checked) drain();
    });
    $('[data-uslow]', el).addEventListener('change', (e) => { dg.setState('users', e.target.checked ? 'warn' : 'idle'); renderNote(); });
    $('[data-one]', el).addEventListener('click', () => runN(1));
    $('[data-ten]', el).addEventListener('click', () => runN(10));
    draw();
    log.add('Place an order in each style and compare the table.');
    return () => { alive = false; T.clear(); if (dg) dg.destroy(); };
  };
})(window.MV);
