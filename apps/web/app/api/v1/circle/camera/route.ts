import type { NextRequest } from "next/server";
import { CameraSharingRequestSchema } from "@walker/contracts";
import { cameraService } from "@/server/camera";
import { circleError, circleRoute, memberCaller } from "@/server/circle";
import { fromThisSite, readJson, walkerJson } from "@/server/walker";

/** GET /api/v1/circle/camera — whether her camera is shared, who is watching, and what this phone may do. */
export async function GET(request: NextRequest) {
  return circleRoute("circle.camera", null, async () => walkerJson(await cameraService().status(memberCaller(request))));
}

/** PUT /api/v1/circle/camera — her own phone turns camera sharing on (with her consent) or off. */
export async function PUT(request: NextRequest) {
  return circleRoute("circle.camera.sharing", null, async () => {
    if (!fromThisSite(request)) return circleError("invalid_request", "Change camera sharing from the Sophi app.");
    const body = await readJson(request, CameraSharingRequestSchema);
    if (body instanceof Response) return body;
    return walkerJson(await cameraService().setSharing(memberCaller(request), body));
  });
}
