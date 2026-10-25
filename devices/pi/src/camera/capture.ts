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

/**
 * A second picture ffmpeg makes from the same camera for the fall check: `fps` a second, scaled and padded to a
 * `box.size` square (src/fall/pose.ts, `letterbox`), as raw RGB. Made only while the camera runs.
 */
export interface AnalysisSpec {
  box: { size: number; width: number; height: number; padX: number; padY: number };
  fps: number;
}

export interface AnalysisFrame {
  seq: number;
  /** box.size * box.size * 3 bytes, RGB, row by row. */
  rgb: Uint8Array;
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

/** The file descriptor ffmpeg writes the analysis picture to (stdin, stdout, stderr, then this). */
export const ANALYSIS_FD = 3;

export function ffmpegArgs(spec: CameraSpec, analysis?: AnalysisSpec): string[] {
  const size = `${spec.width}x${spec.height}`;
  const head = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  const out =
    spec.kind === "camera"
      ? [...head, "-f", "v4l2", "-input_format", "mjpeg", "-video_size", size, "-framerate", String(spec.fps), "-i", spec.device, "-an", "-c:v", "copy", "-f", "mjpeg", "pipe:1"]
      : [...head, "-re", "-f", "lavfi", "-i", `testsrc2=size=${size}:rate=${spec.fps}`, "-an", "-pix_fmt", "yuvj420p", "-c:v", "mjpeg", "-q:v", "5", "-f", "mjpeg", "pipe:1"];
  if (!analysis) return out;
  // The camera's MJPEG is still copied untouched for the live view; only this second output is decoded.
  const { box, fps } = analysis;
  const filter = `fps=${fps},scale=${box.width}:${box.height},pad=${box.size}:${box.size}:${box.padX}:${box.padY}:black`;
  return [...out, "-an", "-vf", filter, "-pix_fmt", "rgb24", "-f", "rawvideo", `pipe:${ANALYSIS_FD}`];
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
  private analysisSeq = 0;
  private readonly analysisListeners = new Set<(frame: AnalysisFrame) => void>();

  constructor(
    private readonly spec: CameraSpec,
    private readonly deps: { clock: Clock; log: Logger; command?: string; spawnChild?: typeof spawn; analysis?: AnalysisSpec },
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

  /** Calls `fn` with each analysis picture (only when made with `analysis`), until the returned function is called. */
  onAnalysis(fn: (frame: AnalysisFrame) => void): () => void {
    this.analysisListeners.add(fn);
    return () => this.analysisListeners.delete(fn);
  }

  private launch() {
    const { clock, log } = this.deps;
    const spawnChild = this.deps.spawnChild ?? spawn;
    const analysis = this.deps.analysis;
    const stdio: Array<"ignore" | "pipe"> = analysis ? ["ignore", "pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"];
    const child = spawnChild(this.deps.command ?? "ffmpeg", ffmpegArgs(this.spec, analysis), { stdio });
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
    if (analysis) {
      const raw = new RawFrames(analysis.box.size * analysis.box.size * 3, (rgb) => {
        if (this.child !== child) return;
        this.analysisSeq += 1;
        const frame = { seq: this.analysisSeq, rgb, at: clock.monotonic() };
        for (const fn of [...this.analysisListeners]) fn(frame);
      });
      (child.stdio[ANALYSIS_FD] as NodeJS.ReadableStream | null | undefined)?.on("data", (chunk: Buffer) => raw.push(chunk));
    }
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

/** Cuts ffmpeg's raw video into whole pictures of `size` bytes, whatever the chunking. Keeps no history. */
export class RawFrames {
  private parts: Buffer[] = [];
  private held = 0;

  constructor(
    private readonly size: number,
    private readonly onFrame: (rgb: Uint8Array) => void,
  ) {}

  push(chunk: Buffer): void {
    this.parts.push(chunk);
    this.held += chunk.length;
    if (this.held < this.size) return;
    let all = Buffer.concat(this.parts, this.held);
    while (all.length >= this.size) {
      this.onFrame(new Uint8Array(all.subarray(0, this.size)));
      all = all.subarray(this.size);
    }
    this.parts = all.length ? [all] : [];
    this.held = all.length;
  }
}

/**
 * One camera, several users: the live link and the fall check each hold a lease, and ffmpeg runs while any lease
 * is started. A lease's `stop()` stops only that lease. Frames are shared: `latest()` and `onFrame` are the camera's.
 */
export class CameraLeases {
  private readonly started = new Set<object>();

  constructor(private readonly camera: FrameSource) {}

  lease(): FrameSource {
    const camera = this.camera;
    const started = this.started;
    const token = {};
    return {
      source: camera.source,
      start() {
        const first = started.size === 0;
        started.add(token);
        if (first) camera.start();
      },
      stop() {
        if (!started.delete(token)) return;
        if (started.size === 0) camera.stop();
      },
      latest: () => (started.has(token) ? camera.latest() : null),
      onFrame: (fn) => camera.onFrame(fn),
    };
  }
}
