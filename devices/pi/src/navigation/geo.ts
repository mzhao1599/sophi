import type { LatLon } from "@walker/contracts";

/**
 * Small geometry for walking routes: distances on the Earth and positions along a polyline. A route is a few
 * kilometres at most, so each segment is projected onto a flat local plane (equirectangular, accurate to well
 * under a metre at this size) to find the nearest point on it.
 */

const EARTH_M = 6_371_000;
const RADIANS = Math.PI / 180;

/** Great-circle distance in metres. */
export function metresBetween(a: LatLon, b: LatLon): number {
  const dLat = (b[0] - a[0]) * RADIANS;
  const dLon = (b[1] - a[1]) * RADIANS;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RADIANS) * Math.cos(b[0] * RADIANS) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Compass bearing from `a` to `b`, 0 to 360 degrees (0 is north). */
export function bearing(a: LatLon, b: LatLon): number {
  const y = Math.sin((b[1] - a[1]) * RADIANS) * Math.cos(b[0] * RADIANS);
  const x = Math.cos(a[0] * RADIANS) * Math.sin(b[0] * RADIANS) - Math.sin(a[0] * RADIANS) * Math.cos(b[0] * RADIANS) * Math.cos((b[1] - a[1]) * RADIANS);
  return ((Math.atan2(y, x) / RADIANS) + 360) % 360;
}

/** The point `metres` from `from` along `bearingDeg` (a flat step: fine for tens of metres). */
export function offsetPoint(from: LatLon, metres: number, bearingDeg: number): LatLon {
  const north = metres * Math.cos(bearingDeg * RADIANS);
  const east = metres * Math.sin(bearingDeg * RADIANS);
  return [from[0] + north / EARTH_M / RADIANS, from[1] + east / (EARTH_M * Math.cos(from[0] * RADIANS)) / RADIANS];
}

/** A polyline with the distance along it at each point (`cum[0]` is 0, the last is its length). */
export interface Polyline {
  points: LatLon[];
  cum: number[];
}

export function polyline(points: LatLon[]): Polyline {
  const cum = [0];
  for (let i = 1; i < points.length; i += 1) cum.push(cum[i - 1]! + metresBetween(points[i - 1]!, points[i]!));
  return { points, cum };
}

export function lengthOf(line: Polyline): number {
  return line.cum.at(-1) ?? 0;
}

/** The point `along` metres from the start (clamped to the ends). */
export function pointAlong(line: Polyline, along: number): LatLon {
  const { points, cum } = line;
  if (along <= 0 || points.length === 1) return points[0]!;
  for (let i = 1; i < points.length; i += 1) {
    if (cum[i]! >= along) {
      const span = cum[i]! - cum[i - 1]!;
      const t = span > 0 ? (along - cum[i - 1]!) / span : 0;
      const a = points[i - 1]!;
      const b = points[i]!;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
  }
  return points.at(-1)!;
}

/** Where a position falls on a line: metres from it (`off`), metres along it (`along`) and the nearest point. */
export interface Snap {
  off: number;
  along: number;
  point: LatLon;
}

/**
 * Snaps `p` to the line. `hint` is her last progress along it, so a route that passes the same corner twice
 * keeps her on the stretch she is walking.
 */
export function snapTo(line: Polyline, p: LatLon, hint = 0): Snap {
  const { points, cum } = line;
  const cosLat = Math.cos(p[0] * RADIANS);
  const xy = (q: LatLon): [number, number] => [(q[1] - p[1]) * RADIANS * EARTH_M * cosLat, (q[0] - p[0]) * RADIANS * EARTH_M];
  const candidates: Snap[] = [];
  if (points.length === 1) return { off: metresBetween(points[0]!, p), along: 0, point: points[0]! };
  for (let i = 1; i < points.length; i += 1) {
    const [ax, ay] = xy(points[i - 1]!);
    const [bx, by] = xy(points[i]!);
    const dx = bx - ax;
    const dy = by - ay;
    const span = dx * dx + dy * dy;
    const t = span > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / span)) : 0;
    const off = Math.hypot(ax + dx * t, ay + dy * t);
    const a = points[i - 1]!;
    const b = points[i]!;
    candidates.push({ off, along: cum[i - 1]! + (cum[i]! - cum[i - 1]!) * t, point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t] });
  }
  candidates.sort((a, b) => a.off - b.off);
  const best = candidates[0]!;
  // The nearest stretch, unless it is a jump of more than 50 m from her progress and another stretch nearly as
  // near is closer to it.
  if (Math.abs(best.along - hint) <= 50) return best;
  return candidates
    .filter((c) => c.off <= best.off + 5)
    .reduce((pick, c) => (Math.abs(c.along - hint) < Math.abs(pick.along - hint) ? c : pick));
}

/** The line from `along` to the end, starting at the point there, with at most `max` points (the ends kept). */
export function lineAhead(line: Polyline, along: number, max: number): LatLon[] {
  const ahead: LatLon[] = [pointAlong(line, along)];
  for (let i = 0; i < line.points.length; i += 1) if (line.cum[i]! > along + 0.5) ahead.push(line.points[i]!);
  if (ahead.length === 1) ahead.push(line.points.at(-1)!);
  if (ahead.length <= max) return ahead;
  // Thinned evenly by index; the first (her snapped position) and the last (the end) always stay.
  const thinned: LatLon[] = [];
  for (let k = 0; k < max; k += 1) thinned.push(ahead[Math.round((k * (ahead.length - 1)) / (max - 1))]!);
  return thinned;
}
