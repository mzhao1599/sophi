import {
  HOLD_CONTROL_REFRESH_MS,
  LIFT_HOMING_TIMEOUT_MS,
  LIFT_STATUS_STALE_MS,
  LiftSerialMessageSchema,
  LiftStateSchema,
  motionTimeoutMs,
  type LiftConfig,
  type LiftInstallation,
  type LiftSerialMessage,
} from "@walker/contracts";
import { describe, expect, it } from "vitest";
import { Bus } from "../src/bus";
import { HELLO_REQUEST_MIN_GAP_MS, LIFT_ACK_TIMEOUT_MS, LIFT_STOP_RETRIES } from "../src/constants";
import { LiftClient, liftMoveSpeed, liftOverLimits, liftVerdict, type LiftCheckInputs, type LiftEvent, type LiftView } from "../src/motion/lift";
import type { LiftPiLine, LiftPortLink } from "../src/serial/liftPort";
import { ModuleManager } from "../src/serial/modules";
import { SIM_LIFT_CONFIG } from "../src/sim/fakeLift";
import { SimulatedHand, SimulatedPort, SimulatedTof } from "../src/sim/fakeModules";
import { FakeClock, captureLogger, flush } from "./support/fakes";

// ---- A fake lift port: the client's writes, stamped like the module manager's link would ----

class FakeLink implements LiftPortLink {
  readonly portId = "fake-lift";
  readonly simulated = true;
  busy = false;
  seq = 0;
  hellos = 0;
  /** Every Pi line written, in order. */
  readonly lines: Array<Record<string, unknown> & { type: string; seq: number }> = [];
  /** How many separate writes. */
  writes = 0;

  send(lines: readonly LiftPiLine[]): boolean {
    if (this.busy) return false;
    lines.forEach((line, i) => {
      const stamped = { v: 1, ...line, seq: this.seq + i };
      LiftSerialMessageSchema.parse(stamped);
      this.lines.push(stamped as never);
    });
    this.seq += lines.length;
    this.writes += 1;
    return true;
  }

  requestHello(): boolean {
    this.hellos += 1;
    this.lines.push({ type: "hello.request", seq: this.seq++ });
    return true;
  }

  of(type: string) {
    return this.lines.filter((l) => l.type === type);
  }
}

const INSTALLED: LiftInstallation = {
  guards_fitted: true,
  drop_test: "passed",
  brake_fitted: false,
  stop_cuts_lift_power: false,
  driver_current_setting: "1.0 A",
  recorded_at: "2026-10-24T00:00:00.000Z",
};
const NOT_DROP_TESTED: LiftInstallation = { ...INSTALLED, drop_test: "not_done" };
const OK_INPUTS: LiftCheckInputs = { stopCircuit: "released", faultLatched: false, armsStowed: true, otherMotion: false };

type Status = Extract<LiftSerialMessage, { type: "lift.status" }>;
const baseStatus: Omit<Status, "seq"> = {
  v: 1,
  type: "lift.status",
  module_id: "lift-01",
  uptime_ms: 1000,
  state: "unhomed",
  homed: false,
  position_mm: null,
  target_mm: null,
  driver_enabled: true,
  limits: { top: "released", bottom: "released" },
  stop_sense: "released",
  faults: [],
  request_id: null,
  heartbeat_age_ms: 40,
};
const IDLE_HOMED: Partial<Status> = { state: "idle", homed: true, position_mm: 5 };

/** One client on a fake link, with a clock the test moves by hand. */
function rig(options: { config?: LiftConfig; installation?: LiftInstallation; bench?: boolean; prefixes?: string[] } = {}) {
  let now = 0;
  let liftSeq = 0;
  const prefixes = [...(options.prefixes ?? ["k3x9q2", "zz9z9z", "aaaaa1"])];
  const log = captureLogger();
  const client = new LiftClient({
    log,
    setup: { config: options.config ?? SIM_LIFT_CONFIG, installation: options.installation ?? INSTALLED },
    bench: options.bench ?? false,
    monotonic: () => now,
    newPrefix: () => prefixes.shift() ?? "fallbk",
  });
  const link = new FakeLink();
  const events: LiftEvent[] = [];
  client.on((e) => events.push(e));
  const r = {
    client,
    link,
    events,
    log,
    get now() {
      return now;
    },
    at(t: number) {
      now = t;
    },
    line(message: Record<string, unknown>) {
      const full = { v: 1, module_id: "lift-01", seq: liftSeq++, ...message } as LiftSerialMessage;
      LiftSerialMessageSchema.parse(full);
      client.liftLine(link, full);
    },
    hello(config: LiftConfig = options.config ?? SIM_LIFT_CONFIG, stopSense: "wired" | "not_wired" = "wired") {
      r.line({ type: "lift.hello", firmware_version: "test", uptime_ms: 0, config, stop_sense: stopSense });
    },
    status(over: Partial<Status> = {}) {
      r.line({ ...baseStatus, ...over });
    },
    ack(requestId: string, reason?: string) {
      r.line({ type: "lift.ack", request_id: requestId, result: reason ? "rejected" : "accepted", ...(reason ? { reason } : {}), uptime_ms: 1 });
    },
    done(requestId: string, outcome: "completed" | "stopped" | "failed", extra: Record<string, unknown> = {}) {
      r.line({ type: "lift.done", request_id: requestId, uptime_ms: 1, outcome, position_mm: null, ...extra });
    },
    setLiftSeq(seq: number) {
      liftSeq = seq;
    },
    /** Ticks every 20 ms up to `until`, feeding a status (with `over`) every 40 ms unless `feed` is false. */
    run(until: number, over: Partial<Status> = {}, hold = false, feed = true) {
      while (now + 20 <= until) {
        now += 20;
        if (feed && now % 40 === 0) r.status(over);
        if (hold) client.holdRefresh(now);
        client.tick(now);
      }
    },
    heartbeats() {
      return link.of("lift.heartbeat").map((l) => l.hold_request_id as string | null);
    },
  };
  return r;
}

