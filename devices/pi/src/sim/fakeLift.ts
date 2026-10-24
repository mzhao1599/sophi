import {
  LIFT_HOMING_BACKOFF_MM,
  LIFT_HOMING_FAST_MM_S,
  LIFT_HOMING_MAX_TRAVEL_MM,
  LIFT_HOMING_RELEASE_MARGIN_MM,
  LIFT_HOMING_SLOW_MM_S,
  LIFT_HOMING_TIMEOUT_MS,
  LIFT_STATUS_HZ,
  LIFT_STOP_DECEL_MM_S2,
  LIFT_WATCHDOG_TIMEOUT_MS,
  LiftSerialMessageSchema,
  SERIAL_ANY_MODULE,
  parseLiftSerialLine,
  type LiftAckReason,
  type LiftConfig,
  type LiftSerialFault,
  type LiftSerialMessage,
} from "@walker/contracts";
import type { Cancel, Clock } from "../clock";
import type { SimulatedPort } from "./fakeModules";

/**
 * A SIMULATED lift board (`lift-01`) for `walker simulate --lift` and the tests: a TypeScript port of the lift
 * firmware's rules 1 to 10 (packages/contracts/src/lift-serial.ts; firmware/lib/lift/lift_core.cpp, PR #74)
 * driving a simulated stepper and carriage. Not ported: the firmware's TX outbox (here a line always goes out
 * unless `dropFromLift` drops it, which still uses its seq, as a status the port can't take does). It is not the firmware and proves
 * nothing about the real board, driver, motor or switches; it lets the Pi's lift client be exercised end to end.
 *
 * The carriage has a physical height (millimetres above the bottom switch's trip point) and the board a counted
 * one (its step count), which agree only after homing and only while every counted step was taken: pressing
 * the stop cuts the step signal, so counted steps then go nowhere.
 */

/** The firmware's default build settings (firmware/README.md, "Build settings"); placeholders, not measured. */
export const SIM_LIFT_CONFIG: LiftConfig = {
  microsteps: 8,
  soft_min_mm: 5,
  soft_max_mm: 600,
  max_speed_mm_s: 20,
  max_accel_mm_s2: 50,
  top_switch_mm: null,
};

/** The simulated board's loop period. */
export const SIM_LIFT_LOOP_MS = 10;
const STATUS_INTERVAL_MS = 1000 / LIFT_STATUS_HZ;
const HOMING_SEARCH_MM = LIFT_HOMING_BACKOFF_MM + LIFT_HOMING_RELEASE_MARGIN_MM;
/** Firmware placeholder: a switch reads released in status only after this long released. */
const SWITCH_RELEASE_MS = 20;
/** The firmware's task watchdog (firmware/README.md): a board whose loop stops restarts after this. */
export const SIM_LIFT_FROZEN_RESTART_MS = 5000;
/** How far a carriage can push past the bottom switch's trip point before the hard stop. Simulation only. */
const OVERTRAVEL_MM = 4;
/** The slowest the simulated stepper runs, so a ramp to a target always arrives. */
const MIN_SPEED_MM_S = 0.2;
/** Boot prefixes the firmware remembers for request_used; once full, a new prefix is refused until it restarts. */
export const SIM_LIFT_PREFIXES = 16;

export type SimSwitchFault = "ok" | "stuck_pressed" | "stuck_released";

/** The pulse generator, as the core sees it (the firmware's StepperPort), in millimetres. */
class SimStepper {
  position = 0;
  private v = 0;
  private target: number | null = null;
  private vmax = 0;
  private accel = 0;
  private decel: number | null = null;

  running(): boolean {
    return this.target !== null || this.decel !== null;
  }

  moveTo(target: number, speed: number, accel: number): void {
    this.target = target;
    this.vmax = speed;
    this.accel = accel;
    this.decel = null;
  }

  decelerate(accel: number): void {
    if (!this.running()) return;
    this.target = null;
    this.decel = accel;
  }

  halt(): void {
    this.v = 0;
    this.target = null;
    this.decel = null;
  }

