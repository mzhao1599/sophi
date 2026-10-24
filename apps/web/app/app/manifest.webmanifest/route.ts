import { APP_MANIFEST } from "@/lib/appManifest";

/** The two-phone app's web app manifest, scoped to /app so only the app installs. */
export const dynamic = "force-static";

export function GET() {
  return new Response(JSON.stringify(APP_MANIFEST), { headers: { "Content-Type": "application/manifest+json" } });
}
