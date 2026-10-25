import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LIFT_ACCEL_CEILING_MM_S2,
  LIFT_HOMING_BACKOFF_MM,
  LIFT_HOMING_FAST_MM_S,
  LIFT_HOMING_MAX_TRAVEL_MM,
  LIFT_HOMING_RELEASE_MARGIN_MM,
  LIFT_HOMING_SLOW_MM_S,
  LIFT_HOMING_TIMEOUT_MS,
  LIFT_HOLD_LEASE_MS,
  LIFT_MOTOR_FULL_STEPS_PER_TURN,
  LIFT_RAIL_LENGTH_MM,
  LIFT_SCREW_LEAD_MM,
  LIFT_SPEED_CEILING_MM_S,
  LIFT_STATUS_HZ,
  LIFT_STOP_DECEL_MM_S2,
  LIFT_WATCHDOG_DRIVER_ACTION,
  LIFT_WATCHDOG_TIMEOUT_MS,
  LiftAckReasonSchema,
  LiftConfigSchema,
  LiftRequestIdSchema,
  SERIAL_ANY_MODULE,
  SERIAL_MAX_LINE_BYTES,
  SerialProblemSchema,
  isAlwaysAcceptedLiftCommand,
  skipsLiftSeqCheck,
  parseLiftSerialLine,
  type LiftSerialMessage,
} from "../src";

/**
 * Cross-check of the lift ESP32 firmware against lift-serial.ts (firmware/test/EXPECTED.md, "Lift board").
 *
 * firmware/test/session/lift_transcript.txt is printed by the firmware's own C++ code running a scripted
 * session on a fake clock and a simulated stepper (firmware/test/session/lift_session_main.cpp);
 * firmware/test/run-native.sh fails if the committed file differs from what the code prints now. This test
 * reads it with the real parseLiftSerialLine. Every lift line must pass; every reply to a Pi line must carry
 * the contract's code for it; and the acceptance rules of the contract's header (rules 2, 3, 4, 6) are computed
 * here from the parsed lines, independently of the C++.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const transcript = read("../../../firmware/test/session/lift_transcript.txt");
const validFixtures = read("./fixtures/lift-serial-v1.valid.jsonl").split("\n").filter(Boolean);
const invalidFixtures: { line: string }[] = JSON.parse(read("./fixtures/lift-serial-v1.invalid.json"));
const firmwareHeader = read("../../../firmware/lib/lift/lift_core.h");
const firmwareMotion = read("../../../firmware/lib/lift/lift_motion.h");
const firmwareMain = read("../../../firmware/src/lift/build_settings.h");

type Event = { kind: "at"; ms: number } | { kind: "pi"; line: string } | { kind: "lift"; line: string };

function events(text: string): Event[] {
  const result: Event[] = [];
  let sections = 0;
  for (const raw of text.split("\n")) {
    if (raw === "" || raw.startsWith("# ")) continue;
    const tag = raw.slice(0, 2);
    const rest = raw.slice(2);
    if (tag === "= ") {
      expect(rest).toBe("lift-01 lift");
      sections += 1;
    } else if (tag === "@ ") result.push({ kind: "at", ms: Number(rest) });
    else if (tag === "> ") result.push({ kind: "pi", line: rest });
    else if (tag === "< ") result.push({ kind: "lift", line: rest });
    else throw new Error(`unknown transcript line: ${raw}`);
  }
  expect(sections).toBe(1);
  return result;
}

const LIFT_SENT_TYPES = new Set(["lift.hello", "lift.status", "lift.done", "lift.ack"]);
const COMMAND_TYPES = new Set(["lift.home", "lift.move", "lift.stop", "lift.enable", "lift.clear"]);
/** Reasons that depend on the lift's state, which this test doesn't model. */
const STATE_REASONS = new Set(
  LiftAckReasonSchema.options.filter((r) => !(SerialProblemSchema.options as readonly string[]).includes(r) && r !== "stale_seq"),
);

function parsedLiftLine(line: string): LiftSerialMessage {
  const result = parseLiftSerialLine(`${line}\n`);
  if (!result.ok) throw new Error(`lift line refused (${result.problem}: ${result.detail}): ${line}`);
  return result.message;
}

const all = events(transcript);
const liftLines = all.filter((e): e is Extract<Event, { kind: "lift" }> => e.kind === "lift").map((e) => parsedLiftLine(e.line));
const of = <T extends LiftSerialMessage["type"]>(type: T) =>
  liftLines.filter((m): m is Extract<LiftSerialMessage, { type: T }> => m.type === type);

