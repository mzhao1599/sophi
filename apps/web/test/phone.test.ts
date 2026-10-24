import { describe, expect, it, vi } from "vitest";
import { APP_MANIFEST } from "@/lib/appManifest";
import { SAMPLE_CARETAKERS, SAMPLE_GROUPS, SAMPLE_LINE, SAMPLE_PLACES, SAMPLE_WALKERS } from "@/lib/nearbySample";
import { PhoneApiError, PhoneHomeSchema, createOwnerPhonesApi, createPhoneApi, type PhoneMember } from "@/lib/phoneApi";
import { createDemoCircle, createPreviewPhone } from "@/lib/phoneFake";
import {
  alertsSentence,
  caregiverOf,
  codeDigits,
  counterLine,
  incoming,
  joinError,
  newCountLine,
  newId,
  spokenMessage,
  statusSentence,
  unseen,
  walkerTitle,
} from "@/lib/phoneView";

// The two-phone app (/app): the fake that tests and ?preview= use, the real client's paths and checks, and
// the app's words. Made-up names only.

const member = (h: Awaited<ReturnType<ReturnType<ReturnType<typeof createDemoCircle>["phone"]>["home"]>>): PhoneMember => {
  if (h.membership !== "member") throw new Error(`expected a member, got ${h.membership}`);
  return h;
};

async function twoPhones() {
  const circle = createDemoCircle();
  const rose = circle.phone();
  const maya = circle.phone();
  await rose.join(circle.addPhone("Rose", "walker_user"));
  const waiting = await maya.join(circle.addPhone("Maya", "caregiver"));
  return { circle, rose, maya, waiting };
}

describe("the demo path on the fake (two phones, one circle)", () => {
  it("links her phone at once and holds the caretaker until the owner approves", async () => {
    const { circle, rose, maya, waiting } = await twoPhones();
    expect(waiting.membership).toBe("waiting");
    await expect(maya.sendText(newId(), "Hello")).rejects.toMatchObject({ code: "not_allowed" });
    expect(circle.approve("Maya")).toBe(true);
    const roseHome = member(await rose.home());
    const mayaHome = member(await maya.home());
    expect(roseHome.me.role).toBe("walker_user");
    expect(roseHome.walker.parts).toBeNull();
    expect(mayaHome.walker.parts).not.toBeNull();
    expect(mayaHome.walker.battery).toBe("not_measured");
    expect(roseHome.people.map((p) => p.name)).toEqual(["Rose", "Maya"]);
  });

  it("carries Maya's message to Rose and Rose's preset back, each once", async () => {
    const { circle, rose, maya } = await twoPhones();
    circle.approve("Maya");
    const id = newId();
    await maya.sendText(id, "Dinner at six. I'll get you.");
    await maya.sendText(id, "Dinner at six. I'll get you."); // a retry: the same message back, not a second one
    const roseHome = member(await rose.home());
    expect(roseHome.messages).toHaveLength(1);
    expect(roseHome.messages[0]).toMatchObject({ text: "Dinner at six. I'll get you.", from_name: "Maya", mine: false });
    const to = caregiverOf(roseHome)!;
    await rose.sendPreset(newId(), "okay", to.member_id);
    const mayaHome = member(await maya.home());
    expect(mayaHome.messages.map((m) => [m.text, m.mine])).toEqual([
      ["Dinner at six. I'll get you.", true],
      ["I'm okay", false],
    ]);
  });

  it("refuses typing from her phone and presets from the caretaker's", async () => {
    const { circle, rose, maya } = await twoPhones();
    circle.approve("Maya");
    await expect(rose.sendText(newId(), "Hi")).rejects.toMatchObject({ code: "not_allowed" });
    const roseId = member(await maya.home()).people.find((p) => p.role === "walker_user")!.member_id;
    await expect(maya.sendPreset(newId(), "okay", roseId)).rejects.toMatchObject({ code: "not_allowed" });
  });

  it("refuses a message over 30 characters, a wrong code and a removed phone", async () => {
    const { circle, rose, maya } = await twoPhones();
    circle.approve("Maya");
    await expect(maya.sendText(newId(), "x".repeat(31))).rejects.toMatchObject({ code: "invalid_request" });
    await expect(circle.phone().join("000000")).rejects.toMatchObject({ code: "invite_code_invalid" });
    circle.remove("Rose");
    await expect(rose.home()).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
  });

  it("uses a code once", async () => {
    const circle = createDemoCircle();
    const code = circle.addPhone("Rose", "walker_user");
    await circle.phone().join(code);
    await expect(circle.phone().join(code)).rejects.toMatchObject({ code: "invite_code_invalid" });
  });

  it("the preview phone holds one message each way and is a simulator", async () => {
    const { api } = await createPreviewPhone("walker_user");
    const h = member(await api.home());
    expect(h.walker.simulator).toBe(true);
    expect(h.messages.map((m) => m.mine)).toEqual([false, true]);
  });
});

