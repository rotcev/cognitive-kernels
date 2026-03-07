import { describe, expect, test } from "vitest";
import type { RuntimeProtocolEvent } from "../../src/types.js";

const BACKEND_MODULE_PATH = "../../src/db/storage-backend.js";

async function importStorageBackendContract() {
  try {
    return await import(BACKEND_MODULE_PATH);
  } catch (error) {
    throw new Error(
      `Missing implementation for contract:storage-backend-interface. Expected module ${BACKEND_MODULE_PATH}.`,
      { cause: error as Error },
    );
  }
}

describe("contract:storage-backend-interface", () => {
  test("exports storage backend factory", async () => {
    const backendModule = await importStorageBackendContract();

    expect(backendModule).toHaveProperty("createStorageBackend");
    expect(typeof backendModule.createStorageBackend).toBe("function");
  });

  test("InMemoryStorageBackend appendEvents accepts RuntimeProtocolEvent[] and stores them", async () => {
    const backendModule = await importStorageBackendContract();
    const backend = backendModule.createStorageBackend();
    await backend.connect();

    const events: RuntimeProtocolEvent[] = [
      {
        action: "os_tick",
        status: "completed",
        timestamp: new Date().toISOString(),
        message: "tick=1",
        agentId: "proc-1",
        agentName: "worker-1",
        eventSource: "os",
      },
      {
        action: "os_spawn",
        status: "started",
        timestamp: new Date().toISOString(),
        message: "spawning",
        eventSource: "os",
      },
    ];

    await backend.appendEvents("run-test-1", events);

    const stored = backend.getRunEvents("run-test-1");
    expect(stored).toHaveLength(2);
    expect(stored[0].action).toBe("os_tick");
    expect(stored[1].action).toBe("os_spawn");

    // Appending more events accumulates
    await backend.appendEvents("run-test-1", [{
      action: "os_tick",
      status: "completed",
      timestamp: new Date().toISOString(),
      eventSource: "os",
    }]);

    expect(backend.getRunEvents("run-test-1")).toHaveLength(3);

    // Different run IDs are isolated
    expect(backend.getRunEvents("run-other")).toHaveLength(0);
  });
});
