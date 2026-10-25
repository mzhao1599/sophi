import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MemoryWalkerStore, type WalkerAgent, type WalkerBackend } from "@walker/cloud-api";
import {
  CIRCLE_ERROR_STATUS,
  CircleErrorSchema,
  CreateInviteResponseSchema,
  OwnerPhonesResponseSchema,
  PAIRING_MAX_WRONG,
  PhoneHomeResponseSchema,
  PhoneSendMessageResponseSchema,
  WalkerErrorSchema,
  type CircleErrorCode,
} from "@walker/contracts";
import * as pairingCodes from "../app/api/v1/walkers/pairing-codes/route";
import * as pair from "../app/api/v1/devices/pair/route";
import * as heartbeat from "../app/api/v1/devices/[id]/heartbeat/route";
import * as ownerCircle from "../app/api/v1/walkers/[id]/circle/route";
import * as invites from "../app/api/v1/walkers/[id]/circle/invites/route";
import * as approve from "../app/api/v1/walkers/[id]/circle/joins/[memberId]/route";
import * as members from "../app/api/v1/walkers/[id]/circle/members/[memberId]/route";
import * as home from "../app/api/v1/circle/route";
import * as join from "../app/api/v1/circle/join/route";
import * as messages from "../app/api/v1/circle/messages/route";

/**
 * The two-phone circle's routes over HTTP, against the in-memory store: which proof each route reads
 * (owner cookie, member cookie, the walker's Bearer, none), the member cookie's attributes, the
 * cross-site refusal, the wrong-code lockout, message limits and removal, and what reaches the log.
 */

const BASE = "http://localhost:3006";
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) as never });

