import {
  MotionStateSchema,
  PARK_PROMPT,
  ScreenStateSchema,
  WALKER_CONFIRM_WAIT_MS,
  confirmPrompt,
  type ActiveMotion,
  type ConfirmAction,
  type LiftState,
  type MotionState,
  type ScreenState,
} from "@walker/contracts";
import { describe, expect, it } from "vitest";
import { SCREEN_DONE_MS, SCREEN_MOTION_STALE_MS } from "../src/constants";
import { Bus } from "../src/bus";
import { attachScreen, startingSettings } from "../src/screen/attach";
import { ScreenMachine, pickScreen, type ScreenModel } from "../src/screen/machine";
import { endedBetween, liftDirection, motionContent, type ScreenMotion } from "../src/screen/motion";
import { FakeClock, captureLogger, flush } from "./support/fakes";

/** Rows D19 to D21 of test/EXPECTED.md: motion on the walker screen. Every time comes from a fake clock. */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const AT = "2026-10-24T19:00:00.000Z";
const settings = startingSettings(undefined, Date.parse(AT));
const base: ScreenModel = { link: "online", talk: "idle", alerts: ["vibration"], offer: null, answer: null, done: null, obstacle: null, motion: null, motionEnded: null, message: null, showing: null };

const LIFT_AT_100: LiftState = {
  connected: true,
  homed: true,
  position_mm: 100,
  target_mm: null,
  moving: false,
  driver_enabled: true,
  limits: { top: "released", bottom: "released" },
  faults: [],
};

function target(n: number, title: string, action: ConfirmAction, needsPark = true) {
  return {
    target_id: uuid(n),
    prepared_by: "operator_cli" as const,
    action,
    title,
    prompt: confirmPrompt(title, needsPark),
    shown_mono_ms: 1000,
    expires_mono_ms: 1000 + WALKER_CONFIRM_WAIT_MS,
    shown_at: AT,
    state: "open" as const,
  };
}

/** A motion state as the coordinator publishes it: every one is checked against MotionStateSchema. */
function motion(over: Partial<MotionState> = {}): MotionState {
  return MotionStateSchema.parse({
    version: 2,
    generated_at: AT,
    mode: "ready",
    bench_mode: true,
    stop_circuit: "not_wired",
    hand_controls_connected: true,
    arms: [],
    lift: LIFT_AT_100,
    active: null,
    confirm_target: null,
    last_command: null,
    faults: [],
    ...over,
  });
}

const cup = target(60, "Bring the cup?", { kind: "skill.run", skill_id: "tray_pick_handover" });
const raise = target(62, "Raise the lift?", { kind: "lift.move", target_mm: 300 });
const lower = target(63, "Lower the lift?", { kind: "lift.move", target_mm: 40 });
const home = target(64, "Home the lift?", { kind: "lift.home" });
const disable = target(65, "Turn the lift motor off?", { kind: "lift.disable" });
const clear = target(66, "Clear it?", { kind: "fault.clear" }, false);

const liftActive = (phase: "running" | "stopping", n = 70, targetId = raise.target_id): ActiveMotion => ({
  kind: "lift.move",
  command_id: uuid(n),
  target_id: targetId,
  started_at: AT,
  phase,
  hold_source: phase === "running" ? "screen_hold_control" : null,
  target_mm: 300,
});
const movingLift = (phase: "running" | "stopping", position = 150): Partial<MotionState> => ({
  mode: "moving",
  active: liftActive(phase),
  lift: { ...LIFT_AT_100, position_mm: position, target_mm: 300, moving: true },
});
const skillActive: ActiveMotion = { kind: "skill.run", command_id: uuid(71), target_id: cup.target_id, started_at: AT, skill_id: "tray_pick_handover", title: "Bring the cup", progress: 0.2 };
const fault = (code: "stop_circuit_opened" | "lift_unhomed" | "overload", part: "system" | "lift" | "arm_left") => ({
  code,
  part,
  raised_at: AT,
  sentence: {
    stop_circuit_opened: "The stop switch was pressed, so the arms and lift stopped.",
    lift_unhomed: "The lift lost track of its height, so it needs homing again.",
    overload: "An arm was working too hard, so it stopped.",
  }[code],
});

const screenMotion = (state: MotionState, atMono = 0, directions: [string, "raise" | "lower" | "home" | "move"][] = []): ScreenMotion => ({
  state,
  atMono,
  directions: new Map(directions),
});
const at = (model: Partial<ScreenModel>, now = 0) => pickScreen({ ...base, ...model }, now, settings).content;
const name = (model: Partial<ScreenModel>, now = 0) => at(model, now).state;

