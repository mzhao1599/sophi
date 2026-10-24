import { join } from "node:path";
import { systemClock } from "./clock";
import { createLogger } from "./log";
import { DEFAULT_STATE_DIR, runOnPi } from "./run";
import { simulate } from "./sim/simulate";
import { pairWalker } from "./pair";
import { StateStore } from "./store";
import { realCheckDeps, walkerCheck } from "./check";
import { readGps } from "./gps";
import { ARMS_USAGE, armsCommand, motionCommand } from "./motion/cli";

const USAGE = `walker: Sophi's always-on walker service

  walker pair <6-digit code> --server <https://...> [--name <walker name>] [--state <dir>]
      Pairs this walker with the walker page's code and saves the device credential (mode 0600).
  walker run
      Runs the service on the Pi (GPIO buttons, serial modules, ALSA mic and speaker). Settings come from
      environment variables; see devices/pi/README.md.
  walker gps [--port </dev/serial/by-path/...>] [--baud <rate>] [--wait <seconds>]
      Reads one checksum-verified GPS fix locally. Never sends coordinates to the cloud. The port can also
      come from WALKER_GPS_PORT; baud defaults to 9600 and wait to 60 seconds.
  walker check [--sound] [--buzz] [--press] [--server <url>] [--state <dir>] [--port <tty,...>]
               [--expect <module id,...>] [--env <file>] [--sim]
      Read-only bring-up checks: one PASS / WARN / FAIL / SKIP line per item, then a summary; exits 1 if
      anything failed. --sound plays one short tone, --buzz sends one short buzz to each hand, --press waits
      for a press on each hand. Run it with sudo on the Pi (the settings file and the credential are readable
      only by root and the service). --sim checks simulated serial boards, lift and arms instead of real
      ports. The arms are only PINGed and READ; the lift is only sent hello.request.
  walker simulate [--script <file>] [--mic-file <16 kHz mono WAV>] [--mic mac] [--loud]
                  [--server <url>] [--state <dir>] [--out <dir>] [--screen] [--lift] [--arms]
      Runs the whole walker on this computer with simulated parts and, unless --server is given, a FAKE
      cloud on 127.0.0.1. Silent by default: speech is written to audio files. --loud plays it.
      --screen also serves the walker screen's page on http://127.0.0.1:8740/ (WALKER_SCREEN_PORT).
      --lift adds a SIMULATED lift board driven by the real lift client from a stand-in loop (the motion
      coordinator isn't wired in); press ? for its keys.
      --arms adds SIMULATED arms (fake servo buses) and a simulated stop switch; press ? for their keys.
${ARMS_USAGE}

State folder: --state, else WALKER_STATE_DIR, else ${DEFAULT_STATE_DIR} (run and pair) or a new temp folder (simulate).`;

const BOOLEAN_FLAGS = new Set(["loud", "sound", "buzz", "press", "sim", "screen", "lift", "arms", "leader"]);

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
    if (BOOLEAN_FLAGS.has(name)) flags.set(name, true);
    else if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i += 1;
    } else throw new Error(`--${name} needs a value.`);
  }
  return { positional, flags };
}

const text = (value: string | true | undefined) => (typeof value === "string" ? value : undefined);


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
      const paired = await pairWalker({
        server,
        code,
        ...(name ? { name } : {}),
        store,
        clock: systemClock,
        say: (line) => process.stdout.write(`${line}\n`),
      });
      process.stdout.write(
        `Paired as device ${paired.device_id}. The credential is saved in ${join(stateDir, "credential.json")} (readable only by this user).\n`,
      );
      return 0;
    }
    case "run":
      return runOnPi(process.env);
    case "gps": {
      const port = text(flags.get("port")) ?? process.env.WALKER_GPS_PORT;
      if (!port) {
        process.stderr.write("Set WALKER_GPS_PORT or pass --port with the GPS USB serial path.\n");
        return 2;
      }
      const baud = Number(text(flags.get("baud")) ?? "9600");
      const wait = Number(text(flags.get("wait")) ?? "60");
      const reading = await readGps(port, baud, wait * 1000);
      if (reading.status === "fix") {
        process.stdout.write(`Receiver-reported GPS fix: ${reading.latitude.toFixed(5)}, ${reading.longitude.toFixed(5)}\n`);
        return 0;
      }
      process.stdout.write(reading.status === "no_fix" ? "GPS is sending RMC data but has no fix yet.\n" : "No valid RMC data received; check the USB port, baud rate, and NMEA output.\n");
      return 1;
    }
    case "check": {
      // Each open serial port holds one libuv thread-pool thread for its blocking reads, as in the service's unit.
      // A closed port's read stays blocked until a byte arrives, and a servo bus never sends one unasked, so
      // each arm adapter keeps its thread until exit: room for four of them plus the ESP32 boards.
      process.env.UV_THREADPOOL_SIZE ??= "16";
      const list = (value: string | true | undefined) => text(value)?.split(",").map((part) => part.trim()).filter(Boolean);
      const sim = flags.get("sim") === true;
      return walkerCheck(
        {
          server: text(flags.get("server")),
          state: text(flags.get("state")),
          envFile: text(flags.get("env")),
          sound: flags.get("sound") === true,
          buzz: flags.get("buzz") === true,
          press: flags.get("press") === true,
          sim,
          ports: list(flags.get("port")) ?? null,
          expect: list(flags.get("expect")) ?? [],
        },
        realCheckDeps(sim),
      );
    }
    case "arms":
      return armsCommand(positional, flags);
    case "motion":
      return motionCommand(positional, flags);
    case "simulate": {
      const mic = text(flags.get("mic"));
      if (mic !== undefined && mic !== "mac") throw new Error("--mic only takes mac.");
      return simulate({
        server: text(flags.get("server")),
        micFile: text(flags.get("mic-file")),
        mic,
        loud: flags.get("loud") === true,
        arms: flags.get("arms") === true,
        state: text(flags.get("state")),
        out: text(flags.get("out")),
        script: text(flags.get("script")),
        screen: flags.get("screen") === true,
        lift: flags.get("lift") === true,
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
