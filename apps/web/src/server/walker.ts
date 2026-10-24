import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { WalkerService, isWalkerError, sharedWalkerActivity, sharedWalkerAgent, sharedWalkerBackend, type DeviceCaller, type OwnerCaller } from "@walker/cloud-api";
import { WALKER_ERROR_STATUS, type ProposalView, type WalkerError, type WalkerErrorCode } from "@walker/contracts";
import type { z } from "zod";

/**
 * Server-side glue between the walker route handlers and the walker service. Two callers, two proofs,
 * and each route reads only its own:
 * - the owner's page: the `walker_owner` cookie, scoped to /api/v1/walkers, so the browser never even
 *   sends it to the device routes;
 * - the Pi: `Authorization: Bearer <credential>` on /api/v1/devices.
 * Both secrets stay with their holder; the server keeps only their SHA-256.
 */

const COOKIE = "walker_owner";
const COOKIE_PATH = "/api/v1/walkers";
/** The walker is kept until its owner forgets it, so the cookie lasts as long as browsers allow (400 days). */
const COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
/** Every walker route except the walker's turns takes a small JSON body; a heartbeat at its largest is about 30 KB. */
export const MAX_BODY_BYTES = 64_000;
/** A walker's turn: a voice clip of up to 1 MB is about 1.34 MB in base64, plus its snapshot. */
export const MAX_TURN_BODY_BYTES = 800_000;

/**
 * The service for one request. It's only a few references; the store and its connection pool, the
 * model and voice, and the page's activity log are shared by every route in the process.
 */
export function walkerService(): WalkerService {
  const backend = sharedWalkerBackend();
  const { assistant, voice } = sharedWalkerAgent();
  return new WalkerService(backend.store, { blocked: backend.blocked, assistant, voice, activity: sharedWalkerActivity() });
}

export function ownerCaller(request: NextRequest): OwnerCaller {
  return { kind: "owner", secret: request.cookies.get(COOKIE)?.value };
}

export function deviceCaller(request: Request): DeviceCaller {
  // The scheme's name is case-insensitive in HTTP; the credential itself isn't.
  const match = /^Bearer ([A-Za-z0-9_-]+)$/i.exec(request.headers.get("authorization")?.trim() ?? "");
  return { kind: "device", credential: match?.[1] };
}

/**
 * False for a request another site made the browser send. SameSite=Strict keeps the cookie off such a
 * request, but the browser would still accept a new cookie from its answer, so a page elsewhere could
 * replace this browser's owner secret and lose it its walkers. Browsers send Sec-Fetch-Site; tools
 * that don't, like curl, are allowed.
 */
export function fromThisSite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  return site === null || site === "same-origin" || site === "none";
}

export function setOwnerCookie(response: NextResponse, secret: string) {
  response.cookies.set(COOKIE, secret, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    path: COOKIE_PATH,
    maxAge: COOKIE_MAX_AGE_S,
  });
}

/**
 * The address that keys the wrong-pairing-code lockout. On Render every request comes through
 * Cloudflare, which sets `CF-Connecting-IP` to the one address that connected to it. Render's docs say
 * to read `X-Forwarded-For`, but Render keeps whatever a client already put there and appends after
 * it, so its leftmost entry can be forged, and how many proxy entries follow isn't documented.
 * Anywhere else there is no proxy to trust (Next.js fills in `X-Forwarded-For` only when a request
 * has none, so a caller could pick its own key), so every caller shares one lockout: it fails closed.
 * Walkers run in production only on Render; production elsewhere has them off.
 */
export function clientAddress(headers: Headers, env: Record<string, string | undefined> = process.env): string {
  if (env.RENDER !== "true") return "local";
  const address = headers.get("cf-connecting-ip")?.trim();
  return address ? ipv6Network(address) : "unknown";
}

/**
 * An IPv6 address as its /64 network, since one household or phone usually gets a whole /64 and could
 * otherwise take a fresh address for every try. IPv4 (including IPv4 written as IPv6) is unchanged.
 */
function ipv6Network(address: string): string {
  const v4 = /(\d{1,3}(\.\d{1,3}){3})$/.exec(address);
  if (v4 || !address.includes(":")) return v4 ? v4[1]! : address;
  const [head = "", tail = ""] = address.toLowerCase().split("%")[0]!.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const groups = address.includes("::") ? [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill("0"), ...right] : left;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

export function walkerJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Each error response's trace id, so the log line can carry it without adding a header. */
const traceIds = new WeakMap<Response, string>();

export function walkerError(code: WalkerErrorCode, message: string, proposal?: ProposalView): NextResponse {
  const trace_id = crypto.randomUUID();
  const body: WalkerError = { error: { code, message, trace_id, ...(proposal ? { proposal } : {}) } };
  const response = walkerJson(body, WALKER_ERROR_STATUS[code]);
  traceIds.set(response, trace_id);
  return response;
}

/**
 * Parses a JSON body with a contract schema, reading at most `maxBytes`. Anything else is a 400
 * naming the first problem's field, never echoing the value.
 */
export async function readJson<S extends z.ZodType>(request: Request, schema: S, maxBytes = MAX_BODY_BYTES): Promise<z.infer<S> | NextResponse> {
  if (!request.headers.get("content-type")?.includes("application/json")) return walkerError("invalid_request", "Send the request as JSON.");
  const text = await readText(request, maxBytes);
  if (text === null) return walkerError("invalid_request", "That request is too large.");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return walkerError("invalid_request", "The request body isn't valid JSON.");
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    return walkerError("invalid_request", `${where}${first?.message ?? "The request doesn't match the API contract."}`);
  }
  return result.data;
}

async function readText(request: Request, maxBytes: number): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Runs a walker route: maps WalkerError to the error envelope, and logs one line per request with the
 * route, the walker id, the HTTP status and the time taken. Never words, credentials or cookies.
 */
export async function walkerRoute(route: string, deviceId: string | null, fn: () => Promise<NextResponse>): Promise<NextResponse> {
  const started = performance.now();
  let response: NextResponse;
  let note = "";
  try {
    response = await fn();
  } catch (error) {
    if (isWalkerError(error)) {
      response = walkerError(error.code, error.message, error.proposal);
    } else {
      // The error's name and, for a database error, its code; never its message, which can quote data.
      const code = error instanceof Error && "code" in error && typeof error.code === "string" ? ` code=${error.code}` : "";
      note = ` error=${error instanceof Error ? error.name : "unknown"}${code}`;
      response = walkerError("unavailable", "Something went wrong on our side. Please try again.");
    }
  }
  const ms = Math.round(performance.now() - started);
  // The id comes from the URL, so only a well-formed one is written to the log.
  const id = deviceId === null ? "-" : /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(deviceId) ? deviceId : "malformed";
  const trace = traceIds.get(response);
  console.info(`[walker] route=${route} device=${id} status=${response.status} ms=${ms}${trace ? ` trace=${trace}` : ""}${note}`);
  return response;
}
