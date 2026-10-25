import { execFile } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PhoneHomeResponse } from "@walker/contracts";
import { DbConnection } from "@walker/care-db/bindings";
import { CareDbClient, CircleService, MemoryWalkerStore, SpacetimeCircleStore, WalkerService, careDbDiscovery, careDbJwks, mintCareToken, sha256, type CareDbConfig, type MemberCaller, type OwnerCaller } from "../../src";
import { Clock, SKIP_SPACETIME, spacetimeTestServer, uuid } from "./support";

/**
 * The care-db module's live views (services/care-db/src/index.ts, "Views"), as a phone and the owner's page see
 * them over a real WebSocket with the generated client bindings, against a local SpacetimeDB server.
 * State is made the way the app makes it: WalkerService + CircleService over SpacetimeCircleStore.
 * Expected, written before the run:
 * 1. A caretaker's member token sees only her own walker's approved people, and only messages to or from her:
 *    none of another walker's names or words, none of a third phone's thread, and no cookie hash anywhere
 *    (the generated view rows have no secretHash field).
 * 2. A waiting caretaker sees her own row as "waiting" and nothing else; when the owner approves, the same
 *    open connection gets the row as "member" and the people fill in, with no reconnect.
 * 3. A message is pushed to her phone's open subscription within 2 s of the send.
 * 4. Removing a caretaker deletes her membership row and empties her messages on her still-open connection.
 * 5. The owner's token sees every phone on its walker, waiting ones included, and its open codes without the
 *    digits; nothing of another walker.
 * 6. Refused: no token; a token signed with another key under the same issuer and kid; a member token calling a
 *    server procedure over HTTP. A member token for an unknown member connects and sees nothing.
 */

const WAIT_MS = 5_000;
const run = promisify(execFile);
const CARE_DB_DIR = fileURLToPath(new URL("../../../care-db", import.meta.url));
const VIEWS = ["my_membership", "my_people", "my_messages", "owner_members", "owner_invites"];
const ALL_VIEWS = VIEWS.map((v) => `SELECT * FROM ${v}`);

const owner = (secret: string | undefined): OwnerCaller => ({ kind: "owner", secret });
const phone = (secret: string | undefined): MemberCaller => ({ kind: "member", secret });
const json = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms} ms: ${label}`)), ms);
    }),
  ]);
}

/** Polls the client cache until `check` holds, or fails after `ms`. */
async function until(check: () => boolean, ms: number, label: string) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`Timed out after ${ms} ms: ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function member(home: PhoneHomeResponse) {
  if (home.membership !== "member") throw new Error(`Expected a member, got ${home.membership}.`);
  return home;
}

