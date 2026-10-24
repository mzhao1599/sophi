# Cloud API and agents

Owns onboarding sessions, the onboarding conversation and its recommendations, and (later) assistant runs, typed tools and the device API. For now it is a TypeScript package that the Next.js route handlers in `apps/web` call; it has no HTTP server of its own. Read [cloud agents](../../docs/subsystems/cloud-agents.md) and the [runtime blueprint](../../docs/agent-runtime.md).

**Status:** the onboarding service works with a **deterministic engine** and an **in-memory store**. There is no LLM agent, no Supabase store, no device API yet.

## What's here

| File | Role |
| --- | --- |
| `src/onboarding/questions.ts` | The question bank: tasks, places, cues, how to start a request, what to reach (only asked when relevant), location, anything else. No question asks for a diagnosis. |
| `src/onboarding/matcher.ts` | Reads typed answers into need tags with a small keyword matcher, including "I don't want…" declines. Ignores condition names on purpose. |
| `src/onboarding/recommend.ts` | Facts → a recommendation for every catalog module, each reason pointing at the fact it came from. Robot arms are only ever "worth considering". |
| `src/onboarding/engine.ts` | Pure session transitions. The current question is derived from the answers, so a restored session resumes where it left off. |
| `src/onboarding/service.ts` | Ownership (secret token), expiry, revision checks, idempotent turns by `client_turn_id`, and errors with stable codes. |
| `src/onboarding/store.ts` | `SessionStore` interface and the in-memory demo store. |

```bash
pnpm --filter @walker/cloud-api test
```

The tests cover the matcher, a full conversation, skipped and revisited questions, edits that change recommendations, retries and stale revisions, expiry, and every combination of chosen tasks and cues producing a valid default selection.

## Next steps

1. **Supabase store**: implement `SessionStore` over Postgres with row-level security on user-owned tables (see the data model in the runtime blueprint). Keep the demo store for local runs.
2. **Onboarding agent**: replace `applyInput`'s answer handling with a bounded model loop that returns the same structured result (facts with tags, the next question, recommendations from the catalog only). Ask for JSON-schema output and retry once with the reason a reply was refused; keep the deterministic engine as the fallback and as the comparison baseline in tests.
3. **Device API**: pairing, configuration fetch and events, behind a device credential separate from user sessions.
