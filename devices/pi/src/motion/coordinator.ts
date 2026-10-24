import { randomUUID } from "node:crypto";
import {
  ARM_COMPLIANT_TORQUE_PCT,
  ARM_JOINTS,
  ARM_OVERLOAD_MS,
  ARM_OVERLOAD_PCT,
  ARM_TEMPERATURE_LIMIT_C,
  ARM_UNDERVOLTAGE_V,
  AT_POSE_TOLERANCE_DEG,
  ArmCalibrationSchema,
  CONFIRM_ARM_DELAY_MS,
  ConfirmActionSchema,
  ConfirmTargetSchema,
  DEFAULT_SERVO_IDS,
  FAULT_REACTION,
  FAULT_SENTENCES,
  FEEDBACK_DIVERGENCE_DEG,
  FEEDBACK_DIVERGENCE_MS,
  FEEDBACK_STALE_MS,
  MOTION_COMMAND_POLICY,
  MOTION_CONTRACT_VERSION,
  MOTION_CONTROL_PERIOD_MS,
  MotionCommandSchema,
  MotionOfferRequestSchema,
  MotionStateSchema,
  NamedPoseSchema,
  PoseNameSchema,
  REFUSAL_SENTENCES,
  SERVO_TICKS_PER_TURN,
  TELEOP_ENGAGE_TOLERANCE_DEG,
  TELEOP_GAP_DEG,
  TELEOP_GAP_MS,
  TELEOP_MAX_SESSION_MS,
  TELEOP_OVERSPEED_FACTOR,
  TELEOP_OVERSPEED_MS,
  WALKER_CONFIRM_WAIT_MS,
  allowedWhileFaulted,
  commandMatchesTarget,
  confirmPressVerdict,
  confirmPrompt,
  degreesToTicks,
  isPreparerAllowed,
  jointsOutsideCalibration,
  mayReplaceConfirmTarget,
  motionTimeoutMs,
  ticksToDegrees,
  type ArmCalibration,
  type ArmJoint,
  type ArmJoints,
  type ArmRole,
  type ArmSide,
  type ArmState,
  type ConfirmAction,
  type ConfirmPressEvidence,
  type ConfirmTarget,
  type JointCalibration,
  type MotionCommand,
  type MotionCommandKind,
  type MotionFault,
  type MotionFaultCode,
  type MotionMode,
  type MotionPart,
  type MotionRefusal,
  type MotionState,
  type NamedPose,
  type Preparer,
  type StopSource,
} from "@walker/contracts";
import type { Bus, ButtonEvent } from "../bus";
import type { Cancel, Clock } from "../clock";
import type { Logger } from "../log";
import { ArmLink, openArmLink, type ServoState } from "./arm";
import { FeetechError, type ReadResult } from "./feetech/bus";
import { SERVO_ERROR_BITS } from "./feetech/protocol";
import type { FeetechPort } from "./feetech/port";
import type { MotionFiles } from "./files";
import {
  SERVO_ACCELERATION_REGISTER,
  clampToFollower,
  jointTorquePct,
  largestGap,
  lineSpeeds,
  modeLimits,
  nextGoal,
  servoSpeedRegister,
  stepSeconds,
  teleopSpeedDegS,
  torqueRegister,
} from "./limits";
import type { StopReading, StopSense } from "./stopSense";

/**
 * The Pi's motion coordinator for the two SO-101 arms (part A: arms, safety, calibration, poses, teleop),
 * following the motion contract (packages/contracts/src/motion.ts, docs/subsystems/manipulation.md). The lift
 * and recorded skills are part B: their commands are refused here (`part_missing`, `unknown_skill`).
 *
 * The rule: motors move only while a person at the walker is acting.
 * - Preparing: the terminal (`operator*`), the cloud's id-only offers (`requestOffer`) and, later, the screen
 *   and the Pi's own "Let go?" can only prepare a command. It becomes the ONE pending Confirm target, worded by
 *   the Pi (`confirmPrompt`), shown and said.
 * - Starting: only a handle Confirm press on that target (`handlePress`), at least CONFIRM_ARM_DELAY_MS and less
 *   than WALKER_CONFIRM_WAIT_MS after it appeared, builds and runs the command. Earlier presses are ignored.
 * - Stopping: any new handle press while anything moves, the terminal, or the guard.
 * Nothing reads an initiator, a confirm record or `base_parked` from a message: the coordinator builds them.
 *
 * READ BEFORE ACT. The coordinator never acts on what it believes a servo is doing, only on what it read from
 * the servo. Every reading (each control tick's one SYNC READ) carries the control registers (torque enable,
 * goal, goal speed, acceleration, torque limit) with the feedback. Torque "on" means the latest fresh reading
 * says on, or else it is unknown. Before any goal write, torque on or hold, it reads; it writes only to servos
 * that read on; and torque on reads every write back (limits, then goal = present with speed and
 * acceleration, then torque) and aborts, turning that arm's torque off, on any mismatch. An arm is fit to move
 * only after torque on wrote and read back its limits (`limitsWritten`), and that ends when a reading shows its
 * torque off or a limit not the one written (a power loss resets both), or its readings stop.
 *
 * Every number not from the contract is a placeholder, not measured. Nothing here has run on real servos.
 */

export interface MotionArmPort {
  side: ArmSide;
  role: ArmRole;
  /** The adapter's by-id name: the calibration file's `bus_id`. */
  busId: string;
  /** Opens a fresh connection to the adapter (each call a new one). */
  openPort: () => FeetechPort;
}

export interface CoordinatorDeps {
  clock: Clock;
  log: Logger;
  bus: Bus;
  files: MotionFiles;
  arms: MotionArmPort[];
  stopSense: StopSense;
  bench: boolean;
  /** Whether a hand control that can confirm and stop (a handle module or the Pi's GPIO buttons) is connected now. */
  handControls: () => boolean;
  /** Whether the walker's own proposal (a settings change Confirm already answers) is open: it owns Confirm first. */
  walkerProposalOpen?: () => boolean;
  /** Speaks one of the Pi's own lines (and shows it on the walker page). */
  say: (text: string) => void;
  newId?: () => string;
}

/** Placeholder, not measured: how often a missing or failed arm is tried again. */
export const ARM_RECONNECT_MS = 3000;
/** Placeholder: how often the motion state is published to the bus (the walker screen's slot). */
export const MOTION_STATE_PUBLISH_MS = 200;
/** Placeholder, not measured: calibration refuses a joint that moved less than this (it probably wasn't moved). */
export const CALIBRATION_MIN_RANGE_DEG = 20;
/** Placeholder: a recorded range this wide probably wrapped past 0/4095 on the way, so it is refused. */
export const CALIBRATION_MAX_RANGE_DEG = 350;
/** Placeholder, not measured: after the offset write, every servo must read this close to the centre (2048). */
export const CALIBRATION_CENTRE_TOLERANCE_TICKS = 16;
/** Placeholder: in bench mode the moving arm's angles are logged this often. */
export const BENCH_LOG_MS = 500;
/** Placeholder: in bench mode the slowest control tick and the bus counters are logged this often. */
export const BENCH_LOOP_LOG_MS = 5000;
/**
 * The stall and load rules (not in the contract; both latch its `feedback_divergence` with its `comply`
 * reaction). The lead clamp keeps a blocked joint's goal within MAX_GOAL_LEAD_DEG, so the 10° divergence rule
 * can't see it, and ARM_OVERLOAD_PCT is above the arm's own torque limit, so the load rule can't either: without
 * these, a blocked joint (a finger, a tray edge) is pushed at its torque limit until the move's deadline.
 * - Stall: while that arm is being moved, a joint whose goal is more than STALL_LEAD_DEG ahead of it while its
 *   measured speed (from successive readings, not the servo's speed register, whose unit is unchecked) is under
 *   STALL_SPEED_DEG_S, for STALL_WINDOW_MS.
 * - Load: a joint whose load is above STALL_LOAD_FRACTION of its own torque limit for STALL_WINDOW_MS, moving or
 *   holding (someone pushing a holding arm).
 * Placeholders, not measured. A joint that sags under gravity while holding isn't moving, so the stall rule
 * doesn't apply then; the load rule does, so the bench must check it against the hold-up load.
 */
export const STALL_WINDOW_MS = 300;
export const STALL_LEAD_DEG = 3;
export const STALL_SPEED_DEG_S = 3;
export const STALL_LOAD_FRACTION = 0.8;
/** Placeholder: the stall rule's speed needs two tick readings at least this far apart. */
export const STALL_MIN_DT_MS = 10;

const HALF_TURN = SERVO_TICKS_PER_TURN / 2;
const DIVERGENCE_TICKS = (FEEDBACK_DIVERGENCE_DEG * SERVO_TICKS_PER_TURN) / 360;
const iso = (ms: number) => new Date(ms).toISOString();
const round1 = (n: number) => Math.round(n * 10) / 10;

interface Reading {
  at: number;
  values: Map<number, ServoState>;
  errors: Map<number, number>;
}

interface Slot {
  side: ArmSide;
  role: ArmRole;
  part: MotionPart;
  label: string;
  port: MotionArmPort;
  /** Servo ids in joint order. */
  ids: number[];
  calibration: ArmCalibration | null;
  link: ArmLink | null;
  connecting: boolean;
  reading: Reading | null;
  /**
   * Torque on and its limits written and read back by torque on, and nothing since has shown otherwise (a
   * reading with torque off or another limit, stale readings, a lost bus). Moving needs it.
   */
  limitsWritten: boolean;
  /** The torque limit register value torque on (or comply) wrote and read back, per servo id. */
  writtenLimits: Map<number, number>;
  /** Last goal written, in ticks per servo id. */
  goalTicks: Map<number, number>;
  /** The same goal in degrees (followers being moved), so ramps keep fractions of a tick. */
  goalDeg: ArmJoints | null;
  /** feedback_stale or servo_bus_lost: no goal is written to this arm until the fault clears. */
  frozen: boolean;
  /** feedback_divergence: its torque limit is ARM_COMPLIANT_TORQUE_PCT until torque is turned on again. */
  compliant: boolean;
  divergeSince: Map<number, number>;
  overloadSince: Map<number, number>;
  /** The stall and load rules' timers, per servo id. */
  stallSince: Map<number, number>;
  loadSince: Map<number, number>;
  /** The control loop's own last two readings, for each joint's measured speed (off-tick reads don't count). */
  previous: Reading | null;
  tickReading: Reading | null;
  /** A tick read of this arm is on the bus now (each arm is read on its own, so a slow bus never holds up another). */
  reading_in_flight: boolean;
  /**
   * Bumped, synchronously, before every torque-off write to this arm. A hold or a re-read captures it before its
   * read and writes no goal if it changed meanwhile: a goal written after a torque off could turn torque back on.
   */
  torqueOffSeq: number;
  lastReadError: number;
}

type ConfirmedCommand = Exclude<MotionCommand, { kind: "motion.stop" } | { kind: "teleop.stop" }>;

type Active =
  | {
      kind: "arm.go_to_pose";
      command: ConfirmedCommand & { kind: "arm.go_to_pose" };
      slot: Slot;
      target: ArmJoints;
      speeds: Record<ArmJoint, number>;
      startedMono: number;
      deadlineMono: number;
      lastStepMono: number;
      lastBenchLog: number;
    }
  | {
      kind: "teleop";
      command: ConfirmedCommand & { kind: "teleop.start" };
      pairs: Array<{
        leader: Slot;
        follower: Slot;
        lastLeader: { joints: ArmJoints; at: number } | null;
        overspeedSince: number | null;
        gapSince: number | null;
      }>;
      speedDegS: number;
      startedMono: number;
      deadlineMono: number;
      lastStepMono: number;
      lastBenchLog: number;
    };

/** One terminal request, as the CLI polls it. Its id is its Confirm target's id. */
export interface OperatorRequest {
  id: string;
  kind: MotionCommandKind;
  state: "waiting_confirm" | "refused" | "running" | "completed" | "stopped" | "faulted" | "expired" | "error";
  /** What the walker showed and said for the Confirm press. */
  prompt: string | null;
  refusal: MotionRefusal | null;
  sentence: string | null;
  detail: string | null;
}

/** The pending target, and what the coordinator keeps beside it (never shown). */
interface Pending {
  target: ConfirmTarget;
  /** A pose's joints when it was prepared: the run must use exactly these. */
  snapshot: ArmJoints | null;
  request: OperatorRequest | null;
  /** A calibration that starts once this torque-off target runs. */
  thenCalibrate: Slot | null;
  /** The mode it was prepared in: if the mode changes, the target is withdrawn. */
  preparedMode: MotionMode;
}

