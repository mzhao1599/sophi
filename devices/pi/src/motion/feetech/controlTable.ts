/**
 * The Feetech STS3215 control table (the servo's register memory), as typed constants.
 *
 * Sources (see README.md in this folder for links and the disagreements between them):
 * - Feetech's official SDKs, FTServo_Python `scservo_sdk/sms_sts.py` and FTServo_Arduino `src/SMS_STS.h`/`.cpp`
 *   (addresses they name, and the sign bits they apply when reading and writing).
 * - LeRobot v0.4.4 `src/lerobot/motors/feetech/tables.py` (`STS_SMS_SERIES_CONTROL_TABLE`,
 *   `STS_SMS_SERIES_ENCODINGS_TABLE`), which has driven SO-100/SO-101 arms of STS3215 servos.
 *
 * Every multi-byte field is little-endian on the STS series (Feetech's `End = 0`): low byte at the lower
 * address. The SCS series is big-endian; this table is for STS/SMS servos only.
 *
 * "eeprom" fields are kept across power cycles only when written with the Lock register at 0; this driver's
 * normal write path refuses them (see `FeetechBus.unlockAndWriteEeprom`). Units marked "assumed" come from
 * the vendor manual and SDK examples, not from a measurement on our servos.
 */

export type FieldArea = "eeprom" | "ram";
export type FieldAccess = "r" | "rw";

export interface ControlField {
  readonly address: number;
  readonly size: 1 | 2;
  readonly area: FieldArea;
  readonly access: FieldAccess;
  /** Sign-magnitude: this bit is the sign, the bits below it the magnitude. Absent: unsigned. */
  readonly signBit?: 10 | 11 | 15;
  /** Raw range the driver accepts when writing; narrower than the field where the manual says so. */
  readonly min?: number;
  readonly max?: number;
  readonly unit: string;
}

const eeprom = (address: number, size: 1 | 2, unit: string, extra: Partial<ControlField> = {}): ControlField => ({
  address,
  size,
  area: "eeprom",
  access: "rw",
  unit,
  ...extra,
});
const ram = (address: number, size: 1 | 2, unit: string, extra: Partial<ControlField> = {}): ControlField => ({
  address,
  size,
  area: "ram",
  access: "rw",
  unit,
  ...extra,
});

