# Walker screen

What the walker's own 800x480 screen draws: a pure `screenView(state, settings?)` that turns the Pi's `ScreenState` ([contract](../contracts/src/circle.ts), [interfaces](../../docs/interfaces.md#the-walker-screens-local-contract-pi--page-on-127001)) into a view model, a React component that draws it, its stylesheet and font, and example states for every screen. **Built and tested here only:** no Pi page serves it yet and the web app doesn't use it yet (later pieces). Nothing here decides behaviour; the Pi picks the state.

| File | What it is |
| --- | --- |
| `src/view.ts` | `screenView(state, settings?)`: the words and layout for each state, in three fixed regions (status strip, the one thing, the band over the handles). Pass draft `settings` to draw a Preview. Also `captionPages(text, textSize)`, which the Pi uses to page captions |
| `src/sizes.ts` | Every size from one `PX_PER_MM` (7.35 for the 800x480, 108.9 mm wide panel): smallest text 40 px, body 48/56/64, main line 88/104/120 by text size, buttons 147 px (20 mm), at most 3 |
| `src/WalkerScreenView.tsx` | The React view (React 19, as `apps/web`). `onPress(action)` for taps; omit it for an inert Preview |
| `src/screen.css` | Tokens copied from `apps/web/app/globals.css`, scoped by `data-theme` (never a system dark mode), `@font-face` for the bundled font, the layout, a 240 ms cross-fade with a reduced-motion branch |
| `src/fonts/` | Atkinson Hyperlegible Next (Google Fonts' latin and latin-ext subsets, variable weight) and its SIL Open Font License, `OFL.txt` |
| `src/fixtures.ts` | Every state at every text size, the walker's own first, with the demo's names and the longest names the contract allows |

Rules it keeps (from the screen research): text only in colours of 7:1 or better; every colour also a shape and a word (filled, hollow or dashed dot; "Simulator" and "Simulated" dashed tags); nothing moves while idle; no blur, slide or pulse; no emergency wording; at most 3 buttons of at least 20 mm. The view model has a `motionStatus` slot for arms and lift status, always `null`: the motion contract is pending on another branch.

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
