import { describe, expect, it } from "vitest";
import { DEFAULT_SCREEN_CHOICES, ScreenStateSchema, TEXT_SIZES, type ScreenState, type ShowCard, type TextSize } from "@walker/contracts";
import { LONGEST_CONDITIONS, LONGEST_PLACE, ONE_THING_PX, SHOWING_CAPTION_CHARS, oneThingPx, screenFixtures, screenView, showingCaptionPages, type ScreenView } from "../src";

/**
 * EXPECTED (written before the code, 2026-10-24; docs/subsystems/show-on-screen.md, "The screen"):
 *
 * - weather: "64°" as the main line; "Partly cloudy skies" and "Wind 8 mph" under it; "Weather data from
 *   Open-Meteo" between the handles on every weather card; a simulated position adds "Near you, from GPS" with a
 *   Simulated tag. Heard as "64 degrees Fahrenheit, partly cloudy skies, wind 8 miles per hour. Weather data
 *   from Open-Meteo."
 * - location: the address as the main line, at the largest size that fits (a 120-character address too);
 *   "Near you, from GPS", Simulated when simulated; "© OpenStreetMap contributors" between the handles (the
 *   address comes from OpenStreetMap's geocoder).
 * - sensors: the nearest measured zone as the main line ("Front left · 30 cm", centimetres as the obstacle
 *   screen), "Not measured" when none is; then each zone in the Pi's order, "Front right · Not measured" for an
 *   unknown one, each with its own Simulated tag. Nothing reads "clear" or "safe". As many zones as fit at her
 *   text size, then "and N more" (", M not measured" when hidden zones aren't measured). A new reading changes
 *   the numbers only: the scene key and the announcement stay, so a screen reader hears the card once.
 * - message: the words at the message size and "From Maya", no Confirm hint and no buttons (the Pi doesn't
 *   replay from this card). Heard as "Maya says: …".
 * - parts: "3 parts" as the main line; each part by its catalog name and its health in words (Working, Needs a
 *   check, Not working, Not responding), problems first; a simulated part is never "Working": its name and a
 *   Simulated tag. "and N more" past what fits.
 * - caption: with captions on and a caption set, the last line under the card, at the smallest size; never in
 *   the key or the announcement; gone when null or with captions off; one longer than a page is shortened at a
 *   word, never clipped.
 * - every card at every text size, with the longest strings the contract allows (120-character address,
 *   40-character conditions, 16 zones, 16 parts, a full caption page): no buttons, Talk on the right, nothing
 *   over the left handle, and its estimated height within the 354 px the one thing has. The screenshot check
 *   (test/shots.test.tsx) draws the same fixtures in Chromium to prove it.
 *
 * Changed after the first run, with the reason:
 * - A caption page at her size (CAPTION_PAGE_CHARS) is 110 characters at Large: three lines at the smallest
 *   size, which left no room at Large for a 120-character address. Under a card a page is now at most two lines
 *   of the smallest size at every text size (SHOWING_CAPTION_CHARS, 75; the Pi pages with showingCaptionPages
 *   while a card is up), and the caption sits under a hairline, since "It's on your screen: four parts." read as
 *   one more part in the first screenshots.
 * - Where room is short the lines drop to the smallest size, and the weather's wind joins its conditions
 *   ("Partly cloudy skies, wind 8 mph"), so the temperature can stay large.
 * - Parts: simulated ones come after problems and before real working ones, so a stand-in is never hidden behind
 *   real parts; "and N more" counts the simulated ones it hides unless every part is simulated.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const settings = { version: 2, ...DEFAULT_SCREEN_CHOICES, changed_at: "2026-10-24T18:00:00.000Z", pending_local: false };
const state = (card: ShowCard, caption: string | null = null, extra: { text_size?: TextSize; captions?: boolean } = {}): ScreenState =>
  ScreenStateSchema.parse({
    v: 1,
    revision: 4,
    screen: { state: "showing", card, caption },
    settings: { ...settings, ...extra },
    strip: { link: "online", simulator: false, bench_mode: false, clock: { local_time: "2026-10-24T19:42:00" } },
  });
const show = (card: ShowCard, caption: string | null = null, extra: { text_size?: TextSize; captions?: boolean } = {}) => screenView(state(card, caption, extra));
const texts = (v: ScreenView) => [v.main.text, ...v.lines.map((l) => l.text), ...v.center.lines.map((l) => l.text)];

const weather: ShowCard = { view: "weather", temperature_f: 64, conditions: "partly cloudy skies", wind_mph: 8, simulated: false };
const zones = (readings: (number | null)[], simulated = true): ShowCard => ({
  view: "sensors",
  zones: readings.map((mm, i) => ({
    zone: ["front_left", "front_right", "rear"][i] ?? `zone_${i}`,
    distance: mm === null ? { status: "unknown" as const } : { status: "measured" as const, mm },
    simulated,
  })),
});

describe("weather card", () => {
  it("the temperature large, the conditions, the wind and the attribution", () => {
    const v = show(weather);
    expect(v.main).toEqual({ text: "64°", size: "main" });
    expect(v.lines).toEqual([{ text: "Partly cloudy skies", size: "body" }, { text: "Wind 8 mph", size: "body" }]);
    expect(v.center.lines).toEqual([{ text: "Weather data from Open-Meteo", size: "detail" }]);
    expect(v.announce).toBe("64 degrees Fahrenheit, partly cloudy skies, wind 8 miles per hour. Weather data from Open-Meteo.");
  });

  it("a simulated position says so; the attribution shows at every size", () => {
    for (const size of TEXT_SIZES) {
      const v = show({ ...weather, simulated: true }, null, { text_size: size });
      expect(v.lines.at(-1), size).toMatchObject({ text: "Near you, from GPS", simulated: true });
      expect(v.center.lines.map((l) => l.text), size).toEqual(["Weather data from Open-Meteo"]);
      expect(v.announce, size).toContain("The location is simulated.");
    }
    expect(show(weather).lines.some((l) => l.simulated)).toBe(false);
  });

  it("the longest conditions the contract allows still fit, with the wind beside them when room is short", () => {
    expect([...LONGEST_CONDITIONS].length).toBe(40);
    for (const size of TEXT_SIZES) {
      const v = show({ view: "weather", temperature_f: -150, conditions: LONGEST_CONDITIONS, wind_mph: 300, simulated: true }, "x".repeat(SHOWING_CAPTION_CHARS), { text_size: size });
      expect(v.lines.map((l) => l.text).join(" "), size).toMatch(/^Thunderstorms with slight and heavy hail,? [Ww]ind 300 mph Near you, from GPS x+$/);
      expect(oneThingPx(v), size).toBeLessThanOrEqual(ONE_THING_PX.words);
    }
  });

  it("says one degree, below zero and one mile per hour in words", () => {
    expect(show({ ...weather, temperature_f: -5, wind_mph: 1 }).announce).toBe("minus 5 degrees Fahrenheit, partly cloudy skies, wind 1 mile per hour. Weather data from Open-Meteo.");
    expect(show({ ...weather, temperature_f: 1 }).announce).toMatch(/^1 degree Fahrenheit,/);
    expect(show({ ...weather, temperature_f: -5 }).main.text).toBe("-5°");
  });
});

describe("location card", () => {
  it("the address, where it came from, and the map credit", () => {
    const v = show({ view: "location", place: "600 Bellevue Avenue, Oakland", simulated: true });
    expect(v.main.text).toBe("600 Bellevue Avenue, Oakland");
    expect(v.lines).toEqual([{ text: "Near you, from GPS", size: "detail", simulated: true }]);
    expect(v.center.lines.map((l) => l.text)).toEqual(["© OpenStreetMap contributors"]);
    expect(v.announce).toBe("Near you, from GPS: 600 Bellevue Avenue, Oakland. The location is simulated.");
    expect(show({ view: "location", place: "Oakland", simulated: false }).lines[0]!.simulated).toBe(false);
  });

  it("a 120-character address drops to a smaller size, never cut", () => {
    const place = LONGEST_PLACE;
    expect([...place].length).toBe(120);
    for (const size of TEXT_SIZES) {
      const v = show({ view: "location", place, simulated: true }, "x".repeat(SHOWING_CAPTION_CHARS), { text_size: size });
      expect(v.main.text, size).toBe(place);
      expect(v.main.size, size).not.toBe("main");
      expect(oneThingPx(v), size).toBeLessThanOrEqual(ONE_THING_PX.words);
    }
  });
});

describe("sensors card", () => {
  it("the nearest measured zone large, then every zone with its own Simulated tag", () => {
    const v = show(zones([1500, 304, null]));
    expect(v.main.text).toBe("Front right · 30 cm");
    expect(v.lines.map((l) => [l.text, l.simulated])).toEqual([
      ["Front left · 150 cm", true],
      ["Front right · 30 cm", true],
      ["Rear · Not measured", true],
    ]);
  });

  it("says Not measured when nothing is, and never clear or safe", () => {
    const v = show(zones([null, null], false));
    expect(texts(v)).toEqual(["Not measured", "Front left · Not measured", "Front right · Not measured"]);
    expect(v.lines.every((l) => l.simulated === false)).toBe(true);
    for (const t of [...texts(v), v.announce]) expect(t).not.toMatch(/clear|safe|nothing (?:there|close)/i);
  });

  it("a new reading changes the numbers, not the scene or what a screen reader hears", () => {
    const a = show(zones([1500, 304]));
    const b = show(zones([1490, 1600]));
    expect(b.main.text).toBe("Front left · 149 cm");
    expect(b.sceneKey).toBe(a.sceneKey);
    expect(b.announce).toBe(a.announce);
    expect([b.main.size, b.lines.map((l) => l.size)]).toEqual([a.main.size, a.lines.map((l) => l.size)]);
    // A zone going unknown keeps them too; a different set of zones is a new card.
    expect(show(zones([null, 304])).sceneKey).toBe(a.sceneKey);
    expect(show(zones([null, 304])).announce).toBe(a.announce);
    expect(show(zones([1500, 304, 800])).sceneKey).not.toBe(a.sceneKey);
    expect(a.announce).toBe("Sensor readings on screen, updated as they come: front left and front right. Simulated.");
  });

  it("16 zones at Largest: what fits, then how many more and how many of those aren't measured", () => {
    const card: ShowCard = {
      view: "sensors",
      zones: Array.from({ length: 16 }, (_, i) => ({
        zone: `rear_lower_bumper_left_${i.toString(16)}`,
        distance: i % 2 ? { status: "unknown" as const } : { status: "measured" as const, mm: 65535 },
        simulated: true,
      })),
    };
    for (const size of TEXT_SIZES) {
      const v = show(card, "x".repeat(SHOWING_CAPTION_CHARS), { text_size: size });
      const zoneLines = v.lines.filter((l) => l.text.includes(" · "));
      const more = v.lines.find((l) => l.text.startsWith("and "));
      expect(zoneLines.length, size).toBeGreaterThan(0);
      expect(zoneLines.length, size).toBeLessThan(16);
      const hidden = card.zones.slice(zoneLines.length);
      const unknown = hidden.filter((z) => z.distance.status === "unknown").length;
      expect(more?.text, size).toBe(`and ${hidden.length} more, ${unknown} not measured`);
      expect(oneThingPx(v), size).toBeLessThanOrEqual(ONE_THING_PX.words);
    }
  });
});

describe("message card", () => {
  it("the words and who sent them, as the message screen, with nothing to press", () => {
    const v = show({ view: "message", message_id: uuid(21), from_name: "Maya", text: "Running late, see you at 6" });
    expect(v.main).toEqual({ text: "Running late, see you at 6", size: "message" });
    expect(v.lines).toEqual([{ text: "From Maya", size: "detail" }]);
    expect(v.left).toBeNull();
    expect(v.center).toEqual({ lines: [], buttons: [] });
    expect(v.announce).toBe("Maya says: Running late, see you at 6");
    expect(v.sceneKey).not.toBe(show({ view: "message", message_id: uuid(22), from_name: "Maya", text: "Running late, see you at 6" }).sceneKey);
  });
});

describe("parts card", () => {
  const parts: ShowCard = {
    view: "parts",
    parts: [
      { module_id: "controls.hand", health: "ok", simulated: false },
      { module_id: "perception.tof", health: "ok", simulated: true },
      { module_id: "voice", health: "degraded", simulated: false },
      { module_id: "manipulation.arm", health: "fault", simulated: false },
      { module_id: "manipulation.lift", health: "unavailable", simulated: true },
    ],
  };

  it("each part by name and its health in words, problems first, simulated never working", () => {
    const v = show(parts, null, { text_size: "large", captions: false });
    expect(v.main.text).toBe("5 parts");
    expect(v.lines.map((l) => [l.text, l.simulated])).toEqual([
      ["Robot arms · Not working", false],
      ["Arm lift · Not responding", true],
      ["Voice · Needs a check", false],
      ["Obstacle sensors", true],
      ["Hand controls · Working", false],
    ]);
    expect(v.announce).toBe(
      "5 parts: Robot arms, not working; Arm lift, not responding, simulated; Voice, needs a check; Obstacle sensors, simulated; Hand controls, working.",
    );
    // With a caption page reserved, fewer fit: the rest are counted, the simulated ones among them named.
    const tight = show(parts, null, { text_size: "large" });
    const more = tight.lines.at(-1)!.text;
    const shown = tight.lines.length - 1;
    expect(shown).toBeLessThan(5);
    const hiddenSimulated = v.lines.slice(shown).filter((l) => l.simulated).length;
    expect(more).toBe(`and ${5 - shown} more${hiddenSimulated ? `, ${hiddenSimulated} simulated` : ""}`);
    expect(show({ view: "parts", parts: [parts.parts[0]!] }).main.text).toBe("1 part");
  });

  it("a change of health is a new card a screen reader hears", () => {
    const fixed: ShowCard = { view: "parts", parts: parts.parts.map((p) => ({ ...p, health: "ok" as const })) };
    expect(show(fixed).sceneKey).not.toBe(show(parts).sceneKey);
    expect(show(fixed).announce).not.toBe(show(parts).announce);
  });

  it("16 parts: what fits, then how many more", () => {
    const many: ShowCard = { view: "parts", parts: Array.from({ length: 16 }, (_, i) => ({ module_id: "base.walker" as const, health: i < 2 ? ("degraded" as const) : ("ok" as const), simulated: i % 2 === 0 })) };
    for (const size of TEXT_SIZES) {
      const v = show(many, "x".repeat(SHOWING_CAPTION_CHARS), { text_size: size });
      const shown = v.lines.filter((l) => l.text.startsWith("Walker and coordinator"));
      const hiddenSimulated = 8 - shown.filter((l) => l.simulated).length;
      expect(shown.length, size).toBeGreaterThan(0);
      expect(v.lines.find((l) => l.text.startsWith("and "))?.text, size).toBe(`and ${16 - shown.length} more${hiddenSimulated ? `, ${hiddenSimulated} simulated` : ""}`);
      expect(oneThingPx(v), size).toBeLessThanOrEqual(ONE_THING_PX.words);
    }
  });
});

describe("the caption under a card", () => {
  it("shows Sophi's caption page last, at the smallest size, without changing the scene or the announcement", () => {
    const quiet = show(weather);
    const speaking = show(weather, "It's on your screen: 64 degrees, partly cloudy.");
    expect(speaking.lines.at(-1)).toEqual({ text: "It's on your screen: 64 degrees, partly cloudy.", size: "caption" });
    expect(speaking.lines.slice(0, -1)).toEqual(quiet.lines);
    expect(speaking.main).toEqual(quiet.main);
    expect(speaking.sceneKey).toBe(quiet.sceneKey);
    expect(speaking.announce).toBe(quiet.announce);
    expect(show(weather, "The next page.").sceneKey).toBe(quiet.sceneKey);
  });

  it("is gone when null, and with captions off", () => {
    expect(show(weather).lines.map((l) => l.text)).not.toContain("It's on your screen.");
    expect(show(weather, "It's on your screen.", { captions: false }).lines.map((l) => l.text)).not.toContain("It's on your screen.");
  });

  it("pages a reply in whole words of at most two lines of the smallest size", () => {
    const reply = "It's on your screen now, with every reading the walker has from its sensors on the front and on the back. The nearest is at the top.";
    const pages = showingCaptionPages(reply);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.join(" ")).toBe(reply);
    for (const p of pages) expect([...p].length).toBeLessThanOrEqual(SHOWING_CAPTION_CHARS);
    expect(SHOWING_CAPTION_CHARS).toBe(75);
  });

  it("a caption longer than a page is shortened at a word", () => {
    const long = "It's on your screen. ".repeat(28).trim();
    expect([...long].length).toBeLessThanOrEqual(600);
    for (const size of TEXT_SIZES) {
      const line = show(weather, long, { text_size: size }).lines.at(-1)!;
      expect([...line.text].length, size).toBeLessThanOrEqual(SHOWING_CAPTION_CHARS);
      expect(line.text, size).toMatch(/…$/);
    }
  });
});

describe("every card fixture", () => {
  const cards = screenFixtures().filter((f) => f.state.screen.state === "showing");

  it("covers each view, simulated and longest, at every text size", () => {
    const views = new Set(cards.map((f) => (f.state.screen.state === "showing" ? f.state.screen.card.view : null)));
    expect(views).toEqual(new Set(["weather", "location", "sensors", "message", "parts"]));
    expect(cards.length % 3).toBe(0);
  });

  it("fits the one thing, has nothing to press, Talk on the right, and never says clear or safe", () => {
    for (const f of cards) {
      const v = screenView(f.state);
      expect(oneThingPx(v), f.name).toBeLessThanOrEqual(ONE_THING_PX.words);
      expect(v.left, f.name).toBeNull();
      expect(v.center.buttons, f.name).toEqual([]);
      expect(v.hold, f.name).toBeNull();
      expect(v.right, f.name).toBe("Talk");
      expect(v.center.lines.length, f.name).toBeLessThanOrEqual(1);
      expect(v.announce.length, f.name).toBeGreaterThan(0);
      for (const t of [...texts(v), v.announce]) expect(t, f.name).not.toMatch(/clear|safe/i);
    }
  });

  it("shows a Simulated tag exactly where the card's data is simulated", () => {
    for (const f of cards) {
      if (f.state.screen.state !== "showing") continue;
      const card = f.state.screen.card;
      const v = screenView(f.state);
      // A tag on a shown line, or the count of simulated ones among those under "and N more".
      const tagged = v.lines.some((l) => l.simulated || / \d+ simulated$/.test(l.text));
      const simulated =
        card.view === "weather" || card.view === "location" ? card.simulated : card.view === "sensors" ? card.zones.some((z) => z.simulated) : card.view === "parts" ? card.parts.some((p) => p.simulated) : false;
      expect(tagged, f.name).toBe(simulated);
    }
  });
});
