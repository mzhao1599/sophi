import { ScreenStateSchema, type ProposalView, type ScreenContent, type ScreenState } from "@walker/contracts";
import { captionPages } from "@walker/walker-screen/view";
import { describe, expect, it } from "vitest";
import { CAPTION_PAGE_MIN_MS, SCREEN_ANSWER_HOLD_MS, SCREEN_DONE_MS, SCREEN_MESSAGE_HOLD_MS, SCREEN_OBSTACLE_TAIL_MS } from "../src/constants";
import { attachScreen, seedScreen, startingSettings } from "../src/screen/attach";
import { ScreenMachine, pageAt, pageMs, pickScreen, type ScreenModel } from "../src/screen/machine";
import { FakeClock, boot, captureLogger, flush, makeHarness, type Harness } from "./support/fakes";

/** Rows D1 to D9 of test/EXPECTED.md ("The walker screen"). Every time comes from a fake clock. */

const settings = startingSettings(undefined, Date.parse("2026-10-24T02:00:00Z"));
const base: ScreenModel = { link: "online", talk: "idle", alerts: ["vibration"], offer: null, answer: null, done: null, obstacle: null, motion: null, motionEnded: null, message: null, showing: null };
const offer = { proposal_id: "11111111-1111-4111-8111-111111111111", from_cues: ["vibration" as const], cues: ["sound" as const] };
const name = (model: Partial<ScreenModel>, now = 0) => pickScreen({ ...base, ...model }, now, settings).content.state;

function machine(clock: FakeClock, localTime: () => string | null = () => null) {
  const states: ScreenState[] = [];
  const errors: Error[] = [];
  const m = new ScreenMachine({ clock, simulator: true, settings, localTime, onState: (s) => states.push(s), onError: (e) => errors.push(e) });
  return { m, states, errors, names: () => states.map((s) => s.screen.state) };
}

describe("D1: the screen's priority", () => {
  it("obstacle, then listening, thinking, answering, Sophi's offer, Done, offline or not set up, then the clock", () => {
    const obstacle = { zone: "front_left", mm: 300, simulated: true, lastNearMono: 0, near: true };
    const answer = { id: 1, heard: null, reply: "Fake cloud: hello.", source: "fixed" as const, startedMono: 0, spokenMono: null };
    const done = { result: { kind: "nothing_changed" as const }, untilMono: 5000 };
    expect(name({ obstacle, talk: "recording", answer, offer, done, link: "offline" })).toBe("obstacle");
    expect(name({ talk: "recording", answer, offer, done, link: "offline" })).toBe("listening");
    expect(name({ answer, offer, done, link: "offline" })).toBe("answering");
    expect(name({ offer, done, link: "offline" })).toBe("model_offer");
    expect(name({ done, link: "offline" })).toBe("done");
    expect(name({ link: "offline" })).toBe("offline");
    expect(name({ link: "unpaired" })).toBe("not_set_up");
    expect(name({ link: "unauthorized" })).toBe("not_set_up");
    expect(name({ link: "connecting" })).toBe("ambient");
    expect(name({})).toBe("ambient");
    // While a turn is in flight (Talk released, no answer yet): One moment, above the offer and Done.
    expect(name({ talk: "waiting", offer, done, link: "offline" })).toBe("thinking");
    expect(name({ obstacle, talk: "waiting" })).toBe("obstacle");
    expect(name({ done }, 5000)).toBe("ambient");
  });

  it("the offer screen carries today's proposal; ambient the alerts in force; every state passes the contract", () => {
    const content = pickScreen({ ...base, offer }, 0, settings).content;
    expect(content).toEqual({ state: "model_offer", ...offer });
    expect(pickScreen(base, 0, settings).content).toEqual({ state: "ambient", alerts: ["vibration"] });
  });
});

