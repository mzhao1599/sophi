/**
 * Feetech SCS/STS packet protocol (a Dynamixel Protocol 1.0 dialect), byte for byte as Feetech's SDK builds it.
 *
 * Instruction packet: FF FF ID LEN INST PARAM... CHECKSUM
 * Status packet:      FF FF ID LEN ERROR PARAM... CHECKSUM
 * LEN counts INST/ERROR, the parameters and the checksum (parameters + 2). CHECKSUM = ~(ID + LEN + every byte
 * after LEN except itself) & 0xFF. The golden-vector test checks these encoders against `feetech-servo-sdk`.
 */

export const HEADER = 0xff;
export const BROADCAST_ID = 0xfe;
/**
 * Highest id an instruction may address: the manual's id range is 0..253 and the SDK sends PING/READ to any
 * id below 254 (its `MAX_ID` of 252 only bounds a broadcast-ping scan). Status packets with a higher id are
 * refused, as the SDK refuses them.
 */
export const MAX_ID = 0xfd;
/** Feetech's SDK refuses longer packets (TXPACKET_MAX_LEN / RXPACKET_MAX_LEN). */
export const MAX_PACKET_LENGTH = 250;

export const Instruction = {
  PING: 0x01,
  READ: 0x02,
  WRITE: 0x03,
  REG_WRITE: 0x04,
  ACTION: 0x05,
  /** Factory reset ("RECOVERY" in FTServo_Arduino INST.h). Never sent by this driver. */
  RECOVERY: 0x06,
  /** "RESET" in FTServo_Arduino/FTServo_Python (0x0A); not in feetech-servo-sdk 1.0.0. Never sent by this driver. */
  RESET: 0x0a,
  /** Middle-position calibration ("CAL"/OFSCAL, 0x0B). Rewrites the offset; never sent by this driver. */
  CALIBRATE: 0x0b,
  SYNC_READ: 0x82,
  SYNC_WRITE: 0x83,
} as const;

/** Bits of a status packet's error byte, and of the status register (65). Bits 4, 6 and 7 are undefined. */
export const SERVO_ERROR_BITS = {
  voltage: 0x01,
  angleSensor: 0x02,
  overheat: 0x04,
  overcurrent: 0x08,
  overload: 0x20,
} as const;
export type ServoErrorName = keyof typeof SERVO_ERROR_BITS;

export function servoErrorNames(bits: number): ServoErrorName[] {
  return (Object.keys(SERVO_ERROR_BITS) as ServoErrorName[]).filter((name) => bits & SERVO_ERROR_BITS[name]);
}

export function checksum(bytes: ArrayLike<number>, from: number, to: number): number {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += bytes[i] ?? 0;
  return ~sum & 0xff;
}

function assertByte(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new RangeError(`${what} ${value} is not a byte`);
}

function assertTargetId(id: number, allowBroadcast: boolean): void {
  assertByte(id, "id");
  if (id === BROADCAST_ID && allowBroadcast) return;
  if (id > MAX_ID) throw new RangeError(`id ${id} is not a servo id (0..${MAX_ID})`);
}

/** Any instruction packet. Prefer the named encoders below, which check their arguments. */
export function encodeInstruction(id: number, instruction: number, params: ArrayLike<number> = []): Uint8Array {
  assertByte(id, "id");
  assertByte(instruction, "instruction");
  const length = params.length + 2;
  if (length + 4 > MAX_PACKET_LENGTH) throw new RangeError(`packet of ${length + 4} bytes exceeds ${MAX_PACKET_LENGTH}`);
  const packet = new Uint8Array(length + 4);
  packet[0] = HEADER;
  packet[1] = HEADER;
  packet[2] = id;
  packet[3] = length;
  packet[4] = instruction;
  for (let i = 0; i < params.length; i += 1) {
    const value = params[i] ?? 0;
    assertByte(value, "parameter");
    packet[5 + i] = value;
  }
  packet[packet.length - 1] = checksum(packet, 2, packet.length - 1);
  return packet;
}

export function encodePing(id: number): Uint8Array {
  assertTargetId(id, false);
  return encodeInstruction(id, Instruction.PING);
}

export function encodeRead(id: number, address: number, length: number): Uint8Array {
  assertTargetId(id, false);
  assertByte(address, "address");
  if (!Number.isInteger(length) || length < 1 || length > MAX_PACKET_LENGTH - 6) throw new RangeError(`read length ${length}`);
  return encodeInstruction(id, Instruction.READ, [address, length]);
}

export function encodeWrite(id: number, address: number, data: ArrayLike<number>): Uint8Array {
  assertTargetId(id, true);
  assertByte(address, "address");
  if (data.length === 0) throw new RangeError("nothing to write");
  return encodeInstruction(id, Instruction.WRITE, [address, ...Array.from(data)]);
}

export function encodeRegWrite(id: number, address: number, data: ArrayLike<number>): Uint8Array {
  assertTargetId(id, true);
  assertByte(address, "address");
  if (data.length === 0) throw new RangeError("nothing to write");
  return encodeInstruction(id, Instruction.REG_WRITE, [address, ...Array.from(data)]);
}

