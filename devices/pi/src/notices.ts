import { effectiveObstacleCues, type ConfiguredCue } from "./cues";
import type { ModuleView } from "./serial/modules";

/**
 * Every line the Pi speaks on its own. These are fixed and built from local state only; the model never
 * speaks unprompted, and none of these lines comes from the cloud.
 */
export const LINES = {
  boot: "Steady is on.",
  backOnline: "I'm back online.",
  notPaired: "I'm not paired yet. Open the walker page to get a pairing code.",
  pairAgain: "I need to be paired again. Open the walker page to get a new pairing code.",
  connecting: "I'm still connecting. Try again in a moment.",
  tooShort: "I didn't catch that. Hold Talk while you speak.",
  cancelled: "Cancelled.",
  stoppedListening: "I stopped listening because the button stopped responding.",
  nothingToConfirm: "Nothing to confirm.",
  confirmedPending: "Confirmed. The change will apply in a moment.",
  offlineNoSettings: "I'm offline right now, so I can't change settings.",
  serverTrouble: "Something went wrong on the server. Please try again.",
  micTrouble: "I couldn't hear the microphone. Please try again.",
} as const;

const isWorking = (module: ModuleView) => module.health === "ok" || module.health === "degraded";

function list(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** What the walker says when it's offline: only what is true of the parts it can see right now. */
export function offlineLine(cues: readonly ConfiguredCue[] | null, modules: readonly ModuleView[]): string {
  const parts = ["I'm offline right now."];
  const sensors = modules.filter((module) => module.type === "perception");
  if (sensors.length > 0) {
    const working = sensors.filter(isWorking);
    if (working.length === 0) {
      parts.push("The obstacle sensor isn't responding, so obstacle alerts are off.");
    } else {
      const hasHaptic = modules.some(
        (module) => module.type === "hand" && module.capabilities.includes("haptic") && isWorking(module),
      );
      const kinds = effectiveObstacleCues(cues, hasHaptic).map((cue) => (cue === "vibration" ? "vibration" : "short-sound"));
      parts.push(`Your ${list(kinds)} alerts still work.`);
      if (working.every((module) => module.simulated)) parts.push("The obstacle sensor is simulated.");
    }
  }
  return parts.join(" ");
}

/** Said after a confirmed change is applied, from the new configuration itself (never the model's words). */
export function appliedLine(cues: readonly ConfiguredCue[]): string {
  const kinds: string[] = [];
  if (cues.includes("vibration")) kinds.push("vibration");
  if (cues.includes("sound")) kinds.push("short sounds");
  return kinds.length > 0 ? `Done. Obstacle alerts now use ${list(kinds)}.` : "Done. Your settings are updated.";
}

export function moduleDownLine(module: Pick<ModuleView, "type" | "instanceId">): string {
  if (module.type === "perception") return "Your obstacle sensor stopped responding.";
  if (module.type === "voice") return "Your voice module stopped responding.";
  const side = /left/.test(module.instanceId) ? "left " : /right/.test(module.instanceId) ? "right " : "";
  return `Your ${side}hand control stopped responding.`;
}
