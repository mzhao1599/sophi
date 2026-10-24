import { describe, expect, it } from "vitest";
import { CapabilityManifestSchema } from "@walker/contracts";
import { toneWav } from "../src/audio/wav";
import { LINES } from "../src/notices";
import { boot, flush, makeHarness, pairInto, type Harness } from "./support/fakes";

const answers = (h: Harness, answer = "confirm") => h.client.calls.filter((c) => c === `answer:${answer}`);

const OFFLINE_VIBRATION = "I'm offline right now. Your vibration alerts still work.";

/** Holds Talk for `ms` (GPIO: press, wait, release) and lets the reply land. */
async function talk(h: Harness, ms = 2000): Promise<void> {
  h.press("talk", "pressed");
  await h.clock.advance(ms);
  h.press("talk", "released");
  await flush();
}

async function goOffline(h: Harness): Promise<void> {
  h.client.network = "down";
  await h.clock.advance(10_000);
  expect(h.service.link).toBe("offline");
}

describe("boot and pairing", () => {
  it("P1: says 'Steady is on.' first, and records nothing until Talk", async () => {
    const h = makeHarness();
    await boot(h);
    expect(h.spoken()[0]).toBe("Steady is on.");
    expect(h.service.link).toBe("online");
    expect(h.service.configuration?.version).toBe(1);
    expect(h.named("config")).toEqual([]);
    await h.clock.advance(60_000);
    expect(h.capture.starts).toBe(0);
  });

  it("P2/B15: unpaired, Talk gets the not-paired line and nothing records or is sent", async () => {
    const h = makeHarness({ paired: false });
    await boot(h);
    expect(h.service.link).toBe("unpaired");
    h.press("talk");
    await flush();
    expect(h.spoken("local_reply")).toEqual([LINES.notPaired]);
    expect(h.capture.starts).toBe(0);
    expect(() => h.client).toThrow();
  });

  it("P4: a credential written while running is picked up on the next tick", async () => {
    const h = makeHarness({ paired: false });
    await boot(h);
    pairInto(h.fake, h.store);
    await h.clock.advance(5000);
    expect(h.named("link").map((l) => l.state)).toEqual(["connecting", "online"]);
  });

  it("P5: no log line carries the credential or audio", async () => {
    const h = makeHarness();
    await boot(h);
    await talk(h);
    await h.clock.advance(20_000);
    const logs = h.log.lines.join("\n");
    expect(logs).not.toContain(h.credential);
    expect(logs).not.toMatch(/UklGR/); // base64 of "RIFF"
  });
});

