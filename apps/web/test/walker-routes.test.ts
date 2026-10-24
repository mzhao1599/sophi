import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { MemoryWalkerStore, type WalkerAgent, type WalkerBackend } from "@walker/cloud-api";
import { AnswerProposalResponseSchema, WALKER_ERROR_STATUS, WalkerErrorSchema, WalkerListResponseSchema, WalkerTurnResponseSchema, type HeartbeatRequest } from "@walker/contracts";
import { clientAddress } from "@/server/walker";
import * as health from "../app/api/v1/health/route";
import * as pairingCodes from "../app/api/v1/walkers/pairing-codes/route";
import * as walkers from "../app/api/v1/walkers/route";
import * as walker from "../app/api/v1/walkers/[id]/route";
import * as pair from "../app/api/v1/devices/pair/route";
import * as heartbeat from "../app/api/v1/devices/[id]/heartbeat/route";
import * as configuration from "../app/api/v1/devices/[id]/configuration/route";
import * as deviceAnswer from "../app/api/v1/devices/[id]/proposals/[proposalId]/route";
import * as pageAnswer from "../app/api/v1/walkers/[id]/proposals/[proposalId]/route";
import * as deviceTurns from "../app/api/v1/devices/[id]/turns/route";
import * as pageTurns from "../app/api/v1/walkers/[id]/turns/route";

/**
 * The walker routes over HTTP, against the in-memory store (no DATABASE_URL in tests): which proof
 * each route reads, the owner cookie's attributes, the error envelope, body limits, the client address
 * for the pairing lockout, and what reaches the log.
 */

const BASE = "http://localhost:3006";
const ctx = (params: Record<string, string>) => ({ params: Promise.resolve(params) as never });

function request(path: string, init: { method?: string; cookie?: string; bearer?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...init.headers };
  if (init.cookie) headers.cookie = `walker_owner=${init.cookie}`;
  if (init.bearer) headers.authorization = `Bearer ${init.bearer}`;
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`${BASE}${path}`, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers,
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
}

async function expectError(response: Response, code: keyof typeof WALKER_ERROR_STATUS) {
  expect(response.status).toBe(WALKER_ERROR_STATUS[code]);
  const body = WalkerErrorSchema.parse(await response.json());
  expect(body.error.code).toBe(code);
  return body;
}

function beat(): HeartbeatRequest {
  const now = new Date().toISOString();
  return {
    sent_at: now,
    service_version: "pi-0.1.0",
    manifest: { device_configuration_version: 1, generated_at: now, simulator: true, modules: [] },
    snapshot: null,
    events: [],
  };
}

async function pairOverHttp(address = "198.51.100.20") {
  const codeResponse = await pairingCodes.POST(request("/api/v1/walkers/pairing-codes", { method: "POST" }));
  expect(codeResponse.status).toBe(201);
  const cookie = /walker_owner=([^;]+)/.exec(codeResponse.headers.get("set-cookie") ?? "")?.[1];
  const { code } = await codeResponse.json();
  const paired = await pair.POST(request("/api/v1/devices/pair", { body: { code, service_version: "pi-0.1.0" }, headers: { "x-forwarded-for": address } }));
  expect(paired.status).toBe(201);
  const { device_id, credential } = await paired.json();
  return { cookie: cookie!, deviceId: device_id as string, credential: credential as string, setCookie: codeResponse.headers.get("set-cookie")! };
}

// The process-wide backend, set here so no test depends on which one ran first.
const shared = globalThis as unknown as { __walkerBackend?: WalkerBackend; __walkerAgent?: WalkerAgent };
const store = new MemoryWalkerStore();
beforeAll(() => {
  shared.__walkerBackend = { kind: "memory", store };
  // No model or voice in these tests, whatever the shell has: turns get the fixed line.
  shared.__walkerAgent = { assistant: null, voice: null };
});

/** A 16 kHz mono 16-bit WAV of silence. */
function wav(ms: number): Buffer {
  const data = 32 * ms;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0, "ascii");
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVEfmt ", 8, "ascii");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16_000, 24);
  b.writeUInt32LE(32_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "ascii");
  b.writeUInt32LE(data, 40);
  return b;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  shared.__walkerBackend = { kind: "memory", store };
});

