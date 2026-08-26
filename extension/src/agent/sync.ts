import type { Settings } from '../protocol';

/** Backend `UserConfig` (backend/dayflow/core/models.py). Kept structural so the mapper is testable. */
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
  sites: Array<{ domain: string; notes: string; allow: boolean }>;
  permissions: { allowed_hosts: string[]; ask_before: string[]; mode: 'ask' | 'auto' };
  connections: { github: boolean; linear: boolean };
  vault_folder: string;
}

/** Panel toggles → brain tool names that need a confirmation credit. */
const ASK_BEFORE: Record<keyof Settings['permissions']['askBefore'], string[]> = {
  sendMessage: ['type_text'],
  createPr: ['create_pull_request', 'issue_write', 'create_issue'],
  download: ['download'],
};

export function toUserConfig(s: Settings): UserConfig {
  const ask = (Object.keys(ASK_BEFORE) as Array<keyof typeof ASK_BEFORE>).flatMap((k) => (s.permissions.askBefore[k] ? ASK_BEFORE[k] : []));
  return {
    skills: s.skills.map((k) => ({ ...k, key: k.key ?? '' })),
    sites: s.sites.map(({ domain, notes, allow }) => ({ domain, notes, allow })),
    permissions: { allowed_hosts: s.permissions.navigationAllowlist, ask_before: ask, mode: 'ask' },
    connections: {
      github: s.connections.some((c) => c.id === 'github' && c.connected),
      linear: s.connections.some((c) => c.id === 'linear' && c.connected),
    },
    vault_folder: s.vaultFolder,
  };
}

/** PUT the panel's settings to the brain so Gemini reads what the user edited. No-op outside live mode. */
export async function pushConfig(s: Settings, fetchImpl: typeof fetch = fetch): Promise<'skipped' | 'ok' | `error:${string}`> {
  if (s.mode !== 'live' || !s.token) return 'skipped';
  const res = await fetchImpl(`${s.backendUrl.replace(/\/+$/, '')}/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${s.token}` },
    body: JSON.stringify(toUserConfig(s)),
  });
  return res.ok ? 'ok' : `error:${res.status}`;
}
