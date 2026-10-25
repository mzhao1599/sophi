import type { Metadata, Viewport } from "next";
import { PAPER, STARTUP_IMAGES } from "@/lib/appManifest";
import styles from "./layout.module.css";

/**
 * The two-phone app, added to a phone's Home Screen as "Sophi". Its own manifest (scope /app, so the site
 * itself never installs), Apple's Home Screen tags, PNG icons and startup images drawn from the mark
 * (`scripts/app-icons.mjs`).
 *
 * No service worker. iOS and current Chrome install the app without one, and it would only add risk: a
 * cached page or script can outlive a deploy, and nothing the app shows is true without the server. While
 * the app is open and the server stops answering, the app itself says it can't reach Sophi.
 */
export const metadata: Metadata = {
  title: { absolute: "Sophi" },
  description: "Sophi on your phone: your walker, messages, and people nearby.",
  manifest: "/app/manifest.webmanifest",
  // "default" lets iOS draw the status bar in the system's own light or dark, so the clock always reads.
  // ("black-translucent" would put white text over the light paper.)
  appleWebApp: { capable: true, title: "Sophi", statusBarStyle: "default", startupImage: STARTUP_IMAGES },
  icons: { apple: [{ url: "/app-icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] },
  // Older iOS reads only the apple- name; Next writes the standard one.
  other: { "apple-mobile-web-app-capable": "yes" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // The page runs edge to edge on a notched iPhone; layout.module.css keeps the app inside the safe area.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: PAPER.light },
    { media: "(prefers-color-scheme: dark)", color: PAPER.dark },
  ],
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <div className={styles.safe}>{children}</div>;
}
