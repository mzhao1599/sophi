import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  CIRCLE_ERROR_STATUS,
  HELP_CLOSED_SHOWN_MS,
  HELP_OPEN_MAX_MS,
  HELP_RETENTION_MS,
  HelpResponseSchema,
  HelpViewSchema,
  WALKER_ERROR_STATUS,
  type CircleErrorCode,
  type HelpView,
  type PhoneHomeResponse,
  type WalkerErrorCode,
} from "@walker/contracts";
import { CircleService, WalkerService, isCircleError, isWalkerError, type DeviceCaller, type MemberCaller, type OwnerCaller } from "../../src";
import type { HelpEvent } from "../../src/walker/help";
import { Clock, SKIP_POSTGRES, SKIP_SPACETIME, manifest, memoryHarness, postgresHarness, snapshot, spacetimeHarness, spacetimeTestServer, uuid, walkerTestDatabaseUrl, type StoreHarness } from "./support";

/**
 * Asking for help (docs/subsystems/help.md) through WalkerService (the walker's routes) and CircleService (the
 * phones'), against the in-memory store, Postgres and SpacetimeDB. The expected results are in EXPECTED-help.md,
 * written before the code; each test names its rows.
 */

const owner = (secret: string): OwnerCaller => ({ kind: "owner", secret });
const phone = (secret: string | undefined): MemberCaller => ({ kind: "member", secret });
const device = (credential: string | undefined): DeviceCaller => ({ kind: "device", credential });

async function walkerRejects(promise: Promise<unknown>, code: WalkerErrorCode) {
  try {
    await promise;
  } catch (error) {
    if (!isWalkerError(error)) throw error;
    expect(error.code).toBe(code);
    expect(error.status).toBe(WALKER_ERROR_STATUS[code]);
    return error;
  }
  throw new Error(`Expected ${code}, but it succeeded.`);
}

