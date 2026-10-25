import "server-only";
import type { NextResponse } from "next/server";
import { CameraService, sharedCameraRelay, sharedWalkerBackend } from "@walker/cloud-api";
import { CAMERA_FRAME_MAX_BYTES } from "@walker/contracts";
import { walkerRoute, walkerService } from "./walker";

/**
 * Server-side glue for the live camera (camera.ts in the contracts). The walker's routes take its Bearer
 * credential through WalkerService.resolve, exactly as every other device route; the phones' routes take the
 * `walker_member` cookie. The relay is one per process, in memory.
 */
export function cameraService(): CameraService {
  const backend = sharedWalkerBackend();
  return new CameraService(backend.store, sharedCameraRelay(), {
    blocked: backend.blocked,
    resolveDevice: (caller, deviceId) => walkerService().resolve(caller, deviceId),
  });
}

/** The posted JPEG, at most CAMERA_FRAME_MAX_BYTES; null for anything else. */
export async function readJpeg(request: Request): Promise<Uint8Array | null> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "image/jpeg") return null;
  if (Number(request.headers.get("content-length") ?? 0) > CAMERA_FRAME_MAX_BYTES) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > CAMERA_FRAME_MAX_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

/**
 * As walkerRoute, for the frames route only: it runs up to ten times a second while someone watches, so a
 * success isn't logged (the watch logs one line when it ends); a failure goes through walkerRoute's line.
 */
export async function quietCameraRoute(route: string, deviceId: string, fn: () => Promise<NextResponse>): Promise<NextResponse> {
  try {
    return await fn();
  } catch (error) {
    return walkerRoute(route, deviceId, () => Promise.reject(error));
  }
}
