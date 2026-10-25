import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  HELP_CHORD_WINDOW_MS,
  ArmCalibrationSchema,
  MANIFEST_MAY_LIST_ARMS,
  MAX_GOAL_LEAD_DEG,
  MAX_GOAL_STEP_DEG,
  MOTION_LIMITS,
} from "@walker/contracts";
import { describe, expect, it } from "vitest";
import { openArmLink } from "../src/motion/arm";
import { STALL_WINDOW_MS, centringOffset, handleSide } from "../src/motion/coordinator";
import { nextGoal, servoSpeedRegister, teleopSpeedDegS } from "../src/motion/limits";
import { answerOperator } from "../src/motion/operator";
import { OperatorClient, OperatorSocket } from "../src/motion/operator";
import { isArmPort, readMotionSettings } from "../src/motion/settings";
import { GpioStopSense, parseGpioget } from "../src/motion/stopSense";
import { FakeStsBus } from "../src/sim/fakeFeetech";
import { fakeConnection } from "../src/sim/motionSim";
import { Instruction } from "../src/motion/feetech/protocol";
import { FakeClock, captureLogger, flush } from "./support/fakes";
import { makeMotionHarness, type MotionHarness } from "./support/motion";

/** Rows M11 to M24 in test/EXPECTED.md ("Motion: the arms"). Every clock is fake; nothing here is hardware. */

async function confirmAfterWindow(h: MotionHarness): Promise<void> {
  await h.clock.advance(2100);
  h.press("c");
  await h.clock.advance(50);
}

function motionEvents(h: MotionHarness): string[] {
  const seen: string[] = [];
  h.bus.on("motion", ({ kind, text }) => seen.push(`${kind} ${text}`));
  h.bus.on("sim", ({ text }) => seen.push(`sim ${text}`));
  return seen;
}

describe("settings", () => {
  it("M11: bench mode only for exactly no-hardware-stop; ports must be stable links; the stop is declared", () => {
    const port = "/dev/serial/by-id/usb-1a86_USB_Single_Serial_ABC-if00";
    expect(readMotionSettings({})).toEqual({ kind: "off" });
    expect(readMotionSettings({ WALKER_ARM_LEFT_PORT: port })).toMatchObject({ kind: "on", settings: { bench: false, stopSense: { kind: "not_wired" } } });
    expect(readMotionSettings({ WALKER_ARM_LEFT_PORT: port, WALKER_MOTION_BENCH: "no-hardware-stop" })).toMatchObject({ settings: { bench: true } });
    expect(readMotionSettings({ WALKER_ARM_LEFT_PORT: port, WALKER_MOTION_BENCH: "yes" }).kind).toBe("error");
    expect(readMotionSettings({ WALKER_ARM_LEFT_PORT: port, WALKER_MOTION_BENCH: "no-hardware-stop " }).kind).toBe("error");
    expect(readMotionSettings({ WALKER_ARM_LEFT_PORT: "/dev/ttyACM0" }).kind).toBe("error");
    expect(readMotionSettings({ WALKER_ARM_LEFT_PORT: "/dev/serial/by-path/platform-xhci-hcd.0-usb-0:1:1.0-port0" }).kind).toBe("on");
    expect(readMotionSettings({ WALKER_ARM_LEFT_PORT: port, WALKER_STOP_SENSE: "gpio:22" })).toMatchObject({ settings: { stopSense: { kind: "gpio", line: 22 } } });
    expect(readMotionSettings({ WALKER_ARM_LEFT_PORT: port, WALKER_STOP_SENSE: "wired" }).kind).toBe("error");
    expect(readMotionSettings({ WALKER_ARM_LEFT_PORT: port, WALKER_LEADER_LEFT_PORT: port }).kind).toBe("error");
  });

  it("M11: an arm port is recognised under another link to the same device, so the ESP32 scanner skips it", () => {
    const dir = mkdtempSync(join(tmpdir(), "walker-ports-"));
    const device = join(dir, "ttyACM7");
    writeFileSync(device, "");
    symlinkSync(device, join(dir, "by-id-arm"));
    symlinkSync(device, join(dir, "by-path-arm"));
    writeFileSync(join(dir, "hand"), "");
    const env = { WALKER_ARM_LEFT_PORT: join(dir, "by-id-arm") };
    expect(isArmPort(join(dir, "by-path-arm"), env)).toBe(true);
    expect(isArmPort(join(dir, "hand"), env)).toBe(false);
  });
});

