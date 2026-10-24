import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createAgentEngine } from "./agent";
import { createAnthropicModel } from "./anthropic";
import { deterministicEngine, type TurnEngine } from "./engine";
import { MemorySessionStore } from "./store";

/**
 * Chooses the onboarding engine from the server's environment:
 *
 * - ONBOARDING_ENGINE: `deterministic` (the default) or `agent`.
 * - ANTHROPIC_API_KEY: needed for `agent`. Without it the deterministic engine runs, exactly as before.
 * - ONBOARDING_AGENT_MODEL: optional model override for `agent`.
 */
export function engineFromEnv(env: Record<string, string | undefined>, warn: (message: string) => void = console.warn): TurnEngine {
  const choice = env.ONBOARDING_ENGINE?.trim() || "deterministic";
  if (choice === "deterministic") return deterministicEngine;
  if (choice !== "agent") {
    warn(`[onboarding] ONBOARDING_ENGINE=${JSON.stringify(choice)} isn't "deterministic" or "agent"; using the deterministic engine.`);
    return deterministicEngine;
  }
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) {
    warn("[onboarding] ONBOARDING_ENGINE=agent but ANTHROPIC_API_KEY isn't set; using the deterministic engine.");
    return deterministicEngine;
  }
  return createAgentEngine({ model: createAnthropicModel({ apiKey, model: env.ONBOARDING_AGENT_MODEL?.trim() || undefined }) });
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
