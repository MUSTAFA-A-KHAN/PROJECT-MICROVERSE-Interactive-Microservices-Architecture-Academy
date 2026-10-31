/* ==========================================================================
   Microverse — routing, application shell, command palette, search and
   keyboard shortcuts.
   ========================================================================== */
window.MV = window.MV || {};

(function (MV) {
  'use strict';
  const { $, $$, esc, icon, ring, popover, closePopover, dialog, closeDialog, toast } = MV.ui;
  const store = MV.store;
  const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const MOD = isMac ? '⌘' : 'Ctrl';

  /* ======================================================================
     Router (hash based so it works on any static server)
     ====================================================================== */
  const routes = [];
  let leaveHandlers = [];
  let navToken = 0;
  let current = { path: '/', params: {}, query: {} };
  let firstRender = true;

  function addRoute(path, handler, meta = {}) {
    const keys = [];
    const pattern = path
      .replace(/\//g, '\\/')
      .replace(/:(\w+)\*/g, (_, k) => { keys.push(k); return '(.+)'; })
      .replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
    routes.push({ re: new RegExp('^' + pattern + '\\/?$'), keys, handler, meta });
  }

  function parseHash() {
    let h = location.hash.replace(/^#/, '') || '/';
    const [path, qs] = h.split('?');
    return { path: path.startsWith('/') ? path : '/' + path, query: Object.fromEntries(new URLSearchParams(qs || '')) };
  }

  async function resolve() {
    const { path, query } = parseHash();
    let match = null;
    const params = {};
    for (const r of routes) {
      const m = path.match(r.re);
      if (m) { match = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); break; }
    }

    leaveHandlers.forEach((fn) => { try { fn(); } catch (e) { console.error(e); } });
    leaveHandlers = [];
    shortcuts.page = {};
    closePopover();
    closeDialog();
    document.querySelector('.app').classList.remove('nav-open');

    const token = ++navToken;
    current = { path, params, query, meta: match ? match.meta : {} };
    const view = $('#view');
    const main = $('#main');
    const app = document.querySelector('.app');
    // Full-bleed workspaces (lab, playground) get the room they need on laptop screens
    if (match && match.meta.full && window.innerWidth < 1500 && window.innerWidth > 860 && !store.get().sidebarCollapsed) app.classList.add('is-collapsed', 'auto-collapsed');
    else if (app.classList.contains('auto-collapsed')) app.classList.remove('is-collapsed', 'auto-collapsed');
    document.body.dataset.page = match ? match.meta.page : 'not-found';
    main.classList.toggle('is-full', !!(match && match.meta.full));
    view.innerHTML = '';

    try {
      if (match) await match.handler(view, params, query, { token });
      else renderNotFound(view);
    } catch (err) {
      console.error(err);
      if (token === navToken) view.innerHTML = `<div class="page"><div class="callout callout-danger">${icon('octagon-alert')}<div><div class="callout-title">Something went wrong rendering this page</div><div class="callout-body"><p>${esc(err.message)}</p><p><a href="#/">Return to the dashboard</a></p></div></div></div></div>`;
    }
    if (token !== navToken) return;

    updateNavActive();
    if (MV.lenis) MV.lenis.scrollTo(0, { immediate: true, force: true });
    main.scrollTop = 0;
    if (!firstRender) {
      if (window.Motion && !MV.reducedMotion) Motion.animate(view, { opacity: [0, 1], transform: ['translateY(6px)', 'none'] }, { duration: 0.28, ease: [0.2, 0.8, 0.2, 1] });
      main.focus({ preventScroll: true });
    }
    firstRender = false;
    if (window.ScrollTrigger) setTimeout(() => ScrollTrigger.refresh(), 60);
  }

  const router = {
    add: addRoute,
    start() { window.addEventListener('hashchange', resolve); resolve(); },
    go(hash) { if (location.hash === hash) resolve(); else location.hash = hash; },
    refresh: resolve,
    current: () => current,
    isCurrent: (token) => token === navToken,
    onLeave(fn) { leaveHandlers.push(fn); },
  };

  function renderNotFound(view) {
    setCrumbs([{ label: 'Not found' }]);
    view.innerHTML = `<div class="page"><div class="empty" style="margin-top:8vh">${icon('map-pin-off')}<strong>That page doesn't exist</strong>
      <span>The link may be outdated. Search for what you were looking for, or head back to the dashboard.</span>
      <div class="flex gap-2 mt-2"><a class="btn btn-primary" href="#/">${icon('layout-dashboard')}Dashboard</a><button class="btn" type="button" data-open-palette>${icon('search')}Search</button></div></div></div>`;
  }

  /* ======================================================================
     Shell: sidebar, top bar, breadcrumbs
     ====================================================================== */
  function setCrumbs(items) {
    const el = $('#crumbs');
    if (!el) return;
    el.innerHTML = items.map((c, i) => {
      const last = i === items.length - 1;
      const sep = i > 0 ? `<span class="crumb-sep" aria-hidden="true">${icon('chevron-right')}</span>` : '';
      if (last) return `${sep}<span class="crumb-current" aria-current="page">${esc(c.label)}</span>`;
      return `${sep}<a class="crumb-parent" href="${c.href}">${esc(c.label)}</a>`;
    }).join('');
    const title = items.length ? items[items.length - 1].label : '';
    document.title = title && title !== 'Dashboard' ? `${title} · Microverse` : 'Microverse — Master Microservices Architecture';
  }

  function overallProgress() {
    const lessons = MV.catalog.lessons;
    const done = lessons.filter((l) => store.isLessonDone(l.key)).length;
    return { done, total: lessons.length, pct: lessons.length ? done / lessons.length : 0 };
  }

  function moduleProgress(m) {
    const done = m.lessons.filter((l) => store.isLessonDone(`${m.id}/${l.id}`)).length;
    return { done, total: m.lessons.length, pct: done / m.lessons.length };
  }

  const NAV_TOP = [
    { label: 'Overview', href: '#/', icon: 'layout-dashboard', match: (p) => p === '/' },
    { label: 'Learning Path', href: '#/path', icon: 'route', match: (p) => p.startsWith('/path') || p.startsWith('/bootcamp') },
  ];
  const NAV_PRACTICE = [
    { label: 'Architecture Lab', href: '#/lab', icon: 'workflow', match: (p) => p.startsWith('/lab'), pill: 'Live' },
    { label: 'Code Playground', href: '#/playground', icon: 'square-terminal', match: (p) => p.startsWith('/playground') },
    { label: 'Code Lab', href: '#/code', icon: 'code-xml', match: (p) => p.startsWith('/code') },
    { label: 'Challenges', href: '#/challenges', icon: 'swords', match: (p) => p.startsWith('/challenge') },
  ];
  const NAV_YOU = [
    { label: 'Progress', href: '#/progress', icon: 'chart-no-axes-column', match: (p) => p.startsWith('/progress') },
    { label: 'Knowledge Check', href: '#/assessment', icon: 'clipboard-check', match: (p) => p.startsWith('/assessment') },
  ];

  function navItem(item, extra = '') {
    return `<a class="nav-item" href="${item.href}" data-nav="${item.href}" data-tip="${esc(item.label)}" data-tip-side="right" data-tip-collapsed-only>
      ${icon(item.icon)}${item.num ? `<span class="nav-num">${item.num}</span>` : ''}<span class="nav-label">${esc(item.label)}</span>${extra}</a>`;
  }

  function renderSidebar() {
    const el = $('#sidebar');
    const scroll = $('.sidebar-scroll', el);
    const keep = scroll ? scroll.scrollTop : 0;
    const prog = overallProgress();
    const solved = Object.values(store.get().challenges).filter((c) => c.solved).length;
    const totalCh = (MV.data.challenges || []).length;
    el.innerHTML = `
      <div class="sidebar-brand">
        <a href="#/" class="flex items-center gap-2.5" style="text-decoration:none" aria-label="Microverse home">
          <svg class="brand-mark" viewBox="0 0 32 32" aria-hidden="true"><defs><linearGradient id="bm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--blue)"/><stop offset="1" stop-color="var(--cyan)"/></linearGradient></defs>
            <rect x="1" y="1" width="30" height="30" rx="8" fill="none" stroke="url(#bm)" stroke-width="1.6" opacity=".9"/>
            <circle cx="10" cy="11" r="3" fill="var(--blue)"/><circle cx="22" cy="11" r="3" fill="var(--cyan)"/><circle cx="16" cy="22" r="3" fill="var(--purple)"/>
            <path d="M12.6 12.4 14.6 19.4M19.4 12.4 17.4 19.4M13 11h6" stroke="var(--fg-2)" stroke-width="1.3" stroke-linecap="round"/></svg>
          <span class="brand-name">Microverse <span>Academy</span></span>
        </a>
        <button class="sidebar-collapse" type="button" data-toggle-sidebar data-tip="Toggle sidebar" data-tip-kbd="[" aria-label="Toggle sidebar">${icon(store.get().sidebarCollapsed ? 'panel-left-open' : 'panel-left-close', '', 16)}</button>
      </div>
      <nav class="sidebar-scroll scroll-thin" aria-label="Main">
        <div class="nav-group">${NAV_TOP.map((n) => navItem(n)).join('')}</div>
        <div class="nav-group"><div class="nav-group-label">Modules</div>
          ${MV.catalog.modules.map((m) => {
            const p = moduleProgress(m);
            return navItem({ label: m.nav, href: `#/module/${m.id}`, icon: m.icon, num: m.num }, `<span class="nav-meta" title="${p.done} of ${p.total} lessons complete">${ring(p.pct, 16, 2.5, 'nav-ring')}</span>`);
          }).join('')}
        </div>
        <div class="nav-group"><div class="nav-group-label">Practice</div>
          ${NAV_PRACTICE.map((n) => navItem(n, n.pill ? `<span class="nav-meta"><span class="nav-pill">${n.pill}</span></span>` : n.href === '#/challenges' && totalCh ? `<span class="nav-meta"><span class="text-[11px] text-mutedc mono">${solved}/${totalCh}</span></span>` : n.href === '#/code' && MV.codelab ? `<span class="nav-meta"><span class="text-[11px] text-mutedc mono">${MV.codelab.solvedCount()}/${MV.data.exercises.length}</span></span>` : '')).join('')}
        </div>
        <div class="nav-group"><div class="nav-group-label">You</div>${NAV_YOU.map((n) => navItem(n)).join('')}</div>
      </nav>
      <div class="sidebar-footer">
        <a class="sidebar-progress" href="#/progress" style="text-decoration:none">
          <div class="sidebar-progress-row"><span>Course progress</span><span class="mono tabular">${Math.round(prog.pct * 100)}%</span></div>
          <div class="bar"><span style="--v:${(prog.pct * 100).toFixed(1)}%"></span></div>
          <div class="sidebar-progress-row"><span>${prog.done} of ${prog.total} lessons</span><span>${MV.ui.fmtDuration(store.get().time.total)}</span></div>
        </a>
      </div>`;
    const sc = $('.sidebar-scroll', el);
    if (sc) sc.scrollTop = keep;
    updateNavActive();
  }

  function updateNavActive() {
    const p = current.path;
    $$('#sidebar [data-nav]').forEach((a) => {
      const href = a.getAttribute('data-nav');
      let active = false;
      const all = [...NAV_TOP, ...NAV_PRACTICE, ...NAV_YOU].find((n) => n.href === href);
      if (all) active = all.match(p);
      else {
        const mid = href.split('/').pop();
        active = p === `/module/${mid}` || p.startsWith(`/lesson/${mid}/`);
      }
      if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }

  function renderTopbar() {
    const el = $('#topbar');
    el.innerHTML = `
      <button class="icon-btn topbar-menu" type="button" data-open-nav aria-label="Open navigation">${icon('menu')}</button>
      <nav class="crumbs" id="crumbs" aria-label="Breadcrumb"></nav>
      <button class="search-trigger" type="button" data-open-palette aria-label="Search lessons, files and commands">
        ${icon('search')}<span class="search-label">Search lessons, files, patterns…</span><span class="kbd">${MOD} K</span>
      </button>
      <a class="topbar-progress" href="#/progress" id="topbar-progress" data-tip="Course progress"></a>
      <div class="topbar-actions">
        <button class="icon-btn" type="button" data-bookmarks aria-haspopup="menu" aria-expanded="false" data-tip="Bookmarks" aria-label="Bookmarks">${icon('bookmark')}</button>
        <button class="icon-btn" type="button" data-toggle-theme data-tip="Toggle theme" data-tip-kbd="T" aria-label="Toggle theme"></button>
        <button class="icon-btn" type="button" data-shortcuts data-tip="Keyboard shortcuts" data-tip-kbd="?" aria-label="Keyboard shortcuts">${icon('keyboard')}</button>
      </div>`;
    updateTopbar();
  }

  function updateTopbar() {
    const prog = overallProgress();
    const tp = $('#topbar-progress');
    if (tp) tp.innerHTML = `${ring(prog.pct, 18, 2.5)}<span class="tp-label">Progress</span><span class="bar bar-thin"><span style="--v:${(prog.pct * 100).toFixed(1)}%"></span></span><span class="mono tabular">${Math.round(prog.pct * 100)}%</span>`;
    const th = $('[data-toggle-theme]');
    if (th) th.innerHTML = icon(store.get().theme === 'dark' ? 'sun' : 'moon');
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', store.get().theme);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', store.get().theme === 'dark' ? '#080B12' : '#F5F7FB');
  }
  function toggleTheme() {
    store.set('theme', store.get().theme === 'dark' ? 'light' : 'dark');
    applyTheme();
    updateTopbar();
    toast(`${store.get().theme === 'dark' ? 'Dark' : 'Light'} theme`, { type: 'info', duration: 1600 });
  }
  function applySidebar() {
    document.querySelector('.app').classList.toggle('is-collapsed', !!store.get().sidebarCollapsed);
  }
  function toggleSidebar() {
    const app = document.querySelector('.app');
    if (window.innerWidth <= 860) { app.classList.toggle('nav-open'); return; }
    if (app.classList.contains('auto-collapsed')) {
      app.classList.remove('is-collapsed', 'auto-collapsed');
      setTimeout(() => window.dispatchEvent(new Event('resize')), 300);
      return;
    }
    store.set('sidebarCollapsed', !store.get().sidebarCollapsed);
    applySidebar();
    renderSidebar();
    setTimeout(() => window.dispatchEvent(new Event('resize')), 300);
  }

  function openBookmarks(anchor) {
    const bms = store.get().bookmarks;
    const html = `<div class="menu-label">Bookmarks</div>${bms.length ? bms.slice(0, 12).map((b) => `
      <div class="flex items-center gap-1"><a class="menu-item" href="${b.route}" data-close-pop>${icon(b.kind === 'challenge' ? 'swords' : b.kind === 'file' ? 'file-code-2' : 'book-open')}<span class="truncate">${esc(b.title)}</span></a>
      <button class="icon-btn" style="width:28px;height:28px" type="button" data-unbookmark="${esc(b.key)}" aria-label="Remove bookmark ${esc(b.title)}">${icon('x', '', 14)}</button></div>`).join('')
      : `<div class="px-3 py-4 text-[13px] text-mutedc" style="max-width:260px">No bookmarks yet. Use the ${icon('bookmark', '', 13)} button on any lesson or challenge (or press <span class="kbd">B</span>) to save it here.</div>`}
      <div class="menu-sep"></div><a class="menu-item" href="#/progress?tab=bookmarks" data-close-pop>${icon('list')}View all in Progress</a>`;
    popover(anchor, html, {
      onOpen(el) {
        el.addEventListener('click', (e) => {
          const rm = e.target.closest('[data-unbookmark]');
          if (!rm) return;
          const key = rm.getAttribute('data-unbookmark');
          const bm = store.get().bookmarks.find((b) => b.key === key);
          if (bm) store.toggleBookmark(bm);
          closePopover();
          openBookmarks(anchor);
        });
      },
    });
  }

  /* ======================================================================
     Search index & command palette
     ====================================================================== */
  const fullText = { loaded: false, loading: null, lessons: {} };

  function stripMd(s) {
    return s.replace(/```[\s\S]*?```/g, ' ').replace(/^:::.*$/gm, ' ').replace(/^::\w+\{.*\}$/gm, ' ')
      .replace(/`([^`]+)`/g, '$1').replace(/[*_#>|]/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
  }

  function ensureFullText() {
    if (fullText.loaded || fullText.loading) return fullText.loading;
    fullText.loading = Promise.all(MV.catalog.modules.map((m) =>
      MV.ui.fetchText(MV.catalog.contentPath(m.id)).then((txt) => {
        MV.lessons.split(txt).forEach((sec, id) => { fullText.lessons[`${m.id}/${id}`] = stripMd(sec); });
      }).catch(() => {})
    )).then(() => { fullText.loaded = true; });
    return fullText.loading;
  }

  function baseItems() {
    const items = [];
    const page = (title, route, ic, sub, kw = '') => items.push({ group: 'Pages', title, route, icon: ic, sub, kw });
    page('Dashboard', '#/', 'layout-dashboard', 'Overview, continue learning, knowledge score');
    page('Learning Path — 3-hour bootcamp', '#/path', 'route', 'Six guided 30-minute sessions');
    page('Architecture Lab', '#/lab', 'workflow', 'Simulate requests and inject failures', 'simulator canvas failure chaos');
    page('Code Playground', '#/playground', 'square-terminal', 'Browse the Order Management System source', 'files go code');
    page('Code Lab — Go exercises', '#/code', 'code-xml', 'Write Go and run real tests', 'exercises coding editor write run compile tests practice');
    page('Go scratchpad', '#/code/scratch', 'square-terminal', 'Edit and run a free-form Go program', 'editor run go playground repl');
    page('Engineering Challenges', '#/challenges', 'swords', 'Scenario-based problems', 'scenarios');
    page('Progress', '#/progress', 'chart-no-axes-column', 'Lessons, quizzes, bookmarks, weak concepts');
    page('Knowledge Check', '#/assessment', 'clipboard-check', 'Assessment with personalised recommendations', 'test exam assessment');
    page('All modules', '#/modules', 'library', 'Course syllabus');

    MV.catalog.modules.forEach((m) => items.push({ group: 'Modules', title: `${m.num} · ${m.title}`, route: `#/module/${m.id}`, icon: m.icon, sub: m.summary, kw: m.nav }));
    MV.catalog.lessons.forEach((l) => items.push({ group: 'Lessons', title: l.title, route: l.route, icon: 'book-open', sub: `${l.module.num} ${l.module.nav} · ${l.summary}`, kw: (l.concepts || []).join(' '), lessonKey: l.key }));
    (MV.data.bootcamp || []).forEach((s) => items.push({ group: 'Bootcamp', title: `Session ${s.num}: ${s.title}`, route: `#/bootcamp/${s.id}`, icon: 'timer', sub: s.summary }));
    (MV.data.exercises || []).forEach((x) => items.push({ group: 'Exercises', title: x.title, route: `#/code/${x.id}`, icon: 'code-xml', sub: `${x.level} · ${x.summary}`, kw: `exercise code go ${(x.concepts || []).join(' ')}` }));
    (MV.data.challenges || []).forEach((c) => items.push({ group: 'Challenges', title: c.title, route: `#/challenge/${c.id}`, icon: 'swords', sub: `${c.level} · ${c.tagline}`, kw: (c.concepts || []).join(' ') }));
    ((MV.data.codebase && MV.data.codebase.files) || []).forEach((f) => items.push({ group: 'Source files', title: f.path, route: `#/playground?file=${encodeURIComponent(f.path)}`, icon: 'file-code-2', sub: f.summary, kw: f.service }));

    const act = (title, ic, run, sub, kbd) => items.push({ group: 'Actions', title, icon: ic, run, sub, kbd });
    act('Toggle theme', 'sun-moon', toggleTheme, 'Switch between dark and light', 'T');
    act('Toggle sidebar', 'panel-left', toggleSidebar, 'Collapse or expand navigation', '[');
    act('Simulate a request in the Architecture Lab', 'play', () => router.go('#/lab?run=1'), 'Opens the lab and sends POST /api/v1/orders');
    act('Keyboard shortcuts', 'keyboard', showShortcuts, 'List every shortcut', '?');
    act('Export progress', 'download', () => MV.progress && MV.progress.exportProgress(), 'Download your progress as JSON');
    return items;
  }

  function scoreText(q, text) {
    if (!text) return 0;
    const t = text.toLowerCase();
    if (t === q) return 100;
    if (t.startsWith(q)) return 85;
    const idx = t.indexOf(q);
    if (idx >= 0) return 70 - Math.min(idx, 40) / 4;
    const words = q.split(/\s+/).filter(Boolean);
    if (words.length > 1 && words.every((w) => t.includes(w))) return 45;
    let j = 0;
    for (let i = 0; i < t.length && j < q.length; i++) if (t[i] === q[j]) j++;
    return j === q.length && q.length >= 3 ? 12 : 0;
  }

  function markMatch(title, q) {
    const i = title.toLowerCase().indexOf(q);
    if (!q || i < 0) return esc(title);
    return esc(title.slice(0, i)) + '<mark>' + esc(title.slice(i, i + q.length)) + '</mark>' + esc(title.slice(i + q.length));
  }

  function search(q) {
    q = q.trim().toLowerCase();
    const items = baseItems();
    if (!q) {
      const recent = store.get().recent.slice(0, 5).map((r) => ({ group: 'Recent', title: r.title, route: r.route, icon: 'history', sub: r.kind || '' }));
      const next = MV.progress && MV.progress.nextLesson ? MV.progress.nextLesson() : null;
      const sugg = [];
      if (next) sugg.push({ group: 'Suggested', title: `Continue: ${next.title}`, route: next.route, icon: 'circle-play', sub: `${next.module.num} ${next.module.nav}` });
      sugg.push({ group: 'Suggested', title: 'Open the Architecture Lab', route: '#/lab', icon: 'workflow', sub: 'Simulate requests and failures' });
      return [...recent, ...sugg, ...items.filter((i) => i.group === 'Pages' || i.group === 'Actions')];
    }
    const scored = items.map((it) => ({ it, s: Math.max(scoreText(q, it.title), scoreText(q, it.kw) * 0.75, scoreText(q, it.sub) * 0.55) }))
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 40).map((x) => x.it);
    // Full-text matches inside lesson bodies
    if (fullText.loaded && q.length >= 3) {
      const words = q.split(/\s+/).filter(Boolean);
      const already = new Set(scored.filter((s) => s.lessonKey).map((s) => s.lessonKey));
      const hits = [];
      Object.entries(fullText.lessons).forEach(([key, text]) => {
        if (already.has(key)) return;
        const lower = text.toLowerCase();
        if (!words.every((w) => lower.includes(w))) return;
        const l = MV.catalog.lesson(key);
        if (!l) return;
        const at = lower.indexOf(words[0]);
        const snippet = (at > 40 ? '…' : '') + text.slice(Math.max(0, at - 40), at + 80) + '…';
        hits.push({ group: 'In lesson content', title: l.title, route: l.route, icon: 'text-search', sub: snippet });
      });
      scored.push(...hits.slice(0, 8));
    }
    return scored;
  }

  function openPalette(initial = '') {
    ensureFullText();
    let results = [];
    let sel = 0;
    dialog({
      raw: true,
      className: 'cmdk',
      labelledBy: 'Command palette',
      body: `<div class="cmdk-input-wrap">${icon('search')}<input class="cmdk-input" id="cmdk-input" type="text" placeholder="Search lessons, patterns, files, or type a command…" autocomplete="off" spellcheck="false" role="combobox" aria-expanded="true" aria-controls="cmdk-list" aria-autocomplete="list" value="${esc(initial)}"><span class="kbd">Esc</span></div>
        <div class="cmdk-list scroll-thin" id="cmdk-list" role="listbox"></div>
        <div class="cmdk-foot"><span><span class="kbd">↑</span><span class="kbd">↓</span>navigate</span><span><span class="kbd">↵</span>open</span><span><span class="kbd">Esc</span>close</span><span class="ml-auto">${fullText.loaded ? 'Searching titles and lesson text' : 'Indexing lesson text…'}</span></div>`,
      onOpen(panel, close) {
        const input = $('#cmdk-input', panel);
        const list = $('#cmdk-list', panel);
        const foot = $('.cmdk-foot .ml-auto', panel);
        const draw = () => {
          const q = input.value.trim().toLowerCase();
          results = search(input.value);
          sel = Math.min(sel, Math.max(0, results.length - 1));
          if (!results.length) {
            list.innerHTML = `<div class="cmdk-empty">No results for “${esc(input.value)}”.<br><span class="text-xs">Try a pattern name like “saga”, a file like “order_handler.go”, or a tool like “Kafka”.</span></div>`;
            return;
          }
          let html = '', group = '';
          results.forEach((r, i) => {
            if (r.group !== group) { group = r.group; html += `<div class="cmdk-group" role="presentation">${esc(group)}</div>`; }
            html += `<button type="button" class="cmdk-item" role="option" id="cmdk-opt-${i}" data-i="${i}" aria-selected="${i === sel}">${icon(r.icon)}
              <span class="ci-text"><span class="ci-title">${markMatch(r.title, q)}</span>${r.sub ? `<span class="ci-sub">${esc(r.sub)}</span>` : ''}</span>
              ${r.kbd ? `<span class="kbd">${esc(r.kbd)}</span>` : r.route ? icon('corner-down-left', '', 14) : ''}</button>`;
          });
          list.innerHTML = html;
          input.setAttribute('aria-activedescendant', `cmdk-opt-${sel}`);
        };
        const select = (i) => {
          sel = i;
          $$('.cmdk-item', list).forEach((b) => b.setAttribute('aria-selected', String(+b.dataset.i === sel)));
          const node = $(`#cmdk-opt-${sel}`, list);
          if (node) node.scrollIntoView({ block: 'nearest' });
          input.setAttribute('aria-activedescendant', `cmdk-opt-${sel}`);
        };
        const run = (i) => {
          const r = results[i];
          if (!r) return;
          close();
          if (r.run) r.run(); else if (r.route) router.go(r.route);
        };
        input.addEventListener('input', () => { sel = 0; draw(); });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); select(Math.min(results.length - 1, sel + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); select(Math.max(0, sel - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); run(sel); }
        });
        list.addEventListener('mousemove', (e) => { const b = e.target.closest('.cmdk-item'); if (b && +b.dataset.i !== sel) select(+b.dataset.i); });
        list.addEventListener('click', (e) => { const b = e.target.closest('.cmdk-item'); if (b) run(+b.dataset.i); });
        draw();
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
        if (!fullText.loaded) ensureFullText().then(() => { if (input.isConnected) { foot.textContent = 'Searching titles and lesson text'; draw(); } });
      },
    });
  }

  /* ======================================================================
     Keyboard shortcuts
     ====================================================================== */
  const shortcuts = { page: {} };
  let gPending = false, gTimer = null;
  const GO = { d: '#/', p: '#/path', l: '#/lab', o: '#/playground', e: '#/code', c: '#/challenges', r: '#/progress', a: '#/assessment', m: '#/modules' };

  function isTyping(e) {
    const t = e.target;
    return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  }

  function showShortcuts() {
    const row = (keys, label) => `<div class="flex items-center justify-between py-2" style="border-bottom:1px solid var(--line)"><span class="text-[13px]">${label}</span><span class="flex gap-1">${keys.map((k) => `<span class="kbd">${k}</span>`).join('')}</span></div>`;
    dialog({
      title: 'Keyboard shortcuts',
      desc: 'Shortcuts are ignored while you are typing in a field.',
      body: `<div class="eyebrow mt-1 mb-1">Global</div>
        ${row([MOD, 'K'], 'Command palette & search')}${row(['/'], 'Search')}${row(['['], 'Toggle sidebar')}${row(['T'], 'Toggle theme')}${row(['?'], 'Show this dialog')}
        <div class="eyebrow mt-4 mb-1">Go to</div>
        ${row(['G', 'D'], 'Dashboard')}${row(['G', 'P'], 'Learning path')}${row(['G', 'M'], 'All modules')}${row(['G', 'L'], 'Architecture Lab')}${row(['G', 'O'], 'Code Playground')}${row(['G', 'E'], 'Code Lab exercises')}${row(['G', 'C'], 'Challenges')}${row(['G', 'R'], 'Progress')}${row(['G', 'A'], 'Knowledge check')}
        <div class="eyebrow mt-4 mb-1">Lessons</div>
        ${row(['N'], 'Next lesson')}${row(['P'], 'Previous lesson')}${row(['M'], 'Mark lesson complete')}${row(['B'], 'Bookmark')}
        <div class="eyebrow mt-4 mb-1">Architecture Lab</div>
        ${row(['Space'], 'Simulate request')}${row(['F'], 'Fit diagram to view')}${row(['←', '↑', '→', '↓'], 'Move the focused node')}
        <div class="eyebrow mt-4 mb-1">Code editor</div>
        ${row([MOD, 'Enter'], 'Run code / tests')}${row(['Shift', 'Alt', 'F'], 'Format with gofmt')}${row([MOD, '/'], 'Toggle comment')}${row([MOD, 'S'], 'Save now')}${row(['Esc', 'Tab'], 'Leave the editor')}`,
    });
  }

  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); return; }
    if (e.defaultPrevented || isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (document.querySelector('.dialog-scrim')) return;
    const k = e.key;
    if (gPending) {
      gPending = false; clearTimeout(gTimer);
      const dest = GO[k.toLowerCase()];
      if (dest) { e.preventDefault(); router.go(dest); }
      return;
    }
    if (k === '/') { e.preventDefault(); openPalette(); return; }
    if (k === '?') { e.preventDefault(); showShortcuts(); return; }
    if (k === '[') { e.preventDefault(); toggleSidebar(); return; }
    if (k === 'g' || k === 'G') { gPending = true; gTimer = setTimeout(() => { gPending = false; }, 1200); return; }
    const pageFn = shortcuts.page[k] || shortcuts.page[k.toLowerCase()];
    if (pageFn) { e.preventDefault(); pageFn(e); return; }
    if (k === 't' || k === 'T') { e.preventDefault(); toggleTheme(); }
  });

  /* ======================================================================
     Delegated shell events
     ====================================================================== */
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (t.closest('[data-open-palette]')) { openPalette(); return; }
    if (t.closest('[data-toggle-theme]')) { toggleTheme(); return; }
    if (t.closest('[data-toggle-sidebar]')) { toggleSidebar(); return; }
    if (t.closest('[data-shortcuts]')) { showShortcuts(); return; }
    if (t.closest('[data-open-nav]')) { document.querySelector('.app').classList.add('nav-open'); $('#sidebar .nav-item').focus(); return; }
    if (t.closest('.sidebar-scrim')) { document.querySelector('.app').classList.remove('nav-open'); return; }
    const bm = t.closest('[data-bookmarks]');
    if (bm) { openBookmarks(bm); return; }
    if (t.closest('#sidebar .nav-item')) document.querySelector('.app').classList.remove('nav-open');
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.querySelector('.app.nav-open')) document.querySelector('.app').classList.remove('nav-open');
  });

  /* ======================================================================
     Time tracking — counts only visible, recently-active time
     ====================================================================== */
  let lastActivity = Date.now();
  ['pointerdown', 'keydown', 'wheel', 'touchstart', 'pointermove'].forEach((ev) => document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));
  function activeArea() {
    const p = current.path;
    const m = p.match(/^\/(?:lesson|module)\/(m\d\d)/);
    if (m) return m[1];
    if (p.startsWith('/lab')) return 'lab';
    if (p.startsWith('/playground')) return 'playground';
    if (p.startsWith('/challenge')) return 'challenges';
    if (p.startsWith('/bootcamp') || p.startsWith('/path')) return 'bootcamp';
    return null;
  }
  setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - lastActivity < 90000) store.addTime(15, activeArea());
  }, 15000);

  /* Re-render shell fragments when progress changes */
  let shellTimer = null;
  store.subscribe((s, change) => {
    if (change.type === 'time') {
      const row = $('#sidebar .sidebar-footer .sidebar-progress-row:last-child span:last-child');
      if (row) row.textContent = MV.ui.fmtDuration(s.time.total);
      return;
    }
    clearTimeout(shellTimer);
    shellTimer = setTimeout(() => { renderSidebar(); updateTopbar(); }, 30);
  });

  /* Smooth scrolling for the main workspace (Lenis) */
  function initLenis() {
    if (!window.Lenis || MV.reducedMotion) return;
    try {
      MV.lenis = new Lenis({
        wrapper: $('#main'),
        content: $('#view'),
        autoRaf: true,
        lerp: 0.14,
        smoothWheel: true,
        allowNestedScroll: true,
        prevent: (node) => !!(node && node.closest && node.closest('[data-lenis-prevent], .no-smooth')),
      });
      if (window.ScrollTrigger) {
        MV.lenis.on('scroll', ScrollTrigger.update);
        ScrollTrigger.defaults({ scroller: '#main' });
      }
    } catch (e) {
      console.warn('[lenis] disabled:', e);
    }
  }

  MV.router = router;
  MV.shell = {
    setCrumbs, renderSidebar, renderTopbar, applyTheme, applySidebar, toggleTheme, toggleSidebar,
    openPalette, showShortcuts, initLenis, overallProgress, moduleProgress, isMac, MOD,
  };
  MV.shortcuts = shortcuts;
  MV.search = { ensureFullText, fullText };
})(window.MV);