  /** Advances by `dt` seconds; returns the counted distance moved. */
  step(dt: number): number {
    let delta = 0;
    if (this.decel !== null) {
      const speed = Math.abs(this.v) - this.decel * dt;
      if (speed <= 0) {
        this.v = 0;
        this.decel = null;
      } else this.v = Math.sign(this.v) * speed;
      delta = this.v * dt;
    } else if (this.target !== null) {
      const dist = this.target - this.position;
      const dir = Math.sign(dist);
      const speed = Math.abs(this.v);
      const desired = Math.max(MIN_SPEED_MM_S, Math.min(this.vmax, Math.sqrt(2 * this.accel * Math.abs(dist))));
      const next = speed < desired ? Math.min(desired, speed + this.accel * dt) : Math.max(desired, speed - this.accel * dt);
      delta = dir * Math.max(MIN_SPEED_MM_S, next) * dt;
      if (Math.abs(delta) >= Math.abs(dist)) {
        delta = dist;
        this.v = 0;
        this.target = null;
      } else this.v = dir * next;
    }
    this.position += delta;
    return delta;
  }
}

type Activity = "none" | "move" | "home";
type Phase = "fast_approach" | "back_off" | "slow_approach" | "final_back_off";
type StopCause = "none" | "command" | "release" | "watchdog";
type Line = Record<string, unknown>;

export interface SimulatedLiftBoardOptions {
  moduleId?: string;
  /** Built into the "firmware" and reported in lift.hello. */
  config?: LiftConfig;
  /** Built with a stop-sense input. */
  stopSense?: "wired" | "not_wired";
  /** Built disable-safe (after a passed drop test or with a brake): `lift.enable` false always frees the motor. */
  disableSafe?: boolean;
  /** The carriage's physical height at power-on. */
  startHeightMm?: number;
  /** Where the physical top switch trips. */
  topSwitchMm?: number;
}

export class SimulatedLiftBoard {
  readonly moduleId: string;
  readonly config: LiftConfig;
  private readonly stopSenseWired: boolean;
  private readonly disableSafe: boolean;
  private readonly topSwitchMm: number;

  // ---- The simulated world (and its injectable faults) ----
  /** The carriage's real height above the bottom switch's trip point. */
  physicalMm: number;
  switchFaults: { bottom: SimSwitchFault; top: SimSwitchFault } = { bottom: "ok", top: "ok" };
  /** The hardware stop: pressed cuts the step signal and opens stop-sense. */
  stopPressed = false;
  /** Lines from the Pi never arrive. */
  dropToLift = false;
  /** Lines from the lift never arrive (they still use their seq, like dropped TX lines). */
  dropFromLift = false;
  /** The board's loop is stuck: no lines in or out; the pulse hardware finishes its move; restart after 5 s. */
  private frozenAt: number | null = null;
  /** Every line the board wrote (delivered or not), parsed, for tests. */
  readonly sentLines: LiftSerialMessage[] = [];

  // ---- The board ----
  private stepper = new SimStepper();
  private running = false;
  private bootMono = 0;
  private lastLoopMono = 0;
  private cancel: Cancel | null = null;
  private seq = 0;
  private hasAcceptedSeq = false;
  private lastAcceptedSeq = 0;
  private lastHeartbeat: number | null = null;
  private hold: string | null = null;
  private activity: Activity = "none";
  private phase: Phase = "fast_approach";
  private stopCause: StopCause = "none";
  private activeRequest = "";
  private prefixes = new Map<string, number>();
  private targetMm = 0;
  private homingStarted = 0;
  private phaseStart = 0;
  private travelBefore = 0;
  private homed = false;
  private driverEnabled = false;
  private faults = new Set<LiftSerialFault>();
  private rawBottom = false;
  private rawTop = false;
  private stop: "pressed" | "released" | "not_wired" = "not_wired";
  private bottomEdge = false;
  /** Homing trips only after two pressed samples in a row; the zero is the first one's counted position. */
  private bottomStreak = 0;
  private bottomFirstPressed = 0;
  private reportedBottom = false;
  private reportedTop = false;
  private bottomReleasedSince = 0;
  private topReleasedSince = 0;
  private nextStatus = 0;
  private lastStatusKey: string | null = null;

