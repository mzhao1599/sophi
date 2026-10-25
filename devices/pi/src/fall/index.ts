export { FallDetector, postureOf, type FallEvent, type FallWhy, type Posture } from "./detector";
export { FallWatch } from "./watch";
export { KEYPOINTS, MODEL_SIZE, letterbox, loadMoveNet, poseFromMoveNet, type Keypoint, type Letterbox, type Pose, type PoseModel } from "./pose";

/** Where scripts/get-pose-model.sh puts the model on the Pi. */
export const DEFAULT_POSE_MODEL = "/opt/steady-walker/models/movenet-singlepose-lightning.onnx";

/**
 * The fall check's settings: WALKER_FALL_CHECK (`on` to turn it on; it needs WALKER_CAMERA_DEVICE), WALKER_POSE_MODEL
 * (the ONNX file, default DEFAULT_POSE_MODEL) and WALKER_FALL_FPS (pictures read a second, default 5; placeholder,
 * not measured on the Pi).
 */
export function readFallSettings(env: NodeJS.ProcessEnv): { kind: "off" } | { kind: "on"; modelPath: string; fps: number } | { kind: "error"; reason: string } {
  const flag = env.WALKER_FALL_CHECK?.trim().toLowerCase() ?? "";
  if (flag === "" || flag === "off" || flag === "0") return { kind: "off" };
  if (flag !== "on" && flag !== "1") return { kind: "error", reason: "WALKER_FALL_CHECK must be on or off." };
  const fps = Number(env.WALKER_FALL_FPS?.trim() || "5");
  if (!Number.isInteger(fps) || fps < 1 || fps > 15) return { kind: "error", reason: "WALKER_FALL_FPS must be a whole number from 1 to 15." };
  const modelPath = env.WALKER_POSE_MODEL?.trim() || DEFAULT_POSE_MODEL;
  return { kind: "on", modelPath, fps };
}
