# Web app

Owns the demo page (onboarding chat and module choice), and (later) device pairing and settings. Next.js 16 (App Router) and TypeScript. The onboarding API route handlers live here too, as thin adapters over [`services/cloud-api`](../../services/cloud-api/README.md); shapes come from [`packages/contracts`](../../packages/contracts/README.md).

**Status:** the site is **one page for a quick demo**, laid out for a laptop screen first (1440 and 1280 wide) and still usable at 768 and 390. A guided text chat with the onboarding assistant sits beside a drawing of the walker that lights up suggested modules as the answers come in; then the drawing becomes the clickable **Your walker**, where each module can be opened and switched, saved, and ordered through Stripe test mode. It works end to end in **demo mode**, with sessions in server memory or, when configured, Supabase Postgres. With Supabase, **passwordless sign-in** (an emailed code or link) saves setups to an account, resumes an unfinished one on another device, and lists saved setups with delete. Checked against a local Supabase stack, not yet a hosted project. The LLM onboarding agent is built but off by default (see below). A **mock purchase** of the saved setup through Stripe runs in **test mode only** and is off until a test key is set. Speech input and device pairing are not built yet.

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

With the Supabase variables in `.env.local` but the stack stopped, sessions can't be saved. To demo with server memory instead, without editing the file, blank the three variables for one run; values already in the environment win over `.env.local`. The `web-memory` entry in [`.claude/launch.json`](../../.claude/launch.json) does the same for Claude Code's preview.

```bash
NEXT_PUBLIC_SUPABASE_URL= NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY= SUPABASE_SECRET_KEY= pnpm dev
```

## Routes

