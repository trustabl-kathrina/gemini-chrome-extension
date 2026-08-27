import { describe, expect, it } from 'vitest';
import { mapWithLimit, parseRef, prefixRefs } from './tools';

describe('mapWithLimit', () => {
  it('keeps at most `limit` calls in flight and returns results in input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const items = [1, 2, 3, 4, 5, 6, 7];
    const done = mapWithLimit(items, 4, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((r) => release.push(r));
      inFlight--;
      return n * 10;
    });
    // Let the first wave start, then drain one at a time so a slot is always taken again.
    for (let i = 0; i < items.length; i++) {
      await new Promise((r) => setTimeout(r, 0));
      release.shift()?.();
    }
    await new Promise((r) => setTimeout(r, 0));
    release.forEach((r) => r());
    expect(await done).toEqual([10, 20, 30, 40, 50, 60, 70]);
    expect(peak).toBe(4);
  });

  it('lets one item fail without sinking the batch', async () => {
    const out = await mapWithLimit(['a', 'boom', 'c'], 2, async (s) => (s === 'boom' ? { error: s } : { ok: s }));
    expect(out).toEqual([{ ok: 'a' }, { error: 'boom' }, { ok: 'c' }]);
  });

  it('handles an empty list', async () => {
    expect(await mapWithLimit([], 4, () => Promise.resolve(1))).toEqual([]);
  });
});

describe('parseRef', () => {
  it('reads the frame out of a ref and stays backward compatible with bare refs', () => {
    expect(parseRef('e17')).toEqual({ frameId: 0, ref: 'e17' });
    expect(parseRef('[e17]')).toEqual({ frameId: 0, ref: 'e17' });
    expect(parseRef(' f3:e17 ')).toEqual({ frameId: 3, ref: 'e17' });
    expect(parseRef('[f12:e4]')).toEqual({ frameId: 12, ref: 'e4' });
    // Not a frame prefix: a label-ish ref keeps its whole value and the top frame.
    expect(parseRef('form:email')).toEqual({ frameId: 0, ref: 'form:email' });
  });
});

describe('prefixRefs', () => {
  const snap = '# Files — https://teams.test (viewport 1280x900, scrollY 0)\n[e1] button "Upload" @10,20\n[e2] tr "Lab 01.pdf" @10,60 href=https://x/y';

  it('qualifies a child frame\'s refs and leaves the top frame untouched', () => {
    expect(prefixRefs(snap, 0)).toBe(snap);
    const out = prefixRefs(snap, 3);
    expect(out).toContain('[f3:e1] button "Upload"');
    expect(out).toContain('[f3:e2] tr "Lab 01.pdf"');
    expect(out.split('\n')[0]).toBe(snap.split('\n')[0]); // the header line is not a ref line
  });

  it('rewrites the ref only at the start of a line, never inside a label', () => {
    expect(prefixRefs('[e1] div "see [e9] above"', 2)).toBe('[f2:e1] div "see [e9] above"');
  });
});
