import { describe, expect, it } from "vitest";
import {
  BENCH_MODE_LABEL,
  CONFIRM_ONLY_PROMPT,
  DEFAULT_SCREEN_CHOICES,
  FAULT_CLEAR_SENTENCE,
  FAULT_SENTENCES,
  PARK_PROMPT,
  REFUSAL_SENTENCES,
  ScreenContentSchema,
  ScreenStateSchema,
  confirmPrompt,
  holdControlShown,
  ManeuverSchema,
  type NavigatingScreen,
  type ScreenContent,
  type ScreenState,
} from "@walker/contracts";
import {
  CAPTION_PAGE_CHARS,
  DEMO_ROUTE,
  FIXTURE_STATE_NAMES,
  LONGEST_PLACE,
  LONGEST_STREET,
  MANEUVER_WORD,
  NAV_ARROW_PX,
  NAV_WORD_CAP_PX,
  TILE_PX,
  WORD_EM,
  bodyChars,
  distanceWords,
  fitChars,
  minutesLeftWords,
  navColumns,
  navMap,
  streetForLine,
  turnWordPx,
  worldPx,
  MIN_FRAGMENT_WORDS,
  PX_PER_MM,
  SAMPLE_REPLY,
  captionPages,
  clockWords,
  fitMotionMain,
  promptAfterTitle,
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
    strip: { link: "online", simulator: false, bench_mode: false, clock: { local_time: "2026-10-24T19:42:00" } },
    ...extra,
  });
const texts = (v: ScreenView) => [v.main.text, ...v.lines.map((l) => l.text), ...v.center.lines.map((l) => l.text)];
const buttons = (v: ScreenView) => [...(v.left?.kind === "button" ? [v.left.button] : []), ...v.center.buttons];
const benchStrip = { link: "online", simulator: false, bench_mode: true, clock: { local_time: "2026-10-24T19:42:00" } } as const;

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

  it("are valid states, and every view has a main line and at most 3 touch targets", () => {
    for (const f of fixtures) {
      expect(ScreenStateSchema.safeParse(f.state).success, f.name).toBe(true);
      const v = screenView(f.state);
      expect(v.main.text.length, f.name).toBeGreaterThan(0);
      expect(buttons(v).length + (v.hold ? 1 : 0), f.name).toBeLessThanOrEqual(3);
      expect(v.announce.length, f.name).toBeGreaterThan(0);
      expect(v.textSize).toBe(f.textSize);
    }
  });

  it("never word anything as an emergency", () => {
    // "clear it" is the instruction to clear a latched motion fault at the walker (FAULT_CLEAR_SENTENCE), not a
    // claim that the way is clear.
    for (const f of fixtures) for (const t of texts(screenView(f.state))) expect(t, f.name).not.toMatch(/emergency|fall|danger|alarm|warning|clear(?! it)|safe/i);
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
    const v = screenView(state({ state: "ambient", alerts: null }, { strip: { link: "online", simulator: false, bench_mode: false, clock: null } }));
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
    expect(v.left).toEqual({ kind: "hint", word: "Confirm" });
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
    const v = screenView(state({ state: "offline" }, { strip: { link: "offline", simulator: false, bench_mode: false, clock: { local_time: "2026-10-24T19:42:00" } } }));
    expect(texts(v)).toEqual(["No internet", "Alerts still work on the walker."]);
    expect(v.strip).toMatchObject({ word: "Offline", shape: "hollow", time: "7:42" });
    // "My screen" isn't built yet, so it isn't shown (it comes back with the circle piece).
    expect(buttons(v)).toEqual([]);
  });

  it("not set up", () => {
    const v = screenView(state({ state: "not_set_up" }, { strip: { link: "unpaired", simulator: false, bench_mode: false, clock: null } }));
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
    const v = screenView(state({ state: "listening" }, { strip: { link: "connecting", simulator: true, bench_mode: false, clock: null } }));
    expect(v.strip).toEqual({ word: "Connecting", shape: "dashed", time: null, simulator: true, bench: false });
    expect(screenView(state({ state: "listening" })).strip).toEqual({ word: "Online", shape: "filled", time: "7:42", simulator: false, bench: false });
  });

  it("cross-fades on a change of scene, never on a clock tick", () => {
    const a = screenView(state({ state: "ambient", alerts: null }));
    const b = screenView(state({ state: "ambient", alerts: null }, { revision: 5, strip: { link: "online", simulator: false, bench_mode: false, clock: { local_time: "2026-10-24T19:43:00" } } }));
    expect(a.sceneKey).toBe(b.sceneKey);
    expect(screenView(state({ state: "listening" })).sceneKey).not.toBe(a.sceneKey);
  });
});

