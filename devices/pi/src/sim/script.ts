import { WalkerToolCallSchema, type WalkerToolCall, type WalkerToolName } from "@walker/contracts";
import type { Bus, BusEvents } from "../bus";

/** What the FAKE cloud says before the walker runs a scripted tool (the real server's "I'll check" lines differ). */
const FAKE_TOOL_LINES: Record<WalkerToolName, string> = {
  get_location: "Fake cloud: let me check where you are.",
  get_distance: "Fake cloud: let me check the sensor.",
  get_weather: "Fake cloud: let me check the weather.",
  start_route: "Fake cloud: let me find that.",
  stop_route: "Fake cloud: stopping the directions.",
  show_on_screen: "Fake cloud: putting that on your screen.",
};

/**
 * A tiny script language for driving the simulator end to end, one step per line:
 *
 *   key t                      press a simulator key (same keys as the interactive keyboard)
 *   expect spoke Sophi is on. wait (up to 20 s) for an event, here a spoken line containing that text
 *   expect 60000 link offline  the same, waiting up to 60,000 ms (for steps outside the script's control)
 *   absent 1500 haptic         fail if a matching event happens within 1,500 ms
 *   wait 1000                  let 1,000 ms pass (for example, holding Talk while "speaking")
 *   gps off_route 50           move the SIMULATED position: `gps at <lat> <lon>`, `gps walk <metres>`,
 *                              `gps off_route <metres>`, `gps pause`, `gps resume` (counts as an action, like `key`)
 *   fake tool start_route Lake Merritt Boating Center
 *                              queue the FAKE cloud's next answer: `fake reply <text>`, or `fake tool <name>
 *                              [destination]` (it asks the walker for that tool, then says "Fake cloud: " and the
 *                              walker's result). A script with any `fake` step starts with no other fake answers.
 *   chord 2500                 hold Talk and Confirm on the simulated hand board together for 2,500 ms, then let go
 *                              (asking for help: HELP_HOLD_MS is 2,000; `chord 1900` lets go early)
 *   # comment
 *
 * `expect` and `absent` look only at events since the last `key` step, so an old event can't satisfy them.
 * Event names and what their text is matched against: spoke (the line), link, talk and mic (the state), cue (the
 * cue name), haptic (the pattern), config (the version), turn (the outcome), heartbeat (ok or failed),
 * module (`<instance> <health>`), screen (the walker screen's state name, with `--screen`), lift (`<kind> <text>`,
 * with `--lift`: the simulated lift board's state, its injected faults and the hold control; the coordinator's
 * lift requests are `motion lift ...`), help (what the help layer shows: `none`, `help_hold`, `help_countdown 8`,
 * `help sending`, `help sending retrying`, `help not_sent offline`, `help open`, `help open shown coming`,
 * `help open confirm_okay`, `help closed okay`), motion (`<kind> <text>`, what
 * the motion coordinator did), sim (what the simulated servos saw, with `--arms`) and navigation (the route's
 * phase and next maneuver, `guiding left`, or `none` once no route is on; never its coordinates or names).
 */
export type ScriptStep =
  | { kind: "key"; key: string; line: number }
  | { kind: "expect"; event: keyof BusEvents; match: string; timeoutMs: number; line: number }
  | { kind: "absent"; event: keyof BusEvents; match: string; forMs: number; line: number }
  | { kind: "wait"; forMs: number; line: number }
  | { kind: "gps"; action: "at" | "walk" | "off_route" | "pause" | "resume"; numbers: number[]; line: number }
  | { kind: "fake"; reply: string; tool: WalkerToolCall | null; line: number }
  | { kind: "chord"; holdMs: number; line: number };

export type CommandStep = Extract<ScriptStep, { kind: "gps" | "fake" }>;

const EVENTS = new Set<keyof BusEvents>(["spoke", "link", "talk", "mic", "cue", "haptic", "config", "turn", "heartbeat", "module", "screen", "lift", "motion", "sim", "navigation", "help"]);
const GPS_ARGS = { at: 2, walk: 1, off_route: 1, pause: 0, resume: 0 } as const;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_TIMEOUT_MS = 600_000;

