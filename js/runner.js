/* ==========================================================================
   Microverse — client for the local code-execution API (tools/serve.mjs).
   Real execution only: code is compiled by the Go toolchain on this machine,
   or — when the learner picks it — by the official Go Playground at go.dev.
   When the app is served by a plain static server (or opened from file://)
   there is no API, and the Code Lab says so instead of pretending to run.
   ========================================================================== */
window.MV = window.MV || {};

(function (MV) {
  'use strict';

  const HEADERS = { 'Content-Type': 'application/json', 'X-Microverse': '1' };
  let infoPromise = null;

  /** Which backends exist. Cached; pass refresh=true to re-probe. */
  function info(refresh = false) {
    if (infoPromise && !refresh) return infoPromise;
    infoPromise = (async () => {
      if (location.protocol === 'file:') return { api: false, reason: 'file' };
      try {
        const res = await fetch('api/go/info', { cache: 'no-store' });
        if (!res.ok) return { api: false, reason: 'static' };
        const j = await res.json();
        if (!j.apiEnabled) return { api: false, reason: 'remote' };
        return { api: true, local: j.local || { available: false }, playground: j.playground || { available: false } };
      } catch (e) {
        return { api: false, reason: 'static' };
      }
    })();
    return infoPromise;
  }

  async function post(path, body) {
    let res;
    try {
      res = await fetch(path, { method: 'POST', headers: HEADERS, body: JSON.stringify(body) });
    } catch (e) {
      throw new Error('Could not reach the Microverse dev server. Is `npm run dev` still running?');
    }
    let j = null;
    try { j = await res.json(); } catch (_) { /* non-JSON error page */ }
    if (!res.ok) throw new Error((j && j.error) || `HTTP ${res.status}`);
    return j;
  }

  const KEY = 'microverse:backend';
  function preferredBackend(inf) {
    let pref = null;
    try { pref = localStorage.getItem(KEY); } catch (_) { /* storage blocked */ }
    if (pref === 'playground' && inf.playground && inf.playground.available) return 'playground';
    if (inf.local && inf.local.available) return 'local';
    return 'playground';
  }
  function setBackend(b) { try { localStorage.setItem(KEY, b); } catch (_) { /* storage blocked */ } }

  /** Compile and run a set of files: { 'main.go': src, ... }. */
  const run = (files, backend) => post('api/go/run', { files, backend });
  const fmt = (code, backend) => post('api/go/fmt', { code, backend });
  const checkService = (service, edits) => post('api/go/check-service', { service, edits });

  /** Parse the exercise test protocol: PASS name / FAIL name :: msg / RESULT p/t. */
  function parseTests(stdout) {
    const tests = [];
    let result = null;
    for (const line of String(stdout || '').split('\n')) {
      let m;
      if ((m = line.match(/^PASS {2}(.+)$/))) tests.push({ name: m[1].trim(), pass: true });
      else if ((m = line.match(/^FAIL {2}(.+?)(?: :: (.*))?$/))) tests.push({ name: m[1].trim(), pass: false, msg: (m[2] || '').split(' | ').join('\n') });
      else if ((m = line.match(/^RESULT (\d+)\/(\d+)/))) result = { passed: +m[1], total: +m[2] };
    }
    return { tests, result };
  }

  /** Test names, read from the tests source, so the checklist shows before the first run. */
  function testNames(src) {
    const names = [];
    const re = /\{\s*"((?:[^"\\]|\\.)+)",\s*func\s*\(t \*T\)/g;
    let m;
    while ((m = re.exec(src || ''))) names.push(m[1].replace(/\\"/g, '"'));
    return names;
  }

  /** gofmt reports "line:12:5: msg" (local) or "prog.go:12:5: msg" (go.dev). */
  function parseFmtError(text) {
    const m = String(text || '').match(/(?:line|prog\.go|<standard input>|[\w.]+\.go):(\d+):(\d+):\s*(.+)/);
    return m ? { line: +m[1], col: +m[2], message: m[3].trim() } : null;
  }

  /** Program output without the test protocol lines (what the learner printed). */
  function userOutput(stdout) {
    return String(stdout || '').split('\n').filter((l) => !/^(PASS {2}|FAIL {2}|RESULT \d)/.test(l)).join('\n').trim();
  }

  MV.runner = { info, run, fmt, checkService, parseTests, testNames, parseFmtError, userOutput, preferredBackend, setBackend };
})(window.MV);
