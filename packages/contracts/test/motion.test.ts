import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ARM_COMPLIANT_TORQUE_PCT,
  ARM_JOINTS,
  ARM_SPEED_CEILING_DEG_S,
  AT_POSE_TOLERANCE_DEG,
  ArmCalibrationSchema,
  ArmStateSchema,
  BENCH_MODE_LABEL,
  CHECKS_WHILE_HOLDING,
  CONFIRMED_KINDS,
  CONFIRM_ARM_DELAY_MS,
  CONFIRM_ONLY_PROMPT,
  SCREEN_HOLD_RELEASE_EVENTS,
  allowedWhileFaulted,
  ConfirmTargetSchema,
  FAULTS_THAT_UNHOME_LIFT,
  FAULT_REACTION,
  FAULT_SENTENCES,
  FEEDBACK_DIVERGENCE_DEG,
  FEEDBACK_STALE_MS,
  FaultReactionSchema,
  GRIPPER_HOLD_TORQUE_PCT,
  HOLD_CONTROL_REFRESH_MS,
  HoldSourceSchema,
  JOINT_RANGE_MARGIN_DEG,
  JointCalibrationSchema,
  LIFT_HEARTBEAT_INTERVAL_MS,
  LIFT_HOLD_LEASE_MS,
  LIFT_HOMING_BACKOFF_MM,
  LIFT_HOMING_FAST_MM_S,
  LIFT_HOMING_MAX_TRAVEL_MM,
  LIFT_HOMING_RELEASE_MARGIN_MM,
  LIFT_HOMING_SLOW_MM_S,
  LIFT_HOMING_TIMEOUT_MS,
  LIFT_STATUS_HZ,
  LIFT_STATUS_STALE_MS,
  LIFT_WATCHDOG_DRIVER_ACTION,
  LIFT_WATCHDOG_TIMEOUT_MS,
  LiftConfigSchema,
  LiftInstallationSchema,
  LiftSerialFaultSchema,
  LiftStateSchema,
  ActiveMotionSchema,
  MANIFEST_MAY_LIST_ARMS,
  MAX_GOAL_LEAD_DEG,
  MAX_GOAL_STEP_DEG,
  MOTION_BENCH_ENV,
  MOTION_BENCH_ENV_VALUE,
  MOTION_COMMAND_POLICY,
  MOTION_CONTROL_HZ,
  MOTION_CONTROL_PERIOD_MS,
  MOTION_LIMITS,
  MOTION_TIMEOUT_MARGIN_MS,
  MotionCommandKindSchema,
  MotionCommandSchema,
  MotionFaultCodeSchema,
  MotionFaultSchema,
  MotionOfferRequestSchema,
  MotionRefusalSchema,
  MotionSetupSchema,
  MotionStateSchema,
  NamedPoseSchema,
  PARK_PROMPT,
  PreparerSchema,
  REFUSAL_SENTENCES,
  SCREEN_OS_USER,
  SKILL_MAX_DURATION_MS,
  SKILL_MAX_WAYPOINTS,
  STOP_COMMANDS,
  SkillSchema,
  StopSourceSchema,
  TELEOP_ENGAGE_TOLERANCE_DEG,
  TELEOP_GAP_DEG,
  TELEOP_OVERSPEED_FACTOR,
  WALKER_CONFIRM_WAIT_MS,
  armsHoldingAtEnd,
  checkSkillAgainstSetup,
  commandMatchesTarget,
  confirmPressVerdict,
  confirmPrompt,
  degreesToTicks,
  isPreparerAllowed,
  jointRangeDegrees,
  jointsOutsideCalibration,
  liftInstallationAllowsMotion,
  liftMayDisable,
  liftStepsPerMm,
  mayReplaceConfirmTarget,
  motionTimeoutMs,
  ticksToDegrees,
  type ArmCalibration,
  type ArmJoints,
  type ConfirmTarget,
  type MotionCommand,
  type MotionSetup,
} from "../src";

// ---- Fixtures: an arm calibrated to ±90° on every joint, a lift from 5 to 600 mm ----

const T = "2026-10-24T09:00:00.000Z";
const T_LATER = "2026-10-24T09:00:20.000Z";
const UUID = "9c7e35ad-7602-4c6a-8a29-306f69599edc";
const OFFER = "0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b";

const joint = (servo_id: number, extra: Partial<Record<string, number>> = {}) => ({
  servo_id,
  homing_offset: 0,
  min_ticks: 1024,
  max_ticks: 3072,
  zero_ticks: 2048,
  direction: 1,
  ...extra,
});
const calibration = (arm: "left" | "right", role: "follower" | "leader" = "follower") => ({
  format: "sophi.arm_calibration",
  version: 1,
  arm,
  role,
  bus_id: `usb-1a86_USB_Single_Serial_${arm}_${role}-if00`,
  calibrated_at: T,
  joints: Object.fromEntries(ARM_JOINTS.map((j, i) => [j, joint(i + 1)])),
});
const joints = (value = 0, over: Partial<ArmJoints> = {}): ArmJoints => ({
  ...(Object.fromEntries(ARM_JOINTS.map((j) => [j, value])) as ArmJoints),
  ...over,
});
const pose = (name: string, arm: "left" | "right" = "left", value = 0) => ({
  name,
  title: name === "handover" ? "Hold it out to you" : "Fold the arm away",
  arm,
  joints: joints(value),
  updated_at: T,
});
const liftConfig = {
  microsteps: 8,
  soft_min_mm: 5,
  soft_max_mm: 600,
  max_speed_mm_s: 20,
  max_accel_mm_s2: 50,
  top_switch_mm: null,
};
const installation = {
  guards_fitted: true,
  drop_test: "passed",
  brake_fitted: false,
  stop_cuts_lift_power: false,
  driver_current_setting: "1.0 A",
  recorded_at: T,
};
const setup = (): MotionSetup =>
  MotionSetupSchema.parse({
    format: "sophi.motion_setup",
    version: 1,
    stop_sense: "wired",
    arms: [calibration("left"), calibration("left", "leader")],
    poses: [pose("stowed"), pose("ready", "left", 10), pose("handover", "left", 20)],
    lift: { config: liftConfig, installation },
  });

/** A one-arm skill: shoulder_pan 0° → 30° → 60° at 30°/s, grasp at 1 s. */
const skill = () => ({
  format: "sophi.skill",
  version: 1,
  skill_id: "tray_pick_handover",
  title: "Hand over the cup",
  source: "recorded",
  created_at: T,
  arms: ["left"],
  start: { joints: { left: joints() }, tolerance_deg: 3 },
  max_speed_deg_s: Object.fromEntries(ARM_JOINTS.map((j) => [j, 30])),
  waypoints: [
    { t_ms: 0, joints: { left: joints() } },
    { t_ms: 1000, joints: { left: joints(0, { shoulder_pan: 30 }) } },
    { t_ms: 2000, joints: { left: joints(0, { shoulder_pan: 60 }) } },
  ],
  gripper_events: [{ t_ms: 1000, arm: "left", kind: "grasp" }],
  let_go: [{ arm: "left", gripper_open_deg: 40 }],
  lift_mm: 250,
});

const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, value: unknown) => schema.safeParse(value).success;

// ---- Calibration ----

