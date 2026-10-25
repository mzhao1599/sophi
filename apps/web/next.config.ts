import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  // No Next.js badge in the corner during development: the demo runs from `next dev` on stage.
  devIndicators: false,
  // The shared packages ship TypeScript source; Next compiles them with the app.
  transpilePackages: ["@walker/contracts", "@walker/cloud-api", "@walker/care-db"],
  // The demo is one page now. Old links (and sign-in's ?next=) still land somewhere useful.
  async redirects() {
    return [
      { source: "/onboarding", destination: "/", permanent: false },
      { source: "/onboarding/review", destination: "/", permanent: false },
    ];
  },
  // The care circle's token issuer (SpacetimeDB reads these at the issuer's origin; see app/api/v1/care-db).
  async rewrites() {
    return [
      { source: "/.well-known/openid-configuration", destination: "/api/v1/care-db/openid-configuration" },
      { source: "/.well-known/jwks.json", destination: "/api/v1/care-db/jwks" },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // No other page asks for the microphone, camera or location. Loosen this per page when one does.
          { key: "Permissions-Policy", value: "microphone=(), camera=(), geolocation=()" },
        ],
      },
      {
        // The onboarding chat (the home page) can be answered by voice; the microphone is for this site only.
        // Listed after the rule above, so its Permissions-Policy is the one sent for "/".
        source: "/",
        headers: [{ key: "Permissions-Policy", value: "microphone=(self), camera=(), geolocation=()" }],
      },
    ];
  },
};

export default config;
