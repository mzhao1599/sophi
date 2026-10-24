import { DeviceTurnRequestSchema } from "@walker/contracts";
import { MAX_TURN_BODY_BYTES, deviceCaller, readJson, walkerJson, walkerRoute, walkerService } from "@/server/walker";

type Context = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/devices/{id}/turns — a question from the walker: a voice clip (WAV, up to 1 MB) or text,
 * with its snapshot. The clip goes to the model with the turn and is then dropped: never stored or logged.
 */
export async function POST(request: Request, { params }: Context) {
  // The turn's time budget counts from here, so reading the upload is inside it.
  const receivedAt = Date.now();
  const { id } = await params;
  return walkerRoute("devices.turn", id, async () => {
    const body = await readJson(request, DeviceTurnRequestSchema, MAX_TURN_BODY_BYTES);
    if (body instanceof Response) return body;
    return walkerJson(await walkerService().turn(deviceCaller(request), id, body, receivedAt));
  });
}
