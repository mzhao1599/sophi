import type { NextRequest } from "next/server";
import { circleRoute, circleService, memberCaller } from "@/server/circle";
import { walkerJson } from "@/server/walker";

/** GET /api/v1/circle — a phone's home: waiting, no answer, or in, with the walker's status and its messages (member cookie). */
export async function GET(request: NextRequest) {
  return circleRoute("circle.home", null, async () => walkerJson(await circleService().home(memberCaller(request))));
}
