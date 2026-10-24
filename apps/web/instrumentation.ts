/**
 * Runs once when the server starts. The walker store gets ready before the first request: on Render
 * that runs the Postgres migrations (under an advisory lock, so two instances never race) and sweeps
 * history older than an hour. A failure is logged by name only; /api/v1/health then answers 503 until
 * a later attempt succeeds.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { WalkerService, sharedWalkerBackend } = await import("@walker/cloud-api");
  const backend = sharedWalkerBackend();
  if (backend.kind === "off") return;
  try {
    await new WalkerService(backend.store).prepare();
    console.info(`[walker] store ready (${backend.kind})`);
  } catch (error) {
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? ` code=${error.code}` : "";
    console.error(`[walker] store not ready: ${error instanceof Error ? error.name : "unknown"}${code}`);
  }
}
