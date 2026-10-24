import type { Bus, BusEvents } from "../bus";

/**
 * A tiny script language for driving the simulator end to end, one step per line:
 *
 *   key t                      press a simulator key (same keys as the interactive keyboard)
 *   expect spoke Sophi is on. wait (up to 20 s) for an event, here a spoken line containing that text
 *   expect 60000 link offline  the same, waiting up to 60,000 ms (for steps outside the script's control)
 *   absent 1500 haptic         fail if a matching event happens within 1,500 ms
 *   wait 1000                  let 1,000 ms pass (for example, holding Talk while "speaking")
 *   # comment
 *
 * `expect` and `absent` look only at events since the last `key` step, so an old event can't satisfy them.
 * Event names and what their text is matched against: spoke (the line), link, talk and mic (the state), cue (the
 * cue name), haptic (the pattern), config (the version), turn (the outcome), heartbeat (ok or failed),
 * module (`<instance> <health>`), screen (the walker screen's state name, with `--screen`), lift (`<kind> <text>`,
 * with `--lift`: the simulated lift board's state, its injected faults and the hold control; the coordinator's
 * lift requests are `motion lift ...`), motion (`<kind> <text>`, what
 * the motion coordinator did) and sim (what the simulated servos saw, with `--arms`).
 */
export type ScriptStep =
  | { kind: "key"; key: string; line: number }
  | { kind: "expect"; event: keyof BusEvents; match: string; timeoutMs: number; line: number }
  | { kind: "absent"; event: keyof BusEvents; match: string; forMs: number; line: number }
  | { kind: "wait"; forMs: number; line: number };

const EVENTS = new Set<keyof BusEvents>(["spoke", "link", "talk", "mic", "cue", "haptic", "config", "turn", "heartbeat", "module", "screen", "lift", "motion", "sim"]);
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
    if (word === "absent") {
      const [ms, event, ...match] = rest;
      const forMs = Number(ms);
      if (!Number.isInteger(forMs) || forMs <= 0) throw new Error(`Line ${line}: absent needs a duration in ms.`);
      if (!event || !EVENTS.has(event as keyof BusEvents)) throw new Error(`Line ${line}: unknown event "${event ?? ""}".`);
      steps.push({ kind: "absent", event: event as keyof BusEvents, match: match.join(" "), forMs, line });
      return;
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
    default:
      return "";
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
  ): Promise<string | null> {
    for (const step of steps) {
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
