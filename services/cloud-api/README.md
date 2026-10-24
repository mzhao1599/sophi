# Cloud API and agents

Owns onboarding sessions, the onboarding conversation and its recommendations, and (later) assistant runs, typed tools and the device API. For now it is a TypeScript package that the Next.js route handlers in `apps/web` call; it has no HTTP server of its own. Read [cloud agents](../../docs/subsystems/cloud-agents.md) and the [runtime blueprint](../../docs/agent-runtime.md).

**Status:** the onboarding service works with a **deterministic engine** and an **in-memory store**. An **LLM onboarding agent** (Claude, through the Anthropic TypeScript SDK) can read text and answer turns when it is turned on; it is off by default. It has been checked with stub models and a local mock of the API, **not yet against the real model**. There is no Supabase store or device API yet.

## What's here

| File | Role |
| --- | --- |
| `src/onboarding/questions.ts` | The question bank: tasks, places, cues, how to start a request, what to reach (only asked when relevant), location, anything else. No question asks for a diagnosis. |
| `src/onboarding/matcher.ts` | Reads typed answers into need tags with a small keyword matcher, including "I don't want…" declines. Ignores condition names on purpose. |
| `src/onboarding/recommend.ts` | Facts → a recommendation for every catalog module, each reason pointing at the fact it came from. Robot arms are only ever "worth considering". |
| `src/onboarding/engine.ts` | Pure session transitions. The current question is derived from the answers, so a restored session resumes where it left off; the one stored exception is the agent's next question (`pending`). `TurnEngine` is the interface both engines implement. |
| `src/onboarding/agent.ts` | The onboarding agent: the prompt, the reply schema, the checks on a reply, one retry, and the fallback to the deterministic engine. |
| `src/onboarding/anthropic.ts` | The model client: one Messages API call with structured output. The default model is `DEFAULT_AGENT_MODEL` here. |
| `src/onboarding/config.ts` | `engineFromEnv`: picks the engine from environment variables. |
| `src/onboarding/service.ts` | Ownership (secret token), expiry, revision checks, idempotent turns by `client_turn_id`, and errors with stable codes. |
| `src/onboarding/store.ts` | `SessionStore` interface and the in-memory demo store. |

```bash
pnpm --filter @walker/cloud-api test
```

The tests cover the matcher, a full conversation, skipped and revisited questions, edits that change recommendations, retries and stale revisions, expiry, and every combination of chosen tasks and cues producing a valid default selection.

`test/agent.test.ts` runs the agent against a stub model with the scenarios from the [cloud agents guide](../../docs/subsystems/cloud-agents.md#evaluation-and-observability): a request for every module, a refused module, an unclear answer, instructions hidden in the user's words, refusals, bad JSON, API errors and a timeout. It also checks that with every model call failing the agent matches the deterministic engine step for step, that two overlapping turns can't both land, and the exact request the SDK sends. A stub proves what the code does with a reply; it says nothing about how well a real model reads people.

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
2. **Supabase store**: implement `SessionStore` over Postgres with row-level security on user-owned tables (see the data model in the runtime blueprint). Keep the demo store for local runs.
3. **Device API**: pairing, configuration fetch and events, behind a device credential separate from user sessions.
