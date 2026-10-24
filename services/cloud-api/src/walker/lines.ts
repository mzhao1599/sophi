import type { CapabilityManifest, Cue, CuesProblem, WalkerStatusView } from "@walker/contracts";

/**
 * The lines the server writes itself, each built from structured fields (the configuration, the
 * manifest, a proposal's payload), never from the model's words or hers. Every one is short enough to
 * be spoken.
 */

/** How each cue is said to the person. */
export const CUE_WORDS: Record<Cue, string> = {
  vibration: "buzzing",
  sound: "short sounds",
  spoken: "speech",
  screen: "the screen",
};

export function spokenList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

const cueList = (cues: readonly Cue[]) => spokenList(cues.map((cue) => CUE_WORDS[cue]));

/** A proposal's summary, from its payload: what goes, what comes. */
export function cuesSummary(from: readonly Cue[], to: readonly Cue[]): string {
  const removed = from.filter((cue) => !to.includes(cue));
  const added = to.filter((cue) => !from.includes(cue));
  if (removed.length > 0 && added.length > 0) return `Switch your alerts from ${cueList(removed)} to ${cueList(added)}.`;
  if (added.length > 0) return `Add ${cueList(added)} to your alerts.`;
  return `Stop using ${cueList(removed)} for your alerts.`;
}

export const PRESS_CONFIRM = "Press Confirm to do it.";
export const SIMULATED_READINGS = "These readings are simulated.";
export const SIMULATED_PARTS = "Some of this walker's parts are simulated.";
export const SIMULATED_ALL_PARTS = "All of this walker's parts are simulated.";

/**
 * How old an obstacle reading is, worded the way it's said aloud, for the model to repeat: "just now" under
 * a second, then whole seconds ("3 seconds ago"). The model never sees milliseconds, which it once read out
 * ("…from 44 milliseconds ago", rehearsal 2026-10-24). null when there's no age to say.
 */
export function readingAge(ageMs: number | null | undefined): string | null {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return null;
  if (ageMs < 1_000) return "just now";
  const seconds = Math.floor(ageMs / 1_000);
  return seconds === 1 ? "1 second ago" : `${seconds} seconds ago`;
}

/** What the person hears when a proposal opens: the change itself, from the payload ("I can switch your alerts…"). */
export function offerLine(summary: string): string {
  return `I can ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`;
}

/** Added when a turn arrives while an earlier proposal is still open. */
export function stillWaiting(summary: string): string {
  return `Still waiting for you: ${summary.charAt(0).toLowerCase()}${summary.slice(1)} ${PRESS_CONFIRM}`;
}

/** Why a suggested cues change was dropped, in place of the model's reply. */
export function cuesRefused(problem: CuesProblem, current: readonly Cue[]): string {
  switch (problem) {
    case "unchanged":
      return `Your alerts already use ${cueList(current)}.`;
    case "alerts_off":
      return "While the obstacle sensors are on, your alerts keep buzzing or short sounds, so I'll leave them as they are.";
    case "undeliverable":
      return "This walker has no part that can give that alert, so I'll leave your alerts as they are.";
    default:
      return "I couldn't make that change, so I'll leave your alerts as they are.";
  }
}

export const OFFLINE_NO_CHANGE = "Your walker is offline, so I can't change its alerts right now. Ask again when it's back online.";

/** Robot arms: no action request exists in this build, whatever the walker reports. */
export function armsLine(manifest: CapabilityManifest | null): string {
  const hasArm = manifest?.modules.some((m) => m.module_id === "manipulation.arm") ?? false;
  return hasArm
    ? "I can't move the robot arms from a conversation yet."
    : "This walker doesn't have robot arms, so I can't pick things up or move things.";
}

/** When the model didn't answer: what still works, from the status view. */
export function fallbackLine(status: WalkerStatusView): string {
  const alerts = `Your alerts are set to ${cueList(status.configuration.cues)}.`;
  return status.online ? `I can't answer that right now. ${alerts}` : `I can't answer that right now, and your walker is offline. ${alerts}`;
}
