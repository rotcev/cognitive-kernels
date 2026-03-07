/**
 * LensClient tests — uses a real WebSocket server to validate the client.
 */

import { describe, expect, test, beforeAll, afterAll } from "vitest";
import { WebSocketServer, WebSocket as WsWebSocket } from "ws";
import { LensClient } from "../../src/lens/client.js";
import type { LensSnapshot, LensSnapshotDelta, LensServerMessage } from "../../src/lens/types.js";

let wss: WebSocketServer;
let port: number;
let lastClientMessage: Record<string, unknown> | null = null;
let serverSocket: InstanceType<typeof WsWebSocket> | null = null;

function makeSnapshot(tick = 0): LensSnapshot {
  return {
    runId: "run-1",
    tick,
    goal: "test goal",
    elapsed: tick * 1000,
    processes: [
      {
        pid: "p1",
        name: "orchestrator",
        type: "lifecycle",
        state: "running",
        role: "kernel",
        parentPid: null,
        children: [],
        objective: "coordinate",
        priority: 90,
        tickCount: tick,
        tokensUsed: tick * 500,
        tokenBudget: null,
        model: "test",
        spawnedAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
        backendKind: undefined,
        selfReports: [],
        blackboardIO: [],
      },
    ],
    dag: { nodes: [], edges: [] },
    blackboard: {},
    heuristics: [],
    deferrals: [],
    metrics: {
      totalTokens: tick * 500,
      tokenRate: 0,
      processCount: 1,
      runningCount: 1,
      sleepingCount: 0,
      deadCount: 0,
      checkpointedCount: 0,
      suspendedCount: 0,
      dagDepth: 0,
      dagEdgeCount: 0,
      wallTimeElapsedMs: tick * 1000,
      tickCount: tick,
    },
  };
}

function serverSend(msg: LensServerMessage): void {
  if (serverSocket?.readyState === WsWebSocket.OPEN) {
    serverSocket.send(JSON.stringify(msg));
  }
}

beforeAll(async () => {
  wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((r) => wss.once("listening", r));
  const addr = wss.address();
  port = typeof addr === "object" ? addr!.port : 0;

  wss.on("connection", (ws) => {
    serverSocket = ws;
    ws.on("message", (data) => {
      lastClientMessage = JSON.parse(data.toString());
    });
  });
});

afterAll(async () => {
  await new Promise<void>((r) => wss.close(() => r()));
});

function createClient(): LensClient {
  return new LensClient({
    url: `ws://127.0.0.1:${port}`,
    reconnect: false,
    WebSocket: WsWebSocket as unknown as new (url: string) => WebSocket,
  });
}

