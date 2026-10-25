import { careDbDiscovery, sharedWalkerBackend } from "@walker/cloud-api";

export const dynamic = "force-dynamic";

/**
 * GET /.well-known/openid-configuration (rewritten here, next.config.ts): this server as the OpenID issuer
 * whose tokens SpacetimeDB accepts for the care circle. 404 when the circle isn't in SpacetimeDB.
 */
export async function GET() {
  const care = sharedWalkerBackend().care;
  if (!care) return new Response(null, { status: 404 });
  return Response.json(careDbDiscovery(care), { headers: { "Cache-Control": "public, max-age=300" } });
}
