import { join } from "node:path";
import { DeadlineError, systemClock, withDeadline } from "./clock";
import { CloudError, pairWithServer } from "./cloud/client";
import { createLogger } from "./log";
import { DEFAULT_STATE_DIR, runOnPi } from "./run";
import { simulate } from "./sim/simulate";
import { StateStore } from "./store";
import { SERVICE_VERSION } from "./version";

const USAGE = `walker: Steady's always-on walker service

  walker pair <6-digit code> --server <https://...> [--name <walker name>] [--state <dir>]
      Pairs this walker with the walker page's code and saves the device credential (mode 0600).
  walker run
      Runs the service on the Pi (GPIO buttons, serial modules, ALSA mic and speaker). Settings come from
      environment variables; see devices/pi/README.md.
  walker simulate [--script <file>] [--mic-file <16 kHz mono WAV>] [--mic mac] [--loud]
                  [--server <url>] [--state <dir>] [--out <dir>]
      Runs the whole walker on this computer with simulated parts and, unless --server is given, a FAKE
      cloud on 127.0.0.1. Silent by default: speech is written to audio files. --loud plays it.

State folder: --state, else WALKER_STATE_DIR, else ${DEFAULT_STATE_DIR} (run and pair) or a new temp folder (simulate).`;

function parseFlags(args: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const next = args[i + 1];
    if (name === "loud") flags.set(name, true);
    else if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i += 1;
    } else throw new Error(`--${name} needs a value.`);
  }
  return { positional, flags };
}

const text = (value: string | true | undefined) => (typeof value === "string" ? value : undefined);

/** A pairing failure in words a person can act on. Never includes the credential (there isn't one yet). */
function pairingProblem(error: unknown): string {
  if (error instanceof DeadlineError) return "The server didn't answer within 90 seconds. Check the URL and try again.";
  if (!(error instanceof CloudError)) return error instanceof Error ? error.message : String(error);
  switch (error.code) {
    case "pairing_code_invalid":
      return "That code isn't valid or has expired. Get a new code on the walker page.";
    case "pairing_locked":
      return "Too many wrong codes from this network. Wait 10 minutes, then try a new code.";
    case "walker_limit":
      return "This owner already has the most walkers allowed. Forget one on the walker page first.";
    default:
      return error.message;
  }
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { positional, flags } = parseFlags(rest);
  switch (command) {
    case "pair": {
      const code = positional[0] ?? "";
      const server = text(flags.get("server"));
      if (!/^\d{6}$/.test(code) || !server) {
        process.stderr.write("Usage: walker pair <6-digit code> --server <https://...>\n");
        return 2;
      }
      const stateDir = text(flags.get("state")) ?? process.env.WALKER_STATE_DIR ?? DEFAULT_STATE_DIR;
      const name = text(flags.get("name"));
      const store = new StateStore(stateDir, createLogger());
      // A free Render service can take about a minute to wake, so pairing waits up to 90 s.
      let paired;
      try {
        paired = await withDeadline(systemClock, 90_000, (signal) =>
          pairWithServer(server, { code, service_version: SERVICE_VERSION, ...(name ? { name } : {}) }, signal),
        );
      } catch (error) {
        throw new Error(pairingProblem(error));
      }
      // The new device's configuration 1 replaces any configuration from an earlier pairing.
      store.writeConfiguration(paired.configuration);
      store.writeCredential({ server_url: server, device_id: paired.device_id, credential: paired.credential });
      process.stdout.write(
        `Paired as device ${paired.device_id}. The credential is saved in ${join(stateDir, "credential.json")} (readable only by this user).\n`,
      );
      return 0;
    }
    case "run":
      return runOnPi(process.env);
    case "simulate": {
      const mic = text(flags.get("mic"));
      if (mic !== undefined && mic !== "mac") throw new Error("--mic only takes mac.");
      return simulate({
        server: text(flags.get("server")),
        micFile: text(flags.get("mic-file")),
        mic,
        loud: flags.get("loud") === true,
        state: text(flags.get("state")),
        out: text(flags.get("out")),
        script: text(flags.get("script")),
      });
    }
    case undefined:
    case "help":
    case "--help":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}\n`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    process.stderr.write(`walker: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  },
);
