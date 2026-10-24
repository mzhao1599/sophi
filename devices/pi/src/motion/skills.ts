import {
  ARM_JOINTS,
  MOTION_CONTRACT_VERSION,
  SKILL_MAX_DURATION_MS,
  SKILL_MAX_WAYPOINT_GAP_MS,
  SKILL_MIN_WAYPOINT_GAP_MS,
  type ArmCalibration,
  type ArmJoint,
  type ArmJoints,
  type ArmSide,
  type Skill,
} from "@walker/contracts";
import { commandRange, largestGap } from "./limits";

/**
 * The arithmetic of taught skills (recording and replay), kept pure so each rule is tested on its own. Angles
 * are degrees from a joint's calibrated zero, times milliseconds. Every number here not imported from the
 * contract is a placeholder, not measured.
 */

/**
 * Placeholder, not measured: the start tolerance a recorded skill gets (the contract allows up to 10°). Teach
 * and replay from the same named pose: a pose counts as reached within 3° (AT_POSE_TOLERANCE_DEG), so two
 * arrivals at it can differ by about 6°.
 */
export const SKILL_RECORD_START_TOLERANCE_DEG = 8;

/** One recorded sample: milliseconds since the recording started, and the follower's angles then. */
export interface RecordedSample {
  t: number;
  joints: ArmJoints;
}

export interface RecordedEvent {
  t: number;
  kind: "grasp" | "release";
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Each sample's angles rounded to 0.01° and clamped into the follower's commandable range (its calibrated
 * range less 2°, as teleop's goals are), with the range's own ends rounded toward its inside, so a clamped
 * value never rounds out past the end checkSkillAgainstSetup checks. A clamp never makes a move faster.
 */
export function clampSamples(samples: readonly RecordedSample[], calibration: ArmCalibration): RecordedSample[] {
  return samples.map((s) => {
    const joints = {} as ArmJoints;
    for (const joint of ARM_JOINTS) {
      const range = commandRange(calibration, joint);
      const lo = Math.ceil(range.min * 100) / 100;
      const hi = Math.floor(range.max * 100) / 100;
      joints[joint] = Math.min(hi, Math.max(lo, round2(s.joints[joint])));
    }
    return { t: s.t, joints };
  });
}

/**
 * New times for the samples so no joint moves faster than `speedDegS` between two of them: a gap is kept, or
 * lengthened just enough (whole milliseconds), never shortened, and never under SKILL_MIN_WAYPOINT_GAP_MS. The
 * path stays the same; only a stretch that ran over the limit (a servo overshooting its goal, reading noise)
 * becomes slower. Fails when a gap would pass SKILL_MAX_WAYPOINT_GAP_MS or the end SKILL_MAX_DURATION_MS.
 */
export function retime(samples: readonly RecordedSample[], speedDegS: number): { ok: true; times: number[] } | { ok: false; error: string } {
  const times: number[] = [0];
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1]!;
    const next = samples[i]!;
    const moved = largestGap(prev.joints, next.joints).deg;
    const needed = Math.ceil((moved / speedDegS) * 1000);
    const gap = Math.max(next.t - prev.t, needed, SKILL_MIN_WAYPOINT_GAP_MS);
    if (gap > SKILL_MAX_WAYPOINT_GAP_MS) return { ok: false, error: `two samples are ${gap} ms apart (at most ${SKILL_MAX_WAYPOINT_GAP_MS})` };
    times.push(times[i - 1]! + gap);
  }
  const end = times.at(-1)!;
  if (end > SKILL_MAX_DURATION_MS) return { ok: false, error: `it lasts ${end} ms once its fastest parts are slowed to ${speedDegS}°/s (at most ${SKILL_MAX_DURATION_MS})` };
  return { ok: true, times };
}

/** An event's time moved with the samples around it: the same offset after the sample before it, within that gap. */
export function retimeEvent(t: number, samples: readonly RecordedSample[], times: readonly number[]): number {
  let i = 0;
  while (i + 1 < samples.length && samples[i + 1]!.t <= t) i += 1;
  const after = i + 1 < samples.length ? times[i + 1]! - times[i]! : 0;
  return Math.min(times.at(-1)!, times[i]! + Math.min(Math.max(0, t - samples[i]!.t), after));
}

/** Which arms a recording ends grasping: its last event for that arm was a grasp. */
export function endsGrasping(events: readonly RecordedEvent[]): boolean {
  return events.at(-1)?.kind === "grasp";
}

