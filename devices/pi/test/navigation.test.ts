import { describe, expect, it } from "vitest";
import {
  InstructionSchema,
  ManeuverSchema,
  NavigatingScreenSchema,
  type LatLon,
  type NavigatingScreen,
} from "@walker/contracts";
import { DeadlineError } from "../src/clock";
import { describeGpsLocation } from "../src/location";
import { metresBetween, offsetPoint, bearing, pointAlong, polyline } from "../src/navigation/geo";
import { NAV_LINES, Navigator, type GuidanceLine } from "../src/navigation/navigator";
import { getMapJson, injectedMapServices, mapServicesFromEnv, OSM_USER_AGENT, type MapFetch } from "../src/navigation/osm";
import { findPlace, placeFromSearch, type Place } from "../src/navigation/places";
import { parseRoute, planRoute, stepWords, tooFarLine, type Route, type RouteOutcome } from "../src/navigation/route";
import { recordedMapFetch, recordedRouteFrom } from "../src/sim/fakeMaps";
import routeFixture from "./fixtures/navigation/osrm-foot-to-boating-center.json";
import searchFixture from "./fixtures/navigation/nominatim-search-boating-center.json";
import { FakeClock, captureLogger, flush } from "./support/fakes";

/**
 * Rows N1 to N16 of test/EXPECTED.md ("Walking directions"): the map services, the route and the Navigator, on a
 * fake clock with the responses recorded in test/fixtures/navigation/. No test touches the network.
 */

const START: LatLon = [37.8098, -122.2575];
const PLACE: Place = { name: "Lake Merritt Boating Center", spoken: "the Lake Merritt Boating Center", at: [37.8051227, -122.2578778] };

const json = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

function recordedRoute(): Route {
  const outcome = parseRoute(routeFixture, PLACE);
  if (outcome.kind !== "ok") throw new Error("the recorded route didn't parse");
  return outcome.route;
}

/** Every line any test here built, checked once at the end for "clear" and "safe". */
const everyLine: string[] = [];

