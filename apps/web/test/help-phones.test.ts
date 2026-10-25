import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HELP_CLOSED_SHOWN_MS, HELP_OPEN_MAX_MS, HELP_RETENTION_MS, type HelpView } from "@walker/contracts";
import { MayaPhone } from "@/components/MayaPhone";
import { RosePhone, type RoseScreen } from "@/components/RosePhone";
import { PhoneApiError, createPhoneApi, type PhoneApi, type PhoneMember } from "@/lib/phoneApi";
import { PREVIEW_FIX, createDemoCircle, createPreviewPhone } from "@/lib/phoneFake";
import {
  PHONE_LIVE_POLL_MS,
  PHONE_POLL_MS,
  agoWords,
  closedForLine,
  comingForLine,
  helpArrived,
  helpChange,
  helpTileLine,
  herClosedLine,
  newId,
  pollEvery,
  goesToLine,
  sentOthersLine,
} from "@/lib/phoneView";

// Asking for help on the two phones. Expected results, written first: test/help-phones.EXPECTED.md.
// Made-up names only (Rose, Maya, Ana).

const member = (h: Awaited<ReturnType<PhoneApi["home"]>>): PhoneMember => {
  if (h.membership !== "member") throw new Error(`expected a member, got ${h.membership}`);
  return h;
};

/** Rose's phone, Maya's (approved), and with `ana` Ana's too, in that joining order. */
async function circle({ maya = true, ana = false } = {}) {
  const c = createDemoCircle();
  const rose = c.phone();
  const mayaPhone = c.phone();
  const anaPhone = c.phone();
  await rose.join(c.addPhone("Rose", "walker_user"));
  if (maya) {
    await mayaPhone.join(c.addPhone("Maya", "caregiver"));
    c.approve("Maya");
  }
  if (ana) {
    await anaPhone.join(c.addPhone("Ana", "caregiver"));
    c.approve("Ana");
  }
  return { c, rose, maya: mayaPhone, ana: anaPhone };
}

// Fixed phones for the word tests; MAYA2 is a second caretaker who is also called Maya.
const MAYA = { member_id: "22222222-2222-4222-8222-222222222222", name: "Maya" };
const ANA = { member_id: "33333333-3333-4333-8333-333333333333", name: "Ana" };
const ROSE = { member_id: "11111111-1111-4111-8111-111111111111", name: "Rose" };
const MAYA2 = { member_id: "44444444-4444-4444-8444-444444444444", name: "Maya" };
const view = (over: Partial<HelpView> = {}): HelpView => ({ help_id: newId(), source: "handles", age_seconds: 5, sent_to: [MAYA], shown_to: [], coming: [], closed: null, ...over });
const names = (people: readonly { name: string }[]) => people.map((p) => p.name);

describe("the client's help calls", () => {
  const help = view();
  const stub = (status: number, body: unknown) => vi.fn(async (_p: string, _i?: RequestInit) => new Response(JSON.stringify(body), { status }));

  it("asks, says on my way and okay at the contract's paths, and reads the help back", async () => {
    const f = stub(200, { help });
    const api = createPhoneApi(f as unknown as typeof fetch);
    const id = newId();
    expect(await api.askForHelp(id)).toEqual(help);
    expect(await api.helpComing("a/b")).toEqual(help);
    expect(await api.helpOkay(help.help_id)).toEqual(help);
    expect(f.mock.calls.map((c) => `${c[1]?.method} ${c[0]}`)).toEqual([
      "POST /api/v1/circle/help",
      "POST /api/v1/circle/help/a%2Fb/coming",
      `POST /api/v1/circle/help/${help.help_id}/okay`,
    ]);
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toEqual({ client_help_id: id });
    expect(f.mock.calls[1]![1]!.body).toBeUndefined();
    expect(f.mock.calls[2]![1]!.body).toBeUndefined();
  });

  it("carries the request on help_closed, and names no_caretaker and not_allowed", async () => {
    const closed = view({ closed: { how: "okay", by: ROSE } });
    const err = (code: string, extra = {}) => ({ error: { code, message: code, trace_id: "t", ...extra } });
    const e = await createPhoneApi(stub(409, err("help_closed", { help: closed })) as unknown as typeof fetch)
      .helpComing(closed.help_id)
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PhoneApiError);
    expect(e).toMatchObject({ code: "help_closed", status: 409, help: closed });
    await expect(createPhoneApi(stub(409, err("no_caretaker")) as unknown as typeof fetch).askForHelp(newId())).rejects.toMatchObject({ code: "no_caretaker" });
    await expect(createPhoneApi(stub(403, err("not_allowed")) as unknown as typeof fetch).askForHelp(newId())).rejects.toMatchObject({ code: "not_allowed" });
  });

  it("refuses a help the contract doesn't allow, and a home without help", async () => {
    const bad = { help: { ...help, closed: { how: "with_her", by: null } } };
    await expect(createPhoneApi(stub(200, bad) as unknown as typeof fetch).askForHelp(newId())).rejects.toMatchObject({ code: "unavailable" });
    const { rose } = await circle();
    const home = member(await rose.home()) as Partial<PhoneMember>;
    delete home.help;
    await expect(createPhoneApi(stub(200, home) as unknown as typeof fetch).home()).rejects.toMatchObject({ code: "unavailable" });
  });
});

