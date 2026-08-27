/**
 * Pause / Resume coordinator for in-flight agent runs.
 * Holds an async promise when paused and unblocks on resume or cancellation.
 */
export class PauseBox {
  private paused = false;
  private resumeResolve: (() => void) | null = null;

  get isPaused(): boolean {
    return this.paused;
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (this.resumeResolve) {
      const resolve = this.resumeResolve;
      this.resumeResolve = null;
      resolve();
    }
  }

  waitIfPaused(signal?: AbortSignal): Promise<void> {
    if (!this.paused) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const onAbort = () => {
        this.resumeResolve = null;
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.resumeResolve = () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      };
    });
  }
}
