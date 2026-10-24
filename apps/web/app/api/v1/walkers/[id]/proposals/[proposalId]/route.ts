import type { NextRequest } from "next/server";
import { AnswerProposalRequestSchema } from "@walker/contracts";
import { ownerCaller, readJson, walkerJson, walkerRoute, walkerService } from "@/server/walker";

type Context = { params: Promise<{ id: string; proposalId: string }> };

/** POST /api/v1/walkers/{id}/proposals/{proposalId} — the page's Confirm or Decline. */
export async function POST(request: NextRequest, { params }: Context) {
  const { id, proposalId } = await params;
  return walkerRoute("walkers.answer", id, async () => {
    const body = await readJson(request, AnswerProposalRequestSchema);
    if (body instanceof Response) return body;
    return walkerJson(await walkerService().answer(ownerCaller(request), id, proposalId, body));
  });
}
