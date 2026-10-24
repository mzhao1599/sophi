import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Bus, ButtonName } from "./bus";
import type { Cancel, Clock } from "./clock";
import { GPIO_DEBOUNCE_MS } from "./constants";
import type { Logger } from "./log";
import { signalChild } from "./process";

/**
 * Pi GPIO buttons through libgpiod's `gpiomon` (no native addon). Each button wires between a GPIO pin and
 * ground with the internal pull-up on, so pressing pulls the line low: falling = pressed, rising = released.
 * Not yet run on a Pi.
 *
 * libgpiod changed its command line between versions: Raspberry Pi OS Bookworm ships v1 (`gpiomon --bias=...
 * --format='%o %e' gpiochip0 17 27`, where %e is 1 rising / 0 falling); v2 takes `--chip` and prints the edge
 * name with %E. Both outputs parse here; pick the flavour with WALKER_GPIOMON.
 */
export type GpiomonFlavor = "v1" | "v2";

export function gpiomonCommand(flavor: GpiomonFlavor, chip: string, offsets: readonly number[]): { command: string; args: string[] } {
  const lines = offsets.map(String);
  if (flavor === "v1") {
    return { command: "gpiomon", args: ["--bias=pull-up", "--line-buffered", "--format=%o %e", chip, ...lines] };
  }
  // v2 has no --line-buffered option; stdbuf keeps each event on its own flushed line.
  return {
    command: "stdbuf",
    args: ["-oL", "gpiomon", "--chip", chip, "--bias=pull-up", "--edges=both", "--format=%o %E", ...lines],
  };
}

export type Level = "low" | "high";

/** One gpiomon output line → which line moved and its new level, or null for anything else. */
export function parseGpiomonLine(line: string): { offset: number; level: Level } | null {
  const match = /^\s*(\d+)\s+(0|1|rising|falling)\s*$/.exec(line);
  if (!match) return null;
  const edge = match[2];
  return { offset: Number(match[1]), level: edge === "1" || edge === "rising" ? "high" : "low" };
}

/**
 * Believes a level only after it has held for `ms` with no other edge, then reports it if it changed.
 * A bouncing press therefore gives one press, and a quick real tap still gives a press and a release.
 */
export class Debouncer {
  private pending: Level;
  private reported: Level;
  private cancel: Cancel | null = null;

  constructor(
    private readonly clock: Clock,
    private readonly ms: number,
    private readonly report: (level: Level) => void,
    initial: Level = "high",
  ) {
    this.pending = initial;
    this.reported = initial;
  }

  /** Forgets everything: the next level the line reports starts fresh from `initial`. */
  reset(initial: Level = "high"): void {
    this.cancel?.();
    this.cancel = null;
    this.pending = initial;
    this.reported = initial;
  }

  input(level: Level): void {
    this.pending = level;
    this.cancel?.();
    this.cancel = this.clock.setTimeout(() => {
      this.cancel = null;
      if (this.pending !== this.reported) {
        this.reported = this.pending;
        this.report(this.pending);
      }
    }, this.ms);
  }
}

export interface GpioButtonsOptions {
  flavor: GpiomonFlavor;
  chip: string;
  pins: Record<ButtonName, number>;
}

/** Runs gpiomon, debounces each line and emits Talk and Confirm edges. Restarts gpiomon if it exits. */
export class GpioButtons {
  private child: ChildProcess | null = null;
  private stopped = false;
  private readonly debouncers = new Map<number, Debouncer>();
  private cancelRestart: Cancel | null = null;

  constructor(
    private readonly options: GpioButtonsOptions,
    private readonly deps: { clock: Clock; log: Logger; bus: Bus; spawnChild?: typeof spawn },
  ) {
    for (const [button, offset] of Object.entries(options.pins) as Array<[ButtonName, number]>) {
      this.debouncers.set(
        offset,
        new Debouncer(deps.clock, GPIO_DEBOUNCE_MS, (level) =>
          deps.bus.emit("button", { button, edge: level === "low" ? "pressed" : "released", source: "gpio", detail: `GPIO${offset}` }),
        ),
      );
    }
  }

  /** Feeds one line of gpiomon output (exposed for tests). */
  handleLine(line: string): void {
    const event = parseGpiomonLine(line);
    if (event) this.debouncers.get(event.offset)?.input(event.level);
  }

  start(): void {
    if (this.stopped) return;
    const { command, args } = gpiomonCommand(this.options.flavor, this.options.chip, [...this.debouncers.keys()]);
    const child = (this.deps.spawnChild ?? spawn)(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    createInterface({ input: child.stdout! }).on("line", (line) => this.handleLine(line));
    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => {
      if (stderr.length < 300) stderr += data.toString();
    });
    // A missing gpiomon emits "error" and may never emit "close"; either one schedules one restart.
    let ended = false;
    const restart = (why: string) => {
      if (ended || this.stopped) return;
      ended = true;
      this.deps.log.error("gpiomon stopped; restarting in 5 s", { why, stderr: stderr.trim().slice(0, 200) });
      // A held button's release can't be seen now: drop that belief (and any recording it started).
      for (const debouncer of this.debouncers.values()) debouncer.reset();
      this.deps.bus.emit("buttonsLost", { source: "gpio" });
      this.cancelRestart = this.deps.clock.setTimeout(() => this.start(), 5000);
    };
    child.once("error", (error) => restart(`couldn't start: ${error.message}`));
    child.once("close", (code) => restart(`exit ${code}`));
    this.deps.log.info("watching GPIO buttons", { chip: this.options.chip, talk: this.options.pins.talk, confirm: this.options.pins.confirm });
  }

  stop(): void {
    this.stopped = true;
    this.cancelRestart?.();
    if (this.child) signalChild(this.child, "SIGTERM");
  }
}
