import type { NextRequest } from "next/server";
import { ApproveJoinRequestSchema } from "@walker/contracts";
import { circleError, circleRoute, circleService } from "@/server/circle";
import { fromThisSite, ownerCaller, readJson, walkerJson } from "@/server/walker";

type Context = { params: Promise<{ id: string; memberId: string }> };

/**
 * POST /api/v1/walkers/{id}/circle/joins/{memberId} — the owner approves a waiting caretaker, with the
 * consent line confirmed (owner cookie). Declining is DELETE /circle/members/{memberId}.
 */
export async function POST(request: NextRequest, { params }: Context) {
  const { id, memberId } = await params;
  return circleRoute("walkers.circle.approve", id, async () => {
    if (!fromThisSite(request)) return circleError("invalid_request", "Approve a phone from the Your walker page.");
    const body = await readJson(request, ApproveJoinRequestSchema);
    if (body instanceof Response) return body;
    return walkerJson(await circleService().approveJoin(ownerCaller(request), id, memberId, body));
  });
}
