import { schema, table, t, SenderError, type InferSchema, type ReducerCtx, type ViewCtx } from "spacetimedb/server";
import { ScheduleAt, type Infer } from "spacetimedb";

/**
 * Sophi's care circle in SpacetimeDB (docs/interfaces.md, "The care circle on SpacetimeDB"): the phones in a
 * walker's circle, the one-time codes that add them, caretakers waiting for the owner's approval, and the
 * short messages between the phones. This database is where that state lives and where every change to it
 * happens, each as one transaction.
 *
 * Two kinds of caller:
 * - Sophi's server (apps/web on Render) calls the procedures below over HTTP, as the CircleStore behind
 *   CircleService. It has already checked the caller's cookie, the request's shape and the owner's consent;
 *   the procedures keep each step atomic, as the Postgres and memory stores do (store.ts, CircleStore).
 * - The phones and the owner's page connect over a WebSocket and subscribe to the views at the bottom, so a
 *   message, a join or an approval reaches them the moment it is committed. Each view shows one caller only
 *   their own circle; the tables themselves are private.
 *
 * Both prove who they are with a JWT that Sophi's server signs (ES256), published as an OpenID issuer at
 * `<issuer>/.well-known/openid-configuration`. SpacetimeDB checks the signature; this module checks the
 * issuer, the audience and the subject: `sophi-server`, `member:<member_id>` or `owner:<device_id>`.
 *
 * Times are ISO strings from the server's clock, as in the other stores, so the server's tests can fake the
 * clock. Only the scheduled sweep uses SpacetimeDB's own clock.
 */

const SERVER_SUBJECT = "sophi-server";
/** Lapsed caretaker joins are kept this long (CIRCLE_ITEM_RETENTION_MS in @walker/contracts). */
const ITEM_RETENTION_MS = 24 * 60 * 60_000;
/** Wrong codes count for this long (PAIRING_LOCK_WINDOW_MS in @walker/contracts). */
const LOCK_WINDOW_MS = 10 * 60_000;
const SWEEP_EVERY_MICROS = 60_000_000n;

const config = table(
  { name: "config" },
  {
    id: t.u8().primaryKey(),
    /** Who published the database; only they can set the issuer. */
    admin: t.identity(),
    /** The server's public origin, such as https://steady-walker.onrender.com. Empty until configured: nobody gets in. */
    issuer: t.string(),
    audience: t.string(),
    /** Orders rows by when they were made (auto-increment ids may have gaps and aren't for ordering). */
    next_seq: t.u64(),
  },
);

const member = table(
  { name: "circle_member" },
  {
    member_id: t.string().primaryKey(),
    device_id: t.string().index("btree"),
    /** SHA-256 of the phone's cookie secret; the secret itself never leaves the server. */
    secret_hash: t.string().unique(),
    name: t.string(),
    /** `walker_user` (her own phone) or `caregiver`. */
    role: t.string(),
    /** `waiting`: a caretaker the owner hasn't approved yet. `member`: in. */
    state: t.string(),
    created_at: t.string(),
    expires_at: t.option(t.string()),
    joined_at: t.option(t.string()),
    /** This browser's earlier membership, removed once this one is in. */
    replaces_member_id: t.option(t.string()),
    seq: t.u64(),
  },
);

const invite = table(
  { name: "circle_invite" },
  {
    invite_id: t.string().primaryKey(),
    device_id: t.string().index("btree"),
    code: t.string().index("btree"),
    name: t.string(),
    role: t.string(),
    created_at: t.string(),
    expires_at: t.string(),
    seq: t.u64(),
  },
);

const message = table(
  {
    name: "circle_message",
    indexes: [{ accessor: "by_sender_client_id", algorithm: "btree", columns: ["from_member_id", "client_message_id"] }],
  },
  {
    message_id: t.string().primaryKey(),
    device_id: t.string().index("btree"),
    client_message_id: t.string(),
    from_member_id: t.string(),
    to_member_id: t.string().index("btree"),
    text: t.string(),
    /** Past the walker's newest MAX_LIVE_MESSAGES: its text is gone, the row stays until it expires so a retry isn't saved again. */
    cleared: t.bool(),
    created_at: t.string(),
    expires_at: t.string(),
    seq: t.u64(),
  },
);