describe("D19: motion in the screen's priority", () => {
  const obstacle = { zone: "front_left", mm: 300, simulated: true, lastNearMono: 0, near: true };
  const answer = { id: 1, heard: null, reply: "Fake cloud: hello.", source: "fixed" as const, startedMono: 0, spokenMono: null };
  const offer = { proposal_id: uuid(50), from_cues: ["vibration" as const], cues: ["sound" as const] };
  const done = { result: { kind: "nothing_changed" as const }, untilMono: 5000 };
  const running = screenMotion(motion(movingLift("running")));
  const faulted = screenMotion(motion({ mode: "fault", faults: [fault("overload", "arm_left")] }));
  const pending = screenMotion(motion({ confirm_target: cup }));
  const ended = { content: { state: "motion_holding" as const, outcome: "stopped" as const, refusal: null }, untilMono: 4000 };

  it("obstacle, running or fault, her own Talk, the pending target, the offer, Done, Stopped, offline, the clock", () => {
    expect(name({ obstacle, motion: running, talk: "recording" })).toBe("obstacle");
    expect(name({ motion: running, talk: "recording", answer, offer, done, link: "offline" })).toBe("motion_running");
    expect(name({ motion: faulted, talk: "recording", answer, offer, done, link: "offline" })).toBe("motion_fault");
    expect(name({ motion: pending, talk: "recording" })).toBe("listening");
    expect(name({ motion: pending, talk: "waiting" })).toBe("thinking");
    expect(name({ motion: pending, answer })).toBe("answering");
    expect(name({ motion: pending, offer, done, motionEnded: ended, link: "offline" })).toBe("motion_confirm");
    expect(name({ offer, done, motionEnded: ended, link: "offline" })).toBe("model_offer");
    expect(name({ done, motionEnded: ended, link: "offline" })).toBe("done");
    expect(name({ motionEnded: ended, link: "offline" })).toBe("motion_holding");
    expect(name({ motionEnded: ended, link: "offline" }, 4000)).toBe("offline");
    expect(name({ motionEnded: ended }, 4000)).toBe("ambient");
  });

  it("every motion screen it picks is a valid ScreenState", () => {
    for (const m of [running, faulted, pending]) {
      const state: ScreenState = { v: 1, revision: 0, screen: at({ motion: m }), settings, strip: { link: "online", simulator: false, bench_mode: true, clock: null } };
      expect(ScreenStateSchema.safeParse(state).success, state.screen.state).toBe(true);
    }
  });

  it("a running motion covers her own screens, which come back underneath once it has stopped", async () => {
    const clock = new FakeClock();
    const states: ScreenState[] = [];
    const m = new ScreenMachine({ clock, simulator: false, settings, localTime: () => null, onState: (s) => states.push(s), onError: (e) => { throw e; } });
    m.seed({ link: "online" });
    m.motion(motion({ mode: "moving", active: skillActive }));
    await flush();
    m.talk("recording");
    await flush();
    expect(states.at(-1)!.screen.state).toBe("motion_running");
    // The handle press stopped it: the coordinator's next state has nothing active.
    m.motion(motion({ last_command: { command_id: skillActive.command_id, kind: "skill.run", outcome: "stopped", at: AT } }));
    await flush();
    expect(states.at(-1)!.screen.state).toBe("listening");
    m.talk("idle");
    await flush();
    // Back underneath: the motion's own "Stopped", for the rest of its time.
    expect(states.at(-1)!.screen).toEqual({ state: "motion_holding", outcome: "stopped", refusal: null });
    m.stop();
  });
});