export function encodeAction(id: number = BROADCAST_ID): Uint8Array {
  assertTargetId(id, true);
  return encodeInstruction(id, Instruction.ACTION);
}

function assertDistinctIds(ids: readonly number[]): void {
  if (ids.length === 0) throw new RangeError("no ids");
  for (const id of ids) assertTargetId(id, false);
  if (new Set(ids).size !== ids.length) throw new RangeError("ids repeat");
}

/** SYNC READ, broadcast: each listed servo answers with its own status packet, in list order. */
export function encodeSyncRead(ids: readonly number[], address: number, length: number): Uint8Array {
  assertDistinctIds(ids);
  assertByte(address, "address");
  if (!Number.isInteger(length) || length < 1 || length > MAX_PACKET_LENGTH - 6) throw new RangeError(`read length ${length}`);
  return encodeInstruction(BROADCAST_ID, Instruction.SYNC_READ, [address, length, ...ids]);
}

/** SYNC WRITE, broadcast: the same `length` bytes at `address` for each servo; no servo replies. */
export function encodeSyncWrite(address: number, length: number, entries: ReadonlyArray<{ id: number; data: ArrayLike<number> }>): Uint8Array {
  assertDistinctIds(entries.map((e) => e.id));
  assertByte(address, "address");
  if (!Number.isInteger(length) || length < 1) throw new RangeError(`write length ${length}`);
  const params: number[] = [address, length];
  for (const { id, data } of entries) {
    if (data.length !== length) throw new RangeError(`id ${id} has ${data.length} bytes, expected ${length}`);
    params.push(id, ...Array.from(data));
  }
  return encodeInstruction(BROADCAST_ID, Instruction.SYNC_WRITE, params);
}

// ---- Status packets ----

export interface StatusFrame {
  id: number;
  /** The error byte: SERVO_ERROR_BITS. */
  error: number;
  params: Uint8Array;
  /** The whole packet as received. */
  raw: Uint8Array;
}

export type ParseEvent =
  | { kind: "frame"; frame: StatusFrame }
  /** Bytes dropped while resynchronising: `reason` says why. */
  | { kind: "corrupt"; reason: "checksum" | "bad_header_fields"; dropped: number };

/**
 * Streaming status-packet parser: feed it bytes as they arrive, in any chunking. Like Feetech's `rxPacket`, it
 * looks for FF FF, rejects an id above 0xFD, a length outside 2..250 or an error byte above 0x7F by dropping
 * one byte and searching again, and checks the checksum. On a bad checksum it drops one byte (not the whole
 * claimed length), so a good packet hidden inside a corrupt one's claimed length is still found.
 */
export class StatusParser {
  private buffer: number[] = [];

  constructor(private readonly onEvent: (event: ParseEvent) => void) {}

  get buffered(): number {
    return this.buffer.length;
  }

  reset(): void {
    this.buffer = [];
  }

  push(chunk: ArrayLike<number>): void {
    for (let i = 0; i < chunk.length; i += 1) this.buffer.push(chunk[i] ?? 0);
    this.drain();
  }

  private drain(): void {
    for (;;) {
      const start = this.findHeader();
      if (start < 0) {
        // Keep a trailing FF: it may be the first half of a header.
        this.buffer = this.buffer.length > 0 && this.buffer[this.buffer.length - 1] === HEADER ? [HEADER] : [];
        return;
      }
      if (start > 0) this.buffer.splice(0, start);
      if (this.buffer.length < 6) return;
      const id = this.buffer[2]!;
      const length = this.buffer[3]!;
      const error = this.buffer[4]!;
      if (id === HEADER) {
        // FF FF FF: the header starts one byte later.
        this.buffer.splice(0, 1);
        continue;
      }
      if (id > 0xfd || length < 2 || length > MAX_PACKET_LENGTH || error > 0x7f) {
        this.buffer.splice(0, 1);
        this.onEvent({ kind: "corrupt", reason: "bad_header_fields", dropped: 1 });
        continue;
      }
      const total = length + 4;
      if (this.buffer.length < total) return;
      const packet = this.buffer.slice(0, total);
      if (checksum(packet, 2, total - 1) !== packet[total - 1]) {
        this.buffer.splice(0, 1);
        this.onEvent({ kind: "corrupt", reason: "checksum", dropped: 1 });
        continue;
      }
      this.buffer.splice(0, total);
      const raw = Uint8Array.from(packet);
      this.onEvent({ kind: "frame", frame: { id, error, params: raw.slice(5, total - 1), raw } });
    }
  }

  private findHeader(): number {
    for (let i = 0; i + 1 < this.buffer.length; i += 1) {
      if (this.buffer[i] === HEADER && this.buffer[i + 1] === HEADER) return i;
    }
    return -1;
  }
}

/** Builds a status packet (what a servo sends). Used by the fake servos and tests. */
export function encodeStatus(id: number, error: number, params: ArrayLike<number> = []): Uint8Array {
  return encodeInstruction(id, error, params);
}

export function toHex(bytes: ArrayLike<number>): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 2 !== 0) throw new RangeError("odd hex length");
  return Uint8Array.from({ length: clean.length / 2 }, (_, i) => Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16));
}
