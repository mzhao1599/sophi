import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startScreenServer, type ScreenServer } from "../src/screen/server";
import {
  TILE_USER_AGENT,
  TileCache,
  WARM_MAX_TILES,
  WARM_PACE_MS,
  parseTilePath,
  readTileSettings,
  tilesAround,
  warmTiles,
  type Tile,
} from "../src/screen/tiles";
import { parseTilesArgs, tilesCommand } from "../src/screen/tilesCli";
import { captureLogger } from "./support/fakes";

/**
 * Map tiles for walking directions (src/screen/tiles.ts), rows written before the code. No test touches the
 * network: every fetch is a fake.
 * T1 Only /tiles/{z}/{x}/{y}.png with whole numbers on the map (z 0 to 19, x and y under 2^z) is a tile.
 * T2 A miss fetches that one tile from tile.openstreetmap.org with the project's user agent and nothing else
 *    (no header from the page, no redirects), keeps it on disk, and serves it; the next ask is the disk's.
 * T3 Offline: a cached tile is served, a missing one is "missing" (the page's 404), and the tile server isn't
 *    asked again for 30 s. A cache-only screen never fetches.
 * T4 A refusal, something that isn't a PNG, or one too large is never kept or served.
 * T5 At most two fetches at once, and one per tile however many ask; over the size cap the oldest tiles go.
 * T6 The screen server: GET /tiles/... is image/png under the same img-src 'self' policy, a 404 when missing or
 *    malformed, 403 when another site asked (Sec-Fetch-Site), 421 for another Host; no log line carries the
 *    tile's numbers.
 * T7 Warming: the tiles around a point at each zoom, about one fetch a second, cached ones free, stops when the
 *    tile server can't be reached; `walker tiles` checks its flags and refuses more than WARM_MAX_TILES.
 */

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]);
const tile: Tile = { z: 17, x: 21023, y: 50645 };
const dir = () => mkdtempSync(join(tmpdir(), "walker-tiles-"));

interface Call {
  url: string;
  init: RequestInit | undefined;
}

