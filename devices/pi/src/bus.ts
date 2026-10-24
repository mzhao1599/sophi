import type { ModuleView, ZoneView } from "./serial/modules";

/**
 * The service's internal events. The logger, the simulator's script runner and the tests all listen here,
 * so what they check is what the service did, not what it printed.
 */
export type ButtonName = "talk" | "confirm";
export type Edge = "pressed" | "released";
/** `toggle` sources (the simulator keyboard) only ever press: a second Talk press sends. */
export type ButtonSourceKind = "gpio" | "esp32" | "keyboard";
export interface ButtonEvent {
  button: ButtonName;
  edge: Edge;
  source: ButtonSourceKind;
  /** For logs: which GPIO line or which module. */
  detail?: string;
}

export type TalkState = "idle" | "recording" | "waiting";
export type LinkState = "unpaired" | "connecting" | "online" | "offline" | "unauthorized";
export type CueName = "listening" | "done" | "error" | "nothing_to_confirm" | "obstacle";
/** What a spoken line was: a model or fake-cloud reply, or one of the Pi's own fixed lines. */
export type SpeechKind = "reply" | "notice" | "local_reply" | "confirm_result";

export interface BusEvents {
  button: ButtonEvent;
  spoke: { text: string; kind: SpeechKind };
  cue: { name: CueName };
  haptic: { instanceId: string; pattern: string; durationMs: number };
  talk: { state: TalkState };
  link: { state: LinkState };
  config: { version: number };
  heartbeat: { ok: boolean };
  module: { instanceId: string; health: string };
  moduleDown: { module: ModuleView; reason: "heartbeat_timeout" | "disconnected" };
  zones: { zones: ZoneView[] };
  /** A button source can no longer report a release (a hand module went away or rebooted, or gpiomon exited). */
  buttonsLost: { source: ButtonSourceKind; detail?: string };
  turn: { outcome: "answered" | "cancelled" | "timeout" | "offline" | "unauthorized" | "failed" | "too_short" | "discarded" };
}

type Listener<T> = (payload: T) => void;

export class Bus {
  private listeners = new Map<keyof BusEvents, Set<Listener<never>>>();

  on<K extends keyof BusEvents>(name: K, fn: Listener<BusEvents[K]>): () => void {
    let set = this.listeners.get(name);
    if (!set) this.listeners.set(name, (set = new Set()));
    set.add(fn as Listener<never>);
    return () => set.delete(fn as Listener<never>);
  }

  emit<K extends keyof BusEvents>(name: K, payload: BusEvents[K]): void {
    for (const fn of this.listeners.get(name) ?? []) (fn as Listener<BusEvents[K]>)(payload);
  }
}
