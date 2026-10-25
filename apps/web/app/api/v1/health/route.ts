import { sharedWalkerBackend, type SpacetimeCircleStore } from "@walker/cloud-api";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/health — Render's health check. 200 when the walker store is ready (on Render, its
 * Postgres migrations have run) and answers now, 503 while it can't be reached, so a deploy whose
 * database isn't ready never takes traffic. A server with walkers off (no database in production) is still healthy: onboarding works.
 * With the circle in SpacetimeDB, `care_db` says whether it answers now, but never fails the check: the walker
 * keeps working without it.
 */
export async function GET() {
  const backend = sharedWalkerBackend();
  const headers = { "Cache-Control": "no-store" };
  if (backend.kind === "off") return Response.json({ status: "ok", walker_store: "off" }, { headers });
  try {
    await backend.store.ready();
    await backend.store.ping();
    // By shape, not instanceof: the start-up hook and the routes are bundled apart, so classes can differ.
    const store = backend.store as Partial<SpacetimeCircleStore>;
    const care = backend.care && store.pingCare ? await careStatus(store.pingCare.call(backend.store)) : "off";
    return Response.json({ status: "ok", walker_store: backend.kind, care_db: care }, { headers });
  } catch {
    return Response.json({ status: "unavailable", walker_store: backend.kind }, { status: 503, headers });
  }
}

/** At most CARE_PING_MS: a slow SpacetimeDB is reported, never allowed to fail Render's check. */
const CARE_PING_MS = 1_500;

async function careStatus(ping: Promise<void>): Promise<"ok" | "unreachable"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"unreachable">((resolve) => (timer = setTimeout(() => resolve("unreachable"), CARE_PING_MS)));
  try {
    return await Promise.race([ping.then(() => "ok" as const, () => "unreachable" as const), late]);
  } finally {
    clearTimeout(timer);
  }
}
