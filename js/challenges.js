/* ==========================================================================
   Microverse — scenario-based engineering challenges.
   Flow: problem → architecture → your proposal (rubric self-check) →
   candidate approaches (verdicts) → engineering approach, Go code, trade-offs.
   ========================================================================== */
window.MV = window.MV || {};

(function (MV) {
  'use strict';
  const { $, $$, esc, icon, toast, inlineMd } = MV.ui;
  const store = MV.store;
  const LEVEL_CLS = { Beginner: 'badge-green', Intermediate: 'badge-warn', Advanced: 'badge-err' };
  const VERDICT = { best: ['is-ok', 'circle-check', 'Strong approach'], partial: ['is-warn', 'circle-alert', 'Partial'], poor: ['is-err', 'circle-x', 'Risky'] };

  function status(id) {
    const c = store.get().challenges[id];
    if (!c) return { label: 'New', cls: 'badge-muted', ic: 'circle-dashed' };
    if (c.solved) return { label: 'Solved', cls: 'badge-green', ic: 'circle-check' };
    return { label: 'In progress', cls: 'badge-blue', ic: 'circle-play' };
  }

  function splitSolutions(text) {
    const map = new Map();
    text.replace(/\r\n?/g, '\n').split(/^@@challenge\s+/m).slice(1).forEach((p) => {
      const nl = p.indexOf('\n');
      map.set(p.slice(0, nl).trim(), p.slice(nl + 1));
    });
    return map;
  }

  /* ---------- List ---------- */
  function renderList(view, query) {
    MV.shell.setCrumbs([{ label: 'Practice', href: '#/challenges' }, { label: 'Engineering challenges' }]);
    const all = MV.data.challenges;
    const solved = all.filter((c) => store.get().challenges[c.id] && store.get().challenges[c.id].solved).length;
    let level = query.level || 'All';
    view.innerHTML = `<div class="page">
      <div class="page-head"><div><div class="eyebrow">Practice</div><h1 class="page-title mt-1">Engineering challenges</h1>
        <p class="page-sub">Realistic incidents and design problems from the Order Management System. Propose a solution in your own words, compare approaches, then study the engineering answer with Go code and trade-offs.</p></div>
        <div class="card card-pad flex items-center gap-4" style="padding:14px 18px">${MV.ui.ring(solved / all.length, 44, 4)}<div><div class="stat-value" style="font-size:22px">${solved}/${all.length}</div><div class="stat-sub">solved</div></div></div></div>
      <div class="flex flex-wrap items-center gap-3 mb-4"><div class="segmented" role="group" aria-label="Difficulty">${['All', ...MV.data.challengeLevels].map((l) => `<button type="button" data-level="${l}" aria-pressed="${l === level}">${l}</button>`).join('')}</div>
        <span class="text-[12.5px] text-mutedc">Beginner → Intermediate → Advanced</span></div>
      <div class="grid-auto" data-cards></div></div>`;
    const draw = () => {
      $('[data-cards]', view).innerHTML = all.filter((c) => level === 'All' || c.level === level).map((c) => {
        const st = status(c.id);
        return `<a class="card card-link spotlight card-pad grid gap-3 content-start" href="#/challenge/${c.id}" data-reveal>
          <div class="flex items-center gap-2"><span class="badge badge-square ${LEVEL_CLS[c.level]}">${c.level}</span><span class="text-[12px] text-mutedc flex items-center gap-1">${icon('clock', '', 12)}${c.minutes} min</span><span class="badge ${st.cls} ml-auto">${icon(st.ic)}${st.label}</span></div>
          <div><div class="font-semibold text-[15px]" style="color:var(--fg)">${esc(c.title)}</div><p class="text-[13px] text-fg2 mt-1">${esc(c.tagline)}</p></div>
          <div class="flex flex-wrap gap-1.5">${c.concepts.slice(0, 3).map((k) => `<span class="chip" style="height:22px;font-size:11px">${esc(MV.quiz.conceptLabel(k))}</span>`).join('')}</div>
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
  }

  /* ---------- Detail ---------- */
  async function renderDetail(view, { id }, query, nav) {
    const c = MV.data.challenges.find((x) => x.id === id);
    if (!c) { view.innerHTML = `<div class="page"><div class="empty">${icon('map-pin-off')}<strong>Challenge not found</strong><a class="btn mt-2" href="#/challenges">All challenges</a></div></div>`; return; }
    MV.shell.setCrumbs([{ label: 'Challenges', href: '#/challenges' }, { label: c.title }]);
    store.pushRecent({ route: `#/challenge/${c.id}`, title: c.title, kind: 'Challenge' });
    const saved = store.get().challenges[c.id] || {};
    const idx = MV.data.challenges.indexOf(c);
    const next = MV.data.challenges[idx + 1];

    view.innerHTML = `<div class="page" style="max-width:1080px">
      <header class="mb-6">
        <div class="flex flex-wrap items-center gap-2"><span class="badge badge-square ${LEVEL_CLS[c.level]}">${c.level}</span><span class="text-[12.5px] text-mutedc flex items-center gap-1">${icon('clock', '', 13)}${c.minutes} min</span>
          ${c.concepts.map((k) => `<a class="chip" href="${MV.catalog.lesson(MV.data.concepts[k].lesson).route}" style="height:22px;font-size:11px">${icon('book-open')}${esc(MV.quiz.conceptLabel(k))}</a>`).join('')}
          <button class="btn btn-sm ml-auto" type="button" data-bm>${icon(store.isBookmarked('challenge:' + c.id) ? 'bookmark-check' : 'bookmark')}${store.isBookmarked('challenge:' + c.id) ? 'Saved' : 'Save'}</button></div>
        <h1 class="lesson-title">${esc(c.title)}</h1>
        <p class="page-sub">${esc(c.tagline)}</p>
      </header>

      <ol class="ch-flow">
        <li class="ch-step"><div class="ch-step-head"><span class="ch-num">1</span><h2>The business problem</h2></div>
          <div class="prose"><p>${inlineMd(c.problem)}</p></div>
          <div class="well mt-3"><div class="eyebrow mb-2">Facts</div><ul class="ch-facts">${c.context.map((f) => `<li>${icon('dot', '', 14)}<span>${inlineMd(f)}</span></li>`).join('')}</ul></div>
        </li>
        <li class="ch-step"><div class="ch-step-head"><span class="ch-num">2</span><h2>The architecture</h2></div><div data-diagram-host></div></li>
        <li class="ch-step"><div class="ch-step-head"><span class="ch-num">3</span><h2>Your proposal</h2></div>
          <p class="text-[13.5px] text-fg2 mb-2">How would you handle this? Write it as you would in a design review: what you'd change, in which component, and why.</p>
          <label class="sr-only" for="ch-answer">Your proposal</label>
          <textarea class="textarea" id="ch-answer" rows="6" placeholder="e.g. Add … in Order Service so that … because …">${esc(saved.answer || '')}</textarea>
          <div class="flex flex-wrap items-center gap-2 mt-2"><button class="btn btn-primary" type="button" data-eval>${icon('sparkles')}Evaluate my answer</button><span class="text-[12px] text-mutedc">Saved automatically</span></div>
          <div data-eval-out class="mt-3"></div>
        </li>
        <li class="ch-step"><div class="ch-step-head"><span class="ch-num">4</span><h2>Which approach would you ship?</h2></div>
          <div class="grid gap-2" data-approaches role="radiogroup" aria-label="Approaches">${c.approaches.map((a, i) => `<button type="button" class="ch-appr" role="radio" aria-checked="false" data-appr="${i}"><span class="opt-key">${'ABCD'[i]}</span><span class="flex-1 text-left">${inlineMd(a.text)}</span></button>`).join('')}</div>
        </li>
        <li class="ch-step"><div class="ch-step-head"><span class="ch-num">5</span><h2>The engineering approach</h2></div><div data-solution></div></li>
      </ol>
      <div class="flex flex-wrap items-center justify-between gap-3 mt-8">
        <a class="btn" href="#/challenges">${icon('arrow-left')}All challenges</a>
        ${next ? `<a class="btn btn-primary" href="#/challenge/${next.id}">Next: ${esc(next.title)}${icon('arrow-right')}</a>` : `<a class="btn btn-primary" href="#/assessment">Take the knowledge check${icon('arrow-right')}</a>`}
      </div>
    </div>`;

    // Diagram
    const host = $('[data-diagram-host]', view);
    const wt = MV.diagram.walkthrough(host, MV.data.diagrams[c.diagram], {});
    MV.router.onLeave(() => wt.destroy());

    // Proposal autosave
    const ta = $('#ch-answer', view);
    let saveT;
    ta.addEventListener('input', () => { clearTimeout(saveT); saveT = setTimeout(() => store.recordChallenge(c.id, { answer: ta.value }), 500); });

    // Evaluation
    const evaluate = () => {
      const text = ta.value.toLowerCase();
      if (text.trim().length < 25) {
        $('[data-eval-out]', view).innerHTML = `<div class="wg-note is-warn">Write a few sentences first — at least what you would change and why.</div>`;
        return;
      }
      const res = c.rubric.map((g) => ({ ...g, hit: g.words.some((w) => text.includes(w)) }));
      const score = Math.round((res.filter((r) => r.hit).length / res.length) * 100);
      store.recordChallenge(c.id, { answer: ta.value, rubricScore: score, countAttempt: true });
      $('[data-eval-out]', view).innerHTML = `<div class="card card-pad">
        <div class="flex items-center gap-3 mb-3">${MV.ui.ring(score / 100, 40, 4)}<div><div class="font-semibold" style="color:var(--fg)">You covered ${res.filter((r) => r.hit).length} of ${res.length} key points</div><div class="text-[12px] text-mutedc">Keyword-based self-check — use the engineering approach below as the reference answer.</div></div></div>
        <ul class="ch-rubric">${res.map((r) => `<li class="${r.hit ? 'is-hit' : ''}">${icon(r.hit ? 'circle-check' : 'circle', '', 15)}<span>${esc(r.label)}</span></li>`).join('')}</ul></div>`;
      revealSolution();
    };
    $('[data-eval]', view).addEventListener('click', evaluate);

    // Approaches
    const showVerdicts = (chosen) => {
      $$('[data-appr]', view).forEach((b) => {
        const i = +b.dataset.appr;
        const a = c.approaches[i];
        const [cls, ic, label] = VERDICT[a.verdict];
        b.setAttribute('aria-checked', String(i === chosen));
        b.classList.add('is-revealed');
        b.classList.toggle('is-chosen', i === chosen);
        b.dataset.verdict = a.verdict;
        if (!$('.ch-verdict', b)) b.insertAdjacentHTML('beforeend', `<div class="ch-verdict"><span class="pill ${cls}">${icon(ic)}${label}</span><span>${inlineMd(a.why)}</span></div>`);
      });
    };
    $('[data-approaches]', view).addEventListener('click', (e) => {
      const b = e.target.closest('[data-appr]');
      if (!b) return;
      const i = +b.dataset.appr;
      const correct = c.approaches[i].verdict === 'best';
      showVerdicts(i);
      const wasSolved = (store.get().challenges[c.id] || {}).solved;
      store.recordChallenge(c.id, { chosen: i, correct, solved: wasSolved || correct, countAttempt: true });
      if (correct && !wasSolved) toast('Challenge solved', { type: 'success', desc: c.title });
      else if (!correct) toast('Not the strongest option', { type: 'warn', desc: 'Read why, then compare with the engineering approach.' });
      revealSolution();
    });
    if (saved.chosen !== undefined) showVerdicts(saved.chosen);

    $('[data-bm]', view).addEventListener('click', (e) => {
      const added = store.toggleBookmark({ key: 'challenge:' + c.id, title: c.title, route: `#/challenge/${c.id}`, kind: 'challenge' });
      e.currentTarget.innerHTML = `${icon(added ? 'bookmark-check' : 'bookmark')}${added ? 'Saved' : 'Save'}`;
    });

    // Solution (locked until the learner commits to an answer)
    const solEl = $('[data-solution]', view);
    let revealed = false;
    async function revealSolution() {
      if (revealed) return;
      revealed = true;
      solEl.innerHTML = MV.ui.skeleton(6);
      try {
        const text = await MV.ui.fetchText('content/challenges.md');
        if (!MV.router.isCurrent(nav.token)) return;
        const src = splitSolutions(text).get(c.id) || '_Solution not found._';
        const ctx = {};
        solEl.innerHTML = `<div class="prose">${MV.md.render(src, ctx)}</div>`;
        MV.lessons.mountEmbeds(solEl);
        if (window.Motion && !MV.reducedMotion) Motion.animate(solEl, { opacity: [0, 1], transform: ['translateY(8px)', 'none'] }, { duration: 0.35 });
      } catch (err) {
        solEl.innerHTML = MV.ui.loadError(err);
      }
    }
    if (saved.rubricScore !== undefined || saved.chosen !== undefined) revealSolution();
    else solEl.innerHTML = `<div class="empty">${icon('lock')}<strong>Commit to an answer first</strong><span>Evaluate your proposal or choose an approach to unlock the engineering answer — committing first is what makes it stick.</span><button class="btn btn-sm mt-1" type="button" data-peek>${icon('eye')}Reveal anyway</button></div>`;
    const peek = $('[data-peek]', view);
    if (peek) peek.addEventListener('click', () => { store.recordChallenge(c.id, { peeked: true }); revealSolution(); });
  }

  MV.challenges = { renderList, renderDetail, status };
})(window.MV);
