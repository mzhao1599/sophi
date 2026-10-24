import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SERIAL_ANY_MODULE,
  SERIAL_MAX_LINE_BYTES,
  SERIAL_TOF_REPORT_HZ,
  SerialRequestIdSchema,
  parseSerialLine,
  type SerialMessage,
} from "../src";

/**
 * Cross-check of the ESP32 firmware against this contract (firmware/test/EXPECTED.md, rows L5 and R15).
 *
 * firmware/test/session/transcript.txt is printed by the firmware's own C++ code running a scripted
 * session on a fake clock (firmware/test/session/session_main.cpp); firmware/test/run-native.sh fails
 * if the committed file differs from what the code prints now. This test reads it with the real
 * parseSerialLine: every module line must pass, and every reply to a Pi line must carry the problem code
 * this parser gives that line. The few firmware-only rules (destination, capability, types only modules
 * send) are computed here from the parsed line, independently of the C++.
 */

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const transcript = read("../../../firmware/test/session/transcript.txt");
const validFixtures = read("./fixtures/serial-v1.valid.jsonl").split("\n").filter(Boolean);
const invalidFixtures: { line: string }[] = JSON.parse(read("./fixtures/serial-v1.invalid.json"));

type Event = { kind: "at"; ms: number } | { kind: "pi"; line: string } | { kind: "module"; line: string };
interface Section {
  moduleId: string;
  moduleType: string;
  events: Event[];
}

function sections(text: string): Section[] {
  const result: Section[] = [];
  for (const raw of text.split("\n")) {
    if (raw === "" || raw.startsWith("# ")) continue;
    const tag = raw.slice(0, 2);
    const rest = raw.slice(2);
    if (tag === "= ") {
      const [moduleId, moduleType] = rest.split(" ");
      result.push({ moduleId: moduleId!, moduleType: moduleType!, events: [] });
      continue;
    }
    const section = result.at(-1);
    if (!section) throw new Error(`line before any section: ${raw}`);
    if (tag === "@ ") section.events.push({ kind: "at", ms: Number(rest) });
    else if (tag === "> ") section.events.push({ kind: "pi", line: rest });
    else if (tag === "< ") section.events.push({ kind: "module", line: rest });
    else throw new Error(`unknown transcript line: ${raw}`);
  }
  return result;
}

const MODULE_ONLY_TYPES = new Set(["hello", "heartbeat", "hand.input", "perception.zones", "ack"]);

type Expected =
  | { kind: "none" }
  | { kind: "hello" }
  | { kind: "error"; code: string }
  | { kind: "ack"; requestId: string; reason: string | null };

/** What the firmware must answer to one Pi line, from the contract's own parser plus the firmware rules. */
function expectedReply(line: string, own: string, hasHaptic: boolean): Expected {
  const result = parseSerialLine(line);
  if (!result.ok) {
    let data: Record<string, unknown> | undefined;
    try {
      data = JSON.parse(line) as Record<string, unknown>;
    } catch {
      data = undefined;
    }
    if (result.problem === "invalid_field" && typeof data?.type === "string") {
      // R10: the firmware doesn't check the fields of a type it never acts on.
      if (MODULE_ONLY_TYPES.has(data.type)) return { kind: "error", code: "unsupported" };
      // R2: a rejected haptic.play is acked against its request_id when that is readable.
      if (data.type === "haptic.play" && SerialRequestIdSchema.safeParse(data.request_id).success) {
        return { kind: "ack", requestId: data.request_id as string, reason: "invalid_field" };
      }
    }
    return { kind: "error", code: result.problem };
  }
  const message = result.message;
  if (MODULE_ONLY_TYPES.has(message.type)) return { kind: "error", code: "unsupported" };
  if (message.type === "error") return { kind: "none" };
  if (message.type === "hello.request") {
    return message.module_id === own || message.module_id === SERIAL_ANY_MODULE
      ? { kind: "hello" }
      : { kind: "error", code: "invalid_field" };
  }
  if (message.type !== "haptic.play") throw new Error(`unexpected type ${message.type}`);
  if (message.module_id !== own) return { kind: "ack", requestId: message.request_id, reason: "invalid_field" };
  if (!hasHaptic) return { kind: "ack", requestId: message.request_id, reason: "unsupported" };
  return { kind: "ack", requestId: message.request_id, reason: null };
}

