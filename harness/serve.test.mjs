// Self-test for the replica portal (node --test harness/serve.test.mjs). Two things must hold at once:
//   1. the default run is the portal `make e2e` has always driven — no login, /api/tree open;
//   2. `--login` puts the seeded demo account in front of everything, so a judge sees the flow from the video.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const OPEN_PORT = 8400 + Math.floor(Math.random() * 200);
const LOGIN_PORT = OPEN_PORT + 1;
const OPEN = `http://127.0.0.1:${OPEN_PORT}`;
const LOGIN = `http://127.0.0.1:${LOGIN_PORT}`;
const children = [];

async function waitFor(url, ms = 10000) {
  const t0 = Date.now();
  for (;;) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() - t0 > ms) throw new Error(`${url} did not answer within ${ms}ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function start(args, env) {
  const child = spawn(process.execPath, [path.join(here, 'serve.mjs'), ...args], { env: { ...process.env, FAKE_WSP_PORT: '', FAKE_WSP_LOGIN: '', ...env }, stdio: 'ignore' });
  children.push(child);
  return child;
}

/** POST /login without following the redirect, so the Set-Cookie can be inspected. */
async function signIn(username, password, next) {
  const body = new URLSearchParams({ username, password, ...(next ? { next } : {}) });
  return fetch(`${LOGIN}/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body, redirect: 'manual' });
}

before(async () => {
  // The open portal takes its port from the env (as e2e.sh does); the replica from --port (as `make replica` does).
  start([], { FAKE_WSP_PORT: String(OPEN_PORT) });
  start(['--login', '--port', String(LOGIN_PORT)], {});
  await Promise.all([waitFor(`${OPEN}/health`), waitFor(`${LOGIN}/health`)]);
});
after(() => {
  for (const c of children) c.kill();
});

test('default run: no login gate, exactly the portal make e2e drives', async () => {
  const health = await (await fetch(`${OPEN}/health`)).json();
  assert.equal(health.login, false);
  const tree = await (await fetch(`${OPEN}/api/tree`)).json();
  assert.ok(tree.schools.length >= 1, 'the course tree is served');
  assert.ok(tree.schools[0].instructors[0].courses[0].files[0].size > 0, 'file sizes come from the PDFs on disk');
  const home = await fetch(`${OPEN}/StudentFiles`);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /id="app"/, 'deep links render the SPA shell, not a login form');
  const pdf = await fetch(`${OPEN}/files/${['Abenova Saule', 'CSCI3240 Introduction to Computer Vision', 'syllabus.pdf'].map(encodeURIComponent).join('/')}`);
  assert.equal(pdf.status, 200);
  assert.match(pdf.headers.get('content-disposition') ?? '', /attachment/);
});

test('replica run: everything is behind the login form until the demo account signs in', async () => {
  assert.equal((await (await fetch(`${LOGIN}/health`)).json()).login, true, '/health stays open so a judge can probe the container');

  const api = await fetch(`${LOGIN}/api/tree`);
  assert.equal(api.status, 401);
  const page = await fetch(`${LOGIN}/StudentFiles`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /name="username"/, 'a navigation lands on the login form');
  assert.match(html, /demo/, 'the seeded credentials are printed on the page');
  const file = await fetch(`${LOGIN}/files/Abenova%20Saule/x.pdf`, { redirect: 'manual' });
  assert.equal(file.status, 302, 'downloads redirect to the login form too');

  assert.equal((await signIn('demo', 'wrong')).status, 401);
  assert.equal((await signIn('demo', 'wrong')).headers.getSetCookie().length, 0, 'a failed attempt never issues a session');

  const ok = await signIn('demo', 'demo', '/StudentFiles');
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('location'), '/StudentFiles', 'the judge lands back where they were headed');
  const cookie = (ok.headers.getSetCookie()[0] ?? '').split(';')[0];
  assert.match(cookie, /^wsp_session=[0-9a-f]{32}$/);

  const signed = await fetch(`${LOGIN}/api/tree`, { headers: { cookie } });
  assert.equal(signed.status, 200);
  assert.ok((await signed.json()).schools.length >= 1);
  assert.match(await (await fetch(`${LOGIN}/StudentFiles`, { headers: { cookie } })).text(), /id="app"/);
});

test('replica run: ?next is not an open redirect and traversal is refused', async () => {
  const away = await signIn('demo', 'demo', 'https://evil.example/');
  assert.equal(away.headers.get('location'), '/', 'an off-site next falls back to the desktop');
  const cookie = (away.headers.getSetCookie()[0] ?? '').split(';')[0];
  const escape = await fetch(`${LOGIN}/files/..%2f..%2fpackage.json`, { headers: { cookie } });
  assert.equal(escape.status, 404, 'no path traversal out of fake-wsp/files');
});
