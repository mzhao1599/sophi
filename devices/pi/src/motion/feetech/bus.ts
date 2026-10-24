import type { Cancel, Clock } from "../../clock";
import { type Logger, silentLogger } from "../../log";
import {
  type ControlField,
  FEEDBACK_LENGTH,
  FEEDBACK_START,
  type FieldName,
  STS3215,
  decodeBlock,
  decodeField,
  encodeField,
  spanOf,
} from "./controlTable";
import { FEETECH_DEFAULT_BAUD, type FeetechPort } from "./port";
import {
  BROADCAST_ID,
  type StatusFrame,
  StatusParser,
  encodePing,
  encodeRead,
  encodeSyncRead,
  encodeSyncWrite,
  encodeWrite,
} from "./protocol";

/**
 * One Feetech STS servo bus (one arm's adapter), with no motion policy: it moves bytes and checks them.
 *
 * - One transaction at a time: every public call waits its turn in a strict queue, so a request and its reply
 *   are never interleaved with another's. Retries of a call happen inside its turn.
 * - Every reply is checked: checksum, the id it came from, and its length. A reply from another id is ignored
 *   (and counted) while the right one is awaited. Bytes that arrive outside a transaction are discarded.
 * - Each attempt has a deadline; a failed call is retried at most `retries` times, and every retry is counted.
 * - Normal writes reach RAM registers only, on one servo at a time: only `broadcastTorqueOff` uses the
 *   broadcast id. Goals are one turn (0..4095) and never carry speed or acceleration 0 ("maximum").
 *   EEPROM (ids, limits, offsets, mode) goes through `unlockAndWriteEeprom`, which motion code must never call.
 * - Run `detectEcho` at startup, before any motion, and build the bus with the `echo` it reports. Write
 *   goal = present position before enabling torque: whether the servo drives to an older goal is unknown.
 *
 * The servo's own fault bits (overload, overheat, voltage...) come back with every reply; they are reported,
 * never retried away. Deciding what to do about them is the motion coordinator's job.
 */

/** Placeholder, not measured: wait for a reply this long beyond the bytes' wire time (LeRobot's patched SDK uses 50 ms). */
export const FEETECH_REPLY_TIMEOUT_MS = 50;
/** Placeholder, not measured: retries after a failed attempt (so at most 3 attempts). */
export const FEETECH_RETRIES = 2;
/** Placeholder, not measured: after a failed attempt, input is ignored this long so a late reply can't be taken for the next one. */
export const FEETECH_SETTLE_MS = 5;

export type FeetechErrorKind =
  | "timeout"
  | "checksum"
  | "malformed"
  | "echo_mismatch"
  | "closed"
  | "write_failed"
  | "refused"
  | "verify_failed";

export class FeetechError extends Error {
  override name = "FeetechError";
  constructor(
    readonly kind: FeetechErrorKind,
    message: string,
    readonly details: {
      ids?: number[];
      attempts?: number;
      partial?: Map<number, StatusFrame>;
      /** setTorque: ids whose write was acknowledged before the failure. */
      applied?: number[];
      /** setTorque: the id that failed; its write may still have taken effect. */
      possiblyApplied?: number[];
    } = {},
  ) {
    super(message);
  }
}

export interface FeetechBusOptions {
  port: FeetechPort;
  clock: Clock;
  log?: Logger;
  /** For the wire-time part of each deadline. */
  baud?: number;
  timeoutMs?: number;
  retries?: number;
  settleMs?: number;
  /**
   * True if the adapter hands our own transmitted bytes back before the reply. The Waveshare Bus Servo
   * Adapter (A)'s schematic gates RX off while TX drives the line, so it should not; `detectEcho` checks.
   */
  echo?: boolean;
  /** The servos' Response Status Level (address 8). 1 (factory default): writes are acknowledged. */
  responseStatusLevel?: 0 | 1;
}

