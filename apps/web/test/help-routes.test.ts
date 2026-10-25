import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MemoryWalkerStore, type WalkerAgent, type WalkerBackend } from "@walker/cloud-api";
import {
  CIRCLE_ERROR_STATUS,
  CircleErrorSchema,
  CreateInviteResponseSchema,
  DeviceHelpStatusResponseSchema,
  HelpResponseSchema,
  OwnerPhonesResponseSchema,
  PhoneHomeResponseSchema,
  WALKER_ERROR_STATUS,
  WalkerErrorSchema,
  type CircleErrorCode,
  type WalkerErrorCode,
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
import * as deviceHelp from "../app/api/v1/devices/[id]/help/route";
import * as deviceOkay from "../app/api/v1/devices/[id]/help/[helpId]/okay/route";
import * as phoneHelp from "../app/api/v1/circle/help/route";
import * as phoneComing from "../app/api/v1/circle/help/[helpId]/coming/route";
import * as phoneOkay from "../app/api/v1/circle/help/[helpId]/okay/route";

/**
 * Asking for help over HTTP (EXPECTED-help.md in services/cloud-api), against the in-memory store: which proof
 * each route reads, 201 against 200, the walker envelope on the walker's routes and the circle envelope on the
 * phones', `409 no_caretaker` and `409 help_closed` with the request, and what reaches the log.
 */

const BASE = "http://localhost:3006";
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) as never });

type Init = { method?: string; owner?: string; member?: string; bearer?: string; body?: unknown };
function request(path: string, init: Init = {}) {
  const headers: Record<string, string> = {};
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

async function walkerFailure(response: Response, code: WalkerErrorCode) {
  expect(response.status).toBe(WALKER_ERROR_STATUS[code]);
  const body = WalkerErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  return body;
}

async function circleFailure(response: Response, code: CircleErrorCode) {
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
  vi.restoreAllMocks();
  shared.__walkerBackend = { kind: "memory", store };
});

async function pairWalker() {
  const codeResponse = await pairingCodes.POST(request("/api/v1/walkers/pairing-codes", { method: "POST" }));
  const owner = /walker_owner=([^;]+)/.exec(codeResponse.headers.get("set-cookie") ?? "")![1]!;
  const { code } = await codeResponse.json();
  const paired = await pair.POST(request("/api/v1/devices/pair", { body: { code, service_version: "pi-0.1.0", name: "Rose's walker" } }));
  const { device_id, credential } = await paired.json();
  const now = new Date().toISOString();
  const beat = await heartbeat.POST(
    request(`/api/v1/devices/${device_id}/heartbeat`, {
      bearer: credential,
      body: { sent_at: now, service_version: "pi-0.1.0", manifest: { device_configuration_version: 1, generated_at: now, simulator: true, modules: [] }, snapshot: null, events: [] },
    }),
    ctx({ id: device_id }),
  );
  expect(beat.status).toBe(200);
  return { owner, deviceId: device_id as string, credential: credential as string };
}

async function addPhone(w: { owner: string; deviceId: string }, role: "walker_user" | "caregiver", name: string) {
  const invite = CreateInviteResponseSchema.parse(
    await (await invites.POST(request(`/api/v1/walkers/${w.deviceId}/circle/invites`, { owner: w.owner, body: { name, role } }), ctx({ id: w.deviceId }))).json(),
  ).invite;
  const joined = await join.POST(request("/api/v1/circle/join", { body: { code: invite.code, consent: { circle_data_notice: true } } }));
  const member = /walker_member=([^;]+)/.exec(joined.headers.get("set-cookie") ?? "")![1]!;
  if (role === "caregiver") {
    const list = OwnerPhonesResponseSchema.parse(await (await ownerCircle.GET(request(`/api/v1/walkers/${w.deviceId}/circle`, { owner: w.owner }), ctx({ id: w.deviceId }))).json());
    const id = list.joins.find((j) => j.name === name)!.member_id;
    const approved = await approve.POST(request(`/api/v1/walkers/${w.deviceId}/circle/joins/${id}`, { owner: w.owner, body: { consent: { walker_user_agreed: true } } }), ctx({ id: w.deviceId, memberId: id }));
    expect(approved.status).toBe(200);
  }
  return member;
}

