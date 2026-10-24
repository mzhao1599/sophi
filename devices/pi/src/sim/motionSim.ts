import { existsSync, writeFileSync } from "node:fs";
import {
  ARM_JOINTS,
  MOTION_CONTRACT_VERSION,
  SERVO_TICKS_PER_TURN,
  type ArmCalibration,
  type ArmJoints,
  type ArmRole,
  type ArmSide,
  type NamedPose,
} from "@walker/contracts";
import type { Bus } from "../bus";
import type { Cancel, Clock } from "../clock";
import type { Logger } from "../log";
import { MotionCoordinator } from "../motion/coordinator";
import type { FeetechPort } from "../motion/feetech/port";
import { MotionFiles, skillJson } from "../motion/files";
import { ManualStopSense, NotWiredStopSense } from "../motion/stopSense";
import { FakeStsBus } from "./fakeFeetech";
import { SIM_TRAY_HEIGHT_MM, type LiftSim } from "./liftSim";
import { SIM_SAMPLE_SKILL_ID, simSampleSkill } from "./sampleSkill";

/** The skill the simulator's own teaching (`record-left`) records. SIMULATED. */
export const SIM_TAUGHT_SKILL_ID = "sim_taught";
/** Where the simulator's object sits between the left gripper's fingers: its made-up 12°. */
const SIM_OBJECT_DEG = 12;

/**
 * SIMULATED arms for `walker simulate --arms` and the tests: four fake STS3215 buses (two followers, two
 * leaders) through the real coordinator, a simulated stop switch, and fault injection. The fake servos use the
 * dangerous default (`torqueOnHoldsPosition: false`: torque on drives to whatever goal is in the register), so
 * a coordinator that forgot goal = present would be caught. Nothing here is hardware, and the simulator's
 * calibrations and poses are made up for it, not measured.
 *
 * With the SIMULATED lift (`lift`, `walker simulate --arms --lift`), the coordinator also drives the lift's real
 * client, the followers start folded at their made-up `stowed` pose (torque still off: it must be turned on, so
 * the arms count as stowed), the walker's one stop switch also opens the lift board's stop-sense input, and the
 * sample skill is "taught" at the made-up tray height SIM_TRAY_HEIGHT_MM.
 */

/** Ticks either side of the middle the simulated calibration allows (about ±97°). */
const SIM_HALF_RANGE = 1100;
const SIM_POSES: Array<{ name: string; title: string; joints: ArmJoints }> = [
  { name: "stowed", title: "Fold the left arm away", joints: { shoulder_pan: 0, shoulder_lift: -40, elbow_flex: 60, wrist_flex: 30, wrist_roll: 0, gripper: 5 } },
  { name: "ready", title: "Move the left arm to ready", joints: { shoulder_pan: 0, shoulder_lift: -20, elbow_flex: 30, wrist_flex: 10, wrist_roll: 0, gripper: 20 } },
  { name: "handover", title: "Hold it out to you", joints: { shoulder_pan: 20, shoulder_lift: 30, elbow_flex: -20, wrist_flex: 0, wrist_roll: 0, gripper: 30 } },
];

function simCalibration(side: ArmSide, role: ArmRole, busId: string, at: string): ArmCalibration {
  const joints = Object.fromEntries(
    ARM_JOINTS.map((joint, i) => [
      joint,
      { servo_id: i + 1, homing_offset: 0, min_ticks: 2048 - SIM_HALF_RANGE, max_ticks: 2048 + SIM_HALF_RANGE, zero_ticks: 2048, direction: 1 as const },
    ]),
  ) as ArmCalibration["joints"];
  return { format: "sophi.arm_calibration", version: MOTION_CONTRACT_VERSION, arm: side, role, bus_id: busId, calibrated_at: at, joints };
}

const degToTicks = (deg: number) => Math.round((deg * SERVO_TICKS_PER_TURN) / 360);

/** A connection to a fake bus that can be closed and opened again (as a real tty can), until the bus is unplugged. */
export function fakeConnection(fake: FakeStsBus, onGoalWrite: () => void): FeetechPort {
  let closed = false;
  const unsubscribes: Array<() => void> = [];
  const closeHandlers: Array<(reason: string) => void> = [];
  const finish = (reason: string) => {
    if (closed) return;
    closed = true;
    for (const off of unsubscribes) off();
    for (const fn of closeHandlers) fn(reason);
  };
  fake.onClose((reason) => finish(reason));
  return {
    async write(bytes) {
      if (closed) throw new Error("port closed");
      // SYNC WRITE (0x83) from address 41: goals (acceleration, position, time, speed).
      if (bytes[4] === 0x83 && bytes[5] === 41) onGoalWrite();
      return fake.write(bytes);
    },
    onData(fn) {
      const off = fake.onData((chunk) => {
        if (!closed) fn(chunk);
      });
      unsubscribes.push(off);
      return off;
    },
    onClose(fn) {
      closeHandlers.push(fn);
    },
    close() {
      finish("closed by the Pi");
    },
  };
}

