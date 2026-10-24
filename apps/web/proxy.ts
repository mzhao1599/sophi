import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE_OPTIONS } from "@/server/auth-cookies";

/**
 * Next.js 16 Proxy (formerly Middleware). Its one job is keeping the Supabase sign-in fresh: an
 * access token lasts an hour, server components can't write cookies, so the refresh happens here,
 * before the page renders. It decides nothing about access; each page, route handler and server
 * action checks the user itself, and Postgres row-level security checks again.
 */
export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!url || !publishableKey) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, publishableKey, {
    cookieOptions: AUTH_COOKIE_OPTIONS,
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll(toSet, headers) {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
        // A response that sets a session cookie must never be cached and served to someone else.
        for (const [key, value] of Object.entries(headers)) response.headers.set(key, value);
      },
    },
  });
  // Refreshes an expired access token through setAll above. Nothing may run between creating the
  // client and this call, or a refresh can be lost.
  await supabase.auth.getClaims();
  return response;
}

export const config = {
  // Pages, route handlers and server actions; not static files, images or the favicon.
  matcher: ["/((?!_next/static|_next/image|images/|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)"],
};
