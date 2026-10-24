import { Pool } from "pg";
import { DEFAULT_GEMINI_MODEL, createGeminiModel, geminiModelName, thinkingFor } from "../onboarding/gemini";
import { ActivityLog } from "./activity";
import { WALKER_TIMEOUT_MS, createWalkerAssistant, type WalkerAssistant } from "./assistant";
import { createHedgedAssistant } from "./hedge";
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

/** The walker assistant's own model; onboarding keeps DEFAULT_GEMINI_MODEL. */
export const WALKER_DEFAULT_MODEL = DEFAULT_GEMINI_MODEL;

/**
 * The backup model's thinking setting: "minimal" on the models measured to accept it (checked live
 * 2026-10-23; gemini-3.7-flash rejects it), otherwise onboarding's thinkingFor. The main model keeps
 * thinkingFor, as before the backup.
 */
export function backupThinkingFor(model: string): Record<string, unknown> | null {
  if (/^gemini-3\.6-flash$|^gemini-3\.5-flash-lite$/.test(model)) return { thinkingLevel: "minimal" };
  return thinkingFor(model);
}

/** The backup model, asked alongside the main one (see hedge.ts); measured live 2026-10-23. */
export const WALKER_BACKUP_MODEL = "gemini-3.6-flash";
/** How long the main model has before the backup's answer is used: the most switching with no bad answer used in the live sweep, leaving the voice its 3 s. */
export const WALKER_BACKUP_AFTER_MS = 4_500;

export interface WalkerModels {
  main: string;
  /** null: no backup, one model as before. */
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
  // "none" leaves the main model at its default, as it always has.
  const main = geminiModelName(rawMain && rawMain.toLowerCase() !== "none" ? rawMain : WALKER_DEFAULT_MODEL);
  const rawBackup = env.WALKER_BACKUP_MODEL?.trim() || WALKER_BACKUP_MODEL;
  const backup = rawBackup.toLowerCase() === "none" ? null : geminiModelName(rawBackup);
  const rawAfter = env.WALKER_BACKUP_AFTER_MS?.trim();
  const after = rawAfter ? Number(rawAfter) : NaN;
  const backupAfterMs = Number.isInteger(after) && after >= 0 && after <= WALKER_TIMEOUT_MS ? after : WALKER_BACKUP_AFTER_MS;
  return { main, backup, backupAfterMs };
}

/** The walker assistant for these models: one model, or the main one with its backup. */
export function createWalkerAssistantFor(apiKey: string, models: WalkerModels, fetch?: typeof globalThis.fetch): WalkerAssistant {
  const main = createWalkerAssistant({ model: createGeminiModel({ apiKey, model: models.main, fetch }), name: models.main });
  if (!models.backup) return main;
  const backup = createWalkerAssistant({ model: createGeminiModel({ apiKey, model: models.backup, thinking: backupThinkingFor(models.backup), fetch }), name: models.backup });
  return createHedgedAssistant({ main, backup, backupAfterMs: models.backupAfterMs });
}

export interface WalkerAgent {
  assistant: WalkerAssistant | null;
  voice: WalkerVoice | null;
}

/**
 * The walker assistant's model and voice from the server's environment:
 *
 * - GEMINI_API_KEY: the walker always uses Gemini, whatever ONBOARDING_AGENT_PROVIDER says, because
 *   voice turns need audio input. The models come from walkerModelsFromEnv: the main one
 *   (WALKER_DEFAULT_MODEL) and a backup asked alongside it (WALKER_BACKUP_MODEL); onboarding's model is
 *   set separately. Without the key every turn gets a fixed line, marked as such.
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
    assistant: gemini ? createWalkerAssistantFor(gemini, walkerModelsFromEnv(env)) : null,
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