/** What the coordinator has seen of one handle button: down now, or released since when (monotonic ms). */
interface ButtonSeen {
  down: boolean;
  releasedAt: number;
}

interface CalibrationRun {
  slot: Slot;
  phase: "middle" | "range";
  offsets: Map<number, number>;
  original: Map<number, number>;
  zero: Map<number, number>;
  min: Map<number, number>;
  max: Map<number, number>;
  busy: boolean;
  /** Servo ids whose offset register this calibration has written (written back if it fails or is cancelled). */
  written: number[];
  /** The old calibration file and poses file, set aside: put back if the calibration doesn't finish. */
  retiredCalibration: string | null;
  posesBackup: string | null;
}

export type OperatorResult<T = Record<string, unknown>> = ({ ok: true } & T) | { ok: false; error: string };

/** Placeholder: terminal requests kept for the CLI to poll. */
const REQUESTS_KEPT = 50;

/** Which handle a press came from. The contract's confirm record names a side; see `handleSide`. */
export function handleSide(event: ButtonEvent): ArmSide {
  const match = /^hand-(left|right)\b/.exec(event.detail ?? "");
  // The Pi's GPIO Confirm button and the simulator keyboard have no side. Confirm is on the left handle
  // (hardware/current-build.md: hand-left GPIO32 maps to Confirm), so they count as the left handle.
  return (match?.[1] as ArmSide | undefined) ?? "left";
}

export class MotionCoordinator {
  private readonly slots: Slot[];
  private readonly newId: () => string;
  private faults: MotionFault[] = [];
  private active: Active | null = null;
  private pending: Pending | null = null;
  private calibration: CalibrationRun | null = null;
  /** A non-moving command (torque on/off) is writing to the bus now. */
  private commandBusy = false;
  /** A stop came while torque on was running: it stops at its next step. */
  private torqueAbort = false;
  private slowestTickMs = 0;
  private lastLoopLog = -Infinity;
  private starting = true;
  private stopped = false;
  /** When the coordinator began watching the buttons: a button not seen since counts as released from then. */
  private startedMono = 0;
  private lastCommand: MotionState["last_command"] = null;
  private poses: NamedPose[] = [];
  private readonly requests = new Map<string, OperatorRequest>();
  private readonly pressResults = new WeakMap<ButtonEvent, boolean>();
  /** Every handle button's last edge, by `source:detail:button`. A button never seen counts as released. */
  private readonly buttonsSeen = new Map<string, ButtonSeen>();
  /** When each hand's (or the GPIO buttons') state was last forgotten: a hello, a loss or a gap in its lines. */
  private readonly buttonsReset = new Map<string, number>();
  private handsWereConnected = false;
  private cancelTick: Cancel | null = null;
  private cancelReconnect: Cancel | null = null;
  private lastPublish = -Infinity;
  private lastMode: MotionMode | null = null;
  private readonly unsubscribe: Array<() => void> = [];

  constructor(private readonly deps: CoordinatorDeps) {
    this.newId = deps.newId ?? randomUUID;
    this.slots = deps.arms.map((port) => ({
      side: port.side,
      role: port.role,
      part: `${port.role === "follower" ? "arm" : "leader"}_${port.side}` as MotionPart,
      label: `${port.side} ${port.role}`,
      port,
      ids: ARM_JOINTS.map((joint) => DEFAULT_SERVO_IDS[joint]),
      calibration: null,
      link: null,
      connecting: false,
      reading: null,
      limitsWritten: false,
      writtenLimits: new Map(),
      goalTicks: new Map(),
      goalDeg: null,
      frozen: false,
      compliant: false,
      divergeSince: new Map(),
      overloadSince: new Map(),
      stallSince: new Map(),
      loadSince: new Map(),
      previous: null,
      tickReading: null,
      reading_in_flight: false,
      torqueOffSeq: 0,
      lastReadError: -Infinity,
    }));
  }

  /** The monotonic clock in whole milliseconds, as the contract's `mono` fields need. */
  private mono(): number {
    return Math.floor(this.deps.clock.monotonic());
  }

  // ---- Start and stop ----

  async start(): Promise<void> {
    const { bus, stopSense, log } = this.deps;
    this.startedMono = this.mono();
    this.poses = this.deps.files.readPoses();
    for (const slot of this.slots) this.loadCalibration(slot);
    this.unsubscribe.push(
      bus.on("button", (event) => {
        this.handlePress(event);
      }),
      bus.on("buttonsLost", ({ source, detail }) => {
        this.forgetButtons(source, detail);
        this.checkHandControls();
      }),
      bus.on("moduleDown", () => this.checkHandControls()),
      // A hand's hello, loss or a gap in its lines: what is known about its buttons may be wrong.
      bus.on("handLink", ({ instanceId, why }) => this.forgetButtons("esp32", instanceId, why)),
    );
    stopSense.onChange((reading) => this.onStopReading(reading));
    stopSense.start();
    log.info("motion coordinator starting", { bench: this.deps.bench, stop_sense: stopSense.reading(), arms: this.slots.map((s) => s.label).join(", ") });
    if (this.deps.bench) log.warn("BENCH MODE: no hardware stop is required; bench limits apply and every motion is logged");
    this.handsWereConnected = this.deps.handControls();
    // The first reading of the stop-sense input (a GPIO is read once before it is watched): an unread input
    // counts as pressed for refusing motion, but only a real reading of pressed latches at boot.
    await stopSense.ready();
    if (stopSense.reading() === "pressed") this.latch("stop_circuit_opened", "system", null, "the stop reads pressed at start");
    await Promise.all(this.slots.map((slot) => this.connect(slot)));
    this.starting = false;
    this.event("mode", this.mode());
    this.scheduleTick(0);
    this.scheduleReconnect();
    this.publish(true);
  }

  /** Service shutdown: hold every follower where it is, let those writes go out (up to 300 ms), then close. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.cancelTick?.();
    this.cancelReconnect?.();
    for (const off of this.unsubscribe) off();
    this.deps.stopSense.stop();
    const writes = this.holdAll();
    let cancel: Cancel = () => {};
    await Promise.race([Promise.allSettled(writes), new Promise<void>((resolve) => (cancel = this.deps.clock.setTimeout(resolve, 300)))]);
    cancel();
    for (const slot of this.slots) slot.link?.close();
  }

  /** Whether a motion Confirm target is pending or a motion runs: the walker service then announces no proposal. */
  ownsConfirm(): boolean {
    return this.pending !== null || this.active !== null;
  }

  // ---- Input: handle presses (the only thing that starts anything) ----

  /**
   * A handle press edge. Returns true when motion used the press, so the walker service doesn't also treat it
   * as Talk or Confirm. Idempotent per event: the coordinator's own bus listener and the service both call it.
   * - Anything moving: any press stops it (`handle_press`).
   * - A Confirm press with a target pending: too early (first CONFIRM_ARM_DELAY_MS) it is ignored, and still
   *   taken, so it can't answer something else; in its window it builds and runs the target's command.
   */
  handlePress(event: ButtonEvent): boolean {
    // Called from the serial and GPIO handlers: nothing may throw back into them. A failure stops motion.
    try {
      return this.pressed(event);
    } catch (error) {
      this.deps.log.error("motion press handling failed; stopping motion", { error: (error as Error).message });
      this.pressResults.set(event, true);
      try {
        this.stopMotion("motion_guard", "press handling failed");
      } catch {
        // Already reported.
      }
      return true;
    }
  }

  /** Stops everything from outside (an unexpected error in the service): never throws. */
  emergencyStop(why: string): void {
    try {
      this.stopMotion("motion_guard", why);
    } catch (error) {
      this.deps.log.error("motion emergency stop failed", { error: (error as Error).message });
    }
  }

  private pressed(event: ButtonEvent): boolean {
    const known = this.pressResults.get(event);
    if (known !== undefined) return known;
    let claimed = false;
    const key = `${event.source}:${event.detail ?? ""}:${event.button}`;
    const nowMono = this.mono();
    const seen = this.buttonsSeen.get(key);
    if (event.edge === "released") {
      this.buttonsSeen.set(key, { down: false, releasedAt: nowMono });
    } else {
      // The contract's press evidence (ConfirmPressEvidence). Released since: this button's last release edge;
      // if it hasn't been pressed since its module's hello (or since the coordinator started watching), that
      // moment; null while it is seen down. Module reset: its latest hello, seq gap, error line or loss.
      const prefix = `${event.source}:${event.source === "esp32" ? (event.detail ?? "") : ""}`;
      const reset = this.buttonsReset.get(prefix) ?? null;
      const baseline = reset ?? this.startedMono;
      const releasedSince = seen === undefined ? baseline : seen.down ? null : Math.max(seen.releasedAt, reset ?? -Infinity);
      // The keyboard (simulator) only ever presses, so each press counts as a press and a release.
      this.buttonsSeen.set(key, event.source === "keyboard" ? { down: false, releasedAt: nowMono } : { down: true, releasedAt: seen?.releasedAt ?? baseline });
      if (!this.stopped) {
        // Anything running, a torque on included, is stopped by the press, and the press is motion's alone.
        if (this.active || this.commandBusy) {
          this.stopMotion("handle_press", `${event.button} press (${event.source})`);
          claimed = true;
        } else if (event.button === "confirm" && this.pending) {
          claimed = this.confirmPressed(event, { pressed_mono_ms: nowMono, released_since_mono_ms: releasedSince, module_reset_mono_ms: reset });
        } else if (event.button === "talk" && this.pending) {
          // She is asking Sophi something else now: the motion question is withdrawn, so a Confirm meant for
          // whatever the reply proposes can't answer it. The Talk press itself goes on to the walker service.
          this.endPending("withdrawn", "Talk pressed");
        }
      }
    }
    this.pressResults.set(event, claimed);
    return claimed;
  }

  /** A hand's buttons can't be trusted now (hello, loss, a gap in its lines): forget them and withdraw the target. */
  private forgetButtons(source: string, detail: string | undefined, why = "lost"): void {
    const prefix = `${source}:${source === "esp32" ? (detail ?? "") : ""}`;
    for (const key of [...this.buttonsSeen.keys()]) if (key.startsWith(prefix)) this.buttonsSeen.delete(key);
    // Its window starts again from now: a press must come CONFIRM_ARM_DELAY_MS after this, whatever it saw before.
    this.buttonsReset.set(prefix, this.mono());
    if (this.pending) this.endPending("withdrawn", `hand control ${why}`);
    // During motion a handle that went away, rebooted or lost a line may have lost a stop press: stop and hold.
    if (this.active) this.latch("hand_controls_lost", "system", null, `a hand control: ${why}`);
  }

  /** The terminal that prepared this request went away (Ctrl-C, a dropped SSH): its target is withdrawn. */
  operatorWithdraw(id: string): void {
    if (this.pending?.request?.id === id) this.endPending("withdrawn", "the terminal went away");
  }

  /** The terminal that started this request went away while it runs (a teleop, a move): it is stopped. */
  operatorStopIfRunning(id: string): void {
    if (this.active?.command.target_id === id) this.stopMotion("operator_cli", "the terminal that started it went away");
  }

  // ---- Preparing (terminal, offers): each becomes the one pending Confirm target ----

  /** An offer from the cloud, by ids only. Dropped (null) unless this walker has that pose and can prepare it now. */
  requestOffer(raw: unknown): ConfirmTarget | null {
    const parsed = MotionOfferRequestSchema.safeParse(raw);
    if (!parsed.success) {
      this.deps.log.warn("motion offer request dropped: not ids the contract allows");
      return null;
    }
    const target = parsed.data.target;
    if (target.kind !== "arm.go_to_pose") {
      this.deps.log.info("motion offer request dropped: skills aren't built yet");
      return null;
    }
    const pose = this.findPose(target.arm, target.pose);
    if (!pose) {
      this.deps.log.info("motion offer request dropped: this walker has no such pose", { arm: target.arm, pose: target.pose });
      return null;
    }
    const result = this.prepare({ kind: "arm.go_to_pose", arm: target.arm, pose: pose.name }, "offer", pose.title, { ...pose.joints });
    if (!result.ok) {
      this.deps.log.info("motion offer request dropped", { reason: result.error });
      return null;
    }
    return this.pending?.target ?? null;
  }

