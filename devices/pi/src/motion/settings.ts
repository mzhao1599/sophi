import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, normalize } from "node:path";
import { MOTION_BENCH_ENV, MOTION_BENCH_ENV_VALUE, ServoBusIdSchema, type ArmRole, type ArmSide } from "@walker/contracts";

/**
 * Motion settings for the real walker, read once at start from the service's environment file
 * (/etc/steady-walker.env). Nothing over the network, the screen or a command can change them.
 *
 * - WALKER_ARM_LEFT_PORT, WALKER_ARM_RIGHT_PORT: the follower arms' Feetech adapters.
 * - WALKER_LEADER_LEFT_PORT, WALKER_LEADER_RIGHT_PORT: the leader (teaching) arms' adapters.
 *   Each is a stable link: /dev/serial/by-id/<name> (named after the adapter's serial number), or
 *   /dev/serial/by-path/<name> (named after the USB socket, for adapters that share a serial number, as the
 *   two hand boards' CP2102s do). Never /dev/ttyACM0, whose number changes with plug order. Unset: not fitted.
 * - WALKER_STOP_SENSE: `gpio:<line>` when the hardware stop's normally closed stop-sense contact is wired to
 *   that Pi GPIO line (BCM number), or `not_wired` (the default). The installer declares it; the Pi never
 *   infers it from a reading. (The contract's motion setup calls this `stop_sense`.)
 * - WALKER_MOTION_BENCH=no-hardware-stop: bench mode (the contract's MOTION_BENCH_ENV), with the bench limits.
 *
 * A setting that can't be read turns motion off (with the reason logged) rather than stopping the walker
 * service, so a typo never costs the voice and the obstacle cues, and never moves an arm.
 */
export interface ArmPortSetting {
  side: ArmSide;
  role: ArmRole;
  /** The stable link, as configured. */
  path: string;
  /** Its basename: the calibration file's `bus_id`. */
  busId: string;
}

export type StopSenseSetting = { kind: "not_wired" } | { kind: "gpio"; line: number };

export interface MotionSettings {
  arms: ArmPortSetting[];
  stopSense: StopSenseSetting;
  bench: boolean;
}

export type MotionSettingsResult = { kind: "off" } | { kind: "error"; reason: string } | { kind: "on"; settings: MotionSettings };

const PORT_ENV: ReadonlyArray<{ name: string; side: ArmSide; role: ArmRole }> = [
  { name: "WALKER_ARM_LEFT_PORT", side: "left", role: "follower" },
  { name: "WALKER_ARM_RIGHT_PORT", side: "right", role: "follower" },
  { name: "WALKER_LEADER_LEFT_PORT", side: "left", role: "leader" },
  { name: "WALKER_LEADER_RIGHT_PORT", side: "right", role: "leader" },
];

const STABLE_DIRS = ["/dev/serial/by-id", "/dev/serial/by-path"];

/** Bench mode is on only for exactly MOTION_BENCH_ENV_VALUE; unset or empty is off; anything else is an error. */
export function readBench(env: NodeJS.ProcessEnv): { ok: true; bench: boolean } | { ok: false; reason: string } {
  const value = env[MOTION_BENCH_ENV];
  if (value === undefined || value === "") return { ok: true, bench: false };
  if (value === MOTION_BENCH_ENV_VALUE) return { ok: true, bench: true };
  return { ok: false, reason: `${MOTION_BENCH_ENV} must be ${MOTION_BENCH_ENV_VALUE} or unset` };
}

export function readStopSense(value: string | undefined): StopSenseSetting | null {
  if (value === undefined || value === "" || value === "not_wired") return { kind: "not_wired" };
  const match = /^gpio:(\d{1,2})$/.exec(value);
  if (!match) return null;
  const line = Number(match[1]);
  return line <= 63 ? { kind: "gpio", line } : null;
}

export function readMotionSettings(env: NodeJS.ProcessEnv): MotionSettingsResult {
  // WALKER_SERIAL_DIR (tests, a laptop) is accepted too, as a folder of stable links.
  const dirs = [...STABLE_DIRS, ...(env.WALKER_SERIAL_DIR ? [normalize(env.WALKER_SERIAL_DIR)] : [])];
  const arms: ArmPortSetting[] = [];
  for (const { name, side, role } of PORT_ENV) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    const path = normalize(value);
    if (!isAbsolute(path) || !dirs.includes(dirname(path))) {
      return { kind: "error", reason: `${name} must be a link in /dev/serial/by-id/ or /dev/serial/by-path/, not /dev/ttyACM0` };
    }
    const busId = basename(path);
    if (!ServoBusIdSchema.safeParse(busId).success) return { kind: "error", reason: `${name}'s name has characters a calibration file can't record` };
    arms.push({ side, role, path, busId });
  }
  const bench = readBench(env);
  if (!bench.ok) return { kind: "error", reason: bench.reason };
  const stopSense = readStopSense(env.WALKER_STOP_SENSE);
  if (!stopSense) return { kind: "error", reason: "WALKER_STOP_SENSE must be gpio:<line> or not_wired" };
  if (arms.length === 0) return { kind: "off" };
  if (new Set(arms.map((a) => a.path)).size !== arms.length) return { kind: "error", reason: "two arms name the same port" };
  return { kind: "on", settings: { arms, stopSense, bench: bench.bench } };
}

/** The configured arm ports, as written. */
export function armPortPaths(env: NodeJS.ProcessEnv): string[] {
  return PORT_ENV.map(({ name }) => env[name]).filter((value): value is string => !!value).map((value) => normalize(value));
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return normalize(path);
  }
};

/**
 * Whether `path` is one of the configured arm adapters, compared by the device each link points to (a by-path
 * and a by-id link name the same tty differently). The ESP32 serial scanner and `walker check` skip these, so
 * no ESP32 hello at 115200 baud ever goes onto a servo bus.
 */
export function isArmPort(path: string, env: NodeJS.ProcessEnv): boolean {
  const target = real(path);
  return armPortPaths(env).some((arm) => normalize(arm) === normalize(path) || real(arm) === target);
}
