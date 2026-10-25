import { readFileSync } from "node:fs";
import { LIFT_PI_MESSAGE_TYPES } from "@walker/contracts";
import { describe, expect, it } from "vitest";
import {
  ARM_SERVO_IDS,
  armsLines,
  findArmAdapters,
  isReadOnlyPacket,
  readOnlyPort,
  simulatedArms,
  type ArmAdapter,
  type ArmSource,
} from "../src/check/arms";
import { cameraLines, parseFormats, parseListDevices } from "../src/check/cameras";
import type { CheckContext, CheckLine, FileAccess, Runner } from "../src/check/core";
import { gpiogetArgs, readStopSense, stopLine } from "../src/check/devices";
import { SIM_LIFT, SIM_MODULES, isServoPort, moduleLines, realSerial, simulatedSerial, tap, type SerialSource } from "../src/check/modules";
import { STS3215 } from "../src/motion/feetech/controlTable";
import { BROADCAST_ID, Instruction, SERVO_ERROR_BITS, encodePing, encodeRead, encodeSyncRead, encodeSyncWrite, encodeWrite } from "../src/motion/feetech/protocol";
import { FakeStsBus } from "../src/sim/fakeFeetech";
import { SimulatedHand, SimulatedLift, SimulatedPort } from "../src/sim/fakeModules";
import { FakeClock } from "./support/fakes";

/**
 * Rows H1–H11 (test/EXPECTED.md): the arms, lift, stop switch and camera checks, on a Mac. The arms run the
 * real Feetech bus class against simulated STS3215s (FakeStsBus), the lift reads the contract's own fixture
 * lines from a simulated board, and the v4l2-ctl and gpioget outputs are written from those tools' documented
 * formats, not captured on the Pi. No real servo, lift board or camera was used.
 */

// ---- shared helpers ----

const BY_ID = "/dev/serial/by-id";
const LEFT_LINK = `${BY_ID}/usb-1a86_USB_Single_Serial_5A46083061-if00`;
const RIGHT_LINK = `${BY_ID}/usb-1a86_USB_Single_Serial_5A46083062-if00`;

function fakeFiles(listing: Record<string, string[]> = {}, real: Record<string, string> = {}): FileAccess {
  return { read: () => null, list: (dir) => listing[dir] ?? null, mode: () => null, size: () => null, realpath: (path) => real[path] ?? path };
}

function ctxFor(clock: FakeClock, over: Partial<Omit<CheckContext, "options">> & { options?: Partial<CheckContext["options"]> } = {}): CheckContext {
  return {
    run: async () => ({ code: null, stdout: Buffer.alloc(0), stderr: "", missing: true, timedOut: false, ms: 0 }),
    files: fakeFiles(),
    clock,
    platform: "linux",
    arch: "arm64",
    env: {},
    say: () => {},
    facts: { serviceActive: false },
    ...over,
    options: { server: undefined, stateDir: "/x", stateDirGiven: false, sound: false, buzz: false, press: false, sim: false, ports: null, expect: [], ...over.options },
  };
}

type Reply = { out?: string; code?: number; stderr?: string };
function fakeRunner(replies: Record<string, Reply>) {
  const calls: string[][] = [];
  const run: Runner = async (command, args) => {
    calls.push([command, ...args]);
    const reply = replies[[command, ...args].join(" ")] ?? replies[command];
    if (!reply) return { code: null, stdout: Buffer.alloc(0), stderr: "", missing: true, timedOut: false, ms: 0 };
    return { code: reply.code ?? 0, stdout: Buffer.from(reply.out ?? ""), stderr: reply.stderr ?? "", missing: false, timedOut: false, ms: 4 };
  };
  return { run, calls };
}

const byItem = (lines: CheckLine[]) => Object.fromEntries(lines.map((l) => [l.item, `${l.status} ${l.detail}`]));

// ---- arms ----

const LEFT: ArmAdapter = { label: "left", path: LEFT_LINK, env: "WALKER_ARM_LEFT_PORT", role: "follower" };

function armSource(buses: Map<string, FakeStsBus>, adapters: ArmAdapter[]): ArmSource & { opened: string[] } {
  const opened: string[] = [];
  return {
    simulated: false,
    opened,
    find: () => ({ adapters, lines: [] }),
    open: (adapter) => {
      opened.push(adapter.path);
      const bus = buses.get(adapter.path);
      if (!bus) throw new Error("EACCES: permission denied");
      return bus;
    },
  };
}

/**
 * Steps the fake clock 1 ms at a time until the check ends. One big `advance` lets only a few rounds of I/O
 * callbacks run before the next deadline fires, so a chain of quick replies would look like timeouts.
 */
async function runArms(clock: FakeClock, ctx: CheckContext, source: ArmSource): Promise<CheckLine[]> {
  let finished = false;
  const done = armsLines(ctx, source).finally(() => {
    finished = true;
  });
  for (let ms = 0; ms < 30_000 && !finished; ms += 1) await clock.advance(1);
  return done;
}

