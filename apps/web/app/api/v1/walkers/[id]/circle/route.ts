import type { NextRequest } from "next/server";
import { circleRoute, circleService } from "@/server/circle";
import { ownerCaller, walkerJson } from "@/server/walker";

type Context = { params: Promise<{ id: string }> };

/** GET /api/v1/walkers/{id}/circle — the phones, open codes and caretakers waiting for approval (owner cookie). */
export async function GET(request: NextRequest, { params }: Context) {
  const { id } = await params;
  return circleRoute("walkers.circle", id, async () => walkerJson(await circleService().ownerCircle(ownerCaller(request), id)));
}