export interface MotionSimHand {
  unplug(): void;
  plug(): void;
  readonly plugged: boolean;
}

export class MotionSim {
  readonly buses = new Map<string, FakeStsBus>();
  readonly stopSwitch = new ManualStopSense("released");
  readonly coordinator: MotionCoordinator;
  private readonly unplugged = new Set<string>();
  private readonly timers: Cancel[] = [];
  private powered = true;
  private readonly files: MotionFiles;
  /** The terminal request the last simulated recording was prepared under (to save it). */
  private recordId: string | null = null;
  /** Where each left follower servo was at the last handle press or handle unplug (for inspect-hold-tight-left). */
  private readonly marked = new Map<number, number>();

  private mark(): void {
    const fake = this.fake("left", "follower");
    fake.update();
    for (const servo of fake.servos.values()) this.marked.set(servo.id, servo.get("presentPosition"));
  }

  constructor(
    private readonly deps: {
      clock: Clock;
      log: Logger;
      bus: Bus;
      stateDir: string;
      bench: boolean;
      hand: MotionSimHand;
      handControls: () => boolean;
      walkerProposalOpen?: () => boolean;
      say: (text: string) => void;
      newId?: () => string;
      /** The SIMULATED lift board and the real lift client (src/sim/liftSim.ts), or none. */
      lift?: LiftSim;
      /** Tests: no stop-sense input declared (WALKER_STOP_SENSE=not_wired); default the simulated stop switch. */
      stopSense?: "switch" | "not_wired";
    },
  ) {
    const files = new MotionFiles(deps.stateDir, deps.log);
    this.files = files;
    const at = new Date(deps.clock.now()).toISOString();
    const arms: Array<{ side: ArmSide; role: ArmRole }> = [
      { side: "left", role: "follower" },
      { side: "right", role: "follower" },
      { side: "left", role: "leader" },
      { side: "right", role: "leader" },
    ];
    for (const { side, role } of arms) {
      const fake = new FakeStsBus(deps.clock, { torqueOnHoldsPosition: false });
      this.buses.set(`${side}/${role}`, fake);
      if (deps.lift && role === "follower") {
        // SIMULATED: a walker with a lift parks with its arms folded.
        const stowed = SIM_POSES.find((p) => p.name === "stowed")!.joints;
        for (const [i, joint] of ARM_JOINTS.entries()) fake.servo(i + 1).moveByHand(2048 + degToTicks(stowed[joint]));
      }
      for (const servo of fake.servos.values()) {
        servo.onTorqueOn = (goal, present) =>
          this.sim(`torque-on ${side} ${role} servo ${servo.id} ${Math.abs(goal - present) <= 1 ? "goal-at-present" : `goal-away ${goal - present}`}`);
        // A goal left in the register by an earlier run: torque on would drive there unless the Pi rewrites it.
        servo.set("goalPosition", 2048 + 300);
      }
      if (!existsSync(files.calibrationPath(side, role))) files.writeCalibration(simCalibration(side, role, `sim-${side}-${role}`, at));
    }
    if (files.readPoses().length === 0) {
      const poses: NamedPose[] = [];
      for (const side of ["left", "right"] as const) {
        for (const pose of SIM_POSES) poses.push({ name: pose.name, title: pose.title.replace("left", side), arm: side, joints: pose.joints, updated_at: at });
      }
      files.writePoses(poses);
    }
    // The SIMULATED sample skill, made up (sampleSkill.ts): only ever written into a simulator's state folder. It
    // names the made-up tray height exactly when the simulator has a lift (rewritten if a folder had the other).
    const sample = files.readSkill(SIM_SAMPLE_SKILL_ID);
    if (sample.kind === "missing") files.writeSkill(simSampleSkill(at, this.sampleLiftMm()), { replace: false, stamp: at });
    else if (sample.kind === "ok" && sample.skill.lift_mm !== this.sampleLiftMm()) files.writeSkill(simSampleSkill(at, this.sampleLiftMm()), { replace: true, stamp: at });
    // Where the arm was at each handle press: the moment a stop happens (registered before the coordinator's).
    deps.bus.on("button", (event) => {
      if (event.edge === "pressed") this.mark();
    });
    this.coordinator = new MotionCoordinator({
      clock: deps.clock,
      log: deps.log,
      bus: deps.bus,
      files,
      arms: arms.map(({ side, role }) => ({
        side,
        role,
        busId: `sim-${side}-${role}`,
        openPort: () => {
          const key = `${side}/${role}`;
          if (this.unplugged.has(key)) throw new Error("simulated adapter unplugged");
          return fakeConnection(this.buses.get(key)!, () => this.sim(`goal-write ${side} ${role}`));
        },
      })),
      stopSense: deps.stopSense === "not_wired" ? new NotWiredStopSense() : this.stopSwitch,
      bench: deps.bench,
      handControls: deps.handControls,
      ...(deps.walkerProposalOpen ? { walkerProposalOpen: deps.walkerProposalOpen } : {}),
      say: deps.say,
      ...(deps.newId ? { newId: deps.newId } : {}),
      lift: deps.lift?.client ?? null,
    });
  }

