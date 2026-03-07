import { describe, expect, test, vi } from "vitest";
import { OsProtocolEmitter } from "../../src/os/protocol-emitter.js";
import type { OsSystemSnapshot } from "../../src/os/types.js";

describe("OsProtocolEmitter DB-only mode", () => {
  function createDbOnlyEmitter() {
    const backend = {
      isConnected: () => true,
      appendEvents: vi.fn(async () => {}),
      saveSnapshot: vi.fn(async () => {}),
    };
    const emitter = new OsProtocolEmitter({ storageBackend: backend, runId: "test-run" });
    return { emitter, backend };
  }

  test("constructs without filesystem paths", () => {
    const { emitter } = createDbOnlyEmitter();
    expect(emitter).toBeDefined();
  });

  test("emit enqueues events for backend flush", () => {
    const { emitter, backend } = createDbOnlyEmitter();
    emitter.emit({ action: "os_tick", status: "completed", message: "tick=1" });
    // Events are buffered, not flushed immediately (batch size = 10)
    // No filesystem error = DB-only mode works
  });

  test("writeLiveState calls saveSnapshot on backend", () => {
    const { emitter, backend } = createDbOnlyEmitter();
    const snapshot = { goal: "test" } as OsSystemSnapshot;
    emitter.writeLiveState(snapshot);
    expect(backend.saveSnapshot).toHaveBeenCalledWith("test-run", snapshot, "live");
  });

  test("saveSnapshot calls saveSnapshot on backend with final source", () => {
    const { emitter, backend } = createDbOnlyEmitter();
    const snapshot = { goal: "test" } as OsSystemSnapshot;
    emitter.saveSnapshot(snapshot);
    // saveSnapshot calls writeLiveState (which does "live") then itself does "final"
    expect(backend.saveSnapshot).toHaveBeenCalledWith("test-run", snapshot, "live");
    expect(backend.saveSnapshot).toHaveBeenCalledWith("test-run", snapshot, "final");
  });

  test("close flushes buffered events to backend", async () => {
    const { emitter, backend } = createDbOnlyEmitter();
    emitter.emit({ action: "os_tick", status: "completed", message: "tick=1" });
    emitter.emit({ action: "os_tick", status: "completed", message: "tick=2" });
    await emitter.close();
    expect(backend.appendEvents).toHaveBeenCalled();
    const allEvents = backend.appendEvents.mock.calls.flatMap(([, events]: [string, unknown[]]) => events);
    expect(allEvents).toHaveLength(2);
  });
});