/** A wrong code, by the server's keyed hash of the client's address (never the address). */
const joinTry = table(
  { name: "join_try" },
  {
    id: t.u64().primaryKey().autoInc(),
    address_key: t.string().index("btree"),
    at: t.string(),
  },
);

/** Which subject each connected identity proved with its JWT, so the views can find the caller. */
const session = table(
  { name: "session" },
  {
    identity: t.identity().primaryKey(),
    subject: t.string().index("btree"),
  },
);

const sweepTimer = table(
  { name: "sweep_timer" },
  {
    scheduled_id: t.u64().primaryKey().autoInc(),
    scheduled_at: t.scheduleAt(),
  },
);

const spacetimedb = schema({ config, member, invite, message, joinTry, session, sweepTimer });
export default spacetimedb;

type Ctx = ReducerCtx<InferSchema<typeof spacetimedb>>;
type MemberRow = Infer<typeof member.rowType>;
type InviteRow = Infer<typeof invite.rowType>;
type MessageRow = Infer<typeof message.rowType>;

const ms = (iso: string) => Date.parse(iso);
const bySeq = (a: { seq: bigint }, b: { seq: bigint }) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0);

function nextSeq(ctx: Ctx): bigint {
  const c = ctx.db.config.id.find(0);
  if (!c) throw new SenderError("The care database isn't set up.");
  ctx.db.config.id.update({ ...c, next_seq: c.next_seq + 1n });
  return c.next_seq;
}

function requireServer(ctx: Ctx) {
  const c = ctx.db.config.id.find(0);
  const jwt = ctx.senderAuth.jwt;
  if (!c || !c.issuer || !jwt || jwt.issuer !== c.issuer || jwt.subject !== SERVER_SUBJECT || !jwt.audience.includes(c.audience)) {
    throw new SenderError("Only Sophi's server can call this.");
  }
}

/** In the circle at `nowMs`: a member, or a caretaker whose join hasn't lapsed. */
function counts(m: MemberRow, nowMs: number) {
  return m.state === "member" || (m.expires_at !== undefined && ms(m.expires_at) > nowMs);
}

function membersOf(ctx: Ctx, deviceId: string): MemberRow[] {
  return [...ctx.db.member.device_id.filter(deviceId)].sort(bySeq);
}

function invitesOf(ctx: Ctx, deviceId: string): InviteRow[] {
  return [...ctx.db.invite.device_id.filter(deviceId)].sort(bySeq);
}

function messagesOf(ctx: Ctx, deviceId: string): MessageRow[] {
  return [...ctx.db.message.device_id.filter(deviceId)].sort(bySeq);
}

// The records the server reads back: the same shapes as store.ts (CircleMemberRecord and the rest).
function memberRecord(m: MemberRow) {
  return { member_id: m.member_id, device_id: m.device_id, name: m.name, role: m.role, state: m.state, created_at: m.created_at, expires_at: m.expires_at ?? null, joined_at: m.joined_at ?? null };
}
function inviteRecord(i: InviteRow) {
  return { invite_id: i.invite_id, device_id: i.device_id, code: i.code, name: i.name, role: i.role, created_at: i.created_at, expires_at: i.expires_at };
}
function messageRecord(m: MessageRow) {
  return { message_id: m.message_id, device_id: m.device_id, client_message_id: m.client_message_id, from_member_id: m.from_member_id, to_member_id: m.to_member_id, text: m.text, created_at: m.created_at, expires_at: m.expires_at };
}

/**
 * Removes a member wherever it is, with every message to or from it. Returns the walkers whose own phone
 * this was, so the server can turn off their GPS sharing (that setting lives with the walker, not here).
 */
function dropMember(ctx: Ctx, memberId: string): string[] {
  const m = ctx.db.member.member_id.find(memberId);
  if (!m) return [];
  const sent = [...ctx.db.message.device_id.filter(m.device_id)].filter((x) => x.from_member_id === memberId || x.to_member_id === memberId);
  for (const x of sent) ctx.db.message.message_id.delete(x.message_id);
  ctx.db.member.member_id.delete(memberId);
  forgetSessions(ctx, `member:${memberId}`);
  return m.role === "walker_user" ? [m.device_id] : [];
}

/** A removed phone's or forgotten walker's connections: their views were already empty, and now nothing is kept. */
function forgetSessions(ctx: Ctx, subject: string) {
  for (const x of [...ctx.db.session.subject.filter(subject)]) ctx.db.session.identity.delete(x.identity);
}

