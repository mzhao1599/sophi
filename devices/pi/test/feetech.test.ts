import { describe, expect, it } from "vitest";
import { FeetechBus, FeetechError } from "../src/motion/feetech/bus";
import {
  FEEDBACK_LENGTH,
  FEEDBACK_START,
  FIELD_NAMES,
  STS3215,
  decodeField,
  decodeSignMagnitude,
  encodeField,
  encodeSignMagnitude,
  readUint16LE,
  spanOf,
  writeUint16LE,
} from "../src/motion/feetech/controlTable";
import { feetechSttyArgs } from "../src/motion/feetech/port";
import {
  BROADCAST_ID,
  type ParseEvent,
  SERVO_ERROR_BITS,
  StatusParser,
  checksum,
  encodeInstruction,
  encodePing,
  encodeRead,
  encodeStatus,
  encodeSyncRead,
  encodeSyncWrite,
  encodeWrite,
  fromHex,
  servoErrorNames,
  toHex,
} from "../src/motion/feetech/protocol";
import { FakeStsBus } from "../src/sim/fakeFeetech";
import { ScriptedPort } from "./support/feetech";
import { FakeClock, flush } from "./support/fakes";

/** Settles a promise while advancing the fake clock, so timeouts can fire. */
async function settle<T>(clock: FakeClock, promise: Promise<T>, ms = 1000): Promise<{ ok: true; value: T } | { ok: false; error: FeetechError }> {
  const outcome = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: error as FeetechError }),
  );
  await clock.advance(ms);
  return outcome;
}

function setup(options: { ids?: number[]; echoPort?: boolean; echoBus?: boolean; retries?: number } = {}) {
  const clock = new FakeClock();
  const port = new FakeStsBus(clock, { ids: options.ids, echo: options.echoPort });
  const bus = new FeetechBus({ port, clock, echo: options.echoBus, retries: options.retries });
  return { clock, port, bus };
}

describe("packets", () => {
  it("F1: checksum is ~(sum from id to the last parameter) & 0xFF", () => {
    expect(toHex(encodePing(1))).toBe("ff ff 01 02 01 fb");
    expect(checksum([0xff, 0xff, 0x01, 0x02, 0x01], 2, 5)).toBe(0xfb);
    // A sum past 255 wraps before inverting.
    const packet = encodeWrite(0xfd, 0xff, [0xff, 0xff]);
    expect(packet[packet.length - 1]).toBe(~(0xfd + 5 + 3 + 0xff + 0xff + 0xff) & 0xff);
    // Every encoder ends with a checksum the parser accepts as a status packet would be.
    for (let id = 0; id <= 0xfd; id += 1) {
      const p = encodeRead(id, 56, 2);
      expect(checksum(p, 2, p.length - 1)).toBe(p[p.length - 1]);
    }
  });

  it("F2: refuses ids, addresses, lengths and parameters that aren't bytes or would overflow a packet", () => {
    expect(() => encodePing(BROADCAST_ID)).toThrow(RangeError);
    expect(() => encodePing(0xff)).toThrow(RangeError);
    expect(() => encodeRead(1, 256, 2)).toThrow(RangeError);
    expect(() => encodeRead(1, 56, 0)).toThrow(RangeError);
    expect(() => encodeWrite(1, 42, [])).toThrow(RangeError);
    expect(() => encodeWrite(1, 42, [256])).toThrow(RangeError);
    expect(() => encodeInstruction(1, 3, new Array(247).fill(0))).toThrow(RangeError);
    expect(() => encodeSyncRead([1, 1], 56, 2)).toThrow(/repeat/);
    expect(() => encodeSyncWrite(42, 2, [{ id: 1, data: [0] }])).toThrow(/expected 2/);
    expect(toHex(encodeWrite(BROADCAST_ID, 40, [0]))).toBe("ff ff fe 04 03 28 00 d2");
  });

  it("F3: error bits name the faults the SDK names", () => {
    expect(servoErrorNames(0)).toEqual([]);
    expect(servoErrorNames(0x25)).toEqual(["voltage", "overheat", "overload"]);
    expect(SERVO_ERROR_BITS).toEqual({ voltage: 1, angleSensor: 2, overheat: 4, overcurrent: 8, overload: 32 });
  });
});

