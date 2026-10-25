import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCREEN_SHOW_MS, ScreenStateSchema, ShowCardSchema, type DeviceTurnRequest, type ScreenState, type ShowCard } from "@walker/contracts";
import { SHOWING_CAPTION_CHARS, showingCaptionPages } from "@walker/walker-screen/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SCREEN_ANSWER_HOLD_MS, SCREEN_ZONES_MIN_MS, ZONE_VALIDITY_MS } from "../src/constants";
import { describeGpsLocation, lookUpPlace } from "../src/location";
import { mapServicesFromEnv } from "../src/navigation/osm";
import { attachScreen, seedScreen, startingSettings } from "../src/screen/attach";
import { ScreenMachine, pageMs, pickScreen, type ScreenModel } from "../src/screen/machine";
import type { ServiceDeps } from "../src/service";
import { NOTHING_SHOWN } from "../src/show";
import { ScriptRunner, parseScript } from "../src/sim/script";
import { currentWeather, describeCurrentWeather, type WeatherReading } from "../src/weather";
import { FakeClock, boot, flush, makeHarness, type Harness } from "./support/fakes";

/** Rows SH1 to SH13 of test/EXPECTED.md ("Show on screen"). Fake clock, fake cloud, fake GPS and lookups: no internet. */

const settings = startingSettings(undefined, Date.parse("2026-10-24T02:00:00Z"));
const WEATHER: WeatherReading = {
  text: "The latest weather estimate near you is 64 degrees Fahrenheit with partly cloudy skies and wind around 8 miles per hour. Weather data from Open-Meteo.",
  temperature_f: 64,
  conditions: "partly cloudy skies",
  wind_mph: 8,
};
const PLACE = { text: "Your GPS puts you near 600 Bellevue Avenue, Oakland, California.", place: "600 Bellevue Avenue, Oakland, California" };
/** A fix nobody would type by accident, so a test can look for it anywhere it must not be. */
const FIX = { status: "fix" as const, latitude: 37.80913, longitude: -122.25871 };
const MESSAGE_WORDS = "Dinner at six. I'll get you.";

class FakeGps {
  simulated = false;
  plugged = true;
  reading: { status: "fix"; latitude: number; longitude: number } | { status: "no_fix" | "no_rmc" } = FIX;
  connected() {
    return this.plugged;
  }
  setEnabled() {}
  track() {}
  current() {
    return null;
  }
  onDemand() {
    return Promise.resolve(this.reading);
  }
  stop() {}
}

function lookups() {
  return {
    weather: vi.fn<NonNullable<ServiceDeps["lookups"]>["weather"]>(() => Promise.resolve(WEATHER)),
    place: vi.fn<NonNullable<ServiceDeps["lookups"]>["place"]>(() => Promise.resolve(PLACE)),
  };
}

/** The whole service with the screen attached, a page "connected" (`page.connected`), fake GPS and lookups. */
function showHarness(options: { gps?: boolean; tof?: boolean; page?: boolean } = {}) {
  const gps = new FakeGps();
  const looks = lookups();
  const h = makeHarness({ withHand: true, withTof: options.tof ?? false, ...(options.gps === false ? {} : { location: gps }), lookups: looks });
  const states: ScreenState[] = [];
  const cards: ShowCard[] = [];
  h.bus.on("show", ({ card }) => cards.push(card));
  const attached = attachScreen({ bus: h.bus, clock: h.clock, log: h.log, service: h.service, modules: h.modules, simulator: true, settings, localTime: () => null, onState: (s) => states.push(s) });
  const page = { connected: options.page ?? true };
  h.service.setScreen({ connected: () => page.connected });
  const start = h.service.start.bind(h.service);
  h.service.start = () => {
    start();
    seedScreen(attached.machine, h.service);
  };
  const names = () => states.map((s) => s.screen.state).filter((n, i, all) => n !== all[i - 1]);
  return Object.assign(h, { gps, looks, states, cards, page, names, machine: attached.machine });
}
type ShowHarness = ReturnType<typeof showHarness>;

