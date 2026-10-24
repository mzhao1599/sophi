import { MOTION_BENCH_ENV, MOTION_BENCH_ENV_VALUE, type LiftConfig, type LiftInstallation } from "@walker/contracts";
import type { Bus } from "../bus";
import type { Cancel, Clock } from "../clock";
import type { Logger } from "../log";
import type { MotionCoordinator } from "../motion/coordinator";
import { LiftClient } from "../motion/lift";
import { HOLD_SEND_MS } from "../screen/hold";
import type { ModuleManager } from "../serial/modules";
import { SimulatedPort } from "./fakeModules";
import { SIM_LIFT_CONFIG, SimulatedLiftBoard } from "./fakeLift";

/**
 * `walker simulate --arms --lift`: a SIMULATED lift board (fakeLift.ts) on a simulated port, found by the real
 * module manager and driven by the real lift client under the real motion coordinator, as on the walker. The
 * lift keys only do what a person or a fault would: prepare a lift target (as the terminal does; Confirm is
 * still `c`), hold or let go of the screen's lift control (it posts "still held" every HOLD_SEND_MS, as the
 * screen's page does, through the same `screenHold` bus event the screen server raises), or inject a fault into
 * the simulated board. Nothing here plays the coordinator.
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

/** The simulator's made-up tray height (its sample skill is "taught" there), and the lowered height. SIMULATED. */
export const SIM_TRAY_HEIGHT_MM = 300;
export const SIM_LOW_HEIGHT_MM = 50;

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

export const LIFT_HELP = `Lift (SIMULATED board, the real lift client under the real motion coordinator; the arms start folded):
      l hold the screen's lift control / let go   e home   u raise to ${SIM_TRAY_HEIGHT_MM} mm   d lower to ${SIM_LOW_HEIGHT_MM} mm (each: then hold l, then c)
      k stop   y the stop switch (the same one as s)   w bottom switch stuck pressed / fixed   j cut the switch harness / fixed
      v line from the lift lost / back   a freeze the lift board (it restarts after 5 s)   z the control loop stops calling the lift / resumes
      K clear the faults (then c)   D turn off the lift's motor (then c)`;

export interface LiftSimDeps {
  clock: Clock;
  log: Logger;
  bus: Bus;
  modules: ModuleManager;
  /** Bench mode, as MOTION_BENCH_ENV says (read once). */
  bench: boolean;
  /** Tests: the Pi's lift.json configuration, when it should differ from the simulated board's built-in one. */
  config?: LiftConfig;
  /** Tests: the Pi's installation record (default SIM_LIFT_INSTALLATION). */
  installation?: LiftInstallation;
  /** Tests: whether the simulated board was built with its stop-sense input (default wired). */
  boardStopSense?: "wired" | "not_wired";
}

/** Bench mode for the lift simulator: MOTION_BENCH_ENV set to exactly MOTION_BENCH_ENV_VALUE. */
export function liftSimBench(env: NodeJS.ProcessEnv): boolean {
  return env[MOTION_BENCH_ENV] === MOTION_BENCH_ENV_VALUE;
}

export class LiftSim {
  readonly port = new SimulatedPort("sim:lift");
  readonly board: SimulatedLiftBoard;
  /** The real lift client, for the coordinator (MotionSim passes it on). */
  readonly client: LiftClient;
  private holding = false;
  private holdTimer: Cancel | null = null;
  private ticksPaused = false;
  private cancels: Cancel[] = [];
  private lastState: string | null = null;
  private stopped = false;

  constructor(private readonly deps: LiftSimDeps) {
    const installation = deps.installation ?? SIM_LIFT_INSTALLATION;
    this.board = new SimulatedLiftBoard(this.port, deps.clock, {
      config: SIM_LIFT_CONFIG,
      disableSafe: installation.drop_test === "passed" || installation.brake_fitted,
      stopSense: deps.boardStopSense ?? "wired",
    });
    this.client = new LiftClient({
      log: deps.log,
      setup: { config: deps.config ?? SIM_LIFT_CONFIG, installation },
      bench: deps.bench,
      monotonic: () => deps.clock.monotonic(),
    });
    // SIMULATED control-loop stall (`lift-pause-ticks`): the coordinator's loop keeps running, but its calls into
    // the lift are dropped, as if the loop had stopped. Only the simulator does this.
    const tick = this.client.tick.bind(this.client);
    this.client.tick = (now: number) => {
      if (!this.ticksPaused) tick(now);
    };
  }

  /** The lift board on its port: call before the coordinator ticks (the handler is set first, as on the Pi). */
  start(): void {
    this.deps.modules.setLiftHandler(this.client);
    this.deps.modules.attach(this.port);
    this.board.start();
    this.deps.log.info("SIMULATED lift board started; the real lift client runs under the motion coordinator");
    const report = () => {
      if (this.stopped) return;
      this.reportState();
      this.cancels.push(this.deps.clock.setTimeout(report, 50));
    };
    report();
  }

  stop(): void {
    this.stopped = true;
    this.holdTimer?.();
    for (const cancel of this.cancels) cancel();
    this.board.powerOff();
  }

  /** The walker's one stop switch also opens the lift board's own stop-sense input (MotionSim calls this). */
  setStopPressed(pressed: boolean): void {
    this.board.stopPressed = pressed;
  }

  /**
   * Named actions for scripts (`key lift-home`) and LIFT_KEYS. `stopSwitch` presses or releases the walker's
   * one stop switch (MotionSim's `stop-switch`).
   */
  actions(coordinator: MotionCoordinator, stopSwitch: () => void): Record<string, () => void> {
    const say = (kind: string, text: string) => this.emit(kind, text);
    const operator = (what: string, result: { ok: boolean; error?: string }) => {
      if (!result.ok) say("refused", `${what}: ${result.error ?? ""}`);
    };
    const holdOn = () => {
      if (this.holding) return;
      this.holding = true;
      say("hold", "on");
      // As the screen's page does: "still held" now and every HOLD_SEND_MS, stamped by the Pi on receipt.
      const refresh = () => {
        if (!this.holding || this.stopped) return;
        this.deps.bus.emit("screenHold", { pressed: true, atMono: this.deps.clock.monotonic() });
        this.holdTimer = this.deps.clock.setTimeout(refresh, HOLD_SEND_MS);
      };
      refresh();
    };
    const holdOff = () => {
      if (!this.holding) return;
      this.holding = false;
      this.holdTimer?.();
      this.holdTimer = null;
      this.deps.bus.emit("screenHold", { pressed: false, atMono: this.deps.clock.monotonic(), reason: "page" });
      say("hold", "off");
    };
    return {
      "lift-hold": () => (this.holding ? holdOff() : holdOn()),
      "lift-hold-on": holdOn,
      "lift-hold-off": holdOff,
      "lift-home": () => operator("lift.home", coordinator.operatorLiftHome()),
      "lift-up": () => operator("lift.move", coordinator.operatorLiftMove(SIM_TRAY_HEIGHT_MM)),
      "lift-down": () => operator("lift.move", coordinator.operatorLiftMove(SIM_LOW_HEIGHT_MM)),
      "lift-stop": () => operator("stop", coordinator.operatorStop()),
      "lift-stop-switch": stopSwitch,
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
        this.ticksPaused = !this.ticksPaused;
        say("sim", `control loop ${this.ticksPaused ? "not calling the lift" : "calling the lift again"}`);
      },
      "lift-clear": () => operator("fault.clear", coordinator.operatorClear("simulator: checked")),
      "lift-disable": () => operator("lift.disable", coordinator.operatorLiftDisable()),
    };
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
