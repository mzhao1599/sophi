import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LIFT_PI_MESSAGE_TYPES, parseLiftSerialLine } from "../src";

/**
 * The lift bench tool (firmware/tools/lift_bench.py) speaks to the lift from a computer before the Pi side
 * exists. Every line it would send must pass the contract's own parser: `--print-lines` prints them without a
 * serial port. Needs python3 on the PATH (it uses only the standard library).
 */

const tool = fileURLToPath(new URL("../../../firmware/tools/lift_bench.py", import.meta.url));
const commands = [["status"], ["home"], ["move", "20", "--speed", "5"], ["stop"], ["clear"], ["enable", "on"], ["enable", "off"]];

describe("the lift bench tool's lines", () => {
  it.each(commands)("%s: every line passes parseLiftSerialLine", (...command) => {
    for (let run = 0; run < 5; run += 1) {
      const out = execFileSync("python3", [tool, "--print-lines", ...command], { encoding: "utf8" });
      const lines = out.split("\n").filter(Boolean);
      expect(lines.length).toBeGreaterThanOrEqual(3);
      lines.forEach((line, index) => {
        const result = parseLiftSerialLine(line);
        expect(result, line).toMatchObject({ ok: true });
        if (!result.ok) return;
        expect(LIFT_PI_MESSAGE_TYPES as readonly string[]).toContain(result.message.type);
        expect(result.message.seq).toBe(index);
      });
    }
  });
});
