import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIFT_HOMING_BACKOFF_MM, MOTION_CONTRACT_VERSION, type LiftConfig, type LiftInstallation, type MotionState } from "@walker/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { Bus } from "../src/bus";
import { MotionFiles } from "../src/motion/files";
import type { LiftEvent } from "../src/motion/lift";
import { OperatorClient, OperatorSocket } from "../src/motion/operator";
import { createPiMotion } from "../src/motion/runtime";
import { SIM_LIFT_CONFIG } from "../src/sim/fakeLift";
import { SIM_LIFT_INSTALLATION, SIM_LOW_HEIGHT_MM, SIM_TRAY_HEIGHT_MM } from "../src/sim/liftSim";
import { FakeClock, captureLogger } from "./support/fakes";
import { makeMotionHarness, type MotionHarness } from "./support/motion";

/**
 * Rows E1 to E15 of test/EXPECTED.md: the lift under the real motion coordinator, with the SIMULATED lift board
 * (src/sim/fakeLift.ts) and SIMULATED servos, on a fake clock. Every motion state published must pass the
 * contract's MotionStateSchema. Nothing here is a hardware result.
 */

type PiLine = { at: number; line: Record<string, unknown> };

async function lifted(
  options: {
    bench?: boolean;
    liftConfig?: LiftConfig;
    liftInstallation?: LiftInstallation;
    boardStopSense?: "wired" | "not_wired";
    stopSense?: "switch" | "not_wired";
  } = {},
) {
  const h = makeMotionHarness({ lift: true, ...options, bench: options.bench ?? false });
  const events: string[] = [];
  h.bus.on("motion", ({ kind, text }) => events.push(`${kind} ${text}`));
  h.bus.on("lift", ({ kind, text }) => events.push(`sim-lift ${kind} ${text}`));
  const piLines: PiLine[] = [];
  const lift = h.lift!;
  const original = lift.port.onPiLine;
  lift.port.onPiLine = (text) => {
    for (const line of text.split("\n").filter(Boolean)) piLines.push({ at: h.clock.monotonic(), line: JSON.parse(line) as Record<string, unknown> });
    original(text);
  };
  await h.start();
  const t = {
    h,
    events,
    piLines,
    lift,
    clock: h.clock,
    coordinator: h.coordinator,
    key(name: string) {
      h.press(name);
    },
    /** Steps the clock 10 ms at a time (a chain of fake-bus exchanges under one big advance turns into timeouts). */
    async wait(ms: number) {
      const end = h.clock.monotonic() + ms;
      while (h.clock.monotonic() < end) await h.clock.advance(Math.min(10, end - h.clock.monotonic()));
    },
    async until(pred: () => boolean, maxMs: number) {
      const end = h.clock.monotonic() + maxMs;
      while (!pred() && h.clock.monotonic() < end) await h.clock.advance(10);
      return pred();
    },
    saw(text: string) {
      return events.some((e) => e.includes(text));
    },
    count(text: string) {
      return events.filter((e) => e.includes(text)).length;
    },
    /** Lines written to the lift's port since `from` (an index into them), as written (before the board reads them). */
    written(from: number, type: string) {
      return lift.port.received
        .slice(from)
        .flatMap((text) => text.split("\n").filter(Boolean))
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.type === type);
    },
    since(mark: number) {
      return events.slice(mark);
    },
    state(): MotionState {
      return h.coordinator.state();
    },
    liftState() {
      return h.coordinator.state().lift!;
    },
    /** A key that prepares a target, then the Confirm press once CONFIRM_ARM_DELAY_MS has passed. */
    async confirm(key: string) {
      t.key(key);
      await t.wait(2100);
      t.key("c");
    },
    /** Both arms' motors on (each Confirmed): the SIMULATED arms start folded, so they then count as stowed. */
    async armsOn() {
      const left = t.count("torque left on");
      const right = t.count("torque right on");
      await t.confirm("torque-on-left");
      expect(await t.until(() => t.count("torque left on") > left, 3000)).toBe(true);
      await t.confirm("torque-on-right");
      expect(await t.until(() => t.count("torque right on") > right, 3000)).toBe(true);
    },
    /** Holds the screen's control, homes, and waits for it to complete. */
    async homed() {
      await t.armsOn();
      t.key("lift-hold-on");
      await t.confirm("lift-home");
      expect(await t.until(() => t.saw("lift ended lift.home"), 40_000)).toBe(true);
      expect(events).toContain("lift ended lift.home completed");
      await t.wait(100);
    },
    async raised(mm = SIM_TRAY_HEIGHT_MM) {
      t.key("lift-hold-on");
      await t.confirm(mm === SIM_TRAY_HEIGHT_MM ? "lift-up" : "lift-down");
      expect(await t.until(() => t.saw(`lift ended lift.move`), 40_000)).toBe(true);
      await t.wait(100);
    },
    pi(type: string, from = 0) {
      return piLines.filter((p) => p.at >= from && p.line.type === type);
    },
  };
  harnesses.push(h);
  return t;
}

const harnesses: MotionHarness[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    expect(h.invalid, h.log.lines.slice(-20).join("\n")).toEqual([]);
    await h.stop();
  }
});

