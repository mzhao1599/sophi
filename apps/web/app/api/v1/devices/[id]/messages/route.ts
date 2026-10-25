import { DeviceSendMessageRequestSchema } from "@walker/contracts";
import { MAX_BODY_BYTES, deviceCaller, readJson, walkerJson, walkerRoute, walkerService } from "@/server/walker";

type Context = { params: Promise<{ id: string }> };

/** The paired Pi calls this only after the left Confirm press accepted an exact spoken draft. */
export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  return walkerRoute("devices.message", id, async () => {
    const body = await readJson(request, DeviceSendMessageRequestSchema, MAX_BODY_BYTES);
    if (body instanceof Response) return body;
    return walkerJson(await walkerService().sendMessage(deviceCaller(request), id, body));
  });
}

/** GET: the newest messages a caretaker sent to her phone, which the walker reads aloud (polled after each heartbeat). */
export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  return walkerRoute("devices.messages", id, async () => walkerJson(await walkerService().incomingMessages(deviceCaller(request), id)));
}
