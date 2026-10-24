import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SessionView, StartSessionRequest, TurnInput } from "@walker/contracts";
import { MAX_TURNS_PER_SESSION, MemorySessionStore, OnboardingService, SupabaseSessionStore, storeBackendFromEnv, type Caller, type SessionStore } from "../src";
import { SKIP_MESSAGE, adminClient, createTestUser, deleteTestUsers, localStack, type TestUser } from "./support/local-supabase";

/** Account sessions next to demo sessions: who can reach what, setup numbering, expiry, and the store choice. */

const DEMO: StartSessionRequest = { input_mode: "text", consent: { demo_data_notice: true } };
const ACCOUNT: StartSessionRequest = { input_mode: "text", consent: { account_data_notice: true } };
const DAY = 24 * 60 * 60 * 1000;

function clockFrom(start = new Date("2026-10-23T17:00:00Z")) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

async function finish(service: OnboardingService, caller: Caller, view: SessionView): Promise<SessionView> {
  view = (await service.turn(view.session_id, caller, { client_turn_id: crypto.randomUUID(), last_seen_revision: view.revision, input: { type: "skip_rest" } })).session;
  return (await service.confirm(view.session_id, caller, { last_seen_revision: view.revision, selected_module_ids: ["base.walker"] })).session;
}

describe("account sessions (memory store)", () => {
  const alice: Caller = { user_id: "11111111-1111-4111-8111-111111111111" };
  const bob: Caller = { user_id: "22222222-2222-4222-8222-222222222222" };

  it("start the kind of session the user's notice names, and need a signed-in user for an account", async () => {
    const service = new OnboardingService(new MemorySessionStore());
    await expect(service.start(ACCOUNT, {})).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
    const account = await service.start(ACCOUNT, alice);
    expect(account.token).toBeUndefined();
    expect(account.response.session.kind).toBe("account");
    // Signed in but read the demo notice: a demo session, kept no longer than that notice said.
    const demo = await service.start(DEMO, alice);
    expect(demo.token).toEqual(expect.any(String));
    expect(demo.response.session.kind).toBe("demo");
  });

  it("are reachable by their owner from any device, and by nobody else", async () => {
    const store = new MemorySessionStore();
    const { response } = await new OnboardingService(store).start(ACCOUNT, alice);
    const id = response.session.session_id;
    const demo = await new OnboardingService(store).start(DEMO, {});

    // A new service over the same store: a refresh, another instance, or another device.
    const later = new OnboardingService(store);
    await expect(later.get(id, alice)).resolves.toMatchObject({ session: { session_id: id, kind: "account" } });
    await expect(later.get(id, bob)).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(later.get(id, { token: demo.token! })).rejects.toMatchObject({ code: "not_found" });
    await expect(later.get(id, {})).rejects.toMatchObject({ code: "not_found" });
    // A demo session needs its cookie; being signed in isn't enough.
    await expect(later.get(demo.response.session.session_id, alice)).rejects.toMatchObject({ code: "not_found" });
    await expect(later.get(demo.response.session.session_id, { ...alice, token: demo.token! })).resolves.toBeDefined();
    await expect(later.remove(id, bob)).rejects.toMatchObject({ code: "not_found" });
    await expect(later.get(id, alice)).resolves.toBeDefined();
  });

  it("number each owner's confirmed setups 1, 2, 3", async () => {
    const service = new OnboardingService(new MemorySessionStore());
    const versions = [];
    for (const caller of [alice, alice, bob]) {
      const { response } = await service.start(ACCOUNT, caller);
      const saved = await finish(service, caller, response.session);
      expect(saved.configuration?.source).toBe("account");
      versions.push(saved.configuration?.configuration_version);
    }
    expect(versions).toEqual([1, 2, 1]);
    const demo = await service.start(DEMO, {});
    expect((await finish(service, { token: demo.token! }, demo.response.session)).configuration).toMatchObject({ configuration_version: 1, source: "demo" });
  });

  it("expire 30 days after the last change unless confirmed", async () => {
    const clock = clockFrom();
    const store = new MemorySessionStore(clock.now);
    const service = new OnboardingService(store, { now: clock.now });
    const open = (await service.start(ACCOUNT, alice)).response.session;
    const done = await finish(service, alice, (await service.start(ACCOUNT, alice)).response.session);
    clock.advance(29 * DAY);
    await expect(service.get(open.session_id, alice)).resolves.toBeDefined();
    clock.advance(2 * DAY);
    const skip: TurnInput = { type: "skip", question_id: "tasks" };
    await expect(service.turn(open.session_id, alice, { client_turn_id: crypto.randomUUID(), last_seen_revision: open.revision, input: skip })).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(service.get(done.session_id, alice)).resolves.toMatchObject({ session: { state: "confirmed" } });
    await expect(service.turn(done.session_id, alice, { client_turn_id: crypto.randomUUID(), last_seen_revision: done.revision, input: { type: "skip_rest" } })).rejects.toMatchObject({
      code: "session_confirmed",
    });
  });

  it("stop growing past the turn cap", async () => {
    const service = new OnboardingService(new MemorySessionStore());
    let view = (await service.start(ACCOUNT, alice)).response.session;
    while (view.turns.length < MAX_TURNS_PER_SESSION) {
      view = (await service.turn(view.session_id, alice, { client_turn_id: crypto.randomUUID(), last_seen_revision: view.revision, input: { type: "revisit", question_id: "tasks" } })).session;
    }
    await expect(
      service.turn(view.session_id, alice, { client_turn_id: crypto.randomUUID(), last_seen_revision: view.revision, input: { type: "revisit", question_id: "tasks" } }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 422 });
    // "Skip the rest" still works, so what is there can be reviewed and saved.
    view = (await service.turn(view.session_id, alice, { client_turn_id: crypto.randomUUID(), last_seen_revision: view.revision, input: { type: "skip_rest" } })).session;
    await expect(service.confirm(view.session_id, alice, { last_seen_revision: view.revision, selected_module_ids: ["base.walker"] })).resolves.toBeDefined();
  });

  it("refuse to start when the server says so", async () => {
    const service = new OnboardingService(new MemorySessionStore(), { startBlocked: "No database." });
    await expect(service.start(DEMO, {})).rejects.toMatchObject({ code: "unavailable", status: 503, message: "No database." });
  });
});

