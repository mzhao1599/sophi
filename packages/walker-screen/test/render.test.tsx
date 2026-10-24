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
      expect(html, f.name).toContain(">Talk<");
    }
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
