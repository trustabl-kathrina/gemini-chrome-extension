import { describe, expect, it } from 'vitest';
import { ConfirmBox } from './confirm';

describe('ConfirmBox', () => {
  it('resolves a waiter when the answer arrives later', async () => {
    const box = new ConfirmBox();
    const p = box.wait('c1');
    expect(box.pending).toBe(1);
    box.answer('c1', true);
    await expect(p).resolves.toBe(true);
    expect(box.pending).toBe(0);
  });

  it('keeps an answer that arrives before anyone waits (the harness clicks Allow within 700 ms)', async () => {
    const box = new ConfirmBox();
    box.answer('c2', false);
    await expect(box.wait('c2')).resolves.toBe(false);
    // Consumed: a second wait for the same id blocks again instead of replaying the old answer.
    let resolved = false;
    void box.wait('c2').then(() => (resolved = true));
    await Promise.resolve();
    expect(resolved).toBe(false);
  });

  it('ignores a second answer for the same card', async () => {
    const box = new ConfirmBox();
    box.answer('c3', true);
    box.answer('c3', false);
    await expect(box.wait('c3')).resolves.toBe(true);
  });
});
