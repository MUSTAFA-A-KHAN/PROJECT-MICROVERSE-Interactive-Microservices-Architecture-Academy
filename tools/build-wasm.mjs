#!/usr/bin/env node
/**
 * Builds the in-browser Go runner used by the Code Lab:
 *
 *   assets/go/runner.wasm.gz   tools/wasm compiled with GOOS=js GOARCH=wasm, gzipped
 *   assets/go/wasm_exec.js     the JS glue from the same Go toolchain (must match)
 *   assets/go/runner.json      version info + content hash for cache busting
 *
 * Usage:
 *   node tools/build-wasm.mjs            build the WebAssembly runner (needs Go)
 *   node tools/build-wasm.mjs --native   also build a native runner for tests
 *
 * Yaegi is built from a temporary copy of the module with PATCHES applied
 * (see below); the module cache and this repository are never modified.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync, cpSync, chmodSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const wasmDir = join(root, 'tools', 'wasm');
const out = join(root, 'assets', 'go');

const go = (args, env = {}) => {
  const r = spawnSync('go', args, { cwd: wasmDir, encoding: 'utf8', env: { ...process.env, ...env } });
  if (r.status !== 0) { console.error(r.stderr || r.stdout); process.exit(1); }
  return r.stdout.trim();
};

/*
 * Fixes for two Yaegi v0.16.1 bugs that ordinary Go code hits:
 *
 * 1. A function's deferred calls run while that frame's lock is held, so a
 *    deferred call that invokes a closure created in the same frame
 *    (`defer cleanup(func() {...})`, `defer f()` with f a local closure)
 *    deadlocks when the closure re-takes the lock. Run them after releasing it.
 *
 * 2. A call wrapper captures the callee's first instruction when it is built.
 *    For `defer helper()` where helper is declared later in the file, that
 *    instruction doesn't exist yet and the deferred call silently does
 *    nothing. Look it up when the call happens instead.
 *
 * 3. A comma-ok assertion to an interface type on a nil interface
 *    (`e, ok := err.(interface{ Timeout() bool })` with err == nil) crashes
 *    instead of yielding ok == false. Check validity before reading the type.
 *
 * 4. Struct types are built with reflect.StructOf, which can't express
 *    unexported fields or (in general) embedding. Yaegi exports `note` as
 *    `Xnote`, so encoding/json would emit it, and marks embedded fields as
 *    embedded only in single-field structs, so JSON nests them instead of
 *    promoting their fields. Hide renamed fields from encoders, and embed
 *    method-less structs (which reflect.StructOf supports).
 */
const PATCHES = [{
  file: 'interp/type.go',
  find: `			if len(t.field) == 1 && f.embed {
				// Mark the field as embedded (anonymous) only if it is the
				// only one, to avoid a panic due to golang/go#15924 issue.
				field.Anonymous = true
			}`,
  replace: `			// Microverse patch: see tools/build-wasm.mjs.
			if !canExport(f.name) && !f.embed {
				field.Tag = \`json:"-" xml:"-"\`
			}
			embeddable := func(rt reflect.Type) bool {
				if rt.Kind() == reflect.Ptr {
					rt = rt.Elem()
				}
				return rt.Kind() == reflect.Struct && rt.NumMethod() == 0 && reflect.PtrTo(rt).NumMethod() == 0 && !strings.Contains(rt.String(), "unsafe2.dummy")
			}
			if f.embed && canExport(f.name) && (len(t.field) == 1 || embeddable(field.Type)) {
				field.Anonymous = true
			}`,
}, {
  file: 'interp/run.go',
  find: `			} else {
				v = v.Elem()
				leftType = v.Type()
				ok = true
			}
			ok = v.IsValid()`,
  replace: `			} else {
				v = v.Elem()
				if v.IsValid() { // Microverse patch: a nil interface has no type
					leftType = v.Type()
				}
			}
			ok = v.IsValid()`,
}, {
  file: 'interp/run.go',
  find: `	start := def.child[3].start
	numRet := len(def.typ.ret)`,
  replace: `	numRet := len(def.typ.ret)`,
}, {
  file: 'interp/run.go',
  find: `			runCfg(start, fr, def, n)`,
  replace: `			runCfg(def.child[3].start, fr, def, n) // Microverse patch: resolve the body when called`,
}, {
  file: 'interp/run.go',
  find: `		f.mutex.Lock()
		f.recovered = recover()
		for _, val := range f.deferred {
			val[0].Call(val[1:])
		}
		if f.recovered != nil {`,
  replace: `		f.mutex.Lock()
		f.recovered = recover()
		deferred := f.deferred
		f.mutex.Unlock()
		// Microverse patch: run deferred calls without holding the frame lock.
		for _, val := range deferred {
			val[0].Call(val[1:])
		}
		f.mutex.Lock()
		if f.recovered != nil {`,
}];

