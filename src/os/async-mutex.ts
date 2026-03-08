/**
 * Minimal async mutex for serializing state mutations.
 * Guarantees FIFO ordering of waiters.
 */
export class AsyncMutex {
  private locked = false;
  private queue: Array<() => void> = [];

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }
    return new Promise<() => void>(resolve => {
      this.queue.push(() => resolve(() => this.release()));
    });
  }

  /**
   * Try to acquire the mutex without waiting.
   * Returns a release function if acquired, null if already locked.
   * Use this for low-priority periodic work that should yield to higher-priority callers.
   */
  tryAcquire(): (() => void) | null {
    if (this.locked) return null;
    this.locked = true;
    return () => this.release();
  }

  private release(): void {
    const next = this.queue.shift();
    if (next) {
      next(); // hand lock to next waiter (stays locked)
    } else {
      this.locked = false;
    }
  }

  get isLocked(): boolean {
    return this.locked;
  }

  get waitingCount(): number {
    return this.queue.length;
  }
}
