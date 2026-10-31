/* ==========================================================================
   Microverse — Code Playground.
   An IDE for the reference Order Management System: file explorer, tabs,
   syntax highlighting, line numbers, per-file explanations, line-anchored
   notes and guided request traces across files.

   The source shown is the real code in codebase/order-management/ (it
   compiles and its tests pass). Nothing is executed in the browser.
   Edit mode keeps changed .go files as drafts in this browser. With the dev
   server and Go installed, "Build & test" copies the service to a temporary
   folder, applies the drafts and runs go build / go vet / go test there;
   repository files are never written. Elsewhere (e.g. GitHub Pages) it
   checks syntax in the browser and exports the drafts as a git patch.
   ========================================================================== */
window.MV = window.MV || {};

(function (MV) {
  'use strict';
  const { $, $$, esc, icon, toast, inlineMd } = MV.ui;
  const CB = MV.data.codebase;
  const byPath = new Map(CB.files.map((f) => [f.path, f]));
  const SERVICE_COLOR = { 'api-gateway': 'cyan', 'user-service': 'blue', 'order-service': 'purple', 'notification-service': 'green', deploy: 'warn', root: 'muted' };

  const codePath = (p) => CB.root + p;
  const SERVICES = ['api-gateway', 'user-service', 'order-service', 'notification-service'];
  const editable = (path) => !!path && path.endsWith('.go') && SERVICES.includes(path.split('/')[0]);
  const drafts = () => MV.store.get().drafts || {};
  const serviceDrafts = (svc) => Object.entries(drafts()).filter(([p]) => p.startsWith(svc + '/'));

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

  /**
   * Unified diff (3 lines of context) of one file, in the format git apply
   * reads. Line-based LCS: these files are a few hundred lines at most.
   */
  function unifiedDiff(path, before, after) {
    const norm = (t) => (t.endsWith('\n') ? t.slice(0, -1) : t).split('\n');
    const a = norm(before.replace(/\r\n/g, '\n')), b = norm(after.replace(/\r\n/g, '\n'));
    const n = a.length, m = b.length;
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    const ops = []; // [kind, text, aLine, bLine]
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && a[i] === b[j]) { ops.push([' ', a[i], i, j]); i++; j++; }
      else if (j < m && (i === n || lcs[i][j + 1] >= lcs[i + 1][j])) { ops.push(['+', b[j], i, j]); j++; }
      else { ops.push(['-', a[i], i, j]); i++; }
    }
    // Each change brings CONTEXT lines either side; overlapping ranges merge into one hunk.
    const CONTEXT = 3;
    const ranges = [];
    ops.forEach((o, k) => {
      if (o[0] === ' ') return;
      const from = Math.max(0, k - CONTEXT), to = Math.min(ops.length, k + CONTEXT + 1);
      const last = ranges[ranges.length - 1];
      if (last && from <= last[1]) last[1] = Math.max(last[1], to);
      else ranges.push([from, to]);
    });
    let out = '';
    for (const [from, to] of ranges) {
      const hunk = ops.slice(from, to);
      const aCount = hunk.filter((o) => o[0] !== '+').length, bCount = hunk.filter((o) => o[0] !== '-').length;
      const aStart = hunk[0][2] + (aCount ? 1 : 0), bStart = hunk[0][3] + (bCount ? 1 : 0);
      out += `@@ -${aStart},${aCount} +${bStart},${bCount} @@\n` + hunk.map((o) => o[0] + o[1]).join('\n') + '\n';
    }
    return out ? `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${out}` : '';
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
      this.inf = null;
      MV.runner.info().then((inf) => { this.inf = inf; if (this.editMode && !this.disposed) this.renderPathbar(); });
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
          <div class="pg-buildbar scroll-thin" id="pg-buildbar" data-lenis-prevent hidden aria-live="polite"></div>
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
          html += `<button type="button" role="treeitem" class="pg-node pg-file${f.path === this.active ? ' is-active' : ''}" data-file="${esc(f.path)}" style="--d:${depth}" title="${esc(f.summary)}">${icon(fileIcon(f.path), '', 14)}<span class="truncate">${esc(name)}</span>${drafts()[f.path] != null ? '<span class="pg-dot" title="Edited in this browser"></span>' : ''}</button>`;
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
          <button type="button" class="pg-tab-open" data-tab="${esc(p)}" title="${esc(p)}">${icon(fileIcon(p), '', 13)}<span>${esc(name)}</span>${drafts()[p] != null ? '<span class="pg-dot" title="Edited"></span>' : ''}<span class="pg-tab-svc" style="color:var(--${SERVICE_COLOR[svc] || 'muted'})">${esc(svc === 'root' ? '' : svc.replace('-service', ''))}</span></button>
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

      this.disposeEditor();
      this.renderPathbar();
      const code = $('#pg-code', this.view);
      code.classList.remove('is-editing');
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
      this.renderExplain(f, located);
      if (this.editMode && editable(path)) { this.mountEditor(path, text, highlight); return; }
      const hl = highlight ? `${highlight.start}-${highlight.end}` : '';
      code.innerHTML = MV.ui.codeBlock(text, { lang: f.lang, title: path, highlight: hl, annotations: ann, maxHeight: 'none' });
      if (highlight) this.scrollToLine(highlight.start, true);
      else code.scrollTop = 0;
      MV.store.pushRecent({ route: `#/playground?file=${encodeURIComponent(path)}`, title: path.split('/').pop(), kind: 'Source file' });
    }

    /* ---------- edit mode ---------- */
    renderPathbar() {
      const path = this.active;
      const bm = MV.store.isBookmarked('file:' + path);
      const canEdit = editable(path);
      const editing = this.editMode && canEdit;
      const hasDraft = drafts()[path] != null;
      const svc = path.split('/')[0];
      const crumbs = `<div class="pg-crumbs flex items-center gap-1.5 min-w-0 mono text-[12px] text-mutedc">${path.split('/').map((p, i, a) => `<span class="${i === a.length - 1 ? 'text-fg2' : ''}">${esc(p)}</span>`).join(icon('chevron-right', '', 11))}</div>`;
      $('#pg-pathbar', this.view).innerHTML = editing
        ? `${crumbs}
          <span class="badge badge-warn ml-auto" data-tip="Your edits are saved in this browser only. Build & test compiles a temporary copy of ${esc(svc)}; files in codebase/ are never modified.">${icon('pencil', '', 12)}${hasDraft ? 'Edited copy' : 'Editing a copy'}</span>
          ${this.inf && !this.inf.local.available
            ? `<button class="btn btn-sm btn-primary" type="button" data-pg-build data-tip="Check your edits for syntax errors in the browser, and export them as a patch (Ctrl+Enter)">${icon('scan-search')}<span class="hide-sm">Check syntax</span></button>`
            : `<button class="btn btn-sm btn-primary" type="button" data-pg-build data-tip="go build, go vet and go test on a temporary copy (Ctrl+Enter)">${icon('hammer')}<span class="hide-sm">Build &amp; test</span></button>`}
          <button class="btn btn-ghost btn-sm btn-icon" type="button" data-pg-patch aria-label="Download your edits as a patch" data-tip="Download your edits as a git patch">${icon('download')}</button>
          ${hasDraft ? `<button class="btn btn-ghost btn-sm btn-icon" type="button" data-pg-revert aria-label="Revert this file" data-tip="Revert this file">${icon('undo-2')}</button>` : ''}
          <button class="btn btn-ghost btn-sm btn-icon" type="button" data-pg-copy aria-label="Copy file" data-tip="Copy file">${icon('copy')}</button>
          <button class="btn btn-sm" type="button" data-pg-edit>${icon('check')}Done</button>`
        : `${crumbs}
          <span class="badge badge-sim ml-auto" data-tip="This is the real source from codebase/order-management. It is displayed, not executed — run it with docker compose up.">${icon('eye', '', 12)}Static source</span>
          <button class="btn btn-ghost btn-sm" type="button" data-pg-bm aria-pressed="${bm}">${icon(bm ? 'bookmark-check' : 'bookmark')}<span class="hide-sm">${bm ? 'Saved' : 'Save'}</span></button>
          <button class="btn btn-ghost btn-sm" type="button" data-pg-copy>${icon('copy')}<span class="hide-sm">Copy</span></button>
          ${canEdit ? `<button class="btn btn-sm" type="button" data-pg-edit data-tip="Change this file and build the service with your edits">${icon('pencil')}${hasDraft ? 'Edit (changed)' : 'Edit'}</button>` : ''}`;
    }

    mountEditor(path, original, highlight) {
      const code = $('#pg-code', this.view);
      code.classList.add('is-editing');
      code.innerHTML = '<div class="pg-edit-host"></div>';
      const draft = drafts()[path];
      let saveT;
      const save = (v) => {
        const had = drafts()[path] != null;
        MV.store.saveDraft(path, v === original ? null : v);
        if (had !== (drafts()[path] != null)) { this.renderPathbar(); this.renderTabs(); this.renderTree(); }
      };
      this.editor = new MV.Editor($('.pg-edit-host', code), {
        value: draft != null ? draft : original, lang: 'go', label: `Edit ${path}`,
        onChange: (v) => { clearTimeout(saveT); saveT = setTimeout(() => save(v), 400); },
        onRun: () => this.buildService(),
        onSave: () => { clearTimeout(saveT); save(this.editor.value); toast('Draft saved in this browser', { duration: 1400 }); },
      });
      this.original = original;
      this.flushDraft = () => { clearTimeout(saveT); if (this.editor) MV.store.saveDraft(path, this.editor.value === original ? null : this.editor.value); };
      this.applyBuildMarkers();
      if (highlight) this.editor.revealLine(highlight.start);
    }

    disposeEditor() {
      if (!this.editor) return;
      this.flushDraft && this.flushDraft();
      this.editor.destroy();
      this.editor = null;
    }

    toggleEdit() {
      this.editMode = !this.editMode;
      this.disposeEditor();
      this.renderTabs();
      this.renderTree();
      this.open(this.active, { keepTrace: !!this.trace });
    }

    async revertFile() {
      const ok = await MV.ui.confirm({ title: 'Revert your edits to this file?', message: 'The draft saved in this browser is discarded and the original source is restored.', confirmText: 'Revert', danger: true });
      if (!ok) return;
      if (this.editor) this.editor.setValue(this.original, { undoable: true });
      MV.store.saveDraft(this.active, null);
      this.renderPathbar(); this.renderTabs(); this.renderTree();
    }

    async buildService() {
      if (this.building || !editable(this.active)) return;
      const svc = this.active.split('/')[0];
      this.flushDraft && this.flushDraft();
      const inf = await MV.runner.info();
      const bar = $('#pg-buildbar', this.view);
      bar.hidden = false;
      if (!inf.api || !inf.local.available) {
        await this.checkInBrowser(svc, inf);
        return;
      }
      const edits = Object.fromEntries(serviceDrafts(svc).map(([p, c]) => [p.slice(svc.length + 1), c]));
      const n = Object.keys(edits).length;
      this.building = true;
      const steps = ['go build ./...', 'go vet ./...', 'go test -count=1 ./...'];
      bar.innerHTML = `${this.buildHead(svc, n)}<ol class="pg-build-steps"><li class="is-run"><span class="spinner"></span><span class="mono">${steps.join(' && ')}</span><span class="text-mutedc">compiling a temporary copy…</span></li></ol>`;
      let r;
      try { r = await MV.runner.checkService(svc, edits); } catch (e) { r = { error: e.message }; }
      this.building = false;
      if (!bar.isConnected) return;
      this.buildResult = { svc, ...r };
      bar.innerHTML = `${this.buildHead(svc, n, r)}${r.error ? `<p class="pg-build-note is-bad">${esc(r.error)}</p>` : `<ol class="pg-build-steps">${steps.map((c, i) => {
        const st = r.steps[i];
        if (!st) return `<li class="is-skip">${icon('circle-minus', '', 14)}<span class="mono">${c}</span><span class="text-mutedc">skipped</span></li>`;
        const out = st.output ? `<pre class="pg-build-out">${this.linkOutput(svc, st.output)}</pre>` : '';
        return `<li class="${st.ok ? 'is-ok' : 'is-bad'}">${icon(st.ok ? 'circle-check' : 'circle-x', '', 14)}<span class="mono">${esc(st.cmd)}</span><span class="text-mutedc mono">${(st.durationMs / 1000).toFixed(1)}s${st.timedOut ? ' · timed out' : ''}</span>${out}</li>`;
      }).join('')}</ol>`}`;
      this.applyBuildMarkers();
      if (!r.error) {
        const failed = r.steps.find((st) => !st.ok);
        toast(r.ok ? `${svc} builds and all tests pass` : `${svc}: ${failed ? failed.cmd.split(' ').slice(0, 2).join(' ') : 'build'} failed`, { type: r.ok ? 'success' : 'error', desc: r.ok ? 'Built from a temporary copy with your edits.' : 'See the build panel under the editor.' });
      }
    }

    /**
     * Without the dev server (e.g. on GitHub Pages) the services can't be
     * built: they need the Go toolchain plus Gin, pgx and the RabbitMQ client.
     * Check what the browser can check (syntax, via go/parser in the Go
     * engine), and hand over a patch to build and test in a clone.
     */
    async checkInBrowser(svc, inf) {
      const bar = $('#pg-buildbar', this.view);
      const drafts = serviceDrafts(svc);
      const why = inf.api
        ? 'Building and testing the services needs Go installed on this machine (they depend on Gin, pgx and the RabbitMQ client).'
        : 'Building and testing the services needs the Go toolchain and their dependencies (Gin, pgx, the RabbitMQ client), so it can\'t happen in a browser. Run <span class="mono">npm run dev</span> with Go installed to build here, or apply the patch in your clone.';
      const head = (badge = '') => `<div class="pg-build-head">${icon('scan-search', '', 14)}<strong>${esc(svc)}</strong><span class="text-mutedc text-[12px]">syntax check in your browser · ${drafts.length} edited file${drafts.length === 1 ? '' : 's'}</span>${badge}<button class="btn btn-ghost btn-sm btn-icon ml-auto" type="button" data-pg-build-close aria-label="Close build results">${icon('x')}</button></div>`;
      if (!drafts.length) {
        bar.innerHTML = `${head()}<p class="pg-build-note">No edits to check yet. ${why}</p>`;
        return;
      }
      if (!inf.browser.available) {
        bar.innerHTML = `${head()}<p class="pg-build-note">${why}</p>${this.patchButton()}`;
        return;
      }
      this.building = true;
      bar.innerHTML = `${head()}<ol class="pg-build-steps"><li class="is-run"><span class="spinner"></span><span>Checking syntax in your browser…</span></li></ol>`;
      const results = [];
      for (const [path, code] of drafts) {
        try {
          results.push({ path, diags: await MV.gowasm.syntax(path.split('/').pop(), code) });
        } catch (e) {
          results.push({ path, error: e.message });
        }
      }
      this.building = false;
      if (!bar.isConnected) return;
      const ok = results.every((r) => !r.error && !r.diags.length);
      this.buildResult = { svc, ok, steps: results.filter((r) => r.diags && r.diags.length).map((r) => ({ ok: false, output: r.diags.map((d) => `${r.path.slice(svc.length + 1)}:${d.line}:${d.col}: ${d.message}`).join('\n') })) };
      bar.innerHTML = `${head(`<span class="badge ${ok ? 'badge-green' : 'badge-err'}">${icon(ok ? 'circle-check' : 'circle-x', '', 12)}${ok ? 'Syntax OK' : 'Syntax errors'}</span>`)}
        <ol class="pg-build-steps">${results.map((r) => {
          const bad = r.error || r.diags.length;
          const out = r.error ? esc(r.error) : r.diags.length ? this.linkOutput(svc, r.diags.map((d) => `${r.path.slice(svc.length + 1)}:${d.line}:${d.col}: ${d.message}`).join('\n')) : '';
          return `<li class="${bad ? 'is-bad' : 'is-ok'}">${icon(bad ? 'circle-x' : 'circle-check', '', 14)}<span class="mono">${esc(r.path.slice(svc.length + 1))}</span>${out ? `<pre class="pg-build-out">${out}</pre>` : ''}</li>`;
        }).join('')}</ol>
        <p class="pg-build-note">${why}</p>${this.patchButton()}`;
      this.applyBuildMarkers();
    }

    patchButton() {
      return `<div class="flex flex-wrap items-center gap-2 mt-2"><button class="btn btn-sm" type="button" data-pg-patch>${icon('download')}Download patch</button><span class="text-[12px] text-mutedc">then <span class="mono">git apply microverse-edits.patch</span> and <span class="mono">make test</span> in <span class="mono">codebase/order-management</span></span></div>`;
    }

    /** A unified diff of every draft against the original source, for `git apply`. */
    async downloadPatch() {
      this.flushDraft && this.flushDraft();
      const entries = Object.entries(drafts()).sort(([a], [b]) => a.localeCompare(b));
      if (!entries.length) { toast('No edits to export', { duration: 1600 }); return; }
      let patch = '';
      for (const [path, code] of entries) {
        let original;
        try { original = await MV.ui.fetchText(codePath(path)); } catch (e) { toast(`Couldn't load ${path}`, { type: 'error', desc: e.message }); return; }
        patch += unifiedDiff(CB.root + path, original, code);
      }
      const url = URL.createObjectURL(new Blob([patch], { type: 'text/x-diff' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: 'microverse-edits.patch' });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
      toast('Patch downloaded', { type: 'success', desc: `${entries.length} file${entries.length === 1 ? '' : 's'} · apply it from the repository root with git apply.` });
    }

    buildHead(svc, n, r) {
      const state = !r ? '' : r.error ? `<span class="badge badge-err">${icon('circle-x', '', 12)}Error</span>` : r.ok ? `<span class="badge badge-green">${icon('circle-check', '', 12)}Passed</span>` : `<span class="badge badge-err">${icon('circle-x', '', 12)}Failed</span>`;
      return `<div class="pg-build-head">${icon('hammer', '', 14)}<strong>${esc(svc)}</strong><span class="text-mutedc text-[12px]">temporary copy · ${n} edited file${n === 1 ? '' : 's'} · Go toolchain on this machine</span>${state}<button class="btn btn-ghost btn-sm btn-icon ml-auto" type="button" data-pg-build-close aria-label="Close build results">${icon('x')}</button></div>`;
    }

    /** Turn "internal/x/y.go:12:5" in go output into links that open the file at that line. */
    linkOutput(svc, text) {
      return esc(text).replace(/((?:\.\/)?([\w./-]+\.go)):(\d+)(?::(\d+))?/g, (m, _f, rel, line) => {
        const p = `${svc}/${rel.replace(/^\.\//, '')}`;
        return byPath.has(p) ? `<button type="button" class="cl-jump" data-build-jump="${esc(p)}" data-line="${line}">${m}</button>` : m;
      });
    }

    applyBuildMarkers() {
      const r = this.buildResult;
      if (!this.editor || !r || !r.steps || !this.active.startsWith(r.svc + '/')) return;
      const rel = this.active.slice(r.svc.length + 1);
      const marks = [];
      r.steps.filter((st) => !st.ok).forEach((st) => {
        const re = /(?:^|\s)(?:\.\/)?([\w./-]+\.go):(\d+)(?::(\d+))?:\s*(.+)/gm;
        let m;
        while ((m = re.exec(st.output))) if (m[1] === rel) marks.push({ line: +m[2], col: +(m[3] || 1), message: m[4] });
      });
      this.editor.setMarkers(marks);
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
        if (t.closest('[data-pg-edit]')) { this.toggleEdit(); return; }
        if (t.closest('[data-pg-build]')) { this.buildService(); return; }
        if (t.closest('[data-pg-revert]')) { this.revertFile(); return; }
        if (t.closest('[data-pg-build-close]')) { $('#pg-buildbar', v).hidden = true; return; }
        if (t.closest('[data-pg-patch]')) { this.downloadPatch(); return; }
        const bj = t.closest('[data-build-jump]');
        if (bj) {
          const line = +bj.dataset.line;
          if (bj.dataset.buildJump !== this.active) await this.open(bj.dataset.buildJump);
          if (this.editor) this.editor.revealLine(line);
          else { this.scrollToLine(line, true); this.flashLine(line); }
          return;
        }
        if (t.closest('[data-pg-copy]')) {
          const ok = await MV.ui.copyText(this.editor ? this.editor.value : (this.text || ''));
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
    MV.router.onLeave(() => { pg.disposed = true; pg.disposeEditor(); });
  }

  MV.playground = { render, codePath, locate };
})(window.MV);