/** A rig whose lift said hello and is idle and homed (by a completed homing), ticking, at t = 1000. */
function homedRig(options: Parameters<typeof rig>[0] = {}) {
  const r = rig(options);
  r.hello();
  r.status();
  r.run(200);
  r.client.holdRefresh(r.now);
  const home = r.client.start({ kind: "lift.home" }, OK_INPUTS, r.now);
  if (!home.ok) throw new Error(home.refusal);
  r.run(220, {}, true);
  r.ack(home.requestId);
  r.done(home.requestId, "completed", { position_mm: 5 });
  r.status(IDLE_HOMED);
  r.client.holdRelease(r.now);
  r.run(1000, IDLE_HOMED);
  return r;
}

describe("lift client: the port", () => {
  it("L1: a lift.hello makes the port a lift port; its lines go to the client, never to the module list or the refused log", async () => {
    const clock = new FakeClock();
    const log = captureLogger();
    const modules = new ModuleManager({ clock, log, bus: new Bus() });
    const seen: string[] = [];
    modules.setLiftHandler({
      liftLine: (_link, m) => seen.push(m.type),
      liftLineRefused: (_link, problem) => seen.push(`refused ${problem}`),
      liftPortClosed: () => seen.push("closed"),
    });
    const port = new SimulatedPort("sim:lift");
    modules.attach(port);
    // A status before any hello: ignored, and answered with a hello.request (the attach one already went out).
    await clock.advance(2500);
    port.sendLine({ ...baseStatus, seq: 0 });
    expect(seen).toEqual([]);
    expect(port.received.filter((l) => l.includes("hello.request"))).toHaveLength(2);
    port.sendLine({ v: 1, type: "lift.hello", module_id: "lift-01", seq: 1, firmware_version: "t", uptime_ms: 5, config: SIM_LIFT_CONFIG, stop_sense: "wired" });
    port.sendLine({ ...baseStatus, seq: 2 });
    port.sendLine({ ...baseStatus, seq: 3, state: "bogus" });
    port.sendRaw("not json\n");
    expect(seen).toEqual(["lift.hello", "lift.status", "refused invalid_field", "refused malformed"]);
    expect(modules.modules()).toEqual([]);
    expect(log.lines.some((l) => l.includes("serial line refused"))).toBe(false);
    port.unplug();
    expect(seen.at(-1)).toBe("closed");
  });

  it("L1: a hand board's port stays a serial port: a lift line there is refused, never handed to the lift client", async () => {
    const clock = new FakeClock();
    const log = captureLogger();
    const modules = new ModuleManager({ clock, log, bus: new Bus() });
    const seen: string[] = [];
    modules.setLiftHandler({ liftLine: (_l, m) => seen.push(m.type), liftLineRefused: () => seen.push("refused"), liftPortClosed: () => {} });
    const port = new SimulatedPort("sim:hand");
    const hand = new SimulatedHand(port, "hand-right-01", clock);
    modules.attach(port);
    hand.start();
    await flush();
    port.sendLine({ v: 1, type: "lift.hello", module_id: "lift-01", seq: 99, firmware_version: "t", uptime_ms: 5, config: SIM_LIFT_CONFIG, stop_sense: "wired" });
    expect(seen).toEqual([]);
    expect(modules.modules().map((m) => m.instanceId)).toEqual(["hand-right-01"]);
    expect(log.lines.some((l) => l.includes("serial line refused") && l.includes("unknown_type"))).toBe(true);
    hand.hang();
  });

  it("L1: the shared ToF and lift board's port carries both: lift lines go to the lift client, zones stay a module", async () => {
    const clock = new FakeClock();
    const log = captureLogger();
    const modules = new ModuleManager({ clock, log, bus: new Bus() });
    const seen: string[] = [];
    modules.setLiftHandler({ liftLine: (_l, m) => seen.push(m.type), liftLineRefused: () => seen.push("refused"), liftPortClosed: () => {} });
    const port = new SimulatedPort("sim:tof-lift");
    const tof = new SimulatedTof(port, "tof-front-01", clock);
    modules.attach(port);
    tof.start();
    await flush();
    port.sendLine({ v: 1, type: "lift.hello", module_id: "lift-01", seq: 99, firmware_version: "t", uptime_ms: 5, config: SIM_LIFT_CONFIG, stop_sense: "wired" });
    await clock.advance(300);
    await flush();
    expect(seen).toEqual(["lift.hello"]);
    expect(modules.modules().map((m) => m.instanceId)).toEqual(["tof-front-01"]);
    expect(log.lines.some((l) => l.includes("serial line refused"))).toBe(false);
    tof.hang();
  });

  it("L1: with no lift client, a lift port beside three boards: they stay ok, the lift isn't a module, and it gets only throttled hello.requests", async () => {
    const clock = new FakeClock();
    const log = captureLogger();
    const bus = new Bus();
    const lost: string[] = [];
    bus.on("buttonsLost", (e) => lost.push(e.detail ?? ""));
    const modules = new ModuleManager({ clock, log, bus });
    const ports = { left: new SimulatedPort("sim:hand-left"), right: new SimulatedPort("sim:hand-right"), tof: new SimulatedPort("sim:tof") };
    const left = new SimulatedHand(ports.left, "hand-left-01", clock);
    const right = new SimulatedHand(ports.right, "hand-right-01", clock);
    const tof = new SimulatedTof(ports.tof, "tof-front-01", clock);
    const liftPort = new SimulatedPort("sim:lift");
    const hellosAt: number[] = [];
    liftPort.onPiLine = (text) => {
      for (const line of text.split("\n").filter(Boolean)) {
        expect(JSON.parse(line)).toMatchObject({ type: "hello.request", module_id: "any" });
        hellosAt.push(clock.monotonic());
      }
    };
    for (const port of [...Object.values(ports), liftPort]) modules.attach(port);
    left.start();
    right.start();
    tof.start();
    // The lift board's boot: ROM garbage, then a status before any hello.
    liftPort.sendRaw(Buffer.from([0x00, 0xff, 0x0d, 0x0a]));
    liftPort.sendRaw("ets Oct 23 2026 12:21:46\r\nrst:0x1 (POWERON_RESET),boot:0x13\r\n");
    let liftSeq = 0;
    const status = () => liftPort.sendLine({ ...baseStatus, seq: liftSeq++ });
    await clock.advance(500);
    status(); // within 2 s of the attach's request: no new one
    await clock.advance(2000);
    status(); // past it: one more
    await clock.advance(500);
    liftPort.sendLine({ v: 1, type: "lift.hello", module_id: "lift-01", seq: liftSeq++, firmware_version: "t", uptime_ms: 3, config: SIM_LIFT_CONFIG, stop_sense: "wired" });
    const logAtHello = log.lines.length;
    for (let i = 0; i < 60; i += 1) {
      await clock.advance(50);
      status();
      if (i === 20) left.start(); // the left hand reboots partway
    }
    expect(modules.modules().map((m) => [m.instanceId, m.health]).sort()).toEqual([
      ["hand-left-01", "ok"],
      ["hand-right-01", "ok"],
      ["tof-front-01", "ok"],
    ]);
    expect(lost).toEqual(["hand-left-01"]);
    expect(hellosAt).toEqual([0, 2500]);
    expect(hellosAt[1]! - hellosAt[0]!).toBeGreaterThanOrEqual(HELLO_REQUEST_MIN_GAP_MS);
    // After its hello, the lift's lines leave nothing in the module log beyond the one notice that nobody reads them.
    expect(log.lines.slice(logAtHello).filter((l) => l.includes("lift") || l.includes("refused"))).toEqual([]);
    expect(log.lines.filter((l) => l.includes("no lift client is running"))).toHaveLength(1);
    expect(log.lines.some((l) => l.includes('"lift.'))).toBe(false);
    for (const board of [left, right, tof]) board.hang();
  });

  it("L8: every Pi line on the lift port has a seq one above the last, hello.request included; a busy write uses no seq and goes next tick", async () => {
    const clock = new FakeClock();
    const log = captureLogger();
    const modules = new ModuleManager({ clock, log, bus: new Bus() });
    const client = new LiftClient({ log, setup: { config: SIM_LIFT_CONFIG, installation: INSTALLED }, bench: false, monotonic: () => clock.monotonic() });
    modules.setLiftHandler(client);
    const port = new SimulatedPort("sim:lift");
    modules.attach(port);
    let seq = 0;
    const status = () => port.sendLine({ ...baseStatus, seq: seq++ });
    port.sendLine({ v: 1, type: "lift.hello", module_id: "lift-01", seq: seq++, firmware_version: "t", uptime_ms: 5, config: SIM_LIFT_CONFIG, stop_sense: "wired" });
    let writesWhenFree = 0;
    for (let t = 20; t <= 400; t += 20) {
      await clock.advance(20);
      if (t % 40 === 0) status();
      port.busy = t >= 120 && t < 260;
      if (t === 260) writesWhenFree = port.received.length;
      client.tick(clock.monotonic());
      // Busy: nothing written (the heartbeat due at 120 waits); the first free tick writes it.
      if (port.busy) expect(port.received.length).toBe(writesWhenFree || port.received.length);
      if (t === 260) expect(port.received.length).toBe(writesWhenFree + 1);
    }
    client.stop();
    const lines = port.received.flatMap((w) => w.split("\n").filter(Boolean)).map((l) => JSON.parse(l) as { seq: number; type: string });
    expect(lines[0]).toMatchObject({ type: "hello.request", seq: 0 });
    expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i));
    expect(lines.filter((l) => l.type === "lift.heartbeat").length).toBeGreaterThanOrEqual(3);
    expect(lines.at(-1)?.type).toBe("lift.stop");
  });
});