/** The instruction byte of every packet the fake bus received. */
const instructions = (bus: FakeStsBus) => bus.received.map((packet) => packet[4]);

/** Every packet is a PING or a READ to one servo, and no register a write would change has changed. */
function expectReadOnly(bus: FakeStsBus, before: Map<number, Uint8Array>): void {
  expect(bus.received.length).toBeGreaterThan(0);
  for (const packet of bus.received) {
    expect(isReadOnlyPacket(packet), Buffer.from(packet).toString("hex")).toBe(true);
    expect([Instruction.PING, Instruction.READ]).toContain(packet[4]);
    expect(packet[2]).not.toBe(BROADCAST_ID);
  }
  for (const [id, memory] of before) {
    const now = bus.servo(id).memory;
    // EEPROM (0..39), torque enable, acceleration, goal, goal time, goal speed, torque limit, lock.
    expect(Buffer.from(now.subarray(0, 40))).toEqual(Buffer.from(memory.subarray(0, 40)));
    for (const name of ["torqueEnable", "acceleration", "goalPosition", "goalTime", "goalSpeed", "torqueLimit", "lock"] as const) {
      expect(bus.servo(id).get(name), `${name} on ${id}`).toBe(decode(memory, name));
    }
  }
}
const decode = (memory: Uint8Array, name: keyof typeof STS3215) => {
  const field = STS3215[name];
  return field.size === 1 ? memory[field.address]! : memory[field.address]! | (memory[field.address + 1]! << 8);
};
const snapshot = (bus: FakeStsBus) => new Map([...bus.servos.keys()].map((id) => [id, Uint8Array.from(bus.servo(id).memory)]));