export interface BusStats {
  /** Packets sent, retries included. */
  exchanges: number;
  retries: number;
  /** Calls that failed after every attempt. */
  failures: number;
  timeouts: number;
  checksumErrors: number;
  malformedReplies: number;
  wrongIdReplies: number;
  echoMismatches: number;
  /** Frames identical to our own request, taken for an echo the adapter wasn't configured to send. */
  echoSuspected: number;
  strayBytes: number;
  /** Replies whose error byte had a fault bit set. */
  servoErrorReplies: number;
}

export interface ReadResult<T> {
  value: T;
  /** The reply's error byte (SERVO_ERROR_BITS); 0 when healthy. */
  error: number;
}

export interface WriteResult {
  id: number;
  /** The acknowledgement's error byte, or null when no acknowledgement is sent (broadcast, or level 0). */
  error: number | null;
}

export type Feedback = Record<
  "presentPosition" | "presentSpeed" | "presentLoad" | "presentVoltage" | "presentTemperature" | "status" | "moving" | "presentCurrent",
  number
>;
const FEEDBACK_FIELDS = [
  "presentPosition",
  "presentSpeed",
  "presentLoad",
  "presentVoltage",
  "presentTemperature",
  "status",
  "moving",
  "presentCurrent",
] as const satisfies readonly FieldName[];

type Problem = "timeout" | "checksum" | "malformed" | "echo_mismatch";

interface Pending {
  packet: Uint8Array;
  echoIndex: number;
  expect: Set<number> | null;
  paramLength: number;
  frames: Map<number, StatusFrame>;
  malformed: Set<number>;
  sawChecksumError: boolean;
  echoFailed: boolean;
  /** Frames byte-identical to our request, set aside: most likely our own echo (see onFrame). */
  suspects: Map<number, StatusFrame>;
  /** Raw capture for detectEcho. */
  capture: number[] | null;
  done: () => void;
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

function assertUnicast(id: number): void {
  if (id === BROADCAST_ID) throw new FeetechError("refused", "the broadcast id reaches every servo; only broadcastTorqueOff may use it");
}

const isRamWritable = (name: FieldName): boolean => {
  const field: ControlField = STS3215[name];
  return field.area === "ram" && field.access === "rw" && name !== "lock";
};

export class FeetechBus {
  private readonly port: FeetechPort;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly baud: number;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly settleMs: number;
  private readonly echo: boolean;
  private readonly level: 0 | 1;
  private readonly parser: StatusParser;
  private readonly lastErrors = new Map<number, number>();
  private pending: Pending | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private closedReason: string | null = null;
  private needSettle = false;
  private readonly counters: BusStats = {
    exchanges: 0,
    retries: 0,
    failures: 0,
    timeouts: 0,
    checksumErrors: 0,
    malformedReplies: 0,
    wrongIdReplies: 0,
    echoMismatches: 0,
    echoSuspected: 0,
    strayBytes: 0,
    servoErrorReplies: 0,
  };
  private readonly unsubscribe: () => void;

  constructor(options: FeetechBusOptions) {
    this.port = options.port;
    this.clock = options.clock;
    this.log = options.log ?? silentLogger;
    this.baud = options.baud ?? FEETECH_DEFAULT_BAUD;
    this.timeoutMs = options.timeoutMs ?? FEETECH_REPLY_TIMEOUT_MS;
    this.retries = Math.max(0, Math.floor(options.retries ?? FEETECH_RETRIES));
    this.settleMs = options.settleMs ?? FEETECH_SETTLE_MS;
    this.echo = options.echo ?? false;
    this.level = options.responseStatusLevel ?? 1;
    this.parser = new StatusParser((event) => {
      const p = this.pending;
      if (!p) return;
      if (event.kind === "corrupt") {
        if (event.reason === "checksum") {
          this.counters.checksumErrors += 1;
          p.sawChecksumError = true;
        }
        return;
      }
      this.onFrame(p, event.frame);
    });
    this.unsubscribe = this.port.onData((chunk) => this.onData(chunk));
    this.port.onClose((reason) => {
      this.closedReason = reason;
      this.pending?.done();
    });
  }

  get stats(): BusStats {
    return { ...this.counters };
  }

  /** Calls waiting for or holding the bus. */
  get queueLength(): number {
    return this.queued;
  }

