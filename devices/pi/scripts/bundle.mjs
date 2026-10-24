// Bundles the Pi service into one ES module that Node 22 runs directly.
// Contracts ship raw TypeScript with extensionless imports, which Node can't load, so the Pi never runs
// the sources: it runs dist/walker.mjs. Usage: `pnpm --filter @walker/pi bundle`.
import { build } from "esbuild";
import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outfile = join(root, "dist", "walker.mjs");

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
