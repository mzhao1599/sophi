import {
  FAULTS_THAT_UNHOME_LIFT,
  MOTION_BENCH_ENV,
  MOTION_BENCH_ENV_VALUE,
  MOTION_CONTROL_PERIOD_MS,
  type LiftInstallation,
  type MotionFaultCode,
} from "@walker/contracts";
import type { Bus } from "../bus";
import type { Cancel, Clock } from "../clock";
import type { Logger } from "../log";
import { LiftClient, type LiftAction, type LiftCheckInputs, type LiftEvent } from "../motion/lift";
import type { ModuleManager } from "../serial/modules";
import { SimulatedPort } from "./fakeModules";
import { SIM_LIFT_CONFIG, SimulatedLiftBoard } from "./fakeLift";

/**
 * `walker simulate --lift`: the real lift client (src/motion/lift/) over the real module manager, talking to a
 * SIMULATED lift board (fakeLift.ts) on a simulated port. The motion coordinator isn't wired here, so a
 * STAND-IN loop plays its part: it ticks the client every MOTION_CONTROL_PERIOD_MS, refreshes the hold while
 * the hold key is on (as the screen's hold control would), latches the faults the client reports and stops
 * the lift on each, and treats a key as the handle Confirm press on a lift target. There is no Confirm target,
 * no screen and no arms in this mode; the logs and bus events say so.
 */

/** SIMULATED installation record: no real lift has been inspected or drop-tested. */
export const SIM_LIFT_INSTALLATION: LiftInstallation = {
  guards_fitted: true,
  drop_test: "passed",
  brake_fitted: false,
  stop_cuts_lift_power: false,
  driver_current_setting: null,
  recorded_at: "2026-10-24T00:00:00.000Z",
};

/** Keyboard letters for the lift actions (scripts use the names: `key lift-home`). */
export const LIFT_KEYS: Readonly<Record<string, string>> = {
  l: "lift-hold",
  e: "lift-home",
  u: "lift-up",
  d: "lift-down",
  k: "lift-stop",
  y: "lift-stop-switch",
  w: "lift-stuck-bottom",
  j: "lift-cut-harness",
  v: "lift-lost-line",
  a: "lift-freeze",
  z: "lift-pause-ticks",
  K: "lift-clear",
  D: "lift-disable",
};

export const LIFT_HELP = `Lift (SIMULATED board; a STAND-IN loop plays the motion coordinator, which isn't wired here):
      l hold the screen's lift control / let go   e home (as Confirm on a lift.home)   u move to 300 mm   d move to 50 mm
      k stop   y stop switch press / release   w bottom switch stuck pressed / fixed   j cut the switch harness / fixed
      v line from the lift lost / back   a freeze the lift board (it restarts after 5 s)   z pause the control loop / resume
      K clear lift faults (as Confirm on fault.clear)   D disable the lift driver (as Confirm on lift.disable)`;

export interface LiftSimDeps {
  clock: Clock;
  log: Logger;
  bus: Bus;
  modules: ModuleManager;
  /** Bench mode, as MOTION_BENCH_ENV says (read once). */
  bench: boolean;
}

/** Bench mode for the lift simulator: MOTION_BENCH_ENV set to exactly MOTION_BENCH_ENV_VALUE. */
export function liftSimBench(env: NodeJS.ProcessEnv): boolean {
  return env[MOTION_BENCH_ENV] === MOTION_BENCH_ENV_VALUE;
}

export class LiftSim {
  readonly port = new SimulatedPort("sim:lift");
  readonly board: SimulatedLiftBoard;
  readonly client: LiftClient;
  /** The faults the stand-in latched, as the coordinator would (only a lift.clear the lift accepts clears them). */
  readonly faults = new Set<MotionFaultCode>();
  private holding = false;
  private ticking = true;
  private cancels: Cancel[] = [];
  private lastState: string | null = null;
  private stopped = false;

  constructor(private readonly deps: LiftSimDeps) {
    this.board = new SimulatedLiftBoard(this.port, deps.clock, {
      config: SIM_LIFT_CONFIG,
      disableSafe: SIM_LIFT_INSTALLATION.drop_test === "passed" || SIM_LIFT_INSTALLATION.brake_fitted,
    });
    this.client = new LiftClient({
      log: deps.log,
      setup: { config: SIM_LIFT_CONFIG, installation: SIM_LIFT_INSTALLATION },
      bench: deps.bench,
      monotonic: () => deps.clock.monotonic(),
    });
    this.client.on((event) => this.onEvent(event));
  }

  start(): void {
    this.deps.modules.setLiftHandler(this.client);
    this.deps.modules.attach(this.port);
    this.board.start();
    this.deps.log.info("SIMULATED lift board started; a STAND-IN loop drives the lift client (no motion coordinator here)");
    const tick = () => {
      if (this.stopped) return;
      const now = this.deps.clock.monotonic();
      if (this.holding) this.client.holdRefresh(now); // the screen refreshes at least every HOLD_CONTROL_REFRESH_MS
      if (this.ticking) this.client.tick(now);
      this.reportState();
      this.cancels.push(this.deps.clock.setTimeout(tick, MOTION_CONTROL_PERIOD_MS));
    };
    this.cancels.push(this.deps.clock.setTimeout(tick, MOTION_CONTROL_PERIOD_MS));
  }

