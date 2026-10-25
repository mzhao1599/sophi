import type { ModuleId } from "@walker/contracts";
import type { Spot } from "./WalkerDiagram";

/*
 * Photographs of the real prototype (2026-10-25), cut out of the room with macOS subject lifting and
 * cleaned by hand: the TV behind the front view and the bookshelf behind the side view were erased, and
 * the seat and bag the mask dropped were put back from the photo. The cleaned cutouts are
 * docs/assets/walker-photos/{front,side}.png, 430 x 573.
 *
 * scripts/walker-photos.mjs splits each cutout into layers in public/walker/: one per module region
 * below, and the walker frame with everything else. Each pixel goes to exactly one layer, so the layers
 * stack back into the photo, and a module that's off can be greyed out as its own silhouette.
 *
 * Each photo sits in the drawing's 320 x 380 box (WalkerDiagram's DRAW_W x H): scaled to the box's
 * height and centred, so the labels, leaders and narrow markers keep working from one coordinate table.
 * Spots below are in box units; regions are in photo pixels.
 *
 * Where a part is visible (arms, lift, hand controls, microphone), its spot points at it and it has a
 * layer. Obstacle sensors and location sharing have no part you can see in these photos, so their spots
 * follow the catalog's placement and nothing in the photo changes for them.
 */

export type PhotoViewId = "front" | "side";

type Point = [number, number];

export interface PhotoView {
  width: number;
  height: number;
  spots: Spot[];
  /** The photo pixels that belong to each module's layer. Modules without a visible part have none. */
  regions: Partial<Record<ModuleId, Point[][]>>;
}

/** Regions that cross the red walker frame: its red tubes stay in the frame layer. */
export const FRAME_RED_STAYS: readonly ModuleId[] = ["manipulation.lift", "controls.hand"];

const PHOTO_W = 430;
const PHOTO_H = 573;
/** Photo pixels to box units: fitted to the box's 380 height, centred across its 320 width. */
export const PHOTO_SCALE = 380 / PHOTO_H;
export const PHOTO_X = (320 - PHOTO_W * PHOTO_SCALE) / 2;

const at = (px: number, py: number): Point => [Math.round((PHOTO_X + px * PHOTO_SCALE) * 10) / 10, Math.round(py * PHOTO_SCALE * 10) / 10];

/** Where a layer is served from: the frame, or one module's part. */
export const layerSrc = (view: PhotoViewId, id: ModuleId | "frame") => `/walker/${view}-${id.replace(".", "-")}.webp`;

// Spots are spaced so that, at the smallest size the stage draws them, no two 44px markers overlap.
export const PHOTO_VIEWS: Record<PhotoViewId, PhotoView> = {
  // From the front left: two arms on the lift at the front, the seat, and the handles at the back.
  front: {
    width: PHOTO_W,
    height: PHOTO_H,
    spots: [
      { id: "manipulation.arm", anchor: at(100, 140), side: "left", labelY: 70 },
      { id: "perception.tof", anchor: at(148, 352), side: "left", labelY: 214 },
      { id: "manipulation.lift", anchor: at(196, 452), side: "left", labelY: 300 },
      { id: "voice", anchor: at(246, 122), side: "right", labelY: 72 },
      { id: "controls.hand", anchor: at(338, 222), side: "right", labelY: 146 },
      { id: "location.gps", anchor: at(246, 368), side: "right", labelY: 236 },
      { id: "base.walker", anchor: at(246, 512), side: "right", labelY: 330 },
    ],
    regions: {
      "manipulation.arm": [
        [[4, 84], [70, 66], [104, 4], [152, 4], [154, 112], [180, 116], [216, 150], [216, 292], [160, 294], [100, 272], [66, 232], [58, 168], [4, 122]],
      ],
      "manipulation.lift": [[[160, 164], [208, 164], [208, 496], [164, 496]]],
      "controls.hand": [
        [[286, 188], [374, 186], [374, 254], [286, 256]],
        [[210, 176], [254, 176], [254, 212], [210, 212]],
      ],
      voice: [[[236, 110], [258, 114], [220, 184], [204, 180]]],
    },
  },
  // From the side: the handles at the left, the lift and both arms at the front on the right.
  side: {
    width: PHOTO_W,
    height: PHOTO_H,
    spots: [
      { id: "voice", anchor: at(100, 124), side: "left", labelY: 74 },
      { id: "controls.hand", anchor: at(124, 216), side: "left", labelY: 146 },
      { id: "location.gps", anchor: at(196, 330), side: "left", labelY: 224 },
      { id: "base.walker", anchor: at(76, 436), side: "left", labelY: 302 },
      { id: "manipulation.arm", anchor: at(332, 172), side: "right", labelY: 92 },
      { id: "manipulation.lift", anchor: at(272, 300), side: "right", labelY: 196 },
      { id: "perception.tof", anchor: at(232, 420), side: "right", labelY: 290 },
    ],
    regions: {
      "manipulation.arm": [[[238, 0], [342, 0], [404, 86], [404, 134], [358, 210], [352, 268], [254, 264], [234, 120]]],
      "manipulation.lift": [[[241, 148], [287, 148], [287, 488], [241, 488]]],
      "controls.hand": [[[56, 190], [144, 192], [144, 242], [56, 244]]],
      voice: [[[88, 110], [106, 110], [118, 200], [100, 202]]],
    },
  },
};

export const points = (poly: Point[]) => poly.map(([x, y]) => `${x},${y}`).join(" ");
