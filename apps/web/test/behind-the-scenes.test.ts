import { describe, expect, it } from "vitest";
import {
  PROPOSAL_TTL_MS,
  WALKER_SETUP,
  WalkerActivityViewSchema,
  WalkerStatusViewSchema,
  type ProposalView,
  type WalkerActivityView,
  type WalkerStatusView,
  type WalkerTurnInFlight,
  type WalkerTurnTrace,
  type WalkerTurnView,
} from "@walker/contracts";
import { CAPTION, IN_FLIGHT_STALE_MS, anyInFlight, buildStages, formatMs, ruleWords, spokenMs, type BehindInput } from "@/lib/behindTheScenes";
import type { ProposalCard } from "@/lib/walkerView";

// Expected results: apps/web/test/walker-page.EXPECTED.md, "Behind the scenes". Fake names only.

const T0 = Date.parse("2026-10-24T18:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function turn(over: Partial<WalkerTurnView> = {}): WalkerTurnView {
  return {
    turn_id: id(101),
    client_turn_id: id(201),
    source: "walker",
    heard: "What can you help me with?",
    heard_by: "gemini",
    reply: "I can read your obstacle sensors.",
    answered_by: "model",
    voiced_by: "cartesia",
    created_at: iso(T0),
    ...over,
  };
}

function trace(over: Partial<WalkerTurnTrace> = {}): WalkerTurnTrace {
  return {
    turn_id: id(101),
    client_turn_id: id(201),
    at: iso(T0),
    input: "audio",
    clip_ms: 2_400,
    model_ran: true,
    model_ms: 2_140,
    rule: null,
    answered_by: "model",
    proposal_opened: false,
    voiced_by: "cartesia",
    voice_ms: 810,
    total_ms: 3_100,
    ...over,
  };
}

function flight(over: Partial<WalkerTurnInFlight> = {}): WalkerTurnInFlight {
  return { client_turn_id: id(202), input: "audio", since: iso(T0 + 5_000), clip_ms: 1_800, stage: "hearing", ...over };
}

function proposal(over: Partial<ProposalView> = {}): ProposalView {
  return {
    proposal_id: id(300),
    client_turn_id: id(201),
    kind: "cues_change",
    from_cues: ["vibration", "spoken"],
    cues: ["spoken", "sound"],
    base_configuration_version: 1,
    summary: "Switch your alerts from buzzing to short sounds.",
    state: "open",
    created_at: iso(T0),
    expires_at: iso(T0 + PROPOSAL_TTL_MS),
    configuration_version: null,
    ...over,
  };
}

function status(over: Partial<WalkerStatusView> = {}): WalkerStatusView {
  return WalkerStatusViewSchema.parse({
    device_id: id(1),
    name: "Sophi walker",
    online: true,
    last_seen_at: iso(T0),
    simulator: true,
    configuration: { version: 1, ...WALKER_SETUP, created_at: iso(T0 - 60_000) },
    applied_configuration_version: 1,
    parts: [],
    zones: [],
    open_proposal: null,
    turns: [turn()],
    walker_said: [],
    ...over,
  });
}

function activity(over: Partial<WalkerActivityView> = {}): WalkerActivityView {
  return WalkerActivityViewSchema.parse({ device_id: id(1), in_flight: [], traces: [trace()], ...over });
}

function build(over: Partial<BehindInput> = {}) {
  return buildStages({ status: status(), activity: activity(), card: null, ownTurnId: null, nowMs: T0 + 6_000, ...over });
}

/** Each station as "label | figure | state". */
const rows = (v: ReturnType<typeof build>) => v.stages.map((s) => `${s.label} | ${s.figure} | ${s.state}`);