  /** `walker motion stop`: always allowed, never waits for Confirm. */
  operatorStop(): OperatorResult<{ stopped: boolean }> {
    const was = this.active !== null;
    this.stopMotion("operator_cli", "terminal stop");
    return { ok: true, stopped: was };
  }

  operatorTorque(enabled: boolean, arms: ArmSide[] | null): OperatorResult<{ request: OperatorRequest }> {
    const sides = [...new Set(arms ?? this.slots.filter((s) => s.role === "follower").map((s) => s.side))];
    if (sides.length === 0 || sides.some((side) => !this.follower(side))) return { ok: false, error: "no such follower arm is configured" };
    const words = sides.length === 2 ? "both arms'" : `the ${sides[0]} arm's`;
    return this.prepareRequest(
      { kind: "arm.torque", arms: sides, enabled },
      // Titles are at most 60 characters (the contract's), so each says only what the walker must say.
      enabled ? `Turn on ${words} motors` : `Turn off ${words} motors; hold it, it goes limp`,
    );
  }

  operatorGoToPose(arm: ArmSide, poseName: string): OperatorResult<{ request: OperatorRequest }> {
    const pose = this.findPose(arm, poseName);
    if (!pose) return { ok: false, error: REFUSAL_SENTENCES.unknown_pose };
    return this.prepareRequest({ kind: "arm.go_to_pose", arm, pose: pose.name }, pose.title, { ...pose.joints });
  }

  operatorTeleop(side: ArmSide): OperatorResult<{ request: OperatorRequest }> {
    return this.prepareRequest({ kind: "teleop.start", pairs: [{ leader: side, follower: side }] }, `The ${side} arm will copy its teaching arm`);
  }

  operatorClear(reason: string): OperatorResult<{ request: OperatorRequest }> {
    const clean = reason.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ").trim().slice(0, 200);
    if (clean.length < 3) return { ok: false, error: "say why it is safe to clear (--reason)" };
    this.deps.log.info("fault clear prepared at the terminal", { reason: clean, faults: this.faults.map((f) => `${f.code}/${f.part}`).join(",") });
    return this.prepareRequest({ kind: "fault.clear" }, "Clear the arm faults");
  }

  operatorRequestStatus(id: string): OperatorRequest | null {
    const request = this.requests.get(id);
    return request ? { ...request } : null;
  }

  operatorPoses(): NamedPose[] {
    return this.poses.map((pose) => ({ ...pose, joints: { ...pose.joints } }));
  }

  /** `walker arms pose save`: records where each named follower is now. It moves nothing, so it needs no Confirm. */
  operatorSavePose(name: string, title: string | null, arms: ArmSide[] | null): OperatorResult<{ saved: NamedPose[] }> {
    if (!PoseNameSchema.safeParse(name).success) return { ok: false, error: "a pose name is lowercase letters, digits and _ (at most 32)" };
    const sides = arms ?? this.slots.filter((s) => s.role === "follower" && s.link && s.calibration).map((s) => s.side);
    if (sides.length === 0) return { ok: false, error: "no connected, calibrated follower arm" };
    const saved: NamedPose[] = [];
    for (const side of sides) {
      const slot = this.follower(side);
      if (!slot?.link) return { ok: false, error: `the ${side} arm isn't connected` };
      if (!slot.calibration) return { ok: false, error: `the ${side} arm isn't calibrated` };
      const joints = this.degrees(slot);
      if (!joints) return { ok: false, error: `the ${side} arm isn't reporting its position` };
      const outside = jointsOutsideCalibration(joints, slot.calibration);
      if (outside.length > 0) {
        const p = outside[0]!;
        return { ok: false, error: `${p.joint} is at ${round1(p.degrees)}°, outside ${round1(p.min)}° to ${round1(p.max)}° (its calibrated range less the margin)` };
      }
      const pose = NamedPoseSchema.safeParse({
        name,
        title: title ?? `Move the ${side} arm to ${name.replace(/_/g, " ")}`,
        arm: side,
        joints: Object.fromEntries(ARM_JOINTS.map((j) => [j, round1(joints[j])])),
        updated_at: iso(this.deps.clock.now()),
      });
      if (!pose.success) return { ok: false, error: `that pose can't be saved: ${pose.error.issues[0]?.message ?? "invalid"}` };
      saved.push(pose.data);
    }
    const kept = this.poses.filter((p) => !saved.some((s) => s.arm === p.arm && s.name === p.name));
    try {
      this.deps.files.writePoses([...kept, ...saved]);
    } catch (error) {
      return { ok: false, error: `couldn't save the poses file: ${(error as Error).message}` };
    }
    this.poses = [...kept, ...saved];
    for (const pose of saved) this.event("pose-saved", `${pose.arm} ${pose.name}`);
    return { ok: true, saved };
  }

  // ---- Calibration (a follower's torque goes off only through its Confirm target) ----

  /**
   * Step 1. A follower: prepares "turn its motors off" as a Confirm target, and the calibration starts once
   * that runs. A leader (no torque ever) starts at once: it only gets its offset registers written.
   */
  operatorCalibrateBegin(side: ArmSide, role: ArmRole): OperatorResult<{ request: OperatorRequest | null }> {
    const slot = this.slot(side, role);
    if (!slot) return { ok: false, error: `no ${side} ${role} is configured` };
    if (this.calibration) return { ok: false, error: "a calibration is already running" };
    if (role === "leader") {
      if (this.active || this.commandBusy) return { ok: false, error: REFUSAL_SENTENCES.busy };
      if (!slot.link || !this.fresh(slot)) return { ok: false, error: `the ${slot.label} isn't connected and reporting` };
      void this.beginCalibration(slot);
      return { ok: true, request: null };
    }
    return this.prepareRequest({ kind: "arm.torque", arms: [side], enabled: false }, `Calibrate the ${side} arm. Its motors turn off, so hold it`, null, slot);
  }

  /** Step 2: every joint sits in the middle of its range. Writes the servos' offsets so the middle reads 2048. */
  async operatorCalibrateMiddle(): Promise<OperatorResult> {
    const run = this.calibration;
    if (!run || run.phase !== "middle") return { ok: false, error: "no calibration is waiting for the middle position" };
    if (run.busy) return { ok: false, error: "busy" };
    const { slot } = run;
    const link = slot.link;
    if (!link || !this.fresh(slot)) return { ok: false, error: `the ${slot.label} isn't reporting its position` };
    run.busy = true;
    try {
      // Torque must be off for an EEPROM write; the driver refuses otherwise, and so do we.
      const torque = await link.readTorque();
      if ([...torque.values()].some((v) => v !== 0)) return { ok: false, error: "a servo's torque is on; calibration needs it off" };
      for (const id of slot.ids) run.original.set(id, (await link.bus.read(id, "homingOffset")).value);
      const reading = slot.reading!;
      for (const id of slot.ids) run.offsets.set(id, centringOffset(reading.values.get(id)!.presentPosition, run.original.get(id)!));
      // The old calibration no longer matches once an offset changes: retire it first.
      const stamp = iso(this.deps.clock.now());
      run.retiredCalibration = this.deps.files.retireCalibration(slot.side, slot.role, stamp);
      slot.calibration = null;
      // A follower's poses are angles from the old zero, so they no longer name the same places: they are set
      // aside (the old file is kept) and must be taught again.
      if (slot.role === "follower" && this.poses.some((p) => p.arm === slot.side)) {
        run.posesBackup = this.deps.files.backupPoses(stamp);
        this.poses = this.poses.filter((p) => p.arm !== slot.side);
        this.deps.files.writePoses(this.poses);
        this.event("poses-retired", slot.side);
      }
      for (const id of slot.ids) {
        run.written.push(id);
        await link.bus.unlockAndWriteEeprom(id, "homingOffset", run.offsets.get(id)!);
      }
      const after = await link.readFeedback();
      const off = slot.ids.filter((id) => Math.abs(after.get(id)!.value.presentPosition - HALF_TURN) > CALIBRATION_CENTRE_TOLERANCE_TICKS);
      if (off.length > 0) {
        // The offset didn't centre the reading: the register's sign or unit isn't what LeRobot's convention says.
        const detail = off.map((id) => `${id} reads ${after.get(id)!.value.presentPosition}`).join(", ");
        await this.undoCalibration(run);
        this.endCalibration("failed: offsets didn't centre");
        return { ok: false, error: `after writing the offsets, servo ${detail} instead of about 2048; the old offsets were written back. Stop and check the offset convention (feetech/README.md)` };
      }
      for (const id of slot.ids) {
        const p = after.get(id)!.value.presentPosition;
        run.zero.set(id, p);
        run.min.set(id, p);
        run.max.set(id, p);
      }
      run.phase = "range";
      this.event("calibration", `${slot.label} centred`);
      return { ok: true };
    } catch (error) {
      const restored = await this.undoCalibration(run);
      this.endCalibration(`failed: ${(error as Error).message}`);
      return {
        ok: false,
        error: `calibration stopped: ${(error as Error).message}. ${restored ? "The old offsets, calibration and poses are back" : "The arm stays uncalibrated: an old offset couldn't be written back"}`,
      };
    } finally {
      run.busy = false;
    }
  }

  /**
   * A calibration that didn't finish: writes the original offsets back to every servo it changed, then puts the
   * old calibration file and poses back (they match those offsets again). True when every offset went back.
   */
  private async undoCalibration(run: CalibrationRun): Promise<boolean> {
    const { slot } = run;
    const link = slot.link;
    let all = true;
    for (const id of run.written) {
      try {
        if (!link) throw new Error("no link");
        await link.bus.unlockAndWriteEeprom(id, "homingOffset", run.original.get(id)!);
      } catch (error) {
        all = false;
        this.deps.log.error("couldn't write an original offset back", { arm: slot.label, servo: id, error: (error as Error).message });
      }
    }
    run.written = [];
    if (!all) return false;
    try {
      if (run.retiredCalibration) this.deps.files.restoreCalibration(run.retiredCalibration, slot.side, slot.role);
      if (run.posesBackup) this.deps.files.restorePoses(run.posesBackup);
    } catch (error) {
      this.deps.log.error("couldn't put the old calibration or poses back", { arm: slot.label, error: (error as Error).message });
      return false;
    }
    this.loadCalibration(slot);
    this.poses = this.deps.files.readPoses();
    return true;
  }

  operatorCalibrateStatus(): OperatorResult<{
    phase: "middle" | "range";
    arm: string;
    joints: Array<{ joint: ArmJoint; id: number; min: number; now: number | null; max: number; range_deg: number }>;
  }> {
    const run = this.calibration;
    if (!run) return { ok: false, error: "no calibration is running" };
    const reading = this.fresh(run.slot) ? run.slot.reading : null;
    return {
      ok: true,
      phase: run.phase,
      arm: run.slot.label,
      joints: ARM_JOINTS.map((joint, i) => {
        const id = run.slot.ids[i]!;
        const min = run.min.get(id) ?? 0;
        const max = run.max.get(id) ?? 0;
        return { joint, id, min, now: reading?.values.get(id)?.presentPosition ?? null, max, range_deg: round1(((max - min) * 360) / SERVO_TICKS_PER_TURN) };
      }),
    };
  }

  /** Step 3: every joint went through its whole range. Saves the calibration file. */
  operatorCalibrateFinish(): OperatorResult<{ calibration: ArmCalibration }> {
    const run = this.calibration;
    if (!run || run.phase !== "range") return { ok: false, error: "no calibration is recording ranges" };
    const { slot } = run;
    const short = ARM_JOINTS.filter((_, i) => {
      const id = slot.ids[i]!;
      return ((run.max.get(id)! - run.min.get(id)!) * 360) / SERVO_TICKS_PER_TURN < CALIBRATION_MIN_RANGE_DEG;
    });
    if (short.length > 0) return { ok: false, error: `${short.join(", ")} moved less than ${CALIBRATION_MIN_RANGE_DEG}°: move every joint through its whole range` };
    // A range of most of a turn means the reading probably wrapped past 0/4095 on the way (or a joint went round).
    const wide = ARM_JOINTS.filter((_, i) => {
      const id = slot.ids[i]!;
      return ((run.max.get(id)! - run.min.get(id)!) * 360) / SERVO_TICKS_PER_TURN >= CALIBRATION_MAX_RANGE_DEG;
    });
    if (wide.length > 0) return { ok: false, error: `${wide.join(", ")} went ${CALIBRATION_MAX_RANGE_DEG}° or more: the reading may have wrapped. Cancel and calibrate again` };
    const joints = Object.fromEntries(
      ARM_JOINTS.map((joint, i) => {
        const id = slot.ids[i]!;
        const entry: JointCalibration = {
          servo_id: id,
          homing_offset: run.offsets.get(id)!,
          min_ticks: run.min.get(id)!,
          max_ticks: run.max.get(id)!,
          zero_ticks: run.zero.get(id)!,
          direction: 1,
        };
        return [joint, entry];
      }),
    );
    const parsed = ArmCalibrationSchema.safeParse({
      format: "sophi.arm_calibration",
      version: MOTION_CONTRACT_VERSION,
      arm: slot.side,
      role: slot.role,
      bus_id: slot.port.busId,
      calibrated_at: iso(this.deps.clock.now()),
      joints,
    });
    if (!parsed.success) return { ok: false, error: `the recorded ranges don't make a valid calibration: ${parsed.error.issues[0]?.message ?? "invalid"}` };
    try {
      this.deps.files.writeCalibration(parsed.data);
    } catch (error) {
      return { ok: false, error: `couldn't save the calibration: ${(error as Error).message}` };
    }
    slot.calibration = parsed.data;
    this.endCalibration("saved");
    return { ok: true, calibration: parsed.data };
  }