const walkerAsk = (w: { deviceId: string }, init: Init) => deviceHelp.POST(request(`/api/v1/devices/${w.deviceId}/help`, init), ctx({ id: w.deviceId }));
const walkerRead = (w: { deviceId: string }, init: Init) => deviceHelp.GET(request(`/api/v1/devices/${w.deviceId}/help`, init), ctx({ id: w.deviceId }));
const walkerOkay = (w: { deviceId: string }, helpId: string, init: Init) =>
  deviceOkay.POST(request(`/api/v1/devices/${w.deviceId}/help/${helpId}/okay`, { method: "POST", ...init }), ctx({ id: w.deviceId, helpId }));
const coming = (helpId: string, member: string | undefined) => phoneComing.POST(request(`/api/v1/circle/help/${helpId}/coming`, { method: "POST", member }), ctx({ helpId }));
const okay = (helpId: string, member: string | undefined) => phoneOkay.POST(request(`/api/v1/circle/help/${helpId}/okay`, { method: "POST", member }), ctx({ helpId }));

describe("help routes", () => {
  it("asks from the walker (201, then 200), reads it, and closes it with her second Confirm; logs no names", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const w = await pairWalker();
    await addPhone(w, "walker_user", "Rose");
    await addPhone(w, "caregiver", "Maya");
    const id = crypto.randomUUID();
    const first = await walkerAsk(w, { bearer: w.credential, body: { client_help_id: id, source: "handles" } });
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const { help } = HelpResponseSchema.parse(await first.json());
    expect(help.sent_to.map((p) => p.name)).toEqual(["Maya"]);
    const again = await walkerAsk(w, { bearer: w.credential, body: { client_help_id: crypto.randomUUID(), source: "voice" } });
    expect(again.status).toBe(200);
    expect(HelpResponseSchema.parse(await again.json()).help.help_id).toBe(help.help_id);
    const read = DeviceHelpStatusResponseSchema.parse(await (await walkerRead(w, { bearer: w.credential })).json());
    expect(read.help?.help_id).toBe(help.help_id);
    const closed = await walkerOkay(w, help.help_id, { bearer: w.credential });
    expect(closed.status).toBe(200);
    expect(HelpResponseSchema.parse(await closed.json()).help.closed).toMatchObject({ how: "okay", by: { name: "Rose" } });
    // Already closed: 409 help_closed in the walker envelope, carrying the request.
    const twice = await walkerFailure(await walkerOkay(w, help.help_id, { bearer: w.credential }), "help_closed");
    expect(twice.error.help?.closed?.how).toBe("okay");
    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("route=devices.help.ask") && l.includes("status=201"))).toBe(true);
    expect(lines.some((l) => l.includes("[circle] help action=ask") && l.includes("via=handles") && l.includes("outcome=created"))).toBe(true);
    expect(lines.join("\n")).not.toMatch(/Maya|Rose|walker'/);
  });

  it("reads only the walker's Bearer on its routes, and answers in the walker envelope", async () => {
    const w = await pairWalker();
    const other = await pairWalker();
    const rose = await addPhone(w, "walker_user", "Rose");
    const body = { client_help_id: crypto.randomUUID(), source: "handles" };
    await walkerFailure(await walkerAsk(w, { body }), "unauthenticated");
    await walkerFailure(await walkerAsk(w, { owner: w.owner, body }), "unauthenticated");
    await walkerFailure(await walkerAsk(w, { member: rose, body }), "unauthenticated");
    await walkerFailure(await walkerAsk(other, { bearer: w.credential, body }), "not_found");
    await walkerFailure(await walkerRead(w, {}), "unauthenticated");
    await walkerFailure(await walkerAsk(w, { bearer: w.credential, body: { ...body, source: "phone" } }), "invalid_request");
    await walkerFailure(await walkerAsk(w, { bearer: w.credential, body: { ...body, extra: 1 } }), "invalid_request");
    // No caretaker: 409 no_caretaker in the walker envelope, and nothing kept.
    await walkerFailure(await walkerAsk(w, { bearer: w.credential, body }), "no_caretaker");
    expect(DeviceHelpStatusResponseSchema.parse(await (await walkerRead(w, { bearer: w.credential })).json()).help).toBeNull();
    await walkerFailure(await walkerOkay(w, crypto.randomUUID(), { bearer: w.credential }), "not_found");
  });

  it("asks from her phone, answers from the caretakers' phones, and uses the circle envelope there", async () => {
    const w = await pairWalker();
    const rose = await addPhone(w, "walker_user", "Rose");
    const maya = await addPhone(w, "caregiver", "Maya");
    const ana = await addPhone(w, "caregiver", "Ana");
    await circleFailure(await phoneHelp.POST(request("/api/v1/circle/help", { member: maya, body: { client_help_id: crypto.randomUUID() } })), "not_allowed");
    await circleFailure(await phoneHelp.POST(request("/api/v1/circle/help", { bearer: w.credential, body: { client_help_id: crypto.randomUUID() } })), "unauthenticated");
    const asked = await phoneHelp.POST(request("/api/v1/circle/help", { member: rose, body: { client_help_id: crypto.randomUUID() } }));
    expect(asked.status).toBe(201);
    const { help } = HelpResponseSchema.parse(await asked.json());
    expect(help.source).toBe("phone");

    // Maya's app shows it: her GET /circle adds her to shown_to; her phone's doesn't.
    const mayaHome = PhoneHomeResponseSchema.parse(await (await home.GET(request("/api/v1/circle", { member: maya }))).json());
    if (mayaHome.membership !== "member") throw new Error("Maya should be in.");
    expect(mayaHome.help?.shown_to.map((p) => p.name)).toEqual(["Maya"]);
    await home.GET(request("/api/v1/circle", { member: rose }));
    const walkerView = DeviceHelpStatusResponseSchema.parse(await (await walkerRead(w, { bearer: w.credential })).json());
    expect(walkerView.help?.shown_to.map((p) => p.name)).toEqual(["Maya"]);

    await circleFailure(await coming(help.help_id, rose), "not_allowed");
    const onWay = await coming(help.help_id, maya);
    expect(onWay.status).toBe(200);
    expect(HelpResponseSchema.parse(await onWay.json()).help.coming.map((p) => p.name)).toEqual(["Maya"]);
    const withHer = await okay(help.help_id, ana);
    expect(HelpResponseSchema.parse(await withHer.json()).help.closed).toMatchObject({ how: "with_her", by: { name: "Ana" } });
    const late = await circleFailure(await okay(help.help_id, rose), "help_closed");
    expect(late.error.help?.closed?.by?.name).toBe("Ana");
    await circleFailure(await coming(crypto.randomUUID(), maya), "not_found");
    await circleFailure(await coming(help.help_id, undefined), "unauthenticated");

    // A removed caretaker's cookie stops working; the request stays.
    const list = OwnerPhonesResponseSchema.parse(await (await ownerCircle.GET(request(`/api/v1/walkers/${w.deviceId}/circle`, { owner: w.owner }), ctx({ id: w.deviceId }))).json());
    const mayaId = list.members.find((m) => m.name === "Maya")!.member_id;
    const removed = await members.DELETE(request(`/api/v1/walkers/${w.deviceId}/circle/members/${mayaId}`, { method: "DELETE", owner: w.owner }), ctx({ id: w.deviceId, memberId: mayaId }));
    expect(removed.status).toBe(204);
    await circleFailure(await coming(help.help_id, maya), "unauthenticated");
    expect(DeviceHelpStatusResponseSchema.parse(await (await walkerRead(w, { bearer: w.credential })).json()).help?.help_id).toBe(help.help_id);
    expect(JSON.stringify(await (await ownerCircle.GET(request(`/api/v1/walkers/${w.deviceId}/circle`, { owner: w.owner }), ctx({ id: w.deviceId }))).json())).not.toContain(help.help_id);
  });
});
