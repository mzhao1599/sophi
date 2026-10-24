import { describe, expect, it } from "vitest";
import { SerialHapticPlaySchema } from "@walker/contracts";
import { CONFIRM_PRESS_HAPTIC_MS, ESP32_TALK_RELEASE_GRACE_MS, TALK_PRESS_HAPTIC_MS } from "../src/constants";
import { boot, flush, makeHarness, type Harness } from "./support/fakes";

/** The haptic.play lines the Pi actually wrote to the simulated hand, as "pattern ms". */
const handLines = (h: Harness) =>
  h.hand!.port.received
    .map((line) => JSON.parse(line) as { type: string })
    .filter((message) => message.type === "haptic.play")
    .map((message) => SerialHapticPlaySchema.parse(message))
    .map((message) => `${message.module_id} ${message.pattern} ${message.duration_ms}`);

/** What the simulated hand felt (it acks every valid haptic.play). */
function feel(h: Harness): string[] {
  const felt: string[] = [];
  h.hand!.onHaptic = (pattern, ms) => felt.push(`${pattern} ${ms}`);
  return felt;
}

/** Holds Talk on the hand board for 2 s and lets the reply land. */
async function handTalk(h: Harness): Promise<void> {
  h.hand!.press("talk", "pressed");
  await h.clock.advance(2000);
  h.hand!.press("talk", "released");
  await h.clock.advance(ESP32_TALK_RELEASE_GRACE_MS);
}

