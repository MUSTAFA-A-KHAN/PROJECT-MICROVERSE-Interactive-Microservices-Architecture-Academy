/* ==========================================================================
   Microverse — modules and lessons.
   Lesson bodies are markdown in content/modules/<id>.md, one section per
   lesson introduced by a line "@@lesson <lesson-id>".
   ========================================================================== */
window.MV = window.MV || {};

(function (MV) {
  'use strict';
  const { $, $$, esc, icon, ring, toast, inlineMd } = MV.ui;
  const store = MV.store;

  /** Split a module markdown file into Map(lessonId -> markdown). */
  function split(text) {
    const map = new Map();
    const parts = text.replace(/\r\n?/g, '\n').split(/^@@lesson\s+/m);
    parts.slice(1).forEach((p) => {
      const nl = p.indexOf('\n');
      const id = p.slice(0, nl).trim();
      map.set(id, p.slice(nl + 1));
    });
    return map;
  }

  async function loadLesson(moduleId, lessonId) {
    const text = await MV.ui.fetchText(MV.catalog.contentPath(moduleId));
    const map = split(text);
    if (!map.has(lessonId)) throw new Error(`Lesson "${lessonId}" was not found in ${MV.catalog.contentPath(moduleId)}`);
    return map.get(lessonId);
  }

  /** Mount interactive widgets and diagrams found inside root. */
  function mountEmbeds(root) {
    $$('[data-widget]', root).forEach((el) => {
      const name = el.getAttribute('data-widget');
      let props = {};
      try { props = JSON.parse(el.getAttribute('data-props') || '{}'); } catch (e) { /* ignore */ }
      const fn = MV.widgets && MV.widgets[name];
      if (!fn) {
        el.innerHTML = `<div class="callout callout-warn">${icon('triangle-alert')}<div><div class="callout-title">Interactive component “${esc(name)}” is unavailable</div><div class="callout-body"><p>Its script didn't load. Reload the page; if it persists, check the browser console.</p></div></div></div>`;
        return;
      }
      el.innerHTML = '';
      try {
        const cleanup = fn(el, props);
        if (typeof cleanup === 'function') MV.router.onLeave(cleanup);
      } catch (e) {
        console.error(e);
        el.innerHTML = `<div class="callout callout-danger">${icon('octagon-alert')}<div><div class="callout-title">This interactive component failed to start</div><div class="callout-body"><p>${esc(e.message)}</p></div></div></div>`;
      }
    });
    $$('[data-diagram]', root).forEach((el) => {
      const id = el.getAttribute('data-diagram');
      let props = {};
      try { props = JSON.parse(el.getAttribute('data-props') || '{}'); } catch (e) { /* ignore */ }
      try {
        const cleanup = MV.diagram.mount(el, id, props);
        if (typeof cleanup === 'function') MV.router.onLeave(cleanup);
      } catch (e) {
        console.error(e);
        el.innerHTML = `<div class="callout callout-warn">${icon('triangle-alert')}<div><div class="callout-title">Diagram “${esc(id)}” couldn't render</div><div class="callout-body"><p>${esc(e.message)}</p></div></div></div>`;
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  function statusIcon(key) {
    const l = store.get().lessons[key];
    if (l && l.status === 'completed') return `<span class="lesson-status is-done" title="Completed">${icon('check', '', 13)}</span>`;
    if (l) return `<span class="lesson-status is-started" title="In progress"></span>`;
    return `<span class="lesson-status" title="Not started"></span>`;
  }

  function relatedChallenges(m) {
    const concepts = new Set(m.lessons.flatMap((l) => l.concepts || []));
    return (MV.data.challenges || []).filter((c) => (c.concepts || []).some((k) => concepts.has(k)));
  }

  /* ---------- All modules ---------- */
  function renderModules(view) {
    MV.shell.setCrumbs([{ label: 'Dashboard', href: '#/' }, { label: 'All modules' }]);
    const total = MV.catalog.totalMinutes();
    view.innerHTML = `<div class="page">
      <div class="page-head"><div><div class="eyebrow">Syllabus</div><h1 class="page-title mt-1">All modules</h1>
        <p class="page-sub">${MV.catalog.lessons.length} lessons across ${MV.catalog.modules.length} modules — about ${Math.round(total / 60)} hours of material. Follow them in order, or use the <a href="#/path">3-hour bootcamp</a> for a guided route through the essentials.</p></div></div>
      <div class="grid-auto">${MV.catalog.modules.map((m) => moduleCard(m)).join('')}</div></div>`;
    MV.ui.revealIn(view);
  }

  function moduleCard(m) {
    const p = MV.shell.moduleProgress(m);
    const mins = m.lessons.reduce((s, l) => s + l.minutes, 0);
    return `<a class="card card-link spotlight card-pad module-card" href="#/module/${m.id}" data-reveal>
      <div class="flex items-start gap-3">
        <div class="icon-tile" style="--c:var(--${m.color})">${icon(m.icon)}</div>
        <div class="min-w-0 flex-1"><div class="eyebrow">Module ${m.num}</div><div class="font-semibold text-[15px] mt-0.5" style="color:var(--fg)">${esc(m.title)}</div></div>
        ${ring(p.pct, 30, 3)}
      </div>
      <p class="text-[13px] mt-3 text-fg2" style="min-height:3.2em">${esc(m.summary)}</p>
      <div class="flex items-center gap-3 mt-4 text-[12px] text-mutedc"><span class="flex items-center gap-1">${icon('book-open', '', 13)}${m.lessons.length} lessons</span><span class="flex items-center gap-1">${icon('clock', '', 13)}${mins} min</span><span class="ml-auto mono">${p.done}/${p.total}</span></div>
    </a>`;
  }

  /* ---------- Module overview ---------- */
  function renderModule(view, { id }) {
    const m = MV.catalog.module(id);
    if (!m) { view.innerHTML = notFound('module'); return; }
    MV.shell.setCrumbs([{ label: 'Modules', href: '#/modules' }, { label: `${m.num} ${m.nav}` }]);
    const p = MV.shell.moduleProgress(m);
    const mins = m.lessons.reduce((s, l) => s + l.minutes, 0);
    const next = m.lessons.find((l) => !store.isLessonDone(`${m.id}/${l.id}`)) || m.lessons[0];
    const started = m.lessons.some((l) => store.get().lessons[`${m.id}/${l.id}`]);
    const chs = relatedChallenges(m).slice(0, 3);
    view.innerHTML = `<div class="page">
      <header class="module-hero card" data-reveal>
        <div class="hero-aurora"></div>
        <div class="relative flex flex-wrap items-start gap-5 p-6">
          <div class="icon-tile" style="--c:var(--${m.color});width:48px;height:48px">${icon(m.icon, '', 22)}</div>
          <div class="flex-1 min-w-[240px]">
            <div class="eyebrow">Module ${m.num} · ${m.lessons.length} lessons · ${mins} min</div>
            <h1 class="page-title mt-1">${esc(m.title)}</h1>
            <p class="page-sub">${esc(m.summary)}</p>
            <div class="flex flex-wrap gap-2 mt-4">
              <a class="btn btn-primary" href="#/lesson/${m.id}/${next.id}">${icon(started ? 'circle-play' : 'play')}${p.done === p.total ? 'Review module' : started ? 'Continue' : 'Start module'}</a>
              <button class="btn" type="button" data-bm-module>${icon(store.isBookmarked('module:' + m.id) ? 'bookmark-check' : 'bookmark')}<span>${store.isBookmarked('module:' + m.id) ? 'Bookmarked' : 'Bookmark'}</span></button>
            </div>
          </div>
          <div class="module-progress">
            ${ring(p.pct, 64, 5)}
            <div><div class="stat-value">${Math.round(p.pct * 100)}%</div><div class="stat-sub">${p.done} of ${p.total} complete</div></div>
          </div>
        </div>
      </header>

      <div class="module-grid">
        <section>
          <div class="section-head"><h2 class="section-title">Lessons</h2><span class="text-[12px] text-mutedc">In order — each builds on the previous one</span></div>
          <ol class="lesson-list card">${m.lessons.map((l, i) => {
            const key = `${m.id}/${l.id}`;
            return `<li data-reveal><a class="lesson-row" href="#/lesson/${m.id}/${l.id}">
              ${statusIcon(key)}<span class="lesson-idx mono">${String(i + 1).padStart(2, '0')}</span>
              <span class="flex-1 min-w-0"><span class="lesson-row-title">${esc(l.title)}</span><span class="lesson-row-sub">${esc(l.summary)}</span></span>
              <span class="lesson-row-meta">${store.isBookmarked('lesson:' + key) ? icon('bookmark-check', 'bm-on', 14) : ''}<span>${l.minutes} min</span>${icon('chevron-right', '', 15)}</span></a></li>`;
          }).join('')}</ol>
        </section>
        <aside class="grid gap-4 content-start">
          <div class="card card-pad" data-reveal>
            <div class="eyebrow mb-3">You will be able to</div>
            <ul class="outcomes">${m.outcomes.map((o) => `<li>${icon('circle-check', '', 15)}<span>${esc(o)}</span></li>`).join('')}</ul>
          </div>
          ${chs.length ? `<div class="card card-pad" data-reveal><div class="eyebrow mb-3">Practise this module</div>
            <div class="grid gap-2">${chs.map((c) => `<a class="mini-link" href="#/challenge/${c.id}">${icon('swords', '', 15)}<span class="flex-1 min-w-0 truncate">${esc(c.title)}</span><span class="badge badge-square ${c.level === 'Beginner' ? 'badge-green' : c.level === 'Intermediate' ? 'badge-warn' : 'badge-err'}">${c.level}</span></a>`).join('')}
            <a class="mini-link" href="#/lab">${icon('workflow', '', 15)}<span class="flex-1">Architecture Lab</span>${icon('arrow-right', '', 14)}</a></div></div>` : ''}
        </aside>
      </div>
    </div>`;
    $('[data-bm-module]', view).addEventListener('click', (e) => {
      const added = store.toggleBookmark({ key: 'module:' + m.id, title: `Module ${m.num}: ${m.title}`, route: `#/module/${m.id}`, kind: 'module' });
      e.currentTarget.innerHTML = `${icon(added ? 'bookmark-check' : 'bookmark')}<span>${added ? 'Bookmarked' : 'Bookmark'}</span>`;
      toast(added ? 'Module bookmarked' : 'Bookmark removed', { type: added ? 'success' : 'info' });
    });
    store.pushRecent({ route: `#/module/${m.id}`, title: `Module ${m.num}: ${m.title}`, kind: 'Module' });
    MV.ui.revealIn(view);
  }

  /* ---------- Lesson ---------- */
  async function renderLesson(view, { m: moduleId, l: lessonId }, query, nav) {
    const key = `${moduleId}/${lessonId}`;
    const lesson = MV.catalog.lesson(key);
    if (!lesson) { view.innerHTML = notFound('lesson'); return; }
    const m = lesson.module;
    MV.shell.setCrumbs([{ label: 'Modules', href: '#/modules' }, { label: `${m.num} ${m.nav}`, href: `#/module/${m.id}` }, { label: lesson.title }]);
    const prev = MV.catalog.prev(key);
    const next = MV.catalog.next(key);
    store.visitLesson(key);
    store.pushRecent({ route: lesson.route, title: lesson.title, kind: `Lesson · ${m.nav}` });

    view.innerHTML = `<div class="read-progress" aria-hidden="true"><span></span></div>
    <div class="page lesson-page">
      <div class="lesson-grid">
        <article class="lesson-main min-w-0">
          <header class="lesson-head">
            <div class="flex flex-wrap items-center gap-2 text-[12.5px] text-mutedc">
              <a class="link-muted" href="#/module/${m.id}">Module ${m.num} · ${esc(m.nav)}</a><span>·</span>
              <span>Lesson ${lesson.index + 1} of ${m.lessons.length}</span><span>·</span>
              <span class="flex items-center gap-1">${icon('clock', '', 13)}${lesson.minutes} min</span>
            </div>
            <h1 class="lesson-title">${esc(lesson.title)}</h1>
            <p class="page-sub">${esc(lesson.summary)}</p>
            <div class="flex flex-wrap items-center gap-2 mt-4">
              ${(lesson.concepts || []).map((c) => `<span class="chip">${icon('tag')}${esc(MV.quiz.conceptLabel(c))}</span>`).join('')}
              <span class="flex-1"></span>
              <button class="btn btn-sm" type="button" data-bookmark data-tip="Bookmark" data-tip-kbd="B"></button>
              <button class="btn btn-sm" type="button" data-complete data-tip="Mark complete" data-tip-kbd="M"></button>
            </div>
          </header>
          <div class="prose" id="lesson-body">${MV.ui.skeleton(10)}</div>
          <section class="lesson-end card" id="lesson-end">
            <div class="flex flex-wrap items-center gap-4 p-5">
              <div class="icon-tile" style="--c:var(--green)">${icon('flag')}</div>
              <div class="flex-1 min-w-[200px]"><div class="font-semibold" style="color:var(--fg)">Finished reading?</div>
                <div class="text-[13px] text-fg2">Mark the lesson complete to update your progress and learning path.</div></div>
              <button class="btn btn-primary" type="button" data-complete-big></button>
            </div>
            <div class="lesson-nav">
              ${prev ? `<a class="lesson-nav-link" href="${prev.route}"><span class="text-[12px] text-mutedc flex items-center gap-1">${icon('arrow-left', '', 13)}Previous</span><span class="truncate">${esc(prev.title)}</span></a>` : '<span></span>'}
              ${next ? `<a class="lesson-nav-link is-next" href="${next.route}"><span class="text-[12px] text-mutedc flex items-center gap-1 justify-end">Next${icon('arrow-right', '', 13)}</span><span class="truncate">${esc(next.title)}</span></a>` : `<a class="lesson-nav-link is-next" href="#/challenges"><span class="text-[12px] text-mutedc flex items-center gap-1 justify-end">Course complete${icon('arrow-right', '', 13)}</span><span>Try the engineering challenges</span></a>`}
            </div>
          </section>
        </article>
        <aside class="lesson-aside" aria-label="Lesson navigation">
          <div class="lesson-aside-inner scroll-thin" data-lenis-prevent>
            <div class="eyebrow mb-2">On this page</div>
            <nav class="toc" id="toc"><div class="skeleton sk-line" style="width:80%"></div><div class="skeleton sk-line mt-2" style="width:60%"></div></nav>
            <div class="eyebrow mt-6 mb-2">Module ${m.num}</div>
            <ol class="aside-lessons">${m.lessons.map((l) => `<li><a href="#/lesson/${m.id}/${l.id}" ${l.id === lessonId ? 'aria-current="page"' : ''}>${statusIcon(`${m.id}/${l.id}`)}<span>${esc(l.title)}</span></a></li>`).join('')}</ol>
          </div>
        </aside>
      </div>
    </div>`;

    const syncButtons = () => {
      const done = store.isLessonDone(key);
      const bm = store.isBookmarked('lesson:' + key);
      $('[data-bookmark]', view).innerHTML = `${icon(bm ? 'bookmark-check' : 'bookmark')}${bm ? 'Saved' : 'Save'}`;
      $('[data-bookmark]', view).classList.toggle('is-active', bm);
      $('[data-complete]', view).innerHTML = `${icon(done ? 'circle-check' : 'circle')}${done ? 'Completed' : 'Mark complete'}`;
      $('[data-complete]', view).classList.toggle('btn-success', done);
      $('[data-complete-big]', view).innerHTML = done ? `${icon('rotate-ccw')}Mark as not complete` : `${icon('check')}Mark lesson complete`;
      $('[data-complete-big]', view).className = done ? 'btn' : 'btn btn-primary';
    };
    const toggleComplete = () => {
      const was = store.isLessonDone(key);
      store.completeLesson(key, !was);
      syncButtons();
      const ap = $('.aside-lessons a[aria-current] .lesson-status', view);
      if (ap) ap.outerHTML = statusIcon(key);
      if (!was) {
        const mp = MV.shell.moduleProgress(m);
        if (mp.done === mp.total) toast(`Module ${m.num} complete`, { type: 'success', desc: `You finished every lesson in ${m.title}.` });
        else toast('Lesson complete', { type: 'success', desc: next ? `Up next: ${next.title}` : undefined, action: next ? { label: 'Next lesson', onClick: () => MV.router.go(next.route) } : undefined });
      }
    };
    const toggleBm = () => {
      const added = store.toggleBookmark({ key: 'lesson:' + key, title: lesson.title, route: lesson.route, kind: 'lesson' });
      syncButtons();
      toast(added ? 'Lesson bookmarked' : 'Bookmark removed', { type: added ? 'success' : 'info', duration: 1800 });
    };
    syncButtons();
    $('[data-complete]', view).addEventListener('click', toggleComplete);
    $('[data-complete-big]', view).addEventListener('click', toggleComplete);
    $('[data-bookmark]', view).addEventListener('click', toggleBm);
    MV.shortcuts.page = {
      n: () => next && MV.router.go(next.route),
      p: () => prev && MV.router.go(prev.route),
      m: toggleComplete,
      b: toggleBm,
    };

    // Load and render the body
    let src;
    try {
      src = await loadLesson(moduleId, lessonId);
    } catch (err) {
      if (!MV.router.isCurrent(nav.token)) return;
      $('#lesson-body', view).innerHTML = MV.ui.loadError(err);
      $('#toc', view).innerHTML = '';
      return;
    }
    if (!MV.router.isCurrent(nav.token)) return;
    const ctx = {};
    const body = $('#lesson-body', view);
    body.innerHTML = MV.md.render(src, ctx);
    mountEmbeds(body);
    MV.quiz.bind(body, 'lesson:' + key, ctx.quizzes);
    bindChecklist(body, key);
    buildToc(view, ctx.headings);
    setupReadProgress(view);
    if (query.s) {
      const target = document.getElementById(query.s);
      if (target) setTimeout(() => target.scrollIntoView({ block: 'start' }), 50);
    }
  }

  /** Persist ticked items of markdown checklists (- [ ] item) per lesson. */
  function bindChecklist(root, key) {
    const boxes = $$('[data-md-check]', root);
    if (!boxes.length) return;
    const saved = new Set((store.get().checklists || {})[key] || []);
    boxes.forEach((cb, i) => { if (saved.has(i)) cb.checked = true; });
    const progress = document.createElement('div');
    progress.className = 'check-progress';
    boxes[0].closest('ul').before(progress);
    const sync = () => {
      const done = boxes.filter((b) => b.checked).length;
      progress.innerHTML = `${icon('list-checks', '', 15)}<span><strong>${done}</strong> of ${boxes.length} checked for your service</span><span class="bar" style="flex:1;max-width:180px"><span style="--v:${(done / boxes.length * 100).toFixed(0)}%"></span></span>`;
    };
    sync();
    root.addEventListener('change', (e) => {
      if (!e.target.matches('[data-md-check]')) return;
      const checked = boxes.map((b, i) => (b.checked ? i : -1)).filter((i) => i >= 0);
      store.update((s) => { s.checklists = s.checklists || {}; s.checklists[key] = checked; }, 'checklist');
      sync();
    });
  }

  function buildToc(view, headings) {
    const toc = $('#toc', view);
    const hs = headings.filter((h) => h.level === 2);
    if (!hs.length) { toc.innerHTML = '<span class="text-[12.5px] text-mutedc">Single-section lesson</span>'; return; }
    toc.innerHTML = hs.map((h) => `<a href="#" data-toc="${h.id}">${esc(h.text)}</a>`).join('');
    toc.addEventListener('click', (e) => {
      const a = e.target.closest('[data-toc]');
      if (!a) return;
      e.preventDefault();
      const el = document.getElementById(a.dataset.toc);
      if (!el) return;
      if (MV.lenis) MV.lenis.scrollTo(el, { offset: -16 }); else el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    const links = new Map(hs.map((h) => [h.id, $(`[data-toc="${h.id}"]`, toc)]));
    const obs = new IntersectionObserver((entries) => {
      entries.forEach((en) => {
        if (en.isIntersecting) {
          links.forEach((a) => a.removeAttribute('aria-current'));
          const a = links.get(en.target.id);
          if (a) a.setAttribute('aria-current', 'true');
        }
      });
    }, { root: $('#main'), rootMargin: '0px 0px -70% 0px', threshold: 0 });
    hs.forEach((h) => { const el = document.getElementById(h.id); if (el) obs.observe(el); });
    MV.router.onLeave(() => obs.disconnect());
  }

  function setupReadProgress(view) {
    const bar = $('.read-progress span', view);
    const main = $('#main');
    if (!bar) return;
    const update = () => {
      const max = main.scrollHeight - main.clientHeight;
      bar.style.transform = `scaleX(${max > 0 ? Math.min(1, main.scrollTop / max) : 0})`;
    };
    main.addEventListener('scroll', update, { passive: true });
    MV.router.onLeave(() => main.removeEventListener('scroll', update));
    update();
  }

  function notFound(kind) {
    return `<div class="page"><div class="empty">${icon('map-pin-off')}<strong>That ${kind} doesn't exist</strong><a class="btn mt-2" href="#/modules">Browse all modules</a></div></div>`;
  }

  MV.lessons = { split, loadLesson, mountEmbeds, renderModules, renderModule, renderLesson, moduleCard, statusIcon };
})(window.MV);
