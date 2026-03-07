import { describe, expect, test, vi } from "vitest";
import type { RuntimeProtocolEvent } from "../../src/types.js";
import type { OsSystemSnapshot } from "../../src/os/types.js";

const PROTOCOL_EMITTER_PG_MODULE_PATH = "../../src/db/protocol-emitter-pg.js";

type PgProtocolEmitterContract = {
  emit(input: { action: string; status: "started" | "completed" | "failed"; message?: string; agentId?: string; agentName?: string }):
    | Promise<void>
    | void;
  emitStreamEvent(pid: string, processName: string, event: { type: string; [key: string]: unknown }): Promise<void> | void;
  writeLiveState(snapshot: OsSystemSnapshot): Promise<void> | void;
  writeSnapshot(snapshot: OsSystemSnapshot): Promise<void> | void;
  close(): Promise<void>;
};

type ProtocolEmitterPgModule = {
  createPgProtocolEmitter: (options: {
    runId: string;
    appendEvents: (runId: string, events: RuntimeProtocolEvent[]) => Promise<void>;
    writeState: (runId: string, state: { snapshot: OsSystemSnapshot; source: "live" | "final" }) => Promise<void>;
  }) => PgProtocolEmitterContract;
};

async function importProtocolEmitterPgContract(): Promise<ProtocolEmitterPgModule> {
  try {
    return (await import(PROTOCOL_EMITTER_PG_MODULE_PATH)) as ProtocolEmitterPgModule;
  } catch (error) {
    throw new Error(
      `Missing implementation for contract:story6-emitter-storage. Expected module ${PROTOCOL_EMITTER_PG_MODULE_PATH}.`,
      { cause: error as Error },
    );
  }
}

async function createEmitterUnderTest() {
  const protocolEmitterPg = await importProtocolEmitterPgContract();
  const appendEvents = vi.fn(async () => undefined);
  const writeState = vi.fn(async () => undefined);

  const emitter = protocolEmitterPg.createPgProtocolEmitter({
    runId: "run-story6",
    appendEvents,
    writeState,
  });

  return { emitter, appendEvents, writeState };
}

function parsePersistedEvent(appendEventsCall: unknown): RuntimeProtocolEvent {
  const [runId, events] = appendEventsCall as [string, RuntimeProtocolEvent[]];
  expect(runId).toBe("run-story6");
  expect(Array.isArray(events)).toBe(true);
  expect(events).toHaveLength(1);
  return events[0] as RuntimeProtocolEvent;
}

describe("contract:story6-emitter-storage", () => {
  test("exports createPgProtocolEmitter", async () => {
    const protocolEmitterPg = await importProtocolEmitterPgContract();

    expect(protocolEmitterPg).toHaveProperty("createPgProtocolEmitter");
    expect(typeof protocolEmitterPg.createPgProtocolEmitter).toBe("function");
  });

  test("emit persists runtime protocol events through appendEvents", async () => {
    const { emitter, appendEvents } = await createEmitterUnderTest();

    await emitter.emit({
      action: "os_tick",
      status: "completed",
      message: "tick=1",
      agentId: "proc-1",
      agentName: "worker-1",
    });

    expect(appendEvents).toHaveBeenCalledTimes(1);
    const event = parsePersistedEvent(appendEvents.mock.calls[0]);
    expect(event).toEqual(
      expect.objectContaining({
        action: "os_tick",
        status: "completed",
        message: "tick=1",
        agentId: "proc-1",
        agentName: "worker-1",
        eventSource: "os",
      }),
    );
    expect(new Date(event.timestamp).toString()).not.toBe("Invalid Date");
  });

  test("emitStreamEvent persists non-empty stream events and filters empty text_delta", async () => {
    const { emitter, appendEvents } = await createEmitterUnderTest();

    await emitter.emitStreamEvent("proc-2", "worker-2", { type: "text_delta", text: "" });
    await emitter.emitStreamEvent("proc-2", "worker-2", { type: "text_delta", text: "hello" });

    expect(appendEvents).toHaveBeenCalledTimes(1);
    const event = parsePersistedEvent(appendEvents.mock.calls[0]);
    expect(event).toEqual(
      expect.objectContaining({
        action: "os_llm_stream",
        status: "started",
        agentId: "proc-2",
        agentName: "worker-2",
        eventSource: "os",
      }),
    );
    expect(event.message).toBe(JSON.stringify({ type: "text_delta", text: "hello" }));
  });

  test("writeLiveState and writeSnapshot persist run state with source tags", async () => {
    const { emitter, writeState } = await createEmitterUnderTest();
    const snapshot = { startedAt: "2026-03-06T00:00:00.000Z", goal: "story6" } as OsSystemSnapshot;

    await emitter.writeLiveState(snapshot);
    await emitter.writeSnapshot(snapshot);

    expect(writeState).toHaveBeenCalledTimes(2);
    expect(writeState).toHaveBeenNthCalledWith(1, "run-story6", { snapshot, source: "live" });
    expect(writeState).toHaveBeenNthCalledWith(2, "run-story6", { snapshot, source: "final" });
  });
});
