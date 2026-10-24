import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { withDeadline, type Clock } from "../clock";
import { signalChild } from "../process";

/**
 * `walker check`: read-only bring-up checks. Each check is a small function that takes a `CheckContext` (the
 * commands it may run, the files it may read, the options) and returns lines, so the tests run every check on
 * a Mac against fake command output. Nothing here moves anything or changes a setting.
 */
export type CheckStatus = "PASS" | "WARN" | "FAIL" | "SKIP";

export interface CheckLine {
  status: CheckStatus;
  group: string;
  item: string;
  detail: string;
}

export interface RunResult {
  /** Exit code, or null when killed (timed out) or never started. */
  code: number | null;
  stdout: Buffer;
  stderr: string;
  /** The command isn't installed (spawn ENOENT). */
  missing: boolean;
  timedOut: boolean;
  ms: number;
}

/** Runs one command with a time limit. `input` goes to its stdin. Never throws. */
export type Runner = (command: string, args: readonly string[], options?: { timeoutMs?: number; input?: string | Buffer }) => Promise<RunResult>;

export interface FileAccess {
  /** A file's text, or null when it is missing; `{ error }` when it exists but can't be read (permissions). */
  read(path: string): string | null | { error: string };
  /** A folder's entries, or null when it is missing or unreadable. */
  list(path: string): string[] | null;
  /** Permission bits, or null when missing. */
  mode(path: string): number | null;
  /** Size in bytes, or null when missing. */
  size(path: string): number | null;
}

export interface CheckOptions {
  /** `--server`: overrides the credential's server for the network checks. */
  server: string | undefined;
  stateDir: string;
  /** Whether the state folder was chosen (flag or variable) rather than defaulted. */
  stateDirGiven: boolean;
  /** `--sound`: play one short tone on the speaker. */
  sound: boolean;
  /** `--buzz`: send one short haptic to each hand. */
  buzz: boolean;
  /** `--press`: wait for a press on each hand. */
  press: boolean;
  /** `--sim`: simulated serial modules instead of real ports. */
  sim: boolean;
  /** `--port`: these serial ports instead of the ones under the serial folder. */
  ports: string[] | null;
  /** Module ids the walker should have (`--expect`). */
  expect: string[];
}

export interface CheckContext {
  run: Runner;
  files: FileAccess;
  clock: Clock;
  platform: NodeJS.Platform;
  /** `process.arch`: arm64 on a Pi 5 with the 64-bit OS. */
  arch: string;
  /** The walker's settings: /etc/steady-walker.env, then this process's environment. */
  env: Record<string, string | undefined>;
  options: CheckOptions;
  /** Prompts for the person at the walker (`--press`). */
  say(line: string): void;
  /** What earlier checks learned that later ones need. */
  facts: { serviceActive: boolean | null };
}

export const pass = (group: string, item: string, detail: string): CheckLine => ({ status: "PASS", group, item, detail });
export const warn = (group: string, item: string, detail: string): CheckLine => ({ status: "WARN", group, item, detail });
export const fail = (group: string, item: string, detail: string): CheckLine => ({ status: "FAIL", group, item, detail });
export const skip = (group: string, item: string, detail: string): CheckLine => ({ status: "SKIP", group, item, detail });

export const isLinux = (ctx: CheckContext) => ctx.platform === "linux";
export const NOT_A_PI = (ctx: CheckContext) => `not a Pi (${ctx.platform}); this runs on the walker`;

/** Placeholder: how long one ordinary command may take. */
export const COMMAND_TIMEOUT_MS = 5000;
/** Most output the check keeps from one command (a 1 s recording is 32,000 bytes). */
const MAX_OUTPUT_BYTES = 1024 * 1024;

export const text = (result: RunResult) => result.stdout.toString("utf8");

/** Why a command didn't give an answer, in words; null when it exited 0. */
export function commandProblem(command: string, result: RunResult): string | null {
  if (result.missing) return `${command} is not installed`;
  if (result.timedOut) return `${command} gave no answer within ${Math.round(result.ms / 1000)} s`;
  if (result.code !== 0) {
    const said = result.stderr.trim().split("\n").filter(Boolean).at(-1)?.slice(0, 160);
    return `${command} exited ${result.code ?? "on a signal"}${said ? `: ${said}` : ""}`;
  }
  return null;
}

