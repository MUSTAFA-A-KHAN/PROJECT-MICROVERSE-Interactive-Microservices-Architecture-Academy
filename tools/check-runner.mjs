#!/usr/bin/env node
/**
 * Fidelity check for the in-browser Go runner (assets/go/runner.wasm.gz):
 * every program in tools/wasm/testdata and the Code Lab scratchpad examples
 * is run by the real Go toolchain and by the WebAssembly runner, and their
 * standard output must be identical.
 *
 * Usage: node tools/check-runner.mjs      (needs Go installed)
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocal, detectGo } from './gorunner.mjs';
import { runWasm } from './wasmrun.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (!detectGo().available) { console.error('Go is not installed — nothing to compare against.'); process.exit(2); }

const sources = [];
for (const [dir, label] of [[join(root, 'tools', 'wasm', 'testdata'), 'testdata'], [join(root, 'content', 'exercises', 'scratch'), 'scratch']]) {
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.go.txt')).sort()) sources.push({ name: `${label}/${f}`, src: await readFile(join(dir, f), 'utf8') });
}

let failures = 0;
for (const { name, src } of sources) {
  const files = { 'main.go': src };
  const [real, wasm] = await Promise.all([runLocal(files), runWasm({ mode: 'run', files })]);
  if (real.stdout === wasm.stdout && (real.exitCode === 0) === (wasm.exitCode === 0)) {
    console.log(`✓ ${name}  identical output (${wasm.ms} ms in the runner)`);
    continue;
  }
  failures++;
  const a = real.stdout.split('\n'), b = wasm.stdout.split('\n');
  const diff = [];
  for (let i = 0; i < Math.max(a.length, b.length) && diff.length < 12; i++) if (a[i] !== b[i]) diff.push(`    go:     ${a[i] ?? '∅'}\n    runner: ${b[i] ?? '∅'}`);
  console.log(`✗ ${name}  (exit ${real.exitCode} vs ${wasm.exitCode})\n${diff.join('\n')}\n    runner stderr: ${wasm.stderr.slice(0, 400)}`);
}
process.exit(failures ? 1 : 0);