describe("control table encoding", () => {
  it("F4: every field round-trips its extremes, little-endian", () => {
    for (const name of FIELD_NAMES) {
      const field = STS3215[name];
      const samples =
        field.min !== undefined || field.max !== undefined
          ? [field.min ?? 0, field.max ?? (field.size === 1 ? 255 : 65535)]
          : field.signBit !== undefined
            ? [0, 1, -1, (1 << field.signBit) - 1, -((1 << field.signBit) - 1)]
            : [0, field.size === 1 ? 255 : 65535];
      for (const value of samples) {
        const bytes = encodeField(field, value);
        expect(bytes, `${name}=${value}`).toHaveLength(field.size);
        expect(decodeField(field, bytes), `${name}=${value}`).toBe(value);
      }
    }
    expect(encodeField(STS3215.goalPosition, 0x0234)).toEqual([0x34, 0x02]);
    expect(encodeField(STS3215.torqueLimit, 0x03e8)).toEqual([0xe8, 0x03]);
    expect(writeUint16LE(0xabcd)).toEqual([0xcd, 0xab]);
    expect(readUint16LE([0xcd, 0xab])).toBe(0xabcd);
  });

  it("F5: sign-magnitude edge cases at bits 10, 11 and 15", () => {
    expect(encodeSignMagnitude(-1, 15)).toBe(0x8001);
    expect(encodeSignMagnitude(-2047, 11)).toBe(0x0fff);
    expect(encodeSignMagnitude(1023, 10)).toBe(0x03ff);
    expect(encodeSignMagnitude(-1023, 10)).toBe(0x07ff);
    expect(() => encodeSignMagnitude(1024, 10)).toThrow(RangeError);
    expect(() => encodeSignMagnitude(-2048, 11)).toThrow(RangeError);
    expect(() => encodeSignMagnitude(32768, 15)).toThrow(RangeError);
    expect(() => encodeSignMagnitude(1.5, 15)).toThrow(RangeError);
    // Negative zero (the sign bit alone) reads as 0, never -0.
    expect(Object.is(decodeSignMagnitude(0x8000, 15), 0)).toBe(true);
    expect(Object.is(decodeSignMagnitude(0x0400, 10), 0)).toBe(true);
    // Bits above the sign bit are ignored.
    expect(decodeSignMagnitude(0xfc05, 10)).toBe(-5);
    expect(decodeSignMagnitude(0xf805, 10)).toBe(5);
    expect(decodeSignMagnitude(0x0800 | 100, 11)).toBe(-100);
    // A 2's-complement reading would be wrong: 0x8064 is -100, not -32668.
    expect(decodeField(STS3215.presentSpeed, [0x64, 0x80])).toBe(-100);
  });

  it("F6: writes are range-checked per field", () => {
    expect(() => encodeField(STS3215.torqueEnable, 128)).toThrow(RangeError);
    expect(() => encodeField(STS3215.torqueEnable, 2)).toThrow(RangeError);
    expect(() => encodeField(STS3215.torqueLimit, 1001)).toThrow(RangeError);
    expect(() => encodeField(STS3215.acceleration, 255)).toThrow(RangeError);
    expect(() => encodeField(STS3215.goalTime, -1)).toThrow(RangeError);
    expect(() => encodeField(STS3215.homingOffset, 2048)).toThrow(RangeError);
  });

  it("F7: the feedback block spans addresses 56..70", () => {
    expect([FEEDBACK_START, FEEDBACK_LENGTH]).toEqual([56, 15]);
    expect(spanOf(["presentVoltage", "presentTemperature"])).toEqual({ start: 62, length: 2 });
  });
});

