import { describe, expect, it } from "vitest";
import { DEFAULT_SCREEN_CHOICES, ScreenContentSchema, ScreenStateSchema, type ScreenContent, type ScreenState } from "@walker/contracts";
import {
  CAPTION_PAGE_CHARS,
  FIXTURE_STATE_NAMES,
  MIN_FRAGMENT_WORDS,
  PX_PER_MM,
  SAMPLE_REPLY,
  captionPages,
  clockWords,
  screenFixtures,
  screenSizes,
  screenView,
  shorten,
  type ScreenView,
} from "../src";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const settings = { version: 2, ...DEFAULT_SCREEN_CHOICES, changed_at: "2026-10-24T18:00:00.000Z", pending_local: false };
const state = (screen: ScreenContent, extra: Partial<ScreenState> = {}): ScreenState =>
  ScreenStateSchema.parse({
    v: 1,
    revision: 4,
    screen,
    settings,
    strip: { link: "online", simulator: false, clock: { local_time: "2026-10-24T19:42:00" } },
    ...extra,
  });
const texts = (v: ScreenView) => [v.main.text, ...v.lines.map((l) => l.text), ...v.center.lines.map((l) => l.text)];
const buttons = (v: ScreenView) => [...(v.left?.kind === "button" ? [v.left.button] : []), ...v.center.buttons];

describe("sizes from one px_per_mm", () => {
  it("gives the design's pixels at 7.35 px/mm", () => {
    expect(PX_PER_MM).toBe(7.35);
    const [large, larger, largest] = (["large", "larger", "largest"] as const).map((t) => screenSizes(t));
    expect([large!.smallest, larger!.smallest, largest!.smallest]).toEqual([40, 40, 40]);
    expect([large!.body, larger!.body, largest!.body]).toEqual([48, 56, 64]);
    expect([large!.main, larger!.main, largest!.main]).toEqual([88, 104, 120]);
    expect(large!.button).toBe(147);
  });

  it("scales every size with the panel", () => {
    expect(screenSizes("large", PX_PER_MM * 2).main).toBe(176);
    expect(screenSizes("large", PX_PER_MM * 2).button).toBe(294);
  });
});

describe("fixtures", () => {
  const fixtures = screenFixtures();

  it("cover every state in the contract at every text size", () => {
    const all = ScreenContentSchema.options.map((o) => o.shape.state.value);
    expect([...FIXTURE_STATE_NAMES].sort()).toEqual([...all].sort());
    for (const size of ["large", "larger", "largest"]) expect(fixtures.filter((f) => f.textSize === size)).toHaveLength(fixtures.length / 3);
  });

  it("are valid states, and every view has a main line, at most 3 buttons and no motion status yet", () => {
    for (const f of fixtures) {
      expect(ScreenStateSchema.safeParse(f.state).success, f.name).toBe(true);
      const v = screenView(f.state);
      expect(v.main.text.length, f.name).toBeGreaterThan(0);
      expect(buttons(v).length, f.name).toBeLessThanOrEqual(3);
      expect(v.announce.length, f.name).toBeGreaterThan(0);
      expect(v.motionStatus).toBeNull();
      expect(v.textSize).toBe(f.textSize);
    }
  });

  it("never word anything as an emergency", () => {
    for (const f of fixtures) for (const t of texts(screenView(f.state))) expect(t, f.name).not.toMatch(/emergency|fall|danger|alarm|warning|clear|safe/i);
  });
});

describe("controls that aren't built are not shown", () => {
  it("no screen outside My screen itself offers a My screen button (it does nothing yet)", () => {
    for (const fixture of screenFixtures().filter((f) => f.state.screen.state !== "my_screen")) {
      expect(buttons(screenView(fixture.state)).map((b) => b.action), fixture.name).not.toContain("my_screen");
    }
  });
});

