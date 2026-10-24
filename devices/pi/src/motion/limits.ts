import {
  ARM_JOINTS,
  ARM_SPEED_CEILING_DEG_S,
  JOINT_RANGE_MARGIN_DEG,
  MAX_GOAL_LEAD_DEG,
  MAX_GOAL_STEP_DEG,
  MOTION_CONTROL_PERIOD_MS,
  MOTION_LIMITS,
  SERVO_TICKS_PER_TURN,
  jointRangeDegrees,
  type ArmCalibration,
  type ArmJoint,
  type ArmJoints,
  type MotionLimits,
} from "@walker/contracts";

/**
 * The arithmetic of the motion loop, kept pure so each rule is tested on its own. Angles are degrees from a
 * joint's calibrated zero (the contract's units). Every number here not imported from the contract is a
 * placeholder, not measured.
 */

export function modeLimits(bench: boolean): MotionLimits {
  return bench ? MOTION_LIMITS.bench : MOTION_LIMITS.normal;
}

/** Teleop's speed: the mode's teleop limit, capped at ARM_SPEED_CEILING_DEG_S while recording a skill. */
export function teleopSpeedDegS(limits: MotionLimits, recording: boolean): number {
  return recording ? Math.min(limits.arm_speed_deg_s.teleop, ARM_SPEED_CEILING_DEG_S) : limits.arm_speed_deg_s.teleop;
}

/**
 * Placeholder, not measured: the servo's own Goal Speed register is set this much above the Pi's ramp speed,
 * as a second layer: the servo can keep up with the Pi's goals, but can't race to a far goal. The register's
 * unit is assumed to be steps/s (devices/pi/src/motion/feetech/README.md; check on the bench).
 */
export const SERVO_SPEED_HEADROOM = 1.25;
/** Placeholder: the lowest Goal Speed the Pi writes (about 5°/s), so a nearly still joint never reads 0 = "fastest". */
export const SERVO_SPEED_FLOOR_DEG_S = 5;
/**
 * Placeholder, not measured: the servo's Acceleration register for every goal (unit assumed 100 steps/s², so
 * 30 is about 264°/s²). Never 0, which the servo reads as "as fast as possible".
 */
export const SERVO_ACCELERATION_REGISTER = 30;

export function servoSpeedRegister(degS: number): number {
  const steps = (Math.max(degS, SERVO_SPEED_FLOOR_DEG_S) * SERVO_SPEED_HEADROOM * SERVO_TICKS_PER_TURN) / 360;
  return Math.max(1, Math.min(32767, Math.ceil(steps)));
}

/** Torque Limit register value (0.1 % units) for a percentage. */
export function torqueRegister(pct: number): number {
  return Math.max(0, Math.min(1000, Math.round(pct * 10)));
}

export function jointTorquePct(limits: MotionLimits, joint: ArmJoint): number {
  return joint === "gripper" ? limits.gripper_torque_pct : limits.arm_torque_pct;
}

/**
 * The control loop's step length. Measured from the clock, but never more than two periods, so a loop that
 * stalled (a slow bus, a busy Pi) doesn't make one big jump afterwards.
 */
export function stepSeconds(elapsedMs: number): number {
  return Math.max(0, Math.min(elapsedMs, 2 * MOTION_CONTROL_PERIOD_MS)) / 1000;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** The commandable range of one joint: its calibrated range less JOINT_RANGE_MARGIN_DEG at each end. */
export function commandRange(calibration: ArmCalibration, joint: ArmJoint): { min: number; max: number } {
  const range = jointRangeDegrees(calibration.joints[joint]);
  return { min: range.min + JOINT_RANGE_MARGIN_DEG, max: range.max - JOINT_RANGE_MARGIN_DEG };
}

/**
 * The next goal for one joint: `previous` moved toward `target` by at most `maxStepDeg` (and never more than
 * MAX_GOAL_STEP_DEG), then clamped to within MAX_GOAL_LEAD_DEG of the measured position. The lead clamp is
 * last, so it always wins: if the Pi stops right after this write, the joint goes at most MAX_GOAL_LEAD_DEG
 * further. A joint that can't keep up just gets a goal that waits for it.
 */
export function nextGoal(previous: number, target: number, measured: number, maxStepDeg: number): number {
  const step = Math.min(Math.max(0, maxStepDeg), MAX_GOAL_STEP_DEG);
  const moved = previous + clamp(target - previous, -step, step);
  return clamp(moved, measured - MAX_GOAL_LEAD_DEG, measured + MAX_GOAL_LEAD_DEG);
}

/**
 * Per-joint speeds for a straight line in joint space from `from` to `to` at `speedDegS`: the joint with the
 * longest move goes at the full speed, the others slower, so they all arrive together.
 */
export function lineSpeeds(from: ArmJoints, to: ArmJoints, speedDegS: number): { speeds: Record<ArmJoint, number>; longestDeg: number } {
  const longestDeg = Math.max(...ARM_JOINTS.map((j) => Math.abs(to[j] - from[j])));
  const speeds = {} as Record<ArmJoint, number>;
  for (const joint of ARM_JOINTS) {
    speeds[joint] = longestDeg > 0 ? (speedDegS * Math.abs(to[joint] - from[joint])) / longestDeg : 0;
  }
  return { speeds, longestDeg };
}

/** A leader's reading clamped into the follower's commandable range, joint by joint. */
export function clampToFollower(joints: ArmJoints, follower: ArmCalibration): ArmJoints {
  const out = {} as ArmJoints;
  for (const joint of ARM_JOINTS) {
    const range = commandRange(follower, joint);
    out[joint] = clamp(joints[joint], range.min, range.max);
  }
  return out;
}

export function largestGap(a: ArmJoints, b: ArmJoints): { joint: ArmJoint; deg: number } {
  let worst: { joint: ArmJoint; deg: number } = { joint: ARM_JOINTS[0], deg: -1 };
  for (const joint of ARM_JOINTS) {
    const deg = Math.abs(a[joint] - b[joint]);
    if (deg > worst.deg) worst = { joint, deg };
  }
  return worst;
}
