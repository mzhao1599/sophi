import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";
import type { CapabilityManifest, ProposalView, SensorSnapshot, WalkerTurnView } from "@walker/contracts";
import { CareDbClient, MemoryWalkerStore, PostgresWalkerStore, SpacetimeCircleStore, careDbDiscovery, careDbJwks, type CareDbConfig, type WalkerStore } from "../../src";

/**
 * Test helpers for the walker store and service. The Postgres tests run when WALKER_TEST_DATABASE_URL
 * points at a local cluster (see the README's "Walker store" section); each run makes its own
 * database there and drops it afterwards. A URL that isn't on this machine is refused.
 */
export const walkerTestDatabaseUrl: string | null = (() => {
  const url = process.env.WALKER_TEST_DATABASE_URL?.trim();
  if (!url) return null;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
    throw new Error("WALKER_TEST_DATABASE_URL must be a local cluster: the tests create and drop databases.");
  }
  return url;
})();

export interface StoreHarness {
  name: string;
  store: () => WalkerStore;
  /** Clears every table between tests. */
  reset: () => Promise<void>;
  /** Every stored value as text, to check what is and isn't kept. */
  dump: () => Promise<string>;
  /** Postgres only. */
  pool?: Pool;
  close: () => Promise<void>;
}

export function memoryHarness(): StoreHarness {
  let store = new MemoryWalkerStore();
  return {
    name: "memory",
    store: () => store,
    reset: async () => {
      store = new MemoryWalkerStore();
    },
    dump: async () => JSON.stringify(store, (_key, value) => (value instanceof Map ? [...value.entries()] : value)),
    close: async () => {},
  };
}

const TABLES = [
  "walker_devices",
  "walker_configurations",
  "walker_proposals",
  "walker_turns",
  "walker_lines",
  "walker_pairing_codes",
  "walker_pairing_tries",
  "walker_circle_members",
  "walker_circle_invites",
  "walker_circle_messages",
];

export async function postgresHarness(url: string): Promise<StoreHarness> {
  const name = `walker_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const admin = new Pool({ connectionString: url, max: 1 });
  await admin.query(`create database ${name}`);
  const target = new URL(url);
  target.pathname = `/${name}`;
  const pool = new Pool({ connectionString: target.toString(), max: 5 });
  const store = new PostgresWalkerStore(pool);
  await store.ready();
  return {
    name: "postgres",
    store: () => store,
    pool,
    // DELETE, not TRUNCATE: truncating recreates files, which takes seconds each on a slow disk.
    reset: async () => {
      await pool.query("delete from walker_devices; delete from walker_pairing_codes; delete from walker_pairing_tries");
    },
    dump: async () => {
      const parts = await Promise.all(TABLES.map((t) => pool.query(`select coalesce(json_agg(t), '[]')::text as rows from ${t} t`)));
      return parts.map((p) => p.rows[0].rows).join("\n");
    },
    close: async () => {
      await pool.end();
      await admin.query(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}

export const SKIP_POSTGRES = "Skipping the walker Postgres tests: set WALKER_TEST_DATABASE_URL to a local cluster.";

/**
 * SPACETIME_TEST_SERVER: a local SpacetimeDB server (`spacetime start --listen-addr 127.0.0.1:3010`), for the
 * circle on SpacetimeDB (SpacetimeCircleStore). Each test gets its own database, published from the module's
 * bundle by the `spacetime` CLI, and a JWT issuer on a local port that the server fetches keys from.
 */
export const spacetimeTestServer: string | null = (() => {
  const url = process.env.SPACETIME_TEST_SERVER?.trim();
  if (!url) return null;
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname)) {
    throw new Error("SPACETIME_TEST_SERVER must be a local server: the tests publish and delete databases.");
  }
  return url.replace(/\/+$/, "");
})();

export const SKIP_SPACETIME = "Skipping the circle's SpacetimeDB tests: set SPACETIME_TEST_SERVER to a local `spacetime start`.";

const run = promisify(execFile);
const CARE_DB_DIR = fileURLToPath(new URL("../../../care-db", import.meta.url));
const CARE_TABLES = ["circle_member", "circle_invite", "circle_message", "join_try", "session"];

export async function spacetimeHarness(server: string): Promise<StoreHarness> {
  const spacetime = (...args: string[]) => run("spacetime", args, { cwd: CARE_DB_DIR, maxBuffer: 16 * 1024 * 1024 });
  await spacetime("build", "-p", CARE_DB_DIR);
  const bundle = `${CARE_DB_DIR}/dist/bundle.js`;

  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const issuerServer: Server = createServer((req, res) => {
    const body = req.url === "/.well-known/openid-configuration" ? careDbDiscovery(config) : req.url === "/.well-known/jwks.json" ? careDbJwks(config) : null;
    res.statusCode = body ? 200 : 404;
    res.setHeader("content-type", "application/json");
    res.end(body ? JSON.stringify(body) : "");
  });
  await new Promise<void>((resolve) => issuerServer.listen(0, "127.0.0.1", resolve));
  const address = issuerServer.address();
  if (!address || typeof address === "string") throw new Error("The test issuer has no port.");
  const jwk = privateKey.export({ format: "jwk" });
  const config: CareDbConfig = {
    uri: server,
    database: "",
    issuer: `http://127.0.0.1:${address.port}`,
    privateKey,
    kid: createHash("sha256").update(`${jwk.x}.${jwk.y}`).digest("hex").slice(0, 16),
  };

  const prefix = `care-test-${crypto.randomUUID().slice(0, 8)}`;
  let n = 0;
  let database = "";
  let base = new MemoryWalkerStore();
  let store: WalkerStore = base;

  async function drop(name: string) {
    if (name) await spacetime("delete", "-s", server, name, "-y").catch(() => {});
  }

  return {
    name: "spacetime",
    store: () => store,
    reset: async () => {
      const old = database;
      database = `${prefix}-${++n}`;
      await spacetime("publish", "-s", server, "-j", bundle, database, "-y");
      await spacetime("call", "-s", server, database, "configure", JSON.stringify(config.issuer), JSON.stringify("sophi-care"));
      base = new MemoryWalkerStore();
      store = new SpacetimeCircleStore(base, new CareDbClient({ ...config, database }));
      await drop(old);
    },
    dump: async () => {
      const parts = await Promise.all(CARE_TABLES.map((t) => spacetime("sql", "-s", server, database, `SELECT * FROM ${t}`).then((r) => r.stdout)));
      return [JSON.stringify(base, (_key, value) => (value instanceof Map ? [...value.entries()] : value)), ...parts].join("\n");
    },
    close: async () => {
      await drop(database);
      await new Promise<void>((resolve) => issuerServer.close(() => resolve()));
    },
  };
}

