# Walker screen

What the walker's own 800x480 screen draws: a pure `screenView(state, settings?)` that turns the Pi's `ScreenState` ([contract](../contracts/src/circle.ts), [interfaces](../../docs/interfaces.md#the-walker-screens-local-contract-pi--page-on-127001)) into a view model, a React component that draws it, its stylesheet and font, and example states for every screen. The Pi's walker service serves it as the walker's screen page (`devices/pi/src/screen/page.tsx`, the walker's own states only so far; the circle's come later); the web app doesn't use it yet. Nothing here decides behaviour; the Pi picks the state.

| File | What it is |
| --- | --- |
| `src/navigation.ts` | Walking directions: the height and width budget, the maneuver words, distances and times in words, and the map's tile grid (Web Mercator, no map library) |
| `src/view.ts` (also exported alone as `@walker/walker-screen/view`, so the Pi's Node bundle gets `captionPages` without React) | `screenView(state, settings?)`: the words and layout for each state, in three fixed regions (status strip, the one thing, the band over the handles). Pass draft `settings` to draw a Preview. Also `captionPages(text, textSize)`, which the Pi uses to page captions |
| `src/sizes.ts` | Every size from one `PX_PER_MM` (7.35 for the 800x480, 108.9 mm wide panel): smallest text 40 px, body 48/56/64, main line 88/104/120 by text size, buttons 147 px (20 mm), at most 3 |
| `src/WalkerScreenView.tsx` | The React view (React 19, as `apps/web`). `onPress(action)` for taps; omit it for an inert Preview. `tiles` is the map tiles' base URL (the Pi's page passes `/tiles`); without it the map draws on a plain background |
| `src/screen.css` | Tokens copied from `apps/web/app/globals.css`, scoped by `data-theme` (never a system dark mode), `@font-face` for the bundled font, the layout, a 240 ms cross-fade with a reduced-motion branch |
| `src/fonts/` | Atkinson Hyperlegible Next (Google Fonts' latin and latin-ext subsets, variable weight) and its SIL Open Font License, `OFL.txt` |
| `src/fixtures.ts` | Every state at every text size, the walker's own first, with the demo's names and the longest names the contract allows; motion with the longest titles, fault and refusal sentences, and the simulator's strip |

Rules it keeps (from the screen research): text only in colours of 7:1 or better (the map's "© OpenStreetMap contributors" credit is the one text under 40 px: 16 px, 7:1 on its own card); every colour also a shape and a word (filled, hollow or dashed dot; "Simulator" and "Simulated" dashed tags); nothing moves while idle; no blur, slide or pulse; no emergency wording ("clear it", the instruction to clear a motion fault, is the one use of "clear"); at most 3 buttons of at least 20 mm.

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

`SCREEN_TILES=file:///path/to/tiles` (a folder of `{z}/{x}/{y}.png`) draws the walking-directions fixtures on real map tiles; without it they draw on the plain background, as the Pi does offline with nothing cached. On walking directions' screens the check also proves the maneuver word keeps one line, no line needed its ellipsis backstop, the map stays in its column, and the OpenStreetMap credit is on the map at 7:1.

Not measured: sizes assume CSS px equal panel px (devicePixelRatio 1). Check a rendered cap height with a ruler on the panel, at the walker, before relying on them.

**Messages** *(changed 2026-10-24)*. The Pi now shows `message` while it reads a caretaker's message aloud: the words, "From Maya", "Confirm" named over the left handle and "Press Confirm to hear it again." It no longer offers a touch "Done" button, because the Pi doesn't act on screen presses yet. `message_waiting` (the "Read it" notice) is still drawn for the circle piece and not used by the Pi.

**Not shown until built:** the "My screen" button (on the clock and offline screens) is left out until the Pi acts on it (a TODO in `view.ts`; a test checks no fixture offers it). The My screen pages themselves are drawn for the circle piece.

**Walking directions** *(added 2026-10-24, [navigation guide](../../docs/subsystems/navigation.md#the-screen-packageswalker-screen-devicespisrcscreen))*. `navigating` is drawn in two columns under the strip: on the left a street map and, under it, the distance and time left ("750 m to go", "about 10 min"); on the right the next thing to do, an arrow drawn in SVG and its word ("Left", "Slight right", "Turn around", "Arrive") as large as fits one line, "in 30 m" in bold, and the street, over the band with Repeat and End route (they send `repeat_direction` and `end_route`) and Talk. The phases say "Finding the way again", "Can't find the way from here" and "Looking for GPS" with the place she is going to, and "You've arrived" with the place; distances show only while they are true. A dashed Simulated tag sits on the map, and her dot's ring is dashed, when the position is simulated. The height and width budget per text size is at the top of `src/navigation.ts`.

- **The scene** is the phase and the instruction, so the screen cross-fades, and a screen reader hears the whole instruction ("Turn left onto Lenox Avenue."), only when the next thing to do changes. The map, her dot and the distances redraw with every state, in place: nothing pans or animates, with or without reduced motion.
- **The map** is a plain tile grid at zoom 17 (about 260 by 290 m by Lake Merritt), or 16 when the next turn would be off it, centred on her (or on the route ahead with no position). The route ahead is a thick blue line with a white edge (light blue on a dark edge in the dark theme, where the tiles are inverted), her position a ringed dot, the next turn a hollow ring and the place a pin. A tile that fails to load is hidden, so the line and the dot still draw on the plain background. The map is one image to a screen reader ("Map: your simulated position, the route ahead, the next turn, the place. Map data © OpenStreetMap contributors.").
- **Names** are shortened to fit their lines at each size (the street to one line, the place to two), with a CSS ellipsis as a backstop for an unusually wide name; the screen reader still hears every word.
- **Fixtures**: every phase on a real walking route by Lake Merritt (OpenStreetMap's foot router, fetched once; illustrative, not a recorded walk), with the longest street (60 characters) and place (100) the contract allows, offline, dark, real and simulated positions.

Screenshots (headless Chromium at 800x480, real OpenStreetMap tiles, 2026-10-24): [guiding at Large](../../docs/design/screenshots/navigating-guiding-large.jpg), [guiding at Largest](../../docs/design/screenshots/navigating-guiding-largest.jpg), [rerouting](../../docs/design/screenshots/navigating-rerouting.jpg), [arrived](../../docs/design/screenshots/navigating-arrived.jpg), [dark](../../docs/design/screenshots/navigating-dark.jpg).

Not shown in the web app: `apps/web` doesn't draw the walker screen (its `/dev/preview` pages are the onboarding page's), so nothing there passes `tiles`.
