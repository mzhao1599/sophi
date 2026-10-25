import type { Cue } from "@walker/contracts";
import type { Clock } from "./clock";
import {
  CUE_MIN_GAP_MS,
  CUE_REPEAT_MS,
  NEAR_ENTER_MM,
  NEAR_EXIT_MM,
  OBSTACLE_HAPTIC_MS,
} from "./constants";
import type { Logger } from "./log";
import type { ModuleManager, ZoneView } from "./serial/modules";

export type ConfiguredCue = Cue;
export type ObstacleCue = "vibration" | "sound";

/**
 * Which obstacle cues to give, from the confirmed configuration's `cues` (null before the Pi has fetched one).
 * Nothing is silently dropped: no configuration yet means both; vibration with no working haptic hand falls
 * back to sound; a list with neither (the contract forbids it while obstacle sensors are on) also gives sound.
 */
export function effectiveObstacleCues(cues: readonly ConfiguredCue[] | null, hasHaptic: boolean): ObstacleCue[] {
  if (cues === null) return hasHaptic ? ["vibration", "sound"] : ["sound"];
  const wanted = new Set<ObstacleCue>();
  if (cues.includes("vibration")) wanted.add(hasHaptic ? "vibration" : "sound");
  if (cues.includes("sound")) wanted.add("sound");
  if (wanted.size === 0) wanted.add("sound");
  return (["vibration", "sound"] as const).filter((cue) => wanted.has(cue));
}

export type ZoneState = "near" | "clear" | "unknown";

export interface CuePolicyDeps {
  clock: Clock;
  log: Logger;
  modules: Pick<ModuleManager, "hapticTargets" | "sendHaptic">;
  playObstacleSound: () => void;
  /** The current configuration's cues, or null before one is fetched. */
  cues: () => readonly ConfiguredCue[] | null;
}

/**
 * The local obstacle cue policy. It runs on the Pi only, from fresh ToF zones; nothing from the cloud ever
 * triggers a cue, and the cloud's only influence is the user-confirmed `cues` list.
 *
 * A zone becomes near under NEAR_ENTER_MM and clears only over NEAR_EXIT_MM (hysteresis). A zone that is
 * missing, stale or invalid is unknown, never clear. Each zone has its own cue gap and repeat timer, so a
 * new obstacle on the other side can buzz immediately. All of these numbers are placeholders, not measured.
 */
export class CuePolicy {
  private readonly states = new Map<string, { state: ZoneState; lastCueMono: number | null; nearBeforeUnknown: boolean }>();

  constructor(private readonly deps: CuePolicyDeps) {}

  /** Call with the zones the Pi may act on now (fresh, from available modules). */
  evaluate(zones: readonly ZoneView[]): void {
    const now = this.deps.clock.monotonic();
    const present = new Set(zones.map((zone) => zone.zone));
    for (const [name, entry] of this.states) if (!present.has(name)) this.toUnknown(entry);

    const dueZones: string[] = [];
    for (const zone of zones) {
      let entry = this.states.get(zone.zone);
      if (!entry) this.states.set(zone.zone, (entry = { state: "unknown", lastCueMono: null, nearBeforeUnknown: false }));
      if (zone.quality !== "valid" || zone.mm === null) {
        this.toUnknown(entry);
        continue;
      }
      const before = entry.state;
      const near = before === "near" ? zone.mm <= NEAR_EXIT_MM : zone.mm < NEAR_ENTER_MM;
      entry.state = near ? "near" : "clear";
      if (!near) continue;
      const gapOk = entry.lastCueMono === null || now - entry.lastCueMono >= CUE_MIN_GAP_MS;
      const repeatOk = entry.lastCueMono === null || now - entry.lastCueMono >= CUE_REPEAT_MS;
      // Back from unknown soon after its last cue, having been near before (a reading flickering near and
      // invalid), counts as staying near. Near, clear, invalid, near is a new entry.
      const flicker =
        before === "unknown" && entry.nearBeforeUnknown && entry.lastCueMono !== null && now - entry.lastCueMono < CUE_REPEAT_MS;
      const staying = before === "near" || flicker;
      if (gapOk && (!staying || repeatOk)) dueZones.push(zone.zone);
    }
    if (dueZones.length === 0) return;

    for (const name of dueZones) {
      const entry = this.states.get(name);
      if (entry) entry.lastCueMono = now;
    }
    this.give(dueZones);
  }

  private toUnknown(entry: { state: ZoneState; nearBeforeUnknown: boolean }): void {
    if (entry.state !== "unknown") entry.nearBeforeUnknown = entry.state === "near";
    entry.state = "unknown";
  }

  zoneState(name: string): ZoneState {
    return this.states.get(name)?.state ?? "unknown";
  }

  private give(dueZones: readonly string[]): void {
    const targets = this.deps.modules.hapticTargets();
    const cues = effectiveObstacleCues(this.deps.cues(), targets.length > 0);
    const targetFor = (zone: string, id: string) =>
      (zone !== "left" && zone !== "right") || id.startsWith(`hand-${zone}-`);
    const selected = targets.filter((target) => dueZones.some((zone) => targetFor(zone, target.instanceId)));
    const missingSide = dueZones.some((zone) =>
      (zone === "left" || zone === "right") && !selected.some((target) => targetFor(zone, target.instanceId)));
    let buzzed = 0;
    if (cues.includes("vibration")) {
      for (const target of selected) {
        if (this.deps.modules.sendHaptic(target.instanceId, "near_obstacle", OBSTACLE_HAPTIC_MS)) buzzed += 1;
      }
    }
    if (cues.includes("sound") || (cues.includes("vibration") && (missingSide || buzzed < selected.length || buzzed === 0))) {
      this.deps.playObstacleSound();
    }
  }
}