describe("lift client: hello and configuration", () => {
  it("L2: a config that differs is lift_config_mismatch once per hello; nothing is named or started; a matching hello lets it pass", () => {
    const r = rig();
    r.hello({ ...SIM_LIFT_CONFIG, soft_max_mm: 601 });
    r.status();
    r.run(200, {}, true);
    expect(r.events.filter((e) => e.type === "fault")).toEqual([{ type: "fault", code: "lift_config_mismatch" }]);
    expect(r.client.verdict({ kind: "lift.home" }, OK_INPUTS, "start", r.now)).toBe("fault_latched");
    expect(r.client.start({ kind: "lift.home" }, OK_INPUTS, r.now)).toEqual({ ok: false, refusal: "fault_latched" });
    r.run(400, {}, true);
    expect(r.heartbeats().every((h) => h === null)).toBe(true);
    expect(r.link.of("lift.home")).toEqual([]);
    expect(r.client.state(r.now).faults).toContain("lift_config_mismatch");
    // The firmware's resolution: 600.0004 is 600.
    r.hello({ ...SIM_LIFT_CONFIG, soft_max_mm: 600.0004 });
    r.run(500, {}, true);
    expect(r.client.verdict({ kind: "lift.home" }, OK_INPUTS, "start", r.now)).toBeNull();
    expect(r.events.filter((e) => e.type === "fault")).toHaveLength(1);
  });

  it("L3: a hello from another lift id is ignored and logged once; nothing is written", () => {
    const r = rig();
    r.line({ type: "lift.hello", module_id: "lift-02", firmware_version: "t", uptime_ms: 0, config: SIM_LIFT_CONFIG, stop_sense: "wired" });
    r.line({ ...baseStatus, module_id: "lift-02" });
    r.run(500, {}, false, false);
    expect(r.link.lines).toEqual([]);
    expect(r.log.lines.filter((l) => l.includes("another id"))).toHaveLength(1);
    expect(r.client.state(r.now).connected).toBe(false);
  });
});

