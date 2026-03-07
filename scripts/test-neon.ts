import { createDbConnection } from "../src/db/connection.js";
import { NeonStorageBackend } from "../src/db/storage-backend.js";
import { runs, runEvents } from "../src/db/schema.js";
import type { KernelRun } from "../src/types.js";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const db = createDbConnection(url);
const backend = new NeonStorageBackend(db);

console.log("Connecting...");
await backend.connect();
console.log("Connected:", backend.isConnected());

console.log("Saving a test run...");
await backend.saveRun({
  id: "test-run-001",
  status: "completed",
  pid: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  command: "node",
  args: ["dist/cli.js", "os"],
  input: { goal: "Integration test", cwd: "/tmp" },
  artifacts: {
    runDir: "/tmp/runs/test-run-001",
    runFilePath: "/tmp/runs/test-run-001/run.json",
    outputPath: "/tmp/runs/test-run-001/output.json",
    protocolLogPath: "/tmp/runs/test-run-001/protocol.ndjson",
    livePath: "/tmp/runs/test-run-001/os-live.json",
    snapshotPath: "/tmp/runs/test-run-001/os-snapshot.json",
    stdoutPath: "/tmp/runs/test-run-001/stdout.log",
    stderrPath: "/tmp/runs/test-run-001/stderr.log",
  },
} as KernelRun);
console.log("Run saved!");

console.log("Appending events...");
await backend.appendEvents("test-run-001", [
  { action: "os_tick", status: "completed" as const, timestamp: new Date().toISOString(), message: "tick=1", eventSource: "os" },
  { action: "os_tick", status: "completed" as const, timestamp: new Date().toISOString(), message: "tick=2", eventSource: "os" },
]);
console.log("Events appended!");

const dbRuns = await db.select().from(runs);
console.log("Runs in DB:", dbRuns.length);
console.log("First run ID:", dbRuns[0]?.id);
console.log("First run status:", dbRuns[0]?.status);

const dbEvents = await db.select().from(runEvents);
console.log("Events in DB:", dbEvents.length);

console.log("\nAll good! Neon is wired up.");
