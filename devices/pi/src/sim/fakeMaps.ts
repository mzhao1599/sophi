import type { LatLon } from "@walker/contracts";
import type { Clock } from "../clock";
import { bearing, metresBetween, polyline, snapTo } from "../navigation/geo";
import { injectedMapServices, type MapFetch, type MapServices } from "../navigation/osm";
import reverseFixture from "../../test/fixtures/navigation/nominatim-reverse-start.json";
import searchFixture from "../../test/fixtures/navigation/nominatim-search-boating-center.json";
import routeFixture from "../../test/fixtures/navigation/osrm-foot-to-boating-center.json";

/**
 * RECORDED map services for tests and `walker simulate`: three real responses fetched once on 2026-10-24 and kept
 * in test/fixtures/navigation/ (a Nominatim search for "Lake Merritt Boating Center", a reverse lookup at the
 * simulated start, and OSRM's foot route from there to the Boating Center). Nothing here touches the internet,
 * so a `.walk` run is offline and repeats exactly.
 *
 * What it can answer, and nothing more:
 * - a search whose words include "boating" gets the recorded search; any other search finds nothing;
 * - every reverse lookup gets the recorded address (the reverse geocoder's own distance check then says when
 *   it is too far away to name);
 * - a route from the recorded start is the recorded route. A route from anywhere else (planning again after
 *   `gps off_route`) is the recorded route cut where it passes nearest to her, with a straight first leg to
 *   that point: a SIMULATED route, not a router's answer.
 */

type OsrmRoute = (typeof routeFixture)["routes"][number];
type OsrmStep = OsrmRoute["legs"][number]["steps"][number];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

const toLatLon = (c: number[]): LatLon => [c[1]!, c[0]!];

/** The recorded route rebuilt to start at `from`: a straight first leg to where the route passes nearest. */
export function recordedRouteFrom(from: LatLon): unknown {
  const recorded = routeFixture.routes[0]!;
  const coords = recorded.geometry.coordinates;
  const start = toLatLon(coords[0]!);
  if (metresBetween(from, start) <= 20) return routeFixture;
  const line = polyline(coords.map(toLatLon));
  const join = snapTo(line, from, 0);
  // Each recorded step's place along the route (the nearest route point to its maneuver).
  const steps = recorded.legs[0]!.steps;
  const alongOf = (step: OsrmStep) => snapTo(line, toLatLon(step.maneuver.location), 0).along;
  const kept = steps.filter((step, i) => i > 0 && (step.maneuver.type === "arrive" || alongOf(step) > join.along + 1));
  const current = [...steps].reverse().find((step) => alongOf(step) <= join.along) ?? steps[0]!;
  const ahead = coords.filter((_, i) => line.cum[i]! > join.along + 0.5);
  // Only the overview geometry and each step's maneuver and distance are read by the Pi (route.ts).
  const departDistance = metresBetween(from, join.point) + (kept[0] && kept[0].maneuver.type !== "arrive" ? alongOf(kept[0]) - join.along : 0);
  const depart = {
    ...steps[0]!,
    name: current.name,
    distance: departDistance,
    geometry: { type: "LineString", coordinates: [[from[1], from[0]], [join.point[1], join.point[0]]] },
    maneuver: { ...steps[0]!.maneuver, location: [from[1], from[0]], bearing_after: Math.round(bearing(from, join.point)) },
  };
  const overview = [[from[1], from[0]], [join.point[1], join.point[0]], ...ahead];
  const distance = metresBetween(from, join.point) + (line.cum.at(-1)! - join.along);
  return {
    code: "Ok",
    waypoints: routeFixture.waypoints,
    routes: [{ ...recorded, distance, geometry: { type: "LineString", coordinates: overview }, legs: [{ ...recorded.legs[0]!, distance, steps: [depart, ...kept] }] }],
  };
}

/** A `fetch` that answers the three kinds of map request from the recordings. */
export const recordedMapFetch: MapFetch = (url) => {
  if (url.pathname.endsWith("/search")) {
    return Promise.resolve(json((url.searchParams.get("q") ?? "").toLowerCase().includes("boating") ? searchFixture : []));
  }
  if (url.pathname.endsWith("/reverse")) return Promise.resolve(json(reverseFixture));
  const match = /\/route\/v1\/foot\/(-?[\d.]+),(-?[\d.]+);(-?[\d.]+),(-?[\d.]+)$/.exec(url.pathname);
  if (match) {
    const from: LatLon = [Number(match[2]), Number(match[1])];
    const to: LatLon = [Number(match[4]), Number(match[3])];
    const end = toLatLon(routeFixture.routes[0]!.geometry.coordinates.at(-1)!);
    // The recording only goes to the Boating Center.
    if (metresBetween(to, end) > 60) return Promise.resolve(json({ code: "NoRoute", message: "Not in the recording." }));
    return Promise.resolve(json(recordedRouteFrom(from)));
  }
  return Promise.resolve(new Response("not found", { status: 404 }));
};

export function recordedMapServices(clock: Clock): MapServices {
  return injectedMapServices(clock, recordedMapFetch);
}
