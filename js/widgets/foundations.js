/* ==========================================================================
   Widget: arch-compare — the same features on three architectures.
   Send requests through a monolith, a modular monolith and microservices,
   fail a component, and compare the blast radius side by side.
   ========================================================================== */
(function (MV) {
  'use strict';
  const { $, $$, esc, icon } = MV.ui;

  const ARCH = {
    monolith: {
      label: 'Monolith',
      spec: {
        w: 760, h: 300,
        nodes: [
          { id: 'client', label: 'Client', sub: 'browser', x: 70, y: 150, kind: 'client', w: 116 },
          { id: 'lb', label: 'Load balancer', x: 215, y: 150, kind: 'infra', icon: 'split', w: 140 },
          { id: 'app', label: 'shop (one process)', sub: 'users · orders · payments · notify', x: 435, y: 150, kind: 'service', w: 240, h: 66 },
          { id: 'db', label: 'PostgreSQL', sub: 'one shared schema', x: 665, y: 150, kind: 'db', w: 160 },
        ],
        edges: [{ id: 'e1', from: 'client', to: 'lb' }, { id: 'e2', from: 'lb', to: 'app' }, { id: 'e3', from: 'app', to: 'db' }],
      },
    },
    modular: {
      label: 'Modular monolith',
      spec: {
        w: 780, h: 320,
        groups: [{ label: 'shop — one process · enforced module APIs', x: 236, y: 16, w: 336, h: 290, color: 'blue' }],
        nodes: [
          { id: 'client', label: 'Client', x: 62, y: 160, kind: 'client', w: 100, h: 44 },
          { id: 'lb', label: 'LB', x: 175, y: 160, kind: 'infra', w: 70, h: 44 },
          { id: 'users', label: 'users', sub: 'users.API', x: 320, y: 95, kind: 'module', w: 140 },
          { id: 'orders', label: 'orders', sub: 'orders.API', x: 490, y: 95, kind: 'module', w: 140 },
          { id: 'pay', label: 'payments', sub: 'payments.API', x: 320, y: 230, kind: 'module', w: 140 },
          { id: 'notify', label: 'notify', sub: 'notify.API', x: 490, y: 230, kind: 'module', w: 140 },
          { id: 'db', label: 'PostgreSQL', sub: 'tables per module', x: 685, y: 160, kind: 'db', w: 160 },
        ],
        edges: [
          { id: 'e1', from: 'client', to: 'lb' }, { id: 'lu', from: 'lb', to: 'users' }, { id: 'lo', from: 'lb', to: 'orders', curve: -40 },
          { id: 'ou', from: 'orders', to: 'users' }, { id: 'op', from: 'orders', to: 'pay' }, { id: 'on', from: 'orders', to: 'notify' },
          { id: 'od', from: 'orders', to: 'db' }, { id: 'ud', from: 'users', to: 'db', curve: -70 },
        ],
      },
    },
    micro: {
      label: 'Microservices',
      spec: {
        w: 860, h: 360,
        nodes: [
          { id: 'client', label: 'Client', x: 66, y: 180, kind: 'client', w: 108 },
          { id: 'gw', label: 'API Gateway', x: 210, y: 180, kind: 'gateway', w: 140 },
          { id: 'users', label: 'User Service', x: 420, y: 60, kind: 'service', w: 160 },
          { id: 'orders', label: 'Order Service', x: 420, y: 180, kind: 'service', w: 160 },
          { id: 'pay', label: 'Payment Service', x: 420, y: 300, kind: 'service', w: 160 },
          { id: 'usersdb', label: 'users-db', x: 640, y: 60, kind: 'db', w: 140 },
          { id: 'ordersdb', label: 'orders-db', x: 640, y: 180, kind: 'db', w: 140 },
          { id: 'broker', label: 'RabbitMQ', x: 640, y: 300, kind: 'broker', w: 140 },
          { id: 'notify', label: 'Notify', sub: 'consumer', x: 795, y: 300, kind: 'worker', w: 110 },
        ],
        edges: [
          { id: 'e1', from: 'client', to: 'gw' }, { id: 'e2', from: 'gw', to: 'orders' }, { id: 'e3', from: 'gw', to: 'users' },
          { id: 'e4', from: 'users', to: 'usersdb' }, { id: 'e5', from: 'orders', to: 'ordersdb' }, { id: 'e6', from: 'orders', to: 'users' },
          { id: 'e7', from: 'orders', to: 'pay' }, { id: 'e8', from: 'orders', to: 'broker' }, { id: 'e9', from: 'broker', to: 'notify' },
        ],
      },
    },
  };

  const FAILURES = [
    { id: 'none', label: 'Nothing (healthy)' },
    { id: 'users', label: 'Users component crashes' },
    { id: 'payments', label: 'Payments component crashes' },
    { id: 'notify', label: 'Notifications component crashes' },
    { id: 'database', label: 'Orders database unavailable' },
  ];
  const FEATURES = { checkout: 'Checkout (POST /orders)', profile: 'View profile (GET /users/me)' };
  const LAT = { monolith: { checkout: 18, profile: 4 }, modular: { checkout: 19, profile: 4 }, micro: { checkout: 46, profile: 9 } };

  /** What happens to each feature: 'ok' | 'fail' | 'delayed' */
  function outcome(arch, failure, feature) {
    if (failure === 'none') return 'ok';
    if (arch !== 'micro') {
      if (feature === 'emails') return 'fail';
      return 'fail'; // one process (or one shared DB): every feature is down
    }
    const table = {
      users: { checkout: 'fail', profile: 'fail', emails: 'ok' },
      payments: { checkout: 'fail', profile: 'ok', emails: 'ok' },
      notify: { checkout: 'ok', profile: 'ok', emails: 'delayed' },
      database: { checkout: 'fail', profile: 'ok', emails: 'ok' },
    };
    return table[failure][feature];
  }

  const EXPLAIN = {
    monolith: {
      none: 'Every feature runs in one process. Calls between users, orders and payments are function calls — fast and atomic, with one database transaction.',
      crash: 'A crash in any module kills the shared process, so **every** feature fails — including ones that never touch the broken code.',
      database: 'Every feature shares one database, so its outage stops everything.',
    },
    modular: {
      none: 'Same single process, but modules talk only through public APIs and own their tables. Refactoring stays cheap and a later split is feasible.',
      crash: 'Clean boundaries do not create fault isolation: it is still **one process**, so a crash still takes every feature down.',
      database: 'Tables are owned per module, but they live in one database instance — an outage still affects everything.',
    },
    micro: {
      none: 'Checkout crosses the network three times (users, payments, orders-db) and emits an event. Higher latency, but each service fails independently.',
      users: 'Checkout **and** profile fail: Order Service validates the customer synchronously, so it shares User Service\'s outage. Isolation is only as good as your synchronous call graph.',
      payments: 'Checkout fails (payment is on the request path) but profiles keep working — the failure is contained to features that need payments.',
      notify: 'Everything keeps working. The `order.created` event waits in RabbitMQ and emails go out when Notification Service recovers.',
      database: 'Only Order Service owns orders-db, so checkout fails while profiles (users-db) keep working.',
    },
  };

  MV.widgets['arch-compare'] = function (el) {
    const ui = MV.wkit.frame(el, {
      title: 'One system, three architectures',
      sub: 'Send requests, break a component, compare the blast radius',
      ico: 'blocks',
      controls: `<div class="segmented" role="group" aria-label="Architecture">${Object.entries(ARCH).map(([k, a], i) => `<button type="button" data-arch="${k}" aria-pressed="${i === 0}">${esc(a.label)}</button>`).join('')}</div>
        <label class="field-inline">Request <select class="select" data-feature>${Object.entries(FEATURES).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}</select></label>
        <label class="field-inline">Failure <select class="select" data-failure>${FAILURES.map((f) => `<option value="${f.id}">${esc(f.label)}</option>`).join('')}</select></label>
        <button class="btn btn-primary btn-sm" type="button" data-send>${icon('send')}Send request</button>`,
    });
    ui.body.innerHTML = `<div class="grid gap-3">
        <div data-dg></div>
        <div class="wg-grid">
          <div class="grid gap-3 content-start">
            <div class="wg-stats">
              <div class="wg-stat"><div class="wg-stat-label">Result</div><div class="wg-stat-value" data-r-status>—</div></div>
              <div class="wg-stat"><div class="wg-stat-label">Latency</div><div class="wg-stat-value" data-r-lat>—</div></div>
              <div class="wg-stat"><div class="wg-stat-label">Network hops</div><div class="wg-stat-value" data-r-hops>—</div></div>
            </div>
            <div class="wg-note" data-explain></div>
          </div>
          <div class="wg-panel"><div class="wg-panel-title">${icon('radar', '', 13)}Blast radius of this failure</div><table class="ac-matrix" data-matrix></table></div>
        </div>
        <div class="wg-panel"><div class="wg-panel-title">${icon('scroll-text', '', 13)}Request log</div><div data-log></div></div>
      </div>`;

    const T = MV.wkit.timers();
    let alive = true;
    let arch = 'monolith', diagram = null, busy = false;
    const log = MV.wkit.logger($('[data-log]', ui.body), 40);
    const feature = () => $('[data-feature]', el).value;
    const failure = () => $('[data-failure]', el).value;

    function drawDiagram() {
      if (diagram) diagram.destroy();
      diagram = MV.diagram.create($('[data-dg]', ui.body), ARCH[arch].spec, { minScale: 0.55 });
      applyFailureStates();
    }

    function applyFailureStates() {
      const f = failure();
      diagram.resetStates();
      if (f === 'none') return;
      if (arch === 'monolith') diagram.setState(f === 'database' ? 'db' : 'app', 'down');
      else if (arch === 'modular') {
        if (f === 'database') diagram.setState('db', 'down');
        else ['users', 'orders', 'pay', 'notify'].forEach((n) => diagram.setState(n, 'down'));
      } else {
        const map = { users: 'users', payments: 'pay', notify: 'notify', database: 'ordersdb' };
        diagram.setState(map[f], 'down');
      }
      renderMatrix();
    }

    function renderMatrix() {
      const f = failure();
      const cell = (o) => o === 'ok' ? `<span class="pill is-ok">${icon('circle-check')}Works</span>` : o === 'delayed' ? `<span class="pill is-warn">${icon('clock')}Delayed</span>` : `<span class="pill is-err">${icon('circle-x')}Fails</span>`;
      $('[data-matrix]', ui.body).innerHTML = `<thead><tr><th>Architecture</th><th>Checkout</th><th>Profile</th><th>Emails</th></tr></thead><tbody>
        ${Object.entries(ARCH).map(([k, a]) => `<tr class="${k === arch ? 'is-current' : ''}"><td style="color:var(--fg)">${esc(a.label)}</td><td>${cell(outcome(k, f, 'checkout'))}</td><td>${cell(outcome(k, f, 'profile'))}</td><td>${cell(outcome(k, f, 'emails'))}</td></tr>`).join('')}</tbody>`;
      const ex = EXPLAIN[arch];
      const text = f === 'none' ? ex.none : arch === 'micro' ? ex[f] : f === 'database' ? ex.database : ex.crash;
      const note = $('[data-explain]', ui.body);
      note.innerHTML = MV.ui.inlineMd(text);
      note.className = 'wg-note' + (f === 'none' ? '' : outcome(arch, f, feature()) === 'fail' ? ' is-err' : ' is-ok');
    }

    async function hops(list, color) {
      for (const h of list) {
        if (!alive) return;
        const rev = h.startsWith('-');
        await diagram.packet(rev ? h.slice(1) : h, { reverse: rev, color: color || (rev ? 'green' : 'blue'), duration: 420 });
      }
    }

    async function send() {
      if (busy) return;
      busy = true;
      $('[data-send]', el).disabled = true;
      const f = failure(), feat = feature();
      const res = outcome(arch, f, feat);
      const st = (s, cls) => { const e = $('[data-r-status]', ui.body); e.textContent = s; e.className = 'wg-stat-value ' + cls; };
      try {
        if (arch === 'monolith') {
          if (res === 'ok') {
            await hops(['e1', 'e2']);
            diagram.pulseNode('app', 'blue');
            log.add(feat === 'checkout' ? 'in-process calls: `users.Get()` → `payments.Charge()` → `notify.Send()` (nanoseconds each)' : 'in-process call: `users.GetProfile()`');
            await MV.wkit.sleep(350, () => alive);
            await hops(['e3', '-e3', '-e2', '-e1']);
          } else {
            await hops(['e1']);
            await diagram.packet(f === 'database' ? 'e2' : 'e2', { color: 'err', duration: 420 });
            if (f === 'database') await diagram.packet('e3', { color: 'err', duration: 420 });
            log.add(f === 'database' ? '`dial tcp postgres:5432: connection refused` — every module shares this database' : `process exited: panic in the ${f} module — the whole binary is down`, 'err');
          }
        } else if (arch === 'modular') {
          if (res === 'ok') {
            await hops(['e1']);
            if (feat === 'checkout') {
              await hops(['lo']);
              log.add('module API calls: `users.API.IsActive()` → `payments.API.Charge()` → `notify.API.Send()`');
              await hops(['ou', '-ou', 'op', '-op', 'on', '-on', 'od', '-od', '-lo', '-e1']);
            } else await hops(['lu', 'ud', '-ud', '-lu', '-e1']);
          } else {
            await hops(['e1']);
            await diagram.packet(feat === 'checkout' ? 'lo' : 'lu', { color: 'err', duration: 420 });
            log.add(f === 'database' ? 'database unavailable — module boundaries do not change that it is shared' : `process exited: panic in the ${f} module — clean boundaries, same process`, 'err');
          }
        } else {
          if (feat === 'profile') {
            if (res === 'ok') await hops(['e1', 'e3', 'e4', '-e4', '-e3', '-e1']);
            else { await hops(['e1']); await diagram.packet('e3', { color: 'err', duration: 420 }); log.add('gateway → user-service: `connection refused` → 502', 'err'); }
          } else {
            await hops(['e1', 'e2']);
            if (f === 'users') { await diagram.packet('e6', { color: 'err', duration: 420 }); log.add('order-service → user-service: `connection refused` → order rejected with 503', 'err'); }
            else {
              await hops(['e6', '-e6']);
              if (f === 'payments') { await diagram.packet('e7', { color: 'err', duration: 420 }); log.add('order-service → payment-service: `connection refused` → 503; profiles unaffected', 'err'); }
              else {
                await hops(['e7', '-e7']);
                if (f === 'database') { await diagram.packet('e5', { color: 'err', duration: 420 }); log.add('order-service → orders-db: connection refused → 503 (users-db is fine)', 'err'); }
                else {
                  await hops(['e5', '-e5', '-e2', '-e1']);
                  log.add('201 Created returned to the client', 'ok');
                  await hops(['e8'], 'purple');
                  if (f === 'notify') { diagram.setBadge('broker', '+1'); log.add('`order.created` queued in RabbitMQ — Notification Service is down; email will be sent on recovery', 'warn'); }
                  else { await hops(['e9'], 'purple'); log.add('Notification Service consumed `order.created` and sent the email (async)', 'async'); }
                }
              }
            }
          }
        }
        if (!alive) return;
        const lat = LAT[arch][feat];
        st(res === 'ok' ? (feat === 'checkout' ? '201' : '200') : arch === 'micro' && f === 'users' && feat === 'profile' ? '502' : '503', res === 'ok' ? 'is-ok' : 'is-err');
        $('[data-r-lat]', ui.body).textContent = res === 'ok' ? `${lat} ms` : arch === 'micro' ? '~3 ms (fast fail)' : '—';
        $('[data-r-hops]', ui.body).textContent = arch === 'micro' ? (feat === 'checkout' ? '5 + 1 async' : '3') : feat === 'checkout' ? '2' : '2';
        if (res === 'ok' && f === 'none') log.add(`${ARCH[arch].label}: ${feat} succeeded in ${lat} ms`, 'ok');
      } catch (e) {
        if (alive) console.error(e);
      } finally {
        busy = false;
        const b = $('[data-send]', el);
        if (b) b.disabled = false;
      }
    }

    $$('[data-arch]', el).forEach((b) => b.addEventListener('click', () => {
      if (busy) return;
      arch = b.dataset.arch;
      $$('[data-arch]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      ['[data-r-status]', '[data-r-lat]', '[data-r-hops]'].forEach((s) => { const e = $(s, ui.body); e.textContent = '—'; e.className = 'wg-stat-value'; });
      drawDiagram();
      renderMatrix();
    }));
    $('[data-failure]', el).addEventListener('change', () => { applyFailureStates(); renderMatrix(); });
    $('[data-feature]', el).addEventListener('change', renderMatrix);
    $('[data-send]', el).addEventListener('click', send);

    drawDiagram();
    renderMatrix();
    log.add('Pick an architecture, choose a failure, and press **Send request**.');
    return () => { alive = false; T.clear(); if (diagram) diagram.destroy(); };
  };
})(window.MV);
