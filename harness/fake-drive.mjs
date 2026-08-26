#!/usr/bin/env node
// Minimal Google Drive v3 stand-in (PLAN v2 §Harness). Stores real files under harness/out/drive/<scene>/ as a
// folder tree, so scene specs can simply list the directory. Any bearer token (or none) is accepted; CORS is
// open so the extension's Drive client (chrome-extension:// origin) can call it directly.
//
// Endpoints (subset of https://www.googleapis.com):
//   GET    /drive/v3/files?q=…                      name / parents / mimeType / trashed / fullText filters
//   GET    /drive/v3/files/{id}[?alt=media]         metadata | bytes
//   POST   /drive/v3/files                          JSON metadata → folder (or empty file)
//   POST   /upload/drive/v3/files?uploadType=multipart|media   multipart/related [metadata, bytes] | raw bytes (+?name=&parents=)
//   PATCH  /upload/drive/v3/files/{id}?uploadType=media        replace bytes
//   PATCH  /drive/v3/files/{id}                     rename / move (name, addParents)
//   DELETE /drive/v3/files/{id}
//   GET    /drive/v3/about?fields=user              the fake account
//   GET    /health · POST /__harness/reset {scene} · GET /__harness/tree
// File ids are `root` or `f_<hex(utf8 relative path)>`, so they survive restarts and map 1:1 to the tree.
// Usage: FAKE_DRIVE_PORT=8101 [FAKE_DRIVE_SCENE=vault-sync] node harness/fake-drive.mjs
import { createServer } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'out', 'drive');
const PORT = Number(process.env.FAKE_DRIVE_PORT || 8101);
const HOST = process.env.FAKE_DRIVE_HOST || '127.0.0.1';
const FOLDER = 'application/vnd.google-apps.folder';
const USER = { kind: 'drive#user', displayName: 'Harness', emailAddress: 'harness@dayflow.local', permissionId: '1', me: true };

let scene = process.env.FAKE_DRIVE_SCENE || 'dev';
let root = path.join(OUT, scene);
fs.mkdirSync(root, { recursive: true });

// ---------- ids ↔ paths ----------
const idOf = (rel) => (rel === '' ? 'root' : `f_${Buffer.from(rel, 'utf8').toString('hex')}`);
function relOf(id) {
  if (id === 'root' || id === '' || id === undefined) return '';
  if (!/^f_[0-9a-f]*$/.test(id)) return null;
  const rel = Buffer.from(id.slice(2), 'hex').toString('utf8');
  return rel.split('/').some((seg) => seg === '' || seg === '.' || seg === '..') ? null : rel;
}
const abs = (rel) => path.join(root, rel);
const safeName = (name) => String(name ?? '').replace(/[/\\]/g, '_').replace(/^\.+$/, '_') || 'untitled';

function meta(rel) {
  const st = fs.statSync(abs(rel));
  const name = rel === '' ? 'My Drive' : path.basename(rel);
  const parent = rel === '' ? null : idOf(path.dirname(rel) === '.' ? '' : path.dirname(rel));
  const isDir = st.isDirectory();
  const m = {
    kind: 'drive#file',
    id: idOf(rel),
    name,
    mimeType: isDir ? FOLDER : mimeOf(name),
    parents: parent ? [parent] : [],
    trashed: false,
    modifiedTime: st.mtime.toISOString(),
    createdTime: st.birthtime.toISOString(),
    webViewLink: `http://${HOST}:${PORT}/view/${idOf(rel)}`,
  };
  if (!isDir) {
    m.size = String(st.size);
    m.webContentLink = `http://${HOST}:${PORT}/drive/v3/files/${m.id}?alt=media`;
  }
  return m;
}
function mimeOf(name) {
  const ext = path.extname(name).toLowerCase();
  return (
    {
      '.pdf': 'application/pdf',
      '.html': 'text/html',
      '.htm': 'text/html',
      '.md': 'text/markdown',
      '.txt': 'text/plain',
      '.json': 'application/json',
      '.ipynb': 'application/x-ipynb+json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.csv': 'text/csv',
      '.zip': 'application/zip',
    }[ext] || 'application/octet-stream'
  );
}
function children(rel) {
  const dir = abs(rel);
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => !n.startsWith('.'))
    .map((n) => (rel ? `${rel}/${n}` : n));
}
function walk(rel = '', acc = []) {
  for (const c of children(rel)) {
    acc.push(c);
    if (fs.statSync(abs(c)).isDirectory()) walk(c, acc);
  }
  return acc;
}

