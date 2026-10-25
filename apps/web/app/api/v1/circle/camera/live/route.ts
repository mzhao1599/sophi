import { NextResponse, type NextRequest } from "next/server";
import { CAMERA_BOUNDARY } from "@walker/contracts";
import { cameraService } from "@/server/camera";
import { circleRoute, memberCaller } from "@/server/circle";

/** GET /api/v1/circle/camera/live — a caretaker's watch: the walker's newest frames as a multipart stream. */
export async function GET(request: NextRequest) {
  return circleRoute("circle.camera.live", null, async () => {
    const body = await cameraService().watch(memberCaller(request), request.signal);
    return new NextResponse(body, {
      headers: {
        "Content-Type": `multipart/x-mixed-replace; boundary=${CAMERA_BOUNDARY}`,
        "Cache-Control": "no-store, no-transform",
        // Proxies must pass each frame on as it comes, not hold the stream.
        "X-Accel-Buffering": "no",
      },
    });
  });
}
