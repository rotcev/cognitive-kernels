/**
 * Lens WebSocket server integration tests.
 *
 * Starts a real WebSocket server, connects a client, pushes events
 * through the bus, and verifies the client receives correct Lens output.
 */

import { describe, expect, test, beforeAll, afterAll, beforeEach } from "vitest";
import WebSocket from "ws";
import { LensServer } from "../../src/lens/server.js";
import { LensEventBus } from "../../src/lens/event-bus.js";
import type { LensServerMessage, LensSnapshot, LensSnapshotDelta } from "../../src/lens/types.js";
import type { RuntimeProtocolEvent } from "../../src/types.js";
import type { OsSystemSnapshot } from "../../src/os/types.js";

let bus: LensEventBus;
let server: LensServer;
let port: number;

function makeSnapshot(tick: number, overrides?: Partial<OsSystemSnapshot>): OsSystemSnapshot {
  return {
    runId: "test-run-1",
    tickCount: tick,
    goal: "test goal",
    startTime: Date.now() - tick * 1000,
    wallTimeElapsedMs: tick * 1000,
    processes: [
      {
        pid: "proc-1",
        name: "goal-orchestrator",
        type: "lifecycle",
        state: "running",
        parentPid: null,
        objective: "test objective",
        priority: 90,
        spawnedAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        tickCount: tick,
        tokensUsed: tick * 1000,
        model: "test-model",
        workingDir: "/tmp",
        children: [],
        onParentDeath: "orphan",
        restartPolicy: "never",
        blackboardKeysWritten: tick > 0 ? ["result"] : [],
      },
      {
        pid: "proc-2",
        name: "metacog-daemon",
        type: "daemon",
        state: "idle",
        parentPid: null,
        objective: "metacog",
        priority: 50,
        spawnedAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        tickCount: 0,
        tokensUsed: 0,
        model: "test-model",
        workingDir: "/tmp",
        children: [],
        onParentDeath: "orphan",
        restartPolicy: "always",
      },
    ],
    dagTopology: {
      nodes: [
        { pid: "proc-1", name: "goal-orchestrator", type: "lifecycle", state: "running" },
        { pid: "proc-2", name: "metacog-daemon", type: "daemon", state: "idle" },
      ],
      edges: [],
    },
    blackboard: tick > 0 ? { result: "hello world" } : {},
    heuristics: [],
    deferrals: [],
    progressMetrics: {
      totalTokensUsed: tick * 1000,
      totalToolCalls: 0,
      totalLlmCalls: tick,
    },
    ...overrides,
  } as OsSystemSnapshot;
}

function makeEvent(action: string, pid?: string): RuntimeProtocolEvent {
  return {
    action: action as RuntimeProtocolEvent["action"],
    status: "completed",
    timestamp: new Date().toISOString(),
    agentId: pid,
    agentName: pid ? "test-process" : undefined,
    message: `test ${action}`,
    eventSource: "os",
  };
}

function connectClient(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function waitForMessage(ws: WebSocket, timeout = 2000): Promise<LensServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for message")), timeout);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

function collectMessages(ws: WebSocket, count: number, timeout = 3000): Promise<LensServerMessage[]> {
  return new Promise((resolve, reject) => {
    const msgs: LensServerMessage[] = [];
    const timer = setTimeout(() => resolve(msgs), timeout);
    const handler = (data: WebSocket.RawData) => {
      msgs.push(JSON.parse(data.toString()));
      if (msgs.length >= count) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msgs);
      }
    };
    ws.on("message", handler);
  });
}

beforeAll(async () => {
  bus = new LensEventBus();
  server = new LensServer({ bus, port: 0 }); // port 0 = random available
  await server.start();
  port = server.address!.port;
});

afterAll(async () => {
  await server.stop();
});