describe("walker routes", () => {
  it("sets the owner cookie httpOnly, SameSite=Strict, scoped to /api/v1/walkers", async () => {
    const { setCookie } = await pairOverHttp();
    expect(setCookie).toMatch(/^walker_owner=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toMatch(/Path=\/api\/v1\/walkers/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=strict/i);
    expect(setCookie).not.toMatch(/Secure/i);
  });

  it("marks the cookie Secure in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = await pairingCodes.POST(request("/api/v1/walkers/pairing-codes", { method: "POST" }));
    expect(response.headers.get("set-cookie")).toMatch(/Secure/i);
  });

  it("reads only the cookie on page routes and only the Bearer on device routes", async () => {
    const w = await pairOverHttp();
    expect((await walkers.GET(request("/api/v1/walkers", { cookie: w.cookie }))).status).toBe(200);
    expect((await heartbeat.POST(request(`/api/v1/devices/${w.deviceId}/heartbeat`, { bearer: w.credential, body: beat() }), ctx({ id: w.deviceId }))).status).toBe(200);
    // Each proof on the other's routes, alone.
    await expectError(await walkers.GET(request("/api/v1/walkers", { bearer: w.credential })), "unauthenticated");
    await expectError(await walker.GET(request(`/api/v1/walkers/${w.deviceId}`, { bearer: w.credential }), ctx({ id: w.deviceId })), "unauthenticated");
    await expectError(await heartbeat.POST(request(`/api/v1/devices/${w.deviceId}/heartbeat`, { cookie: w.cookie, body: beat() }), ctx({ id: w.deviceId })), "unauthenticated");
    await expectError(await configuration.GET(request(`/api/v1/devices/${w.deviceId}/configuration`, { cookie: w.cookie }), ctx({ id: w.deviceId })), "unauthenticated");
    // Each secret presented as the other proof.
    expect(await (await walkers.GET(request("/api/v1/walkers", { cookie: w.credential }))).json()).toEqual({ walkers: [] });
    await expectError(await configuration.GET(request(`/api/v1/devices/${w.deviceId}/configuration`, { bearer: w.cookie }), ctx({ id: w.deviceId })), "unauthenticated");
  });

  it("answers someone else's walker and an unknown one the same way", async () => {
    const mine = await pairOverHttp();
    const theirs = await pairOverHttp("198.51.100.21");
    const a = await expectError(await walker.GET(request(`/api/v1/walkers/${theirs.deviceId}`, { cookie: mine.cookie }), ctx({ id: theirs.deviceId })), "not_found");
    const unknown = crypto.randomUUID();
    const b = await expectError(await walker.GET(request(`/api/v1/walkers/${unknown}`, { cookie: mine.cookie }), ctx({ id: unknown })), "not_found");
    expect(a.error.message).toBe(b.error.message);
  });

  it("forgets a walker with 204 and then refuses its credential", async () => {
    const w = await pairOverHttp();
    const forgotten = await walker.DELETE(request(`/api/v1/walkers/${w.deviceId}`, { method: "DELETE", cookie: w.cookie }), ctx({ id: w.deviceId }));
    expect(forgotten.status).toBe(204);
    expect(await forgotten.text()).toBe("");
    await expectError(await heartbeat.POST(request(`/api/v1/devices/${w.deviceId}/heartbeat`, { bearer: w.credential, body: beat() }), ctx({ id: w.deviceId })), "unauthenticated");
  });

  it("refuses bodies that aren't JSON, are malformed or are too large, with 400", async () => {
    const w = await pairOverHttp();
    const url = `/api/v1/devices/${w.deviceId}/heartbeat`;
    const notJson = new NextRequest(`${BASE}${url}`, { method: "POST", headers: { authorization: `Bearer ${w.credential}`, "content-type": "text/plain" }, body: "hi" });
    await expectError(await heartbeat.POST(notJson, ctx({ id: w.deviceId })), "invalid_request");
    await expectError(await heartbeat.POST(request(url, { bearer: w.credential, body: "{nope" }), ctx({ id: w.deviceId })), "invalid_request");
    const wrongShape = await expectError(await heartbeat.POST(request(url, { bearer: w.credential, body: { ...beat(), extra: 1 } }), ctx({ id: w.deviceId })), "invalid_request");
    expect(wrongShape.error.message).not.toContain(w.credential);
    const huge = await heartbeat.POST(request(url, { bearer: w.credential, body: { ...beat(), service_version: "x".repeat(70_000) } }), ctx({ id: w.deviceId }));
    expect((await expectError(huge, "invalid_request")).error.message).toBe("That request is too large.");
  });

  it("answers health with the store kind, and 503 when the store can't be reached", async () => {
    const response = await health.GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", walker_store: "memory" });
    const down = new MemoryWalkerStore();
    down.ping = async () => {
      throw new Error("connection refused");
    };
    shared.__walkerBackend = { kind: "postgres", store: down };
    const unhealthy = await health.GET();
    expect(unhealthy.status).toBe(503);
    expect(await unhealthy.json()).toEqual({ status: "unavailable", walker_store: "postgres" });
  });

  it("confirms from the walker's button, then tells the page the proposal is closed", async () => {
    const w = await pairOverHttp();
    await heartbeat.POST(request(`/api/v1/devices/${w.deviceId}/heartbeat`, { bearer: w.credential, body: beat() }), ctx({ id: w.deviceId }));
    const now = new Date();
    const clientTurnId = crypto.randomUUID();
    const proposalId = crypto.randomUUID();
    await store.saveTurn(
      w.deviceId,
      { turn_id: crypto.randomUUID(), client_turn_id: clientTurnId, source: "walker", heard: "Use short sounds.", heard_by: "gemini", reply: "Press Confirm to do it.", answered_by: "model", voiced_by: "walker", created_at: now.toISOString() },
      { proposal_id: proposalId, client_turn_id: clientTurnId, kind: "cues_change", from_cues: ["vibration", "spoken"], cues: ["sound", "spoken"], base_configuration_version: 1, summary: "Switch your alerts from buzzing to short sounds.", state: "open", created_at: now.toISOString(), expires_at: new Date(now.getTime() + 60_000).toISOString(), configuration_version: null },
      now,
    );
    const params = ctx({ id: w.deviceId, proposalId });
    const confirmed = await deviceAnswer.POST(request(`/api/v1/devices/${w.deviceId}/proposals/${proposalId}`, { bearer: w.credential, body: { answer: "confirm" } }), params);
    expect(confirmed.status).toBe(200);
    expect(AnswerProposalResponseSchema.parse(await confirmed.json()).proposal.configuration_version).toBe(2);
    const late = await pageAnswer.POST(request(`/api/v1/walkers/${w.deviceId}/proposals/${proposalId}`, { cookie: w.cookie, body: { answer: "decline" } }), params);
    expect((await expectError(late, "proposal_closed")).error.proposal?.state).toBe("confirmed");
  });

  it("takes a voice turn from the walker and a typed turn from the page, each with its own proof", async () => {
    const w = await pairOverHttp();
    await heartbeat.POST(request(`/api/v1/devices/${w.deviceId}/heartbeat`, { bearer: w.credential, body: beat() }), ctx({ id: w.deviceId }));
    const params = ctx({ id: w.deviceId });
    // 3 s of audio: about 128 KB in base64, past the 64 KB limit of the other routes.
    const voice = { client_turn_id: crypto.randomUUID(), input: { type: "audio", mime: "audio/wav", data_base64: wav(3000).toString("base64"), duration_ms: 3000 }, snapshot: null };
    const spoken = await deviceTurns.POST(request(`/api/v1/devices/${w.deviceId}/turns`, { bearer: w.credential, body: voice }), params);
    expect(spoken.status).toBe(200);
    const turn = WalkerTurnResponseSchema.parse(await spoken.json()).turn;
    expect(turn).toMatchObject({ source: "walker", answered_by: "fixed", heard: null, heard_by: null, voiced_by: "walker" });
    const typed = { client_turn_id: crypto.randomUUID(), input: { type: "text", text: "What can you help me with?" } };
    const page = await pageTurns.POST(request(`/api/v1/walkers/${w.deviceId}/turns`, { cookie: w.cookie, body: typed }), params);
    expect(WalkerTurnResponseSchema.parse(await page.json()).turn).toMatchObject({ source: "page", heard_by: "typed", voiced_by: null });
    await expectError(await deviceTurns.POST(request(`/api/v1/devices/${w.deviceId}/turns`, { cookie: w.cookie, body: voice }), params), "unauthenticated");
    await expectError(await pageTurns.POST(request(`/api/v1/walkers/${w.deviceId}/turns`, { bearer: w.credential, body: typed }), params), "unauthenticated");
    // The page sends text only.
    await expectError(await pageTurns.POST(request(`/api/v1/walkers/${w.deviceId}/turns`, { cookie: w.cookie, body: voice }), params), "invalid_request");
    // A full 15 s clip (480,044 bytes) is within the contract's 500,000-byte cap and the body limit; a longer
    // clip is refused by the contract, and a body past 800 KB is refused before parsing.
    const full = { ...voice, client_turn_id: crypto.randomUUID(), input: { ...voice.input, data_base64: wav(15_000).toString("base64"), duration_ms: 15_000 } };
    expect(full.input.data_base64.length).toBeGreaterThan(640_000);
    expect((await deviceTurns.POST(request(`/api/v1/devices/${w.deviceId}/turns`, { bearer: w.credential, body: full }), params)).status).toBe(200);
    const tooLong = { ...voice, client_turn_id: crypto.randomUUID(), input: { ...voice.input, data_base64: wav(16_000).toString("base64"), duration_ms: 15_000 } };
    await expectError(await deviceTurns.POST(request(`/api/v1/devices/${w.deviceId}/turns`, { bearer: w.credential, body: tooLong }), params), "invalid_request");
    const huge = { ...voice, client_turn_id: crypto.randomUUID(), padding: "A".repeat(800_000) };
    const refused = await expectError(await deviceTurns.POST(request(`/api/v1/devices/${w.deviceId}/turns`, { bearer: w.credential, body: huge }), params), "invalid_request");
    expect(refused.error.message).toBe("That request is too large.");
  });

  it("lists the owner's own walker activity (page only) after a turn, shared across routes, never another owner's", async () => {
    const w = await pairOverHttp();
    const other = await pairOverHttp("198.51.100.22");
    await heartbeat.POST(request(`/api/v1/devices/${w.deviceId}/heartbeat`, { bearer: w.credential, body: beat() }), ctx({ id: w.deviceId }));
    const typed = { client_turn_id: crypto.randomUUID(), input: { type: "text", text: "What can you help me with?" } };
    expect((await pageTurns.POST(request(`/api/v1/walkers/${w.deviceId}/turns`, { cookie: w.cookie, body: typed }), ctx({ id: w.deviceId }))).status).toBe(200);
    const voice = { client_turn_id: crypto.randomUUID(), input: { type: "audio", mime: "audio/wav", data_base64: wav(1000).toString("base64"), duration_ms: 1000 }, snapshot: null };
    expect((await deviceTurns.POST(request(`/api/v1/devices/${w.deviceId}/turns`, { bearer: w.credential, body: voice }), ctx({ id: w.deviceId }))).status).toBe(200);

    const listed = await walkers.GET(request("/api/v1/walkers", { cookie: w.cookie }));
    expect(listed.status).toBe(200);
    const body = WalkerListResponseSchema.parse(await listed.json());
    expect(body.activity).toHaveLength(1);
    expect(body.activity![0]).toMatchObject({ device_id: w.deviceId, in_flight: [] });
    expect(body.activity![0]!.traces.map((t) => [t.client_turn_id, t.input, t.clip_ms, t.model_ran, t.rule, t.voiced_by])).toEqual([
      [typed.client_turn_id, "text", null, false, "no_model", null],
      [voice.client_turn_id, "audio", 1000, false, "no_model", "walker"],
    ]);
    expect(JSON.stringify(body.activity)).not.toContain("help me");
    // The other owner's list carries none of it.
    const theirs = await (await walkers.GET(request("/api/v1/walkers", { cookie: other.cookie }))).json();
    expect(WalkerListResponseSchema.parse(theirs).activity).toBeUndefined();
    expect(JSON.stringify(theirs)).not.toContain(w.deviceId);
  });

  it("refuses a pairing code asked for by another site, and accepts a lowercase bearer scheme", async () => {
    const crossSite = await pairingCodes.POST(request("/api/v1/walkers/pairing-codes", { method: "POST", headers: { "sec-fetch-site": "cross-site" } }));
    await expectError(crossSite, "invalid_request");
    expect(crossSite.headers.get("set-cookie")).toBeNull();
    expect((await pairingCodes.POST(request("/api/v1/walkers/pairing-codes", { method: "POST", headers: { "sec-fetch-site": "same-origin" } }))).status).toBe(201);
    const w = await pairOverHttp();
    const lower = new NextRequest(`${BASE}/api/v1/devices/${w.deviceId}/configuration`, { headers: { authorization: `bearer ${w.credential}` } });
    expect((await configuration.GET(lower, ctx({ id: w.deviceId }))).status).toBe(200);
  });

  it("logs route, id, status and time only", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "info").mockImplementation((line: string) => void lines.push(line));
    const w = await pairOverHttp();
    await heartbeat.POST(request(`/api/v1/devices/${w.deviceId}/heartbeat`, { bearer: w.credential, body: beat() }), ctx({ id: w.deviceId }));
    const missing = await walker.GET(request("/api/v1/walkers/x\ninjected", { cookie: w.cookie }), ctx({ id: "x\ninjected" }));
    const { error } = WalkerErrorSchema.parse(await missing.json());
    expect(lines.some((l) => /^\[walker\] route=devices\.heartbeat device=[0-9a-f-]{36} status=200 ms=\d+$/.test(l))).toBe(true);
    expect(lines.some((l) => l.includes(`device=malformed status=404`) && l.endsWith(`trace=${error.trace_id}`))).toBe(true);
    for (const line of lines) {
      expect(line).not.toContain(w.credential);
      expect(line).not.toContain(w.cookie);
      expect(line).not.toContain("\n");
    }
  });
});