  constructor(
    readonly port: SimulatedPort,
    private readonly clock: Clock,
    options: SimulatedLiftBoardOptions = {},
  ) {
    this.moduleId = options.moduleId ?? "lift-01";
    this.config = options.config ?? SIM_LIFT_CONFIG;
    this.stopSenseWired = (options.stopSense ?? "wired") === "wired";
    this.disableSafe = options.disableSafe ?? false;
    this.topSwitchMm = options.topSwitchMm ?? 700;
    this.physicalMm = options.startHeightMm ?? 40;
    port.onPiLine = (text) => {
      for (const line of text.split("\n")) if (line.trim() !== "") this.receive(line);
    };
  }

  /** Power on: rule 1, then the loop every SIM_LIFT_LOOP_MS. */
  start(): void {
    this.cancel?.();
    this.running = true;
    this.boot();
    const loop = () => {
      if (!this.running) return;
      this.loop();
      this.cancel = this.clock.setTimeout(loop, SIM_LIFT_LOOP_MS);
    };
    this.cancel = this.clock.setTimeout(loop, SIM_LIFT_LOOP_MS);
  }

  /** Power off. */
  powerOff(): void {
    this.running = false;
    this.cancel?.();
    this.cancel = null;
    this.stepper.halt();
  }

  get isRunning(): boolean {
    return this.running;
  }

  /** The board's loop sticks (a frozen ESP32); the task watchdog restarts it after SIM_LIFT_FROZEN_RESTART_MS. */
  freeze(): void {
    if (this.frozenAt === null) this.frozenAt = this.clock.monotonic();
  }

  get frozen(): boolean {
    return this.frozenAt !== null;
  }

  /** A cut wire on a normally closed switch reads pressed. */
  cutWire(which: "bottom" | "top" | "both"): void {
    if (which !== "top") this.switchFaults.bottom = "stuck_pressed";
    if (which !== "bottom") this.switchFaults.top = "stuck_pressed";
  }

  /** For tests: the counted height and the board's state. */
  inspect() {
    return {
      countedMm: this.stepper.position,
      physicalMm: this.physicalMm,
      homed: this.homed,
      driverEnabled: this.driverEnabled,
      faults: [...this.faults],
      activity: this.activity,
      stopping: this.stopCause !== "none",
      lastAcceptedSeq: this.hasAcceptedSeq ? this.lastAcceptedSeq : null,
    };
  }

  // ---- Boot and loop ----

  private boot(): void {
    const now = this.clock.monotonic();
    this.bootMono = now;
    this.lastLoopMono = now;
    this.frozenAt = null;
    this.seq = 0;
    this.hasAcceptedSeq = false;
    this.lastHeartbeat = null;
    this.hold = null;
    this.activity = "none";
    this.stopCause = "none";
    this.activeRequest = "";
    this.prefixes.clear();
    this.homed = false;
    this.faults.clear();
    this.lastStatusKey = null;
    // Rule 1: not stepping, unhomed, no fault, driver enabled (holding); a fresh count from 0.
    this.stepper = new SimStepper();
    this.setDriver(true);
    this.readSwitches(0);
    this.reportedBottom = this.rawBottom;
    this.reportedTop = this.rawTop;
    this.sendHello();
    this.sendStatus(0);
    this.checkSwitches(0);
    this.maybeSendStatus(0);
  }

  private uptime(now = this.clock.monotonic()): number {
    return Math.max(0, Math.round(now - this.bootMono));
  }

  private loop(): void {
    const mono = this.clock.monotonic();
    const dt = Math.max(0, mono - this.lastLoopMono) / 1000;
    this.lastLoopMono = mono;
    // The physical world: the pulse hardware keeps going even when the board's loop is stuck.
    const delta = this.stepper.step(dt);
    if (!this.stopPressed && this.driverEnabled) {
      this.physicalMm = Math.max(-OVERTRAVEL_MM, Math.min(this.topSwitchMm + OVERTRAVEL_MM, this.physicalMm + delta));
    }
    if (this.frozenAt !== null) {
      if (mono - this.frozenAt >= SIM_LIFT_FROZEN_RESTART_MS) this.boot(); // the task watchdog restarts the board
      return;
    }
    const now = this.uptime(mono);
    this.readSwitches(now);
    this.checkSwitches(now);
    this.checkWatchdog(now);
    this.advance(now);
    this.maybeSendStatus(now);
  }