async function talk(h: Harness): Promise<void> {
  h.press("talk", "pressed");
  await h.clock.advance(1500);
  h.press("talk", "released");
  await flush();
  await h.clock.advance(0);
}

const requests = (h: Harness): DeviceTurnRequest[] => h.device()!.turnRequests;
/** The result text the walker sent back for its last tool call. */
const result = (h: Harness) => requests(h).at(-1)!.tool_results!.at(-1)!;

async function ask(h: ShowHarness, view: ShowCard["view"]): Promise<void> {
  h.fake.queueShow(view);
  await talk(h);
}

describe("SH1: the turn request says what the walker can show, only while a page is connected", () => {
  it("no page: no screen field, first step or continuation", async () => {
    const h = showHarness({ page: false });
    await boot(h);
    h.fake.queueShow("weather");
    await talk(h);
    expect(requests(h)).toHaveLength(1);
    expect(requests(h)[0]).not.toHaveProperty("screen");
    // The fake cloud, like the server, only asks for a view the walker listed.
    expect(h.spoken("reply")).toEqual(["Fake cloud: this walker didn't offer the weather view, so I can't show it."]);
    expect(h.cards).toEqual([]);
  });

  it("a page and nothing else: parts only", async () => {
    const h = showHarness({ gps: false });
    await boot(h);
    await talk(h);
    expect(requests(h)[0]!.screen).toEqual({ views: ["parts"] });
  });

  it("GPS, obstacle sensors and a held message: every view, in order, on the first step and the continuation", async () => {
    const h = showHarness({ tof: true });
    h.fake.sendFromCaretaker(h.device()!.deviceId, "Maya", MESSAGE_WORDS);
    await boot(h);
    await h.clock.advance(0);
    await ask(h, "parts");
    const all = ["weather", "location", "sensors", "message", "parts"];
    expect(requests(h).map((r) => r.screen?.views)).toEqual([all, all]);
    expect(requests(h)[1]!.tool_results).toBeDefined();
  });

  it("the GPS unplugged: no weather or location; the page closed: no field", async () => {
    const h = showHarness();
    await boot(h);
    h.gps.plugged = false;
    await talk(h);
    expect(requests(h).at(-1)!.screen).toEqual({ views: ["parts"] });
    h.page.connected = false;
    await talk(h);
    expect(requests(h).at(-1)).not.toHaveProperty("screen");
  });
});