describe("arm calibration", () => {
  it("parses a calibrated arm", () => {
    expect(ok(ArmCalibrationSchema, calibration("left"))).toBe(true);
  });

  it.each([
    ["min not below max", { min_ticks: 3072, max_ticks: 3072 }],
    ["zero outside the range", { zero_ticks: 1000 }],
    ["more than half a turn below zero", { min_ticks: 0, zero_ticks: 2049 }],
    ["more than half a turn above zero", { zero_ticks: 1000, min_ticks: 1000, max_ticks: 3049 }],
    ["a tick past 4095", { max_ticks: 4096 }],
    ["the broadcast id", { servo_id: 254 }],
    ["an offset past the register", { homing_offset: 2048 }],
    ["a direction of 0", { direction: 0 }],
    ["a fractional tick", { min_ticks: 1024.5 }],
  ])("refuses a joint with %s", (_why, extra) => {
    expect(ok(JointCalibrationSchema, joint(1, extra as Record<string, number>))).toBe(false);
  });

  it("accepts exactly half a turn either side of zero", () => {
    expect(ok(JointCalibrationSchema, joint(1, { min_ticks: 0, zero_ticks: 2048, max_ticks: 4095 }))).toBe(true);
  });

  it("refuses two joints on one servo id, a missing joint, and an extra field", () => {
    const c = calibration("left");
    expect(ok(ArmCalibrationSchema, { ...c, joints: { ...c.joints, gripper: joint(1) } })).toBe(false);
    const { gripper: _, ...five } = c.joints;
    expect(ok(ArmCalibrationSchema, { ...c, joints: five })).toBe(false);
    expect(ok(ArmCalibrationSchema, { ...c, port: "/dev/ttyACM0" })).toBe(false);
    expect(ok(ArmCalibrationSchema, { ...c, bus_id: "/dev/ttyACM0" })).toBe(false);
  });

  it("converts ticks and degrees both ways, honouring direction", () => {
    const j = JointCalibrationSchema.parse(joint(1));
    expect(ticksToDegrees(j, 3072)).toBe(90);
    expect(ticksToDegrees(j, 1024)).toBe(-90);
    expect(degreesToTicks(j, 45)).toBe(2560);
    const reversed = JointCalibrationSchema.parse(joint(1, { direction: -1 }));
    expect(ticksToDegrees(reversed, 3072)).toBe(-90);
    expect(degreesToTicks(reversed, ticksToDegrees(reversed, 1500))).toBe(1500);
    expect(jointRangeDegrees(reversed)).toEqual({ min: -90, max: 90 });
  });

  it("keeps commanded angles a margin inside the range", () => {
    const c = ArmCalibrationSchema.parse(calibration("left")) as ArmCalibration;
    expect(jointsOutsideCalibration(joints(90 - JOINT_RANGE_MARGIN_DEG), c)).toEqual([]);
    expect(jointsOutsideCalibration(joints(0, { elbow_flex: 89 }), c).map((p) => p.joint)).toEqual(["elbow_flex"]);
  });
});

// ---- Poses and lift ----

describe("named poses", () => {
  it("parses a pose and refuses bad ones", () => {
    expect(ok(NamedPoseSchema, pose("stowed"))).toBe(true);
    expect(ok(NamedPoseSchema, { ...pose("Stowed") })).toBe(false);
    expect(ok(NamedPoseSchema, { ...pose("stowed"), title: " " })).toBe(false);
    const { title: _t, ...untitled } = pose("stowed");
    expect(ok(NamedPoseSchema, untitled)).toBe(false);
    expect(ok(NamedPoseSchema, { ...pose("stowed"), joints: joints(0, { wrist_roll: 180.5 }) })).toBe(false);
    expect(ok(NamedPoseSchema, { ...pose("stowed"), joints: joints(0, { wrist_roll: Number.NaN }) })).toBe(false);
    expect(ok(NamedPoseSchema, { ...pose("stowed"), joints: joints(0, { wrist_roll: Number.POSITIVE_INFINITY }) })).toBe(false);
    const { gripper: _, ...five } = joints();
    expect(ok(NamedPoseSchema, { ...pose("stowed"), joints: five })).toBe(false);
    expect(ok(NamedPoseSchema, { ...pose("stowed"), arm: "middle" })).toBe(false);
  });
});

describe("lift configuration", () => {
  it("parses one and counts steps per millimetre", () => {
    const config = LiftConfigSchema.parse(liftConfig);
    expect(liftStepsPerMm(config)).toBe(320);
    expect(liftStepsPerMm({ microsteps: 1 })).toBe(40);
  });

  it.each([
    ["min not below max", { soft_min_mm: 600 }],
    ["max at the top switch", { top_switch_mm: 600 }],
    ["max past the rail", { soft_max_mm: 1001 }],
    ["a negative min", { soft_min_mm: -1 }],
    ["speed past the ceiling", { max_speed_mm_s: 50.5 }],
    ["zero speed", { max_speed_mm_s: 0 }],
    ["accel past the ceiling", { max_accel_mm_s2: 201 }],
    ["a microstep setting the driver lacks", { microsteps: 3 }],
    ["an installation field mixed in", { guards_fitted: true }],
  ])("refuses %s", (_why, over) => {
    expect(ok(LiftConfigSchema, { ...liftConfig, ...over })).toBe(false);
  });

  it("accepts the ceilings themselves and a measured top switch above max", () => {
    expect(ok(LiftConfigSchema, { ...liftConfig, max_speed_mm_s: 50, max_accel_mm_s2: 200, top_switch_mm: 640 })).toBe(true);
  });
});

describe("lift installation record", () => {
  it("lets the stop cut lift power only after a passed drop test or with a brake", () => {
    expect(ok(LiftInstallationSchema, { ...installation, stop_cuts_lift_power: true })).toBe(true);
    expect(ok(LiftInstallationSchema, { ...installation, drop_test: "not_done", stop_cuts_lift_power: true })).toBe(false);
    expect(ok(LiftInstallationSchema, { ...installation, drop_test: "failed", stop_cuts_lift_power: true })).toBe(false);
    expect(ok(LiftInstallationSchema, { ...installation, drop_test: "failed", brake_fitted: true, stop_cuts_lift_power: true })).toBe(true);
    expect(ok(LiftInstallationSchema, { ...installation, drop_test: "maybe" })).toBe(false);
  });

  it.each([
    ["guards and a passed drop test", {}, true],
    ["no guards", { guards_fitted: false }, false],
    ["the drop test not done", { drop_test: "not_done" }, false],
    ["the drop test failed", { drop_test: "failed" }, false],
    ["the drop test failed but a brake fitted", { drop_test: "failed", brake_fitted: true }, true],
  ])("allows lift motion outside bench with %s: %s", (_why, over, allowed) => {
    expect(liftInstallationAllowsMotion(LiftInstallationSchema.parse({ ...installation, ...over }))).toBe(allowed);
  });
});

describe("motion setup", () => {
  it("parses the bench setup", () => {
    expect(setup().poses).toHaveLength(3);
  });

  it("declares the stop-sense input rather than reading it", () => {
    expect(ok(MotionSetupSchema, { ...setup(), stop_sense: "not_wired" })).toBe(true);
    expect(ok(MotionSetupSchema, { ...setup(), stop_sense: "pressed" })).toBe(false);
    const { stop_sense: _, ...undeclared } = setup();
    expect(ok(MotionSetupSchema, undeclared)).toBe(false);
  });

  it("needs the lift's installation record with its configuration", () => {
    expect(ok(MotionSetupSchema, { ...setup(), lift: liftConfig })).toBe(false);
    expect(ok(MotionSetupSchema, { ...setup(), lift: { config: liftConfig } })).toBe(false);
    expect(ok(MotionSetupSchema, { ...setup(), lift: null })).toBe(true);
  });

  it("refuses a follower with no stowed pose", () => {
    expect(ok(MotionSetupSchema, { ...setup(), poses: [pose("ready")] })).toBe(false);
  });

  it("refuses a pose for an arm with no follower calibration", () => {
    expect(ok(MotionSetupSchema, { ...setup(), poses: [...setup().poses, pose("stowed", "right")] })).toBe(false);
  });

  it("refuses a pose outside its calibrated range", () => {
    expect(ok(MotionSetupSchema, { ...setup(), poses: [pose("stowed"), pose("high", "left", 89)] })).toBe(false);
  });

  it("refuses repeats: arm and role, controller board, pose name", () => {
    const s = setup();
    expect(ok(MotionSetupSchema, { ...s, arms: [...s.arms, calibration("left")] })).toBe(false);
    expect(ok(MotionSetupSchema, { ...s, arms: [s.arms[0], { ...calibration("right"), bus_id: s.arms[0]!.bus_id }] })).toBe(false);
    expect(ok(MotionSetupSchema, { ...s, poses: [...s.poses, pose("stowed")] })).toBe(false);
  });
});

// ---- Skills ----