  /** The last error byte seen from this id, or undefined if it never replied. */
  lastError(id: number): number | undefined {
    return this.lastErrors.get(id);
  }

  close(): void {
    this.unsubscribe();
    this.closedReason ??= "closed";
    this.pending?.done();
    this.port.close();
  }

  // ---- Public calls (each takes one turn on the bus) ----

  /** PING: resolves with the reply's error byte. */
  ping(id: number): Promise<ReadResult<null>> {
    return this.enqueue(async () => {
      const frame = await this.single(id, () => encodePing(id), 0, `ping ${id}`);
      return { value: null, error: frame.error };
    });
  }

  readRaw(id: number, address: number, length: number): Promise<ReadResult<Uint8Array>> {
    return this.enqueue(() => this.readRawNow(id, address, length));
  }

  read(id: number, name: FieldName): Promise<ReadResult<number>> {
    return this.enqueue(() => this.readNow(id, name));
  }

  /** Several fields in one READ of the span that covers them. */
  readFields<K extends FieldName>(id: number, names: readonly K[]): Promise<ReadResult<Record<K, number>>> {
    return this.enqueue(async () => {
      const { start, length } = spanOf(names);
      const result = await this.readRawNow(id, start, length);
      return { value: decodeBlock(names, start, result.value), error: result.error };
    });
  }

  /** One SYNC READ of the span covering `names` for every id. Retries ask again only for the ids still missing. */
  syncRead<K extends FieldName>(ids: readonly number[], names: readonly K[]): Promise<Map<number, ReadResult<Record<K, number>>>> {
    return this.enqueue(async () => {
      const { start, length } = spanOf(names);
      const frames = await this.request([...ids], (remaining) => encodeSyncRead(remaining, start, length), length, `sync read ${start}+${length}`);
      const out = new Map<number, ReadResult<Record<K, number>>>();
      for (const id of ids) {
        const frame = frames.get(id)!;
        out.set(id, { value: decodeBlock(names, start, frame.params), error: frame.error });
      }
      return out;
    });
  }

  async syncReadPositions(ids: readonly number[]): Promise<Map<number, ReadResult<number>>> {
    const all = await this.syncRead(ids, ["presentPosition"]);
    return new Map([...all].map(([id, r]) => [id, { value: r.value.presentPosition, error: r.error }]));
  }

  /** Position, speed, load, voltage, temperature, status, moving and current (addresses 56..70) for every id. */
  readFeedback(ids: readonly number[]): Promise<Map<number, ReadResult<Feedback>>> {
    return this.syncRead(ids, FEEDBACK_FIELDS);
  }

  /** WRITE one RAM register (never EEPROM, never Lock) on one servo (never the broadcast id). */
  async write(id: number, name: FieldName, value: number): Promise<WriteResult> {
    assertUnicast(id);
    this.assertRamWritable(name);
    const data = encodeField(STS3215[name], value);
    return this.enqueue(() => this.writeNow(id, STS3215[name].address, data, `write ${name} to ${id}`));
  }

  /** SYNC WRITE one RAM register on several servos. No servo acknowledges a sync write. */
  async syncWrite(name: FieldName, values: ReadonlyArray<{ id: number; value: number }>): Promise<void> {
    this.assertRamWritable(name);
    const field = STS3215[name];
    const packet = encodeSyncWrite(
      field.address,
      field.size,
      values.map(({ id, value }) => ({ id, data: encodeField(field, value) })),
    );
    return this.enqueue(() => this.sendOnly(packet, `sync write ${name}`));
  }

  /**
   * SYNC WRITE acceleration, goal position, goal time (0) and goal speed in one 7-byte block from address 41,
   * exactly as Feetech's `SyncWritePosEx` does. Speed and acceleration travel with every goal on purpose: both
   * power up at 0, which the servo reads as "as fast as possible", so there is no goal-position-only call. The
   * table's ranges apply: position 0..4095, speed 1..32767, acceleration 1..254.
   */
  async syncWriteGoals(goals: ReadonlyArray<{ id: number; position: number; speed: number; acceleration: number }>): Promise<void> {
    const packet = encodeSyncWrite(
      STS3215.acceleration.address,
      7,
      goals.map(({ id, position, speed, acceleration }) => ({
        id,
        data: [
          ...encodeField(STS3215.acceleration, acceleration),
          ...encodeField(STS3215.goalPosition, position),
          0,
          0,
          ...encodeField(STS3215.goalSpeed, speed),
        ],
      })),
    );
    return this.enqueue(() => this.sendOnly(packet, "sync write goals"));
  }

