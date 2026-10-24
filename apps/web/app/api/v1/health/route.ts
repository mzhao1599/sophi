import { sharedWalkerBackend } from "@walker/cloud-api";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/health — Render's health check. 200 when the walker store is ready (on Render, its
 * Postgres migrations have run) and answers now, 503 while it can't be reached, so a deploy whose
 * database isn't ready never takes traffic. A server with walkers off (no database in production) is still healthy: onboarding works.
 */
export async function GET() {
  const backend = sharedWalkerBackend();
  const headers = { "Cache-Control": "no-store" };
  if (backend.kind === "off") return Response.json({ status: "ok", walker_store: "off" }, { headers });
  try {
    await backend.store.ready();
    await backend.store.ping();
    return Response.json({ status: "ok", walker_store: backend.kind }, { headers });
  } catch {
    return Response.json({ status: "unavailable", walker_store: backend.kind }, { status: 503, headers });
  }
}
