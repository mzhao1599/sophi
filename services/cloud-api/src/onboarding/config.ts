import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAgentEngine } from "./agent";
import { createAnthropicModel } from "./anthropic";
import { deterministicEngine, type TurnEngine } from "./engine";
import { MemorySessionStore } from "./store";

/** The agent's provider. Claude is the only one; the type keeps the notice's wording in one place. */
export type AgentProvider = "anthropic";

/** The model's short name while the agent runs. */
export function agentModelName(_provider: AgentProvider): string {
  return "Claude";
}

type AgentChoice = { provider: AgentProvider; apiKey: string } | { problem: string } | null;

/** The key, or undefined when it is empty or "none" (the walker assistant reads it the same way). */
function apiKeyFrom(env: Record<string, string | undefined>): string | undefined {
  const value = env.ANTHROPIC_API_KEY?.trim();
  return value && value.toLowerCase() !== "none" ? value : undefined;
}

/** The agent the environment asks for, or why it can't run, or null for the deterministic engine. */
function chooseAgent(env: Record<string, string | undefined>): AgentChoice {
  const apiKey = apiKeyFrom(env);
  // Unset: the agent when there is a key, the fixed questions when there isn't, with no warning either way.
  const choice = env.ONBOARDING_ENGINE?.trim() || (apiKey ? "agent" : "deterministic");
  if (choice === "deterministic") return null;
  if (choice !== "agent") return { problem: `ONBOARDING_ENGINE=${JSON.stringify(choice)} isn't "deterministic" or "agent"` };
  if (!apiKey) return { problem: "ONBOARDING_ENGINE=agent but ANTHROPIC_API_KEY isn't set" };
  return { provider: "anthropic", apiKey };
}

/**
 * Chooses the onboarding engine from the server's environment:
 *
 * - ANTHROPIC_API_KEY: the agent's key, the same one the walker assistant uses. With it the agent runs;
 *   without it (or set to "none") the deterministic engine runs, exactly as before.
 * - ONBOARDING_ENGINE: optional. `deterministic` forces the fixed questions even with a key; `agent`
 *   warns when there's no key. Any other value warns and runs the fixed questions.
 * - ONBOARDING_AGENT_MODEL: optional Claude model override.
 */
export function engineFromEnv(env: Record<string, string | undefined>, warn: (message: string) => void = console.warn): TurnEngine {
  const chosen = chooseAgent(env);
  if (!chosen) return deterministicEngine;
  if ("problem" in chosen) {
    warn(`[onboarding] ${chosen.problem}; using the deterministic engine.`);
    return deterministicEngine;
  }
  const model = env.ONBOARDING_AGENT_MODEL?.trim() || undefined;
  // A model name left over from another provider would fail every turn.
  if (model && !model.startsWith("claude-")) {
    warn(`[onboarding] ONBOARDING_AGENT_MODEL=${JSON.stringify(model)} doesn't look like a Claude model.`);
  }
  return createAgentEngine({ model: createAnthropicModel({ apiKey: chosen.apiKey, model }) });
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
