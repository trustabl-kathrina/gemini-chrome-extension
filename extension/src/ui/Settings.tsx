import { Check, LogOut, RefreshCw, X } from 'lucide-react';
import { useState } from 'react';
import { DriveClient } from '../agent/drive';
import { driveConfigured, getGoogleToken, refreshGoogleToken, signIn, signOut } from '../agent/identity';
import { brainAuthHeader, brainUrl } from '../agent/sync';
import { effectiveVaultMode, type Settings, type VaultMode } from '../protocol';
import { Button, Field, Toggle, inputCls } from './primitives';

type Update = (fn: (s: Settings) => Settings) => void;
type Probe = { state: 'idle' } | { state: 'busy' } | { state: 'ok'; text: string } | { state: 'err'; text: string };

function ProbeLine({ p }: { p: Probe }) {
  if (p.state === 'idle') return null;
  if (p.state === 'busy') return <span className="text-[11px] text-fg-3">checking…</span>;
  return (
    <span className={`inline-flex items-center gap-1 text-[11px] ${p.state === 'ok' ? 'text-ok' : 'text-err'}`}>
      {p.state === 'ok' ? <Check size={11} /> : <X size={11} />}
      <span className="break-all">{p.text}</span>
    </span>
  );
}

/** One screen: Google account, brain URL + token, perception toggles, Drive status. Skills/sites/permissions live in Config. */
export function SettingsView({ settings, update }: { settings: Settings; update: Update }) {
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => update((s) => ({ ...s, [k]: v }));
  const [auth, setAuth] = useState<Probe>({ state: 'idle' });
  const [brain, setBrain] = useState<Probe>({ state: 'idle' });
  const [drive, setDrive] = useState<Probe>({ state: 'idle' });
  const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
  // No VITE_GOOGLE_CLIENT_ID in this build → chrome.identity cannot sign in at all, and the vault runs on the brain.
  const googleReady = driveConfigured();
  const mode = effectiveVaultMode(settings, googleReady);

  const doSignIn = async () => {
    setAuth({ state: 'busy' });
    try {
      const p = await signIn();
      update((s) => ({
        ...s,
        account: { email: p.email, name: p.name, token: p.token, expiresAt: Date.now() + 50 * 60 * 1000 },
        connections: s.connections.map((c) => (c.id === 'drive' ? { ...c, connected: true, account: p.email } : c)),
      }));
      setAuth({ state: 'ok', text: `signed in as ${p.email}` });
    } catch (e) {
      setAuth({ state: 'err', text: `${msg(e)} — without an OAuth client, switch the vault to “brain”.` });
    }
  };
  const doSignOut = async () => {
    await signOut(settings.account?.token);
    update((s) => ({ ...s, account: null, driveToken: undefined, connections: s.connections.map((c) => (c.id === 'drive' ? { ...c, connected: false, account: undefined } : c)) }));
    setAuth({ state: 'idle' });
    setDrive({ state: 'idle' });
  };
  const checkBrain = async () => {
    setBrain({ state: 'busy' });
    try {
      const r = await fetch(brainUrl(settings, '/health'), { headers: brainAuthHeader(settings) });
      const j = (await r.json()) as { ok?: boolean; service?: string; firestore?: boolean };
      if (!r.ok || !j.ok) throw new Error(`HTTP ${r.status}`);
      const cfg = await fetch(brainUrl(settings, '/config'), { headers: brainAuthHeader(settings) });
      setBrain(cfg.ok ? { state: 'ok', text: `${j.service ?? 'brain'} · firestore ${j.firestore ? 'on' : 'off'} · token accepted` } : { state: 'err', text: `reachable, but the token was rejected (HTTP ${cfg.status})` });
    } catch (e) {
      setBrain({ state: 'err', text: msg(e) });
    }
  };
  const checkDrive = async () => {
    setDrive({ state: 'busy' });
    try {
      const token = await getGoogleToken(settings, true);
      const client = new DriveClient({ base: settings.driveApiBase, token, onUnauthorized: (stale) => refreshGoogleToken(settings, stale) });
      const me = await client.about().catch(() => ({}) as { emailAddress?: string });
      const items = await client.list(settings.vaultFolder);
      setDrive({ state: 'ok', text: `${me.emailAddress ?? 'connected'} · ${settings.vaultFolder}/ has ${items.length} item${items.length === 1 ? '' : 's'}` });
    } catch (e) {
      setDrive({ state: 'err', text: msg(e) });
    }
  };

  return (
    <div className="flex flex-col gap-4 p-3">
      <Field label="Google account" hint="Used for Google Drive (the vault) via chrome.identity — scope drive.file only.">
        {settings.account ? (
          <div className="hairline flex items-center gap-2 rounded-md bg-bg-1 px-3 py-2">
            <span className="h-1.5 w-1.5 rounded-full bg-ok" />
            <span className="min-w-0 flex-1 truncate">
              {settings.account.email || 'signed in'}
              {settings.account.name && <span className="text-fg-3"> · {settings.account.name}</span>}
            </span>
            <Button onClick={() => void doSignOut()}>
              <LogOut size={12} /> Sign out
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Button variant="primary" onClick={() => void doSignIn()} disabled={auth.state === 'busy' || !googleReady}>
                Sign in with Google
              </Button>
              {settings.driveToken && <span className="text-[11px] text-fg-3">using a provided token</span>}
            </div>
            {!googleReady && (
              <span className="text-[11px] text-warn">
                Drive not configured — this build has no OAuth client. Put VITE_GOOGLE_CLIENT_ID in extension/.env, rebuild, and reload the extension. Until then the vault stays on the brain.
              </span>
            )}
          </div>
        )}
        <ProbeLine p={auth} />
      </Field>

      <Field label="Brain" hint="Point at http://127.0.0.1:8080 to run the brain on your own machine (DAYFLOW_TOKEN=dev).">
        <div className="flex flex-col gap-1.5">
          <input className={`${inputCls} font-mono text-[12px]`} placeholder="https://…run.app" value={settings.backendUrl} onChange={(e) => set('backendUrl', e.target.value.trim())} aria-label="Backend URL" />
          <div className="flex items-center gap-1.5">
            <input type="password" className={`${inputCls} font-mono text-[12px]`} placeholder="access token" value={settings.token} onChange={(e) => set('token', e.target.value.trim())} aria-label="Access token" />
            <Button onClick={() => void checkBrain()} disabled={brain.state === 'busy'} aria-label="Check brain">
              <RefreshCw size={12} /> Check
            </Button>
          </div>
          <ProbeLine p={brain} />
        </div>
      </Field>

      <Field label="Perception">
        <div className="hairline flex flex-col rounded-md bg-bg-1">
          <div className="flex items-center gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div>Vision</div>
              <div className="text-[11px] text-fg-3">Attach a screenshot to every browser action so Gemini sees what happened.</div>
            </div>
            <Toggle checked={settings.vision} onChange={(v) => set('vision', v)} label="Vision" />
          </div>
          <div className="hairline-t flex items-center gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div>Show work</div>
              <div className="text-[11px] text-fg-3">Keep the agent's tab in front of its group and flash what it clicks.</div>
            </div>
            <Toggle checked={settings.showWork} onChange={(v) => set('showWork', v)} label="Show work" />
          </div>
          <div className="hairline-t flex items-center gap-2 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div>Own window</div>
              <div className="text-[11px] text-fg-3">
                The agent's tabs form a "Dayflow" tab group. On: the group opens in its own window, so screenshots never switch the tab you are looking at. Off: the group joins your current window.
              </div>
            </div>
            <Toggle checked={settings.ownWindow} onChange={(v) => set('ownWindow', v)} label="Own window" />
          </div>
        </div>
      </Field>

      <Field label="Vault" hint="Drive: files go to your Google Drive and the brain indexes them. Brain: brain storage only (no OAuth client needed).">
        <div className="flex flex-col gap-1.5">
          <div className="hairline inline-flex w-fit rounded-md bg-bg-1 p-0.5">
            {(['drive', 'brain'] as VaultMode[]).map((m) => (
              <button key={m} onClick={() => set('vaultMode', m)} className={`h-6 rounded-sm px-3 text-[12px] ${mode === m ? 'bg-bg-2 text-fg' : 'text-fg-3'}`} title={m === 'drive' && !googleReady && !settings.driveToken ? 'Drive not configured in this build' : undefined}>
                {m === 'drive' ? 'Google Drive' : 'Brain only'}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5">
            <input className={`${inputCls} font-mono text-[12px]`} value={settings.vaultFolder} onChange={(e) => set('vaultFolder', e.target.value)} aria-label="Drive folder" placeholder="Dayflow" />
            <Button onClick={() => void checkDrive()} disabled={drive.state === 'busy' || mode !== 'drive'} aria-label="Check Drive">
              <RefreshCw size={12} /> Drive
            </Button>
          </div>
          <div className="flex items-center gap-2 text-[11px] text-fg-3">
            <span className={`h-1.5 w-1.5 rounded-full ${mode === 'drive' ? (settings.account || settings.driveToken ? 'bg-ok' : 'bg-warn') : 'bg-fg-3'}`} />
            {mode === 'drive'
              ? settings.account?.email
                ? `Drive as ${settings.account.email}`
                : settings.driveToken
                  ? 'Drive with a provided token'
                  : 'Drive: sign in above first'
              : settings.vaultMode === 'drive'
                ? 'Drive not configured — falling back to the brain vault'
                : 'Drive off — files stay in the brain'}
          </div>
          <ProbeLine p={drive} />
          <details className="text-[11px] text-fg-3">
            <summary className="cursor-pointer select-none">Advanced</summary>
            <div className="mt-1.5 flex flex-col gap-1.5">
              <input className={`${inputCls} font-mono text-[11.5px]`} value={settings.driveApiBase} onChange={(e) => set('driveApiBase', e.target.value.trim())} aria-label="Drive API base" placeholder="https://www.googleapis.com" />
              <input className={`${inputCls} font-mono text-[11.5px]`} type="password" value={settings.driveToken ?? ''} onChange={(e) => set('driveToken', e.target.value.trim() || undefined)} aria-label="Drive token override" placeholder="OAuth token override (optional)" />
            </div>
          </details>
        </div>
      </Field>
    </div>
  );
}
