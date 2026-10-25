import { MODULE_CATALOG, type ModuleId } from "@walker/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEMO_PRICE_LABEL, demoPriceLine, demoTotalCents, formatUsd } from "@/lib/checkout";
import { checkStripeKey } from "@/server/checkout/key";
import {
  CHECKOUT_APP_TAG,
  DEMO_PLACEHOLDER_PRICES_USD_CENTS,
  buildLineItems,
  checkoutParams,
  createDemoCheckout,
  loadDemoOrder,
  type CheckoutClient,
} from "@/server/checkout/order";

// Shaped like real keys, but made up.
const TEST_KEY = "sk_test_51FakeKeyForUnitTests0000";
const LIVE_KEY = "sk_live_51FakeKeyForUnitTests0000";
const RESTRICTED_LIVE_KEY = "rk_live_51FakeKeyForUnitTests0000";

type Retrieved = Awaited<ReturnType<CheckoutClient["checkout"]["sessions"]["retrieve"]>>;
type Listed = Awaited<ReturnType<CheckoutClient["checkout"]["sessions"]["listLineItems"]>>;

function stubClient(overrides: {
  create?: CheckoutClient["checkout"]["sessions"]["create"];
  retrieve?: (id: string) => Promise<Retrieved>;
  list?: Listed;
}) {
  const sessions = {
    create: vi.fn(overrides.create ?? (async () => ({ url: "https://checkout.stripe.com/c/pay/cs_test_abc", livemode: false }))),
    retrieve: vi.fn(overrides.retrieve ?? (async () => paidSession())),
    listLineItems: vi.fn(async () => overrides.list ?? { data: [] }),
  };
  return { client: { checkout: { sessions } } satisfies CheckoutClient, sessions };
}

function paidSession(over: Partial<Retrieved> = {}): Retrieved {
  return {
    id: "cs_test_abc",
    livemode: false,
    status: "complete",
    payment_status: "paid",
    metadata: { app: CHECKOUT_APP_TAG, onboarding_session_id: "s-1", configuration_version: "1" },
    amount_total: 45_000,
    currency: "usd",
    ...over,
  };
}

const lineItem = (module_id: string, amount_total: number) => ({
  metadata: { module_id },
  description: "ignored when the module id is known",
  amount_total,
  currency: "usd",
});

let errors: ReturnType<typeof vi.spyOn>;
let infos: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => {});
  infos = vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function logged(): string {
  return [...errors.mock.calls, ...infos.mock.calls].flat().join("\n");
}

describe("test-mode key guard", () => {
  it("accepts only a Stripe test secret key", () => {
    expect(checkStripeKey(TEST_KEY)).toEqual({ ok: true, key: TEST_KEY });
    expect(checkStripeKey(` ${TEST_KEY}\n`)).toEqual({ ok: true, key: TEST_KEY });
  });

  it("refuses live, restricted-live and publishable-live keys", () => {
    for (const key of [LIVE_KEY, RESTRICTED_LIVE_KEY, "pk_live_51FakeKeyForUnitTests0000"]) {
      expect(checkStripeKey(key)).toEqual({ ok: false, reason: "live" });
    }
  });

  it("refuses keys that aren't sk_test_ secret keys", () => {
    for (const key of ["rk_test_51Fake", "pk_test_51Fake", "sk_test_", "sk_test_has space", "not-a-key"]) {
      expect(checkStripeKey(key)).toEqual({ ok: false, reason: "not_test" });
    }
  });

  it("treats a missing or blank key as off", () => {
    for (const key of [undefined, "", "   "]) expect(checkStripeKey(key)).toEqual({ ok: false, reason: "missing" });
  });
});

describe("getCheckout", () => {
  async function fresh() {
    vi.resetModules();
    return import("@/server/checkout/stripe");
  }
  const stub = () => vi.fn((_key: string) => stubClient({}).client);

  it("builds one client from a test key and reports the button as on", async () => {
    const { getCheckout, checkoutStatus } = await fresh();
    const create = stub();
    const first = getCheckout({ STRIPE_SECRET_KEY: TEST_KEY }, create);
    const second = getCheckout({ STRIPE_SECRET_KEY: TEST_KEY }, create);
    expect(first.ok && second.ok && first.client === second.client).toBe(true);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(TEST_KEY);
    expect(checkoutStatus(first)).toEqual({ enabled: true, reason: "ready" });
  });

  it.each([
    ["live", LIVE_KEY],
    ["restricted live", RESTRICTED_LIVE_KEY],
  ])("refuses a %s key: no client, one error log without the key, button off", async (_name, key) => {
    const { getCheckout, checkoutStatus } = await fresh();
    const create = stub();
    const access = getCheckout({ STRIPE_SECRET_KEY: key }, create);
    getCheckout({ STRIPE_SECRET_KEY: key }, create);
    expect(access).toEqual({ ok: false, reason: "live" });
    expect(create).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledTimes(1);
    expect(logged()).toContain("Refusing to start mock purchase");
    expect(logged()).not.toContain(key);
    expect(logged()).not.toContain("FakeKey");
    expect(checkoutStatus(access)).toEqual({ enabled: false, reason: "not_test_key" });
  });

  it("is off without a key and says so once", async () => {
    const { getCheckout, checkoutStatus } = await fresh();
    const create = stub();
    const access = getCheckout({}, create);
    getCheckout({ STRIPE_SECRET_KEY: "" }, create);
    expect(access).toEqual({ ok: false, reason: "missing" });
    expect(create).not.toHaveBeenCalled();
    expect(infos).toHaveBeenCalledTimes(1);
    expect(errors).not.toHaveBeenCalled();
    expect(checkoutStatus(access)).toEqual({ enabled: false, reason: "missing_key" });
  });
});

