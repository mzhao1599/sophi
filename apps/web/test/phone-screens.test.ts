import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MayaPhone, type MayaScreen } from "@/components/MayaPhone";
import { Home, Join, PREVIEW_LINE, PhoneApp } from "@/components/PhoneApp";
import { PhonesPanel } from "@/components/PhonesPanel";
import { RosePhone, type RoseScreen } from "@/components/RosePhone";
import type { PhoneApi, PhoneMember } from "@/lib/phoneApi";
import { createDemoCircle } from "@/lib/phoneFake";
import { newId } from "@/lib/phoneView";

// Each screen of the two-phone app, rendered to HTML from the fake's answers (the same shapes the server
// sends). Checks what each screen says and names; the headless two-phone run checks layout, focus and taps.

async function circle() {
  const c = createDemoCircle();
  const rose = c.phone();
  const maya = c.phone();
  await rose.join(c.addPhone("Rose", "walker_user"));
  await maya.join(c.addPhone("Maya", "caregiver"));
  c.approve("Maya");
  await maya.sendText(newId(), "Dinner at six. I'll get you.");
  return { c, rose, maya };
}

async function homeOf(api: PhoneApi): Promise<PhoneMember> {
  const h = await api.home();
  if (h.membership !== "member") throw new Error("not a member");
  return h;
}

const noop = async () => undefined;
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
/** Each button's accessible name: its text content (no button here has an aria-label). */
const buttons = (html: string) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ attrs: m[1]!, name: text(m[2]!) }));

async function rose(screen: RoseScreen) {
  const { rose } = await circle();
  return renderToStaticMarkup(createElement(RosePhone, { home: await homeOf(rose), api: rose, refresh: noop, announce: () => undefined, initialScreen: screen }));
}

async function maya(screen: MayaScreen, setup?: (c: ReturnType<typeof createDemoCircle>) => void) {
  const { c, maya } = await circle();
  setup?.(c);
  return renderToStaticMarkup(createElement(MayaPhone, { home: await homeOf(maya), api: maya, refresh: noop, announce: () => undefined, initialScreen: screen }));
}

describe("Join", () => {
  it("asks for the 6-digit code with a numeric keypad, a label and the data notice", () => {
    const html = renderToStaticMarkup(createElement(Join, { phone: { join: async () => null, joining: false, notice: null } }));
    expect(html).toContain("<h1");
    expect(text(html)).toContain("Link this phone to a walker");
    expect(html).toMatch(/<label[^>]*for="join-code"[^>]*>Code from the walker page<\/label>/);
    expect(html).toMatch(/inputmode="numeric"/i);
    expect(html).toMatch(/autocomplete="one-time-code"/i);
    expect(html).toContain('aria-describedby="join-notice"');
    expect(text(html)).toContain("Messages between the phones are deleted after 24 hours.");
    expect(buttons(html).map((b) => b.name)).toEqual(["Link this phone"]);
  });

  it("shows a removed phone why it's back at the code", () => {
    const html = renderToStaticMarkup(createElement(Join, { phone: { join: async () => null, joining: false, notice: "This phone isn't linked to the walker any more." } }));
    expect(text(html)).toContain("This phone isn't linked to the walker any more.");
  });
});

describe("Rose's phone (simple mode)", () => {
  it("home: at most four huge tiles, named by their words, and nothing that changes the walker", async () => {
    const html = await rose("home");
    expect(text(html)).toContain("Hello, Rose");
    const names = buttons(html).map((b) => b.name);
    expect(names).toEqual(["My walker On", "Message Maya 1 new message", "People nearby Sample"]);
    expect(names.length).toBeLessThanOrEqual(4);
    expect(html).not.toMatch(/<input|<textarea|Suggest|Confirm|Change/);
  });

  it("my walker: its state and alerts in sentences, and who can change it", async () => {
    const html = await rose("walker");
    const t = text(html);
    expect(t).toContain("Your walker is on.");
    expect(t).toContain("Alerts: short sounds and spoken messages.");
    expect(t).toContain("Nothing on this phone changes your walker.");
    expect(buttons(html).map((b) => b.name)).toEqual(["Back"]);
  });

  it("messages: the newest from Maya big, then three one-tap replies, no typing", async () => {
    const html = await rose("messages");
    const t = text(html);
    expect(t).toContain("Messages with Maya");
    expect(t).toContain("Dinner at six. I'll get you.");
    expect(t).toContain("Reply to Maya");
    // Before the page knows the phone can speak, the message is text, not a button that does nothing.
    expect(buttons(html).map((b) => b.name)).toEqual(["Back", "I'm okay", "Can you call me?", "I'm on my way"]);
    expect(html).not.toMatch(/<input|<textarea/);
  });

  it("people nearby: tagged Sample in the heading, with the line, and no actions", async () => {
    const html = await rose("nearby");
    expect(html).toMatch(/<h1[^>]*>People nearby <span[^>]*>Sample<\/span><\/h1>/);
    expect(text(html)).toContain("Sample people for the demo. Sophi doesn't share anyone's location.");
    expect(text(html)).toContain("Step-free places");
    expect(text(html)).not.toContain("Caretakers nearby");
    expect(buttons(html).map((b) => b.name)).toEqual(["Back"]);
  });
});

