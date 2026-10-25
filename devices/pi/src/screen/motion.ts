import {
  MOTION_COMMAND_POLICY,
  type ActiveMotion,
  type ConfirmTarget,
  type LiftState,
  type MotionState,
  type ScreenContent,
  type ScreenHoldDirection,
} from "@walker/contracts";

/**
 * The motion coordinator's state (the `motionState` bus event, motion.ts's MotionStateSchema) as walker screen
 * states. Pure: the screen machine keeps the inputs and decides the priority (machine.ts, `pickScreen`). The
 * coordinator decides everything here; this only picks what to show and words what the Pi says itself.
 */

/** The latest motion state and when it arrived (the Pi's monotonic clock). */
export interface ScreenMotion {
  state: MotionState;
  atMono: number;
  /** The way each lift target goes, fixed when it was first seen, so the hold control's words never change under her finger. */
  directions: ReadonlyMap<string, ScreenHoldDirection>;
}

/** "Done", "Stopped" or "Not started" after a motion, for SCREEN_DONE_MS. */
export type MotionHolding = Extract<ScreenContent, { state: "motion_holding" }>;

/**
 * Which way a lift action goes, from where the lift is now. `home` goes down to the bottom switch first, and
 * a move whose start height isn't known is just "move": the words never claim a direction the Pi can't see.
 */
export function liftDirection(action: { kind: string; target_mm?: number }, lift: LiftState | null): ScreenHoldDirection {
  if (action.kind === "lift.home") return "home";
  const at = lift?.position_mm ?? null;
  if (action.target_mm === undefined || at === null || action.target_mm === at) return "move";
  return action.target_mm > at ? "raise" : "lower";
}

const ARM_WORD = { left: "left", right: "right" } as const;

/** The Pi's words for what is moving. Skill titles come from the Pi's own skill files. */
export function movingWords(active: ActiveMotion, direction: ScreenHoldDirection): string {
  switch (active.kind) {
    case "lift.home":
      return "Homing the lift";
    case "lift.move":
      return direction === "raise" ? "Raising the lift" : direction === "lower" ? "Lowering the lift" : "Moving the lift";
    case "arm.go_to_pose":
      return `Moving the ${ARM_WORD[active.arm]} arm`;
    case "skill.run":
      return active.title;
    case "gripper.release":
      return "Letting go";
    case "teleop":
      return active.recording_skill_id ? "Recording a movement" : "Teaching mode";
  }
}

function targetView(target: ConfirmTarget) {
  return { target_id: target.target_id, title: target.title, prompt: target.prompt };
}

/** The remembered way for this target, or the way it goes from here. */
function directionOf(motion: ScreenMotion, targetId: string, action: { kind: string; target_mm?: number }): ScreenHoldDirection {
  return motion.directions.get(targetId) ?? liftDirection(action, motion.state.lift);
}

/**
 * The motion screens this state calls for, by priority layer:
 * - `safety`: a latched fault (with a pending target that clears it, if any), or a running motion;
 * - `pending`: the one pending Confirm target while ready.
 */
export function motionContent(motion: ScreenMotion): { safety: ScreenContent | null; pending: ScreenContent | null } {
  const s = motion.state;
  // Letting go may run with a fault latched (letting go is always possible): while it runs, the screen says what
  // moves ("Letting go") and how to stop it, as for any motion; the fault shows again once it ends.
  if (s.active?.kind === "gripper.release") {
    return { safety: { state: "motion_running", what: movingWords(s.active, "move"), lift: null }, pending: null };
  }
  if (s.mode === "fault" && s.faults.length > 0) {
    const faults = [...new Set(s.faults.map((f) => f.code))];
    return { safety: { state: "motion_fault", faults, confirm: s.confirm_target ? targetView(s.confirm_target) : null }, pending: null };
  }
  if (s.active) {
    if ((s.active.kind === "lift.move" || s.active.kind === "lift.home") && s.active.initiated_by === "talk")
      return { safety: null, pending: null };
    const lift = s.active.kind === "lift.home" || s.active.kind === "lift.move" ? s.active : null;
    const direction = lift ? directionOf(motion, s.active.target_id, lift) : "move";
    return {
      safety: {
        state: "motion_running",
        what: movingWords(s.active, direction),
        lift: lift ? { phase: lift.phase, direction } : null,
      },
      pending: null,
    };
  }
  if (s.mode === "ready" && s.confirm_target) {
    const target = s.confirm_target;
    const hold = MOTION_COMMAND_POLICY[target.action.kind].hold_to_run ? directionOf(motion, target.target_id, target.action) : null;
    return { safety: null, pending: { state: "motion_confirm", target: targetView(target), hold } };
  }
  return { safety: null, pending: null };
}

/**
 * What ended between two states, if anything worth a few seconds on screen:
 * - the motion that was running is gone, and the coordinator's last command is that motion, completed or
 *   stopped (a fault shows itself instead);
 * - or the pending target is gone and the last command is a refusal of that kind, new since (the press
 *   answered it and it didn't start: "Not started", with the coordinator's reason).
 * Matched on the command's id and the target's kind, never guessed: anything else shows nothing.
 */
export function endedBetween(prev: MotionState | null, next: MotionState): MotionHolding | null {
  if (!prev || next.mode === "fault") return null;
  const last = next.last_command;
  if (!last || last.command_id === prev.last_command?.command_id) return null;
  if (prev.active && next.active?.command_id !== prev.active.command_id) {
    if ((prev.active.kind === "lift.move" || prev.active.kind === "lift.home") && prev.active.initiated_by === "talk") return null;
    if (last.command_id !== prev.active.command_id) return null;
    if (last.outcome === "completed") return { state: "motion_holding", outcome: "completed", refusal: null };
    // A stop returns to the clock, route, or conversation already underneath motion.
    if (last.outcome === "stopped") return null;
    return null;
  }
  const target = prev.confirm_target;
  if (target && next.confirm_target?.target_id !== target.target_id && last.outcome === "refused" && last.refusal && last.kind === target.action.kind) {
    return { state: "motion_holding", outcome: "not_started", refusal: last.refusal };
  }
  return null;
}