function sweep(ctx: Ctx, nowMs: number, lapsedBeforeMs: number, triesBeforeMs: number) {
  for (const i of [...ctx.db.invite.iter()]) if (ms(i.expires_at) <= nowMs) ctx.db.invite.invite_id.delete(i.invite_id);
  for (const m of [...ctx.db.message.iter()]) if (ms(m.expires_at) <= nowMs) ctx.db.message.message_id.delete(m.message_id);
  for (const m of [...ctx.db.member.iter()]) {
    if (m.state !== "member" && m.expires_at !== undefined && ms(m.expires_at) < lapsedBeforeMs) dropMember(ctx, m.member_id);
  }
  for (const x of [...ctx.db.joinTry.iter()]) if (ms(x.at) < triesBeforeMs) ctx.db.joinTry.id.delete(x.id);
}

/** An empty string stands for "none" in procedure arguments, which arrive as JSON from the server. */
const orNone = (s: string) => (s === "" ? undefined : s);

// ---- Setup ----

export const init = spacetimedb.init((ctx) => {
  ctx.db.config.insert({ id: 0, admin: ctx.sender, issuer: "", audience: "sophi-care", next_seq: 1n });
  ctx.db.sweepTimer.insert({ scheduled_id: 0n, scheduled_at: ScheduleAt.interval(SWEEP_EVERY_MICROS) });
});

/** Run once after publishing, by the account that published: `spacetime call <db> configure '"<issuer>"' '"sophi-care"'`. */
export const configure = spacetimedb.reducer({ issuer: t.string(), audience: t.string() }, (ctx, { issuer, audience }) => {
  const c = ctx.db.config.id.find(0);
  if (!c || !c.admin.equals(ctx.sender)) throw new SenderError("Only the account that published this database can configure it.");
  ctx.db.config.id.update({ ...c, issuer, audience });
});

/** Deletes expired codes and messages, lapsed joins and old wrong codes even when no request comes in. */
export const sweepOnSchedule = spacetimedb.reducer({ onSchedule: sweepTimer }, { timer: sweepTimer.rowType }, (ctx) => {
  const nowMs = Number(ctx.timestamp.microsSinceUnixEpoch / 1000n);
  sweep(ctx, nowMs, nowMs - ITEM_RETENTION_MS, nowMs - LOCK_WINDOW_MS);
});

/**
 * Every caller connects first, HTTP calls included. Let in the account that published the database (to run
 * `configure`), Sophi's server, and a phone or owner's page with a JWT from Sophi's server; refuse the rest.
 * Only phones and owner pages get a session row, which is what the views read.
 */
export const onConnect = spacetimedb.clientConnected((ctx) => {
  const c = ctx.db.config.id.find(0);
  if (c && c.admin.equals(ctx.sender)) return;
  const jwt = ctx.senderAuth.jwt;
  const ours = !!c && c.issuer !== "" && !!jwt && jwt.issuer === c.issuer && jwt.audience.includes(c.audience);
  if (ours && jwt.subject === SERVER_SUBJECT) return;
  if (!ours || !/^(member|owner):[0-9a-f-]{36}$/.test(jwt.subject)) throw new SenderError("Connect through Sophi's app.");
  const known = ctx.db.session.identity.find(ctx.sender);
  if (known) ctx.db.session.identity.update({ ...known, subject: jwt.subject });
  else ctx.db.session.insert({ identity: ctx.sender, subject: jwt.subject });
});

export const onDisconnect = spacetimedb.clientDisconnected(() => {});

// ---- The server's procedures: one per CircleStore step (store.ts). Each returns JSON. ----

export const ping = spacetimedb.procedure({}, t.string(), (ctx) =>
  ctx.withTx((tx) => {
    requireServer(tx);
    return JSON.stringify("ok");
  }),
);

