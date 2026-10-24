import { AnswerProposalRequestSchema } from "@walker/contracts";
import { deviceCaller, readJson, walkerJson, walkerRoute, walkerService } from "@/server/walker";

type Context = { params: Promise<{ id: string; proposalId: string }> };

/** POST /api/v1/devices/{id}/proposals/{proposalId} — the walker's Confirm button. */
export async function POST(request: Request, { params }: Context) {
  const { id, proposalId } = await params;
  return walkerRoute("devices.answer", id, async () => {
    const body = await readJson(request, AnswerProposalRequestSchema);
    if (body instanceof Response) return body;
    return walkerJson(await walkerService().answer(deviceCaller(request), id, proposalId, body));
  });
}
