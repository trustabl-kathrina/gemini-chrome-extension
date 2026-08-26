import { browser } from 'wxt/browser';
import { TOOL_CHANNEL, type Settings, type ToolCall } from '../protocol';
import { DriveClient, fileNameFromHeaders, mimeFor, splitDrivePath } from './drive';
import { checkNavigable, hostAllowed, safeVaultPath } from './guard';
import { getGoogleToken } from './identity';
import { shrinkJpeg, toDataUrl, type Jpeg } from './image';

type Json = Record<string, unknown>;
type DownloadItem = { id: number; url: string; finalUrl?: string; filename?: string; state?: string; mime?: string };

/** What the run loop gets back: the brain's result (with `screenshot_b64`) and a small thumbnail for the panel. */
export interface ToolOutcome {
  result: Json;
  screenshot?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** captureVisibleTab quota is 2/s per extension; results with screenshots are spaced at least this far apart. */
const CAPTURE_GAP_MS = 550;
let lastCaptureAt = 0;

function waitForLoad(tabId: number, timeoutMs = 20000): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      browser.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve();
    };
    const listener = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    browser.tabs.onUpdated.addListener(listener);
    void browser.tabs.get(tabId).then((t) => t.status === 'complete' && done()).catch(done);
  });
}

async function contentTool<T = Json>(tabId: number, req: Json, attempts = 3): Promise<T> {
  for (let i = 0; ; i++) {
    let res: { ok: true; data: unknown } | { ok: false; error: string } | undefined;
    try {
      res = (await browser.tabs.sendMessage(tabId, { channel: TOOL_CHANNEL, ...req }, { frameId: 0 })) as typeof res;
    } catch (e) {
      // The content script is injected at document_idle: right after a navigation it may not be listening yet.
      if (i < attempts - 1) {
        await sleep(400);
        continue;
      }
      throw new Error(`page has no content script (chrome:// page, or still loading): ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res) throw new Error('page has no content script (chrome:// or not loaded yet)');
    if (!res.ok) throw new Error(res.error);
    return (typeof res.data === 'object' && res.data !== null ? res.data : { result: res.data }) as T;
  }
}

// ---------- click-triggered downloads: remember every item the browser starts, so download(ref) can claim it ----------

const recentDownloads: DownloadItem[] = [];
const downloadWaiters = new Set<(d: DownloadItem) => void>();

/** Call once from the background entrypoint (listeners must be registered synchronously at worker start). */
export function watchDownloads() {
  browser.downloads.onCreated.addListener((item) => {
    const d: DownloadItem = { id: item.id, url: item.url, finalUrl: item.finalUrl, filename: item.filename, state: item.state, mime: item.mime };
    recentDownloads.push(d);
    if (recentDownloads.length > 20) recentDownloads.shift();
    downloadWaiters.forEach((w) => w(d));
  });
}

function nextDownload(timeoutMs: number): Promise<DownloadItem> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      downloadWaiters.delete(waiter);
      reject(new Error(`no download started within ${Math.round(timeoutMs / 1000)}s — is the ref a file row/link?`));
    }, timeoutMs);
    const waiter = (d: DownloadItem) => {
      clearTimeout(timer);
      downloadWaiters.delete(waiter);
      resolve(d);
    };
    downloadWaiters.add(waiter);
  });
}

/** Best effort: the vault is Drive + the brain, so the browser's own copy in ~/Downloads is not needed. */
async function discardDownload(id: number) {
  try {
    const [item] = await browser.downloads.search({ id });
    if (item?.state === 'in_progress') await browser.downloads.cancel(id);
    else if (item?.state === 'complete') await browser.downloads.removeFile(id).catch(() => undefined);
    await browser.downloads.erase({ id });
  } catch {
    /* ignore */
  }
}

export interface ToolGuards {
  settings: Settings;
  /** Asks the user; resolves false when denied. Used for gates the brain cannot be trusted to apply. */
  confirm: (message: string) => Promise<boolean>;
  /** Audit line (run_js, downloads) — the background prints it and the panel could show it. */
  log?: (line: string) => void;
}

/**
 * Executes browser tool calls for one run (PLAN v2 §The loop). Keeps a "job tab" so the brain can work in
 * a pinned background tab without stealing the user's focus. Enforces the user's permissions client-side:
 * URL scheme + navigation allow-list, vault-confined paths, ask-before gates, run_js only on allow-listed hosts.
 * Every result carries `screenshot_b64` (JPEG ≤1280px) when settings.vision is on.
 */
export class BrowserTools {
  private jobTabId: number | null = null;
  private drive: DriveClient | null = null;

  constructor(private guards: ToolGuards) {}

  private get settings() {
    return this.guards.settings;
  }

  /** In show-work mode the job tab is brought to the front before every action. */
  private async reveal(tabId: number) {
    if (!this.settings.showWork) return;
    const t = await browser.tabs.get(tabId);
    if (!t.active) await browser.tabs.update(tabId, { active: true });
  }

  private navigable(raw: string): string {
    const r = checkNavigable(raw, this.settings.permissions.navigationAllowlist);
    if (!r.ok) throw new Error(`blocked: ${r.reason}`);
    return r.url.href;
  }

  private async tab(): Promise<number> {
    if (this.jobTabId !== null) {
      try {
        await browser.tabs.get(this.jobTabId);
        return this.jobTabId;
      } catch {
        this.jobTabId = null;
      }
    }
    const [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (!active?.id) throw new Error('no active tab');
    return active.id;
  }

  private async tabInfo(tabId: number): Promise<Json> {
    const t = await browser.tabs.get(tabId);
    return { tabId, title: t.title, url: t.url };
  }

  /** JPEG of the tab's viewport, ≤1280px, q≈0.55. Null when the page cannot be captured (chrome://, closed). */
  private async capture(tabId: number): Promise<Jpeg | null> {
    // Chrome allows 2 captureVisibleTab calls per second: space them out and retry once more on the quota error.
    for (let attempt = 0; ; attempt++) {
      const wait = lastCaptureAt + CAPTURE_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      lastCaptureAt = Date.now();
      try {
        const t = await browser.tabs.get(tabId);
        if (!t.active) {
          await browser.tabs.update(tabId, { active: true });
          await sleep(120);
        }
        const dataUrl = await browser.tabs.captureVisibleTab(t.windowId, { format: 'jpeg', quality: 55 });
        return await shrinkJpeg(dataUrl, 1280, 0.55);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND/.test(msg) && attempt < 3) {
          await sleep(CAPTURE_GAP_MS);
          continue;
        }
        this.guards.log?.(`screenshot failed: ${msg}`);
        return null;
      }
    }
  }

  /** Attaches the screenshot (brain: `screenshot_b64`; panel: ≤320px thumbnail) when vision is on or forced. */
  private async withShot(tabId: number | null, data: Json, force = false): Promise<ToolOutcome> {
    if (tabId === null || (!force && !this.settings.vision)) return { result: data };
    const shot = await this.capture(tabId);
    if (!shot) return { result: data };
    const thumb = await shrinkJpeg(toDataUrl(shot), 320, 0.6).catch(() => null);
    return {
      result: { ...data, screenshot_b64: shot.b64, screenshot_size: [shot.width, shot.height] },
      screenshot: thumb ? toDataUrl(thumb) : undefined,
    };
  }

  async execute(call: ToolCall): Promise<ToolOutcome> {
    try {
      const out = await this.dispatch(call);
      return { ...out, result: { status: 'success', ...out.result } };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const extra = e instanceof ToolError ? e.extra : {};
      return { result: { status: 'error', message, ...extra } };
    }
  }

  private async dispatch(call: ToolCall): Promise<ToolOutcome> {
    const a = call.args;
    const str = (k: string, d = '') => (typeof a[k] === 'string' ? (a[k] as string) : typeof a[k] === 'number' ? String(a[k]) : d);
    const num = (k: string, d: number) => (typeof a[k] === 'number' ? (a[k] as number) : typeof a[k] === 'string' && a[k] !== '' && !Number.isNaN(Number(a[k])) ? Number(a[k]) : d);
    switch (call.name) {
      case 'open_tab': {
        const show = this.settings.showWork;
        const t = await browser.tabs.create({ url: this.navigable(str('url')), pinned: !show && a.pinned === true, active: show || a.active === true });
        if (!t.id) throw new Error('tab has no id');
        this.jobTabId = t.id;
        await waitForLoad(t.id);
        return this.withShot(t.id, await this.tabInfo(t.id));
      }
      case 'navigate': {
        const id = await this.tab();
        await this.reveal(id);
        await browser.tabs.update(id, { url: this.navigable(str('url')) });
        await waitForLoad(id);
        return this.withShot(id, await this.tabInfo(id));
      }
      case 'read_page': {
        const id = await this.tab();
        await this.reveal(id);
        const snap = await contentTool<{ text: string; nodes: number; truncated: boolean }>(id, { name: 'snapshot', maxNodes: num('max_nodes', 400) });
        return this.withShot(id, { ...(await this.tabInfo(id)), result: snap.text, nodes: snap.nodes, truncated: snap.truncated, summary: `${snap.nodes} elements${snap.truncated ? ' (truncated)' : ''}` });
      }
      case 'screenshot': {
        const id = await this.tab();
        await this.reveal(id);
        const out = await this.withShot(id, await this.tabInfo(id), true);
        if (!out.result.screenshot_b64) throw new Error('could not capture this tab');
        return out;
      }
      case 'click': {
        const id = await this.tab();
        await this.reveal(id);
        const r = await contentTool(id, { name: 'click', ref: str('ref') });
        await sleep(400);
        await waitForLoad(id, 5000);
        return this.withShot(id, { ...r, ...(await this.tabInfo(id)) });
      }
      case 'click_at': {
        const id = await this.tab();
        await this.reveal(id);
        const r = await contentTool(id, { name: 'click_at', x: num('x', 0), y: num('y', 0) });
        await sleep(400);
        await waitForLoad(id, 5000);
        return this.withShot(id, { ...r, ...(await this.tabInfo(id)) });
      }
      case 'type':
      case 'type_text': {
        const id = await this.tab();
        await this.reveal(id);
        const r = await contentTool(id, { name: 'type', ref: str('ref'), text: str('text'), submit: a.submit === true });
        if (a.submit === true) {
          await sleep(400);
          await waitForLoad(id, 5000);
        }
        return this.withShot(id, r);
      }
      case 'press_key': {
        const id = await this.tab();
        await this.reveal(id);
        const r = await contentTool(id, { name: 'press_key', key: str('key', 'Enter') });
        await sleep(400);
        await waitForLoad(id, 5000);
        return this.withShot(id, { ...r, ...(await this.tabInfo(id)) });
      }
      case 'scroll': {
        const id = await this.tab();
        await this.reveal(id);
        const r = await contentTool(id, { name: 'scroll', ref: str('ref') || undefined, dy: num('dy', 600) });
        await sleep(250);
        return this.withShot(id, r);
      }
      case 'set_viewport': {
        const id = await this.tab();
        await this.reveal(id);
        const width = Math.min(Math.max(num('width', 1280), 800), 1920);
        const height = Math.min(Math.max(num('height', 900), 600), 1200);
        const t = await browser.tabs.get(id);
        const win = await browser.windows.get(t.windowId);
        const before = await contentTool<{ width: number; height: number }>(id, { name: 'viewport' });
        const dw = (win.width ?? width) - before.width;
        const dh = (win.height ?? height) - before.height;
        await browser.windows.update(t.windowId, { state: 'normal', width: width + Math.max(0, dw), height: height + Math.max(0, dh) });
        await sleep(300);
        const after = await contentTool<{ width: number; height: number }>(id, { name: 'viewport' });
        return this.withShot(id, { viewport: [after.width, after.height], requested: [width, height] });
      }
      case 'run_js': {
        const id = await this.tab();
        const t = await browser.tabs.get(id);
        const host = t.url ? new URL(t.url).hostname : '';
        if (!host || !hostAllowed(host, this.settings.permissions.navigationAllowlist)) throw new Error(`run_js is only allowed on allow-listed hosts (${host || 'unknown host'} is not)`);
        const expression = str('expression') || str('code');
        if (!expression) throw new Error('run_js needs an expression');
        this.guards.log?.(`run_js on ${host}: ${expression.slice(0, 200)}`);
        const [frame] = await browser.scripting.executeScript({
          target: { tabId: id },
          world: 'MAIN',
          func: (src: string) => {
            try {
              // eslint-disable-next-line no-eval
              const v: unknown = (0, eval)(src);
              return { ok: true, value: JSON.parse(JSON.stringify(v === undefined ? null : v)) as unknown };
            } catch (e) {
              return { ok: false, error: String(e) };
            }
          },
          args: [expression],
        });
        const r = frame?.result as { ok: boolean; value?: unknown; error?: string } | undefined;
        if (!r) throw new Error('run_js returned nothing (page CSP may block eval)');
        if (!r.ok) throw new Error(`run_js: ${r.error}`);
        const value = r.value;
        const text = JSON.stringify(value);
        return this.withShot(id, { value: text.length > 20000 ? `${text.slice(0, 20000)}…` : value, host, logged: true, summary: text.slice(0, 100) });
      }
      case 'wait': {
        const id = await this.tab().catch(() => null);
        await sleep(Math.min(Math.max(num('ms', 1000), 100), 15000));
        if (id !== null) await waitForLoad(id, 3000);
        return this.withShot(id, { waited: true });
      }
      case 'download':
        return this.download(str('path'), str('ref'), str('url'));
      case 'list_tabs': {
        const tabs = await browser.tabs.query({});
        return { result: { tabs: tabs.slice(0, 30).map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })) } };
      }
      default:
        throw new Error(`unknown browser tool ${call.name}`);
    }
  }

  // ---------- download → Drive + brain vault ----------

  private async fetchBytes(url: string): Promise<{ blob: Blob; name: string }> {
    const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
    if (!res.ok) throw new Error(`GET ${url} → HTTP ${res.status}`);
    const blob = await res.blob();
    if (blob.size === 0) throw new Error(`GET ${url} returned no bytes`);
    return { blob, name: fileNameFromHeaders(res.headers, res.url || url) };
  }

  /** Bytes for `download`: a direct URL, or the URL of the download the page starts when `ref` is clicked. */
  private async captureBytes(ref: string, url: string): Promise<{ blob: Blob; name: string; source: string }> {
    if (url) {
      const src = this.navigable(url);
      return { ...(await this.fetchBytes(src)), source: src };
    }
    const id = await this.tab();
    await this.reveal(id);
    if (ref) {
      const { href } = await contentTool<{ href?: string }>(id, { name: 'href', ref });
      if (href && checkNavigable(href, this.settings.permissions.navigationAllowlist).ok && !/\.(html?|php|aspx?)$/i.test(new URL(href).pathname)) {
        const got = await this.fetchBytes(href).catch(() => null);
        if (got && !got.blob.type.startsWith('text/html')) return { ...got, source: href };
      }
    }
    let item: DownloadItem;
    if (ref) {
      // Vaadin file browsers differ: some start the download when the row is clicked, others only from a
      // download icon inside the row. Try the ref itself, then the controls inside it, then those in its row.
      const attempts: Json[] = [{ name: 'click', ref }, { name: 'activate', ref }, { name: 'activate', ref, row: true }];
      let got: DownloadItem | null = null;
      for (const [i, req] of attempts.entries()) {
        const pending = nextDownload(i === attempts.length - 1 ? 12000 : 6000);
        pending.catch(() => undefined);
        const r = await contentTool<{ activated?: string[] }>(id, req).catch((): { activated?: string[] } => ({}));
        if (req.name === 'activate' && !(r.activated?.length ?? 0)) continue; // nothing to click inside
        got = await pending.catch(() => null);
        if (got) break;
      }
      if (!got) throw new Error('no download started after clicking the ref and the controls inside its row — is the ref a file row/link? (try the row\'s download icon, or download(url=…))');
      item = got;
    } else {
      const pending = nextDownload(20000);
      pending.catch(() => undefined);
      item = await pending;
    }
    const src = item.finalUrl || item.url;
    if (!checkNavigable(src, this.settings.permissions.navigationAllowlist).ok) {
      await discardDownload(item.id);
      throw new Error(`the page started a download from ${src}, which is not on your allow-list`);
    }
    this.guards.log?.(`download captured from ${src}`);
    try {
      const got = await this.fetchBytes(src);
      // Chrome names a repeated download "file (1).pdf"; the vault wants the portal's own file name.
      const name = item.filename?.split(/[\\/]/).pop()?.replace(/ \(\d+\)(\.[^.]+)$/, '$1') || got.name;
      return { blob: got.blob, name, source: src };
    } finally {
      await discardDownload(item.id);
    }
  }

  private async download(requestedPath: string, ref: string, url: string): Promise<ToolOutcome> {
    const s = this.settings;
    if (!ref && !url) throw new Error('download needs a ref (file row/link) or a url');
    if (s.permissions.askBefore.download && !(await this.guards.confirm(`Download ${url || ref} → vault/${requestedPath || '?'}?`))) {
      throw new Error('download denied by user');
    }
    const { blob, name, source } = await this.captureBytes(ref, url);
    const rel = requestedPath && !/[\\/]$/.test(requestedPath) ? requestedPath : `${requestedPath}/${name}`;
    const drivePath = safeVaultPath(s.vaultFolder, rel);
    const rootSegs = splitDrivePath(safeVaultPath(s.vaultFolder, 'x')).length - 1;
    const brainPath = splitDrivePath(drivePath).slice(rootSegs).join('/');
    const fileName = brainPath.split('/').pop() ?? name;
    const mime = blob.type && blob.type !== 'application/octet-stream' ? blob.type : mimeFor(fileName);

    let drive: { id?: string; link?: string; error?: string } = {};
    if (s.vaultMode === 'drive') {
      try {
        const token = await getGoogleToken(s);
        this.drive ??= new DriveClient({ base: s.driveApiBase, token });
        const f = await this.drive.upload(drivePath, blob, mime);
        drive = { id: f.id, link: f.webViewLink };
      } catch (e) {
        drive = { error: e instanceof Error ? e.message : String(e) };
      }
    }

    let vault: { id?: string; error?: string; summary?: string } = {};
    if (s.token && s.backendUrl) {
      try {
        const fd = new FormData();
        fd.set('path', brainPath);
        fd.set('file', new File([blob], fileName, { type: mime }));
        if (drive.id) fd.set('drive_file_id', drive.id);
        const res = await fetch(`${s.backendUrl.replace(/\/+$/, '')}/vault/upload`, { method: 'POST', headers: { authorization: `Bearer ${s.token}` }, body: fd });
        if (!res.ok) throw new Error(`POST /vault/upload → HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
        const entry = (await res.json()) as { id?: string; summary?: string };
        vault = { id: entry.id, summary: entry.summary };
      } catch (e) {
        vault = { error: e instanceof Error ? e.message : String(e) };
      }
    } else vault = { error: 'brain not configured (backend URL + token)' };

    const base: Json = { path: brainPath, drive_path: drivePath, bytes: blob.size, name: fileName, source, drive_file_id: drive.id ?? null, drive_link: drive.link ?? null, vault_id: vault.id ?? null };
    if (vault.summary) base.summary = vault.summary;
    if (s.vaultMode === 'drive' && drive.error) throw new ToolError(`Drive upload failed: ${drive.error}${vault.id ? ' (the brain kept a copy)' : ''}`, base);
    if (vault.error && s.vaultMode === 'brain') throw new ToolError(`vault upload failed: ${vault.error}`, base);
    if (vault.error) base.vault_error = vault.error;
    const id = await this.tab().catch(() => null);
    return this.withShot(id, { ...base, summary: `${fileName} · ${(blob.size / 1024).toFixed(0)} KB${drive.id ? ' → Drive' : ''}${vault.id ? ' → indexed' : ''}` });
  }
}

class ToolError extends Error {
  constructor(
    message: string,
    readonly extra: Json,
  ) {
    super(message);
  }
}
