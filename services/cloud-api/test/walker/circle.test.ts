import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CIRCLE_ERROR_STATUS,
  CIRCLE_INVITE_TTL_MS,
  CIRCLE_MESSAGE_RETENTION_MS,
  MAX_LIVE_MESSAGES,
  PAIRING_MAX_WRONG,
  PHONE_JOIN_TTL_MS,
  PhoneHomeResponseSchema,
  WALKER_SETUP,
  type CircleErrorCode,
  type PhoneHomeResponse,
} from "@walker/contracts";
import { CIRCLE_SWEEP_EVERY_MS, CircleService, WalkerService, isCircleError, isWalkerError, type MemberCaller, type MessageEvent, type OwnerCaller } from "../../src";
import { Clock, SKIP_POSTGRES, SKIP_SPACETIME, manifest, memoryHarness, postgresHarness, snapshot, spacetimeHarness, spacetimeTestServer, turn, uuid, walkerTestDatabaseUrl, type StoreHarness } from "./support";

/**
 * The two-phone circle (circle.ts, "The two-phone app"), against the in-memory store, Postgres, and SpacetimeDB
 * (SpacetimeCircleStore over the care-db module, with the walker's own rows in memory).
 * Expected, written before the run:
 * - her own phone is in on the code alone; a caretaker waits for the owner's approval, which lapses after 5 minutes;
 * - owner routes need the owner's own walker; member calls need a known cookie;
 * - wrong codes lock an address after PAIRING_MAX_WRONG, with a count apart from pairing's;
 * - a phone's view has no conversation, no walker lines, no zones and no timestamps (a waiting join's expiry aside);
 * - messages: a caretaker types, her phone sends presets; idempotent; newest 20 kept; gone after 24 h;
 *   removing either phone deletes them from storage at once; the log carries lengths only.
 */

async function rejects(promise: Promise<unknown>, code: CircleErrorCode) {
  try {
    await promise;
  } catch (error) {
    if (!isCircleError(error)) throw error;
    expect(error.code).toBe(code);
    expect(error.status).toBe(CIRCLE_ERROR_STATUS[code]);
    return error;
  }
  throw new Error(`Expected ${code}, but it succeeded.`);
}

const owner = (secret: string | undefined): OwnerCaller => ({ kind: "owner", secret });
const phone = (secret: string | undefined): MemberCaller => ({ kind: "member", secret });

/** Every key in a JSON value, at any depth. */
function keys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keys);
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [k, ...keys(v)]);
  return [];
}