  /** Cancels a calibration; offsets it already wrote are written back, and the old files put back. */
  operatorCalibrateCancel(): OperatorResult {
    const run = this.calibration;
    if (!run) return { ok: true };
    this.endCalibration("cancelled");
    if (run.written.length > 0) {
      void this.undoCalibration(run).then((ok) =>
        this.event("calibration", `${run.slot.label} ${ok ? "old offsets written back" : "an old offset couldn't be written back: the arm stays uncalibrated"}`),
      );
    }
    return { ok: true };
  }

  // ---- State ----

  mode(): MotionMode {
    if (this.faults.length > 0) return "fault";
    if (this.active?.kind === "teleop") return "teleop";
    if (this.active) return "moving";
    if (this.starting || this.calibration) return "disabled";
    if (this.deps.stopSense.reading() === "not_wired" && !this.deps.bench) return "disabled";
    if (!this.slots.some((s) => s.role === "follower" && s.link)) return "disabled";
    return "ready";
  }

  state(): MotionState {
    const active = this.active;
    return {
      version: MOTION_CONTRACT_VERSION,
      generated_at: iso(this.deps.clock.now()),
      mode: this.mode(),
      bench_mode: this.deps.bench,
      stop_circuit: this.deps.stopSense.reading(),
      hand_controls_connected: this.deps.handControls(),
      arms: this.slots.map((slot) => this.armState(slot)),
      lift: null,
      active:
        active === null
          ? null
          : active.kind === "arm.go_to_pose"
            ? {
                kind: "arm.go_to_pose",
                command_id: active.command.command_id,
                target_id: active.command.target_id,
                started_at: active.command.confirm.pressed_at,
                arm: active.command.arm,
                pose: active.command.pose,
              }
            : {
                kind: "teleop",
                command_id: active.command.command_id,
                target_id: active.command.target_id,
                started_at: active.command.confirm.pressed_at,
                pairs: active.command.pairs,
                recording_skill_id: null,
              },
      confirm_target: this.pending ? { ...this.pending.target } : null,
      last_command: this.lastCommand,
      faults: [...this.faults],
    };
  }

  private armState(slot: Slot): ArmState {
    const connected = slot.link !== null;
    const faults = [...new Set(this.faults.filter((f) => f.part === slot.part).map((f) => f.code))];
    const degrees = connected ? this.degrees(slot) : null;
    const reading = slot.reading;
    const joints =
      degrees && reading
        ? (Object.fromEntries(
            ARM_JOINTS.map((joint, i) => {
              const f = reading.values.get(slot.ids[i]!)!;
              return [
                joint,
                {
                  degrees: Math.max(-180, Math.min(180, degrees[joint])),
                  temperature_c: Math.max(-40, Math.min(150, Math.round(f.presentTemperature))),
                  load_pct: Math.max(-100, Math.min(100, f.presentLoad / 10)),
                  voltage_v: Math.max(0, Math.min(20, f.presentVoltage / 10)),
                },
              ];
            }),
          ) as NonNullable<ArmState["joints"]>)
        : null;
    let pose: ArmState["pose"] = { status: "unknown" };
    if (joints && degrees) {
      const moving =
        (this.active?.kind === "arm.go_to_pose" && this.active.slot === slot) ||
        (this.active?.kind === "teleop" && this.active.pairs.some((p) => p.follower === slot || p.leader === slot));
      const at = slot.role === "follower" ? this.poses.find((p) => p.arm === slot.side && largestGap(p.joints, degrees).deg <= AT_POSE_TOLERANCE_DEG) : undefined;
      pose = moving ? { status: "moving" } : at ? { status: "at", name: at.name } : { status: "between" };
    }
    const read = connected ? this.torqueOf(slot) : "unknown";
    const torque = slot.role === "leader" && read === "on" ? "unknown" : read;
    // Grasps come with skills (part B): no arm grasps yet.
    return { arm: slot.side, role: slot.role, connected, calibrated: slot.calibration !== null, torque, pose, joints, grasp_active: false, faults };
  }

  // ---- The control loop ----

  private scheduleTick(delay: number): void {
    if (this.stopped) return;
    this.cancelTick = this.deps.clock.setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    if (this.stopped) return;
    const started = this.deps.clock.monotonic();
    try {
      // Each arm is read on its own: an arm whose read is still on the bus (retries on a bad bus) is skipped this
      // tick and doesn't hold up the others, so a healthy arm's reading never goes stale waiting for it. The tick
      // waits for this tick's reads up to most of a period, then acts on the latest readings.
      const reads: Array<Promise<void>> = [];
      for (const slot of this.slots) {
        if (slot.reading_in_flight || !slot.link) continue;
        slot.reading_in_flight = true;
        reads.push(this.read(slot).finally(() => (slot.reading_in_flight = false)));
      }
      let cancel: Cancel = () => {};
      await Promise.race([Promise.all(reads), new Promise<void>((resolve) => (cancel = this.deps.clock.setTimeout(resolve, MOTION_CONTROL_PERIOD_MS * 0.75)))]);
      cancel();
      if (!this.stopped) this.afterRead();
    } catch (error) {
      this.deps.log.error("motion loop error; stopping motion", { error: (error as Error).message });
      this.emergencyStop("loop error");
    }
    const took = this.deps.clock.monotonic() - started;
    this.benchLoopLog(took);
    this.scheduleTick(Math.max(0, MOTION_CONTROL_PERIOD_MS - took));
  }

  /** Bench mode: every BENCH_LOOP_LOG_MS, the slowest control tick since and each arm's bus counters. */
  private benchLoopLog(tookMs: number): void {
    if (!this.deps.bench) return;
    this.slowestTickMs = Math.max(this.slowestTickMs, tookMs);
    const now = this.deps.clock.monotonic();
    if (now - this.lastLoopLog < BENCH_LOOP_LOG_MS) return;
    this.lastLoopLog = now;
    const fields: Record<string, number | string> = { slowest_tick_ms: Math.round(this.slowestTickMs) };
    for (const slot of this.slots) {
      const stats = slot.link?.bus.stats;
      if (stats) fields[slot.label.replace(" ", "_")] = `exchanges=${stats.exchanges} retries=${stats.retries} timeouts=${stats.timeouts} failures=${stats.failures}`;
    }
    this.deps.log.info("BENCH loop", fields);
    this.slowestTickMs = 0;
  }

  private async read(slot: Slot): Promise<void> {
    const link = slot.link;
    if (!link || link.isClosed) return;
    try {
      const values = await link.readFeedback();
      if (slot.link !== link) return;
      this.takeReading(slot, values);
      slot.previous = slot.tickReading;
      slot.tickReading = slot.reading;
      const run = this.calibration;
      if (run?.slot === slot && run.phase === "range") {
        for (const id of slot.ids) {
          const p = slot.reading!.values.get(id)!.presentPosition;
          run.min.set(id, Math.min(run.min.get(id)!, p));
          run.max.set(id, Math.max(run.max.get(id)!, p));
        }
      }
    } catch (error) {
      const now = this.deps.clock.monotonic();
      if (now - slot.lastReadError > 5000) {
        slot.lastReadError = now;
        this.deps.log.warn("arm read failed", { arm: slot.label, error: error instanceof FeetechError ? error.kind : (error as Error).message });
      }
    }
  }

  /**
   * Stores a reading and checks what torque on wrote still holds: a servo reading torque off, or a torque limit
   * other than the one written (a power loss resets both), ends `limitsWritten`. A leader reading torque on gets
   * it turned off (leaders never get torque).
   */
  private takeReading(slot: Slot, values: Map<number, ReadResult<ServoState>>): void {
    slot.reading = {
      at: this.deps.clock.monotonic(),
      values: new Map([...values].map(([id, r]) => [id, r.value])),
      errors: new Map([...values].map(([id, r]) => [id, r.error])),
    };
    const read = slot.reading.values;
    if (slot.limitsWritten && slot.ids.some((id) => read.get(id)!.torqueEnable !== 1 || read.get(id)!.torqueLimit !== slot.writtenLimits.get(id))) {
      slot.limitsWritten = false;
      this.deps.log.warn("an arm's torque or torque limit isn't what torque on wrote (a power loss?); it must be turned on again", { arm: slot.label });
      this.event("limits-lost", slot.label);
    }
    if (slot.role === "leader" && slot.link && slot.ids.some((id) => read.get(id)!.torqueEnable !== 0)) {
      this.deps.log.warn("a teaching arm reads torque on; turning it off", { arm: slot.label });
      slot.link.setTorque(slot.ids, false).catch((error: unknown) => this.writeFailed(slot, error));
    }
  }

  /** Torque as last read: "on" or "off" only from a fresh reading where every servo agrees, else "unknown". */
  private torqueOf(slot: Slot): "on" | "off" | "unknown" {
    if (!this.fresh(slot)) return "unknown";
    return torqueFrom(slot.reading!, slot.ids);
  }

  private afterRead(): void {
    const now = this.deps.clock.monotonic();
    if (this.deps.stopSense.reading() === "pressed") this.latch("stop_circuit_opened", "system", null, "the stop reads pressed");
    this.checkHandControls();
    // CHECKS_WHILE_HOLDING: the servo limits, stale feedback and divergence run whether or not anything moves.
    for (const slot of this.slots) if (slot.role === "follower") this.servoGuards(slot, now);
    const active = this.active;
    if (active) {
      if (now >= active.deadlineMono) this.latch("motion_timeout", active.kind === "teleop" ? "system" : active.slot.part, null, "past its deadline");
      else if (active.kind === "arm.go_to_pose") this.stepPose(active, now);
      else this.stepTeleop(active, now);
    }
    if (this.pending && this.mono() >= this.pending.target.expires_mono_ms) this.endPending("expired", "no Confirm press in time");
    this.publish(false);
  }

  /**
   * For one follower whose torque may be on: stale feedback, temperature, supply, overload, the servo's own
   * fault bits, and divergence. These keep running while it holds (CHECKS_WHILE_HOLDING).
   */
  private servoGuards(slot: Slot, now: number): void {
    // Torque "unknown" may be on (a failed write or a mixed read), so it is watched too. While the stop reads
    // pressed the arms' power is cut and stop_circuit_opened is already latched.
    const last = slot.reading ? torqueFrom(slot.reading, slot.ids) : "unknown";
    if (!slot.link || last === "off" || slot.frozen || this.deps.stopSense.reading() === "pressed") return;
    if (!this.fresh(slot)) {
      this.latch("feedback_stale", slot.part, null, this.active ? "no fresh reading while moving" : "no fresh reading while holding");
      return;
    }
    const reading = slot.reading!;
    for (const [i, joint] of ARM_JOINTS.entries()) {
      const id = slot.ids[i]!;
      const f = reading.values.get(id)!;
      const bits = (reading.errors.get(id) ?? 0) | f.status;
      if (f.presentTemperature > ARM_TEMPERATURE_LIMIT_C || bits & SERVO_ERROR_BITS.overheat) {
        this.latch("overtemperature", slot.part, joint, `${f.presentTemperature} °C`);
        return;
      }
      if (f.presentVoltage / 10 < ARM_UNDERVOLTAGE_V || bits & SERVO_ERROR_BITS.voltage) {
        this.latch("undervoltage", slot.part, joint, `${f.presentVoltage / 10} V`);
        return;
      }
      if (bits & (SERVO_ERROR_BITS.overload | SERVO_ERROR_BITS.overcurrent)) {
        this.latch("overload", slot.part, joint, "servo overload flag");
        return;
      }
      if (bits & SERVO_ERROR_BITS.angleSensor) {
        this.latch("feedback_stale", slot.part, joint, "servo angle sensor flag");
        return;
      }
      if (Math.abs(f.presentLoad) / 10 > ARM_OVERLOAD_PCT) {
        const since = slot.overloadSince.get(id) ?? now;
        slot.overloadSince.set(id, since);
        if (now - since > ARM_OVERLOAD_MS) {
          this.latch("overload", slot.part, joint, `load ${f.presentLoad / 10}%`);
          return;
        }
      } else slot.overloadSince.delete(id);
      // Divergence, in ticks so it works whatever the calibration: goal and measured too far apart for too long.
      const goal = slot.goalTicks.get(id);
      if (goal === undefined || slot.compliant) continue;
      if (Math.abs(goal - f.presentPosition) > DIVERGENCE_TICKS) {
        const since = slot.divergeSince.get(id) ?? now;
        slot.divergeSince.set(id, since);
        if (now - since > FEEDBACK_DIVERGENCE_MS) {
          this.latch("feedback_divergence", slot.part, joint, `${round1(((goal - f.presentPosition) * 360) / SERVO_TICKS_PER_TURN)}° off its goal`);
          return;
        }
      } else slot.divergeSince.delete(id);
      if (this.stallOrLoad(slot, id, joint, goal, f, now)) return;
    }
  }

