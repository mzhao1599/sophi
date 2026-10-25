import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WALKER_SETUP, type WalkerStatusView } from "@walker/contracts";
import { BACKUP_MARGIN_MS, WALKER_BACKUP_AFTER_MS, buildStatusView, createHedgedAssistant, createWalkerAssistantFor, walkerModelsFromEnv } from "../../src";
import type { AssistantResult, WalkerAssistant } from "../../src/walker/assistant";

/** The backup model's picking rules (hedge.ts), on a fake clock: each fake model answers at a set time. */

const AFTER = WALKER_BACKUP_AFTER_MS;
const status = {} as WalkerStatusView;
const ok = (model: string): AssistantResult => ({ ok: true, attempts: 1, ms: 0, model, reply: { transcript: "", reply: `from ${model}`, topics: [], cues_change: null } });
const fail = (model: string, reason: "refusal" | "invalid_reply" | "timeout" | "model_error"): AssistantResult => ({ ok: false, reason, attempts: 2, ms: 0, model });

/** A model that gives `result` after `ms`, unless cancelled first; it records whether it was cancelled. */
function fake(ms: number, result: AssistantResult) {
  const seen = { cancelled: false, limitMs: undefined as number | undefined };
  const assistant: WalkerAssistant = {
    reply: (_s, _src, _w, _now, limitMs, signal) =>
      new Promise((resolve) => {
        seen.limitMs = limitMs;
        let done = false;
        const timer = setTimeout(() => {
          done = true;
          resolve(result);
        }, ms);
        signal?.addEventListener("abort", () => {
          if (done) return;
          seen.cancelled = true;
          clearTimeout(timer);
          resolve({ ok: false, reason: "timeout", attempts: 1, ms: Date.now() });
        });
      }),
  };
  return { assistant, seen };
}

