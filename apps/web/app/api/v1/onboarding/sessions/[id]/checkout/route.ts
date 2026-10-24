import { CreateCheckoutRequestSchema } from "@/lib/checkout";
import { createDemoCheckout } from "@/server/checkout/order";
import { getCheckout } from "@/server/checkout/stripe";
import { errorResponse, handle, json, onboardingRequest, parseBody } from "@/server/onboarding";

type Context = { params: Promise<{ id: string }> };

/**
 * POST /api/v1/onboarding/sessions/{id}/checkout — mock purchase of the saved setup in Stripe test
 * mode. The line items come from the confirmed configuration on the server, never from the request.
 * It lives under the onboarding path so ownership is checked the same way as every onboarding route:
 * the demo session's cookie, or the signed-in user who saved the setup to their account.
 */
export async function POST(request: Request, { params }: Context) {
  return handle(async () => {
    const access = getCheckout();
    if (!access.ok) return errorResponse("invalid_request", 503, "Mock purchase is off on this server. Nothing was charged.");
    const { id } = await params;
    const body = await parseBody(request, CreateCheckoutRequestSchema);
    if (body instanceof Response) return body;

    const { service, caller } = await onboardingRequest(id);
    const { session } = await service.get(id, caller);
    const configuration = session.configuration;
    if (session.state === "expired") {
      return errorResponse("session_expired", 410, "This setup session has expired. Start a new one to try the mock purchase.");
    }
    if (session.state !== "confirmed" || !configuration) {
      return errorResponse("invalid_request", 409, "Save your setup before trying the mock purchase.");
    }
    if (configuration.configuration_version !== body.configuration_version) {
      return errorResponse("revision_conflict", 409, "Your saved setup changed. Reload the page and try again.");
    }

    const result = await createDemoCheckout(access.client, { configuration, onboardingSessionId: id, origin: new URL(request.url).origin });
    if (!result.ok) return errorResponse("invalid_request", 502, "Couldn't open Stripe's test checkout. Nothing was charged. Please try again.");
    return json({ checkout_url: result.url }, 201);
  });
}
