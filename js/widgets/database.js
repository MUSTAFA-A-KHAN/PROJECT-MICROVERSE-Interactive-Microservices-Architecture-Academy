/* ==========================================================================
   Widgets: tx-visualizer (two concurrent transactions and the lost update)
   and sql-lab (query plans with and without indexes).
   ========================================================================== */
(function (MV) {
  'use strict';
  const { $, $$, esc, icon } = MV.ui;

  /* ======================================================================
     tx-visualizer — scripted interleavings of two transactions
     ====================================================================== */
  // Each step: { tx: 1|2, sql, result, row: {status, version}, lock: 'T1'|'T2'|null, wait: bool, refund: bool, note }
  const SCRIPTS = {
    bug: {
      label: 'Read → check → write (Read Committed)',
      verdict: { ok: false, text: 'Two refunds for one order. Both transactions read `CONFIRMED` before either wrote, so both decided the cancel was allowed. Read Committed does not prevent this **lost update**.' },
      steps: [
        { tx: 1, sql: 'BEGIN;' },
        { tx: 1, sql: "SELECT status FROM orders WHERE id = 8812;", result: "→ 'CONFIRMED'" },
        { tx: 2, sql: 'BEGIN;' },
        { tx: 2, sql: "SELECT status FROM orders WHERE id = 8812;", result: "→ 'CONFIRMED'", note: 'T2 also sees CONFIRMED — T1 has not written yet' },
        { tx: 1, sql: "UPDATE orders SET status = 'CANCELLED'\nWHERE id = 8812;", result: '→ UPDATE 1', row: { status: 'CANCELLED' }, lock: 'T1' },
        { tx: 1, sql: 'refund(order 8812, $42)  -- app code', refund: true },
        { tx: 1, sql: 'COMMIT;', lock: null },
        { tx: 2, sql: "UPDATE orders SET status = 'CANCELLED'\nWHERE id = 8812;", result: '→ UPDATE 1 (overwrites)', lock: 'T2' },
        { tx: 2, sql: 'refund(order 8812, $42)  -- app code', refund: true },
        { tx: 2, sql: 'COMMIT;', lock: null },
      ],
    },
    atomic: {
      label: 'Atomic conditional UPDATE',
      verdict: { ok: true, text: 'One refund. The check and the write are one statement: T2 waits for T1\'s row lock, then re-evaluates its `WHERE` against the committed row, matches nothing and skips the refund.' },
      steps: [
        { tx: 1, sql: 'BEGIN;' },
        { tx: 1, sql: "UPDATE orders SET status = 'CANCELLED'\nWHERE id = 8812 AND status IN ('PENDING','CONFIRMED')\nRETURNING id;", result: '→ 1 row', row: { status: 'CANCELLED' }, lock: 'T1' },
        { tx: 2, sql: 'BEGIN;' },
        { tx: 2, sql: "UPDATE orders SET status = 'CANCELLED'\nWHERE id = 8812 AND status IN ('PENDING','CONFIRMED')\nRETURNING id;", result: '… waiting for T1\'s row lock', wait: true },
        { tx: 1, sql: 'refund(order 8812, $42)', refund: true },
        { tx: 1, sql: 'COMMIT;', lock: 'T2' },
        { tx: 2, sql: '(lock acquired — WHERE re-checked)', result: "→ 0 rows: status is already 'CANCELLED'" },
        { tx: 2, sql: '-- 0 rows → no refund; return 200 (already cancelled)' },
        { tx: 2, sql: 'COMMIT;', lock: null },
      ],
    },
    forupdate: {
      label: 'SELECT … FOR UPDATE',
      verdict: { ok: true, text: 'One refund. T1 locks the row while it decides; T2 blocks on its `SELECT … FOR UPDATE` until T1 commits, then reads `CANCELLED` and stops.' },
      steps: [
        { tx: 1, sql: 'BEGIN;' },
        { tx: 1, sql: 'SELECT status FROM orders\nWHERE id = 8812 FOR UPDATE;', result: "→ 'CONFIRMED' (row locked)", lock: 'T1' },
        { tx: 2, sql: 'BEGIN;' },
        { tx: 2, sql: 'SELECT status FROM orders\nWHERE id = 8812 FOR UPDATE;', result: '… blocked by T1', wait: true },
        { tx: 1, sql: "UPDATE orders SET status = 'CANCELLED' WHERE id = 8812;", row: { status: 'CANCELLED' } },
        { tx: 1, sql: 'refund(order 8812, $42)', refund: true },
        { tx: 1, sql: 'COMMIT;', lock: 'T2' },
        { tx: 2, sql: '(lock acquired)', result: "→ 'CANCELLED'" },
        { tx: 2, sql: '-- already cancelled → no refund', },
        { tx: 2, sql: 'COMMIT;', lock: null },
      ],
    },
    optimistic: {
      label: 'Optimistic version check',
      verdict: { ok: true, text: 'One refund. Both read version 3, but only the first `UPDATE … WHERE version = 3` matches. T2 updates 0 rows and returns **409 Conflict** — no locks held while the application decides.' },
      steps: [
        { tx: 1, sql: 'SELECT status, version FROM orders WHERE id = 8812;', result: "→ 'CONFIRMED', v3" },
        { tx: 2, sql: 'SELECT status, version FROM orders WHERE id = 8812;', result: "→ 'CONFIRMED', v3" },
        { tx: 1, sql: 'BEGIN;' },
        { tx: 1, sql: "UPDATE orders SET status = 'CANCELLED', version = version + 1\nWHERE id = 8812 AND version = 3;", result: '→ UPDATE 1', row: { status: 'CANCELLED', version: 4 }, lock: 'T1' },
        { tx: 1, sql: 'INSERT INTO outbox (order.cancelled …); COMMIT;', lock: null, refund: true },
        { tx: 2, sql: 'BEGIN;' },
        { tx: 2, sql: "UPDATE orders SET status = 'CANCELLED', version = version + 1\nWHERE id = 8812 AND version = 3;", result: '→ UPDATE 0 (version is now 4)' },
        { tx: 2, sql: 'ROLLBACK; -- ErrConcurrentUpdate → 409 Conflict' },
      ],
    },
  };

  MV.widgets['tx-visualizer'] = function (el) {
    const ui = MV.wkit.frame(el, {
      title: 'Two requests cancel the same order',
      sub: 'T1 and T2 run concurrently against orders.id = 8812 (status CONFIRMED, version 3)',
      ico: 'git-compare-arrows',
      controls: `<label class="field-inline">Strategy <select class="select" data-script>${Object.entries(SCRIPTS).map(([k, s]) => `<option value="${k}">${esc(s.label)}</option>`).join('')}</select></label>
        <button class="btn btn-sm btn-primary" type="button" data-step>${icon('step-forward')}Step</button>
        <button class="btn btn-sm" type="button" data-play>${icon('play')}Play</button>
        <button class="btn btn-sm btn-ghost" type="button" data-reset>${icon('rotate-ccw')}Reset</button>`,
    });
    ui.body.innerHTML = `<div class="grid gap-3">
        <div class="tx-row" data-row></div>
        <div class="tx-lanes"><div class="tx-lane"><div class="tx-lane-title">${icon('user', '', 14)}T1 · Alice (support agent)</div><div data-lane="1"></div></div><div class="tx-lane"><div class="tx-lane-title">${icon('user', '', 14)}T2 · Bob (customer, same moment)</div><div data-lane="2"></div></div></div>
        <div class="wg-note" data-note>Press <strong>Step</strong> to execute statements in the interleaving shown.</div>
      </div>`;
    const T = MV.wkit.timers();
    let key = 'bug', i = 0, playing = false;
    let row, refunds, lock;
    function reset() {
      i = 0; row = { status: 'CONFIRMED', version: 3 }; refunds = 0; lock = null; playing = false;
      render();
      $('[data-note]', ui.body).className = 'wg-note';
      $('[data-note]', ui.body).innerHTML = 'Press <strong>Step</strong> to execute statements in the interleaving shown.';
    }
    function render() {
      const s = SCRIPTS[key];
      [1, 2].forEach((tx) => {
        $(`[data-lane="${tx}"]`, ui.body).innerHTML = s.steps.map((st, k) => {
          if (st.tx !== tx) return '';
          const cls = k < i ? (st.wait ? 'is-done' : 'is-done') : k === i - 1 ? 'is-current' : '';
          const waiting = k === i - 1 && st.wait;
          return `<div class="tx-step ${k === i - 1 ? (waiting ? 'is-wait' : 'is-current') : cls}">${esc(st.sql)}${k < i && st.result ? `<span class="tx-res">${esc(st.result)}</span>` : ''}</div>`;
        }).join('');
      });
      $('[data-row]', ui.body).innerHTML = `<div><span>orders.status</span>${esc(row.status)}</div><div><span>version</span>${row.version}</div><div><span>row lock held by</span>${lock || '—'}</div><div><span>refunds issued</span><strong style="color:var(--${refunds > 1 ? 'err' : refunds === 1 ? 'green' : 'fg'})">${refunds}</strong></div>`;
    }
    function step() {
      const s = SCRIPTS[key];
      if (i >= s.steps.length) return false;
      const st = s.steps[i];
      if (st.row) Object.assign(row, st.row);
      if ('lock' in st) lock = st.lock;
      if (st.refund) refunds++;
      i++;
      render();
      const note = $('[data-note]', ui.body);
      if (i >= s.steps.length) {
        note.className = 'wg-note ' + (s.verdict.ok ? 'is-ok' : 'is-err');
        note.innerHTML = MV.ui.inlineMd(s.verdict.text);
        return false;
      }
      if (st.note) { note.className = 'wg-note is-warn'; note.innerHTML = MV.ui.inlineMd(st.note); }
      else if (st.wait) { note.className = 'wg-note is-warn'; note.innerHTML = MV.ui.inlineMd(`T${st.tx} is blocked waiting for a row lock held by T${st.tx === 1 ? 2 : 1}.`); }
      else { note.className = 'wg-note'; note.innerHTML = `Step ${i} of ${s.steps.length}`; }
      return true;
    }
    $('[data-script]', el).addEventListener('change', (e) => { key = e.target.value; reset(); });
    $('[data-step]', el).addEventListener('click', step);
    $('[data-reset]', el).addEventListener('click', reset);
    $('[data-play]', el).addEventListener('click', () => {
      if (playing) return;
      if (i >= SCRIPTS[key].steps.length) reset();
      playing = true;
      const loop = () => { if (!playing) return; if (step()) T.timeout(loop, 900); else playing = false; };
      loop();
    });
    reset();
    return () => { playing = false; T.clear(); };
  };

  /* ======================================================================
     sql-lab — simulated planner for the Order Service's real query shapes
     ====================================================================== */
  const INDEXES = {
    user_id: { name: 'orders_user_id_id_idx', ddl: 'CREATE INDEX CONCURRENTLY orders_user_id_id_idx ON orders (user_id, id DESC);', on: true },
    status_created: { name: 'orders_status_created_idx', ddl: 'CREATE INDEX CONCURRENTLY orders_status_created_idx ON orders (status, created_at);', on: false },
    outbox: { name: 'outbox_unpublished_idx', ddl: 'CREATE INDEX CONCURRENTLY outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;', on: true },
    email: { name: 'users_email_key', ddl: 'CREATE UNIQUE INDEX CONCURRENTLY users_email_key ON users (email);', on: true },
  };
  const QUERIES = [
    {
      id: 'mine', label: 'My orders, newest first', idx: 'user_id',
      sql: 'SELECT id, status, total_cents\nFROM orders\nWHERE user_id = 42\nORDER BY id DESC\nLIMIT 20;',
      cols: ['id', 'status', 'total_cents'], rows: [[1899843, 'PENDING', 4200], [1899412, 'DELIVERED', 1599], [1897730, 'CANCELLED', 8800]],
      good: { ms: 0.09, scanned: 20, plan: ['Limit  (cost=0.43..8.71 rows=20) (actual time=0.031..0.074 rows=20 loops=1)', '  ->  Index Scan using orders_user_id_id_idx on orders  (actual rows=20 loops=1)', '        Index Cond: (user_id = 42)'] },
      bad: { ms: 96.4, scanned: 2000000, plan: ['Limit  (actual time=96.1..96.3 rows=20 loops=1)', '  ->  Gather Merge  (actual rows=20 loops=1)', '        Workers Planned: 2', '        ->  Sort  (actual rows=7 loops=3)', '              Sort Key: id DESC', '              Sort Method: top-N heapsort  Memory: 27kB', '              ->  Parallel Seq Scan on orders  (actual rows=1334 loops=3)', '                    Filter: (user_id = 42)', '                    Rows Removed by Filter: 665332'] },
    },
    {
      id: 'offset', label: 'Admin list, page 5,001 with OFFSET', idx: null,
      sql: 'SELECT id, user_id, status\nFROM orders\nORDER BY id DESC\nLIMIT 20 OFFSET 100000;',
      cols: ['id', 'user_id', 'status'], rows: [[1899999 - 100000, 7781, 'SHIPPED'], [1899999 - 100001, 112, 'PENDING'], [1899999 - 100002, 42, 'DELIVERED']],
      good: { ms: 38.2, scanned: 100020, plan: ['Limit  (actual time=37.9..38.2 rows=20 loops=1)', '  ->  Index Scan Backward using orders_pkey on orders  (actual rows=100020 loops=1)', '-- OFFSET reads and discards 100,000 index entries before returning 20'] },
      lesson: 'OFFSET always reads and throws away every skipped row, so deep pages get slower linearly. Compare with the keyset query below.',
    },
    {
      id: 'keyset', label: 'Same page with keyset pagination', idx: null,
      sql: 'SELECT id, user_id, status\nFROM orders\nWHERE id < 1799999   -- last id of the previous page\nORDER BY id DESC\nLIMIT 20;',
      cols: ['id', 'user_id', 'status'], rows: [[1799998, 7781, 'SHIPPED'], [1799997, 112, 'PENDING'], [1799996, 42, 'DELIVERED']],
      good: { ms: 0.06, scanned: 20, plan: ['Limit  (actual time=0.019..0.048 rows=20 loops=1)', '  ->  Index Scan Backward using orders_pkey on orders  (actual rows=20 loops=1)', '        Index Cond: (id < 1799999)'] },
      lesson: 'Keyset pagination seeks straight to the boundary through the index: constant cost at any depth.',
    },
    {
      id: 'outbox', label: 'Outbox relay: pending events', idx: 'outbox',
      sql: 'SELECT id, event_type, payload\nFROM outbox\nWHERE published_at IS NULL\nORDER BY id\nLIMIT 100\nFOR UPDATE SKIP LOCKED;',
      cols: ['id', 'event_type', 'payload'], rows: [[6400113, 'order.created', '{"order_id":1899843,…}'], [6400114, 'order.cancelled', '{"order_id":1897730,…}']],
      good: { ms: 0.05, scanned: 37, plan: ['Limit  (actual time=0.021..0.041 rows=37 loops=1)', '  ->  LockRows  (actual rows=37 loops=1)', '        ->  Index Scan using outbox_unpublished_idx on outbox  (actual rows=37 loops=1)'] },
      bad: { ms: 812.7, scanned: 6400000, plan: ['Limit  (actual time=811.9..812.7 rows=37 loops=1)', '  ->  LockRows  (actual rows=37 loops=1)', '        ->  Sort  (actual rows=37 loops=1)', '              ->  Seq Scan on outbox  (actual rows=37 loops=1)', '                    Filter: (published_at IS NULL)', '                    Rows Removed by Filter: 6399963'] },
    },
    {
      id: 'status', label: 'Pending orders created today', idx: 'status_created',
      sql: "SELECT id, user_id, created_at\nFROM orders\nWHERE status = 'PENDING'\n  AND created_at > now() - interval '1 day';",
      cols: ['id', 'user_id', 'created_at'], rows: [[1899843, 42, '2026-10-31 09:41'], [1899840, 311, '2026-10-31 09:40']],
      good: { ms: 1.9, scanned: 1240, plan: ['Index Scan using orders_status_created_idx on orders  (actual time=0.03..1.86 rows=1240 loops=1)', "  Index Cond: ((status = 'PENDING') AND (created_at > (now() - '1 day'::interval)))"] },
      bad: { ms: 211.3, scanned: 2000000, plan: ['Gather  (actual time=3.1..211.3 rows=1240 loops=1)', '  Workers Planned: 2', '  ->  Parallel Seq Scan on orders  (actual rows=413 loops=3)', "        Filter: ((status = 'PENDING') AND (created_at > (now() - '1 day'::interval)))", '        Rows Removed by Filter: 666253'] },
    },
    {
      id: 'email', label: 'Login lookup by email (users)', idx: 'email',
      sql: "SELECT id, password_hash, status\nFROM users\nWHERE email = 'ada@example.com';",
      cols: ['id', 'password_hash', 'status'], rows: [[42, '$2a$12$Qe…', 'active']],
      good: { ms: 0.04, scanned: 1, plan: ['Index Scan using users_email_key on users  (actual time=0.021..0.022 rows=1 loops=1)', "  Index Cond: (email = 'ada@example.com'::text)"] },
      bad: { ms: 142.6, scanned: 1200000, plan: ['Gather  (actual time=0.4..142.6 rows=1 loops=1)', '  Workers Planned: 2', '  ->  Parallel Seq Scan on users  (actual rows=0 loops=3)', "        Filter: (email = 'ada@example.com'::text)", '        Rows Removed by Filter: 400000'] },
    },
  ];

  MV.widgets['sql-lab'] = function (el) {
    const ui = MV.wkit.frame(el, {
      title: 'Query lab: orders (2M rows), outbox (6.4M), users (1.2M)',
      sub: 'Real query shapes from Order and User Service; simulated planner output',
      ico: 'database',
      controls: `<label class="field-inline">Query <select class="select" data-q>${QUERIES.map((q, i) => `<option value="${i}">${esc(q.label)}</option>`).join('')}</select></label>
        <button class="btn btn-sm btn-primary" type="button" data-run>${icon('play')}EXPLAIN ANALYZE</button>`,
    });
    ui.body.innerHTML = `<div class="grid gap-3">
        <div class="wg-panel"><div class="wg-panel-title">${icon('list-tree', '', 13)}Indexes (click to create or drop)</div><div class="sq-idx" data-idx></div><div class="text-[12px] text-mutedc mt-2 mono" data-ddl></div></div>
        <div class="wg-grid"><div data-sql></div><div class="grid gap-3 content-start">
          <div class="wg-stats"><div class="wg-stat"><div class="wg-stat-label">Execution time</div><div class="wg-stat-value" data-ms>—</div></div><div class="wg-stat"><div class="wg-stat-label">Rows examined</div><div class="wg-stat-value" data-sc>—</div></div><div class="wg-stat"><div class="wg-stat-label">Rows returned</div><div class="wg-stat-value" data-rr>—</div></div></div>
          <div class="wg-note" data-note>Run the query to see its plan.</div>
        </div></div>
        <div class="sq-plan" data-plan aria-live="polite">-- EXPLAIN (ANALYZE) output appears here</div>
        <div class="table-wrap" data-res></div>
      </div>`;
    const state = Object.fromEntries(Object.entries(INDEXES).map(([k, v]) => [k, v.on]));
    function renderIdx() {
      $('[data-idx]', ui.body).innerHTML = Object.entries(INDEXES).map(([k, v]) => `<button type="button" class="chip" data-toggle-idx="${k}" aria-pressed="${state[k]}" style="${state[k] ? 'border-color:color-mix(in srgb,var(--green) 50%,transparent);color:var(--fg)' : 'opacity:.75'}">${icon(state[k] ? 'circle-check' : 'circle-dashed', '', 13)}<span class="mono">${v.name}</span></button>`).join('') + '<span class="chip">' + icon('key-round', '', 13) + '<span class="mono">orders_pkey (always)</span></span>';
    }
    function renderSql() {
      const q = QUERIES[+$('[data-q]', el).value];
      $('[data-sql]', ui.body).innerHTML = MV.ui.codeBlock(q.sql, { lang: 'sql', lineNumbers: false, title: 'query.sql' });
    }
    function run() {
      const q = QUERIES[+$('[data-q]', el).value];
      const indexed = !q.idx || state[q.idx];
      const r = indexed ? q.good : q.bad;
      const fmt = (ms) => ms < 1 ? `${ms.toFixed(2)} ms` : `${ms.toFixed(1)} ms`;
      $('[data-ms]', ui.body).textContent = fmt(r.ms);
      $('[data-ms]', ui.body).className = 'wg-stat-value ' + (r.ms < 5 ? 'is-ok' : r.ms < 50 ? 'is-warn' : 'is-err');
      $('[data-sc]', ui.body).textContent = r.scanned.toLocaleString();
      $('[data-rr]', ui.body).textContent = q.id === 'email' ? '1' : q.id === 'outbox' ? '37' : q.id === 'status' ? '1,240' : '20';
      const planText = r.plan.map((l) => esc(l).replace(/(Seq Scan[^(]*|Rows Removed by Filter: \d+|Sort Method[^\n]*|OFFSET reads[^\n]*)/g, '<span class="hl-bad">$1</span>').replace(/(Index Scan[^(]*|Index Cond: [^\n]*)/g, '<span class="hl-good">$1</span>')).join('\n');
      $('[data-plan]', ui.body).innerHTML = `-- simulated: plan modelled on PostgreSQL 16 for this data size\n${planText}\nPlanning Time: 0.112 ms\nExecution Time: ${r.ms.toFixed(3)} ms`;
      $('[data-res]', ui.body).innerHTML = `<table class="table"><thead><tr>${q.cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${q.rows.map((row) => `<tr>${row.map((v) => `<td class="mono">${esc(String(v))}</td>`).join('')}</tr>`).join('')}<tr><td colspan="${q.cols.length}" class="text-mutedc">…</td></tr></tbody></table>`;
      const note = $('[data-note]', ui.body);
      if (q.lesson) { note.className = 'wg-note' + (q.id === 'offset' ? ' is-warn' : ' is-ok'); note.innerHTML = MV.ui.inlineMd(q.lesson); }
      else if (indexed) { note.className = 'wg-note is-ok'; note.innerHTML = MV.ui.inlineMd(`**${INDEXES[q.idx].name}** serves this query: the planner seeks directly to the matching entries and reads only what it returns.`); }
      else { note.className = 'wg-note is-err'; note.innerHTML = MV.ui.inlineMd(`Without **${INDEXES[q.idx].name}** the planner must scan every row and filter — ${Math.round(q.bad.ms / q.good.ms).toLocaleString()}× slower here, and it gets worse as the table grows. Click the index above to create it.`); }
    }
    $('[data-idx]', ui.body).addEventListener('click', (e) => {
      const b = e.target.closest('[data-toggle-idx]');
      if (!b) return;
      const k = b.dataset.toggleIdx;
      state[k] = !state[k];
      $('[data-ddl]', ui.body).textContent = state[k] ? INDEXES[k].ddl : `DROP INDEX CONCURRENTLY ${INDEXES[k].name};`;
      renderIdx();
      run();
    });
    $('[data-q]', el).addEventListener('change', () => { renderSql(); run(); });
    $('[data-run]', el).addEventListener('click', run);
    renderIdx(); renderSql(); run();
  };
})(window.MV);