describe("SH2: weather", () => {
  it("one fix, the same lookup as get_weather; the card's values and the GPS's simulated flag; get_weather's sentence after the prefix", async () => {
    const h = showHarness();
    h.gps.simulated = true;
    await boot(h);
    await ask(h, "weather");
    expect(h.looks.weather).toHaveBeenCalledTimes(1);
    expect(h.looks.weather.mock.calls[0]!.slice(0, 2)).toEqual([FIX.latitude, FIX.longitude]);
    expect(h.cards).toEqual([{ view: "weather", temperature_f: 64, conditions: "partly cloudy skies", wind_mph: 8, simulated: true }]);
    expect(result(h)).toEqual({ name: "show_on_screen", text: `Showing the weather on the screen: ${WEATHER.text}` });
    expect(h.spoken("reply")).toEqual(["Fake cloud: putting that on your screen.", `Fake cloud: Showing the weather on the screen: ${WEATHER.text}`]);
  });

  it("get_weather says exactly what it said before; the provider's values come back as numbers", async () => {
    const body = { current: { temperature_2m: 63.6, weather_code: 2, wind_speed_10m: 7.7 } };
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))));
    const signal = new AbortController().signal;
    expect(await describeCurrentWeather(37.8, -122.2, signal)).toBe(
      "The latest weather estimate near you is 64 degrees Fahrenheit with partly cloudy skies and wind around 8 miles per hour. Weather data from Open-Meteo.",
    );
    expect(await currentWeather(37.8, -122.2, signal)).toMatchObject({ temperature_f: 64, conditions: "partly cloudy skies", wind_mph: 8 });
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SH3: location", () => {
  it("the cleaned address on the card, get_location's sentence in the result; no coordinates on the card, in the turn requests or the logs", async () => {
    const h = showHarness();
    await boot(h);
    await ask(h, "location");
    expect(h.cards).toEqual([{ view: "location", place: PLACE.place, simulated: false }]);
    expect(result(h).text).toBe(`Showing the nearest address on the screen: ${PLACE.text}`);
    const everywhere = JSON.stringify([h.cards, requests(h), h.log.lines]);
    expect(everywhere).not.toContain("37.809");
    expect(everywhere).not.toContain("122.258");
  });

  it("get_location's sentences are unchanged; the card's line is the venue and area, or the area alone when that is too long", async () => {
    const reply = (result: object) => vi.fn(() => Promise.resolve(new Response(JSON.stringify(result), { status: 200 })));
    const signal = new AbortController().signal;
    const near = { lat: "37.80913", lon: "-122.25871" };
    // A geocoder of its own per call (its own cache and limiter), on the real fetch the test stubs.
    const at = (url: string) => ({ services: mapServicesFromEnv({ WALKER_GEOCODER_URL: url }) });
    const address = { house_number: "600", road: "Bellevue Avenue", city: "Oakland", state: "California" };
    vi.stubGlobal("fetch", reply({ ...near, name: "Lakeside Park", category: "leisure", address }));
    expect(await describeGpsLocation(37.80913, -122.25871, signal, at("https://geo.example.test/a"))).toBe("Your GPS puts you near Lakeside Park, around 600 Bellevue Avenue, Oakland, California.");
    expect((await lookUpPlace(37.80913, -122.25871, signal, at("https://geo.example.test/b"))).place).toBe("Lakeside Park, 600 Bellevue Avenue, Oakland, California");
    const long = "A".repeat(90);
    vi.stubGlobal("fetch", reply({ ...near, name: long, category: "amenity", address }));
    expect((await lookUpPlace(37.80913, -122.25871, signal, at("https://geo.example.test/c"))).place).toBe("600 Bellevue Avenue, Oakland, California");
    vi.stubGlobal("fetch", reply({ lat: "38.5", lon: "-122.25871", address }));
    expect(await lookUpPlace(37.80913, -122.25871, signal, at("https://geo.example.test/d"))).toEqual({ text: "I have a GPS fix, but the map does not show a reliable nearby address.", place: null });
  });
});

describe("SH4: sensors", () => {
  it("every zone, measured (rounded to 10 mm) only when valid and fresh, unknown otherwise, each with its module's simulated flag", async () => {
    const h = showHarness({ tof: true });
    await boot(h);
    h.tof!.readings = { front_left: { mm: 423 }, front_right: "invalid" };
    await h.clock.advance(200);
    await ask(h, "sensors");
    expect(h.cards[0]).toEqual({
      view: "sensors",
      zones: [
        { zone: "front_left", distance: { status: "measured", mm: 420 }, simulated: true },
        { zone: "front_right", distance: { status: "unknown" }, simulated: true },
      ],
    });
    expect(result(h).text).toBe("Showing the obstacle sensors on the screen, kept current while it is up. Right now: front left 42 centimetres, front right unknown.");
  });

  it("a sensor that went quiet: its zones read unknown, never clear", async () => {
    const h = showHarness({ tof: true });
    await boot(h);
    await h.clock.advance(200);
    h.tof!.hang();
    await h.clock.advance(ZONE_VALIDITY_MS + 100);
    await ask(h, "sensors");
    const card = h.cards[0] as Extract<ShowCard, { view: "sensors" }>;
    expect(card.zones.map((z) => z.distance.status)).toEqual(["unknown", "unknown"]);
    expect(result(h).text).toContain("front left unknown, front right unknown");
  });
});