describe("the real client (fetch)", () => {
  const home = PhoneHomeSchema.parse({ membership: "no_answer", name: "Maya" });

  function stub(status: number, body: unknown) {
    return vi.fn(async (_path: string, _init?: RequestInit) => new Response(body === null ? null : JSON.stringify(body), { status }));
  }

  it("asks the member routes with the cookie and checks every answer", async () => {
    const f = stub(200, home);
    const api = createPhoneApi(f as unknown as typeof fetch);
    expect(await api.home()).toEqual(home);
    expect(await api.join("123456")).toEqual(home);
    expect(f.mock.calls[0]![0]).toBe("/api/v1/circle");
    expect(f.mock.calls[0]![1]).toMatchObject({ method: "GET", credentials: "same-origin", cache: "no-store" });
    expect(f.mock.calls[1]![0]).toBe("/api/v1/circle/join");
    expect(JSON.parse(f.mock.calls[1]![1]!.body as string)).toEqual({ code: "123456", consent: { circle_data_notice: true } });
  });

  it("sends a typed message and a preset in the server's two shapes", async () => {
    const message = { message_id: newId(), client_message_id: newId(), from_member_id: newId(), from_name: "Rose", to_member_id: newId(), text: "I'm okay", mine: true };
    const f = stub(200, { message });
    const api = createPhoneApi(f as unknown as typeof fetch);
    await api.sendText(message.client_message_id, "Dinner at six.");
    await api.sendPreset(message.client_message_id, "okay", message.to_member_id);
    expect(f.mock.calls.map((c) => c[0])).toEqual(["/api/v1/circle/messages", "/api/v1/circle/messages"]);
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toEqual({ client_message_id: message.client_message_id, text: "Dinner at six." });
    expect(JSON.parse(f.mock.calls[1]![1]!.body as string)).toEqual({ client_message_id: message.client_message_id, preset: "okay", to_member_id: message.to_member_id });
  });

  it("reads the contract's errors, a plain 404 and a wrong shape", async () => {
    const err = { error: { code: "invite_code_invalid", message: "Wrong code.", trace_id: "t1" } };
    await expect(createPhoneApi(stub(400, err) as unknown as typeof fetch).join("111111")).rejects.toMatchObject({ code: "invite_code_invalid", status: 400 });
    await expect(createPhoneApi(stub(404, "<html>") as unknown as typeof fetch).home()).rejects.toMatchObject({ code: "not_offered" });
    // A home that carries part health on her own phone isn't one the contract allows.
    const bad = {
      membership: "member",
      me: { member_id: newId(), name: "Rose", role: "walker_user" },
      walker: { walker_name: "My walker", online: true, simulator: false, alerts: ["sound"], parts: [], battery: "not_measured" },
      people: [],
      messages: [],
    };
    await expect(createPhoneApi(stub(200, bad) as unknown as typeof fetch).home()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("turns a dropped connection into a network failure", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const e = await createPhoneApi(f as unknown as typeof fetch)
      .home()
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PhoneApiError);
    expect((e as PhoneApiError).code).toBe("network");
  });
});

describe("the owner's side (the Phones panel on /walker)", () => {
  it("adds a phone by code, sees a caretaker waiting, approves her and removes a phone", async () => {
    const circle = createDemoCircle();
    const owner = circle.owner();
    const dev = newId();
    const roseInvite = await owner.addPhone(dev, "Rose", "walker_user");
    const mayaInvite = await owner.addPhone(dev, "Maya", "caregiver");
    expect(roseInvite.code).toMatch(/^\d{6}$/);
    expect((await owner.list(dev)).invites.map((i) => i.name)).toEqual(["Rose", "Maya"]);
    const rose = circle.phone();
    const maya = circle.phone();
    await rose.join(roseInvite.code);
    expect((await maya.join(mayaInvite.code)).membership).toBe("waiting");
    const list = await owner.list(dev);
    expect(list.invites).toEqual([]);
    expect(list.members.map((m) => m.name)).toEqual(["Rose"]);
    expect(list.joins.map((j) => j.name)).toEqual(["Maya"]);
    await owner.approve(dev, list.joins[0]!.member_id);
    expect((await maya.home()).membership).toBe("member");
    await owner.remove(dev, list.joins[0]!.member_id);
    await expect(maya.home()).rejects.toMatchObject({ code: "unauthenticated" });
  });

  it("the real client asks the owner routes", async () => {
    const member = { member_id: newId(), name: "Maya", role: "caregiver", joined_at: new Date().toISOString() };
    const f = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      if (path.endsWith("/invites")) {
        const now = Date.now();
        return new Response(
          JSON.stringify({ invite: { invite_id: newId(), name: "Maya", role: "caregiver", code: "123456", created_at: new Date(now).toISOString(), expires_at: new Date(now + 600_000).toISOString() } }),
          { status: 201 },
        );
      }
      if (path.includes("/joins/")) return new Response(JSON.stringify({ member }), { status: 200 });
      return new Response(JSON.stringify({ members: [], invites: [], joins: [] }), { status: 200 });
    });
    const api = createOwnerPhonesApi(f as unknown as typeof fetch);
    const dev = newId();
    await api.list(dev);
    await api.addPhone(dev, "Maya", "caregiver");
    await api.approve(dev, member.member_id);
    await api.remove(dev, member.member_id);
    expect(f.mock.calls.map((c) => `${c[1]?.method} ${c[0]}`)).toEqual([
      `GET /api/v1/walkers/${dev}/circle`,
      `POST /api/v1/walkers/${dev}/circle/invites`,
      `POST /api/v1/walkers/${dev}/circle/joins/${member.member_id}`,
      `DELETE /api/v1/walkers/${dev}/circle/members/${member.member_id}`,
    ]);
    expect(JSON.parse(f.mock.calls[1]![1]!.body as string)).toEqual({ name: "Maya", role: "caregiver" });
    expect(JSON.parse(f.mock.calls[2]![1]!.body as string)).toEqual({ consent: { walker_user_agreed: true } });
  });
});

