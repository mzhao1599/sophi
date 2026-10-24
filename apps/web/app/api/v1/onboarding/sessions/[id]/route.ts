import { clearToken, handle, json, onboardingRequest } from "@/server/onboarding";

type Context = { params: Promise<{ id: string }> };

/** GET /api/v1/onboarding/sessions/{id} — restore a session after a refresh. */
export async function GET(_request: Request, { params }: Context) {
  return handle(async () => {
    const { id } = await params;
    const { service, caller } = await onboardingRequest(id);
    return json(await service.get(id, caller));
  });
}

/** DELETE /api/v1/onboarding/sessions/{id} — delete the session and everything in it now, including an account's setup saved from it. */
export async function DELETE(_request: Request, { params }: Context) {
  return handle(async () => {
    const { id } = await params;
    const { service, caller } = await onboardingRequest(id);
    await service.remove(id, caller);
    await clearToken();
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  });
}
