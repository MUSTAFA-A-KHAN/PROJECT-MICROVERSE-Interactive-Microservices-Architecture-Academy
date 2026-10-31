/* ==========================================================================
   Microverse — knowledge checks.
   Used by lessons (inline :::quiz blocks), bootcamp sessions and the
   assessment. Answers are recorded per quiz and per concept so the progress
   page can surface weak areas and recommend lessons.
   ========================================================================== */
window.MV = window.MV || {};

(function (MV) {
  'use strict';
  const { esc, icon, inlineMd, $, $$ } = MV.ui;
  const KEYS = 'ABCDEFGH';

  function conceptLabel(id) {
    return (MV.data.concepts && MV.data.concepts[id] && MV.data.concepts[id].label) || id;
  }

  /**
   * Shuffle a question's options in place, deterministically (seeded by the
   * question text), so the correct answer's position can't be guessed but
   * stays stable across visits — saved answers keep pointing at the same option.
   */
  function shuffle(q) {
    if (q._shuffled) return q;
    let h = 2166136261;
    for (const ch of q.question) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    const perm = q.options.map((_, i) => i);
    for (let i = perm.length - 1; i > 0; i--) {
      h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0;
      const j = h % (i + 1);
      [perm[i], perm[j]] = [perm[j], perm[i]];
    }
    q.options = perm.map((k) => q.options[k]);
    q.answer = perm.indexOf(q.answer);
    q._shuffled = true;
    return q;
  }

  /** Markup for one question. `index` identifies it within its quiz. */
  function html(q, index, opts = {}) {
    shuffle(q);
    const label = opts.label || 'Check your understanding';
    return `<div class="quiz" data-quiz-index="${index}" data-concept="${esc(q.concept || '')}">
      <div class="quiz-head">
        <span class="badge badge-blue">${icon('brain')}${esc(label)}</span>
        ${q.concept ? `<span class="text-xs text-mutedc">${esc(conceptLabel(q.concept))}</span>` : ''}
        <button type="button" class="btn btn-ghost btn-sm ml-auto" data-quiz-reset hidden>${icon('rotate-ccw')}Try again</button>
      </div>
      <div class="quiz-q">${inlineMd(q.question)}</div>
      <div class="quiz-options" role="group" aria-label="Answer options">
        ${q.options.map((o, i) => `<button type="button" class="quiz-option" data-opt="${i}"><span class="opt-key">${KEYS[i]}</span><span>${inlineMd(o)}</span></button>`).join('')}
      </div>
      <div class="quiz-explain" hidden aria-live="polite"></div>
    </div>`;
  }

  function showResult(el, q, chosen) {
    const correct = chosen === q.answer;
    $$('.quiz-option', el).forEach((b, i) => {
      b.disabled = true;
      b.classList.toggle('is-correct', i === q.answer);
      b.classList.toggle('is-wrong', i === chosen && !correct);
      b.setAttribute('aria-pressed', i === chosen ? 'true' : 'false');
    });
    const ex = $('.quiz-explain', el);
    ex.hidden = false;
    ex.innerHTML = `<strong>${correct ? 'Correct.' : `Not quite — the answer is ${KEYS[q.answer]}.`}</strong> ${inlineMd(q.explain || '')}`;
    $('[data-quiz-reset]', el).hidden = false;
  }

  function resetView(el) {
    $$('.quiz-option', el).forEach((b) => { b.disabled = false; b.classList.remove('is-correct', 'is-wrong'); b.removeAttribute('aria-pressed'); });
    const ex = $('.quiz-explain', el);
    ex.hidden = true; ex.innerHTML = '';
    $('[data-quiz-reset]', el).hidden = true;
  }

  /**
   * Wire up every .quiz inside root.
   * quizId: storage key; questions: array matching data-quiz-index.
   */
  function bind(root, quizId, questions, { onAnswer, record = true } = {}) {
    const saved = (MV.store.get().quizzes[quizId] || {}).answers || {};
    $$('.quiz', root).forEach((el) => {
      const idx = +el.getAttribute('data-quiz-index');
      const q = questions[idx];
      if (!q) return;
      if (saved[idx]) showResult(el, q, saved[idx].chosen);
      el.addEventListener('click', (e) => {
        const opt = e.target.closest('.quiz-option');
        if (opt && !opt.disabled) {
          const chosen = +opt.getAttribute('data-opt');
          const correct = chosen === q.answer;
          showResult(el, q, chosen);
          if (!correct) el.classList.add('anim-shake');
          setTimeout(() => el.classList.remove('anim-shake'), 500);
          if (record) MV.store.recordAnswer(quizId, idx, chosen, correct, q.concept);
          onAnswer && onAnswer({ idx, chosen, correct });
          return;
        }
        if (e.target.closest('[data-quiz-reset]')) {
          resetView(el);
          $('.quiz-option', el).focus();
        }
      });
    });
  }

  MV.quiz = { html, bind, conceptLabel, shuffle };
})(window.MV);
