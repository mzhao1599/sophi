import { ConfirmRequestSchema } from "@walker/contracts";
import { handle, json, onboardingRequest, parseBody } from "@/server/onboarding";

type Context = { params: Promise<{ id: string }> };

/** POST /api/v1/onboarding/sessions/{id}/confirm — save the reviewed module selection (an account's next setup number, or 1 for a demo). */
export async function POST(request: Request, { params }: Context) {
  return handle(async () => {
    const { id } = await params;
    const body = await parseBody(request, ConfirmRequestSchema);
    if (body instanceof Response) return body;
    const { service, caller } = await onboardingRequest(id);
    return json(await service.confirm(id, caller, body));
  });
}
