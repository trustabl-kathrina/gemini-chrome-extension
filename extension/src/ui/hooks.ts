import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { mockRun } from '../agent/mock';
import { DEFAULT_SETTINGS, PANEL_PORT, type PanelMessage, type PanelRequest, type Settings } from '../protocol';
import { answerConfirm, applyEvent, newRun, type Run } from '../state/runs';

type Port = ReturnType<typeof browser.runtime.connect>;

/** True inside the real extension; false when the panel is opened as a plain page (design preview). */
const inExtension = (() => {
  try {
    return typeof browser !== 'undefined' && !!browser.runtime?.id;
  } catch {
    return false;
  }
})();

const KEY = 'settings';

async function loadStored(): Promise<Partial<Settings> | undefined> {
  if (inExtension) return (await browser.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  const raw = localStorage.getItem(KEY);
  return raw ? (JSON.parse(raw) as Partial<Settings>) : undefined;
}

function persist(next: Settings) {
  if (inExtension) void browser.storage.local.set({ [KEY]: next });
  else localStorage.setItem(KEY, JSON.stringify(next));
}

/** Settings persisted in chrome.storage.local; defaults fill any missing field. */
export function useSettings() {
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void loadStored().then((stored) => {
      setSettingsState({ ...DEFAULT_SETTINGS, ...stored });
      setLoaded(true);
    });
  }, []);

  const setSettings = useCallback((update: Partial<Settings> | ((s: Settings) => Settings)) => {
    setSettingsState((prev) => {
      const next = typeof update === 'function' ? update(prev) : { ...prev, ...update };
      persist(next);
      return next;
    });
  }, []);

  return { settings, setSettings, loaded };
}

/** Transport to whatever executes runs: the background port, or an in-page mock when previewing. */
interface Transport {
  post: (req: PanelRequest) => void;
  dispose: () => void;
}

function portTransport(onMessage: (m: PanelMessage) => void): Transport {
  let port: Port | null = null;
  let alive = true;
  const connect = () => {
    if (!alive) return;
    port = browser.runtime.connect({ name: PANEL_PORT });
    port.onMessage.addListener((raw: unknown) => onMessage(raw as PanelMessage));
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 400);
    });
  };
  connect();
  return {
    post: (req) => port?.postMessage(req),
    dispose: () => {
      alive = false;
      port?.disconnect();
    },
  };
}

function inPageTransport(onMessage: (m: PanelMessage) => void): Transport {
  const active = new Map<string, { abort: AbortController; confirms: Map<string, (allow: boolean) => void> }>();
  return {
    post: (req) => {
      if (req.type === 'run.start') {
        const abort = new AbortController();
        const confirms = new Map<string, (allow: boolean) => void>();
        active.set(req.runId, { abort, confirms });
        void (async () => {
          const stream = mockRun(req.skillId, req.text, {
            signal: abort.signal,
            waitForConfirm: (id) => new Promise<boolean>((resolve) => confirms.set(id, resolve)),
          });
          for await (const event of stream) onMessage({ type: 'event', runId: req.runId, event });
          active.delete(req.runId);
        })();
      } else if (req.type === 'run.cancel') {
        active.get(req.runId)?.abort.abort();
      } else {
        active.get(req.runId)?.confirms.get(req.confirmId)?.(req.allow);
      }
    },
    dispose: () => active.forEach((a) => a.abort.abort()),
  };
}

/** Runs folded with the pure reducer; transport chosen by environment. */
export function useAgent() {
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const transport = useRef<Transport | null>(null);

  useEffect(() => {
    const onMessage = (m: PanelMessage) => {
      if (m.type !== 'event') return;
      setRuns((prev) => {
        const run = prev[m.runId] ?? newRun(m.runId, '…', undefined, Date.now());
        return { ...prev, [m.runId]: applyEvent(run, m.event) };
      });
    };
    transport.current = inExtension ? portTransport(onMessage) : inPageTransport(onMessage);
    return () => transport.current?.dispose();
  }, []);

  const post = useCallback((req: PanelRequest) => transport.current?.post(req), []);

  const start = useCallback(
    (text: string, skillId?: string) => {
      const runId = crypto.randomUUID();
      setRuns((prev) => ({ ...prev, [runId]: newRun(runId, text, skillId, Date.now()) }));
      post({ type: 'run.start', runId, skillId, text });
      return runId;
    },
    [post],
  );

  const cancel = useCallback((runId: string) => post({ type: 'run.cancel', runId }), [post]);

  const answer = useCallback(
    (runId: string, confirmId: string, allow: boolean) => {
      setRuns((prev) => {
        const run = prev[runId];
        return run ? { ...prev, [runId]: answerConfirm(run, confirmId, allow) } : prev;
      });
      post({ type: 'confirm.answer', runId, confirmId, allow });
    },
    [post],
  );

  return { runs, start, cancel, answer };
}

/** Global keyboard shortcut (⌘K / Ctrl+K). */
export function useHotkey(key: string, handler: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === key) {
        e.preventDefault();
        handler();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [key, handler]);
}
