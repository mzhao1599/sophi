import type { Clock } from "../clock";
import type { Logger } from "../log";
import type { AnalysisFrame, FrameSource } from "../camera/capture";
import { FallDetector, type FallEvent } from "./detector";
import type { PoseModel } from "./pose";

/** Placeholder, not measured: a gap this long between analysed pictures starts the detector afresh. */
export const ANALYSIS_GAP_MS = 3_000;

export interface FallWatchDeps {
  clock: Clock;
  log: Logger;
  /** This watcher's lease on the camera: started for as long as the watch runs. */
  camera: FrameSource;
  /** The camera's analysis pictures (FfmpegCamera.onAnalysis). */
  onAnalysis: (fn: (frame: AnalysisFrame) => void) => () => void;
  model: PoseModel;
  detector?: FallDetector;
  /** A fall was confirmed. Called once per fall; the detector re-arms only after she is upright again. */
  onFall: (event: FallEvent) => void;
}

/**
 * Keeps the camera on and runs each analysis picture through the pose model and the fall detector, one picture at
 * a time: a picture that arrives while the model is busy replaces any waiting one, so the watch never falls behind.
 * Pictures stay in memory only for the model's run. Logs carry outcomes and timings, never a picture or a point.
 * A model error or a camera that stops sending never counts as a fall; the detector only learns from pictures
 * the model has read.
 */
export class FallWatch {
  private readonly detector: FallDetector;
  private off: (() => void) | null = null;
  private busy = false;
  private waiting: AnalysisFrame | null = null;
  private lastAt: number | null = null;
  private errors = 0;
  private analysed = 0;
  private slowestMs = 0;

  constructor(private readonly deps: FallWatchDeps) {
    this.detector = deps.detector ?? new FallDetector();
  }

  start(): void {
    if (this.off) return;
    this.off = this.deps.onAnalysis((frame) => this.take(frame));
    this.deps.camera.start();
    this.deps.log.info("fall check on: the camera stays on and its pictures are read on the walker only");
  }

  async stop(): Promise<void> {
    if (!this.off) return;
    this.off();
    this.off = null;
    this.waiting = null;
    this.deps.camera.stop();
    this.deps.log.info("fall check off", { analysed: this.analysed, slowest_ms: Math.round(this.slowestMs) });
    await this.deps.model.close().catch(() => {});
  }

  private take(frame: AnalysisFrame): void {
    if (!this.off) return;
    if (this.busy) {
      this.waiting = frame;
      return;
    }
    void this.run(frame);
  }

  private async run(frame: AnalysisFrame): Promise<void> {
    this.busy = true;
    const started = this.deps.clock.monotonic();
    try {
      const pose = await this.deps.model.estimate(frame.rgb);
      const took = this.deps.clock.monotonic() - started;
      this.slowestMs = Math.max(this.slowestMs, took);
      this.analysed += 1;
      if (this.errors > 0) {
        this.deps.log.info("pose model reading again", { after_errors: this.errors });
        this.errors = 0;
      }
      if (!this.off) return;
      if (this.lastAt !== null && frame.at - this.lastAt > ANALYSIS_GAP_MS) this.detector.reset();
      this.lastAt = frame.at;
      const fall = this.detector.push(pose, frame.at);
      if (fall) {
        this.deps.log.warn("fall check: possible fall", { why: fall.why, after_ms: Math.round(fall.at - fall.since) });
        this.deps.onFall(fall);
      }
    } catch (error) {
      this.errors += 1;
      // Once, then every 100th, so a broken model can't fill the journal.
      if (this.errors === 1 || this.errors % 100 === 0) this.deps.log.error("pose model failed on a picture", { error: (error as Error).message, count: this.errors });
    } finally {
      this.busy = false;
      const next = this.waiting;
      this.waiting = null;
      if (next && this.off) void this.run(next);
    }
  }
}
