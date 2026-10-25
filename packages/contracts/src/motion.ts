import { z } from "zod";

/**
 * Motion contract, version 2 (MOTION_CONTRACT_VERSION): Sophi's two SO-101 arms (followers and their leaders) and the vertical lift.
 * Implemented in Pi, cloud and ESP32 source; the assembled lift has not yet moved through the Pi.
 * Some limits remain placeholders until a measured bench record in hardware/ replaces them.
 * docs/subsystems/manipulation.md explains the rules in plain words.
 *
 * THE RULE: motors start only when a person at the walker acts. A locally dictated lift move is a separate,
 * explicitly bounded path: the Pi owns its lease, validates the cloud's offer, and keeps Stop available.
 * - Starting other motion (and every other non-stop command) needs a handle Confirm press on the ONE pending
 *   Confirm target, which the walker shows and says in the Pi's own words (`ConfirmTargetSchema`). The press
 *   counts only if the Pi saw that button released for the whole CONFIRM_ARM_DELAY_MS before it, all after the
 *   target appeared, with no hello, seq gap or loss from that hand module since (`confirmPressVerdict`). A
 *   skill or teleop then runs on after that one press until it ends or anything stops it.
 * - The Confirm-based lift path needs the screen's hold control (`HoldSourceSchema`), refreshed at least every
 *   HOLD_CONTROL_REFRESH_MS and released by any of SCREEN_HOLD_RELEASE_EVENTS. A handle button is not a hold
 *   source: a serial hand module reports edges, so a lost `released` line or a hung board would keep the lift
 *   moving.
 * - The terminal (SSH, scripts, coding agents), the walker's screen, and the Pi's own follow-ups can only
 *   PREPARE a Confirm target. A cloud lift offer from a completed local Talk turn may start a lift move only
 *   after the Pi computes its target and rechecks live limits and interlocks. The Pi refreshes that request's
 *   heartbeat until it finishes or is stopped; a stalled Pi or lost link ends the lease. Anyone local can STOP.
 *
 * Also:
 * - The Pi's motion coordinator is the only thing that commands a servo or the lift, and it builds every
 *   MotionCommand itself from the channel an input arrived on. No network API accepts a MotionCommand.
 * - The base is never detected as parked (no wheel sensor). Every Confirm target that can lead to motion says
 *   PARK_PROMPT, and the command carries `base_parked: true` only after that press.
 * - The hardware stop is a latching (twist-to-release) switch. It cuts the arms' 12 V and the lift driver's
 *   step (PUL) signal; it may also cut the lift's motor power only once the drop test passed or a brake is
 *   fitted. Its normally closed stop-sense contact is read edge-triggered by the Pi and separately by the lift
 *   ESP32; either latches `stop_circuit_opened` on any press, and afterwards the lift must home again. Without
 *   a wired stop-sense input, arm motion needs bench mode (MOTION_BENCH_ENV). Normal lift motion requires
 *   both stop-sense inputs. The explicit `WALKER_LIFT_UNSWITCHED_DEMO=1` Pi setting plus a matching ESP32
 *   demo image permits a supervised bench lift move with no switches, using a journaled position estimate.
 *   Bench limits and hold-to-run still apply. This demo mode has not yet moved the assembled lift.
 * - Any new handle press (Talk or Confirm) after motion started is a `motion.stop`; the press that started
 *   it, held or released, is not. A bounce that looks like a new press also stops (fail-safe). A handle
 *   `pressed` line can be lost on the serial link; the hardware stop is the backstop for that.
 * - Faults latch. Only a confirmed local `fault.clear` clears them, and only once the cause is gone.
 *
 * Units: joint angles in degrees from each joint's calibrated zero, lift height in millimetres up from the
 * bottom limit switch, times in milliseconds. `*_mono_ms` fields are the Pi's monotonic clock. Objects are strict.
 */

/**
 * 2 (2026-10-24): the fault enum widened (`grasp_mismatch`, `torque_lost`), letting go allowed with a fault
 * latched, and a running `gripper.release` allowed in `fault` mode. Nothing outside the Pi parses these yet,
 * and every file the Pi keeps carries this version, so files written under 1 must be made again (none exist
 * on a walker yet: the arms haven't been calibrated).
 */
export const MOTION_CONTRACT_VERSION = 2;

const snakeName = (max: number) => z.string().regex(/^[a-z][a-z0-9_]*$/).max(max);
const time = z.iso.datetime();
const mono = z.int().nonnegative();
const unique = <T>(items: readonly T[]) => new Set(items).size === items.length;
/** Plain words for a screen or a spoken line, written on the Pi. */
const title = z.string().trim().min(1).max(60);

// ---- Hardware facts (from part names, datasheets and LeRobot's SO-101 code; none measured on our parts) ----

/** STS3215 servos have a 12-bit magnetic encoder: 4096 ticks per turn. Check on the received servos. */
export const SERVO_TICKS_PER_TURN = 4096;
export const SERVO_TICK_MAX = SERVO_TICKS_PER_TURN - 1;
/** Feetech bus ids run 0–253; 254 is the broadcast id. */
export const SERVO_ID_MAX = 253;
/** The SO-101 bus controller boards run at 1,000,000 baud (LeRobot's default). Check on the received boards. */
export const SERVO_BUS_BAUD = 1_000_000;
/** HGR20 rails bought at 1000 mm (purchase record). Usable travel is shorter and not measured. */
export const LIFT_RAIL_LENGTH_MM = 1000;
/** RM1605 ball screw: 16 mm diameter, 5 mm travel per turn (from the part name). */
export const LIFT_SCREW_LEAD_MM = 5;
/** 17HS19-2004S1 is a 1.8° stepper: 200 full steps per turn (datasheet). */
export const LIFT_MOTOR_FULL_STEPS_PER_TURN = 200;
/**
 * Computed, not measured: the thrust the motor's rated 59 N·cm can push through a 5 mm lead at 60–90 %
 * screw efficiency, about 450 to 670 N. That is a crushing force, which is why every lift motion is
 * hold-to-run, pinch guards are a precondition, and the driver's current should be the lowest DIP setting
 * that still lifts the measured load.
 */
export const LIFT_COMPUTED_THRUST_N = { min: 450, max: 670 } as const;

// ---- Arms ----

/** The six SO-101 joints, in LeRobot's servo id order (1 to 6). */
export const ARM_JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex", "wrist_roll", "gripper"] as const;
export const ArmJointSchema = z.enum(ARM_JOINTS);
export type ArmJoint = z.infer<typeof ArmJointSchema>;
/** Which side of the walker (an arm, or a handle). */
export const ArmSideSchema = z.enum(["left", "right"]);
export type ArmSide = z.infer<typeof ArmSideSchema>;
/** A follower is the motorised arm on the walker; a leader is the hand-moved arm used to teach it. */
export const ArmRoleSchema = z.enum(["follower", "leader"]);
export type ArmRole = z.infer<typeof ArmRoleSchema>;

/** LeRobot's SO-101 numbering. A calibration file names the real ids; this is only the expected default. */
export const DEFAULT_SERVO_IDS: Readonly<Record<ArmJoint, number>> = {
  shoulder_pan: 1,
  shoulder_lift: 2,
  elbow_flex: 3,
  wrist_flex: 4,
  wrist_roll: 5,
  gripper: 6,
};

/** One angle in degrees from the joint's calibrated zero. ±180 is the outer bound; calibration narrows it. */
export const JointDegreesSchema = z.number().min(-180).max(180);
export const ArmJointsSchema = z.strictObject({
  shoulder_pan: JointDegreesSchema,
  shoulder_lift: JointDegreesSchema,
  elbow_flex: JointDegreesSchema,
  wrist_flex: JointDegreesSchema,
  wrist_roll: JointDegreesSchema,
  gripper: JointDegreesSchema,
});
export type ArmJoints = z.infer<typeof ArmJointsSchema>;

const tick = z.int().min(0).max(SERVO_TICK_MAX);
const HALF_TURN_TICKS = SERVO_TICKS_PER_TURN / 2;

/**
 * One joint's calibration, made by moving the arm by hand through each joint's full range (LeRobot's
 * procedure). `homing_offset` is the value written into the servo's offset register so that its reading is
 * centred; `zero_ticks` is the (offset) reading this contract calls 0°; `min_ticks`/`max_ticks` are the ends
 * of the range recorded by hand, in the same readings. Ranges never wrap past 0/4095: the homing offset
 * exists to keep them inside. `direction` is -1 when a positive angle should turn the servo the other way.
 */
export const JointCalibrationSchema = z
  .strictObject({
    servo_id: z.int().min(0).max(SERVO_ID_MAX),
    /** Sign and magnitude in the STS3215 offset register: ±2047 (LeRobot's convention; check on our servos). */
    homing_offset: z.int().min(-2047).max(2047),
    min_ticks: tick,
    max_ticks: tick,
    zero_ticks: tick,
    direction: z.union([z.literal(1), z.literal(-1)]),
  })
  .refine((j) => j.min_ticks < j.max_ticks, { message: "min_ticks is below max_ticks.", path: ["max_ticks"] })
  .refine((j) => j.min_ticks <= j.zero_ticks && j.zero_ticks <= j.max_ticks, {
    message: "zero_ticks lies inside the calibrated range.",
    path: ["zero_ticks"],
  })
  .refine((j) => j.zero_ticks - j.min_ticks <= HALF_TURN_TICKS && j.max_ticks - j.zero_ticks <= HALF_TURN_TICKS, {
    message: "The range reaches at most half a turn either side of zero, so every angle fits in ±180°.",
    path: ["zero_ticks"],
  });
export type JointCalibration = z.infer<typeof JointCalibrationSchema>;

/** A stable name for the arm's controller board, such as its `/dev/serial/by-id/` entry. Never `/dev/ttyACM0`. */
export const ServoBusIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]+$/).min(1).max(128);

/** One arm's calibration file, kept on the Pi. A follower and its leader each have their own. */
export const ArmCalibrationSchema = z
  .strictObject({
    format: z.literal("sophi.arm_calibration"),
    version: z.literal(MOTION_CONTRACT_VERSION),
    arm: ArmSideSchema,
    role: ArmRoleSchema,
    bus_id: ServoBusIdSchema,
    calibrated_at: time,
    joints: z.strictObject({
      shoulder_pan: JointCalibrationSchema,
      shoulder_lift: JointCalibrationSchema,
      elbow_flex: JointCalibrationSchema,
      wrist_flex: JointCalibrationSchema,
      wrist_roll: JointCalibrationSchema,
      gripper: JointCalibrationSchema,
    }),
  })
  .refine((c) => unique(ARM_JOINTS.map((j) => c.joints[j].servo_id)), {
    message: "Each joint has its own servo id.",
    path: ["joints"],
  });
export type ArmCalibration = z.infer<typeof ArmCalibrationSchema>;

/** Degrees from a servo reading: (ticks − zero) × direction × 360 / 4096. */
export function ticksToDegrees(joint: JointCalibration, ticks: number): number {
  return ((ticks - joint.zero_ticks) * joint.direction * 360) / SERVO_TICKS_PER_TURN;
}

/** The servo reading for an angle, rounded to a whole tick. Check the result with `jointRangeDegrees` first. */
export function degreesToTicks(joint: JointCalibration, degrees: number): number {
  return Math.round(joint.zero_ticks + (joint.direction * degrees * SERVO_TICKS_PER_TURN) / 360);
}

/** The calibrated range in degrees, lowest first, whatever the direction. */
export function jointRangeDegrees(joint: JointCalibration): { min: number; max: number } {
  const a = ticksToDegrees(joint, joint.min_ticks);
  const b = ticksToDegrees(joint, joint.max_ticks);
  return { min: Math.min(a, b), max: Math.max(a, b) };
}

/**
 * Placeholder, not measured: a commanded angle must stay this far inside the calibrated range, so a pose or
 * skill never drives a joint onto its recorded end.
 */
export const JOINT_RANGE_MARGIN_DEG = 2;

export interface JointRangeProblem {
  joint: ArmJoint;
  degrees: number;
  min: number;
  max: number;
}

