import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../protocol';
import { pushConfig, toUserConfig } from './sync';

describe('toUserConfig', () => {
  it('maps permissions toggles to brain tool names and keeps skills/sites', () => {
    const cfg = toUserConfig({
      ...DEFAULT_SETTINGS,
      permissions: { navigationAllowlist: ['wsp.kbtu.kz'], askBefore: { sendMessage: true, createPr: false, download: true } },
      connections: DEFAULT_SETTINGS.connections.map((c) => (c.id === 'github' ? { ...c, connected: true } : c)),
    });
    expect(cfg.permissions).toEqual({ allowed_hosts: ['wsp.kbtu.kz'], ask_before: ['type_text', 'download'], mode: 'ask' });
    expect(cfg.connections).toEqual({ github: true, linear: false });
    expect(cfg.skills.map((s) => s.id)).toEqual(DEFAULT_SETTINGS.skills.map((s) => s.id));
    expect(cfg.skills.every((s) => typeof s.key === 'string')).toBe(true);
    expect(cfg.sites.find((s) => s.domain === 'wsp.kbtu.kz')?.notes).toContain('School > Instructor');
    expect(cfg.vault_folder).toBe('DayflowVault');
  });
});

describe('pushConfig', () => {
  it('skips outside live mode and PUTs with the bearer token in live mode', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    expect(await pushConfig({ ...DEFAULT_SETTINGS, mode: 'mock', token: 't' }, f)).toBe('skipped');
    expect(f).not.toHaveBeenCalled();
    expect(await pushConfig({ ...DEFAULT_SETTINGS, mode: 'live', token: 't', backendUrl: 'https://b/' }, f)).toBe('ok');
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://b/config');
    expect(init.method).toBe('PUT');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer t');
  });
});
