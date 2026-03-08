/**
 * EventQueue — async FIFO queue for the kernel event loop.
 *
 * Events are enqueued by I/O callbacks (timer fires, process completions,
 * external commands) and dequeued by the main kernel loop. `dequeue()`
 * returns a promise that blocks until an event is available, making the
 * kernel loop naturally event-driven with zero busy-waiting.
 */

import type { KernelEvent } from "./state-machine/events.js";

export class EventQueue {
  /** Buffered events waiting to be consumed. */
  private pending: KernelEvent[] = [];

  /** Resolve callbacks from callers blocked on dequeue(). */
  private waiters: ((event: KernelEvent) => void)[] = [];

  /** Add an event to the queue. If a dequeue() caller is waiting, deliver immediately. */
  enqueue(event: KernelEvent): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(event);
    } else {
      this.pending.push(event);
    }
  }

  /** Remove and return the next event. Blocks (returns a pending promise) if the queue is empty. */
  dequeue(): Promise<KernelEvent> {
    const event = this.pending.shift();
    if (event) {
      return Promise.resolve(event);
    }
    return new Promise<KernelEvent>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