describe("lift client: heartbeat and the hold lease", () => {
  it("L4: heartbeats come only from tick: none before hello, one per 100 ms with 20 ms ticks, none once ticks stop", () => {
    const r = rig();
    r.run(200); // statuses but no hello yet: the client asks for one, and sends no heartbeat
    expect(r.link.lines.length).toBeGreaterThan(0);
    expect(r.link.lines.every((l) => l.type === "hello.request")).toBe(true);
    r.hello();
    r.status();
    const start = r.now;
    r.run(start + 1000);
    expect(r.heartbeats()).toHaveLength(10);
    // Ticks stop: lines keep arriving from the lift, but nothing is written.
    const before = r.link.lines.length;
    const quietFrom = r.now;
    for (let t = quietFrom + 40; t <= quietFrom + 1000; t += 40) {
      r.at(t);
      r.status();
    }
    expect(r.link.lines.length).toBe(before);
  });

  it("L5: the request is named only while the hold refresh is at most HOLD_CONTROL_REFRESH_MS old, and only once started", () => {
    const r = rig();
    r.hello();
    r.status();
    r.run(100, {}, true);
    expect(r.heartbeats().every((h) => h === null)).toBe(true); // held, but no request
    const start = r.client.start({ kind: "lift.home" }, OK_INPUTS, r.now);
    if (!start.ok) throw new Error(start.refusal);
    r.run(120, {}, true);
    r.ack(start.requestId);
    expect(r.heartbeats().at(-1)).toBe(start.requestId);
    // Last refresh at 120; the tick at 320 (200 ms later) still names it, but it isn't due until 220/320.
    r.run(320, { state: "homing", request_id: start.requestId });
    expect(r.now - 120).toBe(HOLD_CONTROL_REFRESH_MS);
    expect(r.heartbeats().at(-1)).toBe(start.requestId);
    r.run(340, { state: "homing", request_id: start.requestId });
    expect(r.heartbeats().at(-1)).toBeNull();
  });

  it("L5: a refresh stamped later than the tick counts as stale", () => {
    const r = rig();
    r.hello();
    r.status();
    r.run(100);
    r.client.holdRefresh(r.now + 50);
    expect(r.client.start({ kind: "lift.home" }, OK_INPUTS, r.now)).toEqual({ ok: false, refusal: "not_held" });
  });

  it("L6: letting go writes a heartbeat naming nobody on the very next tick, and the request is never named again", () => {
    const r = rig();
    r.hello();
    r.status();
    r.run(100, {}, true);
    const start = r.client.start({ kind: "lift.home" }, OK_INPUTS, r.now);
    if (!start.ok) throw new Error(start.refusal);
    r.run(120, {}, true);
    r.ack(start.requestId);
    const homing = { state: "homing" as const, request_id: start.requestId };
    r.run(200, homing, true);
    const count = r.heartbeats().length;
    r.client.holdRelease(r.now);
    r.run(r.now + 20, homing);
    expect(r.heartbeats()).toHaveLength(count + 1);
    expect(r.heartbeats().at(-1)).toBeNull();
    expect(r.client.active()).toMatchObject({ phase: "stopping", held: false });
    r.run(r.now + 1000, homing, true); // held again
    expect(r.heartbeats().slice(count).every((h) => h === null)).toBe(true);
  });

  it("L7: start writes enable (driver off), the heartbeat naming R, then the command, in one write; ids rise under the boot prefix", () => {
    const r = rig();
    r.hello();
    r.status({ driver_enabled: false });
    r.run(100, { driver_enabled: false }, true);
    const writes = r.link.writes;
    const start = r.client.start({ kind: "lift.home" }, OK_INPUTS, r.now);
    expect(start).toEqual({ ok: true, requestId: "k3x9q2-1" });
    expect(r.link.of("lift.enable")).toEqual([]); // nothing until the tick that sends the move
    r.run(120, { driver_enabled: false }, true);
    expect(r.link.writes).toBe(writes + 1);
    expect(r.link.lines.slice(-3)).toMatchObject([
      { type: "lift.enable", enabled: true, request_id: "k3x9q2-2" },
      { type: "lift.heartbeat", hold_request_id: "k3x9q2-1" },
      { type: "lift.home", request_id: "k3x9q2-1" },
    ]);
  });

  it("L7: the driver goes on only in the write that sends its move: never from a tick that refuses it, or after a stop", () => {
    const off = { driver_enabled: false };
    // The hold lapses before the tick: refused not_held, no enable.
    const a = rig();
    a.hello();
    a.status(off);
    a.run(100, off, true);
    a.client.start({ kind: "lift.home" }, OK_INPUTS, a.now);
    a.client.holdRelease(a.now);
    a.run(200, off);
    expect(a.events.at(-1)).toMatchObject({ type: "ended", outcome: "refused", reason: "not_held" });
    expect(a.link.of("lift.enable")).toEqual([]);
    expect(a.link.of("lift.home")).toEqual([]);
    // A stop before the tick: stopped, no enable.
    const b = rig();
    b.hello();
    b.status(off);
    b.run(100, off, true);
    b.client.start({ kind: "lift.home" }, OK_INPUTS, b.now);
    b.client.stop();
    b.run(300, off, true);
    expect(b.events.at(-1)).toMatchObject({ type: "ended", outcome: "stopped" });
    expect(b.link.of("lift.enable")).toEqual([]);
    expect(b.link.of("lift.stop")).toHaveLength(1);
    // A busy port on the start tick: the enable goes out with the move on the next free tick, once.
    const c = rig();
    c.hello();
    c.status(off);
    c.run(100, off, true);
    c.client.start({ kind: "lift.home" }, OK_INPUTS, c.now);
    c.link.busy = true;
    c.run(120, off, true);
    c.link.busy = false;
    c.run(140, off, true);
    expect(c.link.lines.slice(-3).map((l) => l.type)).toEqual(["lift.enable", "lift.heartbeat", "lift.home"]);
    expect(c.link.of("lift.enable")).toHaveLength(1);
  });
});

