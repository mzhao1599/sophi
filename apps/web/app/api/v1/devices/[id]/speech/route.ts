import { DeviceSpeechRequestSchema } from "@walker/contracts";
import { deviceCaller, readJson, walkerJson, walkerRoute, walkerService } from "@/server/walker";

type Context = { params: Promise<{ id: string }> };

/** A paired Pi requests the same voice used for assistant replies; this creates no turn. */
export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  return walkerRoute("devices.speech", id, async () => {
    const body = await readJson(request, DeviceSpeechRequestSchema);
    if (body instanceof Response) return body;
    return walkerJson(await walkerService().deviceSpeech(deviceCaller(request), id, body.text));
  });
}
