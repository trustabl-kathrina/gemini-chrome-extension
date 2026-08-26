import { ConfirmBox } from '@/src/agent/confirm';
import { liveRun } from '@/src/agent/live';
import { BrowserTools, watchDownloads } from '@/src/agent/tools';
import { notify, skillIdFromAlarm, syncAlarms } from '@/src/agent/scheduler';
import { pushConfig, syncFingerprint } from '@/src/agent/sync';
import { normalizeSettings, PANEL_PORT, type AgentEvent, type PanelMessage, type PanelRequest, type Settings } from '@/src/protocol';

/** One in-flight run: cancellation + confirmation answers (kept until the loop asks for them). */
interface Active {
  abort: AbortController;
  confirms: ConfirmBox;
}

const active = new Map<string, Active>();
const panels = new Set<ReturnType<typeof browser.runtime.connect>>();

async function loadSettings(): Promise<Settings> {
  const { settings } = await browser.storage.local.get('settings');
  return normalizeSettings(settings);
}

async function startRun(req: Extract<PanelRequest, { type: 'run.start' }>, post: (m: PanelMessage) => void, background = false) {
  const abort = new AbortController();
  const confirms = new ConfirmBox();
  active.set(req.runId, { abort, confirms });
  const settings = await loadSettings();
  const send = (event: AgentEvent) => post({ type: 'event', runId: req.runId, event });
  const waitForConfirm = (id: string) => confirms.wait(id);

  try {
    // Client-side gate: surfaces a confirm card in the panel and waits for the answer.
    const confirm = (message: string) => {
      const id = `g-${crypto.randomUUID()}`;
      send({ kind: 'confirm', id, message });
      return waitForConfirm(id);
    };
    const tools = new BrowserTools({ settings, confirm, emit: send, log: (line) => console.log('[dayflow]', line) });
    const stream = liveRun(settings, req, { signal: abort.signal, waitForConfirm, executeTool: (call) => tools.execute(call) });
    for await (const ev of stream) {
      send(ev);
      if (background && ev.kind === 'run.end') notify(ev.status === 'done' ? 'Dayflow finished a scheduled skill' : `Dayflow: ${ev.status}`, ev.summary);
    }
  } catch (e) {
    send({ kind: 'run.end', status: 'error', summary: e instanceof Error ? e.message : String(e) });
  } finally {
    active.delete(req.runId);
  }
}

export default defineBackground(() => {
  watchDownloads();
  browser.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PANEL_PORT) return;
    panels.add(port);
    port.onDisconnect.addListener(() => panels.delete(port));
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
        case 'confirm.answer':
          active.get(msg.runId)?.confirms.answer(msg.confirmId, msg.allow);
          break;
      }
    });
  });

  // Scheduled skills: one alarm per skill, re-armed after each firing and whenever settings change.
  const rearm = () => void loadSettings().then(syncAlarms);
  browser.runtime.onInstalled.addListener(rearm);
  browser.runtime.onStartup.addListener(rearm);
  // Settings → brain: when the slices the brain owns a copy of change, debounce and PUT /config.
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  const syncConfig = () => {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      void loadSettings()
        .then(pushConfig)
        .then((r) => r !== 'skipped' && console.log('[dayflow] config sync', r))
        .catch((e: unknown) => console.warn('[dayflow] config sync failed', e));
    }, 800);
  };
  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    rearm();
    const before = changes.settings.oldValue ? syncFingerprint(normalizeSettings(changes.settings.oldValue)) : '';
    const after = syncFingerprint(normalizeSettings(changes.settings.newValue));
    const next = normalizeSettings(changes.settings.newValue);
    const prev = changes.settings.oldValue ? normalizeSettings(changes.settings.oldValue) : null;
    if (before !== after || !prev || prev.token !== next.token || prev.backendUrl !== next.backendUrl) syncConfig();
  });
  browser.alarms.onAlarm.addListener(async (alarm) => {
    const skillId = skillIdFromAlarm(alarm.name);
    if (!skillId) return;
    const settings = await loadSettings();
    const skill = settings.skills.find((s) => s.id === skillId);
    if (skill?.enabled) {
      const runId = crypto.randomUUID();
      const post = (m: PanelMessage) => panels.forEach((p) => { try { p.postMessage(m); } catch { /* closed */ } });
      void startRun({ type: 'run.start', runId, skillId, text: skill.prompt }, post, true);
    }
    await syncAlarms(settings);
  });
});
