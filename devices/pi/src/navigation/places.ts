import type { LatLon } from "@walker/contracts";
import { PLACE_SEARCH_RADIUS_M } from "../constants";
import { cleanName, getMapJson, type MapServices } from "./osm";

/** A place she asked for, as the map found it. `at` stays on the Pi; `name` and `spoken` reach the model. */
export interface Place {
  /** The place's own name, or its street address ("Lake Merritt Boating Center"). */
  name: string;
  /** How the walker says it in a sentence ("the Lake Merritt Boating Center"). */
  spoken: string;
  at: LatLon;
}

type SearchResult = {
  lat?: unknown;
  lon?: unknown;
  name?: unknown;
  category?: unknown;
  address?: Record<string, unknown>;
};

/** Kinds of place that read naturally with "the" ("the Lake Merritt Boating Center", not "the 600 Bellevue Avenue"). */
const NAMED_KINDS = new Set(["amenity", "building", "leisure", "tourism", "shop", "office", "historic", "craft", "healthcare", "club"]);

/** Her words for the search: one line, at most 80 characters (the contract's RouteDestinationSchema). */
function searchWords(destination: string): string {
  return destination.replace(/[\p{C}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** The first usable result: a finite position, and a name or a street address fit to say. */
export function placeFromSearch(body: unknown): Place | null {
  if (!Array.isArray(body)) return null;
  for (const raw of body as SearchResult[]) {
    if (!raw || typeof raw !== "object") continue;
    const lat = Number(raw.lat);
    const lon = Number(raw.lon);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) continue;
    const address = raw.address ?? {};
    const street = cleanName(address.road ?? address.pedestrian ?? address.footway, 60);
    const number = cleanName(address.house_number, 20);
    const streetLine = street ? [number, street].filter(Boolean).join(" ") : null;
    const own = cleanName(raw.name);
    const name = own ?? streetLine;
    if (!name) continue;
    const withThe = own !== null && NAMED_KINDS.has(String(raw.category)) && !/^(the\s|\d)/i.test(own);
    return { name, spoken: withThe ? `the ${name}` : name, at: [lat, lon] };
  }
  return null;
}

/**
 * Searches Nominatim for her words within about PLACE_SEARCH_RADIUS_M of her (a bounded `viewbox`), and takes
 * the first result. Null when nothing is found; throws when the search itself fails.
 */
export async function findPlace(services: MapServices, destination: string, near: LatLon, signal: AbortSignal): Promise<Place | null> {
  const words = searchWords(destination);
  if (!words) return null;
  const dLat = PLACE_SEARCH_RADIUS_M / 111_320;
  const dLon = dLat / Math.max(0.01, Math.cos((near[0] * Math.PI) / 180));
  const box = [near[1] - dLon, near[0] + dLat, near[1] + dLon, near[0] - dLat].map((n) => n.toFixed(4)).join(",");
  const url = new URL(services.placesUrl);
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("addressdetails", "1");
  url.searchParams.set("limit", "3");
  url.searchParams.set("bounded", "1");
  url.searchParams.set("viewbox", box);
  url.searchParams.set("q", words);
  // A place in the box's corner can be farther than the radius: the route's own limit refuses it then.
  return placeFromSearch(await getMapJson(services, url, { nominatim: true, signal }));
}
