import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, normalizeSettings } from '../protocol';
import { fromUserConfig, pushConfig, syncFingerprint, toUserConfig } from './sync';

describe('toUserConfig', () => {
  it('maps permissions toggles to brain tool names and keeps skills/sites with modes', () => {
    const cfg = toUserConfig({
      ...DEFAULT_SETTINGS,
      permissions: { navigationAllowlist: ['wsp.kbtu.kz'], askBefore: { sendMessage: true, createPr: false, download: true, runJs: true } },
      connections: DEFAULT_SETTINGS.connections.map((c) => (c.id === 'github' ? { ...c, connected: true } : c)),
    });
    expect(cfg.permissions).toEqual({ allowed_hosts: ['wsp.kbtu.kz'], ask_before: ['type', 'type_text', 'download', 'run_js'], mode: 'ask' });
    expect(cfg.connections).toEqual({ github: true, linear: false });
    expect(cfg.skills.map((s) => s.id)).toEqual(DEFAULT_SETTINGS.skills.map((s) => s.id));
    expect(cfg.skills.every((s) => typeof s.key === 'string')).toBe(true);
    expect(cfg.sites.find((s) => s.domain === 'wsp.kbtu.kz')).toMatchObject({ mode: 'dom', allow: true });
    expect(cfg.sites.find((s) => s.domain === 'drive.google.com')?.mode).toBe('vision');
    expect(cfg.vault_folder).toBe('Dayflow');
  });

  it('defaults a site without a mode to dom', () => {
    const cfg = toUserConfig({ ...DEFAULT_SETTINGS, sites: [{ domain: 'x.test', notes: '', allow: true }] });
    expect(cfg.sites[0]?.mode).toBe('dom');
  });
});

describe('skills come from the brain', () => {
  it('ships no skill text: the pack is the single source and the panel caches what GET /config returns', () => {
    expect(DEFAULT_SETTINGS.skills).toEqual([]);
    const pack = {
      ...toUserConfig(DEFAULT_SETTINGS),
      skills: [{ id: 'lab', title: 'Solve a lab', blurb: '', prompt: 'p', instructions: 'vault_list; vault_read', tools: ['vault_list', 'vault_read'], sites: [], schedule: null, pack: 'kbtu-student', enabled: true, key: '4' }],
    };
    expect(fromUserConfig(pack, DEFAULT_SETTINGS).skills.map((s) => s.id)).toEqual(['lab']);
  });

  it('pushConfig keeps the brain\'s skills when the panel has none yet', async () => {
    const remote = { skills: [{ id: 'lab' }], memory: 'm' };
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: typeof init?.body === 'string' ? init.body : undefined });
      return new Response(JSON.stringify(remote), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await pushConfig({ ...DEFAULT_SETTINGS, backendUrl: 'http://b', token: 't' }, fetchImpl);
    expect(r).toBe('ok');
    const sent = JSON.parse(calls[1]?.body ?? '{}') as { skills: unknown[]; memory: string };
    expect(sent.skills).toEqual([{ id: 'lab' }]);
    expect(sent.memory).toBe('m');
  });
});

describe('fromUserConfig', () => {
  it('round-trips through toUserConfig', () => {
    const s = { ...DEFAULT_SETTINGS, permissions: { ...DEFAULT_SETTINGS.permissions, askBefore: { sendMessage: false, createPr: true, download: true, runJs: false } } };
    const back = fromUserConfig(toUserConfig(s), DEFAULT_SETTINGS);
    expect(syncFingerprint(back)).toBe(syncFingerprint(s));
    expect(back.permissions.askBefore).toEqual({ sendMessage: false, createPr: true, download: true, runJs: false });
  });
});

describe('normalizeSettings', () => {
  it('maps harness-seeded shapes (vault.mode, account.token) and fills defaults', () => {
    const s = normalizeSettings({ vault: { mode: 'brain', folder: 'V' }, account: { email: 'h@x', name: 'H', token: 'tok' }, sites: [{ domain: 'a.test', notes: '', allow: true }] });
    expect(s.vaultMode).toBe('brain');
    expect(s.vaultFolder).toBe('V');
    expect(s.driveToken).toBe('tok');
    expect(s.vision).toBe(true);
    expect(s.sites[0]?.mode).toBe('dom');
    expect(normalizeSettings(undefined)).toEqual({ ...DEFAULT_SETTINGS, driveToken: undefined });
  });
});

describe('pushConfig', () => {
  it('skips without a token; merges over the brain copy and PUTs with the bearer token', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const f = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init]);
      if (!init?.method) return new Response(JSON.stringify({ memory: 'remember me', skills: [] }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    expect(await pushConfig({ ...DEFAULT_SETTINGS, token: '' }, f as unknown as typeof fetch)).toBe('skipped');
    expect(f).not.toHaveBeenCalled();
    expect(await pushConfig({ ...DEFAULT_SETTINGS, token: 't', backendUrl: 'https://b/' }, f as unknown as typeof fetch)).toBe('ok');
    const put = calls.find(([, init]) => init?.method === 'PUT');
    expect(put?.[0]).toBe('https://b/config');
    expect((put?.[1]?.headers as Record<string, string>).authorization).toBe('Bearer t');
    const body = JSON.parse(put?.[1]?.body as string) as { memory: string; skills: unknown[] };
    expect(body.memory).toBe('remember me');
    expect(body.skills.length).toBe(DEFAULT_SETTINGS.skills.length);
  });
});
