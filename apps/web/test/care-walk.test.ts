import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CareWalk, shortPlace, timeLeftWords, updatedWords } from "@/components/CareWalk";
import { MayaPhone } from "@/components/MayaPhone";
import type { PhoneMember } from "@/lib/phoneApi";
import { createPreviewPhone } from "@/lib/phoneFake";

// Where she is, on a caretaker's phone: the route she shares, from the same fake the preview runs on.

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

async function home(role: "caregiver" | "walker_user", options: { location?: boolean; route?: boolean }): Promise<PhoneMember> {
  const { api } = await createPreviewPhone(role, options);
  const h = await api.home();
  if (h.membership !== "member") throw new Error("not a member");
  return h;
}

describe("CareWalk", () => {
  it("shows Maya the route Rose is on: who, where to, time and distance left, simulated once", async () => {
    const h = await home("caregiver", { location: true, route: true });
    const words = text(renderToStaticMarkup(createElement(CareWalk, { walker: h.walker, herName: "Rose" })));
    expect(words).toContain("Walking now");
    expect(words).toContain("Rose is on the way");
    expect(words).toContain("6 min left");
    expect(words).toContain("300 m to Lake Merritt Boating Center");
    expect(words).toContain("Map: Rose's route to Lake Merritt Boating Center, 300 metres to go, on a simulated position.");
    expect(words.match(/Simulated position/g)).toHaveLength(1);
    expect(words).toContain("Map from OpenStreetMap, which sees the area shown.");
  });

  it("puts the walk first on Maya's Walker screen, and drops the per-part Simulated tags on a simulator", async () => {
    const { api } = await createPreviewPhone("caregiver", { location: true, route: true });
    const h = (await api.home()) as PhoneMember;
    const words = text(renderToStaticMarkup(createElement(MayaPhone, { home: h, api, refresh: async () => undefined, announce: () => undefined, initialScreen: "walker" })));
    expect(words.indexOf("Rose is on the way")).toBeLessThan(words.indexOf("Alerts in force"));
    expect(words).not.toMatch(/\bSimulated\b(?! position)/);
  });

  it("shows her position alone without a route, and nothing when she doesn't share", async () => {
    const fixOnly = await home("caregiver", { location: true });
    const alone = text(renderToStaticMarkup(createElement(CareWalk, { walker: fixOnly.walker, herName: "Rose" })));
    expect(alone).toContain("Where Rose is");
    expect(alone).not.toContain("min left");
    const off = await home("caregiver", {});
    expect(renderToStaticMarkup(createElement(CareWalk, { walker: off.walker, herName: "Rose" }))).toBe("");
    const hers = await home("walker_user", { location: true, route: true });
    expect(renderToStaticMarkup(createElement(CareWalk, { walker: hers.walker, herName: "Rose" }))).toBe("");
  });

  it("words the label, the age and the time left", () => {
    expect(shortPlace("Lake Merritt Boating Center, 568 Bellevue Avenue, Oakland")).toBe("Lake Merritt Boating Center");
    expect(shortPlace("Lakeside Park Garden Center and Trial Gardens")).toBe("Lakeside Park Garden Center…");
    expect(updatedWords(2)).toBe("Updated just now");
    expect(updatedWords(12)).toBe("Updated 12 s ago");
    expect(timeLeftWords(0)).toBe("Less than a minute");
    expect(timeLeftWords(6)).toBe("6 min");
  });
});
