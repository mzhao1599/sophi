import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TurnResponse } from "@walker/contracts";
import { MemorySessionStore, SupabaseSessionStore, hashDemoToken, type SessionOwner, type SessionStore, type StoredSession } from "../src";
import { confirm, createSession, toView, type EngineSession } from "../src/onboarding/engine";
import { SKIP_MESSAGE, adminClient, createTestUser, deleteTestUsers, localStack, type TestUser } from "./support/local-supabase";

/**
 * The SessionStore contract, run against both stores: the in-memory one always, the Supabase one
 * when the local stack is up (`pnpm test:db`).
 */

interface Harness {
  /** The store as user A's request builds it; it also serves demo sessions. */
  forA: SessionStore;
  /** The store as user B's request builds it. */
  forB: SessionStore;
  a: SessionOwner;
  b: SessionOwner;
  /** Demo session ids to clean up afterwards (account sessions go with their users). */
  demoIds: string[];
}

const HOUR = 60 * 60 * 1000;
const now = () => new Date();

function demoOwner(): SessionOwner {
  return { kind: "demo", token_hash: hashDemoToken(crypto.randomUUID()) };
}

function newSession(h: Harness, owner: SessionOwner): StoredSession {
  const session = createSession(crypto.randomUUID(), now(), HOUR, owner.kind);
  if (owner.kind === "demo") h.demoIds.push(session.id);
  return { session, owner };
}

function next(record: StoredSession, change: (s: EngineSession) => EngineSession = (s) => s): StoredSession {
  const session = change(record.session);
  return { ...record, session: { ...session, revision: record.session.revision + 1 } };
}

function responseFor(session: EngineSession): TurnResponse {
  return { session: toView(session, now()), assistant_text: "Noted.", ack: "Noted.", needs_user_confirmation: false };
}

function describeStore(name: string, setup: () => Promise<Harness>, teardown: (h: Harness) => Promise<void> = async () => {}) {
  describe(`SessionStore contract: ${name}`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await setup();
    });
    afterAll(async () => {
      if (h) await teardown(h);
    });

    it("returns a session only to its owner", async () => {
      const demo = newSession(h, demoOwner());
      await h.forA.create(demo);
      expect((await h.forA.get(demo.session.id, demo.owner))?.session).toEqual(demo.session);
      expect(await h.forA.get(demo.session.id, demoOwner())).toBeUndefined();
      expect(await h.forA.get(demo.session.id, h.a)).toBeUndefined();

      const mine = newSession(h, h.a);
      await h.forA.create(mine);
      expect((await h.forA.get(mine.session.id, h.a))?.session).toEqual(mine.session);
      expect(await h.forB.get(mine.session.id, h.b)).toBeUndefined();
      expect(await h.forA.get(mine.session.id, demo.owner)).toBeUndefined();
      expect(await h.forA.get("not-a-session-id", h.a)).toBeUndefined();
    });

    it("saves only from the revision it read", async () => {
      for (const owner of [demoOwner(), h.a]) {
        const record = newSession(h, owner);
        await h.forA.create(record);
        const first = next(record);
        expect(await h.forA.save(first, 0)).toBe(true);
        expect(await h.forA.save(next(record), 0)).toBe(false);
        expect((await h.forA.get(record.session.id, owner))?.session.revision).toBe(1);
      }
    });

    it("lets exactly one of two overlapping saves land", async () => {
      for (const owner of [demoOwner(), h.a]) {
        const record = newSession(h, owner);
        await h.forA.create(record);
        const results = await Promise.all([h.forA.save(next(record), 0), h.forA.save(next(record), 0)]);
        expect(results.filter(Boolean)).toHaveLength(1);
      }
    });

    it("keeps a turn's response with the save, for the owner only", async () => {
      for (const [owner, other] of [
        [demoOwner(), demoOwner()],
        [h.a, demoOwner()],
      ] as const) {
        const record = newSession(h, owner);
        await h.forA.create(record);
        const saved = next(record);
        const turnId = crypto.randomUUID();
        const response = responseFor(saved.session);
        expect(await h.forA.save(saved, 0, { turn: { client_turn_id: turnId, response } })).toBe(true);
        expect(await h.forA.getResponse(record.session.id, owner, turnId)).toEqual(response);
        expect(await h.forA.getResponse(record.session.id, other, turnId)).toBeUndefined();
        expect(await h.forA.getResponse(record.session.id, owner, crypto.randomUUID())).toBeUndefined();

        // A save that loses the race records nothing.
        const lostId = crypto.randomUUID();
        expect(await h.forA.save(next(record), 0, { turn: { client_turn_id: lostId, response } })).toBe(false);
        expect(await h.forA.getResponse(record.session.id, owner, lostId)).toBeUndefined();
      }
    });

    it("numbers an account's setups 1, 2, 3 and refuses a duplicate number", async () => {
      const confirmWith = async (version: number) => {
        const record = newSession(h, h.a);
        await h.forA.create(record);
        const saved = next(record, (s) => confirm(s, ["base.walker"], now(), version));
        return h.forA.save(saved, 0, { configuration: saved.session.configuration! });
      };
      const first = await h.forA.nextConfigurationVersion(h.a);
      expect(await confirmWith(first)).toBe(true);
      expect(await h.forA.nextConfigurationVersion(h.a)).toBe(first + 1);
      expect(await confirmWith(first)).toBe(false);
      expect(await h.forA.nextConfigurationVersion(h.a)).toBe(first + 1);
      expect(await h.forB.nextConfigurationVersion(h.b)).toBe(1);
      expect(await h.forA.nextConfigurationVersion(demoOwner())).toBe(1);
    });

    it("deletes only for the owner, with the session's turn results", async () => {
      for (const owner of [demoOwner(), h.a]) {
        const record = newSession(h, owner);
        await h.forA.create(record);
        const turnId = crypto.randomUUID();
        await h.forA.save(next(record), 0, { turn: { client_turn_id: turnId, response: responseFor(record.session) } });
        await h.forA.delete(record.session.id, demoOwner());
        await h.forB.delete(record.session.id, h.b);
        expect(await h.forA.get(record.session.id, owner)).toBeDefined();
        await h.forA.delete(record.session.id, owner);
        expect(await h.forA.get(record.session.id, owner)).toBeUndefined();
        expect(await h.forA.getResponse(record.session.id, owner, turnId)).toBeUndefined();
      }
    });
  });
}

describeStore("memory", async () => {
  const store = new MemorySessionStore();
  return {
    forA: store,
    forB: store,
    a: { kind: "account", user_id: crypto.randomUUID() },
    b: { kind: "account", user_id: crypto.randomUUID() },
    demoIds: [],
  };
});

if (localStack) {
  const stack = localStack;
  let users: TestUser[] = [];
  describeStore(
    "supabase (local stack)",
    async () => {
      users = [await createTestUser(stack, "store-a"), await createTestUser(stack, "store-b")];
      const [a, b] = users as [TestUser, TestUser];
      const admin = adminClient(stack);
      return {
        forA: new SupabaseSessionStore({ admin, user: a.client }),
        forB: new SupabaseSessionStore({ admin, user: b.client }),
        a: { kind: "account", user_id: a.id },
        b: { kind: "account", user_id: b.id },
        demoIds: [],
      };
    },
    async (h) => {
      if (h.demoIds.length > 0) await adminClient(stack).from("onboarding_sessions").delete().in("id", h.demoIds);
      await deleteTestUsers(stack, users);
    },
  );
} else {
  describe.skip(`SessionStore contract: supabase (${SKIP_MESSAGE})`, () => {
    it("runs against the local stack", () => {});
  });
}
