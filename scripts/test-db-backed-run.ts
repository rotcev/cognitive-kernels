import { config as loadDotenv } from "dotenv";
loadDotenv();

import { createDbConnection } from "../src/db/connection.js";
import { NeonStorageBackend } from "../src/db/storage-backend.js";
import { runs, runEvents } from "../src/db/schema.js";
import { eq } from "drizzle-orm";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const db = createDbConnection(url);
const backend = new NeonStorageBackend(db);

console.log("Connecting...");
await backend.connect();
await backend.loadRuns();
console.log("Connected:", backend.isConnected());

const allRuns = backend.listRuns();
console.log(`\nRuns in DB: ${allRuns.length}`);

for (const run of allRuns) {
  const events = await db.select().from(runEvents).where(eq(runEvents.runId, run.id));
  const hasArtifacts = run.artifacts ? "filesystem" : "db-only";
  console.log(
    `  ${run.id.slice(0, 8)} | ${run.status.padEnd(10)} | ${String(events.length).padStart(4)} events | ${hasArtifacts.padEnd(10)} | ${run.input?.goal?.slice(0, 50) ?? "no goal"}`,
  );
}

console.log("\nDone. DB-backed run infrastructure is ready.");
console.log("To test: start the MCP server with DATABASE_URL set, then create a run.");
