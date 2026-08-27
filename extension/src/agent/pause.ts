/**
 * Pause / Resume coordinator for in-flight agent runs.
 * Holds an async promise when paused and unblocks on resume or cancellation.
 */
export class PauseBox {
  private paused = false;
  /**
   * Every call currently blocked in `waitIfPaused`. A turn can have several tool calls in flight
   * (live.ts runs a batch in parallel), so Resume must release ALL of them — keeping only the last
   * waiter left the rest of the batch hanging forever.
   */
  private readonly waiters = new Set<() => void>();

  get isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    const release = [...this.waiters];
    this.waiters.clear();
    for (const r of release) r();
  }

  waitIfPaused(signal?: AbortSignal): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const release = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
      const onAbort = () => {
        this.waiters.delete(release);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiters.add(release);
    });
  }
}
