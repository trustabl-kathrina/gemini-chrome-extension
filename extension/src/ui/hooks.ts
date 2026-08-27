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
  post: (req: PanelRequest) => boolean;
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
    post: (req) => {
      if (!port) return false;
      try {
        port.postMessage(req);
        return true;
      } catch {
        return false;
      }
    },
    dispose: () => {
      alive = false;
      port?.disconnect();
    },
  };
}

const CHAT_KEY = 'chatId';

/**
 * chrome.storage.session is the right lifetime for a conversation (survives closing the panel, dies with the
 * browser) — but it needs Chrome 102+, so fall back to `local` where it is missing.
 */
function chatStore() {
  return browser.storage.session ?? browser.storage.local;
}

/** Runs folded with the pure reducer; events arrive over the background port. */
export function useAgent() {
  const [runs, setRuns] = useState<Record<string, Run>>({});
  // One chat = one brain session shared by every run typed here, so follow-ups see the earlier turns.
  const [chatId, setChatId] = useState('');
  const chatIdRef = useRef('');
  const transport = useRef<Transport | null>(null);

  const persistChat = useCallback((id: string) => {
    chatIdRef.current = id;
    setChatId(id);
    if (inExtension) void chatStore().set({ [CHAT_KEY]: id }).catch((e: unknown) => console.warn('[dayflow] chat id save failed', e));
  }, []);

  /** Minted on first use, so a run started before storage answers cannot be orphaned by a late stored id. */
  const currentChatId = useCallback(() => {
    if (!chatIdRef.current) persistChat(crypto.randomUUID());
    return chatIdRef.current;
  }, [persistChat]);

  useEffect(() => {
    if (!inExtension) return;
    let live = true;
    void chatStore()
      .get(CHAT_KEY)
      .then((r) => {
        const stored = r[CHAT_KEY];
        // Skip when a chat is already in play: the panel committed to it before this read came back.
        if (!live || chatIdRef.current || typeof stored !== 'string' || !stored) return;
        chatIdRef.current = stored;
        setChatId(stored);
      })
      .catch((e: unknown) => console.warn('[dayflow] chat id load failed', e));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!inExtension) return;
    const onMessage = (m: PanelMessage) => {
      if (m.type !== 'event') return;
      const sessionId = currentChatId(); // resolved outside the updater: setRuns must stay pure
      setRuns((prev) => {
        const run = prev[m.runId] ?? newRun(m.runId, sessionId, m.event.kind === 'run.start' ? m.event.title : '…', undefined, Date.now());
        return { ...prev, [m.runId]: applyEvent(run, m.event) };
      });
    };
    transport.current = portTransport(onMessage);
    return () => transport.current?.dispose();
  }, [currentChatId]);

  const post = useCallback((req: PanelRequest) => transport.current?.post(req) ?? false, []);

  const start = useCallback(
    (text: string, skillId?: string) => {
      const runId = crypto.randomUUID();
      const sessionId = currentChatId();
      setRuns((prev) => ({ ...prev, [runId]: newRun(runId, sessionId, text, skillId, Date.now()) }));
      if (!post({ type: 'run.start', runId, sessionId, skillId, text })) {
        setRuns((prev) => {
          const run = prev[runId];
          return run ? { ...prev, [runId]: applyEvent(run, { kind: 'run.end', status: 'error', summary: 'Extension background is reconnecting. Try again in a moment.' }) } : prev;
        });
      }
      return runId;
    },
    [post, currentChatId],
  );

  const pause = useCallback((runId: string) => {
    setRuns((prev) => {
      const run = prev[runId];
      return run ? { ...prev, [runId]: applyEvent(run, { kind: 'run.pause' }) } : prev;
    });
    post({ type: 'run.pause', runId });
  }, [post]);
  const resume = useCallback((runId: string) => {
    setRuns((prev) => {
      const run = prev[runId];
      return run ? { ...prev, [runId]: applyEvent(run, { kind: 'run.resume' }) } : prev;
    });
    post({ type: 'run.resume', runId });
  }, [post]);
  const cancel = useCallback((runId: string) => {
    setRuns((prev) => {
      const run = prev[runId];
      return run ? { ...prev, [runId]: applyEvent(run, { kind: 'run.end', status: 'cancelled', summary: 'Cancelled' }) } : prev;
    });
    post({ type: 'run.cancel', runId });
  }, [post]);

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

  /** Fresh conversation: stop whatever is still in flight (it belongs to the old chat) and clear the transcript. */
  const newChat = useCallback(() => {
    for (const run of Object.values(runs)) if (run.status === 'running' || run.status === 'paused') post({ type: 'run.cancel', runId: run.id });
    persistChat(crypto.randomUUID());
    setRuns({});
  }, [post, runs, persistChat]);

  return { runs, chatId, start, newChat, pause, resume, cancel, answer };
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
