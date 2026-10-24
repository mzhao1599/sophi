import type { AgentModel } from "./agent";

/**
 * The onboarding agent's model client for Google's Gemini API: one generateContent call per attempt,
 * with the reply constrained to the agent's JSON schema. Server-side only; the API key never reaches
 * the browser. Called over plain fetch, so there is no SDK to install. Override the model with
 * ONBOARDING_AGENT_MODEL; it must support structured output (`responseJsonSchema`).
 */

/** Measured 2026-10-23 with low thinking: about 2.5 s a turn and no fallbacks over two full conversations. */
export const DEFAULT_GEMINI_MODEL = "gemini-3.7-flash";

const API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Finish reasons that mean the model or Google's filters declined, as opposed to running out of room. */
const DECLINED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "IMAGE_SAFETY"]);

/**
 * Worth one quick retry: briefly unavailable. Not 429: a used-up quota fails again at once, and the
 * retry only spends more of it. The agent's deadline bounds the total.
 */
const RETRYABLE = new Set([500, 502, 503, 504]);

export interface GeminiModelOptions {
  apiKey: string;
  model?: string;
  /** For tests: answers requests instead of the network. */
  fetch?: typeof fetch;
}

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

export function createGeminiModel({ apiKey, model = DEFAULT_GEMINI_MODEL, fetch: fetchImpl = fetch }: GeminiModelOptions): AgentModel {
  // Google's model list names models "models/gemini-…"; accept that form too.
  const name = model.replace(/^models\//, "");
  const url = `${API_BASE}/models/${encodeURIComponent(name)}:generateContent`;
  const thinking = thinkingFor(name);
  return {
    async generate({ system, context, retry, schema }, signal) {
      const body = JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: [{ text: context }, ...(retry ? [{ text: retry }] : [])] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseJsonSchema: schema,
          maxOutputTokens: 4096,
          ...(thinking ? { thinkingConfig: thinking } : {}),
        },
      });
      const init: RequestInit = {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body,
        signal,
      };
      let response = await fetchImpl(url, init);
      if (RETRYABLE.has(response.status) && !signal.aborted) {
        await response.body?.cancel();
        response = await fetchImpl(url, init);
      }
      if (!response.ok) {
        await response.body?.cancel();
        // The status only: Google's error text can echo the request, which holds the user's words.
        throw new Error(`Gemini API returned ${response.status}`);
      }

      const data = (await response.json()) as GenerateContentResponse;
      if (data.promptFeedback?.blockReason) return { stop_reason: "refusal", text: "" };
      const candidate = data.candidates?.[0];
      const text = (candidate?.content?.parts ?? []).flatMap((part) => (part.thought || !part.text ? [] : [part.text])).join("");
      return { stop_reason: stopReason(candidate?.finishReason), text };
    },
  };
}

/**
 * A turn is a short step with a 15-second deadline, so keep thinking low: Gemini 3 and later take a
 * thinking level, 2.5 Flash a token budget (0 turns it off). Other models keep their default. With its
 * default thinking, gemini-3.7-flash took about 5 s a turn and hit the deadline on 2 of 7 turns; with
 * "low", about 2.5 s and none. "minimal" is rejected for that model.
 */
export function thinkingFor(model: string): Record<string, unknown> | null {
  if (/^gemini-2\.5-flash/.test(model)) return { thinkingBudget: 0 };
  if (/^gemini-([3-9]|\d{2,})(\.\d+)?-/.test(model)) return { thinkingLevel: "low" };
  return null;
}

/** Gemini's finish reason in the agent's terms: "refusal" and "max_tokens" are the two it acts on. */
function stopReason(finishReason: string | undefined): string | null {
  if (!finishReason) return null;
  if (DECLINED.has(finishReason)) return "refusal";
  if (finishReason === "MAX_TOKENS") return "max_tokens";
  if (finishReason === "STOP") return "end_turn";
  return finishReason.toLowerCase();
}
