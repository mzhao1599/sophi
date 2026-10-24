# Web app

Owns the landing page, onboarding, module review, and (later) device pairing and settings. Next.js 16 (App Router) and TypeScript. The onboarding API route handlers live here too, as thin adapters over [`services/cloud-api`](../../services/cloud-api/README.md); shapes come from [`packages/contracts`](../../packages/contracts/README.md).

**Status:** the landing page, the text onboarding conversation, module review and the saved-configuration view work end to end in **demo mode**. Sign-in, Supabase persistence, the LLM onboarding agent, speech input and device pairing are not built yet.

## Run it

Needs Node 22.12 or later and pnpm 11 (`corepack enable` gives you the pinned version).

```bash
pnpm install
```

```bash
pnpm dev
```

Then open <http://localhost:3000>. Other commands, from the repository root:

| Command | What it does |
| --- | --- |
| `pnpm test` | Unit tests for the contracts and the onboarding engine (Vitest) |
| `pnpm typecheck` | TypeScript across all packages |
| `pnpm build` | Production build of the web app |

No environment variables are needed yet. When Supabase and a model provider are added, list the variable **names** here and keep values in `.env.local` (git-ignored).

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Landing page: what this is, a build sheet you can tick to see modules on the walker, how setup works, the modules, questions, and a sentence that starts the setup with your words |
| `/onboarding` | Start screen (what the demo does with answers), then one question at a time, the editable "What I understood" summary and the full transcript |
| `/onboarding/review` | Module list with reasons quoted from your answers, dependency checks, the walker drawing, and save; after saving, the configuration the walker would receive |
| `/api/v1/onboarding/sessions/…` | The onboarding API; see [interfaces](../../docs/interfaces.md#cloud-api-surface) |
| `/dev/preview/{start,question,done,review,saved}` | **Development only** (404 in production): each screen rendered from a session the real engine produced, for design review and the taste-skill inspector |

## How demo mode works

- Pressing **Start the demo** creates a session in **server memory**. Its id goes in this tab's `sessionStorage`; the secret that proves you started it is an `httpOnly`, `SameSite=Strict` cookie scoped to `/api/v1/onboarding`. The id alone can't read anything, so it may appear in URLs.
- Answers are deleted an hour after the last change, when the server restarts, or immediately with **Delete my answers**.
- The in-memory store is for local demos. On a host with several instances (Vercel), two requests can land on different instances and lose the session; the Supabase store replaces it (see [`services/cloud-api`](../../services/cloud-api/README.md)).
- The landing page's closing sentence ("I'd like help with ___") hands its words to the first question through `sessionStorage`, never the URL.

## Code map

```text
app/                     routes (pages and API route handlers)
src/server/onboarding.ts cookie handling, request parsing with the contract schemas, error envelope
src/lib/api.ts           browser client; validates every response against the contracts
src/lib/useOnboarding.ts one hook owns the flow: restore, every API call, the status line, focus key
src/components/          screens and parts (QuestionStep, FactsPanel, ReviewScreen, WalkerDiagram, …)
src/components/landing/  landing page parts and styles
public/images/found/     credited archival pictures and credits.json
```

## Accessibility

Target: WCAG 2.2 AA. What is built in:

- Every choice is a native checkbox or radio inside a `fieldset` with a `legend`; no custom key handling.
- When a new question appears, focus moves to its heading; a polite live region announces only what was recorded ("Noted: at home."). Errors use `role="alert"` and are linked to the group with `aria-describedby`.
- Locked modules (the frame, and features not built yet) use `aria-disabled` with a visible reason, so they stay legible and focusable.
- The whole conversation is available as text in the transcript; nothing is said only once or only by sound.
- Touch targets are at least 44px; body text 16–17px; control borders reach 3:1; focus rings are 3px.
- Motion is limited to transform and opacity, with `prefers-reduced-motion` fallbacks that keep all content. Content hidden for an entrance animation is hidden only when the script that reveals it is running.

Manual checklist before a demo (not yet done with real users):

- [ ] Complete onboarding with the keyboard only, including editing and removing an item, changing an earlier answer, and saving.
- [ ] Complete it with VoiceOver (macOS/iOS) or NVDA; check that each question and acknowledgement is read once.
- [ ] 200% browser zoom and a 390px-wide phone: nothing overlaps, no sideways scrolling.
- [ ] Windows High Contrast or forced colours: panels, pills and selected modules stay distinguishable.
- [ ] Ask someone who hasn't seen it to set up a walker without help, and note where they hesitate.

## Design

Built with [taste-skill](https://www.tasteskill.dev/) v2 (`design-taste-frontend`). The dealt sheets are saved in [`.taste-skill/`](../../.taste-skill) (reprint with `node <skill>/scripts/draw.mjs --show --out .taste-skill/app` or `.taste-skill/page`).

- **App screens** (onboarding, review): style `editorial-greeting`, seed 2016038647. The current question is the typeset serif greeting; panels are tonal; the one accent (teal `#1b6e66`) marks selection and data. Shell: no sidebar (the product has two destinations so far), a 56px bar naming the product and the demo scope. Signature element: the walker drawing, with each module drawn where it mounts. Changes from the sheet, for accessibility: body 16px (not 14), control borders `#8c8c88` (not `#d9d9d6`).
- **Landing**: direction `page-is-the-object`, seed 2026717547, palette and type kept from the app. Idea: the walker's build sheet (the configuration the Pi receives) becomes the card on the first screen; its tear-off stub is where you tick modules. The dealt "curtain footer" was replaced by the walker assembling on the card, because the curtain kept the footer under the page for the whole scroll, which the inspector fails as covered text.
- **Inspector**, last run: 0 FAIL on every screen. Warnings kept, with reasons: the 48px question heading on app screens (the style's own greeting size, and larger type helps people with low vision); the review list running past the first screen (the summary and Save stay beside it); "hero void" on the landing (the dealt blueprint is a centred card on a flat field, the page's one rest); "off-centre" at 390px (measured before below-the-fold content appears; the frame is 16px on both sides); no video (no honest clip of walking aids was found).

### Pictures and stand-ins

The walker has no photographs yet, so it is **drawn** (`WalkerDiagram`). Replace or supplement the drawing with real photographs once the hardware exists. The archival pictures show the history of walking aids and are never presented as this walker; each is credited in the footer:

| File | Work | Licence |
| --- | --- | --- |
| `an-old-man-with-a-beard-in.jpg` | "An old man with a beard in a walking frame", Wellcome Collection | CC BY 4.0 |
| `two-mothers-with-crying-babies-and-one.jpg` | "Two mothers with crying babies and one in a walking frame", Wellcome Collection | CC BY 4.0 |
| `mother-child-old-man-with-baby-s.jpg` | Elisha Kirkall, "Mother, Child, old man with baby's walking frame on wheels", 1724, Yale Center for British Art | CC0 |
| `old-man-with-a-walking-stick.jpg` | Wilhelm Leibl, "Old Man with a Walking Stick", 1875/77, Art Institute of Chicago | CC0 |

Source pages and licence links are in `public/images/found/credits.json`.

### Copy to confirm with the team

The letter on the landing page is signed "The Assistive Walker team, Cal Hacks, October 2026". The slip says pairing will use "one code" (the planned one-time pairing challenge). Change either if the team prefers.
