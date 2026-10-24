import { spawn } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLIP_BYTES_PER_MS, CLIP_MAX_PCM_BYTES, CLIP_SAMPLE_RATE } from "../constants";
import type { Logger } from "../log";
import { signalChild } from "../process";
import { readWav, wavFromPcm } from "./wav";

/** A finished push-to-talk clip: a 16 kHz mono 16-bit WAV of at most 15 s (under 1 MB). Held in memory only. */
export interface Clip {
  wav: Buffer;
  durationMs: number;
}

export interface CaptureSession {
  /** Stops recording and returns the clip. */
  stop(): Promise<Clip>;
  /** Stops recording and throws the audio away. */
  abort(): void;
}

export interface AudioCapture {
  readonly simulated: boolean;
  readonly label: string;
  start(): CaptureSession;
}

/** Copies at most 15 s of `pcm` into a new WAV; the caller still owns (and wipes) `pcm`. */
function clipFromPcm(pcm: Buffer): Clip {
  const length = Math.min(pcm.length, CLIP_MAX_PCM_BYTES);
  const capped = pcm.subarray(0, length - (length % 2));
  return { wav: wavFromPcm(capped, CLIP_SAMPLE_RATE), durationMs: Math.floor(capped.length / CLIP_BYTES_PER_MS) };
}

/**
 * Records raw 16 kHz mono 16-bit PCM from a command's stdout (arecord on the Pi), keeping at most 15 s.
 * The service stops it on release or at 15 s. Nothing is written to disk.
 */
export class CommandCapture implements AudioCapture {
  constructor(
    readonly label: string,
    private readonly command: string,
    private readonly args: readonly string[],
    private readonly log: Logger,
    readonly simulated = false,
    private readonly spawnChild: typeof spawn = spawn,
  ) {}

  start(): CaptureSession {
    const child = this.spawnChild(this.command, [...this.args], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: Error | null = null;
    let exited = false;
    // A command that can't start emits "error" and may never emit "close", so either one ends the recording.
    const exit = new Promise<void>((resolve) => {
      child.once("close", () => ((exited = true), resolve()));
      child.once("error", (error) => {
        failure = new Error(`${this.command} could not start (${(error as NodeJS.ErrnoException).code ?? "error"}).`);
        exited = true;
        resolve();
      });
    });
    child.stdout.on("data", (data: Buffer) => {
      if (bytes >= CLIP_MAX_PCM_BYTES) return;
      const part = data.subarray(0, CLIP_MAX_PCM_BYTES - bytes);
      chunks.push(Buffer.from(part));
      bytes += part.length;
    });
    child.stderr.on("data", () => {});
    const wipe = () => {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
    };

    return {
      stop: async () => {
        if (!exited) signalChild(child, "SIGINT");
        const killer = setTimeout(() => signalChild(child, "SIGKILL"), 2000);
        await exit;
        clearTimeout(killer);
        if (failure) throw failure;
        if (bytes === 0) throw new Error(`${this.command} recorded nothing (exit ${child.exitCode ?? child.signalCode}).`);
        const pcm = Buffer.concat(chunks);
        const clip = clipFromPcm(pcm);
        pcm.fill(0);
        wipe();
        return clip;
      },
      abort: () => {
        if (!exited) signalChild(child, "SIGKILL");
        wipe();
        this.log.info("recording discarded");
      },
    };
  }
}

/** arecord's arguments for the walker's clip format (raw 16 kHz mono 16-bit PCM to stdout); `walker check` uses them too. */
export function arecordArgs(device: string): string[] {
  return ["-q", "-D", device, "-f", "S16_LE", "-r", String(CLIP_SAMPLE_RATE), "-c", "1", "-t", "raw"];
}

/** The Pi's microphone through ALSA, by device name (for example `plughw:CARD=Device,DEV=0`). */
export function arecordCapture(device: string, log: Logger): AudioCapture {
  return new CommandCapture(`arecord on ${device}`, "arecord", arecordArgs(device), log);
}

/**
 * The Mac's microphone through ffmpeg (AVFoundation). Behind the simulator's `--mic mac` flag only: it records
 * whoever is nearby and makes macOS ask for microphone permission, so no test or default run uses it.
 */
export function macMicCapture(log: Logger, device = "0"): AudioCapture {
  return new CommandCapture(
    `Mac microphone ${device}`,
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", `:${device}`, "-ac", "1", "-ar", String(CLIP_SAMPLE_RATE), "-f", "s16le", "-"],
    log,
    true,
  );
}

/** One `--mic-file` value as a list of clips: a WAV, a comma-separated list, or a folder (its .wav files by name). */
export function resolveMicFiles(value: string): string[] {
  const paths: string[] = [];
  for (const part of value.split(",").map((p) => p.trim()).filter(Boolean)) {
    if (statSync(part).isDirectory()) {
      // Natural order (2- before 10-), and no hidden files (macOS writes ._name.wav next to copied clips).
      const wavs = readdirSync(part)
        .filter((name) => !name.startsWith(".") && name.toLowerCase().endsWith(".wav"))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (wavs.length === 0) throw new Error(`${part} has no .wav files.`);
      paths.push(...wavs.map((name) => join(part, name)));
    } else {
      paths.push(part);
    }
  }
  if (paths.length === 0) throw new Error("--mic-file needs at least one WAV file.");
  return paths;
}

function readClipFile(path: string): Buffer {
  let info: ReturnType<typeof readWav>;
  try {
    info = readWav(readFileSync(path));
  } catch (error) {
    throw new Error(`${path}: ${(error as Error).message}`);
  }
  if (info.format !== 1 || info.sampleRate !== CLIP_SAMPLE_RATE || info.channels !== 1 || info.bitsPerSample !== 16) {
    throw new Error(
      `${path} must be a 16 kHz mono 16-bit WAV. Convert it with: ffmpeg -i <input> -ar 16000 -ac 1 -sample_fmt s16 <output>.wav`,
    );
  }
  return info.pcm;
}

/**
 * The simulator's microphone: each turn sent plays the next prepared WAV file (capped at 15 s), starting
 * again after the last, so a whole beat sequence runs from one command. A press that ends without a clip
 * (too short, cancelled) doesn't use one up. Each file is read again at its press, so an edit is picked up.
 */
export class FileCapture implements AudioCapture {
  readonly simulated = true;
  readonly label: string;
  private next = 0;

  constructor(private readonly paths: readonly string[]) {
    if (paths.length === 0) throw new Error("The file mic needs at least one WAV file.");
    for (const path of paths) readClipFile(path); // refuse a bad clip now, not at the third press
    this.label = paths.length === 1 ? `file ${paths[0]}` : `${paths.length} files, in order (${paths[0]} first)`;
  }

  start(): CaptureSession {
    const path = this.paths[this.next % this.paths.length]!;
    const pcm = readClipFile(path);
    return {
      stop: async () => {
        this.next += 1;
        return clipFromPcm(pcm);
      },
      abort: () => pcm.fill(0),
    };
  }
}
