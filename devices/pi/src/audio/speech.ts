import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CueName } from "../bus";
import type { Logger } from "../log";
import { CUE_PLAYER_MAX_MS } from "../constants";
import { signalChild } from "../process";
import { CUE_TONES, toneWav } from "./wav";

export interface Utterance {
  done: Promise<void>;
  stop(): void;
}

/** Speech and cue sounds out. Text always goes in on stdin, never as a command-line argument. */
export interface Speaker {
  readonly label: string;
  readonly simulated: boolean;
  /** Speaks text with the walker's own voice. */
  speak(text: string): Utterance;
  /** Plays a reply the server already voiced (Cartesia), a WAV held in memory. */
  playWav(wav: Buffer): Utterance;
  playCue(name: CueName): Promise<void>;
}

/** Writes the five generated cue WAVs into `dir` and returns their paths. */
export function writeCueSounds(dir: string): Record<CueName, string> {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const paths = {} as Record<CueName, string>;
  for (const name of Object.keys(CUE_TONES) as CueName[]) {
    const path = join(dir, `${name}.wav`);
    writeFileSync(path, toneWav(CUE_TONES[name]));
    paths[name] = path;
  }
  return paths;
}

interface Running {
  done: Promise<void>;
  kill(): void;
}

/** Runs one command; resolves on exit 0, or quietly when killed on purpose (or after `limitMs`). */
function run(command: string, args: readonly string[], stdin?: string | Buffer, limitMs?: number): Running {
  const child = spawn(command, [...args], { stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "pipe"] });
  let killed = false;
  let timedOut = false;
  let stderr = "";
  child.stderr?.on("data", (data: Buffer) => {
    if (stderr.length < 500) stderr += data.toString();
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", (error) => reject(new Error(`${command}: ${(error as NodeJS.ErrnoException).code ?? error.message}`)));
    child.once("close", (code) => {
      // Stopped on purpose counts as done; stopped by the time limit is a failure (a hung player).
      if (timedOut) reject(new Error(`${command} was still running after ${limitMs} ms`));
      else if (code === 0 || killed) resolve();
      else reject(new Error(`${command} exited ${code}: ${stderr.trim().slice(0, 200)}`));
    });
  });
  if (stdin !== undefined && child.stdin) {
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  }
  const kill = () => {
    killed = true;
    signalChild(child, "SIGTERM");
    // A player that ignores SIGTERM would block every later line in the voice queue.
    setTimeout(() => signalChild(child, "SIGKILL"), 2000).unref();
  };
  if (limitMs !== undefined) {
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, limitMs);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
  }
  return { done, kill };
}

/** A chain of steps where `stop()` kills the current step and skips the rest. */
function sequence(steps: Array<() => Running>, cleanup: () => void): Utterance {
  let current: Running | null = null;
  let stopped = false;
  const done = (async () => {
    try {
      for (const step of steps) {
        if (stopped) return;
        current = step();
        await current.done;
      }
    } finally {
      cleanup();
    }
  })();
  return {
    done,
    stop: () => {
      stopped = true;
      current?.kill();
    },
  };
}

/**
 * The Pi: the server's voice when reachable, with Piper or espeak-ng as a local fallback.
 */
export class PiSpeaker implements Speaker {
  readonly simulated = false;
  readonly label: string;
  private counter = 0;

  constructor(
    private readonly options: { playbackDevice: string; piperModel: string | null; tmpDir: string; cues: Record<CueName, string>; remoteVoice?: (text: string, signal: AbortSignal) => Promise<Buffer | null> },
    private readonly log: Logger,
  ) {
    // The folder holds synthesized replies for a moment; leftovers from a crash or power cut are removed here.
    // Its contents are emptied rather than the folder recreated, so the private folder is never given up.
    mkdirSync(options.tmpDir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(options.tmpDir)) rmSync(join(options.tmpDir, name), { recursive: true, force: true });
    this.label = `${options.remoteVoice ? "server voice, " : ""}${options.piperModel ? "piper (espeak-ng fallback)" : "espeak-ng"} on ${options.playbackDevice}`;
  }

