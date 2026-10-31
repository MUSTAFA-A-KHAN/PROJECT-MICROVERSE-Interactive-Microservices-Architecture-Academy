#!/usr/bin/env node
/**
 * Verifies every coding exercise with the local Go toolchain:
 *   - the starter compiles and FAILS at least one test (there is work to do)
 *   - the reference solution compiles and PASSES every test
 *
 * Usage: node tools/check-exercises.mjs [exercise-id ...]
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocal, detectGo } from './gorunner.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'content', 'exercises');
if (!detectGo().available) { console.error('Go is not installed — cannot verify exercises.'); process.exit(2); }

const only = process.argv.slice(2);
const dirs = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory() && d.name !== 'scratch' && (!only.length || only.includes(d.name))).map((d) => d.name);
const testkit = await readFile(join(root, 'testkit.go.txt'), 'utf8');
let failures = 0;

const result = (out) => { const m = out.match(/RESULT (\d+)\/(\d+)/); return m ? { passed: +m[1], total: +m[2] } : null; };

for (const id of dirs) {
  const read = (f) => readFile(join(root, id, f), 'utf8');
  const [starter, solution, tests, support] = await Promise.all([read('starter.go.txt'), read('solution.go.txt'), read('tests.go.txt'), read('support.go.txt').catch(() => null)]);
  const shared = { 'main.go': tests, 'testkit.go': testkit, ...(support ? { 'support.go': support } : {}) };
  const s = await runLocal({ 'exercise.go': starter, ...shared });
  const sol = await runLocal({ 'exercise.go': solution, ...shared });
  const sr = result(s.stdout), rr = result(sol.stdout);
  const problems = [];
  if (s.phase === 'build') problems.push(`starter does not compile:\n${s.stderr}`);
  else if (!sr) problems.push(`starter produced no RESULT line:\n${s.stdout}${s.stderr}`);
  else if (sr.passed === sr.total) problems.push('starter already passes every test');
  if (sol.phase === 'build') problems.push(`solution does not compile:\n${sol.stderr}`);
  else if (!rr || rr.passed !== rr.total) problems.push(`solution fails tests:\n${sol.stdout}${sol.stderr}`);
  if (problems.length) { failures++; console.log(`✗ ${id}\n  ${problems.join('\n  ')}`); }
  else console.log(`✓ ${id}  starter ${sr.passed}/${sr.total} · solution ${rr.passed}/${rr.total}`);
}

// Scratchpad examples must build and exit cleanly.
if (!only.length || only.includes('scratch')) {
  const dir = join(root, 'scratch');
  for (const f of (await readdir(dir)).filter((n) => n.endsWith('.go.txt'))) {
    const r = await runLocal({ 'main.go': await readFile(join(dir, f), 'utf8') });
    if (r.ok) console.log(`✓ scratch/${f}  runs (${r.stdout.split('\n').filter(Boolean).length} lines of output)`);
    else { failures++; console.log(`✗ scratch/${f}\n  ${r.stderr || r.stdout}`); }
  }
}
process.exit(failures ? 1 : 0);