/** Joints of `joints` outside `calibration`'s range less JOINT_RANGE_MARGIN_DEG. Empty means all inside. */
export function jointsOutsideCalibration(joints: ArmJoints, calibration: ArmCalibration): JointRangeProblem[] {
  const problems: JointRangeProblem[] = [];
  for (const joint of ARM_JOINTS) {
    const range = jointRangeDegrees(calibration.joints[joint]);
    const min = range.min + JOINT_RANGE_MARGIN_DEG;
    const max = range.max - JOINT_RANGE_MARGIN_DEG;
    const degrees = joints[joint];
    if (!(degrees >= min && degrees <= max)) problems.push({ joint, degrees, min, max });
  }
  return problems;
}

/** Whether one gripper angle is inside the calibrated range less the margin. */
export function gripperWithinCalibration(degrees: number, calibration: ArmCalibration): boolean {
  const range = jointRangeDegrees(calibration.joints.gripper);
  return degrees >= range.min + JOINT_RANGE_MARGIN_DEG && degrees <= range.max - JOINT_RANGE_MARGIN_DEG;
}

// ---- Named poses ----

export const PoseNameSchema = snakeName(32);
/** Every follower needs `stowed`: the folded pose the arms hold while the lift moves. */
export const STOWED_POSE = "stowed";
/** The names the first demo uses. Others may be taught; these three are expected. */
export const STANDARD_POSES = [STOWED_POSE, "ready", "handover"] as const;

/** A follower pose, taught with the leader arm or typed in, for one arm. */
export const NamedPoseSchema = z.strictObject({
  name: PoseNameSchema,
  /** What the Confirm target says, written on the Pi, such as "Hold it out to you". */
  title,
  arm: ArmSideSchema,
  joints: ArmJointsSchema,
  /** When it was taught or last edited. */
  updated_at: time,
});
export type NamedPose = z.infer<typeof NamedPoseSchema>;

// ---- Lift ----

/** The TB6600-type driver's microstep settings (set on its DIP switches). */
export const LiftMicrostepsSchema = z.literal([1, 2, 4, 8, 16, 32]);

/** Named lift requests only. The no-switch demo uses a journaled estimated origin; production needs a measured home. */
export const LiftPresetSchema = z.enum(["ground", "up"]);
export type LiftPreset = z.infer<typeof LiftPresetSchema>;
/** Supervised trial positions: 100 mm apart. Physical travel and step scale remain unverified. */
export const LIFT_PRESET_HEIGHTS_MM: Readonly<Record<LiftPreset, number>> = { ground: 5, up: 105 };

/**
 * Hard ceilings no lift configuration may exceed, whatever is measured later; the configuration's own limits
 * sit below them. Placeholders, not measured, chosen well under what a NEMA 17 on a 5 mm screw can do.
 */
export const LIFT_SPEED_CEILING_MM_S = 50;
export const LIFT_ACCEL_CEILING_MM_S2 = 200;

/**
 * The lift's motion configuration, kept on the Pi and also built into the lift ESP32 (which reports it in
 * `lift.hello`; a mismatch refuses lift motion). Heights are millimetres above the bottom switch's trip point.
 */
export const LiftConfigSchema = z
  .strictObject({
    microsteps: LiftMicrostepsSchema,
    soft_min_mm: z.number().min(0).max(LIFT_RAIL_LENGTH_MM),
    soft_max_mm: z.number().min(0).max(LIFT_RAIL_LENGTH_MM),
    max_speed_mm_s: z.number().positive().max(LIFT_SPEED_CEILING_MM_S),
    max_accel_mm_s2: z.number().positive().max(LIFT_ACCEL_CEILING_MM_S2),
    /** Where the top switch trips, found by a slow measured run; null until measured. */
    top_switch_mm: z.number().positive().max(LIFT_RAIL_LENGTH_MM).nullable(),
  })
  .refine((c) => c.soft_min_mm < c.soft_max_mm, { message: "soft_min_mm is below soft_max_mm.", path: ["soft_max_mm"] })
  .refine((c) => c.top_switch_mm === null || c.soft_max_mm < c.top_switch_mm, {
    message: "soft_max_mm stays below the top switch.",
    path: ["soft_max_mm"],
  });
export type LiftConfig = z.infer<typeof LiftConfigSchema>;

/**
 * What the installer recorded about the lift's safety, kept on the Pi only (not in the firmware). Outside
 * bench mode, lift motion is refused unless `guards_fitted` and (`drop_test` is `passed` or `brake_fitted`).
 * The drop test: with the arms mounted and the carriage raised a little over a soft landing, cut the lift's
 * motor power and see whether the carriage slides down the ball screw.
 */
export const LiftInstallationSchema = z
  .strictObject({
    /** Pinch guards over the screw, the carriage and the rail ends, fitted and checked. */
    guards_fitted: z.boolean(),
    drop_test: z.enum(["not_done", "passed", "failed"]),
    brake_fitted: z.boolean(),
    /**
     * Whether the hardware stop also cuts the lift's motor power (it always cuts the step signal). Allowed only
     * once the drop test passed or a brake is fitted; otherwise cutting power could drop the carriage.
     */
    stop_cuts_lift_power: z.boolean(),
    /** The TB6600 current DIP setting in use, as printed on the unit (for example "1.0 A"). */
    driver_current_setting: z.string().trim().min(1).max(24).nullable(),
    recorded_at: time,
  })
  .refine((i) => !i.stop_cuts_lift_power || i.drop_test === "passed" || i.brake_fitted, {
    message: "The stop may cut lift power only after a passed drop test or with a brake.",
    path: ["stop_cuts_lift_power"],
  });
export type LiftInstallation = z.infer<typeof LiftInstallationSchema>;

/** Steps per millimetre: 200 full steps × microsteps per 5 mm turn (40 at 1×, 320 at 8×). */
export function liftStepsPerMm(config: Pick<LiftConfig, "microsteps">): number {
  return (LIFT_MOTOR_FULL_STEPS_PER_TURN * config.microsteps) / LIFT_SCREW_LEAD_MM;
}

/** Whether the installation record allows lift motion outside bench mode. */
export function liftInstallationAllowsMotion(installation: LiftInstallation): boolean {
  return installation.guards_fitted && (installation.drop_test === "passed" || installation.brake_fitted);
}

/** Whether disabling the lift's driver is allowed: it can't drop (passed test or brake) or it sits on the bottom switch. */
export function liftMayDisable(installation: LiftInstallation, bottomSwitchPressed: boolean): boolean {
  return installation.drop_test === "passed" || installation.brake_fitted || bottomSwitchPressed;
}

// ---- Policy constants (every one a placeholder until measured on the assembled walker) ----

/** Placeholder, not measured: the Pi's motion loop reads every servo and writes new goals this often. */
export const MOTION_CONTROL_HZ = 50;
export const MOTION_CONTROL_PERIOD_MS = 1000 / MOTION_CONTROL_HZ;

/** One mode's speed and torque limits. Bench mode is the slower, weaker set. */
export interface MotionLimits {
  /** Fastest any joint may turn, by what is moving it. */
  arm_speed_deg_s: { replay: number; teleop: number; pose: number };
  /** STS3215 torque limit register, as a percentage of the servo's maximum. */
  arm_torque_pct: number;
  gripper_torque_pct: number;
  lift_speed_mm_s: number;
  lift_accel_mm_s2: number;
}

/**
 * Placeholders, not measured. `bench` applies whenever MOTION_BENCH_ENV is set (with or without a stop wired),
 * `normal` otherwise, which needs a hardware stop wired and reading released. A lift configuration's own
 * limits apply when lower. Replace after measuring: how fast the arm can move without overshooting, how much
 * torque it needs to lift itself and a light object, and how fast the lift runs without losing steps.
 */
export const MOTION_LIMITS: Readonly<{ normal: MotionLimits; bench: MotionLimits }> = {
  normal: {
    arm_speed_deg_s: { replay: 60, teleop: 90, pose: 45 },
    arm_torque_pct: 60,
    gripper_torque_pct: 50,
    lift_speed_mm_s: 20,
    lift_accel_mm_s2: 50,
  },
  bench: {
    arm_speed_deg_s: { replay: 30, teleop: 45, pose: 20 },
    arm_torque_pct: 40,
    gripper_torque_pct: 35,
    lift_speed_mm_s: 10,
    lift_accel_mm_s2: 25,
  },
};

/**
 * The fastest any skill file may declare for any joint: the normal replay limit. Teleop that records a skill
 * is also capped at this, so the recording can pass the skill checks.
 */
export const ARM_SPEED_CEILING_DEG_S = MOTION_LIMITS.normal.arm_speed_deg_s.replay;

/**
 * Placeholder, not measured: the most a joint's goal may change from one control step to the next. At 90°/s
 * and 50 Hz a joint moves 1.8° a step.
 */
export const MAX_GOAL_STEP_DEG = 2;
/**
 * Placeholder, not measured: the most a goal may lead the joint's measured position. A Feetech servo keeps
 * driving to its last goal when nothing more arrives, so if the Pi stops mid-motion (crash, unplugged bus)
 * each joint travels at most this much further and then holds. Each joint's goal is clamped to its measured
 * position ± this. A skill's timeline moves on with each control tick (by the time since the last one, capped
 * at two periods, so a late loop slows it while its deadline counts real time) and doesn't wait for a lagging
 * joint between gripper events; it starts only once the arm is at its first waypoint, and waits at each gripper event until
 * that arm reaches the event's point (bounded by the deadline), so a grasp never closes somewhere else.
 */
export const MAX_GOAL_LEAD_DEG = 5;
/**
 * Placeholder, not measured: a servo reading older than this is stale. The Pi stops writing goals to that
 * arm (each servo keeps its last goal, at most MAX_GOAL_LEAD_DEG ahead), stops all other motion and latches
 * `feedback_stale`. It never writes a goal from a stale reading.
 */
export const FEEDBACK_STALE_MS = 100;
/**
 * Placeholders, not measured: when goal and measured position differ by more than FEEDBACK_DIVERGENCE_DEG for
 * longer than FEEDBACK_DIVERGENCE_MS, the joint is blocked or being pushed (possibly by a person): motion stops,
 * that arm goes compliant (FAULT_REACTION `comply`) and `feedback_divergence` latches. Larger than
 * MAX_GOAL_LEAD_DEG, so only an outside force can cause it. A gripper whose grasp is active (a `grasp` event
 * closed it on an object and no release has run) is exempt: it is meant to be blocked, its goal stays clamped
 * to the lead limit and its torque limit is GRIPPER_HOLD_TORQUE_PCT.
 */
export const FEEDBACK_DIVERGENCE_DEG = 10;
export const FEEDBACK_DIVERGENCE_MS = 300;
/** Placeholder, not measured: the gripper's torque limit while its grasp is active, so it can't overheat. */
export const GRIPPER_HOLD_TORQUE_PCT = 30;
/**
 * Placeholder until measured: on `feedback_divergence` the arm's torque limit drops to this, so it yields to
 * whatever is pushing it. It must be at least the torque measured to hold the arm up against its own weight in
 * its worst pose, or the arm sags onto whoever pushed it; replace with that measurement plus a margin. A
 * gripper whose grasp is active keeps GRIPPER_HOLD_TORQUE_PCT so it doesn't drop the object.
 */
export const ARM_COMPLIANT_TORQUE_PCT = 25;
/** Placeholder, not measured: every joint within this of a pose counts as being at it. */
export const AT_POSE_TOLERANCE_DEG = 3;
/** Placeholder, not measured: a skill may declare a start tolerance up to this. */
export const SKILL_START_TOLERANCE_MAX_DEG = 10;
/**
 * Placeholder, not measured: teleop engages only when every follower joint is within this of its leader, so
 * the follower never leaps to catch up. Otherwise the person moves the leader to match first.
 */
export const TELEOP_ENGAGE_TOLERANCE_DEG = 10;
/**
 * Placeholders, not measured. While teaching, a fast leader is normal: the follower just lags behind its
 * clamp. Only well beyond that does teleop latch: a leader joint faster than TELEOP_OVERSPEED_FACTOR × the
 * active teleop limit for TELEOP_OVERSPEED_MS latches `teleop_overspeed`; a follower more than TELEOP_GAP_DEG
 * from its leader for TELEOP_GAP_MS latches `teleop_gap`. Both hold.
 */
export const TELEOP_OVERSPEED_FACTOR = 2;
export const TELEOP_OVERSPEED_MS = 200;
export const TELEOP_GAP_DEG = 2 * TELEOP_ENGAGE_TOLERANCE_DEG;
export const TELEOP_GAP_MS = 1000;