// ---------- Drive `q` parser: `name = 'x' and 'id' in parents and mimeType != '…' and trashed = false` ----------
function parseQuery(q) {
  const f = { names: [], parents: [], mime: [], contains: [], fullText: [] };
  if (!q) return f;
  const unq = (s) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  for (const m of q.matchAll(/name\s*(=|!=|contains)\s*'((?:[^'\\]|\\.)*)'/g)) {
    if (m[1] === 'contains') f.contains.push(unq(m[2]).toLowerCase());
    else f.names.push({ eq: m[1] === '=', v: unq(m[2]) });
  }
  for (const m of q.matchAll(/'((?:[^'\\]|\\.)*)'\s+in\s+parents/g)) f.parents.push(unq(m[1]));
  for (const m of q.matchAll(/mimeType\s*(=|!=)\s*'((?:[^'\\]|\\.)*)'/g)) f.mime.push({ eq: m[1] === '=', v: unq(m[2]) });
  for (const m of q.matchAll(/fullText\s+contains\s+'((?:[^'\\]|\\.)*)'/g)) f.fullText.push(unq(m[1]).toLowerCase());
  return f;
}
function listFiles(q) {
  const f = parseQuery(q);
  let rels;
  if (f.parents.length) {
    rels = [];
    for (const p of f.parents) {
      const rel = relOf(p);
      if (rel !== null) rels.push(...children(rel));
    }
  } else rels = walk();
  return rels
    .map(meta)
    .filter((m) => f.names.every((n) => (m.name === n.v) === n.eq))
    .filter((m) => f.contains.every((c) => m.name.toLowerCase().includes(c)))
    .filter((m) => f.fullText.every((c) => m.name.toLowerCase().includes(c)))
    .filter((m) => f.mime.every((x) => (m.mimeType === x.v) === x.eq));
}

// ---------- http helpers ----------
function cors(res, req) {
  res.setHeader('access-control-allow-origin', req.headers.origin || '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', req.headers['access-control-request-headers'] || 'authorization,content-type,x-upload-content-type,x-goog-upload-protocol');
  res.setHeader('access-control-expose-headers', 'location,content-disposition');
  res.setHeader('access-control-max-age', '600');
}
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
const gerr = (res, status, message, reason = 'invalid') => json(res, status, { error: { code: status, message, errors: [{ domain: 'global', reason, message }] } });
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
/** Splits a multipart/related (or form-data) body into [{headers, body}] parts. */
function multipart(buf, contentType) {
  const m = /boundary="?([^";]+)"?/i.exec(contentType || '');
  if (!m) throw new Error('multipart body without boundary');
  const delim = Buffer.from(`--${m[1]}`);
  const parts = [];
  let pos = buf.indexOf(delim);
  while (pos !== -1) {
    let start = pos + delim.length;
    if (buf.slice(start, start + 2).toString() === '--') break; // closing delimiter
    if (buf[start] === 0x0d && buf[start + 1] === 0x0a) start += 2;
    else if (buf[start] === 0x0a) start += 1;
    const next = buf.indexOf(delim, start);
    if (next === -1) break;
    let end = next;
    if (buf[end - 2] === 0x0d && buf[end - 1] === 0x0a) end -= 2;
    else if (buf[end - 1] === 0x0a) end -= 1;
    const chunk = buf.slice(start, end);
    let sep = chunk.indexOf('\r\n\r\n');
    let sepLen = 4;
    if (sep === -1) {
      sep = chunk.indexOf('\n\n');
      sepLen = 2;
    }
    const headers = {};
    let body = chunk;
    if (sep !== -1) {
      for (const line of chunk.slice(0, sep).toString('utf8').split(/\r?\n/)) {
        const i = line.indexOf(':');
        if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
      }
      body = chunk.slice(sep + sepLen);
    }
    parts.push({ headers, body });
    pos = next;
  }
  return parts;
}