describe("behind the scenes: a finished turn with a trace", () => {
  it("draws a spoken turn: clip, Gemini's time, its own words, the reply and Cartesia's voice", () => {
    const v = build();
    expect([v.key, v.title, v.timing, v.totalMs]).toEqual([id(201), "Latest turn", "measured", 3_100]);
    expect(rows(v)).toEqual([
      "Walker sent | 2.4 s of audio | done",
      "Gemini | 2.1 s | done",
      "Rules | Gemini's own words | done",
      "Reply | Text sent to the walker | done",
      "Voice | Sent in Cartesia's voice, 810 ms | done",
    ]);
    expect(v.stages.map((s) => s.sentence)).toEqual([
      "The walker sent 2.4 seconds of audio.",
      "Gemini heard the clip and wrote an answer in 2.1 seconds.",
      "Rules: Gemini's own words.",
      "Reply: Text sent to the walker.",
      "The reply was sent in Cartesia's voice, made in 810 milliseconds.",
    ]);
  });

  it("draws a typed page turn with no voice station", () => {
    const s = status({ turns: [turn({ source: "page", heard_by: "typed", voiced_by: null })] });
    const v = build({ status: s, activity: activity({ traces: [trace({ input: "text", clip_ms: null, voiced_by: null, voice_ms: null, model_ms: 640 })] }) });
    expect(rows(v)).toEqual([
      "Page sent | typed | done",
      "Gemini | 640 ms | done",
      "Rules | Gemini's own words | done",
      "Reply | Text sent to this page | done",
    ]);
    expect(v.stages[0]!.sentence).toBe("This page sent a typed question.");
    expect(v.stages[1]!.sentence).toBe("Gemini read the question and wrote an answer in 640 milliseconds.");
  });

  it("says the walker's own voice when no audio was sent, never that it spoke", () => {
    const v = build({ activity: activity({ traces: [trace({ voiced_by: "walker", voice_ms: null })] }) });
    expect(v.stages.at(-1)).toMatchObject({ label: "Voice", figure: "Walker's own voice" });
    const words = JSON.stringify(build().stages) + JSON.stringify(v.stages);
    expect(words).not.toMatch(/spoke|played|buzzed|heard by her/i);
  });

  it("draws no Gemini station when no model ran", () => {
    const v = build({ activity: activity({ traces: [trace({ model_ran: false, model_ms: null, rule: "no_model", answered_by: "fixed" })] }) });
    expect(v.stages.map((s) => s.id)).toEqual(["sent", "rules", "reply", "voice"]);
    expect(v.stages[1]!.figure).toBe("Fixed reply");
  });

  it("words every rule code in plain English", () => {
    expect(
      ["arms", "cues_alerts_off", "cues_unchanged", "cues_undeliverable", "cues_empty", "cues_duplicate", "offline", "timeout", "model_error", "refusal", "invalid_reply", "no_model", "something_new"].map(
        (r) => ruleWords(r, false),
      ),
    ).toEqual([
      "Fixed line: no robot arms",
      "Refused: alerts keep a buzz or sound",
      "Refused: alerts already set",
      "Refused: no part can give that alert",
      "Refused: not a valid change",
      "Refused: not a valid change",
      "Refused: walker offline",
      "Fixed reply",
      "Fixed reply",
      "Fixed reply",
      "Fixed reply",
      "Fixed reply",
      "Fixed reply (something_new)",
    ]);
    expect([ruleWords(null, false), ruleWords(null, true)]).toEqual(["Gemini's own words", "Change allowed"]);
  });

  it("draws the arms rule as a fixed line after Gemini's own step", () => {
    const v = build({ activity: activity({ traces: [trace({ rule: "arms", answered_by: "fixed" })] }) });
    expect(rows(v).slice(1, 3)).toEqual(["Gemini | 2.1 s | done", "Rules | Fixed line: no robot arms | done"]);
  });

  it("says how a model call failed, with its time", () => {
    const at = (rule: string, ms: number | null) => build({ activity: activity({ traces: [trace({ rule, model_ms: ms, answered_by: "fixed" })] }) }).stages[1]!;
    expect(at("timeout", 8_000)).toMatchObject({ figure: "timed out after 8.0 s", sentence: "Gemini timed out after 8 seconds." });
    expect(at("model_error", 1_200)).toMatchObject({ figure: "failed after 1.2 s", sentence: "Gemini failed after 1.2 seconds." });
    expect(at("refusal", 900).figure).toBe("declined to answer");
    expect(at("invalid_reply", 3_000).figure).toBe("gave no usable reply");
  });
});