function fakeFetch(answer: (url: string) => Response | Promise<Response> = () => png()) {
  const calls: Call[] = [];
  const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return answer(String(url));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

const png = (body: Buffer = PNG, type = "image/png", status = 200) =>
  new Response(new Uint8Array(body), { status, headers: { "Content-Type": type, "Content-Length": String(body.length) } });

describe("T1: what a tile path is", () => {
  it("whole numbers on the map only", () => {
    expect(parseTilePath("/tiles/17/21023/50645.png")).toEqual(tile);
    expect(parseTilePath("/tiles/0/0/0.png")).toEqual({ z: 0, x: 0, y: 0 });
    expect(parseTilePath("/tiles/19/524287/524287.png")).toEqual({ z: 19, x: 524287, y: 524287 });
    for (const bad of [
      "/tiles/20/0/0.png",
      "/tiles/17/131072/0.png",
      "/tiles/0/1/0.png",
      "/tiles/17/-1/50645.png",
      "/tiles/17/1.5/50645.png",
      "/tiles/17/21023/50645.jpg",
      "/tiles/17/21023/50645.png/x",
      "/tiles/17/../50645.png",
      "/tiles/17/21023/50645",
      "/tiles/a/b/c.png",
      "/tiles//21023/50645.png",
    ]) {
      expect(parseTilePath(bad), bad).toBeNull();
    }
  });
});

describe("T2: a miss is fetched once, kept, and served from disk after", () => {
  it("asks OpenStreetMap for that tile with the user agent only", async () => {
    const d = dir();
    const { fetch, calls } = fakeFetch();
    const cache = new TileCache({ dir: d, fetch, log: captureLogger() });
    expect(await cache.get(tile)).toEqual({ status: "ok", body: PNG });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://tile.openstreetmap.org/17/21023/50645.png");
    expect(calls[0]!.init?.headers).toEqual({ "User-Agent": TILE_USER_AGENT });
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(TILE_USER_AGENT).toBe("SophiWalker-CalHacks26/0.1 (https://github.com/mzhao1599/sophi)");
    expect(readFileSync(join(d, "17", "21023", "50645.png"))).toEqual(PNG);
    // No temporary file left behind.
    expect(readdirSync(join(d, "17", "21023"))).toEqual(["50645.png"]);
    expect(await cache.get(tile)).toEqual({ status: "ok", body: PNG });
    expect(calls).toHaveLength(1);
  });
});

describe("T3: offline", () => {
  it("serves what is cached, says missing otherwise, and doesn't ask again for 30 s", async () => {
    const d = dir();
    mkdirSync(join(d, "17", "21023"), { recursive: true });
    writeFileSync(join(d, "17", "21023", "50645.png"), PNG);
    let now = 0;
    const { fetch, calls } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const log = captureLogger();
    const cache = new TileCache({ dir: d, fetch, log, monotonic: () => now });
    expect((await cache.get(tile)).status).toBe("ok");
    expect(await cache.get({ ...tile, y: 50646 })).toEqual({ status: "missing" });
    expect(await cache.get({ ...tile, y: 50647 })).toEqual({ status: "missing" });
    expect(calls).toHaveLength(1);
    now = 30_000;
    await cache.get({ ...tile, y: 50647 });
    expect(calls).toHaveLength(2);
    expect(log.lines.filter((l) => l.includes("can't be reached"))).toHaveLength(1);
  });

  it("a cache-only screen never fetches", async () => {
    const cache = new TileCache({ dir: dir(), fetch: null, log: captureLogger() });
    expect(await cache.get(tile)).toEqual({ status: "missing" });
    expect(await cache.warm(tile)).toBe("failed");
  });

  it("reads its folder and mode from the environment", () => {
    expect(readTileSettings({ WALKER_TILE_DIR: "/x/tiles", WALKER_TILES: "cache" }, false)).toEqual({ dir: "/x/tiles", mode: "cache" });
    expect(readTileSettings({ WALKER_STATE_DIR: "/state" }, false)).toEqual({ dir: "/state/tiles", mode: "fetch" });
    expect(readTileSettings({}, false)).toEqual({ dir: "/var/lib/steady-walker/tiles", mode: "fetch" });
    expect(readTileSettings({ WALKER_TILES: "off" }, true).mode).toBe("off");
    expect(readTileSettings({}, true).dir).toMatch(/\.cache\/sophi-walker\/tiles$/);
  });
});

describe("T4: only real tiles are kept", () => {
  it("a refusal, another type, a body that isn't a PNG, or one too large", async () => {
    for (const [why, answer] of [
      ["404", () => png(PNG, "image/png", 404)],
      ["html", () => png(Buffer.from("<html>"), "text/html")],
      ["not a png", () => png(Buffer.from("GIF89a not a png at all"))],
      ["too large", () => png(Buffer.concat([PNG, Buffer.alloc(600 * 1024)]))],
    ] as const) {
      const d = dir();
      const cache = new TileCache({ dir: d, fetch: fakeFetch(answer).fetch, log: captureLogger() });
      expect(await cache.get(tile), why).toEqual({ status: "missing" });
      expect(existsSync(join(d, "17")), why).toBe(false);
    }
  });
});

describe("T5: polite fetching and a size cap", () => {
  it("two at once at most, and one fetch per tile however many ask", async () => {
    let open = 0;
    let most = 0;
    const { fetch, calls } = fakeFetch(async () => {
      open += 1;
      most = Math.max(most, open);
      await new Promise((r) => setTimeout(r, 5));
      open -= 1;
      return png();
    });
    const cache = new TileCache({ dir: dir(), fetch, log: captureLogger() });
    const asks = [0, 1, 2, 3, 4].map((i) => cache.get({ ...tile, x: tile.x + i }));
    asks.push(cache.get(tile), cache.get(tile));
    const results = await Promise.all(asks);
    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(calls).toHaveLength(5);
    expect(most).toBe(2);
  });

  it("over the cap, the oldest tiles go first", async () => {
    const d = dir();
    const cache = new TileCache({ dir: d, fetch: fakeFetch().fetch, log: captureLogger(), maxBytes: PNG.length * 3 });
    for (let i = 0; i < 5; i += 1) {
      await cache.get({ ...tile, x: i });
      await new Promise((r) => setTimeout(r, 2));
    }
    const left = readdirSync(join(d, "17")).sort();
    expect(left.length).toBeLessThanOrEqual(3);
    expect(left).toContain("4");
    expect(left).not.toContain("0");
    expect(cache.bytes()).toBeLessThanOrEqual(PNG.length * 3);
  });
});

describe("T6: the screen server's tile route", () => {
  let server: ScreenServer | null = null;
  afterEach(async () => {
    await server?.close();
    server = null;
  });

  function call(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  async function start(tiles: { get: TileCache["get"] } | null) {
    const assets = join(dir(), "screen-page");
    mkdirSync(assets);
    writeFileSync(join(assets, "page.js"), "/* page */");
    writeFileSync(join(assets, "page.css"), "/* css */");
    const log = captureLogger();
    server = await startScreenServer({ port: 0, assetsDir: assets, log, current: () => null, token: "t".repeat(43), monotonic: () => 0, tiles });
    return { port: server!.port, log };
  }

  it("serves a tile as image/png under img-src 'self', and a 404 when it is missing or malformed", async () => {
    const asked: Tile[] = [];
    const { port, log } = await start({
      get: async (t) => {
        asked.push(t);
        return t.y === 50645 ? { status: "ok", body: PNG } : { status: "missing" };
      },
    });
    const ok = await call(port, "/tiles/17/21023/50645.png?ignored=1", { "Sec-Fetch-Site": "same-origin", Cookie: "a=b" });
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toBe("image/png");
    expect(ok.headers["cache-control"]).toBe("private, max-age=86400");
    expect(String(ok.headers["content-security-policy"])).toContain("img-src 'self'");
    expect(ok.body).toEqual(PNG);
    expect((await call(port, "/tiles/17/21023/50646.png")).status).toBe(404);
    expect((await call(port, "/tiles/20/0/0.png")).status).toBe(404);
    expect((await call(port, "/tiles/17/21023/../x.png")).status).toBe(404);
    expect(asked).toEqual([tile, { ...tile, y: 50646 }]);
    expect(log.lines.join("\n")).not.toMatch(/21023|50645|50646/);
  });

  it("refuses another site's request and another Host, before asking the cache", async () => {
    const asked: Tile[] = [];
    const { port } = await start({ get: async (t) => (asked.push(t), { status: "ok", body: PNG }) });
    expect((await call(port, "/tiles/17/21023/50645.png", { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await call(port, "/tiles/17/21023/50645.png", { "Sec-Fetch-Site": "same-site" })).status).toBe(403);
    expect((await call(port, "/tiles/17/21023/50645.png", { Host: "localhost" })).status).toBe(421);
    expect((await call(port, "/tiles/17/21023/50645.png", { Origin: "https://example.com" })).status).toBe(421);
    expect(asked).toEqual([]);
  });

  it("with no tiles at all, every tile is a 404", async () => {
    const { port } = await start(null);
    expect((await call(port, "/tiles/17/21023/50645.png")).status).toBe(404);
  });
});

describe("T7: warming the cache for a demo area", () => {
  it("covers the area at each zoom, paced about a second apart, with cached tiles free", async () => {
    const tiles = tilesAround(37.8098, -122.2575, 500, [16, 17]);
    expect(tiles.some((t) => t.z === 17 && t.x === 21023 && t.y === 50645)).toBe(true);
    expect(tiles.filter((t) => t.z === 16).length).toBeLessThan(tiles.filter((t) => t.z === 17).length);
    expect(tiles.length).toBeLessThan(WARM_MAX_TILES);
    const d = dir();
    mkdirSync(join(d, "17", "21023"), { recursive: true });
    writeFileSync(join(d, "17", "21023", "50645.png"), PNG);
    const { fetch, calls } = fakeFetch();
    const sleeps: number[] = [];
    const report = await warmTiles(new TileCache({ dir: d, fetch, log: captureLogger() }), tiles.slice(0, 40).concat([tile]), {
      sleep: async (ms) => void sleeps.push(ms),
    });
    const wanted = new Set(tiles.slice(0, 40).concat([tile]).map((t) => `${t.z}/${t.x}/${t.y}`));
    expect(report.cached).toBe(1);
    expect(report.fetched).toBe(wanted.size - 1);
    expect(calls).toHaveLength(wanted.size - 1);
    expect(sleeps).toEqual(Array(wanted.size - 2).fill(WARM_PACE_MS));
  });

  it("stops when the tile server can't be reached", async () => {
    const { fetch, calls } = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    const report = await warmTiles(new TileCache({ dir: dir(), fetch, log: captureLogger() }), tilesAround(37.8098, -122.2575, 200, [17]), { sleep: async () => {} });
    expect(report).toMatchObject({ fetched: 0, failed: 1, unreachable: true });
    expect(calls).toHaveLength(1);
  });

  it("walker tiles checks its flags and refuses a bulk download", async () => {
    const flags = (o: Record<string, string | true>) => new Map(Object.entries(o));
    expect(parseTilesArgs(flags({ around: "37.8098,-122.2575" }), { WALKER_TILE_DIR: "/t" })).toEqual({ lat: 37.8098, lon: -122.2575, radiusM: 500, zooms: [16, 17], dir: "/t" });
    expect(parseTilesArgs(flags({ around: "37.8,-122.2", zoom: "18", dir: "/d" }), {})).toMatchObject({ zooms: [18], dir: "/d" });
    expect(parseTilesArgs(flags({ around: "37.8,-122.2", zoom: "16-18" }), {})).toMatchObject({ zooms: [16, 17, 18] });
    const bads: Record<string, string>[] = [{}, { around: "here" }, { around: "95,0" }, { around: "37.8,-122.2", zoom: "15-17" }, { around: "37.8,-122.2", zoom: "19" }, { around: "37.8,-122.2", radius: "5000" }];
    for (const bad of bads) {
      expect("error" in parseTilesArgs(flags(bad), {}), JSON.stringify(bad)).toBe(true);
    }
    const out: string[] = [];
    const { fetch, calls } = fakeFetch();
    const deps = { env: { WALKER_TILE_DIR: dir() }, fetch, sleep: async () => {}, out: (l: string) => void out.push(l), log: captureLogger() };
    expect(await tilesCommand(flags({ around: "37.8098,-122.2575", radius: "1500", zoom: "16-18" }), deps)).toBe(2);
    expect(out.join("\n")).toMatch(/more than 300/);
    expect(calls).toHaveLength(0);
    expect(await tilesCommand(flags({ around: "37.8098,-122.2575", radius: "100", zoom: "17" }), deps)).toBe(0);
    expect(out.at(-1)).toMatch(/^Map tiles: \d+ fetched, 0 already cached, 0 failed, of \d+\.$/);
    expect(calls.length).toBeGreaterThan(0);
  });
});