describe("skill files", () => {
  it("parses a recorded skill", () => {
    expect(ok(SkillSchema, skill())).toBe(true);
  });

  it("accepts a joint moving at exactly its max speed", () => {
    const s = skill();
    s.waypoints[1] = { t_ms: 1000, joints: { left: joints(0, { shoulder_pan: 30 }) } };
    expect(ok(SkillSchema, s)).toBe(true);
  });

  const broken: [string, (s: ReturnType<typeof skill>) => unknown][] = [
    ["a first waypoint after 0 ms", (s) => ({ ...s, waypoints: [{ ...s.waypoints[0]!, t_ms: 5 }, ...s.waypoints.slice(1)] })],
    ["two waypoints at the same time", (s) => ({ ...s, waypoints: [s.waypoints[0], { ...s.waypoints[1]!, t_ms: 0 }] })],
    ["waypoints out of order", (s) => ({ ...s, waypoints: [s.waypoints[0], s.waypoints[2], s.waypoints[1]] })],
    ["waypoints closer than 10 ms", (s) => ({ ...s, waypoints: [s.waypoints[0], { t_ms: 9, joints: { left: joints() } }] })],
    ["waypoints more than a second apart", (s) => ({ ...s, waypoints: [s.waypoints[0], { t_ms: 1001, joints: { left: joints() } }] })],
    ["a joint faster than its max speed", (s) => ({ ...s, waypoints: [s.waypoints[0], { t_ms: 1000, joints: { left: joints(0, { elbow_flex: 30.01 }) } }] })],
    ["a joint past 180°", (s) => ({ ...s, waypoints: [s.waypoints[0], { t_ms: 1000, joints: { left: joints(0, { gripper: 181 }) } }] })],
    ["a waypoint as a string", (s) => ({ ...s, waypoints: [s.waypoints[0], { t_ms: "1000", joints: { left: joints() } }] })],
    ["no start pose", (s) => {
      const { start: _, ...rest } = s;
      return rest;
    }],
    ["a start pose missing its arm", (s) => ({ ...s, start: { ...s.start, joints: {} } })],
    ["a start pose for another arm", (s) => ({ ...s, start: { ...s.start, joints: { left: joints(), right: joints() } } })],
    ["a first waypoint away from the start pose", (s) => ({ ...s, start: { ...s.start, joints: { left: joints(0, { wrist_flex: 3.5 }) } } })],
    ["a start tolerance over 10°", (s) => ({ ...s, start: { ...s.start, tolerance_deg: 10.5 } })],
    ["a zero start tolerance", (s) => ({ ...s, start: { ...s.start, tolerance_deg: 0 } })],
    ["a waypoint missing its arm", (s) => ({ ...s, waypoints: [s.waypoints[0], { t_ms: 1000, joints: {} }] })],
    ["a max speed over the ceiling", (s) => ({ ...s, max_speed_deg_s: { ...s.max_speed_deg_s, gripper: ARM_SPEED_CEILING_DEG_S + 1 } })],
    ["a missing max speed", (s) => {
      const { gripper: _, ...five } = s.max_speed_deg_s;
      return { ...s, max_speed_deg_s: five };
    }],
    ["a gripper event for another arm", (s) => ({ ...s, gripper_events: [{ t_ms: 1000, arm: "right", kind: "grasp" }] })],
    ["a gripper event after the end", (s) => ({ ...s, gripper_events: [{ t_ms: 2001, arm: "left", kind: "release" }] })],
    ["gripper events out of order", (s) => ({ ...s, gripper_events: [{ t_ms: 1500, arm: "left", kind: "grasp" }, { t_ms: 1000, arm: "left", kind: "release" }] })],
    ["the same arm twice", (s) => ({ ...s, arms: ["left", "left"] })],
    ["no arms", (s) => ({ ...s, arms: [] })],
    ["a single waypoint", (s) => ({ ...s, waypoints: [s.waypoints[0]] })],
    ["a waypoint past 60 s", (s) => ({ ...s, waypoints: [...s.waypoints, { t_ms: 60_001, joints: { left: joints(0, { shoulder_pan: 60 }) } }] })],
    ["a lift height past the rail", (s) => ({ ...s, lift_mm: 1001 })],
    ["an extra field", (s) => ({ ...s, speed_scale: 2 })],
    ["another format", (s) => ({ ...s, format: "lerobot.dataset" })],
    ["an empty title", (s) => ({ ...s, title: "  " })],
  ];
  it.each(broken)("refuses %s", (_why, mutate) => {
    expect(ok(SkillSchema, mutate(skill()))).toBe(false);
  });

  it("refuses more than SKILL_MAX_WAYPOINTS waypoints", () => {
    const waypoints = Array.from({ length: SKILL_MAX_WAYPOINTS + 1 }, (_, i) => ({ t_ms: i * 10, joints: { left: joints() } }));
    expect(ok(SkillSchema, { ...skill(), waypoints, gripper_events: [], let_go: [] })).toBe(false);
  });

  it("parses a two-arm skill", () => {
    const s = skill();
    const both = (j: ArmJoints) => ({ left: j, right: j });
    expect(
      ok(SkillSchema, {
        ...s,
        arms: ["left", "right"],
        start: { ...s.start, joints: both(joints()) },
        waypoints: s.waypoints.map((wp) => ({ t_ms: wp.t_ms, joints: both(wp.joints.left) })),
      }),
    ).toBe(true);
  });

  it("checks a skill against this walker's calibration and lift", () => {
    const s = SkillSchema.parse(skill());
    expect(checkSkillAgainstSetup(s, setup())).toEqual([]);
    const far = SkillSchema.parse({ ...skill(), waypoints: [skill().waypoints[0], { t_ms: 1000, joints: { left: joints(0, { shoulder_pan: 30 }) } }, { t_ms: 2000, joints: { left: joints(0, { shoulder_pan: 59 }) } }, { t_ms: 3000, joints: { left: joints(0, { shoulder_pan: 89 }) } }] });
    expect(checkSkillAgainstSetup(far, setup())).toMatchObject([{ code: "out_of_range", arm: "left", waypoint: 3 }]);
    expect(checkSkillAgainstSetup(SkillSchema.parse({ ...skill(), lift_mm: 601 }), setup())).toEqual([{ code: "lift_out_of_range", lift_mm: 601 }]);
    expect(checkSkillAgainstSetup(s, { ...setup(), lift: null })).toEqual([{ code: "lift_missing" }]);
    expect(checkSkillAgainstSetup(s, { ...setup(), arms: [] })).toEqual([{ code: "arm_not_calibrated", arm: "left" }]);
  });

  it("ends holding, and names where to let go exactly for the arms still grasping", () => {
    expect(armsHoldingAtEnd(SkillSchema.parse(skill()))).toEqual(["left"]);
    expect(ok(SkillSchema, { ...skill(), let_go: [] })).toBe(false);
    expect(ok(SkillSchema, { ...skill(), let_go: [{ arm: "left", gripper_open_deg: 40 }, { arm: "left", gripper_open_deg: 40 }] })).toBe(false);
    expect(ok(SkillSchema, { ...skill(), let_go: [{ arm: "right", gripper_open_deg: 40 }] })).toBe(false);
    const placed = { ...skill(), gripper_events: [{ t_ms: 1000, arm: "left", kind: "grasp" }, { t_ms: 2000, arm: "left", kind: "release" }] };
    expect(ok(SkillSchema, { ...placed, let_go: [] })).toBe(true);
    expect(ok(SkillSchema, placed)).toBe(false);
    expect(ok(SkillSchema, { ...skill(), let_go: [{ arm: "left", gripper_open_deg: 200 }] })).toBe(false);
    const wide = SkillSchema.parse({ ...skill(), let_go: [{ arm: "left", gripper_open_deg: 89 }] });
    expect(checkSkillAgainstSetup(wide, setup())).toEqual([{ code: "let_go_out_of_range", arm: "left", gripper_open_deg: 89 }]);
  });

  it("needs a lift height exactly when the walker has a lift", () => {
    const noHeight = SkillSchema.parse({ ...skill(), lift_mm: null });
    expect(checkSkillAgainstSetup(noHeight, setup())).toEqual([{ code: "lift_height_missing" }]);
    expect(checkSkillAgainstSetup(noHeight, { ...setup(), lift: null })).toEqual([]);
  });
});