describe("D2: an interruption returns to where she was, with a new revision", () => {
  it("offer, obstacle, offer again", async () => {
    const clock = new FakeClock();
    const { m, states, names } = machine(clock);
    m.seed({ link: "online", alerts: ["vibration"] });
    await flush();
    m.offer(offer);
    await flush();
    m.zones([{ zone: "front_left", mm: 300, quality: "valid", simulated: true }]);
    await flush();
    m.zones([{ zone: "front_left", mm: 1500, quality: "valid", simulated: true }]);
    await clock.advance(SCREEN_OBSTACLE_TAIL_MS);
    expect(names()).toEqual(["ambient", "model_offer", "obstacle", "model_offer"]);
    expect(states.map((s) => s.revision)).toEqual([0, 1, 2, 3]);
    expect(states[2]!.screen).toEqual({ state: "obstacle", zone: "front_left", distance: { status: "measured", mm: 300 }, simulated: true });
  });

  it("Talk during captions drops that answer: after listening, the screen goes back underneath", async () => {
    const clock = new FakeClock();
    const { m, names } = machine(clock);
    m.seed({ link: "online" });
    await flush();
    m.answer({ id: 1, heard: null, reply: "Fake cloud: one.", source: "fixed" });
    await flush();
    m.talk("recording");
    await flush();
    m.talk("idle");
    await flush();
    expect(names()).toEqual(["ambient", "answering", "listening", "ambient"]);
  });
});

describe("D3: captions page as the reply is spoken, then go", () => {
  const reply =
    "Fake cloud: this is where Sophi's spoken answer goes. The real assistant isn't connected in this run. It says so on every line.";

  it("pages turn on the speaking-rate clock; the answer ends a hold after it was spoken and every page had its time", async () => {
    const pages = captionPages(reply, "large");
    expect(pages.length).toBeGreaterThan(1);
    expect(pageAt(pages, 0)).toEqual({ page: 0, nextInMs: pageMs(pages[0]!) });
    expect(pageMs("Hi.")).toBe(CAPTION_PAGE_MIN_MS);

    const clock = new FakeClock();
    const { m, states } = machine(clock);
    m.seed({ link: "online" });
    m.answer({ id: 7, heard: "what can you do", reply, source: "model" });
    await clock.advance(1000);
    m.answerSpoken(7); // spoken quickly: the pages still get their time
    const total = pages.reduce((sum, p) => sum + pageMs(p), 0);
    await clock.advance(total - 1000 + SCREEN_ANSWER_HOLD_MS - 1);
    const answering = states.filter((s) => s.screen.state === "answering").map((s) => (s.screen as Extract<ScreenContent, { state: "answering" }>).page);
    expect(answering).toEqual(pages.map((_, i) => i));
    expect(states.at(-1)!.screen.state).toBe("answering");
    await clock.advance(1);
    expect(states.at(-1)!.screen).toEqual({ state: "ambient", alerts: null });
    expect(states.find((s) => s.screen.state === "answering")!.screen).toMatchObject({ heard: "what can you do", source: "model" });
  });

  it("with an offer waiting, the captions give way to it as soon as the reply has been spoken (no hold)", async () => {
    const clock = new FakeClock();
    const { m, names } = machine(clock);
    m.seed({ link: "online" });
    await flush();
    const reply = "Fake cloud: short sounds? Press Confirm to do it.";
    m.offer(offer);
    m.answer({ id: 1, heard: null, reply, source: "fixed" });
    await flush();
    await clock.advance(1000);
    m.answerSpoken(1);
    await clock.advance(pageMs(reply) - 1000 - 1);
    expect(names()).toEqual(["ambient", "answering"]);
    await clock.advance(1);
    expect(names()).toEqual(["ambient", "answering", "model_offer"]);
  });

  it("Confirm settling the offer shows Done at once, even with captions up, then the clock after SCREEN_DONE_MS", async () => {
    const clock = new FakeClock();
    const { m, states, names } = machine(clock);
    m.seed({ link: "online", alerts: ["vibration"] });
    await flush();
    m.offer(offer);
    m.answer({ id: 1, heard: null, reply: "Fake cloud: short sounds?", source: "fixed" });
    await flush();
    m.offer(null);
    m.settled({ kind: "alerts", cues: ["sound"] });
    m.alerts(["sound"]);
    await clock.advance(SCREEN_DONE_MS);
    expect(names()).toEqual(["ambient", "answering", "done", "ambient"]);
    expect(states[2]!.screen).toEqual({ state: "done", result: { kind: "alerts", cues: ["sound"] }, change_back: false });
    expect(states[3]!.screen).toEqual({ state: "ambient", alerts: ["sound"] });
  });
});