type Init = { method?: string; owner?: string; member?: string; bearer?: string; body?: unknown; headers?: Record<string, string> };
function request(path: string, init: Init = {}) {
  const headers: Record<string, string> = { ...init.headers };
  const cookies = [init.owner && `walker_owner=${init.owner}`, init.member && `walker_member=${init.member}`].filter(Boolean);
  if (cookies.length) headers.cookie = cookies.join("; ");
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`${BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

async function expectError(response: Response, code: CircleErrorCode) {
  expect(response.status).toBe(CIRCLE_ERROR_STATUS[code]);
  const body = CircleErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  return body;
}

const shared = globalThis as unknown as { __walkerBackend?: WalkerBackend; __walkerAgent?: WalkerAgent };
const store = new MemoryWalkerStore();
beforeAll(() => {
  shared.__walkerBackend = { kind: "memory", store };
  shared.__walkerAgent = { assistant: null, ears: null, voice: null };
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  shared.__walkerBackend = { kind: "memory", store };
});

function beatBody() {
  const now = new Date().toISOString();
  return { sent_at: now, service_version: "pi-0.1.0", manifest: { device_configuration_version: 1, generated_at: now, simulator: true, modules: [] }, snapshot: null, events: [] };
}

async function pairWalker() {
  const codeResponse = await pairingCodes.POST(request("/api/v1/walkers/pairing-codes", { method: "POST" }));
  const owner = /walker_owner=([^;]+)/.exec(codeResponse.headers.get("set-cookie") ?? "")![1]!;
  const { code } = await codeResponse.json();
  const paired = await pair.POST(request("/api/v1/devices/pair", { body: { code, service_version: "pi-0.1.0" } }));
  const { device_id, credential } = await paired.json();
  const beat = await heartbeat.POST(request(`/api/v1/devices/${device_id}/heartbeat`, { bearer: credential, body: beatBody() }), ctx({ id: device_id }));
  expect(beat.status).toBe(200);
  return { owner, deviceId: device_id as string, credential: credential as string };
}

async function addPhone(w: { owner: string; deviceId: string }, role: "walker_user" | "caregiver", name: string) {
  const response = await invites.POST(request(`/api/v1/walkers/${w.deviceId}/circle/invites`, { owner: w.owner, body: { name, role } }), ctx({ id: w.deviceId }));
  expect(response.status).toBe(201);
  return CreateInviteResponseSchema.parse(await response.json()).invite;
}

async function joinWith(code: string, headers: Record<string, string> = {}) {
  const response = await join.POST(request("/api/v1/circle/join", { body: { code, consent: { circle_data_notice: true } }, headers }));
  const member = /walker_member=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1];
  return { response, member, setCookie: response.headers.get("set-cookie") };
}

/** Her phone and an approved caretaker. */
async function twoPhones() {
  const w = await pairWalker();
  const rose = (await joinWith((await addPhone(w, "walker_user", "Rose")).code)).member!;
  const maya = (await joinWith((await addPhone(w, "caregiver", "Maya")).code)).member!;
  const list = OwnerPhonesResponseSchema.parse(await (await ownerCircle.GET(request(`/api/v1/walkers/${w.deviceId}/circle`, { owner: w.owner }), ctx({ id: w.deviceId }))).json());
  const mayaId = list.joins[0]!.member_id;
  const approved = await approve.POST(
    request(`/api/v1/walkers/${w.deviceId}/circle/joins/${mayaId}`, { owner: w.owner, body: { consent: { walker_user_agreed: true } } }),
    ctx({ id: w.deviceId, memberId: mayaId }),
  );
  expect(approved.status).toBe(200);
  const roseHome = PhoneHomeResponseSchema.parse(await (await home.GET(request("/api/v1/circle", { member: rose }))).json());
  if (roseHome.membership !== "member") throw new Error("Rose should be in.");
  return { w, rose, maya, roseId: roseHome.me.member_id, mayaId };
}

describe("circle routes", () => {
  it("sets the member cookie httpOnly, SameSite=Strict, scoped to /api/v1/circle, and Secure in production", async () => {
    const w = await pairWalker();
    const { setCookie } = await joinWith((await addPhone(w, "walker_user", "Rose")).code);
    expect(setCookie).toMatch(/^walker_member=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toMatch(/Path=\/api\/v1\/circle/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=strict/i);
    expect(setCookie).not.toMatch(/Secure/i);
    vi.stubEnv("NODE_ENV", "production");
    const again = await joinWith((await addPhone(w, "caregiver", "Maya")).code);
    expect(again.setCookie).toMatch(/Secure/i);
  });

  it("reads only the owner cookie on owner routes and only the member cookie on phone routes", async () => {
    const { w, rose } = await twoPhones();
    const ownerRead = (init: Init) => ownerCircle.GET(request(`/api/v1/walkers/${w.deviceId}/circle`, init), ctx({ id: w.deviceId }));
    expect((await ownerRead({ owner: w.owner })).status).toBe(200);
    await expectError(await ownerRead({}), "unauthenticated");
    await expectError(await ownerRead({ bearer: w.credential }), "unauthenticated");
    await expectError(await ownerRead({ member: rose }), "unauthenticated");
    // A phone's secret sent as an owner cookie owns nothing.
    await expectError(await ownerRead({ owner: rose }), "not_found");

    const phoneRead = (init: Init) => home.GET(request("/api/v1/circle", init));
    expect((await phoneRead({ member: rose })).status).toBe(200);
    await expectError(await phoneRead({}), "unauthenticated");
    await expectError(await phoneRead({ bearer: w.credential }), "unauthenticated");
    await expectError(await phoneRead({ owner: w.owner }), "unauthenticated");
    await expectError(await phoneRead({ member: w.owner }), "unauthenticated");

    const send = (init: Init) => messages.POST(request("/api/v1/circle/messages", { ...init, body: { client_message_id: crypto.randomUUID(), text: "Hello" } }));
    await expectError(await send({ owner: w.owner }), "unauthenticated");
    await expectError(await send({ bearer: w.credential }), "unauthenticated");

    // The walker's own routes still read only its Bearer.
    const beat = await heartbeat.POST(request(`/api/v1/devices/${w.deviceId}/heartbeat`, { member: rose, body: beatBody() }), ctx({ id: w.deviceId }));
    expect(beat.status).toBe(401);
    expect(WalkerErrorSchema.parse(await beat.json()).error.code).toBe("unauthenticated");
  });

  it("refuses a join or a new code that another site made the browser send, setting no cookie", async () => {
    const w = await pairWalker();
    const invite = await addPhone(w, "walker_user", "Rose");
    const crossJoin = await joinWith(invite.code, { "sec-fetch-site": "cross-site" });
    await expectError(crossJoin.response, "invalid_request");
    expect(crossJoin.setCookie).toBeNull();
    const crossInvite = await invites.POST(
      request(`/api/v1/walkers/${w.deviceId}/circle/invites`, { owner: w.owner, body: { name: "Eve", role: "caregiver" }, headers: { "sec-fetch-site": "cross-site" } }),
      ctx({ id: w.deviceId }),
    );
    await expectError(crossInvite, "invalid_request");
    // The code is still good from this site.
    expect((await joinWith(invite.code, { "sec-fetch-site": "same-origin" })).response.status).toBe(201);
  });

  it("locks an address out after the wrong-code limit", async () => {
    vi.stubEnv("RENDER", "true");
    const w = await pairWalker();
    const invite = await addPhone(w, "caregiver", "Maya");
    const wrong = invite.code === "000000" ? "000001" : "000000";
    const from = { "cf-connecting-ip": "198.51.100.90" };
    for (let i = 0; i < PAIRING_MAX_WRONG; i++) await expectError((await joinWith(wrong, from)).response, "invite_code_invalid");
    await expectError((await joinWith(invite.code, from)).response, "invite_locked");
    expect((await joinWith(invite.code, { "cf-connecting-ip": "198.51.100.91" })).response.status).toBe(201);
  });

  it("approves a caretaker only with the consent confirmed", async () => {
    const w = await pairWalker();
    await joinWith((await addPhone(w, "caregiver", "Maya")).code);
    const list = OwnerPhonesResponseSchema.parse(await (await ownerCircle.GET(request(`/api/v1/walkers/${w.deviceId}/circle`, { owner: w.owner }), ctx({ id: w.deviceId }))).json());
    const id = list.joins[0]!.member_id;
    const post = (body: unknown, owner = w.owner) => approve.POST(request(`/api/v1/walkers/${w.deviceId}/circle/joins/${id}`, { owner, body }), ctx({ id: w.deviceId, memberId: id }));
    await expectError(await post({}), "invalid_request");
    await expectError(await post({ consent: { walker_user_agreed: false } }), "invalid_request");
    const other = await pairWalker();
    await expectError(await post({ consent: { walker_user_agreed: true } }, other.owner), "not_found");
    expect((await post({ consent: { walker_user_agreed: true } })).status).toBe(200);
    // A retried Approve gets the member again, not an error.
    expect((await post({ consent: { walker_user_agreed: true } })).status).toBe(200);
  });

  it("limits messages to 30 characters, and removing a phone deletes its messages and ends its cookie", async () => {
    const { w, rose, maya, mayaId } = await twoPhones();
    const send = (member: string, body: unknown) => messages.POST(request("/api/v1/circle/messages", { member, body }));
    await expectError(await send(maya, { client_message_id: crypto.randomUUID(), text: "x".repeat(31) }), "invalid_request");
    const sent = await send(maya, { client_message_id: crypto.randomUUID(), text: "Lunch at noon?" });
    expect(sent.status).toBe(201);
    expect(PhoneSendMessageResponseSchema.parse(await sent.json()).message.text).toBe("Lunch at noon?");
    expect((await send(rose, { client_message_id: crypto.randomUUID(), preset: "on_my_way", to_member_id: mayaId })).status).toBe(201);
    await expectError(await send(rose, { client_message_id: crypto.randomUUID(), text: "typed" }), "not_allowed");

    const removed = await members.DELETE(request(`/api/v1/walkers/${w.deviceId}/circle/members/${mayaId}`, { method: "DELETE", owner: w.owner }), ctx({ id: w.deviceId, memberId: mayaId }));
    expect(removed.status).toBe(204);
    await expectError(await home.GET(request("/api/v1/circle", { member: maya })), "unauthenticated");
    const roseHome = PhoneHomeResponseSchema.parse(await (await home.GET(request("/api/v1/circle", { member: rose }))).json());
    expect(roseHome.membership === "member" && roseHome.messages).toEqual([]);
  });

  it("logs route, id, status and time, and a message's length, never names, codes or words", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((line: string) => void lines.push(line));
    const { w, maya } = await twoPhones();
    const invite = await addPhone(w, "caregiver", "Zed");
    await messages.POST(request("/api/v1/circle/messages", { member: maya, body: { client_message_id: crypto.randomUUID(), text: "Lunch at noon?" } }));
    expect(lines.some((l) => /^\[circle\] route=circle\.message device=- status=201 ms=\d+$/.test(l))).toBe(true);
    expect(lines.some((l) => /^\[circle\] message device=[0-9a-f-]{36} from=caregiver length=14 created=true$/.test(l))).toBe(true);
    expect(lines.some((l) => /^\[circle\] route=walkers\.circle\.invite device=[0-9a-f-]{36} status=201 ms=\d+$/.test(l))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain("Lunch");
      expect(line).not.toContain("Maya");
      expect(line).not.toContain("Zed");
      expect(line).not.toContain(invite.code);
      expect(line).not.toContain(maya);
      expect(line).not.toContain(w.owner);
    }
  });
});
