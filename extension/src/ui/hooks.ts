import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, normalizeSettings, PANEL_PORT, type PanelMessage, type PanelRequest, type Settings } from '../protocol';
import { answerConfirm, applyEvent, newRun, type Run } from '../state/runs';

type Port = ReturnType<typeof browser.runtime.connect>;

/** The panel only works inside the extension (chrome.storage, the background port, chrome.identity). */
export const inExtension = (() => {
  try {
    return typeof browser !== 'undefined' && !!browser.runtime?.id;
  } catch {
    return false;
  }
})();

const KEY = 'settings';

/** Settings persisted in chrome.storage.local; defaults fill any missing field; external writes are picked up. */
export function useSettings() {
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const lastWritten = useRef<string>('');

  useEffect(() => {
    if (!inExtension) return;
    void browser.storage.local.get(KEY).then((r) => {
      setSettingsState(normalizeSettings(r[KEY]));
      setLoaded(true);
    });
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area !== 'local' || !changes[KEY]) return;
      const raw = JSON.stringify(changes[KEY].newValue ?? null);
      if (raw === lastWritten.current) return; // our own write
      setSettingsState(normalizeSettings(changes[KEY].newValue));
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, []);

  const setSettings = useCallback((update: Partial<Settings> | ((s: Settings) => Settings)) => {
    setSettingsState((prev) => {
      const next = typeof update === 'function' ? update(prev) : { ...prev, ...update };
      lastWritten.current = JSON.stringify(next);
      if (inExtension) void browser.storage.local.set({ [KEY]: next });
      return next;
    });
  }, []);

  return { settings, setSettings, loaded };
}

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

/** Runs folded with the pure reducer; events arrive over the background port. */
export function useAgent() {
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const transport = useRef<Transport | null>(null);

  useEffect(() => {
    if (!inExtension) return;
    const onMessage = (m: PanelMessage) => {
      if (m.type !== 'event') return;
      setRuns((prev) => {
        const run = prev[m.runId] ?? newRun(m.runId, m.event.kind === 'run.start' ? m.event.title : '…', undefined, Date.now());
        return { ...prev, [m.runId]: applyEvent(run, m.event) };
      });
    };
    transport.current = portTransport(onMessage);
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
