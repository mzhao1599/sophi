import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScript } from "../src/sim/script";
import { makeMotionHarness } from "./support/motion";

/**
 * Runs every `test/sim/motion/*.walk` script (the same files `walker simulate --arms --script` runs) on a fake
 * clock, through the real coordinator, the real Feetech bus class and simulated STS3215 servos. Every motion
 * state published along the way must pass the contract's MotionStateSchema.
 */
const DIR = join(__dirname, "sim", "motion");
const scripts = readdirSync(DIR).filter((name) => name.endsWith(".walk")).sort();

describe("motion scripts (SIMULATED arms)", () => {
  it("has the eleven scripts", () => {
    expect(scripts).toHaveLength(11);
  });

  for (const name of scripts) {
    it(`M${Number(name.slice(0, 2))}: ${name.replace(/\.walk$/, "")}`, async () => {
      const h = makeMotionHarness();
      const steps = parseScript(readFileSync(join(DIR, name), "utf8"));
      await h.start();
      const report: string[] = [];
      const failure = await h.runner.run(steps, h.press, (line) => report.push(line), (ms) => h.clock.advance(ms));
      await h.stop();
      expect(failure, `${failure}\n${report.slice(-6).join("\n")}\n${h.log.lines.slice(-15).join("\n")}`).toBeNull();
      expect(h.invalid).toEqual([]);
      expect(h.states.length).toBeGreaterThan(0);
    }, 60_000);
  }
});
