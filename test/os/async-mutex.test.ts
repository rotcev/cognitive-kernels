import { describe, it, expect } from "vitest";
import { AsyncMutex } from "../../src/os/async-mutex.js";

describe("AsyncMutex", () => {
  it("allows single acquire", async () => {
    const mutex = new AsyncMutex();
    const release = await mutex.acquire();
    expect(mutex.isLocked).toBe(true);
    release();
    expect(mutex.isLocked).toBe(false);
  });

  it("serializes concurrent access", async () => {
    const mutex = new AsyncMutex();
    const order: number[] = [];

    const task = async (id: number, delayMs: number) => {
      const release = await mutex.acquire();
      order.push(id);
      await new Promise(r => setTimeout(r, delayMs));
      release();
    };

    await Promise.all([task(1, 20), task(2, 10), task(3, 5)]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("releases on error via finally pattern", async () => {
    const mutex = new AsyncMutex();
    try {
      const release = await mutex.acquire();
      try {
        throw new Error("boom");
      } finally {
        release();
      }
    } catch { /* expected */ }
    const release2 = await mutex.acquire();
    expect(mutex.isLocked).toBe(true);
    release2();
  });

  it("handles 100 sequential acquires", async () => {
    const mutex = new AsyncMutex();
    for (let i = 0; i < 100; i++) {
      const release = await mutex.acquire();
      release();
    }
    expect(mutex.isLocked).toBe(false);
  });

  it("reports waitingCount accurately", async () => {
    const mutex = new AsyncMutex();
    const release1 = await mutex.acquire();
    expect(mutex.waitingCount).toBe(0);

    const p2 = mutex.acquire();
    const p3 = mutex.acquire();
    // Give microtasks time to enqueue
    await new Promise(r => setTimeout(r, 0));
    expect(mutex.waitingCount).toBe(2);

    release1();
    const release2 = await p2;
    expect(mutex.waitingCount).toBe(1);

    release2();
    const release3 = await p3;
    expect(mutex.waitingCount).toBe(0);
    release3();
  });
});
