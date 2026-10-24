import {
  SERIAL_ANY_MODULE,
  SERIAL_MAX_LINE_BYTES,
  SERIAL_PROTOCOL_VERSION,
  SerialHapticPlaySchema,
  SerialHelloRequestSchema,
  type ModuleId,
  type SerialMessage,
  type SerialModuleType,
} from "@walker/contracts";
import type { Bus, ButtonName } from "../bus";
import type { Clock, Cancel } from "../clock";
import { HELLO_REQUEST_MIN_GAP_MS, MODULE_HEARTBEAT_TIMEOUT_MS, ZONE_VALIDITY_MS } from "../constants";
import type { Logger } from "../log";
import { LineReader } from "./lineReader";

/** One open serial port, real (a tty file) or simulated. */
export interface SerialConnection {
  readonly id: string;
  readonly simulated: boolean;
  /** Writes one line; false when the port is closed or still busy with the previous write (the line is dropped). */
  write(line: string): boolean;
  onData(fn: (data: Buffer) => void): void;
  onClose(fn: (reason: string) => void): void;
  close(): void;
}

export type ModuleHealth = "ok" | "degraded" | "fault" | "unavailable";

export interface ModuleView {
  instanceId: string;
  type: SerialModuleType;
  catalogId: ModuleId;
  capabilities: string[];
  firmwareVersion: string | null;
  health: ModuleHealth;
  faults: string[];
  /** Wall time the Pi last heard from it, for the manifest's `observed_at`. */
  observedAt: number;
  simulated: boolean;
}

export interface ZoneView {
  zone: string;
  instanceId: string;
  mm: number | null;
  quality: "valid" | "invalid";
  receivedMono: number;
  receivedWall: number;
}

/** Fault codes a hand board reports when its haptic driver can't buzz (firmware/lib/module/module_core.cpp). */
export const HAPTIC_FAULTS = ["haptic_missing", "haptic_error"] as const;

/**
 * Whether a buzz sent to this module would be felt: a hand board, healthy (`ok`), that declared `haptic`,
 * with no haptic fault. Anything less and the cue goes to sound instead, so a loose wire never means silence.
 */
export function canBuzz(module: Pick<ModuleView, "type" | "health" | "capabilities" | "faults">): boolean {
  return (
    module.type === "hand" &&
    module.health === "ok" &&
    module.capabilities.includes("haptic") &&
    !module.faults.some((fault) => (HAPTIC_FAULTS as readonly string[]).includes(fault))
  );
}

const CATALOG_ID: Record<SerialModuleType, ModuleId> = {
  hand: "controls.hand",
  perception: "perception.tof",
  voice: "voice",
};

/** Same names everywhere (the design's button map): a hand module declares `button.talk` and `button.confirm`. */
const HAND_BUTTONS: Record<string, ButtonName> = { talk: "talk", confirm: "confirm" };

interface Port {
  conn: SerialConnection;
  instanceId: string | null;
  /** The Pi's own line counter on this port. */
  seq: number;
  ignoredBeforeHello: number;
  badLines: number;
  /** When the Pi last sent this port a `hello.request` (monotonic), or null before the first. */
  lastHelloRequestMono: number | null;
  /** The known module should be asked for a hello, but the request hasn't been written yet (port busy). */
  wantHello: boolean;
  /** A line came from an id another available port holds; logged once. */
  duplicateLogged: boolean;
}

interface ModuleRecord extends ModuleView {
  port: Port;
  lastSeq: number | null;
  droppedLines: number;
  cancelWatchdog: Cancel | null;
}

export interface ModuleManagerDeps {
  clock: Clock;
  log: Logger;
  bus: Bus;
}

/**
 * Tracks every serial module: hello, heartbeats, health, zones and hand input. A module is known only after
 * its hello (its capabilities come from there); lines before that are counted and ignored. If heartbeats
 * stop for MODULE_HEARTBEAT_TIMEOUT_MS, or its port closes, the module becomes `unavailable` and its zones
 * count as unknown.
 *
 * The Pi asks for a hello (`hello.request`) when it opens a port, so a module that kept running while the Pi
 * service restarted still announces itself. It asks again (at most every HELLO_REQUEST_MIN_GAP_MS) while an
 * unknown module keeps talking, and when a module that went unavailable starts sending heartbeats again.
 */
