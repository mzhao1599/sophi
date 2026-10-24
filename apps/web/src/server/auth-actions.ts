"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { isOnboardingError } from "@walker/cloud-api";
import { z } from "zod";
import { safeNext } from "@/server/next-path";
import { deleteAccountData, onboardingRequest } from "@/server/onboarding";
import { requestAuth, supabaseForRequest } from "@/server/supabase";
import { START, type SignInState } from "@/lib/sign-in-state";

/**
 * Account actions, all on the server: sign in, sign out, delete a saved setup, delete the account.
 *
 * Passwordless sign-in with Supabase Auth. One email carries a one-time code and a link; either
 * signs the person in (the link through /auth/confirm). A first sign-in creates the account.
 * Everything runs on the server, so the session cookies stay httpOnly.
 */

const EmailSchema = z.email().max(254);
// Supabase's email codes are 6 digits by default and can be set up to 10.
const CodeSchema = z.string().regex(/^\d{6,10}$/);

function field(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/** The site this request came to, for the link in the email (it must be in Supabase's redirect allow list). */
async function siteOrigin(): Promise<string> {
  const h = await headers();
  // Next.js checks that a server action's Origin matches the host, so this is the page's own origin.
  const origin = h.get("origin");
  if (origin && /^https?:\/\/[^/]+$/.test(origin)) return origin;
  return `${h.get("x-forwarded-proto") ?? "https"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
}

function sendError(error: { status?: number; code?: string }): string {
  if (error.status === 429 || error.code === "over_email_send_rate_limit" || error.code === "over_request_rate_limit") {
    return "Too many sign-in emails were sent just now. Wait a minute, then try again.";
  }
  if (error.code === "email_address_invalid" || error.code === "validation_failed") {
    return "Enter a valid email address, like name@example.com.";
  }
  return "We couldn't send the email. Please try again in a minute.";
}

export async function signIn(_previous: SignInState, form: FormData): Promise<SignInState> {
  const intent = field(form, "intent");
  const next = safeNext(field(form, "next"));
  if (intent === "change") return { step: "email", email: field(form, "email"), error: null };

  const supabase = await supabaseForRequest();
  if (!supabase) return { step: "email", email: "", error: "Sign-in isn't set up on this server." };

  if (intent === "send" || intent === "resend") {
    const parsed = EmailSchema.safeParse(field(form, "email"));
    if (!parsed.success) return { step: "email", email: field(form, "email"), error: "Enter a valid email address, like name@example.com." };
    const email = parsed.data;
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: true, emailRedirectTo: `${await siteOrigin()}/auth/confirm` },
    });
    if (error) {
      return intent === "resend" ? { step: "code", email, error: sendError(error), notice: null } : { step: "email", email, error: sendError(error) };
    }
    return { step: "code", email, error: null, notice: intent === "resend" ? `We sent a new email to ${email}.` : null };
  }

  if (intent === "verify") {
    const parsed = EmailSchema.safeParse(field(form, "email"));
    if (!parsed.success) return START;
    const email = parsed.data;
    const code = CodeSchema.safeParse(field(form, "code").replace(/\s+/g, ""));
    if (!code.success) return { step: "code", email, error: "Enter the code from the email: 6 digits, numbers only.", notice: null };
    const { error } = await supabase.auth.verifyOtp({ email, token: code.data, type: "email" });
    if (error) {
      // Supabase answers a mistyped code and an expired one the same way (otp_expired), so one message covers both.
      const message =
        error.status === 429
          ? "Too many tries just now. Wait a minute, then try again."
          : "That code didn't work. It may be mistyped, expired or already used. Check it, or send a new email.";
      return { step: "code", email, error: message, notice: null };
    }
    redirect(next);
  }

  return START;
}

// Email link types this app sends: the sign-in link, and the sign-up confirmation a first sign-in gets.
const LINK_TYPES = ["email", "magiclink", "signup"] as const;

/**
 * Redeems the email's link, from the button on /auth/confirm. Two shapes arrive there:
 * - `token_hash` and `type`, from this project's template (supabase/templates/sign-in.html). It
 *   works on any device, because the hash itself is the proof.
 * - `code`, from Supabase's default template, which goes through Supabase first. That code only
 *   works in the browser that asked for the email (it needs the PKCE cookie set then).
 */
export async function confirmSignInLink(form: FormData): Promise<void> {
  const supabase = await supabaseForRequest();
  const tokenHash = field(form, "token_hash");
  const type = LINK_TYPES.find((t) => t === field(form, "type"));
  const code = field(form, "code");
  let signedIn = false;
  if (supabase && tokenHash && type) {
    signedIn = !(await supabase.auth.verifyOtp({ type, token_hash: tokenHash })).error;
  } else if (supabase && code) {
    signedIn = !(await supabase.auth.exchangeCodeForSession(code)).error;
  }
  redirect(signedIn ? "/setups" : "/login?error=link");
}

export async function signOut(): Promise<void> {
  const supabase = await supabaseForRequest();
  if (supabase) await supabase.auth.signOut({ scope: "local" });
  redirect("/");
}

export interface ActionResult {
  ok: boolean;
  message: string;
}

/** Deletes one of the signed-in user's setups and the onboarding session (answers) it was confirmed in. */
export async function deleteSetup(sessionId: string): Promise<ActionResult> {
  const { service, caller } = await onboardingRequest();
  if (!caller.user_id) return { ok: false, message: "You've been signed out. Sign in again to delete a setup." };
  try {
    await service.remove(sessionId, caller);
  } catch (error) {
    if (isOnboardingError(error) && error.code === "not_found") return { ok: true, message: "That setup was already deleted." };
    throw error;
  }
  revalidatePath("/setups");
  return { ok: true, message: "Setup deleted, with the answers it came from." };
}

/** Deletes the signed-in user's account; Postgres then deletes every session and setup they own. */
export async function deleteAccount(): Promise<ActionResult> {
  const { client, user } = await requestAuth();
  if (!client || !user) return { ok: false, message: "You've been signed out. Sign in again to delete your account." };
  await deleteAccountData(user.id);
  // The account is gone, so this only clears this browser's session cookies.
  await client.auth.signOut({ scope: "local" });
  redirect("/login?deleted=1");
}
