import type { Keypoint, Pose } from "./pose";

/**
 * Deciding from body points alone whether she has fallen (docs: devices/pi/README.md, "Fall check").
 *
 * The camera is on the walker, facing her. In plain words, a fall looks like this from there:
 * 1. **A fast drop.** Her shoulders and hips move down the picture quickly (sitting down is slow).
 * 2. **Then down.** Within a moment she is lying (her shoulder-to-hip line is closer to flat than upright), or
 *    low in the picture, or gone out of the bottom of it.
 * 3. **And staying down.** That lasts FALL_CONFIRM_MS without her coming back upright (a stumble she catches is
 *    not a fall).
 * A second path catches a slow slump: lying in view for LYING_CONFIRM_MS with no fast drop first.
 *
 * After a fall is reported, nothing more is reported until she has been seen upright for REARM_MS. Every number
 * below is a placeholder, not measured: tune them with recordings of the real mounting before trusting them.
 * This is a prompt to ask her caretakers, never a safety claim: falls it misses are possible, and so are false
 * alarms, which is why the walker counts down first and any handle press stops it.
 */

/** Placeholder: a point counts only at or above this model confidence. */
export const MIN_SCORE = 0.3;
/** Placeholder: how far back the drop is measured. */
export const DROP_WINDOW_MS = 1_000;
/** Placeholder: the body's centre must drop at least this much of the frame's height... */
export const DROP_MIN = 0.2;
/** Placeholder: ...at least this fast (frame heights a second). Sitting down is expected to be slower; not measured. */
export const DROP_SPEED = 0.6;
/** Placeholder: shoulder-to-hip line this far from upright (degrees) counts as lying. */
export const LYING_DEG = 60;
/** Placeholder: shoulder-to-hip line within this of upright (degrees) counts as upright. */
export const UPRIGHT_DEG = 30;
/** Placeholder: the body's centre this low in the frame (0 top, 1 bottom) counts as down. */
export const LOW_Y = 0.8;
/** Placeholder: after the drop, being down or out of view this long confirms the fall. */
export const FALL_CONFIRM_MS = 2_500;
/** Placeholder: lying in view this long, without a drop, is also a fall. */
export const LYING_CONFIRM_MS = 6_000;
/** Placeholder: after a report, upright this long before another fall can be reported. */
export const REARM_MS = 5_000;
/** Placeholder: a person seen this recently, then lost, counts as having just left the picture. */
export const LOST_GRACE_MS = 800;
/** Placeholder: back upright and within this of where her centre was before the drop cancels a suspected fall. */
export const RECOVER_MARGIN = 0.1;

export type FallWhy = "dropped_and_down" | "dropped_out_of_view" | "lying";

export interface FallEvent {
  why: FallWhy;
  /** The monotonic time the fall was confirmed. */
  at: number;
  /** When the drop (or the lying) began. */
  since: number;
}

/** What one frame says, in the few numbers the decision needs. */
export interface Posture {
  /** A body was found: both a shoulder and a hip, or at least five points. */
  present: boolean;
  /** Where the body's centre is, as a fraction of the frame's height (0 top, 1 bottom); null without a body. */
  centerY: number | null;
  /** The shoulder-to-hip line's angle from upright, in degrees (0 upright, 90 flat); null without both ends. */
  tiltDeg: number | null;
}

const SHOULDERS = [5, 6];
const HIPS = [11, 12];

function mean(points: Keypoint[], axis: "x" | "y"): number {
  return points.reduce((sum, p) => sum + p[axis], 0) / points.length;
}

/** `aspect` is the camera frame's width over its height (4:3 for the C270's 640 x 480), so the tilt is in true angles. */
export function postureOf(pose: Pose | null, aspect = 4 / 3): Posture {
  if (!pose) return { present: false, centerY: null, tiltDeg: null };
  const sure = (i: number) => (pose[i] && pose[i]!.score >= MIN_SCORE ? pose[i]! : null);
  const shoulders = SHOULDERS.map(sure).filter((p): p is Keypoint => p !== null);
  const hips = HIPS.map(sure).filter((p): p is Keypoint => p !== null);
  const all = pose.filter((p) => p.score >= MIN_SCORE);
  const present = (shoulders.length > 0 && hips.length > 0) || all.length >= 5;
  if (!present) return { present: false, centerY: null, tiltDeg: null };
  const torso = [...shoulders, ...hips];
  const centerY = mean(torso.length >= 2 ? torso : all, "y");
  let tiltDeg: number | null = null;
  if (shoulders.length && hips.length) {
    const dx = mean(shoulders, "x") - mean(hips, "x");
    const dy = mean(shoulders, "y") - mean(hips, "y");
    // The frame isn't square: compare in the same units (a 4:3 frame's x fraction is wider than its y fraction).
    tiltDeg = (Math.atan2(Math.abs(dx) * aspect, Math.abs(dy)) * 180) / Math.PI;
  }
  return { present, centerY, tiltDeg };
}

interface Sample extends Posture {
  at: number;
}

