import type { Metadata, Viewport } from "next";

/**
 * The two-phone app, added to a phone's Home Screen as "Sophi". Its own manifest (scope /app, so the site
 * itself never installs), Apple's Home Screen tags and PNG icons drawn from the mark. No service worker:
 * the app needs the server to say anything true, so it has nothing to show offline.
 */
export const metadata: Metadata = {
  title: { absolute: "Sophi" },
  description: "Sophi on your phone: your walker, messages, and people nearby.",
  manifest: "/app/manifest.webmanifest",
  appleWebApp: { capable: true, title: "Sophi", statusBarStyle: "default" },
  icons: { apple: [{ url: "/app-icons/apple-touch-icon.png", sizes: "180x180", type: "image/png" }] },
  // Older iOS reads only the apple- name; Next writes the standard one.
  other: { "apple-mobile-web-app-capable": "yes" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f1f4f2" },
    { media: "(prefers-color-scheme: dark)", color: "#101513" },
  ],
};

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return children;
}
