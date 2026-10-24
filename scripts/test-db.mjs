#!/usr/bin/env node
// Runs the cloud-api tests against the local Supabase stack (`pnpm supabase start` first). It reads
// the local URL and keys from `supabase status` and passes them as SUPABASE_TEST_*, which the tests
// accept only for a localhost URL. Plain `pnpm test` skips the database tests.
import { spawnSync } from "node:child_process";
import { SUPABASE_CLI_VERSION } from "./supabase.mjs";

const status = spawnSync("npx", ["--yes", `supabase@${SUPABASE_CLI_VERSION}`, "status", "-o", "json"], { encoding: "utf8" });
let local;
try {
  local = JSON.parse(status.stdout);
} catch {
  local = null;
}
if (!local?.API_URL || !local.PUBLISHABLE_KEY || !local.SECRET_KEY) {
  console.error("The local Supabase stack isn't running, or `supabase status` gave no URL and keys. Start Docker, then run `pnpm supabase start`.");
  process.exit(1);
}
const env = {
  ...process.env,
  SUPABASE_TEST_URL: local.API_URL,
  SUPABASE_TEST_PUBLISHABLE_KEY: local.PUBLISHABLE_KEY,
  SUPABASE_TEST_SECRET_KEY: local.SECRET_KEY,
};
const result = spawnSync("pnpm", ["--filter", "@walker/cloud-api", "test", ...process.argv.slice(2)], { stdio: "inherit", env });
process.exit(result.status ?? 1);
