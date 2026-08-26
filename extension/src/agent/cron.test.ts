import { describe, expect, it } from 'vitest';
import { nextRun, parseCron } from './cron';

describe('cron', () => {
  it('parses lists, ranges and steps', () => {
    const c = parseCron('*/15 8-10,18 * * 1-5');
    expect([...c.min]).toEqual([0, 15, 30, 45]);
    expect([...c.hour]).toEqual([8, 9, 10, 18]);
    expect([...c.dow]).toEqual([1, 2, 3, 4, 5]);
  });

  it('rejects malformed expressions', () => {
    expect(() => parseCron('0 8 * *')).toThrow();
    expect(() => parseCron('60 8 * * *')).toThrow();
  });

  it('finds the next weekday 08:00 across a weekend', () => {
    // Friday 2026-08-28 09:00 → Monday 2026-08-31 08:00
    const from = new Date(2026, 7, 28, 9, 0);
    const next = nextRun('0 8 * * 1-5', from);
    expect(next?.getDay()).toBe(1);
    expect(next?.getDate()).toBe(31);
    expect(next?.getHours()).toBe(8);
  });

  it('is strictly after `from`', () => {
    const from = new Date(2026, 7, 26, 8, 0);
    expect(nextRun('0 8 * * *', from)?.getDate()).toBe(27);
  });
});