  speak(text: string): Utterance {
    this.counter += 1;
    const file = join(this.options.tmpDir, `speech-${this.counter}.wav`);
    const { piperModel, playbackDevice } = this.options;
    let synth: Running | null = null;
    let remotePlayer: Running | null = null;
    const remoteAbort = new AbortController();
    let stopped = false;
    const synthesize = async () => {
      if (piperModel) {
        synth = run("piper", ["--model", piperModel, "--output_file", file], text);
        try {
          await synth.done;
          return;
        } catch (error) {
          if (stopped) return;
          this.log.warn("piper failed; using espeak-ng", { error: (error as Error).message });
        }
      }
      synth = run("espeak-ng", ["--stdin", "-w", file], text);
      await synth.done;
    };
    let player: Running | null = null;
    const done = (async () => {
      try {
        if (this.options.remoteVoice) {
          try {
            const signal = AbortSignal.any([remoteAbort.signal, AbortSignal.timeout(3000)]);
            const remoteWav = await this.options.remoteVoice(text, signal);
            if (stopped) return;
            if (remoteWav) {
              remotePlayer = run("aplay", ["-q", "-D", playbackDevice, "-"], remoteWav);
              await remotePlayer.done;
              return;
            }
          } catch (error) {
            if (stopped) return;
            this.log.warn("server voice unavailable; using local voice", { error: (error as Error).message });
          }
        }
        await synthesize();
        if (stopped) return;
        player = run("aplay", ["-q", "-D", playbackDevice, file]);
        await player.done;
      } finally {
        rmSync(file, { force: true });
      }
    })();
    return {
      done,
      stop: () => {
        stopped = true;
        remoteAbort.abort();
        (remotePlayer as Running | null)?.kill();
        (synth as Running | null)?.kill();
        (player as Running | null)?.kill();
      },
    };
  }

  /** Pipes the WAV into aplay's stdin, so the reply's audio never touches the disk. */
  playWav(wav: Buffer): Utterance {
    return sequence([() => run("aplay", ["-q", "-D", this.options.playbackDevice, "-"], wav)], () => {});
  }

  playCue(name: CueName): Promise<void> {
    return run("aplay", ["-q", "-D", this.options.playbackDevice, this.options.cues[name]], undefined, CUE_PLAYER_MAX_MS).done;
  }
}

/** The Mac, out loud: `say` for speech and `afplay` for cues. Only with the simulator's `--loud` flag. */
export class MacLoudSpeaker implements Speaker {
  readonly simulated = true;
  readonly label = "Mac speakers (say, afplay)";

  constructor(private readonly cues: Record<CueName, string>) {}

  speak(text: string): Utterance {
    return sequence([() => run("say", [], text)], () => {});
  }

  /** afplay needs a file, so the WAV goes to a private temp file that is deleted after playing. */
  playWav(wav: Buffer): Utterance {
    const dir = mkdtempSync(join(tmpdir(), "steady-sim-speech-"));
    const file = join(dir, "reply.wav");
    writeFileSync(file, wav, { mode: 0o600 });
    return sequence([() => run("afplay", [file])], () => rmSync(dir, { recursive: true, force: true }));
  }

  playCue(name: CueName): Promise<void> {
    return run("afplay", [this.cues[name]], undefined, CUE_PLAYER_MAX_MS).done;
  }
}

/**
 * The default for the simulator: no sound out loud. Each line is synthesized by `say` into a numbered AIFF
 * file in `outDir`, so the speech path still runs; cues are already WAV files in the same folder.
 */
export class MacFileSpeaker implements Speaker {
  readonly simulated = true;
  readonly label: string;
  private counter = 0;

  constructor(private readonly outDir: string) {
    mkdirSync(outDir, { recursive: true, mode: 0o700 });
    this.label = `audio files in ${outDir} (silent)`;
  }

  /** Nothing plays aloud here, so `stop` lets the file finish: every spoken line leaves its file behind. */
  speak(text: string): Utterance {
    this.counter += 1;
    const file = join(this.outDir, `${String(this.counter).padStart(3, "0")}-speech.aiff`);
    return { done: run("say", ["-o", file], text).done, stop: () => {} };
  }

  /** Keeps the server's voiced reply as a numbered WAV file next to the synthesized lines. */
  playWav(wav: Buffer): Utterance {
    this.counter += 1;
    writeFileSync(join(this.outDir, `${String(this.counter).padStart(3, "0")}-reply.wav`), wav);
    return { done: Promise.resolve(), stop: () => {} };
  }

  playCue(): Promise<void> {
    return Promise.resolve();
  }
}
