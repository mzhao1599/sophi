import { checkoutStatus, getCheckout } from "@/server/checkout/stripe";
import { json } from "@/server/onboarding";

// Read the key on every request, never at build time.
export const dynamic = "force-dynamic";

/** GET /api/v1/checkout/status — whether the mock purchase button is on. Says why it's off, never anything about the key. */
export function GET() {
  return json(checkoutStatus(getCheckout()));
}
