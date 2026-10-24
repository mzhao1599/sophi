import {
  ApiErrorSchema,
  SessionResponseSchema,
  TurnResponseSchema,
  type ApiErrorCode,
  type ConfirmRequest,
  type ProfileEditRequest,
  type SessionKind,
  type SessionView,
  type TurnInput,
  type TurnResponse,
} from "@walker/contracts";

/** Browser client for the onboarding API. Responses are validated against the shared contracts. */

export class ApiRequestError extends Error {
  constructor(
    readonly code: ApiErrorCode | "network",
    message: string,
    readonly status: number,
    readonly session?: SessionView,
  ) {
    super(message);
  }
}

const BASE = "/api/v1/onboarding/sessions";

async function call(path: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiRequestError("network", "Couldn't reach the server. Check your connection and try again.", 0);
  }
  if (response.status === 204) return null;
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const parsed = ApiErrorSchema.safeParse(body);
    if (parsed.success) {
      const { code, message, session } = parsed.data.error;
      throw new ApiRequestError(code, message, response.status, session);
    }
    throw new ApiRequestError("invalid_request", "Something went wrong. Please try again.", response.status);
  }
  return body;
}

/** `notice`: which data notice the start screen showed, which also decides the kind of session. */
export async function startSession(notice: SessionKind): Promise<TurnResponse> {
  const consent = notice === "account" ? { account_data_notice: true } : { demo_data_notice: true };
  const body = await call(BASE, {
    method: "POST",
    body: JSON.stringify({ input_mode: "text", consent }),
  });
  return TurnResponseSchema.parse(body);
}

export async function getSession(id: string): Promise<SessionView> {
  return SessionResponseSchema.parse(await call(`${BASE}/${encodeURIComponent(id)}`, { method: "GET" })).session;
}

export async function sendTurn(session: SessionView, input: TurnInput): Promise<TurnResponse> {
  const body = await call(`${BASE}/${encodeURIComponent(session.session_id)}/turns`, {
    method: "POST",
    body: JSON.stringify({ client_turn_id: crypto.randomUUID(), last_seen_revision: session.revision, input }),
  });
  return TurnResponseSchema.parse(body);
}

export async function editProfile(session: SessionView, edit: ProfileEditRequest["edit"]): Promise<SessionView> {
  const body = await call(`${BASE}/${encodeURIComponent(session.session_id)}/profile`, {
    method: "PATCH",
    body: JSON.stringify({ last_seen_revision: session.revision, edit }),
  });
  return SessionResponseSchema.parse(body).session;
}

export async function confirmSelection(
  session: SessionView,
  selected: ConfirmRequest["selected_module_ids"],
): Promise<SessionView> {
  const body = await call(`${BASE}/${encodeURIComponent(session.session_id)}/confirm`, {
    method: "POST",
    body: JSON.stringify({ last_seen_revision: session.revision, selected_module_ids: selected }),
  });
  return SessionResponseSchema.parse(body).session;
}

export async function deleteSession(id: string): Promise<void> {
  await call(`${BASE}/${encodeURIComponent(id)}`, { method: "DELETE" });
}