async function circleRejects(promise: Promise<unknown>, code: CircleErrorCode) {
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

function member(home: PhoneHomeResponse) {
  if (home.membership !== "member") throw new Error(`Expected a member, got ${home.membership}.`);
  return home;
}

const ids = (people: { member_id: string }[]) => people.map((p) => p.member_id);

function describeHelp(name: string, makeHarness: () => Promise<StoreHarness>) {
  describe(`help: ${name}`, () => {
    let h: StoreHarness;
    let clock: Clock;
    let walkers: WalkerService;
    let circle: CircleService;
    let events: HelpEvent[];

    beforeAll(async () => {
      h = await makeHarness();
    }, 180_000);
    afterAll(async () => {
      if (h) await h.close();
    }, 60_000);
    beforeEach(async () => {
      await h.reset();
      clock = new Clock();
      // Near the real clock: SpacetimeDB's own sweep runs on it every minute, and must not see the test's times as old.
      clock.t = Math.floor(Date.now() / 1_000) * 1_000;
      events = [];
      walkers = new WalkerService(h.store(), { now: clock.now, onHelp: (e) => void events.push(e) });
      circle = new CircleService(h.store(), { now: clock.now, onHelp: (e) => void events.push(e) });
    });

    async function pairWalker(name = "Rose's walker") {
      const { secret, response } = await walkers.createPairingCode({ kind: "owner", secret: undefined });
      const paired = await walkers.pair({ code: response.code, service_version: "pi-0.1.0", name }, "203.0.113.10");
      const w = { secret, deviceId: paired.device_id, credential: paired.credential };
      await heartbeat(w);
      return w;
    }

    async function heartbeat(w: { deviceId: string; credential: string }) {
      await walkers.heartbeat(device(w.credential), w.deviceId, { sent_at: clock.iso(), service_version: "pi-0.1.0", manifest: manifest(clock), snapshot: snapshot(clock), events: [] });
    }

    type Walker = Awaited<ReturnType<typeof pairWalker>>;
    type Phone = { secret: string; id: string; name: string };

    /** Adds a phone; a caretaker is approved unless `wait`. Each join a second apart, so joining order is unambiguous. */
    async function addPhone(w: Walker, role: "walker_user" | "caregiver", who: string, wait = false): Promise<Phone> {
      clock.advance(1_000);
      const { invite } = await circle.addPhone(owner(w.secret), w.deviceId, { name: who, role });
      const joined = await circle.join(phone(undefined), { code: invite.code, consent: { circle_data_notice: true } }, "198.51.100.7");
      if (role === "caregiver" && !wait) {
        const waiting = (await circle.ownerCircle(owner(w.secret), w.deviceId)).joins.find((j) => j.name === who)!;
        await circle.approveJoin(owner(w.secret), w.deviceId, waiting.member_id, { consent: { walker_user_agreed: true } });
      }
      const id = wait ? (await circle.ownerCircle(owner(w.secret), w.deviceId)).joins.find((j) => j.name === who)!.member_id : member(await circle.home(phone(joined.secret))).me.member_id;
      return { secret: joined.secret, id, name: who };
    }

    /** The messy seed: her phone, two caretakers both named Maya, Ben waiting, Cy removed; and another walker with Zed. */
    async function seed() {
      const w = await pairWalker();
      const rose = await addPhone(w, "walker_user", "Rose");
      const maya = await addPhone(w, "caregiver", "Maya");
      const maya2 = await addPhone(w, "caregiver", "Maya");
      const ben = await addPhone(w, "caregiver", "Ben", true);
      const cy = await addPhone(w, "caregiver", "Cy");
      await circle.removeMember(owner(w.secret), w.deviceId, cy.id);
      const other = await pairWalker("Zed's walker");
      const zed = await addPhone(other, "caregiver", "Zed");
      return { w, rose, maya, maya2, ben, cy, other, zed };
    }

    const ask = (w: Walker, client_help_id = uuid(), source: "handles" | "voice" = "handles") => walkers.askForHelp(device(w.credential), w.deviceId, { client_help_id, source });
    const status = async (w: Walker) => (await walkers.help(device(w.credential), w.deviceId)).help;
    const homeHelp = async (p: Phone) => member(await circle.home(phone(p.secret))).help;

    it("A1, A2, A3, A3b, A9, A10, A13: asks once per open request, keeps retry ids, and opens a new one after", async () => {
      const { w, maya, maya2 } = await seed();
      const first = uuid();
      const a1 = await ask(w, first);
      expect(a1.created).toBe(true);
      const help = a1.response.help;
      expect(HelpViewSchema.parse(help)).toEqual({
        help_id: expect.any(String),
        source: "handles",
        age_seconds: 0,
        sent_to: [
          { member_id: maya.id, name: "Maya" },
          { member_id: maya2.id, name: "Maya" },
        ],
        shown_to: [],
        coming: [],
        closed: null,
      });
      const a2 = await ask(w, first);
      expect(a2).toEqual({ created: false, response: { help } });
      clock.advance(3_500);
      const second = uuid();
      const a3 = await ask(w, second, "voice");
      expect(a3.created).toBe(false);
      expect(a3.response.help).toEqual({ ...help, age_seconds: 3 });
      await walkers.helpOkay(device(w.credential), w.deviceId, help.help_id);
      // A retry of the second ask after its answer was lost: the same request, closed, not a new one.
      const a3b = await ask(w, second, "voice");
      expect(a3b.created).toBe(false);
      expect(a3b.response.help.help_id).toBe(help.help_id);
      expect(a3b.response.help.closed?.how).toBe("okay");
      const a9 = await ask(w, first);
      expect(a9.response.help.help_id).toBe(help.help_id);
      const a10 = await ask(w, uuid(), "voice");
      expect(a10.created).toBe(true);
      expect(a10.response.help.help_id).not.toBe(help.help_id);
      expect(a10.response.help.source).toBe("voice");
      expect(events.filter((e) => e.action === "ask").map((e) => e.outcome)).toEqual(["created", "existing", "existing", "existing", "existing", "created"]);
    });

    it("A4, A5, A6, A7: her phone asks (and gets the open one); caretakers can't", async () => {
      const { w, rose, maya, ben } = await seed();
      const phoneAsk = await circle.askForHelp(phone(rose.secret), { client_help_id: uuid() });
      expect(phoneAsk.created).toBe(true);
      expect(phoneAsk.response.help.source).toBe("phone");
      expect(phoneAsk.response.help.sent_to).toHaveLength(2);
      const fromWalker = await ask(w);
      expect(fromWalker).toEqual({ created: false, response: phoneAsk.response });
      const again = await circle.askForHelp(phone(rose.secret), { client_help_id: uuid() });
      expect(again.created).toBe(false);
      await circleRejects(circle.askForHelp(phone(maya.secret), { client_help_id: uuid() }), "not_allowed");
      await circleRejects(circle.askForHelp(phone(ben.secret), { client_help_id: uuid() }), "not_allowed");
    });

    it("A8: no approved caretaker: 409 no_caretaker from the walker and her phone, and nothing kept", async () => {
      const w = await pairWalker();
      const rose = await addPhone(w, "walker_user", "Rose");
      await addPhone(w, "caregiver", "Ben", true);
      const id = uuid();
      await walkerRejects(ask(w, id), "no_caretaker");
      await circleRejects(circle.askForHelp(phone(rose.secret), { client_help_id: uuid() }), "no_caretaker");
      expect(await status(w)).toBeNull();
      expect(await h.dump()).not.toContain(id);
      expect(events.map((e) => [e.outcome, e.help_id])).toEqual([
        ["no_caretaker", null],
        ["no_caretaker", null],
      ]);
    });

    it("A11: the walker's credential, and only its own walker", async () => {
      const { w, other } = await seed();
      await walkerRejects(walkers.askForHelp(device(undefined), w.deviceId, { client_help_id: uuid(), source: "handles" }), "unauthenticated");
      await walkerRejects(walkers.askForHelp(device("x".repeat(43)), w.deviceId, { client_help_id: uuid(), source: "handles" }), "unauthenticated");
      await walkerRejects(walkers.askForHelp(device(w.credential), other.deviceId, { client_help_id: uuid(), source: "handles" }), "not_found");
      await walkerRejects(walkers.help(device(w.credential), other.deviceId), "not_found");
    });

    it("A14, D7: a request keeps naming caretakers removed later, and answers its own id again", async () => {
      const { w, maya, maya2 } = await seed();
      const id = uuid();
      const { response } = await ask(w, id);
      await circle.removeMember(owner(w.secret), w.deviceId, maya.id);
      await circle.removeMember(owner(w.secret), w.deviceId, maya2.id);
      const again = await ask(w, id);
      expect(again.response.help.help_id).toBe(response.help.help_id);
      expect(ids(again.response.help.sent_to)).toEqual([maya.id, maya2.id]);
      await circleRejects(circle.home(phone(maya.secret)), "unauthenticated");
      await circleRejects(circle.helpComing(phone(maya.secret), response.help.help_id), "unauthenticated");
    });

    it("B1, B2, B3, B4, B5: on my way, each phone once, told apart by id", async () => {
      const { w, rose, maya, maya2, ben } = await seed();
      const { response } = await ask(w);
      const helpId = response.help.help_id;
      expect((await circle.helpComing(phone(maya.secret), helpId)).help.coming).toEqual([{ member_id: maya.id, name: "Maya" }]);
      expect(ids((await circle.helpComing(phone(maya.secret), helpId)).help.coming)).toEqual([maya.id]);
      expect(ids((await circle.helpComing(phone(maya2.secret), helpId)).help.coming)).toEqual([maya.id, maya2.id]);
      await circleRejects(circle.helpComing(phone(rose.secret), helpId), "not_allowed");
      await circleRejects(circle.helpComing(phone(ben.secret), helpId), "not_allowed");
      await circleRejects(circle.helpOkay(phone(ben.secret), helpId), "not_allowed");
      expect(events.filter((e) => e.action === "coming").map((e) => [e.via, e.outcome])).toEqual([
        ["caregiver", "answered"],
        ["caregiver", "unchanged"],
        ["caregiver", "answered"],
      ]);
    });

    it("B6, C4, C5, C6, C7: shown_to records caretaker phones whose answer carried it open, once each", async () => {
      const { w, rose, maya, maya2 } = await seed();
      const { response } = await ask(w);
      expect((await status(w))?.shown_to).toEqual([]);
      expect((await homeHelp(rose))?.shown_to).toEqual([]);
      const seen = await homeHelp(maya);
      expect(seen?.shown_to).toEqual([{ member_id: maya.id, name: "Maya" }]);
      expect(ids((await homeHelp(maya))!.shown_to)).toEqual([maya.id]);
      expect(ids((await homeHelp(maya2))!.shown_to)).toEqual([maya.id, maya2.id]);
      expect(ids((await status(w))!.shown_to)).toEqual([maya.id, maya2.id]);
      // A caretaker approved after she asked sees it, isn't in sent_to, and can answer.
      const ana = await addPhone(w, "caregiver", "Ana");
      const late = await homeHelp(ana);
      expect(late?.help_id).toBe(response.help.help_id);
      expect(ids(late!.sent_to)).toEqual([maya.id, maya2.id]);
      expect(ids(late!.shown_to)).toEqual([maya.id, maya2.id, ana.id]);
      expect(ids((await circle.helpComing(phone(ana.secret), response.help.help_id)).help.coming)).toEqual([ana.id]);
      // Closed: a caretaker's read doesn't add to it any more.
      await circle.helpOkay(phone(rose.secret), response.help.help_id);
      const ted = await addPhone(w, "caregiver", "Ted");
      expect(ids((await homeHelp(ted))!.shown_to)).toEqual([maya.id, maya2.id, ana.id]);
    });

    it("B7, B8, B9, B10, D8: who closed it", async () => {
      const { w, rose, maya } = await seed();
      const byHer = (await ask(w)).response.help;
      expect((await circle.helpOkay(phone(rose.secret), byHer.help_id)).help.closed).toEqual({ how: "okay", by: { member_id: rose.id, name: "Rose" } });
      const byMaya = (await ask(w)).response.help;
      expect((await circle.helpOkay(phone(maya.secret), byMaya.help_id)).help.closed).toEqual({ how: "with_her", by: { member_id: maya.id, name: "Maya" } });
      const onWalker = (await ask(w)).response.help;
      expect((await walkers.helpOkay(device(w.credential), w.deviceId, onWalker.help_id)).help.closed).toEqual({ how: "okay", by: { member_id: rose.id, name: "Rose" } });
      await circle.removeMember(owner(w.secret), w.deviceId, rose.id);
      const noPhone = (await ask(w)).response.help;
      expect((await walkers.helpOkay(device(w.credential), w.deviceId, noPhone.help_id)).help.closed).toEqual({ how: "okay", by: null });
      expect(events.filter((e) => e.action === "okay").map((e) => e.via)).toEqual(["walker_user", "caregiver", "walker", "walker"]);
    });

    it("B11, D4: answering a closed request is 409 help_closed with it as it stands; the first close wins", async () => {
      const { w, rose, maya } = await seed();
      const help = (await ask(w)).response.help;
      const closed = await circle.helpOkay(phone(maya.secret), help.help_id);
      const asWalker = await walkerRejects(walkers.helpOkay(device(w.credential), w.deviceId, help.help_id), "help_closed");
      expect(isWalkerError(asWalker) && asWalker.help).toEqual(closed.help);
      for (const answer of [() => circle.helpOkay(phone(rose.secret), help.help_id), () => circle.helpComing(phone(maya.secret), help.help_id), () => circle.helpOkay(phone(maya.secret), help.help_id)]) {
        const error = await circleRejects(answer(), "help_closed");
        expect(isCircleError(error) && error.help).toEqual(closed.help);
      }
      // Expired, then answered.
      const later = (await ask(w)).response.help;
      clock.advance(HELP_OPEN_MAX_MS);
      const error = await circleRejects(circle.helpComing(phone(maya.secret), later.help_id), "help_closed");
      expect(isCircleError(error) && error.help?.closed).toEqual({ how: "expired", by: null });
    });

    it("B12, B13, C10: unknown, malformed and another walker's ids are 404; another walker's phones never see it", async () => {
      const { w, maya, other, zed } = await seed();
      const help = (await ask(w)).response.help;
      const theirs = (await walkers.askForHelp(device(other.credential), other.deviceId, { client_help_id: uuid(), source: "handles" })).response.help;
      await circleRejects(circle.helpComing(phone(maya.secret), uuid()), "not_found");
      await circleRejects(circle.helpComing(phone(maya.secret), "not-a-uuid"), "not_found");
      await circleRejects(circle.helpOkay(phone(maya.secret), theirs.help_id), "not_found");
      await walkerRejects(walkers.helpOkay(device(w.credential), w.deviceId, theirs.help_id), "not_found");
      await walkerRejects(walkers.helpOkay(device(w.credential), w.deviceId, "../x"), "not_found");
      expect((await homeHelp(zed))?.help_id).toBe(theirs.help_id);
      expect(JSON.stringify(await circle.home(phone(zed.secret)))).not.toContain(help.help_id);
      await circleRejects(circle.helpComing(phone(undefined), help.help_id), "unauthenticated");
    });

    it("B14: two closes at once: one wins, the other gets help_closed with the winner's close", async () => {
      const { w, rose, maya } = await seed();
      const help = (await ask(w)).response.help;
      const settle = (p: Promise<unknown>) => p.then((r) => ({ ok: r as { help: HelpView } }), (e: unknown) => ({ error: e }));
      const [a, b] = await Promise.all([settle(circle.helpOkay(phone(rose.secret), help.help_id)), settle(circle.helpOkay(phone(maya.secret), help.help_id))]);
      const wins = [a, b].filter((r) => "ok" in r) as { ok: { help: HelpView } }[];
      const losses = [a, b].filter((r) => "error" in r) as { error: unknown }[];
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);
      const lost = losses[0]!.error;
      expect(isCircleError(lost) && lost.code).toBe("help_closed");
      expect(isCircleError(lost) && lost.help?.closed).toEqual(wins[0]!.ok.help.closed);
    });

    it("C1, C2, C3, C8, C9: what the walker, the phones and the owner's page read", async () => {
      const { w, rose, ben } = await seed();
      expect(await status(w)).toBeNull();
      const help = (await ask(w)).response.help;
      clock.advance(61_900);
      expect((await status(w))?.age_seconds).toBe(61);
      expect(await homeHelp(rose)).toEqual(await status(w));
      expect((await circle.home(phone(ben.secret))).membership).toBe("waiting");
      expect(JSON.stringify(await circle.ownerCircle(owner(w.secret), w.deviceId))).not.toContain(help.help_id);
      await circle.helpOkay(phone(rose.secret), help.help_id);
      clock.advance(HELP_CLOSED_SHOWN_MS - 1_000);
      expect((await status(w))?.closed?.how).toBe("okay");
      clock.advance(1_000);
      expect(await status(w)).toBeNull();
      expect(await homeHelp(rose)).toBeNull();
    });

    it("D1, D2, D3: an hour open, then expired as of the hour's end and shown 5 minutes from then", async () => {
      const { w, maya } = await seed();
      const help = (await ask(w)).response.help;
      clock.advance(HELP_OPEN_MAX_MS - 1_000);
      expect((await status(w))?.closed).toBeNull();
      clock.advance(1_000);
      // Read late: still counted from the hour's end.
      clock.advance(HELP_CLOSED_SHOWN_MS - 1_000);
      expect((await homeHelp(maya))?.closed).toEqual({ how: "expired", by: null });
      expect((await homeHelp(maya))?.shown_to).toEqual([]);
      clock.advance(1_000);
      expect(await status(w)).toBeNull();
      const next = await ask(w);
      expect(next.created).toBe(true);
      expect(next.response.help.help_id).not.toBe(help.help_id);
    });

    it("D5, D9: deleted 24 hours after she asked by the walker's sweep, open or not, and at server start", async () => {
      const { w, rose } = await seed();
      const closed = (await ask(w)).response.help;
      await circle.helpOkay(phone(rose.secret), closed.help_id);
      clock.advance(10 * 60_000);
      const open = (await ask(w)).response.help;
      clock.advance(HELP_RETENTION_MS - 10 * 60_000 - 60_000);
      await heartbeat(w);
      let dump = await h.dump();
      expect(dump).toContain(closed.help_id);
      clock.advance(61_000);
      await heartbeat(w);
      dump = await h.dump();
      expect(dump).not.toContain(closed.help_id);
      expect(dump).toContain(open.help_id);
      clock.advance(10 * 60_000);
      await walkers.prepare();
      expect(await h.dump()).not.toContain(open.help_id);
    });

    it("D6: forgetting the walker deletes its requests at once", async () => {
      const { w } = await seed();
      const help = (await ask(w)).response.help;
      await walkers.forget(owner(w.secret), w.deviceId);
      expect(await h.dump()).not.toContain(help.help_id);
    });

    it("L1, C11: log events carry ids, how and timings, never a name; views carry no location or times", async () => {
      const { w, maya } = await seed();
      const help = (await ask(w)).response.help;
      clock.advance(5_000);
      await circle.helpComing(phone(maya.secret), help.help_id);
      expect(events.map((e) => [e.action, e.via, e.outcome, e.sent_to, e.age_ms])).toEqual([
        ["ask", "handles", "created", 2, 0],
        ["coming", "caregiver", "answered", 2, 5_000],
      ]);
      expect(JSON.stringify(events)).not.toMatch(/Maya|Rose|walker'/);
      expect(Object.keys(HelpResponseSchema.parse({ help })).concat(Object.keys(help)).sort()).toEqual(
        ["help", "age_seconds", "closed", "coming", "help_id", "sent_to", "shown_to", "source"].sort(),
      );
    });
  });
}

describeHelp("memory", async () => memoryHarness());

if (walkerTestDatabaseUrl) {
  const url = walkerTestDatabaseUrl;
  describeHelp("postgres", () => postgresHarness(url));
} else {
  describe.skip(SKIP_POSTGRES, () => {
    it("needs a local cluster", () => {});
  });
}

if (spacetimeTestServer) {
  const server = spacetimeTestServer;
  describeHelp("spacetime", () => spacetimeHarness(server));
} else {
  describe.skip(SKIP_SPACETIME, () => {
    it("needs a local spacetime server", () => {});
  });
}
