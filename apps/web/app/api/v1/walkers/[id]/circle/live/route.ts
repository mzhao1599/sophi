import type { NextRequest } from "next/server";
import { circleError, circleRoute, circleService } from "@/server/circle";
import { fromThisSite, ownerCaller, walkerJson } from "@/server/walker";

type Context = { params: Promise<{ id: string }> };

/** POST /api/v1/walkers/{id}/circle/live — the owner's page's live connection to this walker's circle, or `live: null` (owner cookie). */
export async function POST(request: NextRequest, { params }: Context) {
  const { id } = await params;
  return circleRoute("walkers.circle.live", id, async () => {
    if (!fromThisSite(request)) return circleError("not_allowed", "That request came from another site.");
    return walkerJson(await circleService().ownerLive(ownerCaller(request), id));
  });
}
