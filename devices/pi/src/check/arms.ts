import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import { ARM_JOINTS, ARM_TEMPERATURE_LIMIT_C, ARM_UNDERVOLTAGE_V, DEFAULT_SERVO_IDS, type ArmJoint, type ArmRole } from "@walker/contracts";
import type { Clock } from "../clock";
import { FeetechBus, FeetechError, type ReadResult } from "../motion/feetech/bus";
import { STS3215_MODEL_NUMBER } from "../motion/feetech/controlTable";
import { FEETECH_DEFAULT_BAUD, openFeetechPort, type FeetechPort } from "../motion/feetech/port";
import { BROADCAST_ID, Instruction, checksum, servoErrorNames } from "../motion/feetech/protocol";
import { FakeStsBus } from "../sim/fakeFeetech";
import { NOT_A_PI, fail, isLinux, pass, skip, warn, type Check, type CheckContext, type CheckLine } from "./core";
import { SERVICE_UNIT } from "./system";

/**
 * The arms: each SO-101 arm's Feetech adapter, opened at 1,000,000 baud with the driver's own port and bus,
 * and asked only PING and READ. Nothing here enables torque, writes a goal or touches EEPROM, and a guard on
 * the port refuses any other packet before it reaches the wire (`readOnlyPort`).
 *
 * The port settings use the motion coordinator's names (claude/motion-arms, not merged yet; same rules as its
 * settings.ts): each a stable link in /dev/serial/by-id or /dev/serial/by-path, never /dev/ttyACM0.
 */
export const ARM_PORT_ENV: ReadonlyArray<{ name: string; label: string; role: ArmRole }> = [
  { name: "WALKER_ARM_LEFT_PORT", label: "left", role: "follower" },
  { name: "WALKER_ARM_RIGHT_PORT", label: "right", role: "follower" },
  { name: "WALKER_LEADER_LEFT_PORT", label: "leader-left", role: "leader" },
  { name: "WALKER_LEADER_RIGHT_PORT", label: "leader-right", role: "leader" },
];
export const SERIAL_BY_ID_DIR = "/dev/serial/by-id";
const STABLE_DIRS = [SERIAL_BY_ID_DIR, "/dev/serial/by-path"];

/**
 * How a servo adapter's by-id link is named when no port is configured: the CH343P bridge on the Waveshare Bus
 * Servo Adapter (A) reports "USB Single Serial" from vendor 1a86. Assumed from the board's schematic and the
 * driver README's example; which adapter our kits have is still to be read off the boxes, and a CH9102 on an
 * ESP32 board reports the same name (the probe only PINGs it; the serial check still opens it if no servo answers).
 */
export const SERVO_ADAPTER_LINK = /^usb-1a86_USB_Single_Serial_/;

/** SO-101 servo ids (LeRobot's numbering; a calibration file names the real ones). */
export const ARM_SERVO_IDS = ARM_JOINTS.map((joint) => DEFAULT_SERVO_IDS[joint]);
const JOINT_OF = new Map<number, ArmJoint>(ARM_JOINTS.map((joint) => [DEFAULT_SERVO_IDS[joint], joint]));

/** Placeholder, not measured: one retry per call (the bench will set the real latency). */
const CHECK_RETRIES = 1;

export interface ArmAdapter {
  /** `left`, `right`, `leader-left`, `leader-right`, or `adapter N` when found by name. */
  label: string;
  path: string;
  /** The setting that named it, or null when found by name. */
  env: string | null;
  role: ArmRole | null;
}

/** Where the arms check gets its adapters: real ttys, or simulated servos. */
export interface ArmSource {
  simulated: boolean;
  find(ctx: CheckContext): { adapters: ArmAdapter[]; lines: CheckLine[] };
  open(adapter: ArmAdapter): FeetechPort;
}

