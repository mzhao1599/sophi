import { describe, expect, it, vi } from "vitest";
import {
  PROPOSAL_TTL_MS,
  WALKER_SETUP,
  WalkerStatusViewSchema,
  type ProposalView,
  type WalkerStatusView,
  type WalkerTurnView,
} from "@walker/contracts";
import { WalkerApiError, createWalkerApi, nextClockOffset } from "@/lib/walkerApi";
import { createFakeWalker } from "@/lib/walkerFake";
import {
  CONNECTION_BACK,
  OUT_OF_TIME,
  PACE_WORD,
  paceOf,
  typedNotice,
  ZONE_MAX_SHOWN_AGE_MS,
  announcements,
  appliedState,
  closedOutcome,
  conversation,
  drawState,
  drawnParts,
  errorMessage,
  formatAge,
  formatCode,
  formatCountdown,
  formatDistance,
  pairCommand,
  partRows,
  presence,
  spreadLabels,
  proposalOutcome,
  readingOrder,
  secondsLeft,
  zoneRows,
} from "@/lib/walkerView";

// Expected results: apps/web/test/walker-page.EXPECTED.md. Fake names only.

const T0 = Date.parse("2026-10-24T18:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function turn(n: number, at: number, over: Partial<WalkerTurnView> = {}): WalkerTurnView {
  return {
    turn_id: id(100 + n),
    client_turn_id: id(200 + n),
    source: "walker",
    heard: "What can you help me with?",
    heard_by: "cartesia",
    reply: "I can read your obstacle sensors.",
    answered_by: "model",
    voiced_by: "cartesia",
    created_at: iso(at),
    ...over,
  };
}

function proposal(over: Partial<ProposalView> = {}): ProposalView {
  return {
    proposal_id: id(300),
    client_turn_id: id(201),
    kind: "cues_change",
    from_cues: ["vibration", "spoken"],
    cues: ["sound", "spoken"],
    base_configuration_version: 1,
    summary: "Switch your alerts from vibration to short sounds.",
    state: "open",
    created_at: iso(T0),
    expires_at: iso(T0 + PROPOSAL_TTL_MS),
    configuration_version: null,
    ...over,
  };
}

/** A walker as the server would send it: checked against the contract, so a test can't use a shape it can't send. */
function status(over: Partial<WalkerStatusView> = {}): WalkerStatusView {
  return WalkerStatusViewSchema.parse({
    device_id: id(1),
    name: "Sophi walker",
    online: true,
    last_seen_at: iso(T0),
    simulator: true,
    configuration: { version: 1, ...WALKER_SETUP, created_at: iso(T0 - 60_000) },
    applied_configuration_version: 1,
    parts: [
      { module_id: "voice", instance_id: "voice-01", health: "ok", simulated: false, in_configuration: true },
      { module_id: "perception.tof", instance_id: "tof-front-01", health: "ok", simulated: true, in_configuration: true },
      { module_id: "controls.hand", instance_id: null, health: "unavailable", simulated: false, in_configuration: true },
      { module_id: "base.walker", instance_id: "pi-01", health: "degraded", simulated: false, in_configuration: true },
      { module_id: "location.gps", instance_id: "gps-01", health: "fault", simulated: false, in_configuration: false },
    ],
    zones: [
      { zone: "front", instance_id: "tof-front-01", simulated: true, reading: { status: "measured", mm: 380, age_ms: 400 } },
      { zone: "front_left", instance_id: "tof-front-01", simulated: true, reading: { status: "unknown", reason: "invalid" } },
      { zone: "rear", instance_id: "tof-rear-01", simulated: false, reading: { status: "unknown", reason: "stale" } },
      { zone: "left", instance_id: "tof-x", simulated: true, reading: { status: "unknown", reason: "missing" } },
    ],
    open_proposal: null,
    turns: [],
    walker_said: [],
    ...over,
  });
}