describe("the fake's help requests (the server's rules)", () => {
  it("only her approved phone asks; with no caretaker nobody is told and nothing is kept", async () => {
    const { c, rose, maya } = await circle({ maya: false });
    await expect(rose.askForHelp(newId())).rejects.toMatchObject({ code: "no_caretaker", status: 409 });
    expect(member(await rose.home()).help).toBeNull();
    await maya.join(c.addPhone("Maya", "caregiver"));
    await expect(maya.askForHelp(newId())).rejects.toMatchObject({ code: "not_allowed" }); // waiting
    c.approve("Maya");
    await expect(maya.askForHelp(newId())).rejects.toMatchObject({ code: "not_allowed" }); // a caretaker
    const h = await rose.askForHelp(newId());
    expect(h).toMatchObject({ source: "phone", shown_to: [], coming: [], closed: null });
    expect(names(h.sent_to)).toEqual(["Maya"]);
    expect(h.sent_to[0]!.member_id).toBe(member(await maya.home()).me.member_id);
  });

  it("fixes sent_to when she asks, in joining order; a later caretaker sees it without being in sent_to", async () => {
    const { c, rose, maya } = await circle({ ana: true });
    const h = await rose.askForHelp(newId());
    expect(names(h.sent_to)).toEqual(["Maya", "Ana"]);
    const sam = c.phone();
    await sam.join(c.addPhone("Sam", "caregiver"));
    expect((await sam.home()).membership).toBe("waiting");
    c.approve("Sam");
    const seen = member(await sam.home()).help!;
    expect(seen.help_id).toBe(h.help_id);
    expect(names(seen.sent_to)).toEqual(["Maya", "Ana"]);
    c.remove("Ana");
    expect(names(member(await maya.home()).help!.sent_to)).toEqual(["Maya", "Ana"]);
  });

  it("adds a caretaker's phone to shown_to when its home carries the open request, once, and never her own", async () => {
    const { rose, maya, ana } = await circle({ ana: true });
    const h = await rose.askForHelp(newId());
    expect(member(await rose.home()).help!.shown_to).toEqual([]);
    await ana.home();
    await maya.home();
    await ana.home();
    expect(names(member(await rose.home()).help!.shown_to)).toEqual(["Ana", "Maya"]);
    await rose.helpOkay(h.help_id);
    expect(names(member(await maya.home()).help!.shown_to)).toEqual(["Ana", "Maya"]);
  });

  it("one open request: asking again returns it; the same id returns it even closed; then a new one", async () => {
    const { c, rose } = await circle();
    const id = newId();
    const first = await rose.askForHelp(id);
    expect((await rose.askForHelp(newId())).help_id).toBe(first.help_id);
    expect(c.walkerAsks("voice").help_id).toBe(first.help_id);
    await rose.helpOkay(first.help_id);
    expect(await rose.askForHelp(id)).toMatchObject({ help_id: first.help_id, closed: { how: "okay", by: { name: "Rose" } } });
    const second = await rose.askForHelp(newId());
    expect(second.help_id).not.toBe(first.help_id);
    expect(second.closed).toBeNull();
  });

  it("on my way from a caretaker only, once each; okay and with her close it; a closed one answers help_closed", async () => {
    const { rose, maya, ana } = await circle({ ana: true });
    const h = await rose.askForHelp(newId());
    await expect(rose.helpComing(h.help_id)).rejects.toMatchObject({ code: "not_allowed" });
    await maya.helpComing(h.help_id);
    await maya.helpComing(h.help_id);
    expect(names((await ana.helpComing(h.help_id)).coming)).toEqual(["Maya", "Ana"]);
    await expect(maya.helpComing(newId())).rejects.toMatchObject({ code: "not_found" });
    // The race: Rose says okay, then Maya says she's with her.
    const roseId = member(await rose.home()).me.member_id;
    expect((await rose.helpOkay(h.help_id)).closed).toEqual({ how: "okay", by: { member_id: roseId, name: "Rose" } });
    const e = await maya.helpOkay(h.help_id).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: "help_closed", status: 409, help: { help_id: h.help_id, closed: { how: "okay", by: { name: "Rose" } } } });
    const h2 = await rose.askForHelp(newId());
    expect((await ana.helpOkay(h2.help_id)).closed).toMatchObject({ how: "with_her", by: { name: "Ana" } });
  });

  it("shows a closed request for 5 minutes, expires an open one after an hour and deletes it after a day", async () => {
    const { c, rose, maya } = await circle();
    const h = await rose.askForHelp(newId());
    await rose.helpOkay(h.help_id);
    c.advance(HELP_CLOSED_SHOWN_MS - 1_000);
    expect(member(await maya.home()).help?.help_id).toBe(h.help_id);
    c.advance(1_000);
    expect(member(await maya.home()).help).toBeNull();

    const open = c.walkerAsks("handles");
    c.advance(90_000);
    expect(member(await maya.home()).help).toMatchObject({ help_id: open.help_id, source: "handles", age_seconds: 90, closed: null });
    c.advance(HELP_OPEN_MAX_MS - 90_000);
    expect(member(await maya.home()).help).toMatchObject({ help_id: open.help_id, closed: { how: "expired", by: null } });
    await expect(maya.helpComing(open.help_id)).rejects.toMatchObject({ code: "help_closed" });
    c.advance(HELP_RETENTION_MS);
    await expect(maya.helpComing(open.help_id)).rejects.toMatchObject({ code: "not_found" });
  });

  it("her walker's Confirm twice closes it by her phone, or by nobody without one", async () => {
    const { c } = await circle();
    c.walkerAsks("voice");
    expect(c.walkerOkay().closed).toMatchObject({ how: "okay", by: { name: "Rose" } });
    c.walkerAsks("handles");
    expect(names(c.caretakerAnswers("Maya", "coming").coming)).toEqual(["Maya"]);
    expect(c.caretakerAnswers("Maya", "with_her").closed).toMatchObject({ how: "with_her", by: { name: "Maya" } });
    c.remove("Rose");
    c.walkerAsks("handles");
    expect(c.walkerOkay().closed).toEqual({ how: "okay", by: null });
  });

  it("shows her fix to a caretaker only while she shares, and erases it when she stops", async () => {
    const { c, rose, maya } = await circle();
    c.setLocation(PREVIEW_FIX);
    expect(member(await maya.home()).walker.location).toBeUndefined();
    await rose.setLocationSharing(true);
    expect(member(await maya.home()).walker.location).toMatchObject(PREVIEW_FIX);
    expect(member(await rose.home()).walker.location).toBeNull();
    await rose.setLocationSharing(false);
    await rose.setLocationSharing(true);
    expect(member(await maya.home()).walker.location).toBeNull();
  });

  it("the preview sets up no caretaker, two, and a shared fix", async () => {
    expect(member(await (await createPreviewPhone("walker_user", { caretakers: 0 })).api.home()).people.map((p) => p.name)).toEqual(["Rose"]);
    const two = await createPreviewPhone("caregiver", { caretakers: 2, location: true });
    const h = member(await two.api.home());
    expect(h.me.name).toBe("Maya");
    expect(h.people.map((p) => p.name)).toEqual(["Rose", "Maya", "Ana"]);
    expect(h.walker.location).toMatchObject(PREVIEW_FIX);
    // Maya's own preview always has Maya.
    expect(member(await (await createPreviewPhone("caregiver", { caretakers: 0 })).api.home()).me.name).toBe("Maya");
  });
});

