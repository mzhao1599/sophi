import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CaretakerSample, RoseSample } from "@/components/SampleScreens";
import { CIRCLE_MESSAGE_MAX, PRESET_REPLIES } from "@/lib/phoneApi";
import { SAMPLE_ROUTE, SAMPLE_THREAD, SAMPLE_WALK, routeLength, splitRoute } from "@/lib/sampleScreens";

// The two stage screens (/sample/caretaker, /sample/rose): what each says, that each says "Sample" once, and
// that the made-up data keeps to what the real app allows. The map itself is checked in a browser.

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

describe("sample screens", () => {
  it("splits the route where Rose is and says what is left", () => {
    expect(Math.round(routeLength(SAMPLE_ROUTE))).toBe(773);
    expect(SAMPLE_WALK.behind.at(-1)).toEqual(SAMPLE_WALK.at);
    expect(SAMPLE_WALK.ahead[0]).toEqual(SAMPLE_WALK.at);
    expect(SAMPLE_WALK.behind.length + SAMPLE_WALK.ahead.length).toBe(SAMPLE_ROUTE.length + 1);
    expect(SAMPLE_WALK.leftM).toBe(300);
    expect(SAMPLE_WALK.leftMin).toBe(6);
    expect(splitRoute(SAMPLE_ROUTE, 10_000).ahead).toEqual([SAMPLE_ROUTE.at(-1)]);
  });

  it("keeps the thread to what the real app can send", () => {
    for (const m of SAMPLE_THREAD) {
      expect(m.text.length).toBeLessThanOrEqual(CIRCLE_MESSAGE_MAX);
      if (m.from === "rose") expect(Object.values(PRESET_REPLIES)).toContain(m.text);
    }
  });

  it("draws Maya's phone with the walk and one Sample tag", () => {
    const html = renderToStaticMarkup(createElement(CaretakerSample));
    const words = text(html);
    expect(words).toContain("Maya's phone");
    expect(words).toContain("Rose is on her way");
    expect(words).toContain("6 min left");
    expect(words).toContain("300 m to the Lake Merritt Boating Center");
    expect(words.match(/\bSample\b/g)).toHaveLength(2); // the tag, and the map's words for a screen reader
    expect(words).not.toContain("Simulated");
    expect(html).not.toContain("<button");
  });

  it("draws Rose's phone with the thread, newest last, and one Sample tag", () => {
    const html = renderToStaticMarkup(createElement(RoseSample));
    const words = text(html);
    expect(words).toContain("Rose's phone");
    expect(words).toContain("Messages with Maya");
    const at = SAMPLE_THREAD.map((m) => words.indexOf(m.text));
    expect(at.every((i, n) => i > (at[n - 1] ?? -1))).toBe(true);
    expect(words.match(/\bSample\b/g)).toHaveLength(1);
    expect(html).not.toContain("<button");
  });
});