export function parseScript(text: string): ScriptStep[] {
  const steps: ScriptStep[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith("#")) return;
    const [word, ...rest] = trimmed.split(/\s+/);
    if (word === "key" && rest.length === 1 && rest[0]) {
      steps.push({ kind: "key", key: rest[0], line });
      return;
    }
    if (word === "expect") {
      const timed = /^\d+$/.test(rest[0] ?? "");
      const timeoutMs = timed ? Number(rest[0]) : DEFAULT_TIMEOUT_MS;
      if (timed && !(timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)) {
        throw new Error(`Line ${line}: an expect timeout is 1 to ${MAX_TIMEOUT_MS} ms.`);
      }
      const [event, ...match] = timed ? rest.slice(1) : rest;
      if (!event || !EVENTS.has(event as keyof BusEvents)) throw new Error(`Line ${line}: unknown event "${event ?? ""}".`);
      steps.push({ kind: "expect", event: event as keyof BusEvents, match: match.join(" "), timeoutMs, line });
      return;
    }
    if (word === "wait") {
      const forMs = Number(rest[0]);
      if (rest.length !== 1 || !Number.isInteger(forMs) || forMs <= 0) throw new Error(`Line ${line}: wait needs a duration in ms.`);
      steps.push({ kind: "wait", forMs, line });
      return;
    }
    if (word === "chord") {
      const holdMs = Number(rest[0]);
      if (rest.length !== 1 || !Number.isInteger(holdMs) || holdMs <= 0 || holdMs > 60_000) throw new Error(`Line ${line}: chord needs a hold in ms (1 to 60000).`);
      steps.push({ kind: "chord", holdMs, line });
      return;
    }
    if (word === "absent") {
      const [ms, event, ...match] = rest;
      const forMs = Number(ms);
      if (!Number.isInteger(forMs) || forMs <= 0) throw new Error(`Line ${line}: absent needs a duration in ms.`);
      if (!event || !EVENTS.has(event as keyof BusEvents)) throw new Error(`Line ${line}: unknown event "${event ?? ""}".`);
      steps.push({ kind: "absent", event: event as keyof BusEvents, match: match.join(" "), forMs, line });
      return;
    }
    if (word === "gps") {
      const [action, ...args] = rest;
      const numbers = args.map(Number);
      if (!action || !(action in GPS_ARGS) || numbers.length !== GPS_ARGS[action as keyof typeof GPS_ARGS] || numbers.some((n) => !Number.isFinite(n))) {
        throw new Error(`Line ${line}: gps takes at <lat> <lon>, walk <metres>, off_route <metres>, pause or resume.`);
      }
      steps.push({ kind: "gps", action: action as keyof typeof GPS_ARGS, numbers, line });
      return;
    }
    if (word === "fake") {
      const [what, ...words] = rest;
      if (what === "reply" && words.length) {
        steps.push({ kind: "fake", reply: words.join(" "), tool: null, line });
        return;
      }
      if (what === "tool" && words[0]) {
        const parsed = WalkerToolCallSchema.safeParse(words[0] === "start_route" ? { name: words[0], destination: words.slice(1).join(" ") } : { name: words[0] });
        if (!parsed.success || (words[0] !== "start_route" && words.length > 1)) throw new Error(`Line ${line}: fake tool needs a tool name (start_route takes a destination).`);
        steps.push({ kind: "fake", reply: FAKE_TOOL_LINES[parsed.data.name], tool: parsed.data, line });
        return;
      }
      throw new Error(`Line ${line}: fake takes reply <text> or tool <name> [destination].`);
    }
    throw new Error(`Line ${line}: can't read "${trimmed}".`);
  });
  return steps;
}

export function eventText<K extends keyof BusEvents>(name: K, payload: BusEvents[K]): string {
  const p = payload as Record<string, unknown>;
  switch (name) {
    case "spoke":
      return String(p.text);
    case "link":
    case "talk":
    case "mic":
      return String(p.state);
    case "cue":
      return String(p.name);
    case "haptic":
      return String(p.pattern);
    case "config":
      return String(p.version);
    case "turn":
      return String(p.outcome);
    case "heartbeat":
      return p.ok ? "ok" : "failed";
    case "module":
      return `${String(p.instanceId)} ${String(p.health)}`;
    case "screen":
      return String(p.state);
    case "lift":
      return `${String(p.kind)} ${String(p.text)}`;
    case "motion":
      return `${String(p.kind)} ${String(p.text)}`;
    case "sim":
      return String(p.text);
    case "navigation": {
      const view = (payload as BusEvents["navigation"]).view;
      return view ? `${view.phase} ${view.maneuver}` : "none";
    }
    case "help":
      return helpText((payload as BusEvents["help"]).screen);
    default:
      return "";
  }
}

/** The help layer in a few words for scripts and logs: the state and phase, never a name. */
export function helpText(screen: BusEvents["help"]["screen"]): string {
  if (!screen) return "none";
  if (screen.state === "help_hold") return "help_hold";
  if (screen.state === "help_countdown") return `help_countdown ${screen.seconds_left}`;
  const h = screen.help;
  switch (h.phase) {
    case "sending":
      return h.retrying ? "help sending retrying" : "help sending";
    case "not_sent":
      return `help not_sent ${h.why}`;
    case "open":
      return ["help open", h.shown_to.length > 0 ? "shown" : "", h.coming.length > 0 ? "coming" : "", h.confirm_okay ? "confirm_okay" : ""].filter(Boolean).join(" ");
    case "closed":
      return `help closed ${h.how}`;
  }
}

