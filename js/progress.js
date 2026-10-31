/* ==========================================================================
   Microverse — dashboard, progress tracking and the knowledge assessment.
   Everything here is computed from the learner's own state in localStorage.
   ========================================================================== */
window.MV = window.MV || {};

(function (MV) {
  'use strict';
  const { $, $$, esc, icon, toast, inlineMd, ring, fmtDuration, timeAgo } = MV.ui;
  const store = MV.store;

  /* ---------- Derived metrics ---------- */
  function nextLesson() {
    const s = store.get();
    const recentLesson = s.recent.find((r) => r.route && r.route.startsWith('#/lesson/'));
    if (recentLesson) {
      const key = recentLesson.route.replace('#/lesson/', '');
      if (!store.isLessonDone(key) && MV.catalog.lesson(key)) return MV.catalog.lesson(key);
      const after = MV.catalog.next(key);
      if (after && !store.isLessonDone(after.key)) return after;
    }
    return MV.catalog.lessons.find((l) => !store.isLessonDone(l.key)) || null;
  }

  function knowledge() {
    const concepts = store.get().concepts;
    let c = 0, w = 0;
    Object.values(concepts).forEach((x) => { c += x.correct; w += x.wrong; });
    return { correct: c, wrong: w, answered: c + w, score: c + w ? Math.round((c / (c + w)) * 100) : null };
  }

  function conceptRows() {
    const s = store.get();
    const assessWrong = new Set(s.assessment ? s.assessment.weak || [] : []);
    return Object.entries(MV.data.concepts).map(([id, meta]) => {
      const st = s.concepts[id] || { correct: 0, wrong: 0 };
      const total = st.correct + st.wrong;
      const mastery = total ? st.correct / total : null;
      let level = 'unseen';
      if (total) level = mastery >= 0.8 ? 'strong' : mastery >= 0.5 ? 'review' : 'weak';
      if (assessWrong.has(id) && level !== 'weak') level = level === 'strong' ? 'review' : 'weak';
      return { id, label: meta.label, lesson: meta.lesson, correct: st.correct, wrong: st.wrong, total, mastery, level };
    });
  }

  function weakConcepts() {
    return conceptRows().filter((r) => r.level === 'weak' || r.level === 'review').sort((a, b) => (a.mastery ?? 0) - (b.mastery ?? 0));
  }

  function recommendations(limit = 4) {
    const seen = new Set();
    const out = [];
    weakConcepts().forEach((c) => {
      if (seen.has(c.lesson)) return;
      seen.add(c.lesson);
      const l = MV.catalog.lesson(c.lesson);
      if (l) out.push({ lesson: l, concept: c });
    });
    return out.slice(0, limit);
  }

  function exportProgress() {
    const json = store.exportJSON();
    try {
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `microverse-progress-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      toast('Progress exported', { type: 'success', desc: 'Saved as a JSON file you can import on another browser.' });
    } catch (e) {
      MV.ui.copyText(json).then((ok) => toast(ok ? 'Progress copied to clipboard' : 'Export failed', { type: ok ? 'success' : 'error' }));
    }
  }

  /* ======================================================================
     Dashboard
     ====================================================================== */
  function renderDashboard(view) {
    MV.shell.setCrumbs([{ label: 'Dashboard' }]);
    const s = store.get();
    const prog = MV.shell.overallProgress();
    const k = knowledge();
    const nl = nextLesson();
    const solved = MV.data.challenges.filter((c) => s.challenges[c.id] && s.challenges[c.id].solved).length;
    const bcDone = MV.data.bootcamp.filter((x) => MV.bootcamp.isDone(x.id)).length;
    const nextBc = MV.bootcamp.nextSession();
    const firstVisit = !Object.keys(s.lessons).length && !s.lab.runs;
    const recent = s.recent.slice(0, 5);
    const upcoming = MV.data.challenges.filter((c) => !(s.challenges[c.id] && s.challenges[c.id].solved)).slice(0, 3);
    const recs = recommendations(3);
    const hour = new Date().getHours();
    const greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

    view.innerHTML = `<div class="page page-wide">
      <section class="dash-hero card" data-reveal>
        <div class="hero-aurora"></div><div class="dash-hero-grid grid-bg"></div>
        <div class="relative dash-hero-inner">
          <div class="min-w-0">
            <div class="eyebrow">${firstVisit ? 'Welcome to Microverse' : greet}</div>
            <h1 class="dash-title">${firstVisit ? 'Learn how production microservices actually work.' : nl ? 'Pick up where you left off.' : 'You’ve completed every lesson.'}</h1>
            <p class="page-sub">${firstVisit ? 'Interactive lessons, a live architecture simulator, a real Go codebase and incident-style challenges — built around one Order Management System.' : nl ? `Next: <strong style="color:var(--fg)">${esc(nl.title)}</strong> · ${esc(nl.module.nav)} · ${nl.minutes} min` : 'Test yourself with the knowledge check or the advanced challenges.'}</p>
            <div class="flex flex-wrap gap-2 mt-5">
              ${nl ? `<a class="btn btn-primary btn-lg" href="${nl.route}">${icon(firstVisit ? 'play' : 'circle-play')}${firstVisit ? 'Start the first lesson' : 'Continue learning'}</a>` : `<a class="btn btn-primary btn-lg" href="#/assessment">${icon('clipboard-check')}Knowledge check</a>`}
              <a class="btn btn-lg" href="#/path">${icon('route')}3-hour bootcamp</a>
              <a class="btn btn-lg btn-ghost" href="#/lab">${icon('workflow')}Open the Lab</a>
            </div>
          </div>
          <div class="dash-hero-figure" aria-label="Course progress">
            ${ring(prog.pct, 132, 9, 'dash-ring')}
            <div class="dash-ring-label"><div class="dash-hero-num" data-count="${Math.round(prog.pct * 100)}">0%</div><div class="stat-sub">${prog.done} of ${prog.total} lessons</div></div>
          </div>
        </div>
      </section>

      <section class="dash-stats" data-reveal>
        ${stat('book-check', 'Lessons completed', `${prog.done}`, `of ${prog.total}`, 'blue')}
        ${stat('brain', 'Knowledge score', k.score === null ? '—' : `${k.score}%`, k.answered ? `${k.answered} answers` : 'answer lesson quizzes', 'purple')}
        ${stat('swords', 'Challenges solved', `${solved}`, `of ${MV.data.challenges.length}`, 'warn')}
        ${stat('timer', 'Time learning', fmtDuration(s.time.total), 'active time only', 'cyan')}
        ${stat('workflow', 'Lab simulations', `${s.lab.runs || 0}`, `${Object.keys(s.lab.failuresSeen || {}).length} failure types tried`, 'green')}
      </section>

      <div class="dash-grid">
        <div class="grid gap-4 content-start">
          <section class="card" data-reveal>
            <div class="card-head"><div class="card-title flex items-center gap-2">${icon('route', '', 16)}Learning path</div><a class="text-[12.5px]" href="#/path">${bcDone}/6 sessions</a></div>
            <div class="p-4"><ol class="dash-path">${MV.data.bootcamp.map((b) => { const d = MV.bootcamp.isDone(b.id); return `<li class="${d ? 'is-done' : nextBc && nextBc.id === b.id ? 'is-next' : ''}"><a href="#/bootcamp/${b.id}"><span class="dash-path-dot">${d ? icon('check', '', 12) : b.num}</span><span class="dash-path-title">${esc(b.title)}</span></a></li>`; }).join('')}</ol>
            ${nextBc ? `<a class="mini-link mt-3" href="#/bootcamp/${nextBc.id}">${icon('circle-play', '', 15)}<span class="flex-1">Session ${nextBc.num}: ${esc(nextBc.title)}</span><span class="text-[11px] text-mutedc">30 min</span></a>` : ''}</div>
          </section>
          <section class="card" data-reveal>
            <div class="card-head"><div class="card-title flex items-center gap-2">${icon('library', '', 16)}Modules</div><a class="text-[12.5px]" href="#/modules">View all</a></div>
            <div class="dash-modules">${MV.catalog.modules.map((m) => { const p = MV.shell.moduleProgress(m); return `<a class="dash-mod" href="#/module/${m.id}"><span class="mono text-[11px] text-mutedc">${m.num}</span><span class="flex-1 min-w-0 truncate">${esc(m.nav)}</span><span class="bar bar-thin" style="width:72px"><span style="--v:${(p.pct * 100).toFixed(0)}%"></span></span><span class="mono text-[11px] text-mutedc" style="width:30px;text-align:right">${p.done}/${p.total}</span></a>`; }).join('')}</div>
          </section>
          ${codeLabCard()}
        </div>
        <div class="grid gap-4 content-start">
          <a class="card card-link spotlight dash-lab" href="#/lab" data-reveal>
            <div class="dash-lab-visual dot-bg" aria-hidden="true">${labMini()}</div>
            <div class="p-4"><div class="flex items-center gap-2"><span class="font-semibold" style="color:var(--fg)">Architecture Lab</span><span class="badge badge-sim">Simulated</span></div>
            <p class="text-[13px] text-fg2 mt-1">Send requests through the Order Management System, inject eight kinds of failure and watch timeouts, retries, breakers and the outbox respond.</p></div>
          </a>
          <section class="card" data-reveal>
            <div class="card-head"><div class="card-title flex items-center gap-2">${icon('history', '', 16)}Recently accessed</div></div>
            <div class="p-2">${recent.length ? recent.map((r) => `<a class="dash-row" href="${r.route}">${icon(r.kind && r.kind.startsWith('Lesson') ? 'book-open' : r.kind === 'Challenge' ? 'swords' : r.kind === 'Source file' ? 'file-code-2' : r.kind === 'Bootcamp' ? 'timer' : r.kind === 'Exercise' ? 'code-xml' : r.kind === 'Scratchpad' ? 'square-terminal' : 'compass', '', 15)}<span class="flex-1 min-w-0"><span class="block truncate" style="color:var(--fg)">${esc(r.title)}</span><span class="block text-[11.5px] text-mutedc">${esc(r.kind || '')}</span></span><span class="text-[11.5px] text-mutedc">${timeAgo(r.at)}</span></a>`).join('') : `<div class="empty" style="margin:8px">${icon('compass')}<span>Your recently opened lessons, files and challenges will appear here.</span></div>`}</div>
          </section>
          <section class="card" data-reveal>
            <div class="card-head"><div class="card-title flex items-center gap-2">${icon('swords', '', 16)}Upcoming challenges</div><a class="text-[12.5px]" href="#/challenges">All</a></div>
            <div class="p-2">${upcoming.length ? upcoming.map((c) => `<a class="dash-row" href="#/challenge/${c.id}"><span class="badge badge-square ${c.level === 'Beginner' ? 'badge-green' : c.level === 'Intermediate' ? 'badge-warn' : 'badge-err'}">${c.level}</span><span class="flex-1 min-w-0 truncate" style="color:var(--fg)">${esc(c.title)}</span>${icon('arrow-right', '', 14)}</a>`).join('') : `<div class="empty" style="margin:8px">${icon('trophy')}<strong>All challenges solved</strong></div>`}</div>
          </section>
          <section class="card" data-reveal>
            <div class="card-head"><div class="card-title flex items-center gap-2">${icon('sparkles', '', 16)}Recommended for you</div><a class="text-[12.5px]" href="#/assessment">Knowledge check</a></div>
            <div class="p-2">${recs.length ? recs.map((r) => `<a class="dash-row" href="${r.lesson.route}">${icon('target', '', 15)}<span class="flex-1 min-w-0"><span class="block truncate" style="color:var(--fg)">${esc(r.lesson.title)}</span><span class="block text-[11.5px] text-mutedc">Review: ${esc(r.concept.label)} (${r.concept.correct}/${r.concept.total} correct)</span></span></a>`).join('') : `<div class="text-[13px] text-fg2 p-3">Answer lesson quizzes or take the <a href="#/assessment">knowledge check</a> — concepts you miss turn into recommendations here.</div>`}</div>
          </section>
        </div>
      </div>
    </div>`;
    MV.ui.revealIn(view);
    const num = $('[data-count]', view);
    MV.ui.countUp(num, +num.dataset.count, { suffix: '%' });
    if (window.gsap && !MV.reducedMotion) gsap.from($$('.dash-lab-visual .lm-pkt', view), { opacity: 0, duration: 0.6, stagger: 0.2 });
  }

  /** Dashboard card: Code Lab progress and the next exercises to try. */
  function codeLabCard() {
    const all = MV.data.exercises;
    const ex = store.get().exercises || {};
    const solved = all.filter((e) => ex[e.id] && ex[e.id].solved).length;
    const next = all.filter((e) => !(ex[e.id] && ex[e.id].solved)).slice(0, 3);
    const LV = { Beginner: 'badge-green', Intermediate: 'badge-warn', Advanced: 'badge-err' };
    return `<section class="card" data-reveal>
      <div class="card-head"><div class="card-title flex items-center gap-2">${icon('code-xml', '', 16)}Code Lab</div><a class="text-[12.5px]" href="#/code">${solved}/${all.length} solved</a></div>
      <div class="p-2">${next.length ? next.map((e) => { const st = MV.codelab.status(e.id); return `<a class="dash-row" href="#/code/${e.id}"><span class="badge badge-square ${LV[e.level]}">${e.level}</span><span class="flex-1 min-w-0 truncate" style="color:var(--fg)">${esc(e.title)}</span>${st.label !== 'New' ? `<span class="text-[11.5px] text-mutedc">${esc(st.label)}</span>` : ''}${icon('arrow-right', '', 14)}</a>`; }).join('') : `<div class="empty" style="margin:8px">${icon('trophy')}<strong>Every exercise solved</strong><a class="btn btn-sm mt-1" href="#/code/scratch">Open the scratchpad</a></div>`}
        <a class="mini-link mt-1" href="#/code/scratch">${icon('square-terminal', '', 15)}<span class="flex-1">Go scratchpad: edit and run any program</span></a></div>
    </section>`;
  }

  function stat(ic, label, value, sub, color) {
    return `<div class="card dash-stat"><span class="icon-tile sm" style="--c:var(--${color})">${icon(ic)}</span><div class="min-w-0"><div class="stat-label">${label}</div><div class="stat-value" style="font-size:22px">${value}</div><div class="stat-sub truncate">${sub}</div></div></div>`;
  }

  function labMini() {
    const n = [['Client', 30, 60], ['Gateway', 120, 60], ['User', 210, 22], ['Order', 210, 98], ['DB', 300, 22], ['Broker', 300, 98]];
    const e = [[0, 1], [1, 2], [1, 3], [2, 4], [3, 5]];
    return `<svg viewBox="0 0 340 120" width="100%" height="120">${e.map(([a, b]) => `<line x1="${n[a][1] + 20}" y1="${n[a][2]}" x2="${n[b][1] - 20}" y2="${n[b][2]}" class="lm-edge"/>`).join('')}
      ${e.map(([a, b], i) => `<circle r="3.5" class="lm-pkt"><animateMotion dur="${2 + i * 0.3}s" repeatCount="indefinite" path="M${n[a][1] + 20},${n[a][2]} L${n[b][1] - 20},${n[b][2]}"/></circle>`).join('')}
      ${n.map(([t, x, y]) => `<g><rect x="${x - 24}" y="${y - 11}" width="48" height="22" rx="6" class="lm-node"/><text x="${x}" y="${y + 4}" text-anchor="middle" class="lm-text">${t}</text></g>`).join('')}</svg>`;
  }

  /* ======================================================================
     Progress page
     ====================================================================== */
  function renderProgress(view, query) {
    MV.shell.setCrumbs([{ label: 'You', href: '#/progress' }, { label: 'Progress' }]);
    const tabs = [['overview', 'Overview', 'chart-no-axes-column'], ['concepts', 'Concepts', 'brain'], ['quizzes', 'Quiz scores', 'list-checks'], ['bookmarks', 'Bookmarks', 'bookmark'], ['time', 'Time', 'timer'], ['data', 'Your data', 'database']];
    let tab = tabs.some((t) => t[0] === query.tab) ? query.tab : 'overview';
    view.innerHTML = `<div class="page">
      <div class="page-head"><div><div class="eyebrow">You</div><h1 class="page-title mt-1">Learning progress</h1><p class="page-sub">Everything here is stored in this browser (localStorage). Export it to move to another device.</p></div></div>
      <div class="tabs mb-5" role="tablist">${tabs.map(([k, l, ic]) => `<button class="tab" role="tab" type="button" data-tab="${k}" aria-selected="${k === tab}">${icon(ic)}${l}${k === 'bookmarks' ? `<span class="count">${store.get().bookmarks.length}</span>` : ''}</button>`).join('')}</div>
      <div data-panel></div></div>`;
    const draw = () => { $('[data-panel]', view).innerHTML = PANELS[tab](); bindPanel(); MV.ui.revealIn(view); };
    const PANELS = {
      overview: () => {
        const s = store.get();
        const prog = MV.shell.overallProgress();
        const k = knowledge();
        return `<div class="dash-stats mb-5">
            ${stat('book-check', 'Lessons completed', `${prog.done}/${prog.total}`, `${Math.round(prog.pct * 100)}% of the course`, 'blue')}
            ${stat('brain', 'Knowledge score', k.score === null ? '—' : `${k.score}%`, `${k.correct} correct · ${k.wrong} wrong`, 'purple')}
            ${stat('swords', 'Challenges solved', `${MV.data.challenges.filter((c) => s.challenges[c.id] && s.challenges[c.id].solved).length}/${MV.data.challenges.length}`, 'scenario-based', 'warn')}
            ${stat('timer', 'Time learning', fmtDuration(s.time.total), `${Object.keys(s.time.byDay).length} active days`, 'cyan')}
          </div>
          <div class="table-wrap"><table class="table"><thead><tr><th>Module</th><th>Lessons</th><th>Progress</th><th>Quiz accuracy</th><th>Time</th></tr></thead><tbody>${MV.catalog.modules.map((m) => {
            const p = MV.shell.moduleProgress(m);
            let c = 0, t = 0;
            m.lessons.forEach((l) => { const q = s.quizzes['lesson:' + m.id + '/' + l.id]; if (q) { c += q.correct; t += q.total; } });
            return `<tr><td><a href="#/module/${m.id}" style="color:var(--fg)"><span class="mono text-mutedc">${m.num}</span> ${esc(m.title)}</a></td><td class="tabular">${p.done}/${p.total}</td><td><span class="bar" style="display:block;width:120px"><span style="--v:${(p.pct * 100).toFixed(0)}%"></span></span></td><td class="tabular">${t ? Math.round((c / t) * 100) + '%' : '—'}</td><td class="tabular">${fmtDuration(s.time.byModule[m.id] || 0)}</td></tr>`;
          }).join('')}</tbody></table></div>
          <div class="grid md:grid-cols-2 gap-4 mt-5">
            <div class="card"><div class="card-head"><div class="card-title">Challenges</div></div><div class="p-2">${MV.data.challenges.map((c) => { const st = MV.challenges.status(c.id); const r = s.challenges[c.id]; return `<a class="dash-row" href="#/challenge/${c.id}"><span class="badge ${st.cls}">${icon(st.ic)}${st.label}</span><span class="flex-1 min-w-0 truncate" style="color:var(--fg)">${esc(c.title)}</span><span class="text-[11.5px] text-mutedc">${r && r.rubricScore !== undefined ? `self-check ${r.rubricScore}%` : ''}</span></a>`; }).join('')}</div></div>
            <div class="card"><div class="card-head"><div class="card-title">Bootcamp</div></div><div class="p-2">${MV.data.bootcamp.map((b) => { const st = s.bootcamp[b.id] || { steps: {} }; const n = MV.bootcamp.STEPS.filter(([k]) => st.steps[k]).length; return `<a class="dash-row" href="#/bootcamp/${b.id}"><span class="badge ${st.completedAt ? 'badge-green' : n ? 'badge-blue' : 'badge-muted'}">${st.completedAt ? 'Complete' : `${n}/6`}</span><span class="flex-1 min-w-0 truncate" style="color:var(--fg)">Session ${b.num}: ${esc(b.title)}</span><span class="text-[11.5px] text-mutedc">${st.quiz ? `quiz ${st.quiz.correct}/${st.quiz.total}` : ''}</span></a>`; }).join('')}</div></div>
          </div>
          <div class="card mt-4"><div class="card-head"><div class="card-title">Code Lab</div><a class="text-[12.5px]" href="#/code">${MV.codelab.solvedCount()}/${MV.data.exercises.length} solved</a></div>
            <div class="p-2 dash-rows-2">${MV.data.exercises.map((e) => { const st = MV.codelab.status(e.id); const r = (s.exercises || {})[e.id]; return `<a class="dash-row" href="#/code/${e.id}"><span class="badge ${st.cls}">${icon(st.ic)}${esc(st.label)}</span><span class="flex-1 min-w-0 truncate" style="color:var(--fg)">${esc(e.title)}</span><span class="text-[11.5px] text-mutedc">${r && r.runs ? `${r.runs} run${r.runs === 1 ? '' : 's'}` : ''}</span></a>`; }).join('')}</div></div>`;
      },
      concepts: () => {
        const rows = conceptRows().sort((a, b) => ({ weak: 0, review: 1, strong: 2, unseen: 3 }[a.level] - { weak: 0, review: 1, strong: 2, unseen: 3 }[b.level]) || (a.mastery ?? 2) - (b.mastery ?? 2));
        const pill = { weak: ['is-err', 'circle-x', 'Weak'], review: ['is-warn', 'triangle-alert', 'Review'], strong: ['is-ok', 'circle-check', 'Strong'], unseen: ['is-muted', 'circle-dashed', 'Not tested'] };
        return `<p class="text-[13.5px] text-fg2 mb-3">Mastery is based on your <strong style="color:var(--fg)">first</strong> answer to each question in lesson quizzes, bootcamp quizzes and the knowledge check.</p>
          <div class="table-wrap"><table class="table"><thead><tr><th>Concept</th><th>Status</th><th>Correct</th><th>Mastery</th><th></th></tr></thead><tbody>${rows.map((r) => {
            const p = pill[r.level];
            const l = MV.catalog.lesson(r.lesson);
            return `<tr><td style="color:var(--fg)">${esc(r.label)}</td><td><span class="pill ${p[0]}">${icon(p[1])}${p[2]}</span></td><td class="tabular">${r.total ? `${r.correct}/${r.total}` : '—'}</td><td>${r.mastery === null ? '' : `<span class="meter${r.level === 'weak' ? ' is-err' : r.level === 'review' ? ' is-warn' : ''}" style="display:block;width:100px"><span style="width:${Math.round(r.mastery * 100)}%"></span></span>`}</td><td>${l ? `<a href="${l.route}" class="text-[12.5px]">Review lesson</a>` : ''}</td></tr>`;
          }).join('')}</tbody></table></div>`;
      },
      quizzes: () => {
        const q = store.get().quizzes;
        const lessonRows = Object.entries(q).filter(([k]) => k.startsWith('lesson:')).map(([k, v]) => ({ l: MV.catalog.lesson(k.slice(7)), v })).filter((x) => x.l);
        const bc = Object.entries(q).filter(([k]) => k.startsWith('bootcamp:'));
        const a = store.get().assessment;
        if (!lessonRows.length && !bc.length && !a) return `<div class="empty">${icon('list-checks')}<strong>No quiz answers yet</strong><span>Every lesson ends with a knowledge check. Your scores will appear here.</span></div>`;
        return `<div class="table-wrap"><table class="table"><thead><tr><th>Quiz</th><th>Score</th><th>When</th></tr></thead><tbody>
          ${a ? `<tr><td><a href="#/assessment" style="color:var(--fg)">Knowledge check</a></td><td class="tabular">${a.score}/${a.total}</td><td>${timeAgo(a.at)}</td></tr>` : ''}
          ${bc.map(([k, v]) => { const b = MV.data.bootcamp.find((x) => 'bootcamp:' + x.id === k); return b ? `<tr><td><a href="#/bootcamp/${b.id}" style="color:var(--fg)">Bootcamp session ${b.num}: ${esc(b.title)}</a></td><td class="tabular">${v.correct}/${v.total}</td><td>${timeAgo(v.at)}</td></tr>` : ''; }).join('')}
          ${lessonRows.map(({ l, v }) => `<tr><td><a href="${l.route}" style="color:var(--fg)">${esc(l.title)}</a> <span class="text-mutedc text-[12px]">${esc(l.module.nav)}</span></td><td class="tabular">${v.correct}/${v.total}</td><td>${timeAgo(v.at)}</td></tr>`).join('')}
        </tbody></table></div>`;
      },
      bookmarks: () => {
        const b = store.get().bookmarks;
        if (!b.length) return `<div class="empty">${icon('bookmark')}<strong>No bookmarks yet</strong><span>Save lessons, modules, challenges and source files with the bookmark button (or press <span class="kbd">B</span> on a lesson).</span></div>`;
        return `<div class="card p-2">${b.map((x) => `<div class="dash-row"><a class="flex items-center gap-2 flex-1 min-w-0" href="${x.route}" style="text-decoration:none">${icon(x.kind === 'challenge' ? 'swords' : x.kind === 'file' ? 'file-code-2' : x.kind === 'module' ? 'library' : 'book-open', '', 15)}<span class="truncate" style="color:var(--fg)">${esc(x.title)}</span></a><span class="text-[11.5px] text-mutedc">${timeAgo(x.at)}</span><button class="btn btn-ghost btn-icon btn-sm" type="button" data-unbm="${esc(x.key)}" aria-label="Remove bookmark">${icon('x')}</button></div>`).join('')}</div>`;
      },
      time: () => {
        const s = store.get();
        const days = [];
        for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10); days.push({ d, v: Math.round((s.time.byDay[d] || 0) / 60) }); }
        const areas = Object.entries(s.time.byModule).sort((a, b) => b[1] - a[1]);
        const name = (k) => (MV.catalog.module(k) ? `${MV.catalog.module(k).num} ${MV.catalog.module(k).nav}` : { lab: 'Architecture Lab', playground: 'Code Playground', challenges: 'Challenges', bootcamp: 'Bootcamp' }[k] || k);
        return `<div class="card card-pad"><div class="card-title mb-1">Minutes of active learning, last 14 days</div><div class="text-[12px] text-mutedc mb-3">Counted only while the tab is visible and you have interacted in the last 90 seconds.</div><div data-time-chart></div></div>
          <div class="table-wrap mt-4"><table class="table"><thead><tr><th>Area</th><th>Time</th></tr></thead><tbody>${areas.length ? areas.map(([k, v]) => `<tr><td style="color:var(--fg)">${esc(name(k))}</td><td class="tabular">${fmtDuration(v)}</td></tr>`).join('') : '<tr><td colspan="2" class="text-mutedc">No time recorded yet.</td></tr>'}</tbody></table></div>`;
      },
      data: () => `<div class="grid md:grid-cols-3 gap-4">
          <div class="card card-pad grid gap-2 content-start"><div class="card-title">Export</div><p class="text-[13px] text-fg2">Download your progress (lessons, quizzes, challenges, code exercises, bookmarks, time) as JSON.</p><button class="btn" type="button" data-export>${icon('download')}Export progress</button></div>
          <div class="card card-pad grid gap-2 content-start"><div class="card-title">Import</div><p class="text-[13px] text-fg2">Restore a previously exported file. This replaces your current progress.</p><label class="btn" style="cursor:pointer">${icon('upload')}Choose file<input type="file" accept="application/json,.json" data-import hidden></label></div>
          <div class="card card-pad grid gap-2 content-start"><div class="card-title">Reset</div><p class="text-[13px] text-fg2">Clear all progress in this browser. Your theme preference is kept.</p><button class="btn btn-danger" type="button" data-reset>${icon('trash-2')}Reset progress</button></div>
        </div>`,
    };
    function bindPanel() {
      const p = $('[data-panel]', view);
      if (tab === 'time') {
        const s = store.get();
        const bars = [];
        for (let i = 13; i >= 0; i--) { const d = new Date(Date.now() - i * 86400000); const key = d.toISOString().slice(0, 10); bars.push({ label: d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' }), value: Math.round((s.time.byDay[key] || 0) / 60) }); }
        MV.wkit.columnChart($('[data-time-chart]', p), { bars, format: (v) => `${Math.round(v)} min`, label: 'Minutes per day' });
      }
      $$('[data-unbm]', p).forEach((b) => b.addEventListener('click', () => { const bm = store.get().bookmarks.find((x) => x.key === b.dataset.unbm); if (bm) store.toggleBookmark(bm); draw(); }));
      const ex = $('[data-export]', p); if (ex) ex.addEventListener('click', exportProgress);
      const im = $('[data-import]', p);
      if (im) im.addEventListener('change', async () => {
        const f = im.files[0]; if (!f) return;
        try { store.importJSON(await f.text()); toast('Progress imported', { type: 'success' }); MV.shell.applyTheme(); draw(); }
        catch (e) { toast('Import failed', { type: 'error', desc: e.message }); }
      });
      const rs = $('[data-reset]', p);
      if (rs) rs.addEventListener('click', async () => {
        const ok = await MV.ui.confirm({ title: 'Reset all progress?', message: 'Lessons, quiz answers, challenges, your Code Lab code and drafts, bookmarks, time and lab layout will be cleared from this browser. This cannot be undone — export first if you might want it back.', confirmText: 'Reset progress', danger: true });
        if (ok) { store.reset(); toast('Progress reset', { type: 'info' }); draw(); }
      });
    }
    $$('[data-tab]', view).forEach((t) => t.addEventListener('click', () => { tab = t.dataset.tab; $$('[data-tab]', view).forEach((x) => x.setAttribute('aria-selected', String(x === t))); draw(); }));
    draw();
  }

  /* ======================================================================
     Knowledge assessment
     ====================================================================== */
  function renderAssessment(view) {
    MV.shell.setCrumbs([{ label: 'You', href: '#/progress' }, { label: 'Knowledge check' }]);
    const Q = MV.data.assessment;
    Q.forEach(MV.quiz.shuffle); // stable shuffle, so saved answers match on any visit
    const prevResult = store.get().assessment;
    let i = 0, answers = {}, started = false;

    function intro() {
      view.innerHTML = `<div class="page" style="max-width:820px">
        <div class="eyebrow">Knowledge check</div><h1 class="page-title mt-1">How well do you know microservices?</h1>
        <p class="page-sub">${Q.length} scenario questions across the whole course, about 12 minutes. Your answers update concept mastery, and every miss becomes a lesson recommendation.</p>
        <div class="card card-pad mt-5 grid gap-3">
          ${prevResult ? `<div class="flex items-center gap-4">${ring(prevResult.score / prevResult.total, 56, 5)}<div><div class="font-semibold" style="color:var(--fg)">Last attempt: ${prevResult.score}/${prevResult.total}</div><div class="text-[13px] text-fg2">${timeAgo(prevResult.at)} · ${prevResult.weak.length} concept${prevResult.weak.length === 1 ? '' : 's'} to review</div></div></div>` : ''}
          <div class="flex flex-wrap gap-2"><button class="btn btn-primary btn-lg" type="button" data-start>${icon('play')}${prevResult ? 'Retake the check' : 'Start the check'}</button>${prevResult ? `<button class="btn btn-lg" type="button" data-show-last>${icon('list-checks')}See last results</button>` : ''}</div>
        </div></div>`;
      $('[data-start]', view).addEventListener('click', () => { started = true; i = 0; answers = {}; question(); });
      const sl = $('[data-show-last]', view);
      if (sl) sl.addEventListener('click', () => { answers = prevResult.answers; results(false); });
    }

    function question() {
      const q = Q[i];
      view.innerHTML = `<div class="page" style="max-width:820px">
        <div class="flex items-center gap-3 mb-4"><span class="mono text-[12.5px] text-mutedc">Question ${i + 1} of ${Q.length}</span><span class="bar" style="flex:1"><span style="--v:${(i / Q.length) * 100}%"></span></span><span class="chip">${icon('tag')}${esc(MV.quiz.conceptLabel(q.concept))}</span></div>
        <div data-q>${MV.quiz.html(q, i, { label: 'Knowledge check' })}</div>
        <div class="flex justify-between mt-4"><button class="btn" type="button" data-quit>${icon('x')}Quit</button><button class="btn btn-primary" type="button" data-next disabled>${i === Q.length - 1 ? 'See results' : 'Next question'}${icon('arrow-right')}</button></div></div>`;
      MV.quiz.bind($('[data-q]', view), 'assessment:' + Date.now(), Q, {
        record: false,
        onAnswer: ({ chosen, correct }) => {
          answers[q.id] = chosen;
          // Count the first attempt toward concept mastery (same rule as lessons).
          const c = store.get().concepts[q.concept] || { correct: 0, wrong: 0 };
          store.update((s) => { s.concepts[q.concept] = { correct: c.correct + (correct ? 1 : 0), wrong: c.wrong + (correct ? 0 : 1), lastAt: Date.now() }; }, 'assessment-answer');
          $('[data-next]', view).disabled = false;
          $('[data-next]', view).focus();
        },
      });
      $('[data-next]', view).addEventListener('click', () => { if (i < Q.length - 1) { i++; question(); } else results(true); });
      $('[data-quit]', view).addEventListener('click', intro);
    }

    function results(save) {
      const score = Q.filter((q) => answers[q.id] === q.answer).length;
      const wrong = Q.filter((q) => answers[q.id] !== undefined && answers[q.id] !== q.answer);
      const weak = [...new Set(wrong.map((q) => q.concept))];
      if (save) store.set('assessment', { at: Date.now(), answers, score, total: Q.length, weak });
      const recs = [...new Set(weak.map((c) => MV.data.concepts[c].lesson))].map((k) => MV.catalog.lesson(k)).filter(Boolean);
      const pct = score / Q.length;
      view.innerHTML = `<div class="page" style="max-width:900px">
        <div class="card card-pad flex flex-wrap items-center gap-5">${ring(pct, 96, 7)}<div class="flex-1 min-w-[220px]"><div class="eyebrow">Your result</div><div class="dash-title" style="font-size:30px;margin-top:4px">${score} / ${Q.length}</div>
          <p class="text-[14px] text-fg2 mt-1">${pct >= 0.85 ? 'Excellent — you reason about distributed systems like a production engineer. Try the advanced challenges.' : pct >= 0.6 ? 'Solid foundation. Review the recommended lessons below to close the gaps.' : 'A good start. Work through the recommended lessons, then retake the check.'}</p></div>
          <div class="flex flex-col gap-2"><button class="btn btn-primary" type="button" data-retake>${icon('rotate-ccw')}Retake</button><a class="btn" href="#/progress?tab=concepts">${icon('brain')}Concept mastery</a></div></div>
        <section class="section"><div class="section-head"><h2 class="section-title">What to study next</h2></div>
          ${recs.length ? `<div class="grid-auto">${recs.map((l) => `<a class="card card-link spotlight card-pad" href="${l.route}"><div class="eyebrow">${esc(l.module.nav)}</div><div class="font-semibold mt-1" style="color:var(--fg)">${esc(l.title)}</div><p class="text-[13px] text-fg2 mt-1">${esc(l.summary)}</p><div class="text-[12px] text-mutedc mt-2">${l.minutes} min · ${store.isLessonDone(l.key) ? 'completed — worth a re-read' : 'not completed yet'}</div></a>`).join('')}</div>` : `<div class="empty">${icon('trophy')}<strong>Nothing to review</strong><span>You answered every question correctly.</span><a class="btn btn-sm mt-1" href="#/challenges">Advanced challenges</a></div>`}
        </section>
        <section class="section"><div class="section-head"><h2 class="section-title">Answers</h2></div>
          <div class="grid gap-2">${Q.map((q) => { const a = answers[q.id]; const ok = a === q.answer; return `<details class="details"><summary>${icon('chevron-right', 'chev')}<span class="pill ${a === undefined ? 'is-muted' : ok ? 'is-ok' : 'is-err'}">${icon(a === undefined ? 'minus' : ok ? 'check' : 'x')}</span><span class="flex-1 min-w-0">${inlineMd(q.question)}</span></summary><div class="details-body text-[13.5px] text-fg2"><p>Your answer: <strong style="color:var(--fg)">${a === undefined ? '—' : inlineMd(q.options[a])}</strong></p><p>Correct: <strong style="color:var(--green)">${inlineMd(q.options[q.answer])}</strong></p><p>${inlineMd(q.explain)}</p><p><a href="${MV.catalog.lesson(MV.data.concepts[q.concept].lesson).route}">Lesson: ${esc(MV.catalog.lesson(MV.data.concepts[q.concept].lesson).title)}</a></p></div></details>`; }).join('')}</div>
        </section></div>`;
      $('[data-retake]', view).addEventListener('click', () => { i = 0; answers = {}; question(); });
      if (save) toast('Knowledge check saved', { type: 'success', desc: `${score}/${Q.length} · ${weak.length} concept${weak.length === 1 ? '' : 's'} to review` });
    }
    intro();
  }

  MV.progress = { renderDashboard, renderProgress, renderAssessment, nextLesson, knowledge, exportProgress, recommendations };
})(window.MV);