  // ---- Lines from the Pi (rules 2 to 6, 9) ----

  private receive(text: string): void {
    if (!this.running || this.frozenAt !== null || this.dropToLift) return;
    const now = this.uptime();
    const parsed = parseLiftSerialLine(text);
    if (!parsed.ok) {
      this.send({ type: "error", code: parsed.problem, uptime_ms: now });
      return;
    }
    this.handle(parsed.message, now);
    this.maybeSendStatus(now);
  }

  private handle(m: LiftSerialMessage, now: number): void {
    const forMe = m.module_id === this.moduleId;
    switch (m.type) {
      case "hello.request":
        if (!forMe && m.module_id !== SERIAL_ANY_MODULE) return this.send({ type: "error", code: "invalid_field", uptime_ms: now });
        // Rule 2: stop whatever runs, forget the Pi's seq, say hello.
        if (this.activity !== "none" && this.stopCause === "none") this.startStop("command");
        this.hasAcceptedSeq = false;
        return this.sendHello();
      case "lift.heartbeat":
        if (!forMe) return this.send({ type: "error", code: "invalid_field", uptime_ms: now });
        return this.heartbeat(m.seq, m.hold_request_id, now);
      case "error":
        return;
      case "lift.home":
      case "lift.move":
      case "lift.stop":
      case "lift.enable":
      case "lift.clear":
        if (!forMe) return this.ack(m.request_id, "invalid_field", now);
        return this.command(m, now);
      default:
        return this.send({ type: "error", code: "unsupported", uptime_ms: now });
    }
  }

  private heartbeat(seq: number, hold: string | null, now: number): void {
    // Rule 3: a stale heartbeat is ignored, as if it never arrived.
    if (this.hasAcceptedSeq && seq <= this.lastAcceptedSeq) return;
    this.hasAcceptedSeq = true;
    this.lastAcceptedSeq = seq;
    this.lastHeartbeat = now;
    this.hold = hold;
    // Rule 5: a heartbeat naming anything else than the running request means the person let go.
    if (this.activity !== "none" && this.stopCause === "none" && hold !== this.activeRequest) this.startStop("release");
  }

  private command(m: Extract<LiftSerialMessage, { request_id: string; type: `lift.${string}` }>, now: number): void {
    // Rule 6: stop and disable skip the seq check.
    const always = m.type === "lift.stop" || (m.type === "lift.enable" && !m.enabled);
    if (!always && this.hasAcceptedSeq && m.seq <= this.lastAcceptedSeq) return this.ack(m.request_id, "stale_seq", now);
    switch (m.type) {
      case "lift.home":
      case "lift.move": {
        const refusal = this.motionRefusal(m, now);
        if (refusal) return this.ack(m.request_id, refusal, now);
        this.recordRequest(m.request_id);
        this.activeRequest = m.request_id;
        this.stopCause = "none";
        this.accept(m.seq, m.request_id, now);
        if (m.type === "lift.move") {
          this.activity = "move";
          this.targetMm = m.target_mm;
          if (Math.abs(m.target_mm - this.stepper.position) < 1e-9) return this.finish("completed", null, now);
          this.stepper.moveTo(m.target_mm, m.speed_mm_s, this.config.max_accel_mm_s2);
          return;
        }
        this.homed = false;
        this.activity = "home";
        this.homingStarted = now;
        this.travelBefore = 0;
        const here = this.stepper.position;
        // Rule 7: already on the switch, so skip the fast approach.
        if (this.rawBottom) this.startHoming("back_off", here + HOMING_SEARCH_MM, LIFT_HOMING_SLOW_MM_S);
        else this.startHoming("fast_approach", here - LIFT_HOMING_MAX_TRAVEL_MM, LIFT_HOMING_FAST_MM_S);
        return;
      }
      case "lift.stop":
        this.accept(m.seq, m.request_id, now);
        if (this.activity !== "none" && this.stopCause === "none") this.startStop("command");
        return;
      case "lift.enable":
        if (m.enabled) {
          this.accept(m.seq, m.request_id, now);
          return this.setDriver(true);
        }
        // Rule 6: free the motor only when the carriage can't drop; refused, any motion ramps down as for a stop.
        if (!this.disableSafe && !this.rawBottom) {
          this.ack(m.request_id, "disable_unsafe", now);
          if (this.activity !== "none" && this.stopCause === "none") this.startStop("command");
          return;
        }
        this.accept(m.seq, m.request_id, now);
        if (this.activity !== "none") {
          this.stepper.halt();
          this.finish("stopped", null, now);
        }
        return this.setDriver(false);
      case "lift.clear":
        // Rule 9. The lift stays unhomed.
        if (this.faults.size > 0 && this.causePresent(now)) return this.ack(m.request_id, "cause_present", now);
        this.faults.clear();
        return this.accept(m.seq, m.request_id, now);
    }
  }

