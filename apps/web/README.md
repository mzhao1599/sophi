# Web app

Owns the landing page, onboarding, module review, and (later) device pairing and settings. Next.js 16 (App Router) and TypeScript. The onboarding API route handlers live here too, as thin adapters over [`services/cloud-api`](../../services/cloud-api/README.md); shapes come from [`packages/contracts`](../../packages/contracts/README.md).

**Status:** the landing page, the text onboarding conversation, module review and the saved-configuration view work end to end in **demo mode**, with sessions in server memory or, when configured, Supabase Postgres. With Supabase, **passwordless sign-in** (an emailed code or link) saves setups to an account, resumes an unfinished one on another device, and lists saved setups with delete. Checked against a local Supabase stack, not yet a hosted project. The LLM onboarding agent is built but off by default (see below). A **mock purchase** of the saved setup through Stripe runs in **test mode only** and is off until a test key is set. Speech input and device pairing are not built yet.

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
| `pnpm test` | Unit tests for the contracts, the onboarding engine and the mock purchase (Vitest) |
| `pnpm typecheck` | TypeScript across all packages |
| `pnpm build` | Production build of the web app |

No environment variables are needed for the default, deterministic onboarding with sessions in server memory. Every variable is listed, names only, in [`.env.example`](.env.example); copy it to `.env.local` (git-ignored) to set them.