function parsedModuleLine(line: string): SerialMessage {
  const result = parseSerialLine(`${line}\n`);
  if (!result.ok) throw new Error(`module line refused (${result.problem}: ${result.detail}): ${line}`);
  return result.message;
}

const all = sections(transcript);

describe("firmware session transcript against the serial contract", () => {
  it("has the three scripted boards", () => {
    expect(all.map((s) => `${s.moduleId} ${s.moduleType}`)).toEqual([
      "hand-left-01 hand",
      "hand-right-01 hand",
      "tof-front-01 perception",
    ]);
  });

  it.each(all)("L5: every line $moduleId sends passes parseSerialLine, under 1,024 bytes, seq 0, 1, 2, …", (section) => {
    let seq = 0;
    let lines = 0;
    for (const event of section.events) {
      if (event.kind !== "module") continue;
      expect(Buffer.byteLength(`${event.line}\n`)).toBeLessThanOrEqual(SERIAL_MAX_LINE_BYTES);
      const message = parsedModuleLine(event.line);
      expect(MODULE_ONLY_TYPES.has(message.type) || message.type === "error").toBe(true);
      expect(message.module_id).toBe(section.moduleId);
      expect(message.seq).toBe(seq);
      seq += 1;
      lines += 1;
    }
    expect(lines).toBeGreaterThanOrEqual(4);
  });

  it.each(all)("L1, L4: $moduleId says hello at boot, and again with a running seq when asked", (section) => {
    const hellos = section.events
      .filter((e): e is Extract<Event, { kind: "module" }> => e.kind === "module")
      .map((e) => parsedModuleLine(e.line))
      .filter((m): m is Extract<SerialMessage, { type: "hello" }> => m.type === "hello");
    expect(hellos[0]?.seq).toBe(0);
    expect(hellos.length).toBeGreaterThanOrEqual(2);
    for (const hello of hellos) {
      expect(hello.module_type).toBe(section.moduleType);
      expect(hello.capabilities).toEqual(hellos[0]!.capabilities);
      expect(hello.firmware_version).toBe(hellos[0]!.firmware_version);
    }
    expect(hellos.slice(1).every((h) => h.seq > 0)).toBe(true);
    if (section.moduleType === "hand") {
      expect(hellos[0]!.capabilities).toEqual(expect.arrayContaining(["button.talk", "button.confirm"]));
    } else {
      expect(hellos[0]!.capabilities).toEqual(["zones"]);
    }
  });

  it.each(all)("R15: every reply from $moduleId carries the contract's code for that Pi line", (section) => {
    const firstHello = parsedModuleLine(section.events.find((e) => e.kind === "module")!.line as string);
    const hasHaptic = firstHello.type === "hello" && firstHello.capabilities.includes("haptic");
    const seen = new Set<string>();
    section.events.forEach((event, index) => {
      if (event.kind !== "pi") return;
      const replies: SerialMessage[] = [];
      for (let next = index + 1; next < section.events.length && section.events[next]!.kind === "module"; next += 1) {
        replies.push(parsedModuleLine((section.events[next] as { line: string }).line));
      }
      const expected = expectedReply(event.line, section.moduleId, hasHaptic);
      const context = `Pi line: ${event.line.slice(0, 200)}`;
      if (expected.kind === "none") {
        expect(replies, context).toEqual([]);
        seen.add("none");
        return;
      }
      expect(replies, context).toHaveLength(1);
      const reply = replies[0]!;
      if (expected.kind === "hello") {
        expect(reply.type, context).toBe("hello");
        seen.add("hello");
      } else if (expected.kind === "error") {
        expect(reply, context).toMatchObject({ type: "error", code: expected.code });
        expect(reply, context).not.toHaveProperty("request_id");
        seen.add(`error ${expected.code}`);
      } else {
        expect(reply, context).toMatchObject({
          type: "ack",
          request_id: expected.requestId,
          result: expected.reason === null ? "accepted" : "rejected",
        });
        expect((reply as { reason?: string }).reason, context).toBe(expected.reason ?? undefined);
        seen.add(`ack ${expected.reason ?? "accepted"}`);
      }
    });
    if (section.moduleId === "hand-left-01") {
      // The scripted and scrambled lines reach every kind of reply, not one path many times.
      expect([...seen].sort()).toEqual(
        [
          "ack accepted",
          "ack invalid_field",
          "error invalid_field",
          "error malformed",
          "error oversize",
          "error unknown_type",
          "error unsupported",
          "error unsupported_version",
          "hello",
          "none",
        ].sort(),
      );
    }
  });

  it("R15: every line of the contract's fixtures was sent to the firmware", () => {
    const sent = new Set(
      all[0]!.events.filter((e): e is Extract<Event, { kind: "pi" }> => e.kind === "pi").map((e) => e.line),
    );
    for (const line of [...validFixtures, ...invalidFixtures.map((c) => c.line)]) expect(sent).toContain(line);
    expect(sent.size).toBeGreaterThan(250);
  });

  it.each(all)("L2: $moduleId sends a heartbeat every 1,000 ms", (section) => {
    const beats = section.events
      .filter((e): e is Extract<Event, { kind: "module" }> => e.kind === "module")
      .map((e) => parsedModuleLine(e.line))
      .filter((m): m is Extract<SerialMessage, { type: "heartbeat" }> => m.type === "heartbeat");
    expect(beats.length).toBeGreaterThanOrEqual(1);
    beats.forEach((beat, i) => expect(beat.uptime_ms).toBe((i + 1) * 1000));
  });

  it("R5, L1: a hand board whose haptic driver didn't answer says so and refuses cues", () => {
    const section = all[1]!;
    const lines = section.events
      .filter((e): e is Extract<Event, { kind: "module" }> => e.kind === "module")
      .map((e) => parsedModuleLine(e.line));
    expect(lines[0]).toMatchObject({ type: "hello", capabilities: ["button.talk", "button.confirm"] });
    expect(lines).toContainEqual(expect.objectContaining({ type: "heartbeat", health: "degraded", faults: ["haptic_missing"] }));
    expect(lines).toContainEqual(expect.objectContaining({ type: "ack", result: "rejected", reason: "unsupported" }));
  });

  it("Z1-Z7: obstacle zones at 10-20 Hz, four named zones, unknown when a sensor can't be trusted", () => {
    const section = all[2]!;
    const messages = section.events
      .filter((e): e is Extract<Event, { kind: "module" }> => e.kind === "module")
      .map((e) => parsedModuleLine(e.line));
    const reports = messages.filter((m): m is Extract<SerialMessage, { type: "perception.zones" }> => m.type === "perception.zones");
    expect(reports.length).toBeGreaterThanOrEqual(12);
    for (let i = 1; i < reports.length; i += 1) {
      const hz = 1000 / (reports[i]!.uptime_ms - reports[i - 1]!.uptime_ms);
      expect(hz).toBeGreaterThanOrEqual(SERIAL_TOF_REPORT_HZ.min);
      expect(hz).toBeLessThanOrEqual(SERIAL_TOF_REPORT_HZ.max);
    }
    for (const report of reports) {
      expect(report.zones.map((z) => z.name)).toEqual(["front_left", "front_right", "left", "right"]);
      const [, frontRight, left, right] = report.zones;
      expect(frontRight).toEqual({ name: "front_right", mm: null, quality: "invalid" }); // signal fail
      expect(right).toEqual({ name: "right", mm: null, quality: "invalid" }); // never answered
      // left stops producing at 500 ms; 250 ms later it reads unknown.
      expect(left!.quality).toBe(report.uptime_ms - 500 > 250 ? "invalid" : "valid");
    }
    const frontLeft = (ms: number) => reports.find((r) => r.uptime_ms === ms)?.zones[0];
    expect(frontLeft(80)).toEqual({ name: "front_left", mm: 875, quality: "valid" });
    expect(frontLeft(800)).toEqual({ name: "front_left", mm: 500, quality: "valid" }); // status 3 at 800: still valid
    expect(frontLeft(960)).toEqual({ name: "front_left", mm: null, quality: "invalid" }); // 4,001 mm at 900
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "heartbeat", health: "degraded", faults: ["sensor_missing", "sensor_error"] }),
    );
  });
});
