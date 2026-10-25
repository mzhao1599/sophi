import { spawn, type ChildProcess } from "node:child_process";
import { CAMERA_FRAME_MAX_BYTES, type CameraSource } from "@walker/contracts";
import type { Cancel, Clock } from "../clock";
import type { Logger } from "../log";
import { signalChild } from "../process";
import { JpegSplitter, withHuffmanTables } from "./jpeg";

/** Where the picture comes from: a UVC camera's own MJPEG (copied, never re-encoded), or ffmpeg's test source. */
export type CameraSpec =
  | { kind: "camera"; device: string; width: number; height: number; fps: number }
  | { kind: "test_pattern"; width: number; height: number; fps: number };

export interface CameraFrame {
  /** Counts up from 1 for each frame since this capture object was made. */
  seq: number;
  jpeg: Buffer;
  /** The monotonic time it arrived. */
  at: number;
}

/** What the cloud link needs from a camera: on demand, newest frame only. */
export interface FrameSource {
  readonly source: CameraSource;
  start(): void;
  stop(): void;
  latest(): CameraFrame | null;
  /** Calls `fn` on each new frame until the returned function is called. */
  onFrame(fn: () => void): () => void;
}

/** First restart delay after ffmpeg exits while the camera is wanted, doubled to RESTART_MAX_MS. Placeholder, not measured. */
export const RESTART_MIN_MS = 1_000;
export const RESTART_MAX_MS = 30_000;
/** How long `stop()` waits for ffmpeg to exit on SIGTERM before SIGKILL. */
export const KILL_AFTER_MS = 2_000;

export function ffmpegArgs(spec: CameraSpec): string[] {
  const size = `${spec.width}x${spec.height}`;
  const head = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  if (spec.kind === "camera") {
    return [...head, "-f", "v4l2", "-input_format", "mjpeg", "-video_size", size, "-framerate", String(spec.fps), "-i", spec.device, "-an", "-c:v", "copy", "-f", "mjpeg", "pipe:1"];
  }
  return [...head, "-re", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${spec.fps}`, "-an", "-pix_fmt", "yuvj420p", "-c:v", "mjpeg", "-q:v", "5", "-f", "mjpeg", "pipe:1"];
}

/**
 * Reads the camera with ffmpeg only while started, keeping just the newest frame in memory (no file, no
 * history); `stop()` drops it. Logs only exit codes and counts, never frame bytes or ffmpeg's own output.
 */
export class FfmpegCamera implements FrameSource {
  readonly source: CameraSource;
  private wanted = false;
  private child: ChildProcess | null = null;
  private frame: CameraFrame | null = null;
  private seq = 0;
  private restartMs = RESTART_MIN_MS;
  private cancelRestart: Cancel | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly spec: CameraSpec,
    private readonly deps: { clock: Clock; log: Logger; command?: string; spawnChild?: typeof spawn },
  ) {
    this.source = spec.kind;
  }

  start(): void {
    if (this.wanted) return;
    this.wanted = true;
    this.restartMs = RESTART_MIN_MS;
    this.launch();
  }

  stop(): void {
    if (!this.wanted) return;
    this.wanted = false;
    this.cancelRestart?.();
    this.cancelRestart = null;
    this.frame = null;
    const child = this.child;
    this.child = null;
    if (child) {
      signalChild(child, "SIGTERM");
      const cancelKill = this.deps.clock.setTimeout(() => signalChild(child, "SIGKILL"), KILL_AFTER_MS);
      child.once("close", cancelKill);
    }
  }

  latest(): CameraFrame | null {
    return this.frame;
  }

  onFrame(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private launch() {
    const { clock, log } = this.deps;
    const spawnChild = this.deps.spawnChild ?? spawn;
    const child = spawnChild(this.deps.command ?? "ffmpeg", ffmpegArgs(this.spec), { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;
    const splitter = new JpegSplitter(CAMERA_FRAME_MAX_BYTES, (jpeg) => {
      if (this.child !== child) return;
      this.seq += 1;
      this.frame = { seq: this.seq, jpeg: withHuffmanTables(jpeg), at: clock.monotonic() };
      this.restartMs = RESTART_MIN_MS;
      for (const fn of [...this.listeners]) fn();
    });
    child.stdout?.on("data", (chunk: Buffer) => splitter.push(chunk));
    child.stderr?.on("data", () => {});
    let ended = false;
    const end = (fields: Record<string, string | number | null>) => {
      if (ended) return;
      ended = true;
      if (splitter.dropped > 0) log.warn("camera frames dropped", { count: splitter.dropped });
      if (this.child !== child) return; // Stopped on purpose.
      this.child = null;
      this.frame = null;
      log.warn("camera capture ended; restarting", { ...fields, retry_ms: this.restartMs });
      const delay = this.restartMs;
      this.restartMs = Math.min(RESTART_MAX_MS, this.restartMs * 2);
      this.cancelRestart = clock.setTimeout(() => {
        this.cancelRestart = null;
        if (this.wanted) this.launch();
      }, delay);
    };
    // A command that can't start emits "error" and may never emit "close"; either one ends this run.
    child.once("error", (error) => end({ code: (error as NodeJS.ErrnoException).code ?? "error" }));
    child.once("close", (code: number | null, signal: NodeJS.Signals | null) => end({ exit: code, signal }));
  }
}
