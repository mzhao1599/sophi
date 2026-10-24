import type { NextRequest } from "next/server";
import { LocationSharingRequestSchema } from "@walker/contracts";
import { circleError, circleRoute, circleService, memberCaller } from "@/server/circle";
import { fromThisSite, readJson, walkerJson } from "@/server/walker";

/** Her approved phone can turn caregiver GPS sharing on or off; the fix is erased immediately on either change. */
export async function PUT(request: NextRequest) {
  return circleRoute("circle.location-sharing", null, async () => {
    if (!fromThisSite(request)) return circleError("invalid_request", "Change sharing from the Sophi app.");
    const body = await readJson(request, LocationSharingRequestSchema);
    if (body instanceof Response) return body;
    return walkerJson(await circleService().locationSharing(memberCaller(request), body));
  });
}
