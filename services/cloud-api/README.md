# Cloud API and agents

Owns onboarding sessions, the onboarding conversation and its recommendations, and (later) assistant runs, typed tools and the device API. For now it is a TypeScript package that the Next.js route handlers in `apps/web` call; it has no HTTP server of its own. Read [cloud agents](../../docs/subsystems/cloud-agents.md) and the [runtime blueprint](../../docs/agent-runtime.md).

**Status:** the onboarding service works with a **deterministic engine** and two stores: **in memory** (local demos, the default) and **Supabase Postgres** with row-level security, tested against a local Supabase stack but **not yet against a hosted project**. An **LLM onboarding agent** (Claude through the Anthropic TypeScript SDK, or Google's Gemini over its REST API) can read text and answer turns when it is turned on; it is off by default. It has been checked with stub models and a local mock of the API, and live on Gemini (`gemini-3.7-flash`, 2026-10-23); **not yet live on Claude**. The **walker API** (pairing, device credentials, heartbeats, the status view and answering proposals, for the always-on assistant) works with an in-memory store and **Postgres** through node-postgres, tested against a local Postgres 17 cluster; it is **deployed on Render** at <https://steady-walker.onrender.com> (free web service and Postgres 17, from [`render.yaml`](../../render.yaml)), checked end to end on 2026-10-24 (see [Walker store](#walker-store)). Its **assistant turn** (voice or text, on Gemini, with Cartesia speech) is built and checked live on Gemini with the demo's lines; Cartesia was checked live on the deployed server on 2026-10-24: a spoken question came back in Cartesia's voice, 4.1 s end to end (see [Walker assistant](#walker-assistant)).

## What's here

| File | Role |
| --- | --- |
| `src/onboarding/questions.ts` | The question bank: tasks, places, cues, how to start a request, what to reach (only asked when relevant), location, anything else. No question asks for a diagnosis. It is written as a chat: each `prompt` is one spoken question (the first one greets; `revisit_prompt` is its wording when the person comes back to it), and each option `label` is in the first person, because tapping it sends it as the person's own message. Internal copy that isn't part of the contract: each option's `ack` (how the reply says it back, in the second person) and each question's `ack_opener` and `typed_ack`. `detail` is still sent but the one-page demo doesn't show it, so anything a person must know is in the prompt or the acknowledgement (sharing the walker's location says it isn't built yet). |
| `src/onboarding/matcher.ts` | Reads typed answers into need tags with a small keyword matcher, including "I don't want…" declines. Ignores condition names on purpose. |
| `src/onboarding/recommend.ts` | Facts → a recommendation for every catalog module, each reason pointing at the fact it came from. Robot arms are only ever "worth considering". |
| `src/onboarding/engine.ts` | Pure session transitions. The current question is derived from the answers, so a restored session resumes where it left off; `pending` holds a follow-up question. The fixed engine asks once for a concrete task when the opening reply names no task or preference, rather than inferring hardware from a disability label. `TurnEngine` is the interface both engines implement. `openingQuestion()` is the question every session opens with, so the web page can show it before a session exists. `SKIP_REPLY` ("Skip") and `SKIP_REST_REPLY` ("Show me my walker") are the person's recorded words for a skip and for skipping the rest, so a page can show the same words while the turn is in flight. Covered topics: see below. |
| `src/onboarding/agent.ts` | The onboarding agent: the prompt, the reply schema, the checks on a reply, one retry, and the fallback to the deterministic engine. |
| `src/onboarding/anthropic.ts` | The Claude client: one Messages API call with structured output. The default model is `DEFAULT_AGENT_MODEL` here. |
| `src/onboarding/gemini.ts` | The Gemini client: one `generateContent` call over `fetch`, with the reply constrained to the same JSON schema. The default model is `DEFAULT_GEMINI_MODEL` here. |
| `src/onboarding/service.ts` | Ownership (demo token or signed-in user), expiry, revision checks, idempotent turns by `client_turn_id`, and errors with stable codes. |
| `src/onboarding/store.ts` | `SessionStore` interface, session owners, and the in-memory store. |
| `src/onboarding/supabase-store.ts` | `SupabaseSessionStore`: the same interface over Postgres ([`supabase/migrations/`](../../supabase/migrations)). |
| `src/onboarding/setups.ts` | Account reads through the user's own client: their saved setups (checked against the contract) and their latest unfinished session. |
| `src/onboarding/config.ts` | `engineFromEnv` and `storeBackendFromEnv`: pick the engine (and the agent's model provider) and the store from environment variables. `agentProviderFromEnv` names the provider for the first screen's notice. |
| `src/walker/service.ts` | The walker API's behaviour: pairing codes and the lockout, the owner's and the Pi's proofs, heartbeats, the status view, answering proposals, Forget, and `WalkerError` with the contract's codes. |
| `src/walker/rules.ts` | The proposal rules both stores call inside their atomic step: online, when an open proposal expires, and what a Confirm or Decline does. |
| `src/walker/status.ts` | `buildStatusView`: the status view from stored data, with the contract's `zoneViews`, parsed with `WalkerStatusViewSchema`. |
| `src/walker/store.ts` | `WalkerStore` interface, the in-memory store, secrets and hashing. |
| `src/walker/postgres-store.ts`, `src/walker/migrations.ts` | `PostgresWalkerStore` and its SQL migrations. |
| `src/walker/config.ts` | `walkerBackendFromEnv`: Postgres when `DATABASE_URL` is set, memory otherwise, off in production without a database. `walkerAgentFromEnv`: the turn's Gemini model and Cartesia voice. |
| `src/walker/assistant.ts` | The turn's model step: the policy prompt, the context, the reply schema, one retry and the 8-second deadline. |
| `src/walker/lines.ts` | The lines the server writes itself: proposal summaries, why a change was dropped, arms, simulated readings, Press Confirm, the fallback. |
| `src/walker/speech.ts` | Cartesia's text-to-speech, and the WAV check for clips and speech. |

```bash
pnpm --filter @walker/cloud-api test
```

That skips the database tests. To run them too, start Docker, then from the repository root:

```bash
pnpm supabase start
```

```bash
pnpm test:db
```

`pnpm test:db` reads the local stack's URL and keys from `supabase status` and passes them as `SUPABASE_TEST_URL`, `SUPABASE_TEST_PUBLISHABLE_KEY` and `SUPABASE_TEST_SECRET_KEY`. The tests refuse any URL that isn't `127.0.0.1` or `localhost`, because they create and delete users. CI has no Docker stack, so there they skip with a message.

The tests cover the matcher, a full conversation, skipped and revisited questions, edits that change recommendations, retries and stale revisions, expiry, and every combination of chosen tasks and cues producing a valid default selection. `test/conversation.test.ts` checks the chat copy (every prompt within the contract's 48 characters and ending in a question mark, every option label at most 34 characters, no em dashes, ellipses or "Noted", a different opener for each question) and covered topics in the deterministic engine.

`test/agent.test.ts` runs the agent against a stub model with the scenarios from the [cloud agents guide](../../docs/subsystems/cloud-agents.md#evaluation-and-observability): a request for every module, a refused module, an unclear answer, instructions hidden in the user's words, refusals, bad JSON, API errors and a timeout. It also checks that the server ignores a covered topic the words reach only through a tag the current topic shares, that the system prompt keeps its safety rules and the chat rules, that with every model call failing the agent matches the deterministic engine step for step, that two overlapping turns can't both land, and the exact request the SDK sends. A stub proves what the code does with a reply; it says nothing about how well a real model reads people.

`test/store.test.ts` runs one `SessionStore` contract against both stores: a session is returned only to its owner, a save only lands from the revision it read, exactly one of two overlapping saves lands, a turn's response is kept with its save, setups are numbered per account, and delete is owner-only. `test/rls.test.ts` checks the database through the real Data API, not through the store: user B can't read, change, delete or write onto user A's rows; an owner can't write or delete setups or turn results directly, and the save function accepts only the next setup number; the server's key can't save an account's row; signed-in users can't reach demo sessions even with the token hash; an anonymous client gets `permission denied` for select, insert, update and delete on every table and for both functions; expiry is bounded on every write; confirmed setups can't be edited; and the expiry job removes expired demo and unfinished sessions but keeps confirmed account setups and anything unexpired. `test/accounts.test.ts` covers account sessions, the caps and the store choice, and runs a whole conversation, the 30-day expiry and the overlapping-turn race over the Supabase store. Breaking a policy or dropping the revision check from the save function makes these tests fail (checked by hand). The `pg_cron` schedule itself was checked by hand (`select * from cron.job`), not by a test.

## How the deterministic conversation reads

Each reply is one chat message, `assistant_text`: the acknowledgement, then the next question. The engine records them as two assistant turns (the acknowledgement, then the question), so a chat page can join them into one message.

| The person | The acknowledgement |
| --- | --- |
| Taps options | The question's opener and the options in the person's terms: "Got it, knowing what's in your way and help picking things up." Openers differ by question ("Got it," "Good to know:" "Sounds good," "All right," "Okay," "Understood," "Thanks,"), so a run doesn't start every reply the same way. |
| Types only | The question's own thanks: "Thanks, that helps." for the first question, "Good to know, thanks." for places, and so on. |
| Taps options and types | The options' acknowledgement only; their words are already in the chat. |
| Skips | "No problem." |
| Skips the rest | "Sure." |

After the last answer the engine says "Here's your walker." The greeting recorded before the first question is one short sentence, and the page leaves it out.

**Covered topics.** When typed words also answer a later topic, that topic counts as answered and isn't asked: "I keep bumping into door frames at home, and a buzz in the handles would help", typed for the first question, answers places (`home`) and how to get the person's attention (`vibration_feedback`), so the next question is how to ask for help. A topic is covered (`covered_by`: the typed fact's id) only when it applies, is still unanswered, comes later in the bank, and the fact has one of that topic's tags that the fact's own topic doesn't also have: "I'd like help picking up cups" is a task (`pick_up`), so it doesn't say what to reach, and that question is still asked. `coverTopics` and `backs` in `engine.ts` hold the rule, and the agent uses the same two for the topics a model lists. Editing or removing the fact so it no longer backs a topic opens that topic again (`prune`). A covered topic can still be revisited: an answer or a skip there replaces the coverage, so it stays answered whatever happens to the words.

## Supabase store

**Choosing it.** `storeBackendFromEnv` reads three variables (listed, names only, in [`apps/web/.env.example`](../../apps/web/.env.example)):

| Variables set | Store | Onboarding |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SECRET_KEY` | Supabase | Works |
| None of them | Memory, exactly as before | Works, except in production (`NODE_ENV=production`, which includes every Vercel deployment): there it answers `503 unavailable`, because instances don't share memory, unless `ONBOARDING_ALLOW_MEMORY_STORE=true` |
| Some but not all | Memory | Always `503`, and the server log names the missing variables (never their values) |

**Tables** ([`supabase/migrations/`](../../supabase/migrations)): `onboarding_sessions` (the engine session as `jsonb`, with `revision`, `state`, `catalog_version`, `expires_at`, an owner `user_id` or a demo token hash), `onboarding_turn_results` (each turn's response, for retries; the newest 5 per session) and `device_configurations` (an account's confirmed setups, numbered 1, 2, 3… per user, never updated: a trigger rejects any `UPDATE`). There is no `profiles` table yet: confirmed facts stay in the session they came from, and are deleted with it.

**Who reaches what.**

- An **account session** is read through a Supabase client carrying the signed-in user's own access token, so Postgres row-level security decides which rows exist. Owners can read their own rows of all three tables and insert, change and delete their own sessions. They can't write turn results or setups, or delete a setup on its own: those are written only by the save function below, and a setup goes only when its session is deleted (`on delete cascade`).
- A **demo session** has no account, so the server reaches it with the secret key (service role), and every such query names `user_id is null` and the SHA-256 of the session's token. The token itself is only in the caller's cookie. The secret key never leaves the server.
- The `anon` role (any browser with the public key and no session) has no privileges on these tables, and can't call the save or expiry functions.
- Owners can call the save function and write their own sessions directly through the Data API with their own token, without this server. That can only change their own data, within the same bounds (expiry, setup numbering); the Pi must still validate any configuration it fetches against what is installed.

**Consistency.** `save_onboarding_session` is a `security definer` Postgres function, so it checks ownership itself: with no token hash it updates only the caller's own account session (`auth.uid()`), with a hash only the service role may call it and only for that demo row. It updates the session only if its stored revision still equals the one the turn started from, and writes the turn's response and, on confirmation, the setup in the same transaction. A setup must carry the owner's next number (highest so far plus one, under a per-user lock). Of two overlapping turns only one lands; the other gets `409 revision_conflict` with the current state, or, if it was a retry of the same `client_turn_id`, the stored response. Numbers can repeat after the newest setup is deleted; the device API will need its own per-device version that never goes back.

**Bounds.** A trigger caps `expires_at` on every write (an hour after now for a demo row, 30 days for an account row, plus five minutes for clock differences), and a row counts as `confirmed` only when its engine state holds a configuration, so no write can keep data longer than its notice says. Anyone can start a demo, so the Supabase store refuses a new one while 500 are live (`503 unavailable`), a conversation stops taking turns at 200 (`422`; "skip the rest" still works, so it can be saved), and only the 5 newest turn responses are kept. There is no per-address rate limit yet; add one (for example a Vercel firewall rule) before sharing a public link.

**Data handling** (AGENTS.md rule 9). Answers can reveal disability.

| | Demo session | Account session |
| --- | --- | --- |
| Consent | The start screen's demo notice (`consent.demo_data_notice`) | The account notice (`consent.account_data_notice`), only when signed in |
| Stored | Transcript, answers, facts and, once saved, the configuration, in `engine_state`; the 5 newest turn responses, for retries | The same, plus the confirmed setup in `device_configurations` |
| Kept | An hour after the last change, saved or not | Unfinished: 30 days after the last change. Confirmed: until the user deletes it or their account |
| Deleted by | **Delete my answers** (now); the `delete-expired-onboarding-sessions` `pg_cron` job every 5 minutes; the server also refuses an expired session | **Delete my answers** while unfinished; **Delete setup** in Your setups (the setup and its session); **Delete my account** there, which deletes the auth user and so every row; the same job for unfinished ones |
| Access | Server only, by token hash | The owner, through row-level security |

With the onboarding agent on, answers are also sent to the model provider (Anthropic or Google), whatever the store; see below.

## Onboarding agent

**Turning it on.** Set these on the server (for the web app, in `apps/web/.env.local`, which git ignores; see `apps/web/.env.example`):

| Variable | Meaning |
| --- | --- |
| `ONBOARDING_ENGINE` | `deterministic` (default) or `agent` |
| `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` | The model provider's key, needed for `agent`. Without one the deterministic engine runs, exactly as before, and the server logs a warning. |
| `ONBOARDING_AGENT_PROVIDER` | Optional: `anthropic` (Claude) or `gemini` (Google). Unset, the agent uses Claude when `ANTHROPIC_API_KEY` is set and otherwise Gemini. Set to a provider whose key is missing, it runs the deterministic engine and warns. |
| `ONBOARDING_AGENT_MODEL` | Optional. Overrides the chosen provider's default (`DEFAULT_AGENT_MODEL` for Claude, `DEFAULT_GEMINI_MODEL` for Gemini). The model must support structured output; for Claude, also the effort setting. |

The key is read only on the server. The browser never sees it, and the first screen's notice names who reads the answers and who may keep them (`agentNoticeClause`, for example "Google's Gemini reads them to choose each question, and Google may keep a copy"). **Open before a public demo:** once sent, answers are outside this server, and **Delete my answers** can't recall them. How long the provider keeps API inputs depends on the account's terms; confirm them and say so on the first screen. With Gemini, check the key's project (Google's Gemini API Additional Terms, read 2026-10-23). On the free (Unpaid Services) tier, Google uses prompts and responses to improve its products, human reviewers may read them, and the terms say not to submit sensitive, confidential or personal information. Free-tier apps may serve only users 18 or older, and users in the EEA, Switzerland or the UK only through Paid Services. On a paid (billing-enabled) project, Google doesn't use prompts or responses to improve its products and keeps them for a limited time to detect abuse. A person's mobility needs can reveal disability, so use the free tier only with scripted, fictional answers (a rehearsed demo), and a paid key before real people type their own needs.

**What the model does, and what it doesn't.** For a `text` or `answer` turn, one model call gets the rules (the system prompt, cached on Claude) and a JSON document describing the turn: the current question, the chosen options, the user's typed words, the facts so far and each topic's status. It returns, as schema-checked JSON:

- `tags` and `declined_tags` for the user's typed words, from the `NeedTag` list only. The fact still quotes the user's own words; the model never writes a fact's text.
- `covered`: other topics those words already answered ("at home" answers places). A topic counts only under the same rule as in the deterministic engine (one of the fact's tags belongs to it and not to the current topic), and it opens again if that fact is removed or reworded so the tag is gone.
- `next`: the next topic, or `done`. It writes the question's `prompt` (48 characters at most) and `detail` **in its own words, from the topic's `purpose`** (why we ask and what a useful answer looks like). It never sees the bank's question wording, because a quotable line comes back nearly word for word; the bank's `prompt` is only the deterministic engine's (and the fallback's) wording. It picks which of that topic's **bank options** to offer, shown as small "for example" replies. It can't invent an option, so a choice always records the bank's fact and tags. It may ask the current topic once more to clarify an unclear answer, on multiple-choice topics only; that answer is added to the first one, not swapped in, and an option chosen again is recorded once.
- `ack`: one short sentence saying back what it heard, in the person's own words, or empty when the question follows straight on (then no acknowledgement turn is recorded and `ack` is `null`). It is shown with the next question as one chat message. If the person asks what the walker can do, the ack answers in one sentence from the catalog's own summaries and limitations, which are in the system prompt, or says it isn't built yet; it may not claim more, since nothing is measured. The question is open, about one thing, never two, and never lists the options.
- **Copy checks** (`copyProblem`, on the ack and the question, or the closing line, as shown): no em dashes, en dashes or ellipses; the ack doesn't open with "Noted" or "I have noted" and has no question; the prompt is exactly one question; at most two sentences in all; no internal names (tag, topic or module ids). A broken rule gets the same single retry as other rule breaks.
- `done` is accepted only when no topic is left unanswered. Ending early is the user's choice ("Skip the rest and review"), as without the agent.

Chosen options, recommendations (`recommend.ts`), the robot arms' "consider only" rule, and the review and confirm steps don't involve the model. It sees the catalog's plain-language summaries and limitations only to answer a question truthfully, never module ids or rules, and it can't pick modules. Skips, "skip the rest" and revisits stay deterministic.

**When a reply is no good.** The schema puts the tag, topic and option lists into the API request, so the model can't produce other values. The server then checks the rest: lengths, a tag both wanted and declined, a topic that doesn't apply or was already answered, a follow-up on a single-choice topic or a third ask, options from another topic, `done` with topics left. A refusal or a broken rule gets one retry with a short server note saying why (built from rule names and ids, never the user's words). A second failure, an API error, or the 15-second deadline (`AGENT_TIMEOUT_MS`) sends that turn to the deterministic engine, and the next turn tries the model again. With Claude, on a policy decline the API first retries on its default fallback model inside the same call (`fallbacks: "default"`). With Gemini, a blocked prompt or a safety finish counts as a refusal.

**Logs.** One line per agent turn: `[onboarding-agent] outcome=agent|fallback attempts=N reason=… ms=…`. No user words, ids or keys.

**Request settings.** In `anthropic.ts`: effort `low`, since a turn is a short conversational step and has to finish in a few seconds; adaptive thinking is the model's default; `max_tokens` 4096; one SDK retry. In `gemini.ts`: `responseMimeType: "application/json"` with `responseJsonSchema` set to the reply schema; `maxOutputTokens` 4096; thinking kept low (`thinkingLevel: "low"` on Gemini 3 and later, `thinkingBudget: 0` on 2.5 Flash, see `thinkingFor`); one retry on a `5xx`, and none on `429`, because a used-up quota fails again at once; a model name may be given as `models/gemini-…`. A model override that doesn't start with the chosen provider's prefix (`claude-`, `gemini-`) logs a warning at startup. Measured on 2026-10-23 over full conversations with new wording: `gemini-3.7-flash` (the default) took about 2.5 s a turn with no fallbacks, and read "at home" out of "my hallway" and "the kitchen shelf" to skip that question; with its default thinking it took about 5 s and hit the deadline on 2 of 7 turns. `gemini-3.5-flash-lite` and `gemini-2.5-flash` answered in about 1 s with no fallbacks but asked more of the questions. Errors are reported by status code only, because Google's error text can echo the request. These are starting values to tune from a live run.

## Walker store

The always-on walker assistant's server side ([walker assistant guide](../../docs/subsystems/walker-assistant.md), contract in [`walker.ts`](../../packages/contracts/src/walker.ts)). The routes are in `apps/web/app/api/v1/{devices,walkers}/` with their glue in `apps/web/src/server/walker.ts`; this package does the work.

**Choosing it** (`walkerBackendFromEnv`):

| `DATABASE_URL` | Store | Walker routes |
| --- | --- | --- |
| Set (on Render, from the Blueprint's database) | Postgres | Work |
| Not set, outside production | Memory: lost on restart | Work, for local runs |
| Not set, in production (such as the Vercel onboarding site) | None | `503 unavailable`; onboarding is unaffected |

**Tables** ([`src/walker/migrations.ts`](src/walker/migrations.ts)): `walker_devices` (owner hash, credential hash, name, last heartbeat, last manifest, last snapshot and when the server received it), `walker_configurations` (immutable versions per walker; a trigger rejects any `UPDATE`), `walker_proposals` (at most one open per walker, by a partial unique index), `walker_turns`, `walker_lines` (what the walker said on its own, from heartbeats), `walker_pairing_codes` and `walker_pairing_tries` (wrong codes by a hash of the client address keyed with a secret held only in server memory, so a stored hash can't be reversed by trying every address). The migrations run at server start (`apps/web/instrumentation.ts`) in one transaction holding a Postgres advisory lock, so two instances starting at once never race; each runs once, recorded in `walker_schema_migrations`.

**Who reaches what.** The server is the only database client: there's no Data API, so Supabase-style row-level security doesn't apply. Ownership is enforced in every query instead. The Pi's walker is found only by the SHA-256 of its credential, and the page's only by its id together with the SHA-256 of the `walker_owner` cookie; everything else is read and written by the device id found that way. An unknown id and someone else's both answer `404`.

**Consistency.** Each step that must be atomic is one transaction that first locks the walker's row: answering a proposal (so of two Confirms at once the second sees the first's result and gets `409 proposal_closed`), saving a turn with the proposal it opens, and claiming a pairing code. A claim first locks its client address (a second claim from that address at the same moment gets `429 rate_limited` at once, rather than hold a connection while it waits), then counts that address's wrong tries, checks the code and records a wrong one, all in one transaction, so tries sent at once can't get past the lockout; it also locks the owner, so two claims can't both pass the 8-walker limit. The lockout window slides: it lifts 10 minutes after the oldest of the 5 wrong tries. The in-memory store makes each of those steps with no `await` inside it. Both stores call the same rules ([`rules.ts`](src/walker/rules.ts)), and both run the same tests.

**Data handling** (AGENTS.md rule 9):

| | |
| --- | --- |
| Stored | The walker's name, its configurations, its last manifest and sensor snapshot, proposals, turns (what the person said, as typed or transcribed, and the reply) and the walker's own lines. Only the SHA-256 of the owner cookie and the device credential, and a keyed hash of a wrong-code client address. Never a voice clip. A NUL character or half a surrogate pair in any text becomes U+FFFD, since Postgres can't store them |
| Kept | Turns, walker lines and answered proposals: an hour after they happen, deleted on every heartbeat, every page read and at server start. Pairing codes: 10 minutes. Wrong-code tries: 10 minutes. The walker itself, its configurations and its last manifest and snapshot: until Forget |
| Deleted by | **Forget this walker** on the page (`DELETE /walkers/{id}`): one statement, so one transaction, removes the walker and, by cascade, everything about it, and its credential stops working. The sweep above |
| Access | The server only, by device id found through a credential or an owner, as above |

**Testing against Postgres.** Docker isn't needed: any local Postgres works. With Homebrew's `postgresql@17`, from the repository root:

```bash
/opt/homebrew/opt/postgresql@17/bin/initdb -D /tmp/walker-pg -U walker --auth=trust
/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /tmp/walker-pg -l /tmp/walker-pg.log -o "-p 55432 -k '' -c listen_addresses=127.0.0.1 -c fsync=off" start
WALKER_TEST_DATABASE_URL=postgres://walker@127.0.0.1:55432/postgres pnpm --filter @walker/cloud-api test
/opt/homebrew/opt/postgresql@17/bin/pg_ctl -D /tmp/walker-pg stop
```

Each test run makes its own database and drops it afterwards; a URL that isn't on this machine is refused. `fsync=off` is for a throwaway cluster only: on a slow disk, each file sync otherwise takes seconds. Without `WALKER_TEST_DATABASE_URL` the Postgres cases skip with a message saying so. The expected results are in [`test/walker/EXPECTED.md`](test/walker/EXPECTED.md).

## Walker assistant

One question and its answer (`WalkerService.turn`, routes `POST /devices/{id}/turns` and `POST /walkers/{id}/turns`).

**The model.** Always Gemini (`GEMINI_API_KEY`; `WALKER_AGENT_MODEL` overrides `gemini-3.7-flash`), whatever the onboarding provider is, because voice turns need audio input. A voice clip goes to Gemini as `inlineData` (`audio/wav`) in the same `generateContent` call as the JSON schema; a live check on 2026-10-24 returned the exact transcript with the reply. The model sees, in order: the policy (the system prompt), the walker and how the person asked, its configuration, its parts with health and `simulated`, its zones (measured with the reading's age, or unknown), the suggestion waiting for Confirm, the last 10 turns, and the person's words, as data. A walker's turn uses the snapshot it carries, received now, instead of the heartbeat's. The reply is `{ transcript, reply, topics, cues_change }`; a reply over 350 characters, or one off the schema, is retried once with a note naming the rule (never the person's words).

**The server's rules,** all from structured fields, never from the words:

| When | What the server does |
| --- | --- |
| `topics` has `arms` | The reply is a fixed line from the manifest ("This walker doesn't have robot arms…"), `answered_by: "fixed"`, and any change is dropped. No action request exists |
| A `cues_change` fails `checkCuesChange` | Dropped; the reply is a fixed line saying why, `answered_by: "fixed"` |
| A valid `cues_change` while the walker is offline | No proposal; a fixed line says the walker is offline |
| A valid `cues_change` | A proposal opens: summary written from the payload ("Switch your alerts from buzzing to short sounds."), the turn's `client_turn_id`, 60 s to answer. The reply is written from the same payload ("I can switch your alerts from buzzing to short sounds. Press Confirm to do it."), so the person hears exactly what Confirm will do, never the model's description of it; it stays `answered_by: "model"`, since the model chose the change |
| A proposal is already open | The reply gets "Still waiting for you: … Press Confirm to do it." |
| `topics` has `obstacles` and a ToF part is simulated | The reply gets "These readings are simulated." |
| `topics` has `parts` and a reported part is simulated (and the line above didn't apply) | The reply gets "All of this walker's parts are simulated." when every part the walker reports is (as on the simulator), otherwise "Some of this walker's parts are simulated." |
| An error, a refusal, a bad reply twice, 8 s, or no key | A fixed line from the status view, `answered_by: "fixed"`; a voice turn with no transcript has `heard: null` |

The model can't confirm anything: only Confirm by id changes a walker (piece 2). A turn's response reads its proposal after expiry, so a replay of an expired proposal, or a walker that dropped offline while the model answered, never comes back as `open`. The rules are one pure function, `applyRules` in `service.ts`.

**Time.** The Pi gives up on a turn after 10 s. The server's part, counted from when the route starts reading the upload, stays within 8 s: the model gets at most 8 s and only what's left, then the voice at most 3 s and only what's left (skipped under half a second). That leaves time for the audio's download over a phone hotspot.

**Idempotency.** A `client_turn_id` already stored returns that turn and its proposal with a fresh status and `speech: null`, without calling the model. Two uploads of one turn at once store one turn and at most one proposal (the store's `saveTurn` is one transaction).

**Speech.** With `CARTESIA_API_KEY` (not `none`), a walker turn's reply text goes to Cartesia (`POST https://api.cartesia.ai/tts/bytes`, `Cartesia-Version: 2026-08-14`, model `sonic-3.6`, the stock voice "Skylar" unless `CARTESIA_VOICE_ID` names another stock one, 16 kHz mono 16-bit WAV, checked against docs.cartesia.ai on 2026-10-24). It returns as `speech` and the turn is `voiced_by: "cartesia"`. With no key, an error, more than 3 s (or less of the turn's 8 s left), audio over `SPEECH_MAX_BYTES`, or audio the Pi's player can't play (anything but PCM 16 kHz mono 16-bit with samples), `speech` is null and `voiced_by` is `"walker"`. Page turns are never spoken. Tested with a stubbed Cartesia only; the live check waits for a key.

**Measured** (live on `gemini-3.7-flash`, 2026-10-24, 30 turns a run: the demo's lines 3 of 3 typed and 3 of 3 spoken, plus 3 fresh wordings each way, on a walker reported the way devices/pi's simulator reports it, including `base.walker` (`sim-coordinator`, added in #36); without it, a "which parts work?" turn heard that the walker itself wasn't responding): every check passed and every voice transcript was exact, at a median of 2.5 to 3.7 s and at most 6.8 to 8.0 s a turn over five runs. To run it again (a Mac with `say` and `ffmpeg`; the clips are written to a temporary folder and never played):

```bash
WALKER_LIVE=1 pnpm --filter @walker/cloud-api walker-live
```

**Data.** The person's clip goes to Gemini with the turn and is then dropped: never stored or logged. Their transcript or typed words and the reply are stored as the turn (an hour, as above), and the reply text goes to Cartesia when speech is on. Logs carry one line per turn: ids, who answered, why not the model, attempts, model and voice milliseconds, whether a proposal opened. Never words or audio. The expected results are in [`test/walker/EXPECTED-turns.md`](test/walker/EXPECTED-turns.md).

## Next steps

1. **Live check of the agent** with a real key: run the conversation by hand with new wording each time (not the fixture sentences, which a model can echo), and read the facts and next questions as well as the fluency. Record latency and the fallback rate from the log lines.
2. **Hosted Supabase**: create the project, apply the migrations (`pnpm supabase link`, then `pnpm supabase db push`), set the variables, and rerun the RLS checks' scenarios by hand against it.
3. **Device API**: pairing, configuration fetch and events, behind a device credential separate from user sessions.