  /** The stall and load rules for one joint (see STALL_WINDOW_MS). True when it latched. */
  private stallOrLoad(slot: Slot, id: number, joint: ArmJoint, goal: number, f: ServoState, now: number): boolean {
    // A gripper with an active grasp is meant to be blocked (part B brings grasps; none is active yet).
    const limits = modeLimits(this.deps.bench);
    const loadPct = Math.abs(f.presentLoad) / 10;
    const loadLimit = STALL_LOAD_FRACTION * jointTorquePct(limits, joint);
    if (loadPct > loadLimit) {
      const since = slot.loadSince.get(id) ?? now;
      slot.loadSince.set(id, since);
      if (now - since > STALL_WINDOW_MS) {
        this.latch("feedback_divergence", slot.part, joint, `load ${loadPct}% over ${round1(loadLimit)}% (${STALL_LOAD_FRACTION} of its torque limit)`);
        return true;
      }
    } else slot.loadSince.delete(id);
    const moving =
      (this.active?.kind === "arm.go_to_pose" && this.active.slot === slot) ||
      (this.active?.kind === "teleop" && this.active.pairs.some((p) => p.follower === slot));
    const previous = slot.previous?.values.get(id);
    // The speed comes from the control loop's own consecutive readings, at least STALL_MIN_DT_MS apart.
    const reading = slot.tickReading;
    if (!moving || !previous || !slot.previous || !reading || reading.at - slot.previous.at < STALL_MIN_DT_MS) {
      slot.stallSince.delete(id);
      return false;
    }
    const now_ = reading.values.get(id)!;
    const leadDeg = (Math.abs(goal - f.presentPosition) * 360) / SERVO_TICKS_PER_TURN;
    const speedDegS = ((Math.abs(now_.presentPosition - previous.presentPosition) * 360) / SERVO_TICKS_PER_TURN) / ((reading.at - slot.previous.at) / 1000);
    if (leadDeg > STALL_LEAD_DEG && speedDegS < STALL_SPEED_DEG_S) {
      const since = slot.stallSince.get(id) ?? now;
      slot.stallSince.set(id, since);
      if (now - since > STALL_WINDOW_MS) {
        this.latch("feedback_divergence", slot.part, joint, `stalled: goal ${round1(leadDeg)}° ahead, moving ${round1(speedDegS)}°/s`);
        return true;
      }
    } else slot.stallSince.delete(id);
    return false;
  }

  private stepPose(active: Extract<Active, { kind: "arm.go_to_pose" }>, now: number): void {
    const slot = active.slot;
    if (!this.fresh(slot)) {
      this.latch("feedback_stale", slot.part, null, "no fresh reading while moving");
      return;
    }
    const measured = this.degrees(slot)!;
    const dt = stepSeconds(now - active.lastStepMono);
    active.lastStepMono = now;
    const previous = slot.goalDeg ?? measured;
    const goal = {} as ArmJoints;
    for (const joint of ARM_JOINTS) goal[joint] = nextGoal(previous[joint], active.target[joint], measured[joint], active.speeds[joint] * dt);
    this.writeGoalDegrees(slot, goal, active.speeds);
    this.benchLog(active, slot, measured, now);
    const arrived = ARM_JOINTS.every((j) => Math.abs(active.target[j] - measured[j]) <= AT_POSE_TOLERANCE_DEG && Math.abs(goal[j] - active.target[j]) < 1e-9);
    if (arrived) this.endActive("completed");
  }

  private stepTeleop(active: Extract<Active, { kind: "teleop" }>, now: number): void {
    const dt = stepSeconds(now - active.lastStepMono);
    active.lastStepMono = now;
    for (const pair of active.pairs) {
      const { leader, follower } = pair;
      if (!this.fresh(leader)) {
        // A stale leader freezes its follower (no goal from a stale reading) and latches feedback_stale.
        this.latch("feedback_stale", leader.part, null, "teaching arm not reporting", [follower]);
        return;
      }
      if (!this.fresh(follower)) {
        this.latch("feedback_stale", follower.part, null, "no fresh reading while following");
        return;
      }
      const lead = this.degrees(leader)!;
      const at = leader.reading!.at;
      // A fast leader is normal while teaching (the follower lags behind its clamp). Only far beyond the limit,
      // for TELEOP_OVERSPEED_MS, is it a fault.
      if (pair.lastLeader && at > pair.lastLeader.at) {
        const speed = largestGap(lead, pair.lastLeader.joints);
        const degS = speed.deg / ((at - pair.lastLeader.at) / 1000);
        if (degS > TELEOP_OVERSPEED_FACTOR * active.speedDegS) {
          pair.overspeedSince ??= pair.lastLeader.at;
          if (at - pair.overspeedSince >= TELEOP_OVERSPEED_MS) {
            this.latch("teleop_overspeed", leader.part, speed.joint, `${round1(degS)}°/s, over ${TELEOP_OVERSPEED_FACTOR}× ${active.speedDegS}°/s`);
            return;
          }
        } else pair.overspeedSince = null;
      }
      if (!pair.lastLeader || at > pair.lastLeader.at) pair.lastLeader = { joints: lead, at };
      const target = clampToFollower(lead, follower.calibration!);
      const measured = this.degrees(follower)!;
      const gap = largestGap(target, measured);
      if (gap.deg > TELEOP_GAP_DEG) {
        pair.gapSince ??= now;
        if (now - pair.gapSince > TELEOP_GAP_MS) {
          this.latch("teleop_gap", follower.part, gap.joint, `${round1(gap.deg)}° behind`);
          return;
        }
      } else pair.gapSince = null;
      const previous = follower.goalDeg ?? measured;
      const goal = {} as ArmJoints;
      const speeds = {} as Record<ArmJoint, number>;
      for (const joint of ARM_JOINTS) {
        goal[joint] = nextGoal(previous[joint], target[joint], measured[joint], active.speedDegS * dt);
        speeds[joint] = active.speedDegS;
      }
      this.writeGoalDegrees(follower, goal, speeds);
      this.benchLog(active, follower, measured, now);
    }
  }

  private benchLog(active: Active, slot: Slot, measured: ArmJoints, now: number): void {
    if (!this.deps.bench || now - active.lastBenchLog < BENCH_LOG_MS) return;
    active.lastBenchLog = now;
    this.deps.log.info("BENCH motion", { arm: slot.label, kind: active.kind, ...Object.fromEntries(ARM_JOINTS.map((j) => [j, round1(measured[j])])) });
  }

  // ---- Writes ----

  /** Writes a follower's goals in degrees: never to a frozen arm, never from a stale reading. */
  private writeGoalDegrees(slot: Slot, goal: ArmJoints, speeds: Record<ArmJoint, number>): void {
    const link = slot.link;
    const calibration = slot.calibration;
    // Only to an arm read with torque on, whose limits torque on wrote and read back.
    if (!link || !calibration || slot.frozen || !this.fresh(slot) || this.torqueOf(slot) !== "on" || !slot.limitsWritten || slot.compliant) return;
    // Its read is still on the bus (retrying): a goal now would queue behind it and go out on an older reading.
    if (slot.reading_in_flight) return;
    const goals = ARM_JOINTS.map((joint, i) => {
      const id = slot.ids[i]!;
      const position = Math.max(0, Math.min(SERVO_TICKS_PER_TURN - 1, degreesToTicks(calibration.joints[joint], goal[joint])));
      return { id, position, speed: servoSpeedRegister(speeds[joint]), acceleration: SERVO_ACCELERATION_REGISTER };
    });
    slot.goalDeg = goal;
    for (const g of goals) slot.goalTicks.set(g.id, g.position);
    link.writeGoals(goals).catch((error: unknown) => this.writeFailed(slot, error));
  }

  /**
   * Hold, read before act: reads the arm now, then writes goal = the position just read (with speed and
   * acceleration) to each servo that read torque on, and to no other. Nothing for a frozen arm, or when the
   * read fails (each servo keeps its last goal, at most MAX_GOAL_LEAD_DEG away). Feetech servos may turn torque
   * on when they get a goal, so a servo that reads torque off never gets one: an arm someone is moving by hand
   * (calibration) or one released after a fault stays limp. The read also means the hold uses where the arm
   * is at the stop, not where it was a tick ago, so it doesn't twitch back.
   */
  private async holdSlot(slot: Slot): Promise<void> {
    const link = slot.link;
    if (slot.role !== "follower" || !link || slot.frozen) return;
    const seq = slot.torqueOffSeq;
    let values: Map<number, ReadResult<ServoState>>;
    try {
      values = await link.readFeedback();
    } catch (error) {
      this.writeFailed(slot, error);
      return;
    }
    if (slot.link !== link || slot.frozen) return;
    this.takeReading(slot, values);
    // A torque off queued after this read (a release, a torque off command) wins: no goal after it.
    if (slot.torqueOffSeq !== seq) return;
    this.writePresentGoals(slot, slot.reading!);
  }

  /** Goal = `reading`'s position for each servo it shows with torque on (none for the others). */
  private writePresentGoals(slot: Slot, reading: Reading): Promise<void> | null {
    const link = slot.link;
    if (!link) return null;
    const speed = servoSpeedRegister(modeLimits(this.deps.bench).arm_speed_deg_s.pose);
    const on = slot.ids.filter((id) => reading.values.get(id)!.torqueEnable === 1);
    for (const id of slot.ids) if (!on.includes(id)) slot.goalTicks.delete(id);
    slot.divergeSince.clear();
    slot.stallSince.clear();
    if (on.length === 0) {
      slot.goalDeg = null;
      return null;
    }
    const goals = on.map((id) => ({ id, position: reading.values.get(id)!.presentPosition, speed, acceleration: SERVO_ACCELERATION_REGISTER }));
    for (const g of goals) slot.goalTicks.set(g.id, g.position);
    slot.goalDeg = this.degrees(slot);
    return link.writeGoals(goals).catch((error: unknown) => this.writeFailed(slot, error));
  }

  private holdAll(except: Slot[] = []): Array<Promise<void>> {
    const holds: Array<Promise<void>> = [];
    for (const slot of this.slots) if (slot.role === "follower" && !except.includes(slot)) holds.push(this.holdSlot(slot));
    return holds;
  }

  private writeFailed(slot: Slot, error: unknown): void {
    this.deps.log.warn("arm write failed", { arm: slot.label, error: error instanceof FeetechError ? error.kind : (error as Error).message });
  }

  /** Torque off, acknowledged per servo; if that fails, the one broadcast the driver allows (torque off). */
  private async releaseSlot(slot: Slot): Promise<void> {
    const link = slot.link;
    if (!link) return;
    slot.torqueOffSeq += 1;
    try {
      await link.setTorque(slot.ids, false);
    } catch (error) {
      this.deps.log.error("torque off failed; sending one broadcast torque off", { arm: slot.label, error: (error as Error).message });
      await link.bus.broadcastTorqueOff().catch(() => {});
    }
    slot.limitsWritten = false;
    slot.goalTicks.clear();
    slot.goalDeg = null;
    this.publish(true);
  }

