import type { Clock } from "../clock";
import { HttpCameraCloud } from "../cloud/client";
import type { Logger } from "../log";
import type { StateStore } from "../store";
import { FallDetector, FallWatch, letterbox, loadMoveNet, readFallSettings, type FallEvent } from "../fall";
import { CameraLeases, FfmpegCamera, type CameraSpec } from "./capture";
import { CameraLink } from "./link";

export { CameraLeases, FfmpegCamera, RawFrames, ffmpegArgs, type AnalysisFrame, type AnalysisSpec, type CameraFrame, type CameraSpec, type FrameSource } from "./capture";
export { CameraLink } from "./link";
export { JpegSplitter, STANDARD_DHT, withHuffmanTables } from "./jpeg";

/** The value of WALKER_CAMERA_DEVICE that picks ffmpeg's generated test picture instead of a camera. */
export const TEST_PATTERN = "test-pattern";

/**
 * The live camera's settings: WALKER_CAMERA_DEVICE (a /dev path, best a stable /dev/v4l/by-id/...-video-index0
 * link, or `test-pattern`), WALKER_CAMERA_SIZE (default 640x480) and WALKER_CAMERA_FPS (default 15 for a camera,
 * 10 for the test pattern). Unset device: the camera is off. The defaults are placeholders, not measured on
 * our InnoMaker cameras.
 */
export function readCameraSettings(env: NodeJS.ProcessEnv): { kind: "off" } | { kind: "on"; spec: CameraSpec } | { kind: "error"; reason: string } {
  const device = env.WALKER_CAMERA_DEVICE?.trim() ?? "";
  if (!device) return { kind: "off" };
  const size = /^(\d{2,4})x(\d{2,4})$/.exec(env.WALKER_CAMERA_SIZE?.trim() || "640x480");
  const width = Number(size?.[1]);
  const height = Number(size?.[2]);
  if (!size || width < 160 || width > 1920 || height < 120 || height > 1080) return { kind: "error", reason: "WALKER_CAMERA_SIZE must be WIDTHxHEIGHT, from 160x120 to 1920x1080." };
  const testPattern = device === TEST_PATTERN;
  const fps = Number(env.WALKER_CAMERA_FPS?.trim() || (testPattern ? "10" : "15"));
  if (!Number.isInteger(fps) || fps < 1 || fps > 30) return { kind: "error", reason: "WALKER_CAMERA_FPS must be a whole number from 1 to 30." };
  if (testPattern) return { kind: "on", spec: { kind: "test_pattern", width, height, fps } };
  if (!device.startsWith("/dev/")) return { kind: "error", reason: `WALKER_CAMERA_DEVICE must be a /dev path or ${TEST_PATTERN}.` };
  return { kind: "on", spec: { kind: "camera", device, width, height, fps } };
}

/**
 * Starts the camera when WALKER_CAMERA_DEVICE is set, else returns null: the live camera's link always, and the
 * fall check too with WALKER_FALL_CHECK=on (src/fall). Both share one ffmpeg through leases: without the fall check
 * the camera opens only while a caretaker watches; with it, the camera stays on and its pictures are read on the
 * walker. A setting that can't be read, a missing model or a missing onnxruntime-node leaves that part off, logged;
 * none of it ever stops the walker.
 */
export async function startCamera(options: {
  env: NodeJS.ProcessEnv;
  clock: Clock;
  log: Logger;
  store: StateStore;
  /** A fall was confirmed (only with the fall check on). */
  onFall?: (event: FallEvent) => void;
}): Promise<{ stop(): Promise<void> } | null> {
  const { env, clock, log, store } = options;
  const settings = readCameraSettings(env);
  if (settings.kind === "off") {
    if (readFallSettings(env).kind === "on") log.error("fall check is off: it needs WALKER_CAMERA_DEVICE");
    return null;
  }
  if (settings.kind === "error") {
    log.error("camera is off: a camera setting can't be read", { reason: settings.reason });
    return null;
  }
  const spec = settings.spec;
  const fall = readFallSettings(env);
  if (fall.kind === "error") log.error("fall check is off: a setting can't be read", { reason: fall.reason });
  const box = letterbox(spec.width, spec.height);
  let model = null;
  if (fall.kind === "on") {
    try {
      model = await loadMoveNet(fall.modelPath, box);
    } catch (error) {
      log.error("fall check is off: the pose model couldn't load", { error: (error as Error).message });
    }
  }
  const camera = new FfmpegCamera(spec, { clock, log, ...(model && fall.kind === "on" ? { analysis: { box, fps: fall.fps } } : {}) });
  const leases = new CameraLeases(camera);
  const link = new CameraLink({
    clock,
    log,
    camera: leases.lease(),
    credential: () => store.readCredential(),
    makeCloud: (credential) => new HttpCameraCloud(credential.server_url, credential.device_id, credential.credential),
  });
  link.start();
  log.info(model ? "camera link started; the camera stays on for the fall check" : "camera link started; the camera opens only while a caretaker watches", {
    source: spec.kind,
    size: `${spec.width}x${spec.height}`,
    fps: spec.fps,
  });
  let watch: FallWatch | null = null;
  if (model) {
    watch = new FallWatch({
      clock,
      log,
      camera: leases.lease(),
      onAnalysis: (fn) => camera.onAnalysis(fn),
      model,
      detector: new FallDetector({ aspect: spec.width / spec.height }),
      onFall: (event) => options.onFall?.(event),
    });
    watch.start();
  }
  return {
    async stop() {
      await watch?.stop();
      await link.stop();
    },
  };
}
