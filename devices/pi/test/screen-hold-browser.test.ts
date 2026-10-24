import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { confirmPrompt, type ScreenState } from "@walker/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { startingSettings } from "../src/screen/attach";
import { startScreenServer, type ScreenHoldEvent, type ScreenServer } from "../src/screen/server";
import { captureLogger } from "./support/fakes";

/**
 * Row D24 of test/EXPECTED.md: the real page (the built dist/screen-page) in headless Chromium against the real
 * screen server, holding the lift's control with the mouse. Off unless these are set and the page is built
 * (`pnpm --filter @walker/pi bundle`); no browser is installed by this package:
 *   PLAYWRIGHT_CORE  path to a playwright-core package directory
 *   CHROMIUM_PATH    path to a Chromium (or chrome-headless-shell) binary
 * Optional SCREEN_SHOTS_DIR saves the held control as a PNG.
 */
const playwrightPath = process.env.PLAYWRIGHT_CORE;
const chromiumPath = process.env.CHROMIUM_PATH;
const shotsDir = process.env.SCREEN_SHOTS_DIR;
const pageDir = fileURLToPath(new URL("../dist/screen-page/", import.meta.url));

interface BrowserPage {
  addInitScript(script: string): Promise<void>;
  goto(url: string): Promise<unknown>;
  waitForSelector(selector: string): Promise<unknown>;
  evaluate<T>(fn: string | (() => T)): Promise<T>;
  mouse: { move(x: number, y: number): Promise<void>; down(): Promise<void>; up(): Promise<void> };
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

const raise = { target_id: "00000000-0000-4000-8000-000000000062", title: "Raise the lift?", prompt: confirmPrompt("Raise the lift?", true) };
const state: ScreenState = {
  v: 1,
  revision: 0,
  screen: { state: "motion_confirm", target: raise, hold: "raise" },
  settings: startingSettings(undefined, Date.parse("2026-10-24T02:00:00Z")),
  strip: { link: "online", simulator: false, bench_mode: true, clock: null },
};

let server: ScreenServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe.skipIf(!playwrightPath || !chromiumPath || !existsSync(join(pageDir, "page.js")))("D24: the hold control in a real browser", () => {
  it("refreshes about every 50 ms while the mouse is down, and lets go on mouse up, window blur, hiding and a dropped stream", async () => {
    const started = performance.now();
    const events: Array<ScreenHoldEvent & { t: number }> = [];
    let current = state;
    server = await startScreenServer({
      port: 0,
      assetsDir: pageDir,
      log: captureLogger(),
      current: () => current,
      monotonic: () => performance.now() - started,
      onHold: (e) => events.push({ ...e, t: performance.now() - started }),
    });
    if (!server) throw new Error("server didn't start");
    const { chromium } = createRequire(import.meta.url)(playwrightPath!) as PlaywrightCore;
    const browser = await chromium.launch({ executablePath: chromiumPath! });
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 480 }, deviceScaleFactor: 1 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      // Keep the page's EventSource reachable, so a dropped stream can be played to the page's own handler.
      await page.addInitScript(
        "{ const ES = window.EventSource; window.__sources = []; window.EventSource = class extends ES { constructor(...a) { super(...a); window.__sources.push(this); } }; }",
      );
      await page.goto(server.url);
      await page.waitForSelector(".ws-hold");
      const box = await page.evaluate(() => {
        const r = document.querySelector(".ws-hold")!.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
      const holdFor = async (ms: number) => {
        await page.mouse.move(box.x, box.y);
        await page.mouse.down();
        await page.waitForTimeout(ms);
      };
      const since = (from: number) => events.filter((e) => e.t >= from);

      // 1. Hold for a second, then lift the mouse.
      let from = performance.now() - started;
      await holdFor(1000);
      if (shotsDir) await page.screenshot({ path: join(shotsDir, "motion-confirm-lift-raise--held.png") });
      expect(await page.evaluate(() => document.querySelector(".ws-hold")!.getAttribute("data-held"))).toBe("true");
      await page.mouse.up();
      await page.waitForTimeout(150);
      const first = since(from);
      const refreshes = first.filter((e) => e.pressed);
      expect(refreshes.length).toBeGreaterThanOrEqual(15);
      expect(refreshes.length).toBeLessThanOrEqual(25);
      const gaps = refreshes.slice(1).map((e, i) => e.atMono - refreshes[i]!.atMono);
      // Never near the 200 ms the lift's lease allows.
      expect(Math.max(...gaps)).toBeLessThan(150);
      expect(first.at(-1)).toMatchObject({ pressed: false, reason: "page" });
      expect(first.filter((e) => !e.pressed)).toHaveLength(1);
      expect(await page.evaluate(() => document.querySelector(".ws-hold")!.getAttribute("data-held"))).toBe("false");

      // 2. The window losing focus, and 3. the page being hidden, each let go while the mouse is still down.
      for (const fire of ['window.dispatchEvent(new Event("blur"))', 'document.dispatchEvent(new Event("visibilitychange"))']) {
        from = performance.now() - started;
        await holdFor(200);
        await page.evaluate(fire);
        await page.waitForTimeout(200);
        const run = since(from);
        expect(run.filter((e) => e.pressed).length, fire).toBeGreaterThan(0);
        expect(run.filter((e) => !e.pressed), fire).toHaveLength(1);
        // Nothing more after the release, though the mouse is still down.
        const after = run.slice(run.findIndex((e) => !e.pressed) + 1);
        expect(after, fire).toEqual([]);
        await page.mouse.up();
        await page.waitForTimeout(50);
      }

      // 4. The control leaving the screen (the Pi's next state has none).
      from = performance.now() - started;
      await holdFor(200);
      current = { ...state, revision: 1, screen: { state: "motion_running", what: "Raising the lift", lift: { phase: "stopping", direction: "raise" } } };
      server.publish(current);
      await page.waitForTimeout(200);
      let run = since(from);
      // The page lets go; a "still held" already on its way when the state changed is turned into a release
      // by the server (not_shown). Either way nothing holds after the first release.
      const firstRelease = run.findIndex((e) => !e.pressed);
      expect(firstRelease).toBeGreaterThan(0);
      expect(run.slice(firstRelease).every((e) => !e.pressed)).toBe(true);
      expect(run.some((e) => !e.pressed && e.reason === "page")).toBe(true);
      expect(await page.evaluate(() => document.querySelector(".ws-hold"))).toBeNull();
      await page.mouse.up();

      // 5. The stream dropping: the page lets go at once (not 5 s later) and hides the control until it is back.
      current = { ...state, revision: 2 };
      server.publish(current);
      await page.waitForSelector(".ws-hold");
      from = performance.now() - started;
      await holdFor(200);
      await page.evaluate('for (const s of window.__sources) s.dispatchEvent(new Event("error"))');
      await page.waitForTimeout(200);
      run = since(from);
      expect(run.filter((e) => !e.pressed)).toHaveLength(1);
      expect(run.slice(run.findIndex((e) => !e.pressed) + 1)).toEqual([]);
      expect(await page.evaluate(() => document.querySelector(".ws-hold"))).toBeNull();
      await page.mouse.up();
    } finally {
      await browser.close();
    }
  }, 60_000);
});