  /**
   * Acknowledged torque on/off for each id in turn (never the broadcast id). Stops at the first id that fails;
   * the error's details say which ids were applied and which one may have been.
   */
  async setTorque(ids: readonly number[], enabled: boolean): Promise<WriteResult[]> {
    for (const id of ids) assertUnicast(id);
    const data = encodeField(STS3215.torqueEnable, enabled ? 1 : 0);
    return this.enqueue(async () => {
      const results: WriteResult[] = [];
      for (const id of ids) {
        try {
          results.push(await this.writeNow(id, STS3215.torqueEnable.address, data, `torque ${enabled ? "on" : "off"} ${id}`));
        } catch (error) {
          if (!(error instanceof FeetechError)) throw error;
          throw new FeetechError(error.kind, `${error.message}; applied to ${results.map((r) => r.id).join(", ") || "none"}`, {
            ...error.details,
            applied: results.map((r) => r.id),
            possiblyApplied: [id],
          });
        }
      }
      return results;
    });
  }

  /** One broadcast WRITE of torque off to every servo on the bus. Unacknowledged: confirm with a read. */
  async broadcastTorqueOff(): Promise<void> {
    const packet = encodeWrite(BROADCAST_ID, STS3215.torqueEnable.address, [0]);
    return this.enqueue(() => this.sendOnly(packet, "broadcast torque off"));
  }

  /**
   * Setup only, never motion: writes one EEPROM field so it survives power-off (ids, limits, offset, mode).
   * Refuses while torque is on. Opens the lock, writes, closes the lock (at the new id when the id changes),
   * then reads the field back. Holds the bus for the whole sequence.
   */
  async unlockAndWriteEeprom(id: number, name: FieldName, value: number): Promise<WriteResult> {
    const field: ControlField = STS3215[name];
    if (field.area !== "eeprom" || field.access !== "rw") {
      throw new FeetechError("refused", `${name} is not a writable EEPROM field`);
    }
    assertUnicast(id);
    const data = encodeField(field, value);
    return this.enqueue(async () => {
      const torque = await this.readNow(id, "torqueEnable");
      if (torque.value !== 0) throw new FeetechError("refused", `torque is on for id ${id}; turn it off before writing EEPROM`, { ids: [id] });
      const changesId = name === "id" && value !== id;
      if (changesId) {
        // Two servos on one id would answer on top of each other: the new id must be free.
        const free = await this.request([value], () => encodePing(value), 0, `ping ${value}`).then(
          () => false,
          (error: unknown) => {
            if (error instanceof FeetechError && error.kind === "timeout") return true;
            throw error;
          },
        );
        if (!free) throw new FeetechError("refused", `id ${value} is already on the bus`, { ids: [value] });
      }
      const lock = STS3215.lock.address;
      await this.writeNow(id, lock, [0], `unlock ${id}`);
      let lockId = id;
      let result: WriteResult;
      try {
        if (changesId) {
          // Which id a servo acknowledges an id change from isn't documented, so don't wait for that
          // acknowledgement: let it pass during the settle gap, then relock and read back at the new id.
          await this.sendOnly(encodeWrite(id, field.address, data), `write id ${value} to ${id}`);
          if (this.level === 1) this.needSettle = true;
          lockId = value;
          result = { id: value, error: null };
        } else {
          result = await this.writeNow(id, field.address, data, `write ${name} to ${id}`);
        }
      } finally {
        await this.writeNow(lockId, lock, [1], `lock ${lockId}`).catch((error: unknown) => {
          this.log.error("couldn't relock servo EEPROM", { id: lockId, error: (error as Error).message });
          throw error;
        });
      }
      const check = await this.readNow(lockId, name);
      if (check.value !== value) {
        throw new FeetechError("verify_failed", `${name} on ${lockId} reads ${check.value}, wrote ${value}`, { ids: [lockId] });
      }
      return { ...result, id: lockId };
    });
  }