/**
 * Placeholders, not measured: every moving command has a deadline of its expected time × MOTION_TIMEOUT_FACTOR
 * + MOTION_TIMEOUT_MARGIN_MS (`motionTimeoutMs`). Past it, motion stops and holds and `motion_timeout` latches.
 * Expected times: a pose's longest joint move at the pose speed; a skill's last waypoint, stretched to the
 * mode's replay speed; a lift move's distance at its speed. Homing uses LIFT_HOMING_TIMEOUT_MS; a teleop
 * session ends at TELEOP_MAX_SESSION_MS, and a recording one at SKILL_MAX_DURATION_MS.
 */
export const MOTION_TIMEOUT_FACTOR = 1.25;
export const MOTION_TIMEOUT_MARGIN_MS = 2000;
export const TELEOP_MAX_SESSION_MS = 5 * 60_000;

export function motionTimeoutMs(expectedMs: number): number {
  return Math.ceil(expectedMs * MOTION_TIMEOUT_FACTOR + MOTION_TIMEOUT_MARGIN_MS);
}

/** Placeholders, not measured: STS3215 readings that stop motion and latch a fault. */
export const ARM_TEMPERATURE_LIMIT_C = 60;
/** Followers run from 12 V regulators; below this their supply is sagging (`undervoltage`). Leaders aren't checked. */
export const ARM_UNDERVOLTAGE_V = 10.5;
/** Load above this percentage for ARM_OVERLOAD_MS is an `overload` (the servo's own overload flag also counts). */
export const ARM_OVERLOAD_PCT = 80;
export const ARM_OVERLOAD_MS = 500;

/**
 * Checks the control loop keeps running at MOTION_CONTROL_HZ while `ready` (holding, nothing moving), so a held
 * object or a pushed arm is still watched: the servo limits, stale feedback, divergence (a gripper with an
 * active grasp stays exempt and at GRIPPER_HOLD_TORQUE_PCT), the bus, and the stop.
 */
export const CHECKS_WHILE_HOLDING = [
  "overload",
  "overtemperature",
  "undervoltage",
  "feedback_stale",
  "feedback_divergence",
  "servo_bus_lost",
  "stop_circuit_opened",
] as const;

/** Placeholder, not measured: the lift counts as at a height within this (position is counted steps, not measured). */
export const LIFT_AT_HEIGHT_TOLERANCE_MM = 1;
/**
 * Placeholders, not measured. Homing, all hold-to-run:
 * 1. fast approach down at LIFT_HOMING_FAST_MM_S until the bottom switch presses (skipped if already pressed);
 * 2. back off up at LIFT_HOMING_SLOW_MM_S by LIFT_HOMING_BACKOFF_MM; the switch must release within
 *    LIFT_HOMING_BACKOFF_MM + LIFT_HOMING_RELEASE_MARGIN_MM of travel, else `homing_failed`;
 * 3. slow approach down at LIFT_HOMING_SLOW_MM_S until it presses (within the same distance, else `homing_failed`):
 *    that trip point is 0 mm;
 * 4. back off up at LIFT_HOMING_SLOW_MM_S by LIFT_HOMING_BACKOFF_MM (same release check): home, at that height.
 * Total travel over all phases above LIFT_HOMING_MAX_TRAVEL_MM, or the top switch pressing, is `homing_failed`.
 * From the very top the fast approach takes about 67 s (at 5 mm/s it would be 200 s), so home with the
 * carriage near the bottom where possible.
 */
export const LIFT_HOMING_FAST_MM_S = 15;
export const LIFT_HOMING_SLOW_MM_S = 2;
export const LIFT_HOMING_BACKOFF_MM = 5;
export const LIFT_HOMING_RELEASE_MARGIN_MM = 3;
/** Placeholder until measured: set from the measured usable travel plus a margin. Covers every homing phase. */
export const LIFT_HOMING_MAX_TRAVEL_MM = LIFT_RAIL_LENGTH_MM;
export const LIFT_HOMING_TIMEOUT_MS = motionTimeoutMs(
  (LIFT_HOMING_MAX_TRAVEL_MM / LIFT_HOMING_FAST_MM_S +
    (3 * (LIFT_HOMING_BACKOFF_MM + LIFT_HOMING_RELEASE_MARGIN_MM)) / LIFT_HOMING_SLOW_MM_S) *
    1000,
);
/** Placeholder, not measured: a stop, a release or a lost lease ramps down at this. A limit switch stops at once. */
export const LIFT_STOP_DECEL_MM_S2 = 200;

/**
 * Placeholder, not measured: the Pi sends the lift ESP32 a `lift.heartbeat` this often, from the motion
 * coordinator's own control loop (every fifth tick at 50 Hz), never from a separate timer, so a stuck loop
 * stops the heartbeat. Each heartbeat carries the hold lease (`hold_request_id`).
 */
export const LIFT_HEARTBEAT_INTERVAL_MS = 100;
/**
 * Placeholder, not measured: a running lift move or homing continues only while heartbeats naming it in
 * `hold_request_id` keep arriving, at most this far apart. A heartbeat naming anything else (the person let
 * go) stops it at once, with no fault. No heartbeat at all for this long stops it and latches
 * `watchdog_expired`. Stopping means ramping down at LIFT_STOP_DECEL_MM_S2 and holding.
 */
export const LIFT_WATCHDOG_TIMEOUT_MS = 300;
/** The hold lease and the watchdog are the same period. */
export const LIFT_HOLD_LEASE_MS = LIFT_WATCHDOG_TIMEOUT_MS;
/**
 * Placeholder, not measured: the screen's hold control must report "still held" to the coordinator at least
 * this often, or it counts as released.
 */
export const HOLD_CONTROL_REFRESH_MS = 200;
/**
 * Browser events on the walker's screen that release its hold control at once, besides a missed refresh:
 * lifting the finger, the browser cancelling the touch, the page losing focus, or the page being hidden.
 */
export const SCREEN_HOLD_RELEASE_EVENTS = ["pointerup", "pointercancel", "touchend", "touchcancel", "blur", "visibilitychange"] as const;
/**
 * What the lift ESP32 does to its driver when its watchdog expires. `hold`: it stops stepping but keeps the
 * driver enabled, so the motor holds the carriage. A ball screw can be back-driven: with the driver disabled
 * the carriage and arms may slide down under their own weight. Stays `hold` even after a passed drop test.
 */
export const LIFT_WATCHDOG_DRIVER_ACTION: "hold" | "disable" = "hold";
/** Placeholder, not measured: the lift ESP32 reports `lift.status` this often. */
export const LIFT_STATUS_HZ = 20;
/**
 * Placeholder, not measured: no `lift.status` for this long and the Pi treats the lift as lost
 * (`lift_module_lost`) and stops sending it heartbeats, so the lift's own watchdog stops it too.
 */
export const LIFT_STATUS_STALE_MS = 300;

/**
 * Placeholder, not measured: a handle Confirm press in the first CONFIRM_ARM_DELAY_MS after a Confirm target
 * appears or changes is ignored, so a press meant for something else can't answer it. Within that window a
 * pending target may not be replaced; a replacement starts the window again.
 */
export const CONFIRM_ARM_DELAY_MS = 2000;
/** Placeholder, not measured: a Confirm target expires this long after it appears (the Pi's monotonic clock). */
export const WALKER_CONFIRM_WAIT_MS = 30_000;

/** What the walker shows (screen and page) whenever bench mode is on. */
export const BENCH_MODE_LABEL = "Bench mode: no hardware stop";
/**
 * Bench mode is set only by this environment variable in the Pi's local service environment file, with
 * exactly MOTION_BENCH_ENV_VALUE, read once at start. Never by the cloud, a model, the screen or a command.
 */
export const MOTION_BENCH_ENV = "WALKER_MOTION_BENCH";
export const MOTION_BENCH_ENV_VALUE = "no-hardware-stop";
/**
 * The walker's screen talks to the coordinator over 127.0.0.1 with a token in a file readable only by this
 * operating-system user, the screen kiosk's own. The screen can prepare, hold the lift and stop; never start.
 */
export const SCREEN_OS_USER = "sophi-screen";
/** Shown or said with every Confirm target that can lead to motion. The press after it is the parked check. */
export const PARK_PROMPT = "Park the walker and lock the brakes, then press Confirm.";
/** Shown or said with a Confirm target that moves nothing (clearing faults). */
export const CONFIRM_ONLY_PROMPT = "Press Confirm to go ahead.";
/**
 * Whether the Pi may list `manipulation.arm` in its manifest. Listing it changes the server's fixed arms
 * reply, which demo beat 5 (docs/demo/walker-script.md) expects word for word. Flip it only together with
 * that beat and `armsLine` in services/cloud-api; the Pi's manifest builder should test against it.
 */
export const MANIFEST_MAY_LIST_ARMS = false;

// ---- Faults ----

/** Every motion fault. All latch; only a confirmed local `fault.clear` clears them, once the cause is gone. */
export const MotionFaultCodeSchema = z.enum([
  "limit_hit",
  "limit_wiring",
  "homing_failed",
  "overload",
  "overtemperature",
  "undervoltage",
  "feedback_stale",
  "feedback_divergence",
  "watchdog_expired",
  "servo_bus_lost",
  "lift_module_lost",
  "lift_config_mismatch",
  "hand_controls_lost",
  "stop_circuit_opened",
  "calibration_missing",
  "lift_unhomed",
  "skill_invalid",
  "motion_timeout",
  "teleop_overspeed",
  "teleop_gap",
  /** A grasping gripper stopped well short of where the skill had it (something else in its hand, such as a finger). */
  "grasp_mismatch",
  /** A moving arm's servos read torque off, or a torque limit other than the one written (a power dip resets both). */
  "torque_lost",
]);
export type MotionFaultCode = z.infer<typeof MotionFaultCodeSchema>;

/** The plain sentence the screen and page show for each fault. */
export const FAULT_SENTENCES: Readonly<Record<MotionFaultCode, string>> = {
  limit_hit: "The lift touched an end switch it wasn't heading for, so it stopped.",
  limit_wiring: "Both lift end switches read pressed at once, so a switch or its wire needs checking.",
  homing_failed: "The lift couldn't find its bottom switch while homing, so it stopped.",
  overload: "An arm was working too hard, so it stopped.",
  overtemperature: "An arm motor got too warm, so it stopped to cool down.",
  undervoltage: "The arms' power supply dropped too low, so they stopped.",
  feedback_stale: "An arm stopped reporting its position, so motion stopped.",
  feedback_divergence: "An arm didn't move as told, as if it was blocked or pushed, so it went soft and stopped.",
  watchdog_expired: "The lift lost contact with the walker's computer, so it stopped.",
  servo_bus_lost: "The walker lost its connection to an arm, so motion stopped.",
  lift_module_lost: "The walker lost its connection to the lift, so motion stopped.",
  lift_config_mismatch: "The lift's settings don't match the walker's, so the lift won't move.",
  hand_controls_lost: "The walker lost its handle controls, so motion stopped.",
  stop_circuit_opened: "The stop switch was pressed, so the arms and lift stopped.",
  calibration_missing: "An arm has no calibration, so it won't move until it is calibrated.",
  lift_unhomed: "The lift lost track of its height, so it needs homing again.",
  skill_invalid: "A taught movement failed its checks, so it didn't run.",
  motion_timeout: "A movement took much longer than it should, so it stopped.",
  teleop_overspeed: "The teaching arm moved far too fast to follow, so the walker's arm stopped.",
  teleop_gap: "The walker's arm fell too far behind the teaching arm, so it stopped.",
  grasp_mismatch: "The hand met something it wasn't taught to hold, so it loosened and stopped.",
  torque_lost: "An arm's motors reset by themselves, as after a power dip, so it stopped.",
};
/** Added to every fault on screen: faults clear only on the walker. */
export const FAULT_CLEAR_SENTENCE = "Ask a helper to clear it at the walker.";

/**
 * How the Pi leaves the hardware when a fault latches. Whatever the reaction, every other motion stops and
 * the lift stops stepping and holds (driver enabled).
 * - `hold`: every arm goal is set to its fresh measured position, torque stays on.
 * - `freeze`: the Pi stops writing goals to that arm, because it has no fresh reading (or no bus); each servo
 *   keeps its last goal, at most MAX_GOAL_LEAD_DEG away. Other arms hold.
 * - `comply`: that arm's goals are set to its measured position and its torque limit drops to
 *   ARM_COMPLIANT_TORQUE_PCT; its gripper does too, unless its grasp is active, when it keeps
 *   GRIPPER_HOLD_TORQUE_PCT so the object isn't dropped. Other arms hold.
 * - `release`: that arm's torque goes off (it goes limp and may sag). Other arms hold.
 * The hardware stop cuts the arms' power (and the lift's step signal) whatever this says.
 */
