import { liveRun } from '@/src/agent/live';
import { mockRun } from '@/src/agent/mock';
import { BrowserTools } from '@/src/agent/tools';
import { DEFAULT_SETTINGS, PANEL_PORT, type AgentEvent, type PanelMessage, type PanelRequest, type Settings } from '@/src/protocol';

/** One in-flight run: cancellation + pending confirmations. */
interface Active {
  abort: AbortController;
  confirms: Map<string, (allow: boolean) => void>;
}

const active = new Map<string, Active>();

async function loadSettings(): Promise<Settings> {
  const { settings } = await browser.storage.local.get('settings');
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
}

async function startRun(req: Extract<PanelRequest, { type: 'run.start' }>, post: (m: PanelMessage) => void) {
  const abort = new AbortController();
  const confirms = new Map<string, (allow: boolean) => void>();
  active.set(req.runId, { abort, confirms });
  const settings = await loadSettings();
  const send = (event: AgentEvent) => post({ type: 'event', runId: req.runId, event });
  const waitForConfirm = (id: string) => new Promise<boolean>((resolve) => confirms.set(id, resolve));

  try {
    const stream =
      settings.mode === 'live'
        ? liveRun(settings, req, { signal: abort.signal, waitForConfirm, executeTool: (call) => new BrowserTools(settings.vaultFolder).execute(call) })
        : mockRun(req.skillId, req.text, { signal: abort.signal, waitForConfirm });
    for await (const ev of stream) send(ev);
  } catch (e) {
    send({ kind: 'run.end', status: 'error', summary: e instanceof Error ? e.message : String(e) });
  } finally {
    active.delete(req.runId);
  }
}

export default defineBackground(() => {
  browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PANEL_PORT) return;
    const post = (m: PanelMessage) => {
      try {
        port.postMessage(m);
      } catch {
        /* panel closed; the run keeps going */
      }
    };
    port.onMessage.addListener((raw: unknown) => {
      const msg = raw as PanelRequest;
      switch (msg.type) {
        case 'run.start':
          void startRun(msg, post);
          break;
        case 'run.cancel':
          active.get(msg.runId)?.abort.abort();
          break;
        case 'confirm.answer': {
          const a = active.get(msg.runId);
          a?.confirms.get(msg.confirmId)?.(msg.allow);
          a?.confirms.delete(msg.confirmId);
          break;
        }
      }
    });
  });

  // Scheduled skills land here once the scheduler is wired (chrome.alarms → run.start).
  browser.alarms.onAlarm.addListener((alarm) => {
    console.log('[dayflow] alarm', alarm.name);
  });
});