describe("LensClient", () => {
  test("connects and subscribes", async () => {
    const client = createClient();
    await client.connect();
    expect(client.connected).toBe(true);

    client.subscribe("run-1");
    await new Promise((r) => setTimeout(r, 50));
    expect(lastClientMessage).toEqual({ type: "subscribe", runId: "run-1" });

    client.disconnect();
  });

  test("receives snapshot and stores state", async () => {
    const client = createClient();
    await client.connect();
    client.subscribe("run-1");
    await new Promise((r) => setTimeout(r, 50));

    const snapshotPromise = new Promise<LensSnapshot>((resolve) => {
      client.on("snapshot", ({ snapshot }) => resolve(snapshot));
    });

    serverSend({ type: "snapshot", runId: "run-1", snapshot: makeSnapshot(0) });
    const snap = await snapshotPromise;

    expect(snap.tick).toBe(0);
    expect(snap.goal).toBe("test goal");
    expect(client.state.get("run-1")?.tick).toBe(0);

    client.disconnect();
  });

  test("applies delta to state", async () => {
    const client = createClient();
    await client.connect();
    client.subscribe("run-1");
    await new Promise((r) => setTimeout(r, 50));

    // Send initial snapshot
    serverSend({ type: "snapshot", runId: "run-1", snapshot: makeSnapshot(0) });
    await new Promise((r) => setTimeout(r, 50));

    // Send delta
    const statePromise = new Promise<LensSnapshot>((resolve) => {
      client.on("state", ({ snapshot }) => {
        if (snapshot.tick === 1) resolve(snapshot);
      });
    });

    const delta: LensSnapshotDelta = {
      tick: 1,
      timestamp: new Date().toISOString(),
      metrics: { totalTokens: 500, tickCount: 1 },
      processes: {
        added: [],
        removed: [],
        changed: [{ pid: "p1", changed: { tickCount: 1, tokensUsed: 500 } }],
      },
    };

    serverSend({ type: "delta", runId: "run-1", delta });
    const updated = await statePromise;

    expect(updated.tick).toBe(1);
    expect(updated.metrics.totalTokens).toBe(500);
    expect(updated.processes[0].tickCount).toBe(1);

    client.disconnect();
  });

  test("receives narrative", async () => {
    const client = createClient();
    await client.connect();
    client.subscribe("run-1");
    await new Promise((r) => setTimeout(r, 50));

    const narrativePromise = client.waitFor("narrative");
    serverSend({ type: "narrative", runId: "run-1", text: "The system is working on your request." });
    const result = await narrativePromise;

    expect(result.text).toBe("The system is working on your request.");

    client.disconnect();
  });

  test("receives run_end", async () => {
    const client = createClient();
    await client.connect();
    client.subscribe("run-1");
    await new Promise((r) => setTimeout(r, 50));

    const endPromise = client.waitFor("run_end");
    serverSend({ type: "run_end", runId: "run-1", reason: "goal_complete" });
    const result = await endPromise;

    expect(result.reason).toBe("goal_complete");

    client.disconnect();
  });

  test("subscribes to process terminal lines", async () => {
    const client = createClient();
    await client.connect();
    client.subscribe("run-1");
    client.subscribeProcess("run-1", "p1");
    await new Promise((r) => setTimeout(r, 50));

    expect(lastClientMessage).toEqual({ type: "subscribe_process", runId: "run-1", pid: "p1" });

    const linePromise = client.waitFor("terminal_line");
    serverSend({
      type: "terminal_line",
      runId: "run-1",
      pid: "p1",
      line: {
        seq: 1,
        timestamp: new Date().toISOString(),
        pid: "p1",
        processName: "orchestrator",
        level: "info",
        text: "Starting work",
      },
    });
    const result = await linePromise;
    expect(result.line.text).toBe("Starting work");

    client.disconnect();
  });

  test("waitFor with filter", async () => {
    const client = createClient();
    await client.connect();
    client.subscribe("run-1");
    await new Promise((r) => setTimeout(r, 50));

    const filtered = client.waitFor(
      "narrative",
      (data) => data.text.includes("complete"),
    );

    // This one doesn't match the filter
    serverSend({ type: "narrative", runId: "run-1", text: "Working..." });
    // This one does
    serverSend({ type: "narrative", runId: "run-1", text: "Task complete!" });

    const result = await filtered;
    expect(result.text).toBe("Task complete!");

    client.disconnect();
  });

  test("waitFor timeout", async () => {
    const client = createClient();
    await client.connect();

    await expect(
      client.waitFor("run_end", undefined, 100),
    ).rejects.toThrow("Timeout");

    client.disconnect();
  });

  test("unsubscribe clears state", async () => {
    const client = createClient();
    await client.connect();
    client.subscribe("run-1");
    await new Promise((r) => setTimeout(r, 50));

    serverSend({ type: "snapshot", runId: "run-1", snapshot: makeSnapshot(0) });
    await new Promise((r) => setTimeout(r, 50));
    expect(client.state.has("run-1")).toBe(true);

    client.unsubscribe("run-1");
    expect(client.state.has("run-1")).toBe(false);

    client.disconnect();
  });

  test("delta adds new processes", async () => {
    const client = createClient();
    await client.connect();
    client.subscribe("run-1");
    await new Promise((r) => setTimeout(r, 50));

    serverSend({ type: "snapshot", runId: "run-1", snapshot: makeSnapshot(0) });
    await new Promise((r) => setTimeout(r, 50));

    const statePromise = client.waitFor("state", (d) => d.snapshot.tick === 1);

    serverSend({
      type: "delta",
      runId: "run-1",
      delta: {
        tick: 1,
        timestamp: new Date().toISOString(),
        processes: {
          added: [{
            pid: "p2",
            name: "worker-1",
            type: "lifecycle",
            state: "running",
            role: "worker",
            parentPid: "p1",
            children: [],
            objective: "do work",
            priority: 70,
            tickCount: 0,
            tokensUsed: 0,
            tokenBudget: null,
            model: "test",
            spawnedAt: new Date().toISOString(),
            lastActiveAt: new Date().toISOString(),
            backendKind: undefined,
            selfReports: [],
            blackboardIO: [],
          }],
          removed: [],
          changed: [],
        },
      },
    });

    const { snapshot } = await statePromise;
    expect(snapshot.processes).toHaveLength(2);
    expect(snapshot.processes[1].name).toBe("worker-1");

    client.disconnect();
  });
});
