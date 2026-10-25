// Splits the cleaned walker photos (docs/assets/walker-photos/{front,side}.png) into the layers the
// onboarding page stacks in public/walker/: one per module region in src/components/walkerPhotos.ts,
// and the frame with everything else. Run from apps/web after changing a photo or a region:
//
//   node scripts/walker-photos.mjs
//
// Each pixel goes to exactly one layer. Inside a region, a pixel belongs to that module, except the red
// walker tubes in the regions FRAME_RED_STAYS names; where regions overlap, the later one wins. Region
// edges are anti-aliased (4 x 4 samples a pixel), so the layers add back up to the photo.
//
// Needs Node 22.18 or later (it reads walkerPhotos.ts directly) and uses sharp, which Next.js already installs.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { FRAME_RED_STAYS, PHOTO_VIEWS, layerSrc } from "../src/components/walkerPhotos.ts";

const web = fileURLToPath(new URL("..", import.meta.url));
// sharp isn't a dependency of this app; resolve the copy Next.js brings.
const fromNext = createRequire(createRequire(`${web}package.json`).resolve("next/package.json"));
const sharp = fromNext("sharp");

const SAMPLES = 4;

function inside(poly, x, y) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

/** How much of each pixel the polygons cover, 0 to 1. */
function coverage(polys, width, height) {
  const out = new Float32Array(width * height);
  for (const poly of polys) {
    const xs = poly.map((p) => p[0]);
    const ys = poly.map((p) => p[1]);
    for (let y = Math.max(0, Math.floor(Math.min(...ys))); y < Math.min(height, Math.ceil(Math.max(...ys))); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(...xs))); x < Math.min(width, Math.ceil(Math.max(...xs))); x++) {
        let n = 0;
        for (let sy = 0; sy < SAMPLES; sy++)
          for (let sx = 0; sx < SAMPLES; sx++) if (inside(poly, x + (sx + 0.5) / SAMPLES, y + (sy + 0.5) / SAMPLES)) n++;
        out[y * width + x] = Math.max(out[y * width + x], n / SAMPLES ** 2);
      }
    }
  }
  return out;
}

const isFrameRed = (r, g, b) => r > 70 && r > g * 1.7 && r > b * 1.3;

for (const [view, photo] of Object.entries(PHOTO_VIEWS)) {
  const { data, info } = await sharp(`${web}../../docs/assets/walker-photos/${view}.png`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height } = info;
  if (width !== photo.width || height !== photo.height) throw new Error(`${view}.png is ${width} x ${height}, walkerPhotos.ts says ${photo.width} x ${photo.height}`);
  const px = width * height;
  // What share of each pixel is still the frame's; each module takes its share in order.
  const left = new Float32Array(px).fill(1);
  const shares = [];
  for (const [id, polys] of Object.entries(photo.regions)) {
    const cover = coverage(polys, width, height);
    const share = new Float32Array(px);
    for (let i = 0; i < px; i++) {
      if (!cover[i]) continue;
      if (FRAME_RED_STAYS.includes(id) && isFrameRed(data[i * 4], data[i * 4 + 1], data[i * 4 + 2])) continue;
      share[i] = cover[i];
    }
    // A later region takes its share from the earlier ones too.
    for (const earlier of shares) for (let i = 0; i < px; i++) earlier.share[i] *= 1 - share[i];
    shares.push({ id, share });
  }
  for (const { share } of shares) for (let i = 0; i < px; i++) left[i] -= share[i];

  const write = async (id, share) => {
    const out = Buffer.from(data);
    for (let i = 0; i < px; i++) out[i * 4 + 3] = Math.round(data[i * 4 + 3] * Math.max(0, Math.min(1, share[i])));
    const file = `${web}public${layerSrc(view, id)}`;
    await sharp(out, { raw: { width, height, channels: 4 } }).webp({ quality: 90, alphaQuality: 100, effort: 6 }).toFile(file);
    console.log(file.slice(web.length));
  };
  await write("frame", left);
  for (const { id, share } of shares) await write(id, share);
}
