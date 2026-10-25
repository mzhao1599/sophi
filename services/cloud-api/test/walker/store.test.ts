import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { WALKER_SETUP } from "@walker/contracts";
import { PostgresWalkerStore, sha256, type WalkerStore } from "../../src";
import type { PairingClaim } from "../../src/walker/store";
import { Clock, SKIP_POSTGRES, memoryHarness, postgresHarness, proposal, turn, uuid, walkerTestDatabaseUrl, type StoreHarness } from "./support";

/** What only the store decides: the lockout and walker limit inside a claim, turn replays, migrations, and immutable versions. */

function claimOf(clock: Clock, code: string, overrides: Partial<PairingClaim> = {}): PairingClaim {
  return {
    code,
    now: clock.now(),
    device: { device_id: uuid(), credential_hash: sha256(uuid()), name: "My walker", service_version: "pi", created_at: clock.iso() },
    configuration: { version: 1, ...WALKER_SETUP, cues: [...WALKER_SETUP.cues], created_at: clock.iso() },
    maxDevices: 8,
    address_key: "address-a",
    triesSince: new Date(clock.t - 600_000),
    maxWrong: 5,
    ...overrides,
  };
}

function describeStore(name: string, makeHarness: () => Promise<StoreHarness>) {
  describe(`walker store: ${name}`, () => {
    let h: StoreHarness;
    beforeAll(async () => {
      h = await makeHarness();
    });
    afterAll(async () => {
      if (h) await h.close();
    });

    it("refuses a claim past the walker limit and keeps the code usable", async () => {
      await h.reset();
      const store: WalkerStore = h.store();
      const clock = new Clock();
      const owner = sha256("owner");
      const code = (digits: string) => ({ code: digits, owner_hash: owner, created_at: clock.iso(), expires_at: clock.iso(600_000) });

      expect(await store.putPairingCode(code("111111"), clock.now())).toBe(true);
      expect((await store.claimPairingCode(claimOf(clock, "111111", { maxDevices: 1 }))).ok).toBe(true);
      expect(await store.putPairingCode(code("222222"), clock.now())).toBe(true);
      expect(await store.claimPairingCode(claimOf(clock, "222222", { maxDevices: 1 }))).toEqual({ ok: false, reason: "walker_limit" });
      // Still there: a higher limit (the owner forgot a walker) can use it.
      expect((await store.claimPairingCode(claimOf(clock, "222222", { maxDevices: 2 }))).ok).toBe(true);
      expect(await store.countDevices(owner)).toBe(2);
    });

    it("gives two claims of one code at once one walker", async () => {
      await h.reset();
      const store = h.store();
      const clock = new Clock();
      await store.putPairingCode({ code: "333333", owner_hash: sha256("owner"), created_at: clock.iso(), expires_at: clock.iso(600_000) }, clock.now());
      const results = await Promise.all([store.claimPairingCode(claimOf(clock, "333333")), store.claimPairingCode(claimOf(clock, "333333", { address_key: "address-b" }))]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "code_invalid" }]);
    });

    it("checks at most 5 of 20 wrong codes sent at once from one address", async () => {
      await h.reset();
      const clock = new Clock();
      const attempt = () => h.store().claimPairingCode(claimOf(clock, "555555", { address_key: "address-c" }));
      const results = await Promise.all(Array.from({ length: 20 }, attempt));
      const reasons = results.map((r) => (r.ok ? "ok" : r.reason));
      // Memory runs them one after another (5 checked, then locked); Postgres turns away the ones that overlap (busy).
      expect(reasons.filter((r) => r === "code_invalid").length).toBeLessThanOrEqual(5);
      expect(reasons.every((r) => r === "code_invalid" || r === "locked" || r === "busy")).toBe(true);
      // Sent one at a time, the address reaches the lockout after 5 wrong codes in all.
      const later: string[] = [];
      for (let i = 0; i < 6; i++) {
        const r = await attempt();
        later.push(r.ok ? "ok" : r.reason);
      }
      expect(later.at(-1)).toBe("locked");
      expect(reasons.filter((r) => r === "code_invalid").length + later.filter((r) => r === "code_invalid").length).toBe(5);
    });

    it("replays a turn by client_turn_id without opening a second proposal", async () => {
      await h.reset();
      const store = h.store();
      const clock = new Clock();
      await store.putPairingCode({ code: "666666", owner_hash: sha256("owner"), created_at: clock.iso(), expires_at: clock.iso(600_000) }, clock.now());
      const claim = await store.claimPairingCode(claimOf(clock, "666666"));
      if (!claim.ok) throw new Error("pairing failed");
      const id = claim.device.device_id;
      await store.recordHeartbeat(id, { at: clock.iso(), service_version: "pi", manifest: { device_configuration_version: 1, generated_at: clock.iso(), simulator: true, modules: [] }, snapshot: null, events: [] });
      const t = turn(clock);
      const p = proposal(clock, t.client_turn_id);
      expect(await store.saveTurn(id, t, p, clock.now())).toEqual({ turn: t, proposal: p, created: true });
      clock.advance(2_000);
      // A retried upload: same client_turn_id, a fresh turn id and proposal id from a second model call.
      const retry = await store.saveTurn(id, { ...t, turn_id: uuid() }, { ...p, proposal_id: uuid() }, clock.now());
      expect(retry).toEqual({ turn: t, proposal: p, created: false });
      expect((await store.openProposal(id))?.proposal_id).toBe(p.proposal_id);
      expect(await store.recentTurns(id, 10)).toEqual([t]);
    });
  });
}

describeStore("memory", async () => memoryHarness());

if (walkerTestDatabaseUrl) {
  const url = walkerTestDatabaseUrl;
  describeStore("postgres", () => postgresHarness(url));

  describe("walker store: postgres migrations", () => {
    let h: StoreHarness;
    beforeAll(async () => {
      h = await postgresHarness(url);
    });
    afterAll(async () => {
      if (h) await h.close();
    });

    it("runs again, and twice at once from two instances, without error or change", async () => {
      const second = new Pool({ connectionString: (h.pool!.options as { connectionString: string }).connectionString, max: 2 });
      const third = new Pool({ connectionString: (h.pool!.options as { connectionString: string }).connectionString, max: 2 });
      try {
        await Promise.all([new PostgresWalkerStore(second).ready(), new PostgresWalkerStore(third).ready()]);
        await new PostgresWalkerStore(second).ready();
        const { rows } = await h.pool!.query("select id from walker_schema_migrations order by id");
        expect(rows.map((r) => r.id)).toEqual(["0001_walker", "0002_walker_turn_order", "0003_walker_circle_phones", "0004_walker_location_sharing", "0005_walker_help"]);
      } finally {
        await second.end();
        await third.end();
      }
    });

    it("never updates a configuration version", async () => {
      await h.reset();
      const clock = new Clock();
      await h.store().putPairingCode({ code: "444444", owner_hash: sha256("o"), created_at: clock.iso(), expires_at: clock.iso(600_000) }, clock.now());
      const claim = await h.store().claimPairingCode(claimOf(clock, "444444"));
      expect(claim.ok).toBe(true);
      await expect(h.pool!.query(`update walker_configurations set cues = '["sound"]'`)).rejects.toThrow(/never updated/);
    });
  });
} else {
  describe.skip(SKIP_POSTGRES, () => {
    it("needs a local cluster", () => {});
  });
}
