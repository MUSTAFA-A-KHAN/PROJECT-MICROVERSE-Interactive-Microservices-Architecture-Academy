/* ==========================================================================
   Widgets: compose-sim (docker compose up/down with health-gated startup)
   and k8s-sim (Deployment, HPA and rolling updates).
   ========================================================================== */
(function (MV) {
  'use strict';
  const { $, $$, esc, icon } = MV.ui;

  /* ======================================================================
     compose-sim — mirrors codebase/order-management/docker-compose.yml
     ====================================================================== */
  const SVCS = [
    { id: 'users-db', boot: 2200, health: true, deps: [] },
    { id: 'orders-db', boot: 2200, health: true, deps: [] },
    { id: 'redis', boot: 800, health: true, deps: [] },
    { id: 'rabbitmq', boot: 4200, health: true, deps: [] },
    { id: 'users-migrate', boot: 1200, oneshot: true, deps: [['users-db', 'service_healthy']] },
    { id: 'orders-migrate', boot: 1200, oneshot: true, deps: [['orders-db', 'service_healthy']] },
    { id: 'user-service', boot: 1000, health: true, deps: [['users-db', 'service_healthy'], ['users-migrate', 'service_completed_successfully'], ['redis', 'service_healthy']] },
    { id: 'order-service', boot: 1000, health: true, deps: [['orders-db', 'service_healthy'], ['orders-migrate', 'service_completed_successfully'], ['rabbitmq', 'service_started']] },
    { id: 'notification-service', boot: 800, health: false, deps: [['rabbitmq', 'service_healthy'], ['redis', 'service_healthy']] },
    { id: 'api-gateway', boot: 900, health: true, deps: [['redis', 'service_healthy'], ['user-service', 'service_healthy'], ['order-service', 'service_healthy']] },
  ];
  const PILL = { stopped: ['is-muted', 'stopped'], waiting: ['is-info', 'waiting'], starting: ['is-info', 'starting'], healthy: ['is-ok', 'healthy'], running: ['is-ok', 'running'], exited: ['is-muted', 'exited (0)'], restarting: ['is-warn', 'restarting'] };

  MV.widgets['compose-sim'] = function (el) {
    const ui = MV.wkit.frame(el, {
      title: 'docker compose — Order Management System',
      sub: 'Health checks and depends_on conditions decide the start order',
      ico: 'container',
      controls: `<button class="btn btn-sm btn-primary" type="button" data-up>${icon('play')}docker compose up</button>
        <button class="btn btn-sm" type="button" data-down>${icon('square')}docker compose down</button>
        <button class="btn btn-sm" type="button" data-curl>${icon('terminal')}curl POST /api/v1/orders</button>`,
    });
    ui.body.innerHTML = `<div class="grid gap-3"><div class="cs-grid" data-grid></div>
      <div class="wg-note" data-note>Press <strong>docker compose up</strong>. Then stop a dependency (a database, Redis or RabbitMQ) and send a request.</div>
      <div class="wg-panel"><div class="wg-panel-title">${icon('terminal', '', 13)}Output</div><div class="cs-out" data-log></div></div></div>`;
    const T = MV.wkit.timers();
    const log = MV.wkit.logger($('[data-log]', ui.body), 120);
    const S = Object.fromEntries(SVCS.map((s) => [s.id, { state: 'stopped', since: 0, why: '' }]));
    const def = (id) => SVCS.find((s) => s.id === id);
    const isUp = (id) => ['healthy', 'running'].includes(S[id].state);

    function depsOk(svc) {
      const missing = svc.deps.filter(([d, cond]) => {
        const s = S[d].state;
        if (cond === 'service_healthy') return s !== 'healthy';
        if (cond === 'service_completed_successfully') return s !== 'exited';
        return !['starting', 'healthy', 'running'].includes(s);
      });
      return missing;
    }
    function set(id, state, why = '') {
      if (S[id].state === state && S[id].why === why) return;
      S[id].state = state; S[id].since = performance.now(); S[id].why = why;
    }
    function tick() {
      const now = performance.now();
      SVCS.forEach((svc) => {
        const s = S[svc.id];
        if (s.state === 'waiting') {
          const miss = depsOk(svc);
          if (!miss.length) { set(svc.id, 'starting'); log.add(`**${svc.id}** Started`); }
          else s.why = `waiting: ${miss.map(([d, c]) => `${d} (${c.replace('service_', '')})`).join(', ')}`;
        } else if (s.state === 'starting' && now - s.since > svc.boot) {
          if (svc.oneshot) { set(svc.id, 'exited', 'migrations applied: 1/u create_' + (svc.id.startsWith('users') ? 'users' : 'orders')); log.add(`**${svc.id}** Exited (0) — schema version 1`, 'ok'); }
          else if (svc.health) { set(svc.id, 'healthy'); log.add(`**${svc.id}** Healthy`, 'ok'); }
          else { set(svc.id, 'running'); log.add(`**${svc.id}** consuming notifications.order-events (prefetch 20)`, 'ok'); }
        } else if (s.state === 'restarting' && now - s.since > 2500) {
          if (isUp('rabbitmq')) { set(svc.id, 'starting'); log.add(`**${svc.id}** restarted (restart: unless-stopped)`); }
          else { set(svc.id, 'restarting', 'dial tcp rabbitmq:5672: connection refused — exit 1'); log.add(`**${svc.id}** exited (1): rabbitmq unreachable — restarting`, 'err'); }
        }
      });
      // Runtime effects of stopped dependencies on running services
      const degraded = (id, cond, why) => { if (isUp(id) && cond) S[id].why = why; else if (isUp(id) && !S[id].why.startsWith('ready')) S[id].why = ''; };
      degraded('user-service', !isUp('users-db'), 'healthz OK, but every query fails: users-db unreachable');
      degraded('order-service', !isUp('orders-db'), 'healthz OK, readyz 503: orders-db unreachable');
      if (isUp('order-service') && isUp('orders-db')) S['order-service'].why = !isUp('rabbitmq') ? 'outbox: publish failing; events pending in Postgres' : '';
      if (isUp('api-gateway')) S['api-gateway'].why = !isUp('redis') ? 'rate limiter failing open (redis down)' : '';
      if (S['notification-service'].state === 'running' && !isUp('rabbitmq')) { set('notification-service', 'restarting', 'lost connection to rabbitmq'); log.add('**notification-service** exited (1): connection to rabbitmq closed', 'err'); }
      render();
    }
    function render() {
      $('[data-grid]', ui.body).innerHTML = SVCS.map((svc) => {
        const s = S[svc.id];
        const [cls, label] = PILL[s.state];
        const canStop = !['stopped', 'exited'].includes(s.state);
        return `<div class="cs-svc"><span class="cs-name">${svc.id}</span><span class="pill ${cls}">${label}</span>
          <span class="cs-why">${esc(s.why)}</span>
          ${svc.oneshot ? '' : `<button class="btn btn-sm btn-ghost" style="grid-column:1/-1;justify-self:start;height:24px" type="button" data-toggle="${svc.id}">${canStop ? icon('square') + 'stop' : icon('play') + 'start'}</button>`}</div>`;
      }).join('');
    }
    function up() {
      log.add('`docker compose up -d` — network order-management_oms created; volumes users-data, orders-data, rabbitmq-data');
      SVCS.forEach((svc) => { if (['stopped', 'exited'].includes(S[svc.id].state) && !(svc.oneshot && S[svc.id].state === 'exited')) set(svc.id, 'waiting'); });
      tick();
    }
    function down() {
      [...SVCS].reverse().forEach((svc) => { if (S[svc.id].state !== 'stopped') { set(svc.id, 'stopped'); log.add(`**${svc.id}** Removed`); } });
      log.add('network removed · named volumes kept (use `down -v` to delete data)');
      render();
    }
    function curl() {
      let res;
      if (!isUp('api-gateway')) res = ['curl: (7) Failed to connect to localhost port 8080: Connection refused', 'err'];
      else if (!isUp('order-service')) res = ['HTTP/1.1 502 Bad Gateway — upstream order-service unreachable', 'err'];
      else if (!isUp('orders-db')) res = ['HTTP/1.1 503 Service Unavailable — orders-db unreachable', 'err'];
      else if (!isUp('user-service') || !isUp('users-db')) res = ['HTTP/1.1 503 Service Unavailable — cannot validate customer (user-service)', 'err'];
      else if (!isUp('rabbitmq')) res = ['HTTP/1.1 201 Created — order saved; order.created waits in the outbox until RabbitMQ is back', 'warn'];
      else res = [`HTTP/1.1 201 Created · {"id":${8800 + Math.floor(Math.random() * 99)},"status":"PENDING"}${isUp('notification-service') ? ' · email sent by notification-service' : ' · event queued for notification-service'}`, 'ok'];
      log.add(`$ curl -X POST localhost:8080/api/v1/orders … → ${res[0]}`, res[1]);
      const note = $('[data-note]', ui.body);
      note.className = 'wg-note ' + (res[1] === 'ok' ? 'is-ok' : res[1] === 'warn' ? 'is-warn' : 'is-err');
      note.innerHTML = res[1] === 'warn' ? '<strong>The outbox at work:</strong> RabbitMQ is down but orders still succeed — <code>order-service</code> deliberately has only <code>condition: service_started</code> on rabbitmq and does not check it in readiness.' : esc(res[0]);
    }
    $('[data-up]', el).addEventListener('click', up);
    $('[data-down]', el).addEventListener('click', down);
    $('[data-curl]', el).addEventListener('click', curl);
    $('[data-grid]', ui.body).addEventListener('click', (e) => {
      const b = e.target.closest('[data-toggle]');
      if (!b) return;
      const id = b.dataset.toggle;
      if (['stopped', 'exited'].includes(S[id].state)) { set(id, 'waiting'); log.add(`$ docker compose start ${id}`); }
      else { set(id, 'stopped'); log.add(`$ docker compose stop ${id} — **${id}** Stopped`, 'warn'); }
      tick();
    });
    T.interval(tick, 250);
    render();
    return () => T.clear();
  };

  /* ======================================================================
     k8s-sim — Deployment + HPA + rolling update
     ====================================================================== */
  MV.widgets['k8s-sim'] = function (el) {
    const ui = MV.wkit.frame(el, {
      title: 'Kubernetes: order-service Deployment',
      sub: 'replicas 3 · maxSurge 1 · maxUnavailable 0 · HPA 3–12 at 70% CPU · 200 req/s per pod at 100%',
      ico: 'ship-wheel',
      controls: `<label class="field-inline">Load <input type="range" min="100" max="2600" step="50" value="400" data-load><span class="mono" data-load-v>400 req/s</span></label>
        <label class="switch is-success"><input type="checkbox" data-hpa checked><span class="switch-track"></span>HPA</label>
        <button class="btn btn-sm btn-primary" type="button" data-deploy>${icon('rocket')}Deploy v2</button>
        <label class="switch is-danger"><input type="checkbox" data-broken><span class="switch-track"></span>v2 fails readiness</label>
        <button class="btn btn-sm" type="button" data-undo>${icon('undo-2')}rollout undo</button>
        <button class="btn btn-sm" type="button" data-kill>${icon('skull')}Kill a pod</button>`,
    });
    ui.body.innerHTML = `<div class="grid gap-3">
        <div class="wg-stats">
          <div class="wg-stat"><div class="wg-stat-label">Ready / desired</div><div class="wg-stat-value" data-ready>—</div></div>
          <div class="wg-stat"><div class="wg-stat-label">Avg CPU (of request)</div><div class="wg-stat-value" data-cpu>—</div></div>
          <div class="wg-stat"><div class="wg-stat-label">p99 latency</div><div class="wg-stat-value" data-p99>—</div></div>
          <div class="wg-stat"><div class="wg-stat-label">Rollout</div><div class="wg-stat-value" data-roll style="font-size:14px">—</div></div>
        </div>
        <div class="k8-pods" data-pods></div>
        <div class="wg-note" data-note></div>
        <div class="wg-panel"><div class="wg-panel-title">${icon('scroll-text', '', 13)}kubectl get events</div><div data-log></div></div>
      </div>`;
    const T = MV.wkit.timers();
    const log = MV.wkit.logger($('[data-log]', ui.body), 80);
    const rs = () => Math.random().toString(36).slice(2, 7);
    let pods = [], desired = 3, target = 'v1', prev = 'v1', hpaLow = 0, tickN = 0, hash = { v1: '7d9f4c', v2: '5b8e21' };
    const mkPod = (version) => { const p = { name: `order-service-${hash[version]}-${rs()}`, version, phase: 'starting', t: 0 }; pods.push(p); log.add(`Created pod ${p.name} (${version})`); return p; };
    for (let i = 0; i < 3; i++) { const p = mkPod('v1'); p.phase = 'ready'; }
    log.clear();
    log.add('deployment.apps/order-service: 3/3 ready (v1)', 'ok');

    const capacity = 200;
    const live = () => pods.filter((p) => p.phase !== 'terminating');
    const ready = () => pods.filter((p) => p.phase === 'ready');
    function util() { const r = ready().length; return r ? (+$('[data-load]', el).value / (r * capacity)) * 100 : 999; }

    function step() {
      tickN++;
      // Pod lifecycle
      pods.forEach((p) => {
        p.t++;
        if (p.phase === 'starting' && p.t >= 3) {
          if (p.version === 'v2' && $('[data-broken]', el).checked) { p.phase = 'notready'; log.add(`Readiness probe failed: GET /readyz 503 — pod ${p.name}`, 'err'); }
          else { p.phase = 'ready'; log.add(`Pod ${p.name} is Ready`, 'ok'); }
        }
      });
      pods = pods.filter((p) => !(p.phase === 'terminating' && p.t >= 3));
      // HPA every 3 ticks
      if ($('[data-hpa]', el).checked && tickN % 3 === 0) {
        const u = util();
        const want = Math.max(3, Math.min(12, Math.ceil(ready().length * (u / 70))));
        if (want > desired) { log.add(`HPA: cpu ${Math.round(u)}%/70% → scale ${desired} → ${want}`, 'warn'); desired = want; hpaLow = 0; }
        else if (want < desired) { hpaLow++; if (hpaLow >= 6) { desired--; hpaLow = 0; log.add(`HPA: sustained low load (stabilization window) → scale down to ${desired}`); } }
        else hpaLow = 0;
      }
      // Deployment controller (rolling update: maxSurge 1, maxUnavailable 0)
      const l = live();
      const newer = l.filter((p) => p.version === target);
      const older = l.filter((p) => p.version !== target);
      if (older.length) {
        const readyNow = ready().length;
        if (l.length < desired + 1 && newer.filter((p) => p.phase !== 'ready').length === 0) mkPod(target);
        const readyNew = newer.filter((p) => p.phase === 'ready').length;
        if (readyNew > 0 && readyNow > desired) {
          const victim = older.find((p) => p.phase !== 'ready') || older[0];
          victim.phase = 'terminating'; victim.t = 0;
          log.add(`Scaled down old ReplicaSet: terminating ${victim.name} (SIGTERM → drain)`);
        } else if (older.some((p) => p.phase !== 'ready')) {
          const victim = older.find((p) => p.phase !== 'ready');
          victim.phase = 'terminating'; victim.t = 0;
        }
        if (readyNew >= desired && !older.some((p) => p.phase === 'ready')) older.forEach((p) => { p.phase = 'terminating'; p.t = 0; });
      } else {
        if (l.length < desired) mkPod(target);
        else if (l.length > desired) {
          const victim = l.find((p) => p.phase !== 'ready') || l[l.length - 1];
          victim.phase = 'terminating'; victim.t = 0;
          log.add(`Terminating ${victim.name} (scale down)`);
        }
      }
      render();
    }

    function render() {
      const r = ready().length;
      const u = util();
      const p99 = u > 200 ? 4000 : Math.round(40 * Math.pow(1 + Math.max(0, u - 70) / 40, 2));
      $('[data-ready]', ui.body).textContent = `${r} / ${desired}`;
      $('[data-ready]', ui.body).className = 'wg-stat-value ' + (r >= desired ? 'is-ok' : 'is-warn');
      $('[data-cpu]', ui.body).textContent = u > 300 ? '>300%' : `${Math.round(u)}%`;
      $('[data-cpu]', ui.body).className = 'wg-stat-value ' + (u > 100 ? 'is-err' : u > 70 ? 'is-warn' : 'is-ok');
      $('[data-p99]', ui.body).textContent = p99 >= 4000 ? 'timeouts' : `${p99} ms`;
      $('[data-p99]', ui.body).className = 'wg-stat-value ' + (p99 > 400 ? 'is-err' : p99 > 120 ? 'is-warn' : 'is-ok');
      const l = live();
      const older = l.filter((p) => p.version !== target);
      const stalled = older.length && l.some((p) => p.version === target && p.phase === 'notready');
      $('[data-roll]', ui.body).innerHTML = older.length ? (stalled ? `<span style="color:var(--err)">stalled at ${target}</span>` : `rolling to ${target}…`) : `${target} · complete`;
      $('[data-pods]', ui.body).innerHTML = pods.map((p) => {
        const cpu = p.phase === 'ready' ? Math.min(300, u) : 0;
        const label = { starting: 'ContainerCreating', ready: 'Running · Ready', notready: 'Running · NotReady', terminating: 'Terminating' }[p.phase];
        return `<div class="k8-pod" data-s="${p.phase}"><div class="k8-pod-name" title="${p.name}">${p.name}</div>
          <div class="flex items-center justify-between mt-1"><span class="pill ${p.version === 'v2' ? 'is-purple' : 'is-info'}" style="height:18px">${p.version}</span><span class="text-[11px] ${p.phase === 'notready' ? '' : 'text-mutedc'}" style="${p.phase === 'notready' ? 'color:var(--warn)' : ''}">${label}</span></div>
          <div class="meter mt-2${cpu > 100 ? ' is-err' : cpu > 70 ? ' is-warn' : ''}"><span style="width:${Math.min(100, cpu / 1.5)}%"></span></div><div class="text-[10.5px] text-mutedc mt-1">cpu ${Math.round(cpu)}%</div></div>`;
      }).join('');
      const note = $('[data-note]', ui.body);
      if (stalled) { note.className = 'wg-note is-err'; note.innerHTML = 'The new pods never pass readiness, so with <code>maxUnavailable: 0</code> no old pod is removed — <strong>capacity is protected</strong> and the rollout stalls. Press <strong>rollout undo</strong>.'; }
      else if (u > 100) { note.className = 'wg-note is-err'; note.innerHTML = $('[data-hpa]', el).checked ? `Pods are saturated (${Math.round(u)}% of their CPU request). The HPA computes <code>ceil(ready × ${Math.round(u)} / 70)</code> and adds pods; latency recovers once they are ready.` : 'Pods are saturated and the HPA is off — latency climbs until requests time out. Turn the HPA on.'; }
      else if (older.length) { note.className = 'wg-note'; note.innerHTML = 'Rolling update: one surge pod is created, and an old pod is terminated only after a new one is <strong>ready</strong>. Ready capacity never drops below the desired count.'; }
      else { note.className = 'wg-note is-ok'; note.innerHTML = `Healthy: ${r} ready pods at ${Math.round(u)}% CPU. Increase the load, deploy v2, or kill a pod to watch the controllers reconcile.`; }
    }

    $('[data-load]', el).addEventListener('input', (e) => { $('[data-load-v]', el).textContent = `${e.target.value} req/s`; render(); });
    $('[data-deploy]', el).addEventListener('click', () => {
      if (target === 'v2') { log.add('v2 is already the target'); return; }
      prev = target; target = 'v2';
      log.add(`kubectl set image deploy/order-service order-service=…/order-service:2.4.0 → new ReplicaSet order-service-${hash.v2}`, 'warn');
    });
    $('[data-undo]', el).addEventListener('click', () => {
      if (target === prev && target === 'v1') { log.add('nothing to undo'); return; }
      const from = target;
      target = from === 'v2' ? 'v1' : 'v2'; prev = target;
      log.add(`kubectl rollout undo deploy/order-service → back to ${target}`, 'ok');
    });
    $('[data-kill]', el).addEventListener('click', () => {
      const r = ready();
      if (!r.length) return;
      const v = r[Math.floor(Math.random() * r.length)];
      pods = pods.filter((p) => p !== v);
      log.add(`Pod ${v.name} killed (node failure) — ReplicaSet will replace it`, 'err');
      render();
    });
    T.interval(step, 700);
    render();
    return () => T.clear();
  };
})(window.MV);