  /**
   * Bench check: does the adapter echo our own bytes? Sends a READ of the model number (whose genuine reply can
   * never equal the request) and reports whether the request came back first and whether the servo replied.
   */
  async detectEcho(id: number): Promise<{ echo: boolean; replied: boolean; bytes: number }> {
    const packet = encodeRead(id, STS3215.modelNumber.address, STS3215.modelNumber.size);
    return this.enqueue(async () => {
      const captured = await this.capture(packet);
      const echo = packet.every((byte, i) => captured[i] === byte);
      const rest = echo ? captured.slice(packet.length) : captured;
      let replied = false;
      new StatusParser((event) => {
        if (event.kind === "frame" && event.frame.id === id && event.frame.params.length === 2) replied = true;
      }).push(rest);
      return { echo, replied, bytes: captured.length };
    });
  }

  // ---- Inside a turn ----

  private async readRawNow(id: number, address: number, length: number): Promise<ReadResult<Uint8Array>> {
    const frame = await this.single(id, () => encodeRead(id, address, length), length, `read ${address}+${length} from ${id}`);
    return { value: frame.params, error: frame.error };
  }

  private async readNow(id: number, name: FieldName): Promise<ReadResult<number>> {
    const field: ControlField = STS3215[name];
    const raw = await this.readRawNow(id, field.address, field.size);
    return { value: decodeField(field, raw.value), error: raw.error };
  }

  private async writeNow(id: number, address: number, data: number[], what: string): Promise<WriteResult> {
    assertUnicast(id);
    const packet = encodeWrite(id, address, data);
    if (this.level === 0) {
      await this.sendOnly(packet, what);
      return { id, error: null };
    }
    const frame = await this.single(id, () => packet, 0, what);
    return { id, error: frame.error };
  }

  private async single(id: number, build: () => Uint8Array, paramLength: number, what: string): Promise<StatusFrame> {
    const frames = await this.request([id], build, paramLength, what);
    return frames.get(id)!;
  }