/**
 * Copies Yaegi out of the module cache, applies PATCHES, and returns a
 * temporary go.mod that replaces the module with the patched copy
 * (use it with `go build -modfile`).
 */
export function patchedModfile() {
  const dir = go(['list', '-m', '-f', '{{.Dir}}', 'github.com/traefik/yaegi']);
  const tmp = join(tmpdir(), 'microverse-yaegi');
  const copy = join(tmp, 'yaegi');
  rmSync(tmp, { recursive: true, force: true });
  cpSync(dir, copy, { recursive: true, filter: (src) => !/[\\/](_test|example|cmd|\.github)([\\/]|$)/.test(src.slice(dir.length)) });
  for (const p of PATCHES) {
    const target = join(copy, p.file);
    chmodSync(target, 0o644);
    const src = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
    if (src.split(p.find).length !== 2) { console.error(`Yaegi patch no longer applies to ${p.file} (expected exactly one match) — check the Yaegi version.`); process.exit(1); }
    writeFileSync(target, src.replace(p.find, p.replace));
  }
  const mod = readFileSync(join(wasmDir, 'go.mod'), 'utf8') + `\nreplace github.com/traefik/yaegi => ${copy.replace(/\\/g, '/')}\n`;
  writeFileSync(join(tmp, 'go.mod'), mod);
  copyFileSync(join(wasmDir, 'go.sum'), join(tmp, 'go.sum'));
  return join(tmp, 'go.mod');
}

function build() {
  mkdirSync(out, { recursive: true });
  const goroot = go(['env', 'GOROOT']);
  const goVersion = go(['env', 'GOVERSION']);
  const yaegi = go(['list', '-m', '-f', '{{.Version}}', 'github.com/traefik/yaegi']);
  const modfile = patchedModfile();
  const tmp = join(tmpdir(), `microverse-runner-${process.pid}.wasm`);
  console.log(`Building runner.wasm with ${goVersion} and yaegi ${yaegi} (patched)…`);
  go(['build', '-trimpath', '-modfile', modfile, '-ldflags=-s -w', '-o', tmp, '.'], { GOOS: 'js', GOARCH: 'wasm', CGO_ENABLED: '0' });

  const wasm = readFileSync(tmp);
  rmSync(tmp, { force: true });
  const gz = gzipSync(wasm, { level: 9 });
  writeFileSync(join(out, 'runner.wasm.gz'), gz);
  copyFileSync(join(goroot, 'lib', 'wasm', 'wasm_exec.js'), join(out, 'wasm_exec.js'));
  const hash = createHash('sha256').update(gz).digest('hex').slice(0, 12);
  writeFileSync(join(out, 'runner.json'), JSON.stringify({ go: goVersion, yaegi, bytes: wasm.length, gzBytes: gz.length, hash }, null, 2) + '\n');
  console.log(`assets/go/runner.wasm.gz  ${(gz.length / 1e6).toFixed(1)} MB gzipped (${(wasm.length / 1e6).toFixed(1)} MB raw) · ${hash}`);

  if (process.argv.includes('--native')) {
    const exe = join(tmpdir(), process.platform === 'win32' ? 'microverse-runner.exe' : 'microverse-runner');
    go(['build', '-modfile', modfile, '-o', exe, '.']);
    console.log(`native runner: ${exe}`);
  }
}

const self = fileURLToPath(import.meta.url).toLowerCase();
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === self) build();