describe("D4: zones for the screen", () => {
  const near = (mm: number) => [{ zone: "front_left", mm, quality: "valid" as const, simulated: true }];

  it("entering is drawn at once; a moving distance at most every 250 ms; leaving after the tail", async () => {
    const clock = new FakeClock();
    const { m, states } = machine(clock);
    m.seed({ link: "online" });
    await flush();
    for (let i = 0; i < 10; i += 1) {
      m.zones(near(300 + i * 10)); // a reading every 50 ms, each 1 cm closer
      await clock.advance(50);
    }
    const obstacles = states.filter((s) => s.screen.state === "obstacle");
    expect(obstacles.length).toBeLessThanOrEqual(3); // at 0, ~250 and ~500 ms, not 10
    expect(obstacles[0]!.screen).toMatchObject({ distance: { mm: 300 } });
    m.zones(near(1500)); // at 500 ms; the last near reading was at 450 ms
    await clock.advance(SCREEN_OBSTACLE_TAIL_MS - 51);
    expect(states.at(-1)!.screen.state).toBe("obstacle");
    await clock.advance(1);
    expect(states.at(-1)!.screen.state).toBe("ambient");
  });

  it("a near zone whose sensor goes quiet reads Unknown for the tail, then the screen returns", async () => {
    const clock = new FakeClock();
    const { m, states } = machine(clock);
    m.seed({ link: "online" });
    m.zones(near(300));
    await clock.advance(600); // no reading for longer than ZONE_VALIDITY_MS
    expect(states.at(-1)!.screen).toMatchObject({ state: "obstacle", distance: { status: "unknown" } });
    await clock.advance(SCREEN_OBSTACLE_TAIL_MS);
    expect(states.at(-1)!.screen.state).toBe("ambient");
  });

  it("uses the cue policy's hysteresis: near under 500 mm, clear only over 650 mm", async () => {
    const clock = new FakeClock();
    const { m, states } = machine(clock);
    m.seed({ link: "online" });
    m.zones(near(520));
    await flush();
    expect(states.at(-1)!.screen.state).toBe("ambient");
    m.zones(near(480));
    await flush();
    for (let t = 0; t < 2000; t += 100) {
      m.zones(near(640)); // between the two thresholds: stays near
      await clock.advance(100);
    }
    expect(states.at(-1)!.screen.state).toBe("obstacle");
    m.zones(near(660));
    await clock.advance(SCREEN_OBSTACLE_TAIL_MS);
    expect(states.at(-1)!.screen.state).toBe("ambient");
  });
});

describe("D5: the clock", () => {
  it("looks again every 30 s while no time is shown, so a clock that syncs later appears without any other change", async () => {
    const clock = new FakeClock();
    let synced = false;
    const { m, states } = machine(clock, () => (synced ? new Date(clock.now()).toISOString().slice(0, 19) : null));
    m.seed({ link: "online" });
    await flush();
    synced = true;
    await clock.advance(29_999);
    expect(states.at(-1)!.strip.clock).toBeNull();
    await clock.advance(1);
    expect(states.at(-1)!.strip.clock).toEqual({ local_time: "2026-10-23T12:00:30" });
  });

  it("shows no time until the clock has synced, and redraws on the minute, not each second", async () => {
    const clock = new FakeClock(); // wall time starts at 12:00:00.000Z
    let synced = false;
    const { m, states } = machine(clock, () => (synced ? new Date(clock.now()).toISOString().slice(0, 19) : null));
    m.seed({ link: "online" });
    await flush();
    expect(states.at(-1)!.strip.clock).toBeNull();
    synced = true;
    m.link("online");
    m.alerts(["sound"]);
    await clock.advance(59_000);
    expect(states.at(-1)!.strip.clock).toEqual({ local_time: "2026-10-23T12:00:00" });
    const before = states.length;
    await clock.advance(1000);
    expect(states.length).toBe(before + 1);
    expect(states.at(-1)!.strip.clock).toEqual({ local_time: "2026-10-23T12:01:00" });
  });
});