describe("the walker's own states", () => {
  it("ambient: the time, the part of the day, her greeting and the alerts, and no My screen yet", () => {
    const v = screenView(state({ state: "ambient", alerts: ["sound", "spoken"] }, { settings: { ...settings, greeting_name: "Nan" } }));
    expect(v.main.text).toBe("7:42");
    expect(texts(v)).toEqual(["7:42", "Good evening, Nan", "Saturday evening", "Alerts: short sounds and speech"]);
    expect(v.strip.time).toBeNull();
    expect(buttons(v)).toEqual([]); // "My screen" comes back with the circle piece, once it does something
    expect(v.left).toBeNull();
  });

  it("ambient: no time when the clock never synced", () => {
    const v = screenView(state({ state: "ambient", alerts: null }, { strip: { link: "online", simulator: false, clock: null } }));
    expect(v.main.text).toBe("Sophi");
    expect(texts(v).join(" ")).not.toMatch(/\d:\d\d/);
  });

  it("listening", () => {
    expect(texts(screenView(state({ state: "listening" })))).toEqual(["Listening", "Let go of Talk when you're done."]);
  });

  it("thinking: One moment, words only, no buttons and no Confirm", () => {
    const v = screenView(state({ state: "thinking" }));
    expect(texts(v)).toEqual(["One moment", "Your question is with Sophi."]);
    expect(v.main.size).toBe("main");
    expect(buttons(v)).toEqual([]);
    expect(v.left).toBeNull();
  });

  it("answering: captions paged at her size, what she said, and where the reply came from", () => {
    const v = screenView(state({ state: "answering", heard: "Is there anything in front of me right now?", reply: SAMPLE_REPLY, source: "model", page: 1 }));
    const pages = captionPages(SAMPLE_REPLY, "large");
    expect(v.main).toEqual({ text: pages[1], size: "body" });
    expect(v.lines.map((l) => l.text)).toEqual(["You said: Is there anything in…", "Answered by Gemini"]);
    expect(v.center.lines.map((l) => l.text)).toEqual([`2 of ${pages.length}`]);
    expect(v.left).toBeNull();
    // A page past the end shows the last one.
    expect(screenView(state({ state: "answering", heard: null, reply: SAMPLE_REPLY, source: "fixed", page: 99 })).main.text).toBe(pages.at(-1));
  });

  it("answering with captions off says only that Sophi is answering", () => {
    const v = screenView(state({ state: "answering", heard: "hi", reply: "Hello.", source: "walker", page: 0 }, { settings: { ...settings, captions: false } }));
    expect(texts(v)).toEqual(["Sophi is answering", "On the walker, offline reply"]);
  });

  it("Sophi's offer: the question, the alerts it makes, Confirm lit, no touch button", () => {
    const v = screenView(state({ state: "model_offer", proposal_id: uuid(50), from_cues: ["vibration", "spoken"], cues: ["sound", "spoken"] }));
    expect(v.main.text).toBe("Short sounds?");
    expect(v.lines[0]).toEqual({ text: "Alerts: short sounds and speech", size: "body" });
    expect(v.left).toEqual({ kind: "hint" });
    expect(buttons(v)).toEqual([]);
  });

  it("obstacle: side and distance, Unknown as large as a number, Simulated when it is", () => {
    const measured = screenView(state({ state: "obstacle", zone: "front_left", distance: { status: "measured", mm: 304 }, simulated: true }));
    expect(measured.main.text).toBe("Something close");
    expect(measured.lines).toEqual([{ text: "Front left · 30 cm", size: "body", simulated: true }]);
    const unknown = screenView(state({ state: "obstacle", zone: "front_right", distance: { status: "unknown" }, simulated: false }));
    expect(unknown.lines).toEqual([{ text: "Front right · Unknown", size: "body", simulated: false }]);
    // Confirm settles nothing during an obstacle.
    expect(unknown.left).toBeNull();
  });

  it("offline: the honest line, a hollow dot, and her own text size still reachable", () => {
    const v = screenView(state({ state: "offline" }, { strip: { link: "offline", simulator: false, clock: { local_time: "2026-10-24T19:42:00" } } }));
    expect(texts(v)).toEqual(["No internet", "Alerts still work on the walker."]);
    expect(v.strip).toMatchObject({ word: "Offline", shape: "hollow", time: "7:42" });
    // "My screen" isn't built yet, so it isn't shown (it comes back with the circle piece).
    expect(buttons(v)).toEqual([]);
  });

  it("not set up", () => {
    const v = screenView(state({ state: "not_set_up" }, { strip: { link: "unpaired", simulator: false, clock: null } }));
    expect(texts(v)).toEqual(["Not set up yet", "Ask your family to set it up."]);
    expect(v.strip).toMatchObject({ word: "Not set up", time: null });
  });

  it("done: what changed, Change it back only when offered, and Nothing changed", () => {
    const back = screenView(state({ state: "done", result: { kind: "change", change: { kind: "text_size", text_size: "larger" } }, change_back: true }));
    expect(texts(back)).toEqual(["Done", "Larger text is on."]);
    expect(buttons(back).map((b) => b.action)).toEqual(["change_back"]);
    const alerts = screenView(state({ state: "done", result: { kind: "alerts", cues: ["vibration", "sound"] }, change_back: false }));
    expect(texts(alerts)).toEqual(["Done", "Alerts: buzz and short sounds."]);
    expect(buttons(alerts)).toEqual([]);
    expect(texts(screenView(state({ state: "done", result: { kind: "nothing_changed" }, change_back: false })))).toEqual(["Nothing changed"]);
  });

  it("strip: Online filled, Connecting dashed, and Simulator on the simulator", () => {
    const v = screenView(state({ state: "listening" }, { strip: { link: "connecting", simulator: true, clock: null } }));
    expect(v.strip).toEqual({ word: "Connecting", shape: "dashed", time: null, simulator: true });
    expect(screenView(state({ state: "listening" })).strip).toEqual({ word: "Online", shape: "filled", time: "7:42", simulator: false });
  });

  it("cross-fades on a change of scene, never on a clock tick", () => {
    const a = screenView(state({ state: "ambient", alerts: null }));
    const b = screenView(state({ state: "ambient", alerts: null }, { revision: 5, strip: { link: "online", simulator: false, clock: { local_time: "2026-10-24T19:43:00" } } }));
    expect(a.sceneKey).toBe(b.sceneKey);
    expect(screenView(state({ state: "listening" })).sceneKey).not.toBe(a.sceneKey);
  });
});

