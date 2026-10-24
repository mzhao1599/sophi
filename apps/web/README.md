# Web app

Owns the landing page, onboarding, module review, and (later) device pairing and settings. Next.js 16 (App Router) and TypeScript. The onboarding API route handlers live here too, as thin adapters over [`services/cloud-api`](../../services/cloud-api/README.md); shapes come from [`packages/contracts`](../../packages/contracts/README.md).

**Status:** the landing page, the text onboarding conversation, module review and the saved-configuration view work end to end in **demo mode**. The LLM onboarding agent is built but off by default (see below). Sign-in, Supabase persistence, speech input and device pairing are not built yet.

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

No environment variables are needed for the default, deterministic onboarding. To turn on the onboarding agent, copy `.env.example` to `.env.local` (git-ignored) and set `ONBOARDING_ENGINE=agent` and `ANTHROPIC_API_KEY`; `ONBOARDING_AGENT_MODEL` is optional. They are read on the server only. What the agent does and how it falls back is in [`services/cloud-api`](../../services/cloud-api/README.md#onboarding-agent).

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Landing page: what this is, how setup works, the modules (tick one to see it drawn on the walker), who's in control, questions, and a closing question that starts the setup with your words |
| `/onboarding` | Start screen (what the demo does with answers), then one question at a time, the editable "What I understood" summary and the full transcript |
| `/onboarding/review` | Module list with reasons quoted from your answers, dependency checks, the walker drawing, and save; after saving, the configuration the walker would receive |
| `/api/v1/onboarding/sessions/…` | The onboarding API; see [interfaces](../../docs/interfaces.md#cloud-api-surface) |
| `/dev/preview/{start,question,done,review,saved}` | **Development only** (404 in production): each screen rendered from a session the real engine produced, for design review and the taste-skill inspector |

## How demo mode works

- Pressing **Start the demo** creates a session in **server memory**. Its id goes in this tab's `sessionStorage`; the secret that proves you started it is an `httpOnly`, `SameSite=Strict` cookie scoped to `/api/v1/onboarding`. The id alone can't read anything, so it may appear in URLs.
- Answers are deleted an hour after the last change, when the server restarts, or immediately with **Delete my answers**.
- The in-memory store is for local demos. On a host with several instances (Vercel), two requests can land on different instances and lose the session; the Supabase store replaces it (see [`services/cloud-api`](../../services/cloud-api/README.md)).
- With the onboarding agent on, each answer is also sent to Anthropic's API, and the first screen says so before the session starts. A turn the model can't handle in time falls back to the fixed questions.
- The landing page's closing question ("What would you like help with?") hands its words to the first question through `sessionStorage`, never the URL.

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
- While onboarding starts, or an answer or edit saves, focus never falls to the page. The buttons involved use `aria-disabled` while busy, not `disabled`, so they stay focusable; a press then is ignored. On a question, Continue, "Skip this question" and "Skip the rest and review" move focus to a visible note ("Saving your answer…", "Skipping this question…", "Skipping to the review…"), which a screen reader reads when it takes focus; the next heading then takes focus in the same update that removes the note. If the save fails, focus goes back to the button that was pressed (Continue, when Enter was pressed in an option) and the error is announced. "Start the demo" and the Save and Remove buttons in "What I understood" keep focus and say what is happening ("Starting…", "Saving…", "Removing…"); "Change this answer" keeps focus until the reopened question's heading takes it. Not yet done: "Delete my answers" in the top bar and the Save buttons on the review page still use `disabled`, so focus can still drop there.
- Locked modules (the frame, and features not built yet) use `aria-disabled` with a visible reason, so they stay legible and focusable.
- The whole conversation is available as text in the transcript; nothing is said only once or only by sound.
- Touch targets are at least 44px; body text 16–17px; control borders reach 3:1; focus rings are 3px.
- Motion is limited to transform and opacity, with `prefers-reduced-motion` fallbacks that keep all content. Content hidden for an entrance animation is hidden only when the script that reveals it is running. The landing page's one moving line has a visible pause button (WCAG 2.2.2), stops on hover, and doesn't move at all under reduced motion.
- On the landing page every colour field sets its own text and focus-ring colours, so the 3px ring stays visible on ultramarine, black, yellow and pink.

Manual checklist before a demo (not yet done with real users):

- [ ] Complete onboarding with the keyboard only, including editing and removing an item, changing an earlier answer, and saving.
- [ ] Complete it with VoiceOver (macOS/iOS) or NVDA; check that each question and acknowledgement is read once.
- [ ] 200% browser zoom and a 390px-wide phone: nothing overlaps, no sideways scrolling.
- [ ] Windows High Contrast or forced colours: panels, pills and selected modules stay distinguishable.
- [ ] Ask someone who hasn't seen it to set up a walker without help, and note where they hesitate.

## Design

Built with [taste-skill](https://www.tasteskill.dev/) v2 (`design-taste-frontend`). The second design (October 2026) started from real sites; what was taken from each is in [`.taste-skill/redesign/inspiration.md`](../../.taste-skill/redesign/inspiration.md), and the reasoning, redraws and critique rounds are in [`.taste-skill/redesign/notes.md`](../../.taste-skill/redesign/notes.md). The dealt sheets are in [`.taste-skill/`](../../.taste-skill) (reprint with `node <skill>/scripts/draw.mjs --show --out .taste-skill/page` or `.taste-skill/app`).

- **Landing**: direction `loud-flat-poster` ("Loud and flat"), seed 1681769881. Flat fields of ultramarine, black, yellow and pink with white or black ink; one green for the primary action; one family, Archivo (condensed 800 capitals for display, normal width for text, body 18px). Idea: the walker's own rules are said at full volume as poster statements, and the walker is a flat drawing you build by ticking its parts (the Modules section, with the drawing pinned beside the list). Redraws: the hero (the dealt one scrolled its headline sideways all the time, which fails WCAG 2.2.2) and the "about" section (it needed team portraits that don't exist); the dealt pink was lightened so black text reaches 7.6:1.
- **App screens** (onboarding, review): style `achromatic-ledger`, seed 1253139886, with the landing's palette and type kept. Ink on white with no colour in the chrome; the primary action is near-black; the one hue (ultramarine `#1423b8`) goes on what you chose: a chosen answer, a module on your walker, the progress bar, the parts drawn on the walker. Titles are Archivo 800 at 80% width (32px; the current question 40px). Shell: no sidebar (the sheet's icon rail was replaced, because the app has two destinations), a 56px bar with the mark, the wordmark in the landing's condensed capitals, the demo scope and "Delete my answers". Changes from the sheet, for accessibility: body 16px (not 14), meta 14px (not 12), control borders `#6e7380` (3:1 or more on white and on the panels), targets 44px or more. Signature element: the walker drawing, on review and on the "That's everything I need" screen.
- **Inspector**, last run: 0 FAIL at 1440, 768 and 390 on the landing and on every app screen (`/dev/preview/{start,question,done,review,saved}`, with `--app`). Warnings kept, with reasons: no video on the landing (the open collections have no honest clip of walking aids; the slow sway of the hero print and the moving line are the page's moving pictures); the 40px question heading (the question is the one thing to read on that screen, and larger type helps people with low vision); the review list running past the first screen (seven modules with reasons; the summary and Save stay pinned beside it).

### Pictures and stand-ins

The walker has no photographs yet, so it is **drawn** (`WalkerDiagram`, flat pieces; solid means on the walker, dashed means left off). Replace or supplement the drawing with real photographs once the hardware exists. The archival prints show the history of walking frames and are never presented as this walker; each is captioned where it appears and credited in the footer, with one treatment (black and white, stuck on at a slight angle):

| File | Work | Licence | Where |
| --- | --- | --- | --- |
| `an-old-man-with-a-beard-in.jpg` | "An old man with a beard in a walking frame", Wellcome Collection | CC BY 4.0 | Hero, cut to an arch |
| `mother-child-old-man-with-baby-s.jpg` | Elisha Kirkall, "Mother, Child, old man with baby's walking frame on wheels", 1724, Yale Center for British Art | CC0 | How setup works |
| `old-man-with-a-walking-stick.jpg` | Wilhelm Leibl, "Old Man with a Walking Stick", 1875/77, Art Institute of Chicago | CC0 | Who's in control |
| `two-mothers-with-crying-babies-and-one.jpg` | "Two mothers with crying babies and one in a walking frame", Wellcome Collection | CC BY 4.0 | Fair questions |

Source pages and licence links are in `public/images/found/credits.json`. The interface fragments under "How setup works" are drawn in HTML from the app's real wording and the demo's sample answers; the configuration shown under "Pair" is an excerpt of the demo's saved output (the `/dev/preview/saved` answers), labelled as such, because pairing isn't built.

### Copy to confirm with the team

The letter on the landing page is signed "The Assistive Walker team, Cal Hacks, October 2026". The "Pair" step says pairing will use "one code" (the planned one-time pairing challenge), and "Tell" says "6 or 7 short questions" (the agent may ask about six). Change any of them if the team prefers.
