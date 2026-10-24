import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HAPTIC_MAX_DURATION_MS, SERIAL_MAX_LINE_BYTES, parseSerialLine } from "../src";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const validLines = read("./fixtures/serial-v1.valid.jsonl").split("\n").filter(Boolean);
const invalidCases: { expect: string; why: string; line: string }[] = JSON.parse(
  read("./fixtures/serial-v1.invalid.json"),
);

describe("serial envelope v1", () => {
  it("keeps every example line from docs/interfaces.md in the fixtures", () => {
    // Lift lines (`"type":"lift.…"`) have their own fixtures and parser: lift-serial.test.ts.
    const docLines = read("../../../docs/interfaces.md")
      .split("\n")
      .filter((l) => l.startsWith('{"v":1,') && !l.startsWith('{"v":1,"type":"lift.'));
    expect(docLines.length).toBeGreaterThanOrEqual(5);
    for (const line of docLines) expect(validLines).toContain(line);
  });

  it.each(validLines)("parses %s", (line) => {
    const result = parseSerialLine(`${line}\n`);
    expect(result).toMatchObject({ ok: true, message: JSON.parse(line) });
  });

  it.each(invalidCases)("rejects: $why", ({ expect: problem, line }) => {
    expect(parseSerialLine(line)).toMatchObject({ ok: false, problem });
  });

  it("matches the fixture's haptic limit", () => {
    expect(HAPTIC_MAX_DURATION_MS).toBe(1000);
  });

  it("counts bytes, newline included, before parsing", () => {
    const filler = (n: number) => "x".repeat(n);
    expect(parseSerialLine(filler(SERIAL_MAX_LINE_BYTES - 1))).toMatchObject({ problem: "malformed" });
    expect(parseSerialLine(filler(SERIAL_MAX_LINE_BYTES))).toMatchObject({ problem: "oversize" });
    // 600 characters, 1200 bytes.
    expect(parseSerialLine("é".repeat(600))).toMatchObject({ problem: "oversize" });
    const longError = `{"v":1,"type":"error","module_id":"hand-left-01","seq":1,"code":"overflow","detail":"${filler(1100)}"}`;
    expect(parseSerialLine(longError)).toMatchObject({ ok: false, problem: "oversize" });
  });

  it("never throws on junk", () => {
    for (const line of ["", "\n", "null", "42", '"hello"', "{}", '{"v":1}', '{"v":1,"type":7}', "\u0000"]) {
      expect(parseSerialLine(line).ok).toBe(false);
    }
  });
});