describe("press buzz: the hand that was pressed buzzes", () => {
  it("B23: a Talk press on the hand sends it one recording buzz, and recording works as before", async () => {
    const h = makeHarness({ withHand: true });
    const felt = feel(h);
    await boot(h);
    h.hand!.press("talk", "pressed");
    await flush();
    expect(handLines(h)).toEqual([`hand-right-01 recording ${TALK_PRESS_HAPTIC_MS}`]);
    expect(felt).toEqual([`recording ${TALK_PRESS_HAPTIC_MS}`]);
    expect(h.named("haptic")).toEqual([{ instanceId: "hand-right-01", pattern: "recording", durationMs: TALK_PRESS_HAPTIC_MS }]);
    expect(h.speaker.cues).toEqual(["listening"]);
    expect(h.capture.starts).toBe(1);
    expect(h.service.talk).toBe("recording");
    await h.clock.advance(2000);
    h.hand!.press("talk", "released");
    await h.clock.advance(ESP32_TALK_RELEASE_GRACE_MS);
    // The release doesn't buzz; the turn goes out as usual.
    expect(handLines(h)).toEqual([`hand-right-01 recording ${TALK_PRESS_HAPTIC_MS}`]);
    expect(h.client.calls.filter((c) => c === "turn")).toHaveLength(1);
    expect(h.named("turn").map((t) => t.outcome)).toEqual(["answered"]);
  });

  it("B23: a Talk press that only gets a local line (unpaired) still buzzes", async () => {
    const h = makeHarness({ withHand: true, paired: false });
    await boot(h);
    h.hand!.press("talk", "pressed");
    await flush();
    expect(handLines(h)).toEqual([`hand-right-01 recording ${TALK_PRESS_HAPTIC_MS}`]);
    expect(h.capture.starts).toBe(0);
  });

  it("B24: Confirm on the hand that confirms the open proposal buzzes confirmation", async () => {
    const h = makeHarness({ withHand: true });
    const felt = feel(h);
    await boot(h);
    h.fake.script = [{ reply: "Fake cloud: switch?", proposeCues: ["sound"] }];
    await handTalk(h);
    expect(h.service.openProposal).not.toBeNull();
    h.hand!.press("confirm", "pressed");
    await h.clock.advance(1000);
    expect(h.service.configuration?.cues).toEqual(["sound"]);
    expect(h.speaker.cues).toContain("done");
    expect(handLines(h)).toEqual([`hand-right-01 recording ${TALK_PRESS_HAPTIC_MS}`, `hand-right-01 confirmation ${CONFIRM_PRESS_HAPTIC_MS}`]);
    expect(felt).toEqual([`recording ${TALK_PRESS_HAPTIC_MS}`, `confirmation ${CONFIRM_PRESS_HAPTIC_MS}`]);
  });

  it("B25: Confirm on the hand with nothing open buzzes error, with the usual sound and line", async () => {
    const h = makeHarness({ withHand: true });
    await boot(h);
    h.hand!.press("confirm", "pressed");
    await flush();
    expect(handLines(h)).toEqual([`hand-right-01 error ${CONFIRM_PRESS_HAPTIC_MS}`]);
    expect(h.speaker.cues).toEqual(["nothing_to_confirm"]);
    expect(h.client.calls.filter((c) => c.startsWith("answer:"))).toEqual([]);
  });

  it("B25: Confirm while recording is ignored and buzzes error once; the recording carries on", async () => {
    const h = makeHarness({ withHand: true });
    await boot(h);
    h.hand!.press("talk", "pressed");
    await flush();
    h.hand!.press("confirm", "pressed");
    await flush();
    expect(handLines(h)).toEqual([`hand-right-01 recording ${TALK_PRESS_HAPTIC_MS}`, `hand-right-01 error ${CONFIRM_PRESS_HAPTIC_MS}`]);
    expect(h.service.talk).toBe("recording");
    expect(h.capture.aborts).toBe(0);
  });

  it("B25: Confirm offline buzzes error", async () => {
    const h = makeHarness({ withHand: true });
    await boot(h);
    h.client.network = "down";
    await h.clock.advance(10_000);
    expect(h.service.link).toBe("offline");
    h.hand!.press("confirm", "pressed");
    await flush();
    expect(handLines(h)).toEqual([`hand-right-01 error ${CONFIRM_PRESS_HAPTIC_MS}`]);
  });

  it("B26: GPIO and keyboard presses never buzz, even with a hand board attached", async () => {
    const h = makeHarness({ withHand: true });
    await boot(h);
    // Even a GPIO event that names the hand's id: the source decides, not the detail.
    h.bus.emit("button", { button: "talk", edge: "pressed", source: "gpio", detail: "hand-right-01" });
    await flush();
    expect(h.capture.starts).toBe(1);
    await h.clock.advance(2000);
    h.bus.emit("button", { button: "talk", edge: "released", source: "gpio", detail: "hand-right-01" });
    await flush();
    h.bus.emit("button", { button: "confirm", edge: "pressed", source: "gpio", detail: "GPIO27" });
    h.bus.emit("button", { button: "confirm", edge: "pressed", source: "keyboard" });
    await h.clock.advance(1000);
    expect(h.named("haptic")).toEqual([]);
    expect(handLines(h)).toEqual([]);
  });

  it("B27: a hand without the haptic capability gets no buzz and no error; Talk still records and sends", async () => {
    const h = makeHarness({ withHand: true });
    h.hand!.hasHaptic = false;
    h.hand!.start(); // say hello again without `haptic`
    await boot(h);
    await handTalk(h);
    h.hand!.press("confirm", "pressed");
    await flush();
    expect(h.named("haptic")).toEqual([]);
    expect(handLines(h)).toEqual([]);
    expect(h.client.calls.filter((c) => c === "turn")).toHaveLength(1);
    expect(h.log.lines.filter((line) => line.startsWith("error"))).toEqual([]);
  });

  it("B27: a buzz whose send throws is logged, never thrown, and the recording still starts", async () => {
    const h = makeHarness({ withHand: true });
    await boot(h);
    h.modules.sendHaptic = () => {
      throw new Error("port exploded");
    };
    h.hand!.press("talk", "pressed");
    await flush();
    expect(h.capture.starts).toBe(1);
    expect(h.service.talk).toBe("recording");
    expect(h.log.lines.some((line) => line.startsWith("warn press buzz failed"))).toBe(true);
  });

  it("B28: with cues set to sound, a press still buzzes, and an obstacle still gets only the sound", async () => {
    const h = makeHarness({ withHand: true, withTof: true, cues: ["sound"] });
    await boot(h);
    h.hand!.press("talk", "pressed");
    await flush();
    expect(handLines(h)).toEqual([`hand-right-01 recording ${TALK_PRESS_HAPTIC_MS}`]);
    h.tof!.readings.front_left = { mm: 300 };
    await h.clock.advance(200);
    expect(h.speaker.cues).toContain("obstacle");
    expect(h.named("haptic").map((e) => e.pattern)).toEqual(["recording"]);
  });

  it("B28: a press buzz doesn't count as an obstacle alert: a near zone right after still gets near_obstacle", async () => {
    const h = makeHarness({ withHand: true, withTof: true }); // configuration 1: vibration
    await boot(h);
    h.hand!.press("talk", "pressed");
    await flush();
    h.tof!.readings.front_left = { mm: 300 };
    await h.clock.advance(200);
    expect(h.named("haptic").map((e) => e.pattern)).toEqual(["recording", "near_obstacle"]);
    expect(handLines(h)).toEqual([`hand-right-01 recording ${TALK_PRESS_HAPTIC_MS}`, "hand-right-01 near_obstacle 400"]);
  });
});
