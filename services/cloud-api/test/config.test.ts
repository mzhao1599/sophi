import { afterEach, describe, expect, it, vi } from "vitest";
import { MemorySessionStore, OnboardingService } from "../src";
import { agentNoticeClause, agentProviderFromEnv, engineFromEnv } from "../src/onboarding/config";
import { walkerAgentFromEnv, walkerModelFromEnv } from "../src/walker/config";

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

  it("sends the agent's turn to Anthropic, matching the notice", async () => {
    expect(await hostFor({ ANTHROPIC_API_KEY: "a-key" })).toEqual(["api.anthropic.com"]);
    expect(agentProviderFromEnv({ ONBOARDING_ENGINE: "agent", ANTHROPIC_API_KEY: "a-key" })).toBe("anthropic");
  });

  it("words the notice clause", () => {
    expect(agentNoticeClause("anthropic")).toBe("Anthropic's Claude reads them to choose each question, and Anthropic may keep a copy");
  });

  it("warns when the model override isn't a Claude model", () => {
    const warnings: string[] = [];
    engineFromEnv({ ONBOARDING_ENGINE: "agent", ANTHROPIC_API_KEY: "a", ONBOARDING_AGENT_MODEL: "gpt-5" }, (m) => warnings.push(m));
    engineFromEnv({ ONBOARDING_ENGINE: "agent", ANTHROPIC_API_KEY: "a", ONBOARDING_AGENT_MODEL: "claude-sonnet-5-5" }, (m) => warnings.push(m));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("doesn't look like a Claude model");
  });
});

describe("agent provider selection", () => {
  const select = (env: Record<string, string>) => {
    const warnings: string[] = [];
    const kind = engineFromEnv({ ONBOARDING_ENGINE: "agent", ...env }, (m) => warnings.push(m)).kind;
    return { kind, warnings };
  };

  it("runs the agent with a Claude key", () => {
    expect(select({ ANTHROPIC_API_KEY: "a-key" })).toEqual({ kind: "agent", warnings: [] });
  });

  it("names the provider the agent runs with, for the first screen's notice", () => {
    expect(agentProviderFromEnv({ ONBOARDING_ENGINE: "agent", ANTHROPIC_API_KEY: "a" })).toBe("anthropic");
    expect(agentProviderFromEnv({ ONBOARDING_ENGINE: "agent" })).toBeNull();
    expect(agentProviderFromEnv({ ANTHROPIC_API_KEY: "a" })).toBeNull();
  });

  it("falls back to the deterministic engine, with a warning, without a key", () => {
    const none = select({});
    expect(none.kind).toBe("deterministic");
    expect(none.warnings.join(" ")).toContain("ANTHROPIC_API_KEY isn't set");

    const unknown = select({ ONBOARDING_ENGINE: "magic", ANTHROPIC_API_KEY: "a-key" });
    expect(unknown.kind).toBe("deterministic");
    expect(unknown.warnings.join(" ")).toContain('"magic"');
    expect([...none.warnings, ...unknown.warnings].join(" ")).not.toMatch(/a-key/);
  });
});

describe("who answers and hears the walker's turns", () => {
  it("is Claude with a Claude key, and Cartesia hears with a Cartesia key", () => {
    expect(walkerModelFromEnv({ ANTHROPIC_API_KEY: "a" })).toBe("claude");
    expect(walkerModelFromEnv({ ANTHROPIC_API_KEY: "none" })).toBeNull();
    expect(walkerModelFromEnv({})).toBeNull();

    const both = walkerAgentFromEnv({ ANTHROPIC_API_KEY: "a", CARTESIA_API_KEY: "c" });
    expect(both.assistant?.provider).toBe("claude");
    expect(both.ears).not.toBeNull();
    expect(both.voice).not.toBeNull();
    const neither = walkerAgentFromEnv({});
    expect([neither.assistant, neither.ears, neither.voice]).toEqual([null, null, null]);
  });
});