describe("line items from a configuration", () => {
  it("makes one line per selected module, in order, priced from the placeholder table", () => {
    const selected: ModuleId[] = ["base.walker", "controls.hand", "perception.tof"];
    const items = buildLineItems({ selected_module_ids: selected });
    expect(items.map((i) => i.metadata?.module_id)).toEqual(selected);
    for (const [i, id] of selected.entries()) {
      const item = items[i]!;
      const name = MODULE_CATALOG.modules.find((m) => m.id === id)!.name;
      expect(item.quantity).toBe(1);
      expect(item.price_data?.currency).toBe("usd");
      expect(item.price_data?.unit_amount).toBe(DEMO_PLACEHOLDER_PRICES_USD_CENTS[id]);
      expect(item.price_data?.product_data?.name).toBe(`${name} (${DEMO_PRICE_LABEL})`);
    }
  });

  it("describes each line with the catalog's summary of the module and the test-mode note, never the person's words", () => {
    const items = buildLineItems({ selected_module_ids: ["perception.tof"] });
    const summary = MODULE_CATALOG.modules.find((m) => m.id === "perception.tof")!.summary;
    expect(items[0]!.price_data?.product_data?.description).toBe(
      `${summary} Experimental prototype module, not a certified mobility aid. Test mode: nothing is charged or shipped.`,
    );
  });

  it("totals the walker sheet's price exactly as Checkout charges it", () => {
    // Wren's walker after she switches on the arms and lift: the total the rehearsal paid on Stripe.
    const wren: ModuleId[] = ["base.walker", "controls.hand", "perception.tof", "manipulation.arm", "manipulation.lift"];
    const charged = buildLineItems({ selected_module_ids: wren }).reduce((t, i) => t + (i.price_data?.unit_amount ?? 0), 0);
    expect(demoTotalCents(wren)).toBe(charged);
    expect(demoTotalCents(wren)).toBe(167_500);
    expect(demoPriceLine(wren)).toBe("$1,675 sample total");
    expect(demoPriceLine(["base.walker"])).toBe("$400 sample total");
    expect(formatUsd(5)).toBe("$0.05");
    expect(formatUsd(167_550)).toBe("$1,675.50");
  });

  it("has a whole-cent placeholder price of at least $0.50 (Stripe's minimum) for every catalog module", () => {
    for (const m of MODULE_CATALOG.modules) {
      const cents = DEMO_PLACEHOLDER_PRICES_USD_CENTS[m.id];
      expect(Number.isInteger(cents) && cents >= 50).toBe(true);
    }
  });

  it("asks Stripe for a test payment with ids-only metadata and no shipping or customer details", () => {
    const now = new Date("2026-10-23T12:00:00Z");
    const params = checkoutParams({
      configuration: { configuration_version: 1, selected_module_ids: ["base.walker"] },
      onboardingSessionId: "session-1",
      origin: "http://localhost:3000",
      now,
    });
    expect(params.mode).toBe("payment");
    expect(params.success_url).toBe("http://localhost:3000/checkout/success?session_id={CHECKOUT_SESSION_ID}");
    expect(params.cancel_url).toBe("http://localhost:3000/checkout/cancelled");
    expect(params.metadata).toEqual({ app: CHECKOUT_APP_TAG, onboarding_session_id: "session-1", configuration_version: "1" });
    expect(params.allowed_payment_method_types).toEqual(["card"]);
    expect(params.wallet_options).toEqual({ link: { display: "never" } });
    expect(params.customer_creation).toBe("if_required");
    expect(params.expires_at).toBe(now.getTime() / 1000 + 3600);
    for (const key of ["shipping_address_collection", "shipping_options", "customer", "customer_email", "client_reference_id"]) {
      expect(params).not.toHaveProperty(key);
    }
    expect(params.phone_number_collection?.enabled ?? false).toBe(false);
    const submit = params.custom_text?.submit;
    expect(typeof submit === "object" && submit ? submit.message : "").toContain("Test mode, no real charge");
  });
});

