import { Client } from "@neondatabase/serverless";
const pg = { Client };
const runId = process.argv[2] || "90ac6081-d48f-4795-8d58-a93a589f773a";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const res = await c.query(
  "SELECT data FROM kernel_run_snapshots WHERE run_id = $1 ORDER BY id DESC LIMIT 1",
  [runId]
);
if (res.rows.length) {
  const snap = res.rows[0].data;
  const procs = snap.processes || [];
  for (const p of procs) {
    console.log(p.name, p.state, `turns=${p.tickCount || 0}`, `tokens=${p.tokensUsed || 0}`);
  }
  console.log("\nBlackboard keys:", Object.keys(snap.blackboard || {}));
  console.log("Halted:", snap.halted, "Reason:", snap.haltReason);
} else {
  console.log("No snapshots found for run", runId);
}
await c.end();