describe("parts", () => {
  it("sorts by catalog, says health in words, and marks simulated and not-configured parts", () => {
    const rows = partRows(status().parts);
    expect(rows.map((r) => r.module_id)).toEqual(["base.walker", "controls.hand", "perception.tof", "voice", "location.gps"]);
    expect(rows.map((r) => r.words)).toEqual([
      "Degraded",
      "Unavailable",
      "Healthy, Simulated",
      "Healthy",
      "Fault, Not in your setup",
    ]);
    expect(rows.map((r) => r.draw)).toEqual(["degraded", "unavailable", "simulated", "on", "fault"]);
  });

  it("keeps one row per part, and draws a module in the worst state of its parts", () => {
    const parts = [
      { module_id: "controls.hand", instance_id: "hand-left-01", health: "fault", simulated: false, in_configuration: true },
      { module_id: "controls.hand", instance_id: "hand-right-01", health: "ok", simulated: false, in_configuration: true },
      { module_id: "perception.tof", instance_id: "tof-front-01", health: "ok", simulated: true, in_configuration: true },
      { module_id: "perception.tof", instance_id: "tof-rear-01", health: "degraded", simulated: false, in_configuration: true },
    ] as const;
    const rows = partRows(status({ parts: [...parts] }).parts);
    expect(rows.map((r) => r.key)).toEqual(["controls.hand/hand-left-01", "controls.hand/hand-right-01", "perception.tof/tof-front-01", "perception.tof/tof-rear-01"]);
    const drawn = drawnParts(rows);
    expect(drawn.get("controls.hand")).toEqual({ draw: "fault", name: "Hand controls", words: "Fault; Healthy", simulated: false });
    expect(drawn.get("perception.tof")).toEqual({ draw: "degraded", name: "Obstacle sensors", words: "Healthy, Simulated; Degraded", simulated: true });
    // A single part's words leave "Simulated" to its chip.
    expect(drawnParts(partRows(status().parts)).get("perception.tof")?.words).toBe("Healthy");
  });

  it("moves the drawing's labels apart only as far as needed, keeping their order", () => {
    // Room for both where they want to be: unchanged.
    expect(spreadLabels([{ want: 64, size: 40 }, { want: 140, size: 40 }], 0, 380)).toEqual([64, 140]);
    // Hand controls and a tall Location sharing: the lower one moves down until they touch.
    expect(spreadLabels([{ want: 64, size: 60 }, { want: 140, size: 100 }], 0, 380)).toEqual([64, 144]);
    // Pushed past the bottom: the stack moves back up, and none rises above the top.
    expect(spreadLabels([{ want: 20, size: 60 }, { want: 300, size: 100 }, { want: 340, size: 100 }], 0, 380)).toEqual([30, 230, 330]);
    // Too tall to fit at all: still no overlap, and the lowest runs past the bottom.
    expect(spreadLabels([{ want: 340, size: 200 }, { want: 64, size: 200 }], 0, 380)).toEqual([300, 100]);
  });

  it("draws solid green only for a real, healthy part", () => {
    expect(drawState({ health: "ok", simulated: false })).toBe("on");
    expect(drawState({ health: "ok", simulated: true })).toBe("simulated");
    expect(drawState({ health: "degraded", simulated: true })).toBe("simulated");
    expect(drawState({ health: "unavailable", simulated: true })).toBe("unavailable");
    expect(drawState({ health: "fault", simulated: true })).toBe("fault");
  });
});

describe("alert settings", () => {
  it("is Applied only when the walker reports the current version", () => {
    const configuration = { version: 2, ...WALKER_SETUP, created_at: iso(T0) };
    expect(appliedState({ configuration, applied_configuration_version: 2 })).toBe("applied");
    expect(appliedState({ configuration, applied_configuration_version: 1 })).toBe("waiting");
    expect(appliedState({ configuration, applied_configuration_version: null })).toBe("waiting");
    expect(appliedState({ configuration, applied_configuration_version: 3 })).toBe("waiting");
  });
});