describe("Talk", () => {
  it("B1: hold 2 s and release: listening cue, one turn with a 2 s 16 kHz WAV, reply spoken, clip zeroed", async () => {
    const h = makeHarness();
    await boot(h);
    h.press("talk", "pressed");
    await flush();
    expect(h.speaker.cues).toEqual(["listening"]);
    expect(h.capture.starts).toBe(1);
    expect(h.service.talk).toBe("recording");
    await h.clock.advance(2000);
    h.press("talk", "released");
    await flush();
    expect(h.speaker.cues).toEqual(["listening", "done"]);
    expect(h.client.calls.filter((c) => c === "turn")).toHaveLength(1);
    expect(h.device()?.clips).toEqual([{ bytes: 64_044, durationMs: 2000 }]);
    expect(h.spoken("reply")).toEqual(["Fake cloud reply 1: I received a 2 second clip. The real assistant isn't connected in this run."]);
    expect(h.service.talk).toBe("idle");
    expect(h.capture.clips[0]?.wav.every((byte) => byte === 0)).toBe(true);
  });

  it("B2: held past 15 s, the turn goes at 15 s and the later release does nothing", async () => {
    const h = makeHarness();
    await boot(h);
    h.press("talk", "pressed");
    await h.clock.advance(15_500);
    expect(h.device()?.clips).toEqual([{ bytes: 480_044, durationMs: 15_000 }]);
    h.press("talk", "released");
    await flush();
    expect(h.client.calls.filter((c) => c === "turn")).toHaveLength(1);
  });

  it("B3: a tap under 300 ms sends nothing and asks to hold Talk", async () => {
    const h = makeHarness();
    await boot(h);
    await talk(h, 200);
    expect(h.client.calls).not.toContain("turn");
    expect(h.capture.aborts).toBe(1);
    expect(h.spoken("local_reply")).toEqual([LINES.tooShort]);
    expect(h.service.talk).toBe("idle");
  });

  it("B4: a press while waiting cancels; the late reply is never spoken", async () => {
    const h = makeHarness();
    await boot(h);
    h.client.hold.add("turn");
    await talk(h);
    expect(h.service.talk).toBe("waiting");
    h.press("talk", "pressed");
    await flush();
    expect(h.spoken("local_reply")).toEqual([LINES.cancelled]);
    expect(h.service.talk).toBe("idle");
    expect(h.capture.starts).toBe(1);
    h.client.releaseHeld();
    await h.clock.advance(15_000);
    expect(h.spoken("reply")).toEqual([]);
    expect(h.service.link).toBe("online");
  });

  it("B5: a press while a reply plays stops it and starts listening", async () => {
    const h = makeHarness();
    await boot(h);
    h.speaker.hold = true;
    await talk(h);
    const reply = h.spoken("reply")[0]!;
    expect(h.speaker.spoken).toContain(reply);
    h.press("talk", "pressed");
    await flush();
    expect(h.speaker.stopped).toContain(reply);
    expect(h.service.talk).toBe("recording");
    expect(h.capture.starts).toBe(2);
  });

  it("B6: the simulator keyboard toggles: press starts, press sends", async () => {
    const h = makeHarness();
    await boot(h);
    h.press("talk", "pressed", "keyboard");
    await h.clock.advance(1000);
    expect(h.service.talk).toBe("recording");
    h.press("talk", "pressed", "keyboard");
    await flush();
    expect(h.device()?.clips).toHaveLength(1);
    expect(h.spoken("reply")).toHaveLength(1);
  });

  it("W4: a reply voiced by the server is played, and the walker's own voice stays silent", async () => {
    const h = makeHarness();
    await boot(h);
    const speech = toneWav([{ hz: 300, ms: 400 }]);
    h.fake.speech = speech;
    await talk(h);
    expect(h.speaker.played).toEqual([speech.length]);
    expect(h.speaker.spoken.filter((t) => t.startsWith("Fake cloud reply"))).toEqual([]);
    expect(h.spoken("reply")).toHaveLength(1);
  });

  it("W4: unreadable speech, or speech that fails to play, falls back to the walker's own voice", async () => {
    const h = makeHarness();
    await boot(h);
    h.fake.speech = Buffer.from("not a wav file");
    await talk(h);
    expect(h.speaker.played).toEqual([]);
    expect(h.speaker.spoken.filter((t) => t.startsWith("Fake cloud reply"))).toHaveLength(1);
    h.fake.speech = toneWav([{ hz: 300, ms: 400 }]);
    h.speaker.failWav = true;
    await talk(h);
    expect(h.speaker.spoken.filter((t) => t.startsWith("Fake cloud reply"))).toHaveLength(2);
  });

  it("ESP32 hand buttons drive the same Talk flow", async () => {
    const h = makeHarness({ withHand: true });
    await boot(h);
    h.hand!.press("talk", "pressed");
    await h.clock.advance(1500);
    h.hand!.press("talk", "released");
    await flush();
    expect(h.device()?.clips).toEqual([{ bytes: 48_044, durationMs: 1500 }]);
  });
});