describe("her circle's states", () => {
  const suggestion = { state: "suggestion", item_id: uuid(10), from_name: "Cooper", change: { kind: "text_size", text_size: "largest" }, minutes_left: 5, one_moment: false } as const;

  it("suggestion: the question, who, time left, Confirm and Not now", () => {
    const v = screenView(state(suggestion));
    expect(texts(v)).toEqual(["Bigger text?", "Largest text", "From Cooper", "About 5 minutes"]);
    expect(buttons(v).map((b) => b.action)).toEqual(["confirm", "not_now"]);
    expect(v.itemId).toBe(uuid(10));
    expect(screenView(state({ ...suggestion, one_moment: true })).center.lines.map((l) => l.text)).toEqual(["One moment"]);
    const smaller = screenView(state({ ...suggestion, change: { kind: "text_size", text_size: "large" } }, { settings: { ...settings, text_size: "largest" } }));
    expect(smaller.main.text).toBe("Smaller text?");
    expect(screenView(state({ ...suggestion, change: { kind: "voice", voice: "calm" } })).lines[0]!.text).toBe("Calm: this is how I'd sound.");
  });

  it("join: the name, the question, who invited them, then Press again", () => {
    const join = { state: "member_join", item_id: uuid(11), name: "Cooper", role: "family", invited_by_name: "Max", step: "first", minutes_left: 5, one_moment: false } as const;
    expect(texts(screenView(state(join)))).toEqual(["Cooper", "Join your circle?", "Max invited Cooper"]);
    const largest = screenView(state(join, { settings: { ...settings, text_size: "largest" } }));
    expect(largest.lines.map((l) => l.text)).toEqual(["Join your circle?"]);
    expect(largest.center.lines).toEqual([{ text: "Max invited Cooper", size: "detail" }]);
    const again = screenView(state({ ...join, step: "again" }));
    expect(texts(again)).toEqual(["Press again", "to let Cooper in."]);
    expect(again.sceneKey).not.toBe(screenView(state(join)).sceneKey);
    expect(buttons(again).map((b) => b.action)).toEqual(["confirm", "not_now"]);
  });

  it("message: a notice with Read it over the Confirm handle, then the words", () => {
    const waiting = screenView(state({ state: "message_waiting", message_id: uuid(20), from_name: "Cooper", more: 1 }));
    expect(texts(waiting)).toEqual(["A message", "From Cooper", "1 more waiting"]);
    expect(waiting.left).toMatchObject({ kind: "button", button: { action: "read_message", label: "Read it", sublabel: "Confirm" } });
    const open = screenView(state({ state: "message", message_id: uuid(20), from_name: "Cooper", text: "Dinner at six. I'll get you." }));
    expect(open.main).toEqual({ text: "Dinner at six. I'll get you.", size: "message" });
  });

  it("My screen: three entries, text size that doesn't wrap around, and reading aloud named in full", () => {
    expect(buttons(screenView(state({ state: "my_screen", view: { page: "menu" } }))).map((b) => b.label)).toEqual(["Text size", "Reading", "Your circle"]);
    const top = screenView(state({ state: "my_screen", view: { page: "text_size" } }, { settings: { ...settings, text_size: "largest" } }));
    expect(buttons(top).find((b) => b.action === "text_bigger")?.disabled).toBe(true);
    const reading = screenView(state({ state: "my_screen", view: { page: "reading" } }));
    expect(texts(reading)).toContain("Read messages aloud automatically: off");
    expect(buttons(reading).find((b) => b.action === "toggle_captions")?.pressed).toBe(true);
  });

  it("Your circle: the owner can read her conversations; removing asks first", () => {
    const owner = screenView(state({ state: "my_screen", view: { page: "circle", index: 0, owner_name: "Max", member: null, count: 2, confirm_remove: false } }));
    expect(texts(owner)).toContain("Max can read your conversations on the Sophi website.");
    expect(buttons(owner).map((b) => b.action)).not.toContain("remove");
    const member = { member_id: uuid(1), name: "Cooper", role: "family", joined_at: "2026-10-24T18:00:00.000Z" } as const;
    const ask = screenView(state({ state: "my_screen", view: { page: "circle", index: 1, owner_name: "Max", member, count: 2, confirm_remove: true } }));
    expect(texts(ask).slice(0, 2)).toEqual(["Remove?", "Cooper"]);
    expect(buttons(ask).map((b) => b.action)).toEqual(["keep", "remove"]);
  });
});

