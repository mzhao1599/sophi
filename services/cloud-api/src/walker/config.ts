import { Pool } from "pg";
import { PostgresWalkerStore } from "./postgres-store";
import { MemoryWalkerStore, type WalkerStore } from "./store";

/** Where walkers are kept, chosen by walkerBackendFromEnv. */
export type WalkerBackend =
  | { kind: "postgres" | "memory"; store: WalkerStore; blocked?: undefined }
  /** Production without a database: every walker route answers 503 with `blocked`. */
  | { kind: "off"; store: WalkerStore; blocked: string };

/**
 * Chooses the walker store from the server's environment:
 *
 * - DATABASE_URL set (Render's web service gets it from its Postgres database): Postgres.
 * - Not set, outside production: the in-memory store, for local runs.
 * - Not set in production (such as the Vercel onboarding site): walkers are off, because a paired
 *   walker's credential must survive a restart. Onboarding is unaffected.
 */
export function walkerBackendFromEnv(env: Record<string, string | undefined>, warn: (message: string) => void = console.warn): WalkerBackend {
  const url = env.DATABASE_URL?.trim();
  if (url) {
    // Render's free Postgres has no connection pooler, so keep this small.
    const pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 });
    // An idle connection dropped by the database must not crash the server; the next query reconnects.
    pool.on("error", (error) => warn(`[walker] an idle database connection failed (code ${"code" in error ? String(error.code) : "unknown"})`));
    return { kind: "postgres", store: new PostgresWalkerStore(pool) };
  }
  if (env.NODE_ENV === "production") {
    warn("[walker] No DATABASE_URL in production; walker routes answer 503.");
    return { kind: "off", store: new MemoryWalkerStore(), blocked: "Walkers aren't set up on this server." };
  }
  return { kind: "memory", store: new MemoryWalkerStore() };
}

const globalForWalker = globalThis as unknown as { __walkerBackend?: WalkerBackend };

/**
 * One backend per server process, shared by the start-up hook and every route (Next.js bundles them
 * separately, so a module-level variable wouldn't be shared) and kept across dev hot reloads, so the
 * memory store keeps its walkers and Postgres keeps one connection pool.
 */
export function sharedWalkerBackend(env: Record<string, string | undefined> = process.env): WalkerBackend {
  return (globalForWalker.__walkerBackend ??= walkerBackendFromEnv(env));
}
