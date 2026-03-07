import type { RuntimeProtocolEvent, RuntimeProtocolStatus } from "../types.js";
import type { OsSystemSnapshot } from "../os/types.js";

type RuntimeProtocolAction = RuntimeProtocolEvent["action"];

type RuntimeProtocolEventInput = {
  action: RuntimeProtocolAction;
  status: RuntimeProtocolStatus;
  message?: string;
  agentId?: string;
  agentName?: string;
};

type PgProtocolEmitterOptions = {
  runId: string;
  appendEvents: (runId: string, events: RuntimeProtocolEvent[]) => Promise<void>;
  writeState: (runId: string, state: { snapshot: OsSystemSnapshot; source: "live" | "final" }) => Promise<void>;
};

export function createPgProtocolEmitter(options: PgProtocolEmitterOptions) {
  const persistEvent = async (event: RuntimeProtocolEvent): Promise<void> => {
    await options.appendEvents(options.runId, [event]);
  };

  return {
    async emit(input: RuntimeProtocolEventInput): Promise<void> {
      const event: RuntimeProtocolEvent = {
        action: input.action,
        status: input.status,
        timestamp: new Date().toISOString(),
        message: input.message,
        agentId: input.agentId,
        agentName: input.agentName,
        eventSource: "os",
      };

      await persistEvent(event);
    },

    async emitStreamEvent(
      pid: string,
      processName: string,
      event: { type: string; [key: string]: unknown },
    ): Promise<void> {
      if (event.type === "text_delta" && !event.text) {
        return;
      }

      const protocolEvent: RuntimeProtocolEvent = {
        action: "os_llm_stream",
        status: "started",
        timestamp: new Date().toISOString(),
        message: JSON.stringify(event),
        agentId: pid,
        agentName: processName,
        eventSource: "os",
      };

      await persistEvent(protocolEvent);
    },

    async writeLiveState(snapshot: OsSystemSnapshot): Promise<void> {
      await options.writeState(options.runId, { snapshot, source: "live" });
    },

    async writeSnapshot(snapshot: OsSystemSnapshot): Promise<void> {
      await options.writeState(options.runId, { snapshot, source: "final" });
    },

    async close(): Promise<void> {
      // No stream resources to dispose for DB-only emitter adapter.
    },
  };
}
