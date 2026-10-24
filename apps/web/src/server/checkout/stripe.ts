import "server-only";
import Stripe from "stripe";
import type { CheckoutStatus } from "@/lib/checkout";
import { checkStripeKey, keyProblemLog, type StripeKeyCheck } from "./key";
import type { CheckoutClient } from "./order";

/**
 * The Stripe client for the mock purchase, built only from an sk_test_ key. STRIPE_SECRET_KEY is
 * read here, on the server, and never sent to the browser. stripe@23.0.0 pins its own API
 * version; the repository date label was normalized to 2026-10-23 and is not an SDK version.
 * No publishable key: hosted Checkout doesn't need one.
 */

export type CheckoutAccess = { ok: true; client: CheckoutClient } | { ok: false; reason: Exclude<StripeKeyCheck, { ok: true }>["reason"] };

const createStripe = (key: string): CheckoutClient => new Stripe(key, { maxNetworkRetries: 1, timeout: 15_000 });

let cached: { key: string; client: CheckoutClient } | undefined;
let lastLogged: string | undefined;

export function getCheckout(env: Record<string, string | undefined> = process.env, create = createStripe): CheckoutAccess {
  const check = checkStripeKey(env.STRIPE_SECRET_KEY);
  if (!check.ok) {
    // Once per process (and again if the reason changes), so the dev server log says why the button is off.
    if (lastLogged !== check.reason) {
      lastLogged = check.reason;
      (check.reason === "missing" ? console.info : console.error)(keyProblemLog(check.reason));
    }
    return { ok: false, reason: check.reason };
  }
  lastLogged = undefined;
  if (cached?.key !== check.key) cached = { key: check.key, client: create(check.key) };
  return { ok: true, client: cached.client };
}

export function checkoutStatus(access: CheckoutAccess): CheckoutStatus {
  if (access.ok) return { enabled: true, reason: "ready" };
  return { enabled: false, reason: access.reason === "missing" ? "missing_key" : "not_test_key" };
}