async function ask(main: WalkerAssistant, backup: WalkerAssistant, limitMs?: number, signal?: AbortSignal) {
  const started = Date.now();
  const promise = createHedgedAssistant({ main, backup, backupAfterMs: AFTER }).reply(status, "walker", { type: "text", text: "hi" }, new Date(), limitMs, signal);
  let at = -1;
  void promise.then(() => (at = Date.now() - started));
  await vi.advanceTimersByTimeAsync(10_000);
  const result = await promise;
  return { result, at };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the walker's backup model", () => {
  it("gives both models the turn's tool results, message recipients, help and screen views", async () => {
    const seen: unknown[][] = [];
    const record = (model: string): WalkerAssistant => ({
      reply: async (...args) => {
        seen.push([model, args[6], args[7], args[8], args[9]]);
        return ok(model);
      },
    });
    const toolResults = [{ name: "get_weather" as const, text: "12 degrees and cloudy." }];
    const recipients = [{ member_id: crypto.randomUUID(), name: "Sam" }];
    const views = ["weather", "sensors"] as const;
    const help = { offer: true, open: null };
    const hedged = createHedgedAssistant({ main: record("main"), backup: record("backup"), backupAfterMs: AFTER });
    const promise = hedged.reply(status, "walker", { type: "text", text: "hi" }, new Date(), undefined, undefined, toolResults, recipients, help, views);
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await promise).ok).toBe(true);
    expect(seen).toEqual([["main", toolResults, recipients, help, views], ["backup", toolResults, recipients, help, views]]);
  });

  it("uses the main model's answer when it comes before the switch-over, and cancels the backup", async () => {
    const main = fake(3000, ok("main"));
    const backup = fake(4000, ok("backup"));
    const { result, at } = await ask(main.assistant, backup.assistant);
    expect(result).toMatchObject({ ok: true, model: "main", ms: 3000 });
    expect(at).toBe(3000);
    expect(backup.seen.cancelled).toBe(true);
    expect(main.seen.cancelled).toBe(false);
  });

  it("prefers the main model before the switch-over even when the backup answered first", async () => {
    const { result } = await ask(fake(AFTER - 1, ok("main")).assistant, fake(1000, ok("backup")).assistant);
    expect(result).toMatchObject({ model: "main", ms: AFTER - 1 });
  });

  it("uses the backup's ready answer at the switch-over, reports the time waited, and cancels the main model", async () => {
    const main = fake(7000, ok("main"));
    const { result, at } = await ask(main.assistant, fake(1300, ok("backup")).assistant);
    expect(result).toMatchObject({ ok: true, model: "backup", ms: AFTER, attempts: 1 });
    expect(at).toBe(AFTER);
    expect(main.seen.cancelled).toBe(true);
  });

  it("after the switch-over, takes the first usable answer", async () => {
    expect((await ask(fake(6000, ok("main")).assistant, fake(5000, ok("backup")).assistant)).result).toMatchObject({ model: "backup", ms: 5000 });
    expect((await ask(fake(5000, ok("main")).assistant, fake(6000, ok("backup")).assistant)).result).toMatchObject({ model: "main", ms: 5000 });
  });

  it("uses the backup as soon as the main model fails, without waiting for the switch-over", async () => {
    expect((await ask(fake(1000, fail("main", "model_error")).assistant, fake(2000, ok("backup")).assistant)).result).toMatchObject({ model: "backup", ms: 2000 });
    expect((await ask(fake(2000, fail("main", "invalid_reply")).assistant, fake(1000, ok("backup")).assistant)).result).toMatchObject({ model: "backup", ms: 2000 });
  });

  it("treats a refusal from the main model as final, even with a backup answer ready", async () => {
    const { result } = await ask(fake(1000, fail("main", "refusal")).assistant, fake(500, ok("backup")).assistant);
    expect(result).toMatchObject({ ok: false, reason: "refusal", model: "main", ms: 1000 });
  });

  it("waits for the main model when the backup fails", async () => {
    const { result } = await ask(fake(7000, ok("main")).assistant, fake(500, fail("backup", "model_error")).assistant);
    expect(result).toMatchObject({ ok: true, model: "main", ms: 7000 });
  });

  it("reports the failure the person waited for when both fail: the one that failed last", async () => {
    expect((await ask(fake(8000, fail("main", "timeout")).assistant, fake(500, fail("backup", "model_error")).assistant)).result).toMatchObject({
      ok: false,
      reason: "timeout",
      model: "main",
      ms: 8000,
    });
    expect((await ask(fake(300, fail("main", "model_error")).assistant, fake(8000, fail("backup", "timeout")).assistant)).result).toMatchObject({
      ok: false,
      reason: "timeout",
      model: "backup",
      ms: 8000,
    });
  });

  it("switches over before a short turn limit, so a ready backup answer never loses to the deadline", async () => {
    const main = fake(7000, ok("main"));
    const { result } = await ask(main.assistant, fake(1000, ok("backup")).assistant, 3000);
    expect(result).toMatchObject({ model: "backup", ms: 3000 - BACKUP_MARGIN_MS });
    expect(main.seen.limitMs).toBe(3000);
  });

  it("passes the caller's cancel on to both models", async () => {
    const main = fake(7000, ok("main"));
    const backup = fake(7000, ok("backup"));
    const caller = new AbortController();
    setTimeout(() => caller.abort(), 100);
    const { result } = await ask(main.assistant, backup.assistant, undefined, caller.signal);
    expect(result).toMatchObject({ ok: false, ms: 100 });
    expect(main.seen.cancelled && backup.seen.cancelled).toBe(true);
  });

  it("counts a model that throws as a model error", async () => {
    const throws: WalkerAssistant = { reply: () => Promise.reject(new Error("bug")) };
    expect((await ask(throws, fake(1000, ok("backup")).assistant)).result).toMatchObject({ model: "backup", ms: 1000 });
    expect((await ask(throws, throws)).result).toMatchObject({ ok: false, reason: "model_error", attempts: 1 });
  });
});

describe("walkerModelsFromEnv", () => {
  it("defaults to gemini-3.7-flash with gemini-3.6-flash as the backup after 4.5 s", () => {
    expect(walkerModelsFromEnv({})).toEqual({ main: "gemini-3.7-flash", backup: "gemini-3.6-flash", backupAfterMs: 4500 });
    // "none" for the main model leaves it at its default, as before the backup.
    expect(walkerModelsFromEnv({ WALKER_AGENT_MODEL: "none" }).main).toBe("gemini-3.7-flash");
  });

  it('turns the backup off with "none", in any case', () => {
    expect(walkerModelsFromEnv({ WALKER_BACKUP_MODEL: "none" }).backup).toBeNull();
    expect(walkerModelsFromEnv({ WALKER_BACKUP_MODEL: " NONE " }).backup).toBeNull();
  });

  it("reads the overrides and keeps the default switch-over for a value it can't use", () => {
    expect(walkerModelsFromEnv({ WALKER_AGENT_MODEL: "models/gemini-3.6-flash", WALKER_BACKUP_MODEL: "gemini-3.5-flash-lite", WALKER_BACKUP_AFTER_MS: "4000" })).toEqual({
      main: "gemini-3.6-flash",
      backup: "gemini-3.5-flash-lite",
      backupAfterMs: 4000,
    });
    for (const bad of ["", "soon", "4.5", "-1", "9000"]) expect(walkerModelsFromEnv({ WALKER_BACKUP_AFTER_MS: bad }).backupAfterMs).toBe(4500);
  });
});

