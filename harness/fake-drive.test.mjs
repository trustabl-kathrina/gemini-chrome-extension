// Self-test for the fake Drive (node --test harness/fake-drive.test.mjs): the extension's DriveClient uploads a
// new file with POST multipart and REPLACES an existing one with PATCH multipart (real Drive v3 semantics). Both
// must leave exactly the file's bytes on disk — a second download of the same path used to corrupt the PDF.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const SCENE = `selftest-${process.pid}`;
let child;

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

function multipartBody(meta, bytes, mime) {
  const boundary = 'dayflow-selftest';
  const body = new Blob([`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`, `--${boundary}\r\ncontent-type: ${mime}\r\n\r\n`, bytes, `\r\n--${boundary}--`]);
  return { body, type: `multipart/related; boundary=${boundary}` };
}

async function upload(meta, bytes, mime, existingId) {
  const { body, type } = multipartBody(meta, bytes, mime);
  const url = existingId ? `${BASE}/upload/drive/v3/files/${encodeURIComponent(existingId)}?uploadType=multipart` : `${BASE}/upload/drive/v3/files?uploadType=multipart`;
  const res = await fetch(url, { method: existingId ? 'PATCH' : 'POST', headers: { 'content-type': type }, body });
  const text = await res.text();
  assert.equal(res.status, 200, text);
  return JSON.parse(text);
}

before(async () => {
  child = spawn(process.execPath, [path.join(here, 'fake-drive.mjs')], { env: { ...process.env, FAKE_DRIVE_PORT: String(PORT), FAKE_DRIVE_SCENE: SCENE }, stdio: 'ignore' });
  await waitFor(`${BASE}/health`);
});
after(() => {
  child?.kill();
  fs.rmSync(path.join(here, 'out', 'drive', SCENE), { recursive: true, force: true });
});

test('uploading the same path twice keeps the raw file bytes (POST then PATCH multipart)', async () => {
  const folder = await (await fetch(`${BASE}/drive/v3/files`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Dayflow', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] }) })).json();
  const first = await upload({ name: 'a.pdf', mimeType: 'application/pdf', parents: [folder.id] }, new Blob(['%PDF-1.4 first']), 'application/pdf');
  const again = await upload({ name: 'a.pdf', mimeType: 'application/pdf' }, new Blob(['%PDF-1.4 second version']), 'application/pdf', first.id);
  assert.equal(again.id, first.id);
  const bytes = await (await fetch(`${BASE}/drive/v3/files/${first.id}?alt=media`)).text();
  assert.equal(bytes, '%PDF-1.4 second version');
  assert.ok(bytes.startsWith('%PDF-'), 'the multipart envelope must not be written to disk');
  const onDisk = fs.readFileSync(path.join(here, 'out', 'drive', SCENE, 'Dayflow', 'a.pdf'), 'utf8');
  assert.equal(onDisk, '%PDF-1.4 second version');
});

test('PATCH ?uploadType=media still replaces with the raw body', async () => {
  const f = await upload({ name: 'b.txt', mimeType: 'text/plain', parents: ['root'] }, new Blob(['one']), 'text/plain');
  const res = await fetch(`${BASE}/upload/drive/v3/files/${f.id}?uploadType=media`, { method: 'PATCH', headers: { 'content-type': 'text/plain' }, body: 'two' });
  assert.equal(res.status, 200);
  assert.equal(await (await fetch(`${BASE}/drive/v3/files/${f.id}?alt=media`)).text(), 'two');
});
