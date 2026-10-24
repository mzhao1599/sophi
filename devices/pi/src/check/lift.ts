import {
  SERIAL_MAX_LINE_BYTES,
  liftStepsPerMm,
  parseLiftSerialLine,
  type LiftSerialMessage,
} from "@walker/contracts";
import { fail, pass, warn, type CheckLine } from "./core";

/**
 * The lift board (`lift-01`), read through the serial check's ports: the module manager's `hello.request` is
 * the only line the Pi sends it (the tap in modules.ts refuses anything else on a lift port), and the board
 * answers with `lift.hello` and keeps sending `lift.status` at LIFT_STATUS_HZ. No heartbeat is sent, so the
 * board refuses every move while the check runs (lift-serial.ts rule 4, `no_heartbeat`).
 */
export type LiftHello = Extract<LiftSerialMessage, { type: "lift.hello" }>;
export type LiftStatus = Extract<LiftSerialMessage, { type: "lift.status" }>;

export interface LiftTap {
  hellos: LiftHello[];
  status: LiftStatus | null;
  statuses: number;
}

/**
 * Splits raw bytes into lines (dropping any longer than SERIAL_MAX_LINE_BYTES) and hands each lift line to
 * `onMessage`. The serial line reader answers `unknown_type` for these, so the tap reads them itself.
 */
export function liftLineSplitter(onMessage: (message: LiftSerialMessage) => void): (data: Buffer) => void {
  let pending = "";
  let discarding = false;
  return (data) => {
    const parts = (pending + data.toString("utf8")).split("\n");
    pending = parts.pop() ?? "";
    for (const line of parts) {
      if (discarding) {
        discarding = false;
        continue;
      }
      if (!line.includes('"lift.')) continue;
      const result = parseLiftSerialLine(line);
      if (result.ok) onMessage(result.message);
    }
    if (pending.length > SERIAL_MAX_LINE_BYTES) {
      pending = "";
      discarding = true;
    }
  };
}

const mm = (value: number | null) => (value === null ? "unknown" : `${value} mm`);

export function liftLines(id: string, port: string, tap: LiftTap, sampleMs: number, simulated: boolean): CheckLine[] {
  const sim = simulated ? " (simulated)" : "";
  const hello = tap.hellos.at(-1)!;
  const c = hello.config;
  const limits =
    `built-in limits ${c.soft_min_mm} to ${c.soft_max_mm} mm, at most ${c.max_speed_mm_s} mm/s and ${c.max_accel_mm_s2} mm/s², ` +
    `${c.microsteps} microsteps (${liftStepsPerMm(c)} steps/mm), top switch ${c.top_switch_mm === null ? "not measured" : `at ${c.top_switch_mm} mm`}`;
  const helloDetail = `firmware ${hello.firmware_version}, protocol v${hello.v}, port ${port}; ${limits}; stop-sense input ${hello.stop_sense}`;
  const lines: CheckLine[] = [
    hello.stop_sense === "wired"
      ? pass("lift", id, `${helloDetail}${sim}`)
      : warn("lift", id, `${helloDetail}: the firmware was built without a stop-sense input (bench only)${sim}`),
  ];
  const s = tap.status;
  if (!s) {
    lines.push(fail("lift", `${id} status`, `no lift.status in ${(sampleMs / 1000).toFixed(1)} s after its hello${sim}`));
    return lines;
  }
  const problems: string[] = [];
  if (s.stop_sense !== "released") problems.push(s.stop_sense === "pressed" ? "the stop reads PRESSED (or its wire is cut): release it" : "stop sense not wired on the lift board");
  if (!s.homed) problems.push("not homed (normal after power-on; homing is a held move from the walker, never from this check)");
  if (s.faults.length) problems.push(`faults latched: ${s.faults.join(" ")}`);
  if (!s.driver_enabled) problems.push("driver disabled (the motor isn't holding the carriage)");
  const detail =
    `${s.state}, height ${mm(s.position_mm)}, top switch ${s.limits.top}, bottom switch ${s.limits.bottom}, stop ${s.stop_sense}, ` +
    `driver ${s.driver_enabled ? "enabled" : "disabled"}, ${s.faults.length ? `faults ${s.faults.join(" ")}` : "no faults"}, ` +
    `last Pi heartbeat ${s.heartbeat_age_ms === null ? "none" : `${s.heartbeat_age_ms} ms ago`} (this check sends none); ` +
    `${tap.statuses} reports in ${(sampleMs / 1000).toFixed(1)} s`;
  lines.push(problems.length ? warn("lift", `${id} status`, `${detail}: ${problems.join("; ")}${sim}`) : pass("lift", `${id} status`, `${detail}${sim}`));
  return lines;
}