describe("status parser", () => {
  const good = encodeStatus(3, 0, [0x00, 0x08]);

  function parse(...chunks: Uint8Array[]) {
    const events: ParseEvent[] = [];
    const parser = new StatusParser((e) => events.push(e));
    for (const chunk of chunks) parser.push(chunk);
    return events;
  }

  it("F8: reassembles a packet split at every byte boundary", () => {
    for (let cut = 1; cut < good.length; cut += 1) {
      const events = parse(good.subarray(0, cut), good.subarray(cut));
      expect(events, `cut ${cut}`).toEqual([{ kind: "frame", frame: expect.objectContaining({ id: 3, error: 0 }) }]);
    }
  });

  it("F9: skips noise and a repeated FF, and finds a good packet hidden inside a corrupt one's length", () => {
    expect(parse(fromHex("00 13 ff"), good).filter((e) => e.kind === "frame")).toHaveLength(1);
    // A corrupt header claiming 0x10 bytes, followed by a real packet inside that span.
    const corrupt = fromHex("ff ff 05 10 00");
    const events = parse(Uint8Array.from([...corrupt, ...good, ...new Array(20).fill(0)]));
    expect(events.filter((e) => e.kind === "corrupt")).toEqual([{ kind: "corrupt", reason: "checksum", dropped: 1 }]);
    expect(events.filter((e) => e.kind === "frame")).toHaveLength(1);
  });
});

