import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FeetechBus, type FeetechError } from "../src/motion/feetech/bus";
import {
  FIELD_NAMES,
  STS3215,
  type ControlField,
  type FieldName,
  decodeField,
  encodeField,
  encodeSignMagnitude,
  writeUint16LE,
} from "../src/motion/feetech/controlTable";
import {
  type StatusFrame,
  StatusParser,
  encodeAction,
  encodePing,
  encodeRead,
  encodeRegWrite,
  encodeSyncRead,
  encodeSyncWrite,
  encodeWrite,
  fromHex,
  toHex,
} from "../src/motion/feetech/protocol";
import { FakeStsBus } from "../src/sim/fakeFeetech";
import { ScriptedPort } from "./support/feetech";
import { FakeClock } from "./support/fakes";

/**
 * Differential test against Feetech's Python SDK: the vectors in fixtures/feetech-golden.json were produced by
 * `feetech-servo-sdk` (scripts/feetech_golden.py). Our encoder and our bus must send the same bytes, and agree
 * with the SDK on every status packet it accepted or refused.
 */

interface EncodeCase {
  name: string;
  op: string;
  args: Record<string, unknown>;
  packets: string[];
}
interface DecodeCase {
  name: string;
  id: number;
  field: FieldName;
  rx: string;
  result: number;
  error: number;
  data?: number[];
  value?: number;
}
interface SyncCase {
  ids: number[];
  address: number;
  length: number;
  rx: string;
  result: number;
  values: Record<string, number>;
}
interface Golden {
  sdk: { package: string; version: string };
  comm: { COMM_SUCCESS: number; COMM_RX_TIMEOUT: number; COMM_RX_CORRUPT: number };
  table: Record<string, { address: number; size: number; signBit: number | null }>;
  encode: EncodeCase[];
  decode: DecodeCase[];
  syncRead: SyncCase[];
}

const golden = JSON.parse(readFileSync(new URL("fixtures/feetech-golden.json", import.meta.url), "utf8")) as Golden;
const field = (name: string): ControlField => STS3215[name as FieldName];

type Goal = { id: number; position: number; speed: number; acceleration: number };
/** The union of every op's arguments in the fixture (each op uses its own subset). */
interface OpArgs {
  id: number;
  field: FieldName;
  value: number;
  address: number;
  length: number;
  ids: number[];
  goals: Goal[];
  values: Array<{ id: number; value: number }>;
}

/**
 * A value's bytes by the field's wire layout alone (size, sign bit, little-endian), without the driver's range
 * check, so samples the bus refuses (negative goals, speed 0) still check the layout against the SDK.
 */
function encodeLayout(f: ControlField, value: number): number[] {
  const raw = f.signBit !== undefined ? encodeSignMagnitude(value, f.signBit) : value;
  return f.size === 1 ? [raw] : writeUint16LE(raw);
}

function inRange(f: ControlField, value: number): boolean {
  return (f.min === undefined || value >= f.min) && (f.max === undefined || value <= f.max);
}

/** Our encoder's packets for one SDK operation. */
function encodeOp(c: EncodeCase): Uint8Array[] {
  const a = c.args as unknown as OpArgs;
  switch (c.op) {
    case "ping":
      return [encodePing(a.id), encodeRead(a.id, 3, 2)];
    case "read":
      return [encodeRead(a.id, field(a.field).address, field(a.field).size)];
    case "readRaw":
      return [encodeRead(a.id, a.address, a.length)];
    case "write":
      return [encodeWrite(a.id, field(a.field).address, encodeLayout(field(a.field), a.value))];
    case "broadcastTorqueOff":
      return [encodeWrite(0xfe, 40, [0])];
    case "regWrite":
      return [encodeRegWrite(a.id, field(a.field).address, encodeLayout(field(a.field), a.value))];
    case "action":
      return [encodeAction(a.id)];
    case "syncRead":
      return [encodeSyncRead(a.ids, a.address, a.length)];
    case "syncWriteGoalPositions":
      return [
        encodeSyncWrite(
          42,
          2,
          a.goals.map((g) => ({ id: g.id, data: encodeLayout(STS3215.goalPosition, g.position) })),
        ),
      ];
    case "syncWriteGoals":
      return [
        encodeSyncWrite(
          41,
          7,
          a.goals.map((g) => ({
            id: g.id,
            data: [g.acceleration, ...encodeField(STS3215.goalPosition, g.position), 0, 0, ...encodeField(STS3215.goalSpeed, g.speed)],
          })),
        ),
      ];
    case "syncWrite":
      return [
        encodeSyncWrite(
          field(a.field).address,
          field(a.field).size,
          a.values.map((v) => ({ id: v.id, data: encodeField(field(a.field), v.value) })),
        ),
      ];
    default:
      throw new Error(`unknown op ${c.op}`);
  }
}

const SYNC_READ_FIELDS: Record<string, FieldName[]> = {
  "56+2": ["presentPosition"],
  "56+15": ["presentPosition", "presentCurrent"],
  "62+2": ["presentVoltage", "presentTemperature"],
  "40+1": ["torqueEnable"],
};

const isRamWritable = (name: FieldName) => STS3215[name].area === "ram" && STS3215[name].access === "rw" && name !== "lock";

/**
 * Runs the same operation through FeetechBus. Returns the packets it sent, "none" when the bus has no such call
 * (REG_WRITE, ACTION, a goal-position-only sync write), or "refused" once it has checked the bus refuses the
 * value or field without sending anything.
 */
