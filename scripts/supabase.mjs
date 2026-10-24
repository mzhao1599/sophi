#!/usr/bin/env node
// Runs the Supabase CLI at the version this repository is tested with, through npx, so nobody needs
// a global install: `pnpm supabase start`, `pnpm supabase status`, `pnpm supabase db reset`.
// Change the version here only after checking it is at least two weeks old (docs/project-plan.md).
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SUPABASE_CLI_VERSION = "2.119.0";

// Run as a script, not when imported (test-db.mjs imports the version).
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const result = spawnSync("npx", ["--yes", `supabase@${SUPABASE_CLI_VERSION}`, ...process.argv.slice(2)], { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