export class ModuleManager {
  private readonly ports = new Set<Port>();
  private readonly records = new Map<string, ModuleRecord>();
  private readonly zones = new Map<string, ZoneView>();
  private requestCounter = 0;

  constructor(private readonly deps: ModuleManagerDeps) {}

  attach(conn: SerialConnection): void {
    const port: Port = {
      conn,
      instanceId: null,
      seq: 0,
      ignoredBeforeHello: 0,
      badLines: 0,
      lastHelloRequestMono: null,
      wantHello: false,
      duplicateLogged: false,
    };
    this.ports.add(port);
    const reader = new LineReader((result) => {
      if (result.ok) this.handle(port, result.message);
      else {
        port.badLines += 1;
        this.deps.log.warn("serial line refused", { port: conn.id, problem: result.problem, detail: result.detail });
      }
    });
    conn.onData((data) => reader.push(data));
    conn.onClose((reason) => this.detach(port, reason));
    this.deps.log.info("serial port opened", { port: conn.id, simulated: conn.simulated });
    this.requestHello(port, SERIAL_ANY_MODULE);
  }

  /**
   * Sends `hello.request` to `target` (`any`, or a known module's own id), unless one went out on this port
   * recently. Returns false when nothing was written (throttled, busy or closed).
   */
  private requestHello(port: Port, target: string): boolean {
    const now = this.deps.clock.monotonic();
    if (port.lastHelloRequestMono !== null && now - port.lastHelloRequestMono < HELLO_REQUEST_MIN_GAP_MS) return false;
    const parsed = SerialHelloRequestSchema.safeParse({
      v: SERIAL_PROTOCOL_VERSION,
      type: "hello.request",
      module_id: target,
      seq: port.seq,
    });
    if (!parsed.success) {
      this.deps.log.error("hello.request failed validation; not sent", { port: port.conn.id });
      return false;
    }
    if (!port.conn.write(`${JSON.stringify(parsed.data)}\n`)) return false;
    port.seq += 1;
    port.lastHelloRequestMono = now;
    return true;
  }

  /** Asks a known module for a fresh hello, and keeps asking on its later lines until the request goes out. */
  private refreshHello(record: ModuleRecord): void {
    record.port.wantHello = !this.requestHello(record.port, record.instanceId);
  }

  modules(): ModuleView[] {
    return [...this.records.values()].map((record) => this.view(record));
  }

  /** Zones the Pi may act on now: valid or invalid readings under ZONE_VALIDITY_MS old, from available modules. */
  currentZones(): ZoneView[] {
    const now = this.deps.clock.monotonic();
    return [...this.zones.values()].filter((zone) => {
      const record = this.records.get(zone.instanceId);
      return record !== undefined && record.health !== "unavailable" && now - zone.receivedMono < ZONE_VALIDITY_MS;
    });
  }

  /** Hand modules a buzz would reach and be felt on (see `canBuzz`). */
  hapticTargets(): ModuleView[] {
    return this.modules().filter(canBuzz);
  }

  /** Sends one `haptic.play`, validated against the shared schema first. Returns false if nothing was sent. */
  sendHaptic(instanceId: string, pattern: "confirmation" | "recording" | "near_obstacle" | "error", durationMs: number): boolean {
    const record = this.records.get(instanceId);
    if (!record || !canBuzz(record)) return false;
    const port = record.port;
    this.requestCounter += 1;
    const parsed = SerialHapticPlaySchema.safeParse({
      v: SERIAL_PROTOCOL_VERSION,
      type: "haptic.play",
      module_id: instanceId,
      seq: port.seq,
      request_id: `cue-${this.requestCounter}`,
      pattern,
      duration_ms: durationMs,
    });
    if (!parsed.success) {
      this.deps.log.error("haptic command failed validation; not sent", { module: instanceId });
      return false;
    }
    const line = `${JSON.stringify(parsed.data)}\n`;
    if (Buffer.byteLength(line) > SERIAL_MAX_LINE_BYTES) return false;
    if (!port.conn.write(line)) {
      this.deps.log.warn("haptic dropped: the port is still busy with the last write", { module: instanceId });
      return false;
    }
    port.seq += 1;
    this.deps.bus.emit("haptic", { instanceId, pattern, durationMs });
    return true;
  }