  stop(): void {
    this.stopped = true;
    for (const cancel of this.cancels) cancel();
    this.board.powerOff();
  }

  /** The stand-in's inputs: no arms (so nothing to stow), the lift's stop as the walker's stop, its own faults. */
  inputs(): LiftCheckInputs {
    return {
      stopCircuit: this.board.stopPressed ? "pressed" : "released",
      faultLatched: this.faults.size > 0,
      armsStowed: true,
      otherMotion: false,
    };
  }

  /** Named actions for scripts (`key lift-home`) and LIFT_KEYS. */
  actions(): Record<string, () => void> {
    const say = (kind: string, text: string) => this.emit(kind, text);
    return {
      "lift-hold": () => (this.holding ? this.actions()["lift-hold-off"]!() : this.actions()["lift-hold-on"]!()),
      "lift-hold-on": () => {
        this.holding = true;
        this.client.holdRefresh(this.deps.clock.monotonic());
        say("hold", "on");
      },
      "lift-hold-off": () => {
        this.holding = false;
        this.client.holdRelease(this.deps.clock.monotonic());
        say("hold", "off");
      },
      "lift-home": () => this.confirm({ kind: "lift.home" }),
      "lift-up": () => this.confirm({ kind: "lift.move", target_mm: 300 }),
      "lift-down": () => this.confirm({ kind: "lift.move", target_mm: 50 }),
      "lift-stop": () => {
        this.client.stop();
        say("stop", "sent");
      },
      "lift-stop-switch": () => {
        this.board.stopPressed = !this.board.stopPressed;
        say("sim", `stop switch ${this.board.stopPressed ? "pressed" : "released"}`);
      },
      "lift-stuck-bottom": () => {
        this.board.switchFaults.bottom = this.board.switchFaults.bottom === "ok" ? "stuck_pressed" : "ok";
        say("sim", `bottom switch ${this.board.switchFaults.bottom}`);
      },
      "lift-cut-harness": () => {
        const cut = this.board.switchFaults.top === "ok";
        if (cut) this.board.cutWire("both");
        else this.board.switchFaults = { bottom: "ok", top: "ok" };
        say("sim", `switch harness ${cut ? "cut" : "fixed"}`);
      },
      "lift-lost-line": () => {
        this.board.dropFromLift = !this.board.dropFromLift;
        say("sim", `line from the lift ${this.board.dropFromLift ? "lost" : "back"}`);
      },
      "lift-freeze": () => {
        this.board.freeze();
        say("sim", "lift board frozen");
      },
      "lift-pause-ticks": () => {
        this.ticking = !this.ticking;
        say("sim", `control loop ${this.ticking ? "running" : "paused"}`);
      },
      "lift-clear": () => {
        say("standin", "Confirm on fault.clear");
        if (!this.client.clearFaults()) say("refused", "fault.clear part_missing");
      },
      "lift-disable": () => {
        say("standin", "Confirm on lift.disable");
        const result = this.client.disable(this.inputs(), this.deps.clock.monotonic());
        if (!result.ok) say("refused", `lift.disable ${result.refusal}`);
      },
    };
  }

  /** As if a handle Confirm press answered a lift target: the coordinator would then call `start`. */
  private confirm(action: Extract<LiftAction, { kind: "lift.home" | "lift.move" }>): void {
    this.emit("standin", `Confirm on ${action.kind}`);
    const result = this.client.start(action, this.inputs(), this.deps.clock.monotonic());
    if (!result.ok) this.emit("refused", `${action.kind} ${result.refusal}`);
  }

  private onEvent(event: LiftEvent): void {
    switch (event.type) {
      case "link":
        return this.emit("link", event.connected ? "connected" : "lost");
      case "accepted":
        return this.emit("accepted", `${event.kind} ${event.requestId}`);
      case "ended":
        return this.emit("ended", [event.kind, event.outcome, event.reason, event.fault].filter(Boolean).join(" "));
      case "fault":
        // What the coordinator does with a fault: latch it, stop the lift, and unhome it if the fault says so.
        this.faults.add(event.code);
        this.client.stop();
        if (FAULTS_THAT_UNHOME_LIFT.includes(event.code)) this.client.markUnhomed();
        return this.emit("fault", event.code);
      case "clear":
        if (event.outcome === "cleared") this.faults.clear();
        return this.emit("clear", [event.outcome, event.reason].filter(Boolean).join(" "));
      case "disable":
        return this.emit("disable", [event.outcome, event.reason].filter(Boolean).join(" "));
    }
  }

  private reportState(): void {
    const state = this.client.state(this.deps.clock.monotonic());
    const status = this.client.lastStatus();
    const text = !state.connected
      ? "disconnected"
      : `${status?.state ?? "unknown"} ${state.homed ? "homed" : "unhomed"}${state.position_mm === null ? "" : ` at ${Math.round(state.position_mm)} mm`}`;
    const key = text.replace(/ at \d+ mm$/, "");
    if (key === this.lastState) return;
    this.lastState = key;
    this.emit("state", text);
  }

  private emit(kind: string, text: string): void {
    this.deps.log.info(`SIMULATED lift ${kind}`, { text });
    this.deps.bus.emit("lift", { kind, text });
  }
}
