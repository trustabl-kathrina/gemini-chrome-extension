#!/usr/bin/env node
// Serves harness/fake-wsp: static SPA shell (deep links for /StudentFiles, /StudentSchedule, /News, /chat),
// /api/tree, PDF downloads with Content-Disposition: attachment, and a tiny chat API the harness inspects.
// Usage: node harness/serve.mjs   (FAKE_WSP_PORT, default 8099)
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, 'fake-wsp');
const PUBLIC = join(ROOT, 'public');
const FILES = join(ROOT, 'files');
const PORT = Number(process.env.FAKE_WSP_PORT || 8099);
const HOST = process.env.FAKE_WSP_HOST || '127.0.0.1';

const tree = JSON.parse(readFileSync(join(ROOT, 'tree.json'), 'utf8'));
// Chat state lives in memory: structuredClone of the seed so every server start is clean.
let chats = structuredClone(tree.chats);
const postedMessages = [];

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.pdf': 'application/pdf' };

function withSizes() {
  const t = structuredClone(tree);
  for (const s of t.schools)
    for (const i of s.instructors)
      for (const c of i.courses)
        for (const f of c.files) {
          const p = join(FILES, i.name, c.name, f.name);
          f.size = existsSync(p) ? statSync(p).size : 0;
        }
  return t;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(body);
}
const json = (res, status, obj) => send(res, status, JSON.stringify(obj));

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
  });
}

/** Resolves a request path to a file under `base`, refusing traversal. */
function safeJoin(base, rel) {
  const p = normalize(join(base, rel));
  return p.startsWith(base + '/') || p === base ? p : null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = decodeURIComponent(url.pathname);
  const log = (status) => console.log(`${new Date().toISOString()} ${req.method} ${path} ${status}`);

  if (path === '/health') return json(res, 200, { ok: true, service: 'fake-wsp', files: FILES }), log(200);
  if (path === '/api/tree') return json(res, 200, withSizes()), log(200);
  if (path === '/api/chat' && req.method === 'GET') return json(res, 200, chats), log(200);
  if (path === '/api/chat/messages' && req.method === 'GET') return json(res, 200, postedMessages), log(200);
  if (path === '/api/chat/reset' && req.method === 'POST') {
    chats = structuredClone(tree.chats);
    postedMessages.length = 0;
    return json(res, 200, { ok: true }), log(200);
  }
  const m = path.match(/^\/api\/chat\/([\w-]+)\/messages$/);
  if (m && req.method === 'POST') {
    const chat = chats.find((c) => c.id === m[1]);
    if (!chat) return json(res, 404, { error: 'no such chat' }), log(404);
    let text = '';
    try {
      text = String(JSON.parse(await readBody(req)).text || '').trim();
    } catch {
      /* fallthrough */
    }
    if (!text) return json(res, 400, { error: 'text required' }), log(400);
    const msg = { from: 'me', text, time: new Date().toISOString().slice(11, 16) };
    chat.messages.push(msg);
    postedMessages.push({ chat: chat.id, chatName: chat.name, ...msg, at: new Date().toISOString() });
    return json(res, 201, msg), log(201);
  }

  // Downloads: /files/<Instructor>/<Course>/<name>.pdf — attachment so the page stays put (like Vaadin's FileDownloader).
  if (path.startsWith('/files/')) {
    const file = safeJoin(FILES, path.slice('/files/'.length));
    if (!file || !existsSync(file) || !statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain'), log(404);
    const name = file.split('/').pop();
    const body = readFileSync(file);
    res.writeHead(200, {
      'content-type': 'application/pdf',
      'content-length': body.length,
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': 'no-store',
    });
    res.end(body);
    return log(200);
  }

  // Static assets, then SPA fallback for extension-less paths (deep links).
  const asset = safeJoin(PUBLIC, path === '/' ? '/index.html' : path);
  if (asset && extname(asset) && existsSync(asset) && statSync(asset).isFile()) {
    return send(res, 200, readFileSync(asset), MIME[extname(asset)] || 'application/octet-stream'), log(200);
  }
  if (!extname(path)) return send(res, 200, readFileSync(join(PUBLIC, 'index.html')), MIME['.html']), log(200);
  send(res, 404, 'not found', 'text/plain');
  log(404);
});

server.listen(PORT, HOST, () => console.log(`fake-wsp listening on http://${HOST}:${PORT} (files: ${FILES})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
