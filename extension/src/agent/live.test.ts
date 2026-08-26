import { describe, expect, it } from 'vitest';
import { brainPageUrl, resultSummary } from './live';

describe('brainPageUrl', () => {
  const base = 'http://localhost:8100';
  it('recognises the brain\'s own pages and nothing else', () => {
    expect(brainPageUrl(base, 'http://localhost:8100/pages/report/AbCdEfGhIjKlMnOpQrStUv')).toBe('http://localhost:8100/pages/report/AbCdEfGhIjKlMnOpQrStUv');
    expect(brainPageUrl(base, 'http://localhost:8100/vault/x')).toBeUndefined();
    expect(brainPageUrl(base, 'http://127.0.0.1:8099/files/a.pdf')).toBeUndefined();
    expect(brainPageUrl(base, 'http://localhost:8101/view/f_x')).toBeUndefined();
    expect(brainPageUrl(base, undefined)).toBeUndefined();
    expect(brainPageUrl('', 'http://localhost:8100/pages/report/x')).toBeUndefined();
  });
});

describe('resultSummary', () => {
  it('prefers the tool summary, then message/title, then ok/failed', () => {
    expect(resultSummary({ status: 'success', summary: 'REPORT.html · 6 KB' })).toBe('REPORT.html · 6 KB');
    expect(resultSummary({ status: 'error', message: 'blocked' })).toBe('blocked');
    expect(resultSummary({ status: 'error' })).toBe('failed');
  });
});