describe("limits", () => {
  it("M12: a goal never leads the measured position by more than 5° nor moves more than 2° a step", () => {
    expect(nextGoal(0, 90, 0, 10)).toBe(MAX_GOAL_STEP_DEG);
    expect(nextGoal(4, 90, 0, 2)).toBe(MAX_GOAL_LEAD_DEG);
    expect(nextGoal(5, 90, -3, 2)).toBe(-3 + MAX_GOAL_LEAD_DEG);
    expect(nextGoal(0, -90, 0, 1)).toBe(-1);
    expect(nextGoal(29.5, 30, 29, 1)).toBe(30);
  });

  it("M12: teleop is capped at the skill ceiling while recording; servo speed is never 0", () => {
    expect(teleopSpeedDegS(MOTION_LIMITS.normal, false)).toBe(90);
    expect(teleopSpeedDegS(MOTION_LIMITS.normal, true)).toBe(60);
    expect(teleopSpeedDegS(MOTION_LIMITS.bench, true)).toBe(45);
    expect(servoSpeedRegister(0)).toBeGreaterThan(0);
  });

  it("M12: the centring offset makes the middle read 2048 (LeRobot's reading = position − offset), within ±2047", () => {
    expect(centringOffset(2500, 0)).toBe(452);
    expect(centringOffset(100, 0)).toBe(-1948);
    expect(centringOffset(4000, 100)).toBe(-2044);
    expect(handleSide({ button: "confirm", edge: "pressed", source: "esp32", detail: "hand-right-01" })).toBe("right");
    expect(handleSide({ button: "confirm", edge: "pressed", source: "gpio" })).toBe("left");
  });
});

describe("start-up check", () => {
  it("M13: an echoing adapter is found and the bus reopened in echo mode before anything is written", async () => {
    const clock = new FakeClock();
    const fake = new FakeStsBus(clock, { echo: true });
    let opens = 0;
    const result = openArmLink({ label: "left follower", openPort: () => (opens++, fakeConnection(fake, () => {})), clock, log: captureLogger(), ids: [1, 2, 3, 4, 5, 6] });
    await clock.advance(500);
    const { link, report } = await result;
    expect(report).toMatchObject({ ok: true, echo: true });
    expect(link?.echo).toBe(true);
    expect(opens).toBe(2);
  });

  it("M13: a missing servo or a wrong model fails the check, and nothing but reads and pings was sent", async () => {
    for (const fault of ["missing", "model"] as const) {
      const clock = new FakeClock();
      const fake = new FakeStsBus(clock);
      if (fault === "missing") fake.servo(4).faults.silent = true;
      else fake.servo(2).set("modelNumber", 1234);
      const result = openArmLink({ label: "left follower", openPort: () => fake, clock, log: captureLogger(), ids: [1, 2, 3, 4, 5, 6] });
      await clock.advance(2000);
      const { link, report } = await result;
      expect(link).toBeNull();
      expect(report.ok).toBe(false);
      const written = fake.received.map((p) => p[4]).filter((i) => i !== Instruction.PING && i !== Instruction.READ);
      expect(written).toEqual([]);
    }
  });
});

