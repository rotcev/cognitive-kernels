import * as schema from "./schema.js";
import { NeonStorageBackend, type StorageBackend } from "./storage-backend.js";

// Both adapters share the same drizzle result shape
export type DbConnection = ReturnType<typeof import("drizzle-orm/neon-http").drizzle<typeof schema>>;

let _cachedDb: DbConnection | null = null;
let _connectionUrl: string | null = null;

export async function createDbConnectionAsync(databaseUrl: string): Promise<DbConnection> {
  // Cache: if we already created a connection for this URL, return it
  if (_cachedDb && _connectionUrl === databaseUrl) return _cachedDb;

  let db: DbConnection;

  if (databaseUrl.includes("neon.tech")) {
    // Neon serverless — HTTP-based driver
    const { neon } = await import("@neondatabase/serverless");
    const { drizzle } = await import("drizzle-orm/neon-http");
    const sql = neon(databaseUrl);
    db = drizzle(sql, { schema }) as unknown as DbConnection;
  } else {
    // Standard Postgres — TCP via node-postgres
    const pg = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new pg.default.Pool({ connectionString: databaseUrl });
    db = drizzle(pool, { schema }) as unknown as DbConnection;
  }

  _cachedDb = db;
  _connectionUrl = databaseUrl;
  return db;
}

// Synchronous wrapper for backward compatibility — uses cached connection
export function createDbConnection(databaseUrl: string): DbConnection {
  if (_cachedDb && _connectionUrl === databaseUrl) return _cachedDb;
  // Fallback: try Neon import (works for Neon URLs in contexts where this is called synchronously)
  // For local postgres, callers should use createDbConnectionAsync first.
  throw new Error("Call createDbConnectionAsync() first, or use connectStorage()");
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

  const db = await createDbConnectionAsync(url);
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
