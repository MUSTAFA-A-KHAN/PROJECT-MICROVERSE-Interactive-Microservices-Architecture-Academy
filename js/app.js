/* ==========================================================================
   Microverse — application bootstrap.
   ========================================================================== */
(function (MV) {
  'use strict';

  function boot() {
    MV.shell.applyTheme();
    MV.shell.applySidebar();
    document.documentElement.classList.remove('pre-collapsed');
    MV.shell.renderSidebar();
    MV.shell.renderTopbar();
    MV.shell.initLenis();

    if (window.gsap && window.ScrollTrigger) gsap.registerPlugin(ScrollTrigger);

    const r = MV.router;
    r.add('/', (v) => MV.progress.renderDashboard(v), { page: 'dashboard' });
    r.add('/modules', (v) => MV.lessons.renderModules(v), { page: 'modules' });
    r.add('/module/:id', (v, p) => MV.lessons.renderModule(v, p), { page: 'module' });
    r.add('/lesson/:m/:l', (v, p, q, nav) => MV.lessons.renderLesson(v, p, q, nav), { page: 'lesson' });
    r.add('/path', (v) => MV.bootcamp.renderPath(v), { page: 'path' });
    r.add('/bootcamp/:id', (v, p, q, nav) => MV.bootcamp.renderSession(v, p, q, nav), { page: 'bootcamp' });
    r.add('/lab', (v, p, q) => MV.lab.render(v, q), { page: 'lab', full: true });
    r.add('/playground', (v, p, q, nav) => MV.playground.render(v, q, nav), { page: 'playground', full: true });
    r.add('/challenges', (v, p, q) => MV.challenges.renderList(v, q), { page: 'challenges' });
    r.add('/challenge/:id', (v, p, q, nav) => MV.challenges.renderDetail(v, p, q, nav), { page: 'challenge' });
    r.add('/progress', (v, p, q) => MV.progress.renderProgress(v, q), { page: 'progress' });
    r.add('/assessment', (v, p, q) => MV.progress.renderAssessment(v, q), { page: 'assessment' });
    r.start();

    if (!MV.store.storageAvailable()) {
      MV.ui.toast('Progress will not be saved', { type: 'warn', desc: 'Browser storage is unavailable (private mode or blocked site data). Everything works, but progress resets when you reload.', duration: 7000 });
    }
    if (location.protocol === 'file:') {
      MV.ui.toast('Run Microverse from a local server', { type: 'warn', desc: 'Lessons and source files load with fetch(), which browsers block on file:// pages. Run "npm run dev" and open http://localhost:5173.', duration: 9000 });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.MV);