// ---- Confirm targets (the one thing a Confirm press can answer) ----

const SHOWN = 100_000;
const target = (over: Record<string, unknown> = {}) => ({
  target_id: OFFER,
  prepared_by: "offer",
  action: { kind: "skill.run", skill_id: "tray_pick_handover" },
  title: "Hand over the cup",
  prompt: confirmPrompt("Hand over the cup", true),
  shown_mono_ms: SHOWN,
  expires_mono_ms: SHOWN + WALKER_CONFIRM_WAIT_MS,
  shown_at: T,
  state: "open",
  ...over,
});
const PRESS = SHOWN + CONFIRM_ARM_DELAY_MS + 500;
const press = (pressed_mono_ms = PRESS, handle = "left", released_since_mono_ms = SHOWN) => ({ handle, pressed_mono_ms, released_since_mono_ms, pressed_at: T_LATER });
const confirmed = { command_id: UUID, target_id: OFFER, prepared_mono_ms: SHOWN, confirm: press() };

const commands = {
  "lift.home": { ...confirmed, prepared_by: "walker_screen", base_parked: true, kind: "lift.home" },
  "lift.move": { ...confirmed, prepared_by: "walker_screen", base_parked: true, kind: "lift.move", target_mm: 250 },
  "lift.disable": { ...confirmed, prepared_by: "operator_cli", base_parked: true, kind: "lift.disable" },
  "arm.torque": { ...confirmed, prepared_by: "operator_cli", base_parked: true, kind: "arm.torque", arms: ["left", "right"], enabled: true },
  "arm.go_to_pose": { ...confirmed, prepared_by: "offer", base_parked: true, kind: "arm.go_to_pose", arm: "left", pose: "handover" },
  "skill.run": { ...confirmed, prepared_by: "offer", base_parked: true, kind: "skill.run", skill_id: "tray_pick_handover" },
  "gripper.release": { ...confirmed, prepared_by: "walker_local", base_parked: true, kind: "gripper.release", arm: "left", gripper_open_deg: 40 },
  "teleop.start": { ...confirmed, prepared_by: "walker_screen", base_parked: true, kind: "teleop.start", pairs: [{ leader: "left", follower: "left" }], record_skill_id: "tray_pick_handover" },
  "fault.clear": { ...confirmed, prepared_by: "walker_screen", kind: "fault.clear" },
  "teleop.stop": { command_id: UUID, issued_at: T, issued_mono_ms: SHOWN, stopped_by: "operator_cli", kind: "teleop.stop" },
  "motion.stop": { command_id: UUID, issued_at: T, issued_mono_ms: SHOWN, stopped_by: "handle_press", kind: "motion.stop" },
} as const;

describe("Confirm targets", () => {
  it("are worded by the Pi: its own title, then the park prompt (or a plain one when nothing moves)", () => {
    expect(confirmPrompt("Hand over the cup", true)).toBe(`Hand over the cup. ${PARK_PROMPT}`);
    expect(confirmPrompt("Clear the fault", false)).toBe(`Clear the fault. ${CONFIRM_ONLY_PROMPT}`);
    expect(ok(ConfirmTargetSchema, target())).toBe(true);
    expect(ok(ConfirmTargetSchema, target({ prompt: "Grab the knife and swing it. Press Confirm." }))).toBe(false);
    expect(ok(ConfirmTargetSchema, target({ prompt: confirmPrompt("Hand over the cup", false) }))).toBe(false);
    const clear = { action: { kind: "fault.clear" }, prepared_by: "walker_screen", title: "Clear the fault", prompt: confirmPrompt("Clear the fault", false) };
    expect(ok(ConfirmTargetSchema, target(clear))).toBe(true);
    expect(ok(ConfirmTargetSchema, target({ ...clear, prompt: confirmPrompt("Clear the fault", true) }))).toBe(false);
  });

  it("keep a title's own question mark", () => {
    expect(confirmPrompt("Let go?", true)).toBe(`Let go? ${PARK_PROMPT}`);
    expect(confirmPrompt("Hold it out to you.", true)).toBe(`Hold it out to you. ${PARK_PROMPT}`);
    expect(confirmPrompt("  Stop now!  ", false)).toBe(`Stop now! ${CONFIRM_ONLY_PROMPT}`);
  });

  it("live exactly WALKER_CONFIRM_WAIT_MS on the monotonic clock", () => {
    expect(ok(ConfirmTargetSchema, target({ expires_mono_ms: SHOWN + WALKER_CONFIRM_WAIT_MS + 1 }))).toBe(false);
    expect(ok(ConfirmTargetSchema, target({ expires_mono_ms: SHOWN + 1000 }))).toBe(false);
    expect(ok(ConfirmTargetSchema, target({ shown_mono_ms: -1 }))).toBe(false);
  });

  it("may be prepared only by whoever the action's policy names; the cloud only offers skills and poses", () => {
    expect(ok(ConfirmTargetSchema, target({ prepared_by: "offer", action: { kind: "lift.move", target_mm: 300 } }))).toBe(false);
    expect(ok(ConfirmTargetSchema, target({ prepared_by: "offer", action: { kind: "fault.clear" } }))).toBe(false);
    expect(ok(ConfirmTargetSchema, target({ prepared_by: "walker_local", action: { kind: "skill.run", skill_id: "tray_pick_handover" } }))).toBe(false);
    expect(ok(ConfirmTargetSchema, target({ prepared_by: "cloud" }))).toBe(false);
    expect(ok(MotionOfferRequestSchema, { target: { kind: "arm.go_to_pose", arm: "left", pose: "handover" } })).toBe(true);
    expect(ok(MotionOfferRequestSchema, { target: { kind: "skill.run", skill_id: "tray_pick_handover" }, title: "Do it now" })).toBe(false);
    expect(ok(MotionOfferRequestSchema, { target: { kind: "lift.home" } })).toBe(false);
    expect(ok(MotionOfferRequestSchema, { target: { kind: "skill.run", skill_id: "tray_pick_handover", speed: 2 } })).toBe(false);
  });

  it("take a press only after the button was seen released for the whole window, all after the target appeared", () => {
    const t = ConfirmTargetSchema.parse(target()) as ConfirmTarget;
    const ev = (pressed: number, released: number | null = SHOWN - 5000, reset: number | null = null) => ({
      pressed_mono_ms: pressed,
      released_since_mono_ms: released,
      module_reset_mono_ms: reset,
    });
    expect(confirmPressVerdict(t, ev(SHOWN + CONFIRM_ARM_DELAY_MS - 1))).toBe("ignore_too_early");
    expect(confirmPressVerdict(t, ev(SHOWN + CONFIRM_ARM_DELAY_MS))).toBe("accept");
    expect(confirmPressVerdict(t, ev(SHOWN + WALKER_CONFIRM_WAIT_MS - 1))).toBe("accept");
    expect(confirmPressVerdict(t, ev(SHOWN + WALKER_CONFIRM_WAIT_MS))).toBe("expired");
    expect(confirmPressVerdict({ ...t, state: "accepted" }, ev(PRESS))).toBe("expired");
    // An ignored press at SHOWN + 1000, released at SHOWN + 1200, restarts the window.
    expect(confirmPressVerdict(t, ev(SHOWN + 3000, SHOWN + 1200))).toBe("ignore_too_early");
    expect(confirmPressVerdict(t, ev(SHOWN + 3200, SHOWN + 1200))).toBe("accept");
    // The button was held down when the target appeared and let go just before.
    expect(confirmPressVerdict(t, ev(SHOWN + 2500, SHOWN + 1000))).toBe("ignore_too_early");
    // No release seen, or the module said hello or skipped a seq since the target appeared.
    expect(confirmPressVerdict(t, ev(PRESS, null))).toBe("ignore_untrusted");
    expect(confirmPressVerdict(t, ev(PRESS, SHOWN - 5000, SHOWN + 10))).toBe("ignore_untrusted");
    expect(confirmPressVerdict(t, ev(PRESS, SHOWN - 5000, SHOWN - 10))).toBe("accept");
  });

  it("can't be replaced in their first CONFIRM_ARM_DELAY_MS", () => {
    const t = ConfirmTargetSchema.parse(target()) as ConfirmTarget;
    expect(mayReplaceConfirmTarget(null, SHOWN)).toBe(true);
    expect(mayReplaceConfirmTarget(t, SHOWN + CONFIRM_ARM_DELAY_MS - 1)).toBe(false);
    expect(mayReplaceConfirmTarget(t, SHOWN + CONFIRM_ARM_DELAY_MS)).toBe(true);
    expect(mayReplaceConfirmTarget({ ...t, state: "accepted" }, SHOWN + 1)).toBe(true);
  });

  it("run only their own action, once, from a press in their window", () => {
    const t = ConfirmTargetSchema.parse(target()) as ConfirmTarget;
    const run = (over: Record<string, unknown> = {}) => MotionCommandSchema.parse({ ...commands["skill.run"], ...over }) as MotionCommand;
    expect(commandMatchesTarget(run(), t)).toBe("ok");
    expect(commandMatchesTarget(run({ skill_id: "something_else" }), t)).toBe("confirm_target_mismatch");
    expect(commandMatchesTarget(run({ target_id: UUID }), t)).toBe("confirm_target_mismatch");
    expect(commandMatchesTarget(run({ prepared_by: "walker_screen" }), t)).toBe("confirm_target_mismatch");
    expect(commandMatchesTarget(run(), { ...t, state: "accepted" })).toBe("confirm_target_expired");
    const pose = ConfirmTargetSchema.parse(target({ action: { kind: "arm.go_to_pose", arm: "left", pose: "handover" }, title: "Hold it out to you", prompt: confirmPrompt("Hold it out to you", true) })) as ConfirmTarget;
    const poseCommand = MotionCommandSchema.parse(commands["arm.go_to_pose"]) as MotionCommand;
    expect(commandMatchesTarget(poseCommand, pose)).toBe("ok");
    expect(commandMatchesTarget({ ...poseCommand, arm: "right" } as MotionCommand, pose)).toBe("confirm_target_mismatch");
    expect(commandMatchesTarget(run(), pose)).toBe("confirm_target_mismatch");
    expect(commandMatchesTarget(MotionCommandSchema.parse(commands["motion.stop"]) as MotionCommand, t)).toBe("confirm_target_mismatch");
  });
});

