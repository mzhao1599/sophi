import type { Clock } from "../clock";
import { STS3215, STS3215_MODEL_NUMBER, decodeField, encodeField, type FieldName } from "../motion/feetech/controlTable";
import type { FeetechPort } from "../motion/feetech/port";
import { BROADCAST_ID, Instruction, SERVO_ERROR_BITS, checksum, encodeStatus } from "../motion/feetech/protocol";

/**
 * Simulated STS3215 servos on one bus, at the byte level: a FeetechPort that parses instruction packets, keeps
 * each servo's control-table memory, moves toward the goal at the commanded speed and acceleration, and
 * answers with status packets. For tests, the simulator and the motion coordinator; never presented as hardware.
 *
 * The physics is a plausible model, not a measured one: trapezoidal motion, a load that follows an injectable
 * external load plus a little for motion, heating with load, and Feetech's protections (overload, overheat,
 * voltage) acting through the Unloading Condition bits. Defaults marked "fake" are chosen, not read off a servo.
 */

/** Fake: top speed when Goal Speed is 0 (Feetech's examples use 3400 step/s as the maximum). */
const FAKE_MAX_SPEED = 3400;
/** Fake: acceleration when Acceleration is 0 ("maximum"), in step/s². */
const FAKE_MAX_ACCEL = 254 * 100;
const STEP_MS = 1;

export interface FakeServoFaults {
  /** Ignores every packet, as an unplugged servo would. */
  silent?: boolean;
  /** Acts on packets but sends no reply. */
  noReply?: boolean;
  /** The next N replies have a wrong checksum. */
  corruptReplies?: number;
  /** ORed into every reply's error byte and the status register. */
  errorBits?: number;
}

export interface FakeServoOptions {
  id: number;
  /** Present position at power-on, in steps. */
  position?: number;
  /**
   * What turning torque on does to the goal register. The real STS3215's behaviour isn't known yet, so the
   * default is the dangerous one: false keeps a goal written while torque was off, and the servo drives to it
   * as soon as torque comes on. true copies the present position into the goal first (the servo holds).
   * Either way, the motion layer must write goal = present position before enabling torque.
   */
  torqueOnHoldsPosition?: boolean;
}

/** Fake EEPROM defaults: plausible STS3215 values, not read from a real servo. */
function factoryEeprom(id: number): Array<[FieldName, number]> {
  return [
    ["firmwareMajor", 3],
    ["firmwareMinor", 10],
    ["modelNumber", STS3215_MODEL_NUMBER],
    ["id", id],
    ["baudRate", 0],
    ["returnDelayTime", 0],
    ["responseStatusLevel", 1],
    ["minPositionLimit", 0],
    ["maxPositionLimit", 4095],
    ["maxTemperatureLimit", 70],
    ["maxVoltageLimit", 140],
    ["minVoltageLimit", 40],
    ["maxTorqueLimit", 1000],
    ["unloadingCondition", 0x2c],
    ["ledAlarmCondition", 0x2f],
    ["protectiveTorque", 20],
    ["protectionTime", 200],
    ["overloadTorque", 80],
    ["homingOffset", 0],
    ["operatingMode", 0],
  ];
}

export class FakeSts3215 {
  readonly memory = new Uint8Array(256);
  /** EEPROM as kept across power-off (written only while Lock is 0). */
  private saved = new Uint8Array(40);
  /** Encoder angle in steps (before the homing offset), and speed in step/s. */
  private encoder: number;
  private velocity = 0;
  private overloadMs = 0;
  private latched = 0;
  private pendingReg: { address: number; data: number[] } | null = null;
  /** Signed external load the servo must hold, in 0.1 % of full torque (gravity, a hand pushing). */
  externalLoad = 0;
  supplyVoltage = 12;
  ambientC = 25;
  temperatureC = 25;
  faults: FakeServoFaults = {};
  /** Instruction packets this servo acted on. */
  readonly log: Array<{ instruction: number; params: number[] }> = [];
  torqueOnHoldsPosition: boolean;

  constructor(options: FakeServoOptions) {
    this.torqueOnHoldsPosition = options.torqueOnHoldsPosition ?? false;
    for (const [name, value] of factoryEeprom(options.id)) this.set(name, value);
    this.saved = this.memory.slice(0, 40);
    this.encoder = options.position ?? 2048;
    this.powerOnRam();
  }

