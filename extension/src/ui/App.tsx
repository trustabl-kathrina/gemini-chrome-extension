import { ArrowLeft, Search, Settings as SettingsIcon } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { CommandPalette, commandsFromSkills, type Command } from './CommandPalette';
import { Composer } from './Composer';
import { Home } from './Home';
import { RunView } from './RunView';
import { SETTINGS_TABS, SettingsView, type SettingsTab } from './Settings';
import { useAgent, useHotkey, useSettings } from './hooks';
import { IconButton, Pill } from './primitives';

type View = { name: 'home' } | { name: 'run'; id: string } | { name: 'settings'; tab: SettingsTab };

export function App() {
  const { settings, setSettings } = useSettings();
  const { runs, start, cancel, answer } = useAgent();
  const [view, setView] = useState<View>({ name: 'home' });
  const [palette, setPalette] = useState(false);

  const runSkill = useCallback(
    (id: string) => {
      const skill = settings.skills.find((s) => s.id === id);
      if (!skill) return;
      setView({ name: 'run', id: start(skill.prompt, skill.id) });
    },
    [settings.skills, start],
  );
  const runText = useCallback((text: string) => setView({ name: 'run', id: start(text) }), [start]);

  useHotkey('k', useCallback(() => setPalette((p) => !p), []));

  const commands = useMemo<Command[]>(
    () => [
      ...commandsFromSkills(settings.skills, runSkill),
      { id: 'nav:home', title: 'Go home', run: () => setView({ name: 'home' }) },
      ...SETTINGS_TABS.map((t) => ({ id: `nav:${t.id}`, title: `Settings → ${t.label}`, run: () => setView({ name: 'settings', tab: t.id }) })),
    ],
    [settings.skills, runSkill],
  );

  const activeRun = view.name === 'run' ? runs[view.id] : undefined;
  const anyRunning = Object.values(runs).some((r) => r.status === 'running');

  return (
    <div className="bloom relative flex h-full flex-col">
      <header className="hairline-b flex h-10 items-center gap-1 px-2">
        {view.name !== 'home' ? (
          <IconButton label="Back" onClick={() => setView({ name: 'home' })}>
            <ArrowLeft size={15} />
          </IconButton>
        ) : (
          <span className="ml-1.5 h-2 w-2 rounded-full bg-accent" />
        )}
        <span className="ml-1 font-medium tracking-tight">{view.name === 'settings' ? 'Settings' : 'Dayflow'}</span>
        <div className="ml-auto flex items-center gap-1">
          <Pill tone={settings.mode === 'live' ? 'ok' : 'neutral'} pulse={anyRunning}>
            {settings.mode}
          </Pill>
          <IconButton label="Search (⌘K)" onClick={() => setPalette(true)}>
            <Search size={15} />
          </IconButton>
          <IconButton label="Settings" onClick={() => setView({ name: 'settings', tab: 'skills' })}>
            <SettingsIcon size={15} />
          </IconButton>
        </div>
      </header>

      {view.name === 'settings' && (
        <nav className="hairline-b flex gap-0.5 overflow-x-auto px-2 py-1.5">
          {SETTINGS_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setView({ name: 'settings', tab: t.id })}
              className={`h-6 shrink-0 rounded-md px-2 text-[12px] transition-colors ${view.tab === t.id ? 'bg-bg-2 text-fg' : 'text-fg-3 hover:text-fg-2'}`}
            >
              {t.label}
            </button>
          ))}
        </nav>
      )}

      {view.name === 'home' && (
        <>
          <Home settings={settings} runs={Object.values(runs)} onRunSkill={runSkill} onOpenRun={(id) => setView({ name: 'run', id })} />
          <Composer placeholder="Ask Dayflow to do something in this tab…" onSubmit={runText} autoFocus />
        </>
      )}

      {view.name === 'run' && activeRun && (
        <>
          <RunView run={activeRun} onCancel={() => cancel(activeRun.id)} onAnswer={(cid, allow) => answer(activeRun.id, cid, allow)} />
          <Composer placeholder="Follow up…" onSubmit={runText} />
        </>
      )}

      {view.name === 'settings' && (
        <div className="flex-1 overflow-y-auto">
          <SettingsView tab={view.tab} settings={settings} update={(fn) => setSettings(fn)} />
        </div>
      )}

      {palette && <CommandPalette commands={commands} onClose={() => setPalette(false)} />}
    </div>
  );
}