// ---- Commands and their policy ----

describe("motion commands", () => {
  it.each(Object.entries(commands))("parses %s", (_kind, command) => {
    expect(MotionCommandSchema.safeParse(command).error?.issues ?? []).toEqual([]);
  });

  it("covers every command kind", () => {
    expect(Object.keys(commands).sort()).toEqual([...MotionCommandKindSchema.options].sort());
    expect([...CONFIRMED_KINDS, ...STOP_COMMANDS].sort()).toEqual([...MotionCommandKindSchema.options].sort());
  });

  it("has no cloud, model or terminal start: nothing but a Confirm press starts a command", () => {
    for (const who of ["cloud", "model", "assistant", "page", "server", "owner_page"]) {
      expect(PreparerSchema.safeParse(who).success).toBe(false);
      expect(StopSourceSchema.safeParse(who).success).toBe(false);
    }
    for (const kind of CONFIRMED_KINDS) {
      const { confirm: _, ...unconfirmed } = commands[kind] as Record<string, unknown>;
      expect(ok(MotionCommandSchema, unconfirmed)).toBe(false);
      expect(ok(MotionCommandSchema, { ...unconfirmed, initiator: "operator_cli" })).toBe(false);
    }
  });

  it.each(CONFIRMED_KINDS.flatMap((kind) => PreparerSchema.options.map((by) => [kind, by] as const)))(
    "%s prepared by %s is allowed only when its policy says so",
    (kind, by) => {
      expect(ok(MotionCommandSchema, { ...commands[kind], prepared_by: by })).toBe(isPreparerAllowed(kind, by));
    },
  );

  it("takes the Confirm press only inside its window", () => {
    const at = (ms: number) => ({ ...commands["skill.run"], confirm: press(ms) });
    expect(ok(MotionCommandSchema, at(SHOWN + CONFIRM_ARM_DELAY_MS))).toBe(true);
    expect(ok(MotionCommandSchema, at(SHOWN + CONFIRM_ARM_DELAY_MS - 1))).toBe(false);
    expect(ok(MotionCommandSchema, at(SHOWN + WALKER_CONFIRM_WAIT_MS - 1))).toBe(true);
    expect(ok(MotionCommandSchema, at(SHOWN + WALKER_CONFIRM_WAIT_MS))).toBe(false);
    expect(ok(MotionCommandSchema, { ...commands["skill.run"], confirm: press(PRESS, "middle") })).toBe(false);
    expect(ok(MotionCommandSchema, { ...commands["skill.run"], confirm: press(PRESS, "left", PRESS - CONFIRM_ARM_DELAY_MS + 1) })).toBe(false);
    expect(ok(MotionCommandSchema, { ...commands["skill.run"], confirm: press(PRESS, "left", PRESS - CONFIRM_ARM_DELAY_MS) })).toBe(true);
  });

  it("lets anyone local stop, with nothing to confirm", () => {
    for (const kind of STOP_COMMANDS) {
      for (const by of StopSourceSchema.options) expect(ok(MotionCommandSchema, { ...commands[kind], stopped_by: by })).toBe(true);
      expect(ok(MotionCommandSchema, { ...commands[kind], confirm: press() })).toBe(false);
    }
  });

  it("refuses a parking command without the parked confirmation, and puts none on fault.clear", () => {
    for (const kind of CONFIRMED_KINDS.filter((k) => MOTION_COMMAND_POLICY[k].needs_park)) {
      const { base_parked: _, ...unparked } = commands[kind] as { base_parked: true };
      expect(ok(MotionCommandSchema, unparked)).toBe(false);
      expect(ok(MotionCommandSchema, { ...commands[kind], base_parked: false })).toBe(false);
    }
    expect(ok(MotionCommandSchema, { ...commands["fault.clear"], base_parked: true })).toBe(false);
  });

  it("refuses raw motion and bad targets", () => {
    expect(ok(MotionCommandSchema, { ...commands["skill.run"], joints: joints() })).toBe(false);
    expect(ok(MotionCommandSchema, { ...commands["arm.go_to_pose"], speed_deg_s: 500 })).toBe(false);
    expect(ok(MotionCommandSchema, { ...commands["lift.move"], target_mm: 1000.5 })).toBe(false);
    expect(ok(MotionCommandSchema, { ...commands["lift.move"], target_mm: -0.1 })).toBe(false);
    expect(ok(MotionCommandSchema, { ...commands["lift.move"], target_mm: 1000 })).toBe(true);
    expect(ok(MotionCommandSchema, { ...commands["arm.torque"], arms: ["left", "left"] })).toBe(false);
    expect(ok(MotionCommandSchema, { ...commands["gripper.release"], gripper_open_deg: 181 })).toBe(false);
    expect(
      ok(MotionCommandSchema, { ...commands["teleop.start"], pairs: [{ leader: "left", follower: "left" }, { leader: "right", follower: "left" }] }),
    ).toBe(false);
    expect(ok(MotionCommandSchema, { ...commands["motion.stop"], kind: "motion.resume" })).toBe(false);
  });
});

