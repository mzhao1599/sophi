import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { connect, createServer } from "node:net";
import { networkInterfaces, tmpdir } from "node:os";
import { join } from "node:path";
import { confirmPrompt, type ScreenState } from "@walker/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startingSettings } from "../src/screen/attach";
import { isLoopback, refusal, startScreenServer, type ScreenHoldEvent, type ScreenServer } from "../src/screen/server";
import { captureLogger } from "./support/fakes";

/** Rows D10 to D13, D18 and D22 of test/EXPECTED.md: the screen server's checks, on a real socket on 127.0.0.1. */

const TOKEN = "t".repeat(43);
const state: ScreenState = {
  v: 1,
  revision: 0,
  screen: { state: "answering", heard: "a private question", reply: "A private reply.", source: "model", page: 0 },
  settings: startingSettings(undefined, Date.parse("2026-10-24T02:00:00Z")),
  strip: { link: "online", simulator: true, bench_mode: false, clock: null },
};

function assets(): string {
  const dir = join(mkdtempSync(join(tmpdir(), "walker-screen-assets-")), "screen-page");
  mkdirSync(dir);
  writeFileSync(join(dir, "page.js"), "/* page */");
  writeFileSync(join(dir, "page.css"), "/* css */");
  writeFileSync(join(dir, "OFL.txt"), "licence");
  return dir;
}

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function call(port: number, path: string, options: { method?: string; headers?: Record<string, string>; body?: string; host?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: options.host ?? "127.0.0.1", port, path, method: options.method ?? "GET", headers: { Host: `127.0.0.1:${port}`, ...options.headers } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        // The event stream never ends: take what arrives in the first moment.
        if (String(res.headers["content-type"]).startsWith("text/event-stream")) {
          res.on("data", (chunk: string) => (body += chunk));
          setTimeout(() => {
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
            req.destroy();
          }, 150);
          return;
        }
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Screen-Token": TOKEN, ...headers },
  body: JSON.stringify(body),
});

let server: ScreenServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function start(log = captureLogger(), extra: { onShown?: (s: unknown) => void; onPress?: (p: unknown) => void } = {}) {
  server = await startScreenServer({ port: 0, assetsDir: assets(), log, current: () => state, token: TOKEN, monotonic: () => 0, ...extra });
  if (!server) throw new Error("server didn't start");
  return { server, port: server.port, log };
}