describe("Confirm", () => {
  async function withProposal(h: Harness) {
    h.fake.script = [{ reply: "Fake cloud: switch to short sounds? Press Confirm to do it.", proposeCues: ["sound"] }];
    await talk(h);
    expect(h.service.openProposal?.kind).toBe("cues_change");
  }

  it("B7: confirms the open proposal by id, applies configuration 2, says so, and reports version 2", async () => {
    const h = makeHarness();
    await boot(h);
    await withProposal(h);
    const id = h.service.openProposal!.proposal_id;
    h.press("confirm");
    await flush();
    expect(answers(h)).toHaveLength(1);
    expect(h.device()?.proposals.at(-1)).toMatchObject({ proposal_id: id, state: "confirmed", configuration_version: 2 });
    expect(h.named("config").map((c) => c.version)).toEqual([2]);
    expect(h.store.readConfiguration()).toMatchObject({ version: 2, cues: ["sound"] });
    expect(h.speaker.cues.at(-1)).toBe("done");
    expect(h.spoken("confirm_result")).toEqual(["Done. Obstacle alerts now use short sounds."]);
    await h.clock.advance(5000);
    expect(h.device()?.lastHeartbeat?.manifest.device_configuration_version).toBe(2);
  });

  it("B7: a proposal learned from a heartbeat (opened elsewhere) can be confirmed too", async () => {
    const h = makeHarness();
    await boot(h);
    await withProposal(h);
    h.service.openProposal = null;
    await h.clock.advance(5000);
    expect(h.service.openProposal).not.toBeNull();
  });

  it("B8: with nothing open, Confirm plays the nothing-to-confirm sound and sends nothing", async () => {
    const h = makeHarness();
    await boot(h);
    h.press("confirm");
    await flush();
    expect(h.speaker.cues).toEqual(["nothing_to_confirm"]);
    expect(h.client.calls.filter((c) => c.startsWith("answer"))).toEqual([]);
    expect(h.store.pendingEvents(h.clock.monotonic())).toContainEqual(expect.objectContaining({ kind: "local_reply", text: "Nothing to confirm." }));
  });

  it("B9: Confirm is ignored while recording", async () => {
    const h = makeHarness();
    await boot(h);
    await withProposal(h);
    h.press("talk", "pressed");
    await flush();
    h.press("confirm");
    await flush();
    expect(h.client.calls.filter((c) => c.startsWith("answer"))).toEqual([]);
    expect(h.service.talk).toBe("recording");
  });

  it("B10: two quick presses send one answer", async () => {
    const h = makeHarness();
    await boot(h);
    await withProposal(h);
    h.client.hold.add("answer:confirm");
    h.press("confirm");
    h.press("confirm");
    await flush();
    expect(answers(h)).toHaveLength(1);
  });

  it("B11: a 409 proposal_closed (superseded, expired, declined) plays nothing-to-confirm and changes nothing", async () => {
    for (const state of ["superseded", "expired", "declined"] as const) {
      const h = makeHarness();
      await boot(h);
      await withProposal(h);
      const device = h.device()!;
      device.proposals = device.proposals.map((p) => ({ ...p, state }));
      h.press("confirm");
      await flush();
      expect(answers(h), state).toHaveLength(1);
      expect(h.speaker.cues.at(-1), state).toBe("nothing_to_confirm");
      expect(h.spoken("confirm_result"), state).toEqual([]);
      expect(h.service.openProposal, state).toBeNull();
      expect(h.named("config"), state).toEqual([]);
    }
  });

  it("B16: a 409 carrying 'confirmed' (the page won first) counts as done", async () => {
    const h = makeHarness();
    await boot(h);
    await withProposal(h);
    const device = h.device()!;
    h.fake.answer(device, h.service.openProposal!.proposal_id, "confirm");
    h.press("confirm");
    await flush();
    expect(answers(h)).toHaveLength(1);
    expect(h.spoken("confirm_result")).toEqual(["Done. Obstacle alerts now use short sounds."]);
    expect(h.service.configuration?.version).toBe(2);
  });

  it("B17: the proposal from a cancelled turn is declined once and never offered to Confirm", async () => {
    const h = makeHarness();
    await boot(h);
    h.fake.script = [{ reply: "Fake cloud: switch?", proposeCues: ["sound"] }];
    h.client.hold.add("turn");
    await talk(h);
    h.press("talk", "pressed");
    await flush();
    expect(h.spoken("local_reply")).toEqual([LINES.cancelled]);
    h.client.releaseHeld();
    await flush();
    expect(h.device()!.proposals.at(-1)?.state).toBe("open");
    await h.clock.advance(5000);
    expect(answers(h, "decline")).toHaveLength(1);
    expect(h.device()!.proposals.at(-1)?.state).toBe("declined");
    expect(h.service.openProposal).toBeNull();
    await h.clock.advance(10_000);
    expect(answers(h, "decline")).toHaveLength(1);
    h.press("confirm");
    await flush();
    expect(h.speaker.cues.at(-1)).toBe("nothing_to_confirm");
    expect(answers(h)).toEqual([]);
  });

  it("O10: offline, Confirm says it can't change settings and sends nothing", async () => {
    const h = makeHarness();
    await boot(h);
    await withProposal(h);
    await goOffline(h);
    expect(h.service.openProposal).toBeNull();
    h.press("confirm");
    await flush();
    expect(h.spoken("local_reply")).toEqual([LINES.offlineNoSettings]);
    expect(h.client.calls.filter((c) => c.startsWith("answer"))).toEqual([]);
  });
});

