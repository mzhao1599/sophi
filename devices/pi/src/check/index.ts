import { hostname } from "node:os";
import { systemClock, type Clock } from "../clock";
import { DEFAULT_STATE_DIR, readPiConfig } from "../run";
import { SERVICE_VERSION } from "../version";
import {
  fail,
  formatLine,
  parseEnvFile,
  pass,
  realFiles,
  runChecks,
  skip,
  spawnRunner,
  summarize,
  warn,
  type Check,
  type CheckContext,
  type CheckLine,
  type CheckOptions,
  type FileAccess,
  type Runner,
} from "./core";
import { audioCheck, gpioCheck, screenCheck, voiceCheck } from "./devices";
import { realSerial, serialCheck, simulatedSerial, type SerialSource } from "./modules";
import { networkCheck, pairingCheck, realNetwork, systemCheck, type NetworkDeps } from "./system";

export const ENV_FILE = "/etc/steady-walker.env";

/** The settings line: where they came from, and whether the service would accept them. */
export function settingsLine(ctx: CheckContext, envFile: string, loaded: boolean | { error: string }): CheckLine {
  const source = loaded === true ? envFile : typeof loaded === "object" ? `this shell only (${envFile}: ${loaded.error}; run with sudo)` : `this shell only (no ${envFile})`;
  if (ctx.platform !== "linux" && loaded !== true) return skip("settings", "walker settings", `${source}; the walker's settings live on the Pi`);
  try {
    const config = readPiConfig(ctx.env as NodeJS.ProcessEnv);
    return pass(
      "settings",
      "walker settings",
      `from ${source}: mic ${config.captureDevice}, speaker ${config.playbackDevice}, voice ${config.piperModel ? "piper" : "espeak-ng"}, GPIO buttons ${config.gpioWired ? `wired on ${config.gpioChip}` : "not declared"}`,
    );
  } catch (error) {
    return (loaded === true ? fail : warn)("settings", "walker settings", `from ${source}: ${(error as Error).message}`);
  }
}

export interface CheckDeps {
  run: Runner;
  files: FileAccess;
  clock: Clock;
  platform: NodeJS.Platform;
  arch: string;
  env: Record<string, string | undefined>;
  net: NetworkDeps;
  serial: SerialSource;
  write(line: string): void;
}

/** Every check, in the order they print. */
export function allChecks(net: NetworkDeps, serial: SerialSource): Check[] {
  return [systemCheck, networkCheck(net), pairingCheck(net), audioCheck, voiceCheck, serialCheck(serial), screenCheck, gpioCheck];
}

/** `walker check`: prints one line per item and a summary; resolves to the exit code (1 if anything failed). */
export async function walkerCheck(options: Omit<CheckOptions, "stateDir" | "stateDirGiven"> & { state?: string; envFile?: string }, deps: CheckDeps): Promise<number> {
  const envFile = options.envFile ?? ENV_FILE;
  const raw = deps.files.read(envFile);
  const loaded = typeof raw === "string" ? true : raw === null ? false : raw;
  // The service reads the file through systemd; anything set in this shell wins, as a way to try a change.
  const env = { ...(typeof raw === "string" ? parseEnvFile(raw) : {}), ...deps.env };
  const stateDir = options.state ?? env.WALKER_STATE_DIR ?? DEFAULT_STATE_DIR;
  const ctx: CheckContext = {
    run: deps.run,
    files: deps.files,
    clock: deps.clock,
    platform: deps.platform,
    arch: deps.arch,
    env,
    options: { ...options, stateDir, stateDirGiven: options.state !== undefined || env.WALKER_STATE_DIR !== undefined },
    say: (line) => deps.write(`      ${line}`),
    facts: { serviceActive: null },
  };
  const started = deps.clock.monotonic();
  deps.write(`walker check (${SERVICE_VERSION}) on ${hostname()}, ${new Date(deps.clock.now()).toISOString()}. Read-only${options.sound ? "; --sound plays one tone" : ""}${options.buzz ? "; --buzz sends one short buzz per hand" : ""}.`);
  const print = (line: CheckLine) => deps.write(formatLine(line));
  const first = settingsLine(ctx, envFile, loaded);
  print(first);
  const lines = [first, ...(await runChecks(ctx, allChecks(deps.net, deps.serial), print))];
  const summary = summarize(lines, (deps.clock.monotonic() - started) / 1000);
  deps.write(summary.text);
  return summary.exitCode;
}

/** The real dependencies, for the CLI. */
export function realCheckDeps(sim: boolean): CheckDeps {
  return {
    run: spawnRunner,
    files: realFiles,
    clock: systemClock,
    platform: process.platform,
    arch: process.arch,
    env: process.env,
    net: realNetwork,
    serial: sim ? simulatedSerial(systemClock) : realSerial,
    write: (line) => process.stdout.write(`${line}\n`),
  };
}
