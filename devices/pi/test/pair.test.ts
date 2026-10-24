import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pairWalker } from "../src/pair";
import { StateStore } from "../src/store";
import { FakeClock, captureLogger, flush } from "./support/fakes";

/** Rows P10–P13 (test/EXPECTED.md): pairing against a server that may be asleep, from the contract notes. */

const PAIRED = {
  device_id: "66666666-6666-4666-8666-666666666666",
  credential: "k".repeat(43),
  configuration: {
    version: 1,
    catalog_version: 1,
    selected_module_ids: ["base.walker", "controls.hand", "perception.tof", "voice"],
    cues: ["vibration", "spoken"],
    created_at: "2026-10-24T12:00:00.000Z",
  },
};

type Handler = (request: IncomingMessage, response: ServerResponse) => void;
let server: Server | null = null;
afterEach(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve) ?? resolve(null));
  server = null;
});

async function serve(routes: { health: Handler; pair: Handler }) {
  const hits = { health: 0, pair: 0 };
  server = createServer((request, response) => {
    if (request.url === "/api/v1/health") {
      hits.health += 1;
      return routes.health(request, response);
    }
    if (request.url === "/api/v1/devices/pair" && request.method === "POST") {
      hits.pair += 1;
      return routes.pair(request, response);
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server!.address() as { port: number }).port}`, hits };
}

const json = (response: ServerResponse, status: number, body: unknown) =>
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

/** Lets real loopback I/O progress, moving the fake clock a step at a time, until the promise settles. */
async function drive<T>(promise: Promise<T>, clock: FakeClock, stepMs: number): Promise<{ value?: T; error?: Error }> {
  let outcome: { value?: T; error?: Error } | null = null;
  promise.then(
    (value) => (outcome = { value }),
    (error: Error) => (outcome = { error }),
  );
  for (let i = 0; i < 400 && !outcome; i += 1) {
    await flush();
    if (outcome) break;
    await clock.advance(stepMs);
  }
  if (!outcome) throw new Error("never settled");
  return outcome;
}

function setup() {
  const clock = new FakeClock();
  const store = new StateStore(mkdtempSync(join(tmpdir(), "walker-pair-")), captureLogger());
  const said: string[] = [];
  return { clock, store, said, say: (line: string) => said.push(line) };
}

describe("walker pair against a server that may be asleep", () => {
  it("P10: says it's waking the server, retries 503s, and claims the code only after a 200", async () => {
    let healthCalls = 0;
    const { url, hits } = await serve({
      health: (_req, res) => (++healthCalls < 3 ? json(res, 503, { status: "unavailable" }) : json(res, 200, { status: "ok", walker_store: "memory" })),
      pair: (_req, res) => json(res, 201, PAIRED),
    });
    const t = setup();
    const result = await drive(pairWalker({ server: url, code: "123456", store: t.store, clock: t.clock, say: t.say }), t.clock, 250);
    expect(result.error).toBeUndefined();
    expect(t.said).toEqual(["Waking the server…"]);
    expect(hits).toEqual({ health: 3, pair: 1 });
    expect(t.store.readCredential()?.device_id).toBe(PAIRED.device_id);
  });

  it("P10: a server that never wakes gets the 90 s message, and the code is never sent", async () => {
    const { url, hits } = await serve({ health: (_req, res) => json(res, 503, { status: "unavailable" }), pair: (_req, res) => json(res, 201, PAIRED) });
    const t = setup();
    const result = await drive(pairWalker({ server: url, code: "123456", store: t.store, clock: t.clock, say: t.say }), t.clock, 1000);
    expect(result.error?.message).toMatch(/didn't wake up within 90 seconds.*wasn't used/);
    expect(hits.pair).toBe(0);
    expect(hits.health).toBeGreaterThan(10);
    expect(t.store.readCredential()).toBeNull();
  });

  it("P10: refused connections are retried until the deadline too", async () => {
    const probe = await serve({ health: () => {}, pair: () => {} });
    const deadUrl = probe.url;
    await new Promise((resolve) => server!.close(resolve));
    server = null;
    const t = setup();
    const result = await drive(pairWalker({ server: deadUrl, code: "123456", store: t.store, clock: t.clock, say: t.say }), t.clock, 1000);
    expect(result.error?.message).toMatch(/didn't wake up within 90 seconds/);
  });

  it("P11: the pairing request is sent once; a timeout says the code may have been used", async () => {
    const { url, hits } = await serve({ health: (_req, res) => json(res, 200, { status: "ok", walker_store: "memory" }), pair: () => {} });
    const t = setup();
    const result = await drive(pairWalker({ server: url, code: "123456", store: t.store, clock: t.clock, say: t.say }), t.clock, 1000);
    expect(result.error?.message).toMatch(/within 20 seconds\. The code may have been used/);
    expect(hits.pair).toBe(1);
    expect(t.store.readCredential()).toBeNull();
  });

  it("P11: a refused code is not retried, and the message says what to do", async () => {
    const { url, hits } = await serve({
      health: (_req, res) => json(res, 200, { status: "ok", walker_store: "memory" }),
      pair: (_req, res) => json(res, 400, { error: { code: "pairing_code_invalid", message: "That pairing code isn't right.", trace_id: "t" } }),
    });
    const t = setup();
    const result = await drive(pairWalker({ server: url, code: "123456", store: t.store, clock: t.clock, say: t.say }), t.clock, 250);
    expect(result.error?.message).toBe("That code isn't valid or has expired. Get a new code on the walker page.");
    expect(hits.pair).toBe(1);
  });

  it("P12: a server with walkers off stops before the code is claimed", async () => {
    const { url, hits } = await serve({ health: (_req, res) => json(res, 200, { status: "ok", walker_store: "off" }), pair: (_req, res) => json(res, 201, PAIRED) });
    const t = setup();
    const result = await drive(pairWalker({ server: url, code: "123456", store: t.store, clock: t.clock, say: t.say }), t.clock, 250);
    expect(result.error?.message).toMatch(/walkers turned off/);
    expect(hits.pair).toBe(0);
  });

  it("P13: the pairing's configuration 1 replaces an earlier pairing's higher version", async () => {
    const { url } = await serve({ health: (_req, res) => json(res, 200, { status: "ok", walker_store: "memory" }), pair: (_req, res) => json(res, 201, PAIRED) });
    const t = setup();
    t.store.writeConfiguration({ ...PAIRED.configuration, version: 3, cues: ["sound"] } as never);
    const result = await drive(pairWalker({ server: url, code: "123456", store: t.store, clock: t.clock, say: t.say }), t.clock, 250);
    expect(result.error).toBeUndefined();
    expect(t.store.readConfiguration()).toMatchObject({ version: 1, cues: ["vibration", "spoken"] });
  });
});

describe("pairing after the review", () => {
  it("P14: a URL the client refuses fails at once, before waking anything", async () => {
    const t = setup();
    await expect(pairWalker({ server: "http://walker.example.test", code: "123456", store: t.store, clock: t.clock, say: t.say })).rejects.toThrow(
      /must use https/,
    );
    expect(t.said).toEqual([]);
    expect(t.clock.monotonic()).toBe(0);
  });

  it("P10: a health request held open past 90 s ends the wait, and the code is never sent", async () => {
    const { url, hits } = await serve({ health: () => {}, pair: (_req, res) => json(res, 201, PAIRED) });
    const t = setup();
    const result = await drive(pairWalker({ server: url, code: "123456", store: t.store, clock: t.clock, say: t.say }), t.clock, 1000);
    expect(result.error?.message).toMatch(/didn't wake up within 90 seconds/);
    expect(hits).toEqual({ health: 1, pair: 0 });
  });

  it("P10: a 200 that isn't the health route's own answer (HTML, or other JSON) doesn't count as awake", async () => {
    const bodies: Handler[] = [
      (_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<html>waking up</html>"),
      (_req, res) => json(res, 200, { waking: true }),
    ];
    for (const health of bodies) {
      const { url, hits } = await serve({ health, pair: (_req, res) => json(res, 201, PAIRED) });
      const t = setup();
      const result = await drive(pairWalker({ server: url, code: "123456", store: t.store, clock: t.clock, say: t.say }), t.clock, 1000);
      expect(result.error?.message).toMatch(/didn't wake up/);
      expect(hits.pair).toBe(0);
      server?.closeAllConnections();
      await new Promise((resolve) => server!.close(resolve));
      server = null;
    }
  });

  it("P11: a server error or an unreadable answer after the code was sent says to get a new code", async () => {
    for (const reply of [
      (res: ServerResponse) => json(res, 503, { error: { code: "unavailable", message: "down", trace_id: "t" } }),
      (res: ServerResponse) => json(res, 201, { device_id: "nope" }),
    ]) {
      const { url } = await serve({ health: (_req, res) => json(res, 200, { status: "ok", walker_store: "memory" }), pair: (_req, res) => reply(res) });
      const t = setup();
      const result = await drive(pairWalker({ server: url, code: "123456", store: t.store, clock: t.clock, say: t.say }), t.clock, 250);
      expect(result.error?.message).toMatch(/The code may have been used: get a new code/);
      expect(t.store.readCredential()).toBeNull();
      server?.closeAllConnections();
      await new Promise((resolve) => server!.close(resolve));
      server = null;
    }
  });
});
