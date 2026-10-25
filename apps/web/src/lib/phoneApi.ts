import {
  ApproveJoinResponseSchema,
  CIRCLE_MESSAGE_MAX,
  CareLiveResponseSchema,
  CircleErrorSchema,
  CircleMessageSchema,
  CreateInviteResponseSchema,
  OwnerPhonesResponseSchema,
  PRESET_REPLIES,
  PhoneHomeResponseSchema,
  LocationSharingResponseSchema,
  PhoneMessageViewSchema,
  PhonePersonSchema,
  PhoneRoleSchema,
  PhoneSendMessageResponseSchema,
  PhoneWalkerViewSchema,
  PresetReplyIdSchema,
  type CareLiveAccess,
  type CircleErrorCode,
  type CircleInvite,
  type CircleMember,
  type OwnerPhonesResponse,
  type PhoneHomeResponse,
  type PhoneMessageView,
  type PhonePerson,
  type PhoneRole,
  type PhoneWalkerView,
  type PresetReplyId,
} from "@walker/contracts";
import type { z } from "zod";

/**
 * The circle's client, in one file: what the two-phone app (/app) and the owner's "Phones" panel on /walker
 * ask of the server. Shapes are the contract's "two-phone app" section (`packages/contracts/src/circle.ts`).
 * Each side has one interface and two implementations: the real fetch client here, and the in-memory fake in
 * `phoneFake.ts` (unit tests, `/app?preview=` and `/walker?fake=1`, each labelled on screen; never on stage).
 *
 * Phone routes (the `walker_member` cookie, path /api/v1/circle):
 * - GET  /api/v1/circle           → PhoneHomeResponse
 * - POST /api/v1/circle/join      { code, consent: { circle_data_notice: true } } → 201 PhoneHomeResponse (sets the cookie)
 * - POST /api/v1/circle/messages  { client_message_id, text } (a caretaker types)
 *                                 { client_message_id, preset, to_member_id } (her phone taps a preset)
 *                                 → 201 { message: PhoneMessageView }
 * - PUT  /api/v1/circle/location-sharing { enabled: true, consent: true } or { enabled: false } → { enabled } (walker user only)
 * - POST /api/v1/circle/live      → { live: { uri, database, token, expires_at } | null } (SpacetimeDB, careLive.ts)
 * Owner routes (the `walker_owner` cookie):
 * - GET    /api/v1/walkers/{id}/circle                     → OwnerPhonesResponse
 * - POST   /api/v1/walkers/{id}/circle/invites             { name, role } → 201 { invite }
 * - POST   /api/v1/walkers/{id}/circle/joins/{member_id}   { consent: { walker_user_agreed: true } } → { member }
 * - DELETE /api/v1/walkers/{id}/circle/members/{member_id} → 204
 * - POST   /api/v1/walkers/{id}/circle/live                → { live } as above
 * Errors are `CircleErrorSchema` bodies.
 */

export { CIRCLE_MESSAGE_MAX, PRESET_REPLIES, PhonePersonSchema, PhoneRoleSchema, PresetReplyIdSchema };
export type { PhonePerson, PhoneRole, PresetReplyId };
export const PRESET_ORDER: readonly PresetReplyId[] = PresetReplyIdSchema.options;

/** One line, 1 to CIRCLE_MESSAGE_MAX characters: the contract's message text. */
export const PhoneTextSchema = CircleMessageSchema.shape.text;
export const PhoneMessageSchema = PhoneMessageViewSchema;
export type PhoneMessage = PhoneMessageView;
export const PhoneWalkerSchema = PhoneWalkerViewSchema;
export type PhoneWalker = PhoneWalkerView;
export const PhoneHomeSchema = PhoneHomeResponseSchema;
export type PhoneHome = PhoneHomeResponse;
export type PhoneMember = Extract<PhoneHome, { membership: "member" }>;

/** The app's whole view of the server. */
export interface PhoneApi {
  /** GET /api/v1/circle. A phone with no cookie, or a removed one, fails with `unauthenticated`. */
  home(signal?: AbortSignal): Promise<PhoneHome>;
  /** Only her approved phone can change this. Turning off erases the server's last fix. */
  setLocationSharing(enabled: boolean): Promise<boolean>;
  /** POST /api/v1/circle/join with the 6-digit code; sets the member cookie. */
  join(code: string): Promise<PhoneHome>;
  /** A caretaker's typed message to her phone. Reusing `clientMessageId` gets the same message back. */
  sendText(clientMessageId: string, text: string): Promise<PhoneMessage>;
  /** Her phone's one-tap reply to one person. */
  sendPreset(clientMessageId: string, preset: PresetReplyId, toMemberId: string): Promise<PhoneMessage>;
  /** A live connection to the circle in SpacetimeDB, or null when the server keeps it itself (the fake has none). */
  live?(): Promise<CareLiveAccess | null>;
}

