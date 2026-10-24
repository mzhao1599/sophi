import { LIFT_STATUS_HZ, SERIAL_ANY_MODULE, parseLiftSerialLine, parseSerialLine, type SerialMessage } from "@walker/contracts";
import type { Cancel, Clock } from "../clock";
import type { SerialConnection } from "../serial/modules";

/**
 * Simulated ESP32 modules for `walker simulate` and tests. They speak serial v1 JSON Lines through the same
 * line reader and module manager as real ports, and every part they create is reported as `simulated`.
 */
export class SimulatedPort implements SerialConnection {
  readonly simulated = true;
  private dataHandlers: Array<(data: Buffer) => void> = [];
  private closeHandlers: Array<(reason: string) => void> = [];
  private closed = false;
  /** Lines the Pi wrote to this module. */
  readonly received: string[] = [];
  onPiLine: (line: string) => void = () => {};

  constructor(readonly id: string) {}

  /** When true, the port acts busy and refuses writes, like a stalled real port. */
  busy = false;

  write(line: string): boolean {
    if (this.closed || this.busy) return false;
    this.received.push(line);
    queueMicrotask(() => this.onPiLine(line));
    return true;
  }

  onData(fn: (data: Buffer) => void): void {
    this.dataHandlers.push(fn);
  }

  onClose(fn: (reason: string) => void): void {
    this.closeHandlers.push(fn);
  }

  close(): void {
    this.unplug("closed by the Pi");
  }

  /** Module side: send raw bytes to the Pi. */
  sendRaw(data: Buffer | string): void {
    if (this.closed) return;
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    for (const fn of this.dataHandlers) fn(bytes);
  }

  sendLine(message: object): void {
    this.sendRaw(`${JSON.stringify(message)}\n`);
  }

  unplug(reason = "unplugged"): void {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.closeHandlers) fn(reason);
  }
}

abstract class SimulatedModule {
  /** What its heartbeats report, as real firmware would (for example `degraded` with `haptic_error`). */
  health: "ok" | "degraded" | "fault" = "ok";
  faults: string[] = [];
  protected seq = 0;
  private cancels: Cancel[] = [];
  private running = false;
  private bootMono = 0;

  constructor(
    readonly port: SimulatedPort,
    readonly moduleId: string,
    protected readonly clock: Clock,
  ) {
    port.onPiLine = (line) => {
      const parsed = parseSerialLine(line);
      if (!parsed.ok) {
        this.send({ type: "error", code: parsed.problem });
        return;
      }
      // A running module answers a hello.request addressed to it (or to "any"), keeping its seq running.
      if (parsed.message.type === "hello.request") {
        const target = parsed.message.module_id;
        if (this.running && (target === SERIAL_ANY_MODULE || target === this.moduleId)) this.sendHello();
        return;
      }
      this.onPiMessage(parsed.message);
    };
  }

  protected onPiMessage(_message: SerialMessage): void {}

  private sendHello(): void {
    this.send({ type: "hello", ...this.hello(), firmware_version: "sim-0.1.0", uptime_ms: this.uptime() });
  }

  protected abstract hello(): Record<string, unknown>;
  protected tick(): void {}
  protected readonly tickMs: number | null = null;

  protected send(message: Record<string, unknown>): void {
    this.port.sendLine({ v: 1, module_id: this.moduleId, seq: this.seq++, ...message });
  }

  protected uptime(): number {
    return Math.max(0, Math.round(this.clock.monotonic() - this.bootMono));
  }

  /** Boots: hello, then a heartbeat every second and the module's own reports. */
  start(): void {
    this.stopTimers();
    this.running = true;
    this.seq = 0;
    this.bootMono = this.clock.monotonic();
    this.sendHello();
    const heartbeat = () => {
      if (!this.running) return;
      this.send({ type: "heartbeat", uptime_ms: this.uptime(), health: this.health, ...(this.faults.length ? { faults: this.faults } : {}) });
      this.cancels.push(this.clock.setTimeout(heartbeat, 1000));
    };
    this.cancels.push(this.clock.setTimeout(heartbeat, 1000));
    if (this.tickMs !== null) {
      const ms = this.tickMs;
      const loop = () => {
        if (!this.running) return;
        this.tick();
        this.cancels.push(this.clock.setTimeout(loop, ms));
      };
      this.cancels.push(this.clock.setTimeout(loop, ms));
    }
  }

