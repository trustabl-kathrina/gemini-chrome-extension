#!/usr/bin/env node
// Serves harness/fake-wsp: static SPA shell (deep links for /StudentFiles, /StudentSchedule, /News, /chat),
// /api/tree, PDF downloads with Content-Disposition: attachment, and a tiny chat API the harness inspects.
//
// Two ways to run the same server, no other harness machinery required:
//   node harness/serve.mjs                     # what `make e2e` starts: open portal, no login (FAKE_WSP_PORT, default 8099)
//   node harness/serve.mjs --login --port 8099 # what `make replica` starts: seeded login screen (demo / demo)
//
// Flags/env (flag wins): --port/FAKE_WSP_PORT/PORT · --host/FAKE_WSP_HOST · --login|--no-login/FAKE_WSP_LOGIN
//                        FAKE_WSP_USER (demo) · FAKE_WSP_PASSWORD (demo)
// The login gate is OFF by default on purpose: the e2e runner drives the portal unattended and never types
// credentials, so `make e2e` sees exactly the portal it always saw.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, 'fake-wsp');
const PUBLIC = join(ROOT, 'public');
const FILES = join(ROOT, 'files');

const argv = process.argv.slice(2);
/** `--name value` or `--name=value`; returns `fallback` when the flag is absent. */
function opt(name, fallback) {
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const i = argv.indexOf(`--${name}`);
  const next = i >= 0 ? argv[i + 1] : undefined;
  return next !== undefined && !next.startsWith('--') ? next : fallback;
}
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());

if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node harness/serve.mjs [--port N] [--host H] [--login|--no-login]\n' + '  env: FAKE_WSP_PORT|PORT, FAKE_WSP_HOST, FAKE_WSP_LOGIN, FAKE_WSP_USER, FAKE_WSP_PASSWORD');
  process.exit(0);
}
const PORT = Number(opt('port', process.env.FAKE_WSP_PORT || process.env.PORT || 8099));
const HOST = opt('host', process.env.FAKE_WSP_HOST || '127.0.0.1');
const LOGIN = argv.includes('--no-login') ? false : argv.includes('--login') || truthy(process.env.FAKE_WSP_LOGIN);
// Demo credentials are deliberately public (README/docs/JUDGES.md and the login page itself print them):
// the replica holds nothing but generated PDFs, and a judge must be able to sign in with zero setup.
const USERNAME = process.env.FAKE_WSP_USER || 'demo';
const PASSWORD = process.env.FAKE_WSP_PASSWORD || 'demo';

const tree = JSON.parse(readFileSync(join(ROOT, 'tree.json'), 'utf8'));
// Chat state lives in memory: structuredClone of the seed so every server start is clean.
let chats = structuredClone(tree.chats);
const postedMessages = [];
// Session ids of everyone who typed the demo password since this process started (in memory: a restart signs
// everyone out). Only consulted when LOGIN is on.
const sessions = new Set();

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

// ---------- login gate (only when LOGIN) ----------
// The real portal puts a Vaadin login form in front of everything; the replica reproduces that shape with seeded
// credentials so a judge sees the same flow as the video. A signed-in browser session is what the agent inherits —
// it never types credentials itself, exactly as on the real portal.
// What the login page itself needs before anyone is signed in (its stylesheet and the header icon).
const isLoginAsset = (path) => path === '/app.css' || path.startsWith('/icons/');

function cookie(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

const signedIn = (req) => !LOGIN || sessions.has(cookie(req, 'wsp_session') ?? '');

const htmlEscape = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/** The login page with the seeded credentials filled in (and an optional error banner). */
function loginPage(next, error) {
  // Function replacements: a `$&` in an env-supplied password must never be read as a substitution pattern.
  const fill = { __USER__: htmlEscape(USERNAME), __PASSWORD__: htmlEscape(PASSWORD), __NEXT__: htmlEscape(next || '/'), __ERROR__: error ? `<div class="login-error" role="alert">${htmlEscape(error)}</div>` : '' };
  return readFileSync(join(PUBLIC, 'login.html'), 'utf8').replace(/__(?:USER|PASSWORD|NEXT|ERROR)__/g, (k) => fill[k]);
}

/** Same-origin absolute path only: `?next=https://evil` must not turn the portal into an open redirect. */
const safeNext = (raw) => (typeof raw === 'string' && /^\/[^/\\]/.test(raw) ? raw : '/');

function redirect(res, to) {
  res.writeHead(302, { location: to, 'cache-control': 'no-store' });
  res.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const path = decodeURIComponent(url.pathname);
  const log = (status) => console.log(`${new Date().toISOString()} ${req.method} ${path} ${status}`);

  if (path === '/health') return json(res, 200, { ok: true, service: 'fake-wsp', login: LOGIN, files: FILES }), log(200);

  if (LOGIN) {
    if (path === '/login' && req.method === 'POST') {
      const form = new URLSearchParams(await readBody(req));
      const next = safeNext(form.get('next'));
      if (form.get('username') !== USERNAME || form.get('password') !== PASSWORD) {
        return send(res, 401, loginPage(next, 'Wrong username or password. The demo account is printed below.'), MIME['.html']), log(401);
      }
      const sid = randomBytes(16).toString('hex');
      sessions.add(sid);
      res.writeHead(302, { location: next, 'set-cookie': `wsp_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200`, 'cache-control': 'no-store' });
      res.end();
      return log(302);
    }
    if (path === '/logout') {
      sessions.delete(cookie(req, 'wsp_session') ?? '');
      res.writeHead(302, { location: '/login', 'set-cookie': 'wsp_session=; Path=/; HttpOnly; Max-Age=0', 'cache-control': 'no-store' });
      res.end();
      return log(302);
    }
    if (path === '/login') {
      if (signedIn(req)) return redirect(res, '/'), log(302);
      return send(res, 200, loginPage(safeNext(url.searchParams.get('next'))), MIME['.html']), log(200);
    }
    if (!signedIn(req) && !isLoginAsset(path)) {
      // APIs answer 401 (the SPA never renders); navigations and downloads land on the login form.
      if (path.startsWith('/api/')) return json(res, 401, { error: 'not signed in' }), log(401);
      const next = `/login?next=${encodeURIComponent(url.pathname + url.search)}`;
      if (path.startsWith('/files/')) return redirect(res, next), log(302);
      if (!extname(path)) return send(res, 200, loginPage(safeNext(url.pathname + url.search)), MIME['.html']), log(200);
      return redirect(res, next), log(302);
    }
  }

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

server.listen(PORT, HOST, () =>
  console.log(`fake-wsp listening on http://${HOST}:${PORT} — login ${LOGIN ? `required (${USERNAME} / ${PASSWORD})` : 'off'} (files: ${FILES})`),
);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
