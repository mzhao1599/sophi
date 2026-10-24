import type { Clock } from "../clock";
import type { Logger } from "../log";
import { FeetechBus, FeetechError, type Feedback, type ReadResult } from "./feetech/bus";
import { STS3215_MODEL_NUMBER } from "./feetech/controlTable";
import type { FeetechPort } from "./feetech/port";

/**
 * One arm's servo bus as the coordinator uses it: the startup check, then reads and the few writes motion
 * needs. Policy (who may move, limits, faults) stays in the coordinator; this only keeps the driver's rules:
 * unicast writes, nonzero speed and acceleration with every goal, no EEPROM on the motion path.
 */
const STATE_FIELDS = [
  "torqueEnable",
  "acceleration",
  "goalPosition",
  "goalSpeed",
  "torqueLimit",
  "presentPosition",
  "presentSpeed",
  "presentLoad",
  "presentVoltage",
  "presentTemperature",
  "status",
  "moving",
  "presentCurrent",
] as const;

/** One servo as read: its control registers and its feedback. */
export type ServoState = Feedback & Record<"torqueEnable" | "acceleration" | "goalPosition" | "goalSpeed" | "torqueLimit", number>;

export interface ServoCheck {
  id: number;
  ok: boolean;
  model: number | null;
  firmware: string | null;
  problem: string | null;
}

export interface ArmCheckReport {
  ok: boolean;
  /** What detectEcho saw on the first servo id. */
  echo: boolean | null;
  servos: ServoCheck[];
  problem: string | null;
}

export class ArmLink {
  private closeHandlers: Array<(reason: string) => void> = [];
  private closed = false;

  constructor(
    readonly bus: FeetechBus,
    port: FeetechPort,
    readonly ids: readonly number[],
    readonly echo: boolean,
  ) {
    port.onClose((reason) => {
      if (this.closed) return;
      this.closed = true;
      for (const fn of this.closeHandlers) fn(reason);
    });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  onClose(fn: (reason: string) => void): void {
    this.closeHandlers.push(fn);
  }

  /**
   * One SYNC READ, per servo, of what motion acts on: the control registers (torque enable, acceleration, goal
   * position, goal speed, torque limit; addresses 40 to 49) and the feedback block (56 to 70). The coordinator
   * reads before it acts and acts only on what it read. Throws FeetechError (with `partial`) if any is missing.
   */
  readFeedback(): Promise<Map<number, ReadResult<ServoState>>> {
    return this.bus.syncRead(this.ids, STATE_FIELDS);
  }

  /** Each servo's Torque Enable register (0 or 1), read one by one. */
  async readTorque(): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    for (const id of this.ids) out.set(id, (await this.bus.read(id, "torqueEnable")).value);
    return out;
  }

  /** Goal position with speed and acceleration, in one SYNC WRITE (Feetech's SyncWritePosEx layout). */
  writeGoals(goals: ReadonlyArray<{ id: number; position: number; speed: number; acceleration: number }>): Promise<void> {
    return this.bus.syncWriteGoals(goals);
  }

  /** Torque Limit (RAM, 0.1 % units) on each servo, acknowledged one by one. */
  async writeTorqueLimits(limits: ReadonlyArray<{ id: number; value: number }>): Promise<void> {
    for (const { id, value } of limits) await this.bus.write(id, "torqueLimit", value);
  }

  setTorque(ids: readonly number[], enabled: boolean): Promise<unknown> {
    return this.bus.setTorque(ids, enabled);
  }

  close(): void {
    this.bus.close();
  }
}

/**
 * Opens an arm's adapter and checks it before anything is written (AGENTS.md rule 8; driver review):
 * 1. `detectEcho` on the first servo id with a probe bus, and if the adapter echoes, the port is opened again
 *    with a bus built for echo.
 * 2. A PING and a model-number read for every servo id; each must be an STS3215 (model 777).
 * Any problem closes the port and returns no link, so nothing is ever written to an arm that failed its check.
 * `openPort` opens a fresh connection each call (a real tty, or a simulated one).
 */
export async function openArmLink(options: {
  label: string;
  openPort: () => FeetechPort;
  clock: Clock;
  log: Logger;
  ids: readonly number[];
}): Promise<{ link: ArmLink | null; report: ArmCheckReport }> {
  const { label, clock, log, ids } = options;
  const report: ArmCheckReport = { ok: false, echo: null, servos: [], problem: null };
  let port: FeetechPort;
  try {
    port = options.openPort();
  } catch (error) {
    report.problem = `couldn't open the port: ${(error as Error).message}`;
    return { link: null, report };
  }
  let bus = new FeetechBus({ port, clock, log, echo: false });
  try {
    const probe = await bus.detectEcho(ids[0]!);
    report.echo = probe.echo;
    if (probe.echo) {
      log.info("arm adapter echoes its own bytes; reopening the bus in echo mode", { arm: label });
      bus.close();
      port = options.openPort();
      bus = new FeetechBus({ port, clock, log, echo: true });
    }
  } catch (error) {
    report.problem = `echo check failed: ${(error as Error).message}`;
    bus.close();
    return { link: null, report };
  }
  for (const id of ids) {
    const check: ServoCheck = { id, ok: false, model: null, firmware: null, problem: null };
    report.servos.push(check);
    try {
      await bus.ping(id);
      check.model = (await bus.read(id, "modelNumber")).value;
      const major = (await bus.read(id, "firmwareMajor")).value;
      const minor = (await bus.read(id, "firmwareMinor")).value;
      check.firmware = `${major}.${minor}`;
      if (check.model !== STS3215_MODEL_NUMBER) check.problem = `model ${check.model}, expected ${STS3215_MODEL_NUMBER} (STS3215)`;
      else check.ok = true;
    } catch (error) {
      check.problem = error instanceof FeetechError ? `${error.kind}: ${error.message}` : (error as Error).message;
    }
  }
  const failed = report.servos.filter((s) => !s.ok);
  if (failed.length > 0) {
    report.problem = `servo ${failed.map((s) => s.id).join(", ")} failed the check`;
    bus.close();
    return { link: null, report };
  }
  report.ok = true;
  return { link: new ArmLink(bus, port, ids, report.echo === true), report };
}
