import { deviceCaller, walkerJson, walkerRoute, walkerService } from "@/server/walker";

type Context = { params: Promise<{ id: string; helpId: string }> };

/** POST /api/v1/devices/{id}/help/{helpId}/okay, no body — her second Confirm on the walker closes it `okay`. */
export async function POST(request: Request, { params }: Context) {
  const { id, helpId } = await params;
  return walkerRoute("devices.help.okay", id, async () => walkerJson(await walkerService().helpOkay(deviceCaller(request), id, helpId)));
}
