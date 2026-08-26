import { AlertCircle, Check, RotateCcw, Save } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { parseConfigYaml, toConfigYaml } from '../agent/config';
import { brainUrl, fromUserConfig, pullConfig, toUserConfig, type UserConfig } from '../agent/sync';
import { DEFAULT_SETTINGS, type Settings } from '../protocol';
import { Button } from './primitives';

type Update = (fn: (s: Settings) => Settings) => void;

/**
 * YAML editor of the brain's UserConfig (skills / sites / permissions / schedules / memory). Loaded from
 * GET /config, validated client-side as you type, saved with PUT /config; the panel's cached slices follow.
 */
export function ConfigView({ settings, update }: { settings: Settings; update: Update }) {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [status, setStatus] = useState<{ tone: 'neutral' | 'ok' | 'err'; text: string }>({ tone: 'neutral', text: '' });
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => parseConfigYaml(text), [text]);
  const dirty = text !== saved;
  const authed = { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' };

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const cfg = await pullConfig(settings);
      if (!cfg) throw new Error('set the backend URL and token in Settings first');
      const y = toConfigYaml(cfg);
      setText(y);
      setSaved(y);
      setStatus({ tone: 'neutral', text: `loaded from ${settings.backendUrl}` });
    } catch (e) {
      const y = toConfigYaml(toUserConfig(settings));
      setText(y);
      setSaved('');
      setStatus({ tone: 'err', text: `could not load from the brain (${e instanceof Error ? e.message : String(e)}); showing the panel's copy` });
    } finally {
      setBusy(false);
    }
  }, [settings]);

  useEffect(() => {
    void load();
    // load once per mount; the token/backend are edited in Settings, which remounts this view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async () => {
    if (!parsed.config) return;
    setBusy(true);
    try {
      const res = await fetch(brainUrl(settings, '/config'), { method: 'PUT', headers: authed, body: JSON.stringify(parsed.config) });
      if (!res.ok) throw new Error(`PUT /config → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const stored = (await res.json()) as UserConfig;
      const y = toConfigYaml(stored);
      setText(y);
      setSaved(y);
      update((s) => fromUserConfig(stored, s));
      setStatus({ tone: 'ok', text: `saved · ${stored.skills.length} skills · ${stored.sites.length} sites` });
    } catch (e) {
      setStatus({ tone: 'err', text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  /** Default pack: the brain's enabled skills (GET /skills) over the panel's default sites/permissions. Not saved until you press Save. */
  const resetToPack = async () => {
    setBusy(true);
    try {
      const base = toUserConfig({ ...DEFAULT_SETTINGS, vaultFolder: settings.vaultFolder });
      let skills = base.skills;
      try {
        const res = await fetch(brainUrl(settings, '/skills'), { headers: authed });
        if (res.ok) skills = (await res.json()) as UserConfig['skills'];
      } catch {
        /* offline: the panel's defaults */
      }
      setText(toConfigYaml({ ...base, skills }));
      setStatus({ tone: 'neutral', text: 'reset to the default pack — press Save to apply' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="hairline-b flex items-center gap-1.5 px-2 py-1.5">
        <span className="min-w-0 flex-1 truncate px-1 text-[11px] text-fg-3" title="The brain's UserConfig: skills, sites, permissions, schedules, memory">
          skills · sites · permissions · schedules · memory
        </span>
        <Button className="shrink-0 whitespace-nowrap" onClick={() => void resetToPack()} disabled={busy} title="Replace the editor with the default pack (not saved until you press Save)">
          <RotateCcw size={12} /> Reset to pack
        </Button>
        <Button className="shrink-0 whitespace-nowrap" variant="primary" onClick={() => void save()} disabled={busy || !parsed.config || !dirty || !settings.token} data-action="save-config">
          <Save size={12} /> Save
        </Button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        aria-label="Config YAML"
        data-config-editor
        className="min-h-0 flex-1 resize-none bg-transparent px-3 py-2 font-mono text-[11.5px] leading-[1.5] text-fg outline-none"
      />
      <div className="hairline-t flex flex-col gap-1 px-3 py-2 text-[11px]">
        {parsed.errors.length > 0 ? (
          <ul className="flex flex-col gap-0.5 text-err" data-config-errors>
            {parsed.errors.slice(0, 6).map((e) => (
              <li key={e} className="flex items-start gap-1">
                <AlertCircle size={11} className="mt-0.5 shrink-0" />
                <span className="break-all">{e}</span>
              </li>
            ))}
            {parsed.errors.length > 6 && <li className="text-fg-3">…and {parsed.errors.length - 6} more</li>}
          </ul>
        ) : (
          <span className="inline-flex items-center gap-1 text-ok">
            <Check size={11} /> valid{dirty ? ' · unsaved changes' : ''}
          </span>
        )}
        {status.text && <span className={status.tone === 'err' ? 'text-err' : status.tone === 'ok' ? 'text-ok' : 'text-fg-3'}>{status.text}</span>}
      </div>
    </div>
  );
}
