/* ==========================================================================
   Microverse — the guided three-hour bootcamp.
   ========================================================================== */
window.MV = window.MV || {};

(function (MV) {
  'use strict';
  const { $, $$, esc, icon, toast, inlineMd } = MV.ui;
  const store = MV.store;
  const STEPS = [
    ['objectives', 'Learning objectives', 2, 'target'],
    ['explain', 'Interactive explanation', 12, 'mouse-pointer-click'],
    ['diagram', 'Architecture diagram', 4, 'workflow'],
    ['code', 'Code walkthrough', 5, 'file-code-2'],
    ['challenge', 'Practical challenge', 5, 'swords'],
    ['quiz', 'Quiz', 2, 'brain'],
  ];

  function sessionState(id) { return store.get().bootcamp[id] || { steps: {} }; }
  function stepsDone(id) { const s = sessionState(id); return STEPS.filter(([k]) => s.steps[k]).length; }
  function isDone(id) { return !!sessionState(id).completedAt; }
  function nextSession() { return MV.data.bootcamp.find((s) => !isDone(s.id)) || null; }

  /* ---------- Learning path overview ---------- */
  function renderPath(view) {
    MV.shell.setCrumbs([{ label: 'Learn', href: '#/' }, { label: 'Learning path' }]);
    const sessions = MV.data.bootcamp;
    const done = sessions.filter((s) => isDone(s.id)).length;
    const nxt = nextSession();
    view.innerHTML = `<div class="page">
      <header class="card module-hero mb-6" data-reveal><div class="hero-aurora"></div>
        <div class="relative flex flex-wrap items-center gap-6 p-6">
          <div class="flex-1 min-w-[260px]"><div class="eyebrow">Guided bootcamp · 6 × 30 minutes</div>
            <h1 class="page-title mt-1">From monolith to production in three hours</h1>
            <p class="page-sub">Each session combines a short interactive explanation, an architecture walkthrough, real Go code from the Order Management System, a practical challenge and a quiz. Sessions can be revisited in any order.</p>
            <div class="flex flex-wrap gap-2 mt-4">${nxt ? `<a class="btn btn-primary" href="#/bootcamp/${nxt.id}">${icon(done ? 'circle-play' : 'play')}${done ? 'Continue' : 'Start'}: Session ${nxt.num}</a>` : `<a class="btn btn-primary" href="#/assessment">${icon('clipboard-check')}Take the knowledge check</a>`}<a class="btn" href="#/modules">${icon('library')}Browse all modules</a></div></div>
          <div class="module-progress">${MV.ui.ring(done / sessions.length, 64, 5)}<div><div class="stat-value">${done}/6</div><div class="stat-sub">sessions complete</div></div></div>
        </div></header>
      <ol class="bc-timeline">${sessions.map((s) => {
        const d = isDone(s.id), n = stepsDone(s.id);
        return `<li class="bc-item${d ? ' is-done' : n ? ' is-started' : ''}" data-reveal>
          <span class="bc-dot">${d ? icon('check', '', 14) : s.num}</span>
          <a class="card card-link spotlight bc-card" href="#/bootcamp/${s.id}">
            <div class="flex items-start gap-3"><span class="icon-tile">${icon(s.icon)}</span>
              <div class="flex-1 min-w-0"><div class="eyebrow">Session ${s.num} · 30 min</div><div class="font-semibold text-[15.5px] mt-0.5" style="color:var(--fg)">${esc(s.title)}</div><p class="text-[13px] text-fg2 mt-1">${esc(s.summary)}</p></div>
              <span class="badge ${d ? 'badge-green' : n ? 'badge-blue' : 'badge-muted'}">${d ? 'Complete' : n ? `${n}/6 steps` : 'Not started'}</span></div>
            <div class="bc-steps">${STEPS.map(([k, label]) => `<span class="bc-step${sessionState(s.id).steps[k] ? ' is-done' : ''}" title="${label}"></span>`).join('')}</div>
          </a></li>`;
      }).join('')}</ol>
      <section class="section"><div class="section-head"><h2 class="section-title">Go deeper: the full modules</h2><a class="text-[13px]" href="#/modules">All modules</a></div>
        <div class="grid-auto">${MV.catalog.modules.slice(0, 6).map((m) => MV.lessons.moduleCard(m)).join('')}</div></section>
    </div>`;
    MV.ui.revealIn(view);
  }

  /* ---------- Session ---------- */
  async function renderSession(view, { id }, query, nav) {
    const s = MV.data.bootcamp.find((x) => x.id === id);
    if (!s) { view.innerHTML = `<div class="page"><div class="empty">${icon('map-pin-off')}<strong>Session not found</strong><a class="btn mt-2" href="#/path">Learning path</a></div></div>`; return; }
    MV.shell.setCrumbs([{ label: 'Learning path', href: '#/path' }, { label: `Session ${s.num}: ${s.title}` }]);
    store.pushRecent({ route: `#/bootcamp/${s.id}`, title: `Session ${s.num}: ${s.title}`, kind: 'Bootcamp' });
    const idx = MV.data.bootcamp.indexOf(s);
    const prev = MV.data.bootcamp[idx - 1], next = MV.data.bootcamp[idx + 1];
    const ch = MV.data.challenges.find((c) => c.id === s.challenge);

    view.innerHTML = `<div class="page" style="max-width:1100px">
      <header class="mb-6"><div class="flex flex-wrap items-center gap-2 text-[12.5px] text-mutedc"><a class="link-muted" href="#/path">Learning path</a><span>·</span><span>Session ${s.num} of 6</span><span>·</span><span class="flex items-center gap-1">${icon('timer', '', 13)}30 minutes</span></div>
        <h1 class="lesson-title">${esc(s.title)}</h1><p class="page-sub">${esc(s.summary)}</p>
        <div class="bc-progress mt-4" data-progress></div></header>
      <ol class="bc-session">${STEPS.map(([k, label, min, ic], i) => `<li class="bc-sstep card" data-step="${k}">
          <div class="bc-sstep-head"><span class="ch-num">${i + 1}</span><span class="icon-tile sm">${icon(ic)}</span><h2>${label}</h2><span class="text-[12px] text-mutedc mono ml-auto">${min} min</span><span data-done-badge></span></div>
          <div class="bc-sstep-body" data-body="${k}"></div></li>`).join('')}</ol>
      <div class="card card-pad mt-6 flex flex-wrap items-center gap-4" data-complete-card></div>
      <div class="lesson-nav card mt-4" style="overflow:hidden">
        ${prev ? `<a class="lesson-nav-link" href="#/bootcamp/${prev.id}"><span class="text-[12px] text-mutedc flex items-center gap-1">${icon('arrow-left', '', 13)}Previous session</span><span>${esc(prev.title)}</span></a>` : '<span></span>'}
        ${next ? `<a class="lesson-nav-link is-next" href="#/bootcamp/${next.id}"><span class="text-[12px] text-mutedc flex items-center gap-1 justify-end">Next session${icon('arrow-right', '', 13)}</span><span>${esc(next.title)}</span></a>` : `<a class="lesson-nav-link is-next" href="#/assessment"><span class="text-[12px] text-mutedc flex items-center gap-1 justify-end">Finished${icon('arrow-right', '', 13)}</span><span>Knowledge check</span></a>`}
      </div></div>`;

    const markBtn = (k) => `<button class="btn btn-sm" type="button" data-mark="${k}">${icon('check')}Mark step done</button>`;
    const body = (k) => $(`[data-body="${k}"]`, view);

    // 1. Objectives
    body('objectives').innerHTML = `<p class="text-[13.5px] text-fg2 mb-2">By the end of this session you will be able to:</p><ul class="outcomes">${s.objectives.map((o) => `<li>${icon('circle-check', '', 15)}<span>${esc(o)}</span></li>`).join('')}</ul><div class="mt-3">${markBtn('objectives')}</div>`;

    // 2. Interactive explanation
    body('explain').innerHTML = `<div class="grid gap-3">${s.widget ? `<div class="widget" data-widget="${s.widget}" data-props="{}"></div>` : `<div class="wg-note">This session's interactive piece is the layered request walkthrough below and the code trace in step 4.</div>${'<div class="diagram-wrap" data-diagram="middleware-chain" data-props="{}"></div>'}`}
      <div class="well"><div class="eyebrow mb-2">Read alongside (open in this tab — your session progress is kept)</div><div class="grid gap-1.5">${s.lessons.map((k) => { const l = MV.catalog.lesson(k); return `<a class="mini-link" href="${l.route}">${MV.lessons.statusIcon(k)}<span class="flex-1 min-w-0 truncate">${esc(l.title)}</span><span class="text-[11px] text-mutedc">${l.minutes} min</span></a>`; }).join('')}</div></div>
      <div>${markBtn('explain')}</div></div>`;

    // 3. Diagram
    body('diagram').innerHTML = `<div class="diagram-wrap" data-diagram="${s.diagram}" data-props="{}"></div><div class="mt-3">${markBtn('diagram')}</div>`;

    // 4. Code
    body('code').innerHTML = `<p class="text-[13.5px] text-fg2 mb-2">${esc(s.code.text)}</p><div data-code>${MV.ui.skeleton(6)}</div>
      <div class="flex flex-wrap gap-2 mt-3"><a class="btn btn-sm" href="#/playground?file=${encodeURIComponent(s.code.file)}">${icon('square-terminal')}Open in Code Playground</a>${s.trace ? `<a class="btn btn-sm" href="#/playground?trace=${s.trace}">${icon('route')}Trace the request across files</a>` : ''}${markBtn('code')}</div>`;

    // 5. Challenge
    const chSt = MV.challenges.status(ch.id);
    body('challenge').innerHTML = `<a class="card card-link card-pad flex flex-wrap items-center gap-3" href="#/challenge/${ch.id}"><span class="icon-tile" style="--c:var(--warn)">${icon('swords')}</span><div class="flex-1 min-w-[220px]"><div class="font-semibold" style="color:var(--fg)">${esc(ch.title)}</div><div class="text-[13px] text-fg2">${esc(ch.tagline)}</div></div><span class="badge ${chSt.cls}">${icon(chSt.ic)}${chSt.label}</span>${icon('arrow-right', '', 16)}</a>
      <p class="text-[12.5px] text-mutedc mt-2">This step completes automatically once you have attempted the challenge (evaluated a proposal or chosen an approach).</p>
      ${s.exercise ? '<div class="mt-4"><div class="eyebrow mb-2">Optional · write the code</div><div data-bc-exercise></div></div>' : ''}`;
    if (s.exercise && MV.widgets.exercise) MV.widgets.exercise($('[data-bc-exercise]', view), { id: s.exercise });

    // 6. Quiz
    body('quiz').innerHTML = `<div class="grid gap-3">${s.quiz.map((q, i) => MV.quiz.html(q, i, { label: `Question ${i + 1} of ${s.quiz.length}` })).join('')}</div><div class="mt-3" data-quiz-score></div>`;

    MV.lessons.mountEmbeds(view);
    const quizId = 'bootcamp:' + s.id;
    const syncQuiz = () => {
      const q = store.get().quizzes[quizId];
      const el = $('[data-quiz-score]', view);
      if (q && q.total >= s.quiz.length) {
        el.innerHTML = `<div class="wg-note ${q.correct >= 4 ? 'is-ok' : 'is-warn'}"><strong>${q.correct}/${s.quiz.length} correct.</strong> ${q.correct >= 4 ? 'Nice work.' : 'Review the explanations above; weak concepts are tracked on your Progress page.'}</div>`;
        if (!sessionState(s.id).steps.quiz) { store.bootcampQuiz(s.id, q.correct, s.quiz.length); store.bootcampStep(s.id, 'quiz'); }
      } else el.innerHTML = `<span class="text-[12.5px] text-mutedc">${q ? q.total : 0} of ${s.quiz.length} answered</span>`;
    };
    MV.quiz.bind(body('quiz'), quizId, s.quiz, { onAnswer: () => { syncQuiz(); refresh(); } });

    // Challenge auto-completion
    const c = store.get().challenges[ch.id];
    if (c && (c.attempts > 0 || c.solved) && !sessionState(s.id).steps.challenge) store.bootcampStep(s.id, 'challenge');

    // Code excerpt
    MV.ui.fetchText(MV.playground.codePath(s.code.file)).then((text) => {
      if (!MV.router.isCurrent(nav.token)) return;
      const lines = text.split('\n');
      const loc = MV.playground.locate(lines, s.code.at) || { start: 1, end: 30 };
      const end = Math.min(loc.end, loc.start + 44);
      $('[data-code]', view).innerHTML = MV.ui.codeBlock(lines.slice(loc.start - 1, end).join('\n'), { lang: s.code.lang || 'go', title: s.code.file, startLine: loc.start, maxHeight: '420px' });
    }).catch((err) => { $('[data-code]', view).innerHTML = MV.ui.loadError(err); });

    function refresh() {
      const st = sessionState(s.id);
      const n = STEPS.filter(([k]) => st.steps[k]).length;
      $('[data-progress]', view).innerHTML = `<div class="flex items-center gap-3"><div class="bar" style="flex:1;max-width:420px"><span style="--v:${(n / 6) * 100}%"></span></div><span class="text-[12.5px] text-fg2 mono">${n}/6 steps</span>${st.completedAt ? `<span class="badge badge-green">${icon('circle-check')}Session complete</span>` : ''}</div>`;
      STEPS.forEach(([k]) => {
        const card = $(`[data-step="${k}"]`, view);
        card.classList.toggle('is-done', !!st.steps[k]);
        $('[data-done-badge]', card).innerHTML = st.steps[k] ? `<span class="badge badge-green">${icon('check')}Done</span>` : '';
        const b = $(`[data-mark="${k}"]`, card);
        if (b) b.innerHTML = st.steps[k] ? `${icon('rotate-ccw')}Mark not done` : `${icon('check')}Mark step done`;
      });
      const all = n === 6;
      $('[data-complete-card]', view).innerHTML = st.completedAt
        ? `<span class="icon-tile" style="--c:var(--green)">${icon('trophy')}</span><div class="flex-1 min-w-[200px]"><div class="font-semibold" style="color:var(--fg)">Session ${s.num} complete</div><div class="text-[13px] text-fg2">${st.quiz ? `Quiz: ${st.quiz.correct}/${st.quiz.total}. ` : ''}You can revisit any step at any time.</div></div>${next ? `<a class="btn btn-primary" href="#/bootcamp/${next.id}">Session ${next.num}: ${esc(next.title)}${icon('arrow-right')}</a>` : `<a class="btn btn-primary" href="#/assessment">Knowledge check${icon('arrow-right')}</a>`}`
        : `<span class="icon-tile">${icon('flag')}</span><div class="flex-1 min-w-[200px]"><div class="font-semibold" style="color:var(--fg)">Complete the session</div><div class="text-[13px] text-fg2">${all ? 'Every step is done.' : `Finish all six steps (${6 - n} left) to complete the session.`}</div></div><button class="btn btn-primary" type="button" data-complete ${all ? '' : 'disabled'}>${icon('check')}Complete session</button>`;
      const cb = $('[data-complete]', view);
      if (cb) cb.addEventListener('click', () => { store.bootcampComplete(s.id); toast(`Session ${s.num} complete`, { type: 'success', desc: next ? `Up next: ${next.title}` : 'You finished the bootcamp.' }); refresh(); });
    }

    view.addEventListener('click', (e) => {
      const b = e.target.closest('[data-mark]');
      if (!b) return;
      const k = b.dataset.mark;
      store.bootcampStep(s.id, k, !sessionState(s.id).steps[k]);
      refresh();
    });
    syncQuiz();
    refresh();
  }

  MV.bootcamp = { renderPath, renderSession, nextSession, isDone, STEPS };
})(window.MV);
