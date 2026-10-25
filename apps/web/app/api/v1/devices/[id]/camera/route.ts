import { CameraSourceSchema } from "@walker/contracts";
import { cameraService } from "@/server/camera";
import { deviceCaller, walkerError, walkerJson, walkerRoute } from "@/server/walker";

type Context = { params: Promise<{ id: string }> };

/** GET /api/v1/devices/{id}/camera?source=camera|test_pattern — the walker's long wait for a caretaker to watch (up to 25 s). */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  return walkerRoute("devices.camera.wait", id, async () => {
    const source = CameraSourceSchema.safeParse(new URL(request.url).searchParams.get("source"));
    if (!source.success) return walkerError("invalid_request", "source: say camera or test_pattern.");
    return walkerJson(await cameraService().deviceWait(deviceCaller(request), id, source.data, request.signal));
  });
}
