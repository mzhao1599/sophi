/**
 * The two-phone app's web app manifest (served at /app/manifest.webmanifest), its Home Screen icons and its
 * iPhone startup images. Scoped to /app, so adding the app to the Home Screen opens /app standalone and the
 * rest of the site never installs. Every PNG in `public/app-icons` is drawn from the mark (`app/icon.svg`) by
 * `scripts/app-icons.mjs`; run `node scripts/app-icons.mjs` from `apps/web` after changing the mark or this list.
 * This file has no imports, so that script can read it too.
 */

/** The paper token from `app/globals.css`, light and dark: the app's background, theme colour and splash. */
export const PAPER = { light: "#f1f4f2", dark: "#101513" } as const;

export const APP_MANIFEST = {
  name: "Sophi",
  short_name: "Sophi",
  description: "Sophi on your phone: your walker, messages, and people nearby.",
  lang: "en",
  id: "/app",
  start_url: "/app",
  scope: "/app",
  display: "standalone",
  orientation: "portrait",
  background_color: PAPER.light,
  theme_color: PAPER.light,
  icons: [
    // Full-bleed: the phone rounds the corners.
    { src: "/app-icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/app-icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    // The mark at 80%, so Android's circle or squircle mask never cuts the green nib.
    { src: "/app-icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
} as const;

/**
 * iPhone screens that get a startup image (what iOS shows while the Home Screen app opens), in CSS points
 * and pixel ratio, portrait. iOS only uses an image whose media query matches the screen exactly; any other
 * iPhone opens on a plain screen instead, which is harmless. The list covers iPhone 8 to iPhone 17 Pro Max and Air.
 */
export const IPHONE_SCREENS = [
  { width: 375, height: 667, ratio: 2 }, // iPhone 8, SE (2nd and 3rd generation)
  { width: 414, height: 736, ratio: 3 }, // iPhone 8 Plus
  { width: 375, height: 812, ratio: 3 }, // iPhone X, XS, 11 Pro, 12 mini, 13 mini
  { width: 414, height: 896, ratio: 2 }, // iPhone XR, 11
  { width: 414, height: 896, ratio: 3 }, // iPhone XS Max, 11 Pro Max
  { width: 390, height: 844, ratio: 3 }, // iPhone 12, 13, 14, 16e
  { width: 428, height: 926, ratio: 3 }, // iPhone 12 Pro Max, 13 Pro Max, 14 Plus
  { width: 393, height: 852, ratio: 3 }, // iPhone 14 Pro, 15, 15 Pro, 16
  { width: 430, height: 932, ratio: 3 }, // iPhone 14 Pro Max, 15 Plus, 15 Pro Max, 16 Plus
  { width: 402, height: 874, ratio: 3 }, // iPhone 16 Pro, 17, 17 Pro
  { width: 420, height: 912, ratio: 3 }, // iPhone Air
  { width: 440, height: 956, ratio: 3 }, // iPhone 16 Pro Max, 17 Pro Max
] as const;

export type Theme = keyof typeof PAPER;

export const startupImagePath = (s: (typeof IPHONE_SCREENS)[number], theme: Theme) =>
  `/app-icons/startup-${s.width * s.ratio}x${s.height * s.ratio}-${theme}.png`;

/** One `apple-touch-startup-image` per screen and colour scheme, for the layout's metadata. */
export const STARTUP_IMAGES = IPHONE_SCREENS.flatMap((s) =>
  (Object.keys(PAPER) as Theme[]).map((theme) => ({
    url: startupImagePath(s, theme),
    media:
      `(device-width: ${s.width}px) and (device-height: ${s.height}px) and (-webkit-device-pixel-ratio: ${s.ratio})` +
      ` and (orientation: portrait) and (prefers-color-scheme: ${theme})`,
  })),
);
