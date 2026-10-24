# Web app

Owns the demo page (onboarding chat and module choice), and (later) device pairing and settings. Next.js 16 (App Router) and TypeScript. The onboarding API route handlers live here too, as thin adapters over [`services/cloud-api`](../../services/cloud-api/README.md); shapes come from [`packages/contracts`](../../packages/contracts/README.md).

**Status:** the site is **Sophi** ("A physical augmentation walker."), **one page for a quick demo**, laid out for a laptop screen first (1440 and 1280 wide) and still usable at 768 and 390. It is a **conversation** with the onboarding assistant (its words as text beside a small live mark, your replies as quiet pills, a few "for example" replies, one text box), beside a pen-drawn walker that draws in each suggested part, one at a time with its name, as the answers come in. When the assistant has enough, the walker rises to the middle as a sheet, **Your walker**, where each part can be opened (your own words first, then the reason) and switched, saved, and ordered through Stripe test mode; the order ends on the walker again, with one button to start over. A slow field of contour lines moves behind it all. It works end to end in **demo mode**, with sessions in server memory or, when configured, Supabase Postgres. With Supabase, **passwordless sign-in** (an emailed code or link) saves setups to an account, resumes an unfinished one on another device, and lists saved setups with delete. Checked against a local Supabase stack, not yet a hosted project. The LLM onboarding agent is built but off by default (see below). A **mock purchase** of the saved setup through Stripe runs in **test mode only** and is off until a test key is set. Speech input and device pairing are not built yet.

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

