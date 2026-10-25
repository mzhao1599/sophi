import { describe, expect, it } from "vitest";
import { CuePolicy, effectiveObstacleCues, type ConfiguredCue } from "../src/cues";
import type { ModuleView, ZoneView } from "../src/serial/modules";
import { FakeClock, captureLogger } from "./support/fakes";

const hand: ModuleView = {
  instanceId: "hand-left-01",
  type: "hand",
  catalogId: "controls.hand",
  capabilities: ["button.talk", "haptic"],
  firmwareVersion: null,
  health: "ok",
  faults: [],
  observedAt: 0,
  simulated: true,
};

function policy(cues: ConfiguredCue[] | null, hands: ModuleView[] = [hand]) {
  const clock = new FakeClock();
  const haptics: string[] = [];
  let sounds = 0;
  const cuePolicy = new CuePolicy({
    clock,
    log: captureLogger(),
    modules: {
      hapticTargets: () => hands,
      sendHaptic: (id, pattern, ms) => {
        haptics.push(`${id} ${pattern} ${ms}`);
        return true;
      },
    },
    playObstacleSound: () => {
      sounds += 1;
    },
    cues: () => cues,
  });
  const zone = (mm: number | null, name = "front_left"): ZoneView => ({
    zone: name,
    instanceId: "tof-front-01",
    mm,
    quality: mm === null ? "invalid" : "valid",
    receivedMono: clock.monotonic(),
    receivedWall: clock.now(),
  });
  return { clock, cuePolicy, haptics, sounds: () => sounds, zone };
}

describe("local cue policy", () => {
  it("C1: vibration gives one near_obstacle haptic per healthy haptic hand, and no sound", () => {
    const right = { ...hand, instanceId: "hand-right-01" };
    const p = policy(["vibration", "spoken"], [hand, right]);
    p.cuePolicy.evaluate([p.zone(300)]);
    expect(p.haptics).toEqual(["hand-left-01 near_obstacle 400", "hand-right-01 near_obstacle 400"]);
    expect(p.sounds()).toBe(0);
  });

  it("C2: sound gives the obstacle sound and no haptic", () => {
    const p = policy(["sound"]);
    p.cuePolicy.evaluate([p.zone(300)]);
    expect(p.haptics).toEqual([]);
    expect(p.sounds()).toBe(1);
  });

  it("C3: both gives both", () => {
    const p = policy(["vibration", "sound"]);
    p.cuePolicy.evaluate([p.zone(300)]);
    expect(p.haptics).toHaveLength(1);
    expect(p.sounds()).toBe(1);
  });

  it("C5: an invalid reading is unknown, not clear, and never cues", () => {
    const p = policy(["sound"]);
    p.cuePolicy.evaluate([p.zone(null)]);
    expect(p.cuePolicy.zoneState("front_left")).toBe("unknown");
    expect(p.sounds()).toBe(0);
  });

  it("C4/C10: a zone missing from the current zones (stale or from an unavailable module) becomes unknown", () => {
    const p = policy(["sound"]);
    p.cuePolicy.evaluate([p.zone(1200)]);
    expect(p.cuePolicy.zoneState("front_left")).toBe("clear");
    p.cuePolicy.evaluate([]);
    expect(p.cuePolicy.zoneState("front_left")).toBe("unknown");
  });

  it("C6: near every 100 ms for 10 s cues at 0, 3, 6 and 9 s", async () => {
    const p = policy(["sound"]);
    const at: number[] = [];
    for (let t = 0; t < 10_000; t += 100) {
      const before = p.sounds();
      p.cuePolicy.evaluate([p.zone(300)]);
      if (p.sounds() > before) at.push(p.clock.monotonic());
      await p.clock.advance(100);
    }
    expect(at).toEqual([0, 3000, 6000, 9000]);
  });

  it("C7: hysteresis holds near between 750 and 900 mm; re-entry cues after 1 s, not before", async () => {
    const p = policy(["sound"]);
    for (const mm of [740, 760, 740, 760, 890]) {
      p.cuePolicy.evaluate([p.zone(mm)]);
      await p.clock.advance(100);
    }
    expect(p.sounds()).toBe(1);
    expect(p.cuePolicy.zoneState("front_left")).toBe("near");
    p.cuePolicy.evaluate([p.zone(950)]);
    expect(p.cuePolicy.zoneState("front_left")).toBe("clear");
    await p.clock.advance(700); // t = 1200
    p.cuePolicy.evaluate([p.zone(700)]);
    expect(p.sounds()).toBe(2);
    p.cuePolicy.evaluate([p.zone(950)]);
    await p.clock.advance(500); // 0.5 s after the last cue
    p.cuePolicy.evaluate([p.zone(700)]);
    expect(p.sounds()).toBe(2);
  });

  it("one cue covers every zone that is near at that moment", async () => {
    const p = policy(["sound"]);
    p.cuePolicy.evaluate([p.zone(300, "front_left"), p.zone(300, "front_right")]);
    await p.clock.advance(1500);
    p.cuePolicy.evaluate([p.zone(300, "front_left"), p.zone(300, "front_right")]);
    expect(p.sounds()).toBe(1);
  });

  it("C8: no configuration yet gives vibration and sound", () => {
    const p = policy(null);
    p.cuePolicy.evaluate([p.zone(300)]);
    expect(p.haptics).toHaveLength(1);
    expect(p.sounds()).toBe(1);
  });

  it("C9: vibration with no working haptic hand falls back to sound", () => {
    const p = policy(["vibration"], []);
    p.cuePolicy.evaluate([p.zone(300)]);
    expect(p.sounds()).toBe(1);
  });

  it("effective cues never come out empty", () => {
    expect(effectiveObstacleCues(["spoken"], true)).toEqual(["sound"]);
    expect(effectiveObstacleCues(["vibration", "sound"], false)).toEqual(["sound"]);
    expect(effectiveObstacleCues(["vibration"], true)).toEqual(["vibration"]);
  });
});
