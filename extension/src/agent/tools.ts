import { browser } from 'wxt/browser';
import { TOOL_CHANNEL, type ToolCall } from '../protocol';

type ToolResult = Record<string, unknown>;
type DownloadDelta = Parameters<Parameters<typeof browser.downloads.onChanged.addListener>[0]>[0];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    void browser.tabs.get(tabId).then((t) => t.status === 'complete' && done());
  });
}

async function contentTool(tabId: number, req: Record<string, unknown>): Promise<ToolResult> {
  const res = (await browser.tabs.sendMessage(tabId, { channel: TOOL_CHANNEL, ...req }, { frameId: 0 })) as
    | { ok: true; data: unknown }
    | { ok: false; error: string }
    | undefined;
  if (!res) throw new Error('page has no content script (chrome:// or not loaded yet)');
  if (!res.ok) throw new Error(res.error);
  return typeof res.data === 'object' && res.data !== null ? (res.data as ToolResult) : { result: res.data };
}

/**
 * Executes browser tool calls for one run. Keeps a "job tab" so the brain can work in a
 * pinned background tab without stealing the user's focus.
 */
export class BrowserTools {
  private jobTabId: number | null = null;

  constructor(private vaultFolder: string) {}

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

  async execute(call: ToolCall): Promise<ToolResult> {
    try {
      const data = await this.dispatch(call);
      return { status: 'success', ...data };
    } catch (e) {
      return { status: 'error', message: e instanceof Error ? e.message : String(e) };
    }
  }

  private async dispatch(call: ToolCall): Promise<ToolResult> {
    const a = call.args;
    const str = (k: string, d = '') => (typeof a[k] === 'string' ? (a[k] as string) : d);
    const num = (k: string, d: number) => (typeof a[k] === 'number' ? (a[k] as number) : d);
    switch (call.name) {
      case 'open_tab': {
        const t = await browser.tabs.create({ url: str('url'), pinned: a.pinned === true, active: a.active === true });
        if (!t.id) throw new Error('tab has no id');
        this.jobTabId = t.id;
        await waitForLoad(t.id);
        const fresh = await browser.tabs.get(t.id);
        return { tabId: t.id, title: fresh.title, url: fresh.url };
      }
      case 'navigate': {
        const id = await this.tab();
        await browser.tabs.update(id, { url: str('url') });
        await waitForLoad(id);
        const t = await browser.tabs.get(id);
        return { tabId: id, title: t.title, url: t.url };
      }
      case 'read_page': {
        const id = await this.tab();
        return contentTool(id, { name: 'snapshot', maxNodes: num('max_nodes', 400) });
      }
      case 'click': {
        const id = await this.tab();
        const r = await contentTool(id, { name: 'click', ref: str('ref') });
        await sleep(400);
        await waitForLoad(id, 5000);
        return r;
      }
      case 'type': {
        const id = await this.tab();
        return contentTool(id, { name: 'type', ref: str('ref'), text: str('text'), submit: a.submit === true });
      }
      case 'scroll': {
        const id = await this.tab();
        return contentTool(id, { name: 'scroll', ref: a.ref, dy: num('dy', 600) });
      }
      case 'wait': {
        await sleep(Math.min(num('ms', 1000), 10000));
        return { waited: true };
      }
      case 'screenshot': {
        const id = await this.tab();
        const t = await browser.tabs.get(id);
        const wasActive = t.active;
        if (!wasActive) await browser.tabs.update(id, { active: true });
        try {
          const dataUrl = await browser.tabs.captureVisibleTab(t.windowId, { format: 'jpeg', quality: 70 });
          return { image_data_url: dataUrl };
        } finally {
          if (!wasActive) {
            const [prev] = await browser.tabs.query({ windowId: t.windowId, active: false });
            if (prev?.id) await browser.tabs.update(prev.id, { active: true });
          }
        }
      }
      case 'download': {
        const filename = `${this.vaultFolder}/${str('path').replace(/^\/+/, '')}`;
        const id = await browser.downloads.download({ url: str('url'), filename, conflictAction: 'overwrite', saveAs: false });
        await new Promise<void>((resolve, reject) => {
          const l = (d: DownloadDelta) => {
            if (d.id !== id) return;
            if (d.state?.current === 'complete') {
              browser.downloads.onChanged.removeListener(l);
              resolve();
            } else if (d.state?.current === 'interrupted') {
              browser.downloads.onChanged.removeListener(l);
              reject(new Error(d.error?.current ?? 'download interrupted'));
            }
          };
          browser.downloads.onChanged.addListener(l);
        });
        const [item] = await browser.downloads.search({ id });
        return { path: item?.filename, bytes: item?.fileSize };
      }
      case 'list_tabs': {
        const tabs = await browser.tabs.query({});
        return { tabs: tabs.slice(0, 30).map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active })) };
      }
      default:
        throw new Error(`unknown browser tool ${call.name}`);
    }
  }
}