/** The real runner: spawn, collect at most 1 MiB, kill (SIGKILL) at the time limit. */
export const spawnRunner: Runner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const started = performance.now();
    const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
    const child = spawn(command, [...args], { stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const finish = (code: number | null, missing: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(chunks), stderr, missing, timedOut, ms: Math.round(performance.now() - started) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalChild(child, "SIGKILL");
    }, timeoutMs);
    child.stdout?.on("data", (data: Buffer) => {
      if (bytes >= MAX_OUTPUT_BYTES) return;
      chunks.push(data.subarray(0, MAX_OUTPUT_BYTES - bytes));
      bytes += Math.min(data.length, MAX_OUTPUT_BYTES - bytes);
    });
    child.stderr?.on("data", (data: Buffer) => {
      if (stderr.length < 2000) stderr += data.toString();
    });
    // A command that can't start emits "error" and may never emit "close".
    child.once("error", (error) => finish(null, (error as NodeJS.ErrnoException).code === "ENOENT"));
    child.once("close", (code) => finish(timedOut ? null : code, false));
    if (options.input !== undefined && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(options.input);
    }
  });

export const realFiles: FileAccess = {
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      return { error: code ?? "unreadable" };
    }
  },
  list(path) {
    try {
      return readdirSync(path).sort();
    } catch {
      return null;
    }
  },
  mode(path) {
    try {
      return statSync(path).mode & 0o777;
    } catch {
      return null;
    }
  },
  size(path) {
    try {
      return statSync(path).size;
    } catch {
      return null;
    }
  },
};

/** systemd's EnvironmentFile, simply: KEY=VALUE lines, # comments, optional surrounding quotes. */
export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) value = value.slice(1, -1);
    values[match[1]!] = value;
  }
  return values;
}

export interface Check {
  name: string;
  /** The whole check's time limit; past it, one FAIL line and the run carries on. */
  timeoutMs: number;
  run(ctx: CheckContext): Promise<CheckLine[]>;
}

/** Runs each check in order, printing its lines as they come, and returns every line. */
export async function runChecks(ctx: CheckContext, checks: readonly Check[], print: (line: CheckLine) => void): Promise<CheckLine[]> {
  const all: CheckLine[] = [];
  for (const check of checks) {
    let lines: CheckLine[];
    try {
      lines = await withDeadline(ctx.clock, check.timeoutMs, () => check.run(ctx));
    } catch (error) {
      const message = error instanceof Error && error.name === "DeadlineError"
        ? `no answer within ${Math.round(check.timeoutMs / 1000)} s`
        : `the check itself failed: ${error instanceof Error ? error.message : String(error)}`;
      lines = [fail(check.name, "check", message)];
    }
    for (const line of lines) {
      all.push(line);
      print(line);
    }
  }
  return all;
}

export function formatLine(line: CheckLine): string {
  return `${line.status.padEnd(4)}  ${line.group.padEnd(8)} ${line.item.padEnd(20)} ${line.detail}`;
}

export function summarize(lines: readonly CheckLine[], seconds: number): { text: string; exitCode: number } {
  const count = (status: CheckStatus) => lines.filter((line) => line.status === status).length;
  const failed = lines.filter((line) => line.status === "FAIL").map((line) => `${line.group} ${line.item}`);
  const warned = lines.filter((line) => line.status === "WARN").map((line) => `${line.group} ${line.item}`);
  const parts = [
    `Summary: ${count("PASS")} pass, ${count("WARN")} warn, ${count("FAIL")} fail, ${count("SKIP")} skip, in ${seconds.toFixed(1)} s.`,
    failed.length ? `Failed: ${failed.join(", ")}.` : "Nothing failed.",
    ...(warned.length ? [`Warnings: ${warned.join(", ")}.`] : []),
  ];
  return { text: parts.join("\n"), exitCode: failed.length ? 1 : 0 };
}
