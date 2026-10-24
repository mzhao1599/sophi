import { createAgentEngine } from "./agent";
import { createAnthropicModel } from "./anthropic";
import { deterministicEngine, type TurnEngine } from "./engine";

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
