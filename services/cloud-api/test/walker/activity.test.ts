import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECENT_TURNS,
  WALKER_HISTORY_RETENTION_MS,
  WalkerListResponseSchema,
  type DeviceTurnRequest,
  type HeartbeatRequest,
  type PageTurnRequest,
  type WalkerActivityView,
} from "@walker/contracts";
import { ActivityLog, MemoryWalkerStore, WalkerService, createWalkerAssistant, type AgentModel, type DeviceCaller, type OwnerCaller, type WalkerEars, type WalkerStore, type WalkerVoice } from "../../src";
import { Clock, manifest, snapshot, uuid } from "./support";

/** The page-only activity log (EXPECTED-turns.md, "Activity log"), with a stub model, the in-memory store and a fake clock. */

type Reply = { transcript?: string; reply: string; topics?: string[]; cues_change?: { cues: string[] } | null };

/** A promise the test resolves by hand. */
function gate<T = void>() {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => (open = resolve));
  return { promise, open };
}

/** A model that answers `reply`, after `wait(call)` when given; `entered[n]` resolves when call n starts. */
function stubModel(reply: Reply | ((call: number) => Reply | Error), wait?: (call: number) => Promise<void>) {
  let calls = 0;
  const entered = Array.from({ length: 8 }, () => gate());
  const model: AgentModel = {
    async generate() {
      const call = ++calls;
      entered[call - 1]?.open();
      if (wait) await wait(call);
      const next = typeof reply === "function" ? reply(call) : reply;
      if (next instanceof Error) throw next;
      return { stop_reason: "end_turn", text: JSON.stringify({ transcript: "", topics: [], cues_change: null, ...next }) };
    },
  };
  return { model, entered, calls: () => calls };
}

/** A 16 kHz mono 16-bit WAV of silence. */
function wav(ms: number): Buffer {
  const data = 32 * ms;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16_000, 24);
  b.writeUInt32LE(32_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(data, 40);
  return b;
}

const owner = (secret: string): OwnerCaller => ({ kind: "owner", secret });
const device = (credential: string): DeviceCaller => ({ kind: "device", credential });

