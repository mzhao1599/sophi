import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAgentEngine } from "./agent";
import { createAnthropicModel } from "./anthropic";
import { deterministicEngine, type TurnEngine } from "./engine";
import { createGeminiModel } from "./gemini";
import { MemorySessionStore } from "./store";

const PROVIDER_KEYS = { anthropic: "ANTHROPIC_API_KEY", gemini: "GEMINI_API_KEY" } as const;
export type AgentProvider = keyof typeof PROVIDER_KEYS;

/** Who reads the user's words when the agent runs, and who may keep a copy, as the first screen's notice names them. */
export const AGENT_PROVIDER_NAMES: Record<AgentProvider, { model: string; company: string }> = {
  anthropic: { model: "Anthropic's Claude", company: "Anthropic" },
  gemini: { model: "Google's Gemini", company: "Google" },
};

/** The notice's clause for the agent: who reads the answers and who may keep them, under its own terms. */
export function agentNoticeClause(provider: AgentProvider): string {
  const { model, company } = AGENT_PROVIDER_NAMES[provider];
  return `${model} reads them to choose each question, and ${company} may keep a copy`;
}

const MODEL_PREFIX: Record<AgentProvider, string> = { anthropic: "claude-", gemini: "gemini-" };

type AgentChoice = { provider: AgentProvider; apiKey: string } | { problem: string } | null;

/** The agent the environment asks for, or why it can't run, or null for the deterministic engine. */
function chooseAgent(env: Record<string, string | undefined>): AgentChoice {
  const choice = env.ONBOARDING_ENGINE?.trim() || "deterministic";
  if (choice === "deterministic") return null;
  if (choice !== "agent") return { problem: `ONBOARDING_ENGINE=${JSON.stringify(choice)} isn't "deterministic" or "agent"` };
  const keyFor = (provider: AgentProvider) => env[PROVIDER_KEYS[provider]]?.trim() || undefined;
  const asked = env.ONBOARDING_AGENT_PROVIDER?.trim() || undefined;
  if (asked !== undefined && asked !== "anthropic" && asked !== "gemini") {
    return { problem: `ONBOARDING_AGENT_PROVIDER=${JSON.stringify(asked)} isn't "anthropic" or "gemini"` };
  }
  const provider = asked ?? (keyFor("anthropic") ? "anthropic" : keyFor("gemini") ? "gemini" : undefined);
  const apiKey = provider && keyFor(provider);
  if (!provider || !apiKey) {
    return { problem: `ONBOARDING_ENGINE=agent but ${provider ? PROVIDER_KEYS[provider] : "ANTHROPIC_API_KEY or GEMINI_API_KEY"} isn't set` };
  }
  return { provider, apiKey };
}

/**
 * Chooses the onboarding engine from the server's environment:
 *
 * - ONBOARDING_ENGINE: `deterministic` (the default) or `agent`.
 * - ONBOARDING_AGENT_PROVIDER: optional, `anthropic` or `gemini`. Unset, the agent uses Claude when
 *   ANTHROPIC_API_KEY is set and otherwise Gemini when GEMINI_API_KEY is set.
 * - ANTHROPIC_API_KEY or GEMINI_API_KEY: the chosen provider's key. Without it the deterministic
 *   engine runs, exactly as before.
 * - ONBOARDING_AGENT_MODEL: optional model override for the chosen provider.
 */
export function engineFromEnv(env: Record<string, string | undefined>, warn: (message: string) => void = console.warn): TurnEngine {
  const chosen = chooseAgent(env);
  if (!chosen) return deterministicEngine;
  if ("problem" in chosen) {
    warn(`[onboarding] ${chosen.problem}; using the deterministic engine.`);
    return deterministicEngine;
  }
  const { provider, apiKey } = chosen;
  const model = env.ONBOARDING_AGENT_MODEL?.trim() || undefined;
  // One override serves both providers, so a model name left over from the other one would fail every turn.
  if (model && !model.replace(/^models\//, "").startsWith(MODEL_PREFIX[provider])) {
    warn(`[onboarding] ONBOARDING_AGENT_MODEL=${JSON.stringify(model)} doesn't look like a ${provider} model; check ONBOARDING_AGENT_PROVIDER.`);
  }
  return createAgentEngine({ model: provider === "gemini" ? createGeminiModel({ apiKey, model }) : createAnthropicModel({ apiKey, model }) });
}

/** The provider engineFromEnv runs the agent with, or null when it runs the deterministic engine. */
export function agentProviderFromEnv(env: Record<string, string | undefined>): AgentProvider | null {
  const chosen = chooseAgent(env);
  return chosen && "provider" in chosen ? chosen.provider : null;
}

/** Where sessions are kept, chosen by storeBackendFromEnv. */
export type StoreBackend =
  | {
      kind: "memory";
      store: MemorySessionStore;
      /** Why this server must not start sessions, if it mustn't; passed to OnboardingService as `startBlocked`. */
      startBlocked?: string;
    }
  | {
      kind: "supabase";
      url: string;
      publishableKey: string;
      /** Service-role client for demo sessions. Server only: it bypasses row-level security. */
      admin: SupabaseClient;
    };

const SUPABASE_VARS = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SECRET_KEY"] as const;

/**
 * Chooses the session store from the server's environment:
 *
 * - NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY and SUPABASE_SECRET_KEY all set:
 *   Supabase (Postgres with row-level security).
 * - None of them set: the in-memory store, exactly as before. In production (NODE_ENV=production,
 *   which includes every Vercel deployment) starting a session is refused unless
 *   ONBOARDING_ALLOW_MEMORY_STORE=true, because instances don't share memory.
 * - Some but not all: refused everywhere, naming the missing variables in the server log.
 */
export function storeBackendFromEnv(env: Record<string, string | undefined>, warn: (message: string) => void = console.warn): StoreBackend {
  const value = (name: (typeof SUPABASE_VARS)[number]) => env[name]?.trim() || undefined;
  const missing = SUPABASE_VARS.filter((name) => !value(name));
  const store = new MemorySessionStore();
  if (missing.length === 0) {
    const url = value("NEXT_PUBLIC_SUPABASE_URL")!;
    if (!/^https?:\/\//.test(url) || !URL.canParse(url)) {
      warn("[onboarding] NEXT_PUBLIC_SUPABASE_URL isn't an http(s) URL. Onboarding won't start until it is.");
      return { kind: "memory", store, startBlocked: "Saving isn't set up correctly on this server yet, so setup can't start. Please try again later." };
    }
    const admin = createClient(url, value("SUPABASE_SECRET_KEY")!, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    return { kind: "supabase", url, publishableKey: value("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY")!, admin };
  }
  if (missing.length < SUPABASE_VARS.length) {
    warn(`[onboarding] Supabase is partly configured; missing ${missing.join(", ")}. Onboarding won't start until all three are set or none are.`);
    return { kind: "memory", store, startBlocked: "Saving isn't set up correctly on this server yet, so setup can't start. Please try again later." };
  }
  if (env.NODE_ENV === "production" && env.ONBOARDING_ALLOW_MEMORY_STORE?.trim() !== "true") {
    warn("[onboarding] No Supabase configuration in production; onboarding won't start. Set the Supabase variables, or ONBOARDING_ALLOW_MEMORY_STORE=true for a single-instance demo.");
    return { kind: "memory", store, startBlocked: "Saving isn't set up on this server yet, so setup can't start. Please try again later." };
  }
  return { kind: "memory", store };
}
