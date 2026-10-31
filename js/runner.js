/* ==========================================================================
   Microverse — where Go code runs. Every backend really executes the code:
     browser     the in-browser engine (js/gowasm.js): a Go interpreter
                 compiled to WebAssembly. Needs no server, so it works on
                 static hosting such as GitHub Pages.
     local       the Go toolchain on this machine, through the dev server
                 (tools/serve.mjs): the real gc compiler.
     playground  the official Go Playground at go.dev, through the dev server
                 (go.dev doesn't allow browsers to call it directly).
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
      const browser = { available: !!(MV.gowasm && MV.gowasm.supported()) };
      const base = { browser, local: { available: false }, playground: { available: false } };
      if (location.protocol === 'file:') return { ...base, api: false, reason: 'file' };
      // The dev server only offers its API on loopback, so don't probe (and
      // log a 404) on static hosting such as GitHub Pages.
      if (!['localhost', '127.0.0.1', '[::1]'].includes(location.hostname)) return { ...base, api: false, reason: 'static' };
      try {
        const res = await fetch('api/go/info', { cache: 'no-store' });
        if (!res.ok) return { ...base, api: false, reason: 'static' };
        const j = await res.json();
        if (!j.apiEnabled) return { ...base, api: false, reason: 'remote' };
        return { ...base, api: true, local: j.local || { available: false }, playground: j.playground || { available: false } };
      } catch (e) {
        return { ...base, api: false, reason: 'static' };
      }
    })();
    return infoPromise;
  }

  /** True when at least one backend can run code. */
  const canRun = (inf) => !!(inf && (inf.browser.available || inf.local.available || inf.playground.available));

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
  const available = (inf, b) => !!(inf && inf[b] && inf[b].available);
  /** The learner's last choice if still available; otherwise the real compiler when present, else the browser engine. */
  function preferredBackend(inf) {
    let pref = null;
    try { pref = localStorage.getItem(KEY); } catch (_) { /* storage blocked */ }
    if (pref && available(inf, pref)) return pref;
    if (available(inf, 'local')) return 'local';
    if (available(inf, 'browser')) return 'browser';
    return 'playground';
  }
  function setBackend(b) { try { localStorage.setItem(KEY, b); } catch (_) { /* storage blocked */ } }

  /** Compile and run a set of files: { 'main.go': src, ... }. */
  async function run(files, backend) {
    if (backend !== 'browser') return post('api/go/run', { files, backend });
    const [r, m] = await Promise.all([MV.gowasm.run(files), MV.gowasm.info()]);
    return { backend: 'browser', goVersion: `Yaegi ${m.yaegi}`, ok: r.exitCode === 0 && !r.timedOut, ...r };
  }

  async function fmt(code, backend) {
    if (backend !== 'browser') return post('api/go/fmt', { code, backend });
    return MV.gowasm.fmt(code);
  }

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

  /** gofmt reports "line:12:5: msg" (local and browser) or "prog.go:12:5: msg" (go.dev). */
  function parseFmtError(text) {
    const m = String(text || '').match(/(?:line|prog\.go|<standard input>|[\w.]+\.go):(\d+):(\d+):\s*(.+)/);
    return m ? { line: +m[1], col: +m[2], message: m[3].trim() } : null;
  }

  /** Program output without the test protocol lines (what the learner printed). */
  function userOutput(stdout) {
    return String(stdout || '').split('\n').filter((l) => !/^(PASS {2}|FAIL {2}|RESULT \d)/.test(l)).join('\n').trim();
  }

  MV.runner = { info, canRun, run, fmt, checkService, parseTests, testNames, parseFmtError, userOutput, preferredBackend, setBackend };
})(window.MV);
