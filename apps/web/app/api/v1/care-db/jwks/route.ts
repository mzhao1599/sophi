import { careDbJwks, sharedWalkerBackend } from "@walker/cloud-api";

export const dynamic = "force-dynamic";

/** GET /.well-known/jwks.json (rewritten here, next.config.ts): the public key SpacetimeDB checks tokens with. */
export async function GET() {
  const care = sharedWalkerBackend().care;
  if (!care) return new Response(null, { status: 404 });
  return Response.json(careDbJwks(care), { headers: { "Cache-Control": "public, max-age=300" } });
}
