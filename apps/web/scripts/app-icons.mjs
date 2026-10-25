// Draws the two-phone app's Home Screen icons and iPhone startup images into public/app-icons from the mark
// (app/icon.svg). Run from apps/web after changing the mark or the screen list in src/lib/appManifest.ts:
//
//   node scripts/app-icons.mjs
//
// Needs Node 22.18 or later (it reads appManifest.ts directly) and uses sharp, which Next.js already installs.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { IPHONE_SCREENS, PAPER, startupImagePath } from "../src/lib/appManifest.ts";

const web = fileURLToPath(new URL("..", import.meta.url));
// sharp isn't a dependency of this app; resolve the copy Next.js brings.
const fromNext = createRequire(createRequire(`${web}package.json`).resolve("next/package.json"));
const sharp = fromNext("sharp");

const mark = readFileSync(`${web}app/icon.svg`, "utf8");
const inner = mark.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
const INK = /fill="(#[0-9a-f]{6})"/i.exec(mark)[1];

/** The mark on a 32x32 canvas: `rx` rounds the tile, `scale` shrinks the drawing around the centre. */
const tile = ({ rx = 8, scale = 1 } = {}) => {
  const body = inner.replace(/rx="[^"]*"/, `rx="${rx}"`);
  const off = (32 - 32 * scale) / 2;
  return `<rect width="32" height="32" rx="${rx}" fill="${INK}"/><g transform="translate(${off} ${off}) scale(${scale})">${body}</g>`;
};

// Icons keep full colour; the flat startup images fit a 256-colour palette at a fraction of the size.
const png = (svg, density, palette = false) => sharp(Buffer.from(svg), { density }).png({ compressionLevel: 9, palette });
const icon = (size, opts) =>
  png(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${tile(opts)}</svg>`, (72 * size) / 32)
    .resize(size, size)
    .flatten({ background: INK }) // Apple's icons must be opaque.
    .toBuffer();

const out = (path, buf) => {
  writeFileSync(`${web}public${path}`, buf);
  console.log(`${path} (${buf.length} bytes)`);
};

// Full-bleed (the phone rounds the corners); the maskable one keeps the mark inside the 80% safe circle.
out("/app-icons/icon-192.png", await icon(192, { rx: 0 }));
out("/app-icons/icon-512.png", await icon(512, { rx: 0 }));
out("/app-icons/apple-touch-icon.png", await icon(180, { rx: 0 }));
out("/app-icons/icon-maskable-512.png", await icon(512, { rx: 0, scale: 0.8 }));

// Startup images: the paper with the rounded mark in the middle, 112 points wide, light and dark.
for (const s of IPHONE_SCREENS) {
  for (const theme of Object.keys(PAPER)) {
    const side = 112;
    const x = (s.width - side) / 2;
    const y = (s.height - side) / 2;
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${s.width}" height="${s.height}" viewBox="0 0 ${s.width} ${s.height}">` +
      `<rect width="100%" height="100%" fill="${PAPER[theme]}"/>` +
      `<g transform="translate(${x} ${y}) scale(${side / 32})">${tile()}</g></svg>`;
    const buf = await png(svg, 72 * s.ratio, true)
      .resize(s.width * s.ratio, s.height * s.ratio)
      .flatten({ background: PAPER[theme] })
      .toBuffer();
    out(startupImagePath(s, theme), buf);
  }
}
