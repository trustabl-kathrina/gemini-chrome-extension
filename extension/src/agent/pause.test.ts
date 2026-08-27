import { describe, expect, it } from 'vitest';
import { PauseBox } from './pause';

describe('PauseBox', () => {
  it('does not block when not paused', async () => {
    const box = new PauseBox();
    expect(box.isPaused).toBe(false);
    await box.waitIfPaused();
  });

  it('blocks while paused and unblocks on resume', async () => {
    const box = new PauseBox();
    box.pause();
    expect(box.isPaused).toBe(true);

    let unblocked = false;
    const pending = box.waitIfPaused().then(() => {
      unblocked = true;
    });

    expect(unblocked).toBe(false);
    box.resume();
    expect(box.isPaused).toBe(false);
    await pending;
    expect(unblocked).toBe(true);
  });

  it('unblocks every waiter of a parallel batch, not just the last one', async () => {
    const box = new PauseBox();
    box.pause();
    const done: number[] = [];
    const pending = [0, 1, 2].map((i) => box.waitIfPaused().then(() => done.push(i)));

    box.resume();
    await Promise.all(pending);
    expect(done.sort()).toEqual([0, 1, 2]);
  });

  it('drops an aborted waiter without stranding the others', async () => {
    const box = new PauseBox();
    box.pause();
    const abort = new AbortController();
    const aborted = box.waitIfPaused(abort.signal);
    let other = false;
    const survivor = box.waitIfPaused().then(() => {
      other = true;
    });

    abort.abort();
    await expect(aborted).rejects.toThrow();
    box.resume();
    await survivor;
    expect(other).toBe(true);
  });

  it('rejects on abort signal while paused', async () => {
    const box = new PauseBox();
    box.pause();
    const abort = new AbortController();

    const pending = box.waitIfPaused(abort.signal);
    abort.abort();

    await expect(pending).rejects.toThrow();
  });
});