describe("bus transactions", () => {
  it("F10: reads, writes and pings a fake servo", async () => {
    const { bus } = setup();
    expect(await bus.ping(1)).toEqual({ value: null, error: 0 });
    expect(await bus.read(1, "modelNumber")).toEqual({ value: 777, error: 0 });
    expect(await bus.write(2, "torqueLimit", 500)).toEqual({ id: 2, error: 0 });
    expect((await bus.read(2, "torqueLimit")).value).toBe(500);
    const fields = await bus.readFields(1, ["presentVoltage", "presentTemperature"]);
    expect(fields.value).toEqual({ presentVoltage: 120, presentTemperature: 25 });
  });

  it("F11: a silent servo times out after exactly 1 + retries attempts, all counted", async () => {
    const { clock, port, bus } = setup({ retries: 2 });
    port.servo(4).faults.silent = true;
    const outcome = await settle(clock, bus.read(4, "presentPosition"));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error).toBeInstanceOf(FeetechError);
      expect(outcome.error.kind).toBe("timeout");
      expect(outcome.error.details.attempts).toBe(3);
      expect(outcome.error.details.ids).toEqual([4]);
    }
    expect(bus.stats).toMatchObject({ exchanges: 3, retries: 2, timeouts: 3, failures: 1 });
    expect(port.received).toHaveLength(3);
  });

  it("F12: the deadline is the configured timeout, not more", async () => {
    const clock = new FakeClock();
    const port = new ScriptedPort();
    const bus = new FeetechBus({ port, clock, retries: 0, timeoutMs: 20 });
    let settled = false;
    const p = bus.ping(1).catch(() => {
      settled = true;
    });
    await clock.advance(19);
    expect(settled).toBe(false);
    await clock.advance(2);
    await p;
    expect(settled).toBe(true);
  });

  it("F13: a reply from another id is ignored and counted while the right one is awaited", async () => {
    const { bus, port } = setup();
    const p = bus.read(1, "presentPosition");
    port.inject(encodeStatus(2, 0, [0x34, 0x12]));
    expect((await p).value).toBe(2048);
    expect(bus.stats.wrongIdReplies).toBe(1);
  });

  it("F14: a corrupt reply is retried once and the retry succeeds", async () => {
    const { bus, port, clock } = setup();
    port.servo(1).faults.corruptReplies = 1;
    const outcome = await settle(clock, bus.read(1, "presentPosition"));
    expect(outcome).toEqual({ ok: true, value: { value: 2048, error: 0 } });
    expect(bus.stats).toMatchObject({ exchanges: 2, retries: 1, checksumErrors: 1, failures: 0 });
  });

  it("F15: a reply of the wrong length is malformed and retried", async () => {
    const clock = new FakeClock();
    const port = new ScriptedPort();
    port.replies.push(encodeStatus(1, 0, [0x00]), encodeStatus(1, 0, [0x00, 0x08]));
    const bus = new FeetechBus({ port, clock });
    const outcome = await settle(clock, bus.read(1, "presentPosition"));
    expect(outcome).toEqual({ ok: true, value: { value: 2048, error: 0 } });
    expect(bus.stats).toMatchObject({ malformedReplies: 1, retries: 1 });
  });

  it("F16: one transaction at a time: the next request isn't written until the previous reply is in", async () => {
    const clock = new FakeClock();
    const port = new ScriptedPort();
    port.hold = true;
    port.replies.push(encodeStatus(1, 0, [0x00, 0x08]), encodeStatus(2, 0, [0x01, 0x00]));
    const bus = new FeetechBus({ port, clock });
    const first = bus.read(1, "presentPosition");
    const second = bus.read(2, "presentPosition");
    await flush();
    expect(port.writes).toHaveLength(1);
    expect(bus.queueLength).toBe(2);
    port.release();
    expect((await first).value).toBe(2048);
    await flush();
    expect(port.writes).toHaveLength(2);
    port.release();
    expect((await second).value).toBe(1);
    expect(bus.queueLength).toBe(0);
  });

  it("F17: a failed call doesn't block the queue, and a late reply is discarded during the settle gap", async () => {
    const clock = new FakeClock();
    const port = new ScriptedPort();
    const bus = new FeetechBus({ port, clock, retries: 0, settleMs: 5 });
    const failed = settle(clock, bus.read(1, "presentPosition"), 60);
    expect((await failed).ok).toBe(false);
    port.replies.push(encodeStatus(1, 0, [0x05, 0x00]));
    const next = bus.read(1, "presentPosition");
    // The stale reply to the failed read arrives during the gap: discarded, not taken as the answer.
    port.emit(encodeStatus(1, 0, [0x09, 0x00]));
    await flush();
    expect(port.writes).toHaveLength(1);
    await clock.advance(5);
    expect((await next).value).toBe(5);
    expect(bus.stats.strayBytes).toBe(8);
  });

  it("F18: a fault bit comes back as data, without a retry", async () => {
    const { bus, port } = setup();
    port.servo(3).faults.errorBits = SERVO_ERROR_BITS.overload;
    expect(await bus.read(3, "presentPosition")).toEqual({ value: 2048, error: 0x20 });
    expect(bus.lastError(3)).toBe(0x20);
    expect(bus.stats).toMatchObject({ exchanges: 1, retries: 0, servoErrorReplies: 1 });
  });

  it("F19: sync read of ids 1-6 decodes each servo's feedback", async () => {
    const { bus, port } = setup();
    port.servo(5).set("presentPosition", 100);
    const feedback = await bus.readFeedback([1, 2, 3, 4, 5, 6]);
    expect([...feedback.keys()]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(feedback.get(1)!.value).toMatchObject({ presentPosition: 2048, presentVoltage: 120, presentTemperature: 25, moving: 0, status: 0 });
    expect(toHex(port.received[0]!)).toBe(toHex(encodeSyncRead([1, 2, 3, 4, 5, 6], 56, 15)));
  });

  it("F20: sync read retries only the missing id, then reports it with the others' data", async () => {
    const { bus, port, clock } = setup({ retries: 1 });
    port.servo(4).faults.silent = true;
    const outcome = await settle(clock, bus.syncReadPositions([1, 2, 3, 4, 5, 6]));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("timeout");
      expect(outcome.error.details.ids).toEqual([4]);
      expect([...outcome.error.details.partial!.keys()].sort()).toEqual([1, 2, 3, 5, 6]);
    }
    expect(port.received.map(toHex)).toEqual([toHex(encodeSyncRead([1, 2, 3, 4, 5, 6], 56, 2)), toHex(encodeSyncRead([4], 56, 2))]);
  });

  it("F21: sync write of goals reaches every servo without a reply", async () => {
    const { bus, port } = setup();
    await bus.syncWriteGoals([1, 2, 3, 4, 5, 6].map((id) => ({ id, position: 1000 + id, speed: 500, acceleration: 20 })));
    for (let id = 1; id <= 6; id += 1) {
      expect(port.servo(id).get("goalPosition")).toBe(1000 + id);
      expect(port.servo(id).get("goalSpeed")).toBe(500);
      expect(port.servo(id).get("acceleration")).toBe(20);
    }
    const goal = { id: 1, position: 2000, speed: 500, acceleration: 20 };
    const sent = port.received.length;
    await expect(bus.syncWriteGoals([goal, { ...goal }])).rejects.toThrow(/repeat/);
    // One turn only, and never speed or acceleration 0 (which the servo reads as "maximum").
    for (const bad of [{ position: -5 }, { position: 4096 }, { speed: 0 }, { speed: 32768 }, { speed: -100 }, { acceleration: 0 }, { acceleration: 255 }]) {
      await expect(bus.syncWriteGoals([{ ...goal, ...bad }]), JSON.stringify(bad)).rejects.toThrow(RangeError);
    }
    await expect(bus.write(1, "goalPosition", -1)).rejects.toThrow(RangeError);
    await expect(bus.write(1, "goalPosition", 4096)).rejects.toThrow(RangeError);
    await expect(bus.write(1, "goalSpeed", 0)).rejects.toThrow(RangeError);
    await expect(bus.write(1, "acceleration", 0)).rejects.toThrow(RangeError);
    expect(port.received).toHaveLength(sent);
    expect("syncWriteGoalPositions" in bus).toBe(false);
  });

  it("F21b: only broadcastTorqueOff may use the broadcast id", async () => {
    const { bus, port } = setup();
    await expect(bus.write(BROADCAST_ID, "goalPosition", 4000)).rejects.toMatchObject({ kind: "refused" });
    await expect(bus.setTorque([1, BROADCAST_ID], true)).rejects.toMatchObject({ kind: "refused" });
    await expect(bus.unlockAndWriteEeprom(BROADCAST_ID, "maxPositionLimit", 3000)).rejects.toMatchObject({ kind: "refused" });
    await expect(bus.syncWrite("goalPosition", [{ id: BROADCAST_ID, value: 4000 }])).rejects.toThrow(RangeError);
    await expect(bus.syncWriteGoals([{ id: BROADCAST_ID, position: 4000, speed: 100, acceleration: 10 }])).rejects.toThrow(RangeError);
    expect(port.received).toHaveLength(0);
    expect([1, 2, 3, 4, 5, 6].map((id) => port.servo(id).get("goalPosition"))).toEqual([2048, 2048, 2048, 2048, 2048, 2048]);
  });

  it("F21c: a failed setTorque says which ids were applied and which may have been", async () => {
    const { bus, port, clock } = setup();
    port.servo(2).faults.silent = true;
    const outcome = await settle(clock, bus.setTorque([1, 2, 3], true));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("timeout");
      expect(outcome.error.details).toMatchObject({ applied: [1], possiblyApplied: [2] });
      expect(outcome.error.message).toMatch(/applied to 1/);
    }
    expect([1, 3].map((id) => port.servo(id).torqueOn)).toEqual([true, false]);
  });

  it("F21d: a write that never completes still times out at the deadline", async () => {
    const clock = new FakeClock();
    const port = new ScriptedPort();
    port.write = () => new Promise<void>(() => {});
    const bus = new FeetechBus({ port, clock, retries: 1, timeoutMs: 20 });
    const outcome = await settle(clock, bus.read(1, "presentPosition"), 200);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe("timeout");
    expect(bus.stats).toMatchObject({ exchanges: 2, timeouts: 2, failures: 1 });
  });

  it("F22: torque on and off, acknowledged per id, and a broadcast torque off", async () => {
    const { bus, port } = setup();
    const on = await bus.setTorque([1, 2, 3], true);
    expect(on).toEqual([1, 2, 3].map((id) => ({ id, error: 0 })));
    expect([1, 2, 3].map((id) => port.servo(id).torqueOn)).toEqual([true, true, true]);
    await bus.broadcastTorqueOff();
    expect([1, 2, 3].map((id) => port.servo(id).torqueOn)).toEqual([false, false, false]);
    expect(toHex(port.received.at(-1)!)).toBe("ff ff fe 04 03 28 00 d2");
  });

  it("F23: with Response Status Level 0, writes don't wait for an acknowledgement", async () => {
    const clock = new FakeClock();
    const port = new FakeStsBus(clock);
    port.servo(1).set("responseStatusLevel", 0);
    const bus = new FeetechBus({ port, clock, responseStatusLevel: 0 });
    expect(await bus.write(1, "goalPosition", 100)).toEqual({ id: 1, error: null });
    expect((await bus.read(1, "goalPosition")).value).toBe(100);
  });

  it("F24: a closed port fails the open call and every later one", async () => {
    const { bus, port, clock } = setup();
    port.servo(1).faults.silent = true;
    const pending = bus.read(1, "presentPosition");
    const later = bus.read(2, "presentPosition");
    await flush();
    port.unplug();
    const a = await settle(clock, pending, 10);
    const b = await settle(clock, later, 10);
    expect(!a.ok && a.error.kind).toBe("closed");
    expect(!b.ok && b.error.kind).toBe("closed");
  });
});

