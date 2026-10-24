import { describe, expect, it } from "vitest";
import { Bus } from "../src/bus";
import { Debouncer, GpioButtons, gpiomonCommand, parseGpiomonLine, type Level } from "../src/buttons";
import { FakeClock, captureLogger } from "./support/fakes";

describe("gpiomon", () => {
  it("B14: parses libgpiod v1 and v2 output; falling is low (pressed), rising is high", () => {
    expect(parseGpiomonLine("17 0")).toEqual({ offset: 17, level: "low" });
    expect(parseGpiomonLine("17 1")).toEqual({ offset: 17, level: "high" });
    expect(parseGpiomonLine("27 falling")).toEqual({ offset: 27, level: "low" });
    expect(parseGpiomonLine(" 27 rising ")).toEqual({ offset: 27, level: "high" });
    for (const junk of ["", "event:  RISING EDGE offset: 17", "17 2", "x 1", "17"]) expect(parseGpiomonLine(junk)).toBeNull();
  });

  it("B14: builds each flavour's command with the pull-up on and line-buffered output", () => {
    expect(gpiomonCommand("v1", "gpiochip0", [17, 27])).toEqual({
      command: "gpiomon",
      args: ["--bias=pull-up", "--line-buffered", "--format=%o %e", "gpiochip0", "17", "27"],
    });
    expect(gpiomonCommand("v2", "gpiochip4", [17, 27])).toEqual({
      command: "stdbuf",
      args: ["-oL", "gpiomon", "--chip", "gpiochip4", "--bias=pull-up", "--edges=both", "--format=%o %E", "17", "27"],
    });
  });
});

describe("debounce", () => {
  it("B13: a bouncing press gives one press, once the line has held for 30 ms", async () => {
    const clock = new FakeClock();
    const seen: Level[] = [];
    const debouncer = new Debouncer(clock, 30, (level) => seen.push(level));
    debouncer.input("low");
    await clock.advance(5);
    debouncer.input("high");
    await clock.advance(5);
    debouncer.input("low");
    await clock.advance(29);
    expect(seen).toEqual([]);
    await clock.advance(1);
    expect(seen).toEqual(["low"]);
  });

  it("B13: a real 100 ms tap gives a press and a release", async () => {
    const clock = new FakeClock();
    const bus = new Bus();
    const buttons = new GpioButtons({ flavor: "v1", chip: "gpiochip0", pins: { talk: 17, confirm: 27 } }, { clock, log: captureLogger(), bus });
    const edges: string[] = [];
    bus.on("button", (e) => edges.push(`${e.button} ${e.edge} ${e.detail}`));
    buttons.handleLine("17 0");
    await clock.advance(100);
    buttons.handleLine("17 1");
    await clock.advance(100);
    buttons.handleLine("27 0");
    buttons.handleLine("5 0");
    await clock.advance(100);
    expect(edges).toEqual(["talk pressed GPIO17", "talk released GPIO17", "confirm pressed GPIO27"]);
  });
});