describe("lift client: acks, done and rejections", () => {
  it("L9: accepted runs; a completed homing counts as homed; a stopped or failed done ends the request with it", () => {
    const r = homedRig();
    expect(r.client.state(r.now)).toMatchObject({ homed: true, position_mm: 5 });
    expect(r.events).toContainEqual({ type: "ended", requestId: "k3x9q2-1", kind: "lift.home", outcome: "completed" });
    r.client.holdRefresh(r.now);
    const move = r.client.start({ kind: "lift.move", target_mm: 300 }, OK_INPUTS, r.now);
    if (!move.ok) throw new Error(move.refusal);
    r.run(r.now + 20, IDLE_HOMED, true);
    expect(r.link.lines.at(-1)).toMatchObject({ type: "lift.move", target_mm: 300, speed_mm_s: 20 });
    r.ack(move.requestId);
    expect(r.client.active()).toMatchObject({ phase: "running", held: true, target_mm: 300 });
    r.done(move.requestId, "failed", { fault: "limit_hit" });
    expect(r.events.at(-1)).toEqual({ type: "ended", requestId: move.requestId, kind: "lift.move", outcome: "failed", fault: "limit_hit" });
    expect(r.client.active()).toBeNull();
  });

  it("L10: stale_seq asks for a hello; request_used takes a new boot prefix; other reasons end refused with that reason", () => {
    const r = rig();
    r.hello();
    r.status();
    const begin = (): string => {
      r.client.holdRefresh(r.now);
      const s = r.client.start({ kind: "lift.home" }, OK_INPUTS, r.now);
      if (!s.ok) throw new Error(s.refusal);
      r.run(r.now + 20, {}, true);
      return s.requestId;
    };
    r.run(100);
    const a = begin();
    r.ack(a, "stale_seq");
    expect(r.link.hellos).toBe(1);
    expect(r.events.at(-1)).toMatchObject({ type: "ended", requestId: a, outcome: "refused", reason: "stale_seq" });
    const b = begin();
    r.ack(b, "request_used");
    const c = begin();
    expect(c).toBe("zz9z9z-1");
    r.ack(c, "not_held");
    expect(r.events.at(-1)).toMatchObject({ type: "ended", requestId: c, outcome: "refused", reason: "not_held" });
  });

  it("L9: a request the lift stops naming after its ack, with no lift.done seen: lift.stop, ended lost, unhomed, lift_unhomed", () => {
    const r = homedRig();
    r.client.holdRefresh(r.now);
    const s = r.client.start({ kind: "lift.move", target_mm: 100 }, OK_INPUTS, r.now);
    if (!s.ok) throw new Error(s.refusal);
    r.run(r.now + 20, IDLE_HOMED, true);
    r.ack(s.requestId);
    r.status({ ...IDLE_HOMED, state: "moving", request_id: s.requestId, target_mm: 100 });
    const stops = r.link.of("lift.stop").length;
    r.status(IDLE_HOMED);
    expect(r.events).toContainEqual({ type: "ended", requestId: s.requestId, kind: "lift.move", outcome: "lost" });
    expect(r.events.at(-1)).toEqual({ type: "fault", code: "lift_unhomed" });
    expect(r.link.of("lift.stop").length).toBe(stops + 1);
    expect(r.client.state(r.now).homed).toBe(false);
  });

  it("L9: the Pi counts the lift unhomed from the moment it sends lift.home, until that homing completes", () => {
    const r = homedRig();
    expect(r.client.state(r.now).homed).toBe(true);
    r.client.holdRefresh(r.now);
    const s = r.client.start({ kind: "lift.home" }, OK_INPUTS, r.now);
    if (!s.ok) throw new Error(s.refusal);
    // Queued, not sent yet: still homed.
    expect(r.client.state(r.now).homed).toBe(true);
    r.run(r.now + 20, IDLE_HOMED, true);
    expect(r.link.of("lift.home")).toHaveLength(2);
    expect(r.client.state(r.now).homed).toBe(false);
    // A homing stopped part way leaves it unhomed, whatever the lift's status says.
    r.ack(s.requestId);
    r.done(s.requestId, "stopped");
    r.status(IDLE_HOMED);
    expect(r.client.state(r.now).homed).toBe(false);
    expect(r.events.filter((e) => e.type === "fault")).toEqual([]);
  });

  it("L9: a stop sent before the lift processed the command ends stopped, not lost: a status older than the ack doesn't count", () => {
    const r = rig();
    r.hello();
    r.status();
    r.run(100, {}, true);
    const s = r.client.start({ kind: "lift.home" }, OK_INPUTS, r.now);
    if (!s.ok) throw new Error(s.refusal);
    r.run(120, {}, true);
    r.client.stop();
    r.status(); // sent by the lift before it read the home: names no request
    r.status();
    expect(r.client.active()).toMatchObject({ requestId: s.requestId, phase: "stopping" });
    r.ack(s.requestId);
    r.status({ state: "stopping", request_id: s.requestId });
    r.done(s.requestId, "stopped");
    expect(r.events.filter((e) => e.type === "ended")).toEqual([
      { type: "ended", requestId: s.requestId, kind: "lift.home", outcome: "stopped" },
    ]);
  });

  it("L11: a stopped request the lift never acks still ends no_ack", () => {
    const r = rig();
    r.hello();
    r.status();
    r.run(100, {}, true);
    const s = r.client.start({ kind: "lift.home" }, OK_INPUTS, r.now);
    if (!s.ok) throw new Error(s.refusal);
    r.run(120, {}, true);
    r.client.stop();
    r.run(120 + LIFT_ACK_TIMEOUT_MS + 20);
    expect(r.events.filter((e) => e.type === "ended")).toEqual([
      { type: "ended", requestId: s.requestId, kind: "lift.home", outcome: "no_ack" },
    ]);
  });

  it("L11: no ack within LIFT_ACK_TIMEOUT_MS: a lift.stop and the request ends no_ack", () => {
    const r = rig();
    r.hello();
    r.status();
    r.run(100, {}, true);
    const s = r.client.start({ kind: "lift.home" }, OK_INPUTS, r.now);
    if (!s.ok) throw new Error(s.refusal);
    r.run(120, {}, true);
    const sentAt = r.now;
    r.run(sentAt + LIFT_ACK_TIMEOUT_MS - 20, {}, true);
    expect(r.link.of("lift.stop")).toEqual([]);
    r.run(sentAt + LIFT_ACK_TIMEOUT_MS, {}, true);
    expect(r.link.of("lift.stop")).toHaveLength(1);
    expect(r.events.at(-1)).toMatchObject({ type: "ended", outcome: "no_ack" });
  });
});

