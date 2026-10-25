import type { CareLiveAccess } from "@walker/contracts";
import type { DbConnection } from "@walker/care-db/bindings";
import type { PhoneHome, PhoneMessage, PhonePerson } from "./phoneApi";

/**
 * Live updates for the circle from SpacetimeDB (docs/interfaces.md, "The care circle on SpacetimeDB"). The
 * server hands the page a short-lived token for its own subject; the page connects with it and subscribes to
 * its views, which SpacetimeDB keeps current the moment a change commits. Writes still go through the
 * server's routes. Without SpacetimeDB on the server (`live: null`), nothing here runs and the page polls.
 */

/** A phone's live rows: its own membership, then (once it is in) its circle's people and its messages. */
export interface PhoneLiveRows {
  membership: { member_id: string; state: string } | null;
  people: { member_id: string; name: string; role: string; seq: bigint }[];
  messages: { message_id: string; client_message_id: string; from_member_id: string; to_member_id: string; text: string; seq: bigint }[];
  /** One row per help request of its walker (`my_help`): no names, places or times, only a revision that goes up on every change. */
  help: { help_id: string; rev: bigint }[];
}

export type LiveStatus = "off" | "connecting" | "live" | "lost";

export interface LiveHandle {
  close(): void;
}

export const PHONE_VIEWS = ["SELECT * FROM my_membership", "SELECT * FROM my_people", "SELECT * FROM my_messages"];
/**
 * Optional: a module published before help existed (no `my_help`) refuses it, and the phone subscribes again without
 * it, keeping the circle's live rows; it then keeps polling every 2 s for help (phoneView.pollEvery).
 */
export const PHONE_HELP_VIEWS = ["SELECT * FROM my_help"];
export const OWNER_VIEWS = ["SELECT * FROM owner_members", "SELECT * FROM owner_invites"];

/** After a first connection that failed, or one SpacetimeDB won't retry, try again this much later. */
const RETRY_MS = 5_000;

/**
 * Opens one live connection. `onRows` runs after the first full set of rows and after every change (batched
 * to once per task); `onStatus` reports the connection. `extra` views are subscribed with the others: `onExtra(true)`
 * once they are applied, `onExtra(false)` if the module refuses them (the others are then subscribed alone). The SDK reconnects a dropped connection by itself,
 * asking `access` for a fresh token; a first connection that fails (SpacetimeDB waking up, the server busy)
 * is tried again every RETRY_MS. The SpacetimeDB client is loaded only once the server says there is one.
 */
export function openLive(
  access: () => Promise<CareLiveAccess | null>,
  views: string[],
  onRows: (conn: DbConnection) => void,
  onStatus: (status: LiveStatus) => void,
  extra?: { views: string[]; onExtra(applied: boolean): void },
): LiveHandle {
  let closed = false;
  let conn: DbConnection | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let queued = false;
  const changed = () => {
    if (queued || closed) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      if (!closed && conn) onRows(conn);
    });
  };
  const drop = () => {
    try {
      conn?.disconnect();
    } catch {
      // Already closed.
    }
    conn = undefined;
  };
  const again = () => {
    if (closed || retry) return;
    onStatus("lost");
    drop();
    retry = setTimeout(() => {
      retry = undefined;
      void start();
    }, RETRY_MS);
  };

  async function start() {
    let first: CareLiveAccess | null;
    try {
      first = await access();
    } catch {
      return again();
    }
    if (closed) return;
    if (!first) return onStatus("off");
    const { DbConnection } = await import("@walker/care-db/bindings");
    if (closed) return;
    onStatus("connecting");
    let connected = false;
    // The extra views go in the same subscription. If the module refuses them (published before they existed), the
    // connection subscribes again without them, so the circle's live rows keep working.
    let withExtra = !!extra;
    const subscribe = (c: DbConnection) => {
      c.subscriptionBuilder()
        .onApplied(() => {
          if (closed) return;
          if (extra) extra.onExtra(withExtra);
          onStatus("live");
          changed();
        })
        .onError(() => {
          if (closed) return;
          if (withExtra) {
            withExtra = false;
            extra?.onExtra(false);
            subscribe(c);
          } else again();
        })
        .subscribe(withExtra && extra ? [...views, ...extra.views] : views);
    };
    const token = first.token;
    conn = DbConnection.builder()
      .withUri(first.uri)
      .withDatabaseName(first.database)
      .withToken(token)
      .withAutomaticReconnect()
      .withTokenProvider(async () => (await access())?.token ?? token)
      .onConnect((c) => {
        connected = true;
        subscribe(c);
      })
      .onAutomaticReconnect(() => !closed && onStatus("live"))
      // The SDK never retries a first connection; after one, it retries until it gives up (no next attempt).
      .onConnectError(() => (connected ? !closed && onStatus("lost") : again()))
      .onDisconnect((_ctx, _error, nextAttempt) => (nextAttempt === undefined ? again() : !closed && onStatus("lost")))
      .build();
    for (const table of [conn.db.myMembership, conn.db.myPeople, conn.db.myMessages, conn.db.myHelp, conn.db.ownerMembers, conn.db.ownerInvites]) {
      table.onInsert(changed);
      table.onDelete(changed);
      table.onUpdate?.(changed);
    }
  }
  void start();

  return {
    close() {
      closed = true;
      clearTimeout(retry);
      // Whatever its state, connecting and reconnecting included: otherwise it would keep trying after the page left.
      drop();
    },
  };
}

