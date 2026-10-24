import {
  LIFT_HOMING_FAST_MM_S,
  LIFT_HOMING_SLOW_MM_S,
  MOTION_LIMITS,
  liftInstallationAllowsMotion,
  liftMayDisable,
  type ConfirmAction,
  type LiftConfig,
  type LiftInstallation,
  type MotionRefusal,
} from "@walker/contracts";

/** The three Confirm actions that drive the lift (motion.ts `ConfirmActionSchema`). */
export type LiftAction = Extract<ConfirmAction, { kind: "lift.home" | "lift.move" | "lift.disable" }>;

/** What the coordinator knows that the lift client doesn't. */
export interface LiftCheckInputs {
  /** The Pi's own stop-sense reading (motion.ts `StopCircuitSchema`). */
  stopCircuit: "released" | "pressed" | "not_wired";
  /** Any motion fault is latched on the Pi (any part). */
  faultLatched: boolean;
  /** Every fitted follower holds its stowed pose (torque on, within AT_POSE_TOLERANCE_DEG). */
  armsStowed: boolean;
  /** Another command (an arm's) is moving something. */
  otherMotion: boolean;
}

/** What the lift client knows, at one moment. */
export interface LiftView {
  /** Bench mode (MOTION_BENCH_ENV), read once at start. */
  bench: boolean;
  config: LiftConfig;
  installation: LiftInstallation;
  /** A lift port has said `lift.hello` for this lift at least once. */
  heard: boolean;
  /** `lift.status` is arriving (not stale) and the latest hello has been seen. */
  fresh: boolean;
  /** The latest hello's `config` matches `config` (null before any hello). */
  configOk: boolean | null;
  /** The latest hello's `stop_sense`. */
  liftStopSense: "wired" | "not_wired" | null;
  /** The latest status's stop-sense reading. */
  statusStop: "pressed" | "released" | "not_wired" | null;
  /** Faults the latest status reports latched. */
  liftFaults: readonly string[];
  /** The lift is moving, homing or stopping by its own status, or the client has a request open. */
  busy: boolean;
  /** Homed in the Pi's view (a completed lift.home since the last unhoming), and by the lift's own status. */
  homed: boolean;
  /** The latest status's bottom switch reads pressed. */
  bottomPressed: boolean;
  /** The screen's hold control is fresh now. */
  held: boolean;
}

/**
 * Whether a lift action may be prepared (`prepare`) or started now (`start`, which adds `not_held`): null, or
 * the first refusal in MOTION_COMMAND_POLICY's order. The coordinator adds the Confirm checks (`confirm_*`) and
 * `no_hand_control`, which it owns.
 */
export function liftVerdict(view: LiftView, action: LiftAction, inputs: LiftCheckInputs, stage: "prepare" | "start"): MotionRefusal | null {
  if (action.kind === "lift.disable") {
    // Making the hardware safer: allowed with a fault latched or the stop pressed (motion.ts allowedWhileFaulted).
    if (view.busy || inputs.otherMotion) return "busy";
    if (!view.heard || !view.fresh) return "part_missing";
    if (!liftMayDisable(view.installation, view.bottomPressed)) return "lift_may_drop";
    return null;
  }
  if (inputs.stopCircuit === "pressed" || view.statusStop === "pressed") return "stop_pressed";
  // The lift never moves without the hardware stop, bench mode or not (the contract's): bench mode waives the
  // stop for the arms only. Both the Pi's stop-sense and the lift board's must be wired.
  if (inputs.stopCircuit === "not_wired" || view.liftStopSense === "not_wired") return "no_hardware_stop";
  if (inputs.faultLatched || view.liftFaults.length > 0 || view.configOk === false) return "fault_latched";
  if (view.busy || inputs.otherMotion) return "busy";
  if (!view.heard) return "part_missing";
  if (!view.fresh || view.configOk === null) return "feedback_stale";
  if (stage === "start" && !view.held) return "not_held";
  if (!view.bench && !view.installation.guards_fitted) return "lift_guards_missing";
  if (!view.bench && !liftInstallationAllowsMotion(view.installation)) return "lift_drop_test_missing";
  if (liftOverLimits(view.config, view.bench, action.kind)) return "lift_over_limits";
  if (!inputs.armsStowed) return "arms_not_stowed";
  if (action.kind === "lift.move") {
    if (!view.homed) return "lift_not_homed";
    if (!(action.target_mm >= view.config.soft_min_mm && action.target_mm <= view.config.soft_max_mm)) return "out_of_range";
  }
  return null;
}

/**
 * Whether the lift would run above this mode's limits (MOTION_LIMITS). `lift.move` carries no acceleration, so
 * the lift uses its built-in `max_accel_mm_s2` (the configuration, which must equal what `lift.hello` reports):
 * above the mode's `lift_accel_mm_s2` it is refused. A move's speed is capped to the mode's (`liftMoveSpeed`),
 * but homing runs at the contract's fixed LIFT_HOMING_FAST_MM_S and LIFT_HOMING_SLOW_MM_S: above the mode's
 * `lift_speed_mm_s` homing is refused. With today's numbers that is bench mode (15 mm/s against 10), so the lift
 * can't home, and so can't move, in bench mode at all.
 */
export function liftOverLimits(config: LiftConfig, bench: boolean, kind: "lift.home" | "lift.move"): boolean {
  const limits = MOTION_LIMITS[bench ? "bench" : "normal"];
  if (config.max_accel_mm_s2 > limits.lift_accel_mm_s2) return true;
  return kind === "lift.home" && Math.max(LIFT_HOMING_FAST_MM_S, LIFT_HOMING_SLOW_MM_S) > limits.lift_speed_mm_s;
}

/** A move's speed: the lower of the configuration's and the mode's (MOTION_LIMITS). */
export function liftMoveSpeed(config: LiftConfig, bench: boolean): number {
  return Math.min(config.max_speed_mm_s, MOTION_LIMITS[bench ? "bench" : "normal"].lift_speed_mm_s);
}

/**
 * Whether the firmware's built-in configuration (from `lift.hello`) is the Pi's, field by field. Heights and
 * rates are compared at the firmware's resolution (it stores thousandths), so 5 and 5.0001 are the same.
 */
export function sameLiftConfig(a: LiftConfig, b: LiftConfig): boolean {
  const milli = (x: number | null) => (x === null ? null : Math.round(x * 1000));
  return (
    a.microsteps === b.microsteps &&
    milli(a.soft_min_mm) === milli(b.soft_min_mm) &&
    milli(a.soft_max_mm) === milli(b.soft_max_mm) &&
    milli(a.max_speed_mm_s) === milli(b.max_speed_mm_s) &&
    milli(a.max_accel_mm_s2) === milli(b.max_accel_mm_s2) &&
    milli(a.top_switch_mm) === milli(b.top_switch_mm)
  );
}