describe("EEPROM stays off the motion path", () => {
  it("F25: the normal write refuses EEPROM fields, Lock, and torque values other than 0 and 1", async () => {
    const { bus, port } = setup();
    await expect(bus.write(1, "id", 7)).rejects.toMatchObject({ kind: "refused" });
    await expect(bus.write(1, "maxPositionLimit", 3000)).rejects.toMatchObject({ kind: "refused" });
    await expect(bus.write(1, "lock", 0)).rejects.toMatchObject({ kind: "refused" });
    await expect(bus.write(1, "presentPosition", 0)).rejects.toMatchObject({ kind: "refused" });
    await expect(bus.syncWrite("homingOffset", [{ id: 1, value: 0 }])).rejects.toMatchObject({ kind: "refused" });
    await expect(bus.write(1, "torqueEnable", 128)).rejects.toThrow(RangeError);
    expect(port.received).toHaveLength(0);
  });

  it("F26: unlockAndWriteEeprom refuses with torque on, and otherwise unlocks, writes, relocks and verifies", async () => {
    const { bus, port } = setup();
    await bus.setTorque([1], true);
    await expect(bus.unlockAndWriteEeprom(1, "maxPositionLimit", 3000)).rejects.toMatchObject({ kind: "refused" });
    await bus.setTorque([1], false);
    const before = port.received.length;
    expect(await bus.unlockAndWriteEeprom(1, "maxPositionLimit", 3000)).toEqual({ id: 1, error: 0 });
    expect(port.received.slice(before).map(toHex)).toEqual(
      [
        encodeRead(1, 40, 1),
        encodeWrite(1, 55, [0]),
        encodeWrite(1, 11, [0xb8, 0x0b]),
        encodeWrite(1, 55, [1]),
        encodeRead(1, 11, 2),
      ].map(toHex),
    );
    port.servo(1).powerCycle();
    expect(port.servo(1).get("maxPositionLimit")).toBe(3000);
    expect(port.servo(1).get("lock")).toBe(1);
    await expect(bus.unlockAndWriteEeprom(1, "goalPosition", 1)).rejects.toMatchObject({ kind: "refused" });
  });

  it("F27: changing an id relocks and verifies at the new id", async () => {
    const { bus, port, clock } = setup({ ids: [1, 2] });
    // The new id must be free.
    expect(await settle(clock, bus.unlockAndWriteEeprom(1, "id", 2))).toMatchObject({ ok: false, error: { kind: "refused" } });
    expect(port.servo(1).get("lock")).toBe(1);
    expect(await settle(clock, bus.unlockAndWriteEeprom(1, "id", 9))).toEqual({ ok: true, value: { id: 9, error: null } });
    expect(port.received.slice(-5).map(toHex)).toEqual(
      [encodePing(9), encodeWrite(1, 55, [0]), encodeWrite(1, 5, [9]), encodeWrite(9, 55, [1]), encodeRead(9, 5, 1)].map(toHex),
    );
    port.servo(9).powerCycle();
    expect(port.servo(9).get("lock")).toBe(1);
    expect((await bus.ping(9)).error).toBe(0);
  });
});