describe("the walker activity log", () => {
  let clock: Clock;
  let store: WalkerStore;
  let log: ActivityLog;

  beforeEach(() => {
    clock = new Clock();
    store = new MemoryWalkerStore();
    log = new ActivityLog(clock.now);
  });

  /** Stands in for Cartesia: every clip is heard as "Which parts work?". */
  const ears: WalkerEars = { transcribe: async () => "Which parts work?" };

  function serviceWith(model: AgentModel | null, extra: { voice?: WalkerVoice; ears?: WalkerEars; timeoutMs?: number; store?: WalkerStore } = {}) {
    return new WalkerService(extra.store ?? store, {
      now: clock.now,
      assistant: model ? createWalkerAssistant({ model, provider: "claude", timeoutMs: extra.timeoutMs }) : null,
      ears: extra.ears ?? ears,
      voice: extra.voice ?? null,
      onTurn: () => {},
      activity: log,
    });
  }

  async function walker(service: WalkerService) {
    const { secret, response } = await service.createPairingCode({ kind: "owner", secret: undefined });
    const paired = await service.pair({ code: response.code, service_version: "pi-0.1.0" }, "203.0.113.5");
    const beat: HeartbeatRequest = { sent_at: clock.iso(), service_version: "pi-0.1.0", manifest: manifest(clock), snapshot: snapshot(clock), events: [] };
    await service.heartbeat(device(paired.credential), paired.device_id, beat);
    return { secret, id: paired.device_id, credential: paired.credential };
  }

  const typed = (text: string): DeviceTurnRequest => ({ client_turn_id: uuid(), input: { type: "text", text }, snapshot: snapshot(clock) });
  const spoken = (clip = wav(1200)): DeviceTurnRequest => ({
    client_turn_id: uuid(),
    input: { type: "audio", mime: "audio/wav", data_base64: clip.toString("base64"), duration_ms: 1200 },
    snapshot: snapshot(clock),
  });
  const fromPage = (text: string): PageTurnRequest => ({ client_turn_id: uuid(), input: { type: "text", text } });

  /** The owner's list, checked against the contract; the activity of walker `id`, if any. */
  async function activityOf(service: WalkerService, secret: string, id: string): Promise<WalkerActivityView | undefined> {
    const listed = await service.list(owner(secret));
    expect(WalkerListResponseSchema.safeParse(listed).success).toBe(true);
    return listed.activity?.find((a) => a.device_id === id);
  }

  // ---- In flight ----

  it("shows a spoken turn hearing during the model, voicing during Cartesia, and clears it after", async () => {
    const modelGate = gate();
    const voiceGate = gate();
    const voiceEntered = gate();
    const stub = stubModel({ transcript: "Is anything in front of me?", reply: "Something is about 64 centimetres ahead.", topics: ["other"] }, () => modelGate.promise);
    const voice: WalkerVoice = { speak: async () => (voiceEntered.open(), await voiceGate.promise, wav(800).toString("base64")) };
    const service = serviceWith(stub.model, { voice });
    const w = await walker(service);
    const request = spoken();
    const pending = service.turn(device(w.credential), w.id, request);

    await stub.entered[0]!.promise;
    const hearing = await activityOf(service, w.secret, w.id);
    expect(hearing).toEqual({
      device_id: w.id,
      in_flight: [{ client_turn_id: request.client_turn_id, input: "audio", since: clock.iso(), clip_ms: 1200, stage: "hearing", model: "claude" }],
      traces: [],
    });

    modelGate.open();
    await voiceEntered.promise;
    expect((await activityOf(service, w.secret, w.id))?.in_flight).toMatchObject([{ client_turn_id: request.client_turn_id, stage: "voicing" }]);

    voiceGate.open();
    const r = await pending;
    expect(r.turn.voiced_by).toBe("cartesia");
    const after = await activityOf(service, w.secret, w.id);
    expect(after?.in_flight).toEqual([]);
    expect(after?.traces).toHaveLength(1);
    expect(after?.traces[0]).toMatchObject({ turn_id: r.turn.turn_id, client_turn_id: request.client_turn_id, input: "audio", clip_ms: 1200, model_ran: true, rule: null, answered_by: "model", voiced_by: "cartesia" });
    expect(after?.traces[0]?.voice_ms).toEqual(expect.any(Number));
  });

  it("clears the in-flight entry after a model error and after the model's deadline (both still traced)", async () => {
    const service = serviceWith(stubModel(() => new Error("model API returned 500")).model);
    const w = await walker(service);
    await service.turn(device(w.credential), w.id, typed("Hello"));
    const slow: AgentModel = { generate: (_request, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason))) };
    await serviceWith(slow, { timeoutMs: 30 }).turn(device(w.credential), w.id, typed("Hello"));
    const a = await activityOf(service, w.secret, w.id);
    expect(a?.in_flight).toEqual([]);
    expect(a?.traces.map((t) => [t.rule, t.answered_by, t.model_ran])).toEqual([
      ["model_error", "fixed", true],
      ["timeout", "fixed", true],
    ]);
  });

  it("clears the in-flight entry when the walker is forgotten during the model (404), and keeps nothing of it", async () => {
    let forget: () => Promise<void> = async () => {};
    let seenDuring: WalkerActivityView[] = [];
    const service = serviceWith(stubModel(() => ({ reply: "Hello.", topics: ["other"] }), async () => {
      seenDuring = log.view([w.id]);
      await forget();
    }).model);
    const w = await walker(service);
    forget = () => service.forget(owner(w.secret), w.id);
    await expect(service.turn(device(w.credential), w.id, typed("Hello"))).rejects.toMatchObject({ code: "not_found" });
    // It was in flight while the model ran, so the clear below isn't vacuous.
    expect(seenDuring[0]?.in_flight).toHaveLength(1);
    expect(log.view([w.id])).toEqual([]);
    expect(dump(log)).not.toContain(w.id);
  });

  it("clears the in-flight entry when the response fails its schema and when the store throws while saving", async () => {
    let seenDuring = -1;
    let mode: "mangle" | "throw" = "mangle";
    // The real store, with saveTurn either mangling what it returns (so the response's parse fails) or throwing.
    const failing = new Proxy(store, {
      get(target, key, receiver) {
        if (key !== "saveTurn") return Reflect.get(target, key, receiver);
        return async (...args: Parameters<WalkerStore["saveTurn"]>) => {
          seenDuring = log.view([args[0]])[0]?.in_flight.length ?? 0;
          if (mode === "throw") throw new Error("connection reset");
          const saved = await target.saveTurn(...args);
          return saved && { ...saved, turn: { ...saved.turn, turn_id: "not-a-uuid" } };
        };
      },
    });
    const service = serviceWith(stubModel({ reply: "Hello.", topics: ["other"] }).model, { store: failing });
    const w = await walker(service);
    await expect(service.turn(device(w.credential), w.id, typed("Hello"))).rejects.toThrow();
    expect(seenDuring).toBe(1);
    expect(log.view([w.id])).toEqual([]);
    mode = "throw";
    seenDuring = -1;
    await expect(service.turn(device(w.credential), w.id, typed("Hello"))).rejects.toThrow("connection reset");
    expect(seenDuring).toBe(1);
    expect(log.view([w.id])).toEqual([]);
  });

  it("never tracks a refused clip or a replay", async () => {
    const service = serviceWith(stubModel({ reply: "Hello.", topics: ["other"] }).model);
    const w = await walker(service);
    const request = typed("Hello");
    await service.turn(device(w.credential), w.id, request);
    const begin = vi.spyOn(log, "begin");
    await expect(service.turn(device(w.credential), w.id, spoken(Buffer.from("not a wav file")))).rejects.toMatchObject({ code: "invalid_request" });
    const replay = await service.turn(device(w.credential), w.id, request);
    expect(replay.speech).toBeNull();
    expect(begin).not.toHaveBeenCalled();
    expect((await activityOf(service, w.secret, w.id))?.traces).toHaveLength(1);
  });

  it("keeps one entry for two uploads of one turn until both end, and traces it once", async () => {
    const gates = [gate(), gate()];
    const stub = stubModel({ reply: "Hello.", topics: ["other"] }, (call) => gates[call - 1]!.promise);
    const service = serviceWith(stub.model);
    const w = await walker(service);
    const request = typed("Hello");
    const a = service.turn(device(w.credential), w.id, request);
    const b = service.turn(device(w.credential), w.id, request);
    await Promise.all([stub.entered[0]!.promise, stub.entered[1]!.promise]);
    expect((await activityOf(service, w.secret, w.id))?.in_flight.map((f) => f.client_turn_id)).toEqual([request.client_turn_id]);

    gates[0]!.open();
    await a;
    // The second upload is still waiting on the model: the first one's end mustn't clear it.
    expect((await activityOf(service, w.secret, w.id))?.in_flight.map((f) => f.client_turn_id)).toEqual([request.client_turn_id]);

    gates[1]!.open();
    await b;
    const after = await activityOf(service, w.secret, w.id);
    expect(after?.in_flight).toEqual([]);
    expect(after?.traces.map((t) => t.client_turn_id)).toEqual([request.client_turn_id]);
  });

  // ---- Traces ----

  it("traces the model's words, the arms line, alerts turned off, an opened proposal, a page turn and no model", async () => {
    const replies: Reply[] = [
      { reply: "Your hand controls work.", topics: ["other"] },
      { reply: "Sure, I'll grab them.", topics: ["arms"] },
      { reply: "I can do that.", topics: ["settings"], cues_change: { cues: ["spoken"] } },
      { reply: "I can do that.", topics: ["settings"], cues_change: { cues: ["sound", "spoken"] } },
      { reply: "Your hand controls work.", topics: ["other"] },
    ];
    const service = serviceWith(stubModel((call) => replies[call - 1]!).model);
    const w = await walker(service);
    const turns = [];
    for (const [i, request] of [typed("Which parts work?"), typed("Pick up my keys."), typed("Only speak to me."), typed("Use short sounds.")].entries()) {
      turns.push(await service.turn(device(w.credential), w.id, request));
      if (i === 0) clock.advance(1_000);
    }
    const page = fromPage("Are my handles working?");
    turns.push(await service.turn(owner(w.secret), w.id, page));
    await serviceWith(null).turn(device(w.credential), w.id, typed("Hello"));

    const traces = (await activityOf(service, w.secret, w.id))!.traces;
    expect(traces).toHaveLength(6);
    // The model's own words, typed on the walker with no voice configured: no Cartesia call, so no voice time.
    expect(traces[0]).toEqual({
      turn_id: turns[0]!.turn.turn_id,
      client_turn_id: turns[0]!.turn.client_turn_id,
      at: new Date(clock.t - 1_000).toISOString(),
      input: "text",
      clip_ms: null,
      model_ran: true,
      model: "claude",
      model_ms: expect.any(Number),
      transcribe_ms: null,
      rule: null,
      answered_by: "model",
      proposal_opened: false,
      voiced_by: "walker",
      voice_ms: null,
      total_ms: expect.any(Number),
    });
    expect(traces[1]).toMatchObject({ rule: "arms", answered_by: "fixed", model_ran: true, proposal_opened: false });
    expect(traces[2]).toMatchObject({ rule: "cues_alerts_off", answered_by: "fixed", proposal_opened: false });
    expect(traces[3]).toMatchObject({ rule: null, answered_by: "model", proposal_opened: true });
    expect(turns[3]!.proposal?.state).toBe("open");
    expect(traces[4]).toMatchObject({ client_turn_id: page.client_turn_id, input: "text", voiced_by: null, voice_ms: null, rule: null, answered_by: "model" });
    expect(traces[5]).toMatchObject({ model_ran: false, model: null, model_ms: null, rule: "no_model", answered_by: "fixed" });
    expect(traces[5]!.at).toBe(clock.iso());
  });

  it("shows a spoken turn with Cartesia first, then Claude, and times the transcription", async () => {
    const heard = gate();
    const entered = gate();
    const slowEars: WalkerEars = { transcribe: async () => (entered.open(), await heard.promise, "Which parts work?") };
    const claude = stubModel({ reply: "Claude here.", transcript: "Which parts work?", topics: ["other"] });
    const service = serviceWith(claude.model, { ears: slowEars });
    const w = await walker(service);

    const request = spoken();
    const pending = service.turn(device(w.credential), w.id, request);
    await entered.promise;
    expect((await activityOf(service, w.secret, w.id))!.in_flight).toMatchObject([{ client_turn_id: request.client_turn_id, input: "audio", stage: "transcribing", model: "claude" }]);
    heard.open();
    await claude.entered[0]!.promise;
    const r = await pending;
    expect(r.turn).toMatchObject({ heard: "Which parts work?", heard_by: "cartesia" });

    // A tool continuation carries the spoken question as text, flagged original_audio: still heard by Cartesia, not typed.
    const continuation: DeviceTurnRequest = { client_turn_id: uuid(), input: { type: "text", text: "Where am I?" }, snapshot: snapshot(clock), tool_results: [{ name: "get_location", text: "Near Main Street." }], original_audio: true };
    const after = await service.turn(device(w.credential), w.id, continuation);
    expect(after.turn).toMatchObject({ heard: "Where am I?", heard_by: "cartesia" });

    const traces = (await activityOf(service, w.secret, w.id))!.traces;
    expect(traces.map((t) => [t.input, t.model, typeof t.transcribe_ms])).toEqual([
      ["audio", "claude", "number"],
      ["text", "claude", "object"],
    ]);
    expect(claude.calls()).toBe(2);
  });

  it("holds none of the person's words or the replies", async () => {
    const service = serviceWith(stubModel({ transcript: "Where is my secret garden?", reply: "Your marigolds look lovely.", topics: ["other"] }).model);
    const w = await walker(service);
    await service.turn(device(w.credential), w.id, typed("Tell me about my secret garden."));
    await service.turn(device(w.credential), w.id, spoken());
    await service.turn(owner(w.secret), w.id, fromPage("Is my secret garden watered?"));
    // The status view beside it carries the conversation (it always has); the activity and the log itself never do.
    const listed = await service.list(owner(w.secret));
    expect(JSON.stringify(listed.walkers)).toMatch(/garden/);
    expect(listed.activity?.[0]?.traces).toHaveLength(3);
    const text = JSON.stringify(listed.activity) + dump(log);
    expect(text).not.toMatch(/garden|marigold/i);
  });

  // ---- Bounds and deletion ----

  it("keeps the newest RECENT_TURNS traces, oldest first", async () => {
    const service = serviceWith(stubModel({ reply: "Hello.", topics: ["other"] }).model);
    const w = await walker(service);
    const ids: string[] = [];
    for (let i = 0; i < RECENT_TURNS + 2; i++) {
      const request = typed(`Question ${i}`);
      ids.push(request.client_turn_id);
      await service.turn(device(w.credential), w.id, request);
      clock.advance(1_000);
    }
    expect((await activityOf(service, w.secret, w.id))?.traces.map((t) => t.client_turn_id)).toEqual(ids.slice(-RECENT_TURNS));
  });

  it("shows at most 4 turns in flight, and still traces the fifth", async () => {
    const release = gate();
    const stub = stubModel({ reply: "Hello.", topics: ["other"] }, () => release.promise);
    const service = serviceWith(stub.model);
    const w = await walker(service);
    const requests = Array.from({ length: 5 }, (_, i) => typed(`Question ${i}`));
    const pending: Promise<unknown>[] = [];
    for (const [i, r] of requests.entries()) {
      pending.push(service.turn(device(w.credential), w.id, r));
      await stub.entered[i]!.promise;
    }
    expect((await activityOf(service, w.secret, w.id))?.in_flight.map((f) => f.client_turn_id)).toEqual(requests.slice(0, 4).map((r) => r.client_turn_id));
    release.open();
    await Promise.all(pending);
    const after = await activityOf(service, w.secret, w.id);
    expect(after?.in_flight).toEqual([]);
    expect(after?.traces).toHaveLength(5);
  });

  it("drops traces past the history retention, and leaves out a walker with nothing to show", async () => {
    const service = serviceWith(stubModel({ reply: "Hello.", topics: ["other"] }).model);
    const w = await walker(service);
    await service.turn(device(w.credential), w.id, typed("Hello"));
    clock.advance(WALKER_HISTORY_RETENTION_MS);
    expect((await activityOf(service, w.secret, w.id))?.traces).toHaveLength(1);
    clock.advance(1);
    const listed = await service.list(owner(w.secret));
    expect(listed.walkers).toHaveLength(1);
    expect(listed).not.toHaveProperty("activity");
    expect(dump(log)).not.toContain(w.id);
  });

  it("deletes a walker's activity when its owner forgets it", async () => {
    const service = serviceWith(stubModel({ reply: "Hello.", topics: ["other"] }).model);
    const w = await walker(service);
    await service.turn(device(w.credential), w.id, typed("Hello"));
    expect(log.view([w.id])).toHaveLength(1);
    await service.forget(owner(w.secret), w.id);
    expect(log.view([w.id])).toEqual([]);
    expect(dump(log)).not.toContain(w.id);
  });

  it("gives each owner only their own walkers' activity", async () => {
    const service = serviceWith(stubModel({ reply: "Hello.", topics: ["other"] }).model);
    const a = await walker(service);
    const b = await walker(service);
    const quiet = await walker(service);
    await service.turn(device(a.credential), a.id, typed("Hello"));
    await service.turn(device(b.credential), b.id, typed("Hello"));
    const listA = await service.list(owner(a.secret));
    const listB = await service.list(owner(b.secret));
    expect(listA.activity?.map((x) => x.device_id)).toEqual([a.id]);
    expect(listB.activity?.map((x) => x.device_id)).toEqual([b.id]);
    // An owner whose walker has no activity gets the list as before.
    expect(await service.list(owner(quiet.secret))).toEqual({ walkers: [expect.objectContaining({ device_id: quiet.id })] });
    for (const listed of [listA, listB]) expect(WalkerListResponseSchema.safeParse(listed).success).toBe(true);
  });

  it("tracks nothing without a log, and the list is unchanged", async () => {
    const service = new WalkerService(store, { now: clock.now, assistant: null, onTurn: () => {} });
    const w = await walker(service);
    await service.turn(device(w.credential), w.id, typed("Hello"));
    expect(await service.list(owner(w.secret))).not.toHaveProperty("activity");
  });
});

/** Everything the log holds, as text. */
function dump(log: ActivityLog): string {
  return JSON.stringify(log, (_key, value) => (value instanceof Map ? [...value.entries()] : value));
}
