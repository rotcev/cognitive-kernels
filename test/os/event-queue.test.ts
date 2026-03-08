import { describe, it, expect } from "vitest";
import { EventQueue } from "../../src/os/event-queue.js";
import type { KernelEvent } from "../../src/os/state-machine/events.js";

/** Helper to create a minimal KernelEvent for testing. */
function makeEvent(label: string, seq: number): KernelEvent {
  return {
    type: "external_command",
    command: "halt",
    reason: label,
    timestamp: Date.now(),
    seq,
  };
}

describe("EventQueue", () => {
  it("enqueue and dequeue in order", async () => {
    const q = new EventQueue();
    const a = makeEvent("A", 1);
    const b = makeEvent("B", 2);

    q.enqueue(a);
    q.enqueue(b);

    const first = await q.dequeue();
    const second = await q.dequeue();

    expect(first).toBe(a);
    expect(second).toBe(b);
  });

  it("dequeue blocks until event available", async () => {
    const q = new EventQueue();

    // Start dequeue before anything is enqueued — it should block
    const promise = q.dequeue();
    let resolved = false;
    promise.then(() => { resolved = true; });

    // Give microtasks a chance to run — should still be unresolved
    await new Promise(r => setTimeout(r, 5));
    expect(resolved).toBe(false);

    // Now enqueue — should unblock
    const ev = makeEvent("delayed", 1);
    q.enqueue(ev);

    const result = await promise;
    expect(result).toBe(ev);
  });

  it("FIFO ordering preserved", async () => {
    const q = new EventQueue();
    const events = [makeEvent("X", 1), makeEvent("Y", 2), makeEvent("Z", 3)];

    for (const e of events) q.enqueue(e);

    const out: KernelEvent[] = [];
    for (let i = 0; i < 3; i++) out.push(await q.dequeue());

    expect(out).toEqual(events);
  });

  it("multiple waiters resolved in order", async () => {
    const q = new EventQueue();

    // Start two dequeues before any events are enqueued
    const p1 = q.dequeue();
    const p2 = q.dequeue();

    const e1 = makeEvent("first", 1);
    const e2 = makeEvent("second", 2);

    q.enqueue(e1);
    q.enqueue(e2);

    const r1 = await p1;
    const r2 = await p2;

    expect(r1).toBe(e1);
    expect(r2).toBe(e2);
  });

  it("mixed enqueue/dequeue", async () => {
    const q = new EventQueue();
    const results: KernelEvent[] = [];

    // Enqueue one, dequeue one
    const e1 = makeEvent("one", 1);
    q.enqueue(e1);
    results.push(await q.dequeue());

    // Dequeue (blocks), then enqueue
    const p = q.dequeue();
    const e2 = makeEvent("two", 2);
    q.enqueue(e2);
    results.push(await p);

    // Enqueue two, dequeue two
    const e3 = makeEvent("three", 3);
    const e4 = makeEvent("four", 4);
    q.enqueue(e3);
    q.enqueue(e4);
    results.push(await q.dequeue());
    results.push(await q.dequeue());

    expect(results.map(e => (e as any).reason)).toEqual([
      "one", "two", "three", "four",
    ]);
  });
});
