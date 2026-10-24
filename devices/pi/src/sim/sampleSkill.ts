import { ARM_JOINTS, MOTION_CONTRACT_VERSION, type ArmJoints, type Skill } from "@walker/contracts";

/**
 * A SIMULATED sample skill for `walker simulate --arms` and the tests ONLY. Made up here, never recorded on a
 * real arm, and written only into a simulator's state folder: it is not a taught skill and must never be put
 * on a walker. Its id and title say so, and it isn't named `tray_pick_handover` (the real first skill, taught
 * on the bench: devices/pi/README.md, "Teach the tray task").
 *
 * The left arm, from the simulator's made-up `ready` pose: down to a made-up tray, a grasp just before the
 * gripper closes, then out to the made-up `handover` pose, ending holding. Every joint stays under 30°/s, so
 * it replays unstretched in bench mode too.
 */
export const SIM_SAMPLE_SKILL_ID = "sim_sample_handover";

const READY: ArmJoints = { shoulder_pan: 0, shoulder_lift: -20, elbow_flex: 30, wrist_flex: 10, wrist_roll: 0, gripper: 20 };
const TRAY: ArmJoints = { shoulder_pan: -15, shoulder_lift: -5, elbow_flex: 15, wrist_flex: 10, wrist_roll: 0, gripper: 20 };
const CLOSED: ArmJoints = { ...TRAY, gripper: 4 };
const HANDOVER: ArmJoints = { shoulder_pan: 20, shoulder_lift: 30, elbow_flex: -20, wrist_flex: 0, wrist_roll: 0, gripper: 4 };
/** Keyframes (ms, angles); waypoints between them ease in and out every 20 ms. */
const KEYS: Array<[number, ArmJoints]> = [
  [0, READY],
  [1500, TRAY],
  [2500, CLOSED],
  [4500, HANDOVER],
];
const GRASP_AT_MS = 1600;
const STEP_MS = 20;

/**
 * `liftMm`: the made-up tray height when the simulator has a lift (a skill names its lift height exactly when the
 * walker has a lift: the contract's checkSkillAgainstSetup), else null.
 */
export function simSampleSkill(createdAt: string, liftMm: number | null = null): Skill {
  const waypoints: Skill["waypoints"] = [];
  for (let k = 0; k + 1 < KEYS.length; k += 1) {
    const [t0, a] = KEYS[k]!;
    const [t1, b] = KEYS[k + 1]!;
    for (let t = t0; t < t1 || (k + 2 === KEYS.length && t === t1); t += STEP_MS) {
      const f = (1 - Math.cos((Math.PI * (t - t0)) / (t1 - t0))) / 2;
      const joints = {} as ArmJoints;
      for (const joint of ARM_JOINTS) joints[joint] = Math.round((a[joint] + (b[joint] - a[joint]) * f) * 100) / 100;
      waypoints.push({ t_ms: t, joints: { left: joints } });
    }
  }
  return {
    format: "sophi.skill",
    version: MOTION_CONTRACT_VERSION,
    skill_id: SIM_SAMPLE_SKILL_ID,
    title: "SIMULATED sample: hold it out",
    source: "authored",
    created_at: createdAt,
    arms: ["left"],
    start: { joints: { left: { ...READY } }, tolerance_deg: 5 },
    max_speed_deg_s: Object.fromEntries(ARM_JOINTS.map((j) => [j, 30])) as Skill["max_speed_deg_s"],
    waypoints,
    gripper_events: [{ t_ms: GRASP_AT_MS, arm: "left", kind: "grasp" }],
    let_go: [{ arm: "left", gripper_open_deg: 30 }],
    lift_mm: liftMm,
  };
}