- **Onboarding agent:** `ONBOARDING_ENGINE=agent` and either `ANTHROPIC_API_KEY` (Claude) or `GEMINI_API_KEY` (Google's Gemini); `ONBOARDING_AGENT_PROVIDER` and `ONBOARDING_AGENT_MODEL` are optional. Server only. What the agent does and how it falls back is in [`services/cloud-api`](../../services/cloud-api/README.md#onboarding-agent).
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
| `/` | **The demo.** "Let's build your walker." and one line of notice; the conversation in a glass panel beside the walker drawing; then the **Your walker** sheet with the clickable drawing, the module list, Save, Order (Demo) and Start Over |
| `/onboarding`, `/onboarding/review` | Redirect to `/` (`next.config.ts`), so old links and sign-in's `?next=` still land on the demo |
| `/login` | Sign in or create an account with an email address: the email carries a code to type here and a link. Needs Supabase. Not linked from the demo |
| `/auth/confirm` | Where the email's link lands: a **Sign in** button that redeems it (opening the link alone signs nobody in), then Your setups |
| `/setups` | **Your setups**: a signed-in user's saved setups, newest first, with delete; carry on with an unfinished setup; sign out; delete the account. Not linked from the demo |
| `/api/v1/onboarding/sessions/…` | The onboarding API; see [interfaces](../../docs/interfaces.md#cloud-api-surface). `POST …/{id}/checkout` starts the mock purchase |
| `/api/v1/checkout/status` | Whether the mock purchase button is on, and why not |
| `/api/v1/walkers/…` | The walker API for the owner's page (`walker_owner` cookie): pairing codes, the owner's walkers and their status, Confirm or Decline, Forget, and typed questions to the assistant; see [interfaces](../../docs/interfaces.md#cloud-api-surface) |
| `/api/v1/devices/…` | The walker API for the Pi (`Authorization: Bearer` credential): pair, heartbeat, configuration, voice or text questions, the Confirm button |
| `/api/v1/health` | Render's health check: `200` once the walker store is ready, `503` while its database can't be reached |
| `/checkout/success` | Where Stripe returns after a test payment: the ordered walker drawn again, "Demo order: no money moved", the modules read from the Checkout Session on the server, and **Set up another walker** (deletes this tab's demo answers and opens a fresh first frame) |
| `/checkout/cancelled` | Where Stripe's back link returns: the same "demo, no money moved" notice |
| `/walker` | **Your walker**, the always-on assistant's page: pair a walker, watch it live, read and join its conversation, confirm or decline what it offers ([guide](../../docs/subsystems/web-and-onboarding.md#your-walker-page)). Uses the owner routes `/api/v1/walkers/...`; typed questions use the built assistant turn route (`POST /api/v1/walkers/{id}/turns`) |
| `/app` | **The two-phone app** (a PWA, "Sophi" on the Home Screen): her own phone in simple mode (My walker, Message Maya, People nearby) or a caretaker's (walker status, messages, nearby). Her phone alone can opt in to sharing the walker's latest GPS fix with approved caretakers. Joins with the code from the walker page's **Phones** card. People nearby is a labelled sample ([guide](../../docs/subsystems/web-and-onboarding.md#the-two-phone-app-app)) |
| `/app?preview=rose`, `/app?preview=maya` | **Development only**: the app on its in-memory fake, with "Preview" across the top. Never on stage |
| `/walker?fake=1` | **Development only**: the same page on a typed fake of its API, with a "Fake walker" banner and a controls panel that plays the walker's side (pair, press Talk, go offline, press Confirm, fail the next action). Its turns report progress like the server's (`activity`), so "Behind the scenes" can be checked without a server |
| `/dev/preview/{start,chat,walker,saved,order}` | **Development only** (404 in production): the demo page in each state, from a session the deterministic engine produced from the demo persona's lines ([script](../../docs/demo/script.md)), for design review and the taste-skill inspector; `order` is the success page's design with that session's modules at their placeholder prices (a real order is only ever read from Stripe) |

### The demo, step by step

1. **The first frame explains itself.** The header says **Sophi** and its one line; the first question ("Hi! What would you like a hand with?") is on screen before anything is sent; it comes from the engine (`openingQuestion()` in `services/cloud-api`), so it matches what a new session asks. Under the bare frame: "Your walker starts as just the frame. Tell us what's hard." The empty box shows an example sentence ("For example: small buttons are hard for me").
2. **The conversation.** Typing is the main way to answer (Enter sends). Up to three of the question's own options sit above the box as **for example** replies; a tap sends one as your message, also on choose-any questions, where more can be added in words. **Skip** is always there, and **Show My Walker** after two answers. Each reply from the assistant is one message: the engine's acknowledgement (`ack`) and the next question, read together, as text beside the assistant's green mark. While it thinks, the mark breathes and three dots pulse (Gemini at low thinking takes about 2 to 3.5 s a turn); then the reply rises in word by word (8px and a blur to sharp, 35 ms apart, all within about a second), and the background surges for a moment. Under the agent the questions are the model's words, and a quiet line under each reply says who answered it: "Read by Gemini", or "Fixed questions: the model's reply didn't come through" when that turn fell back (from the turn's `answered_by`). With the deterministic engine there is no such line.
3. **The walker draws in.** The frame draws itself on load, like a pen. After each answer, the parts that just lit up arrive **one at a time, about 0.36 s apart, each with its name**: a part that's suggested is drawn in green by the pen, one worth considering turns green-dashed, and one the person **said no to** (for example voice, after "I'd rather not talk to it") gets a struck dot and "You Said No". A key under the drawing says what solid, dashed and struck mean. A polite announcement says what lit up. Typed words that also answer a later topic ("at home", "a buzz in the handles") mean that topic isn't asked, so a natural first message can cover three questions.
4. **Your walker.** The assistant's last message is "Here's your walker." A moment later the walker rises to the middle as a sheet (100px, 420 ms) and the conversation recedes behind it. Each module is a labelled button on the drawing (a round marker on narrow screens) that opens a small glass panel: **your own words first** ("You said: “…”" at 20px, or "You picked: …" for a tapped answer), then the rule's reason, then what the part does, and an on/off switch. A part you said no to shows "You said no" and the words you said it in. **All modules** lists the same switches. Switches follow `checkSelection`: the frame stays on, the GPS module remains deferred in onboarding until its hardware is checked (the separate linked-phone sharing control starts off), turning on the arm lift also turns on the arms (and turning off the arms turns off the lift), and a "needs one of" rule (obstacle sensors need hand controls or voice) is shown next to the module and blocks Save until it is settled. The logic is `src/lib/walker.ts`, unit tested.
5. **Save, then Order (Demo).** Save confirms the selection (`POST …/confirm`); the sheet then shows **Saved** and **Order (Demo)**, which opens Stripe's test checkout (see [Mock purchase](#mock-purchase-stripe-test-mode-only)). **Start Over** in the top bar deletes the answers and starts the conversation again.
6. **The end, on the walker.** After a test payment, the success page draws the ordered walker again with its parts named, says "Demo order: no money moved", lists the demo order, and offers **Set up another walker**, which deletes this tab's demo answers and returns to a fresh first frame in one press.

## How demo mode works

- The **first send** creates a session in **Postgres** when Supabase is configured, otherwise in **server memory**. A one-line notice under the text box is on screen before that ("Your answers are kept temporarily for this setup.", then the model's clause when the agent runs, then "Please leave out names and medical details."; built by `noticeLine` in `src/lib/chat.ts`), and starting means `consent: { demo_data_notice: true }`. The session id goes in this tab's `sessionStorage`; the secret that proves you started it is an `httpOnly`, `SameSite=Strict` cookie scoped to `/api/v1/onboarding`. Postgres stores only the secret's hash. The id alone can't read anything, so it may appear in URLs.
- Answers are deleted an hour after the last change (within five minutes of expiring, by a database job), or immediately with **Start over**. The memory store also loses them when the server restarts.
- The in-memory store is for local demos. On a host with several instances (Vercel), two requests can land on different instances and lose the session, so production refuses to start onboarding without Supabase unless `ONBOARDING_ALLOW_MEMORY_STORE=true` (see [`services/cloud-api`](../../services/cloud-api/README.md#supabase-store)).
- With the onboarding agent on, each answer is also sent to the model provider's API (Anthropic or Google), and the notice under the text box names it before the session starts. A turn the model can't handle in time falls back to the fixed questions.

## Sign-in

Passwordless, with Supabase Auth and [`@supabase/ssr`](https://supabase.com/docs/guides/auth/server-side). Everything runs on the server (server actions in `src/server/auth-actions.ts`, the `/auth/confirm` route, server components), so the browser never holds the session in script: the Supabase cookies are `httpOnly`, `SameSite=Lax`, and `Secure` in production. `proxy.ts` (Next.js 16's name for middleware) refreshes an expiring access token before each page; it decides nothing about access. Pages, route handlers and actions each verify the user with `getClaims()`, and Postgres row-level security checks again.

- **First sign-in creates the account.** There is no password to set or forget.
- **One email, two ways in:** a 6-digit code to type on `/login` (works when the email is read on another device), and a link to `/auth/confirm` for the device where you want to be signed in. Both work once and expire in an hour. The link opens a page with a **Sign in** button, and only the button redeems it: email security scanners that open links can't use it up, and a link someone else sent can't quietly sign you into their account. The template is [`supabase/templates/sign-in.html`](../../supabase/templates/sign-in.html); the hosted project needs it pasted in (see "Deploy on Vercel").
- **Accessible:** a labelled email field with a hint, errors in `role="alert"` linked to their field, a polite status for "We sent a new email", and focus moved to the new heading when the step changes. Every step is a plain form, so it works with the keyboard and without JavaScript. The demo stays one click away and is labelled as a demo.
- **Not on the demo path.** The demo page has no sign-in link; `/login` and `/setups` work when visited directly.
- **What changes when signed in:** the notice under the demo's headline says answers go to your account, and the first send starts an account session; an unfinished setup resumes on any device; a saved setup appears in Your setups, numbered 1, 2, 3. **Start over** is hidden for a saved account setup, which is deleted from Your setups behind a confirmation instead. This path was not clicked through after the one-page redesign (it needs the local Supabase stack).
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
4. **Authentication → Email Templates.** For **Magic Link** and for **Confirm signup**, set the subject to `Your Sophi sign-in code` and paste [`supabase/templates/sign-in.html`](../../supabase/templates/sign-in.html) as the body. Without it, emails carry only Supabase's default link, which works only in the browser that asked, and no code.
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

Set them in **Settings → Environment Variables**, or one at a time with `npx vercel@62.2.0 env add <NAME> <environment>`. Names only here; values come from the Supabase dashboard (step 1.6) and your Anthropic or Google AI Studio account.

| Name | Production | Preview | Notes |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Hosted project URL | Same project, or a separate one (below) | Public. Built into the page, so redeploy after changing it |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Publishable key | As above | Public; row-level security is what protects data |
| `SUPABASE_SECRET_KEY` | Secret key | As above | Mark it **Sensitive**. Server only: never give it a `NEXT_PUBLIC_` name |
| `ENABLE_EXPERIMENTAL_COREPACK` | `1` | `1` | Makes Vercel use pnpm 11.20.0 from `packageManager` directly. Without it Vercel starts pnpm 9 or 10 from the lockfile version; pnpm 10 then switches itself to 11.20.0 (checked locally with 10.18.3), pnpm 9 may not |
| `ONBOARDING_ENGINE`, `ANTHROPIC_API_KEY` or `GEMINI_API_KEY`, `ONBOARDING_AGENT_PROVIDER`, `ONBOARDING_AGENT_MODEL` | Optional | Optional | The onboarding agent (see above). Mark the API key **Sensitive** |
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

## Deploy on Render

The walker server runs on Render: one web service running this app (it serves the walker API and the onboarding page from one HTTPS address) and one Postgres database, both described in [`render.yaml`](../../render.yaml) at the repository root (a Render "Blueprint"). Vercel keeps serving the public onboarding site, unchanged; there the walker routes answer `503`, because it has no database.

Both are on Render's free plan. The web service spins down after 15 minutes without requests and takes about a minute to wake; a walker's heartbeat every 5 seconds keeps it awake while the walker is on. The free database expires 30 days after it's created, with 14 days' grace to upgrade.

### Max's clicks (once)

1. Open [dashboard.render.com](https://dashboard.render.com) and sign in with GitHub.
2. Click **New** (top right), then **Blueprint**.
3. Under the repository list, pick **mzhao1599/sophi**. If it isn't listed, click **Configure account** (or **Connect GitHub**), give Render access to that repository, and come back.
4. Name the Blueprint `steady`, keep the branch **main**, and leave the Blueprint path as `render.yaml`. Render then lists what it will create: a web service **steady-walker** and a database **steady-walker-db**, both Free.
5. Render asks for two values it won't take from the file:
   - **GEMINI_API_KEY**: paste your Gemini key (from Google AI Studio).
   - **CARTESIA_API_KEY**: paste your Cartesia key if you have one. If you don't yet, leave it empty. If Render won't continue with it empty, type `none`: the server treats that as no key, and the walker speaks replies with its own voice. Put the real key in later under **steady-walker → Environment**.
   These two go only into Render. Never paste them into chat, a file in the repository, or a commit.
6. Click **Deploy Blueprint**. The database takes a minute or two, then the web service builds (pnpm install and `next build`, several minutes on the free plan).
7. When **steady-walker** shows **Live**, copy its address from the top of its page (something like `https://steady-walker.onrender.com`; Render adds a suffix if the name is taken) and open `/api/v1/health` on it. It should say `{"status":"ok","walker_store":"postgres"}`.
8. Send that address to the lead, who checks pairing, a heartbeat and the walker routes over HTTPS.

If this Mac's network filter blocks the `onrender.com` address (it blocked the new `vercel.app` one), open it on a phone instead.

**Moved repository.** The code's home is now **mzhao1599/sophi**. The Render services were first created from an earlier private repository, which is frozen and gets no new commits. So in Render, connect **steady-walker** (and the Blueprint, if Render shows it separately) to **mzhao1599/sophi**, branch **main**. Then check two things: the latest deploy names a commit that exists in sophi, and `/api/v1/health` still says `{"status":"ok","walker_store":"postgres"}`. The database is not tied to a repository, so it stays as it is.

### After that

- Every push to `main` deploys again on its own. The new version takes traffic only after `/api/v1/health` answers `200` on it, so a deploy whose database isn't ready keeps the old one running.
- Render reads `sync: false` values only when the Blueprint is first created. To change a key later, edit it under **steady-walker → Environment**, then **Save, rebuild, and deploy**.
- The service's logs (**steady-walker → Logs**) carry one line per walker request: the route, the walker id, the status and the milliseconds. Never words, credentials or cookies.

## Mock purchase (Stripe test mode only)

After **Save**, the walker sheet offers **Order (Demo)** so the demo can show buying the walker. **Nothing can really be bought:** the walker is an experimental prototype, not a certified mobility aid, so checkout runs in Stripe test mode only and no real money can move.

- **Test mode is enforced on the server.** `STRIPE_SECRET_KEY` must be a test secret key (`sk_test_…`). A live key (`sk_live_`, `rk_live_`), a restricted key or anything else is refused: the server logs `[checkout] Refusing to start mock purchase: …` (never the key), and the button stays off with a short reason. Without a key the button is off too, and everything else works as before. A Checkout Session that comes back live is also refused.
- **Flow.** The button posts the configuration version to `POST /api/v1/onboarding/sessions/{id}/checkout`. The server reads the confirmed configuration from the session, with ownership checked as on every onboarding route (the demo session's cookie, or the signed-in account that saved it), builds one line item per selected module (its name, a sample-price label, and the catalog's one-sentence summary of what it does, never the person's own words), creates a hosted Checkout Session and returns its `checkout.stripe.com` URL; the browser goes there. There is no card form on our site and no publishable key.
- **Prices are placeholders.** They live in one constant, `DEMO_PLACEHOLDER_PRICES_USD_CENTS` in `src/lib/checkout.ts`, because the catalog's real cost is `not_measured`. Checkout line items are labelled "sample price". The walker sheet shows a running total beside the module count ("5 modules · $1,675 sample total"), computed from the same table Checkout charges, and each switch's announcement reads the new total out.
- **Return pages.** `/checkout/success?session_id=…` looks the session up in Stripe on the server and shows the modules from its line items only if it is a test-mode session this app made and Stripe marks it paid; an unknown, unpaid or foreign session shows no order. `/checkout/cancelled` reads nothing from the URL. Both say it was a demo and no money moved.
- **Data.** Checkout metadata holds only the app tag, the onboarding session id and the configuration version; no answers go to Stripe. Card only, with Stripe's Link wallet hidden (`wallet_options.link.display: "never"`), because Link offers to save details and asks for a phone number. Apple Pay or Google Pay can still appear as card wallets in browsers that support them. No customer record, no shipping address, no phone number. Stripe's page asks for an email, a cardholder name and a ZIP; made-up ones work in test mode.
- **No webhook.** Nothing is fulfilled, so the return page's server-side lookup is enough.

### Try it locally

1. In the [Stripe dashboard](https://dashboard.stripe.com/test/apikeys), in test mode (a sandbox), copy the **secret key** (`sk_test_…`).
2. Put it in `apps/web/.env.local` as `STRIPE_SECRET_KEY=sk_test_…` and restart `pnpm dev`. Never commit it or paste it into chat.
3. Answer a question or two, press **Show My Walker**, **Save**, then **Order (Demo)**, and pay with Stripe's test card `4242 4242 4242 4242`, any future expiry and any CVC.

## Code map

```text
app/                     routes (pages and API route handlers)
src/server/onboarding.ts store and engine choice, who is calling, cookie handling, request parsing, error envelope
src/server/supabase.ts   Supabase client per request (cookies), the verified signed-in user
src/server/walker.ts     walker routes: the owner cookie and the Pi's Bearer, the lockout's client address, body limits, error envelope, logs
instrumentation.ts       at server start: the walker store's migrations and history sweep
src/server/auth-actions.ts server actions: sign in, sign out, delete a setup, delete the account
proxy.ts                 refreshes the Supabase session before each page
src/server/checkout/     mock purchase: test-key guard, Stripe client, placeholder prices, line items, success lookup
src/lib/checkout.ts      mock purchase request/response shapes and the browser calls
src/lib/api.ts           browser client; validates every response against the contracts
src/lib/useOnboarding.ts one hook owns the flow: restore, every API call, the status line, focus key; forgetStoredSession()
src/lib/brand.ts         the product's name (Sophi) and its one line
src/lib/chat.ts          the conversation from the session's turns (one message per reply), quick replies, reveal timing
src/lib/walker.ts        selection: defaults, part states (including "you said no"), switches and their dependency rules, panel text
src/lib/motion.ts        surge() for the background, reduced-motion hook, the surge speed curve
src/lib/phoneApi.ts      the circle's client in one file: the phones' routes and the owner's Phones routes
src/lib/phoneFake.ts     in-memory stand-in for those routes (tests, /app?preview=, /walker?fake=1)
src/lib/phoneView.ts     the phone app's words and small rules; usePhone.ts polls and joins
src/lib/nearbySample.ts  the labelled sample of people nearby (made up, no location)
src/components/PhoneApp.tsx, RosePhone.tsx, MayaPhone.tsx, NearbySample.tsx  the /app screens
src/components/PhonesPanel.tsx  "Phones" on /walker: add a phone, approve a caretaker, remove
src/components/          DemoScreen (the page and the sheet), Chat, WalkerDiagram (line drawing, hotspots, panel, legend),
                         ModuleList, ModuleSwitch, ContourField (WebGL), CheckoutButton; SavedWalker and
                         SetUpAnother for the success page;
                         TopBar, LoginForm, SetupsList for the account pages
test/                    unit tests for selection, the conversation, the surge curve and the mock purchase
```

## Accessibility

Target: WCAG 2.2 AA. What is built in:

- **Every step works by typing alone, by tapping alone and by keyboard alone.** Quick replies, Skip and Show My Walker are real buttons in a labelled group; the reply box is always there; nothing needs voice or a fine-motor gesture.
- **The conversation is `role="log"`**, so each new message is read once, politely. A reply's words animate in, but the whole text is in the page at once, so it is read as one message, not word by word. The bubble shown while your reply is sending keeps its place when the server's copy replaces it, so it isn't read twice. Changes on the walker ("Lit up on your walker: Hand controls and Obstacle sensors.", "Added Robot arms. 4 modules on your walker.") go to a separate polite status line.
- **Focus moves only after your own action.** After a reply, focus stays in the box if it was there; after a quick reply is tapped (and replaced), the box takes it, without scrolling. When the walker sheet rises, focus moves to its heading, "Your walker"; after Save, to "Saved"; after Start Over, to the box. While the sheet is up, the conversation behind it is `inert`, so the keyboard and screen readers can't wander behind it. Nothing moves focus on page load. Busy buttons use `aria-disabled`, so they keep focus.
- **The drawing is never the only way in.** Each module on the drawing is a real `<button>` named with its state (`aria-label`, `aria-expanded`, for example "Voice, You Said No"); Enter or Space opens its panel, Escape closes it from anywhere (also when the panel was opened by clicking the drawn part) and puts focus on the part's button, a press outside closes it. The panel's switch is a `<button role="switch">` named after the module. **All modules** has the same switches. The drawing itself is hidden from screen readers, with a caption in words.
- **Errors are linked:** a chat error is `role="alert"` and in the reply box's `aria-describedby` (with the notice); Save's problem list is an alert linked to Save; a module's dependency problem is linked to its switches; a locked switch stays focusable and says why.
- Targets are at least 44px (quick replies, send, hotspots, switches, the close button); state is never colour alone (drawn solid or dashed, a filled or hollow dot, "On"/"Off" in words). The reply box's edge reaches 3:1; meta text 4.5:1 or more.
- **Motion has a reduced version everywhere:** with `prefers-reduced-motion`, replies appear whole, the frame and the parts are drawn already (no pen, no stagger), the sheet appears without rising, the conversation doesn't scale back, and the contour field is one still frame. The field also stops while the tab is hidden.
- Large text and zoom reflow to one column below 1000px. At 200% zoom on a 1440 by 900 screen (720 CSS pixels wide), the conversation's log gives way first, so the reply box is never cut off; the page scrolls instead.
- Type is Atkinson Hyperlegible Next (and Mono for the drawing's labels), made by the Braille Institute for readers with low vision.

Checked on 2026-10-23 in the built-in browser on port 3002 (Supabase blanked) with the **Gemini agent on**: the demo persona's five lines typed at 1440 (every turn answered by the model, 2.2 to 3.5 s), Show My Walker, the sheet (hand controls and obstacle sensors on, robot arms and arm lift worth considering, voice "You Said No"), two panels opened by the label and by the drawn part and closed with Escape, Save, Order (Demo) to Stripe's test checkout; then **Set up another walker** from the success page's design preview (deleted the session, fresh first frame); and once by keyboard alone (typed replies, Show My Walker, focus to "Your walker", parts by Tab, Enter to open, Escape to close, Save, Order). Screenshots at 200% zoom and with reduced motion were checked from the dev previews. Not yet done:

- [ ] VoiceOver (macOS/iOS) or NVDA: each message and switch change is read once.
- [ ] A real test payment through to the new success page (its design was checked on `/dev/preview/order`).
- [ ] Windows High Contrast or forced colours.
- [ ] Someone who hasn't seen it sets up a walker without help.

## Design

**Fourth design, October 2026: Sophi.** It began from principles read in Caspian's interface (another project's app, reference only: no files, shaders, photos, logo, wordmark or model were copied) and now has its own look:

- **Name:** Sophi, with one line under it: "A physical augmentation walker." Both live in `src/lib/brand.ts`, and the page title, Stripe's checkout note and the success page use them.
- **Mark:** an "S" drawn as one pen line ending in a signal-green nib, on an ink tile (`WalkerMark`, and `app/icon.svg` as the favicon); it holds at 16, 32 and 64 px ([`steady-mark-16-32-64.png`](../../docs/design/screenshots/steady-mark-16-32-64.png)). Next's development badge is off (`devIndicators: false`) so it never shows on stage.
- **Palette:** a cool stone paper with a breath of green (`#f1f4f2`) and a deep green-black ink (`#14201c`), like a survey map printed on light card; dark mode is a green-black ground (`#101513`). No brand colour in the chrome: the primary action is ink on paper. **One signal green** (`--live`, `#1f7a50` light, `#5ccb93` dark) marks what is live and lit: the assistant's mark, a part on the walker, a switch that's on. Contrast on the paper, light and dark: body text 9.0 and 11.2:1, meta text 5.7 and 7.3:1, the green 4.8 and 9.2:1, control edges 3.4 and 4.6:1.
- **Type:** Atkinson Hyperlegible Next for everything people read, and Atkinson Hyperlegible Mono for the drawing's annotations (next/font/google).
- **Messages:** not chat bubbles. The assistant's words sit as plain 18px text beside a small green mark (live beside the newest message, breathing while a reply is on its way, a quiet dot on older ones); the person's replies are quiet hairline pills.
- **Surfaces:** glass (translucent card, `backdrop-filter: blur`, hairline edges), large radii (32px sheets, 18px cards, 24px inputs, pills), soft shadows light enough to rest on the paper.
- **Motion:** one out-quint curve (`cubic-bezier(0.22, 1, 0.36, 1)`) almost everywhere; entrances rise 8px from a 3px blur; press shrinks to 0.98; button labels cross-fade when their words change; the sheet rises 100px over 420 ms while the conversation recedes to 0.97 and dims. CSS keyframes and transitions only, no animation library.
- **Contour field** (`ContourField`, written for this project): a slow field of fine contour lines, "like the map of a familiar walk", every fifth line a little stronger, fading toward the conversation so text sits on calm paper. WebGL at CSS-pixel resolution, about 30 fps; it stops while the tab is hidden, is one still frame under reduced motion, and surges (moves faster on a sin² bell for 1.5 s) when the assistant replies or the sheet rises.
- **The signature: the pen-drawn walker.** A fine ink line drawing with no fills. Each part is a path with `pathLength=1`, and a small nib travels each stroke: the frame draws itself on load, then each part the conversation lights up arrives in turn with its name, drawn in green.
- **Copy:** about ten words per screen, no em dashes or trailing ellipses.

**Inspector**, last run 2026-10-23 on `/dev/preview/{start,chat,walker,saved,order}` with `--app`: 0 FAIL at 1440, 768 and 390. One finding on this pass was fixed rather than allowed: the sheet's shadow read as floating at 12%, so it is 10%. Warnings kept, with reasons: `app-title-size` (the 40px headline and the 44px "Demo order complete" are read from a projector), `panel-void` on start at 1440 (the conversation panel keeps its height so the reply box doesn't move; it fills as you talk), and `heavy-borders` (the inspector measures the hairline borders as if they were opaque ink; they are ink at 7 to 13% opacity, about 1.3:1 against the card). Screenshots: `docs/design/screenshots/steady-*.jpg` (first frame, conversation, walker, a part's panel, a part she said no to, the success page; plus 200% zoom and reduced motion).

### Pictures

The walker has no photographs yet, so it is **drawn** (`WalkerDiagram`). Replace or supplement the drawing with real photographs once the hardware exists. The archival prints the landing page used were removed with it.

### Copy to confirm with the team

The headline ("Let's build your walker."), the notice line, "Show My Walker", "Order (Demo)", the first frame's line, and the name and its line (`PRODUCT_NAME` and `PRODUCT_LINE` in `src/lib/brand.ts`, a one-line change each).