describe("createDemoCheckout", () => {
  const input = {
    configuration: { configuration_version: 1, selected_module_ids: ["base.walker"] as ModuleId[] },
    onboardingSessionId: "session-1",
    origin: "http://localhost:3000",
  };

  it("returns Stripe's hosted test checkout URL", async () => {
    const { client, sessions } = stubClient({});
    expect(await createDemoCheckout(client, input)).toEqual({ ok: true, url: "https://checkout.stripe.com/c/pay/cs_test_abc" });
    expect(sessions.create).toHaveBeenCalledTimes(1);
  });

  it("refuses a live-mode session or a URL that isn't Stripe Checkout", async () => {
    const live = stubClient({ create: async () => ({ url: "https://checkout.stripe.com/c/pay/cs_live_abc", livemode: true }) });
    expect(await createDemoCheckout(live.client, input)).toEqual({ ok: false });
    const elsewhere = stubClient({ create: async () => ({ url: "https://example.com/pay", livemode: false }) });
    expect(await createDemoCheckout(elsewhere.client, input)).toEqual({ ok: false });
    const none = stubClient({ create: async () => ({ url: null, livemode: false }) });
    expect(await createDemoCheckout(none.client, input)).toEqual({ ok: false });
  });

  it("turns a Stripe error into a refusal and logs only its type", async () => {
    const failing = stubClient({
      create: async () => {
        throw Object.assign(new Error("Invalid API Key provided: sk_test_****0000"), { type: "StripeAuthenticationError" });
      },
    });
    expect(await createDemoCheckout(failing.client, input)).toEqual({ ok: false });
    expect(logged()).toContain("type=StripeAuthenticationError");
    expect(logged()).not.toContain("sk_test_");
  });
});

describe("success page lookup (loadDemoOrder)", () => {
  it("refuses a missing, malformed or live session id without asking Stripe", async () => {
    const { client, sessions } = stubClient({});
    for (const id of [undefined, "", "cs_live_abc", "abc", "cs_test_../../v1/customers", "pi_test_abc"]) {
      expect(await loadDemoOrder(client, id)).toEqual({ kind: "not_found" });
    }
    expect(sessions.retrieve).not.toHaveBeenCalled();
  });

  it("refuses an unknown session", async () => {
    const { client } = stubClient({
      retrieve: async () => {
        throw Object.assign(new Error("No such checkout.session"), { type: "StripeInvalidRequestError", statusCode: 404, code: "resource_missing" });
      },
    });
    expect(await loadDemoOrder(client, "cs_test_unknown")).toEqual({ kind: "not_found" });
  });

  it("refuses a session this app didn't make, or a live one", async () => {
    const other = stubClient({ retrieve: async () => paidSession({ metadata: { app: "someone-else" } }) });
    expect(await loadDemoOrder(other.client, "cs_test_abc")).toEqual({ kind: "not_found" });
    const untagged = stubClient({ retrieve: async () => paidSession({ metadata: {} }) });
    expect(await loadDemoOrder(untagged.client, "cs_test_abc")).toEqual({ kind: "not_found" });
    const live = stubClient({ retrieve: async () => paidSession({ livemode: true }) });
    expect(await loadDemoOrder(live.client, "cs_test_abc")).toEqual({ kind: "not_found" });
  });

  it("refuses an unpaid, open or expired session and doesn't list its items", async () => {
    for (const over of [
      { status: "open", payment_status: "unpaid" },
      { status: "complete", payment_status: "unpaid" },
      { status: "expired", payment_status: "unpaid" },
      { status: "complete", payment_status: "no_payment_required" },
    ] as const) {
      const { client, sessions } = stubClient({ retrieve: async () => paidSession(over) });
      expect(await loadDemoOrder(client, "cs_test_abc")).toEqual({ kind: "unpaid" });
      expect(sessions.listLineItems).not.toHaveBeenCalled();
    }
  });

  it("shows a paid session's modules from Stripe's line items", async () => {
    const { client, sessions } = stubClient({
      list: { data: [lineItem("base.walker", 40_000), lineItem("controls.hand", 5_000), lineItem("not.a.module", 100)] },
    });
    const order = await loadDemoOrder(client, "cs_test_abc");
    expect(sessions.listLineItems).toHaveBeenCalledWith("cs_test_abc", { limit: 100 });
    expect(order).toEqual({
      kind: "paid",
      lines: [
        { module_id: "base.walker", name: "Walker and coordinator", amount: 40_000, currency: "usd" },
        { module_id: "controls.hand", name: "Hand controls", amount: 5_000, currency: "usd" },
        { module_id: null, name: "ignored when the module id is known", amount: 100, currency: "usd" },
      ],
      total: 45_000,
      currency: "usd",
      configuration_version: "1",
    });
  });

  it("reports a Stripe outage as an error, not as a missing order", async () => {
    const { client } = stubClient({
      retrieve: async () => {
        throw Object.assign(new Error("socket hang up"), { type: "StripeConnectionError" });
      },
    });
    expect(await loadDemoOrder(client, "cs_test_abc")).toEqual({ kind: "error" });
  });
});