  private motionRefusal(m: Extract<LiftSerialMessage, { type: "lift.home" | "lift.move" }>, now: number): LiftAckReason | null {
    // Rule 4, after stale_seq, in order.
    if (this.requestUsed(m.request_id)) return "request_used";
    if (!this.heartbeatFresh(now)) return "no_heartbeat";
    if (this.hold !== m.request_id) return "not_held";
    if (this.stop === "pressed") return "stop_pressed";
    if (this.faults.size > 0) return "fault_latched";
    if (this.activity !== "none") return "busy";
    if (!this.driverEnabled) return "driver_disabled";
    if (m.type !== "lift.move") return null;
    if (!this.homed) return "not_homed";
    if (m.target_mm < this.config.soft_min_mm || m.target_mm > this.config.soft_max_mm || m.speed_mm_s > this.config.max_speed_mm_s) {
      return "out_of_range";
    }
    return null;
  }

  private requestUsed(id: string): boolean {
    const highest = this.prefixes.get(id.slice(0, 6));
    // A prefix not seen since boot starts again, while there is room to remember it.
    if (highest === undefined) return this.prefixes.size >= SIM_LIFT_PREFIXES;
    return Number(id.slice(7)) <= highest;
  }

  private recordRequest(id: string): void {
    const prefix = id.slice(0, 6);
    this.prefixes.set(prefix, Math.max(this.prefixes.get(prefix) ?? 0, Number(id.slice(7))));
  }

  private accept(seq: number, requestId: string, now: number): void {
    // A stale stop or disable never lowers the threshold.
    if (!this.hasAcceptedSeq || seq > this.lastAcceptedSeq) this.lastAcceptedSeq = seq;
    this.hasAcceptedSeq = true;
    this.ack(requestId, null, now);
  }

  // ---- Switches, watchdog, motion (rules 5, 7, 8) ----

  private readSwitches(now: number): void {
    const read = (fault: SimSwitchFault, physical: boolean) => (fault === "ok" ? physical : fault === "stuck_pressed");
    const bottom = read(this.switchFaults.bottom, this.physicalMm <= 0);
    const top = read(this.switchFaults.top, this.physicalMm >= this.topSwitchMm);
    this.stop = !this.stopSenseWired ? "not_wired" : this.stopPressed ? "pressed" : "released";
    this.bottomEdge = bottom && !this.rawBottom;
    if (!bottom) this.bottomStreak = 0;
    else if (this.bottomStreak < 2) {
      if (this.bottomStreak === 0) this.bottomFirstPressed = this.stepper.position;
      this.bottomStreak += 1;
    }
    this.rawBottom = bottom;
    this.rawTop = top;
    if (bottom) {
      this.reportedBottom = true;
      this.bottomReleasedSince = now;
    } else if (now - this.bottomReleasedSince >= SWITCH_RELEASE_MS) this.reportedBottom = false;
    if (top) {
      this.reportedTop = true;
      this.topReleasedSince = now;
    } else if (now - this.topReleasedSince >= SWITCH_RELEASE_MS) this.reportedTop = false;
  }

