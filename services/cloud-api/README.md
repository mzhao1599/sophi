# Cloud API and agents

Owns onboarding sessions, the onboarding conversation and its recommendations, and (later) assistant runs, typed tools and the device API. For now it is a TypeScript package that the Next.js route handlers in `apps/web` call; it has no HTTP server of its own. Read [cloud agents](../../docs/subsystems/cloud-agents.md) and the [runtime blueprint](../../docs/agent-runtime.md).

**Status:** the onboarding service works with a **deterministic engine** and two stores: **in memory** (local demos, the default) and **Supabase Postgres** with row-level security, tested against a local Supabase stack but **not yet against a hosted project**. An **LLM onboarding agent** (Claude, through the Anthropic TypeScript SDK) can read text and answer turns when it is turned on; it is off by default. It has been checked with stub models and a local mock of the API, **not yet against the real model**. There is no device API yet.

## What's here

| File | Role |
| --- | --- |
| `src/onboarding/questions.ts` | The question bank: tasks, places, cues, how to start a request, what to reach (only asked when relevant), location, anything else. No question asks for a diagnosis. |
| `src/onboarding/matcher.ts` | Reads typed answers into need tags with a small keyword matcher, including "I don't want…" declines. Ignores condition names on purpose. |
| `src/onboarding/recommend.ts` | Facts → a recommendation for every catalog module, each reason pointing at the fact it came from. Robot arms are only ever "worth considering". |
| `src/onboarding/engine.ts` | Pure session transitions. The current question is derived from the answers, so a restored session resumes where it left off; the one stored exception is the agent's next question (`pending`). `TurnEngine` is the interface both engines implement. `openingQuestion()` is the question every session opens with, so the web page can show it before a session exists. |
| `src/onboarding/agent.ts` | The onboarding agent: the prompt, the reply schema, the checks on a reply, one retry, and the fallback to the deterministic engine. |
| `src/onboarding/anthropic.ts` | The model client: one Messages API call with structured output. The default model is `DEFAULT_AGENT_MODEL` here. |
| `src/onboarding/service.ts` | Ownership (demo token or signed-in user), expiry, revision checks, idempotent turns by `client_turn_id`, and errors with stable codes. |
| `src/onboarding/store.ts` | `SessionStore` interface, session owners, and the in-memory store. |
| `src/onboarding/supabase-store.ts` | `SupabaseSessionStore`: the same interface over Postgres ([`supabase/migrations/`](../../supabase/migrations)). |
| `src/onboarding/setups.ts` | Account reads through the user's own client: their saved setups (checked against the contract) and their latest unfinished session. |
| `src/onboarding/config.ts` | `engineFromEnv` and `storeBackendFromEnv`: pick the engine and the store from environment variables. |

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

The tests cover the matcher, a full conversation, skipped and revisited questions, edits that change recommendations, retries and stale revisions, expiry, and every combination of chosen tasks and cues producing a valid default selection.