describe("obstacle zones", () => {
  it("shows a measured distance with its growing age, and Unknown with a reason, never clear", () => {
    const rows = zoneRows(status().zones, 700, true);
    expect(rows.map((r) => [r.name, r.value, r.detail, r.simulated])).toEqual([
      ["Front", "38 cm", "measured 1.1 s ago", true],
      ["Front left", "Unknown", "the sensor couldn't measure", true],
      ["Rear", "Unknown", "reading too old", false],
      ["Left", "Unknown", "no reading", true],
    ]);
    expect(JSON.stringify(rows).toLowerCase()).not.toMatch(/clear|nothing|no obstacle/);
  });

  it("turns a reading Unknown once it's older than the freshness limit plus one poll", () => {
    const [front] = zoneRows(status().zones, ZONE_MAX_SHOWN_AGE_MS - 400, true);
    expect([front!.value, front!.detail]).toEqual(["38 cm", "measured 8.5 s ago"]);
    const [stale] = zoneRows(status().zones, ZONE_MAX_SHOWN_AGE_MS - 399, true);
    expect([stale!.value, stale!.detail, stale!.measured]).toEqual(["Unknown", "reading too old", false]);
  });

  it("turns every zone Unknown when the page isn't live", () => {
    const rows = zoneRows(status().zones, 0, false);
    expect(rows.every((r) => r.value === "Unknown" && r.detail === "no update from the server" && !r.measured)).toBe(true);
  });

  it("formats distances and ages", () => {
    expect([formatDistance(0), formatDistance(380), formatDistance(999), formatDistance(1000), formatDistance(1234)]).toEqual([
      "0 cm",
      "38 cm",
      "100 cm",
      "1.0 m",
      "1.2 m",
    ]);
    expect([formatAge(640), formatAge(12_300), formatAge(150_000), formatAge(-5)]).toEqual(["0.6 s ago", "12 s ago", "2 min ago", "0.0 s ago"]);
  });
});

describe("online and offline", () => {
  it("always says Online, Offline or Status unknown in words", () => {
    expect(presence({ online: true, last_seen_at: iso(T0) }, T0 + 1000, true)).toEqual({ word: "Online", detail: null, tone: "online" });
    expect(presence({ online: false, last_seen_at: iso(T0) }, T0 + 180_000, true).detail).toBe("last seen 3 min ago");
    expect(presence({ online: false, last_seen_at: null }, T0, true).detail).toBe("never seen");
    expect(presence({ online: true, last_seen_at: iso(T0) }, T0, false).word).toBe("Status unknown");
  });
});

describe("countdowns and pairing", () => {
  it("counts whole seconds down to 0 and formats them", () => {
    expect(secondsLeft(T0 + 42_000, T0)).toBe(42);
    expect(secondsLeft(T0 + 41_001, T0)).toBe(42);
    expect(secondsLeft(T0, T0 + 5)).toBe(0);
    expect([formatCountdown(42), formatCountdown(599), formatCountdown(0), formatCountdown(-3)]).toEqual(["0:42", "9:59", "0:00", "0:00"]);
  });

  it("splits the code for reading aloud and builds the pair command", () => {
    expect(formatCode("482913")).toBe("482 913");
    expect(pairCommand("482913", "https://sophi.example")).toBe("walker pair 482913 --server https://sophi.example");
  });
});

describe("conversation", () => {
  it("labels who heard each turn, notes fixed replies and the offered voice, and merges walker lines by time", () => {
    const view = status({
      turns: [
        turn(1, T0 + 1_000),
        turn(2, T0 + 3_000, { source: "page", heard_by: "typed", heard: "Is anything in front of me?", voiced_by: null, answered_by: "fixed" }),
        turn(3, T0 + 5_000, { heard: null, heard_by: null, voiced_by: "walker" }),
        turn(4, T0 + 6_000, { heard_by: "typed", heard: "hello" }),
      ],
      walker_said: [
        { event_id: id(401), kind: "notice", text: "Sophi is on.", at: iso(T0) },
        { event_id: id(402), kind: "local_reply", text: "I'm offline right now.", at: iso(T0 + 4_000) },
      ],
    });
    const entries = conversation(view);
    expect(entries.map((e) => e.key)).toEqual([`e-${id(401)}`, `t-${id(101)}`, `t-${id(102)}`, `e-${id(402)}`, `t-${id(103)}`, `t-${id(104)}`]);
    const turns = entries.filter((e) => e.kind === "turn");
    expect(turns.map((e) => [e.heardLabel, e.heard, e.engineNote, e.voiceNote])).toEqual([
      ["You said (as heard by Cartesia)", "What can you help me with?", null, "In Cartesia's voice"],
      ["You typed", "Is anything in front of me?", "Answered by the fixed replies", null],
      ["You said", null, null, "In the walker's own voice"],
      ["Typed on the walker", "hello", null, "In Cartesia's voice"],
    ]);
    const lines = entries.filter((e) => e.kind === "line");
    expect(lines.map((e) => e.label)).toEqual(["On the walker", "On the walker, offline reply"]);
  });
});