describe("D20: the coordinator's motion state as screens", () => {
  it("a pending target: its own words, no hold control unless the lift is held to run", () => {
    expect(at({ motion: screenMotion(motion({ confirm_target: cup })) })).toEqual({
      state: "motion_confirm",
      target: { target_id: cup.target_id, title: "Bring the cup?", prompt: `Bring the cup? ${PARK_PROMPT}` },
      hold: null,
    });
    const hold = (t: typeof raise) => {
      const c = at({ motion: screenMotion(motion({ confirm_target: t })) });
      return c.state === "motion_confirm" ? c.hold : "not a target";
    };
    expect(hold(raise)).toBe("raise");
    expect(hold(lower)).toBe("lower");
    expect(hold(home)).toBe("home");
    // lift.disable isn't hold-to-run: no hold control.
    expect(hold(disable)).toBeNull();
    // A move from an unknown height says only "move".
    expect(liftDirection({ kind: "lift.move", target_mm: 300 }, { ...LIFT_AT_100, homed: false, position_mm: null })).toBe("move");
    expect(liftDirection({ kind: "lift.move", target_mm: 300 }, null)).toBe("move");
  });

  it("running: the Pi's words, and the lift's phase; the way it goes is fixed when the target is first seen", async () => {
    expect(at({ motion: screenMotion(motion({ mode: "moving", active: skillActive })) })).toEqual({ state: "motion_running", what: "Bring the cup", lift: null });
    expect(at({ motion: screenMotion(motion(movingLift("running"))) })).toEqual({
      state: "motion_running",
      what: "Raising the lift",
      lift: { phase: "running", direction: "raise" },
    });
    expect(at({ motion: screenMotion(motion(movingLift("stopping"))) })).toMatchObject({ lift: { phase: "stopping" } });
    const pose: ActiveMotion = { kind: "arm.go_to_pose", command_id: uuid(72), target_id: uuid(73), started_at: AT, arm: "left", pose: "ready" };
    expect(at({ motion: screenMotion(motion({ mode: "moving", active: pose })) })).toMatchObject({ what: "Moving the left arm" });

    // The machine remembers the way: at the target height the words would say "move", but stay "raise".
    const clock = new FakeClock();
    const states: ScreenState[] = [];
    const m = new ScreenMachine({ clock, simulator: false, settings, localTime: () => null, onState: (s) => states.push(s), onError: (e) => { throw e; } });
    m.seed({ link: "online" });
    m.motion(motion({ confirm_target: raise }));
    await flush();
    m.motion(motion(movingLift("running", 300)));
    await flush();
    expect(states.map((s) => s.screen)).toContainEqual({ state: "motion_running", what: "Raising the lift", lift: { phase: "running", direction: "raise" } });
    expect(JSON.stringify(states.map((s) => s.screen))).not.toContain('"move"');
    m.stop();
  });

  it("a fault: each code once, oldest first, with the target that clears it", () => {
    const state = motion({ mode: "fault", faults: [fault("stop_circuit_opened", "system"), fault("lift_unhomed", "lift"), fault("stop_circuit_opened", "system")], confirm_target: clear, stop_circuit: "released" });
    expect(motionContent(screenMotion(state)).safety).toEqual({
      state: "motion_fault",
      faults: ["stop_circuit_opened", "lift_unhomed"],
      confirm: { target_id: clear.target_id, title: "Clear it?", prompt: clear.prompt },
    });
  });

  it("letting go while a fault is latched shows \"Letting go\" (what moves and how to stop it), then the fault again", () => {
    const releasing: ActiveMotion = { kind: "gripper.release", command_id: uuid(74), target_id: uuid(75), started_at: AT, arm: "left" };
    const faulted = { mode: "fault" as const, faults: [fault("overload", "arm_left")] };
    expect(motionContent(screenMotion(motion({ ...faulted, active: releasing }))).safety).toEqual({ state: "motion_running", what: "Letting go", lift: null });
    expect(motionContent(screenMotion(motion(faulted))).safety).toMatchObject({ state: "motion_fault", faults: ["overload"] });
  });

  it("a motion state older than 1 s shows nothing about motion, so the hold control goes", async () => {
    const m = screenMotion(motion(movingLift("running")), 0);
    expect(name({ motion: m }, SCREEN_MOTION_STALE_MS - 1)).toBe("motion_running");
    expect(name({ motion: m }, SCREEN_MOTION_STALE_MS)).toBe("ambient");
    // The machine redraws by itself when it goes stale, with no other input.
    const clock = new FakeClock();
    const states: ScreenState[] = [];
    const machine = new ScreenMachine({ clock, simulator: false, settings, localTime: () => null, onState: (s) => states.push(s), onError: (e) => { throw e; } });
    machine.seed({ link: "online" });
    machine.motion(motion(movingLift("running")));
    await flush();
    expect(states.at(-1)!.screen.state).toBe("motion_running");
    await clock.advance(SCREEN_MOTION_STALE_MS);
    expect(states.at(-1)!.screen.state).toBe("ambient");
    // Bench mode stays in the strip: it is fixed when the coordinator starts.
    expect(states.at(-1)!.strip.bench_mode).toBe(true);
    machine.stop();
  });

  it("the strip says bench mode from the coordinator, and not without one", async () => {
    const clock = new FakeClock();
    const states: ScreenState[] = [];
    const m = new ScreenMachine({ clock, simulator: false, settings, localTime: () => null, onState: (s) => states.push(s), onError: (e) => { throw e; } });
    m.seed({ link: "online" });
    await flush();
    expect(states.at(-1)!.strip.bench_mode).toBe(false);
    m.motion(motion({ bench_mode: false, stop_circuit: "released" }));
    await flush();
    expect(states.at(-1)!.strip.bench_mode).toBe(false);
    m.motion(motion());
    await flush();
    expect(states.at(-1)!.strip.bench_mode).toBe(true);
    m.stop();
  });

  it("reaches the screen from the bus's motionState event", async () => {
    const clock = new FakeClock();
    const bus = new Bus();
    const states: ScreenState[] = [];
    const attached = attachScreen({
      bus,
      clock,
      log: captureLogger(),
      service: { link: "online", talk: "idle", configuration: null, openProposal: null },
      modules: { modules: () => [] },
      simulator: false,
      settings,
      localTime: () => null,
      onState: (s) => states.push(s),
    });
    attached.machine.seed({ link: "online" });
    bus.emit("motionState", { state: motion({ confirm_target: raise }) });
    await flush();
    expect(states.at(-1)!.screen).toMatchObject({ state: "motion_confirm", hold: "raise" });
    attached.detach();
  });
});