  get id(): number {
    return this.memory[STS3215.id.address]!;
  }

  get(name: FieldName): number {
    return decodeField(STS3215[name], this.memory, STS3215[name].address);
  }

  /** Sets a register directly (test setup), bypassing the protocol and the lock. */
  set(name: FieldName, value: number): void {
    const field = STS3215[name];
    this.memory.set(encodeField({ ...field, min: undefined, max: undefined }, value), field.address);
  }

  /** Power cycle: EEPROM comes back from what was saved, RAM from defaults. */
  powerCycle(): void {
    this.memory.set(this.saved, 0);
    this.velocity = 0;
    this.overloadMs = 0;
    this.latched = 0;
    this.pendingReg = null;
    this.powerOnRam();
  }

  private powerOnRam(): void {
    this.memory.fill(0, 40);
    this.set("lock", 1);
    this.set("torqueLimit", this.get("maxTorqueLimit"));
    this.refreshFeedback();
    this.set("goalPosition", this.get("presentPosition"));
  }

  get torqueOn(): boolean {
    return this.memory[STS3215.torqueEnable.address] === 1;
  }

  /** Error bits as the servo reports them now. */
  get errorBits(): number {
    return this.memory[STS3215.status.address]! | (this.faults.errorBits ?? 0);
  }

  /** Advances the physics by `ms`. */
  step(ms: number): void {
    const dt = ms / 1000;
    const offset = this.get("homingOffset");
    const limit = this.get("torqueLimit");
    if (this.torqueOn && this.get("operatingMode") === 0) {
      let goal = this.get("goalPosition");
      const min = this.get("minPositionLimit");
      const max = this.get("maxPositionLimit");
      if (!(min === 0 && max === 0)) goal = Math.min(max, Math.max(min, goal));
      const target = goal + offset;
      const speed = this.get("goalSpeed");
      const vmax = speed === 0 ? FAKE_MAX_SPEED : Math.min(Math.abs(speed), FAKE_MAX_SPEED);
      const accRaw = this.get("acceleration");
      const accel = accRaw === 0 ? FAKE_MAX_ACCEL : accRaw * 100;
      const stalled = Math.abs(this.externalLoad) >= limit;
      const distance = target - this.encoder;
      const desired = stalled ? 0 : Math.sign(distance) * Math.min(vmax, Math.sqrt(2 * accel * Math.abs(distance)));
      const dv = Math.max(-accel * dt, Math.min(accel * dt, desired - this.velocity));
      this.velocity += dv;
      const move = this.velocity * dt;
      if (Math.abs(move) >= Math.abs(distance) && Math.sign(move) === Math.sign(distance)) {
        this.encoder = target;
        this.velocity = 0;
      } else {
        this.encoder += move;
      }
    } else {
      this.velocity = 0;
    }
    const motionLoad = this.torqueOn ? Math.sign(this.velocity) * Math.min(200, (Math.abs(this.velocity) / FAKE_MAX_SPEED) * 200) : 0;
    const load = this.torqueOn ? Math.max(-limit, Math.min(limit, this.externalLoad + motionLoad)) : 0;
    // Heating with load, cooling toward ambient (fake rates).
    this.temperatureC += ((Math.abs(load) / 1000) * 2 - (this.temperatureC - this.ambientC) * 0.02) * dt;
    // Overload: above Overload Torque (%) for longer than Protection Time (10 ms units).
    if (this.torqueOn && Math.abs(load) > this.get("overloadTorque") * 10) this.overloadMs += ms;
    else this.overloadMs = 0;
    if (this.overloadMs > this.get("protectionTime") * 10) this.latched |= SERVO_ERROR_BITS.overload;
    if (this.temperatureC > this.get("maxTemperatureLimit")) this.latched |= SERVO_ERROR_BITS.overheat;
    let status = this.latched;
    const volts = Math.round(this.supplyVoltage * 10);
    if (volts < this.get("minVoltageLimit") || volts > this.get("maxVoltageLimit")) status |= SERVO_ERROR_BITS.voltage;
    this.memory[STS3215.status.address] = status;
    if (status & this.get("unloadingCondition")) this.memory[STS3215.torqueEnable.address] = 0;
    this.writeFeedback(load);
  }

  private refreshFeedback(): void {
    this.writeFeedback(0);
  }

