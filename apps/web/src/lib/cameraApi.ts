import { CameraSharingResponseSchema, CameraStatusViewSchema, CircleErrorSchema, type CameraStatusView } from "@walker/contracts";
import { LiveFrameReader, type LiveFrame } from "./cameraStream";
import { PhoneApiError, circleCall } from "./phoneApi";

/**
 * The live camera's client for the two-phone app (camera.ts in the contracts). Phone routes, the
 * `walker_member` cookie:
 * - GET /api/v1/circle/camera       → CameraStatusView
 * - PUT /api/v1/circle/camera       { enabled: true, consent: true } or { enabled: false } → { enabled } (her phone only)
 * - GET /api/v1/circle/camera/live  → the multipart stream of frames (an approved caretaker, while she shares)
 */
export interface CameraApi {
  status(signal?: AbortSignal): Promise<CameraStatusView>;
  setSharing(enabled: boolean): Promise<boolean>;
  /** Calls `onFrame` for each frame until the stream ends (resolves) or fails or `signal` aborts (rejects). */
  watch(onFrame: (frame: LiveFrame) => void, signal: AbortSignal): Promise<void>;
}

const BASE = "/api/v1/circle/camera";

export function createCameraApi(fetchImpl: typeof fetch = (...args) => fetch(...args)): CameraApi {
  return {
    status: (signal) => circleCall(fetchImpl, BASE, { method: "GET", signal }, CameraStatusViewSchema),
    async setSharing(enabled) {
      const body = JSON.stringify(enabled ? { enabled: true, consent: true } : { enabled: false });
      return (await circleCall(fetchImpl, BASE, { method: "PUT", body }, CameraSharingResponseSchema)).enabled;
    },
    async watch(onFrame, signal) {
      let response: Response;
      try {
        response = await fetchImpl(`${BASE}/live`, { signal, credentials: "same-origin", cache: "no-store" });
      } catch (error) {
        if (signal.aborted) throw error;
        throw new PhoneApiError("network", "Couldn't reach the server.", 0);
      }
      if (!response.ok || !response.body) {
        const parsed = CircleErrorSchema.safeParse(await response.json().catch(() => null));
        if (!parsed.success) throw new PhoneApiError(response.status === 404 ? "not_offered" : "unavailable", "The server's answer wasn't one the app knows.", response.status);
        throw new PhoneApiError(parsed.data.error.code, parsed.data.error.message, response.status);
      }
      const reader = response.body.getReader();
      const frames = new LiveFrameReader();
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (error) {
          if (signal.aborted) throw error;
          throw new PhoneApiError("network", "The live picture stopped.", 0);
        }
        if (chunk.done) return;
        for (const frame of frames.push(chunk.value)) onFrame(frame);
      }
    },
  };
}