describe("the coordinator", () => {
  it("M14: the terminal only prepares: whatever its message claims, nothing starts without the walker's Confirm", async () => {
    const h = makeMotionHarness();
    const seen = motionEvents(h);
    await h.start();
    const reply = await answerOperator(h.coordinator, {
      op: "torque",
      enabled: true,
      arm: "left",
      initiator: "walker_confirm",
      prepared_by: "walker_local",
      base_parked: true,
      confirm: { handle: "left", pressed_mono_ms: 0, released_since_mono_ms: 0, pressed_at: new Date().toISOString() },
    });
    expect(reply).toMatchObject({ ok: true, request: { state: "waiting_confirm" } });
    expect(h.coordinator.state().confirm_target).toMatchObject({ prepared_by: "operator_cli", action: { kind: "arm.torque", enabled: true } });
    await h.clock.advance(5000);
    expect(seen.filter((e) => e.startsWith("sim torque-on"))).toEqual([]);
    expect(h.sim.buses.get("left/follower")!.servo(1).get("torqueEnable")).toBe(0);
    await h.stop();
  });

  it("M14: a terminal that goes away withdraws the target it prepared", async () => {
    const h = makeMotionHarness();
    await h.start();
    const path = join(mkdtempSync(join(tmpdir(), "walker-sock-")), "m.sock");
    const socket = new OperatorSocket(path, h.coordinator, captureLogger());
    await socket.listen();
    const client = await OperatorClient.connect(path);
    const reply = await client.send({ op: "torque", enabled: true, arm: "left" });
    expect(reply).toMatchObject({ ok: true, request: { state: "waiting_confirm" } });
    expect(h.coordinator.state().confirm_target).not.toBeNull();
    client.close();
    for (let i = 0; i < 50 && h.coordinator.state().confirm_target; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(h.coordinator.state().confirm_target).toBeNull();
    socket.close();
    await h.stop();
  });

  it("M15: the manifest never lists manipulation.arm while MANIFEST_MAY_LIST_ARMS is false, arms or not", async () => {
    expect(MANIFEST_MAY_LIST_ARMS).toBe(false);
    const h = makeMotionHarness();
    await h.start();
    const ids = h.service.manifest().modules.map((m) => m.module_id);
    expect(ids.some((id) => id.startsWith("manipulation."))).toBe(false);
    await h.stop();
  });

  it("M16: a handle Confirm counts only after its button was seen released for 2 s; a hand's hello withdraws the target", async () => {
    const h = makeMotionHarness();
    const seen = motionEvents(h);
    await h.start();
    await h.clock.advance(3000);
    h.coordinator.operatorTorque(true, ["left"]);
    const ignored = () => seen.filter((e) => e.startsWith("press-ignored"));
    // In the target's first 2 s: ignored.
    await h.clock.advance(1500);
    h.hand.press("confirm", "pressed");
    await h.clock.advance(50);
    h.hand.press("confirm", "released");
    await h.clock.advance(550);
    expect(ignored()).toEqual(["press-ignored ignore_too_early"]);
    // 2.1 s after the target but only 0.55 s after this button's release: ignored (the window restarted).
    h.hand.press("confirm", "pressed");
    await h.clock.advance(100);
    // A second press edge with no release seen (a lost release): not trusted.
    h.hand.press("confirm", "pressed");
    // Each press is answered after the help chord window (HELP_CHORD_WINDOW_MS), with the evidence of its own moment.
    await h.clock.advance(HELP_CHORD_WINDOW_MS);
    expect(ignored()).toEqual(["press-ignored ignore_too_early", "press-ignored ignore_too_early", "press-ignored ignore_untrusted"]);
    expect(seen).not.toContain("torque left on");
    h.hand.press("confirm", "released");
    await h.clock.advance(2100);
    h.hand.press("confirm", "pressed");
    await h.clock.advance(100 + HELP_CHORD_WINDOW_MS);
    expect(seen).toContain("torque left on");
    // A new target, then the hand says hello again: withdrawn.
    h.coordinator.operatorGoToPose("left", "ready");
    expect(h.coordinator.state().confirm_target).not.toBeNull();
    h.hand.start();
    await h.clock.advance(20);
    expect(h.coordinator.state().confirm_target).toBeNull();
    await h.stop();
  });

  it("M17: while the walker's own proposal is open, nothing motion can be prepared (confirm_busy)", async () => {
    const h = makeMotionHarness();
    await h.start();
    h.service.openProposal = { proposal_id: "11111111-1111-4111-8111-111111111111" } as never;
    const result = h.coordinator.operatorTorque(true, ["left"]);
    expect(result).toMatchObject({ ok: true, request: { state: "refused", refusal: "confirm_busy" } });
    expect(h.coordinator.state().confirm_target).toBeNull();
    await h.stop();
  });

  it("M18: calibration: Confirm turns torque off, offsets centre the middle, ranges are recorded and saved; old poses are set aside", async () => {
    const h = makeMotionHarness();
    await h.start();
    const fake = h.sim.buses.get("left/follower")!;
    for (const servo of fake.servos.values()) servo.moveByHand(2500);
    const begin = h.coordinator.operatorCalibrateBegin("left", "follower");
    expect(begin).toMatchObject({ ok: true, request: { state: "waiting_confirm" } });
    await confirmAfterWindow(h);
    await h.clock.advance(200);
    expect(h.coordinator.state().mode).toBe("disabled");
    const middle = h.coordinator.operatorCalibrateMiddle();
    await h.clock.advance(1000);
    expect(await middle).toEqual({ ok: true });
    for (const servo of fake.servos.values()) {
      expect(servo.get("homingOffset")).toBe(452);
      expect(Math.abs(servo.get("presentPosition") - 2048)).toBeLessThanOrEqual(1);
    }
    expect(h.coordinator.operatorPoses().some((p) => p.arm === "left")).toBe(false);
    for (const servo of fake.servos.values()) servo.moveByHand(2048 - 500);
    await h.clock.advance(100);
    for (const servo of fake.servos.values()) servo.moveByHand(2048 + 700);
    await h.clock.advance(100);
    const finish = h.coordinator.operatorCalibrateFinish();
    expect(finish.ok).toBe(true);
    const saved = ArmCalibrationSchema.parse(JSON.parse(readFileSync(join(h.dir, "motion", "calibration-left-follower.json"), "utf8")));
    expect(saved.joints.elbow_flex).toMatchObject({ homing_offset: 452, min_ticks: 1548, max_ticks: 2748, zero_ticks: 2048, direction: 1 });
    expect(readdirSync(join(h.dir, "motion")).some((n) => n.startsWith("calibration-left-follower.json.replaced-"))).toBe(true);
    expect(readdirSync(join(h.dir, "motion")).some((n) => n.startsWith("poses.json.replaced-"))).toBe(true);
    await h.stop();
  });

  it("M19: an offer carries ids only: words or an unknown pose are dropped", async () => {
    const h = makeMotionHarness();
    await h.start();
    h.coordinator.operatorTorque(true, ["left"]);
    await confirmAfterWindow(h);
    await h.clock.advance(2100);
    expect(h.coordinator.requestOffer({ target: { kind: "arm.go_to_pose", arm: "left", pose: "ready" }, title: "Cloud words" })).toBeNull();
    expect(h.coordinator.requestOffer({ target: { kind: "arm.go_to_pose", arm: "left", pose: "nowhere" } })).toBeNull();
    const target = h.coordinator.requestOffer({ target: { kind: "arm.go_to_pose", arm: "left", pose: "ready" } });
    expect(target).toMatchObject({ prepared_by: "offer", title: "Move the left arm to ready" });
    await h.stop();
  });

  it("M20: leaders never get torque, before or after the followers' torque comes on", async () => {
    const h = makeMotionHarness();
    await h.start();
    h.coordinator.operatorTorque(true, ["left", "right"]);
    await confirmAfterWindow(h);
    await h.clock.advance(200);
    for (const key of ["left/leader", "right/leader"]) {
      const fake = h.sim.buses.get(key)!;
      for (const servo of fake.servos.values()) expect(servo.get("torqueEnable")).toBe(0);
    }
    for (const servo of h.sim.buses.get("left/follower")!.servos.values()) expect(servo.get("torqueEnable")).toBe(1);
    await h.stop();
  });

  it("M21: a stop latched during the torque-on sequence leaves torque off", async () => {
    const h = makeMotionHarness();
    await h.start();
    h.coordinator.operatorTorque(true, ["left"]);
    await h.clock.advance(2100);
    h.press("c");
    // The stop reads pressed while the sequence is still on the bus (power not cut: a miswired stop).
    h.sim.stopSwitch.set("pressed");
    await h.clock.advance(500);
    expect(h.coordinator.state().faults.map((f) => f.code)).toContain("stop_circuit_opened");
    for (const servo of h.sim.buses.get("left/follower")!.servos.values()) expect(servo.get("torqueEnable")).toBe(0);
    await h.stop();
  });

  it("M22: while holding, a lost reading latches feedback_stale (CHECKS_WHILE_HOLDING)", async () => {
    const h = makeMotionHarness();
    await h.start();
    h.coordinator.operatorTorque(true, ["left"]);
    await confirmAfterWindow(h);
    await h.clock.advance(100);
    h.sim.buses.get("left/follower")!.servo(2).faults.noReply = true;
    await h.clock.advance(600);
    expect(h.coordinator.state().faults.map((f) => `${f.code}/${f.part}`)).toContain("feedback_stale/arm_left");
    await h.stop();
  });
});

describe("holding", () => {
  it("M24: a stop never writes goals to an arm whose torque is off (a servo may turn torque on for a goal)", async () => {
    const h = makeMotionHarness();
    const seen = motionEvents(h);
    await h.start();
    h.coordinator.operatorCalibrateBegin("left", "follower");
    await confirmAfterWindow(h);
    await h.clock.advance(200);
    const before = seen.length;
    h.coordinator.operatorStop();
    await h.clock.advance(500);
    expect(seen.slice(before).filter((e) => e === "sim goal-write left follower")).toEqual([]);
    await h.stop();
  });
});

describe("a blocked or loaded joint", () => {
  /** Advances in 10 ms steps until a fault for this arm and joint latches; the time it took, or null. */
  async function timeToFault(h: MotionHarness, code: string, limitMs: number): Promise<number | null> {
    const start = h.clock.monotonic();
    while (h.clock.monotonic() - start < limitMs) {
      if (h.coordinator.state().faults.some((f) => f.code === code && f.part === "arm_left" && f.joint === "elbow_flex")) return h.clock.monotonic() - start;
      await h.clock.advance(10);
    }
    return null;
  }

  it("M25: a joint blocked mid-move goes compliant within the stall window (plus the lead building and a tick), then nothing pushes it", async () => {
    const h = makeMotionHarness();
    const seen = motionEvents(h);
    await h.start();
    h.coordinator.operatorTorque(true, ["left"]);
    await confirmAfterWindow(h);
    h.coordinator.operatorGoToPose("left", "ready");
    await confirmAfterWindow(h);
    await h.clock.advance(150);
    expect(h.coordinator.state().active?.kind).toBe("arm.go_to_pose");
    const elbow = h.sim.buses.get("left/follower")!.servo(3);
    elbow.heldAt = elbow.get("presentPosition");
    // The lead first grows past 3° (the elbow ramps at 45°/s: about 67 ms), then the 300 ms window, then a tick.
    const took = await timeToFault(h, "feedback_divergence", 1500);
    expect(took).not.toBeNull();
    expect(took!).toBeGreaterThanOrEqual(STALL_WINDOW_MS);
    expect(took!).toBeLessThanOrEqual(STALL_WINDOW_MS + 67 + 2 * 20 + 10);
    expect(h.log.lines.some((l) => l.includes("feedback_divergence") && l.includes("stalled"))).toBe(true);
    await h.clock.advance(100);
    expect(seen).toContain("comply arm_left");
    // Nothing keeps pushing: goal = where it is, every joint at the compliant 25%, and no more goals sent.
    expect(Math.abs(elbow.get("goalPosition") - elbow.get("presentPosition"))).toBeLessThanOrEqual(1);
    for (const servo of h.sim.buses.get("left/follower")!.servos.values()) expect(servo.get("torqueLimit")).toBe(250);
    const before = seen.length;
    await h.clock.advance(1000);
    expect(seen.slice(before).filter((e) => e === "sim goal-write left follower")).toEqual([]);
    expect(Math.abs(elbow.get("goalPosition") - elbow.get("presentPosition"))).toBeLessThanOrEqual(1);
    await h.stop();
  });

  it("M26: a load above 80% of the joint's torque limit for the window goes compliant; a lighter one doesn't", async () => {
    const h = makeMotionHarness();
    await h.start();
    h.coordinator.operatorTorque(true, ["left"]);
    await confirmAfterWindow(h);
    await h.clock.advance(100);
    const elbow = h.sim.buses.get("left/follower")!.servo(3);
    // 40% against a 60% limit (threshold 48%): holds, no fault.
    elbow.externalLoad = 400;
    expect(await timeToFault(h, "feedback_divergence", 1000)).toBeNull();
    // 50%: over the threshold, under the limit, so the old 80% overload rule could never see it.
    elbow.externalLoad = 500;
    const took = await timeToFault(h, "feedback_divergence", 1500);
    expect(took).not.toBeNull();
    expect(took!).toBeGreaterThanOrEqual(STALL_WINDOW_MS);
    expect(took!).toBeLessThanOrEqual(STALL_WINDOW_MS + 2 * 20 + 10);
    expect(h.log.lines.some((l) => l.includes("feedback_divergence") && l.includes("load 50%"))).toBe(true);
    await h.clock.advance(100);
    for (const servo of h.sim.buses.get("left/follower")!.servos.values()) expect(servo.get("torqueLimit")).toBe(250);
    await h.stop();
  });
});

describe("read before act", () => {
  it("M27: torque on reads back the unacknowledged goal write; a servo that missed it aborts torque on, which ends off", async () => {
    const h = makeMotionHarness();
    const seen = motionEvents(h);
    await h.start();
    const fake = h.sim.buses.get("left/follower")!;
    fake.servo(4).faults.dropSyncWrites = true;
    const prepared = h.coordinator.operatorTorque(true, ["left"]);
    await confirmAfterWindow(h);
    await h.clock.advance(300);
    expect(h.log.lines.some((l) => l.includes("read-back mismatch (goal, speed, acceleration) on servo 4"))).toBe(true);
    expect(seen).not.toContain("torque left on");
    for (const servo of fake.servos.values()) expect(servo.get("torqueEnable")).toBe(0);
    expect(prepared.ok && h.coordinator.operatorRequestStatus(prepared.request.id)?.state).toBe("error");
    expect(h.coordinator.state().arms.find((a) => a.arm === "left" && a.role === "follower")?.torque).toBe("off");
    await h.stop();
  });

  it("M30: a torque limit write that doesn't take aborts torque on before any goal is written", async () => {
    const h = makeMotionHarness();
    const seen = motionEvents(h);
    await h.start();
    const fake = h.sim.buses.get("left/follower")!;
    fake.servo(2).faults.ignoreWritesTo = [48, 49];
    h.coordinator.operatorTorque(true, ["left"]);
    await h.clock.advance(2100);
    const before = seen.length;
    h.press("c");
    await h.clock.advance(300);
    expect(h.log.lines.some((l) => l.includes("read-back mismatch (torque limit) on servo 2"))).toBe(true);
    expect(seen.slice(before).filter((e) => e === "sim goal-write left follower")).toEqual([]);
    for (const servo of fake.servos.values()) expect(servo.get("torqueEnable")).toBe(0);
    await h.stop();
  });

  it("M28: a torque limit that changes under it (torque still on) ends limitsWritten: no move until torque on again", async () => {
    const h = makeMotionHarness();
    const seen = motionEvents(h);
    await h.start();
    h.coordinator.operatorTorque(true, ["left"]);
    await confirmAfterWindow(h);
    await h.clock.advance(200);
    expect(seen).toContain("torque left on");
    h.sim.buses.get("left/follower")!.servo(3).set("torqueLimit", 1000);
    await h.clock.advance(100);
    expect(seen).toContain("limits-lost left follower");
    const result = h.coordinator.operatorGoToPose("left", "ready");
    expect(result).toMatchObject({ ok: true, request: { state: "refused", refusal: "torque_off" } });
    await h.stop();
  });

  it("M29: a handle press during torque on stops it (torque ends off) and is motion's alone", async () => {
    const h = makeMotionHarness();
    const seen = motionEvents(h);
    const talk: string[] = [];
    h.bus.on("talk", ({ state }) => talk.push(state));
    await h.start();
    h.coordinator.operatorTorque(true, ["left"]);
    await h.clock.advance(2100);
    h.press("c");
    h.press("t");
    await h.clock.advance(500);
    expect(seen).toContain("stop handle_press");
    expect(seen).not.toContain("torque left on");
    for (const servo of h.sim.buses.get("left/follower")!.servos.values()) expect(servo.get("torqueEnable")).toBe(0);
    expect(talk).not.toContain("recording");
    await h.stop();
  });
});

describe("a torque off always wins over a hold", () => {
  /** Torque on the left follower, then a terminal pose; returns once it moves. */
  async function moving(h: MotionHarness): Promise<void> {
    await h.start();
    h.coordinator.operatorTorque(true, ["left"]);
    await confirmAfterWindow(h);
    h.coordinator.operatorGoToPose("left", "ready");
    await confirmAfterWindow(h);
    await h.clock.advance(100);
    expect(h.coordinator.state().active?.kind).toBe("arm.go_to_pose");
  }
  const allOff = (h: MotionHarness) => [...h.sim.buses.get("left/follower")!.servos.values()].map((s) => s.get("torqueEnable"));

  it("M32: a stop press, then an overload latched in the same turn: the hold's read is queued before the torque off, and still writes no goal after it", async () => {
    const h = makeMotionHarness();
    await moving(h);
    h.press("t");
    // Test-only reach into the guard: latch the overload now, after the stop's hold has queued its read.
    (h.coordinator as unknown as { latch: (c: string, p: string, j: string, d: string) => void }).latch("overload", "arm_left", "elbow_flex", "test");
    await h.clock.advance(500);
    expect(allOff(h)).toEqual([0, 0, 0, 0, 0, 0]);
    await h.stop();
  });

  it("M32: a stop press, then the stop switch (not cutting power, as if miswired) in the same turn: torque ends off", async () => {
    const h = makeMotionHarness();
    await moving(h);
    h.press("t");
    h.sim.stopSwitch.set("pressed");
    await h.clock.advance(500);
    expect(allOff(h)).toEqual([0, 0, 0, 0, 0, 0]);
    await h.stop();
  });

  it("M33: a stop press during a terminal torque off: the arm ends torque off", async () => {
    const h = makeMotionHarness();
    await h.start();
    h.coordinator.operatorTorque(true, ["left"]);
    await confirmAfterWindow(h);
    await h.clock.advance(100);
    h.coordinator.operatorTorque(false, ["left"]);
    await h.clock.advance(2100);
    h.press("c");
    h.press("t");
    await h.clock.advance(500);
    expect(allOff(h)).toEqual([0, 0, 0, 0, 0, 0]);
    await h.stop();
  });

  it("M34: a stop press after torque on's last write but before its read-back: torque ends off, not completed", async () => {
    const h = makeMotionHarness();
    const seen = motionEvents(h);
    await h.start();
    const fake = h.sim.buses.get("left/follower")!;
    const write = fake.write.bind(fake);
    let pressed = false;
    fake.write = async (bytes: Uint8Array) => {
      await write(bytes);
      // WRITE (3) of torque enable (address 40) = 1 to servo 6: the sequence's last write.
      if (!pressed && bytes[2] === 6 && bytes[4] === 3 && bytes[5] === 40 && bytes[6] === 1) {
        pressed = true;
        h.press("t");
      }
    };
    const prepared = h.coordinator.operatorTorque(true, ["left"]);
    await confirmAfterWindow(h);
    await h.clock.advance(500);
    expect(pressed).toBe(true);
    expect(seen).not.toContain("torque left on");
    expect(allOff(h)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(prepared.ok && h.coordinator.operatorRequestStatus(prepared.request.id)?.state).toBe("error");
    await h.stop();
  });
});

describe("each arm read on its own", () => {
  it("M36: a bus that keeps retrying (a silent servo on the right) never makes the healthy left arm stale", async () => {
    const h = makeMotionHarness();
    await h.start();
    h.coordinator.operatorTorque(true, ["left"]);
    await confirmAfterWindow(h);
    await h.clock.advance(100);
    h.sim.buses.get("right/follower")!.servo(2).faults.noReply = true;
    await h.clock.advance(1500);
    expect(h.coordinator.state().faults.filter((f) => f.part === "arm_left")).toEqual([]);
    expect(h.coordinator.state().arms.find((a) => a.arm === "left" && a.role === "follower")?.torque).toBe("on");
    await h.stop();
  });
});

describe("the Pi's own words", () => {
  it("M35: every terminal command's title fits the contract's 60 characters, so it can be prepared", async () => {
    const h = makeMotionHarness();
    await h.start();
    const tries = [
      () => h.coordinator.operatorTorque(true, null),
      () => h.coordinator.operatorTorque(false, null),
      () => h.coordinator.operatorTorque(false, ["right"]),
      () => h.coordinator.operatorTeleop("right"),
      () => h.coordinator.operatorClear("checked by hand"),
      () => h.coordinator.operatorCalibrateBegin("right", "follower"),
    ];
    for (const attempt of tries) {
      await h.clock.advance(2100);
      const result = attempt();
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }
    await h.stop();
  });
});

describe("the stop-sense input", () => {
  it("M23: pressed counts at once and latches nothing until read; released only after 30 ms; a stopped watcher reads pressed", async () => {
    const clock = new FakeClock();
    const children: Array<EventEmitter & { stdout: PassThrough; stderr: PassThrough }> = [];
    const spawnChild = (() => {
      const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), pid: 1, exitCode: null, signalCode: null, kill: () => true });
      children.push(child);
      return child;
    }) as never;
    let level = "0";
    const execFileChild = ((_c: string, _a: string[], _o: unknown, cb: (e: Error | null, out: string) => void) => cb(null, `${level}\n`)) as never;
    const stop = new GpioStopSense({ flavor: "v2", chip: "gpiochip0", line: 22 }, { clock, log: captureLogger(), spawnChild, execFileChild });
    expect(stop.reading()).toBe("pressed");
    stop.start();
    await clock.advance(10);
    expect(stop.reading()).toBe("pressed");
    await clock.advance(30);
    expect(stop.reading()).toBe("released");
    await stop.ready();
    stop.handleLine("22 rising");
    expect(stop.reading()).toBe("pressed");
    stop.handleLine("22 falling");
    await clock.advance(10);
    stop.handleLine("22 rising");
    await clock.advance(40);
    expect(stop.reading()).toBe("pressed");
    stop.handleLine("22 falling");
    await clock.advance(40);
    expect(stop.reading()).toBe("released");
    children[0]!.emit("close", 1);
    expect(stop.reading()).toBe("pressed");
    level = "1";
    expect(parseGpioget('"22"=active')).toBe("high");
    expect(parseGpioget("0")).toBe("low");
    stop.stop();
  });
});