  /**
   * Comply: hold at the measured position and drop every joint's torque limit to ARM_COMPLIANT_TORQUE_PCT, so
   * the arm yields to whatever pushes it. (A gripper with an active grasp would keep GRIPPER_HOLD_TORQUE_PCT;
   * grasps arrive with skills, part B.)
   */
  private async complySlot(slot: Slot): Promise<void> {
    const link = slot.link;
    slot.compliant = true;
    void this.holdSlot(slot);
    if (!link) return;
    try {
      const value = torqueRegister(ARM_COMPLIANT_TORQUE_PCT);
      await link.writeTorqueLimits(slot.ids.map((id) => ({ id, value })));
      for (const id of slot.ids) slot.writtenLimits.set(id, value);
      this.event("comply", slot.part);
    } catch (error) {
      this.deps.log.error("couldn't make the arm compliant; turning its torque off", { arm: slot.label, error: (error as Error).message });
      await this.releaseSlot(slot);
    }
  }

  // ---- Faults ----

  /**
   * Latches a fault (once per code and part), ends any motion, withdraws a pending target (except a
   * fault.clear), and applies the contract's reaction: `freeze` stops writing to the affected arms, `comply`
   * softens one arm, `release` turns torque off; every other follower holds at its fresh measured position.
   */
  private latch(code: MotionFaultCode, part: MotionPart, joint: ArmJoint | null, detail: string, affected?: Slot[]): void {
    if (this.faults.some((f) => f.code === code && f.part === part)) return;
    const fault: MotionFault = { code, part, raised_at: iso(this.deps.clock.now()), sentence: FAULT_SENTENCES[code], ...(joint ? { joint } : {}) };
    // The state carries at most 32; past that a new fault still reacts, and the oldest stay listed.
    if (this.faults.length < 32) this.faults.push(fault);
    this.deps.log.error("motion fault", { code, part, joint: joint ?? undefined, detail });
    this.event("fault", `${code} ${part}${joint ? ` ${joint}` : ""}`);
    const owner = this.slots.find((s) => s.part === part);
    const targets = affected ?? (owner ? [owner] : part === "system" ? this.slots.filter((s) => s.role === "follower") : []);
    this.endActive("faulted");
    if (this.pending && this.pending.target.action.kind !== "fault.clear") this.endPending("withdrawn", "a fault latched");
    const reaction = FAULT_REACTION[code];
    if (reaction === "freeze") {
      for (const slot of targets) {
        slot.frozen = true;
        // No fresh reading or no bus: what torque on wrote can't be known to hold any more.
        slot.limitsWritten = false;
        this.event("goals-stopped", slot.part);
      }
      this.holdAll(targets);
    } else if (reaction === "comply") {
      this.holdAll(targets);
      for (const slot of targets) if (slot.role === "follower") void this.complySlot(slot);
    } else if (reaction === "release") {
      this.holdAll(targets);
      for (const slot of targets) if (slot.role === "follower") void this.releaseSlot(slot);
    } else this.holdAll();
    this.deps.say(fault.sentence);
    this.publish(true);
  }

  /** Whether a latched fault's cause is still there (fault.clear refuses `cause_present`). */
  private causePresent(fault: MotionFault): boolean {
    const slot = this.slots.find((s) => s.part === fault.part);
    switch (fault.code) {
      case "stop_circuit_opened":
        return this.deps.stopSense.reading() === "pressed";
      case "servo_bus_lost":
        return !slot?.link;
      case "feedback_stale":
        return !slot || !this.fresh(slot);
      case "hand_controls_lost":
        return !this.deps.bench && !this.deps.handControls();
      case "overtemperature":
        return !slot || !this.fresh(slot) || [...slot.reading!.values.values()].some((f) => f.presentTemperature > ARM_TEMPERATURE_LIMIT_C);
      case "undervoltage":
        return !slot || !this.fresh(slot) || [...slot.reading!.values.values()].some((f) => f.presentVoltage / 10 < ARM_UNDERVOLTAGE_V);
      default:
        return false;
    }
  }

  private clearFaults(): void {
    this.faults = [];
    for (const slot of this.slots) {
      slot.divergeSince.clear();
      slot.overloadSince.clear();
      slot.stallSince.clear();
      slot.loadSince.clear();
      slot.frozen = false;
    }
    this.event("cleared", "all faults");
    // Read every arm before anything holds or moves: a frozen arm kept its last goal (at most 5° away), and after
    // a power loss its servos rebooted with torque off and their limits reset (so limitsWritten is gone).
    for (const slot of this.slots) void this.refreshTorque(slot);
  }

  // ---- Stopping (anyone local, always) ----

  /** motion.stop: ends any motion, holds every follower, withdraws a pending target. */
  private stopMotion(source: StopSource, why: string): void {
    const raw = { kind: "motion.stop", command_id: this.newId(), issued_at: iso(this.deps.clock.now()), issued_mono_ms: this.mono(), stopped_by: source };
    const command = MotionCommandSchema.parse(raw);
    this.deps.log.info("motion stop", { stopped_by: source, why, active: this.active?.kind ?? "none" });
    const had = this.active !== null;
    // A torque on still running stops at its next step and turns that arm's torque off.
    if (this.commandBusy) this.torqueAbort = true;
    this.endActive("stopped");
    if (this.pending && source !== "handle_press") this.endPending("withdrawn", "stopped");
    this.holdAll();
    if (!had) this.lastCommand = { command_id: command.command_id, kind: "motion.stop", outcome: "completed", at: raw.issued_at };
    this.event("stop", source);
    this.publish(true);
  }

  private endActive(outcome: "completed" | "stopped" | "faulted"): void {
    const active = this.active;
    if (!active) return;
    this.active = null;
    this.recordLast(active.command, outcome);
    this.event("command", `${active.command.kind} ${outcome} ${active.command.prepared_by}`);
    this.deps.log.info("motion ended", { kind: active.command.kind, outcome, ms: Math.round(this.deps.clock.monotonic() - active.startedMono) });
    this.finishRequest(active.command.target_id, outcome);
    if (outcome === "stopped") {
      // Hold where it is now (read first): a stopped pose or teleop leaves the goal a little ahead. A completed
      // pose keeps its goal at the target, within AT_POSE_TOLERANCE_DEG of where it is.
      if (active.kind === "arm.go_to_pose") void this.holdSlot(active.slot);
      else for (const pair of active.pairs) void this.holdSlot(pair.follower);
    }
  }

  // ---- Hand controls and the stop ----

  private checkHandControls(): void {
    const connected = this.deps.handControls();
    if (this.active && this.handsWereConnected && !connected) this.latch("hand_controls_lost", "system", null, "the last handle control went away");
    this.handsWereConnected = connected;
  }

  private onStopReading(reading: StopReading): void {
    this.deps.log.info("stop-sense", { reading });
    this.event("stop-sense", reading);
    if (reading === "pressed") this.latch("stop_circuit_opened", "system", null, "the stop was pressed");
    else if (reading === "released") for (const slot of this.slots) void this.refreshTorque(slot);
    this.publish(true);
  }

  /**
   * Reads an arm afresh (after the stop or a clear: power may have been cut). Servos that read torque on hold
   * where they are, from this same reading, rather than drive to an old goal; the rest get nothing. A leader
   * reading torque on gets it turned off (takeReading).
   */
  private async refreshTorque(slot: Slot): Promise<void> {
    const link = slot.link;
    if (!link) return;
    const seq = slot.torqueOffSeq;
    try {
      const values = await link.readFeedback();
      if (slot.link !== link) return;
      this.takeReading(slot, values);
      const torque = torqueFrom(slot.reading!, slot.ids);
      if (slot.role === "follower" && torque !== "off" && !slot.frozen && slot.torqueOffSeq === seq) {
        this.deps.log.warn("arm reads torque on after the stop or a clear; holding it where it is", { arm: slot.label });
        this.writePresentGoals(slot, slot.reading!);
      }
      this.event("torque", `${slot.side} ${slot.role} ${torque} (re-read)`);
    } catch (error) {
      this.deps.log.warn("couldn't re-read the arm", { arm: slot.label, error: (error as Error).message });
    }
    this.publish(true);
  }

  // ---- Connecting arms ----

  private loadCalibration(slot: Slot): void {
    const calibration = this.deps.files.readCalibration(slot.side, slot.role);
    if (calibration && calibration.bus_id !== slot.port.busId) {
      this.deps.log.error("calibration was made on another adapter; that arm counts as not calibrated", { arm: slot.label });
      slot.calibration = null;
    } else slot.calibration = calibration;
    if (slot.calibration) slot.ids = ARM_JOINTS.map((joint) => slot.calibration!.joints[joint].servo_id);
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.cancelReconnect = this.deps.clock.setTimeout(() => {
      for (const slot of this.slots) if (!slot.link && !slot.connecting) void this.connect(slot);
      this.scheduleReconnect();
    }, ARM_RECONNECT_MS);
  }

  /**
   * The startup check and first writes for one arm: echo check, a ping and a model check per servo, then a read
   * of every servo before anything is written. A follower's servos that read torque on get goal = the measured
   * position (with speed and acceleration) and the mode's torque limits, so they hold where they are; servos
   * that read torque off get nothing (a goal may turn torque on). That narrows the contract's restart rule
   * ("sets every goal to the measured position") to servos with torque on. Torque on from the terminal is
   * still needed before the arm moves (`limitsWritten` stays false). Leaders get their torque turned off. Any
   * failure leaves no link.
   */
  private async connect(slot: Slot): Promise<void> {
    if (this.stopped || slot.connecting) return;
    slot.connecting = true;
    try {
      const { link, report } = await openArmLink({ label: slot.label, openPort: slot.port.openPort, clock: this.deps.clock, log: this.deps.log, ids: slot.ids });
      if (!link) {
        if (this.deps.clock.monotonic() - slot.lastReadError > 30_000) {
          slot.lastReadError = this.deps.clock.monotonic();
          this.deps.log.warn("arm check failed; nothing is written to it", { arm: slot.label, problem: report.problem ?? "unknown" });
        }
        this.event("check", `${slot.side} ${slot.role} failed ${report.problem ?? ""}`.trim());
        return;
      }
      this.event("check", `${slot.side} ${slot.role} passed echo=${report.echo ? "on" : "off"} servos=${report.servos.length} model=777`);
      this.deps.log.info("arm check passed", { arm: slot.label, echo: report.echo === true, firmware: report.servos.map((s) => s.firmware).join(",") });
      try {
        const seq = slot.torqueOffSeq;
        const values = await link.readFeedback();
        slot.link = link;
        slot.limitsWritten = false;
        this.takeReading(slot, values);
        if (slot.role === "follower") {
          // An arm frozen by a latched fault gets its goals when the fault clears; a compliant one stays
          // compliant until its torque is turned on again.
          const reading = slot.reading!;
          const on = slot.ids.filter((id) => reading.values.get(id)!.torqueEnable === 1);
          if (!slot.frozen && on.length > 0) {
            const limits = modeLimits(this.deps.bench);
            await link.writeTorqueLimits(on.map((id) => ({ id, value: torqueRegister(jointTorquePct(limits, ARM_JOINTS[slot.ids.indexOf(id)]!)) })));
            // The limits were awaited: a fault may have frozen the arm, or a torque off been queued, meanwhile.
            if (slot.frozen || slot.torqueOffSeq !== seq) throw new Error("the arm was frozen or turned off during start-up");
            await this.writePresentGoals(slot, reading);
            this.event("startup", `${slot.side} ${slot.role} torque-on=${on.length} goals-at-present`);
          } else this.event("startup", `${slot.side} ${slot.role} torque-off no-goals`);
        } else if (slot.ids.some((id) => slot.reading!.values.get(id)!.torqueEnable !== 0)) {
          await link.setTorque(slot.ids, false);
        }
      } catch (error) {
        this.deps.log.warn("arm start-up writes failed; dropping the link", { arm: slot.label, error: (error as Error).message });
        slot.link = null;
        slot.reading = null;
        link.close();
        return;
      }
      link.onClose((reason) => this.busLost(slot, link, reason));
      if (link.isClosed) this.busLost(slot, link, "closed during start-up");
      this.publish(true);
    } finally {
      slot.connecting = false;
    }
  }

  private busLost(slot: Slot, link: ArmLink, reason: string): void {
    if (slot.link !== link || this.stopped) return;
    slot.link = null;
    slot.reading = null;
    slot.limitsWritten = false;
    slot.goalTicks.clear();
    slot.goalDeg = null;
    this.deps.log.error("arm bus lost", { arm: slot.label, reason });
    if (this.calibration?.slot === slot) this.endCalibration("the arm was disconnected");
    this.latch("servo_bus_lost", slot.part, null, reason);
    this.publish(true);
  }

