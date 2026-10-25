import { existsSync, readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WalkerScreenView, screenFixtures, screenView } from "../src";

const css = readFileSync(new URL("../src/screen.css", import.meta.url), "utf8");

describe("WalkerScreenView", () => {
  it("draws every fixture with its theme, its words, at most 3 buttons and the honest labels", () => {
    for (const f of screenFixtures()) {
      const view = screenView(f.state);
      const html = renderToStaticMarkup(<WalkerScreenView view={view} />);
      expect(html, f.name).toContain(`data-theme="${f.state.settings.theme}"`);
      expect(html, f.name).toContain(`--ws-main:${view.sizes.main}px`);
      expect((html.match(/<button/g) ?? []).length, f.name).toBeLessThanOrEqual(3);
      expect(html.includes(">Simulator<"), f.name).toBe(f.state.strip.simulator);
      expect(html, f.name).toContain('aria-live="polite"');
      expect(html, f.name).toContain(`>${view.right}<`);
      // The hold control is drawn exactly when the view has one.
      expect(html.includes("ws-hold"), f.name).toBe(view.hold !== null);
      expect(html.includes(">Bench mode<"), f.name).toBe(f.state.strip.bench_mode && !f.state.strip.simulator);
    }
  });

  it("draws the hold control held or not, named for a screen reader, and inert without onHold", () => {
    const lift = screenFixtures().find((f) => f.name === "motion-confirm-lift-raise--large")!;
    const view = screenView(lift.state);
    const idle = renderToStaticMarkup(<WalkerScreenView view={view} />);
    expect(idle).toContain('aria-pressed="false"');
    expect(idle).toContain('data-held="false"');
    expect(idle).toContain('aria-label="Hold to raise. Keep it held while you press Confirm on the handle."');
    expect(idle).toContain(">and press Confirm<");
    const held = renderToStaticMarkup(<WalkerScreenView view={view} onHold={() => {}} held />);
    expect(held).toContain('aria-pressed="true"');
    expect(held).toContain('data-held="true"');
    // Running: Stop over both handles, no Talk or Confirm word.
    const running = renderToStaticMarkup(<WalkerScreenView view={screenView(screenFixtures().find((f) => f.name === "motion-running-lift--large")!.state)} />);
    expect(running.match(/>Stop</g)).toHaveLength(2);
    expect(running).not.toMatch(/>Talk<|>Confirm</);
  });

  it("marks switches with aria-pressed and inert buttons with aria-disabled", () => {
    const reading = screenFixtures().find((f) => f.name === "my-screen-reading--large")!;
    const html = renderToStaticMarkup(<WalkerScreenView view={screenView(reading.state)} />);
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-pressed="false"');
    const size = screenFixtures().find((f) => f.name === "my-screen-text-size--large")!;
    expect(renderToStaticMarkup(<WalkerScreenView view={screenView(size.state)} />)).toContain('aria-disabled="true"');
  });
});

describe("walking directions", () => {
  const find = (name: string) => screenFixtures().find((f) => f.name === name)!;

  it("draws the map in its column, her dot, the credit, the arrow, and Repeat and End route", () => {
    const view = screenView(find("navigating--large").state);
    const html = renderToStaticMarkup(<WalkerScreenView view={view} />);
    expect(html).toContain('data-layout="navigating"');
    expect(html).toContain('role="img" aria-label="Map: your simulated position, the route ahead, the next turn, the place. Map data © OpenStreetMap contributors."');
    expect(html).toContain(">© OpenStreetMap contributors<");
    expect(html).toContain('data-maneuver="left"');
    expect(html).toContain(">Simulated<");
    expect(html).toContain('class="ws-map-me-ring" data-simulated="true"');
    expect(html).toMatch(/>Repeat<[\s\S]*>End route</);
    expect(html).toContain('aria-live="polite">Turn left onto Lenox Avenue.<');
    // Without a tile base, the plain background: the route and the dot, and no image at all.
    expect(html).not.toContain("<img");
    expect(html).toContain('class="ws-route"');
  });

  it("asks only its own server for tiles, by number, and hides them from a screen reader", () => {
    const view = screenView(find("navigating--large").state);
    const html = renderToStaticMarkup(<WalkerScreenView view={view} tiles="/tiles/" />);
    const srcs = [...html.matchAll(/<img [^>]*src="([^"]+)"/g)].map((m) => m[1]);
    expect(srcs.length).toBe(view.nav!.map.tiles.length);
    expect(srcs).toContain("/tiles/17/21023/50645.png");
    for (const src of srcs) expect(src).toMatch(/^\/tiles\/\d+\/\d+\/\d+\.png$/);
    expect(html).not.toMatch(/<img (?![^>]*alt="")/);
  });

  it("a real position has a solid ring and no Simulated tag; no position draws no dot", () => {
    const real = renderToStaticMarkup(<WalkerScreenView view={screenView(find("navigating-real-gps-path--large").state)} />);
    expect(real).not.toContain(">Simulated<");
    expect(real).toContain('data-simulated="false"');
    const lost = renderToStaticMarkup(<WalkerScreenView view={screenView(find("navigating-no-position--large").state)} />);
    expect(lost).not.toContain("ws-map-me");
    expect(lost).toContain('aria-label="Map: the route ahead, the next turn, the place.');
    expect(lost).not.toContain("ws-turn-arrow");
  });
});

describe("screen.css", () => {
  it("never follows a system dark mode, and themes only by data-theme", () => {
    expect(css).not.toMatch(/prefers-color-scheme/);
    expect(css).toContain('.ws-screen[data-theme="light"]');
    expect(css).toContain('.ws-screen[data-theme="dark"]');
  });

  it("moves only in a short fade, with a reduced-motion branch, and never blurs, slides or pulses", () => {
    const durations = [...css.matchAll(/animation:[^;]*?(\d+)ms/g)].map((m) => Number(m[1]));
    expect(durations.length).toBeGreaterThan(0);
    for (const ms of durations) expect(ms).toBeLessThanOrEqual(300);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*{\s*\.ws-one\s*{\s*animation: none;/);
    expect(css).not.toMatch(/blur\(|translate|infinite/);
    // Nothing pans or zooms: the map redraws in place (no transitions anywhere).
    expect(css).not.toMatch(/transition/);
  });

  it("sets no text size by hand: every one comes from sizes.ts", () => {
    expect(css).not.toMatch(/font-size:\s*\d/);
  });

  it("ships the font files and their licence", () => {
    for (const file of ["atkinson-hyperlegible-next-latin.woff2", "atkinson-hyperlegible-next-latin-ext.woff2", "OFL.txt"]) {
      expect(existsSync(new URL(`../src/fonts/${file}`, import.meta.url)), file).toBe(true);
    }
    expect(readFileSync(new URL("../src/fonts/OFL.txt", import.meta.url), "utf8")).toMatch(/Atkinson Hyperlegible Next Project Authors[\s\S]*SIL OPEN FONT LICENSE Version 1.1/);
  });
});