/** The configured arm ports, else the links under /dev/serial/by-id that look like servo adapters. */
export function findArmAdapters(ctx: CheckContext): { adapters: ArmAdapter[]; lines: CheckLine[] } {
  const lines: CheckLine[] = [];
  const adapters: ArmAdapter[] = [];
  const dirs = [...STABLE_DIRS, ...(ctx.env.WALKER_SERIAL_DIR ? [normalize(ctx.env.WALKER_SERIAL_DIR)] : [])];
  const configured = ARM_PORT_ENV.filter(({ name }) => ctx.env[name]);
  for (const { name, label, role } of configured) {
    const value = ctx.env[name]!;
    const path = normalize(value);
    if (!isAbsolute(path) || !dirs.includes(dirname(path))) {
      lines.push(fail("arms", label, `${name}=${value}: must be a link in /dev/serial/by-id/ or /dev/serial/by-path/ (a /dev/ttyACM number changes with plug order)`));
      continue;
    }
    if (!(ctx.files.list(dirname(path)) ?? []).includes(basename(path))) {
      lines.push(fail("arms", label, `${name}=${path} is not there: is the adapter plugged in, with a data cable? (ls -l ${dirname(path)})`));
      continue;
    }
    adapters.push({ label, path, env: name, role });
  }
  const real = (path: string) => ctx.files.realpath?.(path) ?? path;
  const looksLikeAdapter = (ctx.files.list(SERIAL_BY_ID_DIR) ?? []).filter((name) => SERVO_ADAPTER_LINK.test(name)).map((name) => join(SERIAL_BY_ID_DIR, name));
  if (configured.length > 0) {
    const taken = new Set(adapters.map((a) => real(a.path)));
    for (const path of looksLikeAdapter.filter((p) => !taken.has(real(p)))) {
      lines.push(skip("arms", "other adapter", `${basename(path)} looks like a servo adapter, but no ${ARM_PORT_ENV.map((e) => e.name).join(", ")} names it; not opened`));
    }
    return { adapters, lines };
  }
  if (looksLikeAdapter.length === 0) {
    lines.push(
      skip(
        "arms",
        "adapters",
        `no arm port set (${ARM_PORT_ENV.map((e) => e.name).join(", ")}) and no link under ${SERIAL_BY_ID_DIR} looks like a servo adapter (usb-1a86_USB_Single_Serial_*): plugged in, with data cables? (lsusb)`,
      ),
    );
    return { adapters, lines };
  }
  looksLikeAdapter.forEach((path, i) => adapters.push({ label: `adapter ${i + 1}`, path, env: null, role: null }));
  lines.push(
    warn(
      "arms",
      "ports",
      `not configured; found ${looksLikeAdapter.length} likely servo adapter${looksLikeAdapter.length === 1 ? "" : "s"} by name. Once you know which arm each is, set WALKER_ARM_LEFT_PORT and WALKER_ARM_RIGHT_PORT (and WALKER_LEADER_*_PORT) in /etc/steady-walker.env`,
    ),
  );
  return { adapters, lines };
}

export const realArms: ArmSource = {
  simulated: false,
  find: findArmAdapters,
  open: (adapter) => openFeetechPort(adapter.path, FEETECH_DEFAULT_BAUD),
};

/** `--sim`: two simulated follower arms of six STS3215s each (FakeStsBus), at plausible fake readings. */
export function simulatedArms(clock: Clock): ArmSource & { buses: Map<string, FakeStsBus> } {
  const buses = new Map<string, FakeStsBus>();
  for (const side of ["left", "right"]) buses.set(`sim:${side}`, new FakeStsBus(clock, { ids: ARM_SERVO_IDS }));
  return {
    simulated: true,
    buses,
    find: () => ({
      adapters: [
        { label: "left", path: "sim:left", env: null, role: "follower" },
        { label: "right", path: "sim:right", env: null, role: "follower" },
      ],
      lines: [],
    }),
    open: (adapter) => buses.get(adapter.path)!,
  };
}

/**
 * Whether one packet is a PING or a READ to one servo: the only instructions walker check sends. Header, a
 * single id (never broadcast), the length byte, the instruction, READ's two parameters, and the checksum.
 */
export function isReadOnlyPacket(bytes: Uint8Array): boolean {
  if (bytes.length < 6 || bytes[0] !== 0xff || bytes[1] !== 0xff) return false;
  const id = bytes[2]!;
  const length = bytes[3]!;
  const instruction = bytes[4]!;
  if (id === BROADCAST_ID || id > 0xfd || length !== bytes.length - 4) return false;
  if (checksum(bytes, 2, bytes.length - 1) !== bytes[bytes.length - 1]) return false;
  if (instruction === Instruction.PING) return length === 2;
  if (instruction === Instruction.READ) return length === 4;
  return false;
}

/**
 * The port the check's buses use: writes pass only if `isReadOnlyPacket`, anything else is refused (and
 * counted) without reaching the adapter. Closing it leaves the real port open, so a second bus (after echo
 * detection) can share it; the check closes the real port itself.
 */
export function readOnlyPort(port: FeetechPort): FeetechPort & { refused: Uint8Array[] } {
  const refused: Uint8Array[] = [];
  return {
    refused,
    write(bytes) {
      if (!isReadOnlyPacket(bytes)) {
        refused.push(Uint8Array.from(bytes));
        return Promise.reject(new Error("walker check sends only PING and READ"));
      }
      return port.write(bytes);
    },
    onData: (fn) => port.onData(fn),
    onClose: (fn) => port.onClose(fn),
    close: () => {},
  };
}