describe("SH5: the sensors card stays current", () => {
  const sensors: ShowCard = {
    view: "sensors",
    zones: [
      { zone: "front_left", distance: { status: "measured", mm: 800 }, simulated: true },
      { zone: "front_right", distance: { status: "measured", mm: 900 }, simulated: true },
    ],
  };
  const zone = (name: string, mm: number | null, at: number) => ({ zone: name, mm, quality: mm === null ? ("invalid" as const) : ("valid" as const), simulated: true, receivedMono: at });

  function machine() {
    const clock = new FakeClock();
    const states: ScreenState[] = [];
    const m = new ScreenMachine({ clock, simulator: true, settings, localTime: () => null, onState: (s) => states.push(s), onError: (e) => { throw e; } });
    const card = () => (states.at(-1)!.screen as Extract<ScreenState["screen"], { state: "showing" }>).card as Extract<ShowCard, { view: "sensors" }>;
    return { clock, m, states, card };
  }

  it("rebuilt from each reading at most every SCREEN_ZONES_MIN_MS; a steady reading sends nothing new", async () => {
    const { clock, m, states, card } = machine();
    m.seed({ link: "online" });
    m.zones([zone("front_left", 803, 0), zone("front_right", 899, 0)]);
    await flush();
    m.show(sensors);
    await flush();
    expect(card().zones.map((z) => z.distance)).toEqual([{ status: "measured", mm: 800 }, { status: "measured", mm: 900 }]);
    const before = states.length;
    for (let t = 100; t <= 1000; t += 100) {
      await clock.advance(100);
      m.zones([zone("front_left", 801, t), zone("front_right", 902, t)]);
    }
    await flush();
    expect(states.length).toBe(before); // rounds to the same 10 mm: no new revision
    await clock.advance(100);
    m.zones([zone("front_left", 600, 1100), zone("front_right", 902, 1100)]);
    await clock.advance(SCREEN_ZONES_MIN_MS);
    expect(card().zones[0]!.distance).toEqual({ status: "measured", mm: 600 });
    expect(states.length).toBe(before + 1);
    expect(states.every((s) => ScreenStateSchema.safeParse(s).success)).toBe(true);
  });

  it("a zone a reading leaves out stays as unknown; with no reading at all, every zone turns unknown at ZONE_VALIDITY_MS", async () => {
    const { clock, m, card } = machine();
    m.seed({ link: "online" });
    m.zones([zone("front_left", 800, 0), zone("front_right", 900, 0)]);
    m.show(sensors);
    await flush();
    await clock.advance(SCREEN_ZONES_MIN_MS);
    m.zones([zone("front_left", 700, SCREEN_ZONES_MIN_MS)]);
    await clock.advance(SCREEN_ZONES_MIN_MS);
    expect(card().zones).toEqual([
      { zone: "front_left", distance: { status: "measured", mm: 700 }, simulated: true },
      { zone: "front_right", distance: { status: "unknown" }, simulated: true },
    ]);
    // No reading since SCREEN_ZONES_MIN_MS: front_left stops counting ZONE_VALIDITY_MS after it.
    await clock.advance(ZONE_VALIDITY_MS - SCREEN_ZONES_MIN_MS - 1);
    expect(card().zones[0]!.distance.status).toBe("measured");
    await clock.advance(1);
    expect(card().zones.map((z) => z.distance.status)).toEqual(["unknown", "unknown"]);
  });
});