export const STS3215 = {
  // ---- EEPROM, read-only ----
  firmwareMajor: eeprom(0, 1, "version", { access: "r" }),
  firmwareMinor: eeprom(1, 1, "version", { access: "r" }),
  /** 777 (0x0309) for an STS3215 (LeRobot MODEL_NUMBER_TABLE). */
  modelNumber: eeprom(3, 2, "model", { access: "r" }),

  // ---- EEPROM, writable only through unlockAndWriteEeprom ----
  id: eeprom(5, 1, "id", { min: 0, max: 253 }),
  /** Index into the baud table (0 = 1,000,000). Indexes 5 and above differ between sources; see README. */
  baudRate: eeprom(6, 1, "index", { min: 0, max: 7 }),
  /** Unit 2 µs (LeRobot sets 0). */
  returnDelayTime: eeprom(7, 1, "2 µs", { min: 0, max: 254 }),
  /** 0: reply only to READ and PING. 1 (factory default): reply to every non-broadcast instruction. */
  responseStatusLevel: eeprom(8, 1, "level", { min: 0, max: 1 }),
  minPositionLimit: eeprom(9, 2, "step"),
  maxPositionLimit: eeprom(11, 2, "step"),
  maxTemperatureLimit: eeprom(13, 1, "°C"),
  maxVoltageLimit: eeprom(14, 1, "0.1 V"),
  minVoltageLimit: eeprom(15, 1, "0.1 V"),
  maxTorqueLimit: eeprom(16, 2, "0.1 %", { min: 0, max: 1000 }),
  phase: eeprom(18, 1, "bits"),
  unloadingCondition: eeprom(19, 1, "bits"),
  ledAlarmCondition: eeprom(20, 1, "bits"),
  pCoefficient: eeprom(21, 1, "gain"),
  dCoefficient: eeprom(22, 1, "gain"),
  iCoefficient: eeprom(23, 1, "gain"),
  /** LeRobot: 2 bytes at 24. Another vendor-derived table splits it into 24 (1 byte) and an integral limit at 25. */
  minimumStartupForce: eeprom(24, 2, "0.1 %"),
  cwDeadZone: eeprom(26, 1, "step"),
  ccwDeadZone: eeprom(27, 1, "step"),
  protectionCurrent: eeprom(28, 2, "6.5 mA"),
  angularResolution: eeprom(30, 1, "factor"),
  /** Position correction ("Ofs"): sign bit 11 (LeRobot), magnitude up to 2047 steps. */
  homingOffset: eeprom(31, 2, "step", { signBit: 11 }),
  /** 0 position, 1 constant speed, 2 PWM open loop, 3 step. */
  operatingMode: eeprom(33, 1, "mode", { min: 0, max: 3 }),
  protectiveTorque: eeprom(34, 1, "1 %"),
  protectionTime: eeprom(35, 1, "10 ms"),
  overloadTorque: eeprom(36, 1, "1 %"),
  velocityP: eeprom(37, 1, "gain"),
  overCurrentProtectionTime: eeprom(38, 1, "10 ms"),
  velocityI: eeprom(39, 1, "gain"),

  // ---- RAM ----
  /**
   * 0 off, 1 on. The servo also accepts 2 (damping) and 128 (recalibrate the present position to 2048, which
   * rewrites the offset); this driver refuses both on purpose.
   */
  torqueEnable: ram(40, 1, "flag", { min: 0, max: 1 }),
  /**
   * Unit 100 step/s² (8.7°/s²), assumed from the vendor manual. The servo reads 0 as its maximum (and powers up
   * at 0), so this driver never writes 0: 1..254 only.
   */
  acceleration: ram(41, 1, "100 step/s²", { min: 1, max: 254 }),
  /**
   * Sign bit 15 on the wire (multi-turn targets), but this driver writes one turn only: 0..4095. A negative or
   * multi-turn goal is refused.
   */
  goalPosition: ram(42, 2, "step", { signBit: 15, min: 0, max: 4095 }),
  /** Feetech's SDKs write 0 here in position mode. In PWM mode (2) the manual uses it as PWM output with sign bit 10. */
  goalTime: ram(44, 2, "ms"),
  /**
   * Unsigned in position mode: Feetech's WritePosEx/SyncWritePosEx take it as a u16 (LeRobot and wheel mode use
   * bit 15 as a direction, so it is refused here). The servo reads 0 as its maximum speed (and powers up at 0),
   * so this driver never writes 0: 1..32767. Unit 1 step/s (about 0.0146 rpm), assumed.
   */
  goalSpeed: ram(46, 2, "step/s", { min: 1, max: 32767 }),
  /** Starts at maxTorqueLimit on power-up. */
  torqueLimit: ram(48, 2, "0.1 %", { min: 0, max: 1000 }),
  /** 1 (default): EEPROM writes are not kept across power-off. 0: they are. */
  lock: ram(55, 1, "flag", { min: 0, max: 1 }),
  presentPosition: ram(56, 2, "step", { access: "r", signBit: 15 }),
  presentSpeed: ram(58, 2, "step/s", { access: "r", signBit: 15 }),
  /** Share of PWM duty driving the motor, 0..1000. Sign bit 10 (both Feetech's SDK and LeRobot). */
  presentLoad: ram(60, 2, "0.1 %", { access: "r", signBit: 10 }),
  presentVoltage: ram(62, 1, "0.1 V", { access: "r" }),
  presentTemperature: ram(63, 1, "°C", { access: "r" }),
  asyncWriteFlag: ram(64, 1, "flag", { access: "r" }),
  /** Same bits as the status packet's error byte (SERVO_ERROR_BITS). */
  status: ram(65, 1, "bits", { access: "r" }),
  moving: ram(66, 1, "flag", { access: "r" }),
  /** Sign bit 15 in Feetech's Arduino SDK (`ReadCurrent`); LeRobot reads it unsigned. Agree below 32768. */
  presentCurrent: ram(69, 2, "6.5 mA", { access: "r", signBit: 15 }),
} as const satisfies Record<string, ControlField>;

