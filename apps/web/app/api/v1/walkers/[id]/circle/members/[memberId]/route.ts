import type { NextRequest } from "next/server";
import { circleRoute, circleService, noContent } from "@/server/circle";
import { ownerCaller } from "@/server/walker";

type Context = { params: Promise<{ id: string; memberId: string }> };

/** DELETE /api/v1/walkers/{id}/circle/members/{memberId} — remove a phone (or decline a waiting one); its messages go at once. */
export async function DELETE(request: NextRequest, { params }: Context) {
  const { id, memberId } = await params;
  return circleRoute("walkers.circle.remove", id, async () => {
    await circleService().removeMember(ownerCaller(request), id, memberId);
    return noContent();
  });
}