describe("walker check: arms", () => {
  it("H1, H2: a healthy arm: one line per joint with model, firmware, position, voltage, temperature, torque; only PING and READ go out", async () => {
    const clock = new FakeClock();
    const bus = new FakeStsBus(clock, { positions: { 1: 2048, 2: 1100, 3: 3000, 4: 2100, 5: 2048, 6: 1500 } });
    const before = snapshot(bus);
    const ctx = ctxFor(clock, { files: fakeFiles({}, { [LEFT_LINK]: "/dev/ttyACM0" }) });
    const lines = await runArms(clock, ctx, armSource(new Map([[LEFT_LINK, bus]]), [LEFT]));
    const items = byItem(lines);
    expect(items.left).toBe("PASS 6 of 6 servos on usb-1a86_USB_Single_Serial_5A46083061-if00 (WALKER_ARM_LEFT_PORT), follower, 1000000 baud, no echo, 12.0 to 12.0 V, 0 retries");
    expect(items["left shoulder_pan"]).toBe("PASS id 1, model 777, firmware 3.10, position 2048, 12.0 V, 25 °C, torque off");
    expect(items["left shoulder_lift"]).toBe("PASS id 2, model 777, firmware 3.10, position 1100, 12.0 V, 25 °C, torque off");
    expect(items["left gripper"]).toMatch(/^PASS id 6, .*position 1500/);
    expect(lines).toHaveLength(7);
    expectReadOnly(bus, before);
    // Echo detection (READ model), six PINGs, then four READs per servo.
    expect(instructions(bus).filter((i) => i === Instruction.PING)).toHaveLength(6);
    // The configured port is recorded as a servo bus, by its tty, so the serial check leaves it alone.
    expect(ctx.facts.servoPorts).toEqual(["/dev/ttyACM0"]);
    expect(isServoPort(ctx, LEFT_LINK)).toBe(true);
    expect(isServoPort(ctx, "/dev/serial/by-path/platform-xhci-hcd.0-usb-0:1.3:1.0")).toBe(false);
    // The real serial source drops it, even when named with --port, and by its by-path alias too.
    const byPathAlias = "/dev/serial/by-path/platform-xhci-hcd.0-usb-0:1.2:1.0";
    const hand = "/dev/serial/by-path/platform-xhci-hcd.0-usb-0:1.3:1.0-port0";
    const serialCtx = { ...ctx, files: fakeFiles({}, { [LEFT_LINK]: "/dev/ttyACM0", [byPathAlias]: "/dev/ttyACM0" }), options: { ...ctx.options, ports: [byPathAlias, hand] } };
    expect(realSerial.ports(serialCtx)).toEqual([hand]);
  });

  it("H3: torque already on, a missing id, low voltage, a hot servo, another model and a fault bit each warn, and the arm line lists them", async () => {
    const clock = new FakeClock();
    const bus = new FakeStsBus(clock);
    bus.servo(5).faults.silent = true;
    bus.servo(2).set("torqueEnable", 1);
    for (const servo of bus.servos.values()) servo.supplyVoltage = 9.8;
    bus.servo(3).ambientC = 66;
    bus.servo(3).temperatureC = 66;
    bus.servo(4).set("modelNumber", 1033);
    bus.servo(6).faults.errorBits = SERVO_ERROR_BITS.overload;
    const before = snapshot(bus);
    const lines = await runArms(clock, ctxFor(clock), armSource(new Map([[LEFT_LINK, bus]]), [LEFT]));
    const items = byItem(lines);
    expect(items["left wrist_roll"]).toBe("WARN id 5 didn't answer a PING (timeout)");
    expect(items["left shoulder_lift"]).toMatch(/^WARN .*torque ON: torque is already ON \(the check never turns it on; something else did\); 9\.8 V is below 10\.5 V/);
    expect(items["left elbow_flex"]).toMatch(/66 °C is above 60 °C/);
    expect(items["left wrist_flex"]).toMatch(/model 1033, not an STS3215 \(777\)/);
    expect(items["left gripper"]).toMatch(/servo reports overload/);
    expect(items.left).toMatch(/^WARN 5 of 6 servos .*: shoulder_pan: 9\.8 V is below 10\.5 V .*wrist_roll: id 5 missing/);
    // The silent servo was retried, and still only PING and READ went out; torque on servo 2 stayed as it was.
    expectReadOnly(bus, before);
    expect(bus.servo(2).torqueOn).toBe(true);
  });

  it("H3: a leader's voltage isn't judged against the follower limit, but above the servo's own limit warns", async () => {
    const clock = new FakeClock();
    const bus = new FakeStsBus(clock);
    for (const servo of bus.servos.values()) servo.supplyVoltage = 5;
    bus.servo(1).supplyVoltage = 12;
    bus.servo(1).set("maxVoltageLimit", 80);
    const leader: ArmAdapter = { label: "leader-left", path: LEFT_LINK, env: "WALKER_LEADER_LEFT_PORT", role: "leader" };
    const items = byItem(await runArms(clock, ctxFor(clock), armSource(new Map([[LEFT_LINK, bus]]), [leader])));
    expect(items["leader-left shoulder_lift"]).toBe("PASS id 2, model 777, firmware 3.10, position 2048, 5.0 V, 25 °C, torque off");
    // Its PING reply carries the voltage bit, which makes it identical to the PING: a READ finds it instead.
    expect(items["leader-left shoulder_pan"]).toBe(
      "WARN id 1, model 777, firmware 3.10, position 2048, 12.0 V, 25 °C, torque off: 12.0 V is above this servo's own 8.0 V limit (a 7.4 V servo on 12 V?); " +
        "servo reports voltage; its PING reply matched the PING byte for byte (the voltage fault bit does that), so it was found by READ",
    );
  });

  it("H4: an echoing adapter warns that it needs echo: true, and the readings still come through", async () => {
    const clock = new FakeClock();
    const bus = new FakeStsBus(clock, { echo: true });
    const before = snapshot(bus);
    const items = byItem(await runArms(clock, ctxFor(clock), armSource(new Map([[LEFT_LINK, bus]]), [LEFT])));
    expect(items.left).toMatch(/^WARN 6 of 6 servos .*, echo, 12\.0 to 12\.0 V, 0 retries: the adapter ECHOES our bytes: the motion coordinator must build this bus with echo: true$/);
    expect(items["left elbow_flex"]).toBe("PASS id 3, model 777, firmware 3.10, position 2048, 12.0 V, 25 °C, torque off");
    expectReadOnly(bus, before);
  });

  it("H5: no servo answering fails with the power hint; a port that can't be opened fails", async () => {
    const clock = new FakeClock();
    const bus = new FakeStsBus(clock);
    for (const servo of bus.servos.values()) servo.faults.silent = true;
    const right: ArmAdapter = { label: "right", path: RIGHT_LINK, env: "WALKER_ARM_RIGHT_PORT", role: "follower" };
    const ctx = ctxFor(clock);
    const lines = await runArms(clock, ctx, armSource(new Map([[LEFT_LINK, bus]]), [LEFT, right]));
    const items = byItem(lines);
    expect(items.left).toBe(
      "FAIL no servo answered ids 1, 2, 3, 4, 5, 6 on usb-1a86_USB_Single_Serial_5A46083061-if00 (WALKER_ARM_LEFT_PORT) (no echo): is the arm's 12 V supply on and its servo cable seated?",
    );
    expect(items.right).toBe(`FAIL couldn't open ${RIGHT_LINK} at 1000000 baud: EACCES: permission denied (run with sudo?)`);
    expect(instructions(bus).every((i) => i === Instruction.READ)).toBe(true);
    // Configured ports count as servo buses even when nothing answers.
    expect(ctx.facts.servoPorts).toEqual([LEFT_LINK, RIGHT_LINK]);
  });

  it("H1: the port guard refuses every write, torque, goal, EEPROM, sync, action and broadcast packet before it reaches the bus", async () => {
    const clock = new FakeClock();
    const bus = new FakeStsBus(clock);
    const guarded = readOnlyPort(bus);
    const refusedPackets = [
      encodeWrite(1, STS3215.torqueEnable.address, [1]),
      encodeWrite(2, STS3215.goalPosition.address, [0x00, 0x08]),
      encodeWrite(3, STS3215.lock.address, [0]),
      encodeWrite(4, STS3215.id.address, [9]),
      encodeWrite(BROADCAST_ID, STS3215.torqueEnable.address, [0]),
      encodeSyncWrite(STS3215.torqueEnable.address, 1, [{ id: 1, data: [1] }]),
      Uint8Array.from([0xff, 0xff, 0x01, 0x02, Instruction.ACTION, 0xfb]),
      encodeSyncRead([1, 2], 56, 2),
      Uint8Array.from([0xff, 0xff, 0x01, 0x02, Instruction.PING, 0x00]), // bad checksum
    ];
    for (const packet of refusedPackets) await expect(guarded.write(packet)).rejects.toThrow("walker check sends only PING and READ");
    expect(guarded.refused).toHaveLength(refusedPackets.length);
    expect(bus.received).toEqual([]);
    await guarded.write(encodePing(1));
    await guarded.write(encodeRead(1, 56, 2));
    expect(bus.received).toHaveLength(2);
    // Closing the guarded port leaves the adapter open for the next bus; only the check closes it.
    guarded.close();
    await guarded.write(encodePing(2));
    expect(bus.received).toHaveLength(3);
  });

  it("H6: configured ports by the coordinator's names; a ttyACM path and a missing link fail; an unnamed adapter is listed, not opened", async () => {
    const clock = new FakeClock();
    const env = { WALKER_ARM_LEFT_PORT: LEFT_LINK, WALKER_ARM_RIGHT_PORT: "/dev/ttyACM1", WALKER_LEADER_LEFT_PORT: `${BY_ID}/usb-gone-if00` };
    const files = fakeFiles({ [BY_ID]: [LEFT_LINK, RIGHT_LINK].map((p) => p.split("/").at(-1)!) });
    const { adapters, lines } = findArmAdapters(ctxFor(clock, { env, files }));
    expect(adapters).toEqual([LEFT]);
    const items = byItem(lines);
    expect(items.right).toBe("FAIL WALKER_ARM_RIGHT_PORT=/dev/ttyACM1: must be a link in /dev/serial/by-id/ or /dev/serial/by-path/ (a /dev/ttyACM number changes with plug order)");
    expect(items["leader-left"]).toMatch(/^FAIL WALKER_LEADER_LEFT_PORT=\/dev\/serial\/by-id\/usb-gone-if00 is not there: is the adapter plugged in/);
    expect(items["other adapter"]).toMatch(/^SKIP usb-1a86_USB_Single_Serial_5A46083062-if00 looks like a servo adapter, but no WALKER_ARM_LEFT_PORT, .* names it; not opened$/);
  });

  it("H6: with no port set, adapters are found by name and checked, with a warning to configure them; none found skips", async () => {
    const clock = new FakeClock();
    const files = fakeFiles({ [BY_ID]: ["usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0", "usb-1a86_USB_Single_Serial_5A46083061-if00"] });
    const found = findArmAdapters(ctxFor(clock, { files }));
    expect(found.adapters).toEqual([{ label: "adapter 1", path: LEFT_LINK, env: null, role: null }]);
    expect(byItem(found.lines).ports).toMatch(/^WARN not configured; found 1 likely servo adapter by name\. .*set WALKER_ARM_LEFT_PORT and WALKER_ARM_RIGHT_PORT/);
    const none = findArmAdapters(ctxFor(clock, { files: fakeFiles({ [BY_ID]: ["usb-Silicon_Labs_CP2102-if00-port0"] }) }));
    expect(none.adapters).toEqual([]);
    expect(none.lines).toEqual([expect.objectContaining({ status: "SKIP", item: "adapters" })]);

    // A link found by name counts as a servo bus only once a servo answers on it.
    const silent = new FakeStsBus(clock);
    for (const servo of silent.servos.values()) servo.faults.silent = true;
    const ctx = ctxFor(clock);
    await runArms(clock, ctx, armSource(new Map([[LEFT_LINK, silent]]), found.adapters));
    expect(ctx.facts.servoPorts).toEqual([]);
  });

  it("H6: with the service running, or on a Mac, no adapter is opened", async () => {
    const clock = new FakeClock();
    const source = armSource(new Map([[LEFT_LINK, new FakeStsBus(clock)]]), [LEFT]);
    const running = await runArms(clock, ctxFor(clock, { facts: { serviceActive: true } }), source);
    expect(running).toEqual([expect.objectContaining({ status: "SKIP", detail: expect.stringContaining("sudo systemctl stop steady-walker") })]);
    const mac = await runArms(clock, ctxFor(clock, { platform: "darwin" }), source);
    expect(mac).toEqual([expect.objectContaining({ status: "SKIP", detail: "not a Pi (darwin); this runs on the walker; pass --sim for simulated arms" })]);
    expect(source.opened).toEqual([]);
  });

  it("H11: --sim checks two simulated arms through the same code, every line labelled simulated, all passing, read-only", async () => {
    const clock = new FakeClock();
    const source = simulatedArms(clock);
    const before = new Map([...source.buses].map(([path, bus]) => [path, snapshot(bus)]));
    const lines = await runArms(clock, ctxFor(clock, { platform: "darwin" }), source);
    expect(lines).toHaveLength(2 * (1 + ARM_SERVO_IDS.length));
    for (const line of lines) {
      expect(line.status).toBe("PASS");
      expect(line.detail).toMatch(/\(simulated\)$/);
    }
    for (const [path, bus] of source.buses) expectReadOnly(bus, before.get(path)!);
  });
});

