import { ArrowLeft, FileCode2, Monitor, Moon, Search, Settings as SettingsIcon, Sun } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fromUserConfig, pullConfig, syncFingerprint } from '../agent/sync';
import { Chat } from './Chat';
import { CommandPalette, commandsFromSkills, type Command } from './CommandPalette';
import { ConfigView } from './Config';
import { SettingsView } from './Settings';
import { Sparkle } from './Sparkle';
import { inExtension, useAgent, useHotkey, useSettings } from './hooks';
import { IconButton, Pill } from './primitives';
import { useTheme } from './theme';

type View = 'chat' | 'settings' | 'config';
const TITLES: Record<View, string> = { chat: 'Dayflow', settings: 'Settings', config: 'Config' };
const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;

export function App() {
  const { settings, setSettings, loaded } = useSettings();
  const { runs, start, cancel, answer } = useAgent();
  const [view, setView] = useState<View>('chat');
  const [palette, setPalette] = useState(false);
  const [theme, , cycleTheme] = useTheme();

  const runSkill = useCallback(
    (id: string) => {
      const skill = settings.skills.find((s) => s.id === id);
      if (!skill) return;
      setView('chat');
      start(skill.prompt, skill.id);
    },
    [settings.skills, start],
  );
  const runText = useCallback(
    (text: string) => {
      setView('chat');
      start(text);
    },
    [start],
  );

  useHotkey('k', useCallback(() => setPalette((p) => !p), []));

  // The brain owns skills/sites/permissions: refresh the panel's cached slices once per open.
  useEffect(() => {
    if (!loaded || !settings.token) return;
    void pullConfig(settings)
      .then((cfg) => {
        // An empty brain (fresh deploy, no pack) has nothing to teach the panel; keep the local defaults.
        if (!cfg || !cfg.skills?.length) return;
        setSettings((s) => {
          const next = fromUserConfig(cfg, s);
          return syncFingerprint(next) === syncFingerprint(s) ? s : next;
        });
      })
      .catch((e: unknown) => console.warn('[dayflow] config pull failed', e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded]);

  const commands = useMemo<Command[]>(
    () => [
      ...commandsFromSkills(settings.skills, runSkill),
      { id: 'nav:chat', title: 'Chat', hint: 'Back to the transcript', run: () => setView('chat') },
      { id: 'nav:config', title: 'Config', hint: 'Edit skills, sites, permissions, schedules (YAML)', run: () => setView('config') },
      { id: 'nav:settings', title: 'Settings', hint: 'Google account, brain, vision, Drive', run: () => setView('settings') },
      { id: 'nav:theme', title: `Theme: ${theme}`, hint: 'Cycle system → light → dark', run: cycleTheme },
    ],
    [settings.skills, runSkill, theme, cycleTheme],
  );

  const anyRunning = Object.values(runs).some((r) => r.status === 'running');
  const ThemeIcon = THEME_ICON[theme];

  if (!inExtension) {
    return (
      <div className="bloom flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Sparkle size={28} />
        <p className="text-fg">Dayflow runs as a Chrome side panel.</p>
        <p className="text-[12px] text-fg-3">Load the unpacked build from extension/.output/chrome-mv3 and click the toolbar icon.</p>
      </div>
    );
  }

  return (
    <div className="bloom relative flex h-full flex-col">
      <header className="flex h-12 items-center gap-1 px-2">
        {view !== 'chat' ? (
          <IconButton label="Back" onClick={() => setView('chat')}>
            <ArrowLeft size={16} />
          </IconButton>
        ) : (
          <span className="ml-1 inline-flex h-7 w-7 items-center justify-center">
            <Sparkle size={18} />
          </span>
        )}
        <span className="ml-0.5 text-[15px] font-medium tracking-tight">{TITLES[view]}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <Pill tone={settings.token ? 'ok' : 'warn'} pulse={anyRunning}>
            {anyRunning ? 'working' : settings.token ? 'ready' : 'no brain'}
          </Pill>
          <IconButton label={`Theme: ${theme} (click to change)`} onClick={cycleTheme} data-theme-toggle>
            <ThemeIcon size={16} />
          </IconButton>
          <IconButton label="Search (⌘K)" onClick={() => setPalette(true)}>
            <Search size={16} />
          </IconButton>
          <IconButton label="Config" onClick={() => setView(view === 'config' ? 'chat' : 'config')} className={view === 'config' ? 'bg-bg-2 text-fg' : ''}>
            <FileCode2 size={16} />
          </IconButton>
          <IconButton label="Settings" onClick={() => setView(view === 'settings' ? 'chat' : 'settings')} className={view === 'settings' ? 'bg-bg-2 text-fg' : ''}>
            <SettingsIcon size={16} />
          </IconButton>
        </div>
      </header>

      {view === 'chat' && <Chat settings={settings} runs={runs} onSubmit={runText} onRunSkill={runSkill} onCancel={cancel} onAnswer={answer} />}
      {view === 'settings' && (
        <div className="flex-1 overflow-y-auto">
          <SettingsView settings={settings} update={(fn) => setSettings(fn)} />
        </div>
      )}
      {view === 'config' && loaded && <ConfigView key={`${settings.backendUrl}|${settings.token}`} settings={settings} update={(fn) => setSettings(fn)} />}

      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
    </div>
  );
}
