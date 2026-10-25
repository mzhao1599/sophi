import { describe, expect, it } from "vitest";
import { helpRowsKey, membershipMoved, withLiveCircle, type PhoneLiveRows } from "@/lib/careLive";
import type { PhoneHome } from "@/lib/phoneApi";

/**
 * How a phone combines the server's home with its live rows from SpacetimeDB (careLive.ts). Expected, written first:
 * - a phone both sides agree is in shows the live people and messages, and the server's walker status;
 * - live messages are named by the live people, `mine` by this phone's id, oldest first by seq;
 * - waiting, no answer, no live rows, or live rows for another member: the server's home as it is;
 * - a change the live rows show (approved, removed, another membership) asks the server again; nothing else does;
 * - folding each live update into the kept home means a later fallback never shows a removed person again.
 */

const ROSE = "11111111-1111-4111-8111-111111111111";
const MAYA = "22222222-2222-4222-8222-222222222222";
const ANA = "33333333-3333-4333-8333-333333333333";

function roseHome(people = [ROSE, MAYA]): PhoneHome {
  return {
    membership: "member",
    me: { member_id: ROSE, name: "Rose", role: "walker_user" },
    walker: { walker_name: "Rose's walker", online: true, simulator: true, alerts: [], parts: null, battery: "not_measured" },
    people: people.map((id) => ({ member_id: id, name: id === ROSE ? "Rose" : id === MAYA ? "Maya" : "Ana", role: id === ROSE ? "walker_user" : "caregiver" })),
    messages: [],
    help: null,
  } as PhoneHome;
}

function rows(over: Partial<PhoneLiveRows> = {}): PhoneLiveRows {
  return {
    membership: { member_id: ROSE, state: "member" },
    people: [
      { member_id: ROSE, name: "Rose", role: "walker_user", seq: 1n },
      { member_id: ANA, name: "Ana", role: "caregiver", seq: 5n },
    ],
    messages: [
      { message_id: "m2", client_message_id: "c2", from_member_id: ROSE, to_member_id: ANA, text: "I'm okay", seq: 9n },
      { message_id: "m1", client_message_id: "c1", from_member_id: ANA, to_member_id: ROSE, text: "Lunch at noon?", seq: 7n },
    ],
    help: [],
    ...over,
  };
}

describe("a phone's live circle", () => {
  it("shows the live people and messages, with the server's walker status", () => {
    const home = withLiveCircle(roseHome(), rows());
    if (home?.membership !== "member") throw new Error("expected a member");
    expect(home.people.map((p) => p.name)).toEqual(["Rose", "Ana"]);
    expect(home.messages.map((m) => [m.text, m.from_name, m.mine])).toEqual([
      ["I'm okay", "Rose", true],
      ["Lunch at noon?", "Ana", false],
    ]);
    expect(home.walker.walker_name).toBe("Rose's walker");
  });

  it("keeps the server's home when the two don't agree the phone is in", () => {
    const home = roseHome();
    expect(withLiveCircle(home, null)).toBe(home);
    expect(withLiveCircle(home, rows({ membership: null }))).toBe(home);
    expect(withLiveCircle(home, rows({ membership: { member_id: MAYA, state: "member" } }))).toBe(home);
    const waiting: PhoneHome = { membership: "waiting", name: "Maya", role: "caregiver", expires_at: "2026-10-24T12:00:00.000Z" };
    expect(withLiveCircle(waiting, rows())).toBe(waiting);
  });

  it("asks the server again only when the live membership moved", () => {
    const waiting: PhoneHome = { membership: "waiting", name: "Maya", role: "caregiver", expires_at: "2026-10-24T12:00:00.000Z" };
    expect(membershipMoved(waiting, rows({ membership: { member_id: MAYA, state: "waiting" } }))).toBe(false);
    expect(membershipMoved(waiting, rows({ membership: { member_id: MAYA, state: "member" } }))).toBe(true);
    expect(membershipMoved(waiting, rows({ membership: null }))).toBe(true);
    expect(membershipMoved(roseHome(), rows())).toBe(false);
    expect(membershipMoved(roseHome(), rows({ membership: null }))).toBe(true);
    expect(membershipMoved(roseHome(), null)).toBe(false);
    expect(membershipMoved({ membership: "no_answer", name: "Maya" }, rows({ membership: null }))).toBe(false);
  });

  it("never steps back to a removed person once a live update was folded in", () => {
    // The kept home was polled while Maya was in; then the owner removed her, and the live rows said so.
    const kept = withLiveCircle(roseHome([ROSE, MAYA]), rows({ people: [{ member_id: ROSE, name: "Rose", role: "walker_user", seq: 1n }], messages: [] }));
    // The walker is forgotten next: her membership leaves the live rows, so the screen falls back to the kept home.
    const fallback = withLiveCircle(kept, rows({ membership: null, people: [], messages: [] }));
    if (fallback?.membership !== "member") throw new Error("expected a member");
    expect(fallback.people.map((p) => p.name)).toEqual(["Rose"]);
  });
});

describe("a phone's live help rows (my_help)", () => {
  it("keys only on help ids and revisions, and only once my_help is subscribed", () => {
    const a = rows({ help: [{ help_id: "h1", rev: 3n }] });
    expect(helpRowsKey(a, false)).toBeNull();
    expect(helpRowsKey(null, true)).toBeNull();
    expect(helpRowsKey(rows(), true)).toBe("");
    expect(helpRowsKey(a, true)).toBe("h1:3");
    // A revision bump, a new request, or one deleted each changes the key; the same rows in another order don't.
    expect(helpRowsKey(rows({ help: [{ help_id: "h1", rev: 4n }] }), true)).not.toBe("h1:3");
    const two = rows({ help: [{ help_id: "h2", rev: 1n }, { help_id: "h1", rev: 3n }] });
    expect(helpRowsKey(two, true)).toBe(helpRowsKey(rows({ help: [{ help_id: "h1", rev: 3n }, { help_id: "h2", rev: 1n }] }), true));
    expect(helpRowsKey(two, true)).not.toBe(helpRowsKey(a, true));
  });

  it("keeps help out of the merged home: the server's help stays", () => {
    const home = { ...roseHome(), help: null } as PhoneHome;
    const merged = withLiveCircle(home, rows({ help: [{ help_id: "h1", rev: 1n }] }));
    if (merged?.membership !== "member") throw new Error("expected a member");
    expect(merged.help).toBeNull();
  });
});
