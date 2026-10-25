import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySessionStore, OnboardingService } from "../src";
import { AGENT_REPLY_JSON_SCHEMA } from "../src/onboarding/agent";
import { agentNoticeClause, agentProviderFromEnv, engineFromEnv } from "../src/onboarding/config";
import { createGeminiModel, thinkingFor } from "../src/onboarding/gemini";
import { backupThinkingFor, walkerAgentFromEnv, walkerTypedModelFromEnv } from "../src/walker/config";

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

/** A fetch that records each request and answers with the next queued response. */
function fakeFetch(...responses: { status?: number; json: unknown }[]) {
  const requests: Captured[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    requests.push({ url, headers: new Headers(init.headers), body: JSON.parse(String(init.body)) });
    const next = responses.shift();
    if (!next) throw new Error("no response queued");
    return new Response(JSON.stringify(next.json), { status: next.status ?? 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { impl, requests };
}

const request = { system: "rules", context: '{"turn":1}', retry: null, schema: AGENT_REPLY_JSON_SCHEMA };
const reply = (parts: { text: string; thought?: boolean }[], finishReason = "STOP") => ({
  json: { candidates: [{ content: { role: "model", parts }, finishReason }] },
});

describe("Gemini model", () => {
  it("sends one structured-output request and joins the reply's text parts", async () => {
    const { impl, requests } = fakeFetch(reply([{ text: "thinking", thought: true }, { text: '{"ok":' }, { text: "true}" }]));
    const model = createGeminiModel({ apiKey: "test-key", fetch: impl });
    const result = await model.generate({ ...request, retry: "Server note: fix it." }, new AbortController().signal);

    expect(result).toEqual({ stop_reason: "end_turn", text: '{"ok":true}' });
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent");
    expect(req.headers.get("x-goog-api-key")).toBe("test-key");
    expect(req.url).not.toContain("test-key");
    expect(req.body).toEqual({
      systemInstruction: { parts: [{ text: "rules" }] },
      contents: [{ role: "user", parts: [{ text: '{"turn":1}' }, { text: "Server note: fix it." }] }],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: AGENT_REPLY_JSON_SCHEMA,
        maxOutputTokens: 4096,
        thinkingConfig: { thinkingLevel: "low" },
      },
    });
  });

  it("uses the model override, with thinking kept low where the model allows it", async () => {
    const { impl, requests } = fakeFetch(reply([{ text: "{}" }]), reply([{ text: "{}" }]));
    const signal = new AbortController().signal;
    await createGeminiModel({ apiKey: "k", model: "gemini-2.5-flash", fetch: impl }).generate(request, signal);
    await createGeminiModel({ apiKey: "k", model: "gemini-2.5-pro", fetch: impl }).generate(request, signal);
    expect(requests[0]!.url).toContain("/models/gemini-2.5-flash:generateContent");
    expect((requests[0]!.body.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingBudget: 0 });
    expect(requests[1]!.body.generationConfig).not.toHaveProperty("thinkingConfig");
  });

  it("picks the thinking setting by model family", () => {
    expect(thinkingFor("gemini-3.7-flash")).toEqual({ thinkingLevel: "low" });
    expect(thinkingFor("gemini-3-flash-preview")).toEqual({ thinkingLevel: "low" });
    expect(thinkingFor("gemini-3.5-flash-lite")).toEqual({ thinkingLevel: "low" });
    expect(thinkingFor("gemini-2.5-flash-lite")).toEqual({ thinkingBudget: 0 });
    expect(thinkingFor("gemini-2.5-pro")).toBeNull();
    expect(thinkingFor("gemini-flash-latest")).toBeNull();
  });

  it("takes a thinking setting, and gives the walker's backup minimal thinking where the model accepts it", async () => {
    const { impl, requests } = fakeFetch(reply([{ text: "{}" }]), reply([{ text: "{}" }]));
    const signal = new AbortController().signal;
    await createGeminiModel({ apiKey: "k", model: "models/gemini-3.6-flash", thinking: backupThinkingFor("gemini-3.6-flash"), fetch: impl }).generate(request, signal);
    await createGeminiModel({ apiKey: "k", model: "gemini-3.6-flash", fetch: impl }).generate(request, signal);
    const thinking = (i: number) => (requests[i]!.body.generationConfig as Record<string, unknown>).thinkingConfig;
    expect(requests[0]!.url).toContain("/models/gemini-3.6-flash:generateContent");
    expect(thinking(0)).toEqual({ thinkingLevel: "minimal" });
    // Without the setting, thinkingFor as before.
    expect(thinking(1)).toEqual({ thinkingLevel: "low" });
    // gemini-3.7-flash rejects "minimal", so a 3.7 backup keeps "low".
    expect(backupThinkingFor("gemini-3.7-flash")).toEqual({ thinkingLevel: "low" });
    expect(backupThinkingFor("gemini-3.5-flash-lite")).toEqual({ thinkingLevel: "minimal" });
    expect(backupThinkingFor("gemini-2.5-flash")).toEqual({ thinkingBudget: 0 });
  });

  it("reports declines and cut-off replies in the agent's terms", async () => {
    const { impl } = fakeFetch(
      reply([{ text: "{" }], "MAX_TOKENS"),
      reply([], "SAFETY"),
      { json: { promptFeedback: { blockReason: "OTHER" } } },
    );
    const model = createGeminiModel({ apiKey: "k", fetch: impl });
    const signal = new AbortController().signal;
    expect(await model.generate(request, signal)).toEqual({ stop_reason: "max_tokens", text: "{" });
    expect(await model.generate(request, signal)).toEqual({ stop_reason: "refusal", text: "" });
    expect(await model.generate(request, signal)).toEqual({ stop_reason: "refusal", text: "" });
  });

  it("retries once when Google is busy, then gives up without echoing the request", async () => {
    const busy = { status: 503, json: { error: { message: "overloaded" } } };
    const ok = fakeFetch(busy, reply([{ text: "{}" }]));
    expect(await createGeminiModel({ apiKey: "k", fetch: ok.impl }).generate(request, new AbortController().signal)).toEqual({
      stop_reason: "end_turn",
      text: "{}",
    });
    expect(ok.requests).toHaveLength(2);

    const bad = fakeFetch({ status: 400, json: { error: { message: 'Invalid value at "contents" {"turn":1}' } } });
    const error = await createGeminiModel({ apiKey: "k", fetch: bad.impl })
      .generate(request, new AbortController().signal)
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Gemini API returned 400");
    expect(bad.requests).toHaveLength(1);
  });

  it("gives up after one retry, and doesn't retry a used-up quota", async () => {
    const signal = new AbortController().signal;
    const twice = fakeFetch({ status: 503, json: {} }, { status: 503, json: {} });
    await expect(createGeminiModel({ apiKey: "k", fetch: twice.impl }).generate(request, signal)).rejects.toThrow("Gemini API returned 503");
    expect(twice.requests).toHaveLength(2);

    const quota = fakeFetch({ status: 429, json: {} });
    await expect(createGeminiModel({ apiKey: "k", fetch: quota.impl }).generate(request, signal)).rejects.toThrow("Gemini API returned 429");
    expect(quota.requests).toHaveLength(1);
  });

  it("accepts a model name in the form Google's model list uses", async () => {
    const { impl, requests } = fakeFetch(reply([{ text: "{}" }]));
    await createGeminiModel({ apiKey: "k", model: "models/gemini-3.7-flash", fetch: impl }).generate(request, new AbortController().signal);
    expect(requests[0]!.url).toContain("/models/gemini-3.7-flash:generateContent");
    expect((requests[0]!.body.generationConfig as Record<string, unknown>).thinkingConfig).toEqual({ thinkingLevel: "low" });
  });
});

describe("the agent engine reaches the provider it names", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** Runs one typed answer through engineFromEnv's engine and returns the host the model call went to. */
  async function hostFor(env: Record<string, string>) {
    const hosts: string[] = [];
    vi.stubGlobal("fetch", (async (input: string | URL | Request) => {
      hosts.push(new URL(input instanceof Request ? input.url : String(input)).host);
      return new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
    }) as typeof fetch);
    const engine = engineFromEnv({ ONBOARDING_ENGINE: "agent", ...env }, () => {});
    const service = new OnboardingService(new MemorySessionStore(), { engine });
    const { token, response } = await service.start({ input_mode: "text", consent: { demo_data_notice: true } });
    const view = response.session;
    await service.turn(view.session_id, { token }, {
      client_turn_id: crypto.randomUUID(),
      last_seen_revision: view.revision,
      input: { type: "answer", question_id: view.current_question!.id, option_ids: [], text: "I trip over things at home" },
    });
    return [...new Set(hosts)];
  }

  it("sends a Gemini key's turn to Google and a Claude key's turn to Anthropic, matching the notice", async () => {
    expect(await hostFor({ GEMINI_API_KEY: "g-key" })).toEqual(["generativelanguage.googleapis.com"]);
    expect(agentProviderFromEnv({ ONBOARDING_ENGINE: "agent", GEMINI_API_KEY: "g-key" })).toBe("gemini");
    expect(await hostFor({ ANTHROPIC_API_KEY: "a-key" })).toEqual(["api.anthropic.com"]);
    expect(agentProviderFromEnv({ ONBOARDING_ENGINE: "agent", ANTHROPIC_API_KEY: "a-key" })).toBe("anthropic");
  });

  it("words the notice clause for each provider", () => {
    expect(agentNoticeClause("gemini")).toBe("Google's Gemini reads them to choose each question, and Google may keep a copy");
    expect(agentNoticeClause("anthropic")).toBe("Anthropic's Claude reads them to choose each question, and Anthropic may keep a copy");
  });

  it("warns when the model override belongs to the other provider", () => {
    const warnings: string[] = [];
    engineFromEnv({ ONBOARDING_ENGINE: "agent", ANTHROPIC_API_KEY: "a", ONBOARDING_AGENT_MODEL: "gemini-3.7-flash" }, (m) => warnings.push(m));
    engineFromEnv({ ONBOARDING_ENGINE: "agent", GEMINI_API_KEY: "g", ONBOARDING_AGENT_MODEL: "models/gemini-3.7-flash" }, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("doesn't look like a anthropic model");
  });
});

describe("agent provider selection", () => {
  const select = (env: Record<string, string>) => {
    const warnings: string[] = [];
    const kind = engineFromEnv({ ONBOARDING_ENGINE: "agent", ...env }, (m) => warnings.push(m)).kind;
    return { kind, warnings };
  };

  it("runs the agent with whichever key is set", () => {
    expect(select({ GEMINI_API_KEY: "g-key" })).toEqual({ kind: "agent", warnings: [] });
    expect(select({ ANTHROPIC_API_KEY: "a-key" })).toEqual({ kind: "agent", warnings: [] });
    expect(select({ ANTHROPIC_API_KEY: "a-key", GEMINI_API_KEY: "g-key" })).toEqual({ kind: "agent", warnings: [] });
    expect(select({ ONBOARDING_AGENT_PROVIDER: "gemini", GEMINI_API_KEY: "g-key" })).toEqual({ kind: "agent", warnings: [] });
  });

  it("names the provider the agent runs with, for the first screen's notice", () => {
    const agent = { ONBOARDING_ENGINE: "agent" };
    expect(agentProviderFromEnv({ ...agent, GEMINI_API_KEY: "g" })).toBe("gemini");
    expect(agentProviderFromEnv({ ...agent, ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" })).toBe("anthropic");
    expect(agentProviderFromEnv({ ...agent, ONBOARDING_AGENT_PROVIDER: "gemini", ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" })).toBe("gemini");
    expect(agentProviderFromEnv({ ...agent, ONBOARDING_AGENT_PROVIDER: "gemini", ANTHROPIC_API_KEY: "a" })).toBeNull();
    expect(agentProviderFromEnv({ GEMINI_API_KEY: "g" })).toBeNull();
  });

  it("falls back to the deterministic engine, with a warning, when the chosen provider has no key", () => {
    const missing = select({ ONBOARDING_AGENT_PROVIDER: "gemini", ANTHROPIC_API_KEY: "a-key" });
    expect(missing.kind).toBe("deterministic");
    expect(missing.warnings.join(" ")).toContain("GEMINI_API_KEY isn't set");

    const none = select({});
    expect(none.kind).toBe("deterministic");
    expect(none.warnings.join(" ")).toContain("ANTHROPIC_API_KEY or GEMINI_API_KEY");

    const unknown = select({ ONBOARDING_AGENT_PROVIDER: "openai", GEMINI_API_KEY: "g-key" });
    expect(unknown.kind).toBe("deterministic");
    expect(unknown.warnings.join(" ")).toContain('"openai"');
    expect([...missing.warnings, ...none.warnings, ...unknown.warnings].join(" ")).not.toMatch(/a-key|g-key/);
  });
});

describe("who answers the walker's typed turns", () => {
  it("is Claude with a Claude key, unless WALKER_TYPED_PROVIDER says gemini; spoken turns stay on Gemini", () => {
    expect(walkerTypedModelFromEnv({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" })).toBe("claude");
    expect(walkerTypedModelFromEnv({ ANTHROPIC_API_KEY: "a" })).toBe("claude");
    expect(walkerTypedModelFromEnv({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g", WALKER_TYPED_PROVIDER: "gemini" })).toBe("gemini");
    expect(walkerTypedModelFromEnv({ GEMINI_API_KEY: "g" })).toBe("gemini");
    expect(walkerTypedModelFromEnv({ ANTHROPIC_API_KEY: "none" })).toBeNull();
    expect(walkerTypedModelFromEnv({})).toBeNull();

    const both = walkerAgentFromEnv({ ANTHROPIC_API_KEY: "a", GEMINI_API_KEY: "g" });
    expect([both.typed?.provider, both.assistant?.provider]).toEqual(["claude", "gemini"]);
    expect(walkerAgentFromEnv({ GEMINI_API_KEY: "g" }).typed).toBeNull();
  });
});