export const putInvite = spacetimedb.procedure(
  {
    invite_id: t.string(),
    device_id: t.string(),
    code: t.string(),
    name: t.string(),
    role: t.string(),
    created_at: t.string(),
    expires_at: t.string(),
    max_open: t.u32(),
    max_members: t.u32(),
    now: t.string(),
  },
  t.string(),
  (ctx, a) =>
    ctx.withTx((tx) => {
      requireServer(tx);
      const nowMs = ms(a.now);
      for (const i of invitesOf(tx, a.device_id)) if (ms(i.expires_at) <= nowMs) tx.db.invite.invite_id.delete(i.invite_id);
      const members = membersOf(tx, a.device_id);
      if (a.role === "walker_user") {
        if (members.some((m) => m.role === "walker_user")) return JSON.stringify("walker_user_taken");
        for (const i of invitesOf(tx, a.device_id)) if (i.role === "walker_user") tx.db.invite.invite_id.delete(i.invite_id);
      }
      if (invitesOf(tx, a.device_id).length >= a.max_open || members.filter((m) => counts(m, nowMs)).length >= a.max_members) return JSON.stringify("circle_full");
      if ([...tx.db.invite.code.filter(a.code)].some((i) => ms(i.expires_at) > nowMs)) return JSON.stringify("code_taken");
      tx.db.invite.insert({ invite_id: a.invite_id, device_id: a.device_id, code: a.code, name: a.name, role: a.role, created_at: a.created_at, expires_at: a.expires_at, seq: nextSeq(tx) });
      return JSON.stringify("ok");
    }),
);

export const circleOf = spacetimedb.procedure({ device_id: t.string(), now: t.string() }, t.string(), (ctx, a) =>
  ctx.withTx((tx) => {
    requireServer(tx);
    const nowMs = ms(a.now);
    return JSON.stringify({
      members: membersOf(tx, a.device_id).map(memberRecord),
      invites: invitesOf(tx, a.device_id).filter((i) => ms(i.expires_at) > nowMs).map(inviteRecord),
    });
  }),
);

export const claimInvite = spacetimedb.procedure(
  {
    code: t.string(),
    now: t.string(),
    member_id: t.string(),
    secret_hash: t.string(),
    created_at: t.string(),
    replaces_member_id: t.string(),
    waiting_until: t.string(),
    max_members: t.u32(),
    address_key: t.string(),
    tries_since: t.string(),
    max_wrong: t.u32(),
  },
  t.string(),
  (ctx, a) =>
    ctx.withTx((tx) => {
      requireServer(tx);
      const nowMs = ms(a.now);
      const wrong = [...tx.db.joinTry.address_key.filter(a.address_key)].filter((x) => ms(x.at) > ms(a.tries_since)).length;
      if (wrong >= a.max_wrong) return JSON.stringify({ ok: false, reason: "locked" });
      const found = [...tx.db.invite.code.filter(a.code)].sort(bySeq).find((i) => ms(i.expires_at) > nowMs);
      if (!found) {
        tx.db.joinTry.insert({ id: 0n, address_key: a.address_key, at: a.now });
        return JSON.stringify({ ok: false, reason: "code_invalid" });
      }
      const members = membersOf(tx, found.device_id);
      if (members.filter((m) => counts(m, nowMs)).length >= a.max_members) return JSON.stringify({ ok: false, reason: "circle_full" });
      if (found.role === "walker_user" && members.some((m) => m.role === "walker_user")) return JSON.stringify({ ok: false, reason: "walker_user_taken" });
      tx.db.invite.invite_id.delete(found.invite_id);
      const waiting = found.role === "caregiver";
      const row = tx.db.member.insert({
        member_id: a.member_id,
        device_id: found.device_id,
        secret_hash: a.secret_hash,
        name: found.name,
        role: found.role,
        state: waiting ? "waiting" : "member",
        created_at: a.created_at,
        expires_at: waiting ? a.waiting_until : undefined,
        joined_at: waiting ? undefined : a.created_at,
        replaces_member_id: orNone(a.replaces_member_id),
        seq: nextSeq(tx),
      });
      return JSON.stringify({ ok: true, member: memberRecord(row) });
    }),
);

export const memberBySecret = spacetimedb.procedure({ secret_hash: t.string() }, t.string(), (ctx, a) =>
  ctx.withTx((tx) => {
    requireServer(tx);
    const m = tx.db.member.secret_hash.find(a.secret_hash);
    return JSON.stringify(m ? memberRecord(m) : null);
  }),
);