  private writeFeedback(load: number): void {
    const present = Math.round(this.encoder - this.get("homingOffset"));
    const wrapped = ((present % 4096) + 4096) % 4096;
    this.set("presentPosition", wrapped);
    this.set("presentSpeed", Math.round(this.velocity));
    this.set("presentLoad", Math.round(load));
    this.set("presentVoltage", Math.min(255, Math.round(this.supplyVoltage * 10)));
    this.set("presentTemperature", Math.max(0, Math.min(255, Math.round(this.temperatureC))));
    this.set("presentCurrent", Math.round(Math.abs(load) * 0.4));
    this.memory[STS3215.moving.address] = this.torqueOn && (this.velocity !== 0 || Math.abs(this.get("goalPosition") - wrapped) > 1) ? 1 : 0;
  }

  /** Applies a WRITE (or an ACTION'd REG_WRITE) to memory, as the servo would. */
  applyWrite(address: number, data: number[]): void {
    for (let i = 0; i < data.length; i += 1) {
      const at = address + i;
      if (at >= STS3215.presentPosition.address || at <= 4) continue; // read-only
      if (at === STS3215.torqueEnable.address) {
        if (data[i]! > 1) continue; // damping (2) and recalibration (128) aren't modelled
        if (data[i] === 1 && !this.torqueOn) {
          // Assumptions, not checked on a servo: see torqueOnHoldsPosition; and turning torque on clears a
          // latched overload/overheat.
          if (this.torqueOnHoldsPosition) this.set("goalPosition", this.get("presentPosition"));
          this.latched = 0;
          this.overloadMs = 0;
        }
      }
      this.memory[at] = data[i]!;
      if (at < 40 && this.memory[STS3215.lock.address] === 0) this.saved[at] = data[i]!;
    }
  }

  /** Handles one instruction addressed to this servo; returns the reply's parameters, or null for no reply. */
  handle(instruction: number, params: number[], broadcast: boolean): number[] | null {
    this.log.push({ instruction, params });
    const level = this.memory[STS3215.responseStatusLevel.address];
    const ack = !broadcast && level === 1 ? [] : null;
    switch (instruction) {
      case Instruction.PING:
        return broadcast ? null : [];
      case Instruction.READ: {
        const [address = 0, length = 0] = params;
        return broadcast ? null : Array.from(this.memory.subarray(address, address + length));
      }
      case Instruction.WRITE:
        this.applyWrite(params[0] ?? 0, params.slice(1));
        return ack;
      case Instruction.REG_WRITE:
        this.pendingReg = { address: params[0] ?? 0, data: params.slice(1) };
        this.memory[STS3215.asyncWriteFlag.address] = 1;
        return ack;
      case Instruction.ACTION:
        if (this.pendingReg) this.applyWrite(this.pendingReg.address, this.pendingReg.data);
        this.pendingReg = null;
        this.memory[STS3215.asyncWriteFlag.address] = 0;
        return ack;
      default:
        return null;
    }
  }
}

export class FakeStsBus implements FeetechPort {
  readonly servos = new Map<number, FakeSts3215>();
  /** Every instruction packet received, valid or not. */
  readonly received: Uint8Array[] = [];
  /** Hands our own bytes back before any reply, like an adapter without TX/RX gating. */
  echo: boolean;
  /** Splits each reply into chunks of this many bytes (exercises reassembly). 0: whole. */
  chunkSize = 0;
  private readonly dataHandlers = new Set<(chunk: Uint8Array) => void>();
  private readonly closeHandlers: Array<(reason: string) => void> = [];
  private input: number[] = [];
  private lastUpdate: number;
  private closed = false;

  constructor(
    private readonly clock: Clock,
    options: { ids?: number[]; echo?: boolean; positions?: Record<number, number>; torqueOnHoldsPosition?: boolean } = {},
  ) {
    this.echo = options.echo ?? false;
    for (const id of options.ids ?? [1, 2, 3, 4, 5, 6]) {
      this.servos.set(id, new FakeSts3215({ id, position: options.positions?.[id], torqueOnHoldsPosition: options.torqueOnHoldsPosition }));
    }
    this.lastUpdate = clock.monotonic();
  }

  servo(id: number): FakeSts3215 {
    const servo = [...this.servos.values()].find((s) => s.id === id);
    if (!servo) throw new Error(`no fake servo with id ${id}`);
    return servo;
  }

