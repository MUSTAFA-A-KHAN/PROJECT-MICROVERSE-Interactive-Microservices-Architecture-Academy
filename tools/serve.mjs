#!/usr/bin/env node
/**
 * Local development server for Microverse.
 *
 *   node tools/serve.mjs [port]        (default 5173)
 *
 * Serves the static app and a small local API that compiles and runs Go:
 *
 *   GET  /api/go/info              which execution backends are available
 *   POST /api/go/run               { backend: 'local'|'playground', files: { 'name.go': src } }
 *   POST /api/go/fmt               { backend, code }
 *   POST /api/go/check-service     { service, edits: { 'relative/path.go': src } }
 *
 * Because the API executes code, the server binds to 127.0.0.1 only and the
 * API accepts requests only from this origin (Host + Origin checks and a
 * custom header that forces a CORS preflight, which is never granted).
 * 'playground' sends your code to the official Go Playground at go.dev.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { detectGo, runLocal, runPlayground, gofmt, checkService } from './gorunner.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const codebase = join(root, 'codebase', 'order-management');
const port = Number(process.argv[2] || process.env.PORT || 5173);
const host = process.env.HOST || '127.0.0.1';
const loopback = ['127.0.0.1', 'localhost', '::1'].includes(host);
const go = detectGo();
const SERVICES = ['api-gateway', 'user-service', 'order-service', 'notification-service'];

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.go': 'text/plain; charset=utf-8',
  '.mod': 'text/plain; charset=utf-8',
  '.sum': 'text/plain; charset=utf-8',
  '.sql': 'text/plain; charset=utf-8',
  '.yml': 'text/plain; charset=utf-8',
  '.yaml': 'text/plain; charset=utf-8',
  '.proto': 'text/plain; charset=utf-8',
  '.lua': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.sh': 'text/plain; charset=utf-8',
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** Only same-origin requests from this machine may reach the API. */
function allowed(req) {
  if (!loopback) return false;
  const h = req.headers.host || '';
  const okHost = [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(h);
  const origin = req.headers.origin;
  const okOrigin = !origin || origin === `http://${h}`;
  return okHost && okOrigin && req.headers['x-microverse'] === '1';
}

async function readJSON(req, limit = 512 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error('request too large'), { status: 413 });
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function validFiles(files) {
  if (!files || typeof files !== 'object') return false;
  const entries = Object.entries(files);
  return entries.length > 0 && entries.length <= 8 && entries.every(([n, c]) => /^[A-Za-z0-9_]+\.go$/.test(n) && typeof c === 'string' && c.length <= 100000);
}

async function api(req, res, path) {
  if (path === '/api/go/info' && req.method === 'GET') {
    return json(res, 200, { local: go, playground: { available: true, host: 'go.dev' }, apiEnabled: loopback });
  }
  if (!allowed(req)) return json(res, 403, { error: 'The code-execution API only accepts same-origin requests on localhost.' });
  if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
  const body = await readJSON(req);

  if (path === '/api/go/run') {
    if (!validFiles(body.files)) return json(res, 400, { error: 'expected files: { "name.go": "source" } (max 8 files, 100 KB each)' });
    const backend = body.backend === 'playground' ? 'playground' : 'local';
    if (backend === 'local' && !go.available) return json(res, 409, { error: 'Go is not installed on this machine. Use the Go Playground backend instead.' });
    const result = backend === 'local' ? await runLocal(body.files) : await runPlayground(body.files);
    return json(res, 200, { backend, goVersion: backend === 'local' ? go.version : 'go.dev playground', ...result });
  }
  if (path === '/api/go/fmt') {
    if (typeof body.code !== 'string' || body.code.length > 200000) return json(res, 400, { error: 'expected { code }' });
    const backend = body.backend === 'playground' || !go.available ? 'playground' : 'local';
    return json(res, 200, await gofmt(body.code, backend));
  }
  if (path === '/api/go/check-service') {
    if (!go.available) return json(res, 409, { error: 'Building the services needs Go installed locally.' });
    if (!SERVICES.includes(body.service)) return json(res, 400, { error: 'unknown service' });
    const edits = body.edits || {};
    if (Object.keys(edits).length > 30 || Object.entries(edits).some(([p, c]) => typeof c !== 'string' || /\.\./.test(p) || p.startsWith('/'))) return json(res, 400, { error: 'invalid edits' });
    return json(res, 200, await checkService(codebase, body.service, edits));
  }
  return json(res, 404, { error: 'unknown endpoint' });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url.pathname);
    const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    let file = join(root, path);
    if (!file.startsWith(root)) { res.writeHead(403).end('Forbidden'); return; }
    let s = await stat(file).catch(() => null);
    if (s && s.isDirectory()) { file = join(file, 'index.html'); s = await stat(file).catch(() => null); }
    if (!s) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end(`Not found: ${url.pathname}`); return; }
    const body = await readFile(file);
    const base = file.split(/[/\\]/).pop();
    const type = TYPES[extname(file).toLowerCase()] || (['Dockerfile', 'Makefile', '.env.example'].includes(base) ? 'text/plain; charset=utf-8' : 'application/octet-stream');
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch (err) {
    if (res.headersSent) return;
    if (req.url.startsWith('/api/')) return json(res, err.status || 500, { error: err.message || String(err) });
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(err));
  }
});

server.listen(port, host, () => {
  console.log(`\n  Microverse running at  http://localhost:${port}`);
  console.log(go.available ? `  Go code runs locally with ${go.version}` : '  Go not found — the Code Lab will offer the go.dev Playground backend');
  if (!loopback) console.log('  (code-execution API disabled: server is not bound to localhost)');
  console.log('');
});