describe("D21: after a motion, Done, Stopped or Not started", () => {
  const runningSkill = motion({ mode: "moving", active: skillActive });

  it("matches the ended motion by its command id", () => {
    const completed = motion({ last_command: { command_id: skillActive.command_id, kind: "skill.run", outcome: "completed", at: AT } });
    expect(endedBetween(runningSkill, completed)).toEqual({ state: "motion_holding", outcome: "completed", refusal: null });
    const stopped = motion({ last_command: { command_id: skillActive.command_id, kind: "skill.run", outcome: "stopped", at: AT } });
    expect(endedBetween(runningSkill, stopped)).toEqual({ state: "motion_holding", outcome: "stopped", refusal: null });
    // Another command's outcome, a fault, or nothing new: nothing is claimed.
    expect(endedBetween(runningSkill, motion({ last_command: { command_id: uuid(99), kind: "skill.run", outcome: "completed", at: AT } }))).toBeNull();
    expect(
      endedBetween(runningSkill, motion({ mode: "fault", faults: [fault("overload", "arm_left")], last_command: { command_id: skillActive.command_id, kind: "skill.run", outcome: "faulted", at: AT } })),
    ).toBeNull();
    expect(endedBetween(runningSkill, motion({ last_command: { command_id: skillActive.command_id, kind: "skill.run", outcome: "faulted", at: AT } }))).toBeNull();
    expect(endedBetween(null, completed)).toBeNull();
  });

  it("a press the coordinator refused: Not started, with its reason; a refused prepare shows nothing", () => {
    const pending = motion({ confirm_target: raise });
    const refused = motion({ last_command: { command_id: uuid(80), kind: "lift.move", outcome: "refused", refusal: "not_held", at: AT } });
    expect(endedBetween(pending, refused)).toEqual({ state: "motion_holding", outcome: "not_started", refusal: "not_held" });
    // The target still pending (a terminal's prepare was refused meanwhile): nothing.
    const stillPending = motion({ confirm_target: raise, last_command: { command_id: uuid(81), kind: "skill.run", outcome: "refused", refusal: "confirm_busy", at: AT } });
    expect(endedBetween(pending, stillPending)).toBeNull();
    // A refusal of another kind: nothing.
    expect(endedBetween(pending, motion({ last_command: { command_id: uuid(82), kind: "skill.run", outcome: "refused", refusal: "busy", at: AT } }))).toBeNull();
  });

  it("shows for SCREEN_DONE_MS, then whatever is underneath", async () => {
    const clock = new FakeClock();
    const states: ScreenState[] = [];
    const m = new ScreenMachine({ clock, simulator: false, settings, localTime: () => null, onState: (s) => states.push(s), onError: (e) => { throw e; } });
    m.seed({ link: "online" });
    m.motion(motion(movingLift("running")));
    await flush();
    m.motion(motion({ last_command: { command_id: uuid(70), kind: "lift.move", outcome: "stopped", at: AT } }));
    await flush();
    expect(states.at(-1)!.screen).toEqual({ state: "motion_holding", outcome: "stopped", refusal: null });
    // The coordinator keeps publishing (5 a second); nothing new ends, so Stopped stays its time.
    for (let t = 200; t < SCREEN_DONE_MS; t += 200) {
      await clock.advance(200);
      m.motion(motion({ last_command: { command_id: uuid(70), kind: "lift.move", outcome: "stopped", at: AT } }));
    }
    await flush();
    expect(states.at(-1)!.screen.state).toBe("motion_holding");
    await clock.advance(200);
    expect(states.at(-1)!.screen.state).toBe("ambient");
    m.stop();
  });
});