describe("map services (N1 to N7)", () => {
  it("N1: a search near her is bounded to about 5 km, identified, and gives the Boating Center", async () => {
    const clock = new FakeClock();
    const asked: Array<{ url: URL; init: RequestInit }> = [];
    const services = injectedMapServices(clock, (url, init) => {
      asked.push({ url, init });
      return Promise.resolve(json(searchFixture));
    });
    const place = await findPlace(services, "Lake Merritt Boating Center", START, new AbortController().signal);
    expect(place).toEqual({ name: "Lake Merritt Boating Center", spoken: "the Lake Merritt Boating Center", at: [37.8051227, -122.2578778] });
    expect(asked).toHaveLength(1);
    const url = asked[0]!.url;
    expect(url.origin + url.pathname).toBe("https://nominatim.openstreetmap.org/search");
    expect(url.searchParams.get("q")).toBe("Lake Merritt Boating Center");
    expect(url.searchParams.get("format")).toBe("jsonv2");
    expect(url.searchParams.get("bounded")).toBe("1");
    const [west, north, east, south] = url.searchParams.get("viewbox")!.split(",").map(Number) as [number, number, number, number];
    expect(metresBetween([north, START[1]], START)).toBeGreaterThan(4900);
    expect(metresBetween([north, START[1]], START)).toBeLessThan(5100);
    expect(metresBetween([START[0], west], START)).toBeGreaterThan(4900);
    expect(metresBetween([START[0], east], START)).toBeLessThan(5100);
    expect(south).toBeLessThan(START[0]);
    expect((asked[0]!.init.headers as Record<string, string>)["user-agent"]).toBe(OSM_USER_AGENT);
    // Nothing found, and names cleaned like the reverse geocoder's.
    expect(placeFromSearch([])).toBeNull();
    expect(placeFromSearch([{ lat: "37.8", lon: "-122.2", category: "amenity", name: "Caf\u0007e <b>Rose</b>" }])?.name).toBe("Caf e b Rose /b");
    expect(placeFromSearch([{ lat: "37.8", lon: "-122.2", category: "amenity", name: "x".repeat(101), address: { house_number: "600", road: "Bellevue Avenue" } }])).toEqual({
      name: "600 Bellevue Avenue",
      spoken: "600 Bellevue Avenue",
      at: [37.8, -122.2],
    });
  });

  it("N2: a search and a reverse lookup share one Nominatim limiter", async () => {
    const clock = new FakeClock();
    const at: number[] = [];
    const services = injectedMapServices(clock, (url, init) => {
      at.push(clock.monotonic());
      return recordedMapFetch(url, init);
    });
    const signal = new AbortController().signal;
    const search = findPlace(services, "Lake Merritt Boating Center", START, signal);
    const reverse = describeGpsLocation(START[0], START[1], signal, { services });
    await clock.advance(2000);
    await Promise.all([search, reverse]);
    expect(at).toHaveLength(2);
    expect(at[1]! - at[0]!).toBeGreaterThanOrEqual(1100);
  });

  it("N3: the real fetch only goes to HTTPS URLs without a user name; an injected one may use any", async () => {
    let calls = 0;
    const counting: MapFetch = () => {
      calls += 1;
      return Promise.resolve(json([]));
    };
    const signal = new AbortController().signal;
    for (const bad of ["http://maps.example.test/search", "https://user:pass@maps.example.test/search"]) {
      const services = { ...mapServicesFromEnv({ WALKER_PLACES_URL: bad }, new FakeClock()), fetch: counting };
      await expect(findPlace(services, "Lake Merritt", START, signal)).rejects.toThrow("Map services must use HTTPS.");
    }
    expect(calls).toBe(0);
    const injected = { ...injectedMapServices(new FakeClock(), counting), placesUrl: "http://127.0.0.1:1/search" };
    await expect(findPlace(injected, "Lake Merritt", START, signal)).resolves.toBeNull();
    expect(calls).toBe(1);
  });

  it("N4: the recorded route: 773 m, 75 points, 14 steps folded to 12, words built on the Pi", () => {
    const route = recordedRoute();
    expect(route.length).toBeGreaterThan(765);
    expect(route.length).toBeLessThan(781);
    expect(route.line.points).toHaveLength(75);
    expect(routeFixture.routes[0]!.legs[0]!.steps).toHaveLength(14);
    expect(route.steps.map((s) => s.instruction)).toEqual([
      "Head west on the path.",
      "Turn left onto Lenox Avenue.",
      "Turn left onto the path.",
      "Turn left onto the path.",
      "Turn right onto the path.",
      "Turn right onto the path.",
      "Turn left onto the path.",
      "Turn right onto the path.",
      "Continue straight onto the path.",
      "Turn right onto the path.",
      "Turn left onto the path.",
      "Arrive near the Lake Merritt Boating Center.",
    ]);
    expect(route.steps.map((s) => s.maneuver)).toEqual(["straight", "left", "left", "left", "right", "right", "left", "right", "straight", "right", "left", "arrive"]);
    expect(route.steps.map((s) => s.street)).toEqual([null, "Lenox Avenue", null, null, null, null, null, null, null, null, null, null]);
    expect(route.steps.map((s) => s.action).slice(0, 3)).toEqual(["head west", "turn left", "turn left"]);
    // In order along the route, the arrival at its end; no two steps under 10 m apart.
    for (let i = 1; i < route.steps.length; i += 1) expect(route.steps[i]!.along - route.steps[i - 1]!.along).toBeGreaterThanOrEqual(10);
    expect(route.steps.at(-1)!.along).toBe(route.length);
    everyLine.push(...route.steps.map((s) => s.instruction));
  });

  it("N5: every OSRM maneuver type and modifier has words and a contract maneuver, and none says clear or safe", () => {
    const types = ["depart", "arrive", "turn", "new name", "continue", "end of road", "fork", "merge", "on ramp", "off ramp", "roundabout", "rotary", "roundabout turn", "exit roundabout", "exit rotary", "notification", "use lane", "something new"];
    const modifiers = [undefined, "left", "right", "slight left", "slight right", "sharp left", "sharp right", "straight", "uturn"];
    for (const type of types) {
      for (const modifier of modifiers) {
        for (const street of [null, "Lenox Avenue", "A".repeat(60)]) {
          const words = stepWords(type, modifier, street, 291, PLACE);
          expect(ManeuverSchema.safeParse(words.maneuver).success).toBe(true);
          expect(InstructionSchema.safeParse(words.instruction).success, words.instruction).toBe(true);
          expect(words.action.length).toBeGreaterThan(0);
          everyLine.push(words.instruction, words.action);
        }
      }
    }
    expect(stepWords("fork", "slight left", "Grand Avenue", 0, PLACE).instruction).toBe("Keep left onto Grand Avenue.");
    expect(stepWords("turn", "uturn", null, 0, PLACE).instruction).toBe("Turn around and continue on the path.");
    expect(stepWords("turn", "sharp right", null, 0, PLACE).instruction).toBe("Turn sharp right onto the path.");
    expect(stepWords("new name", "straight", "Grand Avenue", 0, PLACE).instruction).toBe("Continue onto Grand Avenue.");
    expect(stepWords("depart", "straight", null, 180, PLACE).instruction).toBe("Head south on the path.");
  });

  it("N6: too far, by the route or in a straight line (then the router is never asked)", async () => {
    expect(tooFarLine(7000)).toBe("That's about 7 kilometers, farther than I can guide on foot.");
    expect(tooFarLine(5_440)).toBe("That's about 5.4 kilometers, farther than I can guide on foot.");
    let calls = 0;
    const services = injectedMapServices(new FakeClock(), (url, init) => {
      calls += 1;
      return recordedMapFetch(url, init);
    });
    const far: LatLon = [37.9, -122.2575];
    const outcome = await planRoute(services, far, PLACE, new AbortController().signal);
    expect(outcome.kind).toBe("too_far");
    expect(calls).toBe(0);
    // A route over 5 km (two points 6 km apart).
    const long = { code: "Ok", routes: [{ geometry: { coordinates: [[-122.2575, 37.8098], [-122.2575, 37.8638]] }, legs: [{ steps: [] }] }] };
    const parsed = parseRoute(long, PLACE);
    expect(parsed.kind).toBe("too_far");
    expect(parsed.kind === "too_far" && Math.round(parsed.metres / 100)).toBe(60);
  });

  it("N7: oversized, slow, not JSON, an HTTP error, or a refusal is an error; NoRoute is no route", async () => {
    const clock = new FakeClock();
    const signal = new AbortController().signal;
    const url = new URL("https://routing.openstreetmap.de/routed-foot/route/v1/foot/1,2;3,4");
    const big = injectedMapServices(clock, () => Promise.resolve(json("x".repeat(64 * 1024 + 1))));
    await expect(getMapJson(big, url, { nominatim: false, signal })).rejects.toThrow("Map response too large.");
    const slow = injectedMapServices(clock, () => new Promise(() => {}));
    const pending = getMapJson(slow, url, { nominatim: false, signal });
    const caught = pending.catch((error: unknown) => error);
    await clock.advance(5_999);
    await clock.advance(1);
    expect(await caught).toBeInstanceOf(DeadlineError);
    await expect(getMapJson(injectedMapServices(clock, () => Promise.resolve(json("<html>"))), url, { nominatim: false, signal })).rejects.toThrow("other than JSON");
    await expect(getMapJson(injectedMapServices(clock, () => Promise.resolve(json({}, 502))), url, { nominatim: false, signal })).rejects.toThrow("HTTP 502");
    expect(() => parseRoute({ code: "InvalidQuery" }, PLACE)).toThrow();
    expect(parseRoute({ code: "NoRoute", routes: [] }, PLACE)).toEqual({ kind: "none" });
    expect(parseRoute({ code: "Ok", routes: [] }, PLACE)).toEqual({ kind: "none" });
  });
});