  private handle(port: Port, message: SerialMessage): void {
    if (message.type === "hello") return this.hello(port, message);
    const record = port.instanceId === message.module_id ? this.records.get(message.module_id) : undefined;
    if (!record) {
      // Another port's available module holds this id (two boards flashed alike): don't ask this one for a
      // hello, or the two would take the id back and forth through the Pi's requests.
      const owner = this.records.get(message.module_id);
      if (owner && owner.port !== port && owner.health !== "unavailable") {
        if (!port.duplicateLogged) {
          port.duplicateLogged = true;
          this.deps.log.error("two modules use the same id; this port is ignored", { module: message.module_id, port: port.conn.id });
        }
        return;
      }
      port.ignoredBeforeHello += 1;
      if (port.ignoredBeforeHello === 1 || port.ignoredBeforeHello % 100 === 0) {
        this.deps.log.warn("serial line from a module that hasn't said hello on this port; ignored", {
          port: port.conn.id,
          type: message.type,
          count: port.ignoredBeforeHello,
        });
      }
      this.requestHello(port, SERIAL_ANY_MODULE);
      return;
    }
    // seq only counts up while a module runs, and starts again when it reboots. A line whose seq went back
    // means it rebooted even if its boot hello was lost: a button it reported as held is no longer held.
    let asked = false;
    if (record.lastSeq !== null && message.seq <= record.lastSeq) {
      this.deps.log.warn("module's seq went back: it rebooted", { module: record.instanceId });
      if (record.type === "hand") this.deps.bus.emit("buttonsLost", { source: "esp32", detail: record.instanceId });
      this.refreshHello(record);
      asked = true;
    } else if (port.wantHello) {
      this.refreshHello(record);
      asked = true;
    }
    this.countSeq(record, message.seq);
    record.observedAt = this.deps.clock.now();
    switch (message.type) {
      case "heartbeat": {
        const wasUnavailable = record.health === "unavailable";
        this.armWatchdog(record);
        this.setHealth(record, message.health, message.faults ?? []);
        // Back after going silent: ask for a fresh hello so its capabilities are current (once per line).
        if (wasUnavailable && !asked) this.refreshHello(record);
        return;
      }
      case "hand.input":
        if (message.button === undefined || message.edge === undefined) return;
        if (record.type !== "hand" || !record.capabilities.includes(`button.${message.button}`)) {
          this.deps.log.warn("button not declared in hello; ignored", { module: record.instanceId, button: message.button });
          return;
        }
        {
          const button = HAND_BUTTONS[message.button];
          if (button) this.deps.bus.emit("button", { button, edge: message.edge, source: "esp32", detail: record.instanceId });
        }
        return;
      case "perception.zones": {
        if (record.type !== "perception") return;
        const receivedMono = this.deps.clock.monotonic();
        const receivedWall = this.deps.clock.now();
        for (const zone of message.zones) {
          this.zones.set(zone.name, {
            zone: zone.name,
            instanceId: record.instanceId,
            mm: zone.mm,
            quality: zone.quality,
            receivedMono,
            receivedWall,
          });
        }
        this.deps.bus.emit("zones", { zones: this.currentZones() });
        return;
      }
      case "ack":
        if (message.result === "rejected") {
          this.deps.log.warn("module rejected a command", { module: record.instanceId, request: message.request_id, reason: message.reason });
        }
        return;
      case "error":
        this.deps.log.warn("module reported an error", { module: record.instanceId, code: message.code });
        return;
      case "haptic.play":
      case "hello.request":
        this.deps.log.warn("module sent a Pi-only command; ignored", { module: record.instanceId, type: message.type });
        return;
    }
  }

