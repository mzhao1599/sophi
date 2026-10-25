import type { LatLon, Maneuver, NavigatingScreen, NavigationPhase, TextSize } from "@walker/contracts";
import { screenSizes } from "./sizes";

/**
 * Walking directions on the walker screen (docs/subsystems/navigation.md, "The screen"): the words, the layout
 * and the map, as pure functions of the Pi's `navigating` state. The Pi decides everything; this only draws it.
 *
 * ## The height and width budget (800x480, px), written before the layout
 *
 * The screen keeps its 6 px top and bottom padding, 16 px sides, the 50 px status strip and 8 px row gaps, so
 * below the strip there are 480 - 12 - 50 - 8 = 410 px. That height is split into two columns, 16 px apart:
 *
 * | Region | Large | Larger | Largest |
 * | --- | --- | --- | --- |
 * | Left column (map, then the distance left), wide | 280 | 264 | 240 |
 * | Right column (the next thing to do, then the band), wide | 472 | 488 | 512 |
 * | Right: the next thing to do (the one thing), tall | 255 | 255 | 255 |
 * | Right: the band (Repeat, End route, Talk), tall | 147 | 147 | 147 |
 * | Left: the distance left, two lines at 40 px, tall | 92 | 92 | 92 |
 * | Left: the map, tall (410 - 8 - the distance lines) | 310 | 310 | 310 |
 *
 * The right column's 255 px, guiding (measured line boxes):
 *
 * | Row | Large | Larger | Largest |
 * | --- | --- | --- | --- |
 * | Arrow (square) beside the word and the distance | 140 | 140 | 128 |
 * | Word ("Left"), bold, one line, at most | 88 (90) | 96 (98) | 96 (98) |
 * | Distance ("in 30 m"), bold body, one line | 48 (53) | 56 (62) | 64 (70) |
 * | Street, body, one line, shortened | 48 (53) | 56 (62) | 64 (70) |
 * | Total (word + 4 + distance, 8, street) | 208 | 234 | 250 |
 *
 * The word is as large as fits one line beside the arrow, from its width measured on Atkinson Hyperlegible Next
 * bold (WORD_EM), between the smallest size and the cap above: "Left" is drawn at the cap, "Turn around" at
 * 54, 57 and 63 px. A phase sentence ("Finding the way again") takes the whole right column: one line as large
 * as fits up to the cap, or two lines in bold at her body size when one line would be smaller than that.
 *
 * The band, right column: Talk over the right handle (118 px with its mark) and 12 px, then Repeat (131 px of
 * words, 153 px of button) and End route (two lines in 147 px), 22 px apart, labels at the smallest size: 455
 * px at most, in 472 at Large. Every region is measured at every text size, with the longest street (60
 * characters) and place name (100 characters) the contract allows, by test/shots.test.tsx.
 *
 * Text under 40 px: only "© OpenStreetMap contributors" on the map, a licence credit (16 px, 7:1 on its own
 * card), which the shots check finds on every map.
 */

export const NAV_SIDE_PX = 410;
export const NAV_ONE_PX = NAV_SIDE_PX - 8 - 147;
export const NAV_COLUMN_GAP_PX = 16;
const CONTENT_WIDTH_PX = 800 - 2 * 16;
export const NAV_COLUMN_PX: Record<TextSize, number> = { large: 280, larger: 264, largest: 240 };
export const NAV_ARROW_PX: Record<TextSize, number> = { large: 140, larger: 140, largest: 128 };
export const NAV_WORD_CAP_PX: Record<TextSize, number> = { large: 88, larger: 96, largest: 96 };
/** One detail line (40 px at line height 1.15). */
const DETAIL_LINE_PX = 46;

export const MANEUVER_WORD: Record<Maneuver, string> = {
  straight: "Ahead",
  left: "Left",
  right: "Right",
  slight_left: "Slight left",
  slight_right: "Slight right",
  sharp_left: "Sharp left",
  sharp_right: "Sharp right",
  u_turn: "Turn around",
  arrive: "Arrive",
};

export const PHASE_WORDS: Record<Exclude<NavigationPhase, "guiding">, string> = {
  rerouting: "Finding the way again",
  off_route: "Can't find the way from here",
  no_position: "Looking for GPS",
  arrived: "You've arrived",
};

/**
 * Width in em of each fixed string, bold, with the main line's -0.01em letter spacing, measured in headless
 * Chromium on the bundled Atkinson Hyperlegible Next (2026-10-24, rounded up). The shots check proves the fit.
 */
