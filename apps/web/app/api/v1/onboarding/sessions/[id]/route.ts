import { clearToken, handle, json, onboarding, readToken } from "@/server/onboarding";

type Context = { params: Promise<{ id: string }> };

/** GET /api/v1/onboarding/sessions/{id} — restore a session after a refresh. */
export async function GET(_request: Request, { params }: Context) {
  return handle(async () => {
    const { id } = await params;
    return json(await onboarding.get(id, await readToken(id)));
  });
}

/** DELETE /api/v1/onboarding/sessions/{id} — delete the session and everything in it now. */
export async function DELETE(_request: Request, { params }: Context) {
  return handle(async () => {
    const { id } = await params;
    await onboarding.remove(id, await readToken(id));
    await clearToken();
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  });
}