| Route | Purpose |
| --- | --- |
| `/` | **The demo.** A one-line headline; the chat (about 40% wide) beside the walker drawing (about 60%); at review, "Here's what I heard" and the module list beside the clickable walker, with Save, Order (demo) and Start over |
| `/onboarding`, `/onboarding/review` | Redirect to `/` (`next.config.ts`), so old links and sign-in's `?next=` still land on the demo |
| `/login` | Sign in or create an account with an email address: the email carries a code to type here and a link. Needs Supabase. Not linked from the demo |
| `/auth/confirm` | Where the email's link lands: a **Sign in** button that redeems it (opening the link alone signs nobody in), then Your setups |
| `/setups` | **Your setups**: a signed-in user's saved setups, newest first, with delete; carry on with an unfinished setup; sign out; delete the account. Not linked from the demo |
| `/api/v1/onboarding/sessions/…` | The onboarding API; see [interfaces](../../docs/interfaces.md#cloud-api-surface). `POST …/{id}/checkout` starts the mock purchase |
| `/api/v1/checkout/status` | Whether the mock purchase button is on, and why not |
| `/checkout/success` | Where Stripe returns after a test payment: says it was a demo and no money moved, and lists the modules read from the Checkout Session on the server |
| `/checkout/cancelled` | Where Stripe's back link returns: the same "demo, no money moved" notice |
| `/dev/preview/{start,chat,walker,saved}` | **Development only** (404 in production): the demo page in each state, from a session the real engine produced, for design review and the taste-skill inspector |

### The demo, step by step

1. **Chat.** The first question ("What would you like help with?") is on screen before anything is sent; it comes from the engine (`openingQuestion()` in `services/cloud-api`), so it matches what a new session asks. The options are buttons: on a choose-any question they toggle (`aria-pressed`) and **Send** sends them with anything typed; on a choose-one question a press sends it. The text box is always there (Enter sends, Shift+Enter starts a new line). The log is the session's own turns: questions and the person's replies as bubbles, the short acknowledgements (`ack`) as a line between them. **Skip this question** and, after one answer, **Skip to my walker** sit under the box. Under the agent, the questions and options are the model's choice from the bank; the page doesn't change.
2. **The walker lights up.** After each answer, modules that are now suggested turn solid on the drawing (required plus recommended, the same default as the engine's `defaultSelection`); "worth considering" ones are dashed in blue; the rest are dashed grey; location sharing is marked "Not available yet". A polite announcement says what lit up.
3. **Your walker.** When the questions are done (or skipped), the chat folds into **Here's what I heard**, each answer with **Change** (which reopens that question in the chat), and the drawing becomes the main stage. Each module is a labelled button on the drawing (a round marker on narrow screens) that opens a small panel: what it does, why it was suggested (the recommendation's reason and the answer it came from), and an on/off switch. **All modules** lists the same switches. Switches follow `checkSelection`: the frame stays on, location sharing can't be turned on, turning on the arm lift also turns on the arms (and turning off the arms turns off the lift), and a "needs one of" rule (obstacle sensors need hand controls or voice) is shown next to the module and blocks Save until it is settled. The logic is `src/lib/walker.ts`, unit tested.
4. **Save, then Order (demo).** Save confirms the selection (`POST …/confirm`); the header then shows **Saved.** and **Order (demo)**, which opens Stripe's test checkout (see [Mock purchase](#mock-purchase-stripe-test-mode-only)). **Start over** in the top bar deletes the answers and starts again.

## How demo mode works

- The **first send** creates a session in **Postgres** when Supabase is configured, otherwise in **server memory**. The one-line notice under the text box (answers are deleted after an hour; leave out names and medical details) is on screen before that, and starting means `consent: { demo_data_notice: true }`. The session id goes in this tab's `sessionStorage`; the secret that proves you started it is an `httpOnly`, `SameSite=Strict` cookie scoped to `/api/v1/onboarding`. Postgres stores only the secret's hash. The id alone can't read anything, so it may appear in URLs.
- Answers are deleted an hour after the last change (within five minutes of expiring, by a database job), or immediately with **Start over**. The memory store also loses them when the server restarts.
- The in-memory store is for local demos. On a host with several instances (Vercel), two requests can land on different instances and lose the session, so production refuses to start onboarding without Supabase unless `ONBOARDING_ALLOW_MEMORY_STORE=true` (see [`services/cloud-api`](../../services/cloud-api/README.md#supabase-store)).
- With the onboarding agent on, each answer is also sent to Anthropic's API, and the notice under the text box says so before the session starts. A turn the model can't handle in time falls back to the fixed questions.

## Sign-in

Passwordless, with Supabase Auth and [`@supabase/ssr`](https://supabase.com/docs/guides/auth/server-side). Everything runs on the server (server actions in `src/server/auth-actions.ts`, the `/auth/confirm` route, server components), so the browser never holds the session in script: the Supabase cookies are `httpOnly`, `SameSite=Lax`, and `Secure` in production. `proxy.ts` (Next.js 16's name for middleware) refreshes an expiring access token before each page; it decides nothing about access. Pages, route handlers and actions each verify the user with `getClaims()`, and Postgres row-level security checks again.

- **First sign-in creates the account.** There is no password to set or forget.
- **One email, two ways in:** a 6-digit code to type on `/login` (works when the email is read on another device), and a link to `/auth/confirm` for the device where you want to be signed in. Both work once and expire in an hour. The link opens a page with a **Sign in** button, and only the button redeems it: email security scanners that open links can't use it up, and a link someone else sent can't quietly sign you into their account. The template is [`supabase/templates/sign-in.html`](../../supabase/templates/sign-in.html); the hosted project needs it pasted in (see "Deploy on Vercel").
- **Accessible:** a labelled email field with a hint, errors in `role="alert"` linked to their field, a polite status for "We sent a new email", and focus moved to the new heading when the step changes. Every step is a plain form, so it works with the keyboard and without JavaScript. The demo stays one click away and is labelled as a demo.
- **Not on the demo path.** The demo page has no sign-in link; `/login` and `/setups` work when visited directly.
- **What changes when signed in:** the note under the demo's text box says answers go to your account, and the first send starts an account session; an unfinished setup resumes on any device; a saved setup appears in Your setups, numbered 1, 2, 3. **Start over** is hidden for a saved account setup, which is deleted from Your setups behind a confirmation instead. This path was not clicked through after the one-page redesign (it needs the local Supabase stack).
- **What is kept and for how long** (consent, retention, access and deletion for each kind of session): [`services/cloud-api`](../../services/cloud-api/README.md#supabase-store).

### Trying sign-in locally

Use the throwaway address `walker-tester@example.test` (also noted in `.env.example`). The local stack sends no real email: open Mailpit at <http://127.0.0.1:55424> to read the code and the link. Any localhost port is allowed as a link target locally (`supabase/config.toml`), so it works when `pnpm dev` moves off 3000. Never sign in to the local stack with a real address; there is no reason to.

## Deploy on Vercel

**Deployed as a demo without Supabase** (2026-10-23): <https://assistive-walker.vercel.app>, from the Vercel project `assistive-walker`, connected to this GitHub repository: a push to `main` deploys production, and each pull request gets a preview deployment. Production and Preview each have only `ENABLE_EXPERIMENTAL_COREPACK=1`, `ONBOARDING_ALLOW_MEMORY_STORE=true` and a Stripe test key, so onboarding, review and the mock purchase work, while sign-in and saved setups are off. Sessions live in one server instance's memory: one can be lost if a request reaches another instance, and all are lost on redeploy. Moving to Supabase means steps 1 and 3 below, removing `ONBOARDING_ALLOW_MEMORY_STORE`, and redeploying.

These are the steps for whoever owns the accounts; nothing here creates them. The repository is a pnpm workspace, so the Vercel project's **Root Directory is `apps/web`**, and Vercel installs the whole workspace from the repository root, where `pnpm-lock.yaml` is. No `vercel.json` is needed: the defaults (Next.js preset, `pnpm install`, `pnpm run build`, which is `next build`) are right. A clean clone builds this way: `pnpm install --frozen-lockfile` and `pnpm build`, both run inside `apps/web`.

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

After **Save**, the walker's header offers **Order (demo)** so the demo can show buying the walker. **Nothing can really be bought:** the walker is an experimental prototype, not a certified mobility aid, so checkout runs in Stripe test mode only and no real money can move.

- **Test mode is enforced on the server.** `STRIPE_SECRET_KEY` must be a test secret key (`sk_test_…`). A live key (`sk_live_`, `rk_live_`), a restricted key or anything else is refused: the server logs `[checkout] Refusing to start mock purchase: …` (never the key), and the button stays off with a short reason. Without a key the button is off too, and everything else works as before. A Checkout Session that comes back live is also refused.
- **Flow.** The button posts the configuration version to `POST /api/v1/onboarding/sessions/{id}/checkout`. The server reads the confirmed configuration from the session, with ownership checked as on every onboarding route (the demo session's cookie, or the signed-in account that saved it), builds one line item per selected module, creates a hosted Checkout Session and returns its `checkout.stripe.com` URL; the browser goes there. There is no card form on our site and no publishable key.
- **Prices are placeholders.** They live in one constant, `DEMO_PLACEHOLDER_PRICES_USD_CENTS` in `src/server/checkout/order.ts`, and are labelled "demo price, not a real quote" everywhere they appear, because the catalog's real cost is `not_measured`.
- **Return pages.** `/checkout/success?session_id=…` looks the session up in Stripe on the server and shows the modules from its line items only if it is a test-mode session this app made and Stripe marks it paid; an unknown, unpaid or foreign session shows no order. `/checkout/cancelled` reads nothing from the URL. Both say it was a demo and no money moved.
- **Data.** Checkout metadata holds only the app tag, the onboarding session id and the configuration version; no answers go to Stripe. Card only, with Stripe's Link wallet hidden (`wallet_options.link.display: "never"`), because Link offers to save details and asks for a phone number. Apple Pay or Google Pay can still appear as card wallets in browsers that support them. No customer record, no shipping address, no phone number. Stripe's page asks for an email, a cardholder name and a ZIP; made-up ones work in test mode.
- **No webhook.** Nothing is fulfilled, so the return page's server-side lookup is enough.

### Try it locally

1. In the [Stripe dashboard](https://dashboard.stripe.com/test/apikeys), in test mode (a sandbox), copy the **secret key** (`sk_test_…`).
2. Put it in `apps/web/.env.local` as `STRIPE_SECRET_KEY=sk_test_…` and restart `pnpm dev`. Never commit it or paste it into chat.
3. Answer a question or two, press **Skip to my walker**, **Save my walker**, then **Order (demo)**, and pay with Stripe's test card `4242 4242 4242 4242`, any future expiry and any CVC.

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
src/lib/chat.ts          the chat log from the session's turns, and the reply text the engine records
src/lib/walker.ts        selection: defaults, part states, switches and their dependency rules, panel text
src/components/          DemoScreen (the page), Chat, WalkerDiagram (drawing, hotspots, panel), ModuleList,
                         ModuleSwitch, CheckoutButton; TopBar, LoginForm, SetupsList for the account pages
test/                    unit tests for selection, the chat log and the mock purchase
```

## Accessibility

Target: WCAG 2.2 AA. What is built in:

- **Every step works by tapping alone, by typing alone and by keyboard alone.** Options are real buttons in a `fieldset` with a legend that says how to answer; the text box is always there; nothing needs voice or a fine-motor gesture.
- **The chat log is `role="log"`**, so new messages are read politely; the bubble shown while a reply is being sent keeps its place when the server's copy replaces it, so it isn't read twice. Changes on the walker ("Lit up on your walker: Hand controls and Obstacle sensors.", "Added Arm lift. Robot arms added too, because arm lift needs them. 5 modules on your walker.") go to a separate polite status line.
- **Focus is never taken without a reason.** After a reply, focus stays in the text box if it was there; if an option or Send was pressed, it goes to the next question's first option (or the box), without scrolling. When the walker view appears, focus moves to its heading, "Your walker"; after Save, to "Saved."; after **Change**, to the reopened question's first option; after **Start over**, to the text box. Nothing moves focus on page load. Buttons that are busy use `aria-disabled`, so they keep focus.
- **The drawing is never the only way in.** Each module on the drawing is a real `<button>` with its name and state as its accessible name and `aria-expanded`; Enter or Space opens its panel, Escape closes it and returns focus to the button, a press outside closes it. The panel's switch is a `<button role="switch">` named after the module. **All modules** beside the drawing has the same switches. Hovering or focusing a module highlights its part (a bonus, never needed). The drawing itself is hidden from screen readers; its caption says the same in words.
- **Errors are linked:** a chat error is `role="alert"` and in the text box's and options' `aria-describedby`; Save's "Before saving" list is an alert linked to the Save button; a module's dependency problem is linked to its switches; a locked switch (the frame, location sharing, a saved walker) stays focusable and says why.
- Targets are at least 44px (hotspots, options, switches, text buttons); body text 16–17px; control borders reach 3:1; focus rings are 3px. State is never colour alone: parts on the walker are solid, others dashed, and every label and switch says On or Off in words.
- Motion is transform, opacity and a short glow when a part lights up, with `prefers-reduced-motion` turning it off. Large text and zoom reflow into one column below 1000px.

Checked on 2026-10-23 in the built-in browser with the `web-memory` preview: the whole flow at 1440 by pointer and by keyboard alone (options, Send, Skip, Skip to my walker, hotspot panel, switch, Escape, the Save block and its fix from the list, Save, Order (demo) to Stripe's test checkout, Change, Start over), and at 390 by tapping (marker, panel, switch, Save, Order). Not yet done:

- [ ] VoiceOver (macOS/iOS) or NVDA: check each question, acknowledgement and switch change is read once.
- [ ] 200% browser zoom.
- [ ] Windows High Contrast or forced colours: parts, switches and selected options stay distinguishable.
- [ ] Ask someone who hasn't seen it to set up a walker without help, and note where they hesitate.

## Design

Built with [taste-skill](https://www.tasteskill.dev/) v2 (`design-taste-frontend`). The app style is `achromatic-ledger` (seed 1253139886) with the earlier landing page's palette and type kept: ink on white, no colour in the chrome, Archivo throughout (condensed 800 for titles), and one hue, ultramarine `#1423b8`, on what you chose (your replies as a pale tint, chosen options, switches that are on, parts on the walker). The primary action is near-black. Notes from the earlier redesigns: [`.taste-skill/redesign/`](../../.taste-skill/redesign).

- **Layout**: designed for 1440 x 900 and 1280 x 800 first. One-line headline; the chat at 40% and the walker at 60%; at review the columns ease to 30/70 (instantly under reduced motion). Below 1000px everything stacks; below 560px of drawing width the hotspot labels become 44px round markers on the parts.
- **Signature element**: the walker drawing on drafting-dot paper, with leader lines from each label to its part. It is a schematic, not to scale; solid means on the walker, dashed means left off.
- **Inspector**, last run 2026-10-23 on `/dev/preview/{start,chat,walker,saved}` with `--app`: 0 FAIL at 1440, 768 and 390. Warnings kept, with reasons: the 40px headline (the inspector expects an app title of 18–32px; this is the page's one message, read from a projector in a 30-second demo); on start and chat at 1440, a 57px band around the drawing in its box (the box runs as tall as the chat beside it so the two halves line up, and the drawing is centred on its paper).

### Pictures

The walker has no photographs yet, so it is **drawn** (`WalkerDiagram`). Replace or supplement the drawing with real photographs once the hardware exists. The archival prints the landing page used were removed with it.

### Copy to confirm with the team

The headline ("Tell us what you need help with. We'll build your walker."), the notice under the text box, and the button name "Order (demo)". Change any of them if the team prefers.