describe("E1: home and move, held on the screen, started by a Confirm press", () => {
  it("prepares lift.home from the terminal; the Confirm press with the hold held homes it; a release mid-move stops it for good", async () => {
    const t = await lifted();
    await t.armsOn();
    const prepared = t.coordinator.operatorLiftHome();
    expect(prepared.ok && prepared.request.state).toBe("waiting_confirm");
    const target = t.state().confirm_target!;
    expect(target.action).toEqual({ kind: "lift.home" });
    expect(target.prompt).toBe("Home the lift. Park the walker and lock the brakes, then press Confirm.");
    // Nothing goes to the lift before the press.
    expect(t.pi("lift.home")).toEqual([]);
    t.key("lift-hold-on");
    await t.wait(2100);
    t.key("c");
    expect(t.saw("command lift.home started operator_cli")).toBe(true);
    await t.wait(40);
    const running = t.state().active!;
    expect(running).toMatchObject({ kind: "lift.home", phase: "running", hold_source: "screen_hold_control" });
    expect(t.state().mode).toBe("moving");
    expect(await t.until(() => t.saw("lift ended lift.home"), 40_000)).toBe(true);
    expect(t.events).toContain("lift ended lift.home completed");
    await t.wait(100);
    expect(t.liftState()).toMatchObject({ connected: true, homed: true });
    expect(t.liftState().position_mm).toBeCloseTo(LIFT_HOMING_BACKOFF_MM, 1);
    expect(t.state().last_command).toMatchObject({ kind: "lift.home", outcome: "completed" });
    expect(t.state().mode).toBe("ready");

    // Raise, and let go halfway: a heartbeat naming nobody within one tick; it ramps down; stopped; never resumes.
    await t.confirm("lift-up");
    expect(await t.until(() => (t.liftState().position_mm ?? 0) >= 150, 30_000)).toBe(true);
    const releasedAt = t.clock.monotonic();
    t.key("lift-hold-off");
    await t.wait(30);
    expect(t.state().active).toMatchObject({ kind: "lift.move", phase: "stopping", hold_source: null });
    expect(await t.until(() => t.saw("lift ended lift.move"), 2000)).toBe(true);
    expect(t.events).toContain("lift ended lift.move stopped");
    const after = t.pi("lift.heartbeat", releasedAt);
    expect(after[0]!.at - releasedAt).toBeLessThanOrEqual(20);
    expect(after.every((p) => p.line.hold_request_id === null)).toBe(true);
    await t.wait(100);
    const stoppedAt = t.liftState().position_mm!;
    expect(stoppedAt).toBeGreaterThan(150);
    expect(stoppedAt).toBeLessThan(SIM_TRAY_HEIGHT_MM);
    expect(t.liftState().homed).toBe(true);
    expect(t.state()).toMatchObject({ mode: "ready", active: null, last_command: { kind: "lift.move", outcome: "stopped" } });
    t.key("lift-hold-on");
    await t.wait(1000);
    expect(t.liftState().position_mm).toBeCloseTo(stoppedAt, 6);
    expect(t.pi("lift.heartbeat", releasedAt).every((p) => p.line.hold_request_id === null)).toBe(true);
  }, 60_000);
});

describe("E2: the Confirm press needs the screen's hold control held", () => {
  it("a press with nothing held is refused not_held, and nothing goes to the lift", async () => {
    const t = await lifted();
    await t.armsOn();
    await t.confirm("lift-home");
    expect(t.state().last_command).toMatchObject({ kind: "lift.home", outcome: "refused", refusal: "not_held" });
    expect(t.saw("command lift.home refused:not_held operator_cli")).toBe(true);
    await t.wait(500);
    expect(t.pi("lift.home")).toEqual([]);
    expect(t.state()).toMatchObject({ mode: "ready", active: null, confirm_target: null });
  }, 30_000);

  it("a hold let go between the press and the first control tick: refused not_held and never sent", async () => {
    const t = await lifted();
    await t.armsOn();
    t.key("lift-hold-on");
    t.key("lift-home");
    await t.wait(2100);
    t.key("c");
    // The release lands before the next tick: the client ends the queued request without writing it.
    t.key("lift-hold-off");
    await t.wait(100);
    expect(t.pi("lift.home")).toEqual([]);
    expect(t.state()).toMatchObject({ active: null, last_command: { kind: "lift.home", outcome: "refused", refusal: "not_held" } });
  }, 30_000);
});

