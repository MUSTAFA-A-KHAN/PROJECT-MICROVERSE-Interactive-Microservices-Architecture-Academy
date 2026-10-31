/* ==========================================================================
   Widgets: circuit-breaker, saga, idempotency, load-balancer.
   ========================================================================== */
(function (MV) {
  'use strict';
  const { $, $$, esc, icon } = MV.ui;

  /* ======================================================================
     circuit-breaker — live state machine with real wall-clock cool-down
     ====================================================================== */
  MV.widgets['circuit-breaker'] = function (el) {
    const ui = MV.wkit.frame(el, {
      title: 'Circuit breaker state machine',
      sub: 'Order Service → User Service, wrapped in a breaker',
      ico: 'toggle-right',
      controls: `<label class="field-inline">User Service <div class="segmented" role="group" aria-label="Dependency health"><button type="button" data-h="healthy" aria-pressed="true">Healthy</button><button type="button" data-h="failing" aria-pressed="false">Failing</button></div></label>
        <label class="field-inline">Threshold <select class="select" data-th><option value="3" selected>3 failures</option><option value="5">5 failures</option></select></label>
        <label class="field-inline">Cool-down <select class="select" data-cd><option value="4000" selected>4 s</option><option value="8000">8 s</option></select></label>
        <button class="btn btn-sm btn-primary" type="button" data-call>${icon('send')}Call</button>
        <label class="switch"><input type="checkbox" data-auto><span class="switch-track"></span>Traffic (3 calls/s)</label>`,
    });
    ui.body.innerHTML = `<div class="grid gap-3">
        <div class="cb-states">
          <div class="cb-state" data-s="closed"><div class="cb-state-name">CLOSED</div><div class="cb-state-desc">calls pass · failures counted</div></div>
          <div class="cb-state" data-s="open"><div class="cb-state-name">OPEN</div><div class="cb-state-desc">fail fast · <span data-cool>—</span></div></div>
          <div class="cb-state" data-s="half-open"><div class="cb-state-name">HALF-OPEN</div><div class="cb-state-desc">one probe allowed</div></div>
        </div>
        <div class="wg-stats">
          <div class="wg-stat"><div class="wg-stat-label">Consecutive failures</div><div class="wg-stat-value" data-f>0</div></div>
          <div class="wg-stat"><div class="wg-stat-label">Reached User Service</div><div class="wg-stat-value" data-reached>0</div></div>
          <div class="wg-stat"><div class="wg-stat-label">Failed fast</div><div class="wg-stat-value" data-fast>0</div></div>
          <div class="wg-stat"><div class="wg-stat-label">Time spent waiting</div><div class="wg-stat-value" data-wait>0 ms</div></div>
        </div>
        <div class="wg-panel"><div class="wg-panel-title">Last calls <span class="ml-auto normal-case tracking-normal font-normal flex gap-3"><span class="flex items-center gap-1"><span class="cb-tick is-ok"></span>success</span><span class="flex items-center gap-1"><span class="cb-tick is-fail"></span>failure (800 ms timeout)</span><span class="flex items-center gap-1"><span class="cb-tick is-fast"></span>rejected fast</span><span class="flex items-center gap-1"><span class="cb-tick is-probe"></span>probe</span></span></div><div class="cb-ticks" data-ticks></div></div>
        <div class="wg-panel"><div class="wg-panel-title">${icon('scroll-text', '', 13)}Events</div><div data-log></div></div>
      </div>`;
    const T = MV.wkit.timers();
    const log = MV.wkit.logger($('[data-log]', ui.body), 40);
    let health = 'healthy', state = 'closed', fails = 0, openedAt = 0, reached = 0, fast = 0, waited = 0;
    const ticks = [];
    const th = () => +$('[data-th]', el).value;
    const cd = () => +$('[data-cd]', el).value;
    function setState(s) {
      if (s === state) return;
      log.add(`state **${state.toUpperCase()} → ${s.toUpperCase()}**`, s === 'open' ? 'err' : s === 'closed' ? 'ok' : 'warn');
      state = s;
    }
    function call() {
      if (state === 'open' && Date.now() - openedAt >= cd()) setState('half-open');
      if (state === 'open') { fast++; ticks.push('fast'); render(); return; }
      const probe = state === 'half-open';
      reached++;
      const ok = health === 'healthy';
      waited += ok ? 6 : 800;
      if (ok) {
        ticks.push(probe ? 'probe' : 'ok');
        if (probe) log.add('probe succeeded', 'ok');
        fails = 0;
        setState('closed');
      } else {
        ticks.push(probe ? 'probe' : 'fail');
        fails++;
        if (probe) { log.add('probe failed — re-opening', 'err'); openedAt = Date.now(); setState('open'); }
        else if (fails >= th()) { openedAt = Date.now(); setState('open'); }
      }
      render();
    }
    function render() {
      while (ticks.length > 60) ticks.shift();
      $$('.cb-state', ui.body).forEach((s) => s.classList.toggle('is-on', s.dataset.s === state));
      const left = Math.max(0, cd() - (Date.now() - openedAt));
      $('[data-cool]', ui.body).textContent = state === 'open' ? `half-open in ${(left / 1000).toFixed(1)} s` : 'cool-down ' + cd() / 1000 + ' s';
      $('[data-f]', ui.body).textContent = `${fails}/${th()}`;
      $('[data-reached]', ui.body).textContent = reached;
      $('[data-fast]', ui.body).textContent = fast;
      $('[data-wait]', ui.body).textContent = waited >= 1000 ? `${(waited / 1000).toFixed(1)} s` : `${waited} ms`;
      $('[data-ticks]', ui.body).innerHTML = ticks.map((t) => `<span class="cb-tick is-${t}"></span>`).join('');
    }
    let acc = 0;
    T.interval(() => {
      if (state === 'open' && Date.now() - openedAt >= cd()) { setState('half-open'); }
      if ($('[data-auto]', el).checked) { acc += 0.1 * 3; while (acc >= 1) { acc -= 1; call(); } }
      render();
    }, 100);
    $$('[data-h]', el).forEach((b) => b.addEventListener('click', () => {
      health = b.dataset.h;
      $$('[data-h]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      log.add(health === 'healthy' ? 'User Service recovered' : 'User Service starts timing out (800 ms per call)', health === 'healthy' ? 'ok' : 'warn');
    }));
    $('[data-call]', el).addEventListener('click', call);
    render();
    log.add('Turn on traffic, set User Service to **Failing**, and watch the breaker open. Then recover it and wait for the probe.');
    return () => T.clear();
  };

  /* ======================================================================
     saga — orchestrated, with compensation
     ====================================================================== */
  const SAGA = [
    { id: 'order', name: 'Create order', svc: 'Order Service', action: 'INSERT order (PENDING)', comp: 'Mark order CANCELLED' },
    { id: 'pay', name: 'Charge payment', svc: 'Payment Service', action: 'Charge $42.00', comp: 'Refund $42.00' },
    { id: 'stock', name: 'Reserve inventory', svc: 'Inventory Service', action: 'Reserve 2 × sku-42', comp: 'Release reservation' },
    { id: 'ship', name: 'Schedule shipment', svc: 'Shipping Service', action: 'Book courier slot', comp: 'Cancel booking' },
    { id: 'confirm', name: 'Confirm order', svc: 'Order Service', action: 'status → CONFIRMED', comp: null },
  ];
  MV.widgets.saga = function (el) {
    const ui = MV.wkit.frame(el, {
      title: 'Order saga with compensating transactions',
      sub: 'Orchestrated by Order Service; each step is a local transaction',
      ico: 'workflow',
      controls: `<label class="field-inline">Fail at <select class="select" data-fail><option value="">no failure</option>${SAGA.slice(1).map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
        <label class="switch is-danger"><input type="checkbox" data-compfail><span class="switch-track"></span>Refund fails once (then retried)</label>
        <button class="btn btn-sm btn-primary" type="button" data-run>${icon('play')}Run saga</button>`,
    });
    ui.body.innerHTML = `<div class="wg-grid"><div class="sg-steps" data-steps></div>
      <div class="grid gap-3 content-start"><div class="wg-note" data-note>Choose where the saga fails and press <strong>Run saga</strong>.</div>
      <div class="wg-panel"><div class="wg-panel-title">${icon('database', '', 13)}saga_state (orders-db)</div><div class="mono text-[12px]" data-sstate>—</div></div>
      <div class="wg-panel"><div class="wg-panel-title">${icon('scroll-text', '', 13)}Events</div><div data-log></div></div></div></div>`;
    let alive = true, busy = false;
    const log = MV.wkit.logger($('[data-log]', ui.body), 40);
    const st = {};
    function render() {
      $('[data-steps]', ui.body).innerHTML = SAGA.map((s, i) => `<div class="sg-step" data-s="${st[s.id] || 'idle'}"><span class="sg-n">${i + 1}</span><div class="min-w-0"><div class="sg-step-name">${esc(s.name)}</div><div class="sg-step-sub">${esc(s.svc)} · ${esc(st[s.id] === 'compensated' || st[s.id] === 'compensating' ? s.comp : s.action)}</div></div>
        <span class="pill ${({ done: 'is-ok', failed: 'is-err', compensated: 'is-purple', compensating: 'is-purple', running: 'is-info' })[st[s.id]] || 'is-muted'}">${({ done: 'done', failed: 'failed', compensated: 'compensated', compensating: 'compensating…', running: 'running…' })[st[s.id]] || 'pending'}</span></div>`).join('');
    }
    const setSS = (txt) => { $('[data-sstate]', ui.body).textContent = txt; };
    async function run() {
      if (busy) return;
      busy = true;
      $('[data-run]', el).disabled = true;
      SAGA.forEach((s) => { st[s.id] = 'idle'; });
      log.clear();
      const failAt = $('[data-fail]', el).value;
      const compFail = $('[data-compfail]', el).checked;
      const note = $('[data-note]', ui.body);
      note.className = 'wg-note'; note.textContent = 'Running…';
      const wait = (ms) => MV.wkit.sleep(ms, () => alive);
      try {
        let failedIdx = -1;
        for (let i = 0; i < SAGA.length; i++) {
          const s = SAGA[i];
          st[s.id] = 'running'; render(); setSS(`saga 8812 · step=${s.id} · status=RUNNING`);
          await wait(650);
          if (s.id === failAt) {
            st[s.id] = 'failed'; render();
            log.add(`${s.svc}: **${s.name} failed** (${s.id === 'stock' ? 'out of stock' : s.id === 'pay' ? 'card declined' : 'no courier capacity'})`, 'err');
            failedIdx = i;
            break;
          }
          st[s.id] = 'done'; render();
          log.add(`${s.svc}: ${s.action} — committed locally`, 'ok');
          setSS(`saga 8812 · completed=${s.id} · status=RUNNING`);
        }
        if (failedIdx < 0) {
          setSS('saga 8812 · status=COMPLETED');
          note.className = 'wg-note is-ok';
          note.innerHTML = 'All steps committed. The order is <strong>CONFIRMED</strong>. Between steps the system was briefly inconsistent (paid, not yet reserved) — that is normal for a saga.';
        } else {
          setSS(`saga 8812 · status=COMPENSATING from ${SAGA[failedIdx].id}`);
          log.add('no distributed rollback exists — running compensations in reverse order', 'warn');
          for (let i = failedIdx - 1; i >= 0; i--) {
            const s = SAGA[i];
            if (!s.comp) continue;
            st[s.id] = 'compensating'; render();
            await wait(650);
            if (s.id === 'pay' && compFail) {
              log.add('Payment Service: refund timed out — compensation will be retried (it is idempotent: refund key = saga id)', 'err');
              await wait(900);
              log.add('retry #1: refund succeeded', 'ok');
            }
            st[s.id] = 'compensated'; render();
            log.add(`${s.svc}: ${s.comp}`, 'async');
          }
          setSS('saga 8812 · status=CANCELLED');
          note.className = 'wg-note is-warn';
          note.innerHTML = `The saga failed at <strong>${esc(SAGA[failedIdx].name)}</strong> and compensated every completed step in reverse. The end state is consistent: order <strong>CANCELLED</strong>${failedIdx > 1 ? ', customer refunded' : ''}. ${compFail && failedIdx > 1 ? 'The refund failed once and was retried — compensations must be idempotent and must eventually succeed.' : ''}`;
        }
      } catch (e) { /* disposed */ }
      busy = false;
      const b = $('[data-run]', el); if (b) b.disabled = false;
    }
    $('[data-run]', el).addEventListener('click', run);
    $('[data-fail]', el).value = 'stock';
    render();
    return () => { alive = false; };
  };

  /* ======================================================================
     idempotency — impatient clicks and lost responses
     ====================================================================== */
  MV.widgets.idempotency = function (el) {
    const ui = MV.wkit.frame(el, {
      title: 'Place order — as impatiently as you like',
      sub: 'The mobile app retries automatically when a response is lost',
      ico: 'fingerprint',
      controls: `<label class="switch is-success"><input type="checkbox" data-key checked><span class="switch-track"></span>Send Idempotency-Key</label>
        <label class="switch is-danger"><input type="checkbox" data-flaky checked><span class="switch-track"></span>Flaky network (50% of responses lost)</label>
        <button class="btn btn-sm btn-primary" type="button" data-place>${icon('shopping-cart')}Place order ($42)</button>
        <button class="btn btn-sm btn-ghost" type="button" data-new>${icon('rotate-ccw')}New checkout</button>`,
    });
    ui.body.innerHTML = `<div class="wg-grid">
        <div class="grid gap-3 content-start">
          <div class="wg-stats">
            <div class="wg-stat"><div class="wg-stat-label">Customer intended</div><div class="wg-stat-value" data-intent>1 order</div></div>
            <div class="wg-stat"><div class="wg-stat-label">Orders created</div><div class="wg-stat-value" data-orders>0</div></div>
            <div class="wg-stat"><div class="wg-stat-label">Card charged</div><div class="wg-stat-value" data-charged>$0</div></div>
          </div>
          <div class="wg-note" data-note>Click <strong>Place order</strong> several times quickly.</div>
          <div class="wg-panel"><div class="wg-panel-title">${icon('key-round', '', 13)}Client state</div><div class="mono text-[12px]" data-client></div></div>
        </div>
        <div class="grid gap-3 content-start">
          <div class="wg-panel"><div class="wg-panel-title">${icon('database', '', 13)}orders-db</div><div class="table-wrap"><table class="table" data-table></table></div></div>
          <div class="wg-panel"><div class="wg-panel-title">${icon('scroll-text', '', 13)}Requests</div><div data-log></div></div>
        </div>
      </div>`;
    const T = MV.wkit.timers();
    const log = MV.wkit.logger($('[data-log]', ui.body), 60);
    let orders = [], keys = new Map(), nextId = 8812, intentKey = null, attemptN = 0;
    const newKey = () => Math.random().toString(16).slice(2, 10) + '-' + Math.random().toString(16).slice(2, 6);
    function newCheckout() { intentKey = newKey(); render(); }
    function server(key) {
      if (key && keys.has(key)) return { replay: true, order: keys.get(key) };
      const o = { id: nextId++, key: key || '—', at: new Date().toLocaleTimeString() };
      orders.push(o);
      if (key) keys.set(key, o);
      return { replay: false, order: o };
    }
    function attempt(n) {
      const useKey = $('[data-key]', el).checked;
      const key = useKey ? intentKey : null;
      attemptN++;
      const res = server(key);
      const lost = $('[data-flaky]', el).checked && Math.random() < 0.5;
      const label = `POST /orders ${useKey ? `· Idempotency-Key: ${key}` : '(no key)'}`;
      if (res.replay) log.add(`${label} → **201 replayed** (order #${res.order.id}, \`Idempotent-Replayed: true\`)${lost ? ' — response lost again' : ''}`, 'ok');
      else log.add(`${label} → order **#${res.order.id} created**${lost ? ' — but the response was lost' : ''}`, lost ? 'warn' : 'ok');
      if (lost && n < 3) T.timeout(() => { log.add(`client timed out → automatic retry #${n}`, 'warn'); attempt(n + 1); }, 450);
      render();
    }
    function render() {
      const n = orders.length;
      $('[data-orders]', ui.body).textContent = n;
      $('[data-orders]', ui.body).className = 'wg-stat-value ' + (n > 1 ? 'is-err' : n === 1 ? 'is-ok' : '');
      $('[data-charged]', ui.body).textContent = `$${n * 42}`;
      $('[data-charged]', ui.body).className = 'wg-stat-value ' + (n > 1 ? 'is-err' : '');
      $('[data-client]', ui.body).innerHTML = $('[data-key]', el).checked ? `checkout session key: <span style="color:var(--cyan)">${intentKey}</span><br><span class="text-mutedc">reused for every click and retry of this checkout</span>` : '<span class="text-mutedc">no key — each click and retry is a brand-new request</span>';
      $('[data-table]', ui.body).innerHTML = `<thead><tr><th>id</th><th>idempotency key</th><th>created</th></tr></thead><tbody>${orders.length ? orders.map((o) => `<tr><td class="mono">#${o.id}</td><td class="mono">${o.key}</td><td class="mono">${o.at}</td></tr>`).join('') : '<tr><td colspan="3" class="text-mutedc">no orders yet</td></tr>'}</tbody>`;
      const note = $('[data-note]', ui.body);
      if (n > 1) { note.className = 'wg-note is-err'; note.innerHTML = `<strong>Double charged:</strong> the customer wanted one order and got ${n}. Every click and automatic retry looked like a new order to the server.`; }
      else if (n === 1 && attemptN > 1) { note.className = 'wg-note is-ok'; note.innerHTML = `<strong>${attemptN} requests, 1 order.</strong> Retries carried the same key, so the server returned the stored result instead of creating another order.`; }
      else { note.className = 'wg-note'; note.innerHTML = 'Click <strong>Place order</strong> several times quickly.'; }
    }
    $('[data-place]', el).addEventListener('click', () => attempt(1));
    $('[data-new]', el).addEventListener('click', () => { orders = []; keys = new Map(); attemptN = 0; log.clear(); newCheckout(); });
    $('[data-key]', el).addEventListener('change', render);
    newCheckout();
    return () => T.clear();
  };

  /* ======================================================================
     load-balancer — algorithms vs uneven request cost and a slow instance
     ====================================================================== */
  const ALGOS = { rr: 'Round robin', random: 'Random', p2c: 'Power of two choices', least: 'Least requests' };
  function simulateLB(algo, slow) {
    const N = 4, REQ = 400, INTERVAL = 4; // a request every 4 ms (250 req/s)
    const inst = Array.from({ length: N }, (_, i) => ({ i, active: [], served: 0, maxActive: 0, factor: slow && i === 2 ? 5 : 1 }));
    const lat = [];
    let rr = 0;
    for (let k = 0; k < REQ; k++) {
      const t = k * INTERVAL;
      inst.forEach((s) => { s.active = s.active.filter((end) => end > t); });
      let pick;
      if (algo === 'rr') pick = inst[rr++ % N];
      else if (algo === 'random') pick = inst[Math.floor(Math.random() * N)];
      else if (algo === 'p2c') { const a = inst[Math.floor(Math.random() * N)], b = inst[Math.floor(Math.random() * N)]; pick = a.active.length <= b.active.length ? a : b; }
      else pick = inst.reduce((m, s) => (s.active.length < m.active.length ? s : m), inst[0]);
      const base = Math.random() < 0.1 ? 400 : 20;
      const queuePenalty = Math.max(0, pick.active.length - 3) * 15; // contention when busy
      const d = base * pick.factor + queuePenalty;
      pick.active.push(t + d);
      pick.served++;
      pick.maxActive = Math.max(pick.maxActive, pick.active.length);
      lat.push(d);
    }
    lat.sort((a, b) => a - b);
    const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
    return { inst, p50: q(0.5), p99: q(0.99) };
  }
  MV.widgets['load-balancer'] = function (el) {
    const ui = MV.wkit.frame(el, {
      title: 'Load-balancing algorithms',
      sub: '400 requests at 250 req/s · 90% take 20 ms, 10% take 400 ms',
      ico: 'split',
      controls: `<div class="segmented" role="group" aria-label="Algorithm">${Object.entries(ALGOS).map(([k, v], i) => `<button type="button" data-algo="${k}" aria-pressed="${i === 0}">${v}</button>`).join('')}</div>
        <label class="switch is-danger"><input type="checkbox" data-slow checked><span class="switch-track"></span>Instance #3 is slow (5×)</label>
        <button class="btn btn-sm btn-primary" type="button" data-run>${icon('play')}Run</button>`,
    });
    ui.body.innerHTML = `<div class="grid gap-3"><div class="lb-insts" data-insts></div>
      <div class="wg-stats"><div class="wg-stat"><div class="wg-stat-label">p50 latency</div><div class="wg-stat-value" data-p50>—</div></div><div class="wg-stat"><div class="wg-stat-label">p99 latency</div><div class="wg-stat-value" data-p99>—</div></div><div class="wg-stat"><div class="wg-stat-label">Requests on slow #3</div><div class="wg-stat-value" data-slowshare>—</div></div></div>
      <div class="wg-panel"><div class="wg-panel-title">${icon('table', '', 13)}Comparison (same traffic)</div><div class="table-wrap"><table class="table" data-cmp></table></div></div>
      <div class="wg-note" data-note></div></div>`;
    let algo = 'rr';
    const NOTES = {
      rr: 'Round robin ignores load: the slow instance gets exactly a quarter of the traffic, its requests pile up, and they dominate the p99.',
      random: 'Random is as blind as round robin, with extra variance from unlucky streaks.',
      p2c: 'Power of two choices samples two instances and picks the less busy one — nearly as good as least-requests, with no global view needed.',
      least: 'Least requests sends new work to the instance with the fewest in-flight requests, so the slow instance naturally receives less.',
    };
    function run() {
      const slow = $('[data-slow]', el).checked;
      const r = simulateLB(algo, slow);
      const total = r.inst.reduce((s, x) => s + x.served, 0);
      $('[data-insts]', ui.body).innerHTML = r.inst.map((s) => `<div class="lb-inst${s.factor > 1 ? ' is-slow' : ''}"><div class="lb-inst-name"><span>order-service #${s.i + 1}</span>${s.factor > 1 ? '<span class="pill is-warn">slow</span>' : ''}</div>
        <div class="text-[12px] mt-2">served <strong style="color:var(--fg)">${s.served}</strong> (${Math.round((s.served / total) * 100)}%)</div>
        <div class="meter mt-1${s.maxActive > 8 ? ' is-err' : s.maxActive > 4 ? ' is-warn' : ''}"><span style="width:${Math.min(100, s.maxActive * 7)}%"></span></div><div class="text-[11px] text-mutedc mt-1">max in-flight ${s.maxActive}</div></div>`).join('');
      $('[data-p50]', ui.body).textContent = `${Math.round(r.p50)} ms`;
      $('[data-p99]', ui.body).textContent = `${Math.round(r.p99)} ms`;
      $('[data-p99]', ui.body).className = 'wg-stat-value ' + (r.p99 > 1500 ? 'is-err' : r.p99 > 600 ? 'is-warn' : 'is-ok');
      $('[data-slowshare]', ui.body).textContent = slow ? `${Math.round((r.inst[2].served / total) * 100)}%` : 'n/a';
      const rows = Object.entries(ALGOS).map(([k, v]) => { const x = simulateLB(k, slow); return `<tr style="${k === algo ? 'background:color-mix(in srgb,var(--blue) 8%,transparent)' : ''}"><td style="color:var(--fg)">${v}</td><td class="tabular">${Math.round(x.p50)} ms</td><td class="tabular">${Math.round(x.p99)} ms</td><td class="tabular">${slow ? Math.round((x.inst[2].served / 400) * 100) + '%' : '—'}</td></tr>`; }).join('');
      $('[data-cmp]', ui.body).innerHTML = `<thead><tr><th>Algorithm</th><th>p50</th><th>p99</th><th>Share on slow #3</th></tr></thead><tbody>${rows}</tbody>`;
      $('[data-note]', ui.body).innerHTML = MV.ui.inlineMd(NOTES[algo]);
      $('[data-note]', ui.body).className = 'wg-note' + (algo === 'least' || algo === 'p2c' ? ' is-ok' : slow ? ' is-warn' : '');
    }
    $$('[data-algo]', el).forEach((b) => b.addEventListener('click', () => { algo = b.dataset.algo; $$('[data-algo]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); run(); }));
    $('[data-slow]', el).addEventListener('change', run);
    $('[data-run]', el).addEventListener('click', run);
    run();
  };
})(window.MV);
