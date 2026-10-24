import { ProfileEditRequestSchema } from "@walker/contracts";
import { handle, json, onboarding, parseBody, readToken } from "@/server/onboarding";

type Context = { params: Promise<{ id: string }> };

/** PATCH /api/v1/onboarding/sessions/{id}/profile — edit or remove one item under "What I understood". */
export async function PATCH(request: Request, { params }: Context) {
  return handle(async () => {
    const { id } = await params;
    const body = await parseBody(request, ProfileEditRequestSchema);
    if (body instanceof Response) return body;
    return json(await onboarding.editProfile(id, await readToken(id), body));
  });
}
