import { HOLD_CONTROL_REFRESH_MS, SCREEN_HOLD_RELEASE_EVENTS, holdControlShown, type ScreenHold } from "@walker/contracts";
import { screenFixtures, screenView } from "@walker/walker-screen";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HOLD_SEND_MS, HoldControl } from "../src/screen/hold";
import { ScreenPage } from "../src/screen/pageView";

/** Row D23 of test/EXPECTED.md: the page's side of the lift's hold control, on fake timers and real EventTargets. */

/** A page: a window and a document to fire events at, a hand-moved clock, and every message it would post. */
function page() {
  const window = new EventTarget();
  const document = new EventTarget();
  let now = 0;
  let next = 1;
  const timers = new Map<number, { fn: () => void; every: number; due: number }>();
  const sent: Array<ScreenHold & { t: number }> = [];
  const heldChanges: boolean[] = [];
  const hold = new HoldControl({
    window,
    document,
    send: (h) => sent.push({ ...h, t: now }),
    now: () => 1_761_000_000_000 + now,
    setInterval: (fn, ms) => {
      const id = next++;
      timers.set(id, { fn, every: ms, due: now + ms });
      return id;
    },
    clearInterval: (id) => timers.delete(id as number),
    onChange: (held) => heldChanges.push(held),
  });
  const detach = hold.attach();
  /** Moves the page's clock, firing intervals on the way. */
  const advance = (ms: number) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.values()].filter((t) => t.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!due) break;
      now = due.due;
      due.due += due.every;
      due.fn();
    }
    now = end;
  };
  return { hold, window, document, sent, heldChanges, advance, timers, detach, pressed: () => sent.filter((s) => s.pressed).length, released: () => sent.filter((s) => !s.pressed).length };
}

describe("D23: the page's hold control", () => {
  it("sends still-held at once and then every 50 ms, four times per HOLD_CONTROL_REFRESH_MS", () => {
    expect(HOLD_SEND_MS).toBe(50);
    expect(HOLD_SEND_MS * 4).toBe(HOLD_CONTROL_REFRESH_MS);
    const p = page();
    p.hold.setShown(true);
    p.hold.press();
    p.advance(1000);
    const times = p.sent.filter((s) => s.pressed).map((s) => s.t);
    expect(times[0]).toBe(0);
    expect(times).toHaveLength(21);
    for (let i = 1; i < times.length; i += 1) expect(times[i]! - times[i - 1]!).toBe(50);
    // The page's clock goes up, so the Pi can order a release after them.
    const ats = p.sent.map((s) => s.at);
    expect([...ats].sort((a, b) => a - b)).toEqual(ats);
    expect(p.hold.isHeld()).toBe(true);
    expect(p.heldChanges).toEqual([true]);
  });

  it("does nothing when pressed while the control isn't shown", () => {
    const p = page();
    p.hold.press();
    p.advance(500);
    expect(p.sent).toEqual([]);
    expect(p.hold.isHeld()).toBe(false);
  });

  const releases: Array<[string, (p: ReturnType<typeof page>) => void]> = [
    ...SCREEN_HOLD_RELEASE_EVENTS.map((name): [string, (p: ReturnType<typeof page>) => void] => [
      name,
      (p) => (name === "visibilitychange" ? p.document : p.window).dispatchEvent(new Event(name)),
    ]),
    ["keyup", (p) => p.window.dispatchEvent(new Event("keyup"))],
    ["the control leaving the screen", (p) => p.hold.setShown(false)],
    ["the stream dropping", (p) => p.hold.streamLost()],
    ["the page closing its listeners", (p) => p.detach()],
  ];

  for (const [what, release] of releases) {
    it(`lets go on ${what}: one release, and the refreshes stop`, () => {
      const p = page();
      p.hold.setShown(true);
      p.hold.press();
      p.advance(120);
      const before = p.pressed();
      release(p);
      expect(p.released()).toBe(1);
      expect(p.sent.at(-1)!.pressed).toBe(false);
      p.advance(1000);
      expect(p.pressed()).toBe(before);
      expect(p.released()).toBe(1);
      expect(p.timers.size).toBe(0);
      expect(p.hold.isHeld()).toBe(false);
      expect(p.heldChanges).toEqual([true, false]);
      // A second release event sends nothing more.
      release(p);
      expect(p.released()).toBe(1);
    });
  }

  it("listens for exactly the contract's release events, on the window and (visibilitychange) the document", () => {
    expect([...SCREEN_HOLD_RELEASE_EVENTS]).toEqual(["pointerup", "pointercancel", "touchend", "touchcancel", "blur", "visibilitychange"]);
  });

  it("the confirm screen becoming the running one, with the control still shown, doesn't let go", () => {
    const p = page();
    p.hold.setShown(true);
    p.hold.press();
    p.advance(300);
    // React re-runs the effect with the same answer: still shown.
    p.hold.setShown(true);
    p.advance(300);
    expect(p.released()).toBe(0);
    expect(p.pressed()).toBe(13);
  });

  it("can be pressed again after a release, and a key held down doesn't press twice", () => {
    const p = page();
    p.hold.setShown(true);
    p.hold.press();
    p.hold.press();
    expect(p.pressed()).toBe(1);
    p.window.dispatchEvent(new Event("pointerup"));
    p.hold.press();
    expect(p.sent.map((s) => s.pressed)).toEqual([true, false, true]);
  });
});

describe("D23: the page draws the hold control only for a lift target", () => {
  const draw = (view: ReturnType<typeof screenView> | null, held = false) =>
    renderToStaticMarkup(<ScreenPage view={view} held={held} onPress={() => {}} onHold={() => {}} />);

  it("no screen without a lift target has it; the lift's confirm and running screens do", () => {
    const withHold: string[] = [];
    for (const f of screenFixtures()) {
      const html = draw(screenView(f.state));
      const has = html.includes('class="ws-button ws-hold"');
      expect(has, f.name).toBe(holdControlShown(f.state.screen) !== null);
      if (has) withHold.push(f.name.split("--")[0]!);
    }
    expect([...new Set(withHold)].sort()).toEqual([
      "motion-confirm-lift-home-no-bench",
      "motion-confirm-lift-raise",
      "motion-confirm-longest-hold",
      "motion-running-lift",
      "motion-running-longest-lift",
    ]);
  });

  it("draws it held only while held, and the waiting screen has none", () => {
    const lift = screenFixtures().find((f) => f.name === "motion-running-lift--large")!;
    expect(draw(screenView(lift.state), true)).toContain('data-held="true"');
    expect(draw(screenView(lift.state), false)).toContain('data-held="false"');
    expect(draw(null)).toContain("Waiting for the walker service.");
    expect(draw(null)).not.toContain("ws-hold");
  });
});
