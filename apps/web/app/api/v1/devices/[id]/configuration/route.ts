import { deviceCaller, walkerJson, walkerRoute, walkerService } from "@/server/walker";

type Context = { params: Promise<{ id: string }> };

/** GET /api/v1/devices/{id}/configuration — the walker's current configuration. */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  return walkerRoute("devices.configuration", id, async () => walkerJson(await walkerService().configuration(deviceCaller(request), id)));
}