/** The screen on a whole walker service (fake cloud, simulated hand and ToF), as `walker simulate --screen` runs it. */
function screenHarness(): Harness & { states: ScreenState[]; names: () => string[] } {
  const h = makeHarness({ withHand: true, withTof: true });
  const states: ScreenState[] = [];
  const attached = attachScreen({
    bus: h.bus,
    clock: h.clock,
    log: h.log,
    service: h.service,
    modules: h.modules,
    simulator: true,
    settings,
    localTime: () => null,
    onState: (s) => states.push(s),
  });
  const start = h.service.start.bind(h.service);
  h.service.start = () => {
    start();
    seedScreen(attached.machine, h.service);
  };
  const names = () => states.map((s) => s.screen.state).filter((n, i, all) => n !== all[i - 1]);
  return Object.assign(h, { states, names });
}

async function talk(h: Harness): Promise<void> {
  h.press("talk", "pressed");
  await h.clock.advance(1500);
  h.press("talk", "released");
  await h.clock.advance(0);
}

describe("D6: the demo beats, screen state by screen state", () => {
  it("ask, alerts offer and Confirm, obstacle, offline and back", async () => {
    const h = screenHarness();
    h.fake.script = [
      { reply: "Fake cloud: this is where Sophi's spoken answer goes." },
      { reply: "Fake cloud: I can switch your alerts from buzzing to short sounds. Press Confirm to do it.", proposeCues: ["sound"] },
    ];
    await boot(h);
    // Ask.
    await talk(h);
    await h.clock.advance(20_000);
    // Alerts offer, then Confirm.
    await talk(h);
    await h.clock.advance(10_000);
    expect(h.states.at(-1)!.screen.state).toBe("model_offer");
    h.press("confirm");
    await h.clock.advance(SCREEN_DONE_MS);
    // Obstacle: a hand in front of the simulated ToF, then away.
    h.tof!.readings = { front_left: { mm: 300 }, front_right: { mm: 1500 } };
    await h.clock.advance(500);
    h.tof!.readings = { front_left: { mm: 1500 }, front_right: { mm: 1500 } };
    await h.clock.advance(2000);
    // Offline, a Talk press there, and back.
    h.client.network = "down";
    await h.clock.advance(10_000);
    await talk(h);
    await h.clock.advance(20_000);
    h.client.network = "up";
    await h.clock.advance(20_000);

    expect(h.names()).toEqual([
      "ambient",
      "listening",
      "thinking", // the turn in flight: "One moment"
      "answering",
      "ambient",
      "listening",
      "thinking",
      "answering",
      "model_offer",
      "done",
      "ambient",
      "obstacle",
      "ambient",
      "offline",
      "answering", // the walker's own offline line, captioned
      "offline",
      "ambient",
    ]);
    const answers = h.states.filter((s) => s.screen.state === "answering").map((s) => s.screen as Extract<ScreenContent, { state: "answering" }>);
    expect(answers[0]).toMatchObject({ source: "fixed", heard: null, page: 0 });
    expect(answers.at(-1)).toMatchObject({ source: "walker", reply: expect.stringContaining("I'm offline right now.") });
    expect(h.states.find((s) => s.screen.state === "done")!.screen).toEqual({ state: "done", result: { kind: "alerts", cues: ["sound"] }, change_back: false });
    expect(h.states.find((s) => s.screen.state === "obstacle")!.screen).toMatchObject({ zone: "front_left", distance: { mm: 300 }, simulated: true });
    expect(h.states.at(-1)!.screen).toEqual({ state: "ambient", alerts: ["sound"] });
    // D8: every state the walker sent passes the contract, revisions count up by one, and Simulator is on.
    for (const [i, s] of h.states.entries()) {
      expect(ScreenStateSchema.safeParse(s).success).toBe(true);
      expect(s.revision).toBe(i);
      expect(s.strip.simulator).toBe(true);
    }
    // The logging rule: no reply or heard words in the logs from the screen.
    expect(h.log.lines.filter((l) => /screen/i.test(l)).join("\n")).not.toMatch(/Fake cloud|offline right now/);
  });

  it("Confirm on a closed offer shows Nothing changed", async () => {
    const h = screenHarness();
    h.fake.script = [{ reply: "Fake cloud: short sounds? Press Confirm to do it.", proposeCues: ["sound"] }];
    await boot(h);
    await talk(h);
    await h.clock.advance(10_000);
    const device = h.device()!;
    device.proposals = device.proposals.map((p) => ({ ...p, state: "expired" as const }));
    h.press("confirm");
    await flush();
    expect(h.states.at(-1)!.screen).toEqual({ state: "done", result: { kind: "nothing_changed" }, change_back: false });
  });
});

