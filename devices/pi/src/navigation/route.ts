import type { LatLon, Maneuver } from "@walker/contracts";
import { ROUTE_MAX_M, STEP_FOLD_M, WALK_SPEED_MPS } from "../constants";
import { lengthOf, metresBetween, polyline, type Polyline } from "./geo";
import { cleanName, getMapJson, type MapServices } from "./osm";
import type { Place } from "./places";

/**
 * Planning a walking route with OSRM's foot profile (routing.openstreetmap.de by default) and turning it into the
 * walker's own steps. The words she hears are built here, on the Pi, from each maneuver's type and direction;
 * none is copied from the provider, and none says the way is clear or safe: directions are advice, she steers.
 */

/** One thing to do along the route. `at` and `along` stay on the Pi; the words reach the model and the screen. */
export interface RouteStep {
  maneuver: Maneuver;
  /** The way to walk onto; null when it has no name (said "the path"). */
  street: string | null;
  /** The whole sentence: "Turn left onto Lenox Avenue." */
  instruction: string;
  /** The same thing in a few words, for "Turn left now." */
  action: string;
  at: LatLon;
  /** Metres from the route's start to this step's point. */
  along: number;
}

export interface Route {
  place: Place;
  line: Polyline;
  length: number;
  /** The first is the departure ("Head west on the path."), the last is the arrival. */
  steps: RouteStep[];
}

export type RouteOutcome = { kind: "ok"; route: Route } | { kind: "too_far"; metres: number } | { kind: "none" };

// ---- Words ----

/** "40 meters", "1.2 kilometers": metres rounded to 10 below a kilometre. */
export function distanceWords(metres: number): string {
  if (metres < 1000) return `${Math.max(10, Math.round(metres / 10) * 10)} meters`;
  const km = Math.round(metres / 100) / 10;
  return km === 1 ? "1 kilometer" : `${km} kilometers`;
}

/** A route's length said roughly: "about 750 meters" (nearest 50 m below a kilometre). */
export function roughDistanceWords(metres: number): string {
  if (metres < 100) return distanceWords(metres);
  if (metres < 1000) return `${Math.round(metres / 50) * 50} meters`;
  return distanceWords(metres);
}

/** Minutes on foot at WALK_SPEED_MPS (at least 1 for any distance left). */
export function walkingMinutes(metres: number): number {
  return metres <= 0 ? 0 : Math.max(1, Math.round(metres / WALK_SPEED_MPS / 60));
}

export function minutesWords(minutes: number): string {
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** The fixed refusal for a route that is too long. */
export function tooFarLine(metres: number): string {
  const km = Math.round(metres / 100) / 10;
  return `That's about ${Number.isInteger(km) ? km : km.toFixed(1)} kilometers, farther than I can guide on foot.`;
}

const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"] as const;

function compass(degrees: number): string {
  return COMPASS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8]!;
}

const MODIFIERS: Record<string, Maneuver> = {
  left: "left",
  right: "right",
  "slight left": "slight_left",
  "slight right": "slight_right",
  "sharp left": "sharp_left",
  "sharp right": "sharp_right",
  straight: "straight",
  uturn: "u_turn",
};