function describeCircle(name: string, makeHarness: () => Promise<StoreHarness>) {
  describe(`circle service: ${name}`, () => {
    let h: StoreHarness;
    let clock: Clock;
    let walkers: WalkerService;
    let circle: CircleService;
    let messages: MessageEvent[];

    beforeAll(async () => {
      h = await makeHarness();
    });
    afterAll(async () => {
      if (h) await h.close();
    });
    beforeEach(async () => {
      await h.reset();
      clock = new Clock();
      messages = [];
      walkers = new WalkerService(h.store(), { now: clock.now });
      circle = new CircleService(h.store(), { now: clock.now, onMessage: (e) => void messages.push(e) });
    });

    async function pairWalker(address = "203.0.113.10") {
      const { secret, response } = await walkers.createPairingCode(owner(undefined));
      const paired = await walkers.pair({ code: response.code, service_version: "pi-0.1.0", name: "Rose's walker" }, address);
      return { secret, deviceId: paired.device_id, credential: paired.credential };
    }

    async function heartbeat(w: { deviceId: string; credential: string }) {
      await walkers.heartbeat({ kind: "device", credential: w.credential }, w.deviceId, {
        sent_at: clock.iso(-15),
        service_version: "pi-0.1.0",
        manifest: manifest(clock),
        snapshot: snapshot(clock),
        events: [{ event_id: uuid(), kind: "notice", text: "Rose is at the bakery on Elm Street.", ago_ms: 1_000 }],
      });
    }

    async function addAndJoin(w: { secret: string; deviceId: string }, role: "walker_user" | "caregiver", who: string, address = "198.51.100.7") {
      const { invite } = await circle.addPhone(owner(w.secret), w.deviceId, { name: who, role });
      const joined = await circle.join(phone(undefined), { code: invite.code, consent: { circle_data_notice: true } }, address);
      return { secret: joined.secret, home: joined.home };
    }

    /** Her phone and an approved caretaker. */
    async function twoPhones() {
      const w = await pairWalker();
      await heartbeat(w);
      const rose = await addAndJoin(w, "walker_user", "Rose");
      const maya = await addAndJoin(w, "caregiver", "Maya");
      const waiting = await circle.ownerCircle(owner(w.secret), w.deviceId);
      await circle.approveJoin(owner(w.secret), w.deviceId, waiting.joins[0]!.member_id, { consent: { walker_user_agreed: true } });
      const roseHome = member(await circle.home(phone(rose.secret)));
      const mayaHome = member(await circle.home(phone(maya.secret)));
      return { w, rose: { ...rose, id: roseHome.me.member_id }, maya: { ...maya, id: mayaHome.me.member_id } };
    }

    function member(home: PhoneHomeResponse) {
      if (home.membership !== "member") throw new Error(`Expected a member, got ${home.membership}.`);
      return home;
    }

    // ---- Joining ----

    it("lets her own phone in on the owner's code alone, with alerts and no part health", async () => {
      const w = await pairWalker();
      await heartbeat(w);
      const rose = await addAndJoin(w, "walker_user", "Rose");
      const home = member(rose.home);
      expect(home.me).toMatchObject({ name: "Rose", role: "walker_user" });
      expect(home.walker).toEqual({ walker_name: "Rose's walker", online: true, simulator: true, alerts: [...WALKER_SETUP.cues], parts: null, battery: "not_measured" });
      expect(home.people.map((p) => p.name)).toEqual(["Rose"]);
    });

    it("keeps a caretaker waiting until the owner approves, then shows part health", async () => {
      const w = await pairWalker();
      await heartbeat(w);
      const maya = await addAndJoin(w, "caregiver", "Maya");
      expect(maya.home).toEqual({ membership: "waiting", name: "Maya", role: "caregiver", expires_at: clock.iso(PHONE_JOIN_TTL_MS) });
      await rejects(circle.sendMessage(phone(maya.secret), { client_message_id: uuid(), text: "Hi" }), "not_allowed");
      const before = await circle.ownerCircle(owner(w.secret), w.deviceId);
      expect(before.members).toEqual([]);
      expect(before.joins).toEqual([{ member_id: expect.any(String), name: "Maya", role: "caregiver", expires_at: clock.iso(PHONE_JOIN_TTL_MS) }]);
      clock.advance(60_000);
      const { member: approved } = await circle.approveJoin(owner(w.secret), w.deviceId, before.joins[0]!.member_id, { consent: { walker_user_agreed: true } });
      expect(approved).toMatchObject({ name: "Maya", role: "caregiver", joined_at: clock.iso() });
      // A minute without a heartbeat: offline, and every part reads unavailable, as on the owner's page.
      const offline = member(await circle.home(phone(maya.secret)));
      expect(offline.walker.online).toBe(false);
      expect(new Set(offline.walker.parts!.map((p) => p.health))).toEqual(new Set(["unavailable"]));
      await heartbeat(w);
      const home = member(await circle.home(phone(maya.secret)));
      expect(home.walker.online).toBe(true);
      const health = Object.fromEntries((home.walker.parts ?? []).map((p) => [p.module_id, p.health]));
      expect(health).toMatchObject({ "controls.hand": "ok", "perception.tof": "degraded" });
      // Approving again (a retried tap) answers with the member as it is.
      clock.advance(1_000);
      const again = await circle.approveJoin(owner(w.secret), w.deviceId, before.joins[0]!.member_id, { consent: { walker_user_agreed: true } });
      expect(again.member).toEqual(approved);
      // Another walker's owner still can't.
      const other = await pairWalker("203.0.113.12");
      await rejects(circle.approveJoin(owner(other.secret), other.deviceId, before.joins[0]!.member_id, { consent: { walker_user_agreed: true } }), "not_found");
    });

    it("lets a caretaker's join lapse unapproved after 5 minutes", async () => {
      const w = await pairWalker();
      const maya = await addAndJoin(w, "caregiver", "Maya");
      const id = (await circle.ownerCircle(owner(w.secret), w.deviceId)).joins[0]!.member_id;
      clock.advance(PHONE_JOIN_TTL_MS);
      expect(await circle.home(phone(maya.secret))).toEqual({ membership: "no_answer", name: "Maya" });
      expect((await circle.ownerCircle(owner(w.secret), w.deviceId)).joins).toEqual([]);
      await rejects(circle.approveJoin(owner(w.secret), w.deviceId, id, { consent: { walker_user_agreed: true } }), "not_found");
    });

    it("uses a code once, and not after 10 minutes", async () => {
      const w = await pairWalker();
      const { invite } = await circle.addPhone(owner(w.secret), w.deviceId, { name: "Rose", role: "walker_user" });
      expect(invite).toMatchObject({ name: "Rose", role: "walker_user", code: expect.stringMatching(/^\d{6}$/), expires_at: clock.iso(CIRCLE_INVITE_TTL_MS) });
      await circle.join(phone(undefined), { code: invite.code, consent: { circle_data_notice: true } }, "a");
      await rejects(circle.join(phone(undefined), { code: invite.code, consent: { circle_data_notice: true } }, "a"), "invite_code_invalid");
      const late = await circle.addPhone(owner(w.secret), w.deviceId, { name: "Maya", role: "caregiver" });
      clock.advance(CIRCLE_INVITE_TTL_MS);
      await rejects(circle.join(phone(undefined), { code: late.invite.code, consent: { circle_data_notice: true } }, "a"), "invite_code_invalid");
    });

    it("gives two joins of one code at once one phone", async () => {
      const w = await pairWalker();
      const { invite } = await circle.addPhone(owner(w.secret), w.deviceId, { name: "Rose", role: "walker_user" });
      const join = (address: string) => circle.join(phone(undefined), { code: invite.code, consent: { circle_data_notice: true } }, address).then(() => "in", (e) => (isCircleError(e) ? e.code : "error"));
      const results = await Promise.all([join("a"), join("b"), join("c")]);
      expect(results.filter((r) => r === "in")).toHaveLength(1);
      expect(results.filter((r) => r !== "in").every((r) => r === "invite_code_invalid")).toBe(true);
    });

    it("keeps one phone of hers per walker", async () => {
      const w = await pairWalker();
      await addAndJoin(w, "walker_user", "Rose");
      await rejects(circle.addPhone(owner(w.secret), w.deviceId, { name: "Rose", role: "walker_user" }), "circle_full");
    });

    it("locks an address out after the wrong-code limit, apart from pairing's count", async () => {
      const w = await pairWalker();
      const { invite } = await circle.addPhone(owner(w.secret), w.deviceId, { name: "Maya", role: "caregiver" });
      const wrong = invite.code === "000000" ? "000001" : "000000";
      for (let i = 0; i < PAIRING_MAX_WRONG; i++) {
        await rejects(circle.join(phone(undefined), { code: wrong, consent: { circle_data_notice: true } }, "198.51.100.66"), "invite_code_invalid");
      }
      // Locked, even with the right code.
      await rejects(circle.join(phone(undefined), { code: invite.code, consent: { circle_data_notice: true } }, "198.51.100.66"), "invite_locked");
      // Pairing from the same address still has its own count.
      try {
        await walkers.pair({ code: wrong, service_version: "pi" }, "198.51.100.66");
        throw new Error("Expected a refusal.");
      } catch (error) {
        expect(isWalkerError(error) && error.code).toBe("pairing_code_invalid");
      }
      // Another address is unaffected, and the code is still good.
      const joined = await circle.join(phone(undefined), { code: invite.code, consent: { circle_data_notice: true } }, "198.51.100.67");
      expect(joined.home.membership).toBe("waiting");
    });

    it("lets only the walker's owner manage its phones; others read as not found", async () => {
      const w = await pairWalker();
      const other = await pairWalker("203.0.113.11");
      await rejects(circle.ownerCircle(owner(undefined), w.deviceId), "unauthenticated");
      await rejects(circle.ownerCircle(owner("not-a-secret"), w.deviceId), "unauthenticated");
      await rejects(circle.ownerCircle(owner(other.secret), w.deviceId), "not_found");
      await rejects(circle.addPhone(owner(other.secret), w.deviceId, { name: "Eve", role: "caregiver" }), "not_found");
      const rose = await addAndJoin(w, "walker_user", "Rose");
      const roseId = member(rose.home).me.member_id;
      await rejects(circle.removeMember(owner(other.secret), w.deviceId, roseId), "not_found");
      await rejects(circle.removeMember(owner(other.secret), other.deviceId, roseId), "not_found");
      // A phone's cookie isn't an owner's.
      await rejects(circle.ownerCircle(owner(rose.secret), w.deviceId), "not_found");
      // And an owner's secret isn't a phone's.
      await rejects(circle.home(phone(w.secret)), "unauthenticated");
      await rejects(circle.home(phone(undefined)), "unauthenticated");
    });

    it("shows a phone no conversation, walker lines, zones or timestamps", async () => {
      const { w, rose, maya } = await twoPhones();
      await h.store().saveTurn(w.deviceId, turn(clock, { heard: "Where did I leave my pills?" }), null, clock.now());
      await circle.sendMessage(phone(maya.secret), { client_message_id: uuid(), text: "Lunch at noon?" });
      for (const secret of [rose.secret, maya.secret]) {
        const home = member(await circle.home(phone(secret)));
        expect(PhoneHomeResponseSchema.safeParse(home).success).toBe(true);
        const text = JSON.stringify(home);
        expect(text).not.toContain("pills");
        expect(text).not.toContain("buzzing");
        expect(text).not.toContain("bakery");
        const all = keys(home);
        expect(all).not.toContain("mm");
        expect(all.filter((k) => k.endsWith("_at"))).toEqual([]);
        expect(all).not.toContain("turns");
        expect(all).not.toContain("walker_said");
        expect(all).not.toContain("zones");
        expect(all).not.toContain("open_proposal");
      }
    });

    // ---- Messages ----

    it("carries a caretaker's typed message to her phone and her preset back", async () => {
      const { rose, maya } = await twoPhones();
      const id = uuid();
      const sent = await circle.sendMessage(phone(maya.secret), { client_message_id: id, text: "Lunch at noon?" });
      expect(sent.message).toMatchObject({ from_name: "Maya", to_member_id: rose.id, text: "Lunch at noon?", mine: true });
      // A retry gets the same message back, and saves nothing new.
      const again = await circle.sendMessage(phone(maya.secret), { client_message_id: id, text: "Lunch at noon?" });
      expect(again.message.message_id).toBe(sent.message.message_id);
      await circle.sendMessage(phone(rose.secret), { client_message_id: uuid(), preset: "okay", to_member_id: maya.id });
      const roseHome = member(await circle.home(phone(rose.secret)));
      expect(roseHome.messages.map((m) => [m.from_name, m.text, m.mine])).toEqual([
        ["Maya", "Lunch at noon?", false],
        ["Rose", "I'm okay", true],
      ]);
      expect(member(await circle.home(phone(maya.secret))).messages).toHaveLength(2);
      // The log line has the length, never the words.
      expect(messages.map((m) => [m.from_role, m.length, m.created])).toEqual([
        ["caregiver", 14, true],
        ["caregiver", 14, false],
        ["walker_user", 8, true],
      ]);
      expect(JSON.stringify(messages)).not.toContain("Lunch");
    });

    it("refuses the wrong kind of message for a phone, and a recipient that isn't a caretaker", async () => {
      const { rose, maya } = await twoPhones();
      await rejects(circle.sendMessage(phone(rose.secret), { client_message_id: uuid(), text: "typed" }), "not_allowed");
      await rejects(circle.sendMessage(phone(maya.secret), { client_message_id: uuid(), preset: "okay", to_member_id: rose.id }), "not_allowed");
      await rejects(circle.sendMessage(phone(rose.secret), { client_message_id: uuid(), preset: "okay", to_member_id: rose.id }), "not_found");
      await rejects(circle.sendMessage(phone(rose.secret), { client_message_id: uuid(), preset: "okay", to_member_id: uuid() }), "not_found");
    });

    it("tells a caretaker there's no one to message before her phone joins", async () => {
      const w = await pairWalker();
      const maya = await addAndJoin(w, "caregiver", "Maya");
      const id = (await circle.ownerCircle(owner(w.secret), w.deviceId)).joins[0]!.member_id;
      await circle.approveJoin(owner(w.secret), w.deviceId, id, { consent: { walker_user_agreed: true } });
      await rejects(circle.sendMessage(phone(maya.secret), { client_message_id: uuid(), text: "Hi" }), "not_found");
    });

    it("keeps a walker's newest 20 messages, and none past 24 hours", async () => {
      const { rose, maya } = await twoPhones();
      const firstId = uuid();
      for (let i = 1; i <= MAX_LIVE_MESSAGES + 2; i++) {
        clock.advance(1_000);
        await circle.sendMessage(phone(maya.secret), { client_message_id: i === 1 ? firstId : uuid(), text: `Note ${i}` });
      }
      const kept = member(await circle.home(phone(rose.secret))).messages.map((m) => m.text);
      expect(kept).toHaveLength(MAX_LIVE_MESSAGES);
      expect(kept[0]).toBe("Note 3");
      expect(kept.at(-1)).toBe(`Note ${MAX_LIVE_MESSAGES + 2}`);
      // The cleared ones' words are gone from storage, and a retry of one isn't saved again.
      expect(await h.dump()).not.toMatch(/"text": ?"Note 1"/);
      await rejects(circle.sendMessage(phone(maya.secret), { client_message_id: firstId, text: "Note 1" }), "message_limit");
      expect(member(await circle.home(phone(rose.secret))).messages.map((m) => m.text)).toEqual(kept);
      clock.advance(CIRCLE_MESSAGE_RETENTION_MS - 1_000);
      // One second before the newest turns 24 hours old: the older ones are gone, the newest is kept.
      expect(member(await circle.home(phone(rose.secret))).messages.length).toBeLessThan(MAX_LIVE_MESSAGES);
      clock.advance(1_000);
      expect(member(await circle.home(phone(rose.secret))).messages).toEqual([]);
      // Hidden at once; deleted by the next sweep, which runs at most once a minute.
      expect(await h.dump()).toContain(`Note ${MAX_LIVE_MESSAGES + 2}`);
      clock.advance(CIRCLE_SWEEP_EVERY_MS);
      await circle.home(phone(rose.secret));
      expect(await h.dump()).not.toContain("Note ");
    });

    it("deletes every message to or from a phone when the owner removes it, and its cookie stops working", async () => {
      const { w, rose, maya } = await twoPhones();
      await circle.sendMessage(phone(maya.secret), { client_message_id: uuid(), text: "Lunch at noon?" });
      await circle.sendMessage(phone(rose.secret), { client_message_id: uuid(), preset: "call_me", to_member_id: maya.id });
      expect(await h.dump()).toContain("Lunch at noon?");
      await circle.removeMember(owner(w.secret), w.deviceId, maya.id);
      const dump = await h.dump();
      expect(dump).not.toContain("Lunch at noon?");
      expect(dump).not.toContain("Can you call me?");
      await rejects(circle.home(phone(maya.secret)), "unauthenticated");
      expect(member(await circle.home(phone(rose.secret))).messages).toEqual([]);
      await rejects(circle.removeMember(owner(w.secret), w.deviceId, maya.id), "not_found");
    });

    it("lets the owner decline a waiting caretaker by removing it", async () => {
      const w = await pairWalker();
      const maya = await addAndJoin(w, "caregiver", "Maya");
      const id = (await circle.ownerCircle(owner(w.secret), w.deviceId)).joins[0]!.member_id;
      await circle.removeMember(owner(w.secret), w.deviceId, id);
      await rejects(circle.home(phone(maya.secret)), "unauthenticated");
    });

    it("moves a phone that joins again out of its old membership only once the new one is approved", async () => {
      const { w, rose, maya } = await twoPhones();
      await circle.sendMessage(phone(maya.secret), { client_message_id: uuid(), text: "Lunch at noon?" });
      const { invite } = await circle.addPhone(owner(w.secret), w.deviceId, { name: "Maya", role: "caregiver" });
      const again = await circle.join(phone(maya.secret), { code: invite.code, consent: { circle_data_notice: true } }, "a");
      expect(again.secret).not.toBe(maya.secret);
      expect(again.home.membership).toBe("waiting");
      // Waiting: the old membership and the thread with her phone are untouched.
      expect(member(await circle.home(phone(maya.secret))).me.name).toBe("Maya");
      expect(member(await circle.home(phone(rose.secret))).messages.map((m) => m.text)).toEqual(["Lunch at noon?"]);
      const waiting = (await circle.ownerCircle(owner(w.secret), w.deviceId)).joins[0]!;
      await circle.approveJoin(owner(w.secret), w.deviceId, waiting.member_id, { consent: { walker_user_agreed: true } });
      // In: the old one is gone, with its messages.
      await rejects(circle.home(phone(maya.secret)), "unauthenticated");
      expect(member(await circle.home(phone(again.secret))).me.member_id).toBe(waiting.member_id);
      // Both joined at the same instant of the test clock, so their order is a tie: compare as a set.
      expect(member(await circle.home(phone(rose.secret))).people.map((p) => p.name).sort()).toEqual(["Maya", "Rose"]);
      expect(await h.dump()).not.toContain("Lunch at noon?");
    });

    it("never wipes her phone's thread when her phone types a caretaker's code that is never approved", async () => {
      const { w, rose, maya } = await twoPhones();
      await circle.sendMessage(phone(maya.secret), { client_message_id: uuid(), text: "Lunch at noon?" });
      const { invite } = await circle.addPhone(owner(w.secret), w.deviceId, { name: "Ana", role: "caregiver" });
      const stray = await circle.join(phone(rose.secret), { code: invite.code, consent: { circle_data_notice: true } }, "a");
      expect(stray.home.membership).toBe("waiting");
      clock.advance(PHONE_JOIN_TTL_MS);
      expect(await circle.home(phone(stray.secret))).toEqual({ membership: "no_answer", name: "Ana" });
      expect(member(await circle.home(phone(maya.secret))).messages.map((m) => m.text)).toEqual(["Lunch at noon?"]);
      expect(member(await circle.home(phone(rose.secret))).messages.map((m) => m.text)).toEqual(["Lunch at noon?"]);
    });

    it("deletes expired messages, codes and lapsed joins from storage on the walker's own sweep, with no circle request", async () => {
      const { w, maya } = await twoPhones();
      await circle.sendMessage(phone(maya.secret), { client_message_id: uuid(), text: "Lunch at noon?" });
      await circle.addPhone(owner(w.secret), w.deviceId, { name: "Ana", role: "caregiver" });
      const ben = await circle.addPhone(owner(w.secret), w.deviceId, { name: "Ben", role: "caregiver" });
      await circle.join(phone(undefined), { code: ben.invite.code, consent: { circle_data_notice: true } }, "a");
      // A day and a lapsed join's day later, only the walker's heartbeat runs.
      clock.advance(CIRCLE_MESSAGE_RETENTION_MS + PHONE_JOIN_TTL_MS + 1_000);
      await heartbeat(w);
      const dump = await h.dump();
      expect(dump).not.toContain("Lunch at noon?");
      expect(dump).not.toContain("Ana");
      expect(dump).not.toContain("Ben");
      expect(dump).toContain("Maya");
    });

    it("sweeps at server start too", async () => {
      const { maya } = await twoPhones();
      await circle.sendMessage(phone(maya.secret), { client_message_id: uuid(), text: "Lunch at noon?" });
      clock.advance(CIRCLE_MESSAGE_RETENTION_MS);
      await walkers.prepare();
      expect(await h.dump()).not.toContain("Lunch at noon?");
    });

    it("deletes the whole circle when the walker is forgotten", async () => {
      const { w, rose, maya } = await twoPhones();
      await circle.sendMessage(phone(maya.secret), { client_message_id: uuid(), text: "Lunch at noon?" });
      await walkers.forget(owner(w.secret), w.deviceId);
      await rejects(circle.home(phone(rose.secret)), "unauthenticated");
      await rejects(circle.home(phone(maya.secret)), "unauthenticated");
      const dump = await h.dump();
      expect(dump).not.toContain("Lunch at noon?");
      expect(dump).not.toContain("Maya");
    });
  });
}

describeCircle("memory", async () => memoryHarness());

if (walkerTestDatabaseUrl) {
  const url = walkerTestDatabaseUrl;
  describeCircle("postgres", () => postgresHarness(url));
} else {
  describe.skip(SKIP_POSTGRES, () => {
    it("needs a local cluster", () => {});
  });
}

if (spacetimeTestServer) {
  const server = spacetimeTestServer;
  describeCircle("spacetime", () => spacetimeHarness(server));
} else {
  describe.skip(SKIP_SPACETIME, () => {
    it("needs a local spacetime server", () => {});
  });
}