type State =
  | { kind: "watching" }
  /** A fast drop was seen at `since`, from a centre of `fromY`; waiting to see whether she stays down. */
  | { kind: "suspect"; since: number; fromY: number; downSince: number | null; outOfView: boolean }
  /** A fall was reported; waiting for her to be upright for REARM_MS. */
  | { kind: "reported"; uprightSince: number | null };

/**
 * Feed it one posture per analysed frame, in time order; it returns a FallEvent on the frame that confirms one.
 * It keeps only the last DROP_WINDOW_MS of samples. Pure: no clock, no I/O.
 */
export class FallDetector {
  private samples: Sample[] = [];
  private state: State = { kind: "watching" };
  private lyingSince: number | null = null;
  private lastSeen: Sample | null = null;

  constructor(private readonly options: { aspect?: number } = {}) {}

  /** `pose` is null when the model found nobody (or the frame couldn't be analysed). */
  push(pose: Pose | null, at: number): FallEvent | null {
    return this.pushPosture(postureOf(pose, this.options.aspect), at);
  }

  pushPosture(posture: Posture, at: number): FallEvent | null {
    const sample: Sample = { ...posture, at };
    this.samples = this.samples.filter((s) => at - s.at <= DROP_WINDOW_MS);
    this.samples.push(sample);
    if (posture.present) this.lastSeen = sample;

    const lying = posture.present && posture.tiltDeg !== null && posture.tiltDeg >= LYING_DEG;
    const upright = posture.present && posture.tiltDeg !== null && posture.tiltDeg <= UPRIGHT_DEG;
    const low = posture.present && posture.centerY !== null && posture.centerY >= LOW_Y;
    this.lyingSince = lying ? (this.lyingSince ?? at) : null;

    const state = this.state;
    if (state.kind === "reported") {
      if (!upright) state.uprightSince = null;
      else if (state.uprightSince === null) state.uprightSince = at;
      else if (at - state.uprightSince >= REARM_MS) this.reset();
      return null;
    }

    if (state.kind === "watching") {
      const drop = this.drop(at);
      if (drop) this.state = { kind: "suspect", since: drop.since, fromY: drop.fromY, downSince: null, outOfView: false };
      else if (this.lyingSince !== null && at - this.lyingSince >= LYING_CONFIRM_MS) return this.report("lying", at, this.lyingSince);
      else return null;
    }

    const suspect = this.state as Extract<State, { kind: "suspect" }>;
    const gone = !posture.present;
    if (upright && posture.centerY !== null && posture.centerY <= suspect.fromY + RECOVER_MARGIN) {
      // She caught herself: back upright, about where she was.
      this.state = { kind: "watching" };
      return null;
    }
    if (lying || low || gone) {
      suspect.downSince ??= at;
      if (gone) suspect.outOfView = true;
      else if (lying || low) suspect.outOfView = false;
    } else suspect.downSince = null;
    if (suspect.downSince !== null && at - suspect.downSince >= FALL_CONFIRM_MS) {
      return this.report(suspect.outOfView ? "dropped_out_of_view" : "dropped_and_down", at, suspect.since);
    }
    if (suspect.downSince === null && at - suspect.since > DROP_WINDOW_MS + FALL_CONFIRM_MS) {
      // Dropped, but neither down nor gone since: not a fall (sitting quickly onto a seat, a crouch).
      this.state = { kind: "watching" };
    }
    return null;
  }

  /** Forget everything: after a report has re-armed, or when the camera restarts. */
  reset(): void {
    this.samples = [];
    this.state = { kind: "watching" };
    this.lyingSince = null;
    this.lastSeen = null;
  }

  /** True while a fall has been reported and she hasn't been upright for REARM_MS since. */
  reported(): boolean {
    return this.state.kind === "reported";
  }

  private report(why: FallWhy, at: number, since: number): FallEvent {
    this.state = { kind: "reported", uprightSince: null };
    this.lyingSince = null;
    return { why, at, since };
  }

  /**
   * A fast drop of the body's centre within the window, ending now; or, when she has just left the picture, a
   * fast drop up to the last frame she was in, ending low. Returns where it started.
   */
  private drop(at: number): { since: number; fromY: number } | null {
    const seen = this.samples.filter((s) => s.present && s.centerY !== null);
    const now = this.samples.at(-1)!;
    let end: Sample | null = null;
    if (now.present && now.centerY !== null) end = now;
    else if (this.lastSeen && at - this.lastSeen.at <= LOST_GRACE_MS) end = this.lastSeen;
    if (!end || end.centerY === null) return null;
    const leftView = end !== now;
    let best: { since: number; fromY: number } | null = null;
    for (const s of seen) {
      if (s.at >= end.at) break;
      const fall = end.centerY - s.centerY!;
      const speed = fall / ((end.at - s.at) / 1000);
      // Leaving the picture through the bottom: a smaller drop counts, since the rest of it happened out of view.
      const enough = leftView ? fall >= DROP_MIN / 2 && end.centerY >= LOW_Y - 0.2 : fall >= DROP_MIN;
      if (enough && speed >= DROP_SPEED && (!best || s.centerY! < best.fromY)) best = { since: s.at, fromY: s.centerY! };
    }
    return best;
  }
}
