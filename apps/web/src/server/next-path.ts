/**
 * Where to go after signing in. Only these exact paths are accepted, so a crafted ?next= can't send
 * someone to another site or to an unexpected page.
 */
const AFTER_SIGN_IN = ["/onboarding", "/onboarding/review", "/setups"] as const;

export function safeNext(value: unknown, fallback = "/setups"): string {
  return typeof value === "string" && (AFTER_SIGN_IN as readonly string[]).includes(value) ? value : fallback;
}