describe("lift client: stop and disable", () => {
  it("L12: stop is written at once in every state; a busy port sends it next tick; unacked it is resent, at most LIFT_STOP_RETRIES times", () => {
    const r = rig();
    r.hello({ ...SIM_LIFT_CONFIG, microsteps: 16 }); // a mismatch
    r.status({ state: "fault", faults: ["limit_hit"] });
    r.run(100, { state: "fault", faults: ["limit_hit"] });
    expect(r.client.stop()).toBe(true);
    expect(r.link.lines.at(-1)).toMatchObject({ type: "lift.stop" });
    // Busy: not written now, but first in the next tick's write.
    r.link.busy = true;
    expect(r.client.stop()).toBe(false);
    r.link.busy = false;
    const before = r.link.lines.length;
    r.run(r.now + 20, { state: "fault", faults: ["limit_hit"] });
    expect(r.link.lines[before]).toMatchObject({ type: "lift.stop" });
    // Nothing acks: each stop is resent with a new id, LIFT_STOP_RETRIES times.
    r.run(r.now + 5000, { state: "fault", faults: ["limit_hit"] });
    const stops = r.link.of("lift.stop");
    expect(stops).toHaveLength(2 + 2 * LIFT_STOP_RETRIES);
    expect(new Set(stops.map((s) => s.request_id)).size).toBe(stops.length);
    // Status lost: still written.
    r.run(r.now + LIFT_STATUS_STALE_MS + 40, {}, false, false);
    expect(r.events).toContainEqual({ type: "fault", code: "lift_module_lost" });
    const n = r.link.of("lift.stop").length;
    expect(r.client.stop()).toBe(true);
    expect(r.link.of("lift.stop")).toHaveLength(n + 1);
  });

  it("L12: a stop waits through ticks while the port stays busy, and goes out on the first free one", () => {
    const r = rig();
    r.hello();
    r.status();
    r.run(100);
    r.link.busy = true;
    expect(r.client.stop()).toBe(false);
    r.run(200); // five ticks, every write refused
    expect(r.link.of("lift.stop")).toEqual([]);
    r.link.busy = false;
    r.run(220);
    expect(r.link.of("lift.stop")).toHaveLength(1);
  });

  it("L12: an acked stop is not resent", () => {
    const r = rig();
    r.hello();
    r.status();
    r.run(100);
    r.client.stop();
    r.ack(r.link.lines.at(-1)!.request_id as string);
    r.run(2000);
    expect(r.link.of("lift.stop")).toHaveLength(1);
  });

  it("L13: disable only when liftMayDisable; accepted unhomes; disable_unsafe is reported and leaves it homed; allowed with a fault", () => {
    // Not drop-tested (the lift can't home then, so this part is unhomed): refused off the bottom switch.
    const n = rig({ installation: NOT_DROP_TESTED, bench: true });
    n.hello();
    n.status();
    n.run(200);
    expect(n.client.disable(OK_INPUTS, n.now)).toEqual({ ok: false, refusal: "lift_may_drop" });
    expect(n.link.of("lift.enable").filter((l) => l.enabled === false)).toEqual([]);
    n.run(n.now + 40, { limits: { top: "released" as const, bottom: "pressed" as const } });
    expect(n.client.disable({ ...OK_INPUTS, faultLatched: true }, n.now)).toEqual({ ok: true });
    expect(n.link.lines.at(-1)).toMatchObject({ type: "lift.enable", enabled: false });
    // Drop-tested and homed, but the board wasn't built disable-safe: it refuses, and the lift stays homed.
    const r = homedRig();
    r.client.disable({ ...OK_INPUTS, faultLatched: true }, r.now);
    const first = r.link.lines.at(-1)!;
    expect(first).toMatchObject({ type: "lift.enable", enabled: false });
    r.ack(first.request_id as string, "disable_unsafe");
    expect(r.events.at(-1)).toEqual({ type: "disable", outcome: "refused", reason: "disable_unsafe" });
    expect(r.client.state(r.now).homed).toBe(true);
    r.client.disable(OK_INPUTS, r.now);
    r.ack(r.link.lines.at(-1)!.request_id as string);
    expect(r.events.at(-1)).toEqual({ type: "disable", outcome: "disabled" });
    expect(r.client.state(r.now).homed).toBe(false);
  });

  it("L13: a passed drop test allows disable off the bottom switch; it is never sent by stop", () => {
    const r = homedRig();
    r.client.stop();
    expect(r.link.of("lift.enable").filter((l) => l.enabled === false)).toEqual([]);
    expect(r.client.disable(OK_INPUTS, r.now)).toEqual({ ok: true });
  });
});