  // ---- The one pending Confirm target ----

  private prepareRequest(action: ConfirmAction, title: string, snapshot: ArmJoints | null = null, thenCalibrate: Slot | null = null) {
    const result = this.prepare(action, "operator_cli", title, snapshot, thenCalibrate);
    if (!result.ok) return result;
    return { ok: true as const, request: { ...result.request } };
  }

  /**
   * Prepares `action` as the pending Confirm target, worded by the Pi. Refused (and recorded) when the preparer
   * may not prepare it, another target or a walker proposal owns Confirm (`confirm_busy`), or one of the
   * command's preconditions already fails, so nobody presses Confirm for nothing. The press re-checks all.
   */
  private prepare(
    action: ConfirmAction,
    preparer: Preparer,
    title: string,
    snapshot: ArmJoints | null,
    thenCalibrate: Slot | null = null,
  ): OperatorResult<{ request: OperatorRequest }> {
    const parsedAction = ConfirmActionSchema.safeParse(action);
    if (!parsedAction.success || !isPreparerAllowed(action.kind, preparer)) return { ok: false, error: `${preparer} may not prepare ${action.kind}` };
    const policy = MOTION_COMMAND_POLICY[action.kind];
    const nowMono = this.mono();
    const prompt = confirmPrompt(title, policy.needs_park);
    const request: OperatorRequest = { id: this.newId(), kind: action.kind, state: "waiting_confirm", prompt, refusal: null, sentence: null, detail: null };
    const busy =
      !mayReplaceConfirmTarget(this.pending?.target ?? null, nowMono) || (this.deps.walkerProposalOpen?.() ?? false)
        ? ("confirm_busy" as const)
        : null;
    // A target may be pending only while ready, or in a fault for an action allowedWhileFaulted.
    const mode = this.mode();
    const modeOk = mode === "ready" || (mode === "fault" && allowedWhileFaulted(action));
    const early = busy
      ? { refusal: busy, detail: null }
      : (this.refusalFor(action, snapshot, "prepare") ?? (modeOk ? null : { refusal: "busy" as const, detail: `the arms are ${mode}` }));
    if (early) {
      this.refuseRequest(request, early.refusal, early.detail);
      this.lastCommand = { command_id: this.newId(), kind: action.kind, outcome: "refused", refusal: early.refusal, at: iso(this.deps.clock.now()) };
      this.event("command", `${action.kind} refused:${early.refusal} ${preparer}`);
      this.deps.log.info("motion command not prepared", { kind: action.kind, prepared_by: preparer, refusal: early.refusal, detail: early.detail ?? undefined });
      this.publish(true);
      return { ok: true, request: { ...request } };
    }
    const parsedTarget = ConfirmTargetSchema.safeParse({
      target_id: request.id,
      prepared_by: preparer,
      action: parsedAction.data,
      title,
      prompt,
      shown_mono_ms: nowMono,
      expires_mono_ms: nowMono + WALKER_CONFIRM_WAIT_MS,
      shown_at: iso(this.deps.clock.now()),
      state: "open",
    });
    if (!parsedTarget.success) {
      this.deps.log.error("a Confirm target failed the contract's schema; not prepared", { kind: action.kind, issue: parsedTarget.error.issues[0]?.message ?? "" });
      return { ok: false, error: `that can't be prepared: ${parsedTarget.error.issues[0]?.message ?? "invalid"}` };
    }
    const target = parsedTarget.data;
    if (this.pending) this.endPending("replaced", "a newer target");
    this.pending = { target, snapshot, request: preparer === "operator_cli" ? request : null, thenCalibrate, preparedMode: this.mode() };
    this.keepRequest(request);
    this.event("target", `${action.kind} ${preparer}: ${title}`);
    this.deps.log.info("Confirm target prepared", { kind: action.kind, prepared_by: preparer });
    this.deps.say(prompt);
    this.publish(true);
    return { ok: true, request: { ...request } };
  }

