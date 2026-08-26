import { Download, Plus, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { DEFAULT_SKILLS, type Connection, type Settings, type SiteProfile, type Skill } from '../protocol';
import { Button, Field, Toggle, inputCls } from './primitives';

export type SettingsTab = 'skills' | 'sites' | 'connections' | 'permissions' | 'schedules' | 'advanced';
export const SETTINGS_TABS: { id: SettingsTab; label: string }[] = [
  { id: 'skills', label: 'Skills' },
  { id: 'sites', label: 'Sites' },
  { id: 'connections', label: 'Connections' },
  { id: 'permissions', label: 'Permissions' },
  { id: 'schedules', label: 'Schedules' },
  { id: 'advanced', label: 'Advanced' },
];

type Update = (fn: (s: Settings) => Settings) => void;

const list = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);

// ---------------- Skills ----------------

function SkillEditor({ skill, onChange, onDelete }: { skill: Skill; onChange: (s: Skill) => void; onDelete?: () => void }) {
  const set = <K extends keyof Skill>(k: K, v: Skill[K]) => onChange({ ...skill, [k]: v });
  return (
    <div className="flex flex-col gap-2.5 px-3 pb-3 pt-1">
      <Field label="Title">
        <input className={inputCls} value={skill.title} onChange={(e) => set('title', e.target.value)} />
      </Field>
      <Field label="Prompt" hint="Sent as the opening message when you run the skill.">
        <textarea className={inputCls} rows={2} value={skill.prompt} onChange={(e) => set('prompt', e.target.value)} />
      </Field>
      <Field label="Instructions" hint="Injected into the agent's system prompt for this run.">
        <textarea className={`${inputCls} font-mono text-[12px]`} rows={5} value={skill.instructions} onChange={(e) => set('instructions', e.target.value)} />
      </Field>
      <Field label="Tools" hint="Comma-separated. * = all tools your permissions allow.">
        <input className={`${inputCls} font-mono text-[12px]`} value={skill.tools.join(', ')} onChange={(e) => set('tools', list(e.target.value))} />
      </Field>
      <Field label="Sites" hint="Domains in scope; their site profiles are loaded.">
        <input className={`${inputCls} font-mono text-[12px]`} value={skill.sites.join(', ')} onChange={(e) => set('sites', list(e.target.value))} />
      </Field>
      <Field label="Schedule (cron)" hint="Leave empty to run only on demand.">
        <input className={`${inputCls} font-mono text-[12px]`} placeholder="0 8 * * 1-5" value={skill.schedule ?? ''} onChange={(e) => set('schedule', e.target.value.trim() || null)} />
      </Field>
      {onDelete && (
        <div className="flex justify-end">
          <Button variant="danger" onClick={onDelete}>
            <Trash2 size={13} /> Delete skill
          </Button>
        </div>
      )}
    </div>
  );
}

