import { createServer } from "node:http";
import type { HeartbeatRequest } from "@walker/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { wavFromPcm } from "../src/audio/wav";
import { CancelledError, withDeadline } from "../src/clock";
import { CloudError, HttpCloudClient, pairWithServer, toCloudError } from "../src/cloud/client";
import { FakeCloud, startFakeCloudServer, type FakeCloudServer } from "../src/sim/fakeCloud";
import { FakeClock, captureLogger, flush } from "./support/fakes";

const heartbeatBody: HeartbeatRequest = {
  sent_at: "2026-10-24T12:00:00.000Z",
  service_version: "test",
  manifest: { device_configuration_version: 1, generated_at: "2026-10-24T12:00:00.000Z", simulator: true, modules: [] },
  snapshot: null,
  events: [{ event_id: "11111111-1111-4111-8111-111111111111", kind: "notice", text: "Sophi is on.", ago_ms: 1500 }],
};
const signal = () => new AbortController().signal;
const clip = (ms: number) => wavFromPcm(Buffer.alloc(ms * 32), 16000).toString("base64");

let server: FakeCloudServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function paired() {
  const clock = new FakeClock();
  const cloud = new FakeCloud(clock);
  server = await startFakeCloudServer(cloud, captureLogger());
  const result = await pairWithServer(server.url, { code: cloud.issueCode(), name: "Bench walker", service_version: "test" }, signal());
  return { clock, cloud, server, result, client: new HttpCloudClient(server.url, result.device_id, result.credential) };
}

describe("HTTP cloud client (against the fake cloud on 127.0.0.1, walker contract routes)", () => {
  it("P3: pairs and gets configuration 1, then heartbeats with the bearer credential", async () => {
    const { client, result, cloud } = await paired();
    expect(result.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.configuration).toMatchObject({ version: 1, cues: ["vibration", "spoken"] });
    expect(await client.heartbeat(heartbeatBody, signal())).toEqual({ configuration_version: 1, open_proposal: null });
    expect(await client.configuration(signal())).toMatchObject({ version: 1 });
    expect(cloud.devices.get(result.device_id)?.events).toEqual([
      { event_id: heartbeatBody.events[0]!.event_id, kind: "notice", text: "Sophi is on.", at: "2026-10-24T11:59:58.500Z" },
    ]);
  });

  it("a wrong pairing code is refused with the contract's error code", async () => {
    const cloud = new FakeCloud(new FakeClock());
    server = await startFakeCloudServer(cloud, captureLogger());
    await expect(pairWithServer(server.url, { code: "000000", service_version: "test" }, signal())).rejects.toMatchObject({
      kind: "rejected",
      status: 400,
      code: "pairing_code_invalid",
    });
  });

  it("uploads a voice clip and gets the reply; a repeated client_turn_id gets the same turn", async () => {
    const { client, cloud, result } = await paired();
    const body = {
      client_turn_id: "22222222-2222-4222-8222-222222222222",
      input: { type: "audio" as const, mime: "audio/wav" as const, data_base64: clip(1000), duration_ms: 1000 },
      snapshot: null,
    };
    const first = await client.turn(body, signal());
    const again = await client.turn(body, signal());
    expect(first.turn.answered_by).toBe("fixed");
    expect(again.turn).toEqual(first.turn);
    expect(cloud.devices.get(result.device_id)?.clips).toEqual([{ bytes: 32_044, durationMs: 1000 }]);
  });

  it("B11/B16: answering a closed proposal is a 409 that carries the proposal as it stands", async () => {
    const { client, cloud } = await paired();
    cloud.script = [{ reply: "Fake cloud: switch?", proposeCues: ["sound"] }];
    const reply = await client.turn(
      {
        client_turn_id: "33333333-3333-4333-8333-333333333333",
        input: { type: "audio", mime: "audio/wav", data_base64: clip(500), duration_ms: 500 },
        snapshot: null,
      },
      signal(),
    );
    const id = reply.proposal!.proposal_id;
    const confirmed = await client.answerProposal(id, "confirm", signal());
    expect(confirmed.proposal).toMatchObject({ state: "confirmed", configuration_version: 2 });
    const again = await client.answerProposal(id, "confirm", signal()).catch((error: unknown) => error);
    expect(again).toBeInstanceOf(CloudError);
    expect(again).toMatchObject({ kind: "proposal_closed", status: 409, proposal: { state: "confirmed" } });
  });

  it("A1: a revoked credential gets 401 as `unauthorized`", async () => {
    const { client, cloud, result } = await paired();
    cloud.forget(result.device_id);
    await expect(client.heartbeat(heartbeatBody, signal())).rejects.toMatchObject({ kind: "unauthorized", status: 401 });
  });

  it("a request the contract refuses is never sent as valid: the fake answers 400", async () => {
    const { client } = await paired();
    const bad = { ...heartbeatBody, events: [{ ...heartbeatBody.events[0]!, ago_ms: -1 }] };
    await expect(client.heartbeat(bad, signal())).rejects.toMatchObject({ kind: "rejected", status: 400, code: "invalid_request" });
  });

  it("O1: a refused connection is `unreachable`", async () => {
    const { client, server: s } = await paired();
    s.setNetwork("down");
    await expect(client.heartbeat(heartbeatBody, signal())).rejects.toMatchObject({ kind: "unreachable" });
  });

  it("O3: a server that never answers is aborted at the deadline, by the injected clock", async () => {
    const { client, server: s, clock } = await paired();
    s.setNetwork("hang");
    let settled: unknown = null;
    const pending = withDeadline(clock, 10_000, (sig) => client.heartbeat(heartbeatBody, sig)).catch((error) => (settled = error));
    await flush();
    expect(settled).toBeNull();
    await clock.advance(10_000);
    await pending;
    expect(settled).toMatchObject({ name: "DeadlineError" });
  });

  it("a cancelled request is `cancelled`", async () => {
    const { client, server: s } = await paired();
    s.setNetwork("hang");
    const controller = new AbortController();
    const pending = client.heartbeat(heartbeatBody, controller.signal);
    controller.abort(new CancelledError("test"));
    await expect(pending).rejects.toMatchObject({ kind: "cancelled" });
  });

  it("a response outside the contract is `bad_response`; a 503 is `server_error`", async () => {
    const odd = createServer((request, response) => {
      const heartbeat = request.url?.includes("heartbeat");
      response.writeHead(heartbeat ? 200 : 503, { "content-type": "application/json" });
      response.end(
        JSON.stringify(heartbeat ? { configuration_version: "two" } : { error: { code: "unavailable", message: "down", trace_id: "t" } }),
      );
    });
    await new Promise<void>((resolve) => odd.listen(0, "127.0.0.1", resolve));
    const port = (odd.address() as { port: number }).port;
    const client = new HttpCloudClient(`http://127.0.0.1:${port}`, "44444444-4444-4444-8444-444444444444", "c".repeat(43));
    await expect(client.heartbeat(heartbeatBody, signal())).rejects.toMatchObject({ kind: "bad_response" });
    await expect(client.configuration(signal())).rejects.toMatchObject({ kind: "server_error", status: 503, code: "unavailable" });
    await new Promise((resolve) => odd.close(resolve));
  });

  it("refuses plain http to another machine before sending anything", () => {
    expect(() => new HttpCloudClient("http://walker.example.test", "44444444-4444-4444-8444-444444444444", "c".repeat(43))).toThrow(/https/);
  });

  it("maps a network failure to `unreachable`", () => {
    const error = toCloudError(new TypeError("fetch failed"), signal());
    expect(error).toBeInstanceOf(CloudError);
    expect(error.kind).toBe("unreachable");
  });
});
