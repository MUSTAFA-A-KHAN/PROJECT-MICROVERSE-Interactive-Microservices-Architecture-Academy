#!/usr/bin/env node
/**
 * Consistency checks for course data. Run before committing content changes:
 *   node tools/check-content.mjs
 *
 * - every playground file exists, and every note/trace anchor is found in it
 * - every Architecture Lab code excerpt anchor is found
 * - every lesson in data/lessons.js has a section in its module markdown file
 * - every ::diagram / ::widget referenced in markdown exists
 * - every concept referenced by a lesson is defined
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ctx = { window: {}, console };
ctx.window.MV = {};
ctx.MV = ctx.window.MV;
vm.createContext(ctx);
for (const f of ['data/lessons.js', 'data/architectures.js', 'data/codebase.js', 'data/challenges.js', 'data/bootcamp.js', 'data/assessment.js']) {
  if (existsSync(join(root, f))) vm.runInContext(readFileSync(join(root, f), 'utf8'), ctx, { filename: f });
}
const MV = ctx.MV;
const problems = [];
const cb = MV.data.codebase;
const read = (p) => readFileSync(join(root, cb.root, p), 'utf8');

for (const f of cb.files) {
  if (!existsSync(join(root, cb.root, f.path))) { problems.push(`playground: missing file ${f.path}`); continue; }
  const text = read(f.path);
  for (const n of f.notes || []) if (!text.includes(n.at)) problems.push(`playground note not found in ${f.path}: ${n.at}`);
  for (const [p] of f.connects || []) if (!cb.files.some((x) => x.path === p)) problems.push(`playground connects to unknown file ${p} (from ${f.path})`);
}
for (const t of cb.traces) for (const s of t.steps) {
  if (!existsSync(join(root, cb.root, s.file))) problems.push(`trace ${t.id}: missing file ${s.file}`);
  else if (!read(s.file).includes(s.at)) problems.push(`trace ${t.id}: anchor not found in ${s.file}: ${s.at}`);
}
for (const n of MV.data.lab.nodes) {
  const p = join(root, cb.root, n.code.file);
  if (!existsSync(p)) problems.push(`lab ${n.id}: missing ${n.code.file}`);
  else if (!readFileSync(p, 'utf8').includes(n.code.from)) problems.push(`lab ${n.id}: anchor not found: ${n.code.from}`);
}

const widgetsSrc = readdirSync(join(root, 'js', 'widgets')).map((f) => readFileSync(join(root, 'js', 'widgets', f), 'utf8')).join('\n');
for (const m of MV.data.modules) {
  const mdPath = join(root, 'content', 'modules', `${m.id}.md`);
  if (!existsSync(mdPath)) { problems.push(`module ${m.id}: missing ${mdPath}`); continue; }
  const md = readFileSync(mdPath, 'utf8');
  const ids = [...md.matchAll(/^@@lesson\s+(\S+)/gm)].map((x) => x[1]);
  for (const l of m.lessons) {
    if (!ids.includes(l.id)) problems.push(`lesson ${m.id}/${l.id}: no "@@lesson ${l.id}" section`);
    for (const c of l.concepts || []) if (!MV.data.concepts[c]) problems.push(`lesson ${m.id}/${l.id}: unknown concept ${c}`);
  }
  for (const id of ids) if (!m.lessons.some((l) => l.id === id)) problems.push(`${m.id}.md: section ${id} not in catalog`);
  for (const x of md.matchAll(/::diagram\{id="([^"]+)"/g)) if (!MV.data.diagrams[x[1]]) problems.push(`${m.id}.md: unknown diagram ${x[1]}`);
  const widgetDefined = (name) => [`MV.widgets['${name}']`, `MV.widgets["${name}"]`, `MV.widgets.${name} =`].some((s) => widgetsSrc.includes(s));
  for (const x of md.matchAll(/::widget\{name="([^"]+)"/g)) if (!widgetDefined(x[1])) problems.push(`${m.id}.md: unknown widget ${x[1]}`);
  for (const x of md.matchAll(/:::quiz concept="([^"]+)"/g)) if (!MV.data.concepts[x[1]]) problems.push(`${m.id}.md: quiz uses unknown concept ${x[1]}`);
  md.split(':::quiz').slice(1).forEach((blk, i) => {
    const body = blk.split(/\n:::\s*\n/)[0];
    const correct = (body.match(/^\s*-\s*\[x\]/gim) || []).length;
    const options = (body.match(/^\s*-\s*\[( |x)\]/gim) || []).length;
    if (correct !== 1 || options < 3) problems.push(`${m.id}.md: quiz #${i + 1} has ${correct} correct answer(s) and ${options} options`);
    if (!/^>\s?\S/m.test(body)) problems.push(`${m.id}.md: quiz #${i + 1} has no explanation`);
  });
  for (const x of md.matchAll(/\]\(#\/lesson\/(m\d\d)\/([\w-]+)/g)) {
    const mod = MV.data.modules.find((mm) => mm.id === x[1]);
    if (!mod || !mod.lessons.some((l) => l.id === x[2])) problems.push(`${m.id}.md: broken lesson link ${x[1]}/${x[2]}`);
  }
}

// Bootcamp sessions and challenges reference lessons, widgets, diagrams, code and solutions.
const widgetsAll = readdirSync(join(root, 'js', 'widgets')).map((f) => readFileSync(join(root, 'js', 'widgets', f), 'utf8')).join('\n');
const hasWidget = (name) => [`MV.widgets['${name}']`, `MV.widgets["${name}"]`, `MV.widgets.${name} =`].some((s) => widgetsAll.includes(s));
const lessonExists = (key) => { const [mid, lid] = key.split('/'); const mod = MV.data.modules.find((m) => m.id === mid); return !!(mod && mod.lessons.some((l) => l.id === lid)); };
for (const s of MV.data.bootcamp || []) {
  if (s.widget && !hasWidget(s.widget)) problems.push(`bootcamp ${s.id}: unknown widget ${s.widget}`);
  if (!MV.data.diagrams[s.diagram]) problems.push(`bootcamp ${s.id}: unknown diagram ${s.diagram}`);
  for (const k of s.lessons) if (!lessonExists(k)) problems.push(`bootcamp ${s.id}: unknown lesson ${k}`);
  if (!(MV.data.challenges || []).some((c) => c.id === s.challenge)) problems.push(`bootcamp ${s.id}: unknown challenge ${s.challenge}`);
  const p = join(root, cb.root, s.code.file);
  if (!existsSync(p) || !readFileSync(p, 'utf8').includes(s.code.at)) problems.push(`bootcamp ${s.id}: code anchor not found in ${s.code.file}: ${s.code.at}`);
  if (s.trace && !cb.traces.some((t) => t.id === s.trace)) problems.push(`bootcamp ${s.id}: unknown trace ${s.trace}`);
  for (const q of s.quiz) if (q.answer < 0 || q.answer >= q.options.length) problems.push(`bootcamp ${s.id}: bad answer index`);
}
const solutions = readFileSync(join(root, 'content', 'challenges.md'), 'utf8');
for (const c of MV.data.challenges || []) {
  if (!MV.data.diagrams[c.diagram]) problems.push(`challenge ${c.id}: unknown diagram ${c.diagram}`);
  if (!new RegExp(`^@@challenge ${c.id}\\s*$`, 'm').test(solutions)) problems.push(`challenge ${c.id}: no solution section in content/challenges.md`);
  if (!c.approaches.some((a) => a.verdict === 'best')) problems.push(`challenge ${c.id}: no "best" approach`);
}
for (const q of MV.data.assessment || []) if (q.answer < 0 || q.answer >= q.options.length) problems.push(`assessment ${q.id}: bad answer index`);

const concepts = Object.keys(MV.data.concepts);
const conceptRefs = [];
(MV.data.challenges || []).forEach((c) => (c.concepts || []).forEach((k) => conceptRefs.push([`challenge ${c.id}`, k])));
(MV.data.assessment || []).forEach((q) => conceptRefs.push([`assessment ${q.id}`, q.concept]));
(MV.data.bootcamp || []).forEach((s) => (s.quiz || []).forEach((q) => conceptRefs.push([`bootcamp ${s.id}`, q.concept])));
for (const [where, k] of conceptRefs) if (k && !concepts.includes(k)) problems.push(`${where}: unknown concept ${k}`);
for (const [k, v] of Object.entries(MV.data.concepts)) {
  const [mid, lid] = v.lesson.split('/');
  const mod = MV.data.modules.find((m) => m.id === mid);
  if (!mod || !mod.lessons.some((l) => l.id === lid)) problems.push(`concept ${k}: lesson ${v.lesson} not found`);
}

if (problems.length) {
  console.error(`${problems.length} problem(s):\n  ` + problems.join('\n  '));
  process.exit(1);
}
console.log('All content checks passed.');
