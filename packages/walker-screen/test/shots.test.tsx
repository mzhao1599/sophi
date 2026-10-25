import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WalkerScreenView, screenFixtures, screenView } from "../src";

/**
 * Draws every fixture at 800x480 in headless Chromium, saves a PNG of each, and checks what a screenshot can't
 * be trusted to show by eye: nothing overflows its region or the panel, the main line takes at most two
 * lines, no text is under 40 px, buttons are at least 147 px on their short side with at most 3 a screen,
 * and every text colour is 7:1 or better on what's behind it. On walking directions' screens it also checks
 * that the maneuver word keeps one line, that no line needed its ellipsis backstop, that the map sits in its
 * column, and that the OpenStreetMap credit is on the map at 7:1.
 *
 * Off unless these are set (no browser is installed by this package):
 *   SCREEN_SHOTS_DIR  where the PNGs and report.json go
 *   PLAYWRIGHT_CORE   path to a playwright-core package directory
 *   CHROMIUM_PATH     path to a Chromium (or chrome-headless-shell) binary
 * Optional:
 *   SCREEN_TILES      a tile base URL for the map ("file:///path/to/tiles", holding {z}/{x}/{y}.png); without
 *                     it the map draws on its plain background, as offline with nothing cached
 */
const outDir = process.env.SCREEN_SHOTS_DIR;
const playwrightPath = process.env.PLAYWRIGHT_CORE;
const chromiumPath = process.env.CHROMIUM_PATH;
const tiles = process.env.SCREEN_TILES || undefined;

const src = fileURLToPath(new URL("../src/", import.meta.url));
const css = readFileSync(join(src, "screen.css"), "utf8").replaceAll("./fonts/", pathToFileURL(join(src, "fonts")).href + "/");

/** The little of playwright-core this uses, so the package needn't depend on it. */
interface PlaywrightPage {
  emulateMedia(o: { reducedMotion: "reduce" }): Promise<void>;
  goto(url: string): Promise<unknown>;
  evaluate<T>(fn: () => T | Promise<T>): Promise<T>;
  screenshot(o: { path: string }): Promise<unknown>;
}
interface PlaywrightCore {
  chromium: {
    launch(o: { executablePath: string }): Promise<{
      newPage(o: { viewport: { width: number; height: number }; deviceScaleFactor: number }): Promise<PlaywrightPage>;
      close(): Promise<void>;
    }>;
  };
}

interface Measured {
  problems: string[];
  minContrast: number;
  mainLines: number;
}