  private checkSwitches(now: number): void {
    if (this.stop === "pressed") {
      if (this.activity !== "none") return this.failNow("stop_circuit_opened", now);
      this.latch("stop_circuit_opened");
    }
    if (this.rawBottom && this.rawTop) {
      if (this.activity !== "none") return this.failNow("limit_wiring", now);
      return this.latch("limit_wiring");
    }
    if (this.homed && (this.rawBottom || this.rawTop)) {
      if (this.activity !== "none") return this.failNow("limit_hit", now);
      return this.latch("limit_hit");
    }
    if (this.activity !== "home") return;
    if (this.stopCause !== "none") {
      if (this.rawTop || this.bottomEdge) this.failNow("limit_hit", now);
      return;
    }
    if (this.rawTop) this.failNow("homing_failed", now);
  }

  private checkWatchdog(now: number): void {
    if (this.activity === "none") return;
    if (this.activity === "home" && this.stopCause === "none" && now - this.homingStarted >= LIFT_HOMING_TIMEOUT_MS) {
      return this.failNow("homing_failed", now);
    }
    if (this.stopCause === "none" && !this.heartbeatFresh(now)) this.startStop("watchdog");
  }

  private advance(now: number): void {
    if (this.activity === "home" && this.stopCause === "none") {
      const here = this.stepper.position;
      const travelled = Math.abs(here - this.phaseStart);
      if (this.travelBefore + travelled > LIFT_HOMING_MAX_TRAVEL_MM) return this.failNow("homing_failed", now);
      if ((this.phase === "fast_approach" || this.phase === "slow_approach") && this.bottomStreak >= 2) {
        this.stepper.halt();
        this.travelBefore += travelled;
        if (this.phase === "fast_approach") {
          this.startHoming("back_off", this.stepper.position + HOMING_SEARCH_MM, LIFT_HOMING_SLOW_MM_S);
        } else {
          this.stepper.position -= this.bottomFirstPressed; // the first pressed sample is 0 mm
          this.startHoming("final_back_off", HOMING_SEARCH_MM, LIFT_HOMING_SLOW_MM_S);
        }
        return;
      }
      if ((this.phase === "back_off" || this.phase === "final_back_off") && !this.rawBottom && travelled >= LIFT_HOMING_BACKOFF_MM - 1e-9) {
        this.stepper.halt();
        this.travelBefore += travelled;
        if (this.phase === "back_off") {
          this.startHoming("slow_approach", this.stepper.position - HOMING_SEARCH_MM, LIFT_HOMING_SLOW_MM_S);
        } else {
          this.homed = true;
          this.finish("completed", null, now);
        }
        return;
      }
    }
    if (this.activity === "none" || this.stepper.running()) return;
    switch (this.stopCause) {
      case "command":
      case "release":
        return this.finish("stopped", null, now);
      case "watchdog":
        // LIFT_WATCHDOG_DRIVER_ACTION is "hold": the driver stays enabled.
        this.finish("failed", "watchdog_expired", now);
        return this.latch("watchdog_expired");
      case "none":
        break;
    }
    if (this.activity === "move") return this.finish("completed", null, now);
    this.failNow("homing_failed", now); // a homing phase ran its whole distance without what it looked for
  }

  private startHoming(phase: Phase, target: number, speed: number): void {
    this.phase = phase;
    this.phaseStart = this.stepper.position;
    this.stepper.moveTo(target, speed, this.config.max_accel_mm_s2);
  }

  private heartbeatFresh(now: number): boolean {
    return this.lastHeartbeat !== null && now - this.lastHeartbeat < LIFT_WATCHDOG_TIMEOUT_MS;
  }

  private causePresent(now: number): boolean {
    return this.stop === "pressed" || this.rawTop || !this.heartbeatFresh(now);
  }

  private latch(fault: LiftSerialFault): void {
    this.faults.add(fault);
    this.homed = false;
  }

  private startStop(cause: StopCause): void {
    this.stopCause = cause;
    this.stepper.decelerate(LIFT_STOP_DECEL_MM_S2);
  }