describe("proposals", () => {
  it("says how a proposal closed, from its state", () => {
    expect(proposalOutcome(proposal())).toBeNull();
    expect(proposalOutcome(proposal({ state: "confirmed", configuration_version: 2 }))).toBe(
      "Confirmed. Switching your alerts to short sounds and spoken messages.",
    );
    expect(proposalOutcome(proposal({ state: "declined" }))).toBe("Declined. Nothing changed.");
    expect(proposalOutcome(proposal({ state: "expired" }))).toBe("Expired. Nothing changed.");
    expect(proposalOutcome(proposal({ state: "superseded" }))).toBe("Replaced by a newer offer.");
  });

  it("infers a vanished proposal's end only from what the status shows", () => {
    const p = proposal();
    const moved = status({ configuration: { version: 2, ...WALKER_SETUP, cues: ["sound", "spoken"], created_at: iso(T0 + 5_000) } });
    expect(closedOutcome(p, moved, T0 + 6_000)).toBe("Confirmed. Switching your alerts to short sounds and spoken messages.");
    // Confirmed and then changed again while the page wasn't looking: it can't say nothing changed.
    const twice = status({ configuration: { version: 3, ...WALKER_SETUP, cues: ["vibration", "sound"], created_at: iso(T0 + 9_000) } });
    expect(closedOutcome(p, twice, T0 + PROPOSAL_TTL_MS + 1)).toBe("No longer open.");
    expect(OUT_OF_TIME).not.toMatch(/nothing changed/i);
    // The version moved but to other cues: not this proposal's confirm.
    const other = status({ configuration: { version: 2, ...WALKER_SETUP, cues: ["vibration", "sound"], created_at: iso(T0 + 5_000) } });
    expect(closedOutcome(p, other, T0 + 6_000)).toBe("No longer open.");
    expect(closedOutcome(p, status(), T0 + PROPOSAL_TTL_MS)).toBe("Expired. Nothing changed.");
    const offline = status({
      online: false,
      parts: [],
      zones: [],
    });
    expect(closedOutcome(p, offline, T0 + 1_000)).toBe("Expired. Nothing changed.");
    const newer = status({ open_proposal: proposal({ proposal_id: id(301) }) });
    expect(closedOutcome(p, newer, T0 + 1_000)).toBe("Replaced by a newer offer.");
    expect(closedOutcome(p, status(), T0 + 1_000)).toBe("No longer open.");
  });
});

