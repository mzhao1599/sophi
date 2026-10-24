import { StartSessionRequestSchema } from "@walker/contracts";
import { handle, json, onboarding, parseBody, writeToken } from "@/server/onboarding";

/** POST /api/v1/onboarding/sessions — start a demo onboarding session. */
export async function POST(request: Request) {
  return handle(async () => {
    const body = await parseBody(request, StartSessionRequestSchema);
    if (body instanceof Response) return body;
    const { token, response } = await onboarding.start(body);
    await writeToken(response.session.session_id, token);
    return json(response, 201);
  });
}
