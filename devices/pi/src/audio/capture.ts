import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
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

/** The Pi's microphone through ALSA, by device name (for example `plughw:CARD=Device,DEV=0`). */
export function arecordCapture(device: string, log: Logger): AudioCapture {
  return new CommandCapture(
    `arecord on ${device}`,
    "arecord",
    ["-q", "-D", device, "-f", "S16_LE", "-r", String(CLIP_SAMPLE_RATE), "-c", "1", "-t", "raw"],
    log,
  );
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

/** The simulator's microphone: every recording is the same prepared WAV file (capped at 15 s). */
export class FileCapture implements AudioCapture {
  readonly simulated = true;
  readonly label: string;
  private readonly pcm: Buffer;

  constructor(path: string) {
    const info = readWav(readFileSync(path));
    if (info.format !== 1 || info.sampleRate !== CLIP_SAMPLE_RATE || info.channels !== 1 || info.bitsPerSample !== 16) {
      throw new Error(
        `${path} must be a 16 kHz mono 16-bit WAV. Convert it with: ffmpeg -i <input> -ar 16000 -ac 1 -sample_fmt s16 <output>.wav`,
      );
    }
    this.pcm = Buffer.from(info.pcm);
    this.label = `file ${path}`;
  }

  start(): CaptureSession {
    return { stop: async () => clipFromPcm(this.pcm), abort: () => {} };
  }
}