describe("the app's words", () => {
  it("says the walker's state and alerts in one sentence each", () => {
    expect(statusSentence({ online: true })).toBe("Your walker is on.");
    expect(statusSentence({ online: false })).toBe("Your walker isn't connected right now.");
    expect(alertsSentence(["sound"])).toBe("Alerts: short sounds.");
    expect(alertsSentence(["vibration", "spoken"])).toBe("Alerts: vibration in the handles and spoken messages.");
  });

  it("keeps digits only in the code box, six at most", () => {
    expect(codeDigits("123 456")).toBe("123456");
    expect(codeDigits("12a3456789")).toBe("123456");
  });

  it("counts characters as the server does and flags over the limit", () => {
    expect(counterLine("Dinner at six. I'll get you.")).toEqual({ line: "28 of 30 characters", over: false });
    expect(counterLine("x".repeat(33))).toEqual({ line: "3 over the 30-character limit", over: true });
    expect(counterLine("👋".repeat(30)).over).toBe(false);
  });

  it("knows which incoming messages are new on this phone", async () => {
    const { circle, rose, maya } = await twoPhones();
    circle.approve("Maya");
    await maya.sendText(newId(), "One");
    await maya.sendText(newId(), "Two");
    const h = member(await rose.home());
    expect(incoming(h.messages).map((m) => m.text)).toEqual(["Two", "One"]);
    expect(unseen(h.messages, new Set([h.messages[0]!.message_id])).map((m) => m.text)).toEqual(["Two"]);
    expect(newCountLine(1)).toBe("1 new message");
    expect(newCountLine(2)).toBe("2 new messages");
    expect(newCountLine(0)).toBeNull();
    expect(spokenMessage(h.messages[0]!)).toBe("Maya says: One");
    expect(walkerTitle(member(await maya.home()))).toBe("Rose's walker");
  });

  it("explains a failed join without blaming the person", () => {
    expect(joinError("invite_code_invalid")).toMatch(/didn't work/);
    expect(joinError("invite_locked")).toMatch(/Wait a few minutes/);
    expect(joinError("network")).toMatch(/Can't reach/);
  });

  it("makes v4 ids without crypto.randomUUID (a plain-http phone)", () => {
    const original = crypto.randomUUID;
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
    try {
      expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      Object.defineProperty(crypto, "randomUUID", { value: original, configurable: true });
    }
  });
});

describe("people nearby: a labelled sample", () => {
  it("is made up, says so and carries no coordinates", () => {
    expect(SAMPLE_LINE).toBe("Sample people for the demo. This list does not use GPS or anyone's real location.");
    const all = JSON.stringify([SAMPLE_WALKERS, SAMPLE_CARETAKERS, SAMPLE_GROUPS, SAMPLE_PLACES]);
    expect(all).not.toMatch(/\b(lat|lng|latitude|longitude|coords?)\b|-?\d+\.\d{4,}/i);
  });
});

describe("the Home Screen manifest", () => {
  it("installs only /app, standalone, as Sophi", () => {
    expect(APP_MANIFEST).toMatchObject({ name: "Sophi", start_url: "/app", scope: "/app", display: "standalone", theme_color: "#f1f4f2" });
    expect(APP_MANIFEST.icons.map((i) => i.sizes)).toContain("512x512");
  });
});
