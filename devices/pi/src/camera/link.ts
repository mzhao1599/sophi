import { CAMERA_MAX_FPS, CAMERA_WAIT_MS } from "@walker/contracts";
import { CancelledError, withDeadline, type Clock } from "../clock";
import { CloudError, type CameraCloud } from "../cloud/client";
import type { Logger } from "../log";
import type { CredentialFile } from "../store";
import type { CameraFrame, FrameSource } from "./capture";

/** The server holds the wait up to CAMERA_WAIT_MS; give it this much more before calling it lost. */
export const WAIT_DEADLINE_MS = CAMERA_WAIT_MS + 10_000;
/** One frame's post. Placeholder, not measured. */
export const FRAME_DEADLINE_MS = 5_000;
/** Frames at most this often (CAMERA_MAX_FPS). */
export const FRAME_INTERVAL_MS = 1000 / CAMERA_MAX_FPS;
/** While wanted, a camera that gives no frame for this long is stopped and the link waits again. */
export const NO_FRAME_MS = 5_000;
/** Failed frame posts are retried this often, for at most FAILING_MAX_MS, before the camera stops. */
export const FRAME_RETRY_MS = 500;
export const FAILING_MAX_MS = 10_000;
/** A failed wait is retried after this, doubled up to WAIT_RETRY_MAX_MS. */
export const WAIT_RETRY_MIN_MS = 2_000;
export const WAIT_RETRY_MAX_MS = 30_000;
/** A wait that answers `false` sooner than this is followed by a pause, so a server answering at once can't spin the loop. */
export const MIN_WAIT_ROUND_MS = 1_000;
/** With no credential, or a refused one, the credential file is read again this often. */
export const CREDENTIAL_RECHECK_MS = 5_000;

export interface CameraLinkDeps {
  clock: Clock;
  log: Logger;
  camera: FrameSource;
  /** Read fresh each round, so pairing again (a new credential) takes effect without a restart. */
  credential: () => CredentialFile | null;
  makeCloud: (credential: CredentialFile) => CameraCloud;
}

/**
 * The walker's half of the live camera (packages/contracts/src/camera.ts): waits for a caretaker to watch,
 * then opens the camera and posts its newest frame, one at a time and at most CAMERA_MAX_FPS, until the
 * server says to stop. The camera is open only while someone watches. A failure here never touches the rest
 * of the walker; it is logged (codes only) and retried.
 */
export class CameraLink {
  private running = false;
  private controller = new AbortController();
  private loop: Promise<void> = Promise.resolve();
  /** The credential the server refused (401): nothing more is sent with it. */
  private refused: string | null = null;

