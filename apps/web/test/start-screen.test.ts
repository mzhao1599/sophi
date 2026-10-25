import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Home, type StartScreen } from "@/components/PhoneApp";
import type { PhoneApi } from "@/lib/phoneApi";
import { createPreviewPhone } from "@/lib/phoneFake";

// `/app?screen=`: a link opens the linked phone on one screen, so the stage can show Rose's thread and Maya's
// walker at once. Without it, each phone opens where it always did.

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");

async function open(role: "walker_user" | "caregiver", start?: StartScreen) {
  const { api } = await createPreviewPhone(role, { location: true, route: true });
  const home = await api.home();
  const phone = { refresh: async () => undefined, startOver: () => undefined } as unknown as Parameters<typeof Home>[0]["phone"];
  return text(renderToStaticMarkup(createElement(Home, { phone, home, api: api as PhoneApi, announce: () => undefined, start })));
}

describe("/app?screen=", () => {
  it("opens Rose's phone on her messages, and on her tiles without it", async () => {
    expect(await open("walker_user", "messages")).toContain("Messages with Maya");
    const tiles = await open("walker_user");
    expect(tiles).toContain("Hello, Rose");
    expect(tiles).not.toContain("Messages with Maya");
  });

  it("opens Maya's phone on her walker with Rose's route, or on her messages", async () => {
    expect(await open("caregiver", "walker")).toContain("Rose is on the way");
    expect(await open("caregiver")).toContain("Rose is on the way");
    expect(await open("caregiver", "messages")).toContain("Messages with Rose");
  });
});
