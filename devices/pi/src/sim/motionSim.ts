import { existsSync } from "node:fs";
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
import { MotionFiles } from "../motion/files";
import { ManualStopSense } from "../motion/stopSense";
import { FakeStsBus } from "./fakeFeetech";

/**
 * SIMULATED arms for `walker simulate --arms` and the tests: four fake STS3215 buses (two followers, two
 * leaders) through the real coordinator, a simulated stop switch, and fault injection. The fake servos use the
 * dangerous default (`torqueOnHoldsPosition: false`: torque on drives to whatever goal is in the register), so
 * a coordinator that forgot goal = present would be caught. Nothing here is hardware, and the simulator's
 * calibrations and poses are made up for it, not measured.
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
    },
  ) {
    const files = new MotionFiles(deps.stateDir, deps.log);
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
      stopSense: this.stopSwitch,
      bench: deps.bench,
      handControls: deps.handControls,
      ...(deps.walkerProposalOpen ? { walkerProposalOpen: deps.walkerProposalOpen } : {}),
      say: deps.say,
      ...(deps.newId ? { newId: deps.newId } : {}),
    });
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
        // A hold that read first sets each torqued servo's goal to where it was at the stop (the last handle press
        // or handle unplug), within 0.5°; one made from the tick before would lag by up to a tick of motion.
        const servos = [...this.fake("left", "follower").servos.values()].filter((s) => s.get("torqueEnable") === 1);
        const gap = Math.max(0, ...servos.map((s) => Math.abs(s.get("goalPosition") - (this.marked.get(s.id) ?? Infinity))));
        this.sim(gap <= degToTicks(0.5) ? "left follower hold tight ok" : `left follower hold tight BAD gap=${gap}`);
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
    };
    return out;
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
};

export const MOTION_HELP = `Arms (SIMULATED): s stop switch press/release   h unplug/replug the handle   1/2 torque on left/right (then c)
      0 torque off left   P left arm to "ready" (then c)   H left to "handover"   O an offer: left to "ready" (then c)
      L teleop left (then c)   M match the left leader to its arm   V move the left leader slowly   J jerk it fast
      S terminal stop   C terminal clear (then c)   F left servo 3 stops answering   B push the left elbow
      W block the left elbow   Y make it stiff   Z lean on it   U unplug the left arm   G move the left goals away   I inspect   A status`;