/** What the owner's page asks about the phones linked to one walker. */
export interface OwnerPhonesApi {
  /** The phones, open codes (with the codes) and caretakers waiting for approval. */
  list(deviceId: string, signal?: AbortSignal): Promise<OwnerPhonesResponse>;
  /** "Add a phone": a one-time 6-digit code, good for 10 minutes. */
  addPhone(deviceId: string, name: string, role: PhoneRole): Promise<CircleInvite>;
  /** Approves a waiting caretaker, after the owner confirmed the consent line with her. */
  approve(deviceId: string, memberId: string): Promise<CircleMember>;
  /** Removes a phone, or declines a waiting one. Its messages are deleted at once. */
  remove(deviceId: string, memberId: string): Promise<void>;
  /** As PhoneApi.live, for this walker's circle. */
  live?(deviceId: string): Promise<CareLiveAccess | null>;
}

/** `network`: no answer at all. `not_offered`: a plain 404, a server without these routes yet. */
export type PhoneFailure = CircleErrorCode | "network" | "not_offered";

export class PhoneApiError extends Error {
  constructor(
    readonly code: PhoneFailure,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const BASE = "/api/v1/circle";
/** No request may hang the app: a stalled one counts as a network failure. */
export const PHONE_DEADLINE_MS = 8_000;

/** One request: a deadline, the cookie, the contract's error envelope, and the answer checked against `schema` (null: no body). */
async function circleCall<T>(fetchImpl: typeof fetch, path: string, init: RequestInit, schema: z.ZodType<T> | null): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), PHONE_DEADLINE_MS);
  const onAbort = () => deadline.abort();
  init.signal?.addEventListener("abort", onAbort);
  let response: Response;
  let body: unknown;
  try {
    response = await fetchImpl(path, {
      ...init,
      signal: deadline.signal,
      headers: init.body ? { "Content-Type": "application/json" } : undefined,
      credentials: "same-origin",
      cache: "no-store",
    });
    body = response.status === 204 ? null : await response.json().catch(() => null);
  } catch (error) {
    if (init.signal?.aborted) throw error;
    throw new PhoneApiError("network", "Couldn't reach the server.", 0);
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener("abort", onAbort);
  }
  if (!response.ok) {
    const parsed = CircleErrorSchema.safeParse(body);
    if (!parsed.success) {
      throw new PhoneApiError(response.status === 404 ? "not_offered" : "unavailable", "The server's answer wasn't one the app knows.", response.status);
    }
    throw new PhoneApiError(parsed.data.error.code, parsed.data.error.message, response.status);
  }
  if (!schema) return undefined as T;
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new PhoneApiError("unavailable", "The server's answer didn't match the contract.", response.status);
  return parsed.data;
}

const post = (body: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body) });

export function createPhoneApi(fetchImpl: typeof fetch = (...args) => fetch(...args)): PhoneApi {
  return {
    home: (signal) => circleCall(fetchImpl, BASE, { method: "GET", signal }, PhoneHomeSchema),
    async setLocationSharing(enabled) {
      return (await circleCall(fetchImpl, `${BASE}/location-sharing`, { method: "PUT", body: JSON.stringify(enabled ? { enabled: true, consent: true } : { enabled: false }) }, LocationSharingResponseSchema)).enabled;
    },
    join: (code) => circleCall(fetchImpl, `${BASE}/join`, post({ code, consent: { circle_data_notice: true } }), PhoneHomeSchema),
    async sendText(clientMessageId, text) {
      const body = post({ client_message_id: clientMessageId, text });
      return (await circleCall(fetchImpl, `${BASE}/messages`, body, PhoneSendMessageResponseSchema)).message;
    },
    async sendPreset(clientMessageId, preset, toMemberId) {
      const body = post({ client_message_id: clientMessageId, preset, to_member_id: toMemberId });
      return (await circleCall(fetchImpl, `${BASE}/messages`, body, PhoneSendMessageResponseSchema)).message;
    },
    live: () => liveCall(fetchImpl, `${BASE}/live`),
  };
}

/** A server without the live route (`not_offered`) just has no live updates. */
async function liveCall(fetchImpl: typeof fetch, path: string): Promise<CareLiveAccess | null> {
  try {
    return (await circleCall(fetchImpl, path, post({}), CareLiveResponseSchema)).live;
  } catch (error) {
    if (error instanceof PhoneApiError && error.code === "not_offered") return null;
    throw error;
  }
}

export function createOwnerPhonesApi(fetchImpl: typeof fetch = (...args) => fetch(...args)): OwnerPhonesApi {
  const circle = (id: string) => `/api/v1/walkers/${encodeURIComponent(id)}/circle`;
  return {
    list: (deviceId, signal) => circleCall(fetchImpl, circle(deviceId), { method: "GET", signal }, OwnerPhonesResponseSchema),
    async addPhone(deviceId, name, role) {
      return (await circleCall(fetchImpl, `${circle(deviceId)}/invites`, post({ name, role }), CreateInviteResponseSchema)).invite;
    },
    async approve(deviceId, memberId) {
      const body = post({ consent: { walker_user_agreed: true } });
      return (await circleCall(fetchImpl, `${circle(deviceId)}/joins/${encodeURIComponent(memberId)}`, body, ApproveJoinResponseSchema)).member;
    },
    async remove(deviceId, memberId) {
      await circleCall(fetchImpl, `${circle(deviceId)}/members/${encodeURIComponent(memberId)}`, { method: "DELETE" }, null);
    },
    live: (deviceId) => liveCall(fetchImpl, `${circle(deviceId)}/live`),
  };
}
