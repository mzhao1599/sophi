# Walker screen

What the walker's own 800x480 screen draws: a pure `screenView(state, settings?)` that turns the Pi's `ScreenState` ([contract](../contracts/src/circle.ts), [interfaces](../../docs/interfaces.md#the-walker-screens-local-contract-pi--page-on-127001)) into a view model, a React component that draws it, its stylesheet and font, and example states for every screen. The Pi's walker service serves it as the walker's screen page (`devices/pi/src/screen/page.tsx`, the walker's own states only so far; the circle's come later); the web app doesn't use it yet. Nothing here decides behaviour; the Pi picks the state.

| File | What it is |
| --- | --- |
| `src/view.ts` (also exported alone as `@walker/walker-screen/view`, so the Pi's Node bundle gets `captionPages` without React) | `screenView(state, settings?)`: the words and layout for each state, in three fixed regions (status strip, the one thing, the band over the handles). Pass draft `settings` to draw a Preview. Also `captionPages(text, textSize)`, which the Pi uses to page captions |
| `src/sizes.ts` | Every size from one `PX_PER_MM` (7.35 for the 800x480, 108.9 mm wide panel): smallest text 40 px, body 48/56/64, main line 88/104/120 by text size, buttons 147 px (20 mm), at most 3 |
| `src/WalkerScreenView.tsx` | The React view (React 19, as `apps/web`). `onPress(action)` for taps; omit it for an inert Preview |
| `src/screen.css` | Tokens copied from `apps/web/app/globals.css`, scoped by `data-theme` (never a system dark mode), `@font-face` for the bundled font, the layout, a 240 ms cross-fade with a reduced-motion branch |
| `src/fonts/` | Atkinson Hyperlegible Next (Google Fonts' latin and latin-ext subsets, variable weight) and its SIL Open Font License, `OFL.txt` |
| `src/fixtures.ts` | Every state at every text size, the walker's own first, with the demo's names and the longest names the contract allows; motion with the longest titles, fault and refusal sentences, and the simulator's strip |

Rules it keeps (from the screen research): text only in colours of 7:1 or better; every colour also a shape and a word (filled, hollow or dashed dot; "Simulator" and "Simulated" dashed tags); nothing moves while idle; no blur, slide or pulse; no emergency wording ("clear it", the instruction to clear a motion fault, is the one use of "clear"); at most 3 buttons of at least 20 mm.

**Motion** *(added 2026-10-24)*. Four states from the motion contract: a pending Confirm target (`motion_confirm`: the Pi's title and prompt word for word, "Confirm" named over the left handle and no touch Confirm, because only a handle press starts motion), a running motion (`motion_running`: "Stop" over both handles; the lift's "Keep holding"), "Done", "Stopped" or "Not started" after a motion (`motion_holding`), and a latched fault (`motion_fault`: its sentence and "Ask a helper to clear it at the walker."). Every motion screen says "Bench mode: no hardware stop" when the strip's `bench_mode` is on, and the strip shows a "Bench mode" tag (not beside "Simulator"). The view's `hold` is the lift's hold control ("Hold to raise"), present exactly when the contract's `holdControlShown` says; `WalkerScreenView` calls `onHold(true)` on a press and `onHold(false)` on a key's release, and the caller listens for every other release on the whole page (the Pi's `src/screen/hold.ts`). A motion title is never cut: `fitMotionMain` picks the main size, bold body size or bold smallest size from the height left at 800x480, and the screenshot check proves it on the 60-character worst case.

## Checks

```bash
pnpm --filter @walker/walker-screen typecheck
pnpm --filter @walker/walker-screen test
```

The screenshot check draws every fixture in headless Chromium at 800x480, saves PNGs, and fails on any overflow, a main line over two lines, a word broken across lines, text under 40 px, a button under 147 px or closer than 22 px to another, or text under 7:1. It's off unless you point it at a Playwright and a Chromium (this package installs neither):

```bash
SCREEN_SHOTS_DIR=/tmp/walker-screen-shots \
PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
CHROMIUM_PATH=/path/to/chromium \
pnpm --filter @walker/walker-screen exec vitest run test/shots.test.tsx
```

Not measured: sizes assume CSS px equal panel px (devicePixelRatio 1). Check a rendered cap height with a ruler on the panel, at the walker, before relying on them.

**Messages** *(changed 2026-10-24)*. The Pi now shows `message` while it reads a caretaker's message aloud: the words, "From Maya", "Confirm" named over the left handle and "Press Confirm to hear it again." It no longer offers a touch "Done" button, because the Pi doesn't act on screen presses yet. `message_waiting` (the "Read it" notice) is still drawn for the circle piece and not used by the Pi.

**Asking for help** *(added 2026-10-24, [help design](../../docs/subsystems/help.md))*. Three states the Pi sends: `help_hold` ("Keep holding" / "to ask for help.", "Let go to stop."), `help_countdown` (the seconds left large, "Asking for help in 8 seconds.", "Press any button to stop." and "Stop" over both handles; one scene key for the whole countdown, so the number changes without a cross-fade) and `help` in each phase: `sending` ("Asking for help", and "No internet yet. I'll keep trying." while retrying), `not_sent` ("Not sent" and why, as spoken), `open` (the newest news: "Sent to Maya's phone", "It's showing on Maya's phone" or "Maya is on the way", then "Press Confirm twice to say you're okay." with "Confirm" over the left handle; armed: "Press Confirm again" / "to tell Maya you're okay.") and `closed` ("Okay" / "They'll see that you're okay.", "Maya says they're with you", "Your request for help has ended"). No help screen has a touch button: the handles do it all, and her phone is the touch path. `HELP_WORDS` in `view.ts` holds the walker's fixed help lines; the Pi speaks the same strings (`devices/pi/src/notices.ts`), so screen and voice never drift. The screen's `closed` state carries who closed it but not who it was sent to, so the spoken "Okay. Maya will see that you're okay." shows without the names. Names are never cut: the main line drops to the bold body or smallest size for seven 12-character names, and the screenshot check covers every phase at every size.

**Not shown until built:** the "My screen" button (on the clock and offline screens) is left out until the Pi acts on it (a TODO in `view.ts`; a test checks no fixture offers it). The My screen pages themselves are drawn for the circle piece.