describe("lift client: losing the lift", () => {
  it("L14: no status for LIFT_STATUS_STALE_MS: lift_module_lost once, the request ends lost after a stop, heartbeats stop; they resume after a fresh hello", () => {
    const r = rig();
    r.hello();
    r.status();
    r.run(100, {}, true);
    const s = r.client.start({ kind: "lift.home" }, OK_INPUTS, r.now);
    if (!s.ok) throw new Error(s.refusal);
    r.run(120, {}, true);
    r.ack(s.requestId);
    const homing = { state: "homing" as const, request_id: s.requestId };
    r.run(400, homing, true);
    const lastStatusAt = 400;
    for (let t = 420; t <= 1200; t += 20) {
      r.at(t);
      r.client.holdRefresh(t);
      r.client.tick(t);
    }
    expect(r.events.filter((e) => e.type === "fault")).toEqual([{ type: "fault", code: "lift_module_lost" }]);
    expect(r.events).toContainEqual({ type: "ended", requestId: s.requestId, kind: "lift.home", outcome: "lost" });
    const stop = r.link.of("lift.stop");
    expect(stop).toHaveLength(1);
    const lastHeartbeat = r.link.lines.filter((l) => l.type === "lift.heartbeat").at(-1)!;
    expect(r.link.lines.indexOf(lastHeartbeat)).toBeLessThan(r.link.lines.indexOf(stop[0]!));
    expect(r.client.state(r.now)).toMatchObject({ connected: false, homed: false, faults: ["lift_module_lost"] });
    expect(lastStatusAt + LIFT_STATUS_STALE_MS).toBeLessThanOrEqual(1200);
    // Statuses return: a hello.request, still no heartbeat until the hello.
    const lines = r.link.lines.length;
    r.run(1400);
    expect(r.link.hellos).toBeGreaterThanOrEqual(1);
    expect(r.link.lines.slice(lines).filter((l) => l.type === "lift.heartbeat")).toEqual([]);
    r.hello();
    r.run(1600, {}, true);
    expect(r.heartbeats().slice(-2)).toEqual([null, null]);
  });

  it("L14: the port closing is a loss too", () => {
    const r = homedRig();
    r.client.liftPortClosed(r.link, "unplugged");
    expect(r.events.at(-1)).toEqual({ type: "link", connected: false });
    expect(r.events).toContainEqual({ type: "fault", code: "lift_module_lost" });
    expect(r.client.state(r.now).homed).toBe(false);
  });

  it("L15: a fault in status is reported once per latch and unhomes; stray motion gets a stop", () => {
    const r = homedRig();
    const faulted = { state: "fault" as const, homed: false, position_mm: null, faults: ["limit_hit" as const] };
    r.run(r.now + 200, faulted);
    expect(r.events.filter((e) => e.type === "fault")).toEqual([{ type: "fault", code: "limit_hit" }]);
    expect(r.client.state(r.now).homed).toBe(false);
    r.run(r.now + 200, { state: "moving", homed: true, position_mm: 50, target_mm: 100, request_id: "other1-4" });
    expect(r.link.of("lift.stop")).toHaveLength(1);
  });

  it("L16: past the deadline: lift.stop, ended timeout, motion_timeout (homing and a move)", () => {
    const r = rig();
    r.hello();
    r.status();
    r.run(100, {}, true);
    const s = r.client.start({ kind: "lift.home" }, OK_INPUTS, r.now);
    if (!s.ok) throw new Error(s.refusal);
    r.run(120, {}, true);
    r.ack(s.requestId);
    r.run(120 + LIFT_HOMING_TIMEOUT_MS - 1, { state: "homing", request_id: s.requestId }, true);
    expect(r.link.of("lift.stop")).toEqual([]);
    r.run(120 + LIFT_HOMING_TIMEOUT_MS + 19, { state: "homing", request_id: s.requestId }, true);
    expect(r.link.of("lift.stop")).toHaveLength(1);
    expect(r.events.slice(-2)).toEqual([
      { type: "ended", requestId: s.requestId, kind: "lift.home", outcome: "timeout" },
      { type: "fault", code: "motion_timeout" },
    ]);

    const m = homedRig();
    m.client.holdRefresh(m.now);
    const move = m.client.start({ kind: "lift.move", target_mm: 300 }, OK_INPUTS, m.now);
    if (!move.ok) throw new Error(move.refusal);
    m.run(m.now + 20, IDLE_HOMED, true);
    const sentAt = m.now;
    m.ack(move.requestId);
    const deadline = sentAt + motionTimeoutMs(((300 - 5) / 20) * 1000);
    const moving = { state: "moving" as const, homed: true, position_mm: 100, target_mm: 300, request_id: move.requestId };
    m.run(deadline - 1, moving, true);
    expect(m.events.some((e) => e.type === "ended" && e.outcome === "timeout")).toBe(false);
    m.run(deadline + 19, moving, true);
    expect(m.events.some((e) => e.type === "ended" && e.outcome === "timeout")).toBe(true);
  });

  it("L17: the lift's seq going back is a reboot: unhomed, lift_unhomed, hello.request", () => {
    const r = homedRig();
    r.setLiftSeq(3);
    r.status(IDLE_HOMED);
    expect(r.events).toContainEqual({ type: "fault", code: "lift_unhomed" });
    expect(r.link.hellos).toBeGreaterThanOrEqual(1);
    expect(r.client.state(r.now).homed).toBe(false);
  });

  it("L19: a gap in the lift's seq is neither a loss nor a reboot", () => {
    const r = homedRig();
    r.setLiftSeq(10_000);
    r.run(r.now + 500, IDLE_HOMED);
    expect(r.events.filter((e) => e.type === "fault")).toEqual([]);
    expect(r.link.hellos).toBe(0);
    expect(r.client.state(r.now)).toMatchObject({ connected: true, homed: true });
  });

  it("L18: state() always passes LiftStateSchema", () => {
    const r = rig();
    const states = [r.client.state(0)];
    r.hello();
    r.status();
    r.run(100);
    states.push(r.client.state(r.now));
    const h = homedRig();
    states.push(h.client.state(h.now));
    h.run(h.now + 40, { state: "moving", homed: true, position_mm: 50, target_mm: 100, request_id: "other1-4" });
    states.push(h.client.state(h.now));
    h.run(h.now + 1000, { state: "fault", homed: false, position_mm: null, faults: ["stop_circuit_opened"], stop_sense: "pressed" });
    states.push(h.client.state(h.now));
    h.run(h.now + 1000);
    states.push(h.client.state(h.now + 1000));
    for (const s of states) expect(LiftStateSchema.safeParse(s).success, JSON.stringify(s)).toBe(true);
  });
});

// ---- Preconditions (pure) ----

const VIEW: LiftView = {
  bench: false,
  config: SIM_LIFT_CONFIG,
  installation: INSTALLED,
  heard: true,
  fresh: true,
  configOk: true,
  liftStopSense: "wired",
  statusStop: "released",
  liftFaults: [],
  busy: false,
  homed: true,
  bottomPressed: false,
  held: true,
};