describe("SH6: message", () => {
  it("the newest message on the card; the result names the sender only; its words never reach a turn request, a heartbeat or a log line", async () => {
    const h = showHarness();
    await boot(h);
    h.fake.sendFromCaretaker(h.device()!.deviceId, "Maya", MESSAGE_WORDS);
    await h.clock.advance(5000); // the next heartbeat, then the fetch: it is read aloud
    expect(h.spoken("message")).toEqual([`Message from Maya. ${MESSAGE_WORDS}`]);
    await ask(h, "message");
    const message = h.device()!.messages[0]!;
    expect(h.cards).toEqual([{ view: "message", message_id: message.message_id, from_name: "Maya", text: MESSAGE_WORDS }]);
    expect(result(h).text).toBe("Showing the newest message, from Maya, on the screen.");
    const sent = JSON.stringify([requests(h), h.device()!.lastHeartbeat, h.device()!.events]);
    expect(sent).not.toContain("Dinner");
    // The simulator's harness logs replies in full; the walker's own log lines still never carry the words.
    expect(h.log.lines.filter((l) => !l.startsWith("info speak")).join("\n")).not.toContain("Dinner");
  });
});

describe("SH7: parts", () => {
  it("the manifest's parts with their own health and simulated flags; the result counts them", async () => {
    const h = showHarness({ tof: true });
    await boot(h);
    await ask(h, "parts");
    const manifest = h.service.manifest();
    const card = h.cards[0] as Extract<ShowCard, { view: "parts" }>;
    expect(card.parts).toEqual(manifest.modules.map((m) => ({ module_id: m.module_id, health: m.health, simulated: m.simulated })));
    expect(card.parts.find((p) => p.module_id === "location.gps")).toEqual({ module_id: "location.gps", health: "ok", simulated: false });
    const simulated = card.parts.filter((p) => p.simulated).length;
    expect(result(h).text).toBe(`Showing the walker's parts on the screen: ${card.parts.length} parts, all ok, ${simulated} simulated.`);
  });
});

describe("SH8: a view that can't be filled shows nothing and says why", () => {
  const cases: Array<[string, (h: ShowHarness) => void, ShowCard["view"], string]> = [
    ["no GPS receiver", (h) => (h.gps.plugged = false), "weather", "I can't check weather near you because the GPS receiver is not connected."],
    ["no fix", (h) => (h.gps.reading = { status: "no_fix" }), "location", "The GPS receiver has no satellite fix yet. Try again outdoors with a view of the sky."],
    ["the weather lookup fails", (h) => h.looks.weather.mockRejectedValue(new Error("Weather HTTP 503.")), "weather", "I couldn't check the weather right now."],
    ["the address lookup fails", (h) => h.looks.place.mockRejectedValue(new Error("Geocoder HTTP 503.")), "location", "I found the GPS receiver, but couldn't look up an address right now."],
    ["no reliable address", (h) => h.looks.place.mockResolvedValue({ text: "I have a GPS fix, but the map does not show a reliable nearby address.", place: null }), "location", "I have a GPS fix, but the map does not show a reliable nearby address."],
    ["no zone heard yet", () => {}, "sensors", "The obstacle sensors haven't reported any zone yet."],
    ["no message held", () => {}, "message", "The walker holds no message from a caretaker."],
  ];
  for (const [what, arrange, view, why] of cases) {
    it(`${what}: nothing shown, the result says why, the turn goes on`, async () => {
      const h = showHarness();
      await boot(h);
      arrange(h);
      // Some of these views aren't listed then (no GPS, no sensors, no message): the fake asks anyway, as a
      // confused server might, so the walker's own check is what is tested.
      h.fake.script.unshift({ show: view, ignoreViews: true });
      await talk(h);
      expect(requests(h)).toHaveLength(2);
      expect(result(h)).toEqual({ name: "show_on_screen", text: `${NOTHING_SHOWN} ${why}` });
      expect(h.cards).toEqual([]);
      expect(h.names()).not.toContain("showing");
      expect(h.spoken("reply").at(-1)).toBe(`Fake cloud: ${NOTHING_SHOWN} ${why}`);
    });
  }

  it("the page went while the lookup ran: nothing shown", async () => {
    const h = showHarness();
    await boot(h);
    h.looks.weather.mockImplementation(async () => {
      h.page.connected = false;
      return WEATHER;
    });
    await ask(h, "weather");
    expect(result(h).text).toBe(`${NOTHING_SHOWN} The walker's screen isn't connected.`);
    expect(h.cards).toEqual([]);
  });
});