describe("D7: the screen can never throw into the walker", () => {
  it("a screen listener that throws is logged once, and Talk, the turn and Confirm carry on", async () => {
    const h = makeHarness();
    attachScreen({
      bus: h.bus,
      clock: h.clock,
      log: h.log,
      service: h.service,
      modules: h.modules,
      simulator: true,
      settings,
      localTime: () => {
        throw new Error("broken clock");
      },
      onState: () => {
        throw new Error("broken server");
      },
    });
    // Break the machine's inputs too: every bus listener of the screen throws, in line with the service's
    // own calls (setTalk, setLink, the answer, the offer, Confirm's settlement).
    const broken = attachScreen({ bus: h.bus, clock: h.clock, log: h.log, service: h.service, modules: h.modules, simulator: true, settings, localTime: () => null, onState: () => {} });
    for (const input of ["link", "talk", "alerts", "answer", "answerSpoken", "offer", "settled", "zones"] as const) {
      broken.machine[input] = () => {
        throw new Error("broken input");
      };
    }
    h.fake.script = [{ reply: "Fake cloud: switch?", proposeCues: ["sound"] }];
    await boot(h);
    await talk(h);
    expect(h.spoken("reply")).toEqual(["Fake cloud: switch?"]);
    h.press("confirm");
    await flush();
    expect(h.service.configuration?.version).toBe(2);
    expect(h.spoken("confirm_result")).toEqual(["Done. Obstacle alerts now use short sounds."]);
    const warnings = h.log.lines.filter((l) => l.includes("walker screen error"));
    for (const where of ["talk", "answer", "offer", "settled", "link"]) expect(warnings.join("\n")).toContain(`where="${where}"`);
    expect(warnings.length).toBeGreaterThan(0);
    expect(new Set(warnings).size).toBe(warnings.length); // each kind once
  });
});

describe("D16: Done only once the change is in force", () => {
  it("a confirmed change whose configuration can't be fetched never shows Done: the offer stays up while Confirm is answered, then the real state", async () => {
    const h = screenHarness();
    h.fake.script = [{ reply: "Fake cloud: short sounds? Press Confirm to do it.", proposeCues: ["sound"] }];
    await boot(h);
    await talk(h);
    await h.clock.advance(10_000);
    expect(h.states.at(-1)!.screen.state).toBe("model_offer");
    const client = h.client;
    let release: () => void = () => {};
    client.configuration = () => new Promise((_, reject) => (release = () => reject(new Error("fake fetch failed"))));
    h.press("confirm");
    await flush();
    // Confirmed on the server, the configuration still being fetched: the offer stays, nothing says Done.
    expect(h.states.at(-1)!.screen.state).toBe("model_offer");
    release();
    await h.clock.advance(0);
    expect(h.spoken("confirm_result")).toEqual(["Confirmed. The change will apply in a moment."]);
    expect(h.names().slice(-2)).toEqual(["model_offer", "ambient"]);
    expect(h.states.some((s) => s.screen.state === "done")).toBe(false);
    expect(h.states.at(-1)!.screen).toEqual({ state: "ambient", alerts: ["vibration", "spoken"] });
  });

  it("a confirmed change that is applied shows Done with the new configuration's own cues, straight from the offer", async () => {
    const h = screenHarness();
    h.fake.script = [{ reply: "Fake cloud: short sounds? Press Confirm to do it.", proposeCues: ["sound"] }];
    await boot(h);
    await talk(h);
    await h.clock.advance(10_000);
    h.press("confirm");
    await flush();
    expect(h.names().slice(-2)).toEqual(["model_offer", "done"]);
    expect(h.states.at(-1)!.screen).toEqual({ state: "done", result: { kind: "alerts", cues: ["sound"] }, change_back: false });
  });
});

