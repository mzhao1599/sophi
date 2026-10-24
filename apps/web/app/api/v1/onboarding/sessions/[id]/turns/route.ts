import { TurnRequestSchema } from "@walker/contracts";
import { handle, json, onboardingRequest, parseBody } from "@/server/onboarding";

type Context = { params: Promise<{ id: string }> };

/** POST /api/v1/onboarding/sessions/{id}/turns — answer, skip or revisit a question. */
export async function POST(request: Request, { params }: Context) {
  return handle(async () => {
    const { id } = await params;
    const body = await parseBody(request, TurnRequestSchema);
    if (body instanceof Response) return body;
    const { service, caller } = await onboardingRequest(id);
    return json(await service.turn(id, caller, body));
  });
}