if (spacetimeTestServer) {
  const server = spacetimeTestServer;

  describe("care-db live views", () => {
    let issuerServer: Server;
    let config: CareDbConfig;
    let database = "";
    let clock: Clock;
    let walkers: WalkerService;
    let circle: CircleService;
    let open: DbConnection[] = [];
    const spacetime = (...args: string[]) => run("spacetime", args, { cwd: CARE_DB_DIR, maxBuffer: 16 * 1024 * 1024 });

    beforeAll(async () => {
      await spacetime("build", "-p", CARE_DB_DIR);
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      issuerServer = createServer((req, res) => {
        const body = req.url === "/.well-known/openid-configuration" ? careDbDiscovery(config) : req.url === "/.well-known/jwks.json" ? careDbJwks(config) : null;
        res.statusCode = body ? 200 : 404;
        res.setHeader("content-type", "application/json");
        res.end(body ? JSON.stringify(body) : "");
      });
      await new Promise<void>((resolve) => issuerServer.listen(0, "127.0.0.1", resolve));
      const address = issuerServer.address();
      if (!address || typeof address === "string") throw new Error("The test issuer has no port.");
      const jwk = privateKey.export({ format: "jwk" });
      database = `care-views-${crypto.randomUUID().slice(0, 8)}`;
      config = {
        uri: server,
        database,
        issuer: `http://127.0.0.1:${address.port}`,
        privateKey,
        kid: createHash("sha256").update(`${jwk.x}.${jwk.y}`).digest("hex").slice(0, 16),
      };
      await spacetime("publish", "-s", server, "-j", `${CARE_DB_DIR}/dist/bundle.js`, database, "-y");
      await spacetime("call", "-s", server, database, "configure", JSON.stringify(config.issuer), JSON.stringify("sophi-care"));
    }, 180_000);

    afterAll(async () => {
      if (database) await spacetime("delete", "-s", server, database, "-y").catch(() => {});
      if (issuerServer) await new Promise<void>((resolve) => issuerServer.close(() => resolve()));
    }, 60_000);

    beforeEach(() => {
      // The real clock: the module's own sweep runs on SpacetimeDB's clock every minute, and the tokens are checked against it.
      clock = new Clock();
      clock.t = Date.now();
      const store = new SpacetimeCircleStore(new MemoryWalkerStore(), new CareDbClient(config));
      walkers = new WalkerService(store, { now: clock.now });
      circle = new CircleService(store, { now: clock.now });
    });

    afterEach(() => {
      for (const c of open) {
        try {
          c.disconnect();
        } catch {
          // already closed
        }
      }
      open = [];
    });

    const token = (subject: string) => mintCareToken(config, subject, new Date()).token;

    type Outcome = { kind: "applied"; conn: DbConnection; connects: number } | { kind: "connect_error" | "disconnected" | "subscription_error"; error: string };

    /** Connects with `jwt` and subscribes to every view; resolves with what happened first. */
    function attach(jwt: string | undefined, queries = ALL_VIEWS): Promise<Outcome> {
      return withTimeout(
        new Promise<Outcome>((resolve) => {
          let connects = 0;
          const builder = DbConnection.builder().withUri(server).withDatabaseName(database);
          if (jwt) builder.withToken(jwt);
          const conn = builder
            .onConnect((c) => {
              connects++;
              c.subscriptionBuilder()
                .onApplied(() => resolve({ kind: "applied", conn, connects }))
                .onError((ctx) => resolve({ kind: "subscription_error", error: String(ctx.event ?? "subscription error") }))
                .subscribe(queries);
            })
            .onConnectError((_ctx, error) => resolve({ kind: "connect_error", error: String(error) }))
            .onDisconnect((_ctx, error) => resolve({ kind: "disconnected", error: String(error ?? "closed") }))
            .build();
          open.push(conn);
        }),
        WAIT_MS,
        "connect and subscribe",
      );
    }

    async function live(jwt: string) {
      const outcome = await attach(jwt);
      if (outcome.kind !== "applied") throw new Error(`Expected a live subscription, got ${outcome.kind}: ${outcome.error}`);
      return outcome.conn;
    }

    function rows(conn: DbConnection) {
      return {
        membership: [...conn.db.myMembership.iter()],
        people: [...conn.db.myPeople.iter()],
        messages: [...conn.db.myMessages.iter()],
        ownerMembers: [...conn.db.ownerMembers.iter()],
        ownerInvites: [...conn.db.ownerInvites.iter()],
      };
    }

    async function pairWalker(address: string) {
      const { secret, response } = await walkers.createPairingCode(owner(undefined));
      const paired = await walkers.pair({ code: response.code, service_version: "pi-0.1.0", name: "Rose's walker" }, address);
      return { secret, deviceId: paired.device_id };
    }

    async function addAndJoin(w: { secret: string; deviceId: string }, role: "walker_user" | "caregiver", who: string) {
      const { invite } = await circle.addPhone(owner(w.secret), w.deviceId, { name: who, role });
      const joined = await circle.join(phone(undefined), { code: invite.code, consent: { circle_data_notice: true } }, "198.51.100.7");
      return joined.secret;
    }

    async function approveAll(w: { secret: string; deviceId: string }) {
      for (const j of (await circle.ownerCircle(owner(w.secret), w.deviceId)).joins) {
        await circle.approveJoin(owner(w.secret), w.deviceId, j.member_id, { consent: { walker_user_agreed: true } });
      }
    }

    const idOf = async (secret: string) => member(await circle.home(phone(secret))).me.member_id;

    /** Her phone and approved caretakers, by name. */
    async function circleOf(address: string, walkerUser: string, caretakers: string[]) {
      const w = await pairWalker(address);
      const secrets: Record<string, string> = { [walkerUser]: await addAndJoin(w, "walker_user", walkerUser) };
      for (const name of caretakers) secrets[name] = await addAndJoin(w, "caregiver", name);
      await approveAll(w);
      const ids: Record<string, string> = {};
      for (const [name, secret] of Object.entries(secrets)) ids[name] = await idOf(secret);
      return { w, secrets, ids };
    }

    it("shows a caretaker only her own walker's people and her own thread, and no cookie hash", async () => {
      const a = await circleOf("203.0.113.10", "Rose", ["Maya", "Ana"]);
      const b = await circleOf("203.0.113.11", "Edna", ["Nora"]);
      await circle.sendMessage(phone(a.secrets.Maya!), { client_message_id: uuid(), text: "Lunch at noon?" });
      await circle.sendMessage(phone(a.secrets.Rose!), { client_message_id: uuid(), preset: "okay", to_member_id: a.ids.Maya! });
      await circle.sendMessage(phone(a.secrets.Rose!), { client_message_id: uuid(), preset: "call_me", to_member_id: a.ids.Ana! });
      await circle.sendMessage(phone(a.secrets.Ana!), { client_message_id: uuid(), text: "Ana's private note" });
      await circle.sendMessage(phone(b.secrets.Nora!), { client_message_id: uuid(), text: "Walker B's pharmacy run" });

      const conn = await live(token(`member:${a.ids.Maya}`));
      const seen = rows(conn);
      const dump = json(seen);
      console.info(`[case 1] Maya's views: ${dump}`);

      expect(seen.membership.map((m) => [m.name, m.state])).toEqual([["Maya", "member"]]);
      expect(seen.people.map((p) => p.name).sort()).toEqual(["Ana", "Maya", "Rose"]);
      expect(seen.people.every((p) => p.deviceId === a.w.deviceId)).toBe(true);
      expect(seen.messages.map((m) => m.text)).toEqual(["Lunch at noon?", "I'm okay"]);
      expect(seen.messages.every((m) => m.fromMemberId === a.ids.Maya || m.toMemberId === a.ids.Maya)).toBe(true);
      expect(seen.ownerMembers).toEqual([]);
      expect(seen.ownerInvites).toEqual([]);
      for (const absent of ["Edna", "Nora", "pharmacy", "Ana's private note", "Can you call me?", b.w.deviceId, ...Object.values(b.ids)]) {
        expect(dump).not.toContain(absent);
      }
      // No cookie hash, by value or by field, in any row; nor in the generated view row types.
      for (const secret of [...Object.values(a.secrets), ...Object.values(b.secrets)]) expect(dump).not.toContain(sha256(secret));
      expect(dump.toLowerCase()).not.toContain("secret");
      for (const view of VIEWS) {
        expect(readFileSync(`${CARE_DB_DIR}/bindings/${view}_table.ts`, "utf8").toLowerCase()).not.toContain("secret");
      }
    }, 30_000);

    it("pushes a caretaker's approval to her open connection, with no reconnect", async () => {
      const w = await pairWalker("203.0.113.20");
      await addAndJoin(w, "walker_user", "Rose");
      const mayaSecret = await addAndJoin(w, "caregiver", "Maya");
      const mayaId = (await circle.ownerCircle(owner(w.secret), w.deviceId)).joins[0]!.member_id;

      const outcome = await attach(token(`member:${mayaId}`));
      if (outcome.kind !== "applied") throw new Error(`Expected a live subscription, got ${outcome.kind}`);
      const conn = outcome.conn;
      const before = rows(conn);
      expect(before.membership.map((m) => [m.memberId, m.name, m.state])).toEqual([[mayaId, "Maya", "waiting"]]);
      expect(before.people).toEqual([]);
      expect(before.messages).toEqual([]);

      const events: string[] = [];
      let pushedAt = 0;
      conn.db.myMembership.onUpdate((_ctx, oldRow, newRow) => {
        events.push(`update ${oldRow.state}->${newRow.state}`);
        if (newRow.state === "member" && !pushedAt) pushedAt = performance.now();
      });
      conn.db.myMembership.onInsert((_ctx, row) => {
        events.push(`insert ${row.state}`);
        if (row.state === "member" && !pushedAt) pushedAt = performance.now();
      });
      conn.db.myMembership.onDelete((_ctx, row) => void events.push(`delete ${row.state}`));
      let peopleAt = 0;
      conn.db.myPeople.onInsert(() => void (peopleAt ||= performance.now()));

      const started = performance.now();
      await circle.approveJoin(owner(w.secret), w.deviceId, mayaId, { consent: { walker_user_agreed: true } });
      const returned = performance.now();
      await until(() => pushedAt > 0 && rows(conn).people.length === 2, WAIT_MS, "approval pushed to the open connection");

      const after = rows(conn);
      expect(after.membership.map((m) => [m.memberId, m.state])).toEqual([[mayaId, "member"]]);
      expect(after.people.map((p) => p.name).sort()).toEqual(["Maya", "Rose"]);
      expect(events).toContain("update waiting->member");
      expect(outcome.connects).toBe(1);
      expect(conn.isActive).toBe(true);
      expect(await idOf(mayaSecret)).toBe(mayaId);
      console.info(
        `[case 2] approval push: membership ${(pushedAt - started).toFixed(1)} ms after approveJoin started (${(pushedAt - returned).toFixed(1)} ms after it returned), people ${(peopleAt - started).toFixed(1)} ms; events ${json(events)}`,
      );
    }, 30_000);

    it("pushes a new message to her phone's open subscription within 2 s", async () => {
      const a = await circleOf("203.0.113.30", "Rose", ["Maya"]);
      const conn = await live(token(`member:${a.ids.Rose}`));
      expect(rows(conn).messages).toEqual([]);
      let arrived: { text: string; at: number } | undefined;
      conn.db.myMessages.onInsert((_ctx, row) => void (arrived ??= { text: row.text, at: performance.now() }));
      const started = performance.now();
      await circle.sendMessage(phone(a.secrets.Maya!), { client_message_id: uuid(), text: "On my way, ten minutes" });
      const returned = performance.now();
      await until(() => arrived !== undefined, 2_000, "message pushed within 2 s");
      expect(arrived!.text).toBe("On my way, ten minutes");
      expect(arrived!.at - started).toBeLessThan(2_000);
      console.info(`[case 3] message push: ${(arrived!.at - started).toFixed(1)} ms after sendMessage started (${(arrived!.at - returned).toFixed(1)} ms after it returned)`);
    }, 30_000);

    it("takes a removed caretaker's membership and messages off her still-open connection", async () => {
      const a = await circleOf("203.0.113.40", "Rose", ["Maya"]);
      await circle.sendMessage(phone(a.secrets.Maya!), { client_message_id: uuid(), text: "Lunch at noon?" });
      await circle.sendMessage(phone(a.secrets.Rose!), { client_message_id: uuid(), preset: "call_me", to_member_id: a.ids.Maya! });
      const conn = await live(token(`member:${a.ids.Maya}`));
      expect(rows(conn).messages).toHaveLength(2);
      expect(rows(conn).membership).toHaveLength(1);
      const deleted: string[] = [];
      conn.db.myMembership.onDelete((_ctx, row) => void deleted.push(`membership ${row.name}`));
      conn.db.myMessages.onDelete((_ctx, row) => void deleted.push(`message ${row.text}`));
      const started = performance.now();
      await circle.removeMember(owner(a.w.secret), a.w.deviceId, a.ids.Maya!);
      await until(() => rows(conn).membership.length === 0 && rows(conn).messages.length === 0 && rows(conn).people.length === 0, WAIT_MS, "removal pushed");
      const took = performance.now() - started;
      expect(deleted.sort()).toEqual(["membership Maya", "message Can you call me?", "message Lunch at noon?"]);
      expect(rows(conn)).toEqual({ membership: [], people: [], messages: [], ownerMembers: [], ownerInvites: [] });
      console.info(`[case 4] removal push: ${took.toFixed(1)} ms after removeMember started; deleted ${json(deleted)}`);
    }, 30_000);

    it("shows the owner's page its walker's phones, waiting ones too, and open codes without the digits", async () => {
      const a = await circleOf("203.0.113.50", "Rose", ["Maya"]);
      await addAndJoin(a.w, "caregiver", "Ana"); // waiting
      const { invite } = await circle.addPhone(owner(a.w.secret), a.w.deviceId, { name: "Ben", role: "caregiver" });
      const b = await circleOf("203.0.113.51", "Edna", ["Nora"]);
      const { invite: other } = await circle.addPhone(owner(b.w.secret), b.w.deviceId, { name: "Otto", role: "caregiver" });

      const conn = await live(token(`owner:${a.w.deviceId}`));
      const seen = rows(conn);
      const dump = json(seen);
      console.info(`[case 5] owner's views: ${dump}`);
      expect(seen.ownerMembers.map((m) => [m.name, m.state]).sort()).toEqual([
        ["Ana", "waiting"],
        ["Maya", "member"],
        ["Rose", "member"],
      ]);
      expect(seen.ownerInvites.map((i) => [i.name, i.role, i.inviteId])).toEqual([["Ben", "caregiver", invite.invite_id]]);
      expect(seen.ownerInvites.every((i) => !Object.keys(i).includes("code"))).toBe(true);
      expect(dump).not.toContain(invite.code);
      expect(dump).not.toContain(other.code);
      for (const absent of ["Edna", "Nora", "Otto", b.w.deviceId]) expect(dump).not.toContain(absent);
      expect(seen.membership).toEqual([]);
      expect(seen.people).toEqual([]);
      expect(seen.messages).toEqual([]);
    }, 30_000);

    it("refuses no token, a forged token and a member calling a server procedure; an unknown member sees nothing", async () => {
      const a = await circleOf("203.0.113.60", "Rose", ["Maya"]);
      await circle.sendMessage(phone(a.secrets.Maya!), { client_message_id: uuid(), text: "Lunch at noon?" });

      // (a) No token: an anonymous identity from the server itself.
      const anonymous = await attach(undefined);
      console.info(`[case 6a] anonymous: ${anonymous.kind}${"error" in anonymous ? ` (${anonymous.error})` : ""}`);
      expect(["connect_error", "disconnected"]).toContain(anonymous.kind);
      // The refusal is the module's own (clientConnected), not a socket failure.
      const logs = (await spacetime("logs", "-s", server, database)).stdout;
      console.info(`[case 6a] module log: ${logs.split("\n").filter((l) => l.includes("Connect through")).join(" | ").slice(0, 300)}`);
      expect(logs).toContain("Connect through Sophi's app.");

      // (b) The right issuer and kid, signed with another key.
      const { privateKey: wrongKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const forged = mintCareToken({ ...config, privateKey: wrongKey }, `member:${a.ids.Maya}`, new Date()).token;
      const forgedOutcome = await attach(forged);
      console.info(`[case 6b] forged: ${forgedOutcome.kind}${"error" in forgedOutcome ? ` (${forgedOutcome.error})` : ""}`);
      expect(["connect_error", "disconnected"]).toContain(forgedOutcome.kind);

      // (c) A member's token on a server procedure.
      const response = await fetch(`${server}/v1/database/${encodeURIComponent(database)}/call/circle_of`, {
        method: "POST",
        headers: { authorization: `Bearer ${token(`member:${a.ids.Maya}`)}`, "content-type": "application/json" },
        body: JSON.stringify({ device_id: a.w.deviceId, now: clock.iso() }),
        signal: AbortSignal.timeout(WAIT_MS),
      });
      const body = await response.text();
      console.info(`[case 6c] member calling circle_of: ${response.status} ${body.slice(0, 160)}`);
      expect(response.ok).toBe(false);
      for (const absent of ["Rose", "Maya", a.ids.Rose!, a.ids.Maya!]) expect(body).not.toContain(absent);

      // (d) A well-signed member token for a member that doesn't exist.
      const ghost = await live(token(`member:${uuid()}`));
      const seen = rows(ghost);
      console.info(`[case 6d] unknown member's views: ${json(seen)}`);
      expect(seen).toEqual({ membership: [], people: [], messages: [], ownerMembers: [], ownerInvites: [] });
    }, 30_000);
  });
} else {
  describe.skip(SKIP_SPACETIME, () => {
    it("needs a local spacetime server", () => {});
  });
}
