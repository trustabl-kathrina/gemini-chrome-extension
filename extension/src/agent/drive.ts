/**
 * Minimal Google Drive v3 client (files.list / files.create / multipart upload). Dependency-free so it runs
 * in the service worker and in vitest; `base` comes from settings.driveApiBase so the harness can point it at
 * the fake Drive.
 */

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  size?: string;
  webViewLink?: string;
  modifiedTime?: string;
}

/** `"Dayflow/CSCI3240 CV/Lab 01/x.pdf"` → `["Dayflow", "CSCI3240 CV", "Lab 01", "x.pdf"]`; drops empty, `.` and `..`. */
export function splitDrivePath(p: string): string[] {
  return p
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..');
}

/** Escapes a value for the Drive `q` mini-language (`name = '…'`). */
export function q(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

export function mimeFor(name: string): string {
  const ext = name.toLowerCase().slice(name.lastIndexOf('.'));
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
    }[ext] ?? 'application/octet-stream'
  );
}

/** File name from Content-Disposition (RFC 5987 or plain), else the URL's last path segment. */
export function fileNameFromHeaders(headers: Headers, url: string): string {
  const cd = headers.get('content-disposition') ?? '';
  const star = /filename\*=(?:UTF-8|utf-8)''([^;]+)/.exec(cd);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch {
      /* fall through */
    }
  }
  const plain = /filename="?([^";]+)"?/.exec(cd);
  if (plain?.[1]) return plain[1].trim();
  try {
    const last = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() ?? '');
    if (last) return last;
  } catch {
    /* fall through */
  }
  return 'download.bin';
}

export interface DriveClientOptions {
  base: string;
  token: string;
  fetch?: typeof fetch;
  /**
   * Called on a 401 with the token that was refused; return a fresh one to retry the request once, or null to
   * let the 401 surface. Chrome hands out a cached OAuth token until it expires, so a long run WILL hit this.
   */
  onUnauthorized?: (stale: string) => Promise<string | null>;
}

export class DriveClient {
  private readonly base: string;
  private token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly onUnauthorized?: (stale: string) => Promise<string | null>;
  /**
   * path → the promise of its folder id, so a run touching 40 files does not re-resolve `Dayflow/<course>`
   * each time. The PROMISE is cached, not the resolved id: `download_many` resolves the same
   * "<course>/<week>" chain from four uploads at once, and a cache written only after the await would let
   * all four miss and create four duplicate folders.
   */
  private readonly folders = new Map<string, Promise<string>>([['', Promise.resolve('root')]]);
  /** path → the last upload to it, so two items of one batch naming the same file do not both create it. */
  private readonly uploads = new Map<string, Promise<DriveFile>>();