  private hello(port: Port, message: Extract<SerialMessage, { type: "hello" }>): void {
    const id = message.module_id;
    const existing = this.records.get(id);
    if (existing && existing.port !== port) {
      this.deps.log.warn("module id seen on a second port; the newer port takes it", { module: id, port: port.conn.id });
      if (existing.port.instanceId === id) existing.port.instanceId = null;
    }
    if (port.instanceId && port.instanceId !== id) this.forget(port.instanceId);
    port.instanceId = id;
    port.wantHello = false;
    // A module answering a hello.request keeps its seq running; a reboot starts it again (or it moved ports).
    // Only a reboot means a button it reported as held is no longer held.
    const rebooted = existing !== undefined && (existing.port !== port || message.seq <= (existing.lastSeq ?? -1));
    if (existing?.type === "hand" && rebooted) this.deps.bus.emit("buttonsLost", { source: "esp32", detail: id });
    const record: ModuleRecord = {
      instanceId: id,
      type: message.module_type,
      catalogId: CATALOG_ID[message.module_type],
      capabilities: [...message.capabilities],
      firmwareVersion: message.firmware_version ?? null,
      health: existing?.health === "unavailable" || !existing ? "ok" : existing.health,
      faults: existing?.health === "unavailable" ? [] : (existing?.faults ?? []),
      observedAt: this.deps.clock.now(),
      simulated: port.conn.simulated,
      port,
      lastSeq: message.seq,
      droppedLines: 0,
      cancelWatchdog: existing?.cancelWatchdog ?? null,
    };
    this.records.set(id, record);
    this.armWatchdog(record);
    this.deps.log.info("module said hello", {
      module: id,
      type: message.module_type,
      firmware: record.firmwareVersion,
      simulated: record.simulated,
    });
    this.deps.bus.emit("module", { instanceId: id, health: record.health });
  }

  private countSeq(record: ModuleRecord, seq: number): void {
    if (record.lastSeq !== null && seq > record.lastSeq + 1) record.droppedLines += seq - record.lastSeq - 1;
    record.lastSeq = seq;
  }

  private armWatchdog(record: ModuleRecord): void {
    record.cancelWatchdog?.();
    record.cancelWatchdog = this.deps.clock.setTimeout(() => {
      record.cancelWatchdog = null;
      this.markUnavailable(record, "heartbeat_timeout");
    }, MODULE_HEARTBEAT_TIMEOUT_MS);
  }

  private setHealth(record: ModuleRecord, health: ModuleHealth, faults: string[]): void {
    const changed = record.health !== health;
    record.health = health;
    record.faults = [...faults];
    if (changed) this.deps.bus.emit("module", { instanceId: record.instanceId, health });
  }

  private markUnavailable(record: ModuleRecord, reason: "heartbeat_timeout" | "disconnected"): void {
    record.cancelWatchdog?.();
    record.cancelWatchdog = null;
    if (record.health === "unavailable") return;
    record.health = "unavailable";
    record.faults = [reason];
    this.deps.log.warn("module unavailable", { module: record.instanceId, reason });
    this.deps.bus.emit("module", { instanceId: record.instanceId, health: "unavailable" });
    // Emitted once per transition from available to unavailable.
    this.deps.bus.emit("moduleDown", { module: this.view(record), reason });
    if (record.type === "hand") this.deps.bus.emit("buttonsLost", { source: "esp32", detail: record.instanceId });
  }

  private detach(port: Port, reason: string): void {
    this.ports.delete(port);
    this.deps.log.warn("serial port closed", { port: port.conn.id, reason });
    if (port.instanceId) {
      const record = this.records.get(port.instanceId);
      if (record && record.port === port) this.markUnavailable(record, "disconnected");
    }
  }

  private forget(instanceId: string): void {
    const record = this.records.get(instanceId);
    record?.cancelWatchdog?.();
    this.records.delete(instanceId);
  }

  private view(record: ModuleRecord): ModuleView {
    return {
      instanceId: record.instanceId,
      type: record.type,
      catalogId: record.catalogId,
      capabilities: [...record.capabilities],
      firmwareVersion: record.firmwareVersion,
      health: record.health,
      faults: [...record.faults],
      observedAt: record.observedAt,
      simulated: record.simulated,
    };
  }

  /** Stops every watchdog (service shutdown). */
  stop(): void {
    for (const record of this.records.values()) record.cancelWatchdog?.();
    for (const port of this.ports) port.conn.close();
  }
}