describe("behind the scenes: an offer, Confirm, recorded and applied", () => {
  const offered = trace({ rule: null, proposal_opened: true });
  const stagesOf = (s: WalkerStatusView, card: ProposalCard | null = null, nowMs = T0 + 6_000) => rows(build({ status: s, activity: activity({ traces: [offered] }), card, nowMs }));

  it("shows the server-written offer, then waits for Confirm while it's open", () => {
    expect(stagesOf(status({ open_proposal: proposal() })).slice(2)).toEqual([
      "Rules | Change allowed | done",
      "Reply | Offer written by the server | done",
      "Voice | Sent in Cartesia's voice, 810 ms | done",
      "Offer | Waiting for Confirm | live",
    ]);
  });

  it("after Confirm: recorded at the new version, then waiting for the walker, then applied", () => {
    const confirmed = proposal({ state: "confirmed", configuration_version: 2 });
    const card: ProposalCard = { proposal: confirmed, outcome: "Confirmed.", closedAfter: id(101) };
    const v2 = { version: 2, ...WALKER_SETUP, cues: ["spoken", "sound"] as const, created_at: iso(T0 + 4_000) };
    const waiting = stagesOf(status({ configuration: { ...v2, cues: [...v2.cues] }, applied_configuration_version: 1 }), card);
    expect(waiting.slice(5)).toEqual([
      "Offer | Confirmed | done",
      "Confirm | Button press, not voice | done",
      "Recorded v2 | Saved on the server | done",
      "Walker | Waiting for the walker | live",
    ]);
    const applied = stagesOf(status({ configuration: { ...v2, cues: [...v2.cues] }, applied_configuration_version: 2 }), card);
    expect(applied.at(-1)).toBe("Applied | Reported by the walker | done");
  });

  it("reads a Confirm made on the walker from the configuration, as the card does", () => {
    const card: ProposalCard = { proposal: proposal(), outcome: null, closedAfter: null };
    const s = status({ configuration: { version: 2, ...WALKER_SETUP, cues: ["spoken", "sound"], created_at: iso(T0 + 4_000) }, applied_configuration_version: 2 });
    expect(stagesOf(s, card).slice(5)).toEqual([
      "Offer | Confirmed | done",
      "Confirm | Button press, not voice | done",
      "Recorded v2 | Saved on the server | done",
      "Applied | Reported by the walker | done",
    ]);
  });

  it("ends the line when the offer closes without a change", () => {
    const end = (p: ProposalView) => stagesOf(status(), { proposal: p, outcome: "x", closedAfter: id(101) }).at(-1);
    expect(end(proposal({ state: "declined" }))).toBe("Offer | Declined: nothing changed | end");
    expect(end(proposal({ state: "expired" }))).toBe("Offer | Expired: nothing changed | end");
    expect(end(proposal({ state: "superseded" }))).toBe("Offer | Replaced by a newer offer | end");
    // Closed elsewhere, past its time, configuration unchanged.
    expect(stagesOf(status(), { proposal: proposal(), outcome: null, closedAfter: null }, T0 + PROPOSAL_TTL_MS + 1).at(-1)).toBe("Offer | Expired: nothing changed | end");
  });

  it("never ties another turn's offer to this one", () => {
    expect(stagesOf(status({ open_proposal: proposal({ client_turn_id: id(299) }) })).map((r) => r.split(" | ")[0])).not.toContain("Offer");
  });
});