/** Runs in the page. */
function measure(): Measured {
  const problems: string[] = [];
  const root = document.querySelector(".ws-screen") as HTMLElement;
  const R = root.getBoundingClientRect();
  if (Math.round(R.width) !== 800 || Math.round(R.height) !== 480) problems.push(`screen is ${R.width}x${R.height}`);

  // Sideways overflow of the one-line strip and of buttons. (Heights are checked by the boxes below: a line
  // box is shorter than the font's ascent plus descent, so scrollHeight always reads a few px over.)
  for (const sel of [".ws-strip", ".ws-button", ".ws-center"]) {
    for (const el of root.querySelectorAll<HTMLElement>(sel)) {
      const dw = el.scrollWidth - el.clientWidth;
      if (dw > 1) problems.push(`${sel} "${el.textContent?.slice(0, 30)}" overflows sideways by ${dw} px`);
    }
  }
  // The regions don't overlap each other.
  const [strip, one, band] = [".ws-strip", ".ws-one", ".ws-band"].map((sel) => root.querySelector(sel)!.getBoundingClientRect()) as [DOMRect, DOMRect, DOMRect];
  if (strip.bottom > one.top + 0.5 || one.bottom > band.top + 0.5) problems.push("regions overlap");

  const texts = [...root.querySelectorAll<HTMLElement>(".ws-main, .ws-line, .ws-button-label, .ws-button-sub, .ws-hint, .ws-presence, .ws-time, .ws-tag")];
  const inside = (r: DOMRect, o: DOMRect) => r.left >= o.left - 0.5 && r.right <= o.right + 0.5 && r.top >= o.top - 0.5 && r.bottom <= o.bottom + 0.5;
  for (const el of texts) {
    const r = el.getBoundingClientRect();
    const region = el.closest(".ws-strip, .ws-one, .ws-band, .ws-button, .ws-nav-side") as HTMLElement;
    if (!inside(r, R)) problems.push(`"${el.textContent}" leaves the screen`);
    if (region && !inside(r, region.getBoundingClientRect())) problems.push(`"${el.textContent}" leaves its region`);
    const size = parseFloat(getComputedStyle(el).fontSize);
    if (size < 40) problems.push(`"${el.textContent}" is ${size}px`);
  }

  const main = root.querySelector<HTMLElement>(".ws-main")!;
  const mainLines = Math.round(main.getBoundingClientRect().height / parseFloat(getComputedStyle(main).lineHeight));
  if (main.dataset.size === "main" && mainLines > 2) problems.push(`main line takes ${mainLines} lines`);
  if (main.dataset.size === "nav" && mainLines > (main.dataset.wraps === "true" ? 2 : 1)) problems.push(`"${main.textContent}" takes ${mainLines} lines`);
  // The ellipsis backstop never fires on a fixture: the view shortened the line enough.
  // One line: its text's own width (scrollWidth rounds, and an ellipsis shows at a fraction of a pixel over).
  // More: a line box is shorter than the glyphs, so a clamped block's height is allowed half a line of slack.
  for (const el of root.querySelectorAll<HTMLElement>("[data-max-lines]")) {
    const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
    const range = document.createRange();
    range.selectNodeContents(el);
    const clipped = el.dataset.maxLines === "1" ? range.getBoundingClientRect().width > el.clientWidth : el.scrollHeight > el.clientHeight + lineHeight / 2;
    if (clipped) problems.push(`"${el.textContent}" is clipped`);
  }
  const map = root.querySelector<HTMLElement>(".ws-map");
  if (map) {
    const m = map.getBoundingClientRect();
    const side = root.querySelector(".ws-nav-side")!.getBoundingClientRect();
    if (!inside(m, side) || !inside(m, R)) problems.push("the map leaves its column");
    const credit = map.querySelector<HTMLElement>(".ws-map-credit");
    if (!credit || credit.textContent !== "© OpenStreetMap contributors") problems.push("no OpenStreetMap credit on the map");
    else if (!inside(credit.getBoundingClientRect(), m)) problems.push("the OpenStreetMap credit leaves the map");
  }
  // A word broken across lines: any word whose own rects span two lines.
  for (const el of texts) {
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const text = node.textContent ?? "";
      for (const m of text.matchAll(/\S+/g)) {
        const range = document.createRange();
        range.setStart(node, m.index!);
        range.setEnd(node, m.index! + m[0].length);
        const tops = new Set([...range.getClientRects()].map((x) => Math.round(x.top)));
        if (tops.size > 1) problems.push(`word "${m[0]}" breaks across lines`);
      }
    }
  }

  const buttons = [...root.querySelectorAll<HTMLElement>(".ws-button")];
  if (buttons.length > 3) problems.push(`${buttons.length} buttons`);
  const rects = buttons.map((b) => b.getBoundingClientRect());
  for (const [i, r] of rects.entries()) {
    if (Math.min(r.width, r.height) < 147) problems.push(`button "${buttons[i]!.textContent}" is ${Math.round(r.width)}x${Math.round(r.height)}`);
    for (const o of rects.slice(i + 1)) {
      const gap = Math.max(o.left - r.right, r.left - o.right, o.top - r.bottom, r.top - o.bottom);
      if (gap < 22) problems.push(`buttons ${Math.round(gap)} px apart`);
    }
  }

  const rgba = (c: string) => {
    const n = c.match(/[\d.]+/g)!.map(Number);
    return { r: n[0]!, g: n[1]!, b: n[2]!, a: n[3] ?? 1 };
  };
  const lum = ({ r, g, b }: { r: number; g: number; b: number }) => {
    const f = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const background = (el: Element | null): { r: number; g: number; b: number } => {
    const layers: { r: number; g: number; b: number; a: number }[] = [];
    for (let e = el; e; e = e.parentElement) {
      const c = rgba(getComputedStyle(e).backgroundColor);
      if (c.a > 0) layers.push(c);
      if (c.a >= 1) break;
    }
    let out = { r: 255, g: 255, b: 255 };
    for (const l of layers.reverse()) out = { r: l.r * l.a + out.r * (1 - l.a), g: l.g * l.a + out.g * (1 - l.a), b: l.b * l.a + out.b * (1 - l.a) };
    return out;
  };
  let minContrast = Infinity;
  for (const el of [...texts, ...root.querySelectorAll<HTMLElement>(".ws-map-credit")]) {
    const fg = rgba(getComputedStyle(el).color);
    const bg = background(el);
    const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x) as [number, number];
    const ratio = (a + 0.05) / (b + 0.05);
    minContrast = Math.min(minContrast, ratio);
    if (ratio < 7) problems.push(`"${el.textContent}" contrast ${ratio.toFixed(2)}:1`);
  }
  return { problems, minContrast, mainLines };
}

describe.skipIf(!outDir || !playwrightPath || !chromiumPath)("every fixture at 800x480", () => {
  it("fits, reads at 7:1, and is saved as a PNG", async () => {
    const { chromium } = createRequire(import.meta.url)(playwrightPath!) as PlaywrightCore;
    mkdirSync(join(outDir!, "html"), { recursive: true });
    const browser = await chromium.launch({ executablePath: chromiumPath! });
    const report: Record<string, Measured> = {};
    try {
      const page = await browser.newPage({ viewport: { width: 800, height: 480 }, deviceScaleFactor: 1 });
      // Shots show the settled screen: the 240 ms cross-fade is skipped, as on a reduced-motion setting.
      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const fixture of screenFixtures()) {
        const markup = renderToStaticMarkup(<WalkerScreenView view={screenView(fixture.state)} tiles={tiles} />);
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style><style>body{margin:0}</style></head><body>${markup}</body></html>`;
        const file = join(outDir!, "html", `${fixture.name}.html`);
        writeFileSync(file, html);
        await page.goto(pathToFileURL(file).href);
        await page.evaluate(() => document.fonts.ready);
        // Map tiles: wait until each has loaded or failed (a failed one is hidden, as on the Pi's page).
        await page.evaluate(() =>
          Promise.all(
            [...document.images].map((img) =>
              img.complete
                ? null
                : new Promise((done) => {
                    img.addEventListener("load", done, { once: true });
                    img.addEventListener("error", done, { once: true });
                  }),
            ),
          ),
        );
        const loaded = await page.evaluate(() => document.fonts.check('700 88px "Atkinson Hyperlegible Next"'));
        report[fixture.name] = await page.evaluate(measure);
        if (!loaded) report[fixture.name]!.problems.push("Atkinson Hyperlegible Next didn't load");
        await page.screenshot({ path: join(outDir!, `${fixture.name}.png`) });
      }
    } finally {
      await browser.close();
    }
    writeFileSync(join(outDir!, "report.json"), JSON.stringify(report, null, 2));
    const failing = Object.fromEntries(Object.entries(report).filter(([, m]) => m.problems.length));
    expect(failing).toEqual({});
  }, 300_000);
});