async function busOp(c: EncodeCase): Promise<Uint8Array[] | "none" | "refused"> {
  const clock = new FakeClock();
  const port = new FakeStsBus(clock, { ids: [0, 1, 2, 3, 4, 5, 6, 252, 253] });
  const bus = new FeetechBus({ port, clock, retries: 0 });
  const a = c.args as unknown as OpArgs;
  switch (c.op) {
    case "ping":
      await bus.ping(a.id);
      await bus.read(a.id, "modelNumber");
      break;
    case "read":
      await bus.read(a.id, a.field);
      break;
    case "readRaw":
      await bus.readRaw(a.id, a.address, a.length);
      break;
    case "write":
      if (!isRamWritable(a.field)) {
        await expect(bus.write(a.id, a.field, a.value)).rejects.toMatchObject({ kind: "refused" });
        expect(port.received).toHaveLength(0);
        return "refused";
      }
      if (!inRange(field(a.field), a.value)) {
        await expect(bus.write(a.id, a.field, a.value)).rejects.toThrow(RangeError);
        expect(port.received).toHaveLength(0);
        return "refused";
      }
      await bus.write(a.id, a.field, a.value);
      break;
    case "broadcastTorqueOff":
      await bus.broadcastTorqueOff();
      break;
    case "syncRead":
      await bus.syncRead(a.ids, SYNC_READ_FIELDS[`${a.address}+${a.length}`]!);
      break;
    case "syncWriteGoals":
      await bus.syncWriteGoals(a.goals);
      break;
    case "syncWrite":
      await bus.syncWrite(a.field, a.values);
      break;
    default:
      return "none";
  }
  return port.received;
}

describe(`golden vectors from ${golden.sdk.package} ${golden.sdk.version}`, () => {
  it("G1: our control table matches LeRobot's addresses, sizes and sign bits, field for field", () => {
    expect(Object.keys(golden.table).sort()).toEqual([...FIELD_NAMES].sort());
    for (const [name, ref] of Object.entries(golden.table)) {
      const ours = field(name);
      expect({ name, address: ours.address, size: ours.size, signBit: ours.signBit ?? null }).toEqual({
        name,
        address: ref.address,
        size: ref.size,
        signBit: ref.signBit,
      });
    }
  });

  it("G2: covers every operation the SDK produced", () => {
    expect(golden.encode.length).toBeGreaterThan(100);
    expect(new Set(golden.encode.map((c) => c.op))).toEqual(
      new Set(["ping", "read", "readRaw", "write", "broadcastTorqueOff", "regWrite", "action", "syncRead", "syncWriteGoalPositions", "syncWriteGoals", "syncWrite"]),
    );
  });

  it.each(golden.encode)("G3: encoder is byte-identical: $name", (c) => {
    expect(encodeOp(c).map(toHex)).toEqual(c.packets);
  });

  it.each(golden.encode)("G4: bus sends byte-identical packets: $name", async (c) => {
    const sent = await busOp(c);
    if (sent === "none") {
      expect(["regWrite", "action", "syncWriteGoalPositions"]).toContain(c.op);
      return;
    }
    if (sent === "refused") return;
    expect(sent.map(toHex)).toEqual(c.packets);
  });

  it.each(golden.decode)("G5: parser agrees with the SDK: $name", (c) => {
    const frames: StatusFrame[] = [];
    new StatusParser((event) => {
      if (event.kind === "frame") frames.push(event.frame);
    }).push(fromHex(c.rx));
    const ours = frames.find((f) => f.id === c.id && f.params.length === field(c.field).size);
    if (c.result === golden.comm.COMM_SUCCESS) {
      expect(ours).toBeDefined();
      expect(ours!.error).toBe(c.error);
      expect(Array.from(ours!.params)).toEqual(c.data);
      expect(decodeField(field(c.field), ours!.params)).toBe(c.value);
    } else {
      expect(ours).toBeUndefined();
    }
  });

  it.each(golden.decode)("G6: bus read agrees with the SDK: $name", async (c) => {
    const clock = new FakeClock();
    const port = new ScriptedPort();
    port.replies.push(fromHex(c.rx));
    const bus = new FeetechBus({ port, clock, retries: 0 });
    const result = bus.read(c.id, c.field).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, e }),
    );
    await clock.advance(200);
    const outcome = await result;
    if (c.result === golden.comm.COMM_SUCCESS) {
      expect(outcome).toEqual({ ok: true, r: { value: c.value, error: c.error } });
    } else {
      expect(outcome.ok).toBe(false);
      const kind = (outcome as { e: FeetechError }).e.kind;
      // The SDK calls a bad checksum and an unparseable packet both COMM_RX_CORRUPT; we report the bad
      // checksum as such, and a packet we had to discard (error byte above 0x7f) as no reply.
      expect(kind).toBe(c.name === "corrupt checksum" ? "checksum" : "timeout");
    }
  });

  it.each(golden.syncRead)("G7: bus sync read agrees with GroupSyncRead for ids $ids", async (c) => {
    expect(c.result).toBe(golden.comm.COMM_SUCCESS);
    const clock = new FakeClock();
    const port = new ScriptedPort();
    port.replies.push(fromHex(c.rx));
    const bus = new FeetechBus({ port, clock, retries: 0 });
    const positions = await bus.syncReadPositions(c.ids);
    expect(Object.fromEntries([...positions].map(([id, r]) => [String(id), r.value]))).toEqual(c.values);
    expect(toHex(port.writes[0]!)).toBe(toHex(encodeSyncRead(c.ids, c.address, c.length)));
  });
});