  constructor(private readonly deps: CameraLinkDeps) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.controller = new AbortController();
    this.loop = this.run(this.controller.signal).catch((error: unknown) => {
      this.deps.log.error("camera link stopped on an error", { error: error instanceof Error ? error.name : "unknown" });
    });
  }

  /** Aborts the open request and closes the camera; resolves once the loop has ended. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.controller.abort(new CancelledError("Camera link stopped."));
    this.deps.camera.stop();
    await this.loop;
  }

  private async run(signal: AbortSignal): Promise<void> {
    const { clock, log } = this.deps;
    let retryMs = WAIT_RETRY_MIN_MS;
    while (!signal.aborted) {
      const credential = this.deps.credential();
      if (!credential || credential.credential === this.refused) {
        await sleep(clock, CREDENTIAL_RECHECK_MS, signal);
        continue;
      }
      let cloud: CameraCloud;
      try {
        cloud = this.deps.makeCloud(credential);
      } catch {
        await sleep(clock, CREDENTIAL_RECHECK_MS, signal);
        continue;
      }
      let wanted: boolean;
      const asked = clock.monotonic();
      try {
        wanted = await withDeadline(clock, WAIT_DEADLINE_MS, (s) => cloud.waitForViewer(this.deps.camera.source, s), signal);
        retryMs = WAIT_RETRY_MIN_MS;
      } catch (error) {
        if (signal.aborted) return;
        if (this.refusedBy(error, credential)) continue;
        log.warn("camera wait failed; retrying", { kind: kindOf(error), retry_ms: retryMs });
        await sleep(clock, retryMs, signal);
        retryMs = Math.min(WAIT_RETRY_MAX_MS, retryMs * 2);
        continue;
      }
      if (wanted) await this.stream(cloud, credential, signal);
      else if (clock.monotonic() - asked < MIN_WAIT_ROUND_MS) await sleep(clock, MIN_WAIT_ROUND_MS, signal);
    }
  }

  /** One watch: the camera on, frames out, until the server says stop or the link gives up. */
  private async stream(cloud: CameraCloud, credential: CredentialFile, signal: AbortSignal): Promise<void> {
    const { clock, log, camera } = this.deps;
    camera.start();
    log.info("camera on: a caretaker is watching", { source: camera.source });
    let lastSeq = 0;
    let lastSentAt = -Infinity;
    let failingSince: number | null = null;
    let sent = 0;
    let reason = "stopped";
    try {
      while (!signal.aborted) {
        const frame = await nextFrame(camera, lastSeq, clock, NO_FRAME_MS, signal);
        if (signal.aborted) break;
        if (!frame) {
          reason = "no_frames";
          break;
        }
        const wait = lastSentAt + FRAME_INTERVAL_MS - clock.monotonic();
        if (wait > 0) await sleep(clock, wait, signal);
        if (signal.aborted) break;
        // The newest frame may have moved on while waiting; send that one.
        const newest = camera.latest() ?? frame;
        lastSentAt = clock.monotonic();
        try {
          const keep = await withDeadline(clock, FRAME_DEADLINE_MS, (s) => cloud.sendFrame(newest.jpeg, camera.source, s), signal);
          lastSeq = newest.seq;
          sent += 1;
          failingSince = null;
          if (!keep) {
            reason = "nobody_watching";
            break;
          }
        } catch (error) {
          if (signal.aborted) break;
          if (this.refusedBy(error, credential)) {
            reason = "unauthorized";
            break;
          }
          failingSince ??= clock.monotonic();
          if (clock.monotonic() - failingSince >= FAILING_MAX_MS) {
            reason = "posts_failing";
            log.warn("camera frames keep failing", { kind: kindOf(error) });
            break;
          }
          await sleep(clock, FRAME_RETRY_MS, signal);
        }
      }
    } finally {
      camera.stop();
      log.info("camera off", { reason, frames: sent });
    }
  }

  private refusedBy(error: unknown, credential: CredentialFile): boolean {
    if (!(error instanceof CloudError) || error.kind !== "unauthorized") return false;
    this.refused = credential.credential;
    this.deps.log.warn("camera link refused: the server doesn't accept this walker's credential; waiting for a new pairing");
    return true;
  }
}

function kindOf(error: unknown): string {
  return error instanceof CloudError ? error.kind : error instanceof Error ? error.name : "unknown";
}

/** Resolves after `ms` on `clock`, or at once when `signal` aborts. */
function sleep(clock: Clock, ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    };
    const cancel = clock.setTimeout(done, ms);
    const onAbort = () => {
      cancel();
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** The newest frame after `afterSeq`, waiting up to `ms` for one; null on timeout or abort. */
function nextFrame(camera: FrameSource, afterSeq: number, clock: Clock, ms: number, signal: AbortSignal): Promise<CameraFrame | null> {
  const ready = () => {
    const frame = camera.latest();
    return frame && frame.seq > afterSeq ? frame : null;
  };
  const now = ready();
  if (now || signal.aborted) return Promise.resolve(now);
  return new Promise((resolve) => {
    const finish = (frame: CameraFrame | null) => {
      off();
      cancel();
      signal.removeEventListener("abort", onAbort);
      resolve(frame);
    };
    const off = camera.onFrame(() => {
      const frame = ready();
      if (frame) finish(frame);
    });
    const cancel = clock.setTimeout(() => finish(null), ms);
    const onAbort = () => finish(null);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