- **Onboarding agent:** `ONBOARDING_ENGINE=agent` and `ANTHROPIC_API_KEY`; `ONBOARDING_AGENT_MODEL` is optional. Server only. What the agent does and how it falls back is in [`services/cloud-api`](../../services/cloud-api/README.md#onboarding-agent).
- **Sessions in Postgres:** `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY`. All three or none. The secret key is server only and must never get a `NEXT_PUBLIC_` name.
- **Mock purchase:** `STRIPE_SECRET_KEY`, a Stripe **test** secret key (`sk_test_…`) only. Server only. See [Mock purchase](#mock-purchase-stripe-test-mode-only).

### Local Supabase

Needs Docker running. The CLI comes through npx at a pinned version (`scripts/supabase.mjs`), so there is nothing to install. From the repository root:

```bash
pnpm supabase start
```

The first start downloads the images and applies [`supabase/migrations/`](../../supabase/migrations). This project uses ports 55420–55429, not Supabase's default 5432x, so it can run next to another local Supabase project. Then:

```bash
pnpm supabase status
```

Copy `API_URL`, `PUBLISHABLE_KEY` and `SECRET_KEY` into `apps/web/.env.local` as `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY`, and restart `pnpm dev`. Studio is at <http://127.0.0.1:55423>. `pnpm supabase db reset` re-applies the migrations to an empty database; `pnpm supabase stop` stops the stack. The database tests: `pnpm test:db` (see [`services/cloud-api`](../../services/cloud-api/README.md)).

## Routes

| Route | Purpose |
| --- | --- |
| `/` | Landing page: what this is, how setup works, the modules (tick one to see it drawn on the walker), who's in control, questions, and a closing question that starts the setup with your words |
| `/onboarding` | Start screen (what the demo does with answers), then one question at a time, the editable "What I understood" summary and the full transcript |
| `/onboarding/review` | Module list with reasons quoted from your answers, dependency checks, the walker drawing, and save; after saving, the configuration the walker would receive |
| `/login` | Sign in or create an account with an email address: the email carries a code to type here and a link. Needs Supabase |
| `/auth/confirm` | Where the email's link lands: a **Sign in** button that redeems it (opening the link alone signs nobody in), then Your setups |
| `/setups` | **Your setups**: a signed-in user's saved setups, newest first, with delete; carry on with an unfinished setup; sign out; delete the account |
| `/api/v1/onboarding/sessions/…` | The onboarding API; see [interfaces](../../docs/interfaces.md#cloud-api-surface). `POST …/{id}/checkout` starts the mock purchase |
| `/api/v1/checkout/status` | Whether the mock purchase button is on, and why not |
| `/checkout/success` | Where Stripe returns after a test payment: says it was a demo and no money moved, and lists the modules read from the Checkout Session on the server |
| `/checkout/cancelled` | Where Stripe's back link returns: the same "demo, no money moved" notice |
| `/dev/preview/{start,question,done,review,saved}` | **Development only** (404 in production): each screen rendered from a session the real engine produced, for design review and the taste-skill inspector |

## How demo mode works

- Pressing **Start the demo** creates a session in **Postgres** when Supabase is configured, otherwise in **server memory**. Its id goes in this tab's `sessionStorage`; the secret that proves you started it is an `httpOnly`, `SameSite=Strict` cookie scoped to `/api/v1/onboarding`. Postgres stores only the secret's hash. The id alone can't read anything, so it may appear in URLs.
- Answers are deleted an hour after the last change (within five minutes of expiring, by a database job), or immediately with **Delete my answers**. The memory store also loses them when the server restarts.
- The in-memory store is for local demos. On a host with several instances (Vercel), two requests can land on different instances and lose the session, so production refuses to start onboarding without Supabase unless `ONBOARDING_ALLOW_MEMORY_STORE=true` (see [`services/cloud-api`](../../services/cloud-api/README.md#supabase-store)).
- With the onboarding agent on, each answer is also sent to Anthropic's API, and the first screen says so before the session starts. A turn the model can't handle in time falls back to the fixed questions.
- The landing page's closing question ("What would you like help with?") hands its words to the first question through `sessionStorage`, never the URL.

## Sign-in

Passwordless, with Supabase Auth and [`@supabase/ssr`](https://supabase.com/docs/guides/auth/server-side). Everything runs on the server (server actions in `src/server/auth-actions.ts`, the `/auth/confirm` route, server components), so the browser never holds the session in script: the Supabase cookies are `httpOnly`, `SameSite=Lax`, and `Secure` in production. `proxy.ts` (Next.js 16's name for middleware) refreshes an expiring access token before each page; it decides nothing about access. Pages, route handlers and actions each verify the user with `getClaims()`, and Postgres row-level security checks again.

- **First sign-in creates the account.** There is no password to set or forget.
- **One email, two ways in:** a 6-digit code to type on `/login` (works when the email is read on another device), and a link to `/auth/confirm` for the device where you want to be signed in. Both work once and expire in an hour. The link opens a page with a **Sign in** button, and only the button redeems it: email security scanners that open links can't use it up, and a link someone else sent can't quietly sign you into their account. The template is [`supabase/templates/sign-in.html`](../../supabase/templates/sign-in.html); the hosted project needs it pasted in (see "Deploy on Vercel").
- **Accessible:** a labelled email field with a hint, errors in `role="alert"` linked to their field, a polite status for "We sent a new email", and focus moved to the new heading when the step changes. Every step is a plain form, so it works with the keyboard and without JavaScript. The demo stays one click away and is labelled as a demo.
- **What changes when signed in:** the start screen shows the account notice and starts an account session; the bar says "Saved to your account"; an unfinished setup resumes on any device; a saved setup appears in Your setups, numbered 1, 2, 3. "Delete my answers" is hidden for a saved account setup, which is deleted from Your setups behind a confirmation instead.
- **What is kept and for how long** (consent, retention, access and deletion for each kind of session): [`services/cloud-api`](../../services/cloud-api/README.md#supabase-store).

### Trying sign-in locally

Use the throwaway address `walker-tester@example.test` (also noted in `.env.example`). The local stack sends no real email: open Mailpit at <http://127.0.0.1:55424> to read the code and the link. Any localhost port is allowed as a link target locally (`supabase/config.toml`), so it works when `pnpm dev` moves off 3000. Never sign in to the local stack with a real address; there is no reason to.

## Deploy on Vercel

**Not deployed yet.** These are the steps for whoever owns the accounts; nothing here creates them. The repository is a pnpm workspace, so the Vercel project's **Root Directory is `apps/web`**, and Vercel installs the whole workspace from the repository root, where `pnpm-lock.yaml` is. No `vercel.json` is needed: the defaults (Next.js preset, `pnpm install`, `pnpm run build`, which is `next build`) are right. A clean clone builds this way: `pnpm install --frozen-lockfile` and `pnpm build`, both run inside `apps/web`.

### 1. The hosted Supabase project (once)

1. Create a project in the [Supabase dashboard](https://supabase.com/dashboard). Its **project ref** is the id in the dashboard URL.
2. From the repository root, sign the CLI in and apply the migrations. This creates the tables, policies, functions and the `pg_cron` expiry job.

   ```bash
   pnpm supabase login
   ```

   ```bash
   pnpm supabase link --project-ref <project-ref>
   ```

   ```bash
   pnpm supabase db push
   ```

3. **Authentication → URL Configuration.** Site URL: your production address, for example `https://<project>.vercel.app` or your own domain. Redirect URLs, where the sign-in link may land:
   - `https://<production-domain>/auth/confirm`
   - `https://*-<vercel-team-slug>.vercel.app/auth/confirm`, for preview deployments (the slug is in your Vercel team URL)
   - `http://localhost:3000/auth/confirm`, only if you run the app locally against the hosted project
4. **Authentication → Email Templates.** For **Magic Link** and for **Confirm signup**, set the subject to `Your Assistive Walker sign-in code` and paste [`supabase/templates/sign-in.html`](../../supabase/templates/sign-in.html) as the body. Without it, emails carry only Supabase's default link, which works only in the browser that asked, and no code.
5. **Authentication → SMTP Settings.** Set up your own email provider before anyone outside the team signs in. Supabase's built-in email is for trying things out: it sends only a few emails an hour, and only to members of your Supabase organization.
6. **Project Settings → API Keys.** You need the **publishable** key and a **secret** key for the next step.

### 2. The Vercel project (once)

The CLI runs through npx at a pinned version, so nothing needs installing. Sign in:

```bash
npx vercel@62.2.0 login
```

Then, from the repository root (not `apps/web`), link the repository to a new project:

```bash
npx vercel@62.2.0 link
```

When it asks for the code's directory, answer `./apps/web`. Or, after linking, set **Settings → Build and Deployment → Root Directory** to `apps/web` in the dashboard. In the same place:

- Framework preset: Next.js (detected). Leave Build, Install and Output at their defaults.
- **Include source files outside of the Root Directory in the Build Step**: on (the default). The app compiles `packages/contracts` and `services/cloud-api` from source.
- Node.js version: 22.x, the same as CI.

Connecting the GitHub repository (Settings → Git) makes every pull request a preview deployment and `main` the production one.

### 3. Environment variables

Set them in **Settings → Environment Variables**, or one at a time with `npx vercel@62.2.0 env add <NAME> <environment>`. Names only here; values come from the Supabase dashboard (step 1.6) and your Anthropic account.

| Name | Production | Preview | Notes |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Hosted project URL | Same project, or a separate one (below) | Public. Built into the page, so redeploy after changing it |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable key | As above | Public; row-level security is what protects data |
| `SUPABASE_SECRET_KEY` | Secret key | As above | Mark it **Sensitive**. Server only: never give it a `NEXT_PUBLIC_` name |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` | `1` | Makes Vercel use pnpm 11.20.0 from `packageManager` directly. Without it Vercel starts pnpm 9 or 10 from the lockfile version; pnpm 10 then switches itself to 11.20.0 (checked locally with 10.18.3), pnpm 9 may not |
| `ONBOARDING_ENGINE`, `ANTHROPIC_API_KEY`, `ONBOARDING_AGENT_MODEL` | Optional | Optional | The onboarding agent (see above). Mark the API key **Sensitive** |
| `ONBOARDING_ALLOW_MEMORY_STORE` | Leave unset | Leave unset | Without Supabase, onboarding refuses to start on Vercel, on purpose |
| `STRIPE_SECRET_KEY` | Optional, `sk_test_…` only | Optional, `sk_test_…` only | The mock purchase (below). Live and restricted keys are refused and leave the button off. Mark it **Sensitive** |

Leave the **Development** environment empty: local development uses the local stack in `apps/web/.env.local`. For the same reason, don't run `vercel env pull` into `apps/web/.env.local`; it would replace those local settings.

**Previews and real data.** Pointing Preview at the production Supabase project means preview deployments read and write the same accounts and setups. That is fine for a hackathon team. Once real users sign in, give Preview its own Supabase project (steps 1.1 to 1.6 again, with its own redirect URLs).

### 4. Deploy and check

```bash
npx vercel@62.2.0
```

That makes a preview deployment; `npx vercel@62.2.0 --prod` makes a production one. With Git connected, a push does the same. Then check:

- The build log says pnpm 11.20.0 and `next build` finished.
- `/onboarding` starts a demo, and a row appears in the Supabase dashboard's `onboarding_sessions` table (no `user_id`).
- `/login` sends an email with a code and a link, and both sign in. The link opens a **Sign in** page; press its button.
- A setup saved while signed in appears in **Your setups**, and **Delete setup** removes it from `device_configurations` and `onboarding_sessions`.

Before sharing a public link, add a rate limit for `POST /api/v1/onboarding/sessions` and `/login` (for example a Vercel Firewall rule); the app caps demo sessions and turns but doesn't limit by address.

## Mock purchase (Stripe test mode only)

The saved-setup view has a **Mock purchase this setup** button so the demo can show buying the walker. **Nothing can really be bought:** the walker is an experimental prototype, not a certified mobility aid, so checkout runs in Stripe test mode only and no real money can move.

- **Test mode is enforced on the server.** `STRIPE_SECRET_KEY` must be a test secret key (`sk_test_…`). A live key (`sk_live_`, `rk_live_`), a restricted key or anything else is refused: the server logs `[checkout] Refusing to start mock purchase: …` (never the key), and the button stays off with a short reason. Without a key the button is off too, and everything else works as before. A Checkout Session that comes back live is also refused.
- **Flow.** The button posts the configuration version to `POST /api/v1/onboarding/sessions/{id}/checkout`. The server reads the confirmed configuration from the session, with ownership checked as on every onboarding route (the demo session's cookie, or the signed-in account that saved it), builds one line item per selected module, creates a hosted Checkout Session and returns its `checkout.stripe.com` URL; the browser goes there. There is no card form on our site and no publishable key.
- **Prices are placeholders.** They live in one constant, `DEMO_PLACEHOLDER_PRICES_USD_CENTS` in `src/server/checkout/order.ts`, and are labelled "demo price, not a real quote" everywhere they appear, because the catalog's real cost is `not_measured`.
- **Return pages.** `/checkout/success?session_id=…` looks the session up in Stripe on the server and shows the modules from its line items only if it is a test-mode session this app made and Stripe marks it paid; an unknown, unpaid or foreign session shows no order. `/checkout/cancelled` reads nothing from the URL. Both say it was a demo and no money moved.
- **Data.** Checkout metadata holds only the app tag, the onboarding session id and the configuration version; no answers go to Stripe. Card only, with Stripe's Link wallet hidden (`wallet_options.link.display: "never"`), because Link offers to save details and asks for a phone number. Apple Pay or Google Pay can still appear as card wallets in browsers that support them. No customer record, no shipping address, no phone number. Stripe's page asks for an email, a cardholder name and a ZIP; made-up ones work in test mode.
- **No webhook.** Nothing is fulfilled, so the return page's server-side lookup is enough.

### Try it locally

1. In the [Stripe dashboard](https://dashboard.stripe.com/test/apikeys), in test mode (a sandbox), copy the **secret key** (`sk_test_…`).
2. Put it in `apps/web/.env.local` as `STRIPE_SECRET_KEY=sk_test_…` and restart `pnpm dev`. Never commit it or paste it into chat.
3. Finish onboarding and save, press **Mock purchase this setup**, and pay with Stripe's test card `4242 4242 4242 4242`, any future expiry and any CVC.

## Code map

```text
app/                     routes (pages and API route handlers)
src/server/onboarding.ts store and engine choice, who is calling, cookie handling, request parsing, error envelope
src/server/supabase.ts   Supabase client per request (cookies), the verified signed-in user
src/server/auth-actions.ts server actions: sign in, sign out, delete a setup, delete the account
proxy.ts                 refreshes the Supabase session before each page
src/server/checkout/     mock purchase: test-key guard, Stripe client, placeholder prices, line items, success lookup
src/lib/checkout.ts      mock purchase request/response shapes and the browser calls
src/lib/api.ts           browser client; validates every response against the contracts
src/lib/useOnboarding.ts one hook owns the flow: restore, every API call, the status line, focus key
src/components/          screens and parts (QuestionStep, FactsPanel, ReviewScreen, WalkerDiagram, CheckoutButton, …)
src/components/landing/  landing page parts and styles
public/images/found/     credited archival pictures and credits.json
test/                    unit tests for the mock purchase (stubbed Stripe client and onboarding service)
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
