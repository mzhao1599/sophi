import { describe, expect, it } from "vitest";
import { walkerBackendFromEnv } from "../../src";

describe("walkerBackendFromEnv", () => {
  it("uses Postgres with DATABASE_URL, memory locally, and turns walkers off in production without a database", async () => {
    const warnings: string[] = [];
    const postgres = walkerBackendFromEnv({ DATABASE_URL: "postgres://walker@127.0.0.1:1/none", NODE_ENV: "production" }, (w) => warnings.push(w));
    expect(postgres.kind).toBe("postgres");
    expect(walkerBackendFromEnv({}, (w) => warnings.push(w)).kind).toBe("memory");
    const off = walkerBackendFromEnv({ NODE_ENV: "production" }, (w) => warnings.push(w));
    expect(off).toMatchObject({ kind: "off", blocked: "Walkers aren't set up on this server." });
    expect(warnings).toEqual(["[walker] No DATABASE_URL in production; walker routes answer 503."]);
  });
});
