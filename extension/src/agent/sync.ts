import type { Settings, SiteMode } from '../protocol';

/**
 * Backend `UserConfig` (backend/dayflow/core/models.py). Kept structural so the mapper is testable and
 * so the harness can import this file straight into Node.
 */
export interface UserConfig {
  skills: Array<{
    id: string;
    title: string;
    blurb: string;
    prompt: string;
    instructions: string;
    tools: string[];
    sites: string[];
    schedule: string | null;
    pack: string;
    enabled: boolean;
    key: string;
  }>;
  sites: Array<{ domain: string; notes: string; allow: boolean; mode: SiteMode }>;
  permissions: { allowed_hosts: string[]; ask_before: string[]; mode: 'ask' | 'auto' };
  connections: { github: boolean; linear: boolean };
  vault_folder: string;
  memory?: string;
}

/** Panel toggles → brain tool names that need a confirmation credit. */
const ASK_BEFORE: Record<keyof Settings['permissions']['askBefore'], string[]> = {
  sendMessage: ['type', 'type_text'],
  createPr: ['create_pull_request', 'issue_write', 'create_issue'],
  download: ['download'],
  runJs: ['run_js'],
};

export function toUserConfig(s: Settings): UserConfig {
  const ask = (Object.keys(ASK_BEFORE) as Array<keyof typeof ASK_BEFORE>).flatMap((k) => (s.permissions.askBefore[k] ? ASK_BEFORE[k] : []));
  return {
    skills: s.skills.map((k) => ({ ...k, key: k.key ?? '' })),
    sites: s.sites.map(({ domain, notes, allow, mode }) => ({ domain, notes, allow, mode: mode ?? 'dom' })),
    permissions: { allowed_hosts: s.permissions.navigationAllowlist, ask_before: ask, mode: 'ask' },
    connections: {
      github: s.connections.some((c) => c.id === 'github' && c.connected),
      linear: s.connections.some((c) => c.id === 'linear' && c.connected),
    },
    vault_folder: s.vaultFolder,
  };
}

/** The brain's config → the panel's cached slices (palette, scheduler, guards). */
export function fromUserConfig(cfg: UserConfig, s: Settings): Settings {
  const ask = (names: string[]) => names.some((n) => cfg.permissions.ask_before.includes(n));
  return {
    ...s,
    skills: cfg.skills.map((k) => ({ ...k, schedule: k.schedule ?? null, key: k.key || undefined })),
    sites: cfg.sites.map((x) => ({ domain: x.domain, notes: x.notes, allow: x.allow, mode: x.mode ?? 'dom' })),
    permissions: {
      navigationAllowlist: cfg.permissions.allowed_hosts,
      askBefore: { sendMessage: ask(ASK_BEFORE.sendMessage), createPr: ask(ASK_BEFORE.createPr), download: ask(ASK_BEFORE.download), runJs: ask(ASK_BEFORE.runJs) },
    },
    connections: s.connections.map((c) => (c.id === 'github' ? { ...c, connected: cfg.connections.github } : c.id === 'linear' ? { ...c, connected: cfg.connections.linear } : c)),
    vaultFolder: cfg.vault_folder || s.vaultFolder,
  };
}

/** The slices of Settings the brain owns a copy of; a change here is what triggers a push. */
export function syncFingerprint(s: Settings): string {
  return JSON.stringify(toUserConfig(s));
}

/**
 * Bearer credential for the brain. The brain accepts either the shared DAYFLOW_TOKEN or a Google ID token
 * (backend/dayflow/api/auth.py), so the ID token wins when a sign-in produced one — today `chrome.identity`
 * only yields an access token, so this is the shared token in practice (see `Account.idToken`).
 */
export function brainAuthToken(s: Pick<Settings, 'token' | 'account'>): string {
  return s.account?.idToken || s.token;
}

export function brainAuthHeader(s: Pick<Settings, 'token' | 'account'>): Record<string, string> {
  return { authorization: `Bearer ${brainAuthToken(s)}` };
}

function authHeaders(s: Settings): Record<string, string> {
  return { 'content-type': 'application/json', ...brainAuthHeader(s) };
}

export function brainUrl(s: Settings, path: string): string {
  return `${s.backendUrl.replace(/\/+$/, '')}${path}`;
}

/**
 * PUT the panel's slices to the brain so Gemini reads what the user edited. Fields the panel does not own
 * (`memory`, anything newer than this client) are preserved by merging over the brain's current config.
 * A panel that has not pulled skills yet (empty list) must not wipe the brain's: the pack stays in charge.
 */
export async function pushConfig(s: Settings, fetchImpl: typeof fetch = fetch): Promise<'skipped' | 'ok' | `error:${string}`> {
  if (!brainAuthToken(s) || !s.backendUrl) return 'skipped';
  let remote: Partial<UserConfig> = {};
  try {
    const cur = await fetchImpl(brainUrl(s, '/config'), { headers: authHeaders(s) });
    if (cur.ok) remote = (await cur.json()) as Partial<UserConfig>;
  } catch {
    /* brain unreachable: PUT below reports it */
  }
  const local = toUserConfig(s);
  const merged = { ...remote, ...local, skills: local.skills.length ? local.skills : (remote.skills ?? []) };
  let res: Response;
  try {
    res = await fetchImpl(brainUrl(s, '/config'), { method: 'PUT', headers: authHeaders(s), body: JSON.stringify(merged) });
  } catch (e) {
    return `error:${e instanceof Error ? e.message : String(e)}`;
  }
  return res.ok ? 'ok' : `error:${res.status}`;
}

export async function pullConfig(s: Settings, fetchImpl: typeof fetch = fetch): Promise<UserConfig | null> {
  if (!brainAuthToken(s) || !s.backendUrl) return null;
  const res = await fetchImpl(brainUrl(s, '/config'), { headers: authHeaders(s) });
  if (!res.ok) throw new Error(`GET /config → HTTP ${res.status}`);
  return (await res.json()) as UserConfig;
}