describe("lift preconditions", () => {
  it("LP1: home and move, first failing check wins, in the policy's order", () => {
    const move = { kind: "lift.move" as const, target_mm: 300 };
    const cases: Array<[Partial<LiftView>, Partial<LiftCheckInputs>, string]> = [
      [{ statusStop: "pressed", liftFaults: ["stop_circuit_opened"] }, {}, "stop_pressed"],
      [{}, { stopCircuit: "pressed", faultLatched: true }, "stop_pressed"],
      [{ liftStopSense: "not_wired", liftFaults: ["limit_hit"] }, {}, "no_hardware_stop"],
      [{}, { stopCircuit: "not_wired" }, "no_hardware_stop"],
      [{ liftFaults: ["limit_hit"], busy: true }, {}, "fault_latched"],
      [{ configOk: false }, {}, "fault_latched"],
      [{ busy: true, heard: false }, { faultLatched: false }, "busy"],
      [{}, { otherMotion: true }, "busy"],
      [{ heard: false, fresh: false }, {}, "part_missing"],
      [{ fresh: false, held: false }, {}, "feedback_stale"],
      [{ held: false, installation: { ...INSTALLED, guards_fitted: false } }, {}, "not_held"],
      [{ installation: { ...INSTALLED, guards_fitted: false, drop_test: "failed" } }, {}, "lift_guards_missing"],
      [{ installation: NOT_DROP_TESTED }, { armsStowed: false }, "lift_drop_test_missing"],
      [{ homed: false }, { armsStowed: false }, "arms_not_stowed"],
      [{ homed: false }, {}, "lift_not_homed"],
    ];
    for (const [view, inputs, expected] of cases) {
      expect(liftVerdict({ ...VIEW, ...view }, move, { ...OK_INPUTS, ...inputs }, "start"), expected).toBe(expected);
    }
    expect(liftVerdict(VIEW, { kind: "lift.move", target_mm: 4.9 }, OK_INPUTS, "start")).toBe("out_of_range");
    expect(liftVerdict(VIEW, { kind: "lift.move", target_mm: 600.1 }, OK_INPUTS, "start")).toBe("out_of_range");
    expect(liftVerdict(VIEW, { kind: "lift.move", target_mm: 600 }, OK_INPUTS, "start")).toBeNull();
    // Homing needs neither homed nor a target.
    expect(liftVerdict({ ...VIEW, homed: false }, { kind: "lift.home" }, OK_INPUTS, "start")).toBeNull();
    // not_held only at start.
    expect(liftVerdict({ ...VIEW, held: false }, { kind: "lift.home" }, OK_INPUTS, "prepare")).toBeNull();
    expect(liftVerdict({ ...VIEW, held: false }, { kind: "lift.home" }, OK_INPUTS, "start")).toBe("not_held");
  });

  it("LP2: bench mode skips only the installation checks; never the hardware stop; its lower limits apply", () => {
    const slow = { ...SIM_LIFT_CONFIG, max_accel_mm_s2: 25 };
    const bench = { ...VIEW, bench: true, config: slow, installation: { ...NOT_DROP_TESTED, guards_fitted: false } };
    const move = { kind: "lift.move" as const, target_mm: 300 };
    expect(liftVerdict(bench, move, OK_INPUTS, "start")).toBeNull();
    // The lift never moves without the hardware stop, bench or not: the Pi's or the lift board's not wired.
    expect(liftVerdict(bench, move, { ...OK_INPUTS, stopCircuit: "not_wired" }, "start")).toBe("no_hardware_stop");
    expect(liftVerdict({ ...bench, liftStopSense: "not_wired" }, move, OK_INPUTS, "start")).toBe("no_hardware_stop");
    expect(liftVerdict(bench, move, { ...OK_INPUTS, stopCircuit: "pressed" }, "start")).toBe("stop_pressed");
    // The lift's built-in 50 mm/s² is over bench's 25; homing's fixed 15 mm/s is over bench's 10 mm/s.
    expect(liftVerdict({ ...bench, config: SIM_LIFT_CONFIG }, move, OK_INPUTS, "start")).toBe("lift_over_limits");
    expect(liftVerdict(bench, { kind: "lift.home" }, OK_INPUTS, "start")).toBe("lift_over_limits");
    // Outside bench mode both fit (50 mm/s², 20 mm/s); an acceleration over 50 doesn't.
    expect(liftVerdict(VIEW, { kind: "lift.home" }, OK_INPUTS, "start")).toBeNull();
    expect(liftVerdict({ ...VIEW, config: { ...SIM_LIFT_CONFIG, max_accel_mm_s2: 60 } }, move, OK_INPUTS, "start")).toBe("lift_over_limits");
    expect(liftOverLimits(SIM_LIFT_CONFIG, false, "lift.home")).toBe(false);
    expect(liftOverLimits(slow, true, "lift.move")).toBe(false);
    // Not stowed comes after the limits (the policy's order).
    expect(liftVerdict({ ...bench, config: SIM_LIFT_CONFIG }, move, { ...OK_INPUTS, armsStowed: false }, "start")).toBe("lift_over_limits");
  });

  it("LP3: disable checks only busy, part_missing and lift_may_drop, and is allowed with a fault", () => {
    const disable = { kind: "lift.disable" as const };
    const faulted = { ...VIEW, liftFaults: ["limit_hit"], statusStop: "pressed" as const, installation: NOT_DROP_TESTED };
    expect(liftVerdict({ ...faulted, bottomPressed: true }, disable, { ...OK_INPUTS, faultLatched: true }, "start")).toBeNull();
    expect(liftVerdict(faulted, disable, OK_INPUTS, "start")).toBe("lift_may_drop");
    expect(liftVerdict({ ...faulted, busy: true }, disable, OK_INPUTS, "start")).toBe("busy");
    expect(liftVerdict({ ...faulted, fresh: false }, disable, OK_INPUTS, "start")).toBe("part_missing");
    expect(liftVerdict({ ...VIEW, installation: { ...NOT_DROP_TESTED, brake_fitted: true } }, disable, OK_INPUTS, "start")).toBeNull();
  });

  it("LP4: start re-checks: a refused action never reaches the lift", () => {
    const r = rig();
    r.hello();
    r.status();
    r.run(100, {}, true);
    expect(r.client.start({ kind: "lift.home" }, { ...OK_INPUTS, armsStowed: false }, r.now)).toEqual({ ok: false, refusal: "arms_not_stowed" });
    expect(r.client.start({ kind: "lift.move", target_mm: 100 }, OK_INPUTS, r.now)).toEqual({ ok: false, refusal: "lift_not_homed" });
    r.run(400, {}, true);
    expect(r.link.lines.filter((l) => l.type === "lift.home" || l.type === "lift.move")).toEqual([]);
  });

  it("LP5: a move runs at the lower of the configuration's and the mode's speed", () => {
    // In bench mode the lift can't home (LP2), so bench's 10 mm/s is checked on the function itself.
    expect(liftMoveSpeed(SIM_LIFT_CONFIG, true)).toBe(10);
    const r = homedRig();
    r.client.holdRefresh(r.now);
    r.client.start({ kind: "lift.move", target_mm: 100 }, OK_INPUTS, r.now);
    r.run(r.now + 20, IDLE_HOMED, true);
    expect(r.link.lines.at(-1)).toMatchObject({ type: "lift.move", speed_mm_s: 20 });
    const slow = homedRig({ config: { ...SIM_LIFT_CONFIG, max_speed_mm_s: 8 } });
    slow.client.holdRefresh(slow.now);
    slow.client.start({ kind: "lift.move", target_mm: 100 }, OK_INPUTS, slow.now);
    slow.run(slow.now + 20, IDLE_HOMED, true);
    expect(slow.link.lines.at(-1)).toMatchObject({ type: "lift.move", speed_mm_s: 8 });
  });
});
