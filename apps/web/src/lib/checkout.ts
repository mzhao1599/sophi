import { ApiErrorSchema } from "@walker/contracts";
import { z } from "zod";

/**
 * The mock purchase (Stripe test mode only). Only this web app calls these routes, so their shapes
 * live here rather than in packages/contracts. Nothing in this file is secret: the Stripe key and
 * the placeholder prices stay in src/server/checkout/.
 */

/** Shown next to every price: the catalog's real cost for each module is "not measured". */
export const DEMO_PRICE_LABEL = "demo price, not a real quote";

export const CheckoutStatusSchema = z.object({
  enabled: z.boolean(),
  /** Why it's off: no STRIPE_SECRET_KEY, or a key that isn't an sk_test_ key (refused). */
  reason: z.enum(["ready", "missing_key", "not_test_key"]),
});
export type CheckoutStatus = z.infer<typeof CheckoutStatusSchema>;

/** POST /api/v1/onboarding/sessions/{id}/checkout. The modules come from the saved configuration on the server. */
export const CreateCheckoutRequestSchema = z.strictObject({
  /** The configuration the user is looking at; a mismatch is a 409 rather than buying something else. */
  configuration_version: z.number().int().positive(),
});
export type CreateCheckoutRequest = z.infer<typeof CreateCheckoutRequestSchema>;

export const STRIPE_CHECKOUT_ORIGIN = "https://checkout.stripe.com/";

export const CreateCheckoutResponseSchema = z.object({
  checkout_url: z.string().refine((url) => url.startsWith(STRIPE_CHECKOUT_ORIGIN), "Not a Stripe Checkout URL."),
});
export type CreateCheckoutResponse = z.infer<typeof CreateCheckoutResponseSchema>;

export async function fetchCheckoutStatus(): Promise<CheckoutStatus> {
  const response = await fetch("/api/v1/checkout/status", { cache: "no-store" });
  return CheckoutStatusSchema.parse(await response.json());
}

/** Asks the server for a Stripe test-mode Checkout page for this saved setup and returns its URL. */
export async function startCheckout(sessionId: string, configurationVersion: number): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`/api/v1/onboarding/sessions/${encodeURIComponent(sessionId)}/checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify({ configuration_version: configurationVersion } satisfies CreateCheckoutRequest),
    });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(body);
    throw new Error(parsed.success ? parsed.data.error.message : "Couldn't open the test checkout. Please try again.");
  }
  return CreateCheckoutResponseSchema.parse(body).checkout_url;
}
