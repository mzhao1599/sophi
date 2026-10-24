import { ConfirmRequestSchema } from "@walker/contracts";
import { handle, json, onboarding, parseBody, readToken } from "@/server/onboarding";

type Context = { params: Promise<{ id: string }> };

/** POST /api/v1/onboarding/sessions/{id}/confirm — save the reviewed module selection as configuration 1. */
export async function POST(request: Request, { params }: Context) {
  return handle(async () => {
    const { id } = await params;
    const body = await parseBody(request, ConfirmRequestSchema);
    if (body instanceof Response) return body;
    return json(await onboarding.confirm(id, await readToken(id), body));
  });
}