export const approveJoin = spacetimedb.procedure({ device_id: t.string(), member_id: t.string(), now: t.string() }, t.string(), (ctx, a) =>
  ctx.withTx((tx) => {
    requireServer(tx);
    const m = tx.db.member.member_id.find(a.member_id);
    if (!m || m.device_id !== a.device_id) return JSON.stringify({ member: null, sharing_reset: [] });
    if (m.state === "member") return JSON.stringify({ member: memberRecord(m), sharing_reset: [] });
    if (!counts(m, ms(a.now))) return JSON.stringify({ member: null, sharing_reset: [] });
    const approved = tx.db.member.member_id.update({ ...m, state: "member", expires_at: undefined, joined_at: a.now });
    const sharingReset = m.replaces_member_id ? dropMember(tx, m.replaces_member_id) : [];
    return JSON.stringify({ member: memberRecord(approved), sharing_reset: sharingReset });
  }),
);

export const removeMember = spacetimedb.procedure({ device_id: t.string(), member_id: t.string() }, t.string(), (ctx, a) =>
  ctx.withTx((tx) => {
    requireServer(tx);
    const m = tx.db.member.member_id.find(a.member_id);
    if (!m || m.device_id !== a.device_id) return JSON.stringify({ removed: false, sharing_reset: [] });
    return JSON.stringify({ removed: true, sharing_reset: dropMember(tx, a.member_id) });
  }),
);

export const saveMessage = spacetimedb.procedure(
  {
    message_id: t.string(),
    device_id: t.string(),
    client_message_id: t.string(),
    from_member_id: t.string(),
    to_member_id: t.string(),
    text: t.string(),
    created_at: t.string(),
    expires_at: t.string(),
    max_live: t.u32(),
    now: t.string(),
  },
  t.string(),
  (ctx, a) =>
    ctx.withTx((tx) => {
      requireServer(tx);
      const prior = [...tx.db.message.by_sender_client_id.filter([a.from_member_id, a.client_message_id])][0];
      if (prior?.cleared) return JSON.stringify("cleared");
      if (prior) return JSON.stringify({ message: messageRecord(prior), created: false });
      const isMember = (id: string) => {
        const m = tx.db.member.member_id.find(id);
        return !!m && m.device_id === a.device_id && m.state === "member";
      };
      if (!isMember(a.from_member_id) || !isMember(a.to_member_id)) return JSON.stringify(null);
      const nowMs = ms(a.now);
      for (const m of messagesOf(tx, a.device_id)) if (ms(m.expires_at) <= nowMs) tx.db.message.message_id.delete(m.message_id);
      const saved = tx.db.message.insert({
        message_id: a.message_id,
        device_id: a.device_id,
        client_message_id: a.client_message_id,
        from_member_id: a.from_member_id,
        to_member_id: a.to_member_id,
        text: a.text,
        cleared: false,
        created_at: a.created_at,
        expires_at: a.expires_at,
        seq: nextSeq(tx),
      });
      const live = messagesOf(tx, a.device_id).filter((m) => !m.cleared);
      for (const old of live.slice(0, Math.max(0, live.length - a.max_live))) tx.db.message.message_id.update({ ...old, cleared: true, text: "" });
      return JSON.stringify({ message: messageRecord(saved), created: true });
    }),
);

export const messagesFor = spacetimedb.procedure({ device_id: t.string(), member_id: t.string(), now: t.string() }, t.string(), (ctx, a) =>
  ctx.withTx((tx) => {
    requireServer(tx);
    const nowMs = ms(a.now);
    return JSON.stringify(
      messagesOf(tx, a.device_id)
        .filter((m) => !m.cleared && ms(m.expires_at) > nowMs && (m.from_member_id === a.member_id || m.to_member_id === a.member_id))
        .map(messageRecord),
    );
  }),
);

export const sweepCircle = spacetimedb.procedure({ now: t.string(), lapsed_before: t.string(), tries_before: t.string() }, t.string(), (ctx, a) =>
  ctx.withTx((tx) => {
    requireServer(tx);
    sweep(tx, ms(a.now), ms(a.lapsed_before), ms(a.tries_before));
    return JSON.stringify("ok");
  }),
);

/** The walker was forgotten: its whole circle goes. */
export const forgetWalker = spacetimedb.procedure({ device_id: t.string() }, t.string(), (ctx, a) =>
  ctx.withTx((tx) => {
    requireServer(tx);
    for (const m of membersOf(tx, a.device_id)) dropMember(tx, m.member_id);
    for (const i of invitesOf(tx, a.device_id)) tx.db.invite.invite_id.delete(i.invite_id);
    for (const m of messagesOf(tx, a.device_id)) tx.db.message.message_id.delete(m.message_id);
    forgetSessions(tx, `owner:${a.device_id}`);
    return JSON.stringify("ok");
  }),
);

