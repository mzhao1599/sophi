import type { Metadata, Viewport } from "next";
import { Atkinson_Hyperlegible_Mono, Atkinson_Hyperlegible_Next } from "next/font/google";
import { PRODUCT_LINE, PRODUCT_NAME } from "@/lib/brand";
import "./globals.css";

// Atkinson Hyperlegible, made by the Braille Institute for readers with low vision: legibility is the
// brand of an assistive walker. Next for everything people read; Mono for the drawing's annotations.
const text = Atkinson_Hyperlegible_Next({ subsets: ["latin"], variable: "--font-hyperlegible" });
const mono = Atkinson_Hyperlegible_Mono({ subsets: ["latin"], variable: "--font-hyperlegible-mono" });

export const metadata: Metadata = {
  title: { default: PRODUCT_NAME, template: `%s · ${PRODUCT_NAME}` },
  description: `${PRODUCT_LINE} An experimental prototype: say what's hard, and it suggests only the parts that help.`,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f1f4f2" },
    { media: "(prefers-color-scheme: dark)", color: "#101513" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${text.variable} ${mono.variable}`}>
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
