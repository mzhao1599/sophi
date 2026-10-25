import { randomInt } from "node:crypto";
import {
  HOLD_CONTROL_REFRESH_MS,
  LIFT_HEARTBEAT_INTERVAL_MS,
  LIFT_HOMING_TIMEOUT_MS,
  LIFT_STATUS_STALE_MS,
  motionTimeoutMs,
  type LiftAckReason,
  type LiftConfig,
  type LiftInstallation,
  type LiftSerialFault,
  type LiftSerialMessage,
  type LiftState,
  type MotionFaultCode,
  type MotionRefusal,
} from "@walker/contracts";
import { LIFT_ACK_TIMEOUT_MS, LIFT_STOP_RETRIES } from "../../constants";
import type { Logger } from "../../log";
import type { LiftLineHandler, LiftPiLine, LiftPortLink } from "../../serial/liftPort";
import { liftMoveSpeed, liftVerdict, sameLiftConfig, type LiftAction, type LiftCheckInputs, type LiftView } from "./preconditions";

type Hello = Extract<LiftSerialMessage, { type: "lift.hello" }>;
type Status = Extract<LiftSerialMessage, { type: "lift.status" }>;
type Ack = Extract<LiftSerialMessage, { type: "lift.ack" }>;
type Done = Extract<LiftSerialMessage, { type: "lift.done" }>;

/** How a lift home or move ended, as the coordinator hears it. */
export type LiftRequestOutcome =
  /** The lift's own `lift.done` outcomes. */
  | "completed"
  | "stopped"
  | "failed"
  /** Refused, by the lift's ack (`reason` is its LiftAckReason) or because the hold went before it was sent. */
  | "refused"
  /** No ack within LIFT_ACK_TIMEOUT_MS; a lift.stop was sent. */
  | "no_ack"
  /** Past its deadline; a lift.stop was sent and `motion_timeout` reported. */
  | "timeout"
  /** The lift went quiet, its port closed, or it stopped running the request without a `lift.done` the Pi saw. */
  | "lost";

export type LiftMotionKind = "lift.home" | "lift.move";

export type LiftEvent =
  /** The lift is heard (hello and fresh status) or not. */
  | { type: "link"; connected: boolean }
  | { type: "accepted"; requestId: string; kind: LiftMotionKind }
  | {
      type: "ended";
      requestId: string;
      kind: LiftMotionKind;
      outcome: LiftRequestOutcome;
      reason?: LiftAckReason | "not_held";
      fault?: LiftSerialFault;
    }
  /** A fault for the coordinator to latch (a lift fault newly seen, or one the client raises). */
  | { type: "fault"; code: MotionFaultCode }
  /** What a `lift.clear` got. */
  | { type: "clear"; outcome: "cleared" | "refused" | "no_ack"; reason?: LiftAckReason }
  /**
   * What a `lift.enable` false got: `disabled` (the motor is free, the lift unhomed), or `refused` (for example
   * `disable_unsafe`: the carriage could drop, so the driver stays enabled).
   */
  | { type: "disable"; outcome: "disabled" | "refused" | "no_ack"; reason?: LiftAckReason };

export interface LiftClientDeps {
  log: Logger;
  /** The Pi's lift configuration and installation record (MotionSetup.lift). */
  setup: { config: LiftConfig; installation: LiftInstallation };
  /** Bench mode (MOTION_BENCH_ENV), read once at start. */
  bench: boolean;
  /** Explicit no-switch demo: the ESP32 journals counted position and reports it as an estimate. */
  unswitchedLiftDemo?: boolean;
  /** The Pi's monotonic clock, the same one `tick(now)` is given, to stamp received lines. */
  monotonic: () => number;
  /** The lift to drive. Default `lift-01`. */
  moduleId?: string;
  /** A new per-boot request-id prefix: six lowercase letters or digits. Default random. */
  newPrefix?: () => string;
}

/** The running lift motion, for MotionState.active. `starting` until the lift acks it. */
export interface LiftActive {
  requestId: string;
  kind: LiftMotionKind;
  phase: "starting" | "running" | "stopping";
  /** Whether the hold lease still names it (false once released or stopped: it never resumes). */
  held: boolean;
  target_mm: number | null;
}