describe("D10: the page, its files and the stream", () => {
  it("serves the page with the token embedded and no CORS headers; the stream starts with the current state", async () => {
    const { port } = await start();
    const page = await call(port, "/");
    expect(page.status).toBe(200);
    expect(page.body).toContain(`<meta name="screen-token" content="${TOKEN}">`);
    expect(page.headers["access-control-allow-origin"]).toBeUndefined();
    expect(page.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect((await call(port, "/screen/assets/page.js")).body).toBe("/* page */");
    expect((await call(port, "/screen/assets/OFL.txt")).status).toBe(200);
    expect((await call(port, "/screen/assets/../package.json")).status).toBe(404);
    const stream = await call(port, `/screen/events?token=${TOKEN}`);
    expect(stream.status).toBe(200);
    expect(stream.body).toContain(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  });

  it("accepts a ScreenShown and a ScreenPress with the token, and refuses bodies that aren't one", async () => {
    const shown: unknown[] = [];
    const pressed: unknown[] = [];
    const { port } = await start(captureLogger(), { onShown: (s) => shown.push(s), onPress: (p) => pressed.push(p) });
    const ok = { revision: 0, item_id: null, settings_version: 1, settings_pending_local: false };
    expect((await call(port, "/screen/shown", json(ok))).status).toBe(204);
    expect((await call(port, "/screen/press", json({ revision: 0, action: "my_screen" }))).status).toBe(204);
    expect((await call(port, "/screen/shown", json({ ...ok, extra: 1 }))).status).toBe(400);
    expect((await call(port, "/screen/press", json({ revision: 0, action: "launch" }))).status).toBe(400);
    expect((await call(port, "/screen/press", { ...json({}), body: "x".repeat(5000) })).status).toBe(413);
    expect(shown).toEqual([ok]);
    expect(pressed).toEqual([{ revision: 0, action: "my_screen" }]);
  });
});

describe("D11: the per-boot token, Host and Origin", () => {
  it("refuses a wrong or missing token on the stream and the POSTs", async () => {
    const { port } = await start();
    expect((await call(port, "/screen/events")).status).toBe(403);
    expect((await call(port, `/screen/events?token=${"u".repeat(43)}`)).status).toBe(403);
    expect((await call(port, `/screen/events?token=${TOKEN}x`)).status).toBe(403);
    const ok = { revision: 0, action: "confirm" };
    expect((await call(port, "/screen/press", json(ok, { "X-Screen-Token": "wrong" }))).status).toBe(403);
    const { "X-Screen-Token": _, ...noToken } = json(ok).headers;
    expect((await call(port, "/screen/press", { ...json(ok), headers: noToken })).status).toBe(403);
  });

  it("refuses a Host that isn't 127.0.0.1:<port> (DNS rebinding), on every route, the page too", async () => {
    const { port } = await start();
    for (const host of ["localhost:" + port, "evil.example:" + port, "127.0.0.1", `127.0.0.1:${port + 1}`]) {
      expect((await call(port, "/", { headers: { Host: host } })).status).toBe(421);
      expect((await call(port, `/screen/events?token=${TOKEN}`, { headers: { Host: host } })).status).toBe(421);
      expect((await call(port, "/screen/press", { ...json({ revision: 0, action: "confirm" }), headers: { ...json({}).headers, Host: host } })).status).toBe(421);
    }
  });

  it("refuses an Origin other than the page's own; a same-origin POST goes through", async () => {
    const pressed: unknown[] = [];
    const { port } = await start(captureLogger(), { onPress: (p) => pressed.push(p) });
    const press = (origin: string) => call(port, "/screen/press", json({ revision: 0, action: "confirm" }, { Origin: origin }));
    expect((await press("http://evil.example")).status).toBe(421);
    expect((await press("null")).status).toBe(421);
    expect((await press(`http://localhost:${port}`)).status).toBe(421);
    expect((await call(port, `/screen/events?token=${TOKEN}`, { headers: { Origin: "http://evil.example" } })).status).toBe(421);
    expect((await press(`http://127.0.0.1:${port}`)).status).toBe(204);
    expect(pressed).toHaveLength(1);
  });
});

describe("D18: a page asking after a refused stream, and a frozen screen", () => {
  it("/screen/check answers 204 for this boot's token and 403 for any other", async () => {
    const { port } = await start();
    expect((await call(port, `/screen/check?token=${TOKEN}`)).status).toBe(204);
    expect((await call(port, `/screen/check?token=${"u".repeat(43)}`)).status).toBe(403);
    expect((await call(port, "/screen/check")).status).toBe(403);
  });

  it("drops a stream whose screen stops reading once 256 KB waits for it", async () => {
    const { port, server: s } = await start();
    const socket = connect(port, "127.0.0.1");
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    socket.write(`GET /screen/events?token=${TOKEN} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
    for (let i = 0; i < 50 && s.clients() === 0; i += 1) await new Promise((r) => setTimeout(r, 10));
    expect(s.clients()).toBe(1);
    socket.pause(); // a frozen browser: nothing more is read
    const big = { ...state, screen: { ...state.screen, reply: "x".repeat(600) } } as ScreenState;
    for (let i = 0; i < 20_000 && s.clients() > 0; i += 1) {
      s.publish({ ...big, revision: i });
      if (i % 200 === 0) await new Promise((r) => setTimeout(r, 1));
    }
    await new Promise((r) => setTimeout(r, 50));
    expect(s.clients()).toBe(0);
    socket.destroy();
  });
});

describe("D12: loopback only", () => {
  it("listens on 127.0.0.1 alone, and refuses a request from any other address", async () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    for (const address of ["192.168.1.20", "::1", "::ffff:10.0.0.2", "0.0.0.0", undefined]) expect(isLoopback(address)).toBe(false);
    const fakeReq = (remoteAddress: string) => ({ socket: { remoteAddress }, headers: { host: "127.0.0.1:8740" } });
    expect(refusal(fakeReq("10.0.0.5"), 8740)).toBe("not loopback");
    expect(refusal(fakeReq("127.0.0.1"), 8740)).toBeNull();

    const { port, server: s } = await start();
    expect(s.address).toBe("127.0.0.1");
    // From this machine's own LAN address nothing answers (refused, or dropped by the firewall or sandbox).
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((a) => a && a.family === "IPv4" && !a.internal)?.address;
    if (lan) {
      const outcome = await Promise.race([
        call(port, "/", { host: lan }).then((r) => `answered ${r.status}`, (e: NodeJS.ErrnoException) => `error ${e.code}`),
        new Promise<string>((resolve) => setTimeout(() => resolve("no answer"), 1000)),
      ]);
      expect(outcome).not.toMatch(/^answered/);
    } else console.warn("D12: no non-loopback IPv4 address on this machine; the LAN check was skipped");
  });
});

describe("D13: a screen that can't start never takes the walker down", () => {
  it("a taken port is one log line and null", async () => {
    const blocker = createServer();
    await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
    const port = (blocker.address() as { port: number }).port;
    const log = captureLogger();
    const result = await startScreenServer({ port, assetsDir: assets(), log, current: () => null, monotonic: () => 0 });
    blocker.close();
    expect(result).toBeNull();
    expect(log.lines).toEqual([expect.stringContaining("walker screen not started: its port is taken")]);
  });

  it("missing page files are one log line and null", async () => {
    const log = captureLogger();
    expect(await startScreenServer({ port: 0, assetsDir: join(tmpdir(), "no-such-screen-page"), log, current: () => null, monotonic: () => 0 })).toBeNull();
    expect(log.lines).toHaveLength(1);
    expect(log.lines[0]).toContain("its page files are missing");
  });

  it("logs no state body, words, token or request URL", async () => {
    const { port, log, server: s } = await start();
    await call(port, `/screen/events?token=${TOKEN}`);
    s.publish({ ...state, revision: 1 });
    await call(port, "/screen/press", json({ revision: 0, action: "confirm" }));
    const text = log.lines.join("\n");
    expect(text).not.toContain(TOKEN);
    expect(text).not.toMatch(/private|token=/);
  });
});

describe("D22: the lift's hold control, POST /screen/hold", () => {
  const raise = { target_id: "00000000-0000-4000-8000-000000000062", title: "Raise the lift?", prompt: confirmPrompt("Raise the lift?", true) };
  const withHold: ScreenState = { ...state, screen: { state: "motion_confirm", target: raise, hold: "raise" } };
  const running: ScreenState = { ...state, screen: { state: "motion_running", what: "Raising the lift", lift: { phase: "running", direction: "raise" } } };
  const stopping: ScreenState = { ...state, screen: { state: "motion_running", what: "Raising the lift", lift: { phase: "stopping", direction: "raise" } } };

  /** A server whose clock and current state the test moves, and every hold event it passes on. */
  async function holdServer(initial: ScreenState = withHold) {
    let mono = 1000;
    let current = initial;
    const events: ScreenHoldEvent[] = [];
    server = await startScreenServer({
      port: 0,
      assetsDir: assets(),
      log: captureLogger(),
      current: () => current,
      token: TOKEN,
      monotonic: () => mono,
      onHold: (e) => events.push(e),
    });
    if (!server) throw new Error("server didn't start");
    const s = server;
    return {
      port: s.port,
      events,
      tick: (ms: number) => (mono += ms),
      show: (next: ScreenState) => (current = next),
      hold: (pressed: boolean, at: number, extra: Record<string, string> = {}) => call(s.port, "/screen/hold", json({ pressed, at }, extra)),
      /** Opens a screen stream and keeps it open until `close()`. */
      async stream() {
        const socket = connect(s.port, "127.0.0.1");
        await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
        const before = s.clients();
        socket.write(`GET /screen/events?token=${TOKEN} HTTP/1.1\r\nHost: 127.0.0.1:${s.port}\r\n\r\n`);
        for (let i = 0; i < 100 && s.clients() === before; i += 1) await new Promise((r) => setTimeout(r, 5));
        expect(s.clients()).toBe(before + 1);
        return {
          async close() {
            socket.destroy();
            for (let i = 0; i < 100 && s.clients() > before; i += 1) await new Promise((r) => setTimeout(r, 5));
            await new Promise((r) => setTimeout(r, 10));
          },
        };
      },
    };
  }

  it("refuses a missing or wrong token, a wrong Host or Origin, and a body that isn't a ScreenHold; nothing reaches the bus", async () => {
    const h = await holdServer();
    await h.stream();
    expect((await h.hold(true, 1, { "X-Screen-Token": "wrong" })).status).toBe(403);
    const { "X-Screen-Token": _, ...noToken } = json({}).headers;
    expect((await call(h.port, "/screen/hold", { ...json({ pressed: true, at: 1 }), headers: noToken })).status).toBe(403);
    for (const host of [`localhost:${h.port}`, "evil.example", `127.0.0.1:${h.port + 1}`]) {
      expect((await h.hold(true, 1, { Host: host })).status).toBe(421);
    }
    expect((await h.hold(true, 1, { Origin: "http://evil.example" })).status).toBe(421);
    expect((await h.hold(true, 1, { Origin: "null" })).status).toBe(421);
    expect((await call(h.port, "/screen/hold", json({ pressed: true }))).status).toBe(400);
    expect((await call(h.port, "/screen/hold", json({ pressed: true, at: 1, mono: 5 }))).status).toBe(400);
    expect((await call(h.port, "/screen/hold", { ...json({}), body: "x".repeat(5000) })).status).toBe(413);
    expect(h.events).toEqual([]);
    // The same request from the page's own origin goes through.
    expect((await h.hold(true, 1, { Origin: `http://127.0.0.1:${h.port}` })).status).toBe(204);
    expect(h.events).toEqual([{ pressed: true, atMono: 1000 }]);
  });

  it("stamps every message with the Pi's clock on receipt, whatever the page's clock says, one event per refresh in order", async () => {
    const h = await holdServer();
    await h.stream();
    // The page's clock is far ahead, then far behind: the stamps are the Pi's own.
    expect((await h.hold(true, 9_000_000_000_000)).status).toBe(204);
    h.tick(50);
    expect((await h.hold(true, 9_000_000_000_050)).status).toBe(204);
    h.tick(50);
    expect((await h.hold(true, 9_000_000_000_100)).status).toBe(204);
    h.tick(50);
    expect((await h.hold(false, 9_000_000_000_150)).status).toBe(204);
    expect(h.events).toEqual([
      { pressed: true, atMono: 1000 },
      { pressed: true, atMono: 1050 },
      { pressed: true, atMono: 1100 },
      { pressed: false, atMono: 1150, reason: "page" },
    ]);
  });

  it("drops a still-held that a release overtook, and takes the next press", async () => {
    const h = await holdServer();
    await h.stream();
    await h.hold(false, 500);
    expect((await h.hold(true, 400)).status).toBe(409);
    expect((await h.hold(true, 500)).status).toBe(409);
    expect((await h.hold(true, 501)).status).toBe(204);
    expect(h.events.map((e) => e.pressed)).toEqual([false, true]);
  });

  it("counts a still-held only while the state on screen shows the control; otherwise 409 and a release", async () => {
    const h = await holdServer(state);
    await h.stream();
    expect((await h.hold(true, 1)).status).toBe(409);
    expect(h.events).toEqual([{ pressed: false, atMono: 1000, reason: "not_shown" }]);
    h.show(withHold);
    expect((await h.hold(true, 2)).status).toBe(204);
    h.show(running);
    expect((await h.hold(true, 3)).status).toBe(204);
    // Stopping: the lift never resumes, so the control is gone.
    h.show(stopping);
    expect((await h.hold(true, 4)).status).toBe(409);
    expect(h.events.map((e) => (e.pressed ? "held" : e.reason))).toEqual(["not_shown", "held", "held", "not_shown"]);
  });

  it("with no screen stream open, a still-held is a release", async () => {
    const h = await holdServer();
    expect((await h.hold(true, 1)).status).toBe(409);
    expect(h.events).toEqual([{ pressed: false, atMono: 1000, reason: "no_stream" }]);
  });

  it("a stream closing lets go at once; a reloaded page's clock starts afresh", async () => {
    const h = await holdServer();
    const first = await h.stream();
    await h.hold(true, 5000);
    await h.hold(false, 6000);
    h.tick(10);
    await first.close();
    expect(h.events.at(-1)).toEqual({ pressed: false, atMono: 1010, reason: "stream_closed" });
    // A new page (performance.now() starts again near 0) can hold as soon as its stream is open.
    await h.stream();
    expect((await h.hold(true, 12)).status).toBe(204);
    expect(h.events.at(-1)).toEqual({ pressed: true, atMono: 1010 });
  });

  it("the server closing lets go", async () => {
    const h = await holdServer();
    await h.stream();
    await h.hold(true, 1);
    await server!.close();
    server = null;
    expect(h.events.at(-1)).toMatchObject({ pressed: false, reason: "server_closed" });
  });
});