interface Servo {
  id: number;
  joint: ArmJoint;
  /** Why it didn't answer a PING, or null when it did. */
  missing: string | null;
  model?: number;
  firmware?: string;
  position?: number;
  volts?: number;
  celsius?: number;
  torqueOn?: boolean;
  maxVolts?: number;
  minVolts?: number;
  /** Fault bits from every reply's error byte and the status register. */
  errorBits: number;
  readProblem?: string;
  /** Its PING reply was identical to the request (the voltage fault bit does that); found by READ instead. */
  pingLooksLikeEcho?: boolean;
}

const why = (error: unknown) => (error instanceof FeetechError ? error.kind : error instanceof Error ? error.message : String(error));

async function readServo(bus: FeetechBus, id: number): Promise<Servo> {
  const servo: Servo = { id, joint: JOINT_OF.get(id)!, missing: null, errorBits: 0 };
  const note = <T>(result: ReadResult<T>): T => {
    servo.errorBits |= result.error;
    return result.value;
  };
  try {
    servo.errorBits |= (await bus.ping(id)).error;
  } catch (error) {
    // A PING answered with only the voltage fault bit (0x01) is byte-identical to the PING itself, so without
    // echo mode the bus can't tell it from an echo (driver README). A READ of the model number can't look
    // like its request, so it decides.
    if (!(error instanceof FeetechError && error.kind === "echo_mismatch")) {
      servo.missing = why(error);
      return servo;
    }
    try {
      note(await bus.read(id, "modelNumber"));
      servo.pingLooksLikeEcho = true;
    } catch {
      servo.missing = why(error);
      return servo;
    }
  }
  try {
    const info = note(await bus.readFields(id, ["firmwareMajor", "firmwareMinor", "modelNumber"]));
    servo.model = info.modelNumber;
    servo.firmware = `${info.firmwareMajor}.${info.firmwareMinor}`;
    const limits = note(await bus.readFields(id, ["maxVoltageLimit", "minVoltageLimit"]));
    servo.maxVolts = limits.maxVoltageLimit / 10;
    servo.minVolts = limits.minVoltageLimit / 10;
    servo.torqueOn = note(await bus.read(id, "torqueEnable")) !== 0;
    const now = note(await bus.readFields(id, ["presentPosition", "presentVoltage", "presentTemperature", "status"]));
    servo.position = now.presentPosition;
    servo.volts = now.presentVoltage / 10;
    servo.celsius = now.presentTemperature;
    servo.errorBits |= now.status;
  } catch (error) {
    servo.readProblem = why(error);
  }
  return servo;
}

/** One joint's line, and the warnings it carries (also listed on the arm's line). */
function jointLine(adapter: ArmAdapter, servo: Servo, sim: string): { line: CheckLine; warnings: string[] } {
  const item = `${adapter.label} ${servo.joint}`;
  if (servo.missing) {
    return { line: warn("arms", item, `id ${servo.id} didn't answer a PING (${servo.missing})${sim}`), warnings: [`id ${servo.id} missing`] };
  }
  const warnings: string[] = [];
  if (servo.model !== undefined && servo.model !== STS3215_MODEL_NUMBER) warnings.push(`model ${servo.model}, not an STS3215 (${STS3215_MODEL_NUMBER})`);
  if (servo.torqueOn) warnings.push("torque is already ON (the check never turns it on; something else did)");
  if (servo.volts !== undefined) {
    if (adapter.role === "follower" && servo.volts < ARM_UNDERVOLTAGE_V) warnings.push(`${servo.volts.toFixed(1)} V is below ${ARM_UNDERVOLTAGE_V} V (the follower undervoltage limit)`);
    if (servo.maxVolts !== undefined && servo.volts > servo.maxVolts) warnings.push(`${servo.volts.toFixed(1)} V is above this servo's own ${servo.maxVolts.toFixed(1)} V limit (a 7.4 V servo on 12 V?)`);
  }
  if (servo.celsius !== undefined && servo.celsius > ARM_TEMPERATURE_LIMIT_C) warnings.push(`${servo.celsius} °C is above ${ARM_TEMPERATURE_LIMIT_C} °C`);
  const faults = servoErrorNames(servo.errorBits);
  if (faults.length) warnings.push(`servo reports ${faults.join(" ")}`);
  if (servo.readProblem) warnings.push(`answered PING, then a READ failed (${servo.readProblem})`);
  if (servo.pingLooksLikeEcho) warnings.push("its PING reply matched the PING byte for byte (the voltage fault bit does that), so it was found by READ");
  const facts = [
    `id ${servo.id}`,
    servo.model !== undefined ? `model ${servo.model}` : null,
    servo.firmware ? `firmware ${servo.firmware}` : null,
    servo.position !== undefined ? `position ${servo.position}` : null,
    servo.volts !== undefined ? `${servo.volts.toFixed(1)} V` : null,
    servo.celsius !== undefined ? `${servo.celsius} °C` : null,
    servo.torqueOn !== undefined ? `torque ${servo.torqueOn ? "ON" : "off"}` : null,
  ].filter(Boolean);
  const detail = `${facts.join(", ")}${warnings.length ? `: ${warnings.join("; ")}` : ""}${sim}`;
  return { line: warnings.length ? warn("arms", item, detail) : pass("arms", item, detail), warnings };
}