`test/agent.test.ts` runs the agent against a stub model with the scenarios from the [cloud agents guide](../../docs/subsystems/cloud-agents.md#evaluation-and-observability): a request for every module, a refused module, an unclear answer, instructions hidden in the user's words, refusals, bad JSON, API errors and a timeout. It also checks that with every model call failing the agent matches the deterministic engine step for step, that two overlapping turns can't both land, and the exact request the SDK sends. A stub proves what the code does with a reply; it says nothing about how well a real model reads people.

`test/store.test.ts` runs one `SessionStore` contract against both stores: a session is returned only to its owner, a save only lands from the revision it read, exactly one of two overlapping saves lands, a turn's response is kept with its save, setups are numbered per account, and delete is owner-only. `test/rls.test.ts` checks the database through the real Data API, not through the store: user B can't read, change, delete or write onto user A's rows; an owner can't write or delete setups or turn results directly, and the save function accepts only the next setup number; the server's key can't save an account's row; signed-in users can't reach demo sessions even with the token hash; an anonymous client gets `permission denied` for select, insert, update and delete on every table and for both functions; expiry is bounded on every write; confirmed setups can't be edited; and the expiry job removes expired demo and unfinished sessions but keeps confirmed account setups and anything unexpired. `test/accounts.test.ts` covers account sessions, the caps and the store choice, and runs a whole conversation, the 30-day expiry and the overlapping-turn race over the Supabase store. Breaking a policy or dropping the revision check from the save function makes these tests fail (checked by hand). The `pg_cron` schedule itself was checked by hand (`select * from cron.job`), not by a test.

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

With the onboarding agent on, answers are also sent to Anthropic, whatever the store; see below.

## Onboarding agent

**Turning it on.** Set these on the server (for the web app, in `apps/web/.env.local`, which git ignores; see `apps/web/.env.example`):

| Variable | Meaning |
| --- | --- |
| `ONBOARDING_ENGINE` | `deterministic` (default) or `agent` |
| `ANTHROPIC_API_KEY` | Needed for `agent`. Without it the deterministic engine runs, exactly as before, and the server logs a warning. |
| `ONBOARDING_AGENT_MODEL` | Optional. Overrides `DEFAULT_AGENT_MODEL`; the model must support structured outputs and the effort setting. |

The key is read only on the server. The browser never sees it, and the first screen says when answers are sent to Anthropic. **Open before a public demo:** once sent, answers are outside this server, and **Delete my answers** can't recall them. How long Anthropic keeps API inputs depends on the API account's data-retention terms; confirm them and say so on the first screen.

**What the model does, and what it doesn't.** For a `text` or `answer` turn, one model call gets the rules (the system prompt, cached) and a JSON document describing the turn: the current question, the chosen options, the user's typed words, the facts so far and each topic's status. It returns, as schema-checked JSON:

- `tags` and `declined_tags` for the user's typed words, from the `NeedTag` list only. The fact still quotes the user's own words; the model never writes a fact's text.
- `covered`: other topics those words already answered ("at home" answers places). A topic counts only if one of the fact's tags belongs to it, and it opens again if that fact is removed or reworded so the tag is gone.
- `next`: the next topic, or `done`. It writes the question's `prompt` (48 characters at most) and `detail`, and picks which of that topic's **bank options** to offer. It can't invent an option, so a choice always records the bank's fact and tags. It may ask the current topic once more to clarify an unclear answer, on multiple-choice topics only; that answer is added to the first one, not swapped in, and an option chosen again is recorded once.
- `ack`: one or two short sentences, shown and announced to screen readers.
- `done` is accepted only when no topic is left unanswered. Ending early is the user's choice ("Skip the rest and review"), as without the agent.

Chosen options, recommendations (`recommend.ts`), the robot arms' "consider only" rule, and the review and confirm steps don't involve the model. It never sees the catalog and can't pick modules. Skips, "skip the rest" and revisits stay deterministic.

**When a reply is no good.** The schema puts the tag, topic and option lists into the API request, so the model can't produce other values. The server then checks the rest: lengths, a tag both wanted and declined, a topic that doesn't apply or was already answered, a follow-up on a single-choice topic or a third ask, options from another topic, `done` with topics left. A refusal or a broken rule gets one retry with a short server note saying why (built from rule names and ids, never the user's words). A second failure, an API error, or the 15-second deadline (`AGENT_TIMEOUT_MS`) sends that turn to the deterministic engine, and the next turn tries the model again. On a policy decline the API first retries on its default fallback model inside the same call (`fallbacks: "default"`).

**Logs.** One line per agent turn: `[onboarding-agent] outcome=agent|fallback attempts=N reason=… ms=…`. No user words, ids or keys.

**Request settings** (in `anthropic.ts`): effort `low`, since a turn is a short conversational step and has to finish in a few seconds; adaptive thinking is the model's default; `max_tokens` 4096; one SDK retry. These are starting values to tune from a live run.

## Next steps

1. **Live check of the agent** with a real key: run the conversation by hand with new wording each time (not the fixture sentences, which a model can echo), and read the facts and next questions as well as the fluency. Record latency and the fallback rate from the log lines.
2. **Hosted Supabase**: create the project, apply the migrations (`pnpm supabase link`, then `pnpm supabase db push`), set the variables, and rerun the RLS checks' scenarios by hand against it.
3. **Device API**: pairing, configuration fetch and events, behind a device credential separate from user sessions.