describe("the help words", () => {
  const home = async (who: "rose" | "maya", setup?: (c: ReturnType<typeof createDemoCircle>) => void, ana = false) => {
    const x = await circle({ ana });
    setup?.(x.c);
    return member(await (who === "rose" ? x.rose : x.maya).home());
  };

  it("ages, sources and the lines on both phones", () => {
    expect([0, 59, 60, 119, 300, 3600, 7200].map(agoWords)).toEqual(["just now", "just now", "1 minute ago", "1 minute ago", "5 minutes ago", "1 hour ago", "2 hours ago"]);
    expect(goesToLine(["Maya"])).toBe("It goes to Maya's phone. Sophi doesn't call 911.");
    expect(goesToLine(["Maya", "Ana"])).toBe("It goes to Maya and Ana's phones. Sophi doesn't call 911.");
    const two = view({ sent_to: [MAYA, ANA] });
    const me = MAYA.member_id;
    expect(sentOthersLine(two, me)).toBe("It also went to Ana's phone.");
    expect(sentOthersLine(view(), me)).toBe("It went only to your phone.");
    expect(sentOthersLine(two, newId())).toBe("It went to Maya and Ana's phones.");
    expect(comingForLine(view(), me)).toBe("Nobody has said they're on the way yet.");
    expect(comingForLine(view({ coming: [MAYA] }), me)).toBe("You're on the way.");
    expect(comingForLine(view({ coming: [ANA] }), me)).toBe("Ana is on the way.");
    expect(comingForLine(view({ coming: [MAYA, ANA] }), me)).toBe("You and Ana are on the way.");
    // Another caretaker with the same name is not "You".
    expect(comingForLine(view({ coming: [MAYA2] }), me)).toBe("Maya is on the way.");
    expect(closedForLine(view({ closed: { how: "okay", by: ROSE } }), me, "Rose")).toBe("Rose says she's okay.");
    expect(closedForLine(view({ closed: { how: "okay", by: null } }), me, "Rose")).toBe("Rose said she's okay on her walker.");
    expect(closedForLine(view({ closed: { how: "with_her", by: ANA } }), me, "Rose")).toBe("Ana is with Rose.");
    expect(closedForLine(view({ closed: { how: "with_her", by: MAYA } }), me, "Rose")).toBe("You're with Rose.");
    expect(closedForLine(view({ closed: { how: "with_her", by: MAYA2 } }), me, "Rose")).toBe("Maya is with Rose.");
    expect(closedForLine(view({ closed: { how: "expired", by: null } }), me, "Rose")).toBe("Rose's request for help has ended.");
    expect(herClosedLine(view({ sent_to: [MAYA, ANA], closed: { how: "okay", by: ROSE } }))).toBe("You said you're okay. Maya and Ana's phones will show it.");
    expect(herClosedLine(view({ closed: { how: "okay", by: null } }))).toBe("You said you're okay. Maya's phone will show it.");
    expect(herClosedLine(view({ closed: { how: "with_her", by: MAYA } }))).toBe("Maya says they're with you.");
    expect(herClosedLine(view({ closed: { how: "expired", by: null } }))).toBe("Your request for help has ended.");
  });

  it("the tile's line: who she'd ask, none, or open", async () => {
    expect(helpTileLine(await home("rose"))).toBe("Ask Maya");
    expect(helpTileLine(await home("rose", undefined, true))).toBe("Ask Maya or Ana");
    const x = await circle({ maya: false });
    expect(helpTileLine(member(await x.rose.home()))).toBe("No caretaker linked");
    expect(helpTileLine(await home("rose", (c) => c.walkerAsks("handles")))).toBe("Open: see who's coming");
  });

  it("announces each change once, never on load, and plays the tone only for a new open request", async () => {
    const maya = await home("maya");
    const rose = await home("rose");
    const mayaMe = { member_id: maya.me.member_id, name: "Maya" };
    const open = view({ sent_to: [mayaMe] });
    // On load (no last value yet): nothing.
    expect(helpChange(undefined, open, maya)).toBeNull();
    expect(helpArrived(undefined, open)).toBe(false);
    // Strict Mode's second run sees the same value: nothing.
    expect(helpChange(open, open, maya)).toBeNull();
    expect(helpChange(null, open, maya)).toBe("Rose asked for help from her walker.");
    expect(helpChange(null, view({ source: "voice" }), maya)).toBe("Rose asked for help by asking Sophi.");
    expect(helpArrived(null, open)).toBe(true);
    expect(helpArrived(open, { ...open, coming: [mayaMe] })).toBe(false);
    expect(helpChange(null, open, rose)).toBe("You asked for help. Sent to Maya's phone.");
    // Her phone hears when a caretaker's app has it; the caretaker's own phone doesn't.
    expect(helpChange(open, { ...open, shown_to: [mayaMe] }, rose)).toBe("It's showing on Maya's phone.");
    expect(helpChange(open, { ...open, shown_to: [mayaMe] }, maya)).toBeNull();
    expect(helpChange(open, { ...open, coming: [mayaMe] }, maya)).toBe("You're on the way.");
    expect(helpChange(open, { ...open, coming: [ANA] }, maya)).toBe("Ana is on the way.");
    expect(helpChange(open, { ...open, coming: [MAYA2] }, maya)).toBe("Maya is on the way.");
    expect(helpChange(open, { ...open, coming: [mayaMe] }, rose)).toBe("Maya is on the way.");
    expect(helpChange({ ...open, coming: [mayaMe] }, { ...open, coming: [{ ...mayaMe }], age_seconds: 9 }, rose)).toBeNull();
    const closed: HelpView = { ...open, closed: { how: "okay", by: ROSE } };
    expect(helpChange(open, closed, maya)).toBe("Rose says she's okay.");
    expect(helpChange(open, closed, rose)).toBe("You said you're okay. Maya's phone will show it.");
    expect(helpChange(closed, { ...closed, age_seconds: 99 }, maya)).toBeNull();
    expect(helpArrived(open, closed)).toBe(false);
    // Gone after 5 minutes: nothing to say.
    expect(helpChange(closed, null, maya)).toBeNull();
  });

  it("polls every 2 s unless help requests come live too", () => {
    expect(pollEvery(false, false)).toBe(PHONE_POLL_MS);
    expect(pollEvery(true, false)).toBe(PHONE_POLL_MS);
    expect(pollEvery(true, true)).toBe(PHONE_LIVE_POLL_MS);
    expect(PHONE_POLL_MS).toBe(2_000);
  });
});