  /** Sends, awaits a valid reply from every id, and retries the ids still missing. */
  private async request(
    ids: number[],
    build: (remaining: number[]) => Uint8Array,
    paramLength: number,
    what: string,
  ): Promise<Map<number, StatusFrame>> {
    const got = new Map<number, StatusFrame>();
    let remaining = ids;
    let problems = new Map<number, Problem>();
    const attempts = 1 + this.retries;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) this.counters.retries += 1;
      const outcome = await this.exchange(build(remaining), new Set(remaining), paramLength);
      for (const [id, frame] of outcome.frames) got.set(id, frame);
      problems = outcome.problems;
      if (problems.size === 0) return got;
      remaining = ids.filter((id) => problems.has(id));
    }
    this.counters.failures += 1;
    const kinds = new Set(problems.values());
    const kind: Problem = (["echo_mismatch", "malformed", "checksum"] as const).find((k) => kinds.has(k)) ?? "timeout";
    const hint =
      kind === "echo_mismatch" && !this.echo ? "; only our own request came back: the adapter echoes, so set echo: true (run detectEcho at startup)" : "";
    throw new FeetechError(kind, `${what}: no valid reply from id ${remaining.join(", ")} after ${attempts} attempt(s) (${kind})${hint}`, {
      ids: remaining,
      attempts,
      partial: got,
    });
  }

  /** Sends a packet nobody answers. In echo mode, waits for (and checks) the echo, retrying on a mismatch. */
  private async sendOnly(packet: Uint8Array, what: string): Promise<void> {
    const attempts = this.echo ? 1 + this.retries : 1;
    let problem: Problem = "timeout";
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1) this.counters.retries += 1;
      const outcome = await this.exchange(packet, null, 0);
      if (outcome.problems.size === 0) return;
      problem = outcome.problems.values().next().value ?? "timeout";
    }
    this.counters.failures += 1;
    const why = problem === "echo_mismatch" ? "the adapter's echo didn't match" : "the adapter's echo never came back";
    throw new FeetechError(problem, `${what}: ${why} after ${attempts} attempt(s)`, { attempts });
  }

  private async settleIfNeeded(): Promise<void> {
    if (!this.needSettle) return;
    this.needSettle = false;
    if (this.settleMs > 0) await new Promise<void>((resolve) => this.clock.setTimeout(resolve, this.settleMs));
  }

  private wireMs(bytes: number): number {
    return (bytes * 10 * 1000) / this.baud;
  }

  /** One attempt: write, then gather replies until every expected id is in or the deadline passes. */
  private async exchange(
    packet: Uint8Array,
    expect: Set<number> | null,
    paramLength: number,
  ): Promise<{ frames: Map<number, StatusFrame>; problems: Map<number, Problem> }> {
    await this.settleIfNeeded();
    this.assertOpen();
    this.parser.reset();
    this.counters.exchanges += 1;
    let cancelTimer: Cancel = () => {};
    let resolveDone!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    const pending: Pending = {
      packet,
      echoIndex: this.echo ? 0 : packet.length,
      expect,
      paramLength,
      frames: new Map(),
      malformed: new Set(),
      sawChecksumError: false,
      echoFailed: false,
      suspects: new Map(),
      capture: null,
      done: () => resolveDone(),
    };
    this.pending = pending;
    try {
      // The deadline is armed before the write, so a write that never completes (a wedged adapter) times out too.
      const replyBytes = expect ? expect.size * (6 + paramLength) : 0;
      const echoBytes = this.echo ? packet.length : 0;
      const deadline = this.timeoutMs + this.wireMs(packet.length + echoBytes + replyBytes);
      let timedOut = false;
      const deadlinePassed = new Promise<void>((resolve) => {
        cancelTimer = this.clock.setTimeout(() => {
          timedOut = true;
          resolve();
          resolveDone();
        }, deadline);
      });
      let written = false;
      let writeError: unknown = null;
      const writing = this.port.write(packet).then(
        () => {
          written = true;
        },
        (error: unknown) => {
          writeError = error ?? new Error("write failed");
        },
      );
      await Promise.race([writing, deadlinePassed]);
      if (writeError) {
        throw new FeetechError(this.closedReason ? "closed" : "write_failed", `write failed: ${(writeError as Error).message}`);
      }
      this.assertOpen();
      const problems = new Map<number, Problem>();
      if (!written) {
        for (const id of expect ?? [BROADCAST_ID]) problems.set(id, "timeout");
        this.counters.timeouts += 1;
        this.needSettle = true;
        this.log.warn("servo bus write didn't complete before the deadline", { ms: deadline });
        return { frames: pending.frames, problems };
      }
      if (!this.isComplete(pending)) await finished;
      this.assertOpen();
      if (pending.echoFailed) {
        for (const id of expect ?? [BROADCAST_ID]) problems.set(id, "echo_mismatch");
      } else if (expect) {
        for (const id of expect) {
          if (pending.frames.has(id)) continue;
          // Only a copy of our own request came back for this id: an echoing adapter and a silent servo. A genuine
          // reply identical to the request (a PING answered with error bit 0x01) fails here too; the retry or
          // detectEcho settles which.
          const problem: Problem = pending.malformed.has(id)
            ? "malformed"
            : pending.suspects.has(id)
              ? "echo_mismatch"
              : pending.sawChecksumError
                ? "checksum"
                : "timeout";
          problems.set(id, problem);
        }
      } else if (pending.echoIndex < packet.length) {
        problems.set(BROADCAST_ID, "timeout");
      }
      if (timedOut && problems.size > 0) this.counters.timeouts += 1;
      if (problems.size > 0) this.needSettle = true;
      return { frames: pending.frames, problems };
    } finally {
      cancelTimer();
      this.pending = null;
    }
  }

  /** Writes a packet and returns every byte heard within the reply timeout (detectEcho only). */
  private async capture(packet: Uint8Array): Promise<number[]> {
    await this.settleIfNeeded();
    this.assertOpen();
    this.counters.exchanges += 1;
    const captured: number[] = [];
    let resolveDone!: () => void;
    const finished = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });
    this.pending = {
      packet,
      echoIndex: packet.length,
      expect: null,
      paramLength: 0,
      frames: new Map(),
      malformed: new Set(),
      sawChecksumError: false,
      echoFailed: false,
      suspects: new Map(),
      capture: captured,
      done: () => resolveDone(),
    };
    const cancel = this.clock.setTimeout(() => resolveDone(), this.timeoutMs + this.wireMs(packet.length * 2 + 8));
    try {
      // Not awaited on its own: the timer above already runs, so a write that never completes still ends this.
      let writeError: unknown = null;
      this.port.write(packet).catch((error: unknown) => {
        writeError = error ?? new Error("write failed");
        resolveDone();
      });
      await finished;
      if (writeError) throw new FeetechError(this.closedReason ? "closed" : "write_failed", `write failed: ${(writeError as Error).message}`);
      this.assertOpen();
      return captured;
    } finally {
      cancel();
      this.pending = null;
      this.needSettle = true;
    }
  }

  private onData(chunk: Uint8Array): void {
    const p = this.pending;
    if (!p) {
      this.counters.strayBytes += chunk.length;
      return;
    }
    if (p.capture) {
      p.capture.push(...chunk);
      return;
    }
    let offset = 0;
    while (p.echoIndex < p.packet.length && offset < chunk.length) {
      if (chunk[offset] !== p.packet[p.echoIndex]) {
        this.counters.echoMismatches += 1;
        p.echoFailed = true;
        p.echoIndex = p.packet.length;
        p.done();
        return;
      }
      p.echoIndex += 1;
      offset += 1;
    }
    if (p.echoFailed) return;
    if (offset < chunk.length) this.parser.push(chunk.subarray(offset));
    if (this.isComplete(p)) p.done();
  }

  private onFrame(p: Pending, frame: StatusFrame): void {
    if (!p.expect || !p.expect.has(frame.id) || p.frames.has(frame.id)) {
      this.counters.wrongIdReplies += 1;
      return;
    }
    // Without echo mode, an adapter that does echo hands back our request first, and it parses as a status
    // packet from the same id (the instruction byte read as the error byte). Set it aside and wait for the
    // real reply; if nothing else comes, exchange() fails the id as echo_mismatch rather than take our own bytes.
    if (!this.echo && !p.suspects.has(frame.id) && sameBytes(frame.raw, p.packet)) {
      this.counters.echoSuspected += 1;
      p.suspects.set(frame.id, frame);
      return;
    }
    if (frame.params.length !== p.paramLength) {
      this.counters.malformedReplies += 1;
      p.malformed.add(frame.id);
      return;
    }
    this.accept(p, frame);
  }

  private accept(p: Pending, frame: StatusFrame): void {
    p.malformed.delete(frame.id);
    p.frames.set(frame.id, frame);
    this.lastErrors.set(frame.id, frame.error);
    if (frame.error !== 0) this.counters.servoErrorReplies += 1;
  }

  private isComplete(p: Pending): boolean {
    if (p.echoIndex < p.packet.length) return false;
    if (!p.expect) return true;
    for (const id of p.expect) if (!p.frames.has(id) && !p.malformed.has(id)) return false;
    return true;
  }

  private assertOpen(): void {
    if (this.closedReason) throw new FeetechError("closed", `bus closed: ${this.closedReason}`);
  }

  private assertRamWritable(name: FieldName): void {
    if (!isRamWritable(name)) {
      throw new FeetechError("refused", `${name} is not a writable RAM register; EEPROM goes through unlockAndWriteEeprom`);
    }
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    this.queued += 1;
    const run = this.tail.then(async () => {
      try {
        this.assertOpen();
        return await work();
      } finally {
        this.queued -= 1;
      }
    });
    this.tail = run.catch(() => {});
    return run;
  }
}