describe("offline", () => {
  it("O1: two failed heartbeats put it offline with one notice built from configuration and health", async () => {
    const h = makeHarness({ withHand: true, withTof: true });
    await boot(h);
    h.client.network = "down";
    await h.clock.advance(5000);
    expect(h.service.link).toBe("online");
    await h.clock.advance(5000);
    expect(h.service.link).toBe("offline");
    await h.clock.advance(60_000);
    expect(h.spoken("notice")).toEqual(["Steady is on.", `${OFFLINE_VIBRATION} The obstacle sensor is simulated.`]);
  });

  it("O2: one failure then a success stays online, with no notice", async () => {
    const h = makeHarness();
    await boot(h);
    h.client.network = "down";
    await h.clock.advance(5000);
    h.client.network = "up";
    await h.clock.advance(5000);
    expect(h.named("link").map((l) => l.state)).toEqual(["connecting", "online"]);
    expect(h.spoken("notice")).toEqual(["Steady is on."]);
  });

  it("O3: a turn with no answer for 10 s goes offline and says so", async () => {
    const h = makeHarness();
    await boot(h);
    h.client.hold.add("turn");
    await talk(h);
    await h.clock.advance(9_999);
    expect(h.service.talk).toBe("waiting");
    await h.clock.advance(1);
    expect(h.named("turn").map((t) => t.outcome)).toEqual(["timeout"]);
    expect(h.named("link").at(-1)?.state).toBe("offline");
    expect(h.service.talk).toBe("idle");
    expect(h.spoken("reply")).toEqual([]);
  });

  it("O4/B15: offline, Talk gets the local line at once, records nothing, and probes the link", async () => {
    const h = makeHarness({ withHand: true, withTof: true, cues: ["sound"] });
    await boot(h);
    await goOffline(h);
    const heartbeats = h.client.calls.filter((c) => c === "heartbeat").length;
    h.press("talk");
    await flush();
    expect(h.spoken("local_reply")).toEqual(["I'm offline right now. Your short-sound alerts still work. The obstacle sensor is simulated."]);
    expect(h.capture.starts).toBe(0);
    await h.clock.advance(0);
    expect(h.client.calls.filter((c) => c === "heartbeat").length).toBe(heartbeats + 1);
    expect(h.client.calls).not.toContain("turn");
  });

  it("O6/O8: back online says so, delivers the queued lines, and Talk works again", async () => {
    const h = makeHarness();
    await boot(h);
    await goOffline(h);
    h.press("talk");
    await flush();
    h.client.network = "up";
    await h.clock.advance(15_000);
    expect(h.service.link).toBe("online");
    expect(h.spoken("notice").at(-1)).toBe(LINES.backOnline);
    const delivered = h.device()!.events.map((e) => `${e.kind}: ${e.text}`);
    expect(delivered).toContain("notice: I'm offline right now.");
    expect(delivered.filter((e) => e.startsWith("local_reply"))).toHaveLength(1);
    // The 15 s window holds two more heartbeats, so "back online" has gone out too and nothing waits.
    expect(delivered).toContain(`notice: ${LINES.backOnline}`);
    expect(h.store.pendingEvents(h.clock.monotonic())).toEqual([]);
    await talk(h);
    expect(h.spoken("reply")).toHaveLength(1);
  });

  it("O7: obstacle cues keep working offline", async () => {
    const h = makeHarness({ withHand: true, withTof: true, cues: ["sound"] });
    await boot(h);
    await goOffline(h);
    h.tof!.readings.front_left = { mm: 300 };
    await h.clock.advance(200);
    expect(h.speaker.cues).toContain("obstacle");
  });

  it("O9: retries after failures at 5, 10, 15 and 15 s", async () => {
    const h = makeHarness();
    h.service.start();
    const times: number[] = [];
    h.bus.on("heartbeat", () => times.push(h.clock.monotonic()));
    await flush();
    h.client.network = "down";
    await h.clock.advance(46_000);
    expect(times).toEqual([0, 5000, 15_000, 30_000, 45_000]);
  });
});

