import type { NextRequest } from "next/server";
import { PageTurnRequestSchema } from "@walker/contracts";
import { ownerCaller, readJson, walkerJson, walkerRoute, walkerService } from "@/server/walker";

type Context = { params: Promise<{ id: string }> };

/** POST /api/v1/walkers/{id}/turns — a typed question from the owner's page. Page turns are never spoken. */
export async function POST(request: NextRequest, { params }: Context) {
  const receivedAt = Date.now();
  const { id } = await params;
  return walkerRoute("walkers.turn", id, async () => {
    const body = await readJson(request, PageTurnRequestSchema);
    if (body instanceof Response) return body;
    return walkerJson(await walkerService().turn(ownerCaller(request), id, body, receivedAt));
  });
}