describe("the pairing lockout's client address", () => {
  it("on Render, is Cloudflare's CF-Connecting-IP, whatever X-Forwarded-For claims", () => {
    const env = { RENDER: "true" };
    // The shape a forged header takes behind Render: the client's own entry is kept, real hops follow.
    const forged = new Headers({ "x-forwarded-for": "192.0.2.44, 81.107.0.110, 172.71.0.9, 10.0.0.5", "cf-connecting-ip": "81.107.0.110" });
    expect(clientAddress(forged, env)).toBe("81.107.0.110");
    expect(clientAddress(new Headers({ "x-forwarded-for": "81.107.0.110" }), env)).toBe("unknown");
  });

  it("on Render, keys an IPv6 client by its /64, so it can't take a fresh address per try", () => {
    const env = { RENDER: "true" };
    const at = (ip: string) => clientAddress(new Headers({ "cf-connecting-ip": ip }), env);
    expect(at("2001:db8:85a3:12::8a2e:370:7334")).toBe("2001:db8:85a3:12::/64");
    expect(at("2001:0DB8:85a3:0012:ffff:1:2:3")).toBe("2001:db8:85a3:12::/64");
    expect(at("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(at("::ffff:198.51.100.7")).toBe("198.51.100.7");
  });

  it("elsewhere, is one shared key, since no header there can be trusted", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "192.0.2.44, ::1", "cf-connecting-ip": "192.0.2.45" }), {})).toBe("local");
    expect(clientAddress(new Headers(), {})).toBe("local");
  });

  it("locks out a Render client that forges a new leftmost entry on every try", async () => {
    vi.stubEnv("RENDER", "true");
    for (let i = 0; i < 5; i++) {
      const wrong = await pair.POST(
        request("/api/v1/devices/pair", { body: { code: "000000", service_version: "pi" }, headers: { "cf-connecting-ip": "81.107.0.111", "x-forwarded-for": `192.0.2.${i}, 81.107.0.111` } }),
      );
      await expectError(wrong, "pairing_code_invalid");
    }
    const sixth = await pair.POST(request("/api/v1/devices/pair", { body: { code: "000000", service_version: "pi" }, headers: { "cf-connecting-ip": "81.107.0.111", "x-forwarded-for": "192.0.2.200" } }));
    await expectError(sixth, "pairing_locked");
  });
});
