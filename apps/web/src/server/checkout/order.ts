import "server-only";
import { MODULE_CATALOG, ModuleIdSchema, getCatalogEntry, type DeviceConfiguration, type ModuleId } from "@walker/contracts";
import type Stripe from "stripe";
import { PRODUCT_NAME } from "@/lib/brand";
import { DEMO_PLACEHOLDER_PRICES_USD_CENTS, DEMO_PRICE_LABEL, STRIPE_CHECKOUT_ORIGIN } from "@/lib/checkout";

// The placeholder price table lives in src/lib/checkout.ts so the walker sheet can show the same total.
export { DEMO_PLACEHOLDER_PRICES_USD_CENTS };

/** Said on every Checkout line under the module's own summary. */
const LINE_NOTE = "Experimental prototype module, not a certified mobility aid. Test mode: nothing is charged or shipped.";

/** Marks Checkout Sessions this app made, so the success page refuses anyone else's. */
export const CHECKOUT_APP_TAG = "assistive-walker-mock-purchase";

const STRIPE_PAGE_NOTE =
  "Test mode, no real charge. Pay with Stripe's test card 4242 4242 4242 4242, any future date and any CVC. " +
  `Prices are demo prices, not a real quote. ${PRODUCT_NAME} is an experimental prototype, not a certified mobility aid, and nothing will ship.`;

/** The part of the Stripe client this feature uses, so tests can pass a stub. */
export interface CheckoutClient {
  checkout: {
    sessions: {
      create(params: Stripe.Checkout.SessionCreateParams): Promise<Pick<Stripe.Checkout.Session, "url" | "livemode">>;
      retrieve(
        id: string,
      ): Promise<Pick<Stripe.Checkout.Session, "id" | "livemode" | "status" | "payment_status" | "metadata" | "amount_total" | "currency">>;
      listLineItems(
        id: string,
        params: { limit: number },
      ): Promise<{ data: Array<Pick<Stripe.LineItem, "metadata" | "description" | "amount_total" | "currency">> }>;
    };
  };
}

/**
 * One line per selected module, quantity 1, priced from the placeholder table. Each line says what the
 * module does in the catalog's plain words, never the person's own answers: Checkout data goes to Stripe.
 */
export function buildLineItems(
  configuration: Pick<DeviceConfiguration, "selected_module_ids">,
): Stripe.Checkout.SessionCreateParams.LineItem[] {
  return configuration.selected_module_ids.map((id) => {
    const entry = getCatalogEntry(MODULE_CATALOG, id);
    return {
      quantity: 1,
      metadata: { module_id: id },
      price_data: {
        currency: "usd",
        unit_amount: DEMO_PLACEHOLDER_PRICES_USD_CENTS[id],
        product_data: {
          name: `${entry.name} (${DEMO_PRICE_LABEL})`,
          description: `${entry.summary} ${LINE_NOTE}`,
        },
      },
    };
  });
}

export function checkoutParams(input: {
  configuration: Pick<DeviceConfiguration, "configuration_version" | "selected_module_ids">;
  onboardingSessionId: string;
  origin: string;
  now?: Date;
}): Stripe.Checkout.SessionCreateParams {
  const now = Math.floor((input.now ?? new Date()).getTime() / 1000);
  return {
    mode: "payment",
    line_items: buildLineItems(input.configuration),
    success_url: `${input.origin}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.origin}/checkout/cancelled`,
    // Only ids, never answers: enough to match the order to a demo session in the Stripe dashboard.
    metadata: {
      app: CHECKOUT_APP_TAG,
      onboarding_session_id: input.onboardingSessionId,
      configuration_version: String(input.configuration.configuration_version),
    },
    // Card only. Link is a wallet on top of cards that offers to save details (and asks for a phone
    // number), so it is hidden too. No customer record, no shipping address, no phone number; Stripe
    // still asks for an email, and a made-up one works in test mode.
    allowed_payment_method_types: ["card"],
    wallet_options: { link: { display: "never" } },
    customer_creation: "if_required",
    billing_address_collection: "auto",
    submit_type: "pay",
    custom_text: { submit: { message: STRIPE_PAGE_NOTE } },
    expires_at: now + 60 * 60,
  };
}

