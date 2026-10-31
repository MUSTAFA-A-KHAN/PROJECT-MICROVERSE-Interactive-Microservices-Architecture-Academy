/**
 * Runs jobs on the in-browser Go runner (assets/go/runner.wasm.gz) under
 * Node, the same way js/goworker.js does in the browser: one fresh worker
 * thread per job, so os.Exit, crashes and runaway programs stay contained.
 *
 *   import { runWasm } from './wasmrun.mjs';
 *   const r = await runWasm({ mode: 'run', files: { 'main.go': src } });
 *   // → { phase, exitCode, stdout, stderr, timedOut, ms }
 */
import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let compiled = null;

function module() {
  if (!compiled) compiled = WebAssembly.compile(gunzipSync(readFileSync(join(root, 'assets', 'go', 'runner.wasm.gz'))));
  return compiled;
}

const WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
require(workerData.wasmExec);
const decoders = { 1: new TextDecoder(), 2: new TextDecoder() };
const out = { 1: '', 2: '' };
globalThis.fs.writeSync = (fd, buf) => { out[fd] = (out[fd] || '') + decoders[fd === 2 ? 2 : 1].decode(buf, { stream: true }); return buf.length; };
const events = [];
globalThis.__mvEvent = (kind, payload) => { events.push([kind, JSON.parse(payload)]); };
globalThis.__mvJob = JSON.stringify(workerData.job);
const go = new Go();
let exitCode = 0;
go.exit = (code) => { exitCode = code; };
WebAssembly.instantiate(workerData.module, go.importObject).then(async (inst) => {
  await go.run(inst);
  parentPort.postMessage({ exitCode, stdout: out[1], stderr: out[2], events });
}).catch((e) => parentPort.postMessage({ exitCode: 2, stdout: out[1], stderr: out[2] + String(e), events }));
`;

export async function runWasm(job, { timeoutMs = 20000 } = {}) {
  const mod = await module();
  const start = Date.now();
  return new Promise((resolve) => {
    const w = new Worker(WORKER, { eval: true, workerData: { job, module: mod, wasmExec: join(root, 'assets', 'go', 'wasm_exec.js') } });
    const timer = setTimeout(() => { w.terminate(); resolve({ phase: 'run', exitCode: -1, stdout: '', stderr: 'timed out', timedOut: true, ms: Date.now() - start }); }, timeoutMs);
    w.on('message', (m) => {
      clearTimeout(timer);
      w.terminate();
      const phase = m.events.some(([k, v]) => k === 'phase' && v === 'run') ? 'run' : 'build';
      const result = (m.events.find(([k]) => k === 'result') || [])[1];
      resolve({ phase, exitCode: m.exitCode, stdout: m.stdout, stderr: m.stderr, result, ms: Date.now() - start });
    });
    w.on('error', (e) => { clearTimeout(timer); resolve({ phase: 'build', exitCode: 2, stdout: '', stderr: String(e), ms: Date.now() - start }); });
  });
}