export const T0 = Date.parse("2026-10-23T09:00:00.000Z");

/** A clock the test moves by hand. */
export class Clock {
  t = T0;
  now = () => new Date(this.t);
  advance(ms: number) {
    this.t += ms;
  }
  iso(offsetMs = 0) {
    return new Date(this.t + offsetMs).toISOString();
  }
}

export const uuid = () => crypto.randomUUID();

/**
 * A messy simulator manifest: real hand controls, a simulated ToF sensor that is degraded with a fault,
 * a GPS part the configuration doesn't include, and no voice part reported at all.
 */
export function manifest(clock: Clock, overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return {
    device_configuration_version: 1,
    generated_at: clock.iso(-40),
    simulator: true,
    modules: [
      { module_id: "controls.hand", instance_id: "hand-left-01", firmware_version: "0.3.1", protocol_version: 1, health: "ok", faults: [], observed_at: clock.iso(-200), simulated: false },
      { module_id: "perception.tof", instance_id: "tof-front-01", firmware_version: null, protocol_version: 1, health: "degraded", faults: ["zone_left_noisy"], observed_at: clock.iso(-90), simulated: true },
      { module_id: "location.gps", instance_id: "gps-01", firmware_version: null, protocol_version: null, health: "ok", faults: [], observed_at: clock.iso(-3000), simulated: true },
    ],
    ...overrides,
  };
}

/**
 * The Pi's clock runs 37 minutes behind the server's, so only each clock's own differences can count.
 * Front is valid, left invalid, and rear comes from a sensor the manifest doesn't list.
 */
export function snapshot(clock: Clock): SensorSnapshot {
  const pi = (offsetMs: number) => new Date(clock.t - 37 * 60_000 + offsetMs).toISOString();
  return {
    generated_at: pi(0),
    zones: [
      { zone: "front", instance_id: "tof-front-01", mm: 640, quality: "valid", captured_at: pi(-120), expires_at: pi(880) },
      { zone: "left", instance_id: "tof-front-01", mm: null, quality: "invalid", captured_at: pi(-120), expires_at: pi(880) },
      { zone: "rear", instance_id: "tof-rear-02", mm: 1210, quality: "valid", captured_at: pi(-60), expires_at: pi(940) },
    ],
  };
}

export function turn(clock: Clock, overrides: Partial<WalkerTurnView> = {}): WalkerTurnView {
  return {
    turn_id: uuid(),
    client_turn_id: uuid(),
    source: "walker",
    heard: "Stop buzzing me, use short sounds instead.",
    heard_by: "gemini",
    reply: "I can switch your alerts from buzzing to short sounds. Press Confirm to do it.",
    answered_by: "model",
    voiced_by: "walker",
    created_at: clock.iso(),
    ...overrides,
  };
}

export function proposal(clock: Clock, clientTurnId: string, overrides: Partial<ProposalView> = {}): ProposalView {
  return {
    proposal_id: uuid(),
    client_turn_id: clientTurnId,
    kind: "cues_change",
    from_cues: ["vibration", "spoken"],
    cues: ["sound", "spoken"],
    base_configuration_version: 1,
    summary: "Switch your alerts from buzzing to short sounds.",
    state: "open",
    created_at: clock.iso(),
    expires_at: clock.iso(60_000),
    configuration_version: null,
    ...overrides,
  };
}