describe("command policy (AGENTS.md rule 8)", () => {
  const moving = MotionCommandKindSchema.options.filter((k) => MOTION_COMMAND_POLICY[k].moves);

  it("lets anyone local stop with no precondition, and nobody else prepare a stop", () => {
    for (const kind of STOP_COMMANDS) {
      const policy = MOTION_COMMAND_POLICY[kind];
      expect([...policy.stopped_by].sort()).toEqual([...StopSourceSchema.options].sort());
      expect(policy.prepared_by).toEqual([]);
      expect(policy.refuses_when).toEqual([]);
      expect(Object.values(policy.on_lost).every((r) => r === "continue")).toBe(true);
    }
    for (const kind of CONFIRMED_KINDS) {
      expect(MOTION_COMMAND_POLICY[kind].stopped_by).toEqual([]);
      expect(MOTION_COMMAND_POLICY[kind].prepared_by.length).toBeGreaterThan(0);
      expect(MOTION_COMMAND_POLICY[kind].refuses_when).toEqual(expect.arrayContaining(["confirm_busy", "confirm_target_expired", "confirm_target_mismatch"]));
    }
  });

  it("lets the cloud's offers name only taught skills and poses, and the Pi's own follow-up only let go", () => {
    const by = (who: "offer" | "walker_local") => CONFIRMED_KINDS.filter((k) => isPreparerAllowed(k, who)).sort();
    expect(by("offer")).toEqual(["arm.go_to_pose", "skill.run"]);
    expect(by("walker_local")).toEqual(["gripper.release"]);
  });

  it("refuses every moving command without a ready stop or a hand control, with a fault, while busy or on stale feedback", () => {
    for (const kind of moving) {
      expect(MOTION_COMMAND_POLICY[kind].refuses_when).toEqual(
        expect.arrayContaining(["stop_pressed", "no_hardware_stop", "fault_latched", "busy", "part_missing", "no_hand_control", "feedback_stale"]),
      );
      expect(MOTION_COMMAND_POLICY[kind].on_lost).toEqual({ cloud: "continue", servo_bus: "stop_hold", lift_module: "stop_hold", hand_controls: "stop_hold" });
      expect(MOTION_COMMAND_POLICY[kind].needs_park).toBe(true);
    }
  });

  it("makes every lift motion hold-to-run, guarded and with the arms stowed", () => {
    for (const kind of MotionCommandKindSchema.options) {
      expect(MOTION_COMMAND_POLICY[kind].hold_to_run).toBe(kind === "lift.home" || kind === "lift.move");
    }
    for (const kind of ["lift.home", "lift.move"] as const) {
      expect(MOTION_COMMAND_POLICY[kind].refuses_when).toEqual(expect.arrayContaining(["not_held", "lift_guards_missing", "lift_drop_test_missing", "arms_not_stowed"]));
    }
    expect(MOTION_COMMAND_POLICY["lift.move"].refuses_when).toContain("lift_not_homed");
    expect(MOTION_COMMAND_POLICY["skill.run"].refuses_when).toEqual(expect.arrayContaining(["lift_not_homed", "lift_not_at_height"]));
  });

  it("holds the lift only from the screen's hold control, which lets go on every kind of release", () => {
    expect([...HoldSourceSchema.options]).toEqual(["screen_hold_control"]);
    for (const event of ["pointerup", "pointercancel", "touchcancel", "blur", "visibilitychange"]) expect(SCREEN_HOLD_RELEASE_EVENTS).toContain(event);
  });

  it("offers only safe actions while a fault is latched", () => {
    expect(allowedWhileFaulted({ kind: "fault.clear" })).toBe(true);
    expect(allowedWhileFaulted({ kind: "lift.disable" })).toBe(true);
    expect(allowedWhileFaulted({ kind: "arm.torque", enabled: false })).toBe(true);
    expect(allowedWhileFaulted({ kind: "arm.torque", enabled: true })).toBe(false);
    expect(allowedWhileFaulted({ kind: "skill.run" })).toBe(false);
    expect(MOTION_COMMAND_POLICY["lift.disable"].refuses_when).not.toContain("fault_latched");
  });

  it("disables the lift driver only when it can't drop, and unhomes it", () => {
    expect(MOTION_COMMAND_POLICY["lift.disable"].refuses_when).toContain("lift_may_drop");
    expect(MOTION_COMMAND_POLICY["lift.disable"].ends_in).toContain("unhomed");
    const inst = LiftInstallationSchema.parse({ ...installation, drop_test: "failed" });
    expect(liftMayDisable(inst, false)).toBe(false);
    expect(liftMayDisable(inst, true)).toBe(true);
    expect(liftMayDisable({ ...inst, brake_fitted: true }, false)).toBe(true);
    expect(liftMayDisable({ ...inst, drop_test: "passed" }, false)).toBe(true);
  });

  it("lets go only of an active grasp", () => {
    expect(MOTION_COMMAND_POLICY["gripper.release"].refuses_when).toContain("no_grasp");
    expect(MOTION_COMMAND_POLICY["skill.run"].ends_in).toContain("HOLDING");
  });

  it("refuses only with known reasons, each with a sentence", () => {
    for (const kind of MotionCommandKindSchema.options) {
      for (const reason of MOTION_COMMAND_POLICY[kind].refuses_when) expect(MotionRefusalSchema.options).toContain(reason);
    }
    for (const reason of MotionRefusalSchema.options) expect(REFUSAL_SENTENCES[reason]).toMatch(/^[A-Z].{8,100}\.$/);
  });

  it("is written up command by command in the manipulation guide, under the one rule", () => {
    const guide = readFileSync(new URL("../../../docs/subsystems/manipulation.md", import.meta.url), "utf8");
    for (const kind of MotionCommandKindSchema.options) expect(guide).toContain(`\`${kind}\``);
    for (const code of MotionFaultCodeSchema.options) expect(guide).toContain(`\`${code}\``);
    expect(guide).toContain(PARK_PROMPT);
    expect(guide).toContain(BENCH_MODE_LABEL);
    expect(guide).toContain(`${MOTION_BENCH_ENV}=${MOTION_BENCH_ENV_VALUE}`);
    expect(guide).toContain(SCREEN_OS_USER);
    expect(guide).toContain("**Motors start only when a person at the walker acts, and the lift moves only while a person holds its control.**");
    const source = readFileSync(new URL("../src/motion.ts", import.meta.url), "utf8");
    expect(source).toContain("THE RULE: motors start only when a person at the walker acts, and the lift moves only while a person holds");
  });
});

// ---- Policy constants ----