  private failNow(fault: LiftSerialFault, now: number): void {
    this.stepper.halt();
    this.finish("failed", fault, now);
    this.latch(fault);
  }

  private finish(outcome: "completed" | "stopped" | "failed", fault: LiftSerialFault | null, now: number): void {
    if (this.activity === "none") return;
    this.activity = "none";
    this.stopCause = "none";
    this.send({
      type: "lift.done",
      request_id: this.activeRequest,
      uptime_ms: now,
      outcome,
      ...(fault ? { fault } : {}),
      position_mm: this.homed ? this.height() : null,
    });
    this.activeRequest = "";
  }

  private setDriver(enabled: boolean): void {
    this.driverEnabled = enabled;
    if (!enabled) this.homed = false;
  }

  private height(): number {
    return Math.min(1000, Math.max(0, Math.round(this.stepper.position * 1000) / 1000));
  }

  private state(): "unhomed" | "homing" | "idle" | "moving" | "stopping" | "fault" {
    if (this.faults.size > 0) return "fault";
    if (this.activity !== "none" && this.stopCause !== "none") return "stopping";
    if (this.activity === "home") return "homing";
    if (this.activity === "move") return "moving";
    return this.homed ? "idle" : "unhomed";
  }

  // ---- Lines to the Pi (rule 10) ----

  private snapshot(now: number): Line {
    const state = this.state();
    // The last back-off's end (home) is known only while below it; past it the end is where the switch releases.
    const finalBackOff = state === "homing" && this.phase === "final_back_off" && this.stepper.position < LIFT_HOMING_BACKOFF_MM;
    const target = state === "moving" ? this.targetMm : finalBackOff ? LIFT_HOMING_BACKOFF_MM : null;
    return {
      type: "lift.status",
      uptime_ms: now,
      state,
      homed: this.homed,
      position_mm: this.homed ? this.height() : null,
      target_mm: target,
      driver_enabled: this.driverEnabled,
      limits: { top: this.reportedTop ? "pressed" : "released", bottom: this.reportedBottom ? "pressed" : "released" },
      stop_sense: this.stop,
      faults: [...this.faults],
      request_id: this.activity !== "none" ? this.activeRequest : null,
      heartbeat_age_ms: this.lastHeartbeat === null ? null : Math.max(0, now - this.lastHeartbeat),
    };
  }

  private sendStatus(now: number): void {
    const s = this.snapshot(now);
    const { uptime_ms: _u, position_mm: _p, heartbeat_age_ms: _h, ...key } = s;
    this.lastStatusKey = JSON.stringify(key);
    this.nextStatus = now + STATUS_INTERVAL_MS;
    this.send(s);
  }

  private maybeSendStatus(now: number): void {
    const s = this.snapshot(now);
    const { uptime_ms: _u, position_mm: _p, heartbeat_age_ms: _h, ...key } = s;
    if (this.lastStatusKey === null || JSON.stringify(key) !== this.lastStatusKey || now >= this.nextStatus) this.sendStatus(now);
  }

  private sendHello(): void {
    this.send({
      type: "lift.hello",
      firmware_version: "sim-lift-0.1.0",
      uptime_ms: this.uptime(),
      config: this.config,
      stop_sense: this.stopSenseWired ? "wired" : "not_wired",
    });
  }

  private ack(requestId: string, reason: LiftAckReason | null, now: number): void {
    this.send({
      type: "lift.ack",
      request_id: requestId,
      result: reason ? "rejected" : "accepted",
      ...(reason ? { reason } : {}),
      uptime_ms: now,
    });
  }

  private send(body: Line): void {
    const line = { v: 1, module_id: this.moduleId, seq: this.seq, ...body };
    // Like the firmware's line builder: a line that wouldn't pass the contract is never sent and uses no seq.
    const parsed = LiftSerialMessageSchema.safeParse(line);
    if (!parsed.success) return;
    this.seq += 1;
    this.sentLines.push(parsed.data);
    if (!this.dropFromLift) this.port.sendLine(line);
  }
}