export const FaultReactionSchema = z.enum(["hold", "freeze", "comply", "release"]);
export type FaultReaction = z.infer<typeof FaultReactionSchema>;
export const FAULT_REACTION: Readonly<Record<MotionFaultCode, FaultReaction>> = {
  limit_hit: "hold",
  limit_wiring: "hold",
  homing_failed: "hold",
  overload: "release",
  overtemperature: "release",
  undervoltage: "hold",
  feedback_stale: "freeze",
  feedback_divergence: "comply",
  watchdog_expired: "hold",
  servo_bus_lost: "freeze",
  lift_module_lost: "hold",
  lift_config_mismatch: "hold",
  hand_controls_lost: "hold",
  stop_circuit_opened: "release",
  calibration_missing: "hold",
  lift_unhomed: "hold",
  skill_invalid: "hold",
  motion_timeout: "hold",
  teleop_overspeed: "hold",
  teleop_gap: "hold",
  // Also: that gripper's goal goes to where it is and its torque limit to ARM_COMPLIANT_TORQUE_PCT, and the Pi
  // offers "Let go?" at once (LETTING GO IS ALWAYS POSSIBLE, at gripper.release).
  grasp_mismatch: "hold",
  torque_lost: "hold",
};

/**
 * Faults after which the lift must home again (the Pi's `homed` goes false until a `lift.home` completes): its
 * counted height may be wrong, or it may have moved unpowered or with its step signal cut. A `lift.disable`
 * (driver off) unhomes it too, in the firmware and on the Pi.
 */
export const FAULTS_THAT_UNHOME_LIFT: readonly MotionFaultCode[] = [
  "limit_hit",
  "limit_wiring",
  "homing_failed",
  "watchdog_expired",
  "lift_module_lost",
  "stop_circuit_opened",
  "lift_unhomed",
];

/** Which part a fault belongs to. */
export const MotionPartSchema = z.enum(["arm_left", "arm_right", "leader_left", "leader_right", "lift", "system"]);
export type MotionPart = z.infer<typeof MotionPartSchema>;

/** A latched fault as the Pi reports it. `sentence` is always FAULT_SENTENCES[code]. */
export const MotionFaultSchema = z
  .strictObject({
    code: MotionFaultCodeSchema,
    part: MotionPartSchema,
    /** The joint, for an arm fault that names one. */
    joint: ArmJointSchema.optional(),
    raised_at: time,
    sentence: z.string().min(1).max(160),
  })
  .refine((f) => f.sentence === FAULT_SENTENCES[f.code], {
    message: "sentence is the fixed sentence for the code.",
    path: ["sentence"],
  })
  .refine((f) => f.joint === undefined || f.part.startsWith("arm_") || f.part.startsWith("leader_"), {
    message: "Only an arm fault names a joint.",
    path: ["joint"],
  });
export type MotionFault = z.infer<typeof MotionFaultSchema>;

// ---- Skills (taught or written movements) ----

export const SkillIdSchema = snakeName(40);
/** Placeholders, not measured: bounds on one skill file (and on a recording teleop session). */
export const SKILL_MAX_DURATION_MS = 60_000;
export const SKILL_MAX_WAYPOINTS = 6000;
/** Waypoints at most every 10 ms (100 Hz, twice the control rate) and at least every second. */
export const SKILL_MIN_WAYPOINT_GAP_MS = 10;
export const SKILL_MAX_WAYPOINT_GAP_MS = 1000;
export const SKILL_MAX_GRIPPER_EVENTS = 16;

/** Joint angles per arm. A skill lists exactly its own arms. */
const SkillArmsJointsSchema = z.strictObject({ left: ArmJointsSchema.optional(), right: ArmJointsSchema.optional() });

const SkillWaypointSchema = z.strictObject({
  /** Milliseconds from the start of the skill. */
  t_ms: z.int().min(0).max(SKILL_MAX_DURATION_MS),
  joints: SkillArmsJointsSchema,
});

const MaxSpeedSchema = z.number().positive().max(ARM_SPEED_CEILING_DEG_S);

/** Floating-point slack in the speed check, in degrees. */
const SPEED_EPSILON_DEG = 1e-6;

/** Which arms end the skill with an active grasp: their last gripper event is a `grasp`. */
export function armsHoldingAtEnd(skill: Pick<Skill, "arms" | "gripper_events">): ArmSide[] {
  return skill.arms.filter((arm) => skill.gripper_events.filter((e) => e.arm === arm).at(-1)?.kind === "grasp");
}

/**
 * A movement taught with a leader arm (`recorded`) or written by hand (`authored`), replayed on the follower
 * arms. It always ends HOLDING its last waypoint. An arm that ends with an active grasp (a handover) must name
 * in `let_go` where its gripper opens; the Pi then prepares a "Let go?" Confirm target (`gripper.release`) that
 * the person at the walker presses when they are holding the object. A skill never moves the lift: `lift_mm`,
 * when set, is a height the lift must already be at (and it must be set when the walker has a lift).
 */
export const SkillSchema = z
  .strictObject({
    format: z.literal("sophi.skill"),
    version: z.literal(MOTION_CONTRACT_VERSION),
    skill_id: SkillIdSchema,
    /** Plain words for the screen, the page and the Confirm target, such as "Hand over the cup". Written on the Pi. */
    title,
    source: z.enum(["recorded", "authored"]),
    created_at: time,
    arms: z.array(ArmSideSchema).min(1).max(2).refine(unique, "Each arm appears once."),
    /** Each listed arm must be within `tolerance_deg` of its pose here before the skill may start. */
    start: z.strictObject({
      joints: SkillArmsJointsSchema,
      tolerance_deg: z.number().positive().max(SKILL_START_TOLERANCE_MAX_DEG),
    }),
    /** The fastest each joint may move between waypoints; each at most ARM_SPEED_CEILING_DEG_S. */
    max_speed_deg_s: z.strictObject({
      shoulder_pan: MaxSpeedSchema,
      shoulder_lift: MaxSpeedSchema,
      elbow_flex: MaxSpeedSchema,
      wrist_flex: MaxSpeedSchema,
      wrist_roll: MaxSpeedSchema,
      gripper: MaxSpeedSchema,
    }),
    waypoints: z.array(SkillWaypointSchema).min(2).max(SKILL_MAX_WAYPOINTS),
    gripper_events: z
      .array(z.strictObject({ t_ms: z.int().min(0).max(SKILL_MAX_DURATION_MS), arm: ArmSideSchema, kind: z.enum(["grasp", "release"]) }))
      .max(SKILL_MAX_GRIPPER_EVENTS),
    /** For each arm that ends holding: the gripper angle that lets go, used by the later `gripper.release`. */
    let_go: z.array(z.strictObject({ arm: ArmSideSchema, gripper_open_deg: JointDegreesSchema })).max(2),
    /** The lift height this skill was taught at, or null on a walker without a lift. */
    lift_mm: z.number().min(0).max(LIFT_RAIL_LENGTH_MM).nullable(),
  })
  .superRefine((skill, ctx) => {
    const arms = new Set(skill.arms);
    const sameArms = (joints: { left?: unknown; right?: unknown }) =>
      (joints.left !== undefined) === arms.has("left") && (joints.right !== undefined) === arms.has("right");
    if (!sameArms(skill.start.joints)) {
      ctx.addIssue({ code: "custom", message: "The start pose lists exactly the skill's arms.", path: ["start", "joints"] });
    }
    const waypoints = skill.waypoints;
    waypoints.forEach((wp, i) => {
      if (!sameArms(wp.joints)) {
        ctx.addIssue({ code: "custom", message: "Each waypoint lists exactly the skill's arms.", path: ["waypoints", i, "joints"] });
      }
    });
    if (waypoints[0]?.t_ms !== 0) {
      ctx.addIssue({ code: "custom", message: "The first waypoint is at t_ms 0.", path: ["waypoints", 0, "t_ms"] });
    }
    for (let i = 1; i < waypoints.length; i += 1) {
      const prev = waypoints[i - 1]!;
      const next = waypoints[i]!;
      const gap = next.t_ms - prev.t_ms;
      if (gap < SKILL_MIN_WAYPOINT_GAP_MS || gap > SKILL_MAX_WAYPOINT_GAP_MS) {
        ctx.addIssue({
          code: "custom",
          message: `Waypoints are ${SKILL_MIN_WAYPOINT_GAP_MS} to ${SKILL_MAX_WAYPOINT_GAP_MS} ms apart, in order.`,
          path: ["waypoints", i, "t_ms"],
        });
        continue;
      }
      for (const arm of skill.arms) {
        const a = prev.joints[arm];
        const b = next.joints[arm];
        if (!a || !b) continue;
        for (const joint of ARM_JOINTS) {
          const allowed = (skill.max_speed_deg_s[joint] * gap) / 1000 + SPEED_EPSILON_DEG;
          if (Math.abs(b[joint] - a[joint]) > allowed) {
            ctx.addIssue({
              code: "custom",
              message: `${arm} ${joint} moves faster than its max_speed_deg_s.`,
              path: ["waypoints", i, "joints", arm, joint],
            });
          }
        }
      }
    }
    const first = waypoints[0];
    if (first) {
      for (const arm of skill.arms) {
        const start = skill.start.joints[arm];
        const at = first.joints[arm];
        if (!start || !at) continue;
        if (ARM_JOINTS.some((joint) => Math.abs(at[joint] - start[joint]) > skill.start.tolerance_deg)) {
          ctx.addIssue({
            code: "custom",
            message: "The first waypoint is within tolerance_deg of the start pose.",
            path: ["waypoints", 0, "joints", arm],
          });
        }
      }
    }
    const end = waypoints.at(-1)?.t_ms ?? 0;
    skill.gripper_events.forEach((event, i) => {
      if (!arms.has(event.arm)) {
        ctx.addIssue({ code: "custom", message: "A gripper event names one of the skill's arms.", path: ["gripper_events", i, "arm"] });
      }
      if (event.t_ms > end) {
        ctx.addIssue({ code: "custom", message: "A gripper event happens before the last waypoint.", path: ["gripper_events", i, "t_ms"] });
      }
      if (i > 0 && event.t_ms < skill.gripper_events[i - 1]!.t_ms) {
        ctx.addIssue({ code: "custom", message: "Gripper events are in time order.", path: ["gripper_events", i, "t_ms"] });
      }
    });
    const holding = new Set(armsHoldingAtEnd(skill));
    const letGo = skill.let_go.map((l) => l.arm);
    if (!unique(letGo) || letGo.length !== holding.size || letGo.some((arm) => !holding.has(arm))) {
      ctx.addIssue({ code: "custom", message: "let_go names exactly the arms that end with an active grasp.", path: ["let_go"] });
    }
  });
export type Skill = z.infer<typeof SkillSchema>;

/** The first demo skill (taught, not yet recorded): take a light object from a fixed tray and hold it out. */
export const FIRST_SKILL_ID = "tray_pick_handover";

// ---- The Pi's motion setup file ----