describe("policy constants", () => {
  it("keep a lost Pi's last goal close and below the divergence threshold", () => {
    expect(MAX_GOAL_LEAD_DEG).toBeLessThan(FEEDBACK_DIVERGENCE_DEG);
    expect(MOTION_LIMITS.normal.arm_speed_deg_s.teleop / MOTION_CONTROL_HZ).toBeLessThanOrEqual(MAX_GOAL_STEP_DEG);
    expect(MAX_GOAL_STEP_DEG).toBeLessThanOrEqual(MAX_GOAL_LEAD_DEG);
  });

  it("let a few control periods pass before feedback is stale", () => {
    expect(FEEDBACK_STALE_MS).toBeGreaterThanOrEqual(3 * MOTION_CONTROL_PERIOD_MS);
  });

  it("make bench mode slower and weaker in every limit", () => {
    const { normal, bench } = MOTION_LIMITS;
    for (const key of ["replay", "teleop", "pose"] as const) expect(bench.arm_speed_deg_s[key]).toBeLessThan(normal.arm_speed_deg_s[key]);
    for (const key of ["arm_torque_pct", "gripper_torque_pct", "lift_speed_mm_s", "lift_accel_mm_s2"] as const) {
      expect(bench[key]).toBeLessThan(normal[key]);
    }
  });

  it("make a diverging arm softer than its normal limit, but not limp", () => {
    expect(ARM_COMPLIANT_TORQUE_PCT).toBeLessThan(MOTION_LIMITS.bench.arm_torque_pct);
    expect(ARM_COMPLIANT_TORQUE_PCT).toBeGreaterThan(10);
  });

  it("cap a recording teleop session at what a skill may replay, in speed and length", () => {
    expect(ARM_SPEED_CEILING_DEG_S).toBeLessThanOrEqual(MOTION_LIMITS.normal.arm_speed_deg_s.teleop);
    expect(MOTION_COMMAND_POLICY["teleop.start"].limits).toContain("ARM_SPEED_CEILING_DEG_S while recording");
    expect(MOTION_COMMAND_POLICY["teleop.start"].watchdog).toContain("SKILL_MAX_DURATION_MS while recording");
    expect(SKILL_MAX_DURATION_MS).toBe(60_000);
  });

  it("latch teleop only well beyond what the clamp absorbs", () => {
    expect(TELEOP_OVERSPEED_FACTOR).toBeGreaterThanOrEqual(2);
    expect(TELEOP_GAP_DEG).toBeGreaterThan(TELEOP_ENGAGE_TOLERANCE_DEG);
    expect(FAULT_REACTION.teleop_overspeed).toBe(FAULT_REACTION.teleop_gap);
  });

  it("let the lift miss one heartbeat but not three, and the Pi miss a status or two", () => {
    expect(LIFT_WATCHDOG_TIMEOUT_MS).toBeGreaterThan(2 * LIFT_HEARTBEAT_INTERVAL_MS);
    expect(LIFT_WATCHDOG_TIMEOUT_MS).toBeLessThanOrEqual(3 * LIFT_HEARTBEAT_INTERVAL_MS);
    expect(LIFT_STATUS_STALE_MS).toBeGreaterThan(2 * (1000 / LIFT_STATUS_HZ));
    expect(LIFT_HEARTBEAT_INTERVAL_MS % MOTION_CONTROL_PERIOD_MS).toBe(0);
  });

  it("renew the hold lease with every heartbeat, and hear the screen's hold control more often than the lease", () => {
    expect(LIFT_HOLD_LEASE_MS).toBe(LIFT_WATCHDOG_TIMEOUT_MS);
    expect(HOLD_CONTROL_REFRESH_MS).toBeLessThan(LIFT_HOLD_LEASE_MS);
  });

  it("home fast first, then slowly, with release checks, within its deadline", () => {
    expect(LIFT_HOMING_SLOW_MM_S).toBeLessThan(LIFT_HOMING_FAST_MM_S);
    expect(LIFT_HOMING_FAST_MM_S).toBeLessThanOrEqual(MOTION_LIMITS.normal.lift_speed_mm_s);
    expect(LIFT_HOMING_RELEASE_MARGIN_MM).toBe(3);
    const slowPhases = (3 * (LIFT_HOMING_BACKOFF_MM + LIFT_HOMING_RELEASE_MARGIN_MM)) / LIFT_HOMING_SLOW_MM_S;
    expect(LIFT_HOMING_TIMEOUT_MS).toBe(motionTimeoutMs((LIFT_HOMING_MAX_TRAVEL_MM / LIFT_HOMING_FAST_MM_S + slowPhases) * 1000));
    expect(motionTimeoutMs(0)).toBe(MOTION_TIMEOUT_MARGIN_MS);
    expect(motionTimeoutMs(10_000)).toBe(14_500);
  });

  it("hold the lift on a lost heartbeat, even after a passed drop test", () => {
    expect(LIFT_WATCHDOG_DRIVER_ACTION).toBe("hold");
  });

  it("give a person time to read a Confirm target before a press counts", () => {
    expect(CONFIRM_ARM_DELAY_MS).toBe(2000);
    expect(WALKER_CONFIRM_WAIT_MS).toBeGreaterThan(CONFIRM_ARM_DELAY_MS * 5);
  });

  it("engage teleop only from close by, and count a pose reached from closer still", () => {
    expect(AT_POSE_TOLERANCE_DEG).toBeLessThan(TELEOP_ENGAGE_TOLERANCE_DEG);
    expect(TELEOP_ENGAGE_TOLERANCE_DEG).toBeLessThanOrEqual(FEEDBACK_DIVERGENCE_DEG);
  });

  it("pin the words people see", () => {
    expect(PARK_PROMPT).toBe("Park the walker and lock the brakes, then press Confirm.");
    expect(BENCH_MODE_LABEL).toBe("Bench mode: no hardware stop");
    expect(SCREEN_OS_USER).toBe("sophi-screen");
  });

  it("keep the arms out of the manifest while demo beat 5 expects the no-arms line", () => {
    const script = readFileSync(new URL("../../../docs/demo/walker-script.md", import.meta.url), "utf8");
    const expectsNoArms = script.includes("This walker doesn't have robot arms, so I can't pick things up or move things.");
    expect(MANIFEST_MAY_LIST_ARMS).toBe(!expectsNoArms);
  });
});

// ---- Faults ----

describe("faults", () => {
  it("have one plain sentence each, all different, and a reaction", () => {
    const sentences = MotionFaultCodeSchema.options.map((code) => FAULT_SENTENCES[code]);
    expect(new Set(sentences).size).toBe(sentences.length);
    for (const sentence of sentences) expect(sentence).toMatch(/^[A-Z].{10,158}\.$/);
    for (const code of MotionFaultCodeSchema.options) expect(FaultReactionSchema.options).toContain(FAULT_REACTION[code]);
  });

  it("cover every fault the reviews named", () => {
    for (const code of [
      "limit_hit", "overload", "overtemperature", "undervoltage", "feedback_stale", "feedback_divergence", "watchdog_expired",
      "servo_bus_lost", "lift_module_lost", "stop_circuit_opened", "calibration_missing", "lift_unhomed", "skill_invalid",
      "hand_controls_lost", "motion_timeout", "teleop_overspeed", "teleop_gap",
    ]) {
      expect(MotionFaultCodeSchema.options).toContain(code);
    }
  });

  it("never write a goal from a stale reading, and go soft when pushed", () => {
    expect(FAULT_REACTION.feedback_stale).toBe("freeze");
    expect(FAULT_REACTION.servo_bus_lost).toBe("freeze");
    expect(FAULT_REACTION.feedback_divergence).toBe("comply");
    expect(FAULT_REACTION.stop_circuit_opened).toBe("release");
  });

  it("keep watching a held arm while ready", () => {
    for (const code of ["overtemperature", "feedback_divergence", "feedback_stale", "overload", "stop_circuit_opened"] as const) {
      expect(CHECKS_WHILE_HOLDING).toContain(code);
    }
  });

  it("unhome the lift after every lift fault and the stop", () => {
    for (const code of [...LiftSerialFaultSchema.options, "lift_module_lost", "lift_unhomed"] as const) {
      expect(FAULTS_THAT_UNHOME_LIFT).toContain(code);
    }
  });

  it("carry exactly their fixed sentence", () => {
    const fault = { code: "overtemperature", part: "arm_left", joint: "elbow_flex", raised_at: T, sentence: FAULT_SENTENCES.overtemperature };
    expect(ok(MotionFaultSchema, fault)).toBe(true);
    expect(ok(MotionFaultSchema, { ...fault, sentence: "All good, carry on." })).toBe(false);
    expect(ok(MotionFaultSchema, { ...fault, part: "lift" })).toBe(false);
    expect(ok(MotionFaultSchema, { ...fault, code: "cosmic_ray", sentence: "x" })).toBe(false);
  });
});

// ---- Motion state ----

const reading = { degrees: 0, temperature_c: 31, load_pct: 4.5, voltage_v: 12.1 };
const armState = (over: Record<string, unknown> = {}) => ({
  arm: "left",
  role: "follower",
  connected: true,
  calibrated: true,
  torque: "on",
  pose: { status: "at", name: "stowed" },
  joints: Object.fromEntries(ARM_JOINTS.map((j) => [j, reading])),
  grasp_active: false,
  faults: [],
  ...over,
});
const liftState = (over: Record<string, unknown> = {}) => ({
  connected: true,
  homed: true,
  position_mm: 5,
  target_mm: null,
  moving: false,
  driver_enabled: true,
  limits: { top: "released", bottom: "released" },
  faults: [],
  ...over,
});
const state = (over: Record<string, unknown> = {}) => ({
  version: 1,
  generated_at: T,
  mode: "ready",
  bench_mode: false,
  stop_circuit: "released",
  hand_controls_connected: true,
  arms: [armState()],
  lift: liftState(),
  active: null,
  confirm_target: null,
  last_command: null,
  faults: [],
  ...over,
});
const activeBase = { command_id: UUID, target_id: OFFER, started_at: T };
const skillActive = { ...activeBase, kind: "skill.run", skill_id: "tray_pick_handover", title: "Hand over the cup", progress: 0.4 };
const liftActive = { ...activeBase, kind: "lift.move", phase: "running", hold_source: "screen_hold_control", target_mm: 300 };
const teleopActive = { ...activeBase, kind: "teleop", pairs: [{ leader: "left", follower: "left" }], recording_skill_id: null };
const fault = { code: "stop_circuit_opened", part: "system", raised_at: T, sentence: FAULT_SENTENCES.stop_circuit_opened };
const disconnectedArm = armState({ connected: false, torque: "unknown", pose: { status: "unknown" }, joints: null });
const disconnectedLift = liftState({ connected: false, homed: false, position_mm: null, moving: null, driver_enabled: null, limits: { top: "unknown", bottom: "unknown" } });
const clearTarget = target({ action: { kind: "fault.clear" }, prepared_by: "walker_screen", title: "Clear the fault", prompt: confirmPrompt("Clear the fault", false) });

