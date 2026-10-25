import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import type { NavigatingScreen, ScreenPress, ScreenState } from "@walker/contracts";
import { screenFixtures } from "@walker/walker-screen";
import { afterEach, describe, expect, it } from "vitest";
import { startScreenServer, type ScreenServer } from "../src/screen/server";
import { TileCache } from "../src/screen/tiles";
import { captureLogger } from "./support/fakes";

/**
 * D30 (walking directions, added 2026-10-24): the real page (the built dist/screen-page) in headless Chromium
 * against the real screen server and tile cache, with the tile server faked. Written before the run:
 * - the map's tiles load from /tiles on the page's own server, under img-src 'self', with no policy violation;
 * - the cache asked the (fake) tile server only for those tiles' numbers;
 * - End route and Repeat reach the server as `end_route` and `repeat_direction` presses, with the drawn revision;
 * - a new position (a new revision, the same instruction) redraws the map in place: the one thing isn't remounted
 *   (no cross-fade) and what a screen reader hears doesn't change.
 * Off unless PLAYWRIGHT_CORE and CHROMIUM_PATH are set and the page is built (`pnpm --filter @walker/pi bundle`).
 * Optional: SCREEN_SHOTS_DIR saves the screen; SCREEN_TILE_SOURCE is a folder of real {z}/{x}/{y}.png tiles the
 * fake tile server answers from (otherwise a plain generated tile).
 */
const playwrightPath = process.env.PLAYWRIGHT_CORE;
const chromiumPath = process.env.CHROMIUM_PATH;
const shotsDir = process.env.SCREEN_SHOTS_DIR;
const tileSource = process.env.SCREEN_TILE_SOURCE;
const pageDir = fileURLToPath(new URL("../dist/screen-page/", import.meta.url));

interface BrowserPage {
  addInitScript(script: string): Promise<void>;
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string): Promise<unknown>;
  waitForFunction(fn: () => boolean): Promise<unknown>;
  evaluate<T>(fn: string | (() => T)): Promise<T>;
  click(selector: string): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  screenshot(o: { path: string }): Promise<unknown>;
  emulateMedia(o: { reducedMotion: "reduce" }): Promise<void>;
}
interface PlaywrightCore {
  chromium: {
    launch(o: { executablePath: string }): Promise<{
      newPage(o: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<BrowserPage>;
      close(): Promise<void>;
    }>;
  };
}

/** A 256x256 PNG of one colour (the fake tile server's answer when no real tiles are given). */
function plainPng(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(256, 0);
  ihdr.writeUInt32BE(256, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(256 * 3, 0xd8)]);
  const raw = Buffer.concat(Array.from({ length: 256 }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

let server: ScreenServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe.skipIf(!playwrightPath || !chromiumPath || !existsSync(join(pageDir, "page.js")))("D30: walking directions on the real page", () => {
  it("loads its tiles from its own server, sends End route and Repeat, and redraws the map in place", async () => {
    const fixture = screenFixtures().find((f) => f.name === "navigating--large")!;
    let current: ScreenState = { ...fixture.state, revision: 7 };
    const presses: ScreenPress[] = [];
    const asked: string[] = [];
    const plain = plainPng();
    const fetch = (async (url: string | URL | Request) => {
      asked.push(String(url));
      const m = /\/(\d+)\/(\d+)\/(\d+)\.png$/.exec(String(url))!;
      const file = tileSource ? join(tileSource, m[1]!, m[2]!, `${m[3]}.png`) : null;
      const body = file && existsSync(file) ? readFileSync(file) : plain;
      return new Response(new Uint8Array(body), { status: 200, headers: { "Content-Type": "image/png", "Content-Length": String(body.length) } });
    }) as typeof globalThis.fetch;
    const tiles = new TileCache({ dir: mkdtempSync(join(tmpdir(), "walker-nav-tiles-")), fetch, log: captureLogger() });
    server = await startScreenServer({
      port: 0,
      assetsDir: pageDir,
      log: captureLogger(),
      current: () => current,
      monotonic: () => performance.now(),
      onPress: (p) => presses.push(p),
      tiles,
    });
    if (!server) throw new Error("server didn't start");
    const { chromium } = createRequire(import.meta.url)(playwrightPath!) as PlaywrightCore;
    const browser = await chromium.launch({ executablePath: chromiumPath! });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 480 }, deviceScaleFactor: 1 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      // Every policy report but script-src: the page's validation library (zod) probes whether eval works, and the
      // policy refuses it, as intended, on every screen.
      await page.addInitScript(
        "window.__violations = []; document.addEventListener('securitypolicyviolation', (e) => { if (!e.violatedDirective.startsWith('script-src')) window.__violations.push(e.violatedDirective + ' ' + e.blockedURI); });",
      );
      await page.goto(server.url);
      await page.waitForSelector(".ws-map");
      // (Functions, not strings: the page's policy has no 'unsafe-eval'.)
      await page.waitForFunction(() => [...document.images].length > 0 && [...document.images].every((i) => i.complete));
      const images = await page.evaluate(() => [...document.images].map((i) => ({ src: i.getAttribute("src"), width: i.naturalWidth })));
      expect(images.length).toBeGreaterThan(0);
      for (const img of images) {
        expect(img.src).toMatch(/^\/tiles\/17\/\d+\/\d+\.png$/);
        expect(img.width).toBe(256);
      }
      const violations = () => page.evaluate(() => (window as unknown as { __violations: string[] }).__violations);
      expect(await violations()).toEqual([]);
      expect(asked.sort()).toEqual(images.map((i) => `https://tile.openstreetmap.org${i.src!.slice("/tiles".length)}`).sort());
      if (shotsDir) await page.screenshot({ path: join(shotsDir, "navigating--large--real-page.png") });

      // Presses.
      await page.evaluate(() => ((document.querySelector(".ws-one") as HTMLElement & { __mark?: boolean }).__mark = true));
      const announce = await page.evaluate(() => document.querySelector("[aria-live]")!.textContent);
      await page.click("text=End route");
      await page.click("text=Repeat");
      await page.waitForTimeout(200);
      expect(presses).toEqual([
        { revision: 7, action: "end_route" },
        { revision: 7, action: "repeat_direction" },
      ]);

      // A new position, the same instruction: the map moves, the one thing stays.
      const screen = current.screen as NavigatingScreen;
      current = { ...current, revision: 8, screen: { ...screen, to_step_m: 20, map: { ...screen.map, position: [37.80989, -122.25792] } } };
      server.publish(current);
      await page.waitForFunction(() => document.documentElement.dataset.drawnRevision === "8");
      expect(await page.evaluate(() => document.querySelector(".ws-turn-words .ws-line")!.textContent)).toBe("in 20 m");
      expect(await page.evaluate(() => (document.querySelector(".ws-one") as HTMLElement & { __mark?: boolean }).__mark === true)).toBe(true);
      expect(await page.evaluate(() => document.querySelector("[aria-live]")!.textContent)).toBe(announce);
      expect(await violations()).toEqual([]);
    } finally {
      await browser.close();
    }
  }, 60_000);
});