describe("SH9: one log line per show, with the view, whether it was shown and the time only", () => {
  it("never the card's contents or a provider's error", async () => {
    const h = showHarness();
    await boot(h);
    await ask(h, "weather");
    h.looks.place.mockRejectedValue(new Error("Geocoder HTTP 503."));
    await ask(h, "location");
    const lines = h.log.lines.filter((l) => l.includes("show_on_screen"));
    expect(lines).toEqual(['info show_on_screen view="weather" shown=true ms=0', 'info show_on_screen view="location" shown=false ms=0']);
    const walkerLines = h.log.lines.filter((l) => !l.startsWith("info speak")).join("\n");
    expect(walkerLines).not.toMatch(/partly cloudy|Geocoder|Bellevue/);
  });
});

describe("SH10: where the card sits", () => {
  const card: ShowCard = { view: "weather", temperature_f: 64, conditions: "partly cloudy skies", wind_mph: 8, simulated: false };
  const base: ScreenModel = { link: "online", talk: "idle", alerts: ["vibration"], offer: null, answer: null, done: null, obstacle: null, motion: null, motionEnded: null, message: null, showing: null, navigation: null, help: null };
  const showing = { card, shownMono: 0, zones: null };
  const name = (model: Partial<ScreenModel>, now = 0) => pickScreen({ ...base, showing, ...model }, now, settings).content.state;

  it("under the obstacle and listening; over thinking, answering, the offer, Done, a message and the clock", () => {
    const obstacle = { zone: "front_left", mm: 300, simulated: true, lastNearMono: 0, near: true };
    const answer = { id: 1, heard: null, reply: "Fake cloud: it's up.", source: "fixed" as const, startedMono: 0, spokenMono: null };
    const offer = { proposal_id: "11111111-1111-4111-8111-111111111111", from_cues: ["vibration" as const], cues: ["sound" as const] };
    const done = { result: { kind: "nothing_changed" as const }, untilMono: 5000 };
    const message = { id: 1, message_id: "22222222-2222-4222-8222-222222222222", from_name: "Maya", text: MESSAGE_WORDS, spokenMono: null };
    expect(name({ obstacle, talk: "recording" })).toBe("obstacle");
    expect(name({ obstacle })).toBe("obstacle");
    expect(name({ talk: "recording" })).toBe("listening");
    expect(name({ talk: "waiting", answer, offer, done, message, link: "offline" })).toBe("showing");
    expect(name({ answer, offer, done, message })).toBe("showing");
    expect(name({}, SCREEN_SHOW_MS - 1)).toBe("showing");
    expect(name({}, SCREEN_SHOW_MS)).toBe("ambient");
    expect(name({ talk: "waiting" }, SCREEN_SHOW_MS)).toBe("thinking");
    expect(pickScreen({ ...base, showing }, 0, settings).content).toEqual({ state: "showing", card, caption: null });
  });

  it("never over help: an open request or the countdown keeps the screen, and the card comes back while its time lasts", () => {
    const open = { state: "help" as const, help: { phase: "open" as const, sent_to: ["Maya"], shown_to: [], coming: ["Maya"], confirm_okay: false } };
    expect(name({ help: open })).toBe("help");
    expect(name({ help: { state: "help_countdown", seconds_left: 8 } })).toBe("help_countdown");
    expect(name({ help: open, talk: "recording" })).toBe("listening");
    expect(name({ help: null }, SCREEN_SHOW_MS - 1)).toBe("showing");
  });

  it("an obstacle covers the card, which comes back underneath while its time lasts", async () => {
    const clock = new FakeClock();
    const states: ScreenState[] = [];
    const m = new ScreenMachine({ clock, simulator: true, settings, localTime: () => null, onState: (s) => states.push(s), onError: (e) => { throw e; } });
    m.seed({ link: "online" });
    await flush();
    m.show(card);
    await flush();
    m.zones([{ zone: "front_left", mm: 300, quality: "valid", simulated: true }]);
    await flush();
    m.zones([{ zone: "front_left", mm: 1500, quality: "valid", simulated: true }]);
    await clock.advance(2000);
    expect(states.map((s) => s.screen.state)).toEqual(["ambient", "showing", "obstacle", "showing"]);
  });
});