describe("motion state", () => {
  it.each([
    ["ready", state()],
    ["ready with a pending Confirm target", state({ confirm_target: target() })],
    ["holding an object after a handover, with the Let go? target", state({ arms: [armState({ grasp_active: true, pose: { status: "between" } })], confirm_target: target({ prepared_by: "walker_local", action: { kind: "gripper.release", arm: "left", gripper_open_deg: 40 }, title: "Let go?", prompt: confirmPrompt("Let go?", true) }) })],
    ["moving a skill", state({ mode: "moving", active: skillActive, arms: [armState({ pose: { status: "moving" } })] })],
    ["moving the lift while held", state({ mode: "moving", active: liftActive, lift: liftState({ moving: true, target_mm: 300 }) })],
    ["the lift ramping down after a release", state({ mode: "moving", active: { ...liftActive, phase: "stopping", hold_source: null }, lift: liftState({ moving: true, target_mm: 300 }) })],
    ["teleop", state({ mode: "teleop", active: teleopActive })],
    ["a bench walker moving with no hardware stop and no hand control", state({ mode: "moving", bench_mode: true, stop_circuit: "not_wired", hand_controls_connected: false, active: skillActive })],
    ["no hardware stop, so disabled", state({ mode: "disabled", stop_circuit: "not_wired" })],
    ["the stop pressed, latched", state({ mode: "fault", stop_circuit: "pressed", faults: [fault], arms: [disconnectedArm], lift: disconnectedLift })],
    ["a fault with its clear target pending", state({ mode: "fault", faults: [fault], lift: liftState({ homed: false, position_mm: null }), confirm_target: clearTarget })],
    ["a fault with a torque-off target pending", state({ mode: "fault", faults: [fault], lift: liftState({ homed: false, position_mm: null }), confirm_target: target({ prepared_by: "walker_screen", action: { kind: "arm.torque", arms: ["left"], enabled: false }, title: "Turn the arm off", prompt: confirmPrompt("Turn the arm off", true) }) })],
    ["a leader with torque off", state({ arms: [armState(), armState({ role: "leader", torque: "off", pose: { status: "between" } })] })],
    ["no lift fitted", state({ lift: null })],
    ["a refused command", state({ last_command: { command_id: UUID, kind: "lift.move", outcome: "refused", refusal: "not_held", at: T } })],
  ])("parses %s", (_why, value) => {
    expect(MotionStateSchema.safeParse(value).error?.issues ?? []).toEqual([]);
  });

  it.each([
    ["fault mode with no fault", state({ mode: "fault" })],
    ["a fault outside fault mode", state({ faults: [fault] })],
    ["moving with nothing active", state({ mode: "moving" })],
    ["something active while ready", state({ active: skillActive })],
    ["teleop reported as moving", state({ mode: "moving", active: teleopActive })],
    ["moving with no hardware stop outside bench mode", state({ mode: "moving", stop_circuit: "not_wired", active: skillActive })],
    ["ready with no hardware stop outside bench mode", state({ stop_circuit: "not_wired" })],
    ["the stop pressed without its fault, even disabled", state({ mode: "disabled", stop_circuit: "pressed" })],
    ["moving with the stop pressed, even in bench mode", state({ mode: "moving", bench_mode: true, stop_circuit: "pressed", active: skillActive })],
    ["moving with no hand control outside bench mode", state({ mode: "moving", hand_controls_connected: false, active: skillActive })],
    ["a lift running with nothing holding it", state({ mode: "moving", active: { ...liftActive, hold_source: null } })],
    ["a lift held from the terminal", state({ mode: "moving", active: { ...liftActive, hold_source: "terminal_key" } })],
    ["a lift held by a handle button", state({ mode: "moving", active: { ...liftActive, hold_source: "handle_button" } })],
    ["a Confirm target pending while disabled", state({ mode: "disabled", stop_circuit: "not_wired", confirm_target: target() })],
    ["a torque-on target during a fault", state({ mode: "fault", faults: [fault], lift: liftState({ homed: false, position_mm: null }), confirm_target: target({ prepared_by: "walker_screen", action: { kind: "arm.torque", arms: ["left"], enabled: true }, title: "Turn the arm on", prompt: confirmPrompt("Turn the arm on", true) }) })],
    ["a lift stopping that still names a hold", state({ mode: "moving", active: { ...liftActive, phase: "stopping" } })],
    ["a Confirm target pending while moving", state({ mode: "moving", active: skillActive, confirm_target: target() })],
    ["a motion target pending during a fault", state({ mode: "fault", faults: [fault], lift: liftState({ homed: false, position_mm: null }), confirm_target: target() })],
    ["an accepted target still shown as pending", state({ confirm_target: target({ state: "accepted" }) })],
    ["a skill past 100%", state({ mode: "moving", active: { ...skillActive, progress: 1.01 } })],
    ["a refused command with no reason", state({ last_command: { command_id: UUID, kind: "lift.move", outcome: "refused", at: T } })],
    ["a reason on a completed command", state({ last_command: { command_id: UUID, kind: "lift.move", outcome: "completed", refusal: "busy", at: T } })],
    ["the same arm twice", state({ arms: [armState(), armState()] })],
    ["an extra field", state({ speed_override: 2 })],
  ])("refuses %s", (_why, value) => {
    expect(MotionStateSchema.safeParse(value).success).toBe(false);
  });

  it("represents every lift phase", () => {
    const { target_mm: _, ...home } = liftActive;
    expect(ok(ActiveMotionSchema, { ...home, kind: "lift.home" })).toBe(true);
    expect(ok(ActiveMotionSchema, { ...liftActive, phase: "stopping", hold_source: null })).toBe(true);
  });

  it.each([
    ["a leader with torque on", armState({ role: "leader" })],
    ["a leader with a grasp", armState({ role: "leader", torque: "off", grasp_active: true })],
    ["a disconnected arm with readings", armState({ connected: false, torque: "unknown" })],
    ["a disconnected arm with torque on", armState({ connected: false, pose: { status: "unknown" }, joints: null })],
    ["readings with an unknown pose", armState({ pose: { status: "unknown" } })],
    ["a known pose with no readings", armState({ joints: null })],
    ["a temperature as a fraction", armState({ joints: Object.fromEntries(ARM_JOINTS.map((j) => [j, { ...reading, temperature_c: 31.5 }])) })],
    ["load past 100%", armState({ joints: Object.fromEntries(ARM_JOINTS.map((j) => [j, { ...reading, load_pct: 101 }])) })],
    ["the same fault twice", armState({ faults: ["overload", "overload"] })],
    ["no grasp flag", (() => {
      const { grasp_active: _, ...rest } = armState();
      return rest;
    })()],
  ])("refuses an arm with %s", (_why, value) => {
    expect(ArmStateSchema.safeParse(value).success).toBe(false);
  });

  it.each([
    ["a height while unhomed", liftState({ homed: false })],
    ["no height while homed", liftState({ position_mm: null })],
    ["a disconnected lift said to be still", liftState({ connected: false, homed: false, position_mm: null, driver_enabled: null, limits: { top: "unknown", bottom: "unknown" } })],
    ["a connected lift with unknown motion", liftState({ moving: null })],
    ["a target while still", liftState({ target_mm: 300 })],
    ["a height past the rail", liftState({ position_mm: 1000.1 })],
    ["a negative height", liftState({ position_mm: -1 })],
  ])("refuses a lift with %s", (_why, value) => {
    expect(LiftStateSchema.safeParse(value).success).toBe(false);
  });
});