/** Everything the motion coordinator loads at start: calibrations, poses, the lift, the stop. Kept on the Pi only. */
export const MotionSetupSchema = z
  .strictObject({
    format: z.literal("sophi.motion_setup"),
    version: z.literal(MOTION_CONTRACT_VERSION),
    /**
     * Whether a stop-sense input is wired, declared by the installer, never inferred from a reading. The
     * contact is normally closed, so a cut wire reads `pressed`, not `not_wired`.
     */
    stop_sense: z.enum(["wired", "not_wired"]),
    arms: z.array(ArmCalibrationSchema).max(4),
    poses: z.array(NamedPoseSchema).max(64),
    /** null when no lift is fitted. */
    lift: z.strictObject({ config: LiftConfigSchema, installation: LiftInstallationSchema }).nullable(),
  })
  .superRefine((setup, ctx) => {
    const armKeys = setup.arms.map((a) => `${a.arm}/${a.role}`);
    if (!unique(armKeys)) ctx.addIssue({ code: "custom", message: "One calibration per arm and role.", path: ["arms"] });
    if (!unique(setup.arms.map((a) => a.bus_id))) {
      ctx.addIssue({ code: "custom", message: "Each arm has its own controller board.", path: ["arms"] });
    }
    if (!unique(setup.poses.map((p) => `${p.arm}/${p.name}`))) {
      ctx.addIssue({ code: "custom", message: "Pose names are unique per arm.", path: ["poses"] });
    }
    for (const follower of setup.arms.filter((a) => a.role === "follower")) {
      if (!setup.poses.some((p) => p.arm === follower.arm && p.name === STOWED_POSE)) {
        ctx.addIssue({ code: "custom", message: `The ${follower.arm} follower needs a "${STOWED_POSE}" pose.`, path: ["poses"] });
      }
    }
    setup.poses.forEach((pose, i) => {
      const follower = setup.arms.find((a) => a.arm === pose.arm && a.role === "follower");
      if (!follower) {
        ctx.addIssue({ code: "custom", message: "A pose belongs to a calibrated follower.", path: ["poses", i, "arm"] });
      } else if (jointsOutsideCalibration(pose.joints, follower).length > 0) {
        ctx.addIssue({ code: "custom", message: "A pose stays inside its arm's calibrated range.", path: ["poses", i, "joints"] });
      }
    });
  });
export type MotionSetup = z.infer<typeof MotionSetupSchema>;

export type SkillSetupProblem =
  | { code: "arm_not_calibrated"; arm: ArmSide }
  | { code: "out_of_range"; arm: ArmSide; waypoint: number | "start"; problem: JointRangeProblem }
  | { code: "let_go_out_of_range"; arm: ArmSide; gripper_open_deg: number }
  | { code: "lift_missing" }
  | { code: "lift_height_missing" }
  | { code: "lift_out_of_range"; lift_mm: number };

/**
 * Checks a (schema-valid) skill against this walker's calibrations and lift: every arm calibrated, every
 * angle (and every let-go angle) inside its calibrated range, a lift height exactly when a lift is fitted,
 * inside its soft limits. The Pi runs it when loading a skill and again before each run; any problem refuses
 * the run and latches `skill_invalid`.
 */
export function checkSkillAgainstSetup(skill: Skill, setup: MotionSetup): SkillSetupProblem[] {
  const problems: SkillSetupProblem[] = [];
  for (const arm of skill.arms) {
    const calibration = setup.arms.find((a) => a.arm === arm && a.role === "follower");
    if (!calibration) {
      problems.push({ code: "arm_not_calibrated", arm });
      continue;
    }
    const start = skill.start.joints[arm];
    if (start) for (const problem of jointsOutsideCalibration(start, calibration)) problems.push({ code: "out_of_range", arm, waypoint: "start", problem });
    skill.waypoints.forEach((wp, i) => {
      const joints = wp.joints[arm];
      if (joints) for (const problem of jointsOutsideCalibration(joints, calibration)) problems.push({ code: "out_of_range", arm, waypoint: i, problem });
    });
    for (const l of skill.let_go.filter((x) => x.arm === arm)) {
      if (!gripperWithinCalibration(l.gripper_open_deg, calibration)) {
        problems.push({ code: "let_go_out_of_range", arm, gripper_open_deg: l.gripper_open_deg });
      }
    }
  }
  if (skill.lift_mm === null) {
    if (setup.lift) problems.push({ code: "lift_height_missing" });
  } else if (!setup.lift) {
    problems.push({ code: "lift_missing" });
  } else if (skill.lift_mm < setup.lift.config.soft_min_mm || skill.lift_mm > setup.lift.config.soft_max_mm) {
    problems.push({ code: "lift_out_of_range", lift_mm: skill.lift_mm });
  }
  return problems;
}

// ---- Actions: what a Confirm press can start ----

export const TeleopPairSchema = z.strictObject({ leader: ArmSideSchema, follower: ArmSideSchema });

const actionShapes = {
  "lift.home": {},
  "lift.move": {
    /** Checked against the soft limits by the coordinator; the schema only bounds it to the rail. */
    target_mm: z.number().min(0).max(LIFT_RAIL_LENGTH_MM),
  },
  /** Turns the lift driver off: the motor frees, and the lift is unhomed (firmware and Pi). */
  "lift.disable": {},
  "arm.torque": {
    /** Followers only: a leader's torque always stays off. */
    arms: z.array(ArmSideSchema).min(1).max(2).refine(unique, "Each arm appears once."),
    /** On: goals are first set to the measured position, so nothing moves. Off: the arm goes limp and may sag. */
    enabled: z.boolean(),
  },
  "arm.go_to_pose": { arm: ArmSideSchema, pose: PoseNameSchema },
  "skill.run": { skill_id: SkillIdSchema },
  /** "Let go?" after a handover: open that arm's gripper to the skill's `let_go` angle, slowly. */
  "gripper.release": { arm: ArmSideSchema, gripper_open_deg: JointDegreesSchema },
  "teleop.start": {
    pairs: z
      .array(TeleopPairSchema)
      .min(1)
      .max(2)
      .refine((pairs) => unique(pairs.map((p) => p.leader)) && unique(pairs.map((p) => p.follower)), "Each arm is in one pair."),
    /** Record the session as a new skill under this id (taught on the leader, saved from the follower's readings). */
    record_skill_id: SkillIdSchema.optional(),
  },
  "fault.clear": {},
} as const;

export const CONFIRMED_KINDS = Object.keys(actionShapes) as (keyof typeof actionShapes)[];
export type ConfirmedKind = keyof typeof actionShapes;

const actionSchema = <K extends ConfirmedKind>(kind: K) => z.strictObject({ kind: z.literal(kind), ...actionShapes[kind] });

/** What a Confirm target would run, exactly. */
export const ConfirmActionSchema = z.discriminatedUnion("kind", [
  actionSchema("lift.home"),
  actionSchema("lift.move"),
  actionSchema("lift.disable"),
  actionSchema("arm.torque"),
  actionSchema("arm.go_to_pose"),
  actionSchema("skill.run"),
  actionSchema("gripper.release"),
  actionSchema("teleop.start"),
  actionSchema("fault.clear"),
]);
export type ConfirmAction = z.infer<typeof ConfirmActionSchema>;

/**
 * Who prepared a Confirm target. Never motor authority: only the handle Confirm press that answers the target
 * starts it. `walker_screen`: the walker's screen (127.0.0.1, token readable only by SCREEN_OS_USER).
 * `operator_cli`: a terminal on the Pi (SSH, scripts, coding agents). `offer`: the cloud's id-only
 * MotionOfferRequest. `walker_local`: the Pi's own follow-up (the "Let go?" after a handover).
 */
export const PreparerSchema = z.enum(["walker_screen", "operator_cli", "offer", "walker_local"]);
export type Preparer = z.infer<typeof PreparerSchema>;

/** Who may stop. Anyone local, always. The hardware stop switch isn't a command; it cuts power itself. */
export const StopSourceSchema = z.enum(["handle_press", "walker_screen", "operator_cli", "motion_guard"]);
export type StopSource = z.infer<typeof StopSourceSchema>;

/**
 * What holds a running lift motion: the screen's hold control for confirmed commands, or Pi heartbeats
 * for a move requested with the local Talk control. The latter ends on explicit Stop, timeout, fault, or
 * lost communication. A handle button may be added
 * only when (a) the hand firmware sends a "still held" refresh at least every HOLD_CONTROL_REFRESH_MS, and a
 * seq gap, an error line or a missed refresh counts as released; or (b) for the Pi's own GPIO buttons, their
 * level is read every control tick (not from gpiomon's edges).
 */
export const HoldSourceSchema = z.enum(["screen_hold_control", "local_voice_request"]);
export type HoldSource = z.infer<typeof HoldSourceSchema>;

/** A spoken request may name any millimetre amount within the rail's nominal length.
 * The Pi and lift board still enforce the installed soft limits before motion. */
export const LIFT_VOICE_TRIAL_MAX_MM = 800;
export const LiftRelativeMmSchema = z.number().int().min(-LIFT_VOICE_TRIAL_MAX_MM).max(LIFT_VOICE_TRIAL_MAX_MM).refine((mm) => mm !== 0);

/**
 * Cloud requests are offers, never motor commands or hold leases. A relative lift offer carries only a bounded
 * displacement; the Pi may act on one only within the completed local Talk turn that requested it, after it
 * computes the target from stored position and checks installed limits locally.
 */
export const MotionOfferRequestSchema = z.strictObject({
  target: z.discriminatedUnion("kind", [actionSchema("skill.run"), actionSchema("arm.go_to_pose"), z.strictObject({ kind: z.literal("lift.preset"), preset: LiftPresetSchema }), z.strictObject({ kind: z.literal("lift.relative"), delta_mm: LiftRelativeMmSchema })]),
});

// ---- Commands and their policy ----

export const MotionCommandKindSchema = z.enum([
  "lift.home",
  "lift.move",
  "lift.disable",
  "arm.torque",
  "arm.go_to_pose",
  "skill.run",
  "gripper.release",
  "teleop.start",
  "fault.clear",
  "teleop.stop",
  "motion.stop",
]);
export type MotionCommandKind = z.infer<typeof MotionCommandKindSchema>;
/** Commands that are always allowed, never need a Confirm press, and anyone local may send. */
export const STOP_COMMANDS = ["motion.stop", "teleop.stop"] as const;

/** Why the coordinator refused to prepare or run a command. Each is one precondition in MOTION_COMMAND_POLICY. */
export const MotionRefusalSchema = z.enum([
  /** The stop-sense input reads pressed (and `stop_circuit_opened` is latched). */
  "stop_pressed",
  /** No stop-sense input is wired and bench mode is off. */
  "no_hardware_stop",
  "fault_latched",
  /** Another command is moving something (one motion at a time). */
  "busy",
  /** Preparing: another Confirm target (or a walker proposal) is pending and can't be replaced yet. */
  "confirm_busy",
  /** The Confirm target the press answered is no longer open (used, expired, withdrawn or replaced). */
  "confirm_target_expired",
  /** The command isn't exactly the target's action. */
  "confirm_target_mismatch",
  "part_missing",
  /** No hand control is connected to confirm or stop it (outside bench mode, for motion). */
  "no_hand_control",
  "feedback_stale",
  "not_calibrated",
  "lift_not_homed",
  /** Every fitted follower must hold its stowed pose (torque on, within AT_POSE_TOLERANCE_DEG) while the lift moves. */
  "arms_not_stowed",
  /** Lift: no hold control on the walker is held. */
  "not_held",
  /** Lift, outside bench mode: the installation record lacks pinch guards. */
  "lift_guards_missing",
  /** Lift, outside bench mode: the drop test isn't recorded as passed and no brake is fitted. */
  "lift_drop_test_missing",
  /**
   * Lift: its built-in acceleration (the configuration the lift reports) is above this mode's
   * `lift_accel_mm_s2`, or homing's fixed speeds (LIFT_HOMING_FAST_MM_S) are above its `lift_speed_mm_s`.
   */
  "lift_over_limits",
  /** lift.disable: the carriage could drop (no passed drop test, no brake, not on the bottom switch). */
  "lift_may_drop",
  "torque_off",
  "unknown_pose",
  "unknown_skill",
  "skill_invalid",
  "not_at_start",
  "lift_not_at_height",
  "out_of_range",
  /** gripper.release: that arm has no active grasp. */
  "no_grasp",
  /** Teleop: a follower is further than TELEOP_ENGAGE_TOLERANCE_DEG from its leader. */
  "leader_not_matched",
  /** fault.clear: a fault's cause is still present. */
  "cause_present",
]);
export type MotionRefusal = z.infer<typeof MotionRefusalSchema>;

