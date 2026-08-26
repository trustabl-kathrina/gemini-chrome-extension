/**
 * Pending confirmation cards for one run. An answer may arrive BEFORE the run loop asks for it: the
 * `confirm` card is emitted while the brain's stream is still being read, the harness/user clicks Allow
 * within a second, but `waitForConfirm` only runs after every preceding browser call in the same turn
 * executed. Answers are therefore kept until they are consumed instead of being dropped.
 */
export class ConfirmBox {
  private waiters = new Map<string, (allow: boolean) => void>();
  private answers = new Map<string, boolean>();

  /** Resolves with the user's answer; immediately when it was already given. */
  wait(id: string): Promise<boolean> {
    const early = this.answers.get(id);
    if (early !== undefined) {
      this.answers.delete(id);
      return Promise.resolve(early);
    }
    return new Promise<boolean>((resolve) => this.waiters.set(id, resolve));
  }

  /** Delivers an answer to the waiter, or parks it until `wait(id)` is called. A second answer is ignored. */
  answer(id: string, allow: boolean): void {
    const waiter = this.waiters.get(id);
    if (waiter) {
      this.waiters.delete(id);
      waiter(allow);
      return;
    }
    if (!this.answers.has(id)) this.answers.set(id, allow);
  }

  get pending(): number {
    return this.waiters.size;
  }
}