describe("E3: the arms must be stowed (torque on, at their stowed pose) before the lift moves", () => {
  it("refused arms_not_stowed at once (no target) with the motors off, and with an arm out; prepared once stowed", async () => {
    const t = await lifted();
    const off = t.coordinator.operatorLiftHome();
    expect(off.ok && off.request).toMatchObject({ state: "refused", refusal: "arms_not_stowed" });
    expect(off.ok && off.request.detail).toContain("isn't holding with its motors on");
    expect(t.state().confirm_target).toBeNull();
    await t.homed();
    t.key("lift-hold-off");
    await t.confirm("pose-ready-left");
    expect(await t.until(() => t.saw("command arm.go_to_pose completed"), 8000)).toBe(true);
    const out = t.coordinator.operatorLiftMove(SIM_TRAY_HEIGHT_MM);
    expect(out.ok && out.request).toMatchObject({ state: "refused", refusal: "arms_not_stowed" });
    expect(out.ok && out.request.detail).toMatch(/^the left arm's \w+ is [\d.]+° from stowed: walker arms pose go stowed --arm left$/);
    expect(t.state().confirm_target).toBeNull();
    expect(t.state().last_command).toMatchObject({ kind: "lift.move", outcome: "refused", refusal: "arms_not_stowed" });
    await t.confirm("pose-stowed-left");
    expect(await t.until(() => t.events.filter((e) => e.startsWith("command arm.go_to_pose completed")).length === 2, 8000)).toBe(true);
    const ok = t.coordinator.operatorLiftMove(SIM_TRAY_HEIGHT_MM);
    expect(ok.ok && ok.request.state).toBe("waiting_confirm");
    expect(t.state().confirm_target!.title).toBe(`Raise the lift to ${SIM_TRAY_HEIGHT_MM} mm`);
  }, 60_000);

  it("a move outside the soft limits is refused out_of_range; before homing, lift_not_homed", async () => {
    const t = await lifted();
    await t.armsOn();
    const unhomed = t.coordinator.operatorLiftMove(100);
    expect(unhomed.ok && unhomed.request).toMatchObject({ state: "refused", refusal: "lift_not_homed" });
    await t.homed();
    const high = t.coordinator.operatorLiftMove(900);
    expect(high.ok && high.request).toMatchObject({ state: "refused", refusal: "out_of_range" });
  }, 60_000);
});

describe("E4: a handle press stops the lift", () => {
  for (const button of ["t", "c"] as const) {
    it(`a ${button === "t" ? "Talk" : "Confirm"} press mid-move: lift.stop at once, it ramps down, stopped, still homed`, async () => {
      const t = await lifted();
      await t.homed();
      await t.confirm("lift-up");
      expect(await t.until(() => (t.liftState().position_mm ?? 0) >= 100, 30_000)).toBe(true);
      const from = t.lift.port.received.length;
      t.key(button);
      expect(t.saw("stop handle_press")).toBe(true);
      // The stop is written in the same moment, not at the next tick.
      expect(t.written(from, "lift.stop")).toHaveLength(1);
      expect(t.state().active).toMatchObject({ kind: "lift.move", phase: "stopping", hold_source: null });
      expect(await t.until(() => t.saw("lift ended lift.move"), 2000)).toBe(true);
      expect(t.events).toContain("lift ended lift.move stopped");
      await t.wait(100);
      expect(t.state()).toMatchObject({ mode: "ready", active: null, last_command: { kind: "lift.move", outcome: "stopped" }, faults: [] });
      expect(t.liftState().homed).toBe(true);
      expect(t.liftState().position_mm!).toBeLessThan(150);
      expect(t.state().confirm_target).toBeNull();
    }, 60_000);
  }

  it("the terminal's stop and a stop with nothing moving both send lift.stop", async () => {
    const t = await lifted();
    await t.homed();
    const idle = t.lift.port.received.length;
    t.coordinator.operatorStop();
    expect(t.written(idle, "lift.stop")).toHaveLength(1);
    await t.confirm("lift-up");
    await t.wait(1000);
    const at = t.lift.port.received.length;
    t.key("lift-stop");
    expect(t.written(at, "lift.stop")).toHaveLength(1);
    expect(await t.until(() => t.saw("lift ended lift.move stopped"), 2000)).toBe(true);
  }, 60_000);
});

describe("E5: the stop switch stops both the arms and the lift", () => {
  it("mid-move: stop_circuit_opened from the Pi and from the lift, arms limp, the lift unhomed; clear only once released", async () => {
    const t = await lifted();
    await t.homed();
    await t.confirm("lift-up");
    expect(await t.until(() => (t.liftState().position_mm ?? 0) >= 100, 30_000)).toBe(true);
    t.key("lift-stop-switch");
    expect(await t.until(() => t.saw("lift ended lift.move"), 1000)).toBe(true);
    expect(t.events).toContain("lift ended lift.move failed stop_circuit_opened");
    const faults = t.state().faults.map((f) => `${f.code}/${f.part}`);
    expect(faults).toContain("stop_circuit_opened/system");
    expect(faults).toContain("stop_circuit_opened/lift");
    expect(t.state()).toMatchObject({ mode: "fault", active: null });
    expect(t.state().last_command).toMatchObject({ kind: "lift.move", outcome: "faulted" });
    expect(t.liftState().homed).toBe(false);
    expect(t.lift.board.inspect().activity).toBe("none");
    await t.wait(200);
    expect(t.state().arms.filter((a) => a.role === "follower").every((a) => a.torque !== "on")).toBe(true);
    const early = t.coordinator.operatorClear("checked");
    expect(early.ok && early.request).toMatchObject({ state: "refused", refusal: "cause_present" });
    t.key("lift-stop-switch");
    await t.wait(500);
    await t.confirm("operator-clear");
    expect(await t.until(() => t.saw("lift clear cleared"), 2000)).toBe(true);
    await t.wait(100);
    expect(t.state().faults).toEqual([]);
    expect(t.state().mode).toBe("ready");
    await t.armsOn();
    const move = t.coordinator.operatorLiftMove(SIM_TRAY_HEIGHT_MM);
    expect(move.ok && move.request).toMatchObject({ state: "refused", refusal: "lift_not_homed" });
  }, 90_000);

  it("the lift's faults stay latched until the lift itself accepts lift.clear", async () => {
    const t = await lifted();
    await t.homed();
    t.key("lift-stop-switch");
    await t.wait(300);
    t.key("lift-stop-switch");
    await t.wait(500);
    t.coordinator.operatorClear("checked");
    await t.wait(2100);
    // The line to the lift board is down when Confirm clears: the Pi's own faults clear, the lift's stay.
    t.lift.board.dropToLift = true;
    t.key("c");
    expect(t.saw("cleared all but the lift's (stop_circuit_opened): asking the lift")).toBe(true);
    expect(t.state().faults.map((f) => `${f.code}/${f.part}`)).toEqual(["stop_circuit_opened/lift"]);
    await t.wait(1000);
    expect(t.saw("lift clear no_ack")).toBe(true);
    expect(t.state().faults.map((f) => `${f.code}/${f.part}`)).toEqual(["stop_circuit_opened/lift"]);
    expect(t.state().mode).toBe("fault");
  }, 60_000);
});

describe("E6: the lift module lost, a frozen board, a stalled loop", () => {
  it("lift_module_lost latches (hold), heartbeats stop, the lift stops, unhomed; clear refused until it is heard again", async () => {
    const t = await lifted();
    await t.homed();
    await t.confirm("lift-up");
    await t.wait(1000);
    t.key("lift-lost-line");
    expect(await t.until(() => t.state().faults.some((f) => f.code === "lift_module_lost"), 500)).toBe(true);
    const lostAt = t.clock.monotonic();
    expect(t.state().faults.find((f) => f.code === "lift_module_lost")!.part).toBe("lift");
    expect(t.state()).toMatchObject({ mode: "fault", active: null, last_command: { kind: "lift.move", outcome: "faulted" } });
    expect(await t.until(() => t.lift.board.inspect().activity === "none", 500)).toBe(true);
    await t.wait(500);
    expect(t.pi("lift.heartbeat", lostAt)).toEqual([]);
    expect(t.liftState()).toMatchObject({ connected: false, homed: false });
    // The arms hold (FAULT_REACTION hold): torque stays on.
    expect(t.state().arms.filter((a) => a.role === "follower").every((a) => a.torque === "on")).toBe(true);
    const early = t.coordinator.operatorClear("checked");
    expect(early.ok && early.request).toMatchObject({ state: "refused", refusal: "cause_present" });
    t.key("lift-lost-line");
    expect(await t.until(() => t.liftState().connected, 3000)).toBe(true);
    await t.confirm("operator-clear");
    await t.wait(500);
    expect(t.state()).toMatchObject({ mode: "ready", faults: [] });
    expect(t.liftState().homed).toBe(false);
    const move = t.coordinator.operatorLiftMove(SIM_TRAY_HEIGHT_MM);
    expect(move.ok && move.request).toMatchObject({ state: "refused", refusal: "lift_not_homed" });
  }, 60_000);

  it("both directions lost: no stop arrives, and the lift's own watchdog stops it and latches watchdog_expired", async () => {
    const t = await lifted();
    await t.homed();
    await t.confirm("lift-up");
    await t.wait(1000);
    t.lift.board.dropToLift = true;
    t.key("lift-lost-line");
    const lostAt = t.clock.monotonic();
    expect(await t.until(() => t.lift.board.inspect().faults.includes("watchdog_expired"), 1000)).toBe(true);
    expect(t.clock.monotonic() - lostAt).toBeLessThanOrEqual(300 + 100 + 150);
    expect(t.lift.board.inspect()).toMatchObject({ activity: "none", driverEnabled: true, homed: false });
    expect(t.state().faults.map((f) => f.code)).toContain("lift_module_lost");
  }, 60_000);

  it("a frozen board: lost within LIFT_STATUS_STALE_MS, back unhomed once it restarts", async () => {
    const t = await lifted();
    await t.homed();
    await t.confirm("lift-up");
    await t.wait(500);
    t.key("lift-freeze");
    expect(await t.until(() => t.state().faults.some((f) => f.code === "lift_module_lost"), 400)).toBe(true);
    expect(await t.until(() => t.liftState().connected, 5000 + 3000)).toBe(true);
    expect(t.liftState()).toMatchObject({ homed: false });
  }, 60_000);

  it("the control loop stops calling the lift mid-move: the lift's watchdog stops it; the Pi latches it and unhomes", async () => {
    const t = await lifted();
    await t.homed();
    await t.confirm("lift-up");
    await t.wait(1000);
    t.key("lift-pause-ticks");
    const pausedAt = t.clock.monotonic();
    expect(await t.until(() => t.lift.board.inspect().faults.includes("watchdog_expired"), 2000)).toBe(true);
    expect(t.clock.monotonic() - pausedAt).toBeLessThanOrEqual(300 + 100 + 150);
    expect(await t.until(() => t.state().faults.some((f) => f.code === "watchdog_expired" && f.part === "lift"), 500)).toBe(true);
    expect(t.events).toContain("lift ended lift.move failed watchdog_expired");
    expect(t.liftState().homed).toBe(false);
    t.key("lift-pause-ticks");
  }, 60_000);
});

describe("E7: one motion and one Confirm target at a time", () => {
  it("a lift target pending: a skill can't replace it in its first 2 s; while the lift moves, an arm command is refused busy", async () => {
    const t = await lifted();
    await t.homed();
    t.coordinator.operatorLiftMove(SIM_TRAY_HEIGHT_MM);
    const liftTarget = t.state().confirm_target!;
    const skill = t.coordinator.operatorSkillRun("sim_sample_handover");
    expect(skill.ok && skill.request).toMatchObject({ state: "refused", refusal: "confirm_busy" });
    expect(t.state().confirm_target!.target_id).toBe(liftTarget.target_id);
    await t.wait(2100);
    t.key("c");
    await t.wait(500);
    expect(t.state().active).toMatchObject({ kind: "lift.move", phase: "running" });
    const pose = t.coordinator.operatorGoToPose("left", "ready");
    expect(pose.ok && pose.request).toMatchObject({ state: "refused", refusal: "busy" });
    const again = t.coordinator.operatorLiftHome();
    expect(again.ok && again.request).toMatchObject({ state: "refused", refusal: "busy" });
    expect(t.state().confirm_target).toBeNull();
  }, 60_000);

  it("a skill pending: a lift target can't replace it in its first 2 s, nor after while an arm is out; a running skill refuses the lift busy", async () => {
    const t = await lifted();
    await t.homed();
    await t.raised();
    t.key("lift-hold-off");
    await t.confirm("pose-ready-left");
    expect(await t.until(() => t.saw("command arm.go_to_pose completed"), 8000)).toBe(true);
    t.key("skill-run-sample");
    const skillTarget = t.state().confirm_target!;
    expect(skillTarget.action).toEqual({ kind: "skill.run", skill_id: "sim_sample_handover" });
    const early = t.coordinator.operatorLiftHome();
    expect(early.ok && early.request).toMatchObject({ state: "refused", refusal: "confirm_busy" });
    await t.wait(2100);
    const late = t.coordinator.operatorLiftMove(SIM_LOW_HEIGHT_MM);
    expect(late.ok && late.request).toMatchObject({ state: "refused", refusal: "arms_not_stowed" });
    expect(t.state().confirm_target!.target_id).toBe(skillTarget.target_id);
    t.key("c");
    expect(t.saw("command skill.run started operator_cli")).toBe(true);
    const during = t.coordinator.operatorLiftHome();
    expect(during.ok && during.request).toMatchObject({ state: "refused", refusal: "busy" });
  }, 90_000);
});

describe("E8: a taught skill runs only with the lift homed and at the height it was taught at", () => {
  it("lift_not_homed, then lift_not_at_height with the command that fixes it", async () => {
    const t = await lifted();
    await t.armsOn();
    await t.confirm("pose-ready-left");
    expect(await t.until(() => t.saw("command arm.go_to_pose completed"), 8000)).toBe(true);
    const unhomed = t.coordinator.operatorSkillRun("sim_sample_handover");
    expect(unhomed.ok && unhomed.request).toMatchObject({ state: "refused", refusal: "lift_not_homed" });
    await t.confirm("pose-stowed-left");
    expect(await t.until(() => t.events.filter((e) => e.startsWith("command arm.go_to_pose completed")).length === 2, 8000)).toBe(true);
    t.key("lift-hold-on");
    await t.confirm("lift-home");
    expect(await t.until(() => t.saw("lift ended lift.home completed"), 40_000)).toBe(true);
    await t.confirm("pose-ready-left");
    expect(await t.until(() => t.events.filter((e) => e.startsWith("command arm.go_to_pose completed")).length === 3, 8000)).toBe(true);
    const low = t.coordinator.operatorSkillRun("sim_sample_handover");
    expect(low.ok && low.request).toMatchObject({ state: "refused", refusal: "lift_not_at_height" });
    expect(low.ok && low.request.detail).toBe(`the lift is at ${LIFT_HOMING_BACKOFF_MM} mm; this movement was taught at ${SIM_TRAY_HEIGHT_MM} mm: walker lift move ${SIM_TRAY_HEIGHT_MM}`);
  }, 90_000);
});

describe("E14: any fault mid-move stops the lift (a hand control lost, an arm's stale feedback, a repeat), and Let go? after the tray skill", () => {
  it("an arm's servo stops answering mid lift move: feedback_stale on that arm, and the lift gets lift.stop at once", async () => {
    const t = await lifted();
    await t.homed();
    await t.confirm("lift-up");
    expect(await t.until(() => (t.liftState().position_mm ?? 0) >= 50, 30_000)).toBe(true);
    const from = t.lift.port.received.length;
    t.key("stale-left");
    expect(await t.until(() => t.state().faults.some((f) => f.code === "feedback_stale" && f.part === "arm_left"), 1000)).toBe(true);
    expect(t.written(from, "lift.stop").length).toBeGreaterThan(0);
    expect(await t.until(() => t.lift.board.inspect().activity === "none", 1000)).toBe(true);
    expect(t.state()).toMatchObject({ mode: "fault", active: null, last_command: { kind: "lift.move", outcome: "faulted" } });
    t.key("stale-left");
  }, 60_000);

  it("the coordinator's lift motion with no request left in the client (no ended seen): lift.stop, lift_unhomed, unhomed", async () => {
    const t = await lifted();
    await t.homed();
    await t.confirm("lift-up");
    expect(await t.until(() => (t.liftState().position_mm ?? 0) >= 50, 30_000)).toBe(true);
    // Simulated inconsistency: the client stops reporting the request without an `ended` event.
    t.lift.client.active = () => null;
    const from = t.lift.port.received.length;
    await t.wait(40);
    expect(t.state().faults.map((f) => `${f.code}/${f.part}`)).toContain("lift_unhomed/lift");
    expect(t.written(from, "lift.stop").length).toBeGreaterThan(0);
    expect(t.state()).toMatchObject({ mode: "fault", active: null });
    expect(await t.until(() => t.lift.board.inspect().activity === "none", 1000)).toBe(true);
  }, 60_000);

  it("a fault already latched, repeated while the lift still moves (it can't hear the first stop), sends lift.stop again", async () => {
    const t = await lifted();
    await t.homed();
    await t.confirm("lift-up");
    expect(await t.until(() => (t.liftState().position_mm ?? 0) >= 50, 30_000)).toBe(true);
    // The line to the lift goes, so the first stop is lost; the Pi's own stop input (only) reads pressed, so
    // stop_circuit_opened latches and repeats every tick.
    t.lift.board.dropToLift = true;
    const from = t.lift.port.received.length;
    t.h.sim.stopSwitch.set("pressed");
    await t.wait(250);
    // The first latch's stop, then a repeat at most every 100 ms while the lift reports itself moving.
    const whileMoving = t.written(from, "lift.stop").length;
    expect(whileMoving).toBeGreaterThanOrEqual(2);
    expect(whileMoving).toBeLessThanOrEqual(4);
    // Once the lift reports itself stopped (its own watchdog), the repeats stop; only the client's bounded
    // resends of the unacked stops (LIFT_STOP_RETRIES each, for these and the faults the lift then reports)
    // follow, and then nothing.
    expect(await t.until(() => t.liftState().moving === false, 1000)).toBe(true);
    await t.wait(2500);
    const settled = t.written(from, "lift.stop").length;
    expect(settled).toBeLessThanOrEqual(40);
    await t.wait(1000);
    expect(t.written(from, "lift.stop").length).toBe(settled);
  }, 60_000);

  it("the handle unplugged mid-move: hand_controls_lost latches and the lift gets lift.stop at once, held or not", async () => {
    const t = await lifted();
    await t.homed();
    await t.confirm("lift-up");
    expect(await t.until(() => (t.liftState().position_mm ?? 0) >= 50, 30_000)).toBe(true);
    const from = t.lift.port.received.length;
    t.key("hand-unplug");
    await t.wait(20);
    expect(t.state().faults.map((f) => f.code)).toContain("hand_controls_lost");
    expect(t.written(from, "lift.stop").length).toBeGreaterThan(0);
    // The screen's control is still held, but the lift stops for the fault.
    expect(await t.until(() => t.lift.board.inspect().activity === "none", 1000)).toBe(true);
    const at = t.liftState().position_mm!;
    await t.wait(1000);
    expect(t.liftState().position_mm).toBeCloseTo(at, 6);
  }, 60_000);

  it("Let go? after the tray skill completes holding opens the hand without grasp_mismatch, however slowly it opens", async () => {
    const t = await lifted();
    await t.homed();
    await t.raised();
    t.key("lift-hold-off");
    await t.confirm("pose-ready-left");
    expect(await t.until(() => t.saw("command arm.go_to_pose completed"), 8000)).toBe(true);
    t.key("object-left");
    await t.confirm("skill-run-sample");
    expect(await t.until(() => t.saw("command skill.run completed"), 10_000)).toBe(true);
    expect(t.state().confirm_target?.action.kind).toBe("gripper.release");
    // She takes it; the gripper opens slower than asked (a stiff gripper, about 15°/s, still inside the deadline):
    // opening moves it away from where the skill had it on purpose, which is not the hand meeting something it
    // wasn't taught to hold. (Before the fix, grasp_mismatch latched here, as it did once in a real-time run.)
    t.key("object-left");
    t.h.sim.buses.get("left/follower")!.servo(6).slowTo = 171;
    await t.wait(2100);
    t.key("c");
    expect(await t.until(() => t.saw("command gripper.release completed walker_local") || t.state().faults.length > 0, 15_000)).toBe(true);
    expect(t.state().faults).toEqual([]);
  }, 90_000);
});

describe("E15: the lift's own configuration, installation record and hardware stop", () => {
  it("lift.json's configuration differs from the board's: lift_config_mismatch latches; every lift target refused; the clear refused while it differs", async () => {
    const t = await lifted({ liftConfig: { ...SIM_LIFT_CONFIG, soft_max_mm: 590 } });
    expect(await t.until(() => t.state().faults.some((f) => f.code === "lift_config_mismatch" && f.part === "lift"), 1000)).toBe(true);
    await t.armsOn().catch(() => {});
    const home = t.coordinator.operatorLiftHome();
    expect(home.ok && home.request).toMatchObject({ state: "refused", refusal: "fault_latched" });
    const clear = t.coordinator.operatorClear("checked");
    expect(clear.ok && clear.request).toMatchObject({ state: "refused", refusal: "cause_present" });
    expect(t.pi("lift.home")).toEqual([]);
  }, 30_000);

  it("outside bench mode, no guards or no drop test refuses the lift (lift_guards_missing, lift_drop_test_missing)", async () => {
    const noGuards = await lifted({ liftInstallation: { ...SIM_LIFT_INSTALLATION, guards_fitted: false } });
    await noGuards.armsOn();
    const a = noGuards.coordinator.operatorLiftHome();
    expect(a.ok && a.request).toMatchObject({ state: "refused", refusal: "lift_guards_missing" });
    const noDrop = await lifted({ liftInstallation: { ...SIM_LIFT_INSTALLATION, drop_test: "not_done" } });
    await noDrop.armsOn();
    const b = noDrop.coordinator.operatorLiftHome();
    expect(b.ok && b.request).toMatchObject({ state: "refused", refusal: "lift_drop_test_missing" });
  }, 60_000);

  it("bench mode waives the installation checks only: the lift still refuses its over-limit homing, and never moves without the hardware stop", async () => {
    const t = await lifted({ bench: true, liftInstallation: { ...SIM_LIFT_INSTALLATION, guards_fitted: false, drop_test: "not_done" } });
    await t.armsOn();
    const home = t.coordinator.operatorLiftHome();
    expect(home.ok && home.request).toMatchObject({ state: "refused", refusal: "lift_over_limits" });
    expect(home.ok && home.request.sentence).toBe("The lift's built-in speed is above this mode's limit, so it won't move.");
    // The board built without its stop-sense: the arms still move in bench mode; the lift doesn't.
    const noStop = await lifted({ bench: true, boardStopSense: "not_wired" });
    await noStop.armsOn();
    const lift = noStop.coordinator.operatorLiftHome();
    expect(lift.ok && lift.request).toMatchObject({ state: "refused", refusal: "no_hardware_stop" });
    // The Pi's stop not wired (WALKER_STOP_SENSE=not_wired) in bench mode: arms yes, lift no.
    const noPiStop = await lifted({ bench: true, stopSense: "not_wired" });
    await noPiStop.armsOn();
    expect(noPiStop.state().stop_circuit).toBe("not_wired");
    const pose = noPiStop.coordinator.operatorGoToPose("left", "ready");
    expect(pose.ok && pose.request.state).toBe("waiting_confirm");
    noPiStop.coordinator.operatorStop();
    await noPiStop.wait(2100);
    const piLift = noPiStop.coordinator.operatorLiftHome();
    expect(piLift.ok && piLift.request).toMatchObject({ state: "refused", refusal: "no_hardware_stop" });
  }, 90_000);
});

describe("E16: the service stopping and the terminal going away during a lift move", () => {
  it("SIGTERM (the coordinator stopping) mid-move: lift.stop at once, then no heartbeat; the lift stops", async () => {
    const t = await lifted();
    await t.homed();
    await t.confirm("lift-up");
    expect(await t.until(() => (t.liftState().position_mm ?? 0) >= 50, 30_000)).toBe(true);
    const from = t.lift.port.received.length;
    const stopping = t.coordinator.stop();
    expect(t.written(from, "lift.stop")).toHaveLength(1);
    await t.wait(400);
    await stopping;
    const after = t.lift.port.received.length;
    await t.wait(500);
    expect(t.written(after, "lift.heartbeat")).toEqual([]);
    expect(t.lift.board.inspect().activity).toBe("none");
  }, 60_000);

  it("the terminal that started a lift move goes away (its socket closes): the lift stops", async () => {
    const t = await lifted();
    await t.homed();
    const path = join(mkdtempSync(join(tmpdir(), "lift-op-")), "m.sock");
    const socket = new OperatorSocket(path, t.coordinator, t.h.log);
    await socket.listen();
    const client = await OperatorClient.connect(path);
    try {
      const reply = (await client.send({ op: "lift.move", target_mm: SIM_TRAY_HEIGHT_MM })) as { ok: boolean; request: { state: string } };
      expect(reply.ok && reply.request.state).toBe("waiting_confirm");
      await t.wait(2100);
      t.key("c");
      expect(await t.until(() => (t.liftState().position_mm ?? 0) >= 50, 30_000)).toBe(true);
      client.close();
      for (let i = 0; i < 100 && !t.saw("stop operator_cli"); i += 1) {
        await new Promise((r) => setTimeout(r, 10));
        await t.wait(10);
      }
      expect(t.saw("stop operator_cli")).toBe(true);
      expect(await t.until(() => t.saw("lift ended lift.move stopped"), 2000)).toBe(true);
    } finally {
      socket.close();
    }
  }, 60_000);
});

describe("E17: the lift file (lift.json) and why there is no lift", () => {
  const files = () => new MotionFiles(mkdtempSync(join(tmpdir(), "walker-lift-file-")), captureLogger());
  const good = { format: "sophi.lift", version: MOTION_CONTRACT_VERSION, config: SIM_LIFT_CONFIG, installation: SIM_LIFT_INSTALLATION };

  it("missing, ok, not JSON, failing the schema, an old version: each read as such", () => {
    const f = files();
    expect(f.readLift()).toEqual({ kind: "missing" });
    f.writeLift({ config: SIM_LIFT_CONFIG, installation: SIM_LIFT_INSTALLATION });
    expect(f.readLift()).toEqual({ kind: "ok", setup: { config: SIM_LIFT_CONFIG, installation: SIM_LIFT_INSTALLATION } });
    writeFileSync(f.liftPath(), "{ not json");
    expect(f.readLift()).toEqual({ kind: "invalid", reason: "lift.json is malformed: it isn't JSON" });
    writeFileSync(f.liftPath(), JSON.stringify({ ...good, config: { ...SIM_LIFT_CONFIG, max_speed_mm_s: 80 } }));
    expect(f.readLift()).toMatchObject({ kind: "invalid", reason: expect.stringMatching(/^lift\.json is malformed \(config\.max_speed_mm_s: /) });
    writeFileSync(f.liftPath(), JSON.stringify({ ...good, version: 1 }));
    expect(f.readLift()).toMatchObject({ kind: "invalid", reason: expect.stringContaining("version") });
    // An installation record no lift may have (the stop cutting power without a drop test or brake).
    writeFileSync(f.liftPath(), JSON.stringify({ ...good, installation: { ...SIM_LIFT_INSTALLATION, drop_test: "not_done", stop_cuts_lift_power: true } }));
    expect(f.readLift().kind).toBe("invalid");
  });

  it("createPiMotion: a malformed lift.json means no lift, and a lift target says it is malformed, not missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "walker-lift-run-"));
    const log = captureLogger();
    new MotionFiles(dir, log);
    writeFileSync(join(dir, "motion", "lift.json"), "{ not json");
    const handlers: unknown[] = [];
    const motion = createPiMotion({
      settings: { arms: [], stopSense: { kind: "not_wired" }, bench: false },
      stateDir: dir,
      runtimeDir: dir,
      clock: new FakeClock(),
      log,
      bus: new Bus(),
      modules: { setLiftHandler: (h) => handlers.push(h) },
      gpio: { flavor: "v1", chip: "gpiochip0" },
      handControls: () => true,
      walkerProposalOpen: () => false,
      say: () => {},
    });
    expect(motion.lift).toBeNull();
    expect(handlers).toEqual([]);
    expect(log.lines.some((l) => l.includes("the lift is off") && l.includes("malformed"))).toBe(true);
    const home = motion.coordinator.operatorLiftHome();
    expect(home.ok && home.request).toMatchObject({ refusal: "part_missing", detail: "this walker has no lift: lift.json is malformed: it isn't JSON" });
    // A good file: the client is built and registered for lift ports.
    writeFileSync(join(dir, "motion", "lift.json"), JSON.stringify(good));
    const fitted = createPiMotion({
      settings: { arms: [], stopSense: { kind: "not_wired" }, bench: false },
      stateDir: dir,
      runtimeDir: dir,
      clock: new FakeClock(),
      log,
      bus: new Bus(),
      modules: { setLiftHandler: (h) => handlers.push(h) },
      gpio: { flavor: "v1", chip: "gpiochip0" },
      handControls: () => true,
      walkerProposalOpen: () => false,
      say: () => {},
    });
    expect(fitted.lift).not.toBeNull();
    expect(handlers).toEqual([fitted.lift]);
  });
});

describe("E5b: lift.clear answered drops only the lift faults latched when it was sent", () => {
  it("a lift fault latched after the clear was sent stays latched when the lift answers cleared", async () => {
    const t = await lifted();
    await t.homed();
    t.key("lift-stop-switch");
    await t.wait(300);
    t.key("lift-stop-switch");
    await t.wait(500);
    t.coordinator.operatorClear("checked");
    await t.wait(2100);
    t.key("c");
    // Before the next tick writes lift.clear, a new lift fault arrives (from the client, as from a status).
    (t.lift.client as unknown as { emit(e: LiftEvent): void }).emit({ type: "fault", code: "limit_hit" });
    expect(await t.until(() => t.saw("lift clear cleared"), 1000)).toBe(true);
    await t.wait(40);
    expect(t.state().faults.map((f) => `${f.code}/${f.part}`)).toEqual(["limit_hit/lift"]);
    expect(t.state().mode).toBe("fault");
  }, 60_000);
});

describe("E12: turning off the lift's motor", () => {
  it("lift.disable, Confirmed: the lift frees its motor and is unhomed; a stop never sends it", async () => {
    const t = await lifted();
    await t.homed();
    const lines = t.piLines.length;
    t.coordinator.operatorStop();
    await t.wait(100);
    expect(t.piLines.slice(lines).some((p) => p.line.type === "lift.enable")).toBe(false);
    await t.confirm("lift-disable");
    expect(await t.until(() => t.saw("lift disable disabled"), 1000)).toBe(true);
    await t.wait(100);
    expect(t.state().last_command).toMatchObject({ kind: "lift.disable", outcome: "completed" });
    expect(t.liftState()).toMatchObject({ homed: false, driver_enabled: false });
  }, 60_000);
});

describe("E13: a recording names the lift height it was taught at", () => {
  it("refused before the lift is homed; saved with lift_mm at the lift's height", async () => {
    const t = await lifted();
    await t.armsOn();
    const before = t.coordinator.operatorRecord("sim_taught", "Hand it over", "left", true);
    expect(before).toMatchObject({ ok: false });
    expect(!before.ok && before.error).toContain("the lift isn't homed");
    await t.homed();
    await t.raised();
    t.key("lift-hold-off");
    t.key("leader-match-left");
    await t.wait(100);
    await t.confirm("record-left");
    expect(await t.until(() => t.saw("recording started sim_taught"), 1000), t.events.slice(-12).join("\n")).toBe(true);
    t.key("leader-sweep-left");
    await t.wait(1500);
    t.key("operator-stop");
    await t.wait(200);
    t.key("record-finish");
    expect(await t.until(() => t.saw("skill-saved sim_taught"), 1000)).toBe(true);
    const saved = JSON.parse(readFileSync(join(t.h.dir, "motion", "skills", "sim_taught.json"), "utf8")) as { lift_mm: number };
    expect(saved.lift_mm).toBeCloseTo(SIM_TRAY_HEIGHT_MM, 3);
  }, 90_000);
});