describe("createWalkerAssistantFor", () => {
  const now = new Date("2026-10-23T09:00:00.000Z");
  const view = buildStatusView({
    device: { device_id: crypto.randomUUID(), owner_hash: "h", name: "Walker", service_version: "t", created_at: now.toISOString(), last_heartbeat_at: null, manifest: null, snapshot: null, snapshot_received_at: null, location_sharing_enabled: false, location: null, location_received_at: null },
    configuration: { version: 1, ...WALKER_SETUP, cues: [...WALKER_SETUP.cues], created_at: now.toISOString() },
    proposal: undefined,
    turns: [],
    lines: [],
    now,
  });
  const answer = JSON.stringify({ transcript: "", reply: "Hello.", topics: [], cues_change: null });

  function fakeFetch() {
    const sent: { model: string; thinking: unknown }[] = [];
    const impl = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { generationConfig: { thinkingConfig?: unknown } };
      sent.push({ model: /models\/([^:]+):/.exec(url)![1]!, thinking: body.generationConfig.thinkingConfig });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: answer }] }, finishReason: "STOP" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, sent };
  }

  it("asks both models, the backup with minimal thinking and the main model never with it", async () => {
    vi.useRealTimers();
    const { impl, sent } = fakeFetch();
    const result = await createWalkerAssistantFor("k", walkerModelsFromEnv({}), impl).reply(view, "page", { type: "text", text: "Hi" }, now);
    expect(result).toMatchObject({ ok: true, model: "gemini-3.7-flash" });
    expect(sent).toEqual([
      { model: "gemini-3.7-flash", thinking: { thinkingLevel: "low" } },
      { model: "gemini-3.6-flash", thinking: { thinkingLevel: "minimal" } },
    ]);
  });

  /** A fetch per model: `answer` answers at once, `hang` never answers until its request is cancelled. */
  function scriptedFetch(behaviour: Record<string, "answer" | "hang" | "503">) {
    const calls: Record<string, { count: number; aborted: number }> = {};
    const impl = ((url: string, init: RequestInit) => {
      const model = /models\/([^:]+):/.exec(url)![1]!;
      const c = (calls[model] ??= { count: 0, aborted: 0 });
      c.count++;
      const how = behaviour[model] === "503" && c.count > 1 ? "hang" : behaviour[model];
      if (how === "answer") return Promise.resolve(new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: answer }] }, finishReason: "STOP" }] }), { status: 200 }));
      if (how === "503") return Promise.resolve(new Response("busy", { status: 503 }));
      return new Promise((_resolve, reject) =>
        init.signal!.addEventListener("abort", () => {
          c.aborted++;
          reject(init.signal!.reason);
        }),
      );
    }) as unknown as typeof fetch;
    return { impl, calls };
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  it("cancels the backup's request once the main model answers, so it sends nothing more", async () => {
    vi.useRealTimers();
    const { impl, calls } = scriptedFetch({ "gemini-3.7-flash": "answer", "gemini-3.6-flash": "hang" });
    const result = await createWalkerAssistantFor("k", walkerModelsFromEnv({}), impl).reply(view, "page", { type: "text", text: "Hi" }, now);
    await settle();
    expect(result).toMatchObject({ ok: true, model: "gemini-3.7-flash" });
    expect(calls["gemini-3.6-flash"]).toEqual({ count: 1, aborted: 1 });
  });

  it("cancels the main model's request, its 5xx retry included, once the backup's answer is used", async () => {
    vi.useRealTimers();
    const { impl, calls } = scriptedFetch({ "gemini-3.7-flash": "503", "gemini-3.6-flash": "answer" });
    const result = await createWalkerAssistantFor("k", walkerModelsFromEnv({ WALKER_BACKUP_AFTER_MS: "50" }), impl).reply(view, "page", { type: "text", text: "Hi" }, now);
    await settle();
    expect(result).toMatchObject({ ok: true, model: "gemini-3.6-flash" });
    // The 503 is retried once (gemini.ts), and that retry is cancelled at the pick: no third request.
    expect(calls["gemini-3.7-flash"]).toEqual({ count: 2, aborted: 1 });
  });

  it('asks one model when the backup is "none"', async () => {
    vi.useRealTimers();
    const { impl, sent } = fakeFetch();
    const result = await createWalkerAssistantFor("k", walkerModelsFromEnv({ WALKER_BACKUP_MODEL: "none" }), impl).reply(view, "page", { type: "text", text: "Hi" }, now);
    expect(result).toMatchObject({ ok: true, model: "gemini-3.7-flash" });
    expect(sent).toEqual([{ model: "gemini-3.7-flash", thinking: { thinkingLevel: "low" } }]);
  });
});