describe("half-duplex echo", () => {
  it("F28: detectEcho tells an echoing adapter from a gated one", async () => {
    const echoing = setup({ echoPort: true });
    const echoResult = settle(echoing.clock, echoing.bus.detectEcho(1), 100);
    expect(await echoResult).toEqual({ ok: true, value: { echo: true, replied: true, bytes: 16 } });
    const gated = setup();
    expect(await settle(gated.clock, gated.bus.detectEcho(1), 100)).toEqual({ ok: true, value: { echo: false, replied: true, bytes: 8 } });
  });

  it("F29: echo mode consumes and checks our own bytes before the reply", async () => {
    const { bus, port } = setup({ echoPort: true, echoBus: true });
    expect(await bus.read(1, "modelNumber")).toEqual({ value: 777, error: 0 });
    expect(await bus.write(1, "goalPosition", 10)).toEqual({ id: 1, error: 0 });
    await bus.syncWriteGoals([{ id: 1, position: 20, speed: 100, acceleration: 10 }]);
    expect(port.servo(1).get("goalPosition")).toBe(20);
    expect(bus.stats.echoMismatches).toBe(0);
  });

  it("F30: echo mode fails a mangled echo and retries", async () => {
    const clock = new FakeClock();
    const port = new ScriptedPort();
    const request = encodeRead(1, 56, 2);
    const mangled = Uint8Array.from(request);
    mangled[5] = 0;
    port.replies.push(Uint8Array.from([...mangled, ...encodeStatus(1, 0, [0, 8])]));
    port.replies.push(Uint8Array.from([...request, ...encodeStatus(1, 0, [0, 8])]));
    const bus = new FeetechBus({ port, clock, echo: true });
    expect(await settle(clock, bus.read(1, "presentPosition"))).toEqual({ ok: true, value: { value: 2048, error: 0 } });
    expect(bus.stats).toMatchObject({ echoMismatches: 1, retries: 1 });
    // Mangled every time: the call fails as an echo mismatch.
    for (let i = 0; i < 3; i += 1) port.replies.push(Uint8Array.from([...mangled, ...encodeStatus(1, 0, [0, 8])]));
    const outcome = await settle(clock, bus.read(1, "presentPosition"));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error.kind).toBe("echo_mismatch");
  });

  it("F31: without echo mode, an echoing adapter still reads right: the echo is set aside", async () => {
    const { bus } = setup({ echoPort: true });
    expect(await bus.read(1, "modelNumber")).toEqual({ value: 777, error: 0 });
    expect(await bus.write(1, "goalPosition", 10)).toEqual({ id: 1, error: 0 });
    expect(bus.stats.echoSuspected).toBe(2);
  });

  it("F32: without echo mode, only a copy of our request coming back fails as echo_mismatch, never as data", async () => {
    // An echoing adapter in front of a silent servo: before, the echo of a READ parsed as a reply (value 568).
    const { bus, port, clock } = setup({ echoPort: true });
    port.servo(3).faults.silent = true;
    const outcome = await settle(clock, bus.read(3, "presentPosition"));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.error.kind).toBe("echo_mismatch");
      expect(outcome.error.message).toMatch(/set echo: true/);
    }
    // The cost: a PING answered with the voltage fault bit is byte-identical to the PING, so it fails the same way
    // (detectEcho at startup tells the two apart).
    const clock2 = new FakeClock();
    const scripted = new ScriptedPort();
    expect(toHex(encodeStatus(1, SERVO_ERROR_BITS.voltage))).toBe(toHex(encodePing(1)));
    scripted.replies.push(encodeStatus(1, SERVO_ERROR_BITS.voltage));
    const bus2 = new FeetechBus({ port: scripted, clock: clock2, retries: 0 });
    const ping = await settle(clock2, bus2.ping(1));
    expect(!ping.ok && ping.error.kind).toBe("echo_mismatch");
  });
});

