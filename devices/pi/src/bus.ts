import type { Cue, MotionState, ProposalView, ScreenStateName } from "@walker/contracts";
import type { ScreenHoldEvent } from "./screen/server";
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
  /** The mic opened (after the listening sound): what a script, like a person, holds Talk from. */
  mic: { state: "open" };
  link: { state: LinkState };
  config: { version: number };
  heartbeat: { ok: boolean };
  module: { instanceId: string; health: string };
  moduleDown: { module: ModuleView; reason: "heartbeat_timeout" | "disconnected" };
  zones: { zones: ZoneView[] };
  /** A button source can no longer report a release (a hand module went away or rebooted, or gpiomon exited). */
  buttonsLost: { source: ButtonSourceKind; detail?: string };
  turn: { outcome: "answered" | "cancelled" | "timeout" | "offline" | "unauthorized" | "failed" | "too_short" | "discarded" };
  /**
   * For the walker screen's captions: what a Talk press got back, as it starts being spoken. `model` and
   * `fixed` are the server's `answered_by`; `walker` is the Pi's own line for a Talk press it can't send
   * (offline, not paired). It holds her words and the reply: never log it (docs/interfaces.md, the logging rule).
   */
  answer: { id: number; heard: string | null; reply: string; source: "model" | "fixed" | "walker" };
  /** That answer finished playing, or was stopped. */
  answerSpoken: { id: number };
  /** The open proposal changed (another id, or none). A heartbeat repeating the same one sends nothing. */
  offer: { proposal: ProposalView | null };
  /**
   * A Confirm press settled the open proposal: applied (sent only once the new configuration is in force, with
   * its cues), or nothing changed. A confirmed change whose configuration couldn't be fetched sends neither.
   */
  settled: { result: { kind: "alerts"; cues: Cue[] } | { kind: "nothing_changed" } };
  /** A Confirm press is being answered (`started`) and has finished, however it ended (`ended`). */
  confirming: { phase: "started" | "ended" };
  /** The walker screen sent a new state: its name and revision only (for scripts and tests; never the body). */
  screen: { state: ScreenStateName; revision: number };
  /** `walker simulate --lift` only: what the lift client, the simulated lift and the stand-in loop did. */
  lift: { kind: string; text: string };
  /**
   * A hand module said hello, went away, or its line numbers jumped (a lost line) or went back (a reboot):
   * whatever was known about its buttons may be wrong, so a pending motion Confirm target is withdrawn.
   */
  handLink: { instanceId: string; why: "hello" | "seq_gap" | "seq_back" | "error" | "lost" };
  /** What the motion coordinator did, in a few words (checks, commands, faults, offers), for logs and scripts. */
  motion: { kind: string; text: string };
  /** The motion state, as the contract's MotionStateSchema (the walker screen draws it: src/screen/motion.ts). */
  motionState: { state: MotionState };
  /**
   * The walker screen's lift hold control (POST /screen/hold): "still held", at least every
   * HOLD_CONTROL_REFRESH_MS while her finger is on it, or let go (her finger lifted, the touch cancelled, the
   * page lost focus, was hidden or lost its stream, or the control wasn't on screen). `atMono` is the Pi's
   * monotonic time when it arrived, never the page's. The coordinator wires it to the lift's hold lease:
   * `bus.on("screenHold", (h) => (h.pressed ? lift.holdRefresh(h.atMono) : lift.holdRelease(h.atMono)))`.
   */
  screenHold: ScreenHoldEvent;
  /** Simulator only: what the simulated servos saw (never emitted on the Pi). */
  sim: { text: string };
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