describe("behind the scenes: in flight", () => {
  it("hearing: the clip, then a live station waiting for Gemini", () => {
    const v = build({ activity: activity({ in_flight: [flight()] }) });
    expect([v.key, v.title, v.timing]).toEqual([id(202), "Turn in progress", "measured"]);
    expect(rows(v)).toEqual(["Walker sent | 1.8 s of audio | done", "Hearing | Waiting for Gemini… | live"]);
  });

  it("voicing: hearing done, then a live station waiting for Cartesia, with the same station ids the trace will use", () => {
    const v = build({ activity: activity({ in_flight: [flight({ stage: "voicing" })] }) });
    expect(rows(v)).toEqual(["Walker sent | 1.8 s of audio | done", "Hearing | Done | done", "Voice | Waiting for Cartesia… | live"]);
    expect(v.stages.map((s) => s.id)).toEqual(["sent", "model", "voice"]);
  });

  it("knows this page's own typed question", () => {
    const v = build({ activity: activity({ in_flight: [flight({ input: "text", clip_ms: null })] }), ownTurnId: id(202) });
    expect(v.stages[0]).toMatchObject({ label: "Page sent", figure: "typed" });
    const other = build({ activity: activity({ in_flight: [flight({ input: "text", clip_ms: null })] }) });
    expect(other.stages[0]).toMatchObject({ label: "Sent", figure: "typed" });
  });

  it("drops an in-flight turn 10 s old or more, and shows the finished turn instead", () => {
    const old = flight({ since: iso(T0) });
    const v = build({ activity: activity({ in_flight: [old] }), nowMs: T0 + IN_FLIGHT_STALE_MS });
    expect([v.key, v.title]).toEqual([id(201), "Latest turn"]);
    expect(anyInFlight([activity({ in_flight: [old] })], T0 + IN_FLIGHT_STALE_MS)).toBe(false);
    expect(anyInFlight([activity({ in_flight: [old] })], T0 + IN_FLIGHT_STALE_MS - 1)).toBe(true);
  });

  it("shows the newest of several in flight", () => {
    const v = build({ activity: activity({ in_flight: [flight({ client_turn_id: id(203), since: iso(T0 + 4_000) }), flight()] }) });
    expect(v.key).toBe(id(202));
  });
});

describe("behind the scenes: without timings", () => {
  it("with no activity (a server restart), draws only what the status proves and says there are no timings", () => {
    const v = build({ activity: undefined });
    expect(v.timing).toBe("none");
    expect(rows(v)).toEqual([
      "Walker sent | audio | done",
      "Gemini | ran | done",
      "Rules | Gemini's own words | done",
      "Reply | Text sent to the walker | done",
      "Voice | Sent in Cartesia's voice | done",
    ]);
    expect(v.totalMs).toBeNull();
  });

  it("a fixed reply from status alone says only 'Fixed reply', with no code it can't know", () => {
    const s = status({ turns: [turn({ answered_by: "fixed" })] });
    expect(build({ status: s, activity: activity({ traces: [] }) }).stages[2]!.figure).toBe("Fixed reply");
  });

  it("a turn still listed in flight by the same poll has its timings on the way", () => {
    const v = build({ activity: activity({ traces: [], in_flight: [flight({ client_turn_id: id(201) })] }) });
    expect([v.key, v.timing]).toEqual([id(201), "pending"]);
  });

  it("with no turns and nothing in flight, draws nothing", () => {
    const v = build({ status: status({ turns: [] }), activity: activity({ traces: [] }) });
    expect([v.key, v.stages, v.timing]).toEqual([null, [], "empty"]);
  });
});

describe("behind the scenes: wording", () => {
  it("formats the server's times for the drawing and for a sentence", () => {
    expect([formatMs(640), formatMs(2_140), formatMs(8_000)]).toEqual(["640 ms", "2.1 s", "8.0 s"]);
    expect([spokenMs(640), spokenMs(2_140), spokenMs(8_000)]).toEqual(["640 milliseconds", "2.1 seconds", "8 seconds"]);
    expect(CAPTION).toBe("Drawn as each step's evidence reaches this page. Times are measured.");
  });
});
