import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { gpiomonCommand, parseGpiomonLine, type GpiomonFlavor, type Level } from "../buttons";
import type { Cancel, Clock } from "../clock";
import { GPIO_DEBOUNCE_MS } from "../constants";
import type { Logger } from "../log";
import { signalChild } from "../process";

/**
 * The hardware stop's stop-sense input, as the coordinator sees it: `released` (motor power on), `pressed`
 * (power cut, or the wire is cut, or the input can't be read) or `not_wired` (declared by the installer).
 */
export type StopReading = "released" | "pressed" | "not_wired";

export interface StopSense {
  reading(): StopReading;
  /** Resolves once the first reading is known (or couldn't be made, and then it reads pressed). */
  ready(): Promise<void>;
  onChange(fn: (reading: StopReading) => void): void;
  start(): void;
  stop(): void;
}

/** The installer declared no stop-sense input. Motion is refused outside bench mode. */
export class NotWiredStopSense implements StopSense {
  reading(): StopReading {
    return "not_wired";
  }
  ready(): Promise<void> {
    return Promise.resolve();
  }
  onChange(): void {}
  start(): void {}
  stop(): void {}
}

/** A stop switch moved by hand: the simulator's key and the tests. */
export class ManualStopSense implements StopSense {
  private value: "released" | "pressed";
  private readonly handlers: Array<(reading: StopReading) => void> = [];

  constructor(initial: "released" | "pressed" = "released") {
    this.value = initial;
  }

  reading(): StopReading {
    return this.value;
  }
  ready(): Promise<void> {
    return Promise.resolve();
  }
  onChange(fn: (reading: StopReading) => void): void {
    this.handlers.push(fn);
  }
  set(value: "released" | "pressed"): void {
    if (value === this.value) return;
    this.value = value;
    for (const fn of this.handlers) fn(value);
  }
  start(): void {}
  stop(): void {}
}

export function gpiogetCommand(flavor: GpiomonFlavor, chip: string, line: number): { command: string; args: string[] } {
  if (flavor === "v1") return { command: "gpioget", args: ["--bias=pull-up", chip, String(line)] };
  return { command: "gpioget", args: ["--chip", chip, "--bias=pull-up", "--numeric", String(line)] };
}

/** gpioget's output ("0"/"1", or v2's `"22"=active`) as a level, or null. */
export function parseGpioget(output: string): Level | null {
  const text = output.trim();
  if (text === "0" || /=inactive$/.test(text)) return "low";
  if (text === "1" || /=active$/.test(text)) return "high";
  return null;
}

/**
 * The stop-sense contact on a Pi GPIO line, with the internal pull-up on. The contact is normally closed to
 * ground: released reads low; pressed opens it and the pull-up reads high, and so does a cut wire. Not yet run
 * on a Pi.
 *
 * Fail-safe in every unknown: it reads `pressed` until the first level is known, whenever gpiomon isn't
 * running, and from the first edge towards high, with no debounce. Only `released` is debounced: the line must
 * stay low for GPIO_DEBOUNCE_MS. At start it reads the level once with gpioget (gpiomon only reports edges),
 * then watches with gpiomon. Known gap: an edge in the few milliseconds between the two isn't seen; the
 * hardware stop still cuts the arms' power, and the next edge corrects the reading.
 */
export class GpioStopSense implements StopSense {
  private value: "released" | "pressed" = "pressed";
  private readonly handlers: Array<(reading: StopReading) => void> = [];
  private child: ChildProcess | null = null;
  private stopped = false;
  private cancelRelease: Cancel | null = null;
  private cancelRestart: Cancel | null = null;
  private markReady: () => void = () => {};
  private readonly first = new Promise<void>((resolve) => (this.markReady = resolve));

  constructor(
    private readonly options: { flavor: GpiomonFlavor; chip: string; line: number },
    private readonly deps: { clock: Clock; log: Logger; spawnChild?: typeof spawn; execFileChild?: typeof execFile },
  ) {}

  reading(): StopReading {
    return this.value;
  }

  ready(): Promise<void> {
    return this.first;
  }

  onChange(fn: (reading: StopReading) => void): void {
    this.handlers.push(fn);
  }

  start(): void {
    if (this.stopped) return;
    const { command, args } = gpiogetCommand(this.options.flavor, this.options.chip, this.options.line);
    (this.deps.execFileChild ?? execFile)(command, args, { timeout: 2000 }, (error, stdout) => {
      if (this.stopped) return;
      const level = error ? null : parseGpioget(String(stdout));
      if (level === null) {
        this.deps.log.error("stop-sense input can't be read; it counts as pressed", { line: this.options.line, error: error?.message ?? "unreadable" });
        this.markReady();
        this.scheduleRestart();
        return;
      }
      this.level(level);
      this.watch();
    });
  }

  /** One gpiomon output line (exposed for tests). */
  handleLine(line: string): void {
    const event = parseGpiomonLine(line);
    if (event && event.offset === this.options.line) this.level(event.level);
  }

  /** A level read from the line. Pressed (high) counts at once; released (low) only after it holds. */
  level(level: Level): void {
    this.cancelRelease?.();
    this.cancelRelease = null;
    if (level === "high") {
      this.set("pressed");
      this.markReady();
      return;
    }
    this.cancelRelease = this.deps.clock.setTimeout(() => {
      this.cancelRelease = null;
      this.set("released");
      this.markReady();
    }, GPIO_DEBOUNCE_MS);
  }

  stop(): void {
    this.stopped = true;
    this.cancelRelease?.();
    this.cancelRestart?.();
    if (this.child) signalChild(this.child, "SIGTERM");
  }

  private set(value: "released" | "pressed"): void {
    if (value === this.value) return;
    this.value = value;
    for (const fn of this.handlers) fn(value);
  }

  private watch(): void {
    const { command, args } = gpiomonCommand(this.options.flavor, this.options.chip, [this.options.line]);
    const child = (this.deps.spawnChild ?? spawn)(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    createInterface({ input: child.stdout! }).on("line", (line) => this.handleLine(line));
    let ended = false;
    const end = (why: string) => {
      if (ended || this.stopped) return;
      ended = true;
      this.deps.log.error("stop-sense watcher stopped; the stop counts as pressed until it is back", { why });
      this.cancelRelease?.();
      this.cancelRelease = null;
      this.set("pressed");
      this.scheduleRestart();
    };
    child.once("error", (error) => end(`couldn't start: ${error.message}`));
    child.once("close", (code) => end(`exit ${code}`));
  }

  private scheduleRestart(): void {
    this.cancelRestart?.();
    this.cancelRestart = this.deps.clock.setTimeout(() => this.start(), 5000);
  }
}
