import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseSessionStore, hashDemoToken, type StoredSession } from "../src";
import { confirm, createSession, storedState } from "../src/onboarding/engine";
import { SKIP_MESSAGE, adminClient, anonClient, createTestUser, deleteTestUsers, localStack, type LocalStack, type TestUser } from "./support/local-supabase";

/**
 * Row-level security, checked through the real Data API of the local stack, the same way a browser
 * holding the public key (and maybe someone's session) would try it. Each check talks to Postgres
 * directly instead of through the store, so it proves the policies, not the store's own filters.
 */

const TABLES = ["onboarding_sessions", "onboarding_turn_results", "device_configurations"] as const;
const PERMISSION_DENIED = "42501";

function saveArgs(record: StoredSession, expected: number, demoTokenHash: string | null = null) {
  const session = { ...record.session, revision: expected + 1 };
  return {
    p_id: session.id,
    p_expected_revision: expected,
    p_revision: session.revision,
    p_state: storedState(session),
    p_engine_state: session,
    p_expires_at: session.expires_at,
    p_demo_token_hash: demoTokenHash,
  };
}

function rlsSuite(stack: LocalStack) {
  let a: TestUser;
  let b: TestUser;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  const demoToken = crypto.randomUUID().replaceAll("-", "");
  const demo = createSession(crypto.randomUUID(), new Date(), 60 * 60 * 1000, "demo");
  let mine: StoredSession;
  let setupId: string;

  beforeAll(async () => {
    [a, b] = [await createTestUser(stack, "rls-a"), await createTestUser(stack, "rls-b")];
    admin = adminClient(stack);
    anon = anonClient(stack);

    // A demo session, written the way the server writes one, and an account session owned by A with
    // a turn result and a confirmed setup, written through A's own client.
    const server = new SupabaseSessionStore({ admin, user: null });
    await server.create({ session: demo, owner: { kind: "demo", token_hash: hashDemoToken(demoToken) } });
    const store = new SupabaseSessionStore({ admin, user: a.client });
    mine = { session: createSession(crypto.randomUUID(), new Date(), 60 * 60 * 1000, "account"), owner: { kind: "account", user_id: a.id } };
    await store.create(mine);
    const confirmed = { ...mine, session: { ...confirm(mine.session, ["base.walker"], new Date(), 1), revision: 1 } };
    const response = { session: {} as never, assistant_text: "Noted.", ack: null, needs_user_confirmation: false };
    expect(await store.save(confirmed, 0, { turn: { client_turn_id: crypto.randomUUID(), response }, configuration: confirmed.session.configuration! })).toBe(true);
    mine = confirmed;
    const { data } = await a.client.from("device_configurations").select("id").single();
    setupId = data!.id;
  });

  afterAll(async () => {
    await admin.from("onboarding_sessions").delete().eq("id", demo.id);
    await deleteTestUsers(stack, [a, b]);
  });

  it("lets an owner read their own rows", async () => {
    for (const table of TABLES) {
      const { data, error } = await a.client.from(table).select("*");
      expect(error).toBeNull();
      expect(data).toHaveLength(1);
    }
  });

  it("hides user A's rows from user B", async () => {
    for (const table of TABLES) {
      const { data, error } = await b.client.from(table).select("*");
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
    const byId = await b.client.from("onboarding_sessions").select("*").eq("id", mine.session.id);
    expect(byId.data).toEqual([]);
  });

  it("stops user B changing or deleting user A's rows", async () => {
    const update = await b.client.from("onboarding_sessions").update({ state: "review" }).eq("id", mine.session.id).select();
    expect(update.data).toEqual([]);
    const save = await b.client.rpc("save_onboarding_session", saveArgs(mine, mine.session.revision));
    expect(save.data).toBe(false);
    const removed = await b.client.from("onboarding_sessions").delete().eq("id", mine.session.id).select();
    expect(removed.data).toEqual([]);
    // Nobody but the save function writes or deletes turn results and setups.
    for (const table of ["onboarding_turn_results", "device_configurations"] as const) {
      expect((await b.client.from(table).delete().eq("session_id", mine.session.id)).error?.code).toBe(PERMISSION_DENIED);
    }
    const still = await admin.from("onboarding_sessions").select("revision, state").eq("id", mine.session.id).single();
    expect(still.data).toEqual({ revision: mine.session.revision, state: "confirmed" });
    expect((await admin.from("device_configurations").select("id").eq("session_id", mine.session.id)).data).toHaveLength(1);
  });

  it("lets an owner change setups only through the save function, numbered in order", async () => {
    // Directly, an owner can't write or delete a setup or a turn result, even their own.
    const setup = await a.client.from("device_configurations").insert({
      user_id: a.id,
      session_id: mine.session.id,
      configuration_version: 2147483647,
      catalog_version: 1,
      configuration: {},
      confirmed_at: new Date().toISOString(),
    });
    expect(setup.error?.code).toBe(PERMISSION_DENIED);
    expect((await a.client.from("device_configurations").delete().eq("id", setupId)).error?.code).toBe(PERMISSION_DENIED);
    expect((await a.client.from("onboarding_turn_results").delete().eq("session_id", mine.session.id)).error?.code).toBe(PERMISSION_DENIED);

    // Through the save function, a setup must take the owner's next number (2 here, after setup 1).
    const store = new SupabaseSessionStore({ admin, user: a.client });
    const fresh = { session: createSession(crypto.randomUUID(), new Date(), 60 * 60 * 1000, "account"), owner: mine.owner };
    await store.create(fresh);
    for (const version of [1, 3, 2147483647]) {
      const wrong = { ...fresh, session: { ...confirm(fresh.session, ["base.walker"], new Date(), version), revision: 1 } };
      expect(await store.save(wrong, 0, { configuration: wrong.session.configuration! })).toBe(false);
    }
    expect(await store.nextConfigurationVersion(mine.owner)).toBe(2);
    await a.client.from("onboarding_sessions").delete().eq("id", fresh.session.id);
  });

  it("lets the server's key save only demo rows, never an account's", async () => {
    const asServer = await admin.rpc("save_onboarding_session", saveArgs(mine, mine.session.revision));
    expect(asServer.data).toBe(false);
    const still = await admin.from("onboarding_sessions").select("revision").eq("id", mine.session.id).single();
    expect(still.data).toEqual({ revision: mine.session.revision });
  });

  it("bounds how long any write can keep a session, and when it counts as confirmed", async () => {
    const farFuture = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();
    const session = createSession(crypto.randomUUID(), new Date(), 60 * 60 * 1000, "account");
    const inserted = await a.client
      .from("onboarding_sessions")
      .insert({ id: session.id, user_id: a.id, state: "confirmed", revision: 0, catalog_version: 1, engine_state: session, expires_at: farFuture })
      .select("state, expires_at")
      .single();
    expect(inserted.error).toBeNull();
    // Not confirmed without a configuration, so the expiry job can still remove it.
    expect(inserted.data?.state).toBe("review");
    expect(Date.parse(inserted.data!.expires_at)).toBeLessThanOrEqual(Date.now() + 30 * 24 * 60 * 60 * 1000 + 6 * 60 * 1000);
    const demoRow = await admin.from("onboarding_sessions").update({ expires_at: farFuture }).eq("id", demo.id).select("expires_at").single();
    expect(Date.parse(demoRow.data!.expires_at)).toBeLessThanOrEqual(Date.now() + 66 * 60 * 1000);
    await a.client.from("onboarding_sessions").delete().eq("id", session.id);
  });

  it("stops user B writing rows in user A's name or onto A's session", async () => {
    const session = createSession(crypto.randomUUID(), new Date(), 60 * 60 * 1000, "account");
    const asA = await b.client.from("onboarding_sessions").insert({
      id: session.id,
      user_id: a.id,
      state: "collecting",
      revision: 0,
      catalog_version: session.catalog_version,
      engine_state: session,
      expires_at: session.expires_at,
    });
    expect(asA.error?.code).toBe(PERMISSION_DENIED);
    const result = await b.client
      .from("onboarding_turn_results")
      .insert({ session_id: mine.session.id, client_turn_id: crypto.randomUUID(), response: {} });
    expect(result.error?.code).toBe(PERMISSION_DENIED);
    const setup = await b.client.from("device_configurations").insert({
      user_id: b.id,
      session_id: mine.session.id,
      configuration_version: 1,
      catalog_version: 1,
      configuration: {},
      confirmed_at: new Date().toISOString(),
    });
    expect(setup.error?.code).toBe(PERMISSION_DENIED);
  });

  it("keeps demo sessions away from every signed-in user, even one who knows the token hash", async () => {
    for (const user of [a, b]) {
      const read = await user.client.from("onboarding_sessions").select("*").eq("id", demo.id);
      expect(read.data).toEqual([]);
      const save = await user.client.rpc("save_onboarding_session", saveArgs({ session: demo, owner: { kind: "demo", token_hash: "" } }, 0, hashDemoToken(demoToken)));
      expect(save.data).toBe(false);
    }
    const untouched = await admin.from("onboarding_sessions").select("revision").eq("id", demo.id).single();
    expect(untouched.data).toEqual({ revision: 0 });
  });

  it("gives an anonymous client nothing: no table and not the save function", async () => {
    for (const table of TABLES) {
      const { data, error } = await anon.from(table).select("*");
      expect(error?.code).toBe(PERMISSION_DENIED);
      expect(data).toBeNull();
      expect((await anon.from(table).insert({})).error?.code).toBe(PERMISSION_DENIED);
      expect((await anon.from(table).update({ created_at: new Date().toISOString() }).neq("created_at", "2026-10-23")).error?.code).toBe(PERMISSION_DENIED);
      expect((await anon.from(table).delete().neq("created_at", "2026-10-23")).error?.code).toBe(PERMISSION_DENIED);
    }
    const save = await anon.rpc("save_onboarding_session", saveArgs({ session: demo, owner: { kind: "demo", token_hash: "" } }, 0, hashDemoToken(demoToken)));
    expect(save.error?.code).toBe(PERMISSION_DENIED);
    const sweep = await anon.rpc("delete_expired_onboarding_sessions");
    expect(sweep.error?.code).toBe(PERMISSION_DENIED);
  });

  it("never lets a confirmed setup be edited, even by its owner or the server", async () => {
    for (const client of [a.client, admin]) {
      const { error } = await client.from("device_configurations").update({ configuration_version: 99 }).eq("id", setupId);
      expect(error?.code).toBe(PERMISSION_DENIED);
    }
  });

  it("deletes an unfinished or demo session once expired, but keeps a confirmed account setup and anything unexpired", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const server = new SupabaseSessionStore({ admin, user: null });
    const store = new SupabaseSessionStore({ admin, user: a.client });
    const stale = createSession(crypto.randomUUID(), new Date(), 60 * 60 * 1000, "account");
    await store.create({ session: { ...stale, expires_at: past }, owner: { kind: "account", user_id: a.id } });
    const live = createSession(crypto.randomUUID(), new Date(), 60 * 60 * 1000, "account");
    await store.create({ session: live, owner: { kind: "account", user_id: a.id } });
    await admin.from("onboarding_sessions").update({ expires_at: past }).eq("id", mine.session.id);
    const demoOwner = () => ({ kind: "demo" as const, token_hash: hashDemoToken(crypto.randomUUID()) });
    const expiredDemo = createSession(crypto.randomUUID(), new Date(), 60 * 60 * 1000, "demo");
    await server.create({ session: { ...expiredDemo, expires_at: past }, owner: demoOwner() });
    // A confirmed demo is still a demo: it goes an hour after its last change too.
    const confirmedDemo = createSession(crypto.randomUUID(), new Date(), 60 * 60 * 1000, "demo");
    await server.create({ session: { ...confirm(confirmedDemo, ["base.walker"], new Date()), expires_at: past }, owner: demoOwner() });

    // Run by pg_cron every five minutes as the database owner; here directly, as the server could.
    const swept = await admin.rpc("delete_expired_onboarding_sessions");
    expect(swept.error).toBeNull();
    const ids = [stale.id, live.id, expiredDemo.id, confirmedDemo.id, mine.session.id];
    const left = await admin.from("onboarding_sessions").select("id").in("id", ids);
    expect(new Set(left.data?.map((r) => r.id))).toEqual(new Set([live.id, mine.session.id]));
    await a.client.from("onboarding_sessions").delete().eq("id", live.id);
  });
}

if (localStack) {
  const stack = localStack;
  describe("row-level security (local stack)", () => rlsSuite(stack));
} else {
  describe.skip(`row-level security (${SKIP_MESSAGE})`, () => {
    it("runs against the local stack", () => {});
  });
}
