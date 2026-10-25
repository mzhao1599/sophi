import type { NextRequest } from "next/server";
import { circleError, circleRoute, circleService, memberCaller } from "@/server/circle";
import { fromThisSite, walkerJson } from "@/server/walker";

/** POST /api/v1/circle/live — this phone's live connection to SpacetimeDB, or `live: null` (member cookie). */
export async function POST(request: NextRequest) {
  return circleRoute("circle.live", null, async () => {
    if (!fromThisSite(request)) return circleError("not_allowed", "That request came from another site.");
    return walkerJson(await circleService().phoneLive(memberCaller(request)));
  });
}