/** The plain sentence the screen shows (and the walker can say) for each refusal. */
export const REFUSAL_SENTENCES: Readonly<Record<MotionRefusal, string>> = {
  stop_pressed: "The stop switch is pressed. Release it, then clear it on the walker.",
  no_hardware_stop: "There's no stop switch connected, so the arms and lift won't move.",
  fault_latched: "Something needs checking first. Clear it on the walker.",
  busy: "Something is already moving. Stop it first.",
  confirm_busy: "The walker is already asking something. Answer that first.",
  confirm_target_expired: "That question has ended. Ask again.",
  confirm_target_mismatch: "That isn't what the walker asked about.",
  part_missing: "An arm or the lift isn't connected.",
  no_hand_control: "No handle control is connected, so it won't move.",
  feedback_stale: "An arm or the lift isn't reporting its position.",
  not_calibrated: "That arm isn't calibrated yet.",
  lift_not_homed: "The lift needs homing first.",
  arms_not_stowed: "Fold the arms away before the lift moves.",
  not_held: "Keep holding the lift control to move it.",
  lift_guards_missing: "The lift's guards aren't recorded as fitted, so it won't move.",
  lift_drop_test_missing: "The lift's power-off test isn't recorded as passed, so it won't move.",
  lift_over_limits: "The lift's built-in speed is above this mode's limit, so it won't move.",
  lift_may_drop: "The lift could slide down with its motor off, so it stays on.",
  torque_off: "That arm's motors are off. Turn them on first.",
  unknown_pose: "That arm doesn't know that position.",
  unknown_skill: "That movement hasn't been taught.",
  skill_invalid: "That movement failed its checks.",
  not_at_start: "The arm isn't where that movement starts.",
  lift_not_at_height: "The lift isn't at the height that movement needs.",
  out_of_range: "That's outside where the arm or lift may go.",
  no_grasp: "That hand isn't holding anything.",
  leader_not_matched: "Move the teaching arm to match the walker's arm first.",
  cause_present: "The problem is still there, so it can't be cleared yet.",
};

/** How a part's lost link affects a running command. `continue`: no effect. `stop_hold`: stop all motion, react per FAULT_REACTION, latch the fault. */
export type LossReaction = "continue" | "stop_hold";

/** AGENTS.md rule 8 for one command, as data. The coordinator and the docs table both follow it. */
export interface MotionCommandPolicy {
  /** Who may prepare it (it then needs a handle Confirm press). Empty for stops. Never the cloud except `offer`. */
  prepared_by: readonly Preparer[];
  /** Who may send it directly. Only stops have any. */
  stopped_by: readonly StopSource[];
  /** Whether it can move anything. Moving commands are cancelled by any stop. */
  moves: boolean;
  /** Whether its Confirm target says PARK_PROMPT and the command carries `base_parked: true`. */
  needs_park: boolean;
  /** Whether it runs only while a hold control on the walker is held. */
  hold_to_run: boolean;
  /** Preconditions: each is refused with this reason when it doesn't hold. */
  refuses_when: readonly MotionRefusal[];
  /** The limits it runs under, naming the constants above. */
  limits: string;
  /** What ends it early. */
  cancelled_by: string;
  /** What stops it if a loop, a link or a deadline runs out. */
  watchdog: string;
  on_lost: { cloud: LossReaction; servo_bus: LossReaction; lift_module: LossReaction; hand_controls: LossReaction };
  /** The mode afterwards. */
  ends_in: string;
}

const LOCAL: readonly Preparer[] = ["walker_screen", "operator_cli"];
const STOP_ANYTHING = "motion.stop from any new handle press, the screen, the terminal or the guard; the hardware stop; any fault";
const STOP_ALL: MotionCommandPolicy["on_lost"] = {
  cloud: "continue",
  servo_bus: "stop_hold",
  lift_module: "stop_hold",
  hand_controls: "stop_hold",
};
const NOTHING_LOST: MotionCommandPolicy["on_lost"] = {
  cloud: "continue",
  servo_bus: "continue",
  lift_module: "continue",
  hand_controls: "continue",
};
const CONFIRM_CHECKS = ["confirm_busy", "confirm_target_expired", "confirm_target_mismatch"] as const;
const MOVING_PRECONDITIONS = [
  "stop_pressed",
  "no_hardware_stop",
  "fault_latched",
  "busy",
  ...CONFIRM_CHECKS,
  "part_missing",
  "no_hand_control",
  "feedback_stale",
] as const;
const LIFT_PRECONDITIONS = [...MOVING_PRECONDITIONS, "not_held", "lift_guards_missing", "lift_drop_test_missing", "lift_over_limits", "arms_not_stowed"] as const;
const ARM_WATCHDOG =
  "Control loop at MOTION_CONTROL_HZ: stale feedback (FEEDBACK_STALE_MS) freezes and latches; divergence (FEEDBACK_DIVERGENCE_DEG for FEEDBACK_DIVERGENCE_MS) goes compliant and latches; past motionTimeoutMs(expected) it stops, holds and latches motion_timeout.";
const LIFT_WATCHDOG =
  "Runs only while heartbeats carry its hold lease (LIFT_HOLD_LEASE_MS), set only while a hold control on the walker is held; a heartbeat without it stops it, no heartbeat for LIFT_WATCHDOG_TIMEOUT_MS stops it and latches watchdog_expired; the Pi stops heartbeating after LIFT_STATUS_STALE_MS without lift status; past the deadline it stops, holds and latches motion_timeout.";

export const MOTION_COMMAND_POLICY: Readonly<Record<MotionCommandKind, MotionCommandPolicy>> = {
  "lift.home": {
    prepared_by: LOCAL,
    stopped_by: [],
    moves: true,
    needs_park: true,
    hold_to_run: true,
    refuses_when: LIFT_PRECONDITIONS,
    limits:
      "The four homing phases (fast approach, slow back-off, slow approach, slow back-off) with release checks; homing_failed past LIFT_HOMING_MAX_TRAVEL_MM over all phases or if the top switch trips; deadline LIFT_HOMING_TIMEOUT_MS.",
    cancelled_by: `letting go of the hold; ${STOP_ANYTHING}`,
    watchdog: LIFT_WATCHDOG,
    on_lost: STOP_ALL,
    ends_in: "ready with the lift homed at LIFT_HOMING_BACKOFF_MM; on release or stop, ready and unhomed; on fault, fault.",
  },
  "lift.move": {
    prepared_by: ["walker_screen", "operator_cli", "offer"],
    stopped_by: [],
    moves: true,
    needs_park: true,
    hold_to_run: true,
    refuses_when: [...LIFT_PRECONDITIONS, "lift_not_homed", "out_of_range"],
    limits:
      "target_mm inside the lift configuration's soft limits; speed and acceleration the lower of the configuration's and the mode's (MOTION_LIMITS); deadline motionTimeoutMs(distance / speed).",
    cancelled_by: `letting go of the hold; ${STOP_ANYTHING}. A spoken move (no Confirm target, hold_source local_voice_request) is cancelled by a left Confirm press, the screen's Stop lift, or any stop source; a Talk press does not stop it`,
    watchdog: `${LIFT_WATCHDOG} A spoken move's lease is set by the Pi's control loop instead of a held control, so a stalled loop still stops it.`,
    on_lost: STOP_ALL,
    ends_in: "ready at target_mm; on release or stop, ready where it stopped (still homed); on fault, fault.",
  },
  "lift.disable": {
    prepared_by: LOCAL,
    stopped_by: [],
    moves: false,
    needs_park: true,
    hold_to_run: false,
    refuses_when: ["busy", ...CONFIRM_CHECKS, "part_missing", "no_hand_control", "lift_may_drop"],
    limits:
      "Sends lift.enable(false) only when liftMayDisable (a passed drop test, a brake, or the carriage on the bottom switch); the lift firmware refuses it (disable_unsafe) off the bottom switch unless it was built disable-safe. Allowed with a fault latched (allowedWhileFaulted). Nothing else on the Pi ever disables the lift driver: no fault reaction does.",
    cancelled_by: "Not applicable (immediate).",
    watchdog: "None needed.",
    on_lost: NOTHING_LOST,
    ends_in: "ready or disabled, with the lift driver off and the lift unhomed (firmware and Pi) until a lift.home.",
  },
  "arm.torque": {
    prepared_by: LOCAL,
    stopped_by: [],
    moves: false,
    needs_park: true,
    hold_to_run: false,
    refuses_when: ["stop_pressed", "no_hardware_stop", "fault_latched", "busy", ...CONFIRM_CHECKS, "part_missing", "no_hand_control", "feedback_stale", "not_calibrated"],
    limits:
      "refuses_when applies to turning torque on: each goal is first set to the measured position and the torque limit to MOTION_LIMITS' arm_torque_pct / gripper_torque_pct, so nothing moves. Turning it off is refused only while busy or for the Confirm checks, and is allowed with a fault latched; the arm goes limp and may sag. Leaders never get torque.",
    cancelled_by: "Not applicable (immediate).",
    watchdog: "None needed: it moves nothing.",
    on_lost: STOP_ALL,
    ends_in: "ready (on) or disabled for that arm (off).",
  },
  "arm.go_to_pose": {
    prepared_by: ["walker_screen", "operator_cli", "offer"],
    stopped_by: [],
    moves: true,
    needs_park: true,
    hold_to_run: false,
    refuses_when: [...MOVING_PRECONDITIONS, "not_calibrated", "torque_off", "unknown_pose", "out_of_range"],
    limits:
      "Joints at most MOTION_LIMITS' pose speed; goals at most MAX_GOAL_STEP_DEG per step and clamped to MAX_GOAL_LEAD_DEG from the measured position; done within AT_POSE_TOLERANCE_DEG.",
    cancelled_by: STOP_ANYTHING,
    watchdog: ARM_WATCHDOG,
    on_lost: STOP_ALL,
    ends_in: "ready at the pose; on stop, ready holding where it stopped; on fault, fault.",
  },
  "skill.run": {
    prepared_by: ["walker_screen", "operator_cli", "offer"],
    stopped_by: [],
    moves: true,
    needs_park: true,
    hold_to_run: false,
    refuses_when: [
      ...MOVING_PRECONDITIONS,
      "not_calibrated",
      "torque_off",
      "unknown_skill",
      "skill_invalid",
      "not_at_start",
      "lift_not_homed",
      "lift_not_at_height",
    ],
    limits:
      "The skill's own max_speed_deg_s, its timeline stretched to MOTION_LIMITS' replay speed in bench mode; the timeline starts once the arm is within AT_POSE_TOLERANCE_DEG of the first waypoint, runs on its own clock, and waits only at a gripper event until that arm is within AT_POSE_TOLERANCE_DEG of the event's point (bounded by the deadline), each joint's goal clamped to MAX_GOAL_LEAD_DEG from its measured position; a grasp event makes that gripper's grasp active (GRIPPER_HOLD_TORQUE_PCT, exempt from divergence) until a release event or gripper.release. Never moves the lift; with a lift fitted, the lift must be homed and within LIFT_AT_HEIGHT_TOLERANCE_MM of lift_mm.",
    cancelled_by: `${STOP_ANYTHING}; never resumes`,
    watchdog: `${ARM_WATCHDOG} Expected time: the last waypoint's t_ms, stretched.`,
    on_lost: STOP_ALL,
    ends_in:
      "ready HOLDING the last waypoint (CHECKS_WHILE_HOLDING keep running); for each arm in let_go the Pi then prepares a walker_local \"Let go?\" Confirm target (gripper.release). On stop, ready holding where it stopped; on fault, fault.",
  },
  "gripper.release": {
    prepared_by: ["walker_local", "walker_screen", "operator_cli"],
    stopped_by: [],
    moves: true,
    needs_park: true,
    hold_to_run: false,
    // LETTING GO IS ALWAYS POSSIBLE: not refused for a latched fault (allowedWhileFaulted) or a compliant arm.
    refuses_when: [
      ...MOVING_PRECONDITIONS.filter((r) => r !== "fault_latched"),
      "not_calibrated",
      "torque_off",
      "no_grasp",
      "out_of_range",
    ],
    limits:
      "LETTING GO IS ALWAYS POSSIBLE: allowed with a fault latched and on a compliant arm (torque_off means the gripper's own servo doesn't read torque on). Only the gripper moves, and only opening: toward gripper_open_deg, which must be inside its calibrated range and on the opening side of where it holds (refused out_of_range otherwise), at MOTION_LIMITS' pose speed and GRIPPER_HOLD_TORQUE_PCT, with the same step and lead limits, never past where it is on the closing side. The Pi offers it (walker_local) at once whenever a motion ends with a grasp active (completed, stopped or faulted) and after a fault clears.",
    cancelled_by: STOP_ANYTHING,
    watchdog: ARM_WATCHDOG,
    on_lost: STOP_ALL,
    ends_in: "ready (or fault, if one is still latched), holding, with that arm's grasp no longer active.",
  },
  "teleop.start": {
    prepared_by: LOCAL,
    stopped_by: [],
    moves: true,
    needs_park: true,
    hold_to_run: false,
    refuses_when: [...MOVING_PRECONDITIONS, "not_calibrated", "torque_off", "leader_not_matched"],
    limits:
      "Engages only within TELEOP_ENGAGE_TOLERANCE_DEG; followers track their leaders at most MOTION_LIMITS' teleop speed (ARM_SPEED_CEILING_DEG_S while recording), with the same goal step and lead limits; leader positions clamped to the follower's calibrated range. Beyond the clamp the follower just lags; only a leader faster than TELEOP_OVERSPEED_FACTOR × the limit for TELEOP_OVERSPEED_MS latches teleop_overspeed, and a gap over TELEOP_GAP_DEG for TELEOP_GAP_MS latches teleop_gap.",
    cancelled_by: `teleop.stop; ${STOP_ANYTHING}`,
    watchdog: `${ARM_WATCHDOG} A stale leader freezes its follower and latches feedback_stale. Ends at TELEOP_MAX_SESSION_MS, or at SKILL_MAX_DURATION_MS while recording.`,
    on_lost: STOP_ALL,
    ends_in: "teleop, until stopped; then ready holding where the followers are (a recording is saved only if it passes the skill checks).",
  },
  "fault.clear": {
    prepared_by: LOCAL,
    stopped_by: [],
    moves: false,
    needs_park: false,
    hold_to_run: false,
    // Not while something runs (letting go may run with a fault latched): clearing never cuts across a motion.
    refuses_when: ["busy", ...CONFIRM_CHECKS, "cause_present"],
    limits: "Clears every latched fault only when none of their causes remains; otherwise clears nothing.",
    cancelled_by: "Not applicable.",
    watchdog: "Not applicable.",
    on_lost: NOTHING_LOST,
    ends_in:
      "ready or disabled. Never resumes motion. After any of FAULTS_THAT_UNHOME_LIFT the lift is unhomed; after stop_circuit_opened every arm's torque and position are read afresh and torque stays off until turned on; after servo_bus_lost that arm's torque is off.",
  },
  "teleop.stop": {
    prepared_by: [],
    stopped_by: ["handle_press", "walker_screen", "operator_cli", "motion_guard"],
    moves: false,
    needs_park: false,
    hold_to_run: false,
    refuses_when: [],
    limits: "None: stopping is always allowed.",
    cancelled_by: "Not applicable.",
    watchdog: "Not applicable.",
    on_lost: NOTHING_LOST,
    ends_in: "ready holding where the followers are.",
  },
  "motion.stop": {
    prepared_by: [],
    stopped_by: ["handle_press", "walker_screen", "operator_cli", "motion_guard"],
    moves: false,
    needs_park: false,
    hold_to_run: false,
    refuses_when: [],
    limits: "None: stopping is always allowed, in every mode, with or without a fault.",
    cancelled_by: "Not applicable.",
    watchdog: "Not applicable.",
    on_lost: NOTHING_LOST,
    ends_in:
      "ready (or fault, if one latched): arm goals set to their measured positions, the lift ramped down at LIFT_STOP_DECEL_MM_S2 and holding. Nothing resumes; the next motion needs a new Confirm target and press.",
  },
};

