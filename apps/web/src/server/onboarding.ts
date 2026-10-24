import "server-only";
import { cookies } from "next/headers";
import {
  OnboardingService,
  SupabaseSessionStore,
  engineFromEnv,
  isOnboardingError,
  storeBackendFromEnv,
  type Caller,
  type StoreBackend,
} from "@walker/cloud-api";
import type { ApiError } from "@walker/contracts";
import type { z } from "zod";

/**
 * Server-side glue between the route handlers and the onboarding service. The demo session's
 * secret lives in an httpOnly cookie scoped to the onboarding API; the session id alone grants
 * nothing, so it can appear in URLs without exposing anyone's answers.
 */

const COOKIE = "walker_demo";
const COOKIE_PATH = "/api/v1/onboarding";

// Where sessions are kept: Supabase when its three variables are set, otherwise server memory (see
// storeBackendFromEnv in services/cloud-api, including why production refuses memory). Chosen on the
// first request, not at import, so a build doesn't log about it, and kept for the life of the server
// process (across dev hot reloads too, so the memory store keeps its sessions).
const globalForStore = globalThis as unknown as { __walkerStoreBackend?: StoreBackend };
function storeBackend(): StoreBackend {
  return (globalForStore.__walkerStoreBackend ??= storeBackendFromEnv(process.env));
}
// ONBOARDING_ENGINE=agent plus ANTHROPIC_API_KEY turns on the onboarding agent; otherwise the
// deterministic engine runs. These variables and the Supabase secret key are read here, on the
// server, and never sent to the browser.
const engine = engineFromEnv(process.env);
export const engineKind = engine.kind;

/**
 * The onboarding service for one request, and who is asking about `sessionId`: the demo secret
 * from the cookie, only if it is for that session. The service is rebuilt each time (it is only a
 * few references) so its store can carry the requester's own database client, and so its error
 * classes always match the code that checks them after a hot reload.
 */
export async function onboardingRequest(sessionId?: string): Promise<{ service: OnboardingService; caller: Caller }> {
  const backend = storeBackend();
  const store = backend.kind === "supabase" ? new SupabaseSessionStore({ admin: backend.admin, user: null }) : backend.store;
  const service = new OnboardingService(store, { engine, startBlocked: backend.kind === "memory" ? backend.startBlocked : undefined });
  const token = sessionId ? await readToken(sessionId) : undefined;
  return { service, caller: { token } };
}

export async function readToken(sessionId: string): Promise<string | undefined> {
  const value = (await cookies()).get(COOKIE)?.value;
  if (!value) return undefined;
  const [id, token] = value.split(":");
  return id === sessionId ? token : undefined;
}

export async function writeToken(sessionId: string, token: string) {
  (await cookies()).set(COOKIE, `${sessionId}:${token}`, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: COOKIE_PATH,
    maxAge: 4 * 60 * 60,
  });
}

export async function clearToken() {
  (await cookies()).delete({ name: COOKIE, path: COOKIE_PATH });
}

function traceId() {
  return crypto.randomUUID();
}

export function errorResponse(code: ApiError["error"]["code"], status: number, message: string, extra: Partial<ApiError["error"]> = {}) {
  const body: ApiError = { error: { code, message, trace_id: traceId(), ...extra } };
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Parses a JSON body with a contract schema; anything else is a 400 with a readable message. */
export async function parseBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S> | Response> {
  if (!request.headers.get("content-type")?.includes("application/json")) {
    return errorResponse("invalid_request", 415, "Send the request as JSON.");
  }
  const text = await request.text();
  if (text.length > 16_000) return errorResponse("invalid_request", 413, "That request is too large.");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return errorResponse("invalid_request", 400, "The request body isn't valid JSON.");
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const first = result.error.issues[0];
    return errorResponse("invalid_request", 400, first?.message ?? "The request doesn't match the API contract.");
  }
  return result.data;
}

/** Runs a handler and maps service errors to the error envelope. Unexpected errors are logged by trace id only. */
export async function handle(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (error) {
    if (isOnboardingError(error)) {
      return errorResponse(error.code, error.status, error.message, error.session ? { session: error.session } : {});
    }
    const id = traceId();
    // The name and, for a database error, its Postgres code; never the message, which can quote row data.
    const code = error instanceof Error && "code" in error && typeof error.code === "string" ? ` code=${error.code}` : "";
    console.error(`[onboarding] unexpected error trace=${id} ${error instanceof Error ? error.name : "unknown"}${code}`);
    return Response.json(
      { error: { code: "invalid_request", message: "Something went wrong on our side. Please try again.", trace_id: id } },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