  constructor(opts: DriveClientOptions) {
    this.base = opts.base.replace(/\/+$/, '');
    this.token = opts.token;
    this.onUnauthorized = opts.onUnauthorized;
    // Bound explicitly: a bare `fetch` called as a method (`this.fetchImpl(...)`) throws "Illegal invocation" in workers.
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The token in use — after a 401 refresh this is the new one, so callers can cache it. */
  get accessToken(): string {
    return this.token;
  }

  private async call<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
    const res = await this.fetchImpl(`${this.base}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, ...(init.headers as Record<string, string> | undefined) },
    });
    if (res.status === 401 && !retried && this.onUnauthorized) {
      // Bodies here are strings or Blobs, both replayable; nothing is consumed by the failed attempt.
      const fresh = await this.onUnauthorized(this.token).catch(() => null);
      if (fresh && fresh !== this.token) {
        this.token = fresh;
        return this.call<T>(path, init, true);
      }
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`Drive ${init.method ?? 'GET'} ${path.split('?')[0]} → HTTP ${res.status} ${body}`);
    }
    return (await res.json()) as T;
  }

  async findChild(parentId: string, name: string, folder?: boolean): Promise<DriveFile | null> {
    const mime = folder === undefined ? '' : ` and mimeType ${folder ? '=' : '!='} ${q(FOLDER_MIME)}`;
    const query = `name = ${q(name)} and ${q(parentId)} in parents and trashed = false${mime}`;
    const params = new URLSearchParams({ q: query, fields: 'files(id,name,mimeType,parents,size,webViewLink,modifiedTime)', pageSize: '10' });
    const r = await this.call<{ files?: DriveFile[] }>(`/drive/v3/files?${params}`);
    return r.files?.[0] ?? null;
  }

  /** Creates the folder chain for `path` (idempotent) and returns the id of the last folder. */
  async ensureFolder(path: string): Promise<string> {
    let parent = 'root';
    let key = '';
    for (const seg of splitDrivePath(path)) {
      key = key ? `${key}/${seg}` : seg;
      const at = key;
      let pending = this.folders.get(at);
      if (!pending) {
        pending = this.folderId(parent, seg).catch((e: unknown) => {
          this.folders.delete(at); // a failed lookup must not be replayed for the rest of the run
          throw e;
        });
        this.folders.set(at, pending);
      }
      parent = await pending;
    }
    return parent;
  }

  /** The id of `name` under `parentId`, creating it if it is not there yet. */
  private async folderId(parentId: string, name: string): Promise<string> {
    const existing = await this.findChild(parentId, name, true);
    if (existing) return existing.id;
    const created = await this.call<DriveFile>('/drive/v3/files?fields=id,name', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
    });
    return created.id;
  }

  /** Uploads `blob` at `path` (folders created as needed); an existing file with the same name is replaced. */
  async upload(path: string, blob: Blob, mimeType = mimeFor(path)): Promise<DriveFile> {
    // Uploads to the SAME path are chained: concurrent ones would both miss `findChild` and create two copies.
    const key = splitDrivePath(path).join('/');
    const previous = this.uploads.get(key);
    const next = previous ? previous.then(() => this.uploadOnce(path, blob, mimeType), () => this.uploadOnce(path, blob, mimeType)) : this.uploadOnce(path, blob, mimeType);
    this.uploads.set(key, next);
    return next;
  }

  private async uploadOnce(path: string, blob: Blob, mimeType: string): Promise<DriveFile> {
    const segs = splitDrivePath(path);
    const name = segs.pop();
    if (!name) throw new Error('upload path has no file name');
    const parent = await this.ensureFolder(segs.join('/'));
    const existing = await this.findChild(parent, name, false);
    const boundary = `dayflow-${Date.now().toString(36)}`;
    const meta = { name, mimeType, ...(existing ? {} : { parents: [parent] }) };
    const body = new Blob(
      [
        `--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(meta)}\r\n`,
        `--${boundary}\r\ncontent-type: ${mimeType}\r\n\r\n`,
        blob,
        `\r\n--${boundary}--`,
      ],
      { type: `multipart/related; boundary=${boundary}` },
    );
    const url = existing ? `/upload/drive/v3/files/${encodeURIComponent(existing.id)}?uploadType=multipart&fields=id,name,webViewLink` : '/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink';
    return this.call<DriveFile>(url, { method: existing ? 'PATCH' : 'POST', headers: { 'content-type': `multipart/related; boundary=${boundary}` }, body });
  }

  /** Lists the direct children of the folder at `path` ('' = My Drive root). */
  async list(path: string): Promise<DriveFile[]> {
    const segs = splitDrivePath(path);
    let parent = 'root';
    for (const seg of segs) {
      const f = await this.findChild(parent, seg, true);
      if (!f) return [];
      parent = f.id;
    }
    const params = new URLSearchParams({ q: `${q(parent)} in parents and trashed = false`, fields: 'files(id,name,mimeType,parents,size,webViewLink,modifiedTime)', pageSize: '200' });
    const r = await this.call<{ files?: DriveFile[] }>(`/drive/v3/files?${params}`);
    return r.files ?? [];
  }

  /** The signed-in account (fails fast when the token is bad). */
  async about(): Promise<{ emailAddress?: string; displayName?: string }> {
    const r = await this.call<{ user?: { emailAddress?: string; displayName?: string } }>('/drive/v3/about?fields=user');
    return r.user ?? {};
  }
}
