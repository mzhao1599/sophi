import { OnboardingError, type Caller } from "@walker/cloud-api";
import type { ModuleId } from "@walker/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutAccess } from "@/server/checkout/stripe";
import { CHECKOUT_APP_TAG } from "@/server/checkout/order";

// The route gets a stubbed Stripe client and a stubbed onboarding service; everything else is real.
const access = vi.hoisted(() => ({ current: { ok: false, reason: "missing" } as CheckoutAccess }));
const onboarding = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("@/server/checkout/stripe", () => ({ getCheckout: () => access.current }));
vi.mock("@/server/onboarding", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/onboarding")>()),
  onboardingRequest: onboarding.request,
}));

const { POST } = await import("../app/api/v1/onboarding/sessions/[id]/checkout/route");

const SESSION_ID = "8d0f3c1e-5b7a-4c2d-9e6f-1a2b3c4d5e6f";
const SELECTED: ModuleId[] = ["base.walker", "controls.hand"];

function savedSession(source: "demo" | "account", version: number, state = "confirmed") {
  return {
    session_id: SESSION_ID,
    state,
    configuration:
      state === "confirmed"
        ? { configuration_version: version, selected_module_ids: SELECTED, preferences: { cues: [], request_start: [] }, source }
        : null,
  };
}

function setup(caller: Caller, get: (id: string, caller: Caller) => Promise<unknown>) {
  const create = vi.fn(async () => ({ url: "https://checkout.stripe.com/c/pay/cs_test_route", livemode: false }));
  access.current = { ok: true, client: { checkout: { sessions: { create, retrieve: vi.fn(), listLineItems: vi.fn() } } } as never };
  const service = { get: vi.fn(get) };
  onboarding.request.mockResolvedValue({ service, caller });
  return { create, service };
}

function post(version: number) {
  const request = new Request(`http://localhost:3011/api/v1/onboarding/sessions/${SESSION_ID}/checkout`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ configuration_version: version }),
  });
  return POST(request, { params: Promise.resolve({ id: SESSION_ID }) });
}

beforeEach(() => {
  onboarding.request.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/v1/onboarding/sessions/{id}/checkout", () => {
  it("checks out a signed-in user's saved setup without sending who they are to Stripe", async () => {
    const { create, service } = setup({ user_id: "user-123" }, async () => ({ session: savedSession("account", 2) }));
    const response = await post(2);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ checkout_url: "https://checkout.stripe.com/c/pay/cs_test_route" });
    expect(onboarding.request).toHaveBeenCalledWith(SESSION_ID);
    expect(service.get).toHaveBeenCalledWith(SESSION_ID, { user_id: "user-123" });
    const params = (create.mock.calls[0] as unknown[])[0] as { metadata: unknown; line_items: Array<{ metadata: { module_id: string } }> };
    expect(params.metadata).toEqual({ app: CHECKOUT_APP_TAG, onboarding_session_id: SESSION_ID, configuration_version: "2" });
    expect(params.line_items.map((item) => item.metadata.module_id)).toEqual(SELECTED);
    expect(JSON.stringify(params)).not.toContain("user-123");
  });

  it("checks out a demo setup owned through the session cookie", async () => {
    const { create, service } = setup({ token: "demo-secret" }, async () => ({ session: savedSession("demo", 1) }));
    expect((await post(1)).status).toBe(201);
    expect(service.get).toHaveBeenCalledWith(SESSION_ID, { token: "demo-secret" });
    expect(JSON.stringify((create.mock.calls[0] as unknown[])[0])).not.toContain("demo-secret");
  });

  it("refuses someone who doesn't own the setup, before asking Stripe", async () => {
    const { create } = setup({}, async () => {
      throw new OnboardingError("not_found", 404, "This setup session wasn't found. It may have expired.");
    });
    const response = await post(1);
    expect(response.status).toBe(404);
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses a setup that isn't saved yet, or a different version than the one shown", async () => {
    const unsaved = setup({ user_id: "user-123" }, async () => ({ session: savedSession("account", 1, "review") }));
    expect((await post(1)).status).toBe(409);
    expect(unsaved.create).not.toHaveBeenCalled();

    const changed = setup({ user_id: "user-123" }, async () => ({ session: savedSession("account", 3) }));
    expect((await post(2)).status).toBe(409);
    expect(changed.create).not.toHaveBeenCalled();
  });

  it("is off without a test key, and never looks the session up", async () => {
    access.current = { ok: false, reason: "live" };
    const response = await post(1);
    expect(response.status).toBe(503);
    expect(onboarding.request).not.toHaveBeenCalled();
  });
});
