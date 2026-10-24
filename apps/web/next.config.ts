import type { NextConfig } from "next";

const config: NextConfig = {
  poweredByHeader: false,
  // The shared packages ship TypeScript source; Next compiles them with the app.
  transpilePackages: ["@walker/contracts", "@walker/cloud-api"],
  // The demo is one page now. Old links (and sign-in's ?next=) still land somewhere useful.
  async redirects() {
    return [
      { source: "/onboarding", destination: "/", permanent: false },
      { source: "/onboarding/review", destination: "/", permanent: false },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // No page asks for the microphone, camera or location yet. Loosen this per page when one does.
          { key: "Permissions-Policy", value: "microphone=(), camera=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default config;