describe("the web app's Preview", () => {
  it("draws the same state with draft settings", () => {
    const s = state({ state: "listening" });
    const v = screenView(s, { ...settings, text_size: "largest", theme: "dark" });
    expect(v).toMatchObject({ textSize: "largest", theme: "dark" });
    expect(v.sizes.main).toBe(120);
    expect(screenView(s).theme).toBe("light");
  });
});

describe("helpers", () => {
  it("pages captions at sentence ends, within the budget, never inside a word", () => {
    for (const size of ["large", "larger", "largest"] as const) {
      const pages = captionPages(SAMPLE_REPLY, size);
      expect(pages.join(" ")).toBe(SAMPLE_REPLY);
      for (const p of pages) expect([...p].length).toBeLessThanOrEqual(CAPTION_PAGE_CHARS[size]);
      // Every sentence of the sample fits a page at Large and Larger, so every page ends a sentence.
      if (size !== "largest") for (const p of pages) expect(p, size).toMatch(/[.!?]$/);
    }
    expect(captionPages(SAMPLE_REPLY, "larger")).toEqual([
      "Something is about 30 centimetres ahead on your left.",
      "I can't tell what it is.",
      "Go slowly, and press Talk if you want me to check again in a moment.",
    ]);
    // Short sentences share a page.
    expect(captionPages("Yes. It's 7:42. Anything else?", "largest")).toEqual(["Yes. It's 7:42. Anything else?"]);
    // One word too long for a page is never cut.
    expect(captionPages("x".repeat(80), "largest")).toEqual(["x".repeat(80)]);
  });

  it("breaks a sentence too long for a page between words, never leaving a stray word or two", () => {
    // At Largest (50 characters) this sentence would end its first page on "your" and leave "left." alone.
    const pages = captionPages("Something is about 30 centimetres ahead on your left. I can't tell what it is.", "largest");
    expect(pages).toEqual(["Something is about 30 centimetres ahead", "on your left. I can't tell what it is."]);
    const long = "Go slowly and keep both hands on the handles while I check the floor ahead of you again now.";
    for (const p of captionPages(long, "largest")) {
      expect([...p].length).toBeLessThanOrEqual(50);
      expect(p.split(" ").length, p).toBeGreaterThanOrEqual(MIN_FRAGMENT_WORDS);
    }
    expect(captionPages(long, "largest").join(" ")).toBe(long);
  });

  it("tells the time on a 12-hour clock", () => {
    expect(clockWords("2026-10-24T00:05:00")).toEqual({ time: "12:05", day: "Saturday night", greeting: "Hello" });
    expect(clockWords("2026-10-26T09:30:00")).toEqual({ time: "9:30", day: "Monday morning", greeting: "Good morning" });
  });

  it("shortens at a word with an ellipsis", () => {
    expect(shorten("Is there anything in front of me", 20)).toBe("Is there anything…");
    expect(shorten("short", 20)).toBe("short");
  });
});