describe("storeBackendFromEnv", () => {
  const supabase = {
    NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:55421",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
    SUPABASE_SECRET_KEY: "sb_secret_test",
  };
  /** "supabase", "memory", or "blocked" when onboarding would refuse to start. */
  function choice(env: Record<string, string | undefined>, warn: (m: string) => void = () => {}) {
    const backend = storeBackendFromEnv(env, warn);
    return backend.kind === "memory" && backend.startBlocked ? "blocked" : backend.kind;
  }

  it("uses memory without Supabase variables, but blocks onboarding in production unless allowed", () => {
    expect(choice({})).toBe("memory");
    expect(choice({ NODE_ENV: "development" })).toBe("memory");
    expect(choice({ NODE_ENV: "production" })).toBe("blocked");
    expect(choice({ NODE_ENV: "production", ONBOARDING_ALLOW_MEMORY_STORE: "true" })).toBe("memory");
    expect(choice({ NODE_ENV: "production", ONBOARDING_ALLOW_MEMORY_STORE: "yes" })).toBe("blocked");
  });

  it("uses Supabase with all three variables, and refuses a partial setup by name", () => {
    expect(choice({ ...supabase, NODE_ENV: "production" })).toBe("supabase");
    const warnings: string[] = [];
    expect(choice({ ...supabase, SUPABASE_SECRET_KEY: " " }, (m) => warnings.push(m))).toBe("blocked");
    expect(warnings.join(" ")).toContain("SUPABASE_SECRET_KEY");
    expect(warnings.join(" ")).not.toContain("sb_");
  });
});