describe("motion: the arms and the lift", () => {
  const cup = { target_id: uuid(60), title: "Bring the cup?", prompt: confirmPrompt("Bring the cup?", true) };
  const raise = { target_id: uuid(62), title: "Raise the lift?", prompt: confirmPrompt("Raise the lift?", true) };

  it("a pending target: the Pi's title, the park line, Confirm named over the handle and nothing to tap", () => {
    const v = screenView(state({ state: "motion_confirm", target: cup, hold: null }));
    expect(texts(v)).toEqual(["Bring the cup?", PARK_PROMPT]);
    expect(v.main.size).toBe("main");
    expect(v.left).toEqual({ kind: "hint", word: "Confirm" });
    // Only a handle Confirm press starts motion: no touch Confirm, no other button, no hold control.
    expect(buttons(v)).toEqual([]);
    expect(v.hold).toBeNull();
    expect(v.right).toBe("Talk");
    expect(v.announce).toBe(`Bring the cup? ${PARK_PROMPT}`);
    // A target that moves nothing says the confirm-only line instead.
    const clear = { target_id: uuid(61), title: "Clear it", prompt: confirmPrompt("Clear it", false) };
    expect(promptAfterTitle(clear.title, clear.prompt)).toBe(CONFIRM_ONLY_PROMPT);
  });

  it("a hold-to-run lift target shows the hold control, which names the way and asks for Confirm too", () => {
    const v = screenView(state({ state: "motion_confirm", target: raise, hold: "raise" }));
    expect(v.hold).toEqual({ direction: "raise", label: "Hold to raise", sublabel: "and press Confirm" });
    expect(buttons(v)).toEqual([]);
    expect(v.announce).toBe(`Raise the lift? ${PARK_PROMPT} Keep holding Hold to raise on the screen while you press Confirm.`);
    expect(screenView(state({ state: "motion_confirm", target: raise, hold: "lower" })).hold?.label).toBe("Hold to lower");
    expect(screenView(state({ state: "motion_confirm", target: raise, hold: "home" })).hold?.label).toBe("Hold to home");
  });

  it("running: what moves, how to stop it, and Stop over both handles", () => {
    const arms = screenView(state({ state: "motion_running", what: "Bring the cup", lift: null }));
    expect(texts(arms)).toEqual(["Bring the cup", "Press any handle button to stop."]);
    expect(arms.announce).toBe("Moving: Bring the cup. Press any handle button to stop.");
    expect(arms.left).toEqual({ kind: "hint", word: "Stop" });
    expect(arms.right).toBe("Stop");
    expect(arms.hold).toBeNull();
    expect(buttons(arms)).toEqual([]);
    // The lift: keeping hold is the one thing to do, and the button under her finger names the way.
    const held = screenView(state({ state: "motion_running", what: "Raising the lift", lift: { phase: "running", direction: "raise" } }));
    expect(texts(held)).toEqual(["Keep holding", "Let go, or press a handle button, to stop."]);
    expect(held.main.size).toBe("main");
    expect(held.announce).toBe("Raising the lift. Keep holding. Let go, or press a handle button, to stop.");
    expect(held.hold).toEqual({ direction: "raise", label: "Hold to raise", sublabel: null });
    expect([held.left, held.right]).toEqual([{ kind: "hint", word: "Stop" }, "Stop"]);
    // Once it is stopping it never resumes, so the hold control goes.
    const stopping = screenView(state({ state: "motion_running", what: "Raising the lift", lift: { phase: "stopping", direction: "raise" } }));
    expect(texts(stopping)).toEqual(["Stopping"]);
    expect(stopping.hold).toBeNull();
    expect(stopping.sceneKey).not.toBe(held.sceneKey);
  });

  it("the hold control shows exactly where the contract says, and on no other screen", () => {
    for (const f of screenFixtures()) {
      const v = screenView(f.state);
      expect(v.hold?.direction ?? null, f.name).toBe(holdControlShown(f.state.screen));
    }
    const withHold = screenFixtures().filter((f) => screenView(f.state).hold);
    expect(new Set(withHold.map((f) => f.state.screen.state))).toEqual(new Set(["motion_confirm", "motion_running"]));
  });

  it("holding: done or stopped, holding still; or why it didn't start, in the contract's sentence", () => {
    expect(texts(screenView(state({ state: "motion_holding", outcome: "completed", refusal: null })))).toEqual(["Done", "Holding still."]);
    expect(texts(screenView(state({ state: "motion_holding", outcome: "stopped", refusal: null })))).toEqual(["Stopped", "Holding still."]);
    const refused = screenView(state({ state: "motion_holding", outcome: "not_started", refusal: "not_held" }));
    expect(texts(refused)).toEqual(["Not started", REFUSAL_SENTENCES.not_held]);
    expect(refused.left).toBeNull();
    expect(refused.right).toBe("Talk");
  });

  it("a fault: Stopped, its plain sentence, ask a helper, and how many more", () => {
    const v = screenView(state({ state: "motion_fault", faults: ["stop_circuit_opened", "lift_unhomed"], confirm: null }));
    expect(texts(v)).toEqual(["Stopped", FAULT_SENTENCES.stop_circuit_opened, FAULT_CLEAR_SENTENCE, "1 more to check"]);
    expect(FAULT_CLEAR_SENTENCE).toBe("Ask a helper to clear it at the walker.");
    expect(v.left).toBeNull();
    expect(v.hold).toBeNull();
    expect(buttons(v)).toEqual([]);
    // A target to clear it, shown with the fault, and Confirm named over the handle.
    const clear = { target_id: uuid(61), title: "Clear it?", prompt: confirmPrompt("Clear it?", false) };
    const asking = screenView(state({ state: "motion_fault", faults: ["overload"], confirm: clear }));
    expect(texts(asking)).toEqual(["Clear it?", FAULT_SENTENCES.overload, CONFIRM_ONLY_PROMPT]);
    expect(asking.left).toEqual({ kind: "hint", word: "Confirm" });
  });

  it("bench mode: a tag in the strip on every screen, and the full label on every motion screen", () => {
    const motion: ScreenContent[] = [
      { state: "motion_confirm", target: cup, hold: null },
      { state: "motion_confirm", target: raise, hold: "raise" },
      { state: "motion_running", what: "Bring the cup", lift: null },
      { state: "motion_running", what: "Raising the lift", lift: { phase: "stopping", direction: "raise" } },
      { state: "motion_holding", outcome: "stopped", refusal: null },
      { state: "motion_fault", faults: ["overload"], confirm: null },
    ];
    for (const screen of motion) {
      const v = screenView(state(screen, { strip: benchStrip }));
      expect(v.strip.bench, screen.state).toBe(true);
      expect(texts(v), screen.state).toContain(BENCH_MODE_LABEL);
      expect(texts(screenView(state(screen))), screen.state).not.toContain(BENCH_MODE_LABEL);
    }
    const ambient = screenView(state({ state: "ambient", alerts: null }, { strip: benchStrip }));
    expect(ambient.strip.bench).toBe(true);
    expect(texts(ambient)).not.toContain(BENCH_MODE_LABEL);
    expect(screenView(state({ state: "listening" }, { strip: benchStrip })).strip).toMatchObject({ time: "7:42", bench: true });
    // The simulator in bench mode: its "Simulator" tag takes the room; motion screens still say the label.
    const sim = { ...benchStrip, simulator: true };
    expect(screenView(state({ state: "listening" }, { strip: sim })).strip).toMatchObject({ time: "7:42", simulator: true, bench: false });
    expect(texts(screenView(state({ state: "motion_running", what: "Bring the cup", lift: null }, { strip: sim })))).toContain(BENCH_MODE_LABEL);
  });

  it("a long title drops to a smaller bold size so the screen still fits; the words are never cut", () => {
    const title = "Bring the cup from the kitchen tray over to the left handle?";
    for (const size of ["large", "larger", "largest"] as const) {
      const v = screenView(state({ state: "motion_confirm", target: { target_id: uuid(64), title, prompt: confirmPrompt(title, true) }, hold: null }, { settings: { ...settings, text_size: size } }));
      expect(v.main.text, size).toBe(title);
      expect(["title", "small"], size).toContain(v.main.size);
    }
    // The demo's titles stay at the main size at Large, the hold control's row too.
    expect(fitMotionMain("Bring the cup?", "large", [], false).size).toBe("main");
    expect(fitMotionMain("Raise the lift?", "large", [{ text: PARK_PROMPT, size: "detail" }, { text: BENCH_MODE_LABEL, size: "detail" }], true).size).toBe("main");
    // With the hold control at Largest there is room for the title only in bold at the body size.
    expect(fitMotionMain("Raise the lift?", "largest", [{ text: PARK_PROMPT, size: "detail" }, { text: BENCH_MODE_LABEL, size: "detail" }], true).size).toBe("title");
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
    // Heard again with the Confirm handle; no touch button, since the Pi doesn't act on screen presses yet.
    expect(open.left).toEqual({ kind: "hint", word: "Confirm" });
    expect(texts(open)).toContain("Press Confirm to hear it again.");
    expect(buttons(open)).toEqual([]);
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

/**
 * Walking directions on the screen (docs/subsystems/navigation.md, "The screen"), rows written before the code:
 * N1 guiding: the maneuver's word, "in 30 m" in bold beside the arrow, the street under it, "750 m to go" and
 *    "about 10 min" under the map, Repeat and End route between the handles, Talk on the right, nothing over the
 *    left handle; a screen reader hears the whole instruction.
 * N2 the scene (and what a screen reader hears) changes with the instruction or the phase, never as the metres
 *    count down or her dot moves; the map and the distances do change.
 * N3 each phase in words: "Finding the way again", "Can't find the way from here", "Looking for GPS" (with the
 *    place she is going to), and "You've arrived" with the place; no distances while they aren't true.
 * N4 distances and times in words: "30 m", "1.3 km", "Now" at 0; "about 1 h 9 min", "under a minute".
 * N5 an unnamed way draws no street line; arriving next names the place under the map instead of what's left.
 * N6 every maneuver has a word, drawn on one line beside the arrow, never under the smallest size.
 * N7 the longest street and place the contract allows are shortened to fit their lines at every size.
 * N8 the map: Web Mercator tiles that cover the frame, her dot at the centre, zoom 17, one step out when the
 *    next turn would be off the map, centred on the route with no position; the same state draws the same map.
 */
describe("walking directions", () => {
  const demo = screenFixtures().find((f) => f.name === "navigating--large")!;
  const screen = demo.state.screen as NavigatingScreen;
  const at = (over: Partial<NavigatingScreen>, size: "large" | "larger" | "largest" = "large") =>
    screenView(state({ ...screen, ...over }, { settings: { ...settings, text_size: size } }));

  it("N1: guiding shows the turn, the distance, the street, what's left, and Repeat and End route", () => {
    const v = at({});
    expect(v.main).toEqual({ text: "Left", size: "nav" });
    expect(v.lines).toEqual([
      { text: "in 30 m", size: "body", strong: true },
      { text: "Lenox Avenue", size: "body", maxLines: 1 },
    ]);
    expect(v.nav?.info.map((l) => l.text)).toEqual(["750 m to go", "about 10 min"]);
    expect(v.nav).toMatchObject({ turn: "left", simulated: true, columnPx: 280, arrowPx: NAV_ARROW_PX.large, mainPx: NAV_WORD_CAP_PX.large, mainWraps: false });
    expect(buttons(v).map((b) => [b.action, b.label])).toEqual([
      ["repeat_direction", "Repeat"],
      ["end_route", "End route"],
    ]);
    expect(v.left).toBeNull();
    expect(v.right).toBe("Talk");
    expect(v.announce).toBe("Turn left onto Lenox Avenue.");
    // Every other screen has no map.
    expect(screenView(state({ state: "listening" })).nav).toBeNull();
  });

  it("N2: the scene and the announcement follow the instruction and the phase, not the metres", () => {
    const a = at({});
    const b = at({ to_step_m: 20, remaining_m: 740, remaining_min: 9, map: { ...screen.map, position: [37.80989, -122.25792] } });
    expect(b.sceneKey).toBe(a.sceneKey);
    expect(b.announce).toBe(a.announce);
    expect(b.lines[0]!.text).toBe("in 20 m");
    expect(b.nav!.map.route).not.toBe(a.nav!.map.route);
    expect(at({ instruction: "Turn right onto Bellevue Avenue.", maneuver: "right", street: "Bellevue Avenue" }).sceneKey).not.toBe(a.sceneKey);
    expect(at({ phase: "rerouting" }).sceneKey).not.toBe(a.sceneKey);
  });

  it("N3: each phase in words, with the place, and no distances that aren't true", () => {
    const rerouting = at({ phase: "rerouting" });
    expect(texts(rerouting)).toEqual(["Finding the way again", "To Lake Merritt Boating Center"]);
    expect(rerouting.nav).toMatchObject({ turn: null, info: [] });
    expect(rerouting.announce).toBe("Finding the way again.");
    expect(texts(at({ phase: "off_route" }))[0]).toBe("Can't find the way from here");
    const lost = at({ phase: "no_position", to_step_m: null, map: { ...screen.map, position: null } });
    expect(texts(lost)).toEqual(["Looking for GPS", "To Lake Merritt Boating Center"]);
    expect(lost.nav!.map.position).toBeNull();
    const arrived = at({ phase: "arrived", maneuver: "arrive", street: null, to_step_m: 0, remaining_m: 0, remaining_min: 0 });
    expect(texts(arrived)).toEqual(["You've arrived", "Lake Merritt Boating Center"]);
    expect(arrived.announce).toBe("You've arrived: Lake Merritt Boating Center.");
    // Repeat and End route stay in every phase.
    for (const phase of ["rerouting", "off_route", "no_position", "arrived"] as const) {
      expect(buttons(at({ phase })).map((b) => b.action), phase).toEqual(["repeat_direction", "end_route"]);
    }
  });

  it("N4: distances and times in words", () => {
    expect([distanceWords(30), distanceWords(990), distanceWords(1250), distanceWords(4950), distanceWords(12_340)]).toEqual(["30 m", "990 m", "1.3 km", "5 km", "12 km"]);
    expect(at({ to_step_m: 0 }).lines[0]).toEqual({ text: "Now", size: "body", strong: true });
    expect(at({ to_step_m: 1250 }).lines[0]!.text).toBe("in 1.3 km");
    expect(at({ to_step_m: null }).lines.map((l) => l.text)).toEqual(["Lenox Avenue"]);
    expect([minutesLeftWords(0), minutesLeftWords(1), minutesLeftWords(59), minutesLeftWords(60), minutesLeftWords(69)]).toEqual([
      "under a minute",
      "about 1 min",
      "about 59 min",
      "about 1\u00a0h",
      "about 1\u00a0h 9\u00a0min",
    ]);
  });

  it("N5: an unnamed way draws no street; arriving next names the place under the map", () => {
    expect(at({ street: null }).lines.map((l) => l.text)).toEqual(["in 30 m"]);
    // Arriving is the next thing: "in 30 m" says what is left, so the place goes under the map instead.
    const next = at({ maneuver: "arrive", street: "Bellevue Avenue", instruction: "Arrive at the Lake Merritt Boating Center." });
    expect(texts(next)).toEqual(["Arrive", "in 30 m"]);
    expect(next.nav!.info).toEqual([{ text: "Lake Merritt Boating Center", size: "detail", maxLines: 3 }]);
    expect(next.nav!.turn).toBe("arrive");
  });

  it("N6: every maneuver has a word that fits one line beside the arrow, never under 40 px", () => {
    for (const maneuver of ManeuverSchema.options) {
      const word = MANEUVER_WORD[maneuver];
      expect(WORD_EM[word], word).toBeGreaterThan(0);
      for (const size of ["large", "larger", "largest"] as const) {
        const px = turnWordPx(word, size);
        expect(px, `${word} ${size}`).toBeGreaterThanOrEqual(40);
        expect(px).toBeLessThanOrEqual(NAV_WORD_CAP_PX[size]);
        expect(WORD_EM[word]! * px, `${word} ${size}`).toBeLessThanOrEqual(navColumns(size).right - NAV_ARROW_PX[size] - 16);
      }
    }
    expect(turnWordPx("Left", "largest")).toBe(96);
    // Each word is drawn by a fixture, so the shots check measures it at every size.
    const drawn = new Set(screenFixtures().map((f) => (f.state.screen.state === "navigating" ? f.state.screen.maneuver : null)));
    for (const maneuver of ManeuverSchema.options) expect(drawn.has(maneuver), maneuver).toBe(true);
    expect(turnWordPx("Turn around", "large")).toBeLessThan(88);
  });

  it("N7: a long street's type is shortened first ('Lakeshore Ave'), then the name is cut at a word", () => {
    expect(streetForLine("Lakeshore Avenue", 16)).toBe("Lakeshore Avenue");
    expect(streetForLine("Lakeshore Avenue", 15)).toBe("Lakeshore Ave");
    expect(streetForLine("Martin Luther King Junior Way", 15)).toBe("Martin Luther…");
    expect(streetForLine("Martin Luther King Jr Boulevard", 22)).toBe("Martin Luther King Jr…");
    expect(streetForLine("Martin Luther King Jr Boulevard", 26)).toBe("Martin Luther King Jr Blvd");
  });

  it("N7: the longest street and place are shortened to fit their lines, at every size", () => {
    for (const size of ["large", "larger", "largest"] as const) {
      const street = at({ street: LONGEST_STREET }, size).lines.at(-1)!.text;
      expect([...street].length, size).toBeLessThanOrEqual(bodyChars(size));
      expect(street.endsWith("…"), size).toBe(true);
      const to = at({ phase: "off_route", destination: LONGEST_PLACE }, size).lines[0]!;
      expect(to.maxLines).toBe(2);
      expect([...to.text].length, size).toBeLessThanOrEqual(fitChars(navColumns(size).right, 40, 2));
      expect(at({ phase: "off_route" }, size).lines[0]!.text, size).toBe("To Lake Merritt Boating Center");
      // The announcement keeps every word.
      expect(at({ phase: "arrived", destination: LONGEST_PLACE }, size).announce).toContain(LONGEST_PLACE);
    }
  });

  it("N8: the map is tiles that cover the frame, her dot at the centre, and the same state draws the same map", () => {
    const m = navMap(screen.map, 280, 410, 310);
    expect(m.zoom).toBe(17);
    expect(m.position).toEqual({ x: 140, y: 205 });
    // The tile under her: the slippy-map formula's (21023, 50645) at zoom 17.
    expect(m.tiles.map((t) => t.key)).toContain("17/21023/50645");
    // Every pixel of the frame is under a tile.
    for (const [x, y] of [[0, 0], [279, 0], [0, 409], [279, 409], [140, 205]] as const) {
      expect(m.tiles.some((t) => x >= t.left && x < t.left + TILE_PX && y >= t.top && y < t.top + TILE_PX), `${x},${y}`).toBe(true);
    }
    expect(m.tiles.length).toBeLessThanOrEqual(9);
    expect(navMap(screen.map, 280, 410, 310)).toEqual(m);
    expect(m.route.split(" ")).toHaveLength(screen.map.route.length);
    // The next turn far away: one step out.
    const far = navMap({ ...screen.map, step_at: DEMO_ROUTE[DEMO_ROUTE.length - 1]! }, 280, 410, 310);
    expect(far.zoom).toBe(16);
    // No position: centred on the route ahead, no dot.
    const lost = navMap({ ...screen.map, position: null }, 280, 410, 310);
    expect(lost.position).toBeNull();
    expect(worldPx(screen.map.route[0]!, 17).x - worldPx(screen.map.route[0]!, 17).x).toBe(0);
    expect(worldPx([0, 0], 0)).toEqual({ x: 128, y: 128 });
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
