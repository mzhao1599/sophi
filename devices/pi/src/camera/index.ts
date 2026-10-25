import type { Clock } from "../clock";
import { HttpCameraCloud } from "../cloud/client";
import type { Logger } from "../log";
import type { StateStore } from "../store";
import { FfmpegCamera, type CameraSpec } from "./capture";
import { CameraLink } from "./link";

export { FfmpegCamera, ffmpegArgs, type CameraFrame, type CameraSpec, type FrameSource } from "./capture";
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
 * Starts the live camera's link when WALKER_CAMERA_DEVICE is set, else returns null. A setting that can't be
 * read leaves the camera off, logged; it never stops the walker.
 */
export function startCameraLink(options: { env: NodeJS.ProcessEnv; clock: Clock; log: Logger; store: StateStore }): CameraLink | null {
  const { env, clock, log, store } = options;
  const settings = readCameraSettings(env);
  if (settings.kind === "off") return null;
  if (settings.kind === "error") {
    log.error("camera is off: a camera setting can't be read", { reason: settings.reason });
    return null;
  }
  const camera = new FfmpegCamera(settings.spec, { clock, log });
  const link = new CameraLink({
    clock,
    log,
    camera,
    credential: () => store.readCredential(),
    makeCloud: (credential) => new HttpCameraCloud(credential.server_url, credential.device_id, credential.credential),
  });
  link.start();
  log.info("camera link started; the camera opens only while a caretaker watches", {
    source: settings.spec.kind,
    size: `${settings.spec.width}x${settings.spec.height}`,
    fps: settings.spec.fps,
  });
  return link;
}
