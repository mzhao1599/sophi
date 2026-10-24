import Anthropic from "@anthropic-ai/sdk";
import type { AgentModel } from "./agent";

/**
 * The onboarding agent's model client: one Messages API call per attempt, with structured output.
 * Server-side only; the API key never reaches the browser. Override the model with
 * ONBOARDING_AGENT_MODEL; it must support structured outputs and the effort setting.
 */

export const DEFAULT_AGENT_MODEL = "claude-opus-5-5";

export interface AnthropicModelOptions {
  apiKey: string;
  model?: string;
  /** For tests: answers requests instead of the network. */
  fetch?: typeof fetch;
}

export function createAnthropicModel({ apiKey, model = DEFAULT_AGENT_MODEL, fetch }: AnthropicModelOptions): AgentModel {
  // One quick retry for a dropped connection or an overloaded API; the agent's deadline bounds the total.
  const client = new Anthropic({ apiKey, maxRetries: 1, ...(fetch ? { fetch } : {}) });
  return {
    async generate({ system, context, retry, schema, audio }, signal) {
      if (audio) throw new Error("The Claude client takes text only; voice turns use Gemini.");
      const message = await client.beta.messages.create(
        {
          model,
          max_tokens: 4096,
          // A short conversational step, so low effort: it keeps a turn to a few seconds.
          output_config: { effort: "low", format: { type: "json_schema", schema } },
          // If the model declines for policy reasons, the API tries its default fallback model in the same call.
          betas: ["server-side-fallback-2026-10-23"],
          fallbacks: "default",
          // The rules and question bank are the same on every turn, so they are cached.
          system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: context }, ...(retry ? [{ type: "text" as const, text: retry }] : [])],
            },
          ],
        },
        { signal },
      );
      const text = message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
      return { stop_reason: message.stop_reason, text };
    },
  };
}
