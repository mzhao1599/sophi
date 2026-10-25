import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import type { CareLiveAccess } from "@walker/contracts";

/**
 * Sophi's server and the care circle's SpacetimeDB database (services/care-db; docs/interfaces.md, "The care
 * circle on SpacetimeDB"). Two jobs:
 * - an OpenID issuer: the server signs ES256 JWTs and publishes the public key, so SpacetimeDB can check
 *   them (the discovery document and JWKS are served by apps/web under /.well-known);
 * - a client for the module's procedures, called over HTTP as subject `sophi-server`.
 */

export const CARE_DB_AUDIENCE = "sophi-care";
export const CARE_DB_SERVER_SUBJECT = "sophi-server";
/** Every token lasts an hour; the server renews its own, a phone asks again when it reconnects. */
export const CARE_TOKEN_TTL_S = 60 * 60;
const CALL_TIMEOUT_MS = 8_000;

export interface CareDbConfig {
  /** SpacetimeDB's HTTP origin, such as https://maincloud.spacetimedb.com. */
  uri: string;
  database: string;
  /** This server's public origin; the discovery document lives under it. */
  issuer: string;
  privateKey: KeyObject;
  /** Names the key in the JWKS: the first 16 hex characters of the public key's SHA-256. */
  kid: string;
}

/**
 * The care database's settings, or null when they aren't all set (the circle then stays in the walker store).
 * Half a configuration, or a key that isn't a P-256 private key, is logged and ignored rather than thrown:
 * the walker must keep running whatever the circle's settings say.
 */
export function careDbConfigFromEnv(env: Record<string, string | undefined>, warn: (message: string) => void = console.warn): CareDbConfig | null {
  const get = (name: string) => env[name]?.trim() || undefined;
  const uri = get("SPACETIME_URI");
  const database = get("SPACETIME_DATABASE");
  const issuer = get("SPACETIME_ISSUER");
  const pem = get("SPACETIME_JWT_PRIVATE_KEY");
  const given = [uri, database, issuer, pem].filter(Boolean).length;
  if (given === 0) return null;
  if (given < 4) {
    warn("[care-db] Some SPACETIME_* settings are missing (all four are needed); the circle stays in the walker store.");
    return null;
  }
  let privateKey: KeyObject;
  try {
    // A dashboard may not keep line breaks, so the key may also be given as base64 of the PEM.
    const text = pem!.includes("BEGIN") ? pem!.replace(/\\n/g, "\n") : Buffer.from(pem!, "base64").toString("utf8");
    privateKey = createPrivateKey(text);
  } catch {
    warn("[care-db] SPACETIME_JWT_PRIVATE_KEY isn't a private key; the circle stays in the walker store.");
    return null;
  }
  if (privateKey.asymmetricKeyType !== "ec" || privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
    warn("[care-db] SPACETIME_JWT_PRIVATE_KEY must be a P-256 (ES256) key; the circle stays in the walker store.");
    return null;
  }
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  const kid = createHash("sha256").update(`${jwk.x}.${jwk.y}`).digest("hex").slice(0, 16);
  return { uri: uri!.replace(/\/+$/, ""), database: database!, issuer: issuer!.replace(/\/+$/, ""), privateKey, kid };
}

/** `/.well-known/openid-configuration`: SpacetimeDB requires `issuer` to equal each token's `iss` exactly. */
export function careDbDiscovery(config: CareDbConfig) {
  return { issuer: config.issuer, jwks_uri: `${config.issuer}/.well-known/jwks.json`, id_token_signing_alg_values_supported: ["ES256"] };
}

/** `/.well-known/jwks.json`: the public half only. */
export function careDbJwks(config: CareDbConfig) {
  const { kty, crv, x, y } = createPublicKey(config.privateKey).export({ format: "jwk" });
  return { keys: [{ kty, crv, x, y, kid: config.kid, alg: "ES256", use: "sig" }] };
}

/** A signed token for one subject: `sophi-server`, `member:<member_id>` or `owner:<device_id>`. */
export function mintCareToken(config: CareDbConfig, subject: string, now: Date): { token: string; expires_at: string } {
  const iat = Math.floor(now.getTime() / 1000);
  const exp = iat + CARE_TOKEN_TTL_S;
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signing = `${part({ alg: "ES256", typ: "JWT", kid: config.kid })}.${part({ iss: config.issuer, sub: subject, aud: CARE_DB_AUDIENCE, iat, exp })}`;
  const signature = sign("sha256", Buffer.from(signing), { key: config.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return { token: `${signing}.${signature}`, expires_at: new Date(exp * 1000).toISOString() };
}

/** What a phone or the owner's page needs to connect: where, which database, and its own token. */
export function careLiveAccess(config: CareDbConfig, subject: string, now: Date): CareLiveAccess {
  return { uri: config.uri, database: config.database, ...mintCareToken(config, subject, now) };
}

/** The care database didn't answer, or refused: never carries a token or a request's contents. */
export class CareDbError extends Error {
  override readonly name = "CareDbError";
  constructor(
    readonly procedure: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
  }
}

export interface CareDbClientOptions {
  fetch?: typeof globalThis.fetch;
  /** The real clock, for the server's own token (the stores' `now` is separate and may be a test's). */
  clock?: () => Date;
}

/** Calls the module's procedures as `sophi-server`. Each call is one SpacetimeDB transaction. */
export class CareDbClient {
  private readonly fetch: typeof globalThis.fetch;
  private readonly clock: () => Date;
  private token: { token: string; renewAt: number } | undefined;

  constructor(
    readonly config: CareDbConfig,
    options: CareDbClientOptions = {},
  ) {
    this.fetch = options.fetch ?? globalThis.fetch;
    this.clock = options.clock ?? (() => new Date());
  }

  async call<T>(procedure: string, args: Record<string, unknown>): Promise<T> {
    const url = `${this.config.uri}/v1/database/${encodeURIComponent(this.config.database)}/call/${procedure}`;
    let response: Response;
    try {
      response = await this.fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${this.serverToken()}`, "content-type": "application/json" },
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (error) {
      throw new CareDbError(procedure, null, `The care database didn't answer (${error instanceof Error ? error.name : "unknown"}).`);
    }
    const text = await response.text();
    if (!response.ok) throw new CareDbError(procedure, response.status, `The care database answered ${response.status} to ${procedure}: ${text.slice(0, 200)}`);
    // A procedure returns a string (its JSON result), which the HTTP API sends as a JSON string.
    const outer: unknown = JSON.parse(text);
    if (typeof outer !== "string") throw new CareDbError(procedure, response.status, `The care database's ${procedure} didn't return a string.`);
    return JSON.parse(outer) as T;
  }

  private serverToken(): string {
    const now = this.clock();
    if (!this.token || now.getTime() >= this.token.renewAt) {
      const { token } = mintCareToken(this.config, CARE_DB_SERVER_SUBJECT, now);
      // Renew with 10 minutes to spare.
      this.token = { token, renewAt: now.getTime() + (CARE_TOKEN_TTL_S - 600) * 1000 };
    }
    return this.token.token;
  }
}