  /** Goes silent without closing the port, as a hung board would. */
  hang(): void {
    this.running = false;
    this.stopTimers();
  }

  get isRunning(): boolean {
    return this.running;
  }

  private stopTimers(): void {
    for (const cancel of this.cancels) cancel();
    this.cancels = [];
  }
}

/** A hand control with Talk and Confirm buttons and a haptic motor; it acks every valid haptic.play. */
export class SimulatedHand extends SimulatedModule {
  onHaptic: (pattern: string, durationMs: number) => void = () => {};

  protected override onPiMessage(message: SerialMessage): void {
    if (message.type === "haptic.play") {
      this.send({ type: "ack", request_id: message.request_id, result: "accepted" });
      this.onHaptic(message.pattern, message.duration_ms);
    }
  }

  /** False models a board whose haptic driver didn't answer at boot: its hello leaves out `haptic`. */
  hasHaptic = true;

  protected hello() {
    return { module_type: "hand", capabilities: ["button.talk", "button.confirm", "trigger", ...(this.hasHaptic ? ["haptic"] : [])] };
  }

  press(button: "talk" | "confirm", edge: "pressed" | "released"): void {
    this.send({ type: "hand.input", uptime_ms: this.uptime(), button, edge });
  }
}

export type SimulatedReading = { mm: number } | "invalid";

/** A ToF module with two zones, reporting at 10 Hz. */
export class SimulatedTof extends SimulatedModule {
  protected override readonly tickMs = 100;
  readings: Record<"front_left" | "front_right", SimulatedReading> = {
    front_left: { mm: 1500 },
    front_right: { mm: 1500 },
  };

  protected hello() {
    return { module_type: "perception", capabilities: ["zones"] };
  }

  protected override tick(): void {
    this.send({
      type: "perception.zones",
      uptime_ms: this.uptime(),
      zones: Object.entries(this.readings).map(([name, reading]) =>
        reading === "invalid" ? { name, mm: null, quality: "invalid" } : { name, mm: reading.mm, quality: "valid" },
      ),
    });
  }
}

/**
 * A lift board for `walker check --sim` and its tests: it answers `hello.request` with `lift.hello` and sends
 * `lift.status` at LIFT_STATUS_HZ. It has no motion at all: it never homes or moves, and records every line
 * the Pi sends (`port.received`) so a test can show the check sent nothing but `hello.request`. Its `hello`
 * and `status` bodies (without v, module_id and seq) can be replaced, for example by the contract's fixtures.
 */
export class SimulatedLift {
  hello: Record<string, unknown> = {
    type: "lift.hello",
    firmware_version: "sim-0.1.0",
    uptime_ms: 0,
    config: { microsteps: 8, soft_min_mm: 5, soft_max_mm: 600, max_speed_mm_s: 20, max_accel_mm_s2: 50, top_switch_mm: null },
    stop_sense: "wired",
  };
  status: Record<string, unknown> = {
    type: "lift.status",
    uptime_ms: 0,
    state: "unhomed",
    homed: false,
    position_mm: null,
    target_mm: null,
    driver_enabled: true,
    limits: { top: "released", bottom: "released" },
    stop_sense: "released",
    faults: [],
    request_id: null,
    heartbeat_age_ms: null,
  };
  private seq = 0;
  private cancel: Cancel | null = null;

  constructor(
    readonly port: SimulatedPort,
    readonly moduleId: string,
    private readonly clock: Clock,
  ) {
    port.onPiLine = (line) => {
      const parsed = parseLiftSerialLine(line);
      if (parsed.ok && parsed.message.type === "hello.request") this.send(this.hello);
    };
  }

  private send(body: Record<string, unknown>): void {
    this.port.sendLine({ v: 1, module_id: this.moduleId, seq: this.seq++, ...body });
  }

  start(): void {
    this.hang();
    this.send(this.hello);
    const loop = () => {
      this.send(this.status);
      this.cancel = this.clock.setTimeout(loop, 1000 / LIFT_STATUS_HZ);
    };
    this.cancel = this.clock.setTimeout(loop, 1000 / LIFT_STATUS_HZ);
  }

  hang(): void {
    this.cancel?.();
    this.cancel = null;
  }
}