// ---- The Navigator ----

function makeNavigator(options: { replan?: (from: LatLon) => Promise<RouteOutcome> } = {}) {
  const clock = new FakeClock();
  const log = captureLogger();
  const lines: GuidanceLine[] = [];
  const views: Array<NavigatingScreen | null> = [];
  const routes: Array<Route | null> = [];
  const replans: LatLon[] = [];
  let here: LatLon | null = START;
  const navigator = new Navigator({
    clock,
    log,
    position: () => (here ? { latitude: here[0], longitude: here[1], age_ms: 0 } : null),
    simulated: true,
    replan: (from) => {
      replans.push(from);
      return options.replan ? options.replan(from) : Promise.resolve({ kind: "none" });
    },
    say: (line) => {
      lines.push(line);
      everyLine.push(line.text);
    },
    view: (view) => {
      if (view) expect(NavigatingScreenSchema.safeParse(view).success, JSON.stringify(NavigatingScreenSchema.safeParse(view).error?.issues[0])).toBe(true);
      views.push(view);
    },
    routeChanged: (route) => routes.push(route),
  });
  return {
    clock,
    log,
    navigator,
    lines,
    texts: () => lines.map((l) => l.text),
    views,
    routes,
    replans,
    move: (p: LatLon | null) => (here = p),
    /** One position, then a navigator tick. */
    at: async (p: LatLon | null) => {
      here = p;
      await clock.advance(1000);
    },
  };
}

