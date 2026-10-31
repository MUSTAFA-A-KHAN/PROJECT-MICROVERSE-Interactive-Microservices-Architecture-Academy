#!/usr/bin/env node
/**
 * Verifies every coding exercise on both engines the Code Lab offers:
 *   - "go"      the local Go toolchain (skipped when Go isn't installed)
 *   - "browser" the in-browser WebAssembly runner (assets/go/runner.wasm.gz)
 * On each engine the starter must compile and FAIL at least one test, the
 * reference solution must PASS every test, and both engines must agree on
 * how many tests the starter passes.
 *
 * Usage: node tools/check-exercises.mjs [exercise-id ...]
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocal, detectGo } from './gorunner.mjs';
import { runWasm } from './wasmrun.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'content', 'exercises');
const haveGo = detectGo().available;
if (!haveGo) console.log('Go is not installed: checking the in-browser runner only.\n');
const engines = { browser: (files) => runWasm({ mode: 'run', files }), ...(haveGo ? { go: runLocal } : {}) };

const only = process.argv.slice(2);
const dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== 'scratch' && (!only.length || only.includes(d.name))).map((d) => d.name);
const testkit = await readFile(join(root, 'testkit.go.txt'), 'utf8');
let failures = 0;

const result = (out) => { const m = out.match(/RESULT (\d+)\/(\d+)/); return m ? { passed: +m[1], total: +m[2] } : null; };

for (const id of dirs) {
  const read = (f) => readFile(join(root, id, f), 'utf8');
  const [starter, solution, tests, support] = await Promise.all([read('starter.go.txt'), read('solution.go.txt'), read('tests.go.txt'), read('support.go.txt').catch(() => null)]);
  const shared = { 'main.go': tests, 'testkit.go': testkit, ...(support ? { 'support.go': support } : {}) };
  const problems = [];
  const summary = [];
  const starterPassed = {};
  for (const [engine, run] of Object.entries(engines)) {
    const [s, sol] = await Promise.all([run({ 'exercise.go': starter, ...shared }), run({ 'exercise.go': solution, ...shared })]);
    const sr = result(s.stdout), rr = result(sol.stdout);
    if (s.phase === 'build') problems.push(`[${engine}] starter does not compile:\n${s.stderr}`);
    else if (!sr) problems.push(`[${engine}] starter produced no RESULT line:\n${s.stdout}${s.stderr}`);
    else if (sr.passed === sr.total) problems.push(`[${engine}] starter already passes every test`);
    if (sol.phase === 'build') problems.push(`[${engine}] solution does not compile:\n${sol.stderr}`);
    else if (!rr || rr.passed !== rr.total) problems.push(`[${engine}] solution fails tests:\n${sol.stdout}${sol.stderr}`);
    if (sr) starterPassed[engine] = sr.passed;
    if (sr && rr) summary.push(`${engine}: starter ${sr.passed}/${sr.total} · solution ${rr.passed}/${rr.total}`);
  }
  if (haveGo && starterPassed.go !== starterPassed.browser) problems.push(`engines disagree on the starter: go ${starterPassed.go}, browser ${starterPassed.browser}`);
  if (problems.length) { failures++; console.log(`✗ ${id}\n  ${problems.join('\n  ')}`); }
  else console.log(`✓ ${id}  ${summary.join('  |  ')}`);
}

// Scratchpad examples must build and exit cleanly on every engine.
if (!only.length || only.includes('scratch')) {
  const dir = join(root, 'scratch');
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.go.txt'))) {
    const src = await readFile(join(dir, f), 'utf8');
    for (const [engine, run] of Object.entries(engines)) {
      const r = await run({ 'main.go': src });
      if (r.exitCode === 0 && r.phase === 'run') console.log(`✓ scratch/${f} [${engine}]  runs (${r.stdout.split('\n').filter(Boolean).length} lines of output)`);
      else { failures++; console.log(`✗ scratch/${f} [${engine}]\n  ${r.stderr || r.stdout}`); }
    }
  }
}
process.exit(failures ? 1 : 0);
