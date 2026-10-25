import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { CircleService, careLiveAccess, isCircleError, sharedWalkerBackend, type MemberCaller } from "@walker/cloud-api";
import { CIRCLE_ERROR_STATUS, type CircleError, type CircleErrorCode } from "@walker/contracts";
import { rememberTraceId, traceIdOf, walkerJson } from "./walker";

/**
 * Server-side glue for the two-phone circle (circle.ts, "The two-phone app"). Two proofs, each read only
 * by its own routes:
 * - the owner's page: the `walker_owner` cookie, on /api/v1/walkers/{id}/circle... (ownerCaller in walker.ts);
 * - a phone: the `walker_member` cookie, scoped to /api/v1/circle, so the browser sends it nowhere else.
 * The walker's Bearer credential works on neither. The server keeps only each secret's SHA-256.
 */

const MEMBER_COOKIE = "walker_member";
const MEMBER_COOKIE_PATH = "/api/v1/circle";
/** A phone stays in until the owner removes it, so the cookie lasts as long as browsers allow (400 days). */
const MEMBER_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;

/** The circle's service for one request, on the walkers' shared store (with live access when it is in SpacetimeDB). */
export function circleService(): CircleService {
  const backend = sharedWalkerBackend();
  const care = backend.care;
  return new CircleService(backend.store, {
    blocked: backend.blocked,
    liveAccess: care ? (subject) => careLiveAccess(care, subject, new Date()) : undefined,
  });
}

export function memberCaller(request: NextRequest): MemberCaller {
  return { kind: "member", secret: request.cookies.get(MEMBER_COOKIE)?.value };
}

export function setMemberCookie(response: NextResponse, secret: string) {
  response.cookies.set(MEMBER_COOKIE, secret, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: MEMBER_COOKIE_PATH,
    maxAge: MEMBER_COOKIE_MAX_AGE_S,
  });
}

export function circleError(code: CircleErrorCode, message: string): NextResponse {
  const trace_id = crypto.randomUUID();
  const body: CircleError = { error: { code, message, trace_id } };
  const response = walkerJson(body, CIRCLE_ERROR_STATUS[code]);
  rememberTraceId(response, trace_id);
  return response;
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}

/**
 * Runs a circle route: maps CircleError to the error envelope, and logs one line with the route, the walker
 * id (owner routes only), the status and the time. Never names, codes, message text or cookies.
 */
export async function circleRoute(route: string, deviceId: string | null, fn: () => Promise<NextResponse>): Promise<NextResponse> {
  const started = performance.now();
  let response: NextResponse;
  let note = "";
  try {
    response = await fn();
  } catch (error) {
    if (isCircleError(error)) {
      response = circleError(error.code, error.message);
    } else {
      const code = error instanceof Error && "code" in error && typeof error.code === "string" ? ` code=${error.code}` : "";
      note = ` error=${error instanceof Error ? error.name : "unknown"}${code}`;
      response = circleError("unavailable", "Something went wrong on our side. Please try again.");
    }
  }
  const ms = Math.round(performance.now() - started);
  const id = deviceId === null ? "-" : /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(deviceId) ? deviceId : "malformed";
  const trace = traceIdOf(response);
  console.info(`[circle] route=${route} device=${id} status=${response.status} ms=${ms}${trace ? ` trace=${trace}` : ""}${note}`);
  return response;
}