/** Echo detection, then PING and READ of ids 1 to 6 on one adapter. Only PING and READ packets go out. */
export async function armLines(ctx: CheckContext, source: ArmSource, adapter: ArmAdapter): Promise<{ lines: CheckLine[]; answered: boolean }> {
  const sim = source.simulated ? " (simulated)" : "";
  const where = `${basename(adapter.path)}${adapter.env ? ` (${adapter.env})` : ""}`;
  let port: FeetechPort;
  try {
    port = source.open(adapter);
  } catch (error) {
    return { lines: [fail("arms", adapter.label, `couldn't open ${adapter.path} at ${FEETECH_DEFAULT_BAUD} baud: ${(error as Error).message} (run with sudo?)`)], answered: false };
  }
  const guarded = readOnlyPort(port);
  try {
    // The driver's own echo test: a READ of the model number, whose genuine reply can never equal the request.
    const probe = new FeetechBus({ port: guarded, clock: ctx.clock, retries: 0 });
    let echo = false;
    let replied: number | null = null;
    for (const id of ARM_SERVO_IDS) {
      const result = await probe.detectEcho(id);
      echo ||= result.echo;
      if (result.replied) {
        replied = id;
        break;
      }
    }
    probe.close();
    const echoNote = echo ? "the adapter ECHOES our bytes: the motion coordinator must build this bus with echo: true" : "no echo";
    if (replied === null) {
      return {
        lines: [fail("arms", adapter.label, `no servo answered ids ${ARM_SERVO_IDS.join(", ")} on ${where} (${echoNote}): is the arm's 12 V supply on and its servo cable seated?${sim}`)],
        answered: false,
      };
    }
    const bus = new FeetechBus({ port: guarded, clock: ctx.clock, echo, retries: CHECK_RETRIES });
    const servos: Servo[] = [];
    for (const id of ARM_SERVO_IDS) servos.push(await readServo(bus, id));
    bus.close();
    const joints = servos.map((servo) => jointLine(adapter, servo, sim));
    const present = servos.filter((s) => !s.missing);
    const stats = bus.stats;
    const warnings = [...(echo ? [echoNote] : []), ...joints.flatMap((j) => j.warnings.map((w) => `${j.line.item.split(" ").at(-1)}: ${w}`))];
    const volts = present.map((s) => s.volts).filter((v): v is number => v !== undefined);
    const supply = volts.length ? `, ${Math.min(...volts).toFixed(1)} to ${Math.max(...volts).toFixed(1)} V` : "";
    const summary =
      `${present.length} of ${ARM_SERVO_IDS.length} servos on ${where}, ${adapter.role ?? "role unknown"}, ${FEETECH_DEFAULT_BAUD} baud, ${echo ? "echo" : "no echo"}${supply}, ` +
      `${stats.retries} retries${warnings.length ? `: ${warnings.join("; ")}` : ""}${sim}`;
    const head = present.length === 0 ? fail("arms", adapter.label, summary) : warnings.length ? warn("arms", adapter.label, summary) : pass("arms", adapter.label, summary);
    return { lines: [head, ...joints.map((j) => j.line)], answered: present.length > 0 };
  } finally {
    port.close();
  }
}

export async function armsLines(ctx: CheckContext, source: ArmSource): Promise<CheckLine[]> {
  if (!source.simulated && ctx.facts.serviceActive) {
    return [skip("arms", "arms", `${SERVICE_UNIT} is running and may hold the arm adapters (its serial scan opens every port). For a live check: sudo systemctl stop ${SERVICE_UNIT}, run this again, then start it`)];
  }
  if (!source.simulated && !isLinux(ctx)) return [skip("arms", "arms", `${NOT_A_PI(ctx)}; pass --sim for simulated arms`)];
  const { adapters, lines } = source.find(ctx);
  const real = (path: string) => ctx.files.realpath?.(path) ?? path;
  // Configured ports are servo buses whatever answers; a link found by name only once a servo answers on it.
  const servoPorts = new Set(adapters.filter((a) => a.env).map((a) => real(a.path)));
  for (const adapter of adapters) {
    const result = await armLines(ctx, source, adapter);
    lines.push(...result.lines);
    if (result.answered) servoPorts.add(real(adapter.path));
  }
  ctx.facts.servoPorts = [...servoPorts];
  return lines;
}

/** Up to four adapters, each about 4 s when every servo is slow to answer (placeholder). */
export function armsCheck(source: ArmSource): Check {
  return { name: "arms", timeoutMs: 30_000, run: (ctx) => armsLines(ctx, source) };
}
