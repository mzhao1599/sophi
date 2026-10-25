import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NavigatingScreenSchema } from "@walker/contracts";
import { SimulatedPosition } from "../src/navigation/simulated";
import { recordedMapServices } from "../src/sim/fakeMaps";
import { ScriptRunner, parseScript } from "../src/sim/script";
import { scriptCommand } from "../src/sim/simulate";
import { boot, makeHarness } from "./support/fakes";

/**
 * N27 on a fake clock: `test/sim/navigation.walk`, the same file `walker simulate --script` runs in real time,
 * through the real service with the SIMULATED position, the recorded map services and the fake cloud. A pass
 * here doesn't prove real time (the lessons): the script is also run in real time, three runs in a row.
 */
describe("N27: the navigation walk (fake clock)", () => {
  it("passes every step in order", async () => {
    const h = makeHarness({ location: (clock, log) => new SimulatedPosition(clock, log, { speedup: 3 }), maps: (clock) => recordedMapServices(clock) });
    const runner = new ScriptRunner(h.bus);
    const views: unknown[] = [];
    h.bus.on("navigation", ({ view }) => view && views.push(view));
    await boot(h);
    const steps = parseScript(readFileSync(join(__dirname, "sim", "navigation.walk"), "utf8"));
    const report: string[] = [];
    const press = (key: string) => {
      if (key === "t") h.bus.emit("button", { button: "talk", edge: "pressed", source: "keyboard" });
      else if (key === "c") h.bus.emit("button", { button: "confirm", edge: "pressed", source: "keyboard" });
    };
    const failure = await runner.run(steps, press, (line) => report.push(line), (ms) => h.clock.advance(ms), scriptCommand(h.fake, h.location as SimulatedPosition));
    h.service.stop();
    expect(failure, `${failure}\n${report.slice(-6).join("\n")}\n${h.log.lines.slice(-20).join("\n")}`).toBeNull();
    expect(views.length).toBeGreaterThan(100);
    for (const view of views) expect(NavigatingScreenSchema.safeParse(view).success).toBe(true);
  }, 120_000);
});