export type CreateResult = { ok: true; url: string } | { ok: false };

/** Creates the hosted Checkout page. Refuses anything that isn't a test-mode session on checkout.stripe.com. */
export async function createDemoCheckout(client: CheckoutClient, input: Parameters<typeof checkoutParams>[0]): Promise<CreateResult> {
  let session: Awaited<ReturnType<CheckoutClient["checkout"]["sessions"]["create"]>>;
  try {
    session = await client.checkout.sessions.create(checkoutParams(input));
  } catch (error) {
    console.error(`[checkout] Stripe refused the Checkout Session: ${stripeErrorType(error)}`);
    return { ok: false };
  }
  if (session.livemode) {
    console.error("[checkout] Stripe returned a live-mode Checkout Session; refusing to send anyone to it.");
    return { ok: false };
  }
  if (!session.url?.startsWith(STRIPE_CHECKOUT_ORIGIN)) {
    console.error("[checkout] Stripe returned no hosted Checkout URL.");
    return { ok: false };
  }
  return { ok: true, url: session.url };
}

export type DemoOrderLine = { module_id: ModuleId | null; name: string; amount: number; currency: string };

export type DemoOrder =
  | { kind: "paid"; lines: DemoOrderLine[]; total: number; currency: string; configuration_version: string | null }
  | { kind: "unpaid" }
  | { kind: "not_found" }
  | { kind: "error" };

// Test-mode Checkout Session ids only. A live id (cs_live_…) is never looked up.
const TEST_SESSION_ID = /^cs_test_[A-Za-z0-9]{1,250}$/;

/**
 * What the success page shows, read from Stripe on the server. The session id in the URL is only a
 * lookup key: an unknown id, a session another app made, a live one, or one that isn't paid shows no order.
 */
export async function loadDemoOrder(client: CheckoutClient, sessionId: string | undefined): Promise<DemoOrder> {
  if (!sessionId || !TEST_SESSION_ID.test(sessionId)) return { kind: "not_found" };
  try {
    const session = await client.checkout.sessions.retrieve(sessionId);
    if (session.livemode || session.metadata?.app !== CHECKOUT_APP_TAG) return { kind: "not_found" };
    if (session.status !== "complete" || session.payment_status !== "paid") return { kind: "unpaid" };
    const items = await client.checkout.sessions.listLineItems(sessionId, { limit: 100 });
    const lines = items.data.map((item): DemoOrderLine => {
      const id = ModuleIdSchema.safeParse(item.metadata?.module_id);
      return {
        module_id: id.success ? id.data : null,
        name: id.success ? getCatalogEntry(MODULE_CATALOG, id.data).name : (item.description ?? "Module"),
        amount: item.amount_total,
        currency: item.currency,
      };
    });
    return {
      kind: "paid",
      lines,
      total: session.amount_total ?? lines.reduce((sum, line) => sum + line.amount, 0),
      currency: session.currency ?? "usd",
      configuration_version: session.metadata?.configuration_version ?? null,
    };
  } catch (error) {
    if (isNotFound(error)) return { kind: "not_found" };
    console.error(`[checkout] Couldn't read the Checkout Session: ${stripeErrorType(error)}`);
    return { kind: "error" };
  }
}

function isNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const e = error as { statusCode?: unknown; code?: unknown };
  return e.statusCode === 404 || e.code === "resource_missing";
}

/** Logs only the error's type and code, never request details. */
function stripeErrorType(error: unknown): string {
  if (typeof error === "object" && error !== null && "type" in error) {
    const e = error as { type?: unknown; code?: unknown };
    return `type=${String(e.type)}${typeof e.code === "string" ? ` code=${e.code}` : ""}`;
  }
  return error instanceof Error ? error.name : "unknown";
}
