import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  LIFT_ONLY_MESSAGE_TYPES,
  LIFT_PI_MESSAGE_TYPES,
  LIFT_SERIAL_MESSAGE_TYPES,
  LiftSerialFaultSchema,
  MotionFaultCodeSchema,
  SERIAL_MAX_LINE_BYTES,
  isAlwaysAcceptedLiftCommand,
  skipsLiftSeqCheck,
  parseLiftSerialLine,
  parseSerialLine,
} from "../src";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const validLines = read("./fixtures/lift-serial-v1.valid.jsonl").split("\n").filter(Boolean);
const invalidCases: { expect: string; why: string; line: string }[] = JSON.parse(read("./fixtures/lift-serial-v1.invalid.json"));
const moduleFixtures = read("./fixtures/serial-v1.valid.jsonl").split("\n").filter(Boolean);
const isLiftLine = (line: string) => /^\{"v":1,"type":"lift\./.test(line);

describe("lift serial v1 (proposed)", () => {
  it("keeps every lift example line from docs/interfaces.md in the fixtures", () => {
    const docLines = read("../../../docs/interfaces.md").split("\n").filter(isLiftLine);
    expect(docLines.length).toBeGreaterThanOrEqual(6);
    for (const line of docLines) expect(validLines).toContain(line);
  });

  it("has a fixture line for every lift type", () => {
    const types = new Set(validLines.map((l) => JSON.parse(l).type));
    for (const type of LIFT_SERIAL_MESSAGE_TYPES) expect(types).toContain(type);
  });

  it.each(validLines)("parses %s", (line) => {
    expect(parseLiftSerialLine(`${line}\n`)).toMatchObject({ ok: true, message: JSON.parse(line) });
  });

  it.each(invalidCases)("rejects: $why", ({ expect: problem, line }) => {
    expect(parseLiftSerialLine(line)).toMatchObject({ ok: false, problem });
  });

  it("is unknown to today's module parser, so a deployed Pi or board acts on none of it", () => {
    for (const line of validLines.filter(isLiftLine)) {
      expect(parseSerialLine(line)).toMatchObject({ ok: false, problem: "unknown_type" });
    }
  });

  it("refuses hand and obstacle lines on a lift port", () => {
    for (const line of moduleFixtures) {
      const type = JSON.parse(line).type as string;
      if (type === "hello.request" || type === "error") continue;
      expect(parseLiftSerialLine(line)).toMatchObject({ ok: false, problem: "unknown_type" });
    }
  });

  it("splits the types by direction", () => {
    expect(LIFT_ONLY_MESSAGE_TYPES.every((t) => t.startsWith("lift."))).toBe(true);
    for (const type of LIFT_PI_MESSAGE_TYPES) expect(LIFT_SERIAL_MESSAGE_TYPES).toContain(type);
  });

  it("names its faults as motion faults", () => {
    for (const fault of LiftSerialFaultSchema.options) expect(MotionFaultCodeSchema.options).toContain(fault);
  });

  it("always accepts a stop and nothing else; a disable skips only the seq check", () => {
    const parse = (line: string) => {
      const result = parseLiftSerialLine(line);
      if (!result.ok) throw new Error(result.detail);
      return result.message;
    };
    const cmd = (type: string, extra = "") => `{"v":1,"type":"${type}","module_id":"lift-01","seq":1,"request_id":"k3x9q2-1"${extra}}`;
    expect(isAlwaysAcceptedLiftCommand(parse(cmd("lift.stop")))).toBe(true);
    expect(isAlwaysAcceptedLiftCommand(parse(cmd("lift.enable", ',"enabled":false')))).toBe(false);
    expect(skipsLiftSeqCheck(parse(cmd("lift.stop")))).toBe(true);
    expect(skipsLiftSeqCheck(parse(cmd("lift.enable", ',"enabled":false')))).toBe(true);
    expect(skipsLiftSeqCheck(parse(cmd("lift.enable", ',"enabled":true')))).toBe(false);
    expect(skipsLiftSeqCheck(parse(cmd("lift.home")))).toBe(false);
    expect(isAlwaysAcceptedLiftCommand(parse(cmd("lift.enable", ',"enabled":true')))).toBe(false);
    expect(isAlwaysAcceptedLiftCommand(parse(cmd("lift.home")))).toBe(false);
    expect(isAlwaysAcceptedLiftCommand(parse(cmd("lift.clear")))).toBe(false);
    expect(isAlwaysAcceptedLiftCommand(parse(cmd("lift.move", ',"target_mm":10,"speed_mm_s":5')))).toBe(false);
  });

  it("carries the hold lease on every heartbeat", () => {
    const hb = (hold: string) => `{"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":1,"hold_request_id":${hold}}`;
    expect(parseLiftSerialLine(hb("null")).ok).toBe(true);
    expect(parseLiftSerialLine(hb('"k3x9q2-2"')).ok).toBe(true);
    expect(parseLiftSerialLine(hb('"lift 2"')).ok).toBe(false);
  });

  it("counts bytes, newline included, before parsing", () => {
    const filler = (n: number) => "x".repeat(n);
    expect(parseLiftSerialLine(filler(SERIAL_MAX_LINE_BYTES - 1))).toMatchObject({ problem: "malformed" });
    expect(parseLiftSerialLine(filler(SERIAL_MAX_LINE_BYTES))).toMatchObject({ problem: "oversize" });
    expect(parseLiftSerialLine("é".repeat(600))).toMatchObject({ problem: "oversize" });
  });

  it("accepts the speed ceiling and refuses just past it", () => {
    const move = (speed: number) =>
      `{"v":1,"type":"lift.move","module_id":"lift-01","seq":1,"request_id":"k3x9q2-1","target_mm":1000,"speed_mm_s":${speed}}`;
    expect(parseLiftSerialLine(move(50)).ok).toBe(true);
    expect(parseLiftSerialLine(move(50.001)).ok).toBe(false);
    expect(parseLiftSerialLine(move(0)).ok).toBe(false);
  });

  it("never throws on junk", () => {
    for (const line of ["", "\n", "null", "42", '"lift"', "{}", '{"v":1}', '{"v":1,"type":7}', "\u0000"]) {
      expect(parseLiftSerialLine(line).ok).toBe(false);
    }
  });
});
