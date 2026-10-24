// Bundles the Pi service into one ES module that Node 22 runs directly.
// Contracts ship raw TypeScript with extensionless imports, which Node can't load, so the Pi never runs
// the sources: it runs dist/walker.mjs. Usage: `pnpm --filter @walker/pi bundle`.
// It also builds the walker screen's page for the browser into dist/screen-page/ (page.js, page.css, the
// Atkinson Hyperlegible Next fonts and their licence, OFL.txt). The walker service serves that folder from
// beside walker.mjs; install-pi.sh copies it to /opt/steady-walker/screen-page.
import { build } from "esbuild";
import { chmod, copyFile, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", "walker.mjs");
const pageDir = join(root, "dist", "screen-page");

await build({
  entryPoints: [join(root, "src", "cli.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: false,
  legalComments: "none",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});
await chmod(outfile, 0o755);
console.log(`Bundled ${outfile}`);

await rm(pageDir, { recursive: true, force: true });
await mkdir(pageDir, { recursive: true });
await build({
  entryPoints: { page: join(root, "src", "screen", "page.tsx") },
  outdir: pageDir,
  bundle: true,
  platform: "browser",
  // The kiosk is Chromium (155 in Raspberry Pi's trixie archive, 2026-10-23).
  target: "chrome120",
  format: "iife",
  minify: true,
  jsx: "automatic",
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".woff2": "file" },
  assetNames: "[name]",
  // React's and zod's licence notices go in page.js.LEGAL.txt beside the page.
  legalComments: "linked",
  logLevel: "warning",
});
const screenPackage = dirname(createRequire(join(root, "package.json")).resolve("@walker/walker-screen/view"));
await copyFile(join(screenPackage, "fonts", "OFL.txt"), join(pageDir, "OFL.txt"));
console.log(`Bundled the walker screen's page into ${pageDir}`);
