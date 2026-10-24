import { HeartbeatRequestSchema } from "@walker/contracts";
import { deviceCaller, readJson, walkerJson, walkerRoute, walkerService } from "@/server/walker";

type Context = { params: Promise<{ id: string }> };

/** POST /api/v1/devices/{id}/heartbeat — the Pi's report every 5 s; the answer names the configuration version and open proposal. */
export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  return walkerRoute("devices.heartbeat", id, async () => {
    const body = await readJson(request, HeartbeatRequestSchema);
    if (body instanceof Response) return body;
    return walkerJson(await walkerService().heartbeat(deviceCaller(request), id, body));
  });
}
