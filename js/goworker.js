/* ==========================================================================
   Microverse — Web Worker that runs one job on the in-browser Go runner.
   The page sends {type:'init', module} (a compiled WebAssembly.Module) and
   then one {type:'job', job}; the worker streams output and reports the exit
   code. Each job gets a fresh worker, so os.Exit, a crash or a runaway
   goroutine can't leak into the next run, and the page can terminate() it.
   ========================================================================== */
/* global Go */
importScripts('../assets/go/wasm_exec.js');

const LIMIT = 128 * 1024;
const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
const pending = { 1: '', 2: '' };
let sent = 0;
let flushTimer = null;
let exitCode = 0;
let go = null;
let instance = null;

function flush() {
  flushTimer = null;
  for (const fd of [1, 2]) {
    if (pending[fd]) {
      postMessage({ type: 'out', fd, text: pending[fd] });
      pending[fd] = '';
    }
  }
}

// Capture what the Go program writes to stdout (fd 1) and stderr (fd 2).
globalThis.fs.writeSync = (fd, buf) => {
  const key = fd === 2 ? 2 : 1;
  const text = decoders[key].decode(buf, { stream: true });
  if (sent < LIMIT) {
    const room = LIMIT - sent;
    pending[key] += text.length > room ? text.slice(0, room) + '\n… output truncated at 128 KB\n' : text;
    sent += Math.min(text.length, room);
  }
  if (!flushTimer) flushTimer = setTimeout(flush, 25);
  return buf.length;
};

globalThis.__mvEvent = (kind, payload) => {
  flush();
  postMessage({ type: 'event', kind, data: JSON.parse(payload) });
};

self.onmessage = async (e) => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      go = new Go();
      go.exit = (code) => { exitCode = code; };
      instance = await WebAssembly.instantiate(m.module, go.importObject);
      postMessage({ type: 'ready' });
    } else if (m.type === 'job') {
      globalThis.__mvJob = JSON.stringify(m.job);
      await go.run(instance);
      flush();
      postMessage({ type: 'exit', code: exitCode });
    }
  } catch (err) {
    flush();
    postMessage({ type: 'crash', message: String(err && err.message || err) });
  }
};