describe("lift firmware session transcript against lift-serial.ts", () => {
  it("LS4: every line the lift sends passes parseLiftSerialLine, under 1,024 bytes, seq 0, 1, 2, …", () => {
    let seq = 0;
    for (const event of all) {
      if (event.kind !== "lift") continue;
      expect(Buffer.byteLength(`${event.line}\n`)).toBeLessThanOrEqual(SERIAL_MAX_LINE_BYTES);
      const message = parsedLiftLine(event.line);
      expect(LIFT_SENT_TYPES.has(message.type) || message.type === "error").toBe(true);
      expect(message.module_id).toBe("lift-01");
      expect(message.seq).toBe(seq);
      seq += 1;
    }
    expect(seq).toBeGreaterThan(400);
  });

  it("LS1, LS3: lift.hello at boot with seq 0, again when asked, with the configuration the Pi expects", () => {
    const hellos = of("lift.hello");
    expect(liftLines[0]).toMatchObject({ type: "lift.hello", seq: 0, uptime_ms: 0 });
    expect(hellos.length).toBeGreaterThanOrEqual(3);
    // The contract's example configuration is what lift-01 is built with.
    const example = parsedLiftLine(validFixtures[0]!);
    for (const hello of hellos) {
      expect(LiftConfigSchema.safeParse(hello.config).success).toBe(true);
      expect(hello.config).toEqual(example.type === "lift.hello" ? example.config : null);
    }
    // Rule 1: the first status is unhomed, not stepping, no fault, driver enabled; the stop is wired.
    expect(liftLines[0]).toMatchObject({ stop_sense: "wired" });
    expect(liftLines[1]).toMatchObject({
      type: "lift.status",
      state: "unhomed",
      homed: false,
      position_mm: null,
      driver_enabled: true,
      stop_sense: "released",
      faults: [],
      request_id: null,
      heartbeat_age_ms: null,
    });
  });

  it("LR7: every reply carries the contract's code, and rules 2, 3 and 6 decide every acceptance", () => {
    let threshold: number | null = null;
    const seen = new Set<string>();
    const accepted = new Map<string, string>(); // request_id -> type, for accepted moves and homings
    all.forEach((event, index) => {
      if (event.kind !== "pi") return;
      // Its replies: the lift lines straight after it, leaving out the statuses (sent on change) and
      // lift.done (a disable ends a running command at once).
      const replies: LiftSerialMessage[] = [];
      for (let next = index + 1; next < all.length && all[next]!.kind !== "pi"; next += 1) {
        const e = all[next]!;
        if (e.kind === "at") break;
        const message = parsedLiftLine(e.line);
        if (message.type !== "lift.status" && message.type !== "lift.done") replies.push(message);
      }
      const context = `Pi line: ${event.line.slice(0, 200)}`;
      const result = parseLiftSerialLine(event.line);
      let data: Record<string, unknown> | undefined;
      try {
        data = JSON.parse(event.line) as Record<string, unknown>;
      } catch {
        data = undefined;
      }
      if (event.line.trim() === "") {
        expect(replies, context).toEqual([]);
        return;
      }
      if (!result.ok) {
        const type = typeof data?.type === "string" ? data.type : "";
        if (result.problem === "invalid_field" && LIFT_SENT_TYPES.has(type)) {
          expect(replies, context).toMatchObject([{ type: "error", code: "unsupported" }]);
          seen.add("error unsupported");
        } else if (
          result.problem === "invalid_field" &&
          COMMAND_TYPES.has(type) &&
          LiftRequestIdSchema.safeParse(data?.request_id).success
        ) {
          expect(replies, context).toMatchObject([{ type: "lift.ack", request_id: data!.request_id, result: "rejected", reason: "invalid_field" }]);
          seen.add("ack invalid_field");
        } else {
          expect(replies, context).toHaveLength(1);
          expect(replies[0], context).toMatchObject({ type: "error", code: result.problem });
          expect(replies[0], context).not.toHaveProperty("request_id");
          seen.add(`error ${result.problem}`);
        }
        return;
      }
      const message = result.message;
      if (LIFT_SENT_TYPES.has(message.type)) {
        expect(replies, context).toMatchObject([{ type: "error", code: "unsupported" }]);
        seen.add("error unsupported");
        return;
      }
      if (message.type === "error") {
        expect(replies, context).toEqual([]);
        seen.add("none");
        return;
      }
      if (message.type === "hello.request") {
        if (message.module_id === "lift-01" || message.module_id === SERIAL_ANY_MODULE) {
          expect(replies, context).toMatchObject([{ type: "lift.hello" }]);
          threshold = null; // rules 2 and 3: seq counts again from the last hello.request
          seen.add("hello");
        } else {
          expect(replies, context).toMatchObject([{ type: "error", code: "invalid_field" }]);
        }
        return;
      }
      if (message.type === "lift.heartbeat") {
        expect(replies, context).toEqual(message.module_id === "lift-01" ? [] : [expect.objectContaining({ code: "invalid_field" })]);
        // Rule 3: a fresh heartbeat is an accepted Pi seq; a stale one is ignored.
        if (message.module_id === "lift-01" && (threshold === null || message.seq > threshold)) threshold = message.seq;
        else if (message.module_id === "lift-01") seen.add("stale heartbeat");
        return;
      }
      // A command.
      if (
        message.type !== "lift.home" &&
        message.type !== "lift.move" &&
        message.type !== "lift.stop" &&
        message.type !== "lift.enable" &&
        message.type !== "lift.clear"
      ) {
        throw new Error(`${context}: unexpected type ${message.type}`);
      }
      expect(replies, context).toHaveLength(1);
      const ack = replies[0]!;
      if (ack.type !== "lift.ack") throw new Error(`${context}: no lift.ack`);
      expect(ack.request_id, context).toBe(message.request_id);
      if (message.module_id !== "lift-01") {
        expect(ack, context).toMatchObject({ result: "rejected", reason: "invalid_field" });
        return;
      }
      const always = isAlwaysAcceptedLiftCommand(message);
      const skipsSeq = skipsLiftSeqCheck(message);
      const stale = threshold !== null && message.seq <= threshold;
      if (always) {
        expect(ack.result, context).toBe("accepted"); // rule 6: a stop
        seen.add(`always ${stale ? "stale" : "fresh"}`);
      } else if (skipsSeq) {
        // Rule 6: a disable is never stale_seq; it is accepted or refused disable_unsafe, nothing else.
        if (ack.result === "rejected") expect(ack.reason, context).toBe("disable_unsafe");
        seen.add(`disable ${ack.result === "accepted" ? "accepted" : "disable_unsafe"}${stale ? " stale" : ""}`);
      } else if (stale) {
        expect(ack, context).toMatchObject({ result: "rejected", reason: "stale_seq" }); // rule 3
        seen.add("ack stale_seq");
      } else if (ack.result === "rejected") {
        expect(STATE_REASONS.has(ack.reason!), context).toBe(true);
        if (message.type === "lift.enable") throw new Error(`${context}: enable true is refused only for stale_seq`);
        seen.add(`ack ${ack.reason}`);
      } else {
        seen.add(`accepted ${message.type}`);
      }
      if (ack.result === "accepted") {
        threshold = threshold === null ? message.seq : Math.max(threshold, message.seq);
        if (message.type === "lift.home" || message.type === "lift.move") accepted.set(message.request_id, message.type);
      }
    });
    // The reader cases and the scripted path reach every kind of reply, not one path many times.
    for (const kind of [
      "hello",
      "none",
      "error malformed",
      "error unsupported_version",
      "error unknown_type",
      "error invalid_field",
      "error oversize",
      "error unsupported",
      "ack invalid_field",
      "ack stale_seq",
      "ack not_held",
      "ack stop_pressed",
      "ack request_used",
      "stale heartbeat",
      "ack not_homed",
      "ack cause_present",
      "always stale",
      "always fresh",
      "disable accepted",
      "disable disable_unsafe",
      "accepted lift.home",
      "accepted lift.move",
    ]) {
      expect([...seen], kind).toContain(kind);
    }
    // lift.done once per accepted move or homing, and never for anything else.
    const dones = of("lift.done");
    for (const done of dones) expect(accepted.has(done.request_id), done.request_id).toBe(true);
    for (const id of accepted.keys()) expect(dones.filter((d) => d.request_id === id), id).toHaveLength(1);
  });

  it("LR7: every line of the contract's lift fixtures was sent to the firmware", () => {
    const sent = new Set(all.filter((e): e is Extract<Event, { kind: "pi" }> => e.kind === "pi").map((e) => e.line));
    for (const line of [...validFixtures, ...invalidFixtures.map((c) => c.line)]) expect(sent).toContain(line);
    expect(sent.size).toBeGreaterThan(250);
  });

  it("LS2: a lift.status at least every 1000 / LIFT_STATUS_HZ ms", () => {
    let last: number | null = null;
    for (const status of of("lift.status")) {
      if (last !== null) expect(status.uptime_ms - last).toBeLessThanOrEqual(1000 / LIFT_STATUS_HZ);
      last = status.uptime_ms;
    }
  });

  it("the scripted path: homes, moves, stops on release, on stop, on hello.request, on a lost heartbeat and on the stop", () => {
    const done = (id: string) => of("lift.done").filter((d) => d.request_id === id);
    const acks = (id: string) => of("lift.ack").filter((a) => a.request_id === id);
    const ack = (id: string) => acks(id)[0];
    expect(ack("path00-3")).toMatchObject({ result: "rejected", reason: "stale_seq" });
    expect(ack("path00-4")).toMatchObject({ result: "rejected", reason: "not_held" }); // its heartbeat was stale
    expect(ack("path00-5")).toMatchObject({ result: "rejected", reason: "not_homed" });
    expect(done("path00-6")).toMatchObject([{ outcome: "completed", position_mm: LIFT_HOMING_BACKOFF_MM }]);
    expect(done("path00-7")).toMatchObject([{ outcome: "completed", position_mm: 30 }]);
    // Let go: stopped. Held and sent again: refused, and it never ran twice.
    expect(done("path00-8")).toMatchObject([{ outcome: "stopped" }]);
    expect(acks("path00-8")).toMatchObject([{ result: "accepted" }, { result: "rejected", reason: "request_used" }]);
    expect(done("path00-9")).toMatchObject([{ outcome: "stopped" }]); // lift.stop path00-10
    expect(done("path00-10")).toEqual([]); // a stop has no lift.done of its own
    expect(done("path00-11")).toMatchObject([{ outcome: "stopped" }]); // hello.request
    expect(done("path00-12")).toMatchObject([{ outcome: "failed", fault: "watchdog_expired" }]);
    expect(ack("path00-13")).toMatchObject({ result: "rejected", reason: "cause_present" });
    expect(ack("path00-14")).toMatchObject({ result: "accepted" });
    expect(done("path00-15")).toMatchObject([{ outcome: "completed", position_mm: LIFT_HOMING_BACKOFF_MM }]);
    expect(done("path00-16")).toMatchObject([{ outcome: "failed", fault: "stop_circuit_opened" }]);
    expect(ack("path00-17")).toMatchObject({ result: "rejected", reason: "stop_pressed" });
    expect(ack("path00-18")).toMatchObject({ result: "rejected", reason: "cause_present" });
    expect(ack("path00-19")).toMatchObject({ result: "accepted" });
    expect(ack("path00-20")).toMatchObject({ result: "rejected", reason: "cause_present" });
    expect(ack("path00-21")).toMatchObject({ result: "accepted" });
    expect(ack("path00-22")).toMatchObject({ result: "rejected", reason: "disable_unsafe" });
    expect(ack("path00-23")).toMatchObject({ result: "accepted" });
    const statuses = of("lift.status");
    expect(statuses).toContainEqual(expect.objectContaining({ state: "homing", request_id: "path00-6", target_mm: 5 }));
    expect(statuses).toContainEqual(expect.objectContaining({ state: "stopping", request_id: "path00-8", homed: true }));
    expect(statuses).toContainEqual(expect.objectContaining({ state: "fault", faults: ["watchdog_expired"], homed: false, driver_enabled: true }));
    expect(statuses).toContainEqual(expect.objectContaining({ stop_sense: "pressed", faults: ["stop_circuit_opened"], state: "fault" }));
    expect(statuses).toContainEqual(expect.objectContaining({ faults: ["limit_wiring"], limits: { top: "pressed", bottom: "pressed" } }));
    for (const s of statuses.filter((s) => s.state === "moving")) {
      expect(s.position_mm!).toBeGreaterThanOrEqual(5);
      expect(s.position_mm!).toBeLessThanOrEqual(600);
    }
    expect(statuses.at(-1)).toMatchObject({ state: "unhomed", faults: [], driver_enabled: false });
  });

  it("the firmware's copies of the contract's constants match motion.ts", () => {
    const value = (text: string, name: string) => {
      const match = new RegExp(`constexpr uint32_t ${name} = ([0-9]+);`).exec(text);
      if (!match) throw new Error(`${name} not found`);
      return Number(match[1]);
    };
    expect(value(firmwareHeader, "kHomingFastMilliMmS")).toBe(LIFT_HOMING_FAST_MM_S * 1000);
    expect(value(firmwareHeader, "kHomingSlowMilliMmS")).toBe(LIFT_HOMING_SLOW_MM_S * 1000);
    expect(value(firmwareHeader, "kHomingBackoffMilliMm")).toBe(LIFT_HOMING_BACKOFF_MM * 1000);
    expect(value(firmwareHeader, "kHomingMaxTravelMilliMm")).toBe(LIFT_HOMING_MAX_TRAVEL_MM * 1000);
    expect(value(firmwareHeader, "kHomingReleaseMarginMilliMm")).toBe(LIFT_HOMING_RELEASE_MARGIN_MM * 1000);
    expect(value(firmwareHeader, "kHomingTimeoutMs")).toBe(LIFT_HOMING_TIMEOUT_MS);
    expect(value(firmwareHeader, "kStopDecelMilliMmS2")).toBe(LIFT_STOP_DECEL_MM_S2 * 1000);
    expect(value(firmwareHeader, "kWatchdogTimeoutMs")).toBe(LIFT_WATCHDOG_TIMEOUT_MS);
    expect(LIFT_HOLD_LEASE_MS).toBe(LIFT_WATCHDOG_TIMEOUT_MS);
    expect(value(firmwareHeader, "kStatusIntervalMs")).toBe(1000 / LIFT_STATUS_HZ);
    expect(value(firmwareMotion, "kFullStepsPerTurn")).toBe(LIFT_MOTOR_FULL_STEPS_PER_TURN);
    expect(value(firmwareMotion, "kScrewLeadMm")).toBe(LIFT_SCREW_LEAD_MM);
    expect(value(firmwareMotion, "kRailLengthMm")).toBe(LIFT_RAIL_LENGTH_MM);
    expect(value(firmwareMotion, "kSpeedCeilingMmS")).toBe(LIFT_SPEED_CEILING_MM_S);
    expect(value(firmwareMotion, "kAccelCeilingMmS2")).toBe(LIFT_ACCEL_CEILING_MM_S2);
    expect(LIFT_WATCHDOG_DRIVER_ACTION).toBe("hold");
    // The board's built-in configuration is the one the session ran with, and the one its hello reports.
    // Each limit is either a number or `kEstimatedDemo ? <demo>u : <normal>u`; the normal build's values are compared.
    const limit = String.raw`(?:kEstimatedDemo \? [0-9]+u : )?([0-9]+)u?`;
    const built = new RegExp(
      String.raw`kSettings\{WALKER_LIFT_MICROSTEPS, ${limit}, ${limit},\s+${limit}, ${limit}, false, 0,\s+WatchdogDriverAction::Hold, kStopSenseWired, kDisableSafe\}`,
    ).exec(firmwareMain);
    const rig = /kDefaultSettings\{8, ([0-9]+), ([0-9]+), ([0-9]+), ([0-9]+), false, 0, lift::WatchdogDriverAction::Hold,\s+true, false\}/.exec(
      read("../../../firmware/test/support/lift_rig.h"),
    );
    expect(built).not.toBeNull();
    expect(rig?.slice(1)).toEqual(built!.slice(1));
    expect(/#define WALKER_LIFT_MICROSTEPS 8\n/.test(firmwareMain)).toBe(true);
    expect(/#define WALKER_LIFT_STOP_SENSE 1\n/.test(firmwareMain)).toBe(true);
    expect(/#define WALKER_LIFT_DISABLE_SAFE 0\n/.test(firmwareMain)).toBe(true);
    // The no-switch demo's limits apply only when a build asks for it.
    expect(/#define WALKER_LIFT_ESTIMATED_DEMO 0\n/.test(firmwareMain)).toBe(true);
    const hello = of("lift.hello")[0]!;
    expect(built!.slice(1).map(Number)).toEqual(
      [hello.config.soft_min_mm, hello.config.soft_max_mm, hello.config.max_speed_mm_s, hello.config.max_accel_mm_s2].map((v) => v * 1000),
    );
  });
});
