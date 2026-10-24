import { StartSessionRequestSchema } from "@walker/contracts";
import { handle, json, onboardingRequest, parseBody, writeToken } from "@/server/onboarding";

/**
 * POST /api/v1/onboarding/sessions — start a session of the kind the consent names: a demo session
 * (its secret goes in a cookie) or, for a signed-in user, an account session.
 */
export async function POST(request: Request) {
  return handle(async () => {
    const body = await parseBody(request, StartSessionRequestSchema);
    if (body instanceof Response) return body;
    const { service, caller } = await onboardingRequest();
    const { token, response } = await service.start(body, caller);
    if (token) await writeToken(response.session.session_id, token);
    return json(response, 201);
  });
}