/**
 * The skill file for one arm's recording, before the contract's checks (the caller runs SkillSchema and
 * checkSkillAgainstSetup). `letGoDeg` must be given when it ends grasping.
 */
export function recordedSkill(input: {
  skillId: string;
  title: string;
  arm: ArmSide;
  createdAt: string;
  samples: readonly RecordedSample[];
  events: readonly RecordedEvent[];
  calibration: ArmCalibration;
  speedDegS: number;
  letGoDeg: number | null;
  /** The lift height it was taught at (the lift can't move while recording), or null on a walker without a lift. */
  liftMm?: number | null;
}): { ok: true; skill: Skill } | { ok: false; error: string } {
  if (input.samples.length < 2) return { ok: false, error: "it is too short: nothing was recorded" };
  const samples = clampSamples(input.samples, input.calibration);
  const retimed = retime(samples, input.speedDegS);
  if (!retimed.ok) return retimed;
  const { times } = retimed;
  const holding = endsGrasping(input.events);
  if (holding && input.letGoDeg === null) return { ok: false, error: "it ends holding: say where its gripper lets go" };
  const speed = Object.fromEntries(ARM_JOINTS.map((j) => [j, input.speedDegS])) as Record<ArmJoint, number>;
  const skill: Skill = {
    format: "sophi.skill",
    version: MOTION_CONTRACT_VERSION,
    skill_id: input.skillId,
    title: input.title,
    source: "recorded",
    created_at: input.createdAt,
    arms: [input.arm],
    start: { joints: { [input.arm]: { ...samples[0]!.joints } }, tolerance_deg: SKILL_RECORD_START_TOLERANCE_DEG },
    max_speed_deg_s: speed,
    waypoints: samples.map((s, i) => ({ t_ms: times[i]!, joints: { [input.arm]: s.joints } })),
    gripper_events: input.events.map((e) => ({ t_ms: retimeEvent(e.t, samples, times), arm: input.arm, kind: e.kind })),
    let_go: holding ? [{ arm: input.arm, gripper_open_deg: round2(input.letGoDeg!) }] : [],
    lift_mm: input.liftMm ?? null,
  };
  return { ok: true, skill };
}

// ---- Replay ----

/**
 * How much slower than taught a skill replays: 1, unless one of its joints may move faster than the mode's
 * replay limit (bench mode), when its whole timeline is stretched so that joint fits (the contract's).
 */
export function replayStretch(skill: Pick<Skill, "max_speed_deg_s">, replayDegS: number): number {
  return Math.max(1, ...ARM_JOINTS.map((j) => skill.max_speed_deg_s[j] / replayDegS));
}

/** Each joint's per-step speed cap on replay: its own max_speed_deg_s, never over the mode's replay limit. */
export function replayCaps(skill: Pick<Skill, "max_speed_deg_s">, replayDegS: number): Record<ArmJoint, number> {
  return Object.fromEntries(ARM_JOINTS.map((j) => [j, Math.min(skill.max_speed_deg_s[j], replayDegS)])) as Record<ArmJoint, number>;
}

/**
 * Where one arm's waypoints say it is at `t` (ms of the skill's own timeline), interpolated in a straight
 * line between the two around it; the last waypoint from its time on. `from` is a hint: the index to search
 * from (time only moves forward). Returns the angles and the index of the waypoint at or before `t`.
 */
export function skillPoint(skill: Pick<Skill, "waypoints">, arm: ArmSide, t: number, from = 0): { joints: ArmJoints; index: number } {
  const wps = skill.waypoints;
  let i = Math.max(0, Math.min(from, wps.length - 1));
  while (i > 0 && wps[i]!.t_ms > t) i -= 1;
  while (i + 1 < wps.length && wps[i + 1]!.t_ms <= t) i += 1;
  const a = wps[i]!.joints[arm]!;
  const next = wps[i + 1];
  if (!next || t <= wps[i]!.t_ms) return { joints: { ...a }, index: i };
  const b = next.joints[arm]!;
  const f = (t - wps[i]!.t_ms) / (next.t_ms - wps[i]!.t_ms);
  const joints = {} as ArmJoints;
  for (const joint of ARM_JOINTS) joints[joint] = a[joint] + (b[joint] - a[joint]) * f;
  return { joints, index: i };
}

/** How far an arm is from the skill's start pose, at its worst joint. */
export function startGap(skill: Pick<Skill, "start">, arm: ArmSide, measured: ArmJoints): { joint: ArmJoint; deg: number } {
  return largestGap(skill.start.joints[arm]!, measured);
}
