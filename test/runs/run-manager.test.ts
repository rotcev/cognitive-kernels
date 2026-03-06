import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  KernelRunManager,
  resolveDefaultCliScriptPath,
} from "../../src/runs/run-manager.js";
import type { KernelRun } from "../../src/types.js";

type SpawnCall = {
  command: string;
  args: string[];
  cwd: string;
};

class FakeChildProcess extends EventEmitter {
  pid: number;
  stdout: PassThrough;
  stderr: PassThrough;
  killSignals: Array<NodeJS.Signals | number | undefined> = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignals.push(signal);
    return true;
  }
}

function createSpawnHarness() {
  const calls: SpawnCall[] = [];
  const children: FakeChildProcess[] = [];
  let nextPid = 20_000;

  const spawnFn = ((command: string, args: readonly string[], options: { cwd?: string } = {}) => {
    const child = new FakeChildProcess(nextPid);
    nextPid += 1;

    calls.push({
      command,
      args: [...args],
      cwd: options.cwd ?? "",
    });
    children.push(child);

    return child as unknown as ChildProcess;
  }) as unknown as typeof import("node:child_process").spawn;

  return {
    calls,
    children,
    spawnFn,
  };
}

async function waitForRunStatus(
  manager: KernelRunManager,
  runId: string,
  status: string,
  timeoutMs = 500,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const run = manager.getRun(runId);
    if (run?.status === status) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`Timed out waiting for run ${runId} to reach status ${status}`);
}

describe("KernelRunManager", () => {
  test("resolves the default CLI path from the package root", () => {
    const expected = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
      "dist",
      "cli.js",
    );
    expect(resolveDefaultCliScriptPath()).toBe(expected);
  });

  test("starts an OS run, persists metadata, and marks completion on exit", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cognitive-kernels-manager-"));
    const runsRoot = path.join(tempRoot, "runs");
    const scriptPath = path.join(tempRoot, "dist", "cli.js");
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, "#!/usr/bin/env node\n", "utf8");

    const harness = createSpawnHarness();
    const manager = new KernelRunManager({
      runsRoot,
      scriptPath,
      nodePath: "/usr/bin/node",
      spawnFn: harness.spawnFn,
    });

    await manager.initialize();

    const run = await manager.startRun({
      goal: "Map the repo topology",
      configPath: "./kernel.toml",
      cwd: "/tmp/workspace/project",
      provider: "codex",
    });

    expect(run.status).toBe("running");
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.command).toBe("/usr/bin/node");
    expect(harness.calls[0]?.args).toContain("os");
    expect(harness.calls[0]?.args).toContain("--goal");
    expect(harness.calls[0]?.args).toContain("Map the repo topology");
    expect(harness.calls[0]?.args).toContain("--provider");
    expect(harness.calls[0]?.args).toContain("codex");

    harness.children[0]?.emit("exit", 0, null);
    await waitForRunStatus(manager, run.id, "completed");

    const completedRun = manager.getRun(run.id);
    expect(completedRun?.status).toBe("completed");
    expect(completedRun?.exitCode).toBe(0);

    const persisted = JSON.parse(await readFile(run.artifacts.runFilePath, "utf8")) as KernelRun;
    expect(persisted.status).toBe("completed");
    expect(persisted.exitCode).toBe(0);
    expect(persisted.artifacts.livePath.endsWith("os-live.json")).toBe(true);
  });

  test("supports pause, resume, and cancel transitions", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cognitive-kernels-manager-"));
    const runsRoot = path.join(tempRoot, "runs");
    const scriptPath = path.join(tempRoot, "dist", "cli.js");
    await mkdir(path.dirname(scriptPath), { recursive: true });
    await writeFile(scriptPath, "#!/usr/bin/env node\n", "utf8");

    const harness = createSpawnHarness();
    const manager = new KernelRunManager({
      runsRoot,
      scriptPath,
      spawnFn: harness.spawnFn,
    });

    await manager.initialize();

    const run = await manager.startRun({
      goal: "Investigate the stalled verifier",
      cwd: "/tmp/workspace/project",
    });

    await manager.pauseRun(run.id);
    expect(manager.getRun(run.id)?.status).toBe("paused");

    await manager.resumeRun(run.id);
    expect(manager.getRun(run.id)?.status).toBe("running");

    await manager.cancelRun(run.id);
    expect(manager.getRun(run.id)?.status).toBe("canceled");

    const signals = harness.children[0]?.killSignals ?? [];
    expect(signals).toContain("SIGSTOP");
    expect(signals).toContain("SIGCONT");
    expect(signals).toContain("SIGTERM");
  });

  test("marks stale persisted active runs as failed during initialization", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "cognitive-kernels-stale-run-"));
    const runsRoot = path.join(tempRoot, "runs");
    const runDir = path.join(runsRoot, "run-stale");
    await mkdir(runDir, { recursive: true });

    const run: KernelRun = {
      id: "run-stale",
      status: "running",
      pid: 999_999,
      createdAt: "2026-03-05T00:00:00.000Z",
      updatedAt: "2026-03-05T00:00:00.000Z",
      command: "/usr/bin/node",
      args: ["dist/cli.js", "os"],
      input: {
        goal: "Do work",
        cwd: "/repo",
      },
      artifacts: {
        runDir,
        runFilePath: path.join(runDir, "run.json"),
        outputPath: path.join(runDir, "output.json"),
        protocolLogPath: path.join(runDir, "protocol.ndjson"),
        livePath: path.join(runDir, "os-live.json"),
        snapshotPath: path.join(runDir, "os-snapshot.json"),
        stdoutPath: path.join(runDir, "stdout.log"),
        stderrPath: path.join(runDir, "stderr.log"),
      },
    };

    await writeFile(run.artifacts.runFilePath, `${JSON.stringify(run, null, 2)}\n`, "utf8");

    const manager = new KernelRunManager({
      runsRoot,
      scriptPathExistsFn: () => true,
    });

    await manager.initialize();

    const reconciled = manager.getRun(run.id);
    expect(reconciled?.status).toBe("failed");
    expect(reconciled?.error).toContain("not alive");
  });
});