/** "turn left", "bear right", "turn sharp left", "continue straight", "turn around". */
function turnAction(maneuver: Maneuver): string {
  switch (maneuver) {
    case "left":
    case "right":
      return `turn ${maneuver}`;
    case "slight_left":
    case "slight_right":
      return `bear ${maneuver.slice(7)}`;
    case "sharp_left":
    case "sharp_right":
      return `turn sharp ${maneuver.slice(6)}`;
    case "u_turn":
      return "turn around";
    case "straight":
    case "arrive":
      return "continue straight";
  }
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Keeps a sentence within the contract's 120 characters by dropping an over-long street name first. */
function fit(sentence: (way: string) => string, street: string | null): { text: string; street: string | null } {
  const named = sentence(street ?? "the path");
  return named.length <= 120 || street === null ? { text: named.slice(0, 120), street } : { text: sentence("the path"), street: null };
}

/**
 * The words for one OSRM maneuver: the sentence, the few-word action and the screen's `maneuver`. `type` and
 * `modifier` are OSRM's (https://project-osrm.org/docs/v5.24.0/api/#stepmaneuver-object); an unknown type reads
 * as a turn by its modifier.
 */
export function stepWords(
  type: string,
  modifier: string | undefined,
  street: string | null,
  bearingAfter: number,
  place: Place,
): { maneuver: Maneuver; street: string | null; instruction: string; action: string } {
  if (type === "arrive") {
    return { maneuver: "arrive", street: null, instruction: fit(() => `Arrive near ${place.spoken}.`, null).text, action: "arrive" };
  }
  if (type === "depart") {
    const way = fit((name) => `Head ${compass(bearingAfter)} on ${name}.`, street);
    return { maneuver: "straight", street: way.street, instruction: way.text, action: `head ${compass(bearingAfter)}` };
  }
  const maneuver = MODIFIERS[modifier ?? ""] ?? "straight";
  const side = maneuver.includes("left") ? "left" : maneuver.includes("right") ? "right" : "straight";
  let action: string;
  let sentence: (way: string) => string;
  if ((type === "new name" || type === "continue" || type === "use lane" || type === "notification") && maneuver === "straight") {
    action = "continue straight";
    sentence = (way) => `Continue onto ${way}.`;
  } else if (type === "fork") {
    action = `keep ${side}`;
    sentence = (way) => `Keep ${side} onto ${way}.`;
  } else if (type === "roundabout" || type === "rotary" || type === "roundabout turn" || type === "exit roundabout" || type === "exit rotary") {
    action = `${turnAction(maneuver)} at the roundabout`;
    sentence = (way) => `At the roundabout, take the exit onto ${way}.`;
  } else if (maneuver === "u_turn") {
    action = "turn around";
    sentence = (way) => `Turn around and continue on ${way}.`;
  } else {
    action = turnAction(maneuver);
    sentence = (way) => `${capital(action)} onto ${way}.`;
  }
  const way = fit(sentence, street);
  return { maneuver, street: way.street, instruction: way.text, action };
}

// ---- Parsing OSRM ----

type OsrmStep = {
  distance?: unknown;
  name?: unknown;
  maneuver?: { type?: unknown; modifier?: unknown; location?: unknown; bearing_after?: unknown };
};

interface RawStep {
  type: string;
  modifier: string | undefined;
  name: string | null;
  bearingAfter: number;
  at: LatLon;
  distance: number;
}

function latLon(value: unknown): LatLon | null {
  if (!Array.isArray(value) || value.length < 2) return null;
  const [lon, lat] = value as unknown[];
  if (typeof lat !== "number" || typeof lon !== "number" || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return [lat, lon];
}

/**
 * Steps shorter than STEP_FOLD_M are folded with the step after them, so she never hears two turns a few steps
 * apart: the earlier turn's point and words stay (she reaches it first), with the later way's name and both
 * distances. A short departure takes the later step's direction too. The arrival is never folded away.
 */
export function foldSteps(steps: RawStep[]): RawStep[] {
  const out: RawStep[] = [];
  for (let i = 0; i < steps.length; i += 1) {
    const step = { ...steps[i]! };
    if (step.type !== "arrive") {
      while (step.distance < STEP_FOLD_M && i + 1 < steps.length && steps[i + 1]!.type !== "arrive") {
        const next = steps[(i += 1)]!;
        step.distance += next.distance;
        step.name = next.name;
        if (step.type === "depart") step.bearingAfter = next.bearingAfter;
      }
    }
    out.push(step);
  }
  return out;
}

/** Turns an OSRM route response (`steps=true`, `geometries=geojson`, `overview=full`) into the walker's route. */
export function parseRoute(body: unknown, place: Place): RouteOutcome {
  const data = body as { code?: unknown; routes?: Array<{ geometry?: { coordinates?: unknown }; legs?: Array<{ steps?: OsrmStep[] }> }> } | null;
  if (!data || typeof data !== "object") throw new Error("Router answered something other than a route.");
  if (data.code === "NoRoute" || data.code === "NoSegment") return { kind: "none" };
  if (data.code !== "Ok") throw new Error("Router refused the request.");
  const first = Array.isArray(data.routes) ? data.routes[0] : undefined;
  if (!first) return { kind: "none" };
  const coordinates = Array.isArray(first.geometry?.coordinates) ? (first.geometry.coordinates as unknown[]) : [];
  const points: LatLon[] = [];
  for (const c of coordinates) {
    const p = latLon(c);
    if (!p) throw new Error("Router geometry has a bad point.");
    if (!points.length || metresBetween(points.at(-1)!, p) > 0.01) points.push(p);
  }
  if (points.length < 2) return { kind: "none" };
  const line = polyline(points);
  const length = lengthOf(line);
  if (length > ROUTE_MAX_M) return { kind: "too_far", metres: length };
  const raw: RawStep[] = [];
  for (const leg of first.legs ?? []) {
    for (const s of leg.steps ?? []) {
      const type = typeof s.maneuver?.type === "string" ? s.maneuver.type : "";
      const at = latLon(s.maneuver?.location);
      if (!type || !at) throw new Error("Router step has no maneuver.");
      raw.push({
        type,
        modifier: typeof s.maneuver?.modifier === "string" ? s.maneuver.modifier : undefined,
        name: cleanName(s.name, 60),
        bearingAfter: typeof s.maneuver?.bearing_after === "number" ? s.maneuver.bearing_after : 0,
        at,
        distance: typeof s.distance === "number" && Number.isFinite(s.distance) ? Math.max(0, s.distance) : 0,
      });
    }
  }
  // A multi-leg answer has an arrival per leg; only the last is hers.
  const steps = raw.filter((s, i) => s.type !== "arrive" || i === raw.length - 1);
  if (steps[0]?.type !== "depart" || steps.at(-1)?.type !== "arrive") throw new Error("Router steps don't start and end the route.");
  // Each step's place along the route: the nearest route point to its maneuver, never behind the step before.
  let from = 0;
  const built = foldSteps(steps).map((s, i, all): RouteStep => {
    let along = 0;
    if (i === all.length - 1) along = length;
    else if (i > 0) {
      let best = from;
      for (let k = from; k < points.length; k += 1) if (metresBetween(points[k]!, s.at) < metresBetween(points[best]!, s.at)) best = k;
      from = best;
      along = line.cum[best]!;
    }
    return { ...stepWords(s.type, s.modifier, s.name, s.bearingAfter, place), at: s.at, along };
  });
  return { kind: "ok", route: { place, line, length, steps: built } };
}

/**
 * Plans a walking route from `from` to the place. A place more than ROUTE_MAX_M away in a straight line is
 * refused without asking the router; a longer route than that is refused too. Throws when the router fails.
 */
export async function planRoute(services: MapServices, from: LatLon, place: Place, signal: AbortSignal): Promise<RouteOutcome> {
  const straight = metresBetween(from, place.at);
  if (straight > ROUTE_MAX_M) return { kind: "too_far", metres: straight };
  const url = new URL(`${services.routerUrl}/${from[1].toFixed(6)},${from[0].toFixed(6)};${place.at[1].toFixed(6)},${place.at[0].toFixed(6)}`);
  url.searchParams.set("steps", "true");
  url.searchParams.set("overview", "full");
  url.searchParams.set("geometries", "geojson");
  return parseRoute(await getMapJson(services, url, { nominatim: false, signal }), place);
}
