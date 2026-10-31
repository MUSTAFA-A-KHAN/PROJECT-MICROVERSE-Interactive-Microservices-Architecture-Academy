/* ==========================================================================
   Microverse — Code Lab: write Go and run it for real.
   #/code          exercise list
   #/code/:id      workspace: brief, editor, tests, console
   #/code/scratch  free-form program

   Execution is real, never simulated (see js/runner.js):
     - in the browser: a Go interpreter compiled to WebAssembly, so the Code
       Lab works on static hosting such as GitHub Pages;
     - with the dev server: the Go toolchain on this machine (the real gc
       compiler), or the official Go Playground at go.dev.
   When no backend can run (no WebAssembly, or the page opened from a file),
   the page says so plainly.
   ========================================================================== */
window.MV = window.MV || {};
MV.widgets = MV.widgets || {};

(function (MV) {
  'use strict';
  const { $, $$, esc, icon, toast } = MV.ui;
  const store = MV.store;
  const LEVEL_CLS = { Beginner: 'badge-green', Intermediate: 'badge-warn', Advanced: 'badge-err' };
  const BASE = 'content/exercises/';
  const CONSENT = 'microverse:playground-consent';

  const exercises = () => MV.data.exercises;
  const byId = (id) => exercises().find((e) => e.id === id);

  function status(id) {
    const e = store.get().exercises[id];
    if (!e || (!e.runs && !e.code)) return { label: 'New', cls: 'badge-muted', ic: 'circle-dashed' };
    if (e.solved) return { label: 'Solved', cls: 'badge-green', ic: 'circle-check' };
    if (e.best) return { label: `${e.best.passed}/${e.best.total} tests`, cls: 'badge-blue', ic: 'circle-play' };
    return { label: 'In progress', cls: 'badge-blue', ic: 'circle-play' };
  }
  const solvedCount = () => exercises().filter((e) => (store.get().exercises[e.id] || {}).solved).length;

  async function loadFiles(ex) {
    const get = (f) => MV.ui.fetchText(BASE + f);
    const [readme, starter, tests, testkit, support] = await Promise.all([
      get(`${ex.id}/README.md`), get(`${ex.id}/starter.go.txt`), get(`${ex.id}/tests.go.txt`), get('testkit.go.txt'),
      ex.support ? get(`${ex.id}/support.go.txt`) : Promise.resolve(null),
    ]);
    return { readme, starter, tests, testkit, support };
  }

  function hasConsent() { try { return localStorage.getItem(CONSENT) === '1'; } catch (_) { return false; } }
  function giveConsent() { try { localStorage.setItem(CONSENT, '1'); } catch (_) { /* storage blocked */ } }

  const BACKENDS = {
    browser: { icon: 'globe', label: 'In browser', tip: 'A Go interpreter compiled to WebAssembly runs your code in this tab. Nothing is sent anywhere.' },
    local: { icon: 'cpu', label: 'Local Go', tip: 'Compiled and run by the Go toolchain on this machine (via npm run dev).' },
    playground: { icon: 'cloud', label: 'Go Playground', tip: 'Compiled and run on go.dev: your code is sent there.' },
  };

  /** One line describing where code will run — shown wherever a Run button is. */
  function backendLabel(inf, backend) {
    if (!MV.runner.canRun(inf)) return 'Execution unavailable';
    if (backend === 'local') return `Local Go · ${(inf.local.version || '').split(' ')[0]}`;
    if (backend === 'playground') return 'Go Playground · go.dev';
    return 'In browser · Go interpreter (WebAssembly)';
  }

  function noRunHtml(inf) {
    const why = inf.reason === 'file'
      ? 'This page was opened from a file, and browsers block what the Code Lab needs on file:// pages.'
      : 'This browser can\'t start the in-browser Go engine: it needs WebAssembly, Web Workers and DecompressionStream (any current Chrome, Edge, Firefox or Safari has them).';
    return `<div class="callout callout-warn">${icon('plug-zap')}<div><div class="callout-title">Your code can't run here yet</div><div class="callout-body">
      <p>${why} Editing still works and your code is saved in this browser.</p>
      <p>Serve the site over HTTP (any static host, such as GitHub Pages, works), or run the dev server to use the Go toolchain on your machine:</p>
      ${MV.ui.codeBlock('npm run dev', { lang: 'bash', lineNumbers: false })}</div></div></div>`;
  }

  /** "Downloading the Go engine… 3.1 of 8.5 MB" while the in-browser engine loads. */
  function engineProgress() {
    const st = MV.gowasm ? MV.gowasm.state() : { status: 'idle' };
    if (st.status === 'loading') return `Downloading the Go engine (once): ${(st.loaded / 1e6).toFixed(1)} of ${(st.total / 1e6).toFixed(1)} MB…`;
    if (st.status === 'compiling') return 'Starting the Go engine…';
    return null;
  }

  /* ======================================================================
     List
     ====================================================================== */
  async function renderList(view, query) {
    MV.shell.setCrumbs([{ label: 'Practice', href: '#/challenges' }, { label: 'Code Lab' }]);
    const all = exercises();
    const solved = solvedCount();
    let level = query.level || 'All';
    view.innerHTML = `<div class="page">
      <div class="page-head"><div><div class="eyebrow">Practice</div><h1 class="page-title mt-1">Code Lab</h1>
        <p class="page-sub">Write real Go for the patterns in this course. Each exercise comes with a test suite; press <span class="kbd">Ctrl</span> <span class="kbd">Enter</span> to run your code against it and see which tests pass.</p></div>
        <div class="card card-pad flex items-center gap-4" style="padding:14px 18px">${MV.ui.ring(solved / all.length, 44, 4)}<div><div class="stat-value" style="font-size:22px">${solved}/${all.length}</div><div class="stat-sub">solved</div></div></div></div>
      <div class="cl-env card" data-env>${MV.ui.skeleton(1)}</div>
      <a class="card card-link spotlight cl-scratch-card" href="#/code/scratch">
        <span class="icon-tile" style="--c:var(--purple)">${icon('square-terminal')}</span>
        <span class="min-w-0 flex-1"><span class="block font-semibold text-[15px]" style="color:var(--fg)">Go scratchpad</span>
          <span class="block text-[13px] text-fg2 mt-0.5">${esc(MV.data.scratch.summary)} No tests, just <span class="mono">go run</span>.</span></span>
        <span class="btn btn-sm">Open${icon('arrow-right')}</span>
      </a>
      <div class="flex flex-wrap items-center gap-3 mb-4 mt-6"><div class="segmented" role="group" aria-label="Difficulty">${['All', 'Beginner', 'Intermediate', 'Advanced'].map((l) => `<button type="button" data-level="${l}" aria-pressed="${l === level}">${l}</button>`).join('')}</div>
        <span class="text-[12.5px] text-mutedc">${all.length} exercises · each verified against a reference solution</span></div>
      <div class="grid-auto" data-cards></div></div>`;

    const draw = () => {
      $('[data-cards]', view).innerHTML = all.filter((e) => level === 'All' || e.level === level).map((e) => {
        const st = status(e.id);
        const n = all.indexOf(e) + 1;
        return `<a class="card card-link spotlight card-pad grid gap-3 content-start" href="#/code/${e.id}" data-reveal>
          <div class="flex items-center gap-2"><span class="mono text-[11.5px] text-mutedc">${String(n).padStart(2, '0')}</span><span class="badge badge-square ${LEVEL_CLS[e.level]}">${e.level}</span><span class="text-[12px] text-mutedc flex items-center gap-1">${icon('clock', '', 12)}${e.minutes} min</span><span class="badge ${st.cls} ml-auto">${icon(st.ic)}${esc(st.label)}</span></div>
          <div><div class="font-semibold text-[15px]" style="color:var(--fg)">${esc(e.title)}</div><p class="text-[13px] text-fg2 mt-1">${esc(e.summary)}</p></div>
          <div class="flex flex-wrap gap-1.5">${e.concepts.map((k) => `<span class="chip" style="height:22px;font-size:11px">${esc(MV.quiz.conceptLabel(k))}</span>`).join('')}</div>
        </a>`;
      }).join('');
      MV.ui.revealIn(view);
    };
    $$('[data-level]', view).forEach((b) => b.addEventListener('click', () => {
      level = b.dataset.level;
      $$('[data-level]', view).forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      draw();
    }));
    draw();

    const inf = await MV.runner.info();
    const env = $('[data-env]', view);
    if (!env) return;
    if (!MV.runner.canRun(inf)) { env.classList.remove('card'); env.innerHTML = noRunHtml(inf); return; }
    const local = inf.local.available;
    env.innerHTML = `<div class="cl-env-row">
      <span class="icon-tile sm" style="--c:var(--green)">${icon(local ? 'cpu' : 'globe')}</span>
      <div class="min-w-0 flex-1"><div class="text-[13.5px] font-semibold" style="color:var(--fg)">${local ? `Your code runs on this machine with <span class="mono">${esc(inf.local.version)}</span>` : 'Your code runs right here in your browser'}</div>
        <div class="text-[12.5px] text-fg2">${local
          ? 'Each run is compiled by the real Go toolchain in a temporary folder, with a time limit and no network access. You can also switch an exercise to the in-browser engine or the Go Playground.'
          : 'A Go interpreter compiled to WebAssembly runs your code in this tab: no server, and nothing is sent anywhere. It downloads once (about 8.5 MB) the first time you press Run.'}</div></div>
      <span class="badge badge-green">${icon('circle-check')}Real execution</span></div>`;
  }

  /* ======================================================================
     Workspace
     ====================================================================== */
  class Workspace {
    constructor(view, ex, files, inf, nav) {
      this.view = view;
      this.ex = ex;
      this.scratch = ex.id === 'scratch';
      this.files = files;
      this.inf = inf;
      this.nav = nav;
      this.backend = MV.runner.preferredBackend(inf);
      this.tests = this.scratch ? [] : MV.runner.testNames(files.tests).map((name) => ({ name, state: 'idle' }));
      this.fileTab = 'exercise.go';
      this.resTab = this.scratch ? 'output' : 'tests';
      this.running = false;
      this.last = null;
      const saved = store.get().exercises[ex.id] || {};
      this.render(saved.code != null ? saved.code : files.starter);
    }

    get mainFile() { return this.scratch ? 'main.go' : 'exercise.go'; }

    tabsHtml() {
      const tabs = this.scratch ? [['exercise.go', 'main.go', false]] : [
        ['exercise.go', 'exercise.go', false],
        ['main.go', 'main.go · tests', true],
        ...(this.files.support ? [['support.go', 'support.go', true]] : []),
        ['testkit.go', 'testkit.go', true],
      ];
      return tabs.map(([key, label, ro]) => `<div class="pg-tab${key === this.fileTab ? ' is-active' : ''}" role="presentation">
        <button type="button" class="pg-tab-open" role="tab" aria-selected="${key === this.fileTab}" data-ftab="${key}">${icon(ro ? 'lock' : 'file-code-2', '', 13)}<span>${esc(label)}</span></button></div>`).join('');
    }

    render(code) {
      const ex = this.ex;
      const idx = exercises().indexOf(ex);
      const runDisabled = !MV.runner.canRun(this.inf);
      const choices = Object.keys(BACKENDS).filter((b) => this.inf[b] && this.inf[b].available);
      this.view.innerHTML = `<div class="cl${this.scratch ? ' is-scratch' : ''}">
        <div class="cl-bar">
          <a class="btn btn-ghost btn-sm" href="#/code">${icon('arrow-left')}<span class="cl-hide-sm">Code Lab</span></a>
          <div class="cl-title">
            ${this.scratch ? `<span class="badge badge-square badge-purple">${icon('square-terminal')}Scratchpad</span>` : `<span class="badge badge-square ${LEVEL_CLS[ex.level]}">${ex.level}</span>`}
            <h1>${esc(ex.title)}</h1>
            ${this.scratch ? '' : `<span class="badge ${status(ex.id).cls}" data-status>${icon(status(ex.id).ic)}${esc(status(ex.id).label)}</span>`}
          </div>
          <div class="cl-actions">
            ${choices.length > 1 ? `<div class="segmented cl-backend" role="group" aria-label="Where your code runs">
              ${choices.map((b) => `<button type="button" data-backend="${b}" aria-pressed="${this.backend === b}" data-tip="${esc(BACKENDS[b].tip)}">${icon(BACKENDS[b].icon)}<span>${BACKENDS[b].label}</span></button>`).join('')}</div>`
              : choices.length === 1 ? `<span class="badge badge-green" data-tip="${esc(BACKENDS[choices[0]].tip)}">${icon(BACKENDS[choices[0]].icon)}${BACKENDS[choices[0]].label}</span>` : ''}
            <button class="btn btn-sm btn-ghost" type="button" data-fmt${runDisabled ? ' disabled' : ''} data-tip="Format with gofmt (Shift+Alt+F)">${icon('wand-sparkles')}<span class="cl-hide-sm">Format</span></button>
            <button class="btn btn-sm btn-ghost" type="button" data-copy-code data-tip="Copy your code">${icon('copy')}<span class="cl-hide-sm">Copy</span></button>
            <button class="btn btn-sm btn-ghost" type="button" data-reset data-tip="${this.scratch ? 'Restore the example' : 'Restore the starter code'}">${icon('rotate-ccw')}<span class="cl-hide-sm">Reset</span></button>
            <button class="btn btn-sm btn-primary" type="button" data-run${runDisabled ? ' disabled' : ''}>${icon('play')}<span>${this.scratch ? 'Run' : 'Run tests'}</span><span class="kbd cl-kbd">Ctrl ↵</span></button>
          </div>
        </div>
        <div class="cl-body">
          <aside class="cl-brief scroll-thin" data-lenis-prevent aria-label="${this.scratch ? 'About the scratchpad' : 'Exercise brief'}">${this.scratch ? this.scratchBrief() : this.briefHtml(idx)}</aside>
          <section class="cl-main" aria-label="Editor and results">
            <div class="cl-editor">
              <div class="pg-tabs scroll-thin" role="tablist" aria-label="Files" data-ftabs>${this.tabsHtml()}</div>
              <div class="cl-ed-host" data-ed-main></div>
              <div class="cl-ed-host" data-ed-view hidden></div>
              <div class="cl-status"><span data-caret>Ln 1, Col 1</span><span data-saved>${icon('check', '', 12)}Saved in this browser</span><span class="ml-auto" data-backend-label>${icon(MV.runner.canRun(this.inf) ? 'circle-check' : 'circle-off', '', 12)}${esc(backendLabel(this.inf, this.backend))}</span></div>
            </div>
            <div class="cl-split" role="separator" aria-orientation="horizontal" aria-label="Resize results panel" tabindex="0"></div>
            <div class="cl-results">
              <div class="cl-res-tabs" role="tablist" aria-label="Results">
                ${this.scratch ? '' : `<button type="button" role="tab" data-rtab="tests" aria-selected="${this.resTab === 'tests'}">${icon('list-checks')}Tests <span class="cl-count" data-test-count>${this.tests.length}</span></button>`}
                <button type="button" role="tab" data-rtab="output" aria-selected="${this.resTab === 'output'}">${icon('terminal')}Output</button>
                <span class="cl-res-meta" data-res-meta></span>
              </div>
              <div class="cl-res-body scroll-thin" data-lenis-prevent data-res-body aria-live="polite"></div>
            </div>
          </section>
        </div>
      </div>`;

      this.editor = new MV.Editor($('[data-ed-main]', this.view), {
        value: code, lang: 'go', label: `${this.mainFile} — your code`,
        onChange: (v) => this.onChange(v),
        onRun: () => this.run(),
        onSave: () => { store.saveExerciseCode(this.ex.id, this.editor.value); this.flashSaved('Saved'); },
        onFormat: () => this.format(),
        onCaret: (l, c) => { const el = $('[data-caret]', this.view); if (el) el.textContent = `Ln ${l}, Col ${c}`; },
      });
      this.viewer = null;
      this.bind();
      if (MV.gowasm && this.inf.browser.available) {
        this.offEngine = MV.gowasm.onState(() => { if (this.running) this.renderResults(); });
        if (this.backend === 'browser') setTimeout(() => MV.gowasm.load().catch(() => {}), 600);
      }
      this.renderResults();
      if (window.innerWidth > 1060) setTimeout(() => this.editor.focus(), 60);
    }

    briefHtml(idx) {
      const ex = this.ex;
      const saved = store.get().exercises[ex.id] || {};
      const shown = Math.min(saved.hints || 0, ex.hints.length);
      const lesson = MV.catalog.lesson(ex.lesson);
      return `<div class="cl-brief-in">
        <div class="flex flex-wrap items-center gap-2 text-[12px] text-mutedc"><span>Exercise ${idx + 1} of ${exercises().length}</span><span>·</span><span class="flex items-center gap-1">${icon('clock', '', 12)}${ex.minutes} min</span></div>
        <div class="prose cl-prose mt-3">${MV.md.render(this.files.readme, {})}</div>
        <div class="cl-sec">
          <div class="cl-sec-label">${icon('lightbulb', '', 13)}Hints</div>
          <ol class="cl-hints" data-hints>${ex.hints.slice(0, shown).map((h) => `<li>${MV.ui.inlineMd(h)}</li>`).join('')}</ol>
          ${shown < ex.hints.length ? `<button class="btn btn-sm" type="button" data-hint>${icon('eye')}Show hint ${shown + 1} of ${ex.hints.length}</button>` : `<p class="text-[12.5px] text-mutedc">All hints shown.</p>`}
        </div>
        <div class="cl-sec">
          <div class="cl-sec-label">${icon('book-check', '', 13)}Reference solution</div>
          <div data-solution>${saved.sawSolution ? '' : `<p class="text-[12.5px] text-fg2 mb-2">One correct approach, verified against these tests. Try the hints first. You learn more from a failing test than from reading the answer.</p>`}
            <button class="btn btn-sm" type="button" data-show-solution>${icon('eye')}Show solution</button></div>
        </div>
        <div class="cl-sec">
          <div class="cl-sec-label">${icon('book-open', '', 13)}Learn more</div>
          ${lesson ? `<a class="mini-link" href="${lesson.route}">${icon('book-open', '', 14)}<span class="flex-1 min-w-0"><span class="block truncate text-[12.5px]" style="color:var(--fg)">${esc(lesson.title)}</span><span class="block text-[11.5px] text-mutedc">${esc(lesson.module.num)} · ${esc(lesson.module.nav)}</span></span></a>` : ''}
        </div>
      </div>`;
    }

    scratchBrief() {
      const sc = MV.data.scratch;
      return `<div class="cl-brief-in">
        <div class="prose cl-prose"><p>A complete Go program you can change freely. It is compiled and run as <span class="mono">main.go</span> in a fresh module.</p>
          <ul><li>Standard library only. No third-party modules, no network.</li><li>10-second time limit; output is capped at 128 KB.</li><li>Your code is saved in this browser as you type.</li></ul></div>
        <div class="cl-sec"><div class="cl-sec-label">${icon('files', '', 13)}Examples</div>
          <div class="grid gap-1.5">${sc.examples.map((x) => `<button type="button" class="mini-link" data-example="${esc(x.file)}">${icon('file-code-2', '', 14)}<span class="flex-1 min-w-0 text-left"><span class="block truncate text-[12.5px]" style="color:var(--fg)">${esc(x.title)}</span><span class="block text-[11.5px] text-mutedc">${esc(x.desc)}</span></span></button>`).join('')}</div></div>
        <div class="cl-sec"><div class="cl-sec-label">${icon('keyboard', '', 13)}Keys</div>
          <dl class="cl-keys"><dt><span class="kbd">Ctrl</span> <span class="kbd">Enter</span></dt><dd>Run</dd><dt><span class="kbd">Shift</span> <span class="kbd">Alt</span> <span class="kbd">F</span></dt><dd>Format (gofmt)</dd><dt><span class="kbd">Ctrl</span> <span class="kbd">/</span></dt><dd>Toggle comment</dd><dt><span class="kbd">Tab</span> / <span class="kbd">Shift</span> <span class="kbd">Tab</span></dt><dd>Indent / outdent</dd><dt><span class="kbd">Esc</span> then <span class="kbd">Tab</span></dt><dd>Leave the editor</dd></dl></div>
        <div class="cl-sec"><div class="cl-sec-label">${icon('list-checks', '', 13)}Want tests?</div><a class="btn btn-sm" href="#/code">${icon('code-xml')}Browse exercises</a></div>
      </div>`;
    }

    bind() {
      const v = this.view;
      $('[data-run]', v).addEventListener('click', () => this.run());
      $('[data-fmt]', v).addEventListener('click', () => this.format());
      $('[data-reset]', v).addEventListener('click', () => this.reset());
      $('[data-copy-code]', v).addEventListener('click', async () => { const ok = await MV.ui.copyText(this.editor.value); toast(ok ? 'Code copied' : 'Copy failed', { type: ok ? 'success' : 'error' }); });
      $$('[data-backend]', v).forEach((b) => b.addEventListener('click', () => this.setBackend(b.dataset.backend)));
      $('[data-ftabs]', v).addEventListener('click', (e) => { const b = e.target.closest('[data-ftab]'); if (b) this.showFile(b.dataset.ftab); });
      $$('[data-rtab]', v).forEach((b) => b.addEventListener('click', () => this.setResTab(b.dataset.rtab)));
      const brief = $('.cl-brief', v);
      brief.addEventListener('click', (e) => {
        if (e.target.closest('[data-hint]')) this.showHint();
        else if (e.target.closest('[data-show-solution]')) this.showSolution();
        else if (e.target.closest('[data-load-solution]')) this.loadSolution();
        else if (e.target.closest('[data-example]')) this.loadExample(e.target.closest('[data-example]').dataset.example);
      });
      $('[data-res-body]', v).addEventListener('click', (e) => {
        const j = e.target.closest('[data-jump]');
        if (j) { this.showFile('exercise.go'); this.editor.revealLine(+j.dataset.jump, +(j.dataset.col || 1)); }
        const n = e.target.closest('[data-next]');
        if (n) MV.router.go(n.dataset.next);
        const rj = e.target.closest('[data-rtab-jump]');
        if (rj) this.setResTab(rj.dataset.rtabJump);
      });
      // Ctrl+Enter runs from anywhere in the workspace, not just the editor.
      const onKey = (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !document.querySelector('.dialog-scrim')) { e.preventDefault(); this.run(); } };
      v.addEventListener('keydown', onKey);
      this.bindSplit();
      MV.router.onLeave(() => {
        clearTimeout(this.saveT);
        store.saveExerciseCode(this.ex.id, this.editor.value);
        this.editor.destroy();
        this.viewer && this.viewer.destroy();
        this.offEngine && this.offEngine();
      });
    }

    bindSplit() {
      const split = $('.cl-split', this.view);
      const main = $('.cl-main', this.view);
      let saved = null;
      try { saved = localStorage.getItem('microverse:cl-split'); } catch (_) { /* storage blocked */ }
      if (saved) main.style.setProperty('--res-h', saved);
      const set = (px) => {
        const h = Math.max(120, Math.min(main.clientHeight - 160, px));
        main.style.setProperty('--res-h', `${h}px`);
        try { localStorage.setItem('microverse:cl-split', `${h}px`); } catch (_) { /* storage blocked */ }
      };
      split.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        split.setPointerCapture(e.pointerId);
        const move = (ev) => set(main.getBoundingClientRect().bottom - ev.clientY);
        const up = () => { split.removeEventListener('pointermove', move); split.removeEventListener('pointerup', up); };
        split.addEventListener('pointermove', move);
        split.addEventListener('pointerup', up);
      });
      split.addEventListener('keydown', (e) => {
        const cur = $('.cl-results', this.view).offsetHeight;
        if (e.key === 'ArrowUp') { e.preventDefault(); set(cur + 24); }
        if (e.key === 'ArrowDown') { e.preventDefault(); set(cur - 24); }
      });
    }

    onChange(v) {
      clearTimeout(this.saveT);
      const el = $('[data-saved]', this.view);
      if (el) el.innerHTML = `${icon('pencil', '', 12)}Editing…`;
      this.saveT = setTimeout(() => { store.saveExerciseCode(this.ex.id, v); this.flashSaved(); }, 500);
    }

    flashSaved(text = 'Saved in this browser') {
      const el = $('[data-saved]', this.view);
      if (el) el.innerHTML = `${icon('check', '', 12)}${text}`;
    }

    showFile(key) {
      this.fileTab = key;
      $('[data-ftabs]', this.view).innerHTML = this.tabsHtml();
      const mainHost = $('[data-ed-main]', this.view), viewHost = $('[data-ed-view]', this.view);
      if (key === 'exercise.go') { mainHost.hidden = false; viewHost.hidden = true; this.editor.focus(); return; }
      const src = key === 'main.go' ? this.files.tests : key === 'support.go' ? this.files.support : this.files.testkit;
      if (!this.viewer) this.viewer = new MV.Editor(viewHost, { value: src, lang: 'go', readOnly: true, label: `${key} (read-only)`, onRun: () => this.run() });
      else this.viewer.setValue(src);
      mainHost.hidden = true; viewHost.hidden = false;
      this.viewer.measure();
    }

    setBackend(b) {
      if (b === this.backend) return;
      this.backend = b;
      MV.runner.setBackend(b);
      $$('[data-backend]', this.view).forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.backend === b)));
      $('[data-backend-label]', this.view).innerHTML = `${icon('circle-check', '', 12)}${esc(backendLabel(this.inf, b))}`;
      if (b === 'playground') toast('Runs on the Go Playground', { desc: 'Your code will be sent to go.dev to compile and run.', duration: 3500 });
    }

    setResTab(t) {
      this.resTab = t;
      $$('[data-rtab]', this.view).forEach((x) => x.setAttribute('aria-selected', String(x.dataset.rtab === t)));
      this.renderResults();
    }

    /* ---------------- results ---------------- */
    renderResults() {
      const body = $('[data-res-body]', this.view);
      if (!body) return;
      const passed = this.tests.filter((t) => t.state === 'pass').length;
      const cnt = $('[data-test-count]', this.view);
      if (cnt) {
        const ran = this.tests.some((t) => t.state === 'pass' || t.state === 'fail');
        cnt.textContent = ran ? `${passed}/${this.tests.length}` : String(this.tests.length);
        cnt.className = `cl-count${ran ? (passed === this.tests.length ? ' is-ok' : ' is-bad') : ''}`;
      }
      const meta = $('[data-res-meta]', this.view);
      if (meta) meta.innerHTML = this.last && !this.last.error ? this.metaHtml(this.last) : '';
      body.innerHTML = this.resTab === 'tests' ? this.testsHtml() : this.outputHtml();
    }

    metaHtml(r) {
      const parts = [r.backend === 'local' ? `local · ${esc((r.goVersion || '').split(' ')[0])}` : r.backend === 'browser' ? `in browser · ${esc(r.goVersion || 'Go interpreter')}` : 'go.dev playground'];
      if (r.buildMs) parts.push(`build ${(r.buildMs / 1000).toFixed(1)}s`);
      if (r.phase === 'run' && r.runMs) parts.push(`run ${(r.runMs / 1000).toFixed(2)}s`);
      return `${icon('cpu', '', 12)}${parts.join(' · ')}`;
    }

    testsHtml() {
      if (!MV.runner.canRun(this.inf) && !this.last) return noRunHtml(this.inf);
      const r = this.last;
      let banner = '';
      if (this.running) banner = `<div class="cl-banner is-run"><span class="spinner"></span>${esc(engineProgress() || `Compiling and running ${this.tests.length} tests…`)}</div>`;
      else if (r && r.error) banner = `<div class="cl-banner is-bad">${icon('octagon-alert')}<span>${esc(r.error)}</span></div>`;
      else if (r && r.phase === 'build') banner = `<div class="cl-banner is-bad">${icon('octagon-alert')}<span>Build failed. Fix the compile errors, then run again. <button type="button" class="link-btn" data-rtab-jump="output">Show errors</button></span></div>`;
      else if (r && this.allPass) {
        const next = exercises()[exercises().indexOf(this.ex) + 1];
        banner = `<div class="cl-banner is-ok">${icon('party-popper')}<span><strong>All ${this.tests.length} tests pass.</strong> Compare your approach with the reference solution, then move on.</span>${next ? `<button type="button" class="btn btn-sm btn-success" data-next="#/code/${next.id}">Next: ${esc(next.title)}${icon('arrow-right')}</button>` : `<button type="button" class="btn btn-sm btn-success" data-next="#/code">All exercises${icon('arrow-right')}</button>`}</div>`;
      } else if (r && r.timedOut) banner = `<div class="cl-banner is-bad">${icon('timer-off')}<span>The program was stopped after 10 s. Look for a deadlock or an infinite loop.</span></div>`;
      else if (r && !r.parsed) banner = `<div class="cl-banner is-bad">${icon('octagon-alert')}<span>The program exited before reporting results (exit ${r.exitCode}). <button type="button" class="link-btn" data-rtab-jump="output">See the output</button></span></div>`;
      else if (!r) banner = `<div class="cl-banner">${icon('info')}<span>Not run yet. Press <span class="kbd">Ctrl</span> <span class="kbd">Enter</span> to build your code with the tests and run them.</span></div>`;
      const rows = this.tests.map((t) => {
        const ic = this.running ? 'loader' : t.state === 'pass' ? 'circle-check' : t.state === 'fail' ? 'circle-x' : 'circle-dashed';
        return `<li class="cl-test is-${this.running ? 'run' : t.state}">${icon(ic, '', 15)}<div class="min-w-0"><div class="cl-test-name">${esc(t.name)}</div>${t.msg && !this.running ? `<pre class="cl-test-msg">${esc(t.msg)}</pre>` : ''}</div></li>`;
      }).join('');
      return `${banner}<ul class="cl-tests">${rows}</ul>`;
    }

    outputHtml() {
      if (!MV.runner.canRun(this.inf) && !this.last) return noRunHtml(this.inf);
      if (this.running) return `<div class="cl-banner is-run"><span class="spinner"></span>${esc(engineProgress() || (this.backend === 'local' ? 'Building with your local Go toolchain…' : this.backend === 'browser' ? 'Running in your browser…' : 'Sending to go.dev…'))}</div>`;
      const r = this.last;
      if (!r) return `<div class="cl-console cl-muted">${this.scratch ? 'Press Run (Ctrl+Enter) to compile and run main.go.' : 'Output from your code (fmt.Println and friends) and compiler errors appear here.'}</div>`;
      if (r.error) return `<div class="cl-banner is-bad">${icon('octagon-alert')}<span>${esc(r.error)}</span></div>`;
      const linkify = (text) => esc(text).replace(/((?:\.\/)?(exercise|main)\.go):(\d+)(?::(\d+))?/g, (m, f, base, l, c) =>
        (base === 'exercise' || this.scratch) ? `<button type="button" class="cl-jump" data-jump="${l}" data-col="${c || 1}">${m}</button>` : m);
      const cmd = r.backend === 'local' ? '$ go build && ./program' : r.backend === 'browser' ? '$ go run .   # in-browser Go interpreter' : '$ go.dev/play';
      const out = this.scratch ? r.stdout : MV.runner.userOutput(r.stdout);
      let html = `<div class="cl-console"><div class="cl-muted">${esc(cmd)}</div>`;
      if (r.phase === 'build') html += `<div class="cl-err">${linkify(r.stderr)}</div>`;
      else {
        if (out) html += `<div>${esc(out)}</div>`;
        if (r.stderr && r.stderr.trim()) html += `<div class="cl-err">${linkify(r.stderr)}</div>`;
        if (!out && !(r.stderr || '').trim()) html += `<div class="cl-muted">${this.scratch ? '(no output)' : '(your code printed nothing; test results are in the Tests tab)'}</div>`;
      }
      html += `<div class="cl-muted mt-2">${r.phase === 'build' ? 'build failed' : `exit status ${r.exitCode}`}${r.timedOut ? ' · killed after 10 s' : ''}</div></div>`;
      return html;
    }

    /* ---------------- actions ---------------- */
    payload() {
      const code = this.editor.value;
      if (this.scratch) return { 'main.go': code };
      const files = { 'exercise.go': code, 'main.go': this.files.tests, 'testkit.go': this.files.testkit };
      if (this.files.support) files['support.go'] = this.files.support;
      return files;
    }

    async run() {
      if (this.running) return;
      if (!MV.runner.canRun(this.inf)) { this.setResTab(this.scratch ? 'output' : 'tests'); toast('Code can\'t run in this browser', { type: 'warn', desc: 'See the note in the results panel.' }); return; }
      if (this.backend === 'playground' && !hasConsent()) {
        const ok = await MV.ui.confirm({ title: 'Send your code to the Go Playground?', message: 'The Go Playground backend compiles and runs your code on go.dev, a service run by the Go team at Google. Your code (and the exercise tests) will be sent there. Choose Local Go instead to keep everything on this machine.', confirmText: 'Send to go.dev' });
        if (!ok) return;
        giveConsent();
      }
      this.running = true;
      const btn = $('[data-run]', this.view);
      btn.disabled = true;
      btn.firstElementChild.outerHTML = '<span class="spinner"></span>';
      this.editor.setMarkers([]);
      this.renderResults();
      store.saveExerciseCode(this.ex.id, this.editor.value);
      let r;
      try {
        r = await MV.runner.run(this.payload(), this.backend);
      } catch (e) {
        r = { error: e.message };
      }
      this.running = false;
      if (btn.isConnected) { btn.disabled = false; btn.firstElementChild.outerHTML = icon('play'); }
      if (!this.view.isConnected) return;
      this.handle(r);
    }

    handle(r) {
      this.last = r;
      this.allPass = false;
      if (r.error) { this.renderResults(); return; }
      // Compiler errors → markers in the editor.
      const errs = MV.editor.parseGoErrors(r.stderr, this.mainFile);
      this.editor.setMarkers(errs.map((e) => ({ line: e.line, col: e.col, message: e.message })));
      if (r.phase === 'build') {
        const other = MV.editor.parseGoErrors(r.stderr).filter((e) => e.file !== this.mainFile);
        if (other.length && !errs.length && !this.scratch) r.stderr += '\nThe errors are in the test file: your exercise.go no longer defines something the tests use (a renamed or deleted function, type or field?).\n';
        this.tests.forEach((t) => { t.state = 'idle'; t.msg = ''; });
        this.setResTab('output');
        return;
      }
      if (this.scratch) { this.setResTab('output'); return; }
      const { tests, result } = MV.runner.parseTests(r.stdout);
      r.parsed = !!result;
      const byName = new Map(tests.map((t) => [t.name, t]));
      this.tests.forEach((t) => {
        const got = byName.get(t.name);
        t.state = got ? (got.pass ? 'pass' : 'fail') : 'idle';
        t.msg = got && !got.pass ? got.msg : '';
      });
      const passed = this.tests.filter((t) => t.state === 'pass').length;
      this.allPass = r.parsed && passed === this.tests.length;
      const wasSolved = !!(store.get().exercises[this.ex.id] || {}).solved;
      if (r.parsed) store.recordExerciseRun(this.ex.id, passed, this.tests.length);
      const st = status(this.ex.id);
      const badge = $('[data-status]', this.view);
      if (badge) { badge.className = `badge ${st.cls}`; badge.innerHTML = `${icon(st.ic)}${esc(st.label)}`; }
      this.setResTab(r.parsed ? 'tests' : 'output');
      if (this.allPass && !wasSolved) toast('Exercise solved', { type: 'success', desc: `${this.ex.title}: all ${this.tests.length} tests pass.` });
    }

    async format() {
      if (!MV.runner.canRun(this.inf)) { toast('Formatting isn\'t available in this browser', { type: 'warn' }); return; }
      if (this.fileTab !== 'exercise.go') this.showFile('exercise.go');
      try {
        const r = await MV.runner.fmt(this.editor.value, this.backend);
        if (r.error) {
          const m = MV.runner.parseFmtError(r.error);
          if (m) { this.editor.setMarkers([m]); this.editor.revealLine(m.line, m.col); }
          toast('gofmt found a syntax error', { type: 'error', desc: m ? `Line ${m.line}: ${m.message}` : r.error });
          return;
        }
        if (r.code === this.editor.value) { toast('Already formatted', { duration: 1800 }); return; }
        this.editor.setValue(r.code, { undoable: true });
        toast('Formatted with gofmt', { type: 'success', desc: 'Ctrl+Z undoes it.', duration: 2200 });
      } catch (e) {
        toast('Format failed', { type: 'error', desc: e.message });
      }
    }

    async reset() {
      const ok = await MV.ui.confirm({ title: this.scratch ? 'Restore the example program?' : 'Restore the starter code?', message: 'This replaces the code in the editor. You can still undo it with Ctrl+Z until you leave the page.', confirmText: 'Reset code', danger: true });
      if (!ok) return;
      this.showFile('exercise.go');
      this.editor.setValue(this.files.starter, { undoable: true });
      this.editor.setMarkers([]);
      store.saveExerciseCode(this.ex.id, this.files.starter);
    }

    showHint() {
      const saved = store.get().exercises[this.ex.id] || {};
      const n = Math.min((saved.hints || 0) + 1, this.ex.hints.length);
      store.recordExercise(this.ex.id, { hints: n });
      const sec = $('[data-hints]', this.view).parentElement;
      sec.innerHTML = `<div class="cl-sec-label">${icon('lightbulb', '', 13)}Hints</div>
        <ol class="cl-hints" data-hints>${this.ex.hints.slice(0, n).map((h) => `<li>${MV.ui.inlineMd(h)}</li>`).join('')}</ol>
        ${n < this.ex.hints.length ? `<button class="btn btn-sm" type="button" data-hint>${icon('eye')}Show hint ${n + 1} of ${this.ex.hints.length}</button>` : `<p class="text-[12.5px] text-mutedc">All hints shown.</p>`}`;
      const last = $$('.cl-hints li', sec).pop();
      if (last && window.Motion && !MV.reducedMotion) Motion.animate(last, { opacity: [0, 1], transform: ['translateY(4px)', 'none'] }, { duration: 0.25 });
    }

    async showSolution() {
      const saved = store.get().exercises[this.ex.id] || {};
      if (!saved.solved && !saved.runs && !saved.sawSolution) {
        const ok = await MV.ui.confirm({ title: 'Show the solution before trying?', message: "You haven't run the tests yet. Running them once, even with broken code, tells you exactly what's expected. Show the reference solution anyway?", confirmText: 'Show solution' });
        if (!ok) return;
      }
      let src;
      try { src = await MV.ui.fetchText(`${BASE}${this.ex.id}/solution.go.txt`); } catch (e) { toast('Could not load the solution', { type: 'error', desc: e.message }); return; }
      this.solution = src;
      store.recordExercise(this.ex.id, { sawSolution: true });
      $('[data-solution]', this.view).innerHTML = `${MV.ui.codeBlock(src, { lang: 'go', title: 'solution.go', maxHeight: '420px' })}
        <div class="flex flex-wrap gap-2 mt-2"><button class="btn btn-sm" type="button" data-load-solution>${icon('file-input')}Load into editor</button></div>`;
    }

    async loadSolution() {
      const ok = await MV.ui.confirm({ title: 'Replace your code with the solution?', message: 'Your current code will be replaced. Ctrl+Z in the editor brings it back until you leave the page.', confirmText: 'Load solution' });
      if (!ok) return;
      this.showFile('exercise.go');
      this.editor.setValue(this.solution, { undoable: true });
    }

    async loadExample(file) {
      let src;
      try { src = await MV.ui.fetchText(`${BASE}scratch/${file}`); } catch (e) { toast('Could not load the example', { type: 'error', desc: e.message }); return; }
      if (this.editor.value !== this.files.starter && this.editor.value.trim()) {
        const ok = await MV.ui.confirm({ title: 'Replace the scratchpad?', message: 'The example replaces your current program. Ctrl+Z brings it back until you leave the page.', confirmText: 'Load example' });
        if (!ok) return;
      }
      this.files.starter = src;
      this.editor.setValue(src, { undoable: true });
      this.editor.setMarkers([]);
      this.last = null;
      this.renderResults();
    }
  }

  async function renderWorkspace(view, { id }, query, nav) {
    const scratch = id === 'scratch';
    const ex = scratch ? MV.data.scratch : byId(id);
    if (!ex) {
      MV.shell.setCrumbs([{ label: 'Code Lab', href: '#/code' }, { label: 'Not found' }]);
      view.innerHTML = `<div class="page"><div class="empty">${icon('map-pin-off')}<strong>Exercise not found</strong><a class="btn mt-2" href="#/code">All exercises</a></div></div>`;
      return;
    }
    MV.shell.setCrumbs([{ label: 'Code Lab', href: '#/code' }, { label: ex.title }]);
    store.pushRecent({ route: `#/code/${ex.id}`, title: ex.title, kind: scratch ? 'Scratchpad' : 'Exercise' });
    view.innerHTML = `<div class="page">${MV.ui.skeleton(8)}</div>`;
    let files, inf;
    try {
      [files, inf] = await Promise.all([
        scratch ? MV.ui.fetchText(`${BASE}scratch/starter.go.txt`).then((starter) => ({ starter })) : loadFiles(ex),
        MV.runner.info(),
      ]);
    } catch (err) {
      if (MV.router.isCurrent(nav.token)) view.innerHTML = `<div class="page">${MV.ui.loadError(err)}</div>`;
      return;
    }
    if (!MV.router.isCurrent(nav.token)) return;
    new Workspace(view, ex, files, inf, nav);
  }

  /* ======================================================================
     Lesson embed: ::widget{name="exercise" id="retry-backoff"}
     ====================================================================== */
  MV.widgets.exercise = function (el, props) {
    const ex = byId(props.id);
    if (!ex) { el.innerHTML = ''; return; }
    const st = status(ex.id);
    el.innerHTML = `<a class="cl-embed card card-link spotlight" href="#/code/${ex.id}">
      <span class="icon-tile" style="--c:var(--green)">${icon('code-xml')}</span>
      <span class="min-w-0 flex-1">
        <span class="flex flex-wrap items-center gap-2 text-[11.5px] text-mutedc"><span class="eyebrow" style="color:var(--green)">Hands-on exercise</span><span class="badge badge-square ${LEVEL_CLS[ex.level]}">${ex.level}</span><span>${ex.minutes} min</span><span class="badge ${st.cls}">${icon(st.ic)}${esc(st.label)}</span></span>
        <span class="block font-semibold text-[15px] mt-1" style="color:var(--fg)">${esc(ex.title)}</span>
        <span class="block text-[13px] text-fg2 mt-0.5">${esc(ex.summary)} Real Go, real tests.</span>
      </span>
      <span class="btn btn-sm btn-primary cl-embed-go">Write the code${icon('arrow-right')}</span>
    </a>`;
  };

  MV.codelab = { renderList, renderWorkspace, status, solvedCount };
})(window.MV);