describe("re-pair (401)", () => {
  it("A1: a 401 heartbeat says 'pair me again' once", async () => {
    const h = makeHarness();
    await boot(h);
    h.fake.forget(h.store.readCredential()!.device_id);
    await h.clock.advance(30_000);
    expect(h.service.link).toBe("unauthorized");
    expect(h.spoken("notice").filter((t) => t === LINES.pairAgain)).toHaveLength(1);
  });

  it("A2: Talk while unauthorized gets the same line and records nothing", async () => {
    const h = makeHarness();
    await boot(h);
    h.fake.forget(h.store.readCredential()!.device_id);
    await h.clock.advance(5000);
    h.press("talk");
    await flush();
    expect(h.spoken("local_reply")).toEqual([LINES.pairAgain]);
    expect(h.capture.starts).toBe(0);
  });

  it("A3: a turn answered 401 says it too", async () => {
    const h = makeHarness();
    await boot(h);
    h.press("talk", "pressed");
    await h.clock.advance(1000);
    h.fake.forget(h.store.readCredential()!.device_id);
    h.press("talk", "released");
    await flush();
    expect(h.named("turn").map((t) => t.outcome)).toEqual(["unauthorized"]);
    expect(h.spoken("notice")).toContain(LINES.pairAgain);
  });

  it("A4: pairing again while running brings it back online", async () => {
    const h = makeHarness();
    await boot(h);
    h.fake.forget(h.store.readCredential()!.device_id);
    await h.clock.advance(5000);
    pairInto(h.fake, h.store);
    await h.clock.advance(5000);
    expect(h.service.link).toBe("online");
    await talk(h);
    expect(h.spoken("reply")).toHaveLength(1);
  });
});