describe("SH11: the answer's caption page rides under the card", () => {
  const card: ShowCard = { view: "parts", parts: [{ module_id: "base.walker", health: "ok", simulated: true }] };
  const reply = "Fake cloud: it's on your screen now. The real assistant isn't connected in this run, so this reply says so on every page it has.";

  it("paged by showingCaptionPages (75 characters at every size), turning on those pages' clock, through the hold; null when captions are off", async () => {
    const pages = showingCaptionPages(reply);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages.every((p) => [...p].length <= SHOWING_CAPTION_CHARS)).toBe(true);
    const clock = new FakeClock();
    const states: ScreenState[] = [];
    const m = new ScreenMachine({ clock, simulator: true, settings, localTime: () => null, onState: (s) => states.push(s), onError: (e) => { throw e; } });
    m.seed({ link: "online" });
    m.show(card);
    m.answer({ id: 1, heard: "show me", reply, source: "model" });
    await flush();
    const caption = () => (states.at(-1)!.screen as Extract<ScreenState["screen"], { state: "showing" }>).caption;
    expect(caption()).toBe(pages[0]);
    await clock.advance(pageMs(pages[0]!));
    expect(caption()).toBe(pages[1]);
    m.answerSpoken(1);
    const total = pages.reduce((sum, p) => sum + pageMs(p), 0);
    await clock.advance(total - pageMs(pages[0]!) + SCREEN_ANSWER_HOLD_MS - 1);
    expect(caption()).toBe(pages.at(-1));
    await clock.advance(1);
    expect(caption()).toBeNull();
    expect(states.at(-1)!.screen.state).toBe("showing");

    const off = pickScreen(
      { link: "online", talk: "idle", alerts: null, offer: null, answer: { id: 2, heard: null, reply, source: "model", startedMono: 0, spokenMono: null }, done: null, obstacle: null, motion: null, motionEnded: null, message: null, showing: { card, shownMono: 0, zones: null }, navigation: null, help: null },
      0,
      { ...settings, captions: false },
    );
    expect(off.content).toEqual({ state: "showing", card, caption: null });
  });
});