// ---- The screens, rendered from the fake's answers ----

const noop = async () => undefined;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const buttons = (html: string) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => text(m[2]!));
const CALM = /\bSOS\b|emergenc|alarm/i;

async function roseScreen(screen: RoseScreen, setup?: (x: Awaited<ReturnType<typeof circle>>) => Promise<unknown> | unknown, opts?: Parameters<typeof circle>[0]) {
  const x = await circle(opts);
  await setup?.(x);
  return renderToStaticMarkup(createElement(RosePhone, { home: member(await x.rose.home()), api: x.rose, refresh: noop, announce: () => undefined, initialScreen: screen }));
}

async function mayaScreen(setup?: (x: Awaited<ReturnType<typeof circle>>) => Promise<unknown> | unknown, opts?: Parameters<typeof circle>[0]) {
  const x = await circle(opts);
  await setup?.(x);
  return renderToStaticMarkup(createElement(MayaPhone, { home: member(await x.maya.home()), api: x.maya, refresh: noop, announce: () => undefined }));
}

describe("Rose's Get help", () => {
  it("asks Maya with one big button, says what happens, whether her location is shared, and links 911", async () => {
    const html = await roseScreen("help");
    const t = text(html);
    expect(html).toMatch(/<h1[^>]*>Ask Maya for help\?<\/h1>/);
    expect(buttons(html)).toEqual(["Back", "Ask for help"]);
    expect(t).toContain("It goes to Maya's phone. Sophi doesn't call 911.");
    expect(t).toContain("Location sharing is off, so Maya won't see where you are.");
    expect(html).toMatch(/<a href="tel:911"[^>]*>[\s\S]*Call 911<\/a>/);
    expect(t).not.toMatch(CALM);
  });

  it("names both caretakers, and says when her location is shared", async () => {
    const html = await roseScreen("help", ({ rose }) => rose.setLocationSharing(true), { ana: true });
    expect(html).toMatch(/<h1[^>]*>Ask Maya and Ana for help\?<\/h1>/);
    expect(text(html)).toContain("It goes to Maya and Ana's phones.");
    expect(text(html)).toContain("Location sharing is on, so Maya and Ana can see your walker's latest GPS position.");
  });

  it("with no caretaker: says so, no button, and still the 911 link", async () => {
    const html = await roseScreen("help", undefined, { maya: false });
    expect(html).toMatch(/<h1[^>]*>Get help<\/h1>/);
    expect(text(html)).toContain("No caretaker is linked to your walker.");
    expect(buttons(html)).toEqual(["Back"]);
    expect(html).toContain('href="tel:911"');
  });

  it("open: sent to, showing on, who is coming, how long ago, and I'm okay now", async () => {
    let html = await roseScreen("help", ({ rose }) => rose.askForHelp(newId()));
    let t = text(html);
    expect(html).toMatch(/<h1[^>]*>You asked for help<\/h1>/);
    expect(t).toContain("Sent to Maya's phone.");
    expect(t).not.toContain("showing");
    expect(t).not.toMatch(/told/);
    expect(t).toContain("Nobody has said they're on the way yet.");
    expect(t).toContain("Asked just now");
    expect(buttons(html)).toEqual(["Back", "I'm okay now"]);
    expect(html).toContain('href="tel:911"');
    html = await roseScreen("help", async ({ rose, maya }) => (await rose.askForHelp(newId()), await maya.home()));
    expect(text(html)).toContain("It's showing on Maya's phone.");
    html = await roseScreen("help", async ({ rose, maya }) => maya.helpComing((await rose.askForHelp(newId())).help_id));
    expect(text(html)).toContain("Maya is on the way.");
  });

  it("home: the banner leads while open, and says how it closed", async () => {
    let html = await roseScreen("home", ({ c }) => c.walkerAsks("handles"), { ana: true });
    expect(text(html).indexOf("You asked for help. Sent to Maya and Ana's phones.")).toBeLessThan(text(html).indexOf("Hello, Rose"));
    expect(buttons(html)[0]).toBe("Get help Open: see who's coming");
    html = await roseScreen("home", async ({ c, ana }) => (c.walkerAsks("handles"), await ana.home()), { ana: true });
    expect(text(html)).toContain("You asked for help. It's showing on Ana's phone.");
    html = await roseScreen("home", ({ c }) => (c.walkerAsks("handles"), c.caretakerAnswers("Ana", "coming")), { ana: true });
    expect(text(html)).toContain("You asked for help. Ana is on the way.");
    html = await roseScreen("home", ({ c }) => (c.walkerAsks("handles"), c.caretakerAnswers("Maya", "with_her")));
    expect(text(html)).toContain("Maya says they're with you.");
    expect(buttons(html)[0]).toBe("Get help Ask Maya");
    html = await roseScreen("home", ({ c }) => (c.walkerAsks("handles"), c.advance(HELP_OPEN_MAX_MS)));
    expect(text(html)).toContain("Your request for help has ended.");
    html = await roseScreen("home");
    expect(text(html)).not.toContain("asked for help");
  });

  it("closed: the line, then she can ask again", async () => {
    const html = await roseScreen("help", async ({ rose }) => rose.helpOkay((await rose.askForHelp(newId())).help_id));
    expect(text(html)).toContain("You said you're okay. Maya's phone will show it.");
    expect(buttons(html)).toEqual(["Back", "Ask for help"]);
  });
});

