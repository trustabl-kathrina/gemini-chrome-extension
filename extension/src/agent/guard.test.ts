import { describe, expect, it } from 'vitest';
import { checkNavigable, safeVaultPath } from './guard';

describe('checkNavigable', () => {
  const allow = ['wsp.kbtu.kz', 'github.com'];
  it('allows listed hosts and their subdomains over http(s)', () => {
    expect(checkNavigable('https://wsp.kbtu.kz/x', allow).ok).toBe(true);
    expect(checkNavigable('https://api.github.com/', allow).ok).toBe(true);
  });
  it('blocks other hosts, lookalikes and non-http schemes', () => {
    expect(checkNavigable('https://evil.com/', allow).ok).toBe(false);
    expect(checkNavigable('https://github.com.evil.com/', allow).ok).toBe(false);
    expect(checkNavigable('javascript:alert(1)', allow).ok).toBe(false);
    expect(checkNavigable('file:///etc/passwd', allow).ok).toBe(false);
    expect(checkNavigable('chrome://settings', allow).ok).toBe(false);
    expect(checkNavigable('not a url', allow).ok).toBe(false);
  });
  it('with an empty allow-list permits any http(s) host but still no other scheme', () => {
    expect(checkNavigable('https://anything.example/', []).ok).toBe(true);
    expect(checkNavigable('javascript:alert(1)', []).ok).toBe(false);
  });
});

describe('safeVaultPath', () => {
  it('keeps nested relative paths', () => {
    expect(safeVaultPath('DayflowVault', 'ML/Week 07/lecture.pdf')).toBe('DayflowVault/ML/Week 07/lecture.pdf');
  });
  it('strips traversal, absolute prefixes and drive letters', () => {
    expect(safeVaultPath('DayflowVault', '../../.ssh/id_rsa')).toBe('DayflowVault/.ssh/id_rsa');
    expect(safeVaultPath('DayflowVault', '/etc/passwd')).toBe('DayflowVault/etc/passwd');
    expect(safeVaultPath('DayflowVault', 'C:\\Windows\\x.dll')).toBe('DayflowVault/C/Windows/x.dll');
    expect(safeVaultPath('../Vault', 'a.pdf')).toBe('Vault/a.pdf');
  });
  it('never returns an empty leaf', () => {
    expect(safeVaultPath('DayflowVault', '..')).toBe('DayflowVault/download.bin');
  });
});