describe("SH12: when the card goes", () => {
  const weather: ShowCard = { view: "weather", temperature_f: 64, conditions: "partly cloudy skies", wind_mph: 8, simulated: false };
  const parts: ShowCard = { view: "parts", parts: [{ module_id: "base.walker", health: "ok", simulated: true }] };

  function machine() {
    const clock = new FakeClock();
    const states: ScreenState[] = [];
    const m = new ScreenMachine({ clock, simulator: true, settings, localTime: () => null, onState: (s) => states.push(s), onError: (e) => { throw e; } });
    m.seed({ link: "online" });
    return { clock, m, states, last: () => states.at(-1)!.screen };
  }

  async function seeded() {
    const made = machine();
    await flush();
    return made;
  }

  it("SCREEN_SHOW_MS after the answer finished playing", async () => {
    const { clock, m, last } = machine();
    m.answer({ id: 1, heard: null, reply: "Putting that on your screen.", source: "fixed" });
    m.show(weather);
    await clock.advance(10_000); // still playing: no end yet
    expect(last().state).toBe("showing");
    m.answerSpoken(1);
    await clock.advance(SCREEN_SHOW_MS - 1);
    expect(last().state).toBe("showing");
    await clock.advance(1);
    expect(last().state).toBe("ambient");
  });

  it("SCREEN_SHOW_MS after it was drawn when no answer was playing; a later answer never brings it back", async () => {
    const { clock, m, states, last } = machine();
    m.show(weather);
    await clock.advance(SCREEN_SHOW_MS);
    expect(last().state).toBe("ambient");
    m.answer({ id: 1, heard: null, reply: "Fake cloud: later.", source: "fixed" });
    await flush();
    expect(last().state).toBe("answering");
    expect(states.filter((s) => s.screen.state === "showing")).toHaveLength(1);
  });

  it("a Talk press ends it at once; a newer card replaces it", async () => {
    const { clock, m, states, last } = await seeded();
    m.show(weather);
    await flush();
    m.show(parts);
    await flush();
    expect(last()).toMatchObject({ state: "showing", card: parts });
    m.talk("recording");
    await flush();
    expect(last().state).toBe("listening");
    m.talk("idle");
    await clock.advance(0);
    expect(last().state).toBe("ambient");
    expect(states.map((s) => s.screen.state)).toEqual(["ambient", "showing", "showing", "listening", "ambient"]);
  });

  it("on the whole service: the answer is captioned under the card, then it goes 30 s after; a Talk press during it ends it", async () => {
    const h = showHarness();
    await boot(h);
    await ask(h, "weather");
    expect(h.names()).toEqual(["ambient", "listening", "thinking", "showing"]);
    const shown = h.states.filter((s) => s.screen.state === "showing").map((s) => (s.screen as Extract<ScreenState["screen"], { state: "showing" }>).caption);
    expect(shown.at(-1)).toContain("Fake cloud: Showing the weather");
    await h.clock.advance(SCREEN_SHOW_MS - 1);
    expect(h.names().at(-1)).toBe("showing");
    await h.clock.advance(1);
    expect(h.names().at(-1)).toBe("ambient");
    await ask(h, "parts");
    expect(h.names().at(-1)).toBe("showing");
    h.press("talk", "pressed");
    await flush();
    expect(h.names().at(-1)).toBe("listening");
    expect(h.states.every((s) => ScreenStateSchema.safeParse(s).success)).toBe(true);
  });
});

describe("SH13: the fake cloud and the simulator's script", () => {
  it("every card the walker built passes the contract", async () => {
    const h = showHarness({ tof: true });
    h.fake.sendFromCaretaker(h.device()!.deviceId, "Maya", MESSAGE_WORDS);
    await boot(h);
    await h.clock.advance(200);
    for (const view of ["weather", "location", "sensors", "message", "parts"] as const) await ask(h, view);
    expect(h.cards.map((c) => c.view)).toEqual(["weather", "location", "sensors", "message", "parts"]);
    expect(h.cards.every((c) => ShowCardSchema.safeParse(c).success)).toBe(true);
  });

  it("test/sim/show-weather.walk passes on a fake clock", async () => {
    const h = showHarness();
    h.gps.simulated = true;
    h.looks.weather.mockResolvedValue({ text: "Simulated weather, not a real forecast: 64 degrees Fahrenheit with partly cloudy skies and wind around 8 miles per hour.", temperature_f: 64, conditions: "partly cloudy skies", wind_mph: 8 });
    const runner = new ScriptRunner(h.bus);
    const steps = parseScript(readFileSync(join(__dirname, "sim", "show-weather.walk"), "utf8"));
    h.service.start();
    const press = (key: string) => {
      if (key === "t") h.bus.emit("button", { button: "talk", edge: "pressed", source: "keyboard" });
      else if (key.startsWith("show-")) h.fake.queueShow(key.slice(5) as ShowCard["view"]);
      else if (key !== "q") throw new Error(`unknown key ${key}`);
    };
    const report: string[] = [];
    const failure = await runner.run(steps, press, (line) => report.push(line), (ms) => h.clock.advance(ms));
    expect(failure, report.join("\n")).toBeNull();
    expect(h.cards).toEqual([{ view: "weather", temperature_f: 64, conditions: "partly cloudy skies", wind_mph: 8, simulated: true }]);
  }, 60_000);
});
