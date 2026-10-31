/* ==========================================================================
   Microverse — the in-browser Go engine (no server needed).
   Loads assets/go/runner.wasm.gz once, compiles it, and runs each job in a
   fresh Web Worker (js/goworker.js). The runner is a Go interpreter (Yaegi)
   plus the go/types checker and gofmt, built by tools/build-wasm.mjs.
   ========================================================================== */
window.MV = window.MV || {};

(function (MV) {
  'use strict';

  const BASE = 'assets/go/';
  let manifest = null;
  let modulePromise = null;
  let spare = null; // a worker already instantiated, waiting for its job
  const listeners = new Set();
  let state = { status: 'idle', loaded: 0, total: 0, error: null };

  function setState(patch) {
    state = { ...state, ...patch };
    listeners.forEach((fn) => { try { fn(state); } catch (_) { /* listener failed */ } });
  }

  const supported = () => typeof WebAssembly === 'object' && typeof Worker === 'function' && typeof DecompressionStream === 'function' && location.protocol !== 'file:';

  async function info() {
    if (!manifest) {
      const res = await fetch(BASE + 'runner.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`Go engine manifest missing (${res.status})`);
      manifest = await res.json();
    }
    return manifest;
  }

  /** Download (with progress), decompress and compile the runner. Cached. */
  function load() {
    if (modulePromise) return modulePromise;
    modulePromise = (async () => {
      const m = await info();
      setState({ status: 'loading', loaded: 0, total: m.gzBytes, error: null });
      const res = await fetch(`${BASE}runner.wasm.gz?v=${m.hash}`);
      if (!res.ok) throw new Error(`Couldn't download the Go engine (${res.status})`);
      const reader = res.body.getReader();
      const chunks = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        setState({ loaded });
      }
      const blob = new Blob(chunks);
      const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
      // A host may already have decoded the gzip (Content-Encoding); check the magic bytes.
      const bytes = head[0] === 0x1f && head[1] === 0x8b
        ? await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
        : await blob.arrayBuffer();
      setState({ status: 'compiling' });
      const mod = await WebAssembly.compile(bytes);
      setState({ status: 'ready' });
      return mod;
    })().catch((err) => {
      modulePromise = null;
      setState({ status: 'error', error: err.message || String(err) });
      throw err;
    });
    return modulePromise;
  }

  function spawn(mod) {
    const worker = new Worker('js/goworker.js');
    const ready = new Promise((resolve, reject) => {
      worker.onmessage = (e) => { if (e.data.type === 'ready') resolve(); else if (e.data.type === 'crash') reject(new Error(e.data.message)); };
      worker.onerror = (e) => reject(new Error(e.message || 'The Go engine worker failed to start'));
    });
    worker.postMessage({ type: 'init', module: mod });
    return { worker, ready };
  }

  async function takeWorker() {
    const mod = await load();
    const w = spare || spawn(mod);
    spare = null;
    await w.ready;
    // Warm the next one while this job runs, so the following Run starts instantly.
    setTimeout(() => { if (!spare) spare = spawn(mod); }, 0);
    return w.worker;
  }

  /**
   * Run one job. mode 'run' → { phase, stdout, stderr, exitCode, timedOut, buildMs, runMs };
   * modes 'fmt' and 'syntax' → { result }.
   */
  async function exec(job, { timeoutMs = 15000 } = {}) {
    const worker = await takeWorker();
    return new Promise((resolve) => {
      const t0 = performance.now();
      let tRun = null;
      let stdout = '', stderr = '', result = null, settled = false;
      const finish = (extra) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        worker.terminate();
        const end = performance.now();
        resolve({ phase: tRun ? 'run' : 'build', stdout, stderr: tidyStderr(stderr), result, buildMs: Math.round((tRun || end) - t0), runMs: tRun ? Math.round(end - tRun) : 0, ...extra });
      };
      const timer = setTimeout(() => finish({ exitCode: -1, timedOut: true, stderr: tidyStderr(stderr) + '\nprogram stopped: exceeded the 15 s time limit (infinite loop or deadlock?)\n' }), timeoutMs);
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'out') { if (m.fd === 2) stderr += m.text; else stdout += m.text; }
        else if (m.type === 'event') {
          if (m.kind === 'phase' && m.data === 'run') tRun = performance.now();
          if (m.kind === 'result') result = m.data;
        } else if (m.type === 'exit') finish({ exitCode: m.code, timedOut: false });
        else if (m.type === 'crash') finish({ exitCode: 2, timedOut: false, stderr: tidyStderr(stderr) + '\n' + m.message });
      };
      worker.onerror = (e) => finish({ exitCode: 2, timedOut: false, stderr: tidyStderr(stderr) + '\n' + (e.message || 'engine error') });
      worker.postMessage({ type: 'job', job });
    });
  }

  /**
   * A goroutine that panics without recovering takes the whole engine down,
   * and the Go runtime prints the interpreter's internal stack. Keep the
   * panic message and drop the engine frames.
   */
  function tidyStderr(text) {
    if (!/\ngoroutine \d+ \[/.test(text) || !/traefik\/yaegi|syscall\/js|runtime\.goexit/.test(text)) return text;
    const lines = text.split('\n');
    const keep = [];
    for (const l of lines) {
      if (/^goroutine \d+ \[/.test(l)) break;
      keep.push(l);
    }
    return keep.join('\n').trimEnd() + '\n\n(a goroutine panicked; the interpreter\'s internal stack trace is hidden)\n';
  }

  MV.gowasm = {
    supported,
    info,
    load,
    state: () => state,
    onState(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    run: (files) => exec({ mode: 'run', files }),
    async fmt(code) {
      const r = await exec({ mode: 'fmt', src: code }, { timeoutMs: 10000 });
      if (!r.result) throw new Error(r.stderr || 'format failed');
      return r.result;
    },
    async syntax(name, src) {
      const r = await exec({ mode: 'syntax', name, src }, { timeoutMs: 10000 });
      return (r.result && r.result.diags) || [];
    },
  };
})(window.MV);
