import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  OFFLINE_AFTER_MS,
  PAIRING_CODE_TTL_MS,
  PAIRING_LOCK_WINDOW_MS,
  PairDeviceResponseSchema,
  SNAPSHOT_MAX_AGE_MS,
  WALKER_ERROR_STATUS,
  WALKER_HISTORY_RETENTION_MS,
  WALKER_SETUP,
  WalkerStatusViewSchema,
  type HeartbeatRequest,
  type WalkerEvent,
  type WalkerStatusView,
} from "@walker/contracts";
import { WalkerService, isWalkerError, sha256, type DeviceCaller, type OwnerCaller, type WalkerError } from "../../src";
import {
  Clock,
  SKIP_POSTGRES,
  T0,
  manifest,
  memoryHarness,
  postgresHarness,
  proposal,
  snapshot,
  turn,
  uuid,
  walkerTestDatabaseUrl,
  type StoreHarness,
} from "./support";

/** Every case in EXPECTED.md that the service decides, against the in-memory store and Postgres. */

async function rejects(promise: Promise<unknown>, code: WalkerError["code"]): Promise<WalkerError> {
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

const owner = (secret: string | undefined): OwnerCaller => ({ kind: "owner", secret });
const device = (credential: string | undefined): DeviceCaller => ({ kind: "device", credential });
const parses = (view: WalkerStatusView) => expect(WalkerStatusViewSchema.safeParse(view).success).toBe(true);

function describeService(name: string, makeHarness: () => Promise<StoreHarness>) {
  describe(`walker service: ${name}`, () => {
    let h: StoreHarness;
    let clock: Clock;
    let service: WalkerService;

    beforeAll(async () => {
      h = await makeHarness();
    });
    afterAll(async () => {
      if (h) await h.close();
    });
    beforeEach(async () => {
      await h.reset();
      clock = new Clock();
      service = new WalkerService(h.store(), { now: clock.now });
    });

    async function pairWalker(secret?: string, address = "203.0.113.10") {
      const { secret: ownerSecret, response } = await service.createPairingCode(owner(secret));
      const paired = await service.pair({ code: response.code, service_version: "pi-0.1.0", name: "Kitchen walker" }, address);
      return { secret: ownerSecret, ...paired };
    }

    function beat(overrides: Partial<HeartbeatRequest> = {}): HeartbeatRequest {
      return { sent_at: clock.iso(-15), service_version: "pi-0.1.0", manifest: manifest(clock), snapshot: snapshot(clock), events: [], ...overrides };
    }

    async function openProposal(deviceId: string, overrides = {}) {
      const t = turn(clock);
      const p = proposal(clock, t.client_turn_id, overrides);
      await h.store().saveTurn(deviceId, t, p, clock.now());
      return p;
    }

    // ---- Auth ----

    it("shows a walker only to its owner, and an unknown id the same way", async () => {
      const a = await pairWalker();
      const other = (await service.createPairingCode(owner(undefined))).secret;
      parses((await service.get(owner(a.secret), a.device_id)).walker);
      const theirs = await rejects(service.get(owner(other), a.device_id), "not_found");
      const unknown = await rejects(service.get(owner(a.secret), uuid()), "not_found");
      await rejects(service.get(owner(a.secret), "not-a-uuid"), "not_found");
      expect(theirs.message).toBe(unknown.message);
    });

    it("refuses page calls with no owner secret or a malformed one", async () => {
      await rejects(service.list(owner(undefined)), "unauthenticated");
      await rejects(service.list(owner("short")), "unauthenticated");
      await rejects(service.get(owner("x".repeat(44)), uuid()), "unauthenticated");
    });

    it("keeps the two proofs apart", async () => {
      const a = await pairWalker();
      // The device credential presented as an owner secret names no owner.
      expect((await service.list(owner(a.credential))).walkers).toEqual([]);
      await rejects(service.get(owner(a.credential), a.device_id), "not_found");
      // The owner secret presented as a device credential is unknown.
      await rejects(service.heartbeat(device(a.secret), a.device_id, beat()), "unauthenticated");
      await rejects(service.answer(device(a.secret), a.device_id, uuid(), { answer: "confirm" }), "unauthenticated");
    });

    it("refuses a forged credential with 401 and another walker's id with 404", async () => {
      const a = await pairWalker();
      const b = await pairWalker(a.secret);
      await rejects(service.heartbeat(device(undefined), a.device_id, beat()), "unauthenticated");
      await rejects(service.heartbeat(device("A".repeat(43)), a.device_id, beat()), "unauthenticated");
      await rejects(service.configuration(device(a.credential), b.device_id), "not_found");
      expect((await service.configuration(device(b.credential), b.device_id)).configuration.version).toBe(1);
    });

    it("revokes a forgotten walker's credential", async () => {
      const a = await pairWalker();
      await service.heartbeat(device(a.credential), a.device_id, beat());
      await service.forget(owner(a.secret), a.device_id);
      await rejects(service.heartbeat(device(a.credential), a.device_id, beat()), "unauthenticated");
      await rejects(service.get(owner(a.secret), a.device_id), "not_found");
    });

    it("stores only the SHA-256 of the owner secret and the credential, and no client address", async () => {
      const a = await pairWalker();
      await service.heartbeat(device(a.credential), a.device_id, beat());
      await rejects(service.pair({ code: "000000", service_version: "pi" }, "203.0.113.10"), "pairing_code_invalid");
      const stored = await h.dump();
      expect(stored).not.toContain(a.secret);
      expect(stored).not.toContain(a.credential);
      expect(stored).toContain(sha256(a.secret));
      expect(stored).toContain(sha256(a.credential));
      // The wrong try is kept under a keyed hash: not the address, and not its plain SHA-256.
      expect(stored).toContain("address_key");
      expect(stored).not.toContain("203.0.113.10");
      expect(stored).not.toContain(sha256("203.0.113.10"));
    });

    it("stores lines and parts carrying characters Postgres can't, as U+FFFD", async () => {
      const a = await pairWalker();
      const odd = manifest(clock);
      odd.modules[0]!.firmware_version = "0.3\u0000";
      const line: WalkerEvent = { event_id: uuid(), kind: "notice", text: "Steady\u0000 is on \ud800.", ago_ms: 0 };
      await service.heartbeat(device(a.credential), a.device_id, beat({ manifest: odd, events: [line], service_version: "pi\udc00" }));
      const { walker } = await service.get(owner(a.secret), a.device_id);
      expect(walker.walker_said.map((l) => l.text)).toEqual(["Steady\uFFFD is on \uFFFD."]);
      expect(walker.online).toBe(true);
    });

    // ---- Pairing ----

    it("pairs with a fresh code and creates configuration version 1 from the walker setup", async () => {
      const { secret, response } = await service.createPairingCode(owner(undefined));
      expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(response.code).toMatch(/^\d{6}$/);
      expect(Date.parse(response.expires_at)).toBe(T0 + PAIRING_CODE_TTL_MS);
      const paired = await service.pair({ code: response.code, service_version: "pi-0.1.0" }, "203.0.113.10");
      expect(PairDeviceResponseSchema.parse(paired).configuration).toEqual({ version: 1, ...WALKER_SETUP, created_at: clock.iso() });
      expect((await service.get(owner(secret), paired.device_id)).walker.name).toBe("My walker");
      // One-time.
      await rejects(service.pair({ code: response.code, service_version: "pi-0.1.0" }, "203.0.113.10"), "pairing_code_invalid");
    });

    it("keeps the owner's secret and replaces their earlier code", async () => {
      const first = await service.createPairingCode(owner(undefined));
      const second = await service.createPairingCode(owner(first.secret));
      expect(second.secret).toBe(first.secret);
      if (first.response.code !== second.response.code) {
        await rejects(service.pair({ code: first.response.code, service_version: "pi" }, "198.51.100.1"), "pairing_code_invalid");
      }
      await service.pair({ code: second.response.code, service_version: "pi" }, "198.51.100.1");
      expect((await service.list(owner(first.secret))).walkers).toHaveLength(1);
    });

    it("refuses a code 10 minutes and 1 ms after it was made", async () => {
      const { response } = await service.createPairingCode(owner(undefined));
      clock.advance(PAIRING_CODE_TTL_MS + 1);
      await rejects(service.pair({ code: response.code, service_version: "pi" }, "198.51.100.1"), "pairing_code_invalid");
    });

    it("locks one address out after 5 wrong codes, for the window, without using up the right code", async () => {
      const { secret, response } = await service.createPairingCode(owner(undefined));
      const wrong = response.code === "000000" ? "000001" : "000000";
      for (let i = 0; i < 5; i++) {
        clock.advance(1_000);
        await rejects(service.pair({ code: wrong, service_version: "pi" }, "192.0.2.7"), "pairing_code_invalid");
      }
      await rejects(service.pair({ code: response.code, service_version: "pi" }, "192.0.2.7"), "pairing_locked");
      // The locked try didn't use the code up, and another address isn't locked.
      await service.pair({ code: response.code, service_version: "pi" }, "192.0.2.99");
      const fresh = await service.createPairingCode(owner(secret));
      // Still inside the window measured from the first wrong code.
      clock.advance(PAIRING_LOCK_WINDOW_MS - 5_001);
      await rejects(service.pair({ code: fresh.response.code, service_version: "pi" }, "192.0.2.7"), "pairing_locked");
      expect((await service.list(owner(secret))).walkers).toHaveLength(1);
    });

    it("lets a locked address pair once the window has passed", async () => {
      for (let i = 0; i < 5; i++) await rejects(service.pair({ code: "123456", service_version: "pi" }, "192.0.2.8"), "pairing_code_invalid");
      clock.advance(PAIRING_LOCK_WINDOW_MS);
      const { response } = await service.createPairingCode(owner(undefined));
      await service.pair({ code: response.code, service_version: "pi" }, "192.0.2.8");
    });

    it("refuses a ninth walker", async () => {
      const a = await pairWalker();
      for (let i = 1; i < 8; i++) await pairWalker(a.secret, `198.51.100.${i}`);
      expect((await service.list(owner(a.secret))).walkers).toHaveLength(8);
      await rejects(service.createPairingCode(owner(a.secret)), "walker_limit");
    });

    // ---- Heartbeat and status ----

    it("answers a heartbeat and stores the manifest and snapshot with the server's receive time", async () => {
      const a = await pairWalker();
      clock.advance(2_000);
      expect(await service.heartbeat(device(a.credential), a.device_id, beat())).toEqual({ configuration_version: 1, open_proposal: null });
      const { walker } = await service.get(owner(a.secret), a.device_id);
      parses(walker);
      expect(walker.online).toBe(true);
      expect(walker.last_seen_at).toBe(clock.iso());
      expect(walker.simulator).toBe(true);
      expect(walker.applied_configuration_version).toBe(1);
    });

    it("counts a walker offline 15,001 ms after its last heartbeat, and shows nothing as available then", async () => {
      const a = await pairWalker();
      expect((await service.get(owner(a.secret), a.device_id)).walker.online).toBe(false);
      await service.heartbeat(device(a.credential), a.device_id, beat());
      clock.advance(OFFLINE_AFTER_MS - 1);
      const online = (await service.get(owner(a.secret), a.device_id)).walker;
      expect(online.online).toBe(true);
      expect(online.parts.find((p) => p.instance_id === "hand-left-01")?.health).toBe("ok");
      clock.advance(2);
      const offline = (await service.get(owner(a.secret), a.device_id)).walker;
      parses(offline);
      expect(offline.online).toBe(false);
      expect(offline.parts.every((p) => p.health === "unavailable")).toBe(true);
      expect(offline.zones.every((z) => z.reading.status === "unknown")).toBe(true);
      expect(offline.open_proposal).toBeNull();
    });

    it("places walker lines in time by ago_ms, stores each once, and skips ones older than an hour", async () => {
      const a = await pairWalker();
      const on: WalkerEvent = { event_id: uuid(), kind: "notice", text: "Steady is on.", ago_ms: 30_000 };
      const offline: WalkerEvent = { event_id: uuid(), kind: "local_reply", text: "I'm offline right now. Your buzz alerts still work.", ago_ms: 2_000 };
      const back: WalkerEvent = { event_id: uuid(), kind: "notice", text: "I'm back online.", ago_ms: 0 };
      const ancient: WalkerEvent = { event_id: uuid(), kind: "notice", text: "Steady is on.", ago_ms: WALKER_HISTORY_RETENTION_MS + 1 };
      const pairAgain: WalkerEvent = { event_id: uuid(), kind: "notice", text: "Pair me again from the Your walker page.", ago_ms: 0 };
      await service.heartbeat(device(a.credential), a.device_id, beat({ events: [back, on, ancient, offline, pairAgain] }));
      clock.advance(5_000);
      await service.heartbeat(device(a.credential), a.device_id, beat({ events: [on] }));
      const said = (await service.get(owner(a.secret), a.device_id)).walker.walker_said;
      expect(said.map((l) => [l.text, l.at])).toEqual([
        ["Steady is on.", new Date(T0 - 30_000).toISOString()],
        ["I'm offline right now. Your buzz alerts still work.", new Date(T0 - 2_000).toISOString()],
        ["I'm back online.", new Date(T0).toISOString()],
        // Said at the same moment: kept in the order the walker sent them.
        ["Pair me again from the Your walker page.", new Date(T0).toISOString()],
      ]);
    });

    it("merges configured and reported parts, each with its own simulated flag", async () => {
      const a = await pairWalker();
      await service.heartbeat(device(a.credential), a.device_id, beat());
      const { parts } = (await service.get(owner(a.secret), a.device_id)).walker;
      expect(parts).toEqual([
        { module_id: "base.walker", instance_id: null, health: "unavailable", simulated: false, in_configuration: true },
        { module_id: "controls.hand", instance_id: "hand-left-01", health: "ok", simulated: false, in_configuration: true },
        { module_id: "perception.tof", instance_id: "tof-front-01", health: "degraded", simulated: true, in_configuration: true },
        { module_id: "voice", instance_id: null, health: "unavailable", simulated: false, in_configuration: true },
        { module_id: "location.gps", instance_id: "gps-01", health: "ok", simulated: true, in_configuration: false },
      ]);
    });

    it("shows zones measured with their age, unknown when invalid, missing or stale", async () => {
      const a = await pairWalker();
      await service.heartbeat(device(a.credential), a.device_id, beat());
      clock.advance(1_000);
      const fresh = (await service.get(owner(a.secret), a.device_id)).walker.zones;
      expect(fresh).toEqual([
        { zone: "front", instance_id: "tof-front-01", simulated: true, reading: { status: "measured", mm: 640, age_ms: 1_120 } },
        { zone: "left", instance_id: "tof-front-01", simulated: true, reading: { status: "unknown", reason: "invalid" } },
        { zone: "rear", instance_id: "tof-rear-02", simulated: true, reading: { status: "unknown", reason: "missing" } },
      ]);
      clock.advance(SNAPSHOT_MAX_AGE_MS + 1 - 1_000);
      const stale = (await service.get(owner(a.secret), a.device_id)).walker.zones;
      expect(stale[0]?.reading).toEqual({ status: "unknown", reason: "stale" });
    });

    // ---- Proposals ----

    it("offers the open proposal in the heartbeat answer and the status", async () => {
      const a = await pairWalker();
      await service.heartbeat(device(a.credential), a.device_id, beat());
      const p = await openProposal(a.device_id);
      clock.advance(1_000);
      expect((await service.heartbeat(device(a.credential), a.device_id, beat())).open_proposal).toEqual(p);
      expect((await service.get(owner(a.secret), a.device_id)).walker.open_proposal).toEqual(p);
    });

    it("confirms into the next configuration version, from the walker's button", async () => {
      const a = await pairWalker();
      await service.heartbeat(device(a.credential), a.device_id, beat());
      const p = await openProposal(a.device_id);
      clock.advance(3_000);
      const answered = await service.answer(device(a.credential), a.device_id, p.proposal_id, { answer: "confirm" });
      expect(answered.proposal).toEqual({ ...p, state: "confirmed", configuration_version: 2 });
      expect(answered.status.configuration).toEqual({ ...answered.status.configuration, version: 2, cues: ["sound", "spoken"], created_at: clock.iso() });
      expect(answered.status.open_proposal).toBeNull();
      expect((await service.heartbeat(device(a.credential), a.device_id, beat())).configuration_version).toBe(2);
      expect((await service.configuration(device(a.credential), a.device_id)).configuration.cues).toEqual(["sound", "spoken"]);
      if (h.pool) {
        const { rows } = await h.pool.query("select version, cues from walker_configurations where device_id = $1 order by version", [a.device_id]);
        expect(rows).toEqual([{ version: 1, cues: ["vibration", "spoken"] }, { version: 2, cues: ["sound", "spoken"] }]);
      }
    });

    it("lets the first of two Confirms at once win, and tells the second", async () => {
      const a = await pairWalker();
      await service.heartbeat(device(a.credential), a.device_id, beat());
      const p = await openProposal(a.device_id);
      const results = await Promise.allSettled([
        service.answer(device(a.credential), a.device_id, p.proposal_id, { answer: "confirm" }),
        service.answer(owner(a.secret), a.device_id, p.proposal_id, { answer: "confirm" }),
      ]);
      const won = results.filter((r) => r.status === "fulfilled");
      const lost = results.flatMap((r) => (r.status === "rejected" ? [r.reason as WalkerError] : []));
      expect(won).toHaveLength(1);
      expect(lost).toHaveLength(1);
      expect(lost[0]?.code).toBe("proposal_closed");
      expect(lost[0]?.proposal).toEqual({ ...p, state: "confirmed", configuration_version: 2 });
      expect((await service.configuration(device(a.credential), a.device_id)).configuration.version).toBe(2);
    });

    it("declines without a new version, from the page", async () => {
      const a = await pairWalker();
      await service.heartbeat(device(a.credential), a.device_id, beat());
      const p = await openProposal(a.device_id);
      const answered = await service.answer(owner(a.secret), a.device_id, p.proposal_id, { answer: "decline" });
      expect(answered.proposal.state).toBe("declined");
      expect(answered.status.configuration.version).toBe(1);
      const again = await rejects(service.answer(owner(a.secret), a.device_id, p.proposal_id, { answer: "confirm" }), "proposal_closed");
      expect(again.proposal?.state).toBe("declined");
    });

    it("supersedes a Confirm whose base configuration moved", async () => {
      const a = await pairWalker();
      await service.heartbeat(device(a.credential), a.device_id, beat());
      const first = await openProposal(a.device_id);
      await service.answer(owner(a.secret), a.device_id, first.proposal_id, { answer: "confirm" });
      // A proposal still made against version 1 (say, from a slow turn) can't be applied to version 2.
      const stale = await openProposal(a.device_id, { from_cues: ["vibration", "spoken"], cues: ["vibration", "sound"] });
      const closed = await rejects(service.answer(device(a.credential), a.device_id, stale.proposal_id, { answer: "confirm" }), "proposal_closed");
      expect(closed.proposal?.state).toBe("superseded");
      expect((await service.configuration(device(a.credential), a.device_id)).configuration.version).toBe(2);
    });

    it("supersedes the open proposal when a new one opens", async () => {
      const a = await pairWalker();
      await service.heartbeat(device(a.credential), a.device_id, beat());
      const older = await openProposal(a.device_id);
      const newer = await openProposal(a.device_id, { cues: ["vibration", "sound"] });
      const closed = await rejects(service.answer(owner(a.secret), a.device_id, older.proposal_id, { answer: "confirm" }), "proposal_closed");
      expect(closed.proposal?.state).toBe("superseded");
      expect((await service.get(owner(a.secret), a.device_id)).walker.open_proposal?.proposal_id).toBe(newer.proposal_id);
    });

    it("marks a timed-out proposal expired, not superseded, when a new one opens", async () => {
      const a = await pairWalker();
      await service.heartbeat(device(a.credential), a.device_id, beat());
      const older = await openProposal(a.device_id);
      for (let i = 0; i < 13; i++) {
        clock.advance(5_000);
        await h.store().recordHeartbeat(a.device_id, { at: clock.iso(), service_version: "pi", manifest: manifest(clock), snapshot: null, events: [] });
      }
      await openProposal(a.device_id, { cues: ["vibration", "sound"] });
      const closed = await rejects(service.answer(owner(a.secret), a.device_id, older.proposal_id, { answer: "confirm" }), "proposal_closed");
      expect(closed.proposal?.state).toBe("expired");
    });

    it("expires a proposal 60 s after it was made", async () => {
      const a = await pairWalker();
      await service.heartbeat(device(a.credential), a.device_id, beat());
      const p = await openProposal(a.device_id);
      for (let i = 0; i < 12; i++) {
        clock.advance(5_000);
        await service.heartbeat(device(a.credential), a.device_id, beat());
      }
      const closed = await rejects(service.answer(device(a.credential), a.device_id, p.proposal_id, { answer: "confirm" }), "proposal_closed");
      expect(closed.proposal?.state).toBe("expired");
    });

    for (const firstRead of ["status", "heartbeat", "answer"] as const) {
      it(`expires the open proposal for good when the walker goes offline (first read: ${firstRead})`, async () => {
        const a = await pairWalker();
        await service.heartbeat(device(a.credential), a.device_id, beat());
        const p = await openProposal(a.device_id);
        clock.advance(OFFLINE_AFTER_MS + 1);
        if (firstRead === "status") expect((await service.get(owner(a.secret), a.device_id)).walker.open_proposal).toBeNull();
        if (firstRead === "heartbeat") expect((await service.heartbeat(device(a.credential), a.device_id, beat())).open_proposal).toBeNull();
        if (firstRead === "answer") await rejects(service.answer(device(a.credential), a.device_id, p.proposal_id, { answer: "confirm" }), "proposal_closed");
        // Back online, it stays expired.
        await service.heartbeat(device(a.credential), a.device_id, beat());
        expect((await service.get(owner(a.secret), a.device_id)).walker.open_proposal).toBeNull();
        const closed = await rejects(service.answer(owner(a.secret), a.device_id, p.proposal_id, { answer: "confirm" }), "proposal_closed");
        expect(closed.proposal?.state).toBe("expired");
      });
    }

    it("answers 404 for an unknown proposal or another walker's", async () => {
      const a = await pairWalker();
      const b = await pairWalker(a.secret);
      await service.heartbeat(device(b.credential), b.device_id, beat());
      const theirs = await openProposal(b.device_id);
      await rejects(service.answer(owner(a.secret), a.device_id, uuid(), { answer: "confirm" }), "not_found");
      await rejects(service.answer(owner(a.secret), a.device_id, "nope", { answer: "confirm" }), "not_found");
      await rejects(service.answer(device(a.credential), a.device_id, theirs.proposal_id, { answer: "confirm" }), "not_found");
    });

    // ---- Retention and Forget ----

    it("deletes turns and walker lines an hour after they happen, on a heartbeat", async () => {
      const a = await pairWalker();
      await service.heartbeat(device(a.credential), a.device_id, beat({ events: [{ event_id: uuid(), kind: "notice", text: "Steady is on.", ago_ms: 0 }] }));
      await h.store().saveTurn(a.device_id, turn(clock), null, clock.now());
      clock.advance(60_000);
      await h.store().saveTurn(a.device_id, turn(clock, { reply: "Your hand controls are working." }), null, clock.now());
      clock.advance(WALKER_HISTORY_RETENTION_MS - 60_000 + 1);
      await service.heartbeat(device(a.credential), a.device_id, beat());
      const { walker } = await service.get(owner(a.secret), a.device_id);
      expect(walker.turns.map((t) => t.reply)).toEqual(["Your hand controls are working."]);
      expect(walker.walker_said).toEqual([]);
    });

    it("sweeps turns, lines, expired codes and old wrong tries at server start", async () => {
      const a = await pairWalker();
      await h.store().saveTurn(a.device_id, turn(clock), null, clock.now());
      const { response } = await service.createPairingCode(owner(undefined));
      await rejects(service.pair({ code: "999999", service_version: "pi" }, "192.0.2.50"), "pairing_code_invalid");
      const before = await h.dump();
      for (const kept of ["Press Confirm to do it.", `"code":"${response.code}"`, "address_key"]) expect(before).toContain(kept);
      clock.advance(WALKER_HISTORY_RETENTION_MS + 1);
      await service.prepare();
      const after = await h.dump();
      for (const gone of ["Press Confirm to do it.", `"code":"${response.code}"`, "address_key"]) expect(after).not.toContain(gone);
    });

    it("deletes old history when the page reads a walker that sends no heartbeats", async () => {
      const a = await pairWalker();
      await h.store().saveTurn(a.device_id, turn(clock), null, clock.now());
      clock.advance(WALKER_HISTORY_RETENTION_MS + 1);
      expect((await service.get(owner(a.secret), a.device_id)).walker.turns).toEqual([]);
      expect(await h.dump()).not.toContain("Press Confirm to do it.");
    });

    it("forgets one walker and everything about it, and nothing else", async () => {
      const a = await pairWalker();
      const kept = await pairWalker(a.secret);
      const other = await pairWalker(undefined, "198.51.100.77");
      for (const w of [a, kept, other]) {
        await service.heartbeat(device(w.credential), w.device_id, beat({ events: [{ event_id: uuid(), kind: "notice", text: "Steady is on.", ago_ms: 0 }] }));
        await openProposal(w.device_id);
      }
      await service.forget(owner(a.secret), a.device_id);
      const stored = await h.dump();
      expect(stored).not.toContain(a.device_id);
      expect(stored).toContain(kept.device_id);
      expect((await service.list(owner(a.secret))).walkers.map((w) => w.device_id)).toEqual([kept.device_id]);
      expect((await service.get(owner(other.secret), other.device_id)).walker.walker_said).toHaveLength(1);
      await rejects(service.forget(owner(a.secret), a.device_id), "not_found");
      await rejects(service.forget(owner(other.secret), kept.device_id), "not_found");
    });

    it("answers 503 everywhere when walkers are off on this server", async () => {
      const off = new WalkerService(h.store(), { now: clock.now, blocked: "Walkers aren't set up on this server." });
      await rejects(off.createPairingCode(owner(undefined)), "unavailable");
      await rejects(off.heartbeat(device("A".repeat(43)), uuid(), beat()), "unavailable");
    });
  });
}

describeService("memory", async () => memoryHarness());

if (walkerTestDatabaseUrl) {
  const url = walkerTestDatabaseUrl;
  describeService("postgres", () => postgresHarness(url));
} else {
  describe.skip(SKIP_POSTGRES, () => {
    it("needs a local cluster", () => {});
  });
}