if (localStack) {
  const stack = localStack;
  describe("onboarding over the Supabase store (local stack)", () => {
    let alice: TestUser;
    let bob: TestUser;
    const demoIds: string[] = [];
    const storeFor = (user: TestUser | null): SessionStore => new SupabaseSessionStore({ admin: adminClient(stack), user: user?.client ?? null });

    beforeAll(async () => {
      [alice, bob] = [await createTestUser(stack, "service-a"), await createTestUser(stack, "service-b")];
    });
    afterAll(async () => {
      if (demoIds.length > 0) await adminClient(stack).from("onboarding_sessions").delete().in("id", demoIds);
      await deleteTestUsers(stack, [alice, bob]);
    });

    it("runs an account conversation to a saved setup that survives a new instance", async () => {
      const caller = { user_id: alice.id };
      const service = new OnboardingService(storeFor(alice));
      let view = (await service.start(ACCOUNT, caller)).response.session;
      const request = { client_turn_id: crypto.randomUUID(), last_seen_revision: view.revision, input: { type: "answer", question_id: "tasks", option_ids: ["obstacles"] } as TurnInput };
      const first = await service.turn(view.session_id, caller, request);
      // A retry gets the stored response, even on a fresh instance.
      expect(await new OnboardingService(storeFor(alice)).turn(view.session_id, caller, request)).toEqual(first);
      view = await finish(service, caller, first.session);
      expect(view.configuration).toMatchObject({ configuration_version: 1, source: "account" });

      const reopened = await new OnboardingService(storeFor(alice)).get(view.session_id, caller);
      expect(reopened.session).toEqual(view);
      const { data } = await alice.client.from("device_configurations").select("configuration_version, configuration, session_id");
      expect(data).toEqual([{ configuration_version: 1, configuration: view.configuration, session_id: view.session_id }]);
      await expect(new OnboardingService(storeFor(bob)).get(view.session_id, { user_id: bob.id })).rejects.toMatchObject({ code: "not_found" });

      // Deleting the session deletes its setup.
      await service.remove(view.session_id, caller);
      expect((await alice.client.from("device_configurations").select("id")).data).toEqual([]);
    });

    it("tells an account owner their unfinished setup expired, rather than that it's missing", async () => {
      const caller = { user_id: alice.id };
      const service = new OnboardingService(storeFor(alice));
      const view = (await service.start(ACCOUNT, caller)).response.session;
      await adminClient(stack).from("onboarding_sessions").update({ expires_at: new Date(Date.now() - 1000).toISOString() }).eq("id", view.session_id);
      await expect(
        service.turn(view.session_id, caller, { client_turn_id: crypto.randomUUID(), last_seen_revision: view.revision, input: { type: "skip_rest" } }),
      ).rejects.toMatchObject({ code: "session_expired", status: 410, message: expect.stringContaining("30 days") });
      await service.remove(view.session_id, caller);
    });

    it("refuses a new demo once the live demo sessions reach the cap", async () => {
      const { count } = await adminClient(stack).from("onboarding_sessions").select("id", { count: "exact", head: true }).is("user_id", null).gt("expires_at", new Date().toISOString());
      const live = count ?? 0;
      const full = new OnboardingService(new SupabaseSessionStore({ admin: adminClient(stack), user: null }, { maxLiveDemoSessions: live }));
      await expect(full.start(DEMO, {})).rejects.toMatchObject({ code: "unavailable", status: 503 });
      const room = new OnboardingService(new SupabaseSessionStore({ admin: adminClient(stack), user: null }, { maxLiveDemoSessions: live + 1 }));
      const { response } = await room.start(DEMO, {});
      demoIds.push(response.session.session_id);
    });

    it("lets only one of two overlapping turns land", async () => {
      const service = new OnboardingService(storeFor(null));
      const { token, response } = await service.start(DEMO, {});
      demoIds.push(response.session.session_id);
      const turn = (text: string) =>
        service.turn(response.session.session_id, { token }, { client_turn_id: crypto.randomUUID(), last_seen_revision: 0, input: { type: "text", text } });
      const results = await Promise.allSettled([turn("at home"), turn("outside")]);
      expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "revision_conflict", status: 409 } });
      expect((await service.get(response.session.session_id, { token })).session.revision).toBe(1);
    });
  });
} else {
  describe.skip(`onboarding over the Supabase store (${SKIP_MESSAGE})`, () => {
    it("runs against the local stack", () => {});
  });
}