describe("reports", () => {
  it("S11: the manifest lists each part with catalog id, protocol, health and simulated, and passes the schema", async () => {
    const h = makeHarness({ withHand: true, withTof: true });
    await boot(h);
    await h.clock.advance(5000);
    const manifest = h.device()!.lastHeartbeat!.manifest;
    expect(CapabilityManifestSchema.parse(manifest)).toEqual(manifest);
    expect(manifest.simulator).toBe(true);
    expect(manifest.device_configuration_version).toBe(1);
    expect(manifest.modules.map((m) => [m.module_id, m.instance_id, m.protocol_version, m.health, m.simulated])).toEqual([
      ["controls.hand", "hand-left-01", 1, "ok", true],
      ["perception.tof", "tof-front-01", 1, "ok", true],
      ["voice", "test-audio", null, "ok", true],
    ]);
    expect(h.device()!.lastHeartbeat!.snapshot?.zones.map((z) => z.zone)).toEqual(["front_left", "front_right"]);
  });

  it("P6: without an obstacle sensor the heartbeat and turn snapshots are null", async () => {
    const h = makeHarness();
    await boot(h);
    await h.clock.advance(5000);
    expect(h.device()!.lastHeartbeat!.snapshot).toBeNull();
  });

  it("O8: a line's ago_ms comes from the monotonic clock, so the page shows when it was said", async () => {
    const h = makeHarness();
    await boot(h);
    const bootLine = h.device()!.events.find((e) => e.text === "Steady is on.");
    expect(bootLine?.at).toBe("2026-10-24T12:00:00.000Z");
    h.client.network = "down";
    await h.clock.advance(10_000);
    h.client.network = "up";
    await h.clock.advance(15_000);
    const offline = h.device()!.events.find((e) => e.text.startsWith("I'm offline"));
    expect(offline?.at).toBe("2026-10-24T12:00:10.000Z");
  });

  it("C4: the snapshot leaves out zones older than 500 ms", async () => {
    const h = makeHarness({ withTof: true });
    await boot(h);
    await h.clock.advance(1000);
    expect(h.service.snapshot().zones).toHaveLength(2);
    h.tof!.hang();
    await h.clock.advance(500);
    expect(h.service.snapshot().zones).toEqual([]);
  });

  it("S7: a module that stops responding is announced once and reported unavailable", async () => {
    const h = makeHarness({ withTof: true });
    await boot(h);
    h.tof!.hang();
    await h.clock.advance(10_000);
    expect(h.spoken("notice").filter((t) => t.includes("stopped responding"))).toEqual(["Your obstacle sensor stopped responding."]);
    expect(h.device()!.lastHeartbeat!.manifest.modules[0]).toMatchObject({ health: "unavailable", faults: ["heartbeat_timeout"] });
  });

  it("C1/C11: vibration config buzzes the hand; turns, proposals and confirms never cue on their own", async () => {
    const h = makeHarness({ withHand: true, withTof: true });
    await boot(h);
    h.fake.script = [{ reply: "Fake cloud: switch?", proposeCues: ["sound"] }];
    await talk(h);
    h.press("confirm");
    await h.clock.advance(5000);
    expect(h.service.configuration?.cues).toEqual(["sound"]);
    expect(h.named("haptic")).toEqual([]);
    expect(h.speaker.cues).not.toContain("obstacle");
    h.tof!.readings.front_left = { mm: 300 };
    await h.clock.advance(200);
    expect(h.speaker.cues).toContain("obstacle");
    expect(h.named("haptic")).toEqual([]);
  });

  it("C1: with configuration 1 (vibration), a near zone sends the haptic to the hand and no sound", async () => {
    const h = makeHarness({ withHand: true, withTof: true });
    await boot(h);
    h.tof!.readings.front_left = { mm: 300 };
    await h.clock.advance(200);
    expect(h.named("haptic")).toEqual([{ instanceId: "hand-left-01", pattern: "near_obstacle", durationMs: 400 }]);
    expect(h.speaker.cues).not.toContain("obstacle");
  });

  it("B15: connecting (no answer yet), Talk says so", async () => {
    const h = makeHarness();
    h.service.start();
    h.client.hold.add("heartbeat");
    await flush();
    h.press("talk");
    await flush();
    expect(h.service.link).toBe("connecting");
    expect(h.spoken("local_reply")).toEqual([LINES.connecting]);
  });
});