describe("announcements", () => {
  it("reads nothing on load, then each new reply, walker line, proposal and change once", () => {
    const first = status({ turns: [turn(1, T0)], walker_said: [{ event_id: id(401), kind: "notice", text: "Sophi is on.", at: iso(T0) }] });
    const loaded = announcements(undefined, first);
    expect(loaded.lines).toEqual([]);

    const next = status({
      turns: [turn(1, T0), turn(2, T0 + 2_000, { reply: "I can switch your alerts. Press Confirm to do it." })],
      walker_said: [first.walker_said[0]!, { event_id: id(402), kind: "notice", text: "A part stopped responding.", at: iso(T0 + 1_000) }],
      open_proposal: proposal(),
    });
    const second = announcements(loaded.heard, next);
    expect(second.lines).toEqual([
      "On the walker: A part stopped responding.",
      "Sophi: I can switch your alerts. Press Confirm to do it.",
      "Sophi offers: Switch your alerts from vibration to short sounds. Confirm or decline within a minute.",
    ]);
    expect(announcements(second.heard, next).lines).toEqual([]);

    const offline = status({ online: false, parts: [], zones: [], turns: next.turns, walker_said: next.walker_said });
    const third = announcements(second.heard, offline);
    expect(third.lines).toEqual(["Your walker went offline."]);
    expect(announcements(third.heard, next).lines).toEqual(["Your walker is back online."]);

    const v2 = { version: 2, ...WALKER_SETUP, cues: ["sound", "spoken"] as const, created_at: iso(T0 + 5_000) };
    const waiting = status({ configuration: { ...v2, cues: [...v2.cues] }, applied_configuration_version: 1, turns: next.turns, walker_said: next.walker_said });
    const w = announcements(second.heard, waiting);
    expect(w.lines).toEqual([]);
    const applied = status({ configuration: { ...v2, cues: [...v2.cues] }, applied_configuration_version: 2, turns: next.turns, walker_said: next.walker_said });
    expect(announcements(w.heard, applied).lines).toEqual(["Your walker applied the new alerts."]);
  });

  it("reads an offer's closing before the news it caused, when both come in one poll", () => {
    // The walker's Confirm: the offer closes and the walker applies v2 before the page's next poll.
    const open = status({ open_proposal: proposal() });
    const loaded = announcements(undefined, status());
    const offered = announcements(loaded.heard, open);
    const v2 = { version: 2, ...WALKER_SETUP, cues: ["sound", "spoken"] as const, created_at: iso(T0 + 5_000) };
    const done = status({ configuration: { ...v2, cues: [...v2.cues] }, applied_configuration_version: 2 });
    const news = announcements(offered.heard, done).lines;
    const closing = closedOutcome(proposal(), done, T0 + 6_000);
    expect(news).toEqual(["Your walker applied the new alerts."]);
    expect(readingOrder([], closing, news).join(" ")).toBe(
      "Confirmed. Switching your alerts to short sounds and spoken messages. Your walker applied the new alerts.",
    );
    // A connection line still comes first; no closing (or focus on the card) leaves the rest as it was.
    expect(readingOrder([CONNECTION_BACK], closing, news)).toEqual([CONNECTION_BACK, closing, ...news]);
    expect(readingOrder([CONNECTION_BACK], null, news)).toEqual([CONNECTION_BACK, ...news]);
  });

  it("says a walker is online the first time, and back online after that", () => {
    const never = status({ online: false, last_seen_at: null, parts: [], zones: [] });
    const loaded = announcements(undefined, never);
    const first = announcements(loaded.heard, status());
    expect(first.lines).toEqual(["Your walker is online."]);
    const gone = announcements(first.heard, status({ online: false, parts: [], zones: [] }));
    expect(announcements(gone.heard, status()).lines).toEqual(["Your walker is back online."]);
  });

  it("reads a summary without a full stop as its own sentence", () => {
    const loaded = announcements(undefined, status());
    const next = status({ open_proposal: proposal({ summary: "Switch your alerts to short sounds" }) });
    expect(announcements(loaded.heard, next).lines).toEqual(["Sophi offers: Switch your alerts to short sounds. Confirm or decline within a minute."]);
  });
});

describe("errors in plain words", () => {
  it("has a sentence for every code, with no codes or numbers from HTTP", () => {
    const codes = [
      "invalid_request",
      "unauthenticated",
      "not_found",
      "pairing_code_invalid",
      "pairing_locked",
      "walker_limit",
      "proposal_closed",
      "rate_limited",
      "unavailable",
      "network",
      "not_offered",
    ] as const;
    for (const code of codes) expect(errorMessage(code)).toMatch(/^[A-Z][^_]*\.$/);
    expect(errorMessage("walker_limit")).toBe("You already have 8 walkers. Forget one before connecting another.");
    expect(errorMessage("pairing_locked")).toBe("Too many wrong codes were tried from this network. Wait 10 minutes, then get a new code.");
  });

  it("keeps the typed-words notice exactly as written, naming who reads typed words", () => {
    expect(typedNotice("claude")).toBe(
      "Your words go to Anthropic's Claude. What's said to the walker goes to Cartesia to be written down, then to Claude. The text of Sophi's spoken replies goes to Cartesia. Both may keep a copy. Please don't type names or health details. Each message is deleted an hour after it's sent, or right away with Forget this walker.",
    );
    expect(typedNotice(null)).toBe(
      "No model reads what you type here: Sophi answers with fixed replies. What's said to the walker and the text of Sophi's spoken replies go to Cartesia. Please don't type names or health details. Each message is deleted an hour after it's sent, or right away with Forget this walker.",
    );
  });
});