describe("fake STS3215", () => {
  it("F33: moves to the goal at the commanded speed and acceleration, then stops", async () => {
    const { bus, port, clock } = setup();
    await bus.write(1, "goalSpeed", 1000);
    await bus.write(1, "acceleration", 10); // 1000 step/s²
    await bus.setTorque([1], true);
    await bus.write(1, "goalPosition", 3048);
    await clock.advance(1000);
    const mid = (await bus.readFeedback([1])).get(1)!.value;
    // Accelerating for 1 s at 1000 step/s² covers about 500 steps and reaches about 1000 step/s.
    expect(mid.presentPosition).toBeGreaterThan(2048 + 400);
    expect(mid.presentPosition).toBeLessThan(2048 + 600);
    expect(mid.presentSpeed).toBeGreaterThan(900);
    expect(mid.moving).toBe(1);
    await clock.advance(1500);
    const end = (await bus.readFeedback([1])).get(1)!.value;
    expect(end).toMatchObject({ presentPosition: 3048, presentSpeed: 0, moving: 0 });
    expect(port.servo(1).get("presentPosition")).toBe(3048);
  });

  it("F34: with torque off a goal doesn't move it; by default torque on then drives to that goal", async () => {
    const { bus, clock } = setup();
    await bus.write(1, "goalPosition", 100);
    await clock.advance(1000);
    expect((await bus.read(1, "presentPosition")).value).toBe(2048);
    await bus.setTorque([1], true);
    await clock.advance(3000);
    // The real servo's behaviour is unknown, so the fake defaults to the dangerous one: the arm jumps.
    expect((await bus.read(1, "presentPosition")).value).toBe(100);
    // With torqueOnHoldsPosition, the servo holds where it is instead.
    const clock2 = new FakeClock();
    const port2 = new FakeStsBus(clock2, { torqueOnHoldsPosition: true });
    const bus2 = new FeetechBus({ port: port2, clock: clock2 });
    await bus2.write(1, "goalPosition", 100);
    await bus2.setTorque([1], true);
    await clock2.advance(3000);
    expect((await bus2.read(1, "presentPosition")).value).toBe(2048);
  });

  it("F35: a goal past the angle limits stops at the limit", async () => {
    const { bus, port, clock } = setup();
    port.servo(2).set("maxPositionLimit", 2500);
    await bus.setTorque([2], true);
    await bus.write(2, "goalPosition", 4000);
    await clock.advance(3000);
    expect((await bus.read(2, "presentPosition")).value).toBe(2500);
  });

  it("F36: a sustained overload sets the overload bit and drops torque", async () => {
    const { bus, port, clock } = setup();
    await bus.setTorque([3], true);
    port.servo(3).externalLoad = 900; // above the 80 % overload threshold
    await clock.advance(1000);
    expect((await bus.read(3, "presentLoad")).value).toBe(900);
    await clock.advance(1500); // past the 2 s protection time
    const reply = await bus.read(3, "torqueEnable");
    expect(reply).toEqual({ value: 0, error: SERVO_ERROR_BITS.overload });
    const fb = (await bus.readFeedback([3])).get(3)!;
    expect(fb.value.status & SERVO_ERROR_BITS.overload).toBeTruthy();
    expect(fb.value.presentLoad).toBe(0);
    // In the fake, turning torque back on clears the latch (unverified on a real servo).
    port.servo(3).externalLoad = 0;
    expect((await bus.setTorque([3], true))[0]!.error).toBe(0);
    expect(port.servo(3).torqueOn).toBe(true);
  });

  it("F37: a supply drop below the minimum voltage sets the voltage bit; load heats the servo", async () => {
    const { bus, port, clock } = setup();
    port.servo(4).supplyVoltage = 3.5;
    expect(await bus.read(4, "presentVoltage")).toEqual({ value: 35, error: SERVO_ERROR_BITS.voltage });
    await bus.setTorque([5], true);
    port.servo(5).externalLoad = -700;
    await clock.advance(10_000);
    const fb = (await bus.readFeedback([5])).get(5)!.value;
    expect(fb.presentLoad).toBe(-700);
    expect(fb.presentTemperature).toBeGreaterThan(25);
    expect(fb.presentCurrent).toBe(280);
  });

  it("F38: stty settings for a binary 8N1 link at 1 Mbaud", () => {
    expect(feetechSttyArgs("/dev/serial/by-id/x", 1_000_000, "linux")).toEqual([
      "-F",
      "/dev/serial/by-id/x",
      "1000000",
      "raw",
      "-echo",
      "cs8",
      "-parenb",
      "-cstopb",
      "-crtscts",
      "clocal",
    ]);
  });
});