  private endPending(state: "expired" | "withdrawn" | "replaced" | "accepted", why: string): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.target = { ...pending.target, state };
    if (state !== "accepted" && pending.request) this.refuseRequest(pending.request, state === "expired" ? "confirm_target_expired" : "confirm_target_expired", why, state === "expired");
    if (state !== "accepted") this.event("target-ended", `${state}: ${why}`);
    this.publish(true);
  }

  /** A handle Confirm press with a target pending. Returns whether the press is taken (it is, unless expired). */
  private confirmPressed(event: ButtonEvent, evidence: ConfirmPressEvidence): boolean {
    const pending = this.pending!;
    const pressMono = evidence.pressed_mono_ms;
    // Accepted only if the button was seen released for the whole CONFIRM_ARM_DELAY_MS before this press, all
    // of it after the target appeared, and its module had no hello, gap, error or loss since (the contract's).
    const verdict = confirmPressVerdict(pending.target, evidence);
    if (verdict === "ignore_too_early" || verdict === "ignore_untrusted") {
      // Taken and ignored: it can't answer this, or anything else. Its own window starts again at its release.
      this.event("press-ignored", verdict);
      this.deps.log.info("Confirm press ignored", { verdict });
      return true;
    }
    if (verdict === "expired") {
      this.endPending("expired", "no Confirm press in time");
      return false;
    }
    // Single use: consumed before anything runs.
    this.endPending("accepted", "Confirm press");
    const { target } = pending;
    const raw = {
      ...target.action,
      command_id: this.newId(),
      target_id: target.target_id,
      prepared_by: target.prepared_by,
      prepared_mono_ms: target.shown_mono_ms,
      confirm: {
        handle: handleSide(event),
        pressed_mono_ms: pressMono,
        released_since_mono_ms: Math.max(0, evidence.released_since_mono_ms!),
        pressed_at: iso(this.deps.clock.now()),
      },
      ...(MOTION_COMMAND_POLICY[target.action.kind].needs_park ? { base_parked: true } : {}),
    };
    const parsed = MotionCommandSchema.safeParse(raw);
    if (!parsed.success || !("confirm" in parsed.data)) {
      this.deps.log.error("motion command failed the contract's schema; not run", { kind: target.action.kind, issue: parsed.success ? "" : (parsed.error.issues[0]?.message ?? "") });
      if (pending.request) this.refuseRequest(pending.request, "confirm_target_mismatch", "schema");
      return true;
    }
    const command = parsed.data as ConfirmedCommand;
    const match = commandMatchesTarget(command, { ...target, state: "open" });
    if (match !== "ok") {
      this.refuseCommand(command, match, null, pending.request);
      return true;
    }
    this.deps.log.info("Confirm press accepted the target", { kind: command.kind, prepared_by: command.prepared_by, handle: command.confirm.handle });
    this.run(command, pending);
    return true;
  }

  // ---- Running a confirmed command ----

  private run(command: ConfirmedCommand, pending: Pending): void {
    const request = pending.request;
    const refusal = this.refusalFor(command, pending.snapshot, "press");
    if (refusal) return this.refuseCommand(command, refusal.refusal, refusal.detail, request);
    if (request) request.state = "running";
    this.deps.log.info("motion command", { kind: command.kind, prepared_by: command.prepared_by, bench: this.deps.bench });
    switch (command.kind) {
      case "arm.go_to_pose":
        return this.startPose(command, pending.snapshot!);
      case "teleop.start":
        return this.startTeleop(command);
      case "arm.torque":
        void this.runTorque(command, request, pending.thenCalibrate);
        return;
      case "fault.clear":
        this.clearFaults();
        this.recordLast(command, "completed");
        this.finishRequest(command.target_id, "completed");
        this.publish(true);
        return;
      default:
        // Part B: lift motion, skills and gripper.release aren't built yet.
        this.refuseCommand(command, command.kind === "skill.run" ? "unknown_skill" : "part_missing", "not built yet", request);
    }
  }

  /**
   * The first refusal that applies, in the order of the command's `refuses_when`. At `prepare` the Confirm
   * checks are skipped (the press checks them); at `press` they were already checked by commandMatchesTarget.
   */
  private refusalFor(action: ConfirmAction, snapshot: ArmJoints | null, when: "prepare" | "press"): { refusal: MotionRefusal; detail: string | null } | null {
    let reasons: readonly MotionRefusal[] = MOTION_COMMAND_POLICY[action.kind].refuses_when;
    // Turning torque off is refused only while busy (or for the Confirm checks); part_missing because a
    // disconnected arm can't be written to at all.
    if (action.kind === "arm.torque" && !action.enabled) reasons = ["busy", "part_missing"];
    const followers =
      action.kind === "arm.go_to_pose" ? [this.follower(action.arm)] : action.kind === "arm.torque" ? action.arms.map((a) => this.follower(a)) : action.kind === "teleop.start" ? action.pairs.map((p) => this.follower(p.follower)) : [];
    const parts: Array<Slot | undefined> = action.kind === "teleop.start" ? [...followers, ...action.pairs.map((p) => this.slot(p.leader, "leader"))] : followers;
    for (const reason of reasons) {
      if (reason === "confirm_busy" || reason === "confirm_target_expired" || reason === "confirm_target_mismatch") continue;
      const detail = this.refusalApplies(reason, action, parts, snapshot);
      if (detail !== false) return { refusal: reason, detail };
    }
    void when;
    return null;
  }

  /** false when the precondition holds; otherwise a detail (or null) for the log and the terminal. */
  private refusalApplies(reason: MotionRefusal, action: ConfirmAction, parts: Array<Slot | undefined>, snapshot: ArmJoints | null): string | null | false {
    const stop = this.deps.stopSense.reading();
    switch (reason) {
      case "stop_pressed":
        return stop === "pressed" ? null : false;
      case "no_hardware_stop":
        return stop === "not_wired" && !this.deps.bench ? null : false;
      case "fault_latched":
        return this.faults.length > 0 ? this.faults.map((f) => f.code).join(", ") : false;
      case "busy":
        return this.active || this.calibration || this.commandBusy || this.starting ? null : false;
      case "part_missing":
        if (action.kind.startsWith("lift.")) return "no lift on this walker yet";
        return parts.some((s) => !s?.link) ? "an arm isn't connected" : false;
      case "no_hand_control":
        return !this.deps.bench && !this.deps.handControls() ? null : false;
      case "feedback_stale":
        return parts.some((s) => s && !this.fresh(s)) ? null : false;
      case "not_calibrated":
        return parts.some((s) => !s?.calibration) ? null : false;
      case "torque_off":
        // Read before act: torque on as read now, its limits written and read back by torque on, not compliant.
        return parts.some((s) => s?.role === "follower" && (this.torqueOf(s) !== "on" || !s.limitsWritten || s.compliant)) ? null : false;
      case "unknown_pose":
        return action.kind === "arm.go_to_pose" && !this.findPose(action.arm, action.pose) ? null : false;
      case "unknown_skill":
        return action.kind === "skill.run" ? "skills aren't built yet" : false;
      case "no_grasp":
        return action.kind === "gripper.release" ? null : false;
      case "out_of_range": {
        if (action.kind !== "arm.go_to_pose") return false;
        const slot = this.follower(action.arm);
        if (!slot?.calibration || !snapshot) return false;
        const outside = jointsOutsideCalibration(snapshot, slot.calibration);
        return outside.length > 0 ? `${outside[0]!.joint} at ${round1(outside[0]!.degrees)}°` : false;
      }
      case "leader_not_matched": {
        if (action.kind !== "teleop.start") return false;
        for (const pair of action.pairs) {
          const follower = this.follower(pair.follower);
          const leader = this.slot(pair.leader, "leader");
          if (!follower?.calibration || !leader?.calibration) continue;
          const f = this.degrees(follower);
          const l = this.degrees(leader);
          if (!f || !l) continue;
          const gap = largestGap(clampToFollower(l, follower.calibration), f);
          if (gap.deg > TELEOP_ENGAGE_TOLERANCE_DEG) return `${gap.joint} is ${round1(gap.deg)}° from the teaching arm`;
        }
        return false;
      }
      case "cause_present": {
        const present = this.faults.filter((f) => this.causePresent(f));
        return present.length > 0 ? present.map((f) => `${f.code}/${f.part}`).join(", ") : false;
      }
      // The lift's own preconditions (part B) and skill checks.
      default:
        return false;
    }
  }

  private refuseCommand(command: ConfirmedCommand, refusal: MotionRefusal, detail: string | null, request: OperatorRequest | null): void {
    this.deps.log.info("motion command refused", { kind: command.kind, prepared_by: command.prepared_by, refusal, detail: detail ?? undefined });
    this.recordLast(command, "refused", refusal);
    this.event("command", `${command.kind} refused:${refusal} ${command.prepared_by}`);
    if (request) this.refuseRequest(request, refusal, detail);
    this.deps.say(REFUSAL_SENTENCES[refusal]);
    this.publish(true);
  }

  private recordLast(command: ConfirmedCommand, outcome: "refused" | "completed" | "stopped" | "faulted", refusal?: MotionRefusal): void {
    this.lastCommand = { command_id: command.command_id, kind: command.kind, outcome, ...(refusal ? { refusal } : {}), at: iso(this.deps.clock.now()) };
  }

  private startPose(command: ConfirmedCommand & { kind: "arm.go_to_pose" }, target: ArmJoints): void {
    const slot = this.follower(command.arm)!;
    const measured = this.degrees(slot)!;
    const speed = modeLimits(this.deps.bench).arm_speed_deg_s.pose;
    const { speeds, longestDeg } = lineSpeeds(measured, target, speed);
    const now = this.deps.clock.monotonic();
    // The goal starts from where the arm is now, never from an older goal.
    slot.goalDeg = measured;
    this.active = {
      kind: "arm.go_to_pose",
      command,
      slot,
      target,
      speeds,
      startedMono: now,
      deadlineMono: now + motionTimeoutMs((longestDeg / speed) * 1000),
      lastStepMono: now,
      lastBenchLog: -Infinity,
    };
    this.event("command", `arm.go_to_pose started ${command.prepared_by}`);
    this.publish(true);
  }

  private startTeleop(command: ConfirmedCommand & { kind: "teleop.start" }): void {
    const now = this.deps.clock.monotonic();
    const pairs = command.pairs.map((p) => {
      const follower = this.follower(p.follower)!;
      follower.goalDeg = this.degrees(follower);
      return { leader: this.slot(p.leader, "leader")!, follower, lastLeader: null, overspeedSince: null, gapSince: null };
    });
    this.active = {
      kind: "teleop",
      command,
      pairs,
      speedDegS: teleopSpeedDegS(modeLimits(this.deps.bench), command.record_skill_id !== undefined),
      startedMono: now,
      deadlineMono: now + TELEOP_MAX_SESSION_MS,
      lastStepMono: now,
      lastBenchLog: -Infinity,
    };
    this.event("command", `teleop.start started ${command.prepared_by}`);
    this.publish(true);
  }

  /**
   * Torque on, read before act, every write read back: the torque limits (acknowledged, then read back), goal =
   * the present position just read with speed and acceleration (an unacknowledged SYNC WRITE, so read back),
   * then torque (read back). Any mismatch aborts and turns that arm's torque off. Torque off is read back too.
   */
  private async runTorque(command: ConfirmedCommand & { kind: "arm.torque" }, request: OperatorRequest | null, thenCalibrate: Slot | null): Promise<void> {
    this.commandBusy = true;
    this.torqueAbort = false;
    const limits = modeLimits(this.deps.bench);
    let ok = false;
    let working: Slot | null = null;
    // Torque on takes about 20 transactions: a fault, the stop or a stop press can come in between. Checked
    // before each write that could make an arm stiff, so a stop never ends with torque turned on after it.
    const stillAllowed = () => {
      if (this.stopped || this.torqueAbort || this.faults.length > 0 || this.deps.stopSense.reading() === "pressed") {
        throw new Error("a fault or a stop came during torque on");
      }
    };
    const readBack = async (slot: Slot, link: ArmLink, what: string, ok: (id: number, s: ServoState) => boolean) => {
      const values = await link.readFeedback();
      this.takeReading(slot, values);
      const wrong = slot.ids.filter((id) => !ok(id, values.get(id)!.value));
      if (wrong.length > 0) throw new Error(`read-back mismatch (${what}) on servo ${wrong.join(", ")}`);
      return values;
    };
    try {
      for (const side of command.arms) {
        const slot = this.follower(side)!;
        const link = slot.link;
        if (!link) throw new Error(`the ${side} arm was disconnected`);
        working = slot;
        if (!command.enabled) {
          slot.limitsWritten = false;
          slot.torqueOffSeq += 1;
          await link.setTorque(slot.ids, false);
          await readBack(slot, link, "torque off", (_id, s) => s.torqueEnable === 0);
          slot.compliant = false;
          slot.goalTicks.clear();
          slot.goalDeg = null;
          this.event("torque", `${side} off`);
          working = null;
          continue;
        }
        slot.limitsWritten = false;
        stillAllowed();
        // 1. Torque limits first: a RAM write that can't make anything move, acknowledged, then read back.
        const wanted = new Map(slot.ids.map((id, i) => [id, torqueRegister(jointTorquePct(limits, ARM_JOINTS[i]!))]));
        await link.writeTorqueLimits([...wanted].map(([id, value]) => ({ id, value })));
        const before = await readBack(slot, link, "torque limit", (id, s) => s.torqueLimit === wanted.get(id));
        stillAllowed();
        // 2. Goal = the position just read, with nonzero speed and acceleration; unacknowledged, so read back.
        const speed = servoSpeedRegister(limits.arm_speed_deg_s.pose);
        const goals = slot.ids.map((id) => ({ id, position: before.get(id)!.value.presentPosition, speed, acceleration: SERVO_ACCELERATION_REGISTER }));
        const goalOf = new Map(goals.map((g) => [g.id, g.position]));
        await link.writeGoals(goals);
        for (const g of goals) slot.goalTicks.set(g.id, g.position);
        slot.divergeSince.clear();
        await readBack(slot, link, "goal, speed, acceleration", (id, s) => s.goalPosition === goalOf.get(id) && s.goalSpeed === speed && s.acceleration === SERVO_ACCELERATION_REGISTER);
        stillAllowed();
        // 3. Torque, read back with the limits still as written.
        await link.setTorque(slot.ids, true);
        await readBack(slot, link, "torque on", (id, s) => s.torqueEnable === 1 && s.torqueLimit === wanted.get(id));
        // A stop during the last writes: torque ends off, not "completed".
        stillAllowed();
        slot.writtenLimits = wanted;
        slot.limitsWritten = true;
        slot.compliant = false;
        slot.goalDeg = this.degrees(slot);
        this.event("torque", `${side} on`);
        working = null;
      }
      this.recordLast(command, "completed");
      this.finishRequest(command.target_id, "completed");
      ok = true;
    } catch (error) {
      this.deps.log.error("torque command failed; turning that arm's torque off", { error: (error as Error).message });
      // Only the arm being worked on is in doubt; arms done before it keep their read-back state. Its torque
      // goes off (acknowledged per servo, or the one broadcast torque off), so it can't be left stiff.
      if (working) {
        working.limitsWritten = false;
        if (command.enabled) await this.releaseSlot(working);
      }
      this.recordLast(command, "faulted");
      if (request) {
        request.state = "error";
        request.detail = (error as Error).message;
      }
      this.holdAll();
    } finally {
      this.commandBusy = false;
      this.publish(true);
    }
    if (ok && thenCalibrate) void this.beginCalibration(thenCalibrate);
  }

  private async beginCalibration(slot: Slot): Promise<void> {
    this.calibration = {
      slot,
      phase: "middle",
      offsets: new Map(),
      original: new Map(),
      zero: new Map(),
      min: new Map(),
      max: new Map(),
      busy: true,
      written: [],
      retiredCalibration: null,
      posesBackup: null,
    };
    this.publish(true);
    try {
      // A follower's torque is already off (its Confirm target did that); a leader's is made sure of.
      if (slot.role === "leader") await slot.link!.setTorque(slot.ids, false);
      this.event("calibration", `${slot.label} waiting for the middle position`);
    } catch (error) {
      this.endCalibration(`failed: ${(error as Error).message}`);
    } finally {
      if (this.calibration) this.calibration.busy = false;
    }
  }

  private endCalibration(why: string): void {
    const run = this.calibration;
    if (!run) return;
    this.calibration = null;
    this.event("calibration", `${run.slot.label} ${why}`);
    this.deps.log.info("calibration ended", { arm: run.slot.label, why });
    this.publish(true);
  }

  // ---- Requests (for the CLI to poll) ----

  private keepRequest(request: OperatorRequest): void {
    this.requests.set(request.id, request);
    while (this.requests.size > REQUESTS_KEPT) this.requests.delete(this.requests.keys().next().value!);
  }

  private refuseRequest(request: OperatorRequest, refusal: MotionRefusal, detail: string | null, expired = false): void {
    request.state = expired ? "expired" : "refused";
    request.refusal = refusal;
    request.sentence = REFUSAL_SENTENCES[refusal];
    request.detail = detail;
    this.keepRequest(request);
  }

  private finishRequest(id: string, outcome: "completed" | "stopped" | "faulted"): void {
    const request = this.requests.get(id);
    if (request && (request.state === "running" || request.state === "waiting_confirm")) request.state = outcome;
  }

  // ---- Helpers ----

  private slot(side: ArmSide, role: ArmRole): Slot | undefined {
    return this.slots.find((s) => s.side === side && s.role === role);
  }

  private follower(side: ArmSide): Slot | undefined {
    return this.slot(side, "follower");
  }

  private findPose(arm: ArmSide, name: string): NamedPose | undefined {
    return this.poses.find((p) => p.arm === arm && p.name === name);
  }

  private fresh(slot: Slot): boolean {
    return slot.link !== null && slot.reading !== null && this.deps.clock.monotonic() - slot.reading.at <= FEEDBACK_STALE_MS;
  }

  /** The arm's angles from a fresh reading, or null (not calibrated, or no fresh reading). */
  private degrees(slot: Slot): ArmJoints | null {
    if (!slot.calibration || !this.fresh(slot)) return null;
    const reading = slot.reading!;
    const out = {} as ArmJoints;
    for (const [i, joint] of ARM_JOINTS.entries()) out[joint] = ticksToDegrees(slot.calibration.joints[joint], reading.values.get(slot.ids[i]!)!.presentPosition);
    return out;
  }

  private event(kind: string, text: string): void {
    this.deps.bus.emit("motion", { kind, text });
  }

  /** Publishes the motion state (5 Hz, and at once on a change) after checking it against the contract. */
  private publish(now: boolean): void {
    const mono = this.deps.clock.monotonic();
    // A target lives only in the mode it was prepared in (ready, or a fault for fault.clear).
    if (this.pending && this.mode() !== this.pending.preparedMode) this.endPending("withdrawn", `the mode is now ${this.mode()}`);
    const mode = this.mode();
    if (mode !== this.lastMode) {
      if (this.lastMode !== null) this.event("mode", mode);
      this.deps.log.info("motion mode", { mode });
      this.lastMode = mode;
      now = true;
    }
    if (!now && mono - this.lastPublish < MOTION_STATE_PUBLISH_MS) return;
    this.lastPublish = mono;
    const parsed = MotionStateSchema.safeParse(this.state());
    if (!parsed.success) {
      this.deps.log.error("motion state failed the contract's schema; not published", { issue: `${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message}` });
      this.deps.bus.emit("motion", { kind: "state-invalid", text: `${parsed.error.issues[0]?.path.join(".")}: ${parsed.error.issues[0]?.message ?? ""}` });
      return;
    }
    this.deps.bus.emit("motionState", { state: parsed.data });
  }
}

/** Torque as `reading` shows it: "on" or "off" when every servo agrees, else "unknown". */
function torqueFrom(reading: { values: Map<number, ServoState> }, ids: readonly number[]): "on" | "off" | "unknown" {
  const values = ids.map((id) => reading.values.get(id)?.torqueEnable);
  if (values.every((v) => v === 1)) return "on";
  if (values.every((v) => v === 0)) return "off";
  return "unknown";
}

/**
 * The offset that makes a servo now reading `present` (with `current` in its offset register) read the
 * middle, 2048, using LeRobot's convention (reading = position − offset). The register holds ±2047, so the
 * value is taken modulo a turn into that range.
 */
export function centringOffset(present: number, current: number): number {
  let offset = (present + current - HALF_TURN) % SERVO_TICKS_PER_TURN;
  if (offset > 2047) offset -= SERVO_TICKS_PER_TURN;
  if (offset < -2047) offset += SERVO_TICKS_PER_TURN;
  return Math.max(-2047, Math.min(2047, offset));
}
