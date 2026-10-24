import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutAccess } from "@/server/checkout/stripe";
import { CHECKOUT_APP_TAG } from "@/server/checkout/order";

// The page reads the Stripe client from getCheckout(); here it gets a stub instead of a real key.
const access = vi.hoisted(() => ({ current: { ok: false, reason: "missing" } as CheckoutAccess }));
vi.mock("@/server/checkout/stripe", () => ({ getCheckout: () => access.current }));

const { default: CheckoutSuccessPage } = await import("../app/checkout/success/page");

function stubStripe(session: Record<string, unknown> | Error) {
  const retrieve = vi.fn(async () => {
    if (session instanceof Error) throw session;
    return session;
  });
  const listLineItems = vi.fn(async () => ({ data: [{ metadata: { module_id: "base.walker" }, description: null, amount_total: 40_000, currency: "usd" }] }));
  access.current = { ok: true, client: { checkout: { sessions: { create: vi.fn(), retrieve, listLineItems } } } as never };
  return { retrieve, listLineItems };
}

async function orderFor(sessionId: string | string[] | undefined) {
  const element = await CheckoutSuccessPage({ searchParams: Promise.resolve({ session_id: sessionId }) });
  return (element.props as { order: { kind: string } }).order;
}

const session = (over: Record<string, unknown>) => ({
  id: "cs_test_abc",
  livemode: false,
  status: "complete",
  payment_status: "paid",
  metadata: { app: CHECKOUT_APP_TAG, configuration_version: "1" },
  amount_total: 40_000,
  currency: "usd",
  ...over,
});

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("/checkout/success", () => {
  it("shows no order while checkout is off", async () => {
    access.current = { ok: false, reason: "live" };
    expect(await orderFor("cs_test_abc")).toEqual({ kind: "off" });
  });

  it("refuses an unknown session", async () => {
    const { retrieve } = stubStripe(Object.assign(new Error("No such checkout.session"), { statusCode: 404, code: "resource_missing" }));
    expect((await orderFor("cs_test_doesnotexist")).kind).toBe("not_found");
    expect(retrieve).toHaveBeenCalledWith("cs_test_doesnotexist");
  });

  it("refuses a missing or repeated session_id without asking Stripe", async () => {
    const { retrieve } = stubStripe(session({}));
    expect((await orderFor(undefined)).kind).toBe("not_found");
    expect((await orderFor(["cs_test_a", "cs_test_b"])).kind).toBe("not_found");
    expect(retrieve).not.toHaveBeenCalled();
  });

  it("refuses an unpaid session", async () => {
    const { listLineItems } = stubStripe(session({ status: "open", payment_status: "unpaid" }));
    expect((await orderFor("cs_test_abc")).kind).toBe("unpaid");
    expect(listLineItems).not.toHaveBeenCalled();
  });

  it("shows a paid session's modules", async () => {
    stubStripe(session({}));
    expect(await orderFor("cs_test_abc")).toMatchObject({ kind: "paid", lines: [{ module_id: "base.walker", amount: 40_000 }] });
  });
});