  /** The sample skill's lift height: the made-up tray height with a lift, else none. */
  private sampleLiftMm(): number | null {
    return this.deps.lift ? SIM_TRAY_HEIGHT_MM : null;
  }

  private sim(text: string): void {
    this.deps.bus.emit("sim", { text });
  }

  private fake(side: ArmSide, role: ArmRole): FakeStsBus {
    return this.buses.get(`${side}/${role}`)!;
  }

  /** Moves one leader joint by hand, smoothly, at `degS`. */
  private sweepLeader(side: ArmSide, joint: (typeof ARM_JOINTS)[number], byDeg: number, degS: number): void {
    const servo = this.fake(side, "leader").servo(ARM_JOINTS.indexOf(joint) + 1);
    const start = servo.get("presentPosition");
    const target = start + degToTicks(byDeg);
    const stepMs = 10;
    const perStep = (degToTicks(degS) * stepMs) / 1000;
    let at = start;
    const move = () => {
      at = target > at ? Math.min(target, at + perStep) : Math.max(target, at - perStep);
      servo.moveByHand(Math.round(at));
      if (Math.round(at) !== target) this.timers.push(this.deps.clock.setTimeout(move, stepMs));
    };
    move();
  }

  /** The words a script or the keyboard uses, each one simulated action. */
  actions(): Record<string, () => void> {
    const c = this.coordinator;
    const toggleHold = (side: ArmSide, by: number) => {
      const servo = this.fake(side, "follower").servo(3);
      servo.heldAt = servo.heldAt === null ? servo.get("presentPosition") + degToTicks(by) : null;
      this.sim(`elbow ${side} ${servo.heldAt === null ? "free" : `held at ${servo.heldAt}`}`);
    };
    const operator = (result: { ok: boolean }) => {
      if (!result.ok) this.deps.log.warn("SIMULATED operator request not accepted", { result: JSON.stringify(result).slice(0, 200) });
    };
    const out: Record<string, () => void> = {
      "stop-switch": () => {
        const next = this.stopSwitch.reading() === "pressed" ? "released" : "pressed";
        // The stop cuts the followers' 12 V: their servos go silent, and power up again on release.
        this.powered = next === "released";
        for (const side of ["left", "right"] as const) {
          for (const servo of this.fake(side, "follower").servos.values()) {
            if (this.powered) servo.powerCycle();
            servo.faults.silent = !this.powered;
          }
        }
        // The one stop switch also opens the lift's own stop-sense input (the lift board reads it separately).
        this.deps.lift?.setStopPressed(next === "pressed");
        this.stopSwitch.set(next);
        this.sim(`stop switch ${next}`);
      },
      "hand-unplug": () => {
        if (!this.deps.hand.plugged) return this.deps.hand.plug();
        this.mark();
        this.deps.hand.unplug();
      },
      "torque-on-left": () => operator(c.operatorTorque(true, ["left"])),
      "torque-on-right": () => operator(c.operatorTorque(true, ["right"])),
      "torque-off-left": () => operator(c.operatorTorque(false, ["left"])),
      "pose-ready-left": () => operator(c.operatorGoToPose("left", "ready")),
      "pose-handover-left": () => operator(c.operatorGoToPose("left", "handover")),
      "pose-stowed-left": () => operator(c.operatorGoToPose("left", "stowed")),
      "pose-stowed-right": () => operator(c.operatorGoToPose("right", "stowed")),
      "offer-ready-left": () => {
        // SIMULATED offer source: stands in for a later request by ids (MotionOfferRequestSchema).
        if (!c.requestOffer({ target: { kind: "arm.go_to_pose", arm: "left", pose: "ready" } })) this.sim("offer dropped");
      },
      "teleop-left": () => operator(c.operatorTeleop("left")),
      "operator-stop": () => operator(c.operatorStop()),
      "operator-clear": () => operator(c.operatorClear("simulator: checked")),
      "stale-left": () => {
        const servo = this.fake("left", "follower").servo(3);
        servo.faults.noReply = !servo.faults.noReply;
        this.sim(`left follower servo 3 ${servo.faults.noReply ? "silent" : "answering"}`);
      },
      "push-left": () => toggleHold("left", 25),
      "block-left": () => toggleHold("left", 0),
      "slow-left": () => {
        // A stiff elbow that still moves, at about 5°/s: slower than any move expects, faster than a stall.
        const servo = this.fake("left", "follower").servo(3);
        servo.slowTo = servo.slowTo === null ? 57 : null;
        this.sim(`elbow left ${servo.slowTo === null ? "free" : "slow"}`);
      },
      "load-left": () => {
        // Something leans on the elbow at 50% of full torque: under the 60% limit, so it still moves.
        const servo = this.fake("left", "follower").servo(3);
        servo.externalLoad = servo.externalLoad === 0 ? 500 : 0;
        this.sim(`elbow left load ${servo.externalLoad / 10}%`);
      },
      "leader-match-left": () => {
        const follower = this.fake("left", "follower");
        const leader = this.fake("left", "leader");
        for (const servo of follower.servos.values()) leader.servo(servo.id).moveByHand(servo.get("presentPosition"));
        this.sim("left leader matched");
      },
      "leader-sweep-left": () => this.sweepLeader("left", "shoulder_pan", 20, 15),
      "leader-jerk-left": () => this.sweepLeader("left", "shoulder_pan", 90, 360),
      "unplug-left": () => {
        this.unplugged.add("left/follower");
        this.fake("left", "follower").unplug();
      },
      "stray-goal-left": () => {
        for (const servo of this.fake("left", "follower").servos.values()) servo.set("goalPosition", servo.get("presentPosition") + 200);
        this.sim("left follower goals moved away");
      },
      "inspect-hold-tight-left": () => {
        // A hold that read first sets each torqued servo's goal to where the servo was when that goal arrived,
        // within 0.5°; one made from the tick before would lag by up to a tick of motion. Measured at the goal's
        // arrival, not at the press, so the check holds in real time too (the fresh read lands a few ms after
        // the press, while the arm still coasts). A grasping gripper too: a stop lets off its squeeze.
        const servos = [...this.fake("left", "follower").servos.values()].filter((s) => s.get("torqueEnable") === 1);
        const gap = Math.max(0, ...servos.map((s) => Math.abs(s.get("goalPosition") - (s.presentAtGoalWrite ?? this.marked.get(s.id) ?? Infinity))));
        this.sim(gap <= degToTicks(0.5) ? `left follower hold tight ok (${servos.length} servos)` : `left follower hold tight BAD gap=${gap}`);
      },
      "inspect-goals-right": () => {
        const servos = [...this.fake("right", "follower").servos.values()];
        const gap = Math.max(...servos.map((s) => Math.abs(s.get("goalPosition") - s.get("presentPosition"))));
        this.sim(`right follower goals gap=${gap}`);
      },
      "inspect-hold-left": () => {
        // What a stop must leave: every servo with torque on holds within 5° of where it is.
        const servos = [...this.fake("left", "follower").servos.values()].filter((s) => s.get("torqueEnable") === 1);
        const gap = Math.max(0, ...servos.map((s) => Math.abs(s.get("goalPosition") - s.get("presentPosition"))));
        this.sim(gap <= degToTicks(5) ? "left follower hold ok" : `left follower hold BAD gap=${gap}`);
      },
      "power-cycle-left": () => {
        // The left arm's 12 V drops for 300 ms with no stop-sense edge: its servos go silent, then reboot with
        // torque off and their torque limit back at the EEPROM maximum.
        const servos = [...this.fake("left", "follower").servos.values()];
        for (const servo of servos) servo.faults.silent = true;
        this.sim("left follower power off");
        this.timers.push(
          this.deps.clock.setTimeout(() => {
            for (const servo of servos) {
              servo.powerCycle();
              servo.faults.silent = false;
            }
            this.sim("left follower power back");
          }, 300),
        );
      },
      "inspect-goals-left": () => {
        const servos = [...this.fake("left", "follower").servos.values()];
        const gap = Math.max(...servos.map((s) => Math.abs(s.get("goalPosition") - s.get("presentPosition"))));
        this.sim(`left follower goals gap=${gap}`);
      },
      "inspect-left": () => {
        const servos = [...this.fake("left", "follower").servos.values()];
        this.sim(`left follower torque=${servos.map((s) => s.get("torqueEnable")).join(",")} limit=${servos.map((s) => s.get("torqueLimit")).join(",")}`);
      },
      "motion-status": () => {
        const state = c.state();
        this.deps.log.info("SIMULATED arms", { mode: state.mode, faults: state.faults.map((f) => f.code).join(","), active: state.active?.kind ?? "none" });
      },
      // ---- Skills (SIMULATED teaching; the terminal's commands, called directly) ----
      "record-left": () => {
        const result = c.operatorRecord(SIM_TAUGHT_SKILL_ID, "Hand it over (SIMULATED teaching)", "left", true);
        operator(result);
        if (result.ok) this.recordId = result.request.id;
      },
      "leader-teach-left": () => this.teachLeft(),
      "grasp-left": () => operator(c.operatorRecordMark(this.recordId ?? "", "grasp")),
      "release-left": () => operator(c.operatorRecordMark(this.recordId ?? "", "release")),
      "record-finish": () => {
        // As the terminal does: save; if it ends holding, with the suggested let-go angle (where it began).
        const id = this.recordId ?? "";
        const first = c.operatorRecordFinish(id, null);
        const result = !first.ok && "needs_let_go" in first ? c.operatorRecordFinish(id, first.needs_let_go.suggest_deg) : first;
        if (!result.ok) this.sim(`record-finish not saved: ${result.error}`);
      },
      "skill-run-taught": () => operator(c.operatorSkillRun(SIM_TAUGHT_SKILL_ID)),
      "skill-run-sample": () => operator(c.operatorSkillRun(SIM_SAMPLE_SKILL_ID)),
      "offer-skill-sample": () => {
        // SIMULATED offer source: stands in for a later request by id (MotionOfferRequestSchema).
        if (!c.requestOffer({ target: { kind: "skill.run", skill_id: SIM_SAMPLE_SKILL_ID } })) this.sim("offer dropped");
      },
      "let-go-left": () => operator(c.operatorLetGo("left", null)),
      "skill-rm-taught": () => operator(c.operatorSkillRemove(SIM_TAUGHT_SKILL_ID)),
      "skills-list": () => this.sim(`skills ${c.operatorSkills().map((s) => `${s.skill_id}:${s.valid ? "ok" : "invalid"}`).join(" ")}`),
      "object-left": () => {
        // An object between the left gripper's fingers (or taken away): the gripper can't close past it.
        const servo = this.fake("left", "follower").servo(6);
        servo.objectAt = servo.objectAt === null ? 2048 + degToTicks(SIM_OBJECT_DEG) : null;
        this.sim(`left gripper ${servo.objectAt === null ? "empty" : `holds an object at ${SIM_OBJECT_DEG}°`}`);
      },
      "finger-left": () => {
        // Something bigger than the object in the left gripper (a finger, SIMULATED): it stops closing at 18°.
        const servo = this.fake("left", "follower").servo(6);
        servo.objectAt = servo.objectAt === null ? 2048 + degToTicks(18) : null;
        this.sim(`left gripper ${servo.objectAt === null ? "empty" : "has a finger in it at 18°"}`);
      },
      "inspect-grip-left": () => {
        const servo = this.fake("left", "follower").servo(6);
        this.sim(`left gripper goal-present=${servo.get("goalPosition") - servo.get("presentPosition")} limit=${servo.get("torqueLimit")}`);
      },
      "skill-edit-too-fast": () => {
        // Someone edits the sample skill's file by hand: one waypoint jumps 40° (far over its 30°/s).
        const skill = simSampleSkill(new Date(this.deps.clock.now()).toISOString(), this.sampleLiftMm());
        skill.waypoints[60]!.joints.left!.shoulder_pan += 40;
        writeFileSync(this.files.skillPath(SIM_SAMPLE_SKILL_ID), skillJson(skill));
        this.sim("sample skill edited: too fast");
      },
      "skill-edit-out-of-range": () => {
        // The same, with the wrist turned to 95° throughout: past this arm's calibrated range less the margin.
        const skill = simSampleSkill(new Date(this.deps.clock.now()).toISOString(), this.sampleLiftMm());
        skill.start.joints.left!.wrist_roll = 95;
        for (const wp of skill.waypoints) wp.joints.left!.wrist_roll = 95;
        writeFileSync(this.files.skillPath(SIM_SAMPLE_SKILL_ID), skillJson(skill));
        this.sim("sample skill edited: out of range");
      },
      "skill-restore-sample": () => {
        const at = new Date(this.deps.clock.now()).toISOString();
        this.files.writeSkill(simSampleSkill(at, this.sampleLiftMm()), { replace: true, stamp: at });
        this.sim("sample skill restored");
      },
    };
    return out;
  }