describe("real API client", () => {
  const json = (status: number, body: unknown, date = "Sat, 24 Oct 2026 18:00:00 GMT") =>
    new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json", date } });

  it("sends the contract's requests and validates the answers", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const answers = [json(200, { walkers: [status()] }), json(204, null)];
    const api = createWalkerApi(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return answers.shift()!;
    });
    expect(((await api.listWalkers()).walkers).map((w) => w.name)).toEqual(["Sophi walker"]);
    await api.forgetWalker(id(1));
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["GET", "/api/v1/walkers"],
      ["DELETE", `/api/v1/walkers/${id(1)}`],
    ]);
    expect(calls[0]!.init.credentials).toBe("same-origin");
  });

  it("passes the activity view through, and reads a server without one as no activity", async () => {
    const activity = { device_id: id(1), in_flight: [], traces: [] };
    const answers = [json(200, { walkers: [status()], activity: [activity] }), json(200, { walkers: [status()] })];
    const api = createWalkerApi(async () => answers.shift()!);
    expect((await api.listWalkers()).activity).toEqual([activity]);
    expect((await api.listWalkers()).activity).toEqual([]);
  });

  it("passes the speaking paces through (none from an older server, so no card), and sets one by PUT", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const paces = [{ device_id: id(1), speech_pace: "slower" }];
    const answers = [json(200, { walkers: [status()], speech_paces: paces }), json(200, { walkers: [status()] }), json(200, { speech_pace: "faster" })];
    const api = createWalkerApi(async (url, init) => {
      calls.push({ url: String(url), init: init! });
      return answers.shift()!;
    });
    const listed = await api.listWalkers();
    expect(listed.speech_paces).toEqual(paces);
    expect(paceOf(listed.speech_paces, id(1))).toBe("slower");
    expect(paceOf((await api.listWalkers()).speech_paces, id(1))).toBeNull();
    expect(await api.setSpeechPace(id(1), "faster")).toEqual({ speech_pace: "faster" });
    expect([calls[2]!.init.method, calls[2]!.url, calls[2]!.init.body]).toEqual(["PUT", `/api/v1/walkers/${id(1)}/speech-pace`, JSON.stringify({ speech_pace: "faster" })]);
    expect(Object.values(PACE_WORD)).toEqual(["Slower", "Normal", "Faster"]);
  });

  it("turns errors into codes, keeps a closed proposal, and reads anything else as unavailable", async () => {
    const closed = proposal({ state: "expired" });
    const answers = [
      json(409, { error: { code: "proposal_closed", message: "closed", trace_id: "t1", proposal: closed } }),
      new Response("<html>404</html>", { status: 404 }),
      json(200, { walkers: [{ name: "half a walker" }] }),
    ];
    const api = createWalkerApi(async () => answers.shift()!);
    const first = await api.answerProposal(id(1), closed.proposal_id, "confirm").catch((e: unknown) => e);
    expect(first).toBeInstanceOf(WalkerApiError);
    expect([(first as WalkerApiError).code, (first as WalkerApiError).status, (first as WalkerApiError).proposal?.state]).toEqual([
      "proposal_closed",
      409,
      "expired",
    ]);
    // A plain 404 (a route this server doesn't have yet) is "not offered", never a walker that went away.
    await expect(api.listWalkers()).rejects.toMatchObject({ code: "not_offered", status: 404 });
    await expect(api.listWalkers()).rejects.toMatchObject({ code: "unavailable", status: 200 });
    const offline = createWalkerApi(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(offline.listWalkers()).rejects.toMatchObject({ code: "network", status: 0 });
  });

  it("follows the server's clock only when it differs by more than the Date header's wobble", () => {
    const at = Date.parse("Sat, 24 Oct 2026 18:00:00 GMT");
    expect(nextClockOffset(0, "Sat, 24 Oct 2026 18:00:00 GMT", at + 300)).toBe(0);
    expect(nextClockOffset(0, "Sat, 24 Oct 2026 18:00:00 GMT", at - 30_000)).toBe(30_500);
    expect(nextClockOffset(30_500, "Sat, 24 Oct 2026 18:00:00 GMT", at - 30_200)).toBe(30_500);
    expect(nextClockOffset(1_000, null, at)).toBe(1_000);
    expect(nextClockOffset(1_000, "not a date", at)).toBe(1_000);
  });
});

