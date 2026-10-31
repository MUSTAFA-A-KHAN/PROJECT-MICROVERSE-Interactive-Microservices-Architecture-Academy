/* ==========================================================================
   Microverse — persistent learning state.
   Everything the learner does (progress, quiz answers, bookmarks, time spent,
   lab layout) lives in one JSON document in localStorage. Reads and writes
   are wrapped so the app still works in private windows or when storage is
   blocked — progress simply won't survive a reload in that case.
   ========================================================================== */
window.MV = window.MV || {};

(function (MV) {
  'use strict';

  const KEY = 'microverse:state:v1';
  const listeners = new Set();
  let saveTimer = null;
  let storageOk = true;

  function defaults() {
    return {
      version: 1,
      createdAt: Date.now(),
      theme: 'dark',
      sidebarCollapsed: false,
      lessons: {},        // "m01/monolith" -> { status: 'started'|'completed', visitedAt, completedAt }
      quizzes: {},        // quizId -> { correct, total, answers: { qIndex: { chosen, correct } }, at }
      concepts: {},       // conceptId -> { correct, wrong, lastAt }
      challenges: {},     // challengeId -> { attempts, chosen, score, solved, answer, at }
      bootcamp: {},       // sessionId -> { steps: { objectives, explain, diagram, code, challenge, quiz }, quiz: { correct, total }, completedAt }
      bookmarks: [],      // { key, title, route, kind, at }
      recent: [],         // { route, title, kind, at }
      time: { total: 0, byDay: {}, byModule: {} },
      lab: { layout: {}, runs: 0, failuresSeen: {} },
      playground: { tabs: [], active: null },
      assessment: null,   // { at, answers: { qid: chosenIndex }, score, total, weak: [conceptIds] }
      checklists: {},     // lessonKey -> [checked item indexes]
      exercises: {},      // exerciseId -> { code, runs, best: { passed, total }, solved, solvedAt, hints, sawSolution, at }
      drafts: {},         // Code Playground edit mode: 'service/path.go' -> edited source
    };
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return defaults();
      const parsed = JSON.parse(raw);
      return Object.assign(defaults(), parsed);
    } catch (e) {
      storageOk = false;
      return defaults();
    }
  }

  let state = load();

  function persist() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(state));
        storageOk = true;
      } catch (e) {
        storageOk = false;
      }
    }, 120);
  }

  function emit(change) {
    listeners.forEach((fn) => {
      try { fn(state, change); } catch (e) { console.error('[state] listener failed', e); }
    });
  }

  function commit(change) {
    persist();
    emit(change || {});
  }

  const store = {
    get: () => state,
    storageAvailable: () => storageOk,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    set(key, value) {
      state[key] = value;
      commit({ type: key });
    },

    update(fn, type) {
      fn(state);
      commit({ type: type || 'update' });
    },

    /* ----- Lessons ----- */
    lessonKey: (moduleId, lessonId) => `${moduleId}/${lessonId}`,

    visitLesson(key) {
      const l = state.lessons[key] || { status: 'started' };
      l.visitedAt = Date.now();
      state.lessons[key] = l;
      commit({ type: 'lesson', key });
    },

    completeLesson(key, done = true) {
      const l = state.lessons[key] || {};
      l.status = done ? 'completed' : 'started';
      l.completedAt = done ? Date.now() : null;
      l.visitedAt = l.visitedAt || Date.now();
      state.lessons[key] = l;
      commit({ type: 'lesson', key });
    },

    isLessonDone: (key) => state.lessons[key]?.status === 'completed',

    /* ----- Quizzes & concepts ----- */
    recordAnswer(quizId, qIndex, chosen, correct, concept) {
      const q = state.quizzes[quizId] || { answers: {}, correct: 0, total: 0 };
      const first = !(qIndex in q.answers);
      q.answers[qIndex] = { chosen, correct };
      q.correct = Object.values(q.answers).filter((a) => a.correct).length;
      q.total = Object.keys(q.answers).length;
      q.at = Date.now();
      state.quizzes[quizId] = q;
      // Only the first attempt counts toward concept mastery, so re-answering
      // after seeing the explanation doesn't inflate the score.
      if (concept && first) {
        const c = state.concepts[concept] || { correct: 0, wrong: 0 };
        if (correct) c.correct++; else c.wrong++;
        c.lastAt = Date.now();
        state.concepts[concept] = c;
      }
      commit({ type: 'quiz', quizId });
    },

    resetQuiz(quizId) {
      delete state.quizzes[quizId];
      commit({ type: 'quiz', quizId });
    },

    /* ----- Challenges ----- */
    recordChallenge(id, data) {
      const c = state.challenges[id] || { attempts: 0 };
      Object.assign(c, data);
      c.attempts = (c.attempts || 0) + (data.countAttempt ? 1 : 0);
      delete c.countAttempt;
      c.at = Date.now();
      state.challenges[id] = c;
      commit({ type: 'challenge', id });
    },

    /* ----- Coding exercises ----- */
    /** Autosave the learner's code. Persists without notifying listeners (it runs while typing). */
    saveExerciseCode(id, code) {
      const e = state.exercises[id] || { runs: 0 };
      e.code = code;
      e.at = Date.now();
      state.exercises[id] = e;
      persist();
    },
    recordExercise(id, data) {
      const e = state.exercises[id] || { runs: 0 };
      Object.assign(e, data);
      e.at = Date.now();
      state.exercises[id] = e;
      commit({ type: 'exercise', id });
    },
    /** Record a test run; an exercise counts as solved the first time every test passes. */
    recordExerciseRun(id, passed, total) {
      const e = state.exercises[id] || { runs: 0 };
      e.runs = (e.runs || 0) + 1;
      if (total && (!e.best || passed / total >= e.best.passed / e.best.total)) e.best = { passed, total };
      if (total && passed === total && !e.solved) { e.solved = true; e.solvedAt = Date.now(); }
      e.at = Date.now();
      state.exercises[id] = e;
      commit({ type: 'exercise', id });
      return e;
    },
    saveDraft(path, code) {
      if (code == null) delete state.drafts[path]; else state.drafts[path] = code;
      persist();
    },

    /* ----- Bootcamp ----- */
    bootcampStep(sessionId, step, value = true) {
      const s = state.bootcamp[sessionId] || { steps: {} };
      s.steps[step] = value;
      state.bootcamp[sessionId] = s;
      commit({ type: 'bootcamp', sessionId });
    },
    bootcampQuiz(sessionId, correct, total) {
      const s = state.bootcamp[sessionId] || { steps: {} };
      s.quiz = { correct, total, at: Date.now() };
      state.bootcamp[sessionId] = s;
      commit({ type: 'bootcamp', sessionId });
    },
    bootcampComplete(sessionId, done = true) {
      const s = state.bootcamp[sessionId] || { steps: {} };
      s.completedAt = done ? Date.now() : null;
      state.bootcamp[sessionId] = s;
      commit({ type: 'bootcamp', sessionId });
    },

    /* ----- Bookmarks ----- */
    isBookmarked: (key) => state.bookmarks.some((b) => b.key === key),
    toggleBookmark(item) {
      const i = state.bookmarks.findIndex((b) => b.key === item.key);
      let added;
      if (i >= 0) { state.bookmarks.splice(i, 1); added = false; }
      else { state.bookmarks.unshift({ ...item, at: Date.now() }); added = true; }
      commit({ type: 'bookmarks' });
      return added;
    },

    /* ----- Recent ----- */
    pushRecent(entry) {
      if (!entry || !entry.route) return;
      state.recent = state.recent.filter((r) => r.route !== entry.route);
      state.recent.unshift({ ...entry, at: Date.now() });
      state.recent = state.recent.slice(0, 12);
      persist(); // no emit: avoids re-render loops during navigation
    },

    /* ----- Time tracking ----- */
    addTime(seconds, moduleId) {
      const day = new Date().toISOString().slice(0, 10);
      state.time.total += seconds;
      state.time.byDay[day] = (state.time.byDay[day] || 0) + seconds;
      if (moduleId) state.time.byModule[moduleId] = (state.time.byModule[moduleId] || 0) + seconds;
      persist();
      emit({ type: 'time' });
    },

    /* ----- Maintenance ----- */
    exportJSON: () => JSON.stringify(state, null, 2),
    importJSON(text) {
      const parsed = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || parsed.version !== 1) throw new Error('Not a Microverse progress file');
      state = Object.assign(defaults(), parsed);
      commit({ type: 'import' });
    },
    reset() {
      const theme = state.theme;
      state = defaults();
      state.theme = theme;
      commit({ type: 'reset' });
    },
  };

  MV.store = store;
})(window.MV);
