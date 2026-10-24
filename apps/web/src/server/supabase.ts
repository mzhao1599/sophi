import "server-only";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { AUTH_COOKIE_OPTIONS } from "./auth-cookies";

/**
 * Supabase Auth on the server. Sign-in, sign-out and every database call happen here (server
 * actions, route handlers, server components), never in the browser, so the session cookies can be
 * httpOnly: a script on the page can't read the access token.
 *
 * The publishable key is public; row-level security is what protects data. The secret key is not
 * used here (see services/cloud-api storeBackendFromEnv).
 */

export interface SupabasePublicConfig {
  url: string;
  publishableKey: string;
}

/** The project URL and publishable key, or null when Supabase isn't configured (then nobody can sign in). */
export function supabasePublicConfig(): SupabasePublicConfig | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  return url && publishableKey ? { url, publishableKey } : null;
}

/**
 * A Supabase client for this request, carrying the signed-in user's session from the cookies, or
 * null when Supabase isn't configured. Make one per request.
 */
export async function supabaseForRequest(): Promise<SupabaseClient | null> {
  const config = supabasePublicConfig();
  if (!config) return null;
  const store = await cookies();
  return createServerClient(config.url, config.publishableKey, {
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll: () => store.getAll(),
      setAll(toSet) {
        try {
          for (const { name, value, options } of toSet) store.set(name, value, options);
        } catch {
          // Server components can't set cookies. The proxy (proxy.ts) refreshes the session before
          // they render, so a refresh here only happens if that failed; the next request retries.
        }
      },
    },
  });
}

export interface SignedInUser {
  id: string;
  email: string | null;
}

/**
 * The signed-in user, verified: getClaims checks the access token's signature (and refreshes an
 * expired one), unlike getSession, which only reads the cookie.
 */
export async function signedInUser(client: SupabaseClient | null): Promise<SignedInUser | null> {
  if (!client) return null;
  const { data, error } = await client.auth.getClaims();
  if (error || !data?.claims?.sub) return null;
  const email = typeof data.claims.email === "string" ? data.claims.email : null;
  return { id: data.claims.sub, email };
}

/** This request's Supabase client and signed-in user (both null when Supabase isn't configured). */
export async function requestAuth(): Promise<{ client: SupabaseClient | null; user: SignedInUser | null }> {
  const client = await supabaseForRequest();
  return { client, user: await signedInUser(client) };
}