  /**
   * SIMULATED teaching: moves the left leader by hand through a made-up tray pick and hand-out, about 3.7 s:
   * out and down (pan +15°, elbow −10°), the gripper closing 35° from 1.2 s (on an object at 12° the follower
   * stops more than 20° short of its leader, as a real grasp does), then up and across from 2.4 s. Every joint
   * under 30°/s, well within the 60°/s a recording follows at.
   */
  private teachLeft(): void {
    const later = (ms: number, fn: () => void) => this.timers.push(this.deps.clock.setTimeout(fn, ms));
    this.sweepLeader("left", "shoulder_pan", 15, 15);
    this.sweepLeader("left", "elbow_flex", -10, 10);
    later(1200, () => this.sweepLeader("left", "gripper", -35, 28));
    later(2400, () => {
      this.sweepLeader("left", "shoulder_lift", 15, 15);
      this.sweepLeader("left", "shoulder_pan", -25, 20);
    });
    later(3700, () => this.sim("leader teaching done"));
  }

  async stop(): Promise<void> {
    for (const cancel of this.timers) cancel();
    await this.coordinator.stop();
  }
}

/** Interactive keys for the motion actions (`walker simulate --arms`). */
export const MOTION_KEYS: Record<string, string> = {
  s: "stop-switch",
  h: "hand-unplug",
  "1": "torque-on-left",
  "2": "torque-on-right",
  "0": "torque-off-left",
  P: "pose-ready-left",
  H: "pose-handover-left",
  O: "offer-ready-left",
  L: "teleop-left",
  M: "leader-match-left",
  V: "leader-sweep-left",
  J: "leader-jerk-left",
  S: "operator-stop",
  C: "operator-clear",
  F: "stale-left",
  B: "push-left",
  W: "block-left",
  Y: "slow-left",
  Z: "load-left",
  U: "unplug-left",
  G: "stray-goal-left",
  I: "inspect-left",
  A: "motion-status",
  R: "record-left",
  T: "leader-teach-left",
  "3": "grasp-left",
  "4": "release-left",
  E: "record-finish",
  "5": "skill-run-taught",
  N: "skill-run-sample",
  Q: "offer-skill-sample",
  "6": "let-go-left",
  X: "object-left",
  "7": "skill-edit-too-fast",
  "8": "skill-restore-sample",
  "9": "skills-list",
  b: "finger-left",
  "[": "pose-stowed-left",
  "]": "pose-stowed-right",
};

export const MOTION_HELP = `Arms (SIMULATED): s stop switch press/release   h unplug/replug the handle   1/2 torque on left/right (then c)
      0 torque off left   P left arm to "ready" (then c)   H left to "handover"   O an offer: left to "ready" (then c)
      L teleop left (then c)   M match the left leader to its arm   V move the left leader slowly   J jerk it fast
      S terminal stop   C terminal clear (then c)   F left servo 3 stops answering   B push the left elbow
      W block the left elbow   Y make it stiff   Z lean on it   U unplug the left arm   G move the left goals away   I inspect   A status
Skills (SIMULATED): R record the left arm as "sim_taught" (then M first, and c)   T teach: move the left leader through a pick
      3 mark a grasp   4 mark a release   S end the recording   E save it   X an object in the left gripper / taken away
      5 run "sim_taught" (then c)   N run the made-up sample skill (then c)   Q offer the sample (then c)   6 "Let go?" again
      7 edit the sample file to be too fast   8 put the sample back   9 list the skills   b a finger in the left gripper / out
      [ fold the left arm away ("stowed", then c)   ] fold the right arm away (then c)`;