function resolveParent(parents) {
  const p = Array.isArray(parents) && parents.length ? parents[0] : 'root';
  const rel = relOf(String(p));
  if (rel === null || !fs.existsSync(abs(rel)) || !fs.statSync(abs(rel)).isDirectory()) return null;
  return rel;
}
/** Creates (or overwrites) a file/folder from Drive metadata; returns its metadata. */
function create(metadata, bytes) {
  const parentRel = resolveParent(metadata.parents);
  if (parentRel === null) return { error: `parent not found: ${JSON.stringify(metadata.parents)}` };
  const name = safeName(metadata.name);
  const rel = parentRel ? `${parentRel}/${name}` : name;
  const target = abs(rel);
  if (metadata.mimeType === FOLDER) {
    if (fs.existsSync(target) && !fs.statSync(target).isDirectory()) return { error: `${rel} exists and is a file` };
    fs.mkdirSync(target, { recursive: true });
  } else {
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) return { error: `${rel} exists and is a folder` };
    fs.writeFileSync(target, bytes ?? Buffer.alloc(0));
  }
  return { meta: meta(rel) };
}

let requests = 0;
const server = createServer(async (req, res) => {
  cors(res, req);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;
  const log = (status, extra = '') => console.log(`${new Date().toISOString()} ${req.method} ${p}${url.search} ${status} ${extra}`.trimEnd());
  requests++;
  if (req.method === 'OPTIONS') return res.writeHead(204).end(), log(204);
  try {
    if (p === '/health') return json(res, 200, { ok: true, service: 'fake-drive', scene, root, requests }), log(200);
    if (p === '/__harness/reset' && req.method === 'POST') {
      let body = {};
      try {
        body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      } catch {
        /* empty */
      }
      scene = safeName(body.scene || url.searchParams.get('scene') || scene);
      root = path.join(OUT, scene);
      if (body.clear !== false) fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(root, { recursive: true });
      return json(res, 200, { ok: true, scene, root }), log(200, `scene=${scene}`);
    }
    if (p === '/__harness/tree') return json(res, 200, { scene, root, entries: walk().map((r) => (fs.statSync(abs(r)).isDirectory() ? `${r}/` : r)) }), log(200);

    if (p === '/drive/v3/about') return json(res, 200, { kind: 'drive#about', user: USER, storageQuota: { limit: '1099511627776', usage: '0' } }), log(200);

    // ----- list -----
    if (p === '/drive/v3/files' && req.method === 'GET') {
      const files = listFiles(url.searchParams.get('q') || '');
      return json(res, 200, { kind: 'drive#fileList', incompleteSearch: false, files }), log(200, `${files.length} files q=${JSON.stringify(url.searchParams.get('q') || '')}`);
    }
    // ----- create (metadata only) -----
    if (p === '/drive/v3/files' && req.method === 'POST') {
      let md;
      try {
        md = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      } catch {
        return gerr(res, 400, 'invalid JSON metadata', 'parseError'), log(400);
      }
      const r = create(md, Buffer.alloc(0));
      if (r.error) return gerr(res, 404, r.error, 'notFound'), log(404, r.error);
      return json(res, 200, r.meta), log(200, `${md.mimeType === FOLDER ? 'folder' : 'file'} ${r.meta.name}`);
    }
    // ----- upload -----
    if (p === '/upload/drive/v3/files' && req.method === 'POST') {
      const type = url.searchParams.get('uploadType') || 'media';
      const body = await readBody(req);
      let md = {};
      let bytes = body;
      if (type === 'multipart') {
        const parts = multipart(body, req.headers['content-type']);
        if (parts.length < 1) return gerr(res, 400, 'multipart body has no parts', 'parseError'), log(400);
        try {
          md = JSON.parse(parts[0].body.toString('utf8') || '{}');
        } catch {
          return gerr(res, 400, 'first multipart part is not JSON metadata', 'parseError'), log(400);
        }
        bytes = parts[1]?.body ?? Buffer.alloc(0);
      } else if (type === 'media') {
        md = { name: url.searchParams.get('name') || `Untitled-${Date.now()}`, parents: url.searchParams.get('parents') ? url.searchParams.get('parents').split(',') : undefined };
      } else return gerr(res, 400, `uploadType ${type} not supported by the fake (use multipart or media)`), log(400);
      const r = create({ ...md, mimeType: md.mimeType === FOLDER ? FOLDER : undefined }, bytes);
      if (r.error) return gerr(res, 404, r.error, 'notFound'), log(404, r.error);
      return json(res, 200, r.meta), log(200, `${r.meta.name} ${bytes.length}B`);
    }
    // ----- per-file -----
    const mFile = p.match(/^\/(?:upload\/)?drive\/v3\/files\/([^/]+)$/);
    if (mFile) {
      const id = decodeURIComponent(mFile[1]);
      const rel = relOf(id);
      if (rel === null || !fs.existsSync(abs(rel))) return gerr(res, 404, `File not found: ${id}.`, 'notFound'), log(404);
      if (req.method === 'GET') {
        if (url.searchParams.get('alt') === 'media') {
          if (fs.statSync(abs(rel)).isDirectory()) return gerr(res, 403, 'folders have no content', 'fileNotDownloadable'), log(403);
          const data = fs.readFileSync(abs(rel));
          res.writeHead(200, { 'content-type': mimeOf(rel), 'content-length': data.length, 'content-disposition': `attachment; filename="${path.basename(rel)}"` });
          return res.end(data), log(200, `${data.length}B`);
        }
        return json(res, 200, meta(rel)), log(200);
      }
      if (req.method === 'PATCH') {
        const body = await readBody(req);
        if (p.startsWith('/upload/')) {
          if (fs.statSync(abs(rel)).isDirectory()) return gerr(res, 403, 'cannot upload bytes to a folder'), log(403);
          fs.writeFileSync(abs(rel), body);
          return json(res, 200, meta(rel)), log(200, `${body.length}B`);
        }
        let md = {};
        try {
          md = JSON.parse(body.toString('utf8') || '{}');
        } catch {
          return gerr(res, 400, 'invalid JSON metadata', 'parseError'), log(400);
        }
        let newRel = rel;
        const addParent = url.searchParams.get('addParents') || (Array.isArray(md.parents) ? md.parents[0] : null);
        if (addParent) {
          const pr = relOf(addParent);
          if (pr === null || !fs.existsSync(abs(pr))) return gerr(res, 404, `parent not found: ${addParent}`, 'notFound'), log(404);
          newRel = pr ? `${pr}/${path.basename(newRel)}` : path.basename(newRel);
        }
        if (md.name) newRel = path.join(path.dirname(newRel) === '.' ? '' : path.dirname(newRel), safeName(md.name));
        if (newRel !== rel) fs.renameSync(abs(rel), abs(newRel));
        return json(res, 200, meta(newRel)), log(200, newRel);
      }
      if (req.method === 'DELETE') {
        fs.rmSync(abs(rel), { recursive: true, force: true });
        return res.writeHead(204).end(), log(204);
      }
    }
    if (p.startsWith('/view/')) {
      const rel = relOf(p.slice('/view/'.length));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><title>fake Drive</title><h1>fake Drive</h1><p>${rel === null ? 'unknown id' : `Dayflow harness file: <code>${rel}</code>`}</p>`), log(200);
    }
    gerr(res, 404, `no fake for ${req.method} ${p}`, 'notFound');
    log(404);
  } catch (e) {
    gerr(res, 500, e.message, 'internalError');
    log(500, e.message);
  }
});

server.listen(PORT, HOST, () => console.log(`fake-drive listening on http://${HOST}:${PORT} (scene ${scene}, root ${root})`));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