describe("Maya's phone with a request for help", () => {
  it("leads the app: who, how, how long ago, who else, who is coming, location, the answers and 911", async () => {
    const html = await mayaScreen(({ c }) => c.walkerAsks("handles"), { ana: true });
    const t = text(html);
    expect(t.indexOf("Rose asked for help")).toBeLessThan(t.indexOf("Rose's walker"));
    expect(html).toMatch(/<section[^>]*aria-labelledby="help-card-title"/);
    // The page's first heading, so a screen reader opening the app lands on it.
    expect(html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)![1]).toMatch(/Rose asked for help$/);
    expect(t).toContain("From her walker, just now.");
    expect(t).toContain("It also went to Ana's phone.");
    expect(t).toContain("Nobody has said they're on the way yet.");
    expect(t).toContain("Rose's location isn't shared.");
    expect(buttons(html)).toEqual(["I'm on my way", "I'm with Rose", "Walker", "Messages", "Nearby"]);
    expect(html).toContain('href="tel:911"');
    expect(t).not.toMatch(CALM);
  });

  it("says how she asked, and who is on the way", async () => {
    expect(text(await mayaScreen(({ c }) => c.walkerAsks("voice")))).toContain("By asking Sophi, just now.");
    expect(text(await mayaScreen(({ rose }) => rose.askForHelp(newId())))).toContain("From her phone, just now.");
    const html = await mayaScreen(({ c }) => (c.walkerAsks("handles"), c.caretakerAnswers("Maya", "coming"), c.caretakerAnswers("Ana", "coming")), { ana: true });
    expect(text(html)).toContain("You and Ana are on the way.");
    expect(text(html)).toContain("You said you're on the way.");
    expect(buttons(html).slice(0, 1)).toEqual(["I'm with Rose"]);
  });

  it("shows the map only with her shared fix, and says when sharing is on without one", async () => {
    let html = await mayaScreen(async ({ c, rose }) => (await rose.setLocationSharing(true), c.walkerAsks("handles")));
    expect(text(html)).toContain("No recent GPS fix from Rose's walker.");
    expect(html).not.toContain("Map of where");
    html = await mayaScreen(async ({ c, rose }) => (await rose.setLocationSharing(true), c.setLocation(PREVIEW_FIX), c.walkerAsks("handles")));
    expect(html).toMatch(/role="region" aria-label="Map of where Rose&#x27;s walker is"/);
    expect(text(html)).toContain("GPS fix from about 12 seconds ago. Map from OpenStreetMap.");
  });

  it("closed: one line, no buttons in the card", async () => {
    const lines = [
      [(x: Awaited<ReturnType<typeof circle>>) => (x.c.walkerAsks("handles"), x.c.walkerOkay()), "Rose says she's okay."],
      [(x: Awaited<ReturnType<typeof circle>>) => (x.c.walkerAsks("handles"), x.c.remove("Rose"), x.c.walkerOkay()), "She said she's okay on the walker."],
      [(x: Awaited<ReturnType<typeof circle>>) => (x.c.walkerAsks("handles"), x.c.caretakerAnswers("Ana", "with_her")), "Ana is with Rose."],
      [(x: Awaited<ReturnType<typeof circle>>) => (x.c.walkerAsks("handles"), x.c.caretakerAnswers("Maya", "with_her")), "You're with Rose."],
      [(x: Awaited<ReturnType<typeof circle>>) => (x.c.walkerAsks("handles"), x.c.advance(HELP_OPEN_MAX_MS)), "Rose's request for help has ended."],
    ] as const;
    for (const [setup, line] of lines) {
      const html = await mayaScreen(setup, { ana: true });
      expect(html).toMatch(new RegExp(`<h1 id="help-card-title"[^>]*>[\\s\\S]*${line.replace(/[.?]/g, "\\$&").replace(/'/g, "&#x27;")}</h1>`));
      expect(buttons(html)).toEqual(["Walker", "Messages", "Nearby"]);
      expect(html).not.toContain("tel:911");
    }
  });

  it("no request: no card", async () => {
    const html = await mayaScreen();
    expect(html).not.toContain("help-card-title");
    expect(text(html)).not.toContain("asked for help");
  });
});
