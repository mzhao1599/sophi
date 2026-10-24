import { PairDeviceRequestSchema } from "@walker/contracts";
import { clientAddress, readJson, walkerJson, walkerRoute, walkerService } from "@/server/walker";

/** POST /api/v1/devices/pair — the Pi claims a pairing code and gets its credential, shown this once. */
export async function POST(request: Request) {
  return walkerRoute("devices.pair", null, async () => {
    const body = await readJson(request, PairDeviceRequestSchema);
    if (body instanceof Response) return body;
    return walkerJson(await walkerService().pair(body, clientAddress(request.headers)), 201);
  });
}