// ---- lift ----

const FIXTURE = readFileSync(new URL("../../../packages/contracts/test/fixtures/lift-serial-v1.valid.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line) as Record<string, unknown>);
const body = (message: Record<string, unknown>) => {
  const { v: _v, module_id: _m, seq: _s, ...rest } = message;
  return rest;
};
const fixtureHello = body(FIXTURE.find((m) => m.type === "lift.hello")!);
const fixtureStatus = (pick: (m: Record<string, unknown>) => boolean) => body(FIXTURE.find((m) => m.type === "lift.status" && pick(m))!);

function liftSource(boards: Array<{ port: SimulatedPort; board?: SimulatedHand | SimulatedLift }>): SerialSource {
  return {
    simulated: false,
    ports: () => boards.map((b) => b.port.id),
    open: (path) => boards.find((b) => b.port.id === path)!.port,
    started: () => boards.forEach((b) => b.board?.start()),
    stop: () => boards.forEach((b) => b.board?.hang()),
  };
}

async function runSerial(clock: FakeClock, ctx: CheckContext, source: SerialSource): Promise<CheckLine[]> {
  const done = moduleLines(ctx, source);
  await clock.advance(30_000);
  return done;
}

const liftOnly = (lines: CheckLine[]) => lines.filter((l) => l.group === "lift");

describe("walker check: lift", () => {
  it("H7: the lift's hello limits and one status from the contract's fixture lines; only hello.request is sent, even with --buzz", async () => {
    const clock = new FakeClock();
    const lift = new SimulatedLift(new SimulatedPort("usb-lift"), "lift-01", clock);
    lift.hello = fixtureHello;
    lift.status = fixtureStatus((m) => m.state === "moving");
    const hand = new SimulatedHand(new SimulatedPort("usb-hand"), "hand-left-01", clock);
    const ctx = ctxFor(clock, { options: { buzz: true, expect: ["hand-left-01"] } });
    const lines = await runSerial(clock, ctx, liftSource([{ port: lift.port, board: lift }, { port: hand.port, board: hand }]));
    const items = byItem(lines);
    expect(items["lift-01"]).toBe(
      "PASS firmware 0.1.0, protocol v1, port usb-lift; built-in limits 5 to 600 mm, at most 20 mm/s and 50 mm/s², 8 microsteps (320 steps/mm), top switch not measured; stop-sense input wired",
    );
    expect(items["lift-01 status"]).toMatch(
      /^PASS moving, height 121\.5 mm, top switch released, bottom switch released, stop released, driver enabled, no faults, last Pi heartbeat 60 ms ago \(this check sends none\); 2[0-9] reports in 1\.2 s$/,
    );
    expect(items["hand-left-01 buzz"]).toMatch(/^PASS/);
    expect(lines.filter((l) => l.status === "FAIL")).toEqual([]);
    // The lift was sent exactly one line, a hello.request, and never a heartbeat, home, move, enable, stop or clear.
    expect(lift.port.received.map((line) => JSON.parse(line).type)).toEqual(["hello.request"]);
    for (const type of LIFT_PI_MESSAGE_TYPES.filter((t) => t !== "hello.request")) expect(lift.port.received.join("")).not.toContain(`"${type}"`);
  });

  it("H7: not homed, the stop pressed, a latched fault, a disabled driver and a firmware without stop sense each warn", async () => {
    const cases: Array<{ status: Record<string, unknown>; hello?: Record<string, unknown>; expected: RegExp }> = [
      { status: fixtureStatus((m) => m.state === "unhomed"), expected: /^WARN unhomed, height unknown, .*last Pi heartbeat none .*: not homed \(normal after power-on/ },
      { status: fixtureStatus((m) => m.stop_sense === "pressed"), expected: /^WARN fault, .*stop pressed, .*faults stop_circuit_opened, .*: the stop reads PRESSED \(or its wire is cut\): release it; not homed .*; faults latched: stop_circuit_opened$/ },
      { status: fixtureStatus((m) => (m.faults as string[]).includes("watchdog_expired")), expected: /^WARN fault, height 140\.2 mm, .*: faults latched: watchdog_expired$/ },
      { status: { ...fixtureStatus((m) => m.state === "unhomed"), driver_enabled: false }, expected: /driver disabled \(the motor isn't holding the carriage\)$/ },
      { status: { ...fixtureStatus((m) => m.state === "unhomed"), stop_sense: "not_wired" }, expected: /stop sense not wired on the lift board/ },
    ];
    for (const c of cases) {
      const clock = new FakeClock();
      const lift = new SimulatedLift(new SimulatedPort("usb-lift"), "lift-01", clock);
      lift.hello = fixtureHello;
      lift.status = c.status;
      const items = byItem(await runSerial(clock, ctxFor(clock, { options: { expect: ["lift-01"] } }), liftSource([{ port: lift.port, board: lift }])));
      expect(items["lift-01 status"]).toMatch(c.expected);
      expect(items["lift-01"]).toMatch(/^PASS/);
    }
    const clock = new FakeClock();
    const bench = new SimulatedLift(new SimulatedPort("usb-lift"), "lift-01", clock);
    bench.hello = { ...fixtureHello, stop_sense: "not_wired" };
    bench.status = { ...fixtureStatus((m) => m.state === "unhomed"), stop_sense: "not_wired" };
    const items = byItem(await runSerial(clock, ctxFor(clock, { options: { expect: ["lift-01"] } }), liftSource([{ port: bench.port, board: bench }])));
    expect(items["lift-01"]).toMatch(/stop-sense input not_wired: the firmware was built without a stop-sense input \(bench only\)$/);
  });

  it("H7, H8: a lift that says hello and then no status fails; no lift on any port skips, and fails when expected", async () => {
    const clock = new FakeClock();
    const quiet = new SimulatedPort("usb-lift");
    quiet.onPiLine = (line) => {
      if (line.includes("hello.request")) quiet.sendLine({ v: 1, module_id: "lift-01", seq: 0, ...fixtureHello });
    };
    const items = byItem(await runSerial(clock, ctxFor(clock, { options: { expect: ["lift-01"] } }), liftSource([{ port: quiet }])));
    expect(items["lift-01 status"]).toBe("FAIL no lift.status in 1.2 s after its hello");
    expect(items.port).toBeUndefined();

    const clock2 = new FakeClock();
    const hand = new SimulatedHand(new SimulatedPort("usb-hand"), "hand-left-01", clock2);
    const none = liftOnly(await runSerial(clock2, ctxFor(clock2, { options: { expect: ["hand-left-01"] } }), liftSource([{ port: hand.port, board: hand }])));
    expect(none).toEqual([expect.objectContaining({ status: "SKIP", item: "lift-01", detail: "no lift board said lift.hello on any serial port (not fitted yet?)" })]);
    const clock3 = new FakeClock();
    const hand3 = new SimulatedHand(new SimulatedPort("usb-hand"), "hand-left-01", clock3);
    const expected = await runSerial(clock3, ctxFor(clock3, { options: { expect: ["hand-left-01", "lift-01"] } }), liftSource([{ port: hand3.port, board: hand3 }]));
    expect(expected.filter((l) => l.item === "lift-01").map((l) => `${l.status} ${l.group} ${l.detail}`)).toEqual([
      "FAIL serial not seen on any port",
      "SKIP lift no lift board said lift.hello on any serial port (not fitted yet?)",
    ]);
  });

  it("H1: the serial tap refuses every line but hello.request on a lift port, and anything but hello.request and haptic.play elsewhere", () => {
    const liftPort = new SimulatedPort("usb-lift");
    const { tapped, state } = tap(liftPort);
    liftPort.onPiLine = () => {};
    liftPort.sendLine({ v: 1, module_id: "lift-01", seq: 0, ...fixtureHello });
    tapped.onData(() => {});
    liftPort.sendLine({ v: 1, module_id: "lift-01", seq: 1, ...fixtureHello });
    expect(state.lift.hellos).toHaveLength(1);
    for (const line of FIXTURE.filter((m) => LIFT_PI_MESSAGE_TYPES.includes(m.type as never) && m.type !== "hello.request")) {
      expect(tapped.write(`${JSON.stringify(line)}\n`)).toBe(false);
    }
    expect(tapped.write(`${JSON.stringify({ v: 1, type: "haptic.play", module_id: "lift-01", seq: 9, request_id: "r", pattern: "error", duration_ms: 100 })}\n`)).toBe(false);
    expect(tapped.write(`${JSON.stringify({ v: 1, type: "hello.request", module_id: "any", seq: 0 })}\n`)).toBe(true);
    expect(liftPort.received.map((line) => JSON.parse(line).type)).toEqual(["hello.request"]);
    expect(new Set(state.blocked)).toEqual(new Set(["lift.heartbeat", "lift.enable", "lift.home", "lift.move", "lift.set_position", "lift.stop", "lift.clear", "haptic.play"]));

    const handPort = new SimulatedPort("usb-hand");
    const hand = tap(handPort);
    expect(hand.tapped.write(`${JSON.stringify({ v: 1, type: "haptic.play", module_id: "hand-left-01", seq: 1, request_id: "r", pattern: "recording", duration_ms: 300 })}\n`)).toBe(true);
    expect(hand.tapped.write("not json\n")).toBe(false);
  });

  it("H11: --sim includes a simulated lift that warns it isn't homed, and nothing fails", async () => {
    const clock = new FakeClock();
    const lines = await runSerial(clock, ctxFor(clock, { platform: "darwin", options: { sim: true, buzz: true } }), simulatedSerial(clock));
    const items = byItem(lines);
    expect(items[SIM_LIFT]).toMatch(/^PASS firmware sim-0\.1\.0, .*\(simulated\)$/);
    expect(items[`${SIM_LIFT} status`]).toMatch(/^WARN unhomed, .*not homed .*\(simulated\)$/);
    for (const id of SIM_MODULES) expect(items[id]).toMatch(/^PASS .*\(simulated\)$/);
    expect(lines.filter((l) => l.status === "FAIL")).toEqual([]);
  });
});

// ---- stop switch ----

describe("walker check: stop switch", () => {
  it("H10: gpio:<line> reads the level once with the pull-up: low is released, high is pressed or cut", async () => {
    const clock = new FakeClock();
    const env = { WALKER_STOP_SENSE: "gpio:22", WALKER_GPIOMON: "v2" };
    const low = fakeRunner({ "gpioget --chip gpiochip0 --bias=pull-up --numeric 22": { out: "0\n" } });
    expect(await stopLine(ctxFor(clock, { env, run: low.run }))).toEqual({ status: "PASS", group: "stop", item: "stop switch", detail: "released: gpiochip0 line 22 reads low (the normally closed contact is closed)" });
    expect(low.calls).toEqual([["gpioget", "--chip", "gpiochip0", "--bias=pull-up", "--numeric", "22"]]);
    const high = fakeRunner({ gpioget: { out: "1\n" } });
    expect((await stopLine(ctxFor(clock, { env: { ...env, WALKER_GPIO_CHIP: "gpiochip4" }, run: high.run }))).detail).toBe(
      "PRESSED, or its wire is cut: gpiochip4 line 22 reads high through the pull-up. Motion is refused until it is released",
    );
    expect(gpiogetArgs(undefined, "gpiochip0", 5)).toEqual(["--bias=pull-up", "gpiochip0", "5"]);
    const busy = fakeRunner({ gpioget: { code: 1, stderr: "gpioget: unable to request lines: Device or resource busy" } });
    expect(await stopLine(ctxFor(clock, { env, run: busy.run, facts: { serviceActive: true } }))).toMatchObject({
      status: "FAIL",
      detail: "couldn't read gpiochip0 line 22: gpioget exited 1: gpioget: unable to request lines: Device or resource busy (steady-walker may be watching it); the coordinator counts an unreadable stop as pressed",
    });
  });

  it("H10: not wired warns that motion is refused outside bench mode; a bad setting fails; a Mac skips", async () => {
    const clock = new FakeClock();
    const runner = fakeRunner({});
    expect((await stopLine(ctxFor(clock, { run: runner.run }))).detail).toBe(
      "not_wired (WALKER_STOP_SENSE unset): with no stop-sense input, the lift never moves, and arm motion is refused unless WALKER_MOTION_BENCH=no-hardware-stop (bench mode)",
    );
    expect((await stopLine(ctxFor(clock, { env: { WALKER_STOP_SENSE: "not_wired", WALKER_MOTION_BENCH: "no-hardware-stop" } }))).detail).toMatch(/is not_wired.*the lift never moves.*WALKER_MOTION_BENCH is on, so the arms move under the bench limits/);
    expect(await stopLine(ctxFor(clock, { env: { WALKER_STOP_SENSE: "22" } }))).toMatchObject({ status: "FAIL", detail: expect.stringContaining("must be gpio:<BCM line> or not_wired") });
    expect(await stopLine(ctxFor(clock, { platform: "darwin", env: { WALKER_STOP_SENSE: "gpio:22" } }))).toMatchObject({ status: "SKIP" });
    expect(runner.calls).toEqual([]);
    expect(readStopSense("gpio:64")).toBeNull();
    expect(readStopSense("gpio:27")).toEqual({ kind: "gpio", line: 27 });
  });
});

// ---- cameras ----

// Written from v4l2-ctl's documented output (v4l-utils 1.2x), not captured on the Pi. The Pi 5's own blocks
// (pispbe, rpi-hevc-dec) list too and aren't cameras.
const LIST_DEVICES = (cameras: number) =>
  [
    "pispbe (platform:1000880000.pisp_be):",
    "\t/dev/video20",
    "\t/dev/video21",
    "\t/dev/media0",
    "",
    "rpi-hevc-dec (platform:rpi-hevc-dec):",
    "\t/dev/video19",
    "\t/dev/media1",
    "",
    ...[
      ["USB 2.0 Camera: USB Camera", "usb-xhci-hcd.0-1.1", 0],
      ["InnoMaker-U20CAM-1080p: InnoM", "usb-xhci-hcd.0-1.2", 2],
      ["InnoMaker-U20CAM-1080p: InnoM", "usb-xhci-hcd.1-1.3", 4],
    ]
      .slice(0, cameras)
      .flatMap(([name, bus, n]) => [`${name} (${bus}):`, `\t/dev/video${n}`, `\t/dev/video${Number(n) + 1}`, `\t/dev/media${3 + Number(n)}`, ""]),
  ].join("\n");

const FORMATS_1080 = [
  "ioctl: VIDIOC_ENUM_FMT",
  "\tType: Video Capture",
  "",
  "\t[0]: 'MJPG' (Motion-JPEG, compressed)",
  "\t\tSize: Discrete 1920x1080",
  "\t\t\tInterval: Discrete 0.033s (30.000 fps)",
  "\t\t\tInterval: Discrete 0.067s (15.000 fps)",
  "\t\tSize: Discrete 1280x720",
  "\t\t\tInterval: Discrete 0.017s (60.000 fps)",
  "\t\tSize: Discrete 640x480",
  "\t\t\tInterval: Discrete 0.033s (30.000 fps)",
  "\t[1]: 'YUYV' (YUYV 4:2:2)",
  "\t\tSize: Discrete 1920x1080",
  "\t\t\tInterval: Discrete 0.200s (5.000 fps)",
  "\t\tSize: Discrete 640x480",
  "\t\t\tInterval: Discrete 0.033s (30.000 fps)",
  "",
].join("\n");
const FORMATS_META = ["ioctl: VIDIOC_ENUM_FMT", "\tType: Metadata Capture", "", "\t[0]: 'UVCH' (UVC Payload Header Metadata)", ""].join("\n");

describe("walker check: cameras", () => {
  it("H9: three USB cameras pass, each with its formats and sizes; the Pi's own video blocks and metadata nodes are left out", async () => {
    const clock = new FakeClock();
    const replies: Record<string, Reply> = { "v4l2-ctl --list-devices": { out: LIST_DEVICES(3) } };
    for (const n of [0, 2, 4]) {
      replies[`v4l2-ctl -d /dev/video${n} --list-formats-ext`] = { out: FORMATS_1080 };
      replies[`v4l2-ctl -d /dev/video${n + 1} --list-formats-ext`] = { out: FORMATS_META };
    }
    const runner = fakeRunner(replies);
    const lines = await cameraLines(ctxFor(clock, { run: runner.run }));
    const items = byItem(lines);
    expect(items.count).toBe("PASS 3 USB cameras");
    expect(items["camera 1"]).toBe(
      'PASS "USB 2.0 Camera: USB Camera" on usb-xhci-hcd.0-1.1, /dev/video0: MJPG 1920x1080@30 1280x720@60 640x480@30; YUYV 1920x1080@5 640x480@30',
    );
    expect(items["camera 3"]).toMatch(/^PASS "InnoMaker-U20CAM-1080p: InnoM" on usb-xhci-hcd\.1-1\.3, \/dev\/video4: MJPG/);
    // The first node with capture formats is enough; only listing commands ran.
    expect(runner.calls.map((c) => c.join(" "))).toEqual([
      "v4l2-ctl --list-devices",
      "v4l2-ctl -d /dev/video0 --list-formats-ext",
      "v4l2-ctl -d /dev/video2 --list-formats-ext",
      "v4l2-ctl -d /dev/video4 --list-formats-ext",
    ]);
    expect(parseFormats(FORMATS_META)).toEqual([]);
    expect(parseListDevices(LIST_DEVICES(1)).map((d) => d.bus)).toEqual(["platform:1000880000.pisp_be", "platform:rpi-hevc-dec", "usb-xhci-hcd.0-1.1"]);
  });

  it("H9: fewer than three warn; a camera with no MJPG or YUYV warns; none at all warns; v4l2-ctl missing and a Mac skip", async () => {
    const clock = new FakeClock();
    const two = fakeRunner({
      "v4l2-ctl --list-devices": { out: LIST_DEVICES(2) },
      "v4l2-ctl -d /dev/video0 --list-formats-ext": { out: FORMATS_1080 },
      "v4l2-ctl -d /dev/video2 --list-formats-ext": { out: FORMATS_1080.replace(/MJPG/g, "H264").replace(/YUYV/g, "NV12") },
    });
    const items = byItem(await cameraLines(ctxFor(clock, { run: two.run })));
    expect(items.count).toBe("WARN 2 USB cameras; expected 3 (one 720p and two 1080p InnoMaker). Check each USB cable and hub port (lsusb)");
    expect(items["camera 2"]).toMatch(/H264 .*NV12 .*: neither MJPG nor YUYV$/);
    const none = fakeRunner({ "v4l2-ctl --list-devices": { code: 1, out: "", stderr: "Cannot open device /dev/video0, exiting.\n" } });
    expect(await cameraLines(ctxFor(clock, { run: none.run }))).toEqual([expect.objectContaining({ status: "WARN", item: "count", detail: expect.stringMatching(/^0 USB cameras; expected 3/) })]);
    expect(await cameraLines(ctxFor(clock))).toEqual([
      { status: "SKIP", group: "camera", item: "cameras", detail: "v4l2-ctl is not installed: sudo apt install v4l-utils, then run this again" },
    ]);
    expect(await cameraLines(ctxFor(clock, { platform: "darwin" }))).toEqual([expect.objectContaining({ status: "SKIP", detail: "not a Pi (darwin); this runs on the walker" })]);
  });
});
