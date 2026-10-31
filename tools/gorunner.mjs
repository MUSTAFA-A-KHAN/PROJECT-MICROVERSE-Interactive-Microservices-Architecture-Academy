/**
 * Real Go execution for Microverse's coding features.
 *
 *   runLocal(files)            compile + run a small program with the local Go toolchain
 *   runPlayground(files)       compile + run on the official Go Playground (go.dev)
 *   gofmt(code, backend)       format source with gofmt (local) or go.dev/_/fmt
 *   checkService(svc, edits)   go build / vet / test a copy of a codebase service with your edits
 *
 * Everything runs in throwaway temp directories, one job at a time, with
 * time and output limits. Called only by tools/serve.mjs.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, cp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, normalize, sep } from 'node:path';

const OUTPUT_LIMIT = 128 * 1024;
const isWin = process.platform === 'win32';

export function detectGo() {
  try {
    const r = spawnSync('go', ['version'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
    if (r.status === 0) return { available: true, version: r.stdout.trim().replace(/^go version /, '') };
  } catch (e) { /* not installed */ }
  return { available: false };
}

/** Run a process with a timeout, output cap and (on Windows) whole-tree kill. */
function run(cmd, args, { cwd, env, timeoutMs, input }) {
  return new Promise((resolve) => {
    const start = Date.now();
    let stdout = '', stderr = '', truncated = false, timedOut = false;
    const child = spawn(cmd, args, { cwd, env, windowsHide: true });
    const cap = (s, chunk) => {
      if (s.length >= OUTPUT_LIMIT) { truncated = true; return s; }
      return s + chunk.toString('utf8').slice(0, OUTPUT_LIMIT - s.length);
    };
    child.stdout.on('data', (d) => { stdout = cap(stdout, d); });
    child.stderr.on('data', (d) => { stderr = cap(stderr, d); });
    const timer = setTimeout(() => {
      timedOut = true;
      if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: stderr + String(err), timedOut, truncated, durationMs: Date.now() - start }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr, timedOut, truncated, durationMs: Date.now() - start }); });
    if (input !== undefined) child.stdin.end(input); else child.stdin.end();
  });
}

// One job at a time: keeps a laptop responsive and makes timings meaningful.
let chain = Promise.resolve();
function enqueue(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

const goEnv = (extra = {}) => ({ ...process.env, GOTOOLCHAIN: 'local', CGO_ENABLED: '0', ...extra });

/** Make compiler output refer to file names, not temp paths. */
function clean(text, dir) {
  return text.split(dir + sep).join('').split(dir).join('')
    // Windows prints internal\model\order.go:7:1 — use / so the UI can link every file:line.
    .replace(/[\w.\\/-]+\.go(?=:\d)/g, (p) => p.replace(/\\/g, '/'));
}

export function runLocal(files) {
  return enqueue(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'microverse-run-'));
    try {
      await writeFile(join(dir, 'go.mod'), 'module microverse/exercise\n\ngo 1.22\n');
      for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
      const exe = join(dir, isWin ? 'prog.exe' : 'prog');
      const env = goEnv({ GOFLAGS: '-mod=mod', GOPROXY: 'off' });
      const b = await run('go', ['build', '-o', exe, '.'], { cwd: dir, env, timeoutMs: 90000 });
      if (b.code !== 0) {
        return { ok: false, phase: 'build', stdout: '', stderr: clean(b.stderr, dir) || (b.timedOut ? 'build timed out' : 'build failed'), exitCode: b.code, buildMs: b.durationMs, runMs: 0 };
      }
      const r = await run(exe, [], { cwd: dir, env, timeoutMs: 10000 });
      let stderr = clean(r.stderr, dir);
      if (r.timedOut) stderr += '\nprogram killed: exceeded the 10 s time limit (infinite loop or deadlock?)\n';
      if (r.truncated) stderr += '\noutput truncated at 128 KB\n';
      return { ok: r.code === 0 && !r.timedOut, phase: 'run', stdout: r.stdout, stderr, exitCode: r.code, timedOut: r.timedOut, buildMs: b.durationMs, runMs: r.durationMs };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}

export async function runPlayground(files) {
  const names = Object.keys(files);
  const body = names.length === 1 ? files[names[0]] : names.map((n) => `-- ${n} --\n${files[n]}`).join('\n');
  const form = new URLSearchParams({ version: '2', body, withVet: 'true' });
  const start = Date.now();
  const res = await fetch('https://go.dev/_/compile', { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`Go Playground responded ${res.status}`);
  const j = await res.json();
  const ms = Date.now() - start;
  if (j.Errors) return { ok: false, phase: 'build', stdout: '', stderr: j.Errors, exitCode: 2, buildMs: ms, runMs: 0 };
  const events = j.Events || [];
  const stdout = events.filter((e) => e.Kind === 'stdout').map((e) => e.Message).join('');
  const stderr = events.filter((e) => e.Kind === 'stderr').map((e) => e.Message).join('') + (j.VetErrors ? `\ngo vet:\n${j.VetErrors}` : '');
  const status = typeof j.Status === 'number' ? j.Status : 0;
  return { ok: status === 0, phase: 'run', stdout, stderr, exitCode: status, buildMs: 0, runMs: ms };
}

export async function gofmt(code, backend) {
  if (backend !== 'playground') {
    const r = await run('gofmt', [], { env: goEnv(), timeoutMs: 10000, input: code });
    if (r.code === 0) return { code: r.stdout };
    return { error: r.stderr.replace(/<standard input>/g, 'line') };
  }
  const res = await fetch('https://go.dev/_/fmt', { method: 'POST', body: new URLSearchParams({ body: code, imports: 'true' }), signal: AbortSignal.timeout(15000) });
  const j = await res.json();
  return j.Error ? { error: j.Error } : { code: j.Body };
}

/** Copy one codebase service to a temp dir, apply edits, then go build / vet / test it. */
export function checkService(codebaseRoot, service, edits) {
  return enqueue(async () => {
    const src = join(codebaseRoot, service);
    const dir = await mkdtemp(join(tmpdir(), 'microverse-svc-'));
    const work = join(dir, service);
    try {
      await cp(src, work, { recursive: true });
      for (const [rel, content] of Object.entries(edits)) {
        const target = normalize(join(work, rel));
        if (!target.startsWith(work + sep)) throw new Error(`refusing to write outside the service: ${rel}`);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
      }
      const env = goEnv({ GOFLAGS: '-mod=mod' });
      const steps = [];
      for (const args of [['build', './...'], ['vet', './...'], ['test', '-count=1', './...']]) {
        const r = await run('go', args, { cwd: work, env, timeoutMs: 180000 });
        steps.push({ cmd: `go ${args.join(' ')}`, ok: r.code === 0, output: clean(r.stdout + r.stderr, work).trim(), durationMs: r.durationMs, timedOut: r.timedOut });
        if (r.code !== 0) break; // later steps are meaningless if this one failed
      }
      return { ok: steps.every((s) => s.ok) && steps.length === 3, steps };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
}
