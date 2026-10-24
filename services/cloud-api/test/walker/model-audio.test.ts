import { describe, expect, it } from "vitest";
import { createAnthropicModel, createGeminiModel, type AgentRequest } from "../../src";

/** The model clients with and without a voice clip: onboarding's request is unchanged, the clip rides inline. */

const base: AgentRequest = { system: "rules", context: '{"person_words":"hi"}', retry: null, schema: { type: "object" } };

function capture() {
  const bodies: Record<string, unknown>[] = [];
  const fetch = async (_url: unknown, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ candidates: [{ content: { parts: [{ text: "{}" }] }, finishReason: "STOP" }] });
  };
  return { bodies, fetch: fetch as typeof globalThis.fetch };
}

describe("model clients and voice clips", () => {
  it("sends Gemini exactly the onboarding body when there's no clip", async () => {
    const { bodies, fetch } = capture();
    await createGeminiModel({ apiKey: "k", fetch }).generate({ ...base, retry: "Server note: fix it." }, new AbortController().signal);
    expect(bodies[0]).toEqual({
      systemInstruction: { parts: [{ text: "rules" }] },
      contents: [{ role: "user", parts: [{ text: '{"person_words":"hi"}' }, { text: "Server note: fix it." }] }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: { type: "object" }, maxOutputTokens: 4096, thinkingConfig: { thinkingLevel: "low" } },
    });
  });

  it("sends a clip to Gemini inline, after the context, in the same call as the schema", async () => {
    const { bodies, fetch } = capture();
    await createGeminiModel({ apiKey: "k", fetch }).generate({ ...base, audio: { mime: "audio/wav", data_base64: "UklGRg==" } }, new AbortController().signal);
    expect(bodies[0]).toMatchObject({
      contents: [{ role: "user", parts: [{ text: '{"person_words":"hi"}' }, { inlineData: { mimeType: "audio/wav", data: "UklGRg==" } }] }],
      generationConfig: { responseMimeType: "application/json", responseJsonSchema: { type: "object" } },
    });
  });

  it("refuses a clip in the Claude client, which takes text only", async () => {
    const model = createAnthropicModel({ apiKey: "k", fetch: (async () => Response.json({})) as typeof fetch });
    await expect(model.generate({ ...base, audio: { mime: "audio/wav", data_base64: "UklGRg==" } }, new AbortController().signal)).rejects.toThrow(/text only/);
  });
});