interface Request {
  id: string;
  kind: LiftMotionKind;
  target_mm: number | null;
  speed_mm_s: number | null;
  phase: "queued" | "sent" | "running" | "stopping";
  /** The hold went (or a stop came): it is never named in a heartbeat again. */
  released: boolean;
  /** The lift acked it accepted: only then can a status that doesn't name it mean it ended unseen. */
  acked: boolean;
  sentAt: number | null;
  deadline: number | null;
}

/** A stop, enable or clear the Pi wrote and is waiting to hear acked. */
interface Awaiting {
  kind: "stop" | "enable_on" | "enable_off" | "clear";
  writtenAt: number;
  tries: number;
}

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
function randomPrefix(): string {
  let out = "";
  for (let i = 0; i < 6; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out;
}

const MOVING_STATES = new Set(["moving", "homing", "stopping"]);

/**
 * The Pi side of the lift (packages/contracts/src/lift-serial.ts, rules 1 to 10; motion.ts for the policy).
 * SIMULATED ONLY so far: tested against `src/sim/fakeLift.ts`, never against the lift board. The motion
 * coordinator (src/motion/coordinator.ts) drives it: README.md, "Wired into the coordinator".
 *
 * The motion coordinator owns Confirm targets and presses, faults and the motion state; this client owns the
 * lift's serial lines. It sends nothing on a timer of its own: the coordinator's control loop calls
 * `tick(now)` (every MOTION_CONTROL_PERIOD_MS), and only that writes heartbeats and commands, so a stuck loop
 * stops the heartbeat and the lift's own watchdog stops the lift. `stop()` and `disable()` write at once
 * (and again from the next tick if the port was busy). AGENTS.md rule 8 for the lift:
 *   - Authorization and user initiation: a home or move starts only from `start`, which the coordinator calls
 *     after a handle Confirm press on that lift target; `start` re-checks the preconditions (`liftVerdict`).
 *   - Hold-to-run: each heartbeat names the request (the hold lease) only while the screen's hold control was
 *     refreshed within HOLD_CONTROL_REFRESH_MS; once it lapses or a stop comes, the request is never named again.
 *   - Range, speed and deadline: soft limits from the configuration (and the firmware's own, which must match:
 *     `lift_config_mismatch`); speed the lower of the configuration's and MOTION_LIMITS'; a deadline of
 *     LIFT_HOMING_TIMEOUT_MS or motionTimeoutMs(distance / speed), then `lift.stop` and `motion_timeout`.
 *   - Cancellation: `stop()` (any motion.stop), a released hold, or any fault the coordinator latches (it
 *     calls `stop()`).
 *   - Lost communication: no `lift.status` for LIFT_STATUS_STALE_MS is `lift_module_lost`: heartbeats stop,
 *     so the lift stops on its own watchdog within LIFT_WATCHDOG_TIMEOUT_MS.
 */
export class LiftClient implements LiftLineHandler {
  private readonly moduleId: string;
  private readonly newPrefix: () => string;
  private prefix: string;
  private counter = 0;
  private listeners: Array<(event: LiftEvent) => void> = [];

  private link: LiftPortLink | null = null;
  private hello: Hello | null = null;
  /** A hello must be heard again before heartbeats resume (after a loss or a reboot). */
  private needHello = true;
  private configOk: boolean | null = null;
  private status: Status | null = null;
  /** When the Pi last heard the lift (a hello or a status), on its monotonic clock. */
  private heardAt: number | null = null;
  private lost = false;
  private connectedReported = false;
  private lastLiftSeq: number | null = null;
  private knownFaults = new Set<LiftSerialFault>();
  private strayStopped: string | null = null;
  private wrongIdLogged = false;

  /** Homed in the Pi's view: set by a completed lift.home, cleared by anything that may have moved it uncounted. */
  private piHomed = false;
  private holdAt: number | null = null;
  private holdReleasedAt = -Infinity;
  private request: Request | null = null;
  /** Lines to write before the next heartbeat (stops first). */
  private outbox: Array<{ id: string; line: LiftPiLine; kind: Awaiting["kind"]; tries: number }> = [];
  private awaiting = new Map<string, Awaiting>();
  private lastHeartbeatAt: number | null = null;
  /** The next tick writes a heartbeat whatever the cadence (the lease changed). */
  private heartbeatNow = false;
  private now = 0;

  constructor(private readonly deps: LiftClientDeps) {
    this.moduleId = deps.moduleId ?? "lift-01";
    this.newPrefix = deps.newPrefix ?? randomPrefix;
    this.prefix = this.newPrefix();
  }

  /** The Pi's lift configuration and installation record, as given (the motion setup's `lift`). */
  get setup(): { config: LiftConfig; installation: LiftInstallation } {
    return this.deps.setup;
  }

  on(listener: (event: LiftEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  // ---- Inputs from the coordinator ----

  /** The screen's hold control said "still held" at `atMono` (the Pi's monotonic clock). */
  holdRefresh(atMono: number): void {
    if (atMono <= this.holdReleasedAt) return; // older than a release already seen
    if (this.holdAt === null || atMono > this.holdAt) this.holdAt = atMono;
  }

  /** The screen's hold control was released (any of SCREEN_HOLD_RELEASE_EVENTS) at `atMono`. */
  holdRelease(atMono: number): void {
    this.holdAt = null;
    this.holdReleasedAt = Math.max(this.holdReleasedAt, atMono);
  }

  /** Whether a lift action may be prepared as a Confirm target, or started now: null, or why not. */
  verdict(action: LiftAction, inputs: LiftCheckInputs, stage: "prepare" | "start", nowMono: number): MotionRefusal | null {
    return liftVerdict(this.view(nowMono), action, inputs, stage);
  }

  /**
   * Starts a confirmed lift.home or lift.move (after the handle Confirm press on its target). Re-checks the
   * start verdict; if it passes, the next tick writes the heartbeat naming the new request, then the command.
   */
  start(
    action: Extract<LiftAction, { kind: LiftMotionKind }>,
    inputs: LiftCheckInputs,
    nowMono: number,
  ): { ok: true; requestId: string } | { ok: false; refusal: MotionRefusal } {
    const refusal = this.verdict(action, inputs, "start", nowMono);
    if (refusal) return { ok: false, refusal };
    const id = this.nextId();
    this.request = {
      id,
      kind: action.kind,
      target_mm: action.kind === "lift.move" ? action.target_mm : null,
      speed_mm_s: action.kind === "lift.move" ? liftMoveSpeed(this.deps.setup.config, this.deps.bench) : null,
      phase: "queued",
      released: false,
      acked: false,
      sentAt: null,
      deadline: null,
    };
    this.deps.log.info("lift request queued", { request: id, kind: action.kind, target_mm: this.request.target_mm });
    return { ok: true, requestId: id };
  }

  /** Stops the lift now: `lift.stop` (always accepted, rule 6). Any running request is never named again. */
  stop(): boolean {
    const request = this.request;
    if (request) {
      request.released = true;
      this.heartbeatNow = true;
      if (request.phase === "queued") this.end(request, "stopped");
      else request.phase = "stopping";
    }
    if (!this.outbox.some((o) => o.kind === "stop")) this.queue({ kind: "stop" });
    return this.flushOutbox();
  }

  /**
   * A confirmed lift.disable: `lift.enable` false, only when `liftMayDisable`. Never a stop (use `stop()`). If the
   * lift accepts, the motor frees and the lift is unhomed (firmware and Pi); it may still refuse
   * `disable_unsafe` (rule 6), and then stays enabled and homed. Allowed with a fault latched.
   */
  disable(inputs: LiftCheckInputs, nowMono: number): { ok: true } | { ok: false; refusal: MotionRefusal } {
    const refusal = this.verdict({ kind: "lift.disable" }, inputs, "start", nowMono);
    if (refusal) return { ok: false, refusal };
    this.queue({ kind: "enable_off" });
    this.flushOutbox();
    return { ok: true };
  }

  /** Relays a confirmed local fault.clear as `lift.clear` (next tick). False if the lift isn't heard. */
  clearFaults(): boolean {
    if (!this.link || this.lost) return false;
    this.queue({ kind: "clear" });
    return true;
  }

  /** The coordinator latched a fault in FAULTS_THAT_UNHOME_LIFT from elsewhere (its own stop-sense, say). */
  markUnhomed(): void {
    this.piHomed = false;
  }

  /** The coordinator's control loop, every MOTION_CONTROL_PERIOD_MS. The only place heartbeats come from. */
  tick(nowMono: number): void {
    this.now = nowMono;
    if (this.link && !this.lost && this.heardAt !== null && nowMono - this.heardAt >= LIFT_STATUS_STALE_MS) {
      this.loseLift("no lift.status");
    }
    const request = this.request;
    if (request) {
      const held = this.holdFresh(nowMono);
      if (request.phase === "queued" && (!held || !this.canHeartbeat())) {
        this.end(request, "refused", { reason: "not_held" });
      } else if (!request.released && !held) {
        this.deps.log.info("lift hold let go: stopping", { request: request.id });
        request.released = true;
        request.phase = "stopping";
        this.heartbeatNow = true;
      }
      if (this.request && request.deadline !== null && nowMono >= request.deadline) {
        this.deps.log.warn("lift request past its deadline: stopping", { request: request.id });
        this.queue({ kind: "stop" });
        this.end(request, "timeout");
        this.emit({ type: "fault", code: "motion_timeout" });
      } else if (this.request && !request.acked && request.sentAt !== null && nowMono - request.sentAt >= LIFT_ACK_TIMEOUT_MS) {
        this.deps.log.warn("lift request never acked: stopping", { request: request.id });
        this.queue({ kind: "stop" });
        this.end(request, "no_ack");
      }
    }
    this.checkAwaiting(nowMono);
    this.write(nowMono);
  }

  // ---- What the coordinator reads ----

  /** The lift as MotionState.lift (motion.ts LiftStateSchema). */
  state(nowMono: number): LiftState {
    const status = this.status;
    const connected = this.view(nowMono).fresh && status !== null;
    const faults = new Set<MotionFaultCode>(status && connected ? status.faults : []);
    if (this.configOk === false) faults.add("lift_config_mismatch");
    if (this.lost) faults.add("lift_module_lost");
    if (!connected || !status) {
      return {
        connected: false,
        homed: false,
        position_mm: null,
        target_mm: null,
        moving: null,
        driver_enabled: null,
        limits: { top: "unknown", bottom: "unknown" },
        faults: [...faults],
      };
    }
    const homed = this.piHomed && status.homed;
    const moving = MOVING_STATES.has(status.state);
    return {
      connected: true,
      homed,
      position_mm: homed ? status.position_mm : null,
      target_mm: moving ? status.target_mm : null,
      moving,
      driver_enabled: status.driver_enabled,
      limits: { ...status.limits },
      faults: [...faults],
    };
  }

  /** The lift motion running now, or null. */
  active(): LiftActive | null {
    const r = this.request;
    if (!r) return null;
    return {
      requestId: r.id,
      kind: r.kind,
      phase: r.phase === "queued" || r.phase === "sent" ? "starting" : r.phase,
      held: !r.released,
      target_mm: r.target_mm,
    };
  }

  /** The latest `lift.status`, as received (null before one). */
  lastStatus(): Status | null {
    return this.status;
  }

  // ---- Lines from the lift (LiftLineHandler) ----

  liftLine(link: LiftPortLink, message: LiftSerialMessage): void {
    if (!("module_id" in message) || message.module_id !== this.moduleId) {
      if (!this.wrongIdLogged) {
        this.wrongIdLogged = true;
        this.deps.log.warn("a lift board with another id is ignored", { port: link.portId, expected: this.moduleId });
      }
      return;
    }
    if (this.link !== link) {
      if (this.link && !this.lost) {
        this.deps.log.warn("a second port speaks for the lift; ignored", { port: link.portId });
        return;
      }
      this.link = link;
      this.needHello = true;
      this.lastLiftSeq = null;
    }
    const now = this.deps.monotonic();
    // The lift's seq only counts up while it runs; going back means it rebooted (its hello may have been lost).
    const rebooted = this.lastLiftSeq !== null && message.seq <= this.lastLiftSeq;
    this.lastLiftSeq = message.seq;
    if (rebooted) this.liftRebooted(message.type !== "lift.hello");
    switch (message.type) {
      case "lift.hello":
        return this.onHello(message, now);
      case "lift.status":
        return this.onStatus(message, now);
      case "lift.ack":
        return this.onAck(message);
      case "lift.done":
        return this.onDone(message);
      case "error":
        this.deps.log.warn("the lift reported an error", { code: message.code });
        return;
      default:
        this.deps.log.warn("the lift sent a Pi-only line; ignored", { type: message.type });
    }
  }

  liftLineRefused(link: LiftPortLink, problem: string): void {
    this.deps.log.warn("lift line refused", { port: link.portId, problem });
  }

  liftPortClosed(link: LiftPortLink, reason: string): void {
    if (link !== this.link) return;
    this.deps.log.warn("lift port closed", { port: link.portId, reason });
    this.loseLift("port closed");
    this.link = null;
  }

  // ---- Internals ----

  private onHello(hello: Hello, now: number): void {
    this.hello = hello;
    this.heardAt = now;
    this.needHello = false;
    if (this.lost) {
      this.lost = false;
      this.deps.log.info("lift heard again");
    }
    const ok = sameLiftConfig(hello.config, this.deps.setup.config);
    if (!ok) {
      this.deps.log.error("the lift's built-in settings differ from the walker's: lift motion refused", {
        lift: JSON.stringify(hello.config),
        walker: JSON.stringify(this.deps.setup.config),
      });
      this.emit({ type: "fault", code: "lift_config_mismatch" });
    }
    this.configOk = ok;
    // A hello answers a hello.request (which stops whatever ran, rule 2) or is a boot: nothing of ours resumes.
    if (this.request && this.request.phase !== "queued") {
      this.request.released = true;
      this.request.phase = "stopping";
    }
  }

  private onStatus(status: Status, now: number): void {
    this.status = status;
    this.heardAt = now;
    if (this.needHello || this.lost) {
      // Heard again without a fresh hello: ask for one (throttled by the port); heartbeats wait for it.
      this.link?.requestHello(this.moduleId);
      return;
    }
    if (!this.connectedReported) {
      this.connectedReported = true;
      this.emit({ type: "link", connected: true });
    }
    if (this.deps.unswitchedLiftDemo && status.homed && status.faults.length === 0 &&
        !MOVING_STATES.has(status.state) && this.request === null) this.piHomed = true;
    const latched = new Set(status.faults);
    for (const fault of status.faults) {
      if (!this.knownFaults.has(fault)) {
        this.deps.log.warn("the lift latched a fault", { fault });
        this.piHomed = false;
        this.emit({ type: "fault", code: fault });
      }
    }
    this.knownFaults = latched;
    if (!status.homed && this.piHomed) {
      this.piHomed = false;
      if (status.faults.length === 0 && this.request?.kind !== "lift.home") this.emit({ type: "fault", code: "lift_unhomed" });
    }
    const request = this.request;
    const ours = request && request.phase !== "queued" ? request.id : null;
    if (MOVING_STATES.has(status.state) && status.request_id !== null && status.request_id !== ours) {
      if (this.strayStopped !== status.request_id) {
        this.strayStopped = status.request_id;
        this.deps.log.warn("the lift is running a request the walker isn't: stopping it", { request: status.request_id });
        this.stop();
      }
    }
    // Acked, but the lift no longer names it, and no lift.done arrived: we lost track of how it ended. Before the
    // ack, a status that doesn't name it is just older than the command (a stop may already have followed it).
    // Not knowing how it ended, the Pi stops the lift, counts it unhomed and reports `lift_unhomed` (it must home
    // again before it moves).
    if (request && request.acked && status.request_id !== request.id) {
      this.deps.log.warn("the lift stopped running a request without a lift.done the walker saw: stopping, unhomed", { request: request.id });
      this.stop();
      this.end(request, "lost");
      this.piHomed = false;
      this.emit({ type: "fault", code: "lift_unhomed" });
    }
  }

  private onAck(ack: Ack): void {
    const request = this.request;
    if (request && ack.request_id === request.id) {
      if (ack.result === "accepted") {
        request.acked = true;
        if (request.phase === "sent") request.phase = request.released ? "stopping" : "running";
        this.emit({ type: "accepted", requestId: request.id, kind: request.kind });
        return;
      }
      this.rejected(ack.reason);
      this.end(request, "refused", ack.reason ? { reason: ack.reason } : {});
      return;
    }
    const waiting = this.awaiting.get(ack.request_id);
    if (!waiting) return;
    this.awaiting.delete(ack.request_id);
    if (ack.result === "rejected") {
      this.rejected(ack.reason);
      this.deps.log.warn("the lift refused a command", { kind: waiting.kind, reason: ack.reason });
      const reason = ack.reason ? { reason: ack.reason } : {};
      if (waiting.kind === "clear") this.emit({ type: "clear", outcome: "refused", ...reason });
      if (waiting.kind === "enable_off") this.emit({ type: "disable", outcome: "refused", ...reason });
      return;
    }
    if (waiting.kind === "clear") {
      this.knownFaults.clear();
      this.emit({ type: "clear", outcome: "cleared" });
    } else if (waiting.kind === "enable_off") {
      this.piHomed = false;
      this.emit({ type: "disable", outcome: "disabled" });
    }
  }

  private rejected(reason: LiftAckReason | undefined): void {
    if (reason === "stale_seq") this.link?.requestHello(this.moduleId); // resets the lift's seq memory (rule 2)
    if (reason === "request_used") {
      // The lift has seen this prefix go higher (a prefix repeated by chance): start a new one. The lift also
      // refuses a new prefix once it remembers 16 since it booted; then only restarting the lift board helps.
      this.deps.log.warn("the lift refused a request id as used; if this repeats, restart the lift board (it remembers 16 walker restarts)");
      let prefix = this.newPrefix();
      for (let i = 0; i < 5 && prefix === this.prefix; i += 1) prefix = this.newPrefix();
      this.prefix = prefix;
      this.counter = 0;
    }
  }

  private onDone(done: Done): void {
    const request = this.request;
    if (!request || done.request_id !== request.id) return;
    if (done.outcome === "completed" && request.kind === "lift.home") this.piHomed = true;
    this.end(request, done.outcome, done.fault ? { fault: done.fault } : {});
  }

  private end(request: Request, outcome: LiftRequestOutcome, extra: { reason?: LiftAckReason | "not_held"; fault?: LiftSerialFault } = {}): void {
    if (this.request !== request) return;
    this.request = null;
    this.heartbeatNow = true;
    this.deps.log.info("lift request ended", { request: request.id, kind: request.kind, outcome, reason: extra.reason, fault: extra.fault });
    this.emit({ type: "ended", requestId: request.id, kind: request.kind, outcome, ...extra });
  }

  private liftRebooted(helloLost: boolean): void {
    this.deps.log.warn("the lift restarted", { hello_seen: !helloLost });
    if (this.piHomed) this.emit({ type: "fault", code: "lift_unhomed" });
    this.piHomed = false;
    this.knownFaults.clear();
    if (this.request) this.end(this.request, "lost");
    if (helloLost) {
      this.needHello = true;
      this.link?.requestHello(this.moduleId);
    }
  }

  private loseLift(why: string): void {
    if (this.lost) return;
    this.lost = true;
    this.needHello = true;
    this.piHomed = false;
    this.deps.log.warn("lift lost: heartbeats stop, so the lift stops on its own watchdog", { why });
    this.emit({ type: "fault", code: "lift_module_lost" });
    if (this.connectedReported) {
      this.connectedReported = false;
      this.emit({ type: "link", connected: false });
    }
    if (this.request) {
      this.stop(); // best effort: the link may be one-way
      if (this.request) this.end(this.request, "lost");
    }
  }

  private canHeartbeat(): boolean {
    return this.link !== null && !this.lost && !this.needHello;
  }

  private holdFresh(now: number): boolean {
    return this.holdAt !== null && this.holdAt <= now && now - this.holdAt <= HOLD_CONTROL_REFRESH_MS;
  }

  private view(now: number): LiftView {
    const status = this.status;
    const fresh = this.link !== null && !this.lost && !this.needHello && this.heardAt !== null && now - this.heardAt < LIFT_STATUS_STALE_MS;
    return {
      bench: this.deps.bench,
      unswitchedLiftDemo: this.deps.unswitchedLiftDemo === true,
      config: this.deps.setup.config,
      installation: this.deps.setup.installation,
      heard: this.hello !== null && this.link !== null,
      fresh,
      configOk: this.configOk,
      liftStopSense: this.hello?.stop_sense ?? null,
      statusStop: status?.stop_sense ?? null,
      liftFaults: status ? status.faults : [],
      busy: this.request !== null || (status !== null && MOVING_STATES.has(status.state)),
      homed: this.piHomed && status?.homed === true,
      bottomPressed: status?.limits.bottom === "pressed",
      held: this.holdFresh(now),
    };
  }

  private nextId(): string {
    this.counter += 1;
    return `${this.prefix}-${this.counter}`;
  }

  private queue(item: { kind: Awaiting["kind"]; tries?: number }): void {
    const id = this.nextId();
    const line: LiftPiLine =
      item.kind === "stop"
        ? { type: "lift.stop", module_id: this.moduleId, request_id: id }
        : item.kind === "clear"
          ? { type: "lift.clear", module_id: this.moduleId, request_id: id }
          : { type: "lift.enable", module_id: this.moduleId, request_id: id, enabled: item.kind === "enable_on" };
    // Stops go first, so a stop never lands after a command it was meant to precede.
    if (item.kind === "stop") this.outbox.unshift({ id, line, kind: item.kind, tries: item.tries ?? 0 });
    else this.outbox.push({ id, line, kind: item.kind, tries: item.tries ?? 0 });
  }

  /** Writes what is queued now (stop, disable), outside the tick; whatever doesn't go waits for the tick. */
  private flushOutbox(): boolean {
    if (!this.link || this.outbox.length === 0) return false;
    if (!this.link.send(this.outbox.map((o) => o.line))) return false;
    this.sent(this.outbox.splice(0), this.deps.monotonic());
    return true;
  }

  private sent(items: typeof this.outbox, now: number): void {
    for (const item of items) this.awaiting.set(item.id, { kind: item.kind, writtenAt: now, tries: item.tries });
  }

  private checkAwaiting(now: number): void {
    for (const [id, waiting] of this.awaiting) {
      if (now - waiting.writtenAt < LIFT_ACK_TIMEOUT_MS) continue;
      this.awaiting.delete(id);
      if (waiting.kind === "stop" && waiting.tries + 1 < LIFT_STOP_RETRIES + 1 && !this.lost && this.link) {
        this.deps.log.warn("lift.stop not acked: sending it again", { tries: waiting.tries + 1 });
        if (!this.outbox.some((o) => o.kind === "stop")) this.queue({ kind: "stop", tries: waiting.tries + 1 });
      } else if (waiting.kind === "clear") {
        this.emit({ type: "clear", outcome: "no_ack" });
      } else if (waiting.kind === "enable_off") {
        this.emit({ type: "disable", outcome: "no_ack" });
      }
    }
  }

  /** One write per tick: queued stops and commands, then the heartbeat (if due), then a new request's command. */
  private write(now: number): void {
    if (!this.link) return;
    const lines: LiftPiLine[] = this.outbox.map((o) => o.line);
    const request = this.request;
    let heartbeat = false;
    let command = false;
    let enableId: string | null = null;
    if (this.canHeartbeat()) {
      const starting = request?.phase === "queued";
      command = starting && request !== null && this.configOk === true;
      // The driver goes on only in the same write as the move it is for (never from a refused tick or a stop).
      if (command && this.status && !this.status.driver_enabled) {
        enableId = this.nextId();
        lines.push({ type: "lift.enable", module_id: this.moduleId, request_id: enableId, enabled: true });
      }
      const due = this.lastHeartbeatAt === null || now - this.lastHeartbeatAt >= LIFT_HEARTBEAT_INTERVAL_MS;
      if (due || this.heartbeatNow || starting) {
        heartbeat = true;
        // THE LEASE: the request is named only while the person holds the screen's control (checked this tick).
        const lease = request && !request.released && this.holdFresh(now) ? request.id : null;
        lines.push({ type: "lift.heartbeat", module_id: this.moduleId, hold_request_id: lease });
      }
      if (command && request) {
        lines.push(
          request.kind === "lift.home"
            ? { type: "lift.home", module_id: this.moduleId, request_id: request.id }
            : {
                type: "lift.move",
                module_id: this.moduleId,
                request_id: request.id,
                target_mm: request.target_mm ?? 0,
                speed_mm_s: request.speed_mm_s ?? 0,
              },
        );
      }
    }
    if (lines.length === 0) return;
    if (!this.link.send(lines)) return; // busy or closed: everything waits for the next tick
    this.sent(this.outbox.splice(0), now);
    if (enableId) this.awaiting.set(enableId, { kind: "enable_on", writtenAt: now, tries: 0 });
    if (heartbeat) {
      this.lastHeartbeatAt = now;
      this.heartbeatNow = false;
    }
    if (command && request) {
      request.phase = "sent";
      request.sentAt = now;
      // Homing starts by losing the height it had: the Pi counts it unhomed until this homing completes.
      if (request.kind === "lift.home") this.piHomed = false;
      const from = this.status?.position_mm ?? null;
      request.deadline =
        request.kind === "lift.home"
          ? now + LIFT_HOMING_TIMEOUT_MS
          : now + motionTimeoutMs(((from === null ? 0 : Math.abs((request.target_mm ?? 0) - from)) / (request.speed_mm_s ?? 1)) * 1000);
      this.deps.log.info("lift request sent", { request: request.id, kind: request.kind });
    }
  }

  private emit(event: LiftEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
