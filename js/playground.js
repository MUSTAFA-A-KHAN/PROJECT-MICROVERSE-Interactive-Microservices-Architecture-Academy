/* ==========================================================================
   Microverse — Code Playground.
   A read-only IDE for the reference Order Management System: file explorer,
   tabs, syntax highlighting, line numbers, per-file explanations,
   line-anchored notes and guided request traces across files.

   The source shown is the real code in codebase/order-management/ (it
   compiles and its tests pass). Nothing is executed in the browser.
   ========================================================================== */
window.MV = window.MV || {};

(function (MV) {
  'use strict';
  const { $, $$, esc, icon, toast, inlineMd } = MV.ui;
  const CB = MV.data.codebase;
  const byPath = new Map(CB.files.map((f) => [f.path, f]));
  const SERVICE_COLOR = { 'api-gateway': 'cyan', 'user-service': 'blue', 'order-service': 'purple', 'notification-service': 'green', deploy: 'warn', root: 'muted' };

  const codePath = (p) => CB.root + p;

  function fileIcon(path) {
    if (path.endsWith('.go')) return path.endsWith('_test.go') ? 'flask-conical' : 'file-code-2';
    if (path.endsWith('.sql')) return 'database';
    if (path.endsWith('.yml') || path.endsWith('.yaml')) return 'file-cog';
    if (path.endsWith('Dockerfile')) return 'container';
    if (path.endsWith('.sh')) return 'terminal';
    if (path.endsWith('.md')) return 'book-open';
    return 'file-text';
  }

  /** Build a nested tree from the flat file list. */
  function buildTree() {
    const root = { name: 'order-management', dirs: new Map(), files: [] };
    CB.files.forEach((f) => {
      const parts = f.path.split('/');
      let node = root;
      parts.slice(0, -1).forEach((p) => {
        if (!node.dirs.has(p)) node.dirs.set(p, { name: p, dirs: new Map(), files: [] });
        node = node.dirs.get(p);
      });
      node.files.push(f);
    });
    return root;
  }

  /** Find the 1-based line containing `needle` and the extent of the block it opens. */
  function locate(lines, needle) {
    const start = lines.findIndex((l) => l.includes(needle));
    if (start < 0) return null;
    let depth = 0, opened = false, end = start;
    for (let i = start; i < lines.length && i < start + 120; i++) {
      const l = lines[i].replace(/"(?:\\.|[^"\\])*"|`[^`]*`|'(?:\\.|[^'\\])*'|\/\/.*$/g, '');
      for (const ch of l) {
        if (ch === '{') { depth++; opened = true; }
        else if (ch === '}') depth--;
      }
      end = i;
      if (opened && depth <= 0) break;
      if (!opened && i - start >= 6) break;
    }
    return { start: start + 1, end: end + 1 };
  }

  class Playground {
    constructor(view, query, nav) {
      this.view = view;
      this.nav = nav;
      const saved = MV.store.get().playground || {};
      this.tabs = (saved.tabs || []).filter((p) => byPath.has(p));
      this.active = byPath.has(saved.active) ? saved.active : null;
      this.trace = null;
      this.traceStep = 0;
      this.filter = '';
      this.collapsed = new Set();
      this.highlight = null;
      this.render();
      const file = query.file && byPath.has(query.file) ? query.file : null;
      if (query.trace) this.startTrace(query.trace, +(query.step || 1) - 1);
      else this.open(file || this.active || 'order-service/internal/service/order_service.go');
    }

    render() {
      MV.shell.setCrumbs([{ label: 'Practice', href: '#/challenges' }, { label: 'Code Playground' }]);
      this.view.innerHTML = `<div class="pg">
        <aside class="pg-explorer" aria-label="File explorer">
          <div class="pg-explorer-head">
            <span class="eyebrow">Explorer</span>
            <span class="badge badge-square badge-muted mono">${CB.files.length} files</span>
          </div>
          <div class="px-3 pb-2"><label class="sr-only" for="pg-filter">Filter files</label>
            <input class="input" id="pg-filter" type="search" placeholder="Filter files…" autocomplete="off"></div>
          <div class="pg-tree scroll-thin" id="pg-tree" data-lenis-prevent role="tree" aria-label="order-management"></div>
          <div class="pg-traces">
            <div class="eyebrow px-3 pt-3 pb-2 flex items-center gap-1.5">${icon('route', '', 13)}Trace a request</div>
            ${CB.traces.map((t) => `<button type="button" class="pg-trace-btn" data-trace="${t.id}"><span class="lc-method mono" data-m="${t.title.split(' ')[0]}">${esc(t.title.split(' ')[0])}</span><span class="flex-1 min-w-0"><span class="block truncate mono text-[12px]" style="color:var(--fg)">${esc(t.title.split(' ').slice(1).join(' ') || t.title)}</span><span class="block truncate text-[11.5px] text-mutedc">${esc(t.desc)}</span></span></button>`).join('')}
          </div>
        </aside>
        <section class="pg-editor" aria-label="Editor">
          <div class="pg-tabs scroll-thin" id="pg-tabs" role="tablist" aria-label="Open files"></div>
          <div class="pg-pathbar" id="pg-pathbar"></div>
          <div class="pg-code scroll-thin" id="pg-code" data-lenis-prevent tabindex="0" aria-label="Source code"></div>
          <div class="pg-tracebar" id="pg-tracebar" hidden></div>
        </section>
        <aside class="pg-explain scroll-thin" id="pg-explain" data-lenis-prevent aria-label="Explanation"></aside>
        <label class="pg-mobile-pick"><span class="sr-only">Open file</span><select class="select" id="pg-mobile-select">${CB.files.map((f) => `<option value="${esc(f.path)}">${esc(f.path)}</option>`).join('')}</select></label>
      </div>`;
      this.renderTree();
      this.bind();
    }

    /* ---------- explorer ---------- */
    renderTree() {
      const tree = buildTree();
      const q = this.filter.toLowerCase();
      const renderDir = (dir, path, depth) => {
        let html = '';
        [...dir.dirs.values()].sort((a, b) => a.name.localeCompare(b.name)).forEach((d) => {
          const p = path ? `${path}/${d.name}` : d.name;
          const inner = renderDir(d, p, depth + 1);
          if (q && !inner) return;
          const open = q || !this.collapsed.has(p);
          const color = depth === 0 ? SERVICE_COLOR[d.name] : null;
          html += `<div role="treeitem" aria-expanded="${open}"><button type="button" class="pg-node pg-dir" data-dir="${esc(p)}" style="--d:${depth}">${icon(open ? 'chevron-down' : 'chevron-right', 'pg-chev', 13)}${icon(open ? 'folder-open' : 'folder', '', 14)}<span${color ? ` style="color:var(--${color})"` : ''}>${esc(d.name)}</span></button>
            ${open ? `<div role="group">${inner}</div>` : ''}</div>`;
        });
        dir.files.filter((f) => !q || f.path.toLowerCase().includes(q)).sort((a, b) => a.path.localeCompare(b.path)).forEach((f) => {
          const name = f.path.split('/').pop();
          html += `<button type="button" role="treeitem" class="pg-node pg-file${f.path === this.active ? ' is-active' : ''}" data-file="${esc(f.path)}" style="--d:${depth}" title="${esc(f.summary)}">${icon(fileIcon(f.path), '', 14)}<span class="truncate">${esc(name)}</span></button>`;
        });
        return html;
      };
      const html = renderDir(tree, '', 0);
      $('#pg-tree', this.view).innerHTML = html || `<div class="px-3 py-4 text-[12.5px] text-mutedc">No files match “${esc(this.filter)}”.</div>`;
    }

    /* ---------- tabs ---------- */
    renderTabs() {
      $('#pg-tabs', this.view).innerHTML = this.tabs.map((p) => {
        const name = p.split('/').pop();
        const svc = byPath.get(p).service;
        return `<div class="pg-tab${p === this.active ? ' is-active' : ''}" role="tab" aria-selected="${p === this.active}">
          <button type="button" class="pg-tab-open" data-tab="${esc(p)}" title="${esc(p)}">${icon(fileIcon(p), '', 13)}<span>${esc(name)}</span><span class="pg-tab-svc" style="color:var(--${SERVICE_COLOR[svc] || 'muted'})">${esc(svc === 'root' ? '' : svc.replace('-service', ''))}</span></button>
          <button type="button" class="pg-tab-close" data-close-tab="${esc(p)}" aria-label="Close ${esc(name)}">${icon('x', '', 12)}</button></div>`;
      }).join('');
      const act = $('.pg-tab.is-active', this.view);
      if (act) act.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    persist() {
      MV.store.update((s) => { s.playground = { tabs: this.tabs.slice(-8), active: this.active }; }, 'playground');
    }

    /* ---------- open a file ---------- */
    async open(path, { highlight = null, keepTrace = false } = {}) {
      const f = byPath.get(path);
      if (!f) return;
      if (!keepTrace) this.endTrace(true);
      this.active = path;
      if (!this.tabs.includes(path)) this.tabs.push(path);
      if (this.tabs.length > 8) this.tabs.shift();
      this.persist();
      this.renderTabs();
      this.renderTree();
      $('#pg-mobile-select', this.view).value = path;

      const bm = MV.store.isBookmarked('file:' + path);
      $('#pg-pathbar', this.view).innerHTML = `<div class="flex items-center gap-1.5 min-w-0 mono text-[12px] text-mutedc">${path.split('/').map((p, i, a) => `<span class="${i === a.length - 1 ? 'text-fg2' : ''}">${esc(p)}</span>`).join(icon('chevron-right', '', 11))}</div>
        <span class="badge badge-sim ml-auto" data-tip="This is the real source from codebase/order-management. It is displayed, not executed — run it with docker compose up.">${icon('eye', '', 12)}Static source</span>
        <button class="btn btn-ghost btn-sm" type="button" data-pg-bm aria-pressed="${bm}">${icon(bm ? 'bookmark-check' : 'bookmark')}<span class="hide-sm">${bm ? 'Saved' : 'Save'}</span></button>
        <button class="btn btn-ghost btn-sm" type="button" data-pg-copy>${icon('copy')}<span class="hide-sm">Copy</span></button>`;
      const code = $('#pg-code', this.view);
      code.innerHTML = `<div class="p-4">${MV.ui.skeleton(14)}</div>`;
      this.renderExplain(f, null);

      let text;
      try {
        text = await MV.ui.fetchText(codePath(path));
      } catch (err) {
        if (this.active === path) code.innerHTML = `<div class="p-4">${MV.ui.loadError(err)}</div>`;
        return;
      }
      if (this.active !== path || this.disposed) return;
      this.text = text;
      const lines = text.replace(/\n$/, '').split('\n');
      const ann = {};
      const located = (f.notes || []).map((n) => {
        const loc = locate(lines, n.at);
        if (loc) ann[loc.start] = n.text;
        return { ...n, line: loc ? loc.start : null };
      });
      this.notes = located;
      const hl = highlight ? `${highlight.start}-${highlight.end}` : '';
      code.innerHTML = MV.ui.codeBlock(text, { lang: f.lang, title: path, highlight: hl, annotations: ann, maxHeight: 'none' });
      this.renderExplain(f, located);
      if (highlight) this.scrollToLine(highlight.start, true);
      else code.scrollTop = 0;
      MV.store.pushRecent({ route: `#/playground?file=${encodeURIComponent(path)}`, title: path.split('/').pop(), kind: 'Source file' });
    }

    scrollToLine(n, center) {
      const code = $('#pg-code', this.view);
      const row = $(`.code-line[data-line="${n}"]`, code);
      if (!row) return;
      const top = row.offsetTop - (center ? code.clientHeight / 3 : 40);
      code.scrollTo({ top: Math.max(0, top), behavior: MV.reducedMotion ? 'auto' : 'smooth' });
    }

    flashLine(n) {
      const code = $('#pg-code', this.view);
      $$('.code-line.is-flash, .code-ln.is-flash', code).forEach((e) => e.classList.remove('is-flash'));
      const row = $(`.code-line[data-line="${n}"]`, code);
      if (!row) return;
      row.classList.add('is-flash');
      const ln = row.previousElementSibling;
      if (ln) ln.classList.add('is-flash');
    }

    /* ---------- explanation panel ---------- */
    renderExplain(f, notes) {
      const el = $('#pg-explain', this.view);
      const svc = f.service;
      el.innerHTML = `<div class="pg-ex-head">
          <span class="badge badge-square" style="--c:var(--${SERVICE_COLOR[svc] || 'muted'})">${esc(svc)}</span>
          <span class="badge badge-square badge-muted">${esc(f.layer)}</span>
        </div>
        <h2 class="pg-ex-title">${esc(f.path.split('/').pop())}</h2>
        <p class="text-[13px] text-fg2 mt-1">${inlineMd(f.summary)}</p>
        <div class="tabs mt-3" role="tablist">
          <button class="tab" role="tab" type="button" data-extab="explain" aria-selected="true">${icon('book-open')}Explain</button>
          <button class="tab" role="tab" type="button" data-extab="notes" aria-selected="false">${icon('message-square-text')}Line notes <span class="count">${notes ? notes.filter((n) => n.line).length : (f.notes || []).length}</span></button>
        </div>
        <div data-expanel="explain">
          ${section('What it does', 'scan-search', f.what)}
          ${section('Why it exists', 'lightbulb', f.why)}
          <div class="pg-ex-sec"><div class="pg-ex-label">${icon('git-fork', '', 13)}How it connects</div>
            <div class="grid gap-1.5">${(f.connects || []).map(([p, why]) => `<button type="button" class="mini-link" data-file="${esc(p)}">${icon(fileIcon(p), '', 14)}<span class="flex-1 min-w-0 text-left"><span class="block truncate mono text-[11.5px]" style="color:var(--fg)">${esc(p)}</span><span class="block text-[11.5px] text-mutedc">${esc(why)}</span></span></button>`).join('')}</div></div>
          ${section('What happens at runtime', 'activity', f.runtime)}
          <div class="pg-ex-sec"><div class="pg-ex-label">${icon('triangle-alert', '', 13)}Production issues to watch</div>
            <ul class="pg-issues">${(f.issues || []).map((i) => `<li>${inlineMd(i)}</li>`).join('')}</ul></div>
        </div>
        <div data-expanel="notes" hidden>
          ${notes && notes.length ? notes.map((n) => `<button type="button" class="pg-note" data-goto-line="${n.line || ''}" ${n.line ? '' : 'disabled'}><span class="pg-note-ln mono">${n.line ? 'L' + n.line : '—'}</span><span>${inlineMd(n.text)}</span></button>`).join('')
            : `<div class="empty mt-3">${icon('message-square-text')}<span>${notes ? 'No line notes for this file. The Explain tab covers it.' : 'Loading…'}</span></div>`}
          ${notes && notes.length ? '<p class="text-[12px] text-mutedc mt-3">Annotated lines are marked with a dot in the gutter — click the line number to jump here.</p>' : ''}
        </div>`;
      function section(label, ic, text) {
        return text ? `<div class="pg-ex-sec"><div class="pg-ex-label">${icon(ic, '', 13)}${label}</div><p>${inlineMd(text)}</p></div>` : '';
      }
    }

    showExplainTab(name) {
      const el = $('#pg-explain', this.view);
      $$('[data-extab]', el).forEach((t) => t.setAttribute('aria-selected', String(t.dataset.extab === name)));
      $$('[data-expanel]', el).forEach((p) => { p.hidden = p.dataset.expanel !== name; });
    }

    /* ---------- traces ---------- */
    async startTrace(id, step = 0) {
      const t = CB.traces.find((x) => x.id === id);
      if (!t) return;
      this.trace = t;
      $$('.pg-trace-btn', this.view).forEach((b) => b.classList.toggle('is-active', b.dataset.trace === id));
      await this.gotoStep(Math.max(0, Math.min(step, t.steps.length - 1)));
    }

    async gotoStep(i) {
      const t = this.trace;
      if (!t) return;
      this.traceStep = i;
      const s = t.steps[i];
      const bar = $('#pg-tracebar', this.view);
      bar.hidden = false;
      bar.innerHTML = `<div class="flex items-center gap-2 min-w-0">
          <span class="badge badge-blue">${icon('route', '', 12)}${esc(t.title)}</span>
          <span class="mono text-[12px] text-mutedc">step ${i + 1}/${t.steps.length}</span>
          <div class="pg-trace-dots" aria-hidden="true">${t.steps.map((_, k) => `<span class="${k < i ? 'is-done' : k === i ? 'is-on' : ''}"></span>`).join('')}</div>
          <span class="flex-1"></span>
          <button class="btn btn-sm btn-icon" type="button" data-step="-1" ${i === 0 ? 'disabled' : ''} aria-label="Previous step">${icon('chevron-left')}</button>
          <button class="btn btn-sm btn-primary" type="button" data-step="1">${i === t.steps.length - 1 ? 'Finish' : 'Next'}${icon('chevron-right')}</button>
          <button class="btn btn-sm btn-ghost btn-icon" type="button" data-end-trace aria-label="Exit trace">${icon('x')}</button>
        </div>
        <p class="pg-trace-text"><span class="mono text-[11.5px]" style="color:var(--cyan)">${esc(s.file)}</span> — ${inlineMd(s.text)}</p>`;
      // Load file then highlight the located block
      let text;
      try { text = await MV.ui.fetchText(codePath(s.file)); } catch (e) { text = ''; }
      const loc = locate(text.split('\n'), s.at) || { start: 1, end: 1 };
      await this.open(s.file, { highlight: loc, keepTrace: true });
    }

    endTrace(silent) {
      if (!this.trace) return;
      this.trace = null;
      $$('.pg-trace-btn', this.view).forEach((b) => b.classList.remove('is-active'));
      const bar = $('#pg-tracebar', this.view);
      if (bar) bar.hidden = true;
      if (!silent) toast('Trace finished', { type: 'success', desc: 'Pick another trace or keep exploring the files.', duration: 2200 });
    }

    /* ---------- events ---------- */
    bind() {
      const v = this.view;
      $('#pg-filter', v).addEventListener('input', (e) => { this.filter = e.target.value; this.renderTree(); });
      $('#pg-mobile-select', v).addEventListener('change', (e) => this.open(e.target.value));
      v.addEventListener('click', async (e) => {
        const t = e.target;
        const dir = t.closest('[data-dir]');
        if (dir) { const p = dir.dataset.dir; if (this.collapsed.has(p)) this.collapsed.delete(p); else this.collapsed.add(p); this.renderTree(); return; }
        const file = t.closest('[data-file]');
        if (file) { this.open(file.dataset.file); return; }
        const close = t.closest('[data-close-tab]');
        if (close) {
          const p = close.dataset.closeTab;
          const i = this.tabs.indexOf(p);
          this.tabs.splice(i, 1);
          if (p === this.active) {
            const next = this.tabs[Math.min(i, this.tabs.length - 1)];
            if (next) this.open(next); else { this.active = null; this.renderTabs(); this.open('README.md'); }
          } else this.renderTabs();
          this.persist();
          return;
        }
        const tab = t.closest('[data-tab]');
        if (tab) { this.open(tab.dataset.tab); return; }
        const tr = t.closest('[data-trace]');
        if (tr) { this.startTrace(tr.dataset.trace, 0); return; }
        const step = t.closest('[data-step]');
        if (step && this.trace) {
          const n = this.traceStep + +step.dataset.step;
          if (n >= this.trace.steps.length) this.endTrace(false); else this.gotoStep(n);
          return;
        }
        if (t.closest('[data-end-trace]')) { this.endTrace(true); return; }
        const extab = t.closest('[data-extab]');
        if (extab) { this.showExplainTab(extab.dataset.extab); return; }
        const gl = t.closest('[data-goto-line]');
        if (gl && gl.dataset.gotoLine) { this.scrollToLine(+gl.dataset.gotoLine, true); this.flashLine(+gl.dataset.gotoLine); return; }
        const ann = t.closest('.code-ln.is-annotated');
        if (ann) {
          this.showExplainTab('notes');
          const n = ann.dataset.ann;
          const btn = $(`[data-goto-line="${n}"]`, v);
          $$('.pg-note', v).forEach((b) => b.classList.toggle('is-on', b === btn));
          if (btn) btn.scrollIntoView({ block: 'nearest' });
          this.flashLine(+n);
          return;
        }
        if (t.closest('[data-pg-copy]')) {
          const ok = await MV.ui.copyText(this.text || '');
          toast(ok ? 'File copied' : 'Copy failed', { type: ok ? 'success' : 'error', duration: 1500 });
          return;
        }
        const bm = t.closest('[data-pg-bm]');
        if (bm && this.active) {
          const added = MV.store.toggleBookmark({ key: 'file:' + this.active, title: this.active, route: `#/playground?file=${encodeURIComponent(this.active)}`, kind: 'file' });
          bm.innerHTML = `${icon(added ? 'bookmark-check' : 'bookmark')}<span class="hide-sm">${added ? 'Saved' : 'Save'}</span>`;
          toast(added ? 'File bookmarked' : 'Bookmark removed', { type: added ? 'success' : 'info', duration: 1500 });
        }
      });
      v.addEventListener('keydown', (e) => {
        const ann = e.target.closest && e.target.closest('.code-ln.is-annotated');
        if (ann && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ann.click(); }
      });
      MV.shortcuts.page = {
        ArrowRight: () => this.trace && this.gotoStep(Math.min(this.trace.steps.length - 1, this.traceStep + 1)),
        ArrowLeft: () => this.trace && this.gotoStep(Math.max(0, this.traceStep - 1)),
      };
    }
  }

  function render(view, query, nav) {
    const pg = new Playground(view, query || {}, nav);
    MV.router.onLeave(() => { pg.disposed = true; });
  }

  MV.playground = { render, codePath, locate };
})(window.MV);