export type FieldName = keyof typeof STS3215;
export const FIELD_NAMES = Object.keys(STS3215) as FieldName[];

/** The STS3215's model number (LeRobot MODEL_NUMBER_TABLE["sts3215"]). */
export const STS3215_MODEL_NUMBER = 777;
/** Steps per turn of the magnetic encoder (LeRobot MODEL_RESOLUTION["sts3215"]). */
export const STS3215_RESOLUTION = 4096;

/** The feedback block, addresses 56 to 70, read in one go (Feetech's Arduino `FeedBack`). */
export const FEEDBACK_START = STS3215.presentPosition.address;
export const FEEDBACK_LENGTH = STS3215.presentCurrent.address + STS3215.presentCurrent.size - FEEDBACK_START;

// ---- Encoding ----

/** Sign-magnitude encode: bit `signBit` is the sign, the lower bits the magnitude. Throws if it doesn't fit. */
export function encodeSignMagnitude(value: number, signBit: number): number {
  if (!Number.isInteger(value)) throw new RangeError(`${value} is not an integer`);
  const max = (1 << signBit) - 1;
  const magnitude = Math.abs(value);
  if (magnitude > max) throw new RangeError(`magnitude ${magnitude} exceeds ${max} (sign bit ${signBit})`);
  return value < 0 ? (1 << signBit) | magnitude : magnitude;
}

/**
 * Sign-magnitude decode. Bits above the sign bit are ignored, as LeRobot's `decode_sign_magnitude` does
 * (Feetech's SDK leaves them in; they are never set by a healthy servo). Note -0 (only the sign bit set) is 0.
 */
export function decodeSignMagnitude(raw: number, signBit: number): number {
  const magnitude = raw & ((1 << signBit) - 1);
  return (raw >> signBit) & 1 ? (magnitude === 0 ? 0 : -magnitude) : magnitude;
}

export function writeUint16LE(value: number): [number, number] {
  return [value & 0xff, (value >> 8) & 0xff];
}

export function readUint16LE(bytes: ArrayLike<number>, offset = 0): number {
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

/** A field value as the bytes to write, after range and sign checks. */
export function encodeField(field: ControlField, value: number): number[] {
  if (!Number.isInteger(value)) throw new RangeError(`${value} is not an integer`);
  if (field.min !== undefined && value < field.min) throw new RangeError(`${value} is below ${field.min}`);
  if (field.max !== undefined && value > field.max) throw new RangeError(`${value} is above ${field.max}`);
  let raw: number;
  if (field.signBit !== undefined) {
    raw = encodeSignMagnitude(value, field.signBit);
  } else {
    const max = field.size === 1 ? 0xff : 0xffff;
    if (value < 0 || value > max) throw new RangeError(`${value} doesn't fit an unsigned ${field.size}-byte field`);
    raw = value;
  }
  return field.size === 1 ? [raw] : writeUint16LE(raw);
}

/** A field's value from the bytes read at its address. */
export function decodeField(field: ControlField, bytes: ArrayLike<number>, offset = 0): number {
  const raw = field.size === 1 ? (bytes[offset] ?? 0) : readUint16LE(bytes, offset);
  return field.signBit === undefined ? raw : decodeSignMagnitude(raw, field.signBit);
}

/** Decodes several fields out of one block read that starts at `start`. */
export function decodeBlock<K extends FieldName>(names: readonly K[], start: number, bytes: ArrayLike<number>): Record<K, number> {
  const out = {} as Record<K, number>;
  for (const name of names) {
    const field: ControlField = STS3215[name];
    const offset = field.address - start;
    if (offset < 0 || offset + field.size > bytes.length) throw new RangeError(`${name} is outside the block read`);
    out[name] = decodeField(field, bytes, offset);
  }
  return out;
}

/** The smallest contiguous span that covers these fields. */
export function spanOf(names: readonly FieldName[]): { start: number; length: number } {
  if (names.length === 0) throw new RangeError("no fields");
  const fields: ControlField[] = names.map((name) => STS3215[name]);
  const start = Math.min(...fields.map((f) => f.address));
  const end = Math.max(...fields.map((f) => f.address + f.size));
  return { start, length: end - start };
}
