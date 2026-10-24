import { Pool } from "pg";
import { createGeminiModel } from "../onboarding/gemini";
import { ActivityLog } from "./activity";
import { createWalkerAssistant, type WalkerAssistant } from "./assistant";
import { PostgresWalkerStore } from "./postgres-store";
import { createCartesiaVoice, type WalkerVoice } from "./speech";
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

export interface WalkerAgent {
  assistant: WalkerAssistant | null;
  voice: WalkerVoice | null;
}

/**
 * The walker assistant's model and voice from the server's environment:
 *
 * - GEMINI_API_KEY: the walker always uses Gemini, whatever ONBOARDING_AGENT_PROVIDER says, because
 *   voice turns need audio input. WALKER_AGENT_MODEL optionally overrides the model. Without the key
 *   every turn gets a fixed line, marked as such.
 * - CARTESIA_API_KEY: Steady's spoken voice (CARTESIA_VOICE_ID optionally picks another stock voice).
 *   Without it (or set to "none"), the walker speaks replies with its own voice.
 */
export function walkerAgentFromEnv(env: Record<string, string | undefined>): WalkerAgent {
  const set = (name: string) => {
    const value = env[name]?.trim();
    return value && value.toLowerCase() !== "none" ? value : undefined;
  };
  const gemini = set("GEMINI_API_KEY");
  const cartesia = set("CARTESIA_API_KEY");
  return {
    assistant: gemini ? createWalkerAssistant({ model: createGeminiModel({ apiKey: gemini, model: set("WALKER_AGENT_MODEL") }) }) : null,
    voice: cartesia ? createCartesiaVoice({ apiKey: cartesia, voiceId: set("CARTESIA_VOICE_ID") }) : null,
  };
}

const globalForWalker = globalThis as unknown as { __walkerBackend?: WalkerBackend; __walkerAgent?: WalkerAgent };

/**
 * One backend per server process, shared by the start-up hook and every route (Next.js bundles them
 * separately, so a module-level variable wouldn't be shared) and kept across dev hot reloads, so the
 * memory store keeps its walkers and Postgres keeps one connection pool.
 */
export function sharedWalkerBackend(env: Record<string, string | undefined> = process.env): WalkerBackend {
  return (globalForWalker.__walkerBackend ??= walkerBackendFromEnv(env));
}

/** The model and voice, made once per server process. The keys stay on the server. */
export function sharedWalkerAgent(env: Record<string, string | undefined> = process.env): WalkerAgent {
  return (globalForWalker.__walkerAgent ??= walkerAgentFromEnv(env));
}

const globalForActivity = globalThis as unknown as { __walkerActivity?: ActivityLog };

/**
 * The page's live companion log, one per server process for the same reason as the backend: every
 * route builds its own WalkerService, and a turn's route must write where the list route reads.
 */
export function sharedWalkerActivity(): ActivityLog {
  return (globalForActivity.__walkerActivity ??= new ActivityLog());
}
