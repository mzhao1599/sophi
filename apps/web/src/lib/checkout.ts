import { ApiErrorSchema, type ModuleId } from "@walker/contracts";
import { z } from "zod";

/**
 * The mock purchase (Stripe test mode only). Only this web app calls these routes, so their shapes
 * live here rather than in packages/contracts. Nothing in this file is secret: the Stripe key stays
 * in src/server/checkout/. The placeholder prices live here so the walker sheet can show the same
 * total that Checkout will charge.
 */

/** Shown next to every price: the catalog's real cost for each module is "not measured". */
export const DEMO_PRICE_LABEL = "sample price";

/**
 * Placeholder prices for the mock purchase, in US cents. They are NOT real quotes: the catalog's
 * cost for every module is "not_measured". This is the only place a price is defined; every page
 * that shows one labels it as a sample amount.
 */
export const DEMO_PLACEHOLDER_PRICES_USD_CENTS: Record<ModuleId, number> = {
  "base.walker": 40_000,
  "controls.hand": 5_000,
  "perception.tof": 7_500,
  voice: 6_000,
  "manipulation.arm": 90_000,
  "manipulation.lift": 25_000,
  "location.gps": 4_000,
};

/** What Checkout would charge for these modules at the placeholder prices, in US cents. */
export function demoTotalCents(selected: readonly ModuleId[]): number {
  return selected.reduce((sum, id) => sum + DEMO_PLACEHOLDER_PRICES_USD_CENTS[id], 0);
}

/** "$1,675", or "$1,675.50" when there are cents. */
export function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
  }).format(cents / 100);
}

/** The walker sheet's price line, clearly marked as a sample amount. */
export function demoPriceLine(selected: readonly ModuleId[]): string {
  return `${formatUsd(demoTotalCents(selected))} sample total`;
}

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
