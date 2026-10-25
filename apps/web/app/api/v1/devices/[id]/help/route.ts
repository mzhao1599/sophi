import { DeviceAskForHelpRequestSchema } from "@walker/contracts";
import { deviceCaller, readJson, walkerJson, walkerRoute, walkerService } from "@/server/walker";

type Context = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/devices/{id}/help — the walker asks for help (both handle buttons held, or the voice countdown at
 * zero). `201` for a new request, `200` for the open one or a repeated `client_help_id`; `409 no_caretaker` keeps nothing.
 */
export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  return walkerRoute("devices.help.ask", id, async () => {
    const body = await readJson(request, DeviceAskForHelpRequestSchema);
    if (body instanceof Response) return body;
    const { created, response } = await walkerService().askForHelp(deviceCaller(request), id, body);
    return walkerJson(response, created ? 201 : 200);
  });
}

/** GET: the walker's open request, or the newest closed within 5 minutes, or null (polled after heartbeats). */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  return walkerRoute("devices.help", id, async () => walkerJson(await walkerService().help(deviceCaller(request), id)));
}
