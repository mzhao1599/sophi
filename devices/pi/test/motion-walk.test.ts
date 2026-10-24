import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseScript } from "../src/sim/script";
import { makeMotionHarness } from "./support/motion";

/**
 * Runs every `test/sim/motion/*.walk` script (rows M1 to M10, M31), every `test/sim/skills/*.walk` script
 * (rows T1 to T7) and every `test/sim/lift/*.walk` script (rows E9 and E10, with the SIMULATED lift), the same
 * files `walker simulate --arms [--lift] --script` runs, on a fake clock, through the real
 * coordinator, the real Feetech bus class and simulated STS3215 servos. Every motion state published along the
 * way must pass the contract's MotionStateSchema.
 */
const SUITES = [
  { dir: join(__dirname, "sim", "motion"), row: "M", count: 11, lift: false },
  { dir: join(__dirname, "sim", "skills"), row: "T", count: 7, lift: false },
  // The lift under the coordinator (rows E9 and E10), with the SIMULATED lift board: `--arms --lift`.
  { dir: join(__dirname, "sim", "lift"), row: "E", count: 2, lift: true },
];

for (const suite of SUITES) {
  const scripts = readdirSync(suite.dir)
    .filter((name) => name.endsWith(".walk"))
    .sort();

  describe(`${suite.row} scripts (SIMULATED arms)`, () => {
    it(`has the ${suite.count} scripts`, () => {
      expect(scripts).toHaveLength(suite.count);
    });

    for (const name of scripts) {
      it(`${suite.row}${suite.lift ? Number(name.slice(0, 2)) + 8 : Number(name.slice(0, 2))}: ${name.replace(/\.walk$/, "")}`, async () => {
        const h = makeMotionHarness({ lift: suite.lift });
        const steps = parseScript(readFileSync(join(suite.dir, name), "utf8"));
        await h.start();
        const report: string[] = [];
        const failure = await h.runner.run(steps, h.press, (line) => report.push(line), (ms) => h.clock.advance(ms));
        await h.stop();
        expect(failure, `${failure}\n${report.slice(-6).join("\n")}\n${h.log.lines.slice(-25).join("\n")}`).toBeNull();
        expect(h.invalid).toEqual([]);
        expect(h.states.length).toBeGreaterThan(0);
      }, 60_000);
    }
  });
}
