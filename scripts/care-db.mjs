#!/usr/bin/env node
// The care circle's SpacetimeDB database (services/care-db; docs/interfaces.md, "The care circle on SpacetimeDB").
//
//   node scripts/care-db.mjs keygen --out <file>
//       Makes the server's P-256 signing key and appends SPACETIME_JWT_PRIVATE_KEY=<base64 of the PEM> to <file>
//       (for example apps/web/.env.local). Never prints the key. Copy that line to the server's secret settings.
//   node scripts/care-db.mjs publish --server <local|maincloud|url> --database <name> --issuer <origin> [--delete-data]
//       Builds and publishes the module, then sets the issuer it trusts (`configure`, which only the account that
//       published it can run). <origin> is the server's public origin: SpacetimeDB fetches its keys from there.
//
// Needs the `spacetime` CLI (https://spacetimedb.com/install), logged in for Maincloud (`spacetime login`).
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const MODULE = fileURLToPath(new URL("../services/care-db", import.meta.url));
const [command, ...rest] = process.argv.slice(2);
const flag = (name) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

function spacetime(args) {
  const result = spawnSync("spacetime", args, { stdio: "inherit", cwd: MODULE });
  if (result.status !== 0) {
    console.error(`spacetime ${args[0]} failed.`);
    process.exit(result.status ?? 1);
  }
}

if (command === "keygen") {
  const out = flag("out");
  if (!out) {
    console.error("Usage: node scripts/care-db.mjs keygen --out <file>");
    process.exit(1);
  }
  if (existsSync(out) && /^SPACETIME_JWT_PRIVATE_KEY=/m.test(readFileSync(out, "utf8"))) {
    console.error(`${out} already has SPACETIME_JWT_PRIVATE_KEY. Remove that line first to make a new key.`);
    process.exit(1);
  }
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });
  appendFileSync(out, `SPACETIME_JWT_PRIVATE_KEY=${Buffer.from(pem).toString("base64")}\n`, { mode: 0o600 });
  console.log(`Wrote SPACETIME_JWT_PRIVATE_KEY to ${out}.`);
} else if (command === "publish") {
  const server = flag("server");
  const database = flag("database");
  const issuer = flag("issuer")?.replace(/\/+$/, "");
  if (!server || !database || !issuer) {
    console.error("Usage: node scripts/care-db.mjs publish --server <local|maincloud|url> --database <name> --issuer <origin> [--delete-data]");
    process.exit(1);
  }
  spacetime(["publish", "-s", server, "-p", MODULE, database, rest.includes("--delete-data") ? "--delete-data=always" : "--delete-data=never", "-y"]);
  spacetime(["call", "-s", server, database, "configure", JSON.stringify(issuer), JSON.stringify("sophi-care")]);
  console.log(`Published ${database} on ${server}, trusting tokens from ${issuer}.`);
} else {
  console.error("Commands: keygen, publish. See the top of scripts/care-db.mjs.");
  process.exit(1);
}
