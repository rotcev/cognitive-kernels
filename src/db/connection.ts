import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema.js";
import { NeonStorageBackend, type StorageBackend } from "./storage-backend.js";

export type DbConnection = ReturnType<typeof drizzle<typeof schema>>;

export function createDbConnection(databaseUrl: string): DbConnection {
  const sql = neon(databaseUrl);
  return drizzle(sql, { schema });
}

let activeBackend: StorageBackend | null = null;

export async function connectStorage(databaseUrl?: string): Promise<StorageBackend> {
  if (activeBackend) {
    return activeBackend;
  }

  const url = databaseUrl ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is required — pass it as an argument or set it in the environment");
  }

  const db = createDbConnection(url);
  const backend = new NeonStorageBackend(db);
  await backend.connect();
  await backend.loadRuns();
  activeBackend = backend;
  return backend;
}

export async function disconnectStorage(): Promise<void> {
  if (!activeBackend) {
    return;
  }

  await activeBackend.disconnect();
  activeBackend = null;
}
