import type { CookieOptionsWithName } from "@supabase/ssr";

/**
 * Options for the Supabase session cookies, shared by the proxy and the server client. httpOnly
 * because nothing in the browser uses the session: sign-in and data access all run on the server.
 */
export const AUTH_COOKIE_OPTIONS: CookieOptionsWithName = {
  httpOnly: true,
  sameSite: "lax",
  secure: process.env.NODE_ENV === "production",
  path: "/",
};
