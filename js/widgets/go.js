/* ==========================================================================
   Widget: worker-pool — bounded concurrency with goroutines and channels.
   A producer sends jobs into a channel; N workers consume them. Compare with
   spawning one goroutine per job, and create (then fix) a goroutine leak.
   ========================================================================== */
(function (MV) {
  'use strict';
  const { $, $$, esc, icon } = MV.ui;

  MV.widgets['worker-pool'] = function (el) {
    const ui = MV.wkit.frame(el, {
      title: 'Worker pool vs unbounded goroutines',
      sub: 'jobs := make(chan Job, buffer) · N workers range over jobs',
      ico: 'cpu',
      controls: `<div class="segmented" role="group" aria-label="Mode"><button type="button" data-mode="pool" aria-pressed="true">Worker pool</button><button type="button" data-mode="unbounded" aria-pressed="false">go per job (unbounded)</button></div>
        <label class="field-inline" data-pool-only>Workers <input type="range" min="1" max="8" value="3" data-workers><span class="mono" data-workers-v>3</span></label>
        <label class="field-inline" data-pool-only>Channel buffer <input type="range" min="0" max="20" value="5" data-buffer><span class="mono" data-buffer-v>5</span></label>
        <label class="field-inline">Jobs <select class="select" data-jobmix><option value="uniform">uniform (300 ms)</option><option value="mixed" selected>mixed (10% heavy)</option></select></label>
        <button class="btn btn-primary btn-sm" type="button" data-add>${icon('plus')}Enqueue 20 jobs</button>
        <button class="btn btn-sm" type="button" data-leak>${icon('bug')}Leak a goroutine</button>
        <button class="btn btn-sm" type="button" data-cancel>${icon('octagon-x')}cancel()</button>`,
    });
    ui.body.innerHTML = `<div class="wg-grid">
        <div class="grid gap-3 content-start">
          <div class="wg-panel"><div class="wg-panel-title">${icon('arrow-right-to-line', '', 13)}Producer <span class="ml-auto normal-case tracking-normal font-normal" data-producer></span></div><div class="wp-queue" data-pending aria-label="Jobs waiting for the producer to send"></div></div>
          <div class="wg-panel"><div class="wg-panel-title">${icon('inbox', '', 13)}<span data-chan-title>jobs channel</span><span class="ml-auto mono normal-case tracking-normal font-normal" data-chan-count></span></div><div class="wp-queue" data-chan aria-label="Jobs buffered in the channel"></div></div>
          <div class="wg-panel"><div class="wg-panel-title">${icon('cpu', '', 13)}<span data-lanes-title>Workers</span></div><div class="wp-lanes" data-lanes></div></div>
        </div>
        <div class="grid gap-3 content-start">
          <div class="wg-stats">
            <div class="wg-stat"><div class="wg-stat-label">Completed</div><div class="wg-stat-value" data-s-done>0</div></div>
            <div class="wg-stat"><div class="wg-stat-label">Throughput</div><div class="wg-stat-value" data-s-tput>0/s</div></div>
            <div class="wg-stat"><div class="wg-stat-label">Goroutines</div><div class="wg-stat-value" data-s-gor>1</div></div>
          </div>
          <div class="wg-panel"><div class="wg-panel-title">${icon('server', '', 13)}Load on the downstream dependency</div>
            <div class="meter" data-load-m><span style="width:0%"></span></div>
            <div class="text-[12px] mt-2" data-load-t>Idle.</div></div>
          <div class="wg-note" data-note></div>
          <div class="wg-panel"><div class="wg-panel-title">${icon('scroll-text', '', 13)}Events</div><div data-log></div></div>
        </div>
      </div>`;

    const T = MV.wkit.timers();
    const log = MV.wkit.logger($('[data-log]', ui.body), 40);
    const DEP_CAPACITY = 6; // concurrent calls the dependency handles at full speed
    let mode = 'pool';
    let nextId = 1;
    let pending = [];       // jobs the producer still has to send
    let chan = [];          // buffered in the channel
    let workers = [];       // { job, progress } or null job
    let running = [];       // unbounded mode: in-flight goroutines
    let done = 0, doneWindow = [], leaked = null, producerBlocked = false;

    const cfg = () => ({ workers: +$('[data-workers]', el).value, buffer: +$('[data-buffer]', el).value, mix: $('[data-jobmix]', el).value });

    function resizeWorkers() {
      const n = cfg().workers;
      while (workers.length < n) workers.push({ job: null });
      while (workers.length > n) {
        const w = workers.pop();
        if (w.job) chan.unshift(w.job); // in a real pool you'd drain; here the job returns to the queue
      }
    }

    function makeJob() {
      const heavy = cfg().mix === 'mixed' && Math.random() < 0.1;
      return { id: nextId++, cost: heavy ? 2400 : 300, heavy, progress: 0 };
    }

    function concurrency() {
      return mode === 'pool' ? workers.filter((w) => w.job).length : running.length;
    }

    function tick(dt) {
      const c = cfg();
      // Producer: send into the channel while there is buffer space (or an idle receiver for buffer 0).
      producerBlocked = false;
      while (pending.length) {
        if (mode === 'unbounded') { running.push(pending.shift()); continue; }
        const idle = workers.find((w) => !w.job && w !== leaked);
        if (chan.length < c.buffer) chan.push(pending.shift());
        else if (c.buffer === 0 && idle) { idle.job = pending.shift(); }
        else { producerBlocked = true; break; }
      }
      // Workers receive from the channel
      if (mode === 'pool') {
        workers.forEach((w) => { if (!w.job && w !== leaked && chan.length) w.job = chan.shift(); });
      }
      // Progress: the dependency slows down when concurrency exceeds its capacity
      const conc = concurrency();
      const slowdown = Math.max(1, conc / DEP_CAPACITY);
      const advance = (job) => { job.progress += dt / slowdown; return job.progress >= job.cost; };
      if (mode === 'pool') {
        workers.forEach((w) => {
          if (!w.job || w === leaked) return;
          if (advance(w.job)) { complete(w.job); w.job = null; }
        });
      } else {
        running = running.filter((j) => { if (advance(j)) { complete(j); return false; } return true; });
      }
      const now = performance.now();
      doneWindow = doneWindow.filter((t) => now - t < 3000);
      render(conc, slowdown);
    }

    function complete(job) {
      done++;
      doneWindow.push(performance.now());
      if (job.heavy) log.add(`job #${job.id} (heavy) finished`, 'ok');
    }

    function render(conc, slowdown) {
      const c = cfg();
      $('[data-producer]', ui.body).innerHTML = pending.length
        ? (producerBlocked ? `<span class="pill is-warn">${icon('pause')}blocked on send — channel full</span>` : `<span class="pill is-info">sending…</span>`)
        : '<span class="pill is-muted">idle</span>';
      $('[data-pending]', ui.body).innerHTML = pending.slice(0, 60).map((j) => `<span class="wp-job${j.heavy ? ' is-heavy' : ''}" title="job #${j.id}"></span>`).join('') + (pending.length > 60 ? `<span class="text-[11px] text-mutedc">+${pending.length - 60}</span>` : '');
      const chanEl = $('[data-chan]', ui.body);
      if (mode === 'pool') {
        $('[data-chan-title]', ui.body).textContent = c.buffer === 0 ? 'jobs channel (unbuffered: send blocks until a worker receives)' : `jobs channel (buffer ${c.buffer})`;
        $('[data-chan-count]', ui.body).textContent = `${chan.length}/${c.buffer}`;
        chanEl.innerHTML = chan.map((j) => `<span class="wp-job${j.heavy ? ' is-heavy' : ''}"></span>`).join('') + Array.from({ length: Math.max(0, c.buffer - chan.length) }, () => '<span class="wp-job" style="opacity:.12"></span>').join('');
        $('[data-lanes-title]', ui.body).textContent = `Workers (${c.workers})`;
        $('[data-lanes]', ui.body).innerHTML = workers.map((w, i) => {
          const stuck = w === leaked;
          const pct = stuck ? 100 : w.job ? Math.min(100, (w.job.progress / w.job.cost) * 100) : 0;
          return `<div class="wp-row"><span class="mono text-mutedc">worker ${i + 1}</span><div class="wp-track"><div class="wp-fill${stuck ? ' is-stuck' : ''}" style="width:${pct}%"></div></div><span class="mono text-[11px]">${stuck ? '<span style="color:var(--err)">blocked</span>' : w.job ? `#${w.job.id}` : '<span class="text-mutedc">idle</span>'}</span></div>`;
        }).join('');
      } else {
        $('[data-chan-title]', ui.body).textContent = 'no channel — every job gets its own goroutine immediately';
        $('[data-chan-count]', ui.body).textContent = '';
        chanEl.innerHTML = '';
        $('[data-lanes-title]', ui.body).textContent = `Goroutines in flight (${running.length})`;
        $('[data-lanes]', ui.body).innerHTML = running.slice(0, 10).map((j) => `<div class="wp-row"><span class="mono text-mutedc">go #${j.id}</span><div class="wp-track"><div class="wp-fill" style="width:${Math.min(100, (j.progress / j.cost) * 100)}%"></div></div><span class="mono text-[11px]">${slowdown > 1 ? `${slowdown.toFixed(1)}× slower` : ''}</span></div>`).join('') + (running.length > 10 ? `<div class="text-[12px] text-mutedc">…and ${running.length - 10} more</div>` : '') || '<div class="text-[12px] text-mutedc">No goroutines running.</div>';
      }
      $('[data-s-done]', ui.body).textContent = done;
      $('[data-s-tput]', ui.body).textContent = `${(doneWindow.length / 3).toFixed(1)}/s`;
      const gor = 1 + (mode === 'pool' ? workers.length + (leaked ? 0 : 0) : running.length) + (pending.length && producerBlocked ? 0 : 0);
      $('[data-s-gor]', ui.body).textContent = gor;
      const m = $('[data-load-m]', ui.body);
      const pct = Math.min(100, (conc / (DEP_CAPACITY * 2)) * 100);
      m.className = 'meter' + (conc > DEP_CAPACITY * 1.5 ? ' is-err' : conc > DEP_CAPACITY ? ' is-warn' : '');
      $('span', m).style.width = pct + '%';
      $('[data-load-t]', ui.body).innerHTML = conc === 0 ? 'Idle.' : conc <= DEP_CAPACITY
        ? `${conc} concurrent calls — within the dependency's capacity (${DEP_CAPACITY}).`
        : `<strong style="color:var(--${conc > DEP_CAPACITY * 1.5 ? 'err' : 'warn'})">${conc} concurrent calls</strong> — ${slowdown.toFixed(1)}× over capacity; every call slows down.`;
      const note = $('[data-note]', ui.body);
      if (mode === 'unbounded') {
        note.className = 'wg-note is-warn';
        note.innerHTML = '`for _, j := range jobs { go process(j) }` starts everything at once. Goroutines are cheap — **the dependency is not**. Concurrency equals queue length, so a burst overloads it and every call gets slower.';
      } else if (leaked) {
        note.className = 'wg-note is-err';
        note.innerHTML = 'Worker 1 is blocked forever (e.g. sending on a channel nobody reads). It never exits and never picks up work — a **goroutine leak**. Press `cancel()` to signal ctx.Done() so it can return.';
      } else {
        note.className = 'wg-note';
        note.innerHTML = `Concurrency is capped at **${c.workers}** workers. The channel buffer (${c.buffer}) absorbs bursts; when it is full the producer blocks — natural **back-pressure**. Throughput is limited by workers × job speed, and the dependency is never overloaded.`;
      }
    }

    let last = performance.now();
    T.interval(() => { const now = performance.now(); tick(Math.min(250, now - last)); last = now; }, 100);

    $$('[data-mode]', el).forEach((b) => b.addEventListener('click', () => {
      mode = b.dataset.mode;
      $$('[data-mode]', el).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      $$('[data-pool-only]', el).forEach((x) => { x.style.display = mode === 'pool' ? '' : 'none'; });
      $('[data-leak]', el).disabled = mode !== 'pool';
      // move in-flight work across modes
      if (mode === 'unbounded') { running = [...chan, ...workers.filter((w) => w.job).map((w) => w.job)]; chan = []; workers.forEach((w) => { w.job = null; }); leaked = null; }
      else { chan = running.slice(); running = []; resizeWorkers(); }
      log.add(mode === 'pool' ? 'switched to a bounded worker pool' : 'switched to one goroutine per job', 'warn');
    }));
    $('[data-workers]', el).addEventListener('input', (e) => { $('[data-workers-v]', el).textContent = e.target.value; resizeWorkers(); });
    $('[data-buffer]', el).addEventListener('input', (e) => { $('[data-buffer-v]', el).textContent = e.target.value; while (chan.length > +e.target.value) pending.unshift(chan.pop()); });
    $('[data-add]', el).addEventListener('click', () => { for (let i = 0; i < 20; i++) pending.push(makeJob()); log.add('enqueued 20 jobs'); });
    $('[data-leak]', el).addEventListener('click', () => {
      if (mode !== 'pool' || leaked) return;
      resizeWorkers();
      leaked = workers[0];
      if (leaked.job) { chan.unshift(leaked.job); leaked.job = null; }
      log.add('worker 1: `results <- r` blocks forever — nobody reads `results` any more', 'err');
    });
    $('[data-cancel]', el).addEventListener('click', () => {
      if (leaked) { leaked = null; log.add('ctx cancelled → worker 1 hits `case <-ctx.Done(): return` and exits; a fresh worker replaces it', 'ok'); }
      else if (pending.length || chan.length) { const n = pending.length + chan.length; pending = []; chan = []; log.add(`ctx cancelled → producer stops; ${n} queued job(s) dropped, in-flight jobs finish`, 'warn'); }
      else log.add('nothing to cancel');
    });

    resizeWorkers();
    render(0, 1);
    log.add('Press **Enqueue 20 jobs**, then try the unbounded mode and the leak.');
    return () => T.clear();
  };
})(window.MV);
