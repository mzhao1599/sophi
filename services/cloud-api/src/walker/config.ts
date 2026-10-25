import { Pool } from "pg";
import type { WalkerModel } from "@walker/contracts";
import { createAnthropicModel } from "../onboarding/anthropic";
import { ActivityLog } from "./activity";
import { WALKER_TIMEOUT_MS, createWalkerAssistant, type WalkerAssistant } from "./assistant";
import { createHedgedAssistant } from "./hedge";
import { CareDbClient, careDbConfigFromEnv, type CareDbConfig } from "./care-db";
import { PostgresWalkerStore } from "./postgres-store";
import { SpacetimeCircleStore } from "./spacetime-store";
import { createCartesiaEars, createCartesiaVoice, type WalkerEars, type WalkerVoice } from "./speech";
import { MemoryWalkerStore, type WalkerStore } from "./store";

/** Where walkers are kept, chosen by walkerBackendFromEnv. */
export type WalkerBackend =
  /** `care`: the circle lives in SpacetimeDB (SpacetimeCircleStore), with these settings. */
  | { kind: "postgres" | "memory"; store: WalkerStore; blocked?: undefined; care?: CareDbConfig }
  /** Production without a database: every walker route answers 503 with `blocked`. */
  | { kind: "off"; store: WalkerStore; blocked: string; care?: undefined };

/**
 * Chooses the walker store from the server's environment:
 *
 * - DATABASE_URL set (Render's web service gets it from its Postgres database): Postgres.
 * - Not set, outside production: the in-memory store, for local runs.
 * - Not set in production (such as the Vercel onboarding site): walkers are off, because a paired
 *   walker's credential must survive a restart. Onboarding is unaffected.
 *
 * With the four SPACETIME_* settings as well (careDbConfigFromEnv), the circle moves to SpacetimeDB and the
 * rest stays where it is (SpacetimeCircleStore).
 */
export function walkerBackendFromEnv(env: Record<string, string | undefined>, warn: (message: string) => void = console.warn): WalkerBackend {
  const backend = baseBackendFromEnv(env, warn);
  const care = careDbConfigFromEnv(env, warn);
  if (!care || backend.kind === "off") return backend;
  return { kind: backend.kind, store: new SpacetimeCircleStore(backend.store, new CareDbClient(care)), care };
}

function baseBackendFromEnv(env: Record<string, string | undefined>, warn: (message: string) => void): WalkerBackend {
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

/**
 * The walker's main model: Claude Haiku 5.5, the fastest Claude, because a spoken reply has a few seconds.
 * Onboarding keeps its own model (onboarding/anthropic.ts).
 */
export const WALKER_DEFAULT_MODEL = "claude-haiku-5-5";

/** The backup model, asked alongside the main one (see hedge.ts): Claude Opus 5.5. */
export const WALKER_BACKUP_MODEL = "claude-opus-5-5";
/** How long the main model has before the backup's answer is used, leaving the voice its 3 s of the 8 s turn. */
export const WALKER_BACKUP_AFTER_MS = 4_500;

export interface WalkerModels {
  main: string;
  /** null: no backup, one model. */
  backup: string | null;
  backupAfterMs: number;
}

/**
 * The walker's models from the environment: WALKER_AGENT_MODEL (the main one), WALKER_BACKUP_MODEL
 * ("none" turns the backup off) and WALKER_BACKUP_AFTER_MS (whole milliseconds, 0 to WALKER_TIMEOUT_MS;
 * anything else keeps the default).
 */
export function walkerModelsFromEnv(env: Record<string, string | undefined>): WalkerModels {
  const rawMain = env.WALKER_AGENT_MODEL?.trim();
  // "none" leaves the main model at its default.
  const main = rawMain && rawMain.toLowerCase() !== "none" ? rawMain : WALKER_DEFAULT_MODEL;
  const rawBackup = env.WALKER_BACKUP_MODEL?.trim() || WALKER_BACKUP_MODEL;
  const backup = rawBackup.toLowerCase() === "none" ? null : rawBackup;
  const rawAfter = env.WALKER_BACKUP_AFTER_MS?.trim();
  const after = rawAfter ? Number(rawAfter) : NaN;
  const backupAfterMs = Number.isInteger(after) && after >= 0 && after <= WALKER_TIMEOUT_MS ? after : WALKER_BACKUP_AFTER_MS;
  return { main, backup, backupAfterMs };
}

/** The walker assistant for these models: one model, or the main one with its backup. */
export function createWalkerAssistantFor(apiKey: string, models: WalkerModels, fetch?: typeof globalThis.fetch): WalkerAssistant {
  const main = createWalkerAssistant({ model: createAnthropicModel({ apiKey, model: models.main, fetch }), name: models.main, provider: "claude" });
  if (!models.backup) return main;
  const backup = createWalkerAssistant({ model: createAnthropicModel({ apiKey, model: models.backup, fetch }), name: models.backup, provider: "claude" });
  return createHedgedAssistant({ main, backup, backupAfterMs: models.backupAfterMs });
}

const setting = (env: Record<string, string | undefined>, name: string) => {
  const value = env[name]?.trim();
  return value && value.toLowerCase() !== "none" ? value : undefined;
};

/** Who answers walker turns with this environment, for the page's notice: Claude, or no model (fixed replies). */
export function walkerModelFromEnv(env: Record<string, string | undefined>): WalkerModel | null {
  return setting(env, "ANTHROPIC_API_KEY") ? "claude" : null;
}

export interface WalkerAgent {
  /** Every turn, typed or spoken: Claude. null: fixed replies. */
  assistant: WalkerAssistant | null;
  /** Turns a Talk clip into words before Claude reads them: Cartesia. null: spoken turns get a fixed line. */
  ears: WalkerEars | null;
  voice: WalkerVoice | null;
}

/**
 * The walker assistant's model, hearing and voice from the server's environment:
 *
 * - ANTHROPIC_API_KEY: Claude answers every turn. The models come from walkerModelsFromEnv: the main one
 *   (WALKER_DEFAULT_MODEL) and a backup asked alongside it (WALKER_BACKUP_MODEL); onboarding's model is
 *   set separately. Without the key every turn gets a fixed line, marked as such.
 * - CARTESIA_API_KEY: Cartesia hears spoken turns (speech-to-text, then Claude reads the words) and gives
 *   Sophi's spoken voice (CARTESIA_VOICE_ID optionally picks another stock voice). Without it (or set to
 *   "none"), a Talk press gets a fixed "can't hear" line and the walker speaks replies with its own voice.
 */
export function walkerAgentFromEnv(env: Record<string, string | undefined>): WalkerAgent {
  const set = (name: string) => setting(env, name);
  const anthropic = set("ANTHROPIC_API_KEY");
  const cartesia = set("CARTESIA_API_KEY");
  return {
    assistant: anthropic ? createWalkerAssistantFor(anthropic, walkerModelsFromEnv(env)) : null,
    ears: cartesia ? createCartesiaEars({ apiKey: cartesia }) : null,
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