export function isPreparerAllowed(kind: MotionCommandKind, by: Preparer): boolean {
  return MOTION_COMMAND_POLICY[kind].prepared_by.includes(by);
}

/** An offered lift target is finite and within the nominal rail; installation limits are checked separately. */
export function offerKeepsToRail(action: { kind: string; target_mm?: number }, by: Preparer): boolean {
  if (by !== "offer" || action.kind !== "lift.move") return true;
  const height = action.target_mm;
  return typeof height === "number" && Number.isFinite(height) && height >= 0 && height <= LIFT_RAIL_LENGTH_MM;
}

/**
 * The words a Confirm target shows and says: the Pi's own title, then PARK_PROMPT (or CONFIRM_ONLY_PROMPT). A
 * title already ending in `.`, `?` or `!` keeps its own mark ("Let go? Park the walker…").
 */
export function confirmPrompt(localTitle: string, needsPark: boolean): string {
  const t = localTitle.trim();
  const sentence = /[.?!]$/.test(t) ? t : `${t}.`;
  return `${sentence} ${needsPark ? PARK_PROMPT : CONFIRM_ONLY_PROMPT}`;
}

/**
 * Actions a Confirm target may offer while a fault is latched: clearing it, the two that only make the
 * hardware safer (arm torque off, lift driver off), and letting go (`gripper.release`: LETTING GO IS ALWAYS
 * POSSIBLE, gripper only and opening only).
 */
export function allowedWhileFaulted(action: { kind: string; enabled?: boolean }): boolean {
  return (
    action.kind === "fault.clear" ||
    action.kind === "lift.disable" ||
    action.kind === "gripper.release" ||
    (action.kind === "arm.torque" && action.enabled === false)
  );
}

/**
 * The ONE pending Confirm target: what a handle Confirm press would do now. The walker shows `prompt` on its
 * screen and says it. It is single use (the first accepted press consumes it), expires WALKER_CONFIRM_WAIT_MS
 * after it appeared, can't be replaced in its first CONFIRM_ARM_DELAY_MS, and a replacement starts a new
 * target (new id, new window). Targets live in the coordinator's memory only, never on disk, and are
 * withdrawn when the coordinator starts, when any hand module says hello or is lost, and whenever the mode
 * leaves `ready` (in `fault`, only an `allowedWhileFaulted` action may then be prepared).
 * Order with the walker's own proposals (walker.ts, `cues_change`): whichever the walker showed first owns
 * Confirm until it is answered, expires or is withdrawn; the Pi prepares no motion target while a walker
 * proposal is open (`confirm_busy`), and announces no walker proposal while a motion target is pending or a
 * motion is running. While a motion runs, a Confirm press is only a stop.
 */
export const ConfirmTargetSchema = z
  .strictObject({
    target_id: z.uuid(),
    prepared_by: PreparerSchema,
    action: ConfirmActionSchema,
    /** The skill's, pose's or action's title from the Pi's own files or fixed words, never cloud text. */
    title,
    prompt: z.string().min(1).max(160),
    shown_mono_ms: mono,
    expires_mono_ms: mono,
    /** For display and logs only; timing uses the monotonic fields. */
    shown_at: time,
    state: z.enum(["open", "accepted", "expired", "withdrawn", "replaced"]),
  })
  .refine((t) => isPreparerAllowed(t.action.kind, t.prepared_by), {
    message: "This preparer may not prepare this action.",
    path: ["prepared_by"],
  })
  .refine((t) => offerKeepsToRail(t.action, t.prepared_by), {
    message: "An offer moves the lift only to a target within the rail.",
    path: ["action"],
  })
  .refine((t) => t.prompt === confirmPrompt(t.title, MOTION_COMMAND_POLICY[t.action.kind].needs_park), {
    message: "prompt is confirmPrompt(title).",
    path: ["prompt"],
  })
  .refine((t) => t.expires_mono_ms - t.shown_mono_ms === WALKER_CONFIRM_WAIT_MS, {
    message: `A Confirm target lives exactly ${WALKER_CONFIRM_WAIT_MS} ms.`,
    path: ["expires_mono_ms"],
  });
export type ConfirmTarget = z.infer<typeof ConfirmTargetSchema>;

/** What the Pi knows about the handle a Confirm press came from. */
export interface ConfirmPressEvidence {
  pressed_mono_ms: number;
  /**
   * When the Pi last saw that Confirm button become released: its last `released` edge, or the module's hello
   * if it hasn't been pressed since (the firmware ignores a button already held at boot). null if unknown.
   * Every press, ignored or not, is followed by a release that moves this forward, so an ignored press
   * restarts the window.
   */
  released_since_mono_ms: number | null;
  /** The latest hello, seq gap, error line or loss from that hand module, or null if none since it was first seen. */
  module_reset_mono_ms: number | null;
}

/**
 * Whether a handle Confirm press answers this target. Accepted only if the button was seen released for the
 * whole CONFIRM_ARM_DELAY_MS before the press, all of it after the target appeared, and the module had no
 * hello, seq gap, error line or loss since the target appeared. Anything else is ignored (and restarts the
 * window); a press after expiry or on a used target is `expired`.
 */
export function confirmPressVerdict(
  target: ConfirmTarget,
  press: ConfirmPressEvidence,
): "accept" | "ignore_too_early" | "ignore_untrusted" | "expired" {
  const at = press.pressed_mono_ms;
  if (target.state !== "open" || !(at < target.expires_mono_ms)) return "expired";
  if (press.module_reset_mono_ms !== null && press.module_reset_mono_ms >= target.shown_mono_ms) return "ignore_untrusted";
  if (press.released_since_mono_ms === null) return "ignore_untrusted";
  const windowStart = at - CONFIRM_ARM_DELAY_MS;
  if (windowStart < target.shown_mono_ms || press.released_since_mono_ms > windowStart) return "ignore_too_early";
  return "accept";
}

/** Whether a new target may replace the pending one now (never within its first CONFIRM_ARM_DELAY_MS). */
export function mayReplaceConfirmTarget(pending: ConfirmTarget | null, nowMono: number): boolean {
  if (!pending || pending.state !== "open" || !(nowMono < pending.expires_mono_ms)) return true;
  return nowMono >= pending.shown_mono_ms + CONFIRM_ARM_DELAY_MS;
}

/** The handle Confirm press that started a command: which handle, when, and since when its button was released. */
export const ConfirmPressSchema = z
  .strictObject({
    handle: ArmSideSchema,
    pressed_mono_ms: mono,
    released_since_mono_ms: mono,
    pressed_at: time,
  })
  .refine((p) => p.pressed_mono_ms - p.released_since_mono_ms >= CONFIRM_ARM_DELAY_MS, {
    message: "The button was released for at least CONFIRM_ARM_DELAY_MS before the press.",
    path: ["released_since_mono_ms"],
  });

/**
 * A confirmed command: the target's action, plus the record of the target and the press that started it.
 * Built by the coordinator only. The press is at least CONFIRM_ARM_DELAY_MS and less than
 * WALKER_CONFIRM_WAIT_MS after the target appeared.
 */
const confirmedBase = {
  command_id: z.uuid(),
  target_id: z.uuid(),
  prepared_by: PreparerSchema,
  prepared_mono_ms: mono,
  confirm: ConfirmPressSchema,
};
/** Set only after the Confirm target said PARK_PROMPT and the person pressed. Not detected: no wheel sensor. */
const parked = { base_parked: z.literal(true) };
const confirmedCommand = <K extends ConfirmedKind>(kind: K, needsPark: boolean) =>
  z.strictObject({ ...confirmedBase, ...(needsPark ? parked : {}), kind: z.literal(kind), ...actionShapes[kind] });

export const LiftHomeCommandSchema = confirmedCommand("lift.home", true);
export const LiftMoveCommandSchema = confirmedCommand("lift.move", true);
export const LiftDisableCommandSchema = confirmedCommand("lift.disable", true);
export const ArmTorqueCommandSchema = confirmedCommand("arm.torque", true);
export const ArmGoToPoseCommandSchema = confirmedCommand("arm.go_to_pose", true);
export const SkillRunCommandSchema = confirmedCommand("skill.run", true);
export const GripperReleaseCommandSchema = confirmedCommand("gripper.release", true);
export const TeleopStartCommandSchema = confirmedCommand("teleop.start", true);
export const FaultClearCommandSchema = confirmedCommand("fault.clear", false);
const stopBase = { command_id: z.uuid(), issued_at: time, issued_mono_ms: mono, stopped_by: StopSourceSchema };
export const TeleopStopCommandSchema = z.strictObject({ ...stopBase, kind: z.literal("teleop.stop") });
export const MotionStopCommandSchema = z.strictObject({ ...stopBase, kind: z.literal("motion.stop") });

/** One command, as the coordinator recorded it. */
export const MotionCommandSchema = z
  .discriminatedUnion("kind", [
    LiftHomeCommandSchema,
    LiftMoveCommandSchema,
    LiftDisableCommandSchema,
    ArmTorqueCommandSchema,
    ArmGoToPoseCommandSchema,
    SkillRunCommandSchema,
    GripperReleaseCommandSchema,
    TeleopStartCommandSchema,
    FaultClearCommandSchema,
    TeleopStopCommandSchema,
    MotionStopCommandSchema,
  ])
  .refine((c) => !("prepared_by" in c) || isPreparerAllowed(c.kind, c.prepared_by), {
    message: "This preparer may not prepare this command.",
    path: ["prepared_by"],
  })
  .refine((c) => !("prepared_by" in c) || offerKeepsToRail(c, c.prepared_by), {
    message: "An offer moves the lift only to a target within the rail.",
    path: ["target_mm"],
  })
  .refine(
    (c) => {
      if (!("confirm" in c)) return true;
      const after = c.confirm.pressed_mono_ms - c.prepared_mono_ms;
      return after >= CONFIRM_ARM_DELAY_MS && after < WALKER_CONFIRM_WAIT_MS;
    },
    { message: "The Confirm press comes at least CONFIRM_ARM_DELAY_MS and less than WALKER_CONFIRM_WAIT_MS after the target appeared.", path: ["confirm"] },
  );