describe("lens:server", () => {
  test("client connects and subscribes", async () => {
    const ws = await connectClient();
    expect(ws.readyState).toBe(WebSocket.OPEN);

    ws.send(JSON.stringify({ type: "subscribe", runId: "test-run-1" }));
    // Give it a moment to process
    await new Promise((r) => setTimeout(r, 50));

    expect(server.clientCount).toBeGreaterThanOrEqual(1);
    ws.close();
  });

  test("receives full snapshot on first snapshot event", async () => {
    const ws = await connectClient();
    ws.send(JSON.stringify({ type: "subscribe", runId: "test-run-1" }));
    await new Promise((r) => setTimeout(r, 50));

    const msgPromise = waitForMessage(ws);
    bus.emit({ type: "snapshot", runId: "test-run-1", snapshot: makeSnapshot(0) });
    const msg = await msgPromise;

    expect(msg.type).toBe("snapshot");
    if (msg.type === "snapshot") {
      expect(msg.runId).toBe("test-run-1");
      expect(msg.snapshot.tick).toBe(0);
      expect(msg.snapshot.processes.length).toBe(2);
      expect(msg.snapshot.processes[0].role).toBe("kernel"); // goal-orchestrator = kernel (root lifecycle)
      expect(msg.snapshot.processes[1].role).toBe("kernel"); // metacog = kernel (daemon)
    }

    ws.close();
  });

  test("receives delta on subsequent snapshots", async () => {
    const ws = await connectClient();
    ws.send(JSON.stringify({ type: "subscribe", runId: "delta-run" }));
    await new Promise((r) => setTimeout(r, 50));

    // First snapshot — full
    const firstPromise = waitForMessage(ws);
    bus.emit({ type: "snapshot", runId: "delta-run", snapshot: makeSnapshot(0, { runId: "delta-run" }) });
    const first = await firstPromise;
    expect(first.type).toBe("snapshot");

    // Second snapshot — delta
    const deltaPromise = waitForMessage(ws);
    bus.emit({ type: "snapshot", runId: "delta-run", snapshot: makeSnapshot(1, { runId: "delta-run" }) });
    const delta = await deltaPromise;
    expect(delta.type).toBe("delta");
    if (delta.type === "delta") {
      expect(delta.runId).toBe("delta-run");
      expect(delta.delta.tick).toBe(1);
      expect(delta.delta.metrics).toBeDefined();
    }

    ws.close();
  });

  test("receives protocol events", async () => {
    const ws = await connectClient();
    ws.send(JSON.stringify({ type: "subscribe", runId: "event-run" }));
    await new Promise((r) => setTimeout(r, 50));

    const msgPromise = waitForMessage(ws);
    bus.emit({ type: "event", runId: "event-run", event: makeEvent("os_tick", "proc-1") });
    const msg = await msgPromise;

    expect(msg.type).toBe("event");
    if (msg.type === "event") {
      expect(msg.runId).toBe("event-run");
      expect(msg.event.action).toBe("os_tick");
    }

    ws.close();
  });

  test("receives terminal lines for subscribed processes", async () => {
    const ws = await connectClient();
    ws.send(JSON.stringify({ type: "subscribe", runId: "term-run" }));
    ws.send(JSON.stringify({ type: "subscribe_process", runId: "term-run", pid: "proc-A" }));
    await new Promise((r) => setTimeout(r, 50));

    // Send a spawn event for proc-A
    const msgs = collectMessages(ws, 2);
    bus.emit({
      type: "event",
      runId: "term-run",
      event: makeEvent("os_process_spawn", "proc-A"),
    });
    const received = await msgs;

    // Should get both the raw event and the terminal line
    const eventMsg = received.find((m) => m.type === "event");
    const lineMsg = received.find((m) => m.type === "terminal_line");
    expect(eventMsg).toBeDefined();
    expect(lineMsg).toBeDefined();
    if (lineMsg?.type === "terminal_line") {
      expect(lineMsg.pid).toBe("proc-A");
      expect(lineMsg.line.level).toBe("system");
    }

    ws.close();
  });

  test("does not receive events for unsubscribed runs", async () => {
    const ws = await connectClient();
    ws.send(JSON.stringify({ type: "subscribe", runId: "my-run" }));
    await new Promise((r) => setTimeout(r, 50));

    // Send event to a different run
    bus.emit({ type: "event", runId: "other-run", event: makeEvent("os_tick") });

    // Wait briefly — should not receive anything
    const msgs = await collectMessages(ws, 1, 200);
    expect(msgs.length).toBe(0);

    ws.close();
  });

  test("receives run_end", async () => {
    const ws = await connectClient();
    ws.send(JSON.stringify({ type: "subscribe", runId: "end-run" }));
    await new Promise((r) => setTimeout(r, 50));

    const msgPromise = waitForMessage(ws);
    bus.emit({ type: "run_end", runId: "end-run", reason: "goal_work_complete" });
    const msg = await msgPromise;

    expect(msg.type).toBe("run_end");
    if (msg.type === "run_end") {
      expect(msg.reason).toBe("goal_work_complete");
    }

    ws.close();
  });

  test("sends cached snapshot on late subscribe", async () => {
    // Push a snapshot before anyone subscribes
    bus.emit({ type: "snapshot", runId: "cached-run", snapshot: makeSnapshot(5, { runId: "cached-run" }) });
    await new Promise((r) => setTimeout(r, 50));

    // Now subscribe — should receive the cached snapshot
    const ws = await connectClient();
    const msgPromise = waitForMessage(ws);
    ws.send(JSON.stringify({ type: "subscribe", runId: "cached-run" }));
    const msg = await msgPromise;

    expect(msg.type).toBe("snapshot");
    if (msg.type === "snapshot") {
      expect(msg.snapshot.tick).toBe(5);
    }

    ws.close();
  });
});