  /** Brings every servo's physics up to the clock. */
  update(): void {
    const now = this.clock.monotonic();
    while (this.lastUpdate + STEP_MS <= now) {
      for (const servo of this.servos.values()) servo.step(STEP_MS);
      this.lastUpdate += STEP_MS;
    }
    // Refresh feedback and protections for changes made since (supply voltage, a write) with no time passing.
    for (const servo of this.servos.values()) servo.step(0);
  }

  /** Puts raw bytes on the line (noise, another device, a late reply). */
  inject(bytes: ArrayLike<number>): void {
    this.deliver(Uint8Array.from(bytes));
  }

  async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("port closed");
    const copy = Uint8Array.from(bytes);
    if (this.echo) this.deliver(copy);
    this.input.push(...copy);
    this.parse();
  }

  onData(fn: (chunk: Uint8Array) => void): () => void {
    this.dataHandlers.add(fn);
    return () => this.dataHandlers.delete(fn);
  }

  onClose(fn: (reason: string) => void): void {
    this.closeHandlers.push(fn);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const fn of this.closeHandlers) fn("closed");
  }

  /** Simulates the adapter being unplugged. */
  unplug(): void {
    this.close();
  }

  private deliver(bytes: Uint8Array): void {
    const size = this.chunkSize > 0 ? this.chunkSize : bytes.length;
    const chunks: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.slice(i, i + size));
    setImmediate(() => {
      if (this.closed) return;
      for (const chunk of chunks) for (const fn of this.dataHandlers) fn(chunk);
    });
  }

  private parse(): void {
    for (;;) {
      let start = -1;
      for (let i = 0; i + 1 < this.input.length; i += 1) {
        if (this.input[i] === 0xff && this.input[i + 1] === 0xff && this.input[i + 2] !== 0xff) {
          start = i;
          break;
        }
      }
      if (start < 0) return;
      this.input.splice(0, start);
      if (this.input.length < 4) return;
      const total = this.input[3]! + 4;
      if (this.input[3]! < 2) {
        this.input.splice(0, 1);
        continue;
      }
      if (this.input.length < total) return;
      const packet = this.input.slice(0, total);
      if (checksum(packet, 2, total - 1) !== packet[total - 1]) {
        this.input.splice(0, 1);
        continue;
      }
      this.input.splice(0, total);
      this.received.push(Uint8Array.from(packet));
      this.execute(packet[2]!, packet[4]!, packet.slice(5, total - 1));
    }
  }

  private listening(id: number): FakeSts3215 | undefined {
    const servo = [...this.servos.values()].find((s) => s.id === id);
    return servo && !servo.faults.silent ? servo : undefined;
  }

  private reply(servo: FakeSts3215, params: number[]): void {
    if (servo.faults.noReply) return;
    const packet = encodeStatus(servo.id, servo.errorBits & 0x7f, params);
    if ((servo.faults.corruptReplies ?? 0) > 0) {
      servo.faults.corruptReplies! -= 1;
      packet[packet.length - 1] = packet[packet.length - 1]! ^ 0x5a;
    }
    this.deliver(packet);
  }

  private execute(id: number, instruction: number, params: number[]): void {
    this.update();
    if (instruction === Instruction.SYNC_WRITE) {
      const [address = 0, length = 0] = params;
      for (let i = 2; i + length < params.length; i += length + 1) {
        this.listening(params[i]!)?.handle(Instruction.WRITE, [address, ...params.slice(i + 1, i + 1 + length)], true);
      }
      this.update();
      return;
    }
    if (instruction === Instruction.SYNC_READ) {
      const [address = 0, length = 0, ...ids] = params;
      // Each listed servo answers in list order; an absent one is simply skipped (an assumption about firmware).
      for (const target of ids) {
        const servo = this.listening(target);
        if (servo) this.reply(servo, Array.from(servo.memory.subarray(address, address + length)));
      }
      return;
    }
    if (id === BROADCAST_ID) {
      for (const servo of this.servos.values()) if (!servo.faults.silent) servo.handle(instruction, params, true);
      this.update();
      return;
    }
    const servo = this.listening(id);
    if (!servo) return;
    const out = servo.handle(instruction, params, false);
    this.update();
    if (out) this.reply(servo, out);
  }
}