export type MotionCommand = z.infer<typeof MotionCommandSchema>;

/** Whether `a` and `b` are the same action (kind and every field). */
function sameAction(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

/**
 * Whether a confirmed command may run: it answers this exact open target, with a press inside the target's
 * window, and does exactly the target's action. The coordinator then marks the target `accepted`.
 */
export function commandMatchesTarget(
  command: MotionCommand,
  target: ConfirmTarget,
): "ok" | "confirm_target_expired" | "confirm_target_mismatch" {
  if (!("confirm" in command) || command.target_id !== target.target_id) return "confirm_target_mismatch";
  if (command.prepared_by !== target.prepared_by || command.prepared_mono_ms !== target.shown_mono_ms) return "confirm_target_mismatch";
  const verdict = confirmPressVerdict(target, { ...command.confirm, module_reset_mono_ms: null });
  if (verdict === "expired") return "confirm_target_expired";
  if (verdict !== "accept") return "confirm_target_mismatch";
  const { command_id: _c, target_id: _t, prepared_by: _p, prepared_mono_ms: _m, confirm: _f, base_parked: _b, ...action } =
    command as Record<string, unknown>;
  return sameAction(action, target.action as Record<string, unknown>) ? "ok" : "confirm_target_mismatch";
}

// ---- Motion state (Pi → its screen, and later the cloud page) ----

/**
 * `disabled`: no motion possible now (no hardware stop and no bench mode, nothing connected, or starting up).
 * `ready`: idle, holding; a command may run. `moving`: one command is running. `teleop`: leaders drive
 * followers. `fault`: one or more faults latched. Bench mode is a separate flag, since a bench walker moves too.
 */
export const MotionModeSchema = z.enum(["disabled", "ready", "moving", "teleop", "fault"]);
export type MotionMode = z.infer<typeof MotionModeSchema>;
/**
 * The stop: `released` or `pressed` as read from the normally closed stop-sense contact (a cut wire reads
 * pressed), or `not_wired` when the motion setup declares no stop-sense input. Never inferred from a reading.
 */
export const StopCircuitSchema = z.enum(["released", "pressed", "not_wired"]);

const faultCodes = z.array(MotionFaultCodeSchema).max(MotionFaultCodeSchema.options.length).refine(unique, "Each fault appears once.");

/** One joint's latest reading. */
export const JointReadingSchema = z.strictObject({
  degrees: JointDegreesSchema,
  temperature_c: z.int().min(-40).max(150),
  /** Signed load as a percentage of the servo's maximum. */
  load_pct: z.number().min(-100).max(100),
  voltage_v: z.number().min(0).max(20),
});

export const ArmPoseStatusSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("at"), name: PoseNameSchema }),
  z.strictObject({ status: z.literal("moving") }),
  /** Still, but not at a named pose. */
  z.strictObject({ status: z.literal("between") }),
  /** No fresh reading. */
  z.strictObject({ status: z.literal("unknown") }),
]);

export const ArmStateSchema = z
  .strictObject({
    arm: ArmSideSchema,
    role: ArmRoleSchema,
    connected: z.boolean(),
    calibrated: z.boolean(),
    torque: z.enum(["on", "off", "unknown"]),
    pose: ArmPoseStatusSchema,
    /** null when there is no fresh reading. */
    joints: z
      .strictObject({
        shoulder_pan: JointReadingSchema,
        shoulder_lift: JointReadingSchema,
        elbow_flex: JointReadingSchema,
        wrist_flex: JointReadingSchema,
        wrist_roll: JointReadingSchema,
        gripper: JointReadingSchema,
      })
      .nullable(),
    /** The gripper closed on an object (a grasp event) and nothing has let go since. */
    grasp_active: z.boolean(),
    faults: faultCodes,
  })
  .refine((a) => a.connected || (a.torque === "unknown" && a.joints === null), {
    message: "A disconnected arm has unknown torque and no reading.",
    path: ["connected"],
  })
  .refine((a) => (a.joints === null) === (a.pose.status === "unknown"), {
    message: "The pose is unknown exactly when there is no reading.",
    path: ["pose"],
  })
  .refine((a) => a.role === "follower" || a.torque !== "on", { message: "A leader's torque is never on.", path: ["torque"] })
  .refine((a) => a.role === "follower" || !a.grasp_active, { message: "Only a follower grasps.", path: ["grasp_active"] });
export type ArmState = z.infer<typeof ArmStateSchema>;

const switchState = z.enum(["pressed", "released", "unknown"]);
/** Once homed the lift never goes below its soft minimum (≥ 0), so a known height is never negative. */
const liftHeight = z.number().min(0).max(LIFT_RAIL_LENGTH_MM);

export const LiftStateSchema = z
  .strictObject({
    connected: z.boolean(),
    /**
     * The Pi's view: false after any of FAULTS_THAT_UNHOME_LIFT or a lift.disable until a `lift.home`
     * completes, even if the lift ESP32 still counts itself homed.
     */
    homed: z.boolean(),
    /** Counted steps since homing, not a measurement; null when unhomed or disconnected. */
    position_mm: liftHeight.nullable(),
    target_mm: liftHeight.nullable(),
    /** null when disconnected (the lift's own watchdog stops it, but the Pi can't see that). */
    moving: z.boolean().nullable(),
    driver_enabled: z.boolean().nullable(),
    limits: z.strictObject({ top: switchState, bottom: switchState }),
    faults: faultCodes,
  })
  .refine((l) => (l.position_mm !== null) === (l.connected && l.homed), {
    message: "A position is known exactly when the lift is connected and homed.",
    path: ["position_mm"],
  })
  .refine(
    (l) =>
      l.connected ||
      (l.moving === null && l.driver_enabled === null && l.limits.top === "unknown" && l.limits.bottom === "unknown"),
    { message: "A disconnected lift's motion, driver and switches are unknown.", path: ["connected"] },
  )
  .refine((l) => !l.connected || (l.moving !== null && l.driver_enabled !== null), {
    message: "A connected lift reports whether it moves and whether its driver is on.",
    path: ["moving"],
  })
  .refine((l) => l.target_mm === null || l.moving === true, { message: "A target exists only while moving.", path: ["target_mm"] });
export type LiftState = z.infer<typeof LiftStateSchema>;

const activeBase = { command_id: z.uuid(), target_id: z.uuid(), started_at: time };
/**
 * A lift motion while it runs: `running` while its lease is current (`hold_source`), `stopping`
 * after a release, stop, or loss. A stopping or finished request never resumes.
 */
const liftActive = {
  ...activeBase,
  phase: z.enum(["running", "stopping"]),
  hold_source: HoldSourceSchema.nullable(),
  /** Present for a lift request initiated by a local Talk turn, even while stopping. */
  initiated_by: z.literal("talk").optional(),
};
export const ActiveMotionSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({ ...liftActive, kind: z.literal("lift.home") }),
    z.strictObject({ ...liftActive, kind: z.literal("lift.move"), target_mm: liftHeight }),
    z.strictObject({ ...activeBase, kind: z.literal("arm.go_to_pose"), arm: ArmSideSchema, pose: PoseNameSchema }),
    z.strictObject({
      ...activeBase,
      kind: z.literal("skill.run"),
      skill_id: SkillIdSchema,
      title,
      /** 0 at the first waypoint, 1 at the last. */
      progress: z.number().min(0).max(1),
    }),
    z.strictObject({ ...activeBase, kind: z.literal("gripper.release"), arm: ArmSideSchema }),
    z.strictObject({
      ...activeBase,
      kind: z.literal("teleop"),
      pairs: z.array(TeleopPairSchema).min(1).max(2),
      recording_skill_id: SkillIdSchema.nullable(),
    }),
  ])
  .refine((a) => !("phase" in a) || (a.phase === "running") === (a.hold_source !== null), {
    message: "A lift motion runs exactly while a hold control holds it; after a release it is stopping.",
    path: ["hold_source"],
  })
  .refine((a) => !("phase" in a) || (a.initiated_by === "talk" ? a.kind === "lift.move" && a.hold_source !== "screen_hold_control" : a.hold_source !== "local_voice_request"), {
    message: "Only a lift.move started from a local Talk turn holds on local_voice_request, and it never holds on the screen control.",
    path: ["hold_source"],
  });
export type ActiveMotion = z.infer<typeof ActiveMotionSchema>;

export const LastCommandSchema = z
  .strictObject({
    command_id: z.uuid(),
    kind: MotionCommandKindSchema,
    outcome: z.enum(["refused", "completed", "stopped", "faulted"]),
    /** Present exactly when refused. */
    refusal: MotionRefusalSchema.optional(),
    at: time,
  })
  .refine((c) => (c.outcome === "refused") === (c.refusal !== undefined), {
    message: "A refusal names its reason; other outcomes don't.",
    path: ["refusal"],
  });

/** What the Pi reports about motion, several times a second to its screen and with each heartbeat later. */
export const MotionStateSchema = z
  .strictObject({
    version: z.literal(MOTION_CONTRACT_VERSION),
    generated_at: time,
    mode: MotionModeSchema,
    /** Set only by MOTION_BENCH_ENV at start; clients then show BENCH_MODE_LABEL. */
    bench_mode: z.boolean(),
    stop_circuit: StopCircuitSchema,
    /** Whether a hand control that can confirm and stop (a handle module or the Pi's GPIO buttons) is connected. */
    hand_controls_connected: z.boolean(),
    arms: z
      .array(ArmStateSchema)
      .max(4)
      .refine((arms) => unique(arms.map((a) => `${a.arm}/${a.role}`)), "Each arm and role appears once."),
    /** null when no lift is fitted. */
    lift: LiftStateSchema.nullable(),
    active: ActiveMotionSchema.nullable(),
    /** The one pending Confirm target, if any: what a Confirm press would do now. */
    confirm_target: ConfirmTargetSchema.refine((t) => t.state === "open", "Only an open target is pending.").nullable(),
    last_command: LastCommandSchema.nullable(),
    /** Every latched fault, oldest first. */
    faults: z.array(MotionFaultSchema).max(32),
  })
  .refine((s) => (s.mode === "fault") === (s.faults.length > 0), {
    message: "The mode is fault exactly when a fault is latched.",
    path: ["mode"],
  })
  .refine((s) => (s.mode === "fault" ? s.active === null || s.active.kind === "gripper.release" : (s.mode === "moving") === (s.active !== null && s.active.kind !== "teleop")), {
    message: "The mode is moving exactly when a command other than teleop is active; with a fault latched, only letting go runs.",
    path: ["mode"],
  })
  .refine((s) => (s.mode === "teleop") === (s.active?.kind === "teleop"), {
    message: "The mode is teleop exactly when teleop is active.",
    path: ["mode"],
  })
  .refine((s) => s.stop_circuit !== "pressed" || s.faults.some((f) => f.code === "stop_circuit_opened"), {
    message: "A pressed stop always has stop_circuit_opened latched.",
    path: ["faults"],
  })
  .refine((s) => s.stop_circuit !== "not_wired" || s.bench_mode || s.mode === "disabled" || s.mode === "fault", {
    message: "Without a hardware stop outside bench mode, motion is disabled.",
    path: ["mode"],
  })
  .refine((s) => s.active === null || s.bench_mode || s.hand_controls_connected, {
    message: "Outside bench mode nothing moves without a hand control connected to stop it.",
    path: ["active"],
  })
  .refine(
    (s) =>
      s.confirm_target === null ||
      s.mode === "ready" ||
      (s.mode === "fault" && allowedWhileFaulted(s.confirm_target.action)),
    {
      message: "A Confirm target is pending only while ready (in a fault, only to clear it or make the hardware safer).",
      path: ["confirm_target"],
    },
  );
export type MotionState = z.infer<typeof MotionStateSchema>;