describe("development fake", () => {
  function setup() {
    let t = T0;
    const fake = createFakeWalker(() => t, false);
    return { ...fake, tick: (ms: number) => (t += ms), at: () => t };
  }

  it("pairs, answers, opens a proposal, and confirms it once", async () => {
    const { api, controls, tick } = setup();
    await expect(api.listWalkers()).rejects.toMatchObject({ code: "unauthenticated" });
    await api.createPairingCode();
    expect((await api.listWalkers()).walkers).toEqual([]);
    expect(controls.pairFromWalker()).toBe(true);
    const [w] = (await api.listWalkers()).walkers;
    expect([w!.online, w!.simulator, w!.walker_said.map((e) => e.text)]).toEqual([true, true, ["Sophi is on."]]);

    const asked = await api.sendTurn(w!.device_id, id(900), "Stop buzzing me, use short sounds instead.");
    expect(asked.status.open_proposal?.state).toBe("open");
    const again = await api.sendTurn(w!.device_id, id(900), "Stop buzzing me, use short sounds instead.");
    expect(again.turn.turn_id).toBe(asked.turn.turn_id);

    const done = await api.answerProposal(w!.device_id, asked.proposal!.proposal_id, "confirm");
    expect([done.proposal.state, done.status.configuration.version, appliedState(done.status)]).toEqual(["confirmed", 2, "waiting"]);
    await expect(api.answerProposal(w!.device_id, asked.proposal!.proposal_id, "decline")).rejects.toMatchObject({
      code: "proposal_closed",
      proposal: { state: "confirmed" },
    });
    tick(3_000);
    expect(appliedState(((await api.listWalkers()).walkers)[0]!)).toBe("applied");
  });

  it("expires proposals on time and when the walker goes offline, and delivers offline lines on reconnect", async () => {
    const { api, controls, tick } = setup();
    await api.createPairingCode();
    controls.pairFromWalker();
    const [w] = (await api.listWalkers()).walkers;
    const first = await api.sendTurn(w!.device_id, id(901), "No more buzzing please");
    tick(PROPOSAL_TTL_MS);
    expect(((await api.listWalkers()).walkers)[0]!.open_proposal).toBeNull();
    await expect(api.answerProposal(w!.device_id, first.proposal!.proposal_id, "confirm")).rejects.toMatchObject({ proposal: { state: "expired" } });

    await api.sendTurn(w!.device_id, id(902), "No more buzzing please");
    controls.setOnline(false);
    const offline = ((await api.listWalkers()).walkers)[0]!;
    expect([offline.online, offline.open_proposal, offline.parts.every((p) => p.health === "unavailable")]).toEqual([false, null, true]);
    expect(offline.zones.every((z) => z.reading.status === "unknown")).toBe(true);
    controls.walkerSays("I'm offline right now. Your alerts still work.", "local_reply");
    expect(((await api.listWalkers()).walkers)[0]!.walker_said.map((e) => e.text)).not.toContain("I'm offline right now. Your alerts still work.");
    tick(5_000);
    controls.setOnline(true);
    const back = ((await api.listWalkers()).walkers)[0]!;
    expect(back.walker_said.map((e) => e.kind)).toEqual(["notice", "local_reply", "notice"]);
  });

  it("reports each turn in flight, then its trace, like the server", async () => {
    const { api, controls } = setup();
    await api.createPairingCode();
    controls.pairFromWalker();
    const [w] = (await api.listWalkers()).walkers;
    expect(controls.walkerTalks("Can you pick up my keys?")).toBe(true);
    // Without delays the fake's pauses end on the next tick: let the Talk press finish first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const typed = await api.sendTurn(w!.device_id, id(907), "Stop buzzing me, use short sounds instead.");
    const { activity } = await api.listWalkers();
    const traces = activity[0]!.traces;
    expect(traces.map((t) => [t.input, t.rule, t.answered_by, t.proposal_opened, t.voiced_by, t.model_ran])).toEqual([
      ["audio", "arms", "fixed", false, "cartesia", true],
      ["text", null, "model", true, null, true],
    ]);
    expect(traces[0]!.clip_ms).toBeGreaterThan(0);
    expect(traces[1]!.turn_id).toBe(typed.turn.turn_id);
    // The offer names the turn that made it, as the server's does.
    expect(typed.proposal?.client_turn_id).toBe(id(907));
    expect(activity[0]!.in_flight).toEqual([]);
    controls.setOnline(false);
    expect(controls.walkerTalks("What can you help me with?")).toBe(false);
  });

  it("holds a Talk press in flight, transcribing, hearing then voicing, until it's saved", async () => {
    vi.useFakeTimers({ now: T0 });
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    try {
      const { api, controls } = createFakeWalker(Date.now, true);
      const list = async () => {
        const p = api.listWalkers();
        await vi.advanceTimersByTimeAsync(120);
        return p;
      };
      const code = api.createPairingCode();
      await vi.advanceTimersByTimeAsync(300);
      await code;
      controls.pairFromWalker();
      controls.walkerTalks("What can you help me with?");
      const transcribing = (await list()).activity[0]!.in_flight;
      expect(transcribing.map((f) => [f.input, f.stage, f.clip_ms !== null, f.model])).toEqual([["audio", "transcribing", true, "claude"]]);
      await vi.advanceTimersByTimeAsync(500);
      expect((await list()).activity[0]!.in_flight.map((f) => f.stage)).toEqual(["hearing"]);
      await vi.advanceTimersByTimeAsync(1_100);
      expect((await list()).activity[0]!.in_flight.map((f) => f.stage)).toEqual(["voicing"]);
      await vi.advanceTimersByTimeAsync(1_000);
      const done = await list();
      expect(done.activity[0]!.in_flight).toEqual([]);
      expect(done.activity[0]!.traces.map((t) => [t.transcribe_ms, t.model_ms, t.voice_ms])).toEqual([[500, 1_100, 650]]);
      expect(done.walkers[0]!.turns.map((t) => [t.source, t.heard_by, t.voiced_by])).toEqual([["walker", "cartesia", "cartesia"]]);
    } finally {
      vi.restoreAllMocks();
      vi.useRealTimers();
    }
  });

  it("answers a replaced proposal with 409 and the proposal as it stands, like the server", async () => {
    const { api, controls } = setup();
    await api.createPairingCode();
    controls.pairFromWalker();
    const [w] = (await api.listWalkers()).walkers;
    const first = await api.sendTurn(w!.device_id, id(905), "no more buzzing");
    await api.sendTurn(w!.device_id, id(906), "no more buzzing, really");
    await expect(api.answerProposal(w!.device_id, first.proposal!.proposal_id, "confirm")).rejects.toMatchObject({
      code: "proposal_closed",
      proposal: { state: "superseded" },
    });
  });

  it("fails the next action on demand, forgets, and loses the cookie", async () => {
    const { api, controls } = setup();
    controls.failNext("pairing_locked");
    await expect(api.createPairingCode()).rejects.toMatchObject({ code: "pairing_locked", status: 429 });
    await api.createPairingCode();
    controls.pairFromWalker();
    const [w] = (await api.listWalkers()).walkers;
    controls.failNext("network");
    expect((await api.listWalkers()).walkers).toHaveLength(1);
    await expect(api.sendTurn(w!.device_id, id(904), "hello")).rejects.toMatchObject({ code: "network" });
    controls.setServerDown(true);
    await expect(api.listWalkers()).rejects.toMatchObject({ code: "network" });
    controls.setServerDown(false);
    await api.forgetWalker(w!.device_id);
    expect((await api.listWalkers()).walkers).toEqual([]);
    await expect(api.sendTurn(w!.device_id, id(903), "hello")).rejects.toMatchObject({ code: "not_found" });
    controls.clearCookie();
    await expect(api.listWalkers()).rejects.toMatchObject({ code: "unauthenticated" });
  });
});