/** Walks the recorded route in `stepM` steps, one per tick, until it ends or `until` metres. */
async function walk(n: ReturnType<typeof makeNavigator>, route: Route, stepM: number, from = 0, until = route.length) {
  for (let d = from; d <= until && n.navigator.active(); d += stepM) await n.at(pointAlong(route.line, d));
}

describe("the Navigator (N9 to N16)", () => {
  it("N9/N10: walking the route says each step once ahead and once at it, then the arrival", async () => {
    const n = makeNavigator();
    const route = recordedRoute();
    n.navigator.start(route, START);
    await walk(n, route, 3);
    const texts = n.texts();
    const ahead = texts.filter((t) => t.startsWith("In "));
    const now = texts.filter((t) => t.endsWith(" now."));
    // Steps 1 to 11 each heard once ahead (the arrival's is "you'll be near"), steps 1 to 10 once at the turn.
    expect(ahead).toHaveLength(11);
    expect(now).toHaveLength(10);
    expect(new Set(n.lines.filter((l) => l.kind === "ahead").map((l) => l.step))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]));
    expect(new Set(n.lines.filter((l) => l.kind === "now").map((l) => l.step))).toEqual(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
    expect(ahead[0]).toMatch(/^In (40|30) meters, turn left onto Lenox Avenue\.$/);
    expect(now[0]).toBe("Turn left now.");
    expect(ahead.at(-1)).toMatch(/^In \d+ meters, you'll be near the Lake Merritt Boating Center\.$/);
    expect(texts.filter((t) => t === "You've arrived near the Lake Merritt Boating Center.")).toHaveLength(1);
    // Distances fall as she walks.
    const guiding = n.views.filter((v): v is NavigatingScreen => v?.phase === "guiding");
    for (let i = 1; i < guiding.length; i += 1) expect(guiding[i]!.remaining_m).toBeLessThanOrEqual(guiding[i - 1]!.remaining_m);
    // The same position again says nothing more.
    const before = n.lines.length;
    await n.clock.advance(1000);
    expect(n.lines.length).toBe(before);
  });

  it("N9: a sample that jumps 30 m past a turn still says that turn once (progress, not a radius)", async () => {
    const n = makeNavigator();
    const route = recordedRoute();
    n.navigator.start(route, START);
    const turn = route.steps[1]!.along;
    await n.at(pointAlong(route.line, turn - 45));
    await n.at(pointAlong(route.line, turn + 30));
    await n.at(pointAlong(route.line, turn + 31));
    expect(n.texts().filter((t) => t === "Turn left now.")).toHaveLength(1);
    expect(n.navigator.summary()?.next).toBe("Turn left onto the path.");
  });

  it("N11: two positions off the route plan again from her position; at most every 20 s and 5 times a route", async () => {
    let fail = true;
    const n = makeNavigator({
      replan: (from) => {
        if (fail) return Promise.resolve({ kind: "none" });
        return Promise.resolve(parseRoute(recordedRouteFrom(from), PLACE));
      },
    });
    const route = recordedRoute();
    n.navigator.start(route, START);
    const onRoute = pointAlong(route.line, 20);
    const off = offsetPoint(onRoute, 50, bearing(route.line.points[0]!, route.line.points[1]!) + 90);
    await n.at(onRoute);
    await n.at(off);
    expect(n.replans).toHaveLength(0);
    expect(n.texts()).not.toContain(NAV_LINES.offRoute);
    await n.at(off);
    await flush();
    expect(n.replans).toHaveLength(1);
    expect(n.texts().filter((t) => t === NAV_LINES.offRoute)).toHaveLength(1);
    expect(n.texts().filter((t) => t === NAV_LINES.noWay)).toHaveLength(1);
    expect(n.navigator.summary()?.phase).toBe("off_route");
    // Within 20 s: no new plan; at the next window, another (silently).
    for (let i = 0; i < 18; i += 1) await n.at(off);
    expect(n.replans).toHaveLength(1);
    await n.at(off);
    await n.at(off);
    expect(n.replans).toHaveLength(2);
    // Five at most.
    for (let i = 0; i < 100; i += 1) await n.at(off);
    expect(n.replans).toHaveLength(5);
    expect(n.texts().filter((t) => t === NAV_LINES.offRoute || t === NAV_LINES.noWay)).toHaveLength(2);
    // A fresh route, a plan that works: the new first instruction, guiding again, from her position.
    fail = false;
    n.navigator.start(route, START);
    await n.at(onRoute);
    await n.at(off);
    await n.at(off);
    await flush();
    expect(n.replans.at(-1)).toEqual(off);
    expect(n.navigator.summary()?.phase).toBe("guiding");
    expect(n.texts().at(-1)).toMatch(/^Head (north|northeast|east|southeast|south|southwest|west|northwest) on the path\.$/);
    expect(n.routes.at(-1)?.line.points[0]).toEqual(off);
  });

  it("N11: back on the route while off, guidance carries on without a new plan", async () => {
    const n = makeNavigator({ replan: () => new Promise(() => {}) });
    const route = recordedRoute();
    n.navigator.start(route, START);
    const onRoute = pointAlong(route.line, 20);
    const off = offsetPoint(onRoute, 50, 0);
    await n.at(off);
    await n.at(off);
    expect(n.navigator.summary()?.phase).toBe("rerouting");
    await n.at(onRoute);
    expect(n.navigator.summary()?.phase).toBe("guiding");
  });

  it("N12: 15 s without a position says so once; guidance resumes when it returns", async () => {
    const n = makeNavigator();
    const route = recordedRoute();
    n.navigator.start(route, START);
    await n.at(pointAlong(route.line, 5));
    n.move(null);
    await n.clock.advance(13_000);
    expect(n.texts()).not.toContain(NAV_LINES.lost);
    await n.clock.advance(2_000);
    expect(n.texts().filter((t) => t === NAV_LINES.lost)).toHaveLength(1);
    expect(n.navigator.summary()).toMatchObject({ phase: "no_position", to_next_m: null });
    await n.clock.advance(30_000);
    expect(n.texts().filter((t) => t === NAV_LINES.lost)).toHaveLength(1);
    await n.at(pointAlong(route.line, 15));
    expect(n.navigator.summary()?.phase).toBe("guiding");
    expect(n.navigator.summary()?.to_next_m).not.toBeNull();
  });

  it("N13: within 15 m of the end she has arrived; 20 s later the route ends", async () => {
    const n = makeNavigator();
    const route = recordedRoute();
    n.navigator.start(route, START);
    await n.at(pointAlong(route.line, route.length - 20));
    expect(n.navigator.summary()?.phase).toBe("guiding");
    await n.at(pointAlong(route.line, route.length - 14));
    expect(n.texts().at(-1)).toBe("You've arrived near the Lake Merritt Boating Center.");
    expect(n.views.at(-1)).toMatchObject({ phase: "arrived", maneuver: "arrive", instruction: "You've arrived near the Lake Merritt Boating Center." });
    await n.clock.advance(19_000);
    expect(n.navigator.active()).toBe(true);
    await n.clock.advance(1_000);
    expect(n.navigator.active()).toBe(false);
    expect(n.views.at(-1)).toBeNull();
    expect(n.routes.at(-1)).toBeNull();
    expect(n.texts().filter((t) => t.startsWith("You've arrived"))).toHaveLength(1);
  });

  it("N14: the first line names the place, the distance, the first instruction and the source", () => {
    const n = makeNavigator();
    n.navigator.start(recordedRoute(), START);
    const intro = n.navigator.introLine()!;
    expect(intro.text).toBe(
      "Walking to the Lake Merritt Boating Center, about 750 meters. Head west on the path. Directions come from OpenStreetMap and may include steps or curbs.",
    );
    everyLine.push(intro.text);
  });

  it("N15: a line about a step she has passed, or from an ended route, is no longer due", async () => {
    const n = makeNavigator();
    const route = recordedRoute();
    n.navigator.start(route, START);
    await walk(n, route, 3, 0, route.steps[1]!.along - 30);
    const ahead = n.lines.find((l) => l.kind === "ahead")!;
    expect(n.navigator.due(ahead)).toBe(true);
    await n.at(pointAlong(route.line, route.steps[1]!.along + 2));
    const now = n.lines.find((l) => l.kind === "now")!;
    expect(n.navigator.due(ahead)).toBe(false);
    expect(n.navigator.due(now)).toBe(true);
    await walk(n, route, 3, route.steps[1]!.along + 3, route.steps[2]!.along + 2);
    expect(n.navigator.due(now)).toBe(false);
    const repeat = n.navigator.repeatLine()!;
    expect(n.navigator.due(repeat)).toBe(true);
    n.navigator.stop("test");
    expect(n.navigator.due(repeat)).toBe(false);
    expect(n.navigator.repeatLine()).toBeNull();
  });

  it("N16: the screen's view passes the contract, with at most 200 route points, and null at the end", async () => {
    const n = makeNavigator();
    // A 1 km straight route with a point every 2 m: 500 points, thinned for the screen.
    const points: LatLon[] = [];
    for (let i = 0; i <= 500; i += 1) points.push(offsetPoint(START, i * 2, 180));
    const line = polyline(points);
    const long: Route = {
      place: PLACE,
      line,
      length: line.cum.at(-1)!,
      steps: [
        { ...stepWords("depart", "straight", null, 180, PLACE), at: points[0]!, along: 0 },
        { ...stepWords("arrive", undefined, null, 0, PLACE), at: points.at(-1)!, along: line.cum.at(-1)! },
      ],
    };
    n.navigator.start(long, START);
    await n.at(points[10]!);
    const view = n.views.at(-1)!;
    expect(view.map.route.length).toBeLessThanOrEqual(200);
    expect(view.map.route[0]).toEqual(view.map.position && pointAlong(line, 20).map((x) => x));
    expect(view.map.route.at(-1)).toEqual(points.at(-1));
    expect(view.map.step_at).toBeNull();
    n.navigator.stop("test");
    expect(n.views.at(-1)).toBeNull();
  });
});

describe("words", () => {
  it("no line the Pi builds says clear or safe", () => {
    expect(everyLine.length).toBeGreaterThan(100);
    for (const line of everyLine) expect(line, line).not.toMatch(/\b(clear|safe)/i);
  });
});
