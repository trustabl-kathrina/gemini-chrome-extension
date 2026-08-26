import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { DEFAULT_SETTINGS, PANEL_PORT, type PanelMessage, type PanelRequest, type Settings } from '../protocol';
import { answerConfirm, applyEvent, newRun, type Run } from '../state/runs';

type Port = ReturnType<typeof browser.runtime.connect>;

/** Settings persisted in chrome.storage.local; defaults fill any missing field. */
export function useSettings() {
  const [settings, setSettingsState] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void browser.storage.local.get('settings').then(({ settings: stored }) => {
      setSettingsState({ ...DEFAULT_SETTINGS, ...(stored as Partial<Settings> | undefined) });
      setLoaded(true);
    });
  }, []);

  const setSettings = useCallback((update: Partial<Settings> | ((s: Settings) => Settings)) => {
    setSettingsState((prev) => {
      const next = typeof update === 'function' ? update(prev) : { ...prev, ...update };
      void browser.storage.local.set({ settings: next });
      return next;
    });
  }, []);

  return { settings, setSettings, loaded };
}

/** Long-lived port to the background; runs are folded with the pure reducer. */
export function useAgent() {
  const [runs, setRuns] = useState<Record<string, Run>>({});
  const portRef = useRef<Port | null>(null);

  useEffect(() => {
    let alive = true;
    const connect = () => {
      if (!alive) return;
      const port = browser.runtime.connect({ name: PANEL_PORT });
      port.onMessage.addListener((raw: unknown) => {
        const m = raw as PanelMessage;
        if (m.type !== 'event') return;
        setRuns((prev) => {
          const run = prev[m.runId] ?? newRun(m.runId, '…', undefined, Date.now());
          return { ...prev, [m.runId]: applyEvent(run, m.event) };
        });
      });
      port.onDisconnect.addListener(() => {
        portRef.current = null;
        setTimeout(connect, 400);
      });
      portRef.current = port;
    };
    connect();
    return () => {
      alive = false;
      portRef.current?.disconnect();
    };
  }, []);

  const post = useCallback((req: PanelRequest) => portRef.current?.postMessage(req), []);

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