const bySeq = (a: { seq: bigint }, b: { seq: bigint }) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0);

export function phoneRows(conn: DbConnection): PhoneLiveRows {
  const membership = [...conn.db.myMembership.iter()][0];
  return {
    membership: membership ? { member_id: membership.memberId, state: membership.state } : null,
    people: [...conn.db.myPeople.iter()].map((p) => ({ member_id: p.memberId, name: p.name, role: p.role, seq: p.seq })).sort(bySeq),
    messages: [...conn.db.myMessages.iter()]
      .map((m) => ({ message_id: m.messageId, client_message_id: m.clientMessageId, from_member_id: m.fromMemberId, to_member_id: m.toMemberId, text: m.text, seq: m.seq }))
      .sort(bySeq),
    help: [...conn.db.myHelp.iter()].map((h) => ({ help_id: h.helpId, rev: h.rev })),
  };
}

/** A key that changes exactly when a help row is added, changed or removed; null before `my_help` is subscribed. */
export const helpRowsKey = (live: PhoneLiveRows | null, subscribed: boolean): string | null =>
  live && subscribed ? live.help.map((h) => `${h.help_id}:${h.rev}`).sort().join(",") : null;

/**
 * The phone's home with its circle from the live rows: the people and messages as SpacetimeDB has them now,
 * and the walker's status (online, alerts, parts, GPS) from the server's last answer. Only for a phone that
 * both sides agree is in; otherwise the server's home as it is.
 */
export function withLiveCircle(home: PhoneHome | null, live: PhoneLiveRows | null): PhoneHome | null {
  if (!home || home.membership !== "member" || !live || live.membership?.state !== "member" || live.membership.member_id !== home.me.member_id) return home;
  const me = home.me.member_id;
  const people: PhonePerson[] = live.people.flatMap((p) => (p.role === "walker_user" || p.role === "caregiver" ? [{ member_id: p.member_id, name: p.name, role: p.role }] : []));
  const names = new Map(people.map((p) => [p.member_id, p.name]));
  const messages: PhoneMessage[] = live.messages.map((m) => ({
    message_id: m.message_id,
    client_message_id: m.client_message_id,
    from_member_id: m.from_member_id,
    from_name: names.get(m.from_member_id) ?? "Someone",
    to_member_id: m.to_member_id,
    text: m.text,
    mine: m.from_member_id === me,
  }));
  return { ...home, people, messages };
}

/**
 * Whether the live membership says something the server's last home doesn't (approved, removed, a different
 * phone): then the page asks the server again at once.
 */
export function membershipMoved(home: PhoneHome | null, live: PhoneLiveRows | null): boolean {
  if (!home || !live) return false;
  if (home.membership === "member") return live.membership?.member_id !== home.me.member_id || live.membership.state !== "member";
  if (home.membership === "waiting") return live.membership?.state === "member" || live.membership === null;
  return false;
}
