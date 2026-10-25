import type { TextSize } from "@walker/contracts";

/**
 * Every size on the walker screen comes from one number: pixels per millimetre on the panel. The panel is an
 * ELECROW 5-inch, 800x480 landscape, active area 108.9 x 65.3 mm (from its listing, to check with a ruler on
 * the day), so 800 / 108.9 = 7.35 px/mm. Sizes are set in millimetres for a reader about 65 cm away and
 * rounded to whole pixels. These assume CSS px equal panel px (devicePixelRatio 1, no OS scaling): measure a
 * rendered cap height on the panel before relying on them.
 */
export const PANEL = { width_px: 800, height_px: 480, width_mm: 108.9, height_mm: 65.3 } as const;
export const PX_PER_MM = 7.35;

const TEXT_SIZE_INDEX: Record<TextSize, 0 | 1 | 2> = { large: 0, larger: 1, largest: 2 };

/** Millimetres, by text size where it changes. */
export const SIZES_MM = {
  /** The smallest text anywhere: the status strip, the time left, "You said". */
  smallest: 5.45,
  /** Body lines and captions, which grow with her text size. */
  body: [6.53, 7.62, 8.71],
  /** A member's message: two lines of 30 characters at every text size. */
  message: [8.71, 9.8, 10.89],
  /** The one main line. */
  main: [11.97, 14.15, 16.33],
  /** Button labels. */
  button_label: [5.45, 5.99, 6.53],
  /** The shortest side of a touch target (20 mm, the size older and motor-impaired users do best with). */
  button: 20,
  /** Space between touch targets. */
  button_gap: 3,
  /** Space from the panel's edge. */
  edge: 2.2,
  /** The presence dot. */
  dot: 3,
  /**
   * The map's licence credit ("© OpenStreetMap contributors"), the one text under the smallest size (16 px): a notice
   * the licence asks for on every map, not something she needs to read.
   */
  credit: 2.2,
} as const;

export interface ScreenSizes {
  smallest: number;
  body: number;
  message: number;
  main: number;
  button_label: number;
  button: number;
  button_gap: number;
  edge: number;
  dot: number;
  credit: number;
}

const px = (mm: number, pxPerMm: number) => Math.round(mm * pxPerMm);

/** The pixel sizes for one text size. Pass another `pxPerMm` to draw the same screen for a different panel. */
export function screenSizes(textSize: TextSize, pxPerMm: number = PX_PER_MM): ScreenSizes {
  const i = TEXT_SIZE_INDEX[textSize];
  return {
    smallest: px(SIZES_MM.smallest, pxPerMm),
    body: px(SIZES_MM.body[i], pxPerMm),
    message: px(SIZES_MM.message[i], pxPerMm),
    main: px(SIZES_MM.main[i], pxPerMm),
    button_label: px(SIZES_MM.button_label[i], pxPerMm),
    button: px(SIZES_MM.button, pxPerMm),
    button_gap: px(SIZES_MM.button_gap, pxPerMm),
    edge: px(SIZES_MM.edge, pxPerMm),
    dot: px(SIZES_MM.dot, pxPerMm),
    credit: px(SIZES_MM.credit, pxPerMm),
  };
}

/** At most this many touch targets on any screen. */
export const MAX_BUTTONS = 3;