interface Seen {
  event: keyof BusEvents;
  text: string;
}

/**
 * Records the service's events from the moment it is created (before the service starts, so the boot line
 * counts), then runs a script against them with real time. `run` returns null when every step passed.
 */
export class ScriptRunner {
  private readonly seen: Seen[] = [];
  private readonly waiters = new Set<() => void>();
  private cursor = 0;

  constructor(bus: Bus) {
    for (const event of EVENTS) {
      bus.on(event, (payload) => {
        this.seen.push({ event, text: eventText(event, payload as never) });
        for (const wake of [...this.waiters]) wake();
      });
    }
  }

  private find(event: keyof BusEvents, match: string): boolean {
    return this.seen.slice(this.cursor).some((item) => item.event === event && item.text.includes(match));
  }

  /**
   * Runs the steps. With `advance` (a fake clock's), time moves only by it, in 10 ms steps while an `expect`
   * waits, so a test runs a script deterministically; without it, real time passes.
   */
  async run(
    steps: readonly ScriptStep[],
    press: (key: string) => void,
    report: (message: string) => void,
    advance?: (ms: number) => Promise<void>,
    command?: (step: CommandStep) => void,
  ): Promise<string | null> {
    for (const step of steps) {
      if (step.kind === "gps" || step.kind === "fake") {
        if (!command) return `step ${step.line}: ${step.kind} needs the simulator`;
        // Moving the position is an action, like a key: later expects look only at what follows it.
        if (step.kind === "gps") this.cursor = this.seen.length;
        report(`step ${step.line}: ${step.kind} ${step.kind === "gps" ? `${step.action} ${step.numbers.join(" ")}` : step.tool?.name ?? "reply"}`.trimEnd());
        try {
          command(step);
        } catch (error) {
          return `step ${step.line}: ${(error as Error).message}`;
        }
        continue;
      }
      if (advance && step.kind === "expect") {
        let waited = 0;
        while (!this.find(step.event, step.match) && waited < step.timeoutMs) {
          await advance(10);
          waited += 10;
        }
        if (!this.find(step.event, step.match)) return `step ${step.line}: no "${step.event}" event matching "${step.match}" within ${step.timeoutMs} ms`;
        report(`step ${step.line}: saw ${step.event} ${step.match}`.trimEnd());
        continue;
      }
      if (advance && (step.kind === "wait" || step.kind === "absent")) {
        await advance(step.forMs);
        if (step.kind === "absent" && this.find(step.event, step.match)) {
          return `step ${step.line}: "${step.event}" matching "${step.match}" happened but shouldn't have`;
        }
        continue;
      }
      if (step.kind === "key") {
        this.cursor = this.seen.length;
        report(`step ${step.line}: key ${step.key}`);
        press(step.key);
        continue;
      }
      if (step.kind === "chord") {
        // Both buttons down, held, then both up; what follows looks at events from the moment they went down.
        this.cursor = this.seen.length;
        report(`step ${step.line}: chord held ${step.holdMs} ms`);
        press("chord-down");
        if (advance) await advance(step.holdMs);
        else await new Promise((resolve) => setTimeout(resolve, step.holdMs));
        press("chord-up");
        continue;
      }
      if (step.kind === "expect") {
        const ok = await new Promise<boolean>((resolve) => {
          if (this.find(step.event, step.match)) return resolve(true);
          const timer = setTimeout(() => {
            this.waiters.delete(check);
            resolve(false);
          }, step.timeoutMs);
          const check = () => {
            if (!this.find(step.event, step.match)) return;
            clearTimeout(timer);
            this.waiters.delete(check);
            resolve(true);
          };
          this.waiters.add(check);
        });
        if (!ok) return `step ${step.line}: no "${step.event}" event matching "${step.match}" within ${step.timeoutMs} ms`;
        report(`step ${step.line}: saw ${step.event} ${step.match}`.trimEnd());
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, step.forMs));
      if (step.kind === "wait") continue;
      if (this.find(step.event, step.match)) {
        return `step ${step.line}: "${step.event}" matching "${step.match}" happened but shouldn't have`;
      }
      report(`step ${step.line}: no ${step.event} ${step.match} for ${step.forMs} ms`.replace(/\s+/g, " "));
    }
    return null;
  }
}