export const WORD_EM: Record<string, number> = {
  Ahead: 2.91,
  Left: 1.82,
  Right: 2.44,
  "Slight left": 4.56,
  "Slight right": 5.16,
  "Sharp left": 4.55,
  "Sharp right": 5.15,
  "Turn around": 5.52,
  Arrive: 2.78,
  "You've arrived": 6.48,
  "Finding the way again": 10.04,
  "Can't find the way from here": 13.03,
  "Looking for GPS": 7.42,
};

/** Slack (px) left at the end of a fitted line, for rounding and the font's side bearings. */
const FIT_SLACK_PX = 8;
/**
 * Average width of a character of regular text, as a share of the font size: street and place names measured
 * 0.45 to 0.51 (Lenox Avenue) in Chromium on the bundled font, so 0.52 keeps a little room. A line of more than
 * one keeps 15% for wrapping.
 */
const CHAR_EM = 0.52;

export function navColumns(textSize: TextSize): { left: number; right: number } {
  const left = NAV_COLUMN_PX[textSize];
  return { left, right: CONTENT_WIDTH_PX - left - NAV_COLUMN_GAP_PX };
}

/** The maneuver word's size: as large as fits one line beside the arrow, between the smallest size and the cap. */
export function turnWordPx(word: string, textSize: TextSize): number {
  const sizes = screenSizes(textSize);
  const room = navColumns(textSize).right - NAV_ARROW_PX[textSize] - 16 - FIT_SLACK_PX;
  const em = WORD_EM[word] ?? 0.6 * [...word].length;
  return Math.max(sizes.smallest, Math.min(NAV_WORD_CAP_PX[textSize], Math.floor(room / em)));
}

/** A phase sentence: one line as large as fits up to the cap, or two lines at her body size in bold. */
export function phaseLine(text: string, textSize: TextSize): { px: number; wraps: boolean } {
  const sizes = screenSizes(textSize);
  const em = WORD_EM[text] ?? 0.6 * [...text].length;
  const px = Math.min(NAV_WORD_CAP_PX[textSize], Math.floor((navColumns(textSize).right - FIT_SLACK_PX) / em));
  return px >= sizes.body ? { px, wraps: false } : { px: sizes.body, wraps: true };
}

/** About how many characters of regular text at `px` fit in `lines` lines `width` wide. */
export function fitChars(width: number, px: number, lines: number): number {
  const perLine = Math.floor(width / (CHAR_EM * px));
  return lines === 1 ? perLine : Math.floor(perLine * lines * 0.85);
}

/** Street-type words, shortened the usual way, when a street's name is too long for its line. */
const STREET_WORDS: Record<string, string> = {
  Avenue: "Ave",
  Street: "St",
  Boulevard: "Blvd",
  Road: "Rd",
  Drive: "Dr",
  Place: "Pl",
  Lane: "Ln",
  Court: "Ct",
  Parkway: "Pkwy",
  Highway: "Hwy",
  Terrace: "Ter",
};

/**
 * A street's name for one line of `max` characters: as it is when it fits; else with its street-type words
 * shortened ("Lakeshore Ave"); else cut at a word with an ellipsis. The screen reader hears the whole instruction.
 */
