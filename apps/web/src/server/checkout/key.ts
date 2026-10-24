import "server-only";

/**
 * The test-mode guard for the mock purchase. The walker is an experimental prototype, not a
 * certified mobility aid, so real money must never move: only a Stripe test secret key (sk_test_…)
 * turns checkout on. A live key (sk_live_, rk_live_, pk_live_) or anything else is refused.
 */

export type StripeKeyCheck = { ok: true; key: string } | { ok: false; reason: "missing" | "live" | "not_test" };

const TEST_SECRET_KEY = /^sk_test_[A-Za-z0-9]+$/;

export function checkStripeKey(value: string | undefined): StripeKeyCheck {
  const key = value?.trim() ?? "";
  if (key === "") return { ok: false, reason: "missing" };
  if (key.includes("_live_")) return { ok: false, reason: "live" };
  if (!TEST_SECRET_KEY.test(key)) return { ok: false, reason: "not_test" };
  return { ok: true, key };
}

/** The log line for a refused or missing key. It never includes the key itself. */
export function keyProblemLog(reason: Exclude<StripeKeyCheck, { ok: true }>["reason"]): string {
  switch (reason) {
    case "missing":
      return "[checkout] Mock purchase is off: STRIPE_SECRET_KEY is not set. Everything else works as before.";
    case "live":
      return "[checkout] Refusing to start mock purchase: STRIPE_SECRET_KEY is a live-mode key. Only Stripe test secret keys (sk_test_…) are accepted, so no real money can move.";
    case "not_test":
      return "[checkout] Refusing to start mock purchase: STRIPE_SECRET_KEY is not a Stripe test secret key. It must start with sk_test_ (restricted and publishable keys are refused too).";
  }
}
