import { z } from "zod";
import { CircleNameSchema, MAX_CIRCLE_MEMBERS } from "./circle";

/**
 * The walker's live camera on a caretaker's phone, version 1 (docs/interfaces.md, "The live camera").
 *
 * Who sees it: only an approved caretaker's phone in the two-phone app, and only while her own phone has
 * camera sharing turned on (with her consent tap). Her phone sees who is watching right now. The owner's page
 * and her conversation never see a frame.
 *
 * The path, all over the routes the walker and the phones already use:
 * 1. The Pi asks `GET /api/v1/devices/{id}/camera` (its Bearer credential). The server answers at once when a
 *    caretaker is watching, otherwise after at most CAMERA_WAIT_MS with `wanted: false`, and the Pi asks again.
 *    The camera itself is opened only while `wanted` is true, so it is off whenever nobody watches.
 * 2. While wanted, the Pi posts each new JPEG to `POST /api/v1/devices/{id}/camera/frames`, one at a time, at
 *    most CAMERA_MAX_FPS. The answer says whether to keep sending; a slow link just drops frames.
 * 3. The caretaker's phone reads `GET /api/v1/circle/camera/live`, a multipart stream of the newest frames.
 *
 * With the walker's fall check on (WALKER_FALL_CHECK, devices/pi/README.md "Fall check"), the Pi keeps the camera
 * open to read body points on the walker; nothing more is sent here for that, and frames still go up only while
 * a caretaker watches.
 *
 * Retention: none. The server keeps only the newest frame of each walker, in memory, while someone watches; it
 * is dropped when the last viewer stops or sharing turns off, and never written to disk, the database or a log.
 * Sharing itself is in server memory too, so a server restart turns it off (it fails closed).
 */

/** The largest JPEG the server takes: 640 x 480 MJPEG from a UVC camera is usually 30 to 90 KB. */
export const CAMERA_FRAME_MAX_BYTES = 256_000;
/** The Pi sends at most this many frames a second. */
export const CAMERA_MAX_FPS = 10;
/** How long the server holds the Pi's wait open before answering `wanted: false`. */
export const CAMERA_WAIT_MS = 25_000;
/** The walker counts as having a camera while its last wait started this recently. */
export const CAMERA_LINK_FRESH_MS = CAMERA_WAIT_MS + 10_000;
/** One watch lasts at most this long; the phone then offers to watch again. */
export const CAMERA_WATCH_MAX_MS = 5 * 60_000;
/** The phone stops calling a picture live when its newest frame is older than this. */
export const CAMERA_FRAME_STALE_MS = 3_000;

/**
 * Where the frames come from. `test_pattern` is the simulator's generated picture (ffmpeg's test source),
 * never a camera: every phone that shows it says "Test pattern, not a camera".
 */
export const CameraSourceSchema = z.enum(["camera", "test_pattern"]);
export type CameraSource = z.infer<typeof CameraSourceSchema>;

// ---- The walker's routes (Bearer credential) ----

/** GET /api/v1/devices/{id}/camera?source=camera|test_pattern: waits up to CAMERA_WAIT_MS. */
export const CameraWaitResponseSchema = z.strictObject({ wanted: z.boolean() });
export type CameraWaitResponse = z.infer<typeof CameraWaitResponseSchema>;

/** The header on a posted frame naming its source (the body is the JPEG itself, `Content-Type: image/jpeg`). */
export const CAMERA_SOURCE_HEADER = "x-walker-camera-source";

/** POST /api/v1/devices/{id}/camera/frames. `keep_sending: false` once nobody watches or sharing is off. */
export const CameraFrameResponseSchema = z.strictObject({ keep_sending: z.boolean() });
export type CameraFrameResponse = z.infer<typeof CameraFrameResponseSchema>;

// ---- The phones' routes (`walker_member` cookie) ----

/** GET /api/v1/circle/camera: what this phone may do with the camera now. */
export const CameraStatusViewSchema = z.strictObject({
  /** Her phone has camera sharing on (and is still in the circle). */
  sharing: z.boolean(),
  /** This is her own phone, so it may turn sharing on or off. */
  can_change: z.boolean(),
  /** This is an approved caretaker's phone and sharing is on. */
  can_watch: z.boolean(),
  /** The walker is online and its camera link asked for viewers within CAMERA_LINK_FRESH_MS. */
  walker_camera: z.boolean(),
  /** What the walker said it sends, while `walker_camera` is true; null otherwise. */
  source: CameraSourceSchema.nullable(),
  /** Who is watching right now. Shown on her phone so she always knows; a caretaker sees it too. */
  watching: z.array(z.strictObject({ name: CircleNameSchema })).max(MAX_CIRCLE_MEMBERS),
});
export type CameraStatusView = z.infer<typeof CameraStatusViewSchema>;

/** PUT /api/v1/circle/camera, only from her own phone. Turning it off needs no consent flag. */
export const CameraSharingRequestSchema = z.union([
  z.strictObject({ enabled: z.literal(true), consent: z.literal(true) }),
  z.strictObject({ enabled: z.literal(false) }),
]);
export type CameraSharingRequest = z.infer<typeof CameraSharingRequestSchema>;
export const CameraSharingResponseSchema = z.strictObject({ enabled: z.boolean() });

/**
 * GET /api/v1/circle/camera/live: `multipart/x-mixed-replace; boundary=CAMERA_BOUNDARY`. Each part is
 *
 *   --walker-camera-frame\r\n
 *   Content-Type: image/jpeg\r\n
 *   Content-Length: <bytes>\r\n
 *   X-Frame-Seq: <the server's frame number for this walker, rising>\r\n
 *   X-Frame-Source: camera | test_pattern\r\n
 *   X-Frame-Age-Ms: <how long the server had held it when sent>\r\n
 *   \r\n
 *   <JPEG>\r\n
 *
 * A part is sent only when a newer frame arrives, so a quiet stream means no new picture. The stream ends
 * when sharing turns off, the phone leaves the circle, or after CAMERA_WATCH_MAX_MS; the phone then reads the
 * status to say why. Refusals before the stream starts are the circle's JSON errors.
 */
export const CAMERA_BOUNDARY = "walker-camera-frame";

/** True for bytes that start with a JPEG's SOI marker and end with its EOI marker. */
export function looksLikeJpeg(bytes: Uint8Array): boolean {
  const n = bytes.length;
  return n >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[n - 2] === 0xff && bytes[n - 1] === 0xd9;
}
