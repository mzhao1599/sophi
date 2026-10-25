/**
 * Body points from one camera frame, and the pose model that finds them (docs: devices/pi/README.md, "Fall check").
 *
 * The model is MoveNet SinglePose Lightning (Google, Apache-2.0), as ONNX: one 192 x 192 RGB picture in, 17 body
 * points out, each a position and a confidence. It finds one person, the most prominent. It runs on the Pi's CPU
 * through onnxruntime-node, which is not bundled into walker.mjs (it is a native module): the Pi installs it beside
 * walker.mjs, and the walker loads it only when the fall check is on. Nothing here sends a frame anywhere.
 */

/** MoveNet's 17 points (the COCO order). */
export const KEYPOINTS = [
  "nose",
  "left_eye",
  "right_eye",
  "left_ear",
  "right_ear",
  "left_shoulder",
  "right_shoulder",
  "left_elbow",
  "right_elbow",
  "left_wrist",
  "right_wrist",
  "left_hip",
  "right_hip",
  "left_knee",
  "right_knee",
  "left_ankle",
  "right_ankle",
] as const;
export type KeypointName = (typeof KEYPOINTS)[number];

/** One body point. `x` and `y` are fractions of the camera frame (0 to 1, `y` down); `score` is the model's confidence. */
export interface Keypoint {
  x: number;
  y: number;
  score: number;
}

/** All 17 points, in KEYPOINTS order. */
export type Pose = Keypoint[];

/** MoveNet Lightning's input side, in pixels. */
export const MODEL_SIZE = 192;

/**
 * How a frame is fitted into the model's square without stretching: scaled to fit, centred, the rest black.
 * ffmpeg does this before the walker sees the picture (`scale` then `pad`), so the walker gets MODEL_SIZE^2 RGB.
 */
export interface Letterbox {
  /** The model's square side. */
  size: number;
  /** The scaled picture's size inside it (even numbers, which ffmpeg's scaler wants). */
  width: number;
  height: number;
  /** Where the scaled picture starts. */
  padX: number;
  padY: number;
}

export function letterbox(frameWidth: number, frameHeight: number, size = MODEL_SIZE): Letterbox {
  const scale = Math.min(size / frameWidth, size / frameHeight);
  const even = (n: number) => Math.max(2, Math.min(size, 2 * Math.round((n * scale) / 2)));
  const width = even(frameWidth);
  const height = even(frameHeight);
  return { size, width, height, padX: Math.floor((size - width) / 2), padY: Math.floor((size - height) / 2) };
}

/**
 * MoveNet's output, `[1, 1, 17, 3]` as (y, x, score) in the padded square, turned into points on the camera frame.
 * A point in the black border is clamped to the frame's edge; its score is kept as the model gave it.
 */
export function poseFromMoveNet(output: ArrayLike<number>, box: Letterbox): Pose {
  if (output.length < KEYPOINTS.length * 3) throw new Error(`MoveNet output has ${output.length} numbers; expected ${KEYPOINTS.length * 3}`);
  const clamp = (n: number) => Math.min(1, Math.max(0, n));
  const pose: Pose = [];
  for (let i = 0; i < KEYPOINTS.length; i += 1) {
    const y = output[i * 3]!;
    const x = output[i * 3 + 1]!;
    const score = output[i * 3 + 2]!;
    pose.push({
      x: clamp((x * box.size - box.padX) / box.width),
      y: clamp((y * box.size - box.padY) / box.height),
      score: Number.isFinite(score) ? score : 0,
    });
  }
  return pose;
}

/** Finds the body points in one MODEL_SIZE x MODEL_SIZE RGB picture. */
export interface PoseModel {
  estimate(rgb: Uint8Array): Promise<Pose>;
  close(): Promise<void>;
}

/** The part of onnxruntime-node the walker uses (declared here, so the walker builds without it installed). */
interface OrtTensor {
  readonly data: ArrayLike<number>;
}
interface OrtSession {
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, OrtTensor>): Promise<Record<string, OrtTensor>>;
  release(): Promise<void>;
}
interface OrtModule {
  Tensor: new (type: "int32", data: Int32Array, dims: number[]) => OrtTensor;
  InferenceSession: { create(path: string, options?: { intraOpNumThreads?: number; executionMode?: "sequential" }): Promise<OrtSession> };
}

/** The package name, kept in a variable so neither esbuild nor TypeScript tries to resolve it at build time. */
const ORT_PACKAGE = "onnxruntime-node";

/**
 * Loads MoveNet from an ONNX file. Throws with a plain reason when onnxruntime-node isn't installed beside
 * walker.mjs or the file can't be read. `threads` keeps the model off the cores the rest of the walker uses.
 */
export async function loadMoveNet(modelPath: string, box: Letterbox, options: { threads?: number; importOrt?: () => Promise<OrtModule> } = {}): Promise<PoseModel> {
  let ort: OrtModule;
  try {
    ort = options.importOrt ? await options.importOrt() : ((await import(ORT_PACKAGE)) as OrtModule);
  } catch {
    throw new Error(`${ORT_PACKAGE} isn't installed beside walker.mjs (see "Fall check" in devices/pi/README.md)`);
  }
  const session = await ort.InferenceSession.create(modelPath, { intraOpNumThreads: options.threads ?? 1, executionMode: "sequential" });
  const input = session.inputNames[0];
  const output = session.outputNames[0];
  if (!input || !output) throw new Error("the pose model has no input or output");
  const pixels = box.size * box.size * 3;
  const buffer = new Int32Array(pixels);
  return {
    async estimate(rgb) {
      if (rgb.length !== pixels) throw new Error(`a pose picture must be ${pixels} bytes; got ${rgb.length}`);
      for (let i = 0; i < pixels; i += 1) buffer[i] = rgb[i]!;
      const result = await session.run({ [input]: new ort.Tensor("int32", buffer, [1, box.size, box.size, 3]) });
      return poseFromMoveNet(result[output]!.data, box);
    },
    close: () => session.release(),
  };
}