describe("D17: captions follow the voice", () => {
  it("a reply queued behind another line is captioned only when it starts playing", async () => {
    const h = screenHarness();
    h.fake.script = [{ reply: "Fake cloud: hello." }];
    await boot(h);
    h.speaker.hold = true;
    h.press("talk", "pressed");
    await h.clock.advance(1500);
    h.press("talk", "released");
    // A notice starts playing while the turn is in flight, so the reply waits behind it.
    h.bus.emit("moduleDown", { module: { instanceId: "tof-front-01", type: "perception" } as never, reason: "disconnected" });
    await h.clock.advance(0);
    expect(h.spoken("reply")).toEqual(["Fake cloud: hello."]); // queued (the spoke event), not playing yet
    expect(h.states.some((s) => s.screen.state === "answering")).toBe(false);
    h.speaker.finish(); // the notice ends; the reply starts
    await flush();
    expect(h.states.at(-1)!.screen).toMatchObject({ state: "answering", reply: "Fake cloud: hello." });
  });
});

describe("D9: the offer event follows the proposal id, not every heartbeat", () => {
  it("one offer event when it opens, one when Confirm closes it", async () => {
    const h = makeHarness();
    const offers: Array<ProposalView | null> = [];
    h.bus.on("offer", ({ proposal }) => offers.push(proposal));
    h.fake.script = [{ reply: "Fake cloud: switch?", proposeCues: ["sound"] }];
    await boot(h);
    await talk(h);
    await h.clock.advance(20_000); // four heartbeats carrying the same open proposal
    expect(offers.map((p) => p?.cues ?? null)).toEqual([["sound"]]);
    h.press("confirm");
    await flush();
    expect(offers.map((p) => p?.cues ?? null)).toEqual([["sound"], null]);
  });
});

describe("D25/D26: a caretaker's message read aloud", () => {
  const message = { id: 1, message_id: "22222222-2222-4222-8222-222222222222", from_name: "Maya", text: "Dinner at six. I'll get you.", spokenMono: null };

  it("shows under her own Talk, the answer, Sophi's offer and Done, and over offline and the clock", () => {
    const answer = { id: 1, heard: null, reply: "Fake cloud: hello.", source: "fixed" as const, startedMono: 0, spokenMono: null };
    const done = { result: { kind: "nothing_changed" as const }, untilMono: 5000 };
    expect(name({ message, talk: "recording" })).toBe("listening");
    expect(name({ message, answer })).toBe("answering");
    expect(name({ message, offer })).toBe("model_offer");
    expect(name({ message, done })).toBe("done");
    expect(name({ message, link: "offline" })).toBe("message");
    expect(name({ message })).toBe("message");
    expect(pickScreen({ ...base, message }, 0, settings).content).toEqual({
      state: "message",
      message_id: message.message_id,
      from_name: "Maya",
      text: "Dinner at six. I'll get you.",
    });
  });

  it("stays until SCREEN_MESSAGE_HOLD_MS after it has played, then goes", () => {
    const played = { ...message, spokenMono: 1000 };
    expect(name({ message: played }, 1000 + SCREEN_MESSAGE_HOLD_MS - 1)).toBe("message");
    expect(pickScreen({ ...base, message: played }, 1000, settings).nextAt).toBe(1000 + SCREEN_MESSAGE_HOLD_MS);
    expect(name({ message: played }, 1000 + SCREEN_MESSAGE_HOLD_MS)).toBe("ambient");
  });

  it("is dropped by a new Talk press, and heard again starts its time afresh", async () => {
    const clock = new FakeClock();
    const { m, names } = machine(clock);
    m.seed({ link: "online", alerts: ["vibration"] });
    await flush();
    m.message({ id: 1, message_id: message.message_id, from_name: "Maya", text: message.text });
    m.messageSpoken(1);
    await flush();
    await clock.advance(SCREEN_MESSAGE_HOLD_MS - 1000);
    m.message({ id: 2, message_id: message.message_id, from_name: "Maya", text: message.text });
    m.messageSpoken(2);
    await clock.advance(SCREEN_MESSAGE_HOLD_MS - 1000);
    await flush();
    expect(names().at(-1)).toBe("message");
    m.talk("recording");
    await flush();
    m.talk("idle");
    await flush();
    expect(names().slice(-2)).toEqual(["listening", "ambient"]);
  });
});