function SkillsTab({ settings, update }: { settings: Settings; update: Update }) {
  const [open, setOpen] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const setSkill = (id: string, next: Skill) => update((s) => ({ ...s, skills: s.skills.map((k) => (k.id === id ? next : k)) }));
  const add = () => {
    const id = `custom-${Date.now().toString(36)}`;
    const skill: Skill = { id, title: 'New skill', blurb: '', prompt: '', instructions: '', tools: ['*'], sites: [], schedule: null, pack: 'custom', enabled: true };
    update((s) => ({ ...s, skills: [...s.skills, skill] }));
    setOpen(id);
  };
  const remove = (id: string) => update((s) => ({ ...s, skills: s.skills.filter((k) => k.id !== id) }));
  const exportJson = () => {
    const blob = new Blob([JSON.stringify(settings.skills, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    void browser.downloads.download({ url, filename: 'dayflow-skills.json', saveAs: true });
  };
  const importJson = async (f: File | undefined) => {
    if (!f) return;
    const parsed: unknown = JSON.parse(await f.text());
    if (!Array.isArray(parsed)) return;
    const incoming = parsed.filter((x): x is Skill => typeof x === 'object' && x !== null && 'id' in x && 'title' in x);
    update((s) => ({ ...s, skills: [...s.skills.filter((k) => !incoming.some((i) => i.id === k.id)), ...incoming] }));
  };
  const reset = () => update((s) => ({ ...s, skills: [...DEFAULT_SKILLS, ...s.skills.filter((k) => k.pack === 'custom')] }));

  return (
    <div className="flex flex-col gap-1 p-2">
      <div className="flex items-center gap-1.5 pb-1">
        <Button variant="primary" onClick={add}>
          <Plus size={13} /> New skill
        </Button>
        <Button onClick={exportJson}>
          <Download size={13} /> Export
        </Button>
        <Button onClick={() => file.current?.click()}>
          <Upload size={13} /> Import
        </Button>
        <input ref={file} type="file" accept="application/json" className="hidden" onChange={(e) => void importJson(e.target.files?.[0])} />
        <Button className="ml-auto" onClick={reset}>
          Reset pack
        </Button>
      </div>
      {settings.skills.map((k) => (
        <div key={k.id} className="hairline rounded-md bg-bg-1">
          <div className="flex items-center gap-2 px-3 py-2">
            <Toggle checked={k.enabled} onChange={(v) => setSkill(k.id, { ...k, enabled: v })} label={`Enable ${k.title}`} />
            <button className="min-w-0 flex-1 truncate text-left font-medium tracking-tight" onClick={() => setOpen(open === k.id ? null : k.id)}>
              {k.title}
            </button>
            <span className="text-[11px] text-fg-3">{k.pack}</span>
          </div>
          {open === k.id && <SkillEditor skill={k} onChange={(n) => setSkill(k.id, n)} onDelete={k.pack === 'custom' ? () => remove(k.id) : undefined} />}
        </div>
      ))}
    </div>
  );
}

// ---------------- Sites ----------------

function SitesTab({ settings, update }: { settings: Settings; update: Update }) {
  const setSite = (domain: string, next: SiteProfile) => update((s) => ({ ...s, sites: s.sites.map((x) => (x.domain === domain ? next : x)) }));
  const addCurrent = async () => {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    const domain = tab?.url ? new URL(tab.url).hostname : '';
    if (!domain || settings.sites.some((x) => x.domain === domain)) return;
    update((s) => ({ ...s, sites: [...s.sites, { domain, notes: '', allow: true }] }));
  };
  const remove = (domain: string) => update((s) => ({ ...s, sites: s.sites.filter((x) => x.domain !== domain) }));
  return (
    <div className="flex flex-col gap-1 p-2">
      <p className="px-1 pb-1 text-fg-2">Notes the agent reads when it works on a domain — like a CLAUDE.md per site.</p>
      <div className="pb-1">
        <Button variant="primary" onClick={() => void addCurrent()}>
          <Plus size={13} /> Add current site
        </Button>
      </div>
      {settings.sites.map((x) => (
        <div key={x.domain} className="hairline flex flex-col gap-2 rounded-md bg-bg-1 p-3">
          <div className="flex items-center gap-2">
            <span className="flex-1 font-mono text-[12px]">{x.domain}</span>
            <span className="text-[11px] text-fg-3">allow</span>
            <Toggle checked={x.allow} onChange={(v) => setSite(x.domain, { ...x, allow: v })} label={`Allow ${x.domain}`} />
            <button onClick={() => remove(x.domain)} aria-label="Remove" className="text-fg-3 hover:text-err">
              <Trash2 size={13} />
            </button>
          </div>
          <textarea className={inputCls} rows={2} placeholder="Where things are, what buttons are called, what to avoid…" value={x.notes} onChange={(e) => setSite(x.domain, { ...x, notes: e.target.value })} />
        </div>
      ))}
    </div>
  );
}

// ---------------- Connections ----------------

function ConnectionsTab({ settings, update }: { settings: Settings; update: Update }) {
  const toggle = (c: Connection) =>
    update((s) => ({
      ...s,
      connections: s.connections.map((x) => (x.id === c.id ? { ...x, connected: !x.connected, account: x.connected ? undefined : 'mock@dayflow' } : x)),
    }));
  return (
    <div className="flex flex-col gap-1 p-2">
      <p className="px-1 pb-1 text-fg-2">One-click OAuth; tokens live in the backend, never in the extension. You already act as yourself in the browser — connections only add APIs.</p>
      {settings.connections.map((c) => (
        <div key={c.id} className="hairline flex items-center gap-2 rounded-md bg-bg-1 px-3 py-2">
          <span className={`h-1.5 w-1.5 rounded-full ${c.connected ? 'bg-ok' : 'bg-fg-3'}`} />
          <span className="flex-1 font-medium tracking-tight">{c.label}</span>
          <span className="text-[11px] text-fg-3">{c.account ?? 'not connected'}</span>
          <Button variant={c.connected ? 'ghost' : 'primary'} onClick={() => toggle(c)}>
            {c.connected ? 'Disconnect' : 'Connect'}
          </Button>
        </div>
      ))}
    </div>
  );
}

// ---------------- Permissions ----------------

function PermissionsTab({ settings, update }: { settings: Settings; update: Update }) {
  const p = settings.permissions;
  const setAsk = (k: keyof Settings['permissions']['askBefore'], v: boolean) =>
    update((s) => ({ ...s, permissions: { ...s.permissions, askBefore: { ...s.permissions.askBefore, [k]: v } } }));
  const rows: { k: keyof Settings['permissions']['askBefore']; label: string }[] = [
    { k: 'sendMessage', label: 'Sending a message on my behalf' },
    { k: 'createPr', label: 'Opening a pull request or issue' },
    { k: 'download', label: 'Downloading files into the vault' },
  ];
  return (
    <div className="flex flex-col gap-3 p-3">
      <Field label="Navigation allow-list" hint="One domain per line. The brain refuses to navigate anywhere else.">
        <textarea className={`${inputCls} font-mono text-[12px]`} rows={6} value={p.navigationAllowlist.join('\n')} onChange={(e) => update((s) => ({ ...s, permissions: { ...s.permissions, navigationAllowlist: list(e.target.value) } }))} />
      </Field>
      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-fg-3">Always ask before</span>
        {rows.map((r) => (
          <div key={r.k} className="hairline flex items-center gap-2 rounded-md bg-bg-1 px-3 py-2">
            <span className="flex-1">{r.label}</span>
            <Toggle checked={p.askBefore[r.k]} onChange={(v) => setAsk(r.k, v)} label={r.label} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------- Schedules ----------------

function SchedulesTab({ settings, update }: { settings: Settings; update: Update }) {
  const setSchedule = (id: string, schedule: string | null) => update((s) => ({ ...s, skills: s.skills.map((k) => (k.id === id ? { ...k, schedule } : k)) }));
  return (
    <div className="flex flex-col gap-1 p-2">
      <p className="px-1 pb-1 text-fg-2">Scheduled skills run in the background and notify you (Telegram or Chrome) when done.</p>
      {settings.skills.map((k) => (
        <div key={k.id} className="hairline flex items-center gap-2 rounded-md bg-bg-1 px-3 py-2">
          <Toggle checked={k.schedule !== null} onChange={(v) => setSchedule(k.id, v ? '0 8 * * 1-5' : null)} label={`Schedule ${k.title}`} />
          <span className="min-w-0 flex-1 truncate">{k.title}</span>
          <input className={`${inputCls} w-28 font-mono text-[11px]`} disabled={k.schedule === null} value={k.schedule ?? ''} onChange={(e) => setSchedule(k.id, e.target.value)} />
        </div>
      ))}
    </div>
  );
}

// ---------------- Advanced ----------------

function AdvancedTab({ settings, update }: { settings: Settings; update: Update }) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => update((s) => ({ ...s, [k]: v }));
  return (
    <div className="flex flex-col gap-3 p-3">
      <Field label="Account">
        {settings.account ? (
          <div className="hairline flex items-center gap-2 rounded-md bg-bg-1 px-3 py-2">
            <span className="flex-1">{settings.account.email}</span>
            <Button onClick={() => set('account', null)}>Sign out</Button>
          </div>
        ) : (
          <Button variant="primary" onClick={() => set('account', { email: 'student@kbtu.kz', name: 'Student' })}>
            Sign in with Google
          </Button>
        )}
      </Field>
      <Field label="Mode" hint="Mock plays scripted runs without a backend.">
        <div className="hairline inline-flex w-fit rounded-md bg-bg-1 p-0.5">
          {(['mock', 'live'] as const).map((m) => (
            <button key={m} onClick={() => set('mode', m)} className={`h-6 rounded-sm px-3 text-[12px] ${settings.mode === m ? 'bg-bg-2 text-fg' : 'text-fg-3'}`}>
              {m}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Backend URL" hint="Point at http://localhost:8080 to run the brain on your own machine.">
        <input className={`${inputCls} font-mono text-[12px]`} value={settings.backendUrl} onChange={(e) => set('backendUrl', e.target.value)} />
      </Field>
      <Field label="Access token">
        <input type="password" className={`${inputCls} font-mono text-[12px]`} value={settings.token} onChange={(e) => set('token', e.target.value)} />
      </Field>
      <Field label="Show work" hint="Keep the agent's tab in front and flash the elements it clicks. Turn off to let it work in a pinned background tab.">
        <div className="hairline flex items-center gap-2 rounded-md bg-bg-1 px-3 py-2">
          <span className="flex-1">Watch the agent navigate</span>
          <Toggle checked={settings.showWork} onChange={(v) => set('showWork', v)} label="Show work" />
        </div>
      </Field>
      <Field label="Vault folder" hint="Inside your Downloads folder.">
        <input className={`${inputCls} font-mono text-[12px]`} value={settings.vaultFolder} onChange={(e) => set('vaultFolder', e.target.value)} />
      </Field>
    </div>
  );
}

export function SettingsView({ tab, settings, update }: { tab: SettingsTab; settings: Settings; update: Update }) {
  switch (tab) {
    case 'skills':
      return <SkillsTab settings={settings} update={update} />;
    case 'sites':
      return <SitesTab settings={settings} update={update} />;
    case 'connections':
      return <ConnectionsTab settings={settings} update={update} />;
    case 'permissions':
      return <PermissionsTab settings={settings} update={update} />;
    case 'schedules':
      return <SchedulesTab settings={settings} update={update} />;
    case 'advanced':
      return <AdvancedTab settings={settings} update={update} />;
  }
}