// ---- Views: what each phone and the owner's page sees, live. Never the cookie hash, never another circle. ----

const MemberView = t.row("CircleMemberView", {
  member_id: t.string().primaryKey(),
  device_id: t.string(),
  name: t.string(),
  role: t.string(),
  state: t.string(),
  created_at: t.string(),
  expires_at: t.option(t.string()),
  joined_at: t.option(t.string()),
  seq: t.u64(),
});

const MessageView = t.row("CircleMessageView", {
  message_id: t.string().primaryKey(),
  device_id: t.string(),
  client_message_id: t.string(),
  from_member_id: t.string(),
  to_member_id: t.string(),
  text: t.string(),
  created_at: t.string(),
  seq: t.u64(),
});

const InviteView = t.row("CircleInviteView", {
  invite_id: t.string().primaryKey(),
  device_id: t.string(),
  name: t.string(),
  role: t.string(),
  expires_at: t.string(),
  seq: t.u64(),
});

type ViewDb = ViewCtx<InferSchema<typeof spacetimedb>>;

function subjectOf(ctx: ViewDb, kind: "member" | "owner"): string | undefined {
  const s = ctx.db.session.identity.find(ctx.sender);
  return s?.subject.startsWith(`${kind}:`) ? s.subject.slice(kind.length + 1) : undefined;
}

function me(ctx: ViewDb): MemberRow | undefined {
  const id = subjectOf(ctx, "member");
  return id ? (ctx.db.member.member_id.find(id) ?? undefined) : undefined;
}

const memberView = (m: MemberRow) => ({ member_id: m.member_id, device_id: m.device_id, name: m.name, role: m.role, state: m.state, created_at: m.created_at, expires_at: m.expires_at, joined_at: m.joined_at, seq: m.seq });

/** This phone's own membership: waiting, then in the moment the owner approves; gone when removed. */
export const myMembership = spacetimedb.view({ name: "my_membership", public: true }, t.array(MemberView), (ctx) => {
  const m = me(ctx);
  return m ? [memberView(m)] : [];
});

/** The people in this phone's circle, once it is in. */
export const myPeople = spacetimedb.view({ name: "my_people", public: true }, t.array(MemberView), (ctx) => {
  const m = me(ctx);
  if (!m || m.state !== "member") return [];
  return [...ctx.db.member.device_id.filter(m.device_id)].filter((x) => x.state === "member").sort(bySeq).map(memberView);
});

/** Messages to or from this phone (not cleared ones), once it is in. */
export const myMessages = spacetimedb.view({ name: "my_messages", public: true }, t.array(MessageView), (ctx) => {
  const m = me(ctx);
  if (!m || m.state !== "member") return [];
  return [...ctx.db.message.device_id.filter(m.device_id)]
    .filter((x) => !x.cleared && (x.from_member_id === m.member_id || x.to_member_id === m.member_id))
    .sort(bySeq)
    .map((x) => ({ message_id: x.message_id, device_id: x.device_id, client_message_id: x.client_message_id, from_member_id: x.from_member_id, to_member_id: x.to_member_id, text: x.text, created_at: x.created_at, seq: x.seq }));
});

/** The owner's page: every phone and waiting caretaker on this walker. */
export const ownerMembers = spacetimedb.view({ name: "owner_members", public: true }, t.array(MemberView), (ctx) => {
  const deviceId = subjectOf(ctx, "owner");
  return deviceId ? [...ctx.db.member.device_id.filter(deviceId)].sort(bySeq).map(memberView) : [];
});

/** The owner's page: open codes (without the digits, which the page already has from the server). */
export const ownerInvites = spacetimedb.view({ name: "owner_invites", public: true }, t.array(InviteView), (ctx) => {
  const deviceId = subjectOf(ctx, "owner");
  return deviceId
    ? [...ctx.db.invite.device_id.filter(deviceId)].sort(bySeq).map((i) => ({ invite_id: i.invite_id, device_id: i.device_id, name: i.name, role: i.role, expires_at: i.expires_at, seq: i.seq }))
    : [];
});