export function streetForLine(street: string, max: number): string {
  const name = street.trim().replace(/\s+/g, " ");
  if ([...name].length <= max) return name;
  const short = name
    .split(" ")
    .map((word) => STREET_WORDS[word] ?? word)
    .join(" ");
  if ([...short].length <= max) return short;
  const chars = [...short];
  const cut = chars.slice(0, max - 1).join("");
  // Cut at the last whole word (the one that ends exactly at the cut counts).
  const space = chars[max - 1] === " " ? cut.length : cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** About how many characters of body text fit one line of the right column. */
export function bodyChars(textSize: TextSize): number {
  return fitChars(navColumns(textSize).right, screenSizes(textSize).body, 1);
}

/** "30 m", "1.2 km". The Pi rounds metres to 10. */
export function distanceWords(m: number): string {
  if (m < 1000) return `${m} m`;
  const km = Math.round(m / 100) / 10;
  return `${km >= 10 ? Math.round(km) : km} km`;
}

/** A no-break space: keeps a number with its unit when a line wraps ("about 1 h" / "9 min", never "9" / "min"). */
export const NBSP = String.fromCharCode(0xa0);

/** "about 10 min", "about 1 h 10 min", "under a minute". */
export function minutesLeftWords(min: number): string {
  if (min <= 0) return "under a minute";
  if (min < 60) return `about ${min} min`;
  const h = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `about ${h}${NBSP}h ${rest}${NBSP}min` : `about ${h}${NBSP}h`;
}

// ---- The map: a plain tile grid in Web Mercator, no map library ----

export const TILE_PX = 256;
/** The usual zoom: about 0.94 m a pixel by Lake Merritt, so the map shows about 260 by 290 m. */
export const MAP_ZOOM = 17;
/** When the next point is off that map, one step out (twice the ground), never further. */
export const MAP_ZOOM_OUT = 16;
/** A marker keeps this far inside the map's edge to count as on it. */
const MARKER_INSET_PX = 24;

/** World pixel coordinates of a point at a zoom (Web Mercator, as OpenStreetMap's tiles). */
export function worldPx([lat, lon]: LatLon, zoom: number): { x: number; y: number } {
  const scale = TILE_PX * 2 ** zoom;
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const phi = (clamped * Math.PI) / 180;
  return {
    x: ((lon + 180) / 360) * scale,
    y: ((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * scale,
  };
}

export interface MapTile {
  /** "z/x/y": the image's path under the tile base URL, without ".png". */
  key: string;
  z: number;
  x: number;
  y: number;
  /** Where the tile's top-left corner sits in the map, px. */
  left: number;
  top: number;
}

export interface MapPoint {
  x: number;
  y: number;
}

export interface NavMap {
  width: number;
  height: number;
  zoom: number;
  tiles: MapTile[];
  /** The route ahead as an SVG polyline's points ("x,y x,y"), px in the map. */
  route: string;
  position: MapPoint | null;
  step: MapPoint | null;
  destination: MapPoint;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * The map for a navigating state: a frame `width` by `height` centred on her position (or, with no position,
 * the start of the route ahead), at MAP_ZOOM, or MAP_ZOOM_OUT when the next point (the step, else the
 * destination) would be off the part that shows (`visibleHeight` tall, centred). Tiles cover the whole frame,
 * and the page centres the frame in the map's box, so her dot stays in the middle whatever height the box
 * gets. Markers and the route are in the frame's pixels. Pure: the same state draws the same map.
 */
export function navMap(map: NavigatingScreen["map"], width: number, height: number, visibleHeight = height): NavMap {
  const centre = map.position ?? map.route[0]!;
  const next = map.step_at ?? map.destination_at;
  const frame = (zoom: number) => {
    const c = worldPx(centre, zoom);
    const origin = { x: c.x - width / 2, y: c.y - height / 2 };
    const at = (p: LatLon): MapPoint => {
      const w = worldPx(p, zoom);
      return { x: round1(w.x - origin.x), y: round1(w.y - origin.y) };
    };
    return { origin, at };
  };
  let zoom = MAP_ZOOM;
  let f = frame(zoom);
  const n = f.at(next);
  const top = (height - visibleHeight) / 2 + MARKER_INSET_PX;
  if (n.x < MARKER_INSET_PX || n.x > width - MARKER_INSET_PX || n.y < top || n.y > height - top) {
    zoom = MAP_ZOOM_OUT;
    f = frame(zoom);
  }
  const count = 2 ** zoom;
  const tiles: MapTile[] = [];
  const x0 = Math.floor(f.origin.x / TILE_PX);
  const x1 = Math.floor((f.origin.x + width - 1) / TILE_PX);
  const y0 = Math.floor(f.origin.y / TILE_PX);
  const y1 = Math.floor((f.origin.y + height - 1) / TILE_PX);
  for (let ty = y0; ty <= y1; ty += 1) {
    if (ty < 0 || ty >= count) continue;
    for (let tx = x0; tx <= x1; tx += 1) {
      const x = ((tx % count) + count) % count;
      tiles.push({ key: `${zoom}/${x}/${ty}`, z: zoom, x, y: ty, left: Math.round(tx * TILE_PX - f.origin.x), top: Math.round(ty * TILE_PX - f.origin.y) });
    }
  }
  return {
    width,
    height,
    zoom,
    tiles,
    route: map.route.map((p) => {
      const q = f.at(p);
      return `${q.x},${q.y}`;
    }).join(" "),
    position: map.position ? f.at(map.position) : null,
    step: map.step_at ? f.at(map.step_at) : null,
    destination: f.at(map.destination_at),
  };
}

/** About how much of the map shows: the left column less the distance lines under it (and their gap). */
export function navMapHeight(infoLines: number): number {
  return infoLines ? NAV_SIDE_PX - 8 - infoLines * DETAIL_LINE_PX : NAV_SIDE_PX;
}

/** How many 40 px lines a detail text takes in the left column (estimated, proved by the shots check). */
export function detailLines(text: string, textSize: TextSize): number {
  return Math.max(1, Math.ceil(([...text].length * CHAR_EM * screenSizes(textSize).smallest) / NAV_COLUMN_PX[textSize]));
}