describe("Maya's phone (caretaker)", () => {
  it("walker: Online with a shape and a word, alerts, part health and the battery line", async () => {
    const html = await maya("walker");
    const t = text(html);
    expect(t).toContain("Rose's walker");
    expect(html).toMatch(/data-online="true"[^>]*aria-hidden="true"/);
    expect(t).toContain("Online");
    expect(t).toContain("Alerts in force");
    expect(t).toContain("Short sounds");
    expect(t).toContain("Parts");
    expect(t).toContain("Healthy");
    expect(t).toContain("Battery: not measured on this walker");
    // No suggestion button while the server has no route for one, and nothing about her conversation or location.
    expect(t).not.toMatch(/Suggest|location|last seen|ago/i);
    expect(buttons(html).map((b) => b.name)).toEqual(["Walker", "Messages", "Nearby"]);
    expect(html).toMatch(/aria-current="page"[^>]*>Walker</);
  });

  it("walker offline: a hollow dot and the word, and a simulator says so", async () => {
    const html = await maya("walker", (c) => {
      c.setOnline(false);
      c.setSimulator(true);
    });
    expect(html).toMatch(/data-online="false"/);
    expect(text(html)).toContain("Offline");
    expect(text(html)).toContain("Simulator");
    expect(text(html)).toContain("This walker is the simulator running on a computer, not a Pi.");
    expect(text(html)).toContain("Unavailable");
  });

  it("messages: the thread with who said what, a labelled box and the 30-character counter", async () => {
    const html = await maya("messages");
    const t = text(html);
    expect(t).toContain("Messages with Rose");
    expect(t).toContain("You Dinner at six. I'll get you.");
    expect(html).toMatch(/<label[^>]*for="message-text"[^>]*>Message to <!-- -->Rose<\/label>|<label[^>]*for="message-text"[^>]*>Message to Rose<\/label>/);
    expect(t).toContain("0 of 30 characters");
    expect(html).toContain('aria-describedby="message-counter"');
    expect(buttons(html).map((b) => b.name)).toEqual(["Walker", "Messages", "Nearby", "Send"]);
  });

  it("nearby: the same sample, with caretakers too", async () => {
    const html = await maya("nearby");
    expect(html).toMatch(/<h1[^>]*>Nearby <span[^>]*>Sample<\/span><\/h1>/);
    expect(text(html)).toContain("Caretakers nearby");
    expect(text(html)).toContain("Sample people for the demo. Sophi doesn't share anyone's location.");
  });
});

describe("a caretaker waiting for the family", () => {
  const phone = { phase: "home" as const, home: null, unreachable: false, notice: null, joining: false, join: async () => null, startOver: () => undefined, refresh: noop };
  const render = (home: Parameters<typeof Home>[0]["home"]) =>
    renderToStaticMarkup(createElement(Home, { phone, home, api: createDemoCircle().phone(), announce: () => undefined }));

  it("waits for the family's approval, never for a press on the walker", () => {
    const html = render({ membership: "waiting", name: "Maya", role: "caregiver", expires_at: new Date(Date.now() + 60_000).toISOString() });
    expect(text(html)).toContain("Waiting for the family to approve");
    expect(text(html)).not.toMatch(/Confirm|press/i);
    expect(buttons(html)).toEqual([]);
  });

  it("not approved: says so, and offers a new code", () => {
    const html = render({ membership: "no_answer", name: "Maya" });
    expect(text(html)).toContain("Not approved yet");
    expect(text(html)).toContain("Ask again later.");
    expect(buttons(html).map((b) => b.name)).toEqual(["Type a new code"]);
  });
});

describe("the owner's Phones panel", () => {
  it("starts by loading, inside a labelled section", () => {
    const html = renderToStaticMarkup(createElement(PhonesPanel, { api: createDemoCircle().owner(), deviceId: newId() }));
    expect(html).toMatch(/<h2 id="phones-heading"[^>]*>Phones<\/h2>/);
    expect(text(html)).toContain("Loading the phones.");
  });
});

describe("the app frame", () => {
  it("preview says Preview on screen; the real app doesn't", () => {
    const preview = renderToStaticMarkup(createElement(PhoneApp, { preview: "walker_user" }));
    expect(text(preview)).toContain(PREVIEW_LINE);
    expect(preview).toMatch(/>Preview</);
    const real = renderToStaticMarkup(createElement(PhoneApp, {}));
    expect(text(real)).not.toContain("Preview");
    expect(real).toContain('id="main"');
    expect(real).toContain('role="status"');
  });
});
