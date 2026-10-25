import { CAMERA_SOURCE_HEADER, CameraSourceSchema } from "@walker/contracts";
import { cameraService, quietCameraRoute, readJpeg } from "@/server/camera";
import { deviceCaller, walkerError, walkerJson } from "@/server/walker";

type Context = { params: Promise<{ id: string }> };

/** POST /api/v1/devices/{id}/camera/frames — one JPEG (image/jpeg) while a caretaker watches; the answer says whether to keep sending. */
export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  return quietCameraRoute("devices.camera.frame", id, async () => {
    const source = CameraSourceSchema.safeParse(request.headers.get(CAMERA_SOURCE_HEADER));
    if (!source.success) return walkerError("invalid_request", `${CAMERA_SOURCE_HEADER}: say camera or test_pattern.`);
    const jpeg = await readJpeg(request);
    if (!jpeg) return walkerError("invalid_request", "Send one JPEG of at most 256 KB as image/jpeg.");
    return walkerJson(await cameraService().deviceFrame(deviceCaller(request), id, jpeg, source.data));
  });
}
