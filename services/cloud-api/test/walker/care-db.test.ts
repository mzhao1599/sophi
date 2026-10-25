import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CARE_DB_AUDIENCE, careDbConfigFromEnv, careDbDiscovery, careDbJwks, mintCareToken, walkerBackendFromEnv } from "../../src";

/**
 * The server as the care circle's token issuer (care-db.ts). Expected, written first:
 * - no SPACETIME_* settings: no care database, nothing logged; some of them, or a key that isn't P-256: no care
 *   database and one warning, never a throw (the walker must keep running);
 * - all four: the walker backend's circle moves to SpacetimeDB;
 * - the JWKS has the public key only; a token's signature verifies with it, and carries issuer, audience, subject
 *   and an hour's expiry.
 */

const p256 = () => generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const env = (over: Record<string, string> = {}) => ({
  SPACETIME_URI: "https://maincloud.spacetimedb.com/",
  SPACETIME_DATABASE: "sophi-care",
  SPACETIME_ISSUER: "https://steady-walker.onrender.com/",
  SPACETIME_JWT_PRIVATE_KEY: Buffer.from(p256()).toString("base64"),
  ...over,
});

describe("the care database's settings", () => {
  it("is off with none, and ignores half a configuration or a wrong key with a warning", () => {
    const warnings: string[] = [];
    const warn = (m: string) => void warnings.push(m);
    expect(careDbConfigFromEnv({}, warn)).toBeNull();
    expect(warnings).toEqual([]);
    expect(careDbConfigFromEnv({ SPACETIME_URI: "https://maincloud.spacetimedb.com" }, warn)).toBeNull();
    expect(careDbConfigFromEnv(env({ SPACETIME_JWT_PRIVATE_KEY: "not a key" }), warn)).toBeNull();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(careDbConfigFromEnv(env({ SPACETIME_JWT_PRIVATE_KEY: rsa }), warn)).toBeNull();
    expect(warnings).toHaveLength(3);
    expect(warnings.join(" ")).not.toContain("BEGIN");
  });

  it("takes the key as PEM or base64 of it, and moves the walker backend's circle to SpacetimeDB", () => {
    const pem = p256();
    expect(careDbConfigFromEnv(env({ SPACETIME_JWT_PRIVATE_KEY: pem }))?.uri).toBe("https://maincloud.spacetimedb.com");
    const config = careDbConfigFromEnv(env());
    expect(config?.issuer).toBe("https://steady-walker.onrender.com");
    const backend = walkerBackendFromEnv({ ...env() }, () => {});
    expect(backend.kind).toBe("memory");
    expect(backend.care?.database).toBe("sophi-care");
    expect(backend.store.constructor.name).toBe("SpacetimeCircleStore");
  });
});

describe("the care circle's tokens", () => {
  it("publishes the public key only, and signs tokens it verifies", () => {
    const config = careDbConfigFromEnv(env())!;
    const jwks = careDbJwks(config);
    expect(jwks.keys).toHaveLength(1);
    expect(Object.keys(jwks.keys[0]!).sort()).toEqual(["alg", "crv", "kid", "kty", "use", "x", "y"]);
    expect(careDbDiscovery(config)).toMatchObject({ issuer: config.issuer, jwks_uri: `${config.issuer}/.well-known/jwks.json` });

    const now = new Date("2026-10-24T20:00:00.000Z");
    const { token, expires_at } = mintCareToken(config, "member:11111111-1111-4111-8111-111111111111", now);
    const [header, payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "ES256", typ: "JWT", kid: config.kid });
    expect(claims).toEqual({ iss: config.issuer, sub: "member:11111111-1111-4111-8111-111111111111", aud: CARE_DB_AUDIENCE, iat: 1792872000, exp: 1792875600 });
    expect(expires_at).toBe("2026-10-24T21:00:00.000Z");
    const key = createPublicKey({ key: jwks.keys[0]!, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature!, "base64url"))).toBe(true);
  });
});
