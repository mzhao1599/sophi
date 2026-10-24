/**
 * The two-phone app's web app manifest (served at /app/manifest.webmanifest). Scoped to /app, so adding the
 * app to the Home Screen opens /app standalone and the rest of the site never installs. Icons are drawn
 * from the mark (`public/app-icons`, full-bleed: the phone rounds the corners).
 */
export const APP_MANIFEST = {
  name: "Sophi",
  short_name: "Sophi",
  description: "Sophi on your phone: your walker, messages, and people nearby.",
  id: "/app",
  start_url: "/app",
  scope: "/app",
  display: "standalone",
  orientation: "portrait",
  background_color: "#f1f4f2",
  theme_color: "#f1f4f2",
  icons: [
    { src: "/app-icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "/app-icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
    { src: "/app-icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
} as const;
