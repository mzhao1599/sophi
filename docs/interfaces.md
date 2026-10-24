# Proposed interfaces and contracts

This is the first shared contract for web, cloud, Pi, and ESP32 work. The **onboarding routes are implemented** (demo mode only) with schemas in [`packages/contracts/src/onboarding.ts`](../packages/contracts/src/onboarding.ts). The serial envelope, capability manifest, sensor snapshot and action request/status are **specified** as v1 schemas in [`serial.ts`](../packages/contracts/src/serial.ts) and [`device.ts`](../packages/contracts/src/device.ts) but **not implemented** on any Pi, ESP32 or cloud route. The walker assistant's routes are **specified** in [`walker.ts`](../packages/contracts/src/walker.ts) and explained in the [walker assistant guide](subsystems/walker-assistant.md). All of them are **built** (in-memory and Postgres stores, tested against a local Postgres, and deployed on Render at https://steady-walker.onrender.com, checked end to end 2026-10-24). The two turn routes are checked live on Gemini; their Cartesia speech is tested with a stub only. Everything else here is still a proposal. Define each new schema in `packages/contracts/`, assign a protocol version, and validate on **both** sides. Prefer generated types where practical.

## Rules shared by all transports

- Each event has a schema version, origin, timestamp, request/event ID, and correlation ID. Avoid embedding raw audio/images in ordinary JSON events.
- Commands have idempotency keys and explicit deadlines. A retry must not start the same motion twice.
- Acknowledgement means receipt/validation, not task completion. Completion or failure is a later event.
- Reject unknown command types or unsupported major versions. Allow only documented optional fields within a version.
- Validate length, numeric ranges, enum values, and payload size before using data. Do not treat a device's self-reported capability as sufficient authorization.
- Timestamps help ordering; use local monotonic timers for watchdogs because wall clocks can jump.

## Cloud API surface

Base path proposal: `/api/v1`. User routes require proof of who is calling: a signed-in session, or for demo sessions and the walker page, a secret in an `httpOnly` cookie. Device routes require a distinct revocable device credential bound to one device. Pairing uses a short-lived, one-time challenge; never copy a user's session cookie to the Pi.

| Route | Caller | Purpose | Status |
| --- | --- | --- | --- |
| `POST /onboarding/sessions` | User web app | Start a session with consent and chosen input mode | Built (demo) |
| `POST /onboarding/sessions/{id}/turns` | User web app or approved integration | Answer, skip or revisit a question; returns the assistant turn, the acknowledgement and the updated session with recommendations | Built (demo), text only |
| `GET /onboarding/sessions/{id}` | User web app | Restore transcript/summary/recommendation after refresh | Built (demo) |
| `PATCH /onboarding/sessions/{id}/profile` | User web app | Edit or remove one item of the draft profile ("What I understood"); recommendations are recomputed | Built (demo); the one-page demo changes answers with `revisit` instead, so no page calls it now |
| `POST /onboarding/sessions/{id}/confirm` | User web app | Confirm the reviewed selection as configuration version 1 | Built (demo) |
| `DELETE /onboarding/sessions/{id}` | User web app | Delete the session and its answers now | Built (demo) |
| `POST /onboarding/sessions/{id}/checkout` | User web app | Mock purchase of the confirmed configuration: returns a Stripe **test-mode** hosted Checkout URL. Web-only; shapes in `apps/web/src/lib/checkout.ts` | Built (demo), test mode only |
| `GET /checkout/status` | User web app | Whether the mock purchase is on (an `sk_test_` key is set) and why not | Built (demo) |
| `POST /walkers/pairing-codes` | Owner's page (`walker_owner` cookie) | A one-time 6-digit pairing code, valid 10 minutes (`PairingCodeResponseSchema`) | Built ([`services/cloud-api`](../services/cloud-api/README.md#walker-store)); deployed on Render, checked 2026-10-24 |
| `GET /walkers`, `GET /walkers/{id}` | Owner's page | The owner's walkers as status views (`WalkerStatusViewSchema`). `GET /walkers` also carries `activity` (`WalkerActivityViewSchema`), for the page only: per walker of this owner, the turns the server is working on now (`hearing`, then `voicing`) and a trace of each recent saved turn (timings, the rule code, who answered and voiced; no words). It lives in server memory, so a restart empties it; at most 10 traces a walker, each kept an hour; the key is left out when no walker has any | Built ([`services/cloud-api`](../services/cloud-api/README.md#walker-store)); deployed on Render, checked 2026-10-24. `activity` built 2026-10-23, tested only (not deployed) |
| `POST /walkers/{id}/turns` | Owner's page | A typed question to the walker's assistant (`PageTurnRequestSchema` → `WalkerTurnResponseSchema`) | Built ([walker assistant](../services/cloud-api/README.md#walker-assistant)); deployed on Render, checked 2026-10-24 |
| `POST /walkers/{id}/proposals/{proposalId}` | Owner's page | Confirm or decline the open proposal (`AnswerProposalRequestSchema` → `AnswerProposalResponseSchema`) | Built ([`services/cloud-api`](../services/cloud-api/README.md#walker-store)); deployed on Render, checked 2026-10-24 |
| `DELETE /walkers/{id}` | Owner's page | Forget the walker: delete it, its turns, lines, configurations and proposals, and revoke its credential; `204`, no body | Built ([`services/cloud-api`](../services/cloud-api/README.md#walker-store)); deployed on Render, checked 2026-10-24 |
| `POST /devices/pair` | Pi | Claim a pairing code; receive the device id, a device credential (shown once) and configuration version 1 (`PairDeviceRequestSchema`, `PairDeviceResponseSchema`) | Built ([`services/cloud-api`](../services/cloud-api/README.md#walker-store)); deployed on Render, checked 2026-10-24 |
| `POST /devices/{id}/heartbeat` | Pi | Every 5 s: the capability manifest, sensor snapshot and the walker's own lines since the last one; the answer names the current configuration version and the open proposal (`HeartbeatRequestSchema`, `HeartbeatResponseSchema`) | Built ([`services/cloud-api`](../services/cloud-api/README.md#walker-store)); deployed on Render, checked 2026-10-24 |
| `GET /devices/{id}/configuration` | Pi | The current walker configuration (`ConfigurationResponseSchema`) | Built ([`services/cloud-api`](../services/cloud-api/README.md#walker-store)); deployed on Render, checked 2026-10-24 |
| `POST /devices/{id}/turns` | Pi | A voice clip (WAV, ≤ 15 s, ≤ 500,000 bytes) or text, with the current snapshot; the answer, any proposal it opened, the reply as speech when available, and the status (`DeviceTurnRequestSchema` → `WalkerTurnResponseSchema`) | Built ([walker assistant](../services/cloud-api/README.md#walker-assistant)); deployed on Render; Cartesia speech checked there 2026-10-24 |
| `POST /devices/{id}/proposals/{proposalId}` | Pi | The Confirm button: confirm or decline the open proposal (`AnswerProposalRequestSchema` → `AnswerProposalResponseSchema`) | Built ([`services/cloud-api`](../services/cloud-api/README.md#walker-store)); deployed on Render, checked 2026-10-24 |
| `POST /devices/{id}/actions/{actionId}/status` | Pi | Report local acceptance, progress, completion, cancellation, or fault | Body specified (`ActionStatusReportSchema`), route not built; no route creates an action yet |

**As built (demo mode):** a session's id is in the URL; a separate secret in an `httpOnly`, `SameSite=Strict` cookie scoped to `/api/v1/onboarding` proves the caller started it, and a missing or wrong secret reads as `404`, the same as an unknown id. Sessions live in Supabase Postgres when the server has its three Supabase variables, otherwise in server memory; either way they are deleted an hour after the last change. Postgres keeps only the secret's SHA-256, and only the server reaches demo rows. Without Supabase, a production server answers `POST /onboarding/sessions` with `503 unavailable` unless `ONBOARDING_ALLOW_MEMORY_STORE=true`, because instances don't share memory. With Supabase, it also answers `503` while 500 demo sessions are live, and a turn gets `422 invalid_request` once a conversation reaches 200 turns (except `skip_rest`, so it can still be saved). Store details: [`services/cloud-api`](../services/cloud-api/README.md#supabase-store). Turn inputs are `text` (answers the current question), `answer` (`question_id`, `option_ids`, optional `text`), `skip`, `skip_rest` and `revisit`. Responses carry `ack`, a short acknowledgement (`null` when the agent's question follows straight on without one), besides `assistant_text`, which is the acknowledgement and the next question together, written to read as one chat message ("Got it, knowing what's in your way. Where will you be using your walker?"). The person's own turns are the chosen option labels, written in the first person, then any typed words; a skip records `Skip` and skipping the rest `Show me my walker` (`SKIP_REPLY`, `SKIP_REST_REPLY` in `services/cloud-api`). Typed words that also answer a later topic ("at home", typed for the first question, answers where the walker is used) mark that topic answered, so it isn't asked; editing or removing those words asks it again. Both engines apply the same rule ([covered topics](../services/cloud-api/README.md#how-the-deterministic-conversation-reads)). With `ONBOARDING_ENGINE=agent` and either `ANTHROPIC_API_KEY` (Claude) or `GEMINI_API_KEY` (Google's Gemini) set on the server, an LLM agent reads `text` and `answer` turns; the wire format is the same either way. Under the agent, `current_question` is still a bank topic (`id` from `QuestionId`) with the bank's `selection` and `text_label`, but its `prompt` and `detail` are the model's words and `options` can be a subset of the bank's, in the model's order; a multiple-choice topic can come back once as a clarifying follow-up, whose answer is added to the earlier one. A turn the model can't complete (refusal or bad reply twice, API error, 15-second deadline) is answered by the deterministic engine instead of failing, so there is no `503` for a model outage on this route. Under the agent, the assistant turns that reply to an answer carry `answered_by`: `"model"` when the model worded them, `"fixed"` when the deterministic engine answered because the model's reply didn't come through; the field is absent with the deterministic engine and on skips and revisits, which never ask the model. The web page shows it as a quiet note under each reply ("Read by Gemini"), so a fallback turn is never passed off as the model's. Because a model turn takes seconds, a turn's save is conditional on the revision it started from (one Postgres transaction with the Supabase store): of two overlapping turns, the second gets `409 revision_conflict`, and a retried `client_turn_id` gets the stored response. Details: [`services/cloud-api`](../services/cloud-api/README.md#onboarding-agent). Errors use `{ "error": { "code", "message", "trace_id", "session"? } }`; a `409 revision_conflict` includes the current session so the client can recover.

**Sign-in and ownership (as built):** the onboarding routes take either of two proofs, and the session's `kind` says which one owns it.

- **Signed in** (Supabase Auth, passwordless): `/login` emails a one-time code and a link (`/auth/confirm`, which redeems it only when its **Sign in** button is pressed); either sets the Supabase session cookies (`sb-…-auth-token`, `httpOnly`, `SameSite=Lax`, `Secure` in production). `proxy.ts` refreshes an expiring access token before each page. Route handlers verify the user with `getClaims()` and read and write account sessions through a database client carrying that user's own token, so Postgres row-level security applies. An account session (`kind: "account"`) is reachable by its owner from any device and by nobody else; signed out, it reads as `404`.
- **Demo** (no account): the session secret in the `walker_demo` cookie, as above. A demo session needs that cookie even when the visitor is signed in, and a signed-in user's id never opens someone's demo session.
- Which kind `POST /onboarding/sessions` creates is decided by the consent the page showed (the one-line notice under the demo's text box), not by whether the visitor happens to be signed in at that moment.

Account pages that aren't part of this API: `/setups` lists a signed-in user's confirmed setups (newest first) with **Delete setup** (deletes the setup and its session) and **Delete my account** (deletes the Supabase user, which cascades to every row). Both are server actions that check the user first.

**Start request consent:** `consent` is `{ "demo_data_notice": true }` or `{ "account_data_notice": true }`, naming the notice the start screen showed, and it picks the session's `kind` (`demo` or `account`), so a session is never kept longer than its notice said. `account_data_notice` needs a signed-in user (`401 unauthenticated` otherwise). A confirmed `configuration.source` is `demo` or `account`; account setups are numbered 1, 2, 3… per user.

An external caller (including a future Codex tool or another app) can call the onboarding agent through the same authenticated session/turn routes. Build a narrow server-side wrapper or OpenAPI description that exposes `start_onboarding`, `send_onboarding_turn`, `get_recommendations`, and `confirm_selection`. The wrapper must pass the end user's auth, never a broad service key. There is no public anonymous tool that can read another person's profile. A demo integration may use ephemeral sessions with no persistent personal data.

Example text turn request:

```json
{
  "client_turn_id": "c38d8b0d-1d17-4baf-9341-f9f93a83b50b",
  "input": { "type": "text", "text": "I have trouble gripping small objects." },
  "last_seen_revision": 2
}
```

Example response (or final streamed event):

```json
{
  "session_id": "session-id",
  "revision": 3,
  "assistant_text": "Would help with picking up objects be useful, or would you rather focus on walker controls?",
  "profile_patch_proposal": { "goals": ["pick up small objects"] },
  "recommendations": [
    { "module_id": "manipulation.arm", "status": "consider", "reason": "Could help with a specific grasping task", "limitations": ["Needs supervised operation"] }
  ],
  "needs_user_confirmation": true
}
```

The profile patch is a proposal until confirmed. Use server-side session revision checks to avoid two tabs overwriting each other. Never place unverified model text directly into a device configuration.

**Walker assistant routes (built; deployed on Render 2026-10-24).** The Pi and the owner's page use separate proofs: device routes take `Authorization: Bearer <credential>`, where the credential is 32 random bytes in base64url, shown once at pairing, with only its SHA-256 kept. Page routes take the `walker_owner` cookie (`httpOnly`, `SameSite=Strict`, path `/api/v1/walkers`). Neither works on the other's routes, and an unknown or someone else's id reads as `404`, the same either way. Errors use `{ "error": { "code", "message", "trace_id", "proposal"? } }` with the codes in `WalkerErrorCodeSchema` and the HTTP status for each in `WALKER_ERROR_STATUS` (`400` invalid request or pairing code, `401`, `404`, `409` walker limit or proposal closed, `429` pairing locked or rate limited, `503`). A Pi that gets `401 unauthenticated` asks to be paired again. `GET /api/v1/health` (no proof) answers `200` once the walker store is ready and `503` while its database can't be reached; Render uses it as the health check. On Render the wrong-code lockout is keyed on Cloudflare's `CF-Connecting-IP` (an IPv6 client by its /64), because a client can forge the leftmost `X-Forwarded-For` entry there; the window slides, lifting 10 minutes after the oldest of the 5 wrong tries. `POST /walkers/pairing-codes` refuses a request another site made the browser send (`Sec-Fetch-Site`), so no other page can replace the owner cookie. Turns are idempotent by `client_turn_id`. The only change a turn can propose is the walker's alert cues (`cues_change`), confirmed by id from the walker's Confirm button or the page, never by voice. Rules: [walker assistant guide](subsystems/walker-assistant.md#the-shared-nouns).

## Sophi Circle and the walker screen (proposed, not built)

**Status: proposed, not built.** The schemas are written in [`circle.ts`](../packages/contracts/src/circle.ts) and tested as schemas only. No route, table, Pi code or page uses them yet. Everything below specifies what the next pieces (cloud, Pi, web app) will build. The screen's drawing package (`packages/walker-screen`, a separate change) renders fixtures only.

**What it is.** The walker's own screen belongs to the person who walks with it ("Nan" below). Family and caregivers join her circle from a web app on their phones. Family can send short messages and suggest one change at a time to her screen or to Sophi's voice. Nothing reaches her walker until she presses Confirm on it. It is a separate system from the walker assistant above: today's turns, proposals, Confirm and heartbeat don't change, and no `walker.ts` or `device.ts` shape changes (a test pins them, [`unchanged-shapes.test.ts`](../packages/contracts/test/unchanged-shapes.test.ts)). So today's deployed Pi and server keep working whichever is deployed first.

**The rule everything rests on: only a call made with the walker's device credential can accept a join or a suggestion.** That call comes from the handle's Confirm or the screen's Confirm button, both through the Pi. No owner-cookie or member-cookie route accepts anything, so the rule holds by construction. The cloud piece adds a test that an owner-cookie accept is refused.

### Callers and proofs

| Caller | Proof | Path prefix |
| --- | --- | --- |
| The walker (Pi) | `Authorization: Bearer <device credential>`, as today | `/api/v1/devices/{id}/circle` |
| The owner (the browser that paired) | The `walker_owner` cookie. Its path is `/api/v1/walkers`, so owner routes must sit under it | `/api/v1/walkers/{id}/circle` |
| A member (family or caregiver), in the web app | A new `walker_member` cookie: `httpOnly`, `SameSite=Strict`, `Secure` in production, path `/api/v1/circle`. It holds a random secret, and the server keeps only its SHA-256. One membership per browser | `/api/v1/circle` |

None of the three proofs works on another's routes. An unknown id, or one that belongs to someone else, reads as `404`. Errors use `{ "error": { "code", "message", "trace_id", "item"?, "settings"? } }` with `CircleErrorCodeSchema` and `CIRCLE_ERROR_STATUS`. This is a separate list, so `WalkerErrorCodeSchema` is unchanged:

- `400` `invalid_request`, `invite_code_invalid`
- `401` `unauthenticated`
- `403` `not_allowed` (a caregiver sending or suggesting)
- `404` `not_found`
- `409` `circle_full`, `walker_offline`, `suggestion_waiting` (with the member's own waiting suggestion, as the same projection the member routes return), `unchanged`, `item_closed` (walker only: with the item as it stands), `settings_conflict` (walker only: with the current settings), `message_limit`
- `429` `invite_locked`, `rate_limited`
- `503` `unavailable`

### Routes

Device routes (the walker):

| Route | Request → response | Notes and errors |
| --- | --- | --- |
| `GET /devices/{id}/circle` | → `CircleFeedResponseSchema` | Polled every 2 s (`CIRCLE_FEED_POLL_MS`). Carries `device_id`, her settings and voice, the owner's name, her members, every live message for this walker (oldest first), and at most one waiting item: a suggestion or a join, oldest first. The rest wait their turn on the server. See "The feed" below |
| `POST /devices/{id}/circle/items/{item_id}` | `AnswerCircleItemRequestSchema` (`accept` or `ignore`) → `AnswerCircleItemResponseSchema` (the item, settings, voice) | The only accept. Accepting a screen change adds a settings version, or names the current one if her settings already had that value. Accepting a voice change sets the voice. A join is accepted on her second press. `ignore` is her Not now tap, or a join whose second press never came. Anything not waiting gets `409 item_closed`, so a retried accept that already won sees `accepted`. A `404` means the item is gone (its member was removed or left): the Pi shows and says "Nothing changed." |
| `PUT /devices/{id}/circle/settings` | `OwnSettingsRequestSchema` (`base_version`, all five choices, voice) → `OwnSettingsResponseSchema` | Her own change from My screen, or "Change it back". An old `base_version` gets `409 settings_conflict` with the current settings; the walker puts her change on top and sends it again (her last press wins) |
| `DELETE /devices/{id}/circle/members/{member_id}` | → `204` | She removed someone (two taps on her screen). Deletes their messages and suggestions at once |
| `POST /devices/{id}/circle/messages/{message_id}/opened` | No body → `MessageOpenedResponseSchema` | She opened it (by Confirm or the Read it button), or it was read aloud on arrival because she turned that on |
| `POST /devices/{id}/circle/screen` | `ScreenReportRequestSchema` → `204` | Sent whenever a field changes, and retried until it gets a 2xx. It says whether a screen page is connected, the settings version the page last drew, whether a change of hers was pending on top of it, and the message ids the walker holds (those read as delivered). `settings_version_drawn` is null while a change of hers is pending (what's drawn then is no server version), so a member's "On the walker", which comes only from it, can never claim something her screen isn't showing. Which item is on her screen is never sent: nothing in the cloud needs it, and it would say what she is doing |
| `GET /devices/{id}/circle/voices/{voice}/sample` | → `VoiceSampleResponseSchema` (WAV, as `SpeechSchema`) | "This is how I'd sound." in that voice, synthesised once and cached on the server. Played when a voice suggestion is on screen |

Owner routes (the /walker page):

| Route | Request → response | Notes and errors |
| --- | --- | --- |
| `POST /walkers/{id}/circle/invites` | `CreateInviteRequestSchema` (the person's name, up to 12 characters; their role; the owner's own name, which is how the walker names the owner) → `CreateInviteResponseSchema` | A one-time 6-digit code, good for 10 minutes (`CIRCLE_INVITE_TTL_MS`). It shows on the page only, never on the walker. Refuses a request another site made the browser send (`Sec-Fetch-Site`), as pairing codes do. `409 circle_full` at 8 members or 4 open invites |
| `GET /walkers/{id}/circle` | → `OwnerCircleResponseSchema` | Members, open invites (with their codes) and joins waiting for her. No messages or suggestions: those are hers |
| `DELETE /walkers/{id}/circle/members/{member_id}` | → `204` | The same as her own removal |
| `DELETE /walkers/{id}/circle/invites/{invite_id}` | → `204` | Cancels an unused code |

Member routes (the web app):

| Route | Request → response | Notes and errors |
| --- | --- | --- |
| `POST /circle/join` | `JoinCircleRequestSchema` (the code, and the notice the app showed) → `MemberHomeResponseSchema` (`waiting`) | Needs no cookie, and sets one. Refuses a request another site made the browser send (`Sec-Fetch-Site`), as pairing codes do, so no other page can replace the member cookie. The member's name and role come from the invite, never from them. Wrong codes share the pairing lockout's limits (`PAIRING_MAX_WRONG` within `PAIRING_LOCK_WINDOW_MS`, keyed the same way): `400 invite_code_invalid`, then `429 invite_locked`. Redeeming a code makes a join item for her walker, which lapses after 5 minutes |
| `GET /circle` | → `MemberHomeResponseSchema` | One of `waiting`, `no_answer` (then the cookie stops working) or `member`. A member sees the walker's name (null when it has none: the app then says "the walker"), Online/Offline and last seen, and the alerts in force. Family also see her screen's choices and voice, current and as last drawn on the walker, with no versions or times (the app's "as of" comes from `last_seen_at`); caregivers see part health instead, and the response is refused if it carries both or neither. Members get projections, not the server's rows: their own suggestions as `{item_id, change, created_at, expires_at, outcome}` (no item state, so not whether she tapped Not now) and their own messages with an `outcome` word only (no delivered or opened times). Both see her circle's names. Never her conversation, location, activity or what is on her screen. The app polls it every 1.5 s while something is waiting, otherwise every 5 s |
| `POST /circle/suggestions` | `CreateSuggestionRequestSchema` (one change: `text_size`, `theme`, `greeting` or `voice`) → `MemberSuggestionViewSchema` | Family only (`403 not_allowed`). `409 walker_offline` ("Nan's walker is offline. Try again when it's back."); `409 suggestion_waiting` (one waiting per member, returned in the body); `409 unchanged`. Idempotent by `client_suggestion_id`. Lapses after 5 minutes (`CIRCLE_ITEM_TTL_MS`). There is no suggestion for captions, reading aloud or her circle: those are hers alone |
| `POST /circle/messages` | `SendMessageRequestSchema` (1 to 30 characters, one line) → `SendMessageResponseSchema` | Family only. `409 message_limit` at 20 live messages for the walker, or 3 unopened from this member. Idempotent by `client_message_id`. Waits on the server while the walker is offline |
| `DELETE /circle` | → `204` | Leave the circle. Deletes this member's messages and suggestions now |
| `GET /circle/voices/{voice}/sample` | → `audio/wav` | The same cached clip, labelled "Sample" in the app |

What a member's phone says comes from `suggestionOutcome`, one shared function, so the server and the app agree:

- `waiting`: "Waiting for Nan". The phone never says whether it is on her screen or queued behind something, so it can't tell what she is doing.
- `offline`: still waiting, and her walker is offline.
- `accepted`: she accepted it and her screen hasn't drawn it yet.
- `on_the_walker`: her screen reported drawing the version that carries it. For a voice, accepted.
- `no_answer`: "No answer. Nothing changed." Ignored and expired read the same. (Removing a member deletes their items, so there is no withdrawn state.)

Messages read `waiting` ("Waiting for the walker"), `delivered` ("Delivered to the walker", once the walker's screen report lists it) and `opened`. None of these is styled as an error.

### The feed: polling and `404`

- The new Pi polls `GET /devices/{id}/circle` every 2 s; the old Pi never calls it. A suggestion should reach the walker within about 2 to 3 s (to be measured).
- The feed never touches the link state. Online/Offline comes from the heartbeat only, and the heartbeat handles `401` as today.
- `404` means "this server has no circle yet" (an old server, or a rollback). The Pi keeps her applied settings, shows no circle items or messages, deletes nothing, and asks again after 60 s (`CIRCLE_FEED_ABSENT_RETRY_MS`).
- Any other failure (a timeout, a `5xx`) keeps the cache as it is and retries at the normal interval.
- The Pi keys its cache by `device_id` and clears it when that changes, so re-pairing the walker (the reset between judges) starts the walker with an empty circle.
- The feed is the whole truth. A cached message missing from the feed is deleted on the walker; that is how a removal, or the 24-hour limit, reaches its disk.

### Who owns which state

| State | Owned by |
| --- | --- |
| Members, invites, joins and suggestions (5 minutes to answer), messages (24 hours), screen settings versions, the voice choice, the last screen report | Cloud, in new `circle_*` tables (migration 0003, proposed) |
| Her applied screen settings (including a change not yet sent), cached messages, the circle | Pi, on disk, keyed by device id, for offline use |
| Which screen state shows, Talk, the link, obstacles, cues, the Confirm timing rule, arbitration | Pi. The screen page decides nothing |
| What the screen has actually drawn | The screen page, which tells the Pi (`ScreenShown`) |
| Button presses | The ESP32 hands, as today |

### Accepting on the walker: timing, two presses, arbitration

These are Pi rules. They are written into the contract's constants and comments so that the screen, the Pi and the docs agree.

- **The gate (`SCREEN_ACCEPT_GATE_MS`, 1.5 s).** For a circle item, a Confirm press counts only 1.5 s after the later of two moments: (a) the screen page reporting that it drew that item's revision (`ScreenShown` names the revision and the item id), and (b) the spoken prompt finishing. With no screen page connected, (b) alone opens the gate, so a dead kiosk never blocks a join. An earlier press gets a short low tone and "One moment" (spoken as `circle_prompt`, and shown as `one_moment`). An obstacle or Talk interrupts: the Pi forgets the item's "shown", and when the screen returns to the item with a new revision, the gate starts again.
- **Ignore after every settle (`SETTLE_IGNORE_MS`, 2 s).** After any Confirm settles anything, today's model offers included, presses are ignored for 2 s, each with a low tone. One press settles one item.
- **Joins take two presses.** The first press arms the join, and the screen shows "Press Confirm again" as its own revision with its own gate. Only the second press calls accept. With no second press within 30 s (`JOIN_ARMED_TTL_MS`), the Pi settles it as `ignore` and shows and says "Nothing changed."
- **Saying no.** A suggestion or a join has a Not now button (`not_now`, which the Pi answers `ignore`). On the handles, doing nothing is the way to say no: the item lapses after its 5 minutes. Talk never dismisses it; she can ask Sophi something and the item is still there afterwards.
- **Arbitration: one thing on screen at a time.** An obstacle or her own Talk comes first. Then today's model offer, which keeps the screen and Confirm until it is settled. Then a circle item, then a message notice, then the clock. A model offer that arrives by heartbeat (typed on the owner's page) while a circle item is on screen waits behind it; only an offer from her own Talk turn takes over. A suggestion waiting behind a model offer simply waits, within its own 5 minutes. Confirm during an obstacle screen settles nothing.
- **Today's model offers keep today's Confirm** (no gate), apart from the 2 s ignore after a settle. Confirm with nothing waiting still plays today's "nothing to confirm" sound.
- **Every essential action has a handle path.** Confirm accepts a suggestion or a join, and on "Message from Cooper" it shows the message and reads it aloud. The main line of every screen is spoken when it appears. Touch (the large buttons: Read it, Not now, Change it back, My screen) is for when she is parked or seated. Removing someone is touch only (two taps), or the owner's page.

### Speech, logs and the conversation

**One logging rule, for the Pi's screen server and the cloud alike:** never log `ScreenState` bodies, message text, heard words or replies, in full or in part. Log lengths, kinds, ids and outcomes only. (The Pi's logger already logs replies by length; the simulator, whose replies are the fake cloud's, is the only exception, as today.)

Every line the Pi speaks for the circle names its kind (`CircleSpeechKindSchema`):

- `circle_prompt`: the Pi's fixed circle lines. These are the join and suggestion prompts, "Press Confirm again to let Cooper in.", "One moment", "Done. Larger text is on.", "Nothing changed.", and a voice suggestion's sample clip.
- `circle_message`: a member's message, read aloud. Logged by length only, never its words (like `reply` in the Pi's logger).

Neither kind is ever queued as a heartbeat `WalkerEvent`, so neither reaches the walker's conversation lines or the owner's page. Messages and suggestions never go to a model. The server applies the voice choice when Cartesia voices her replies; messages and offline lines use the walker's own voice, which doesn't change.

### The walker screen's local contract (Pi ↔ page on 127.0.0.1)

- The Pi serves the screen page and a Server-Sent Events stream on `127.0.0.1` only, so the screen keeps working with no internet (beat 6). Each `state` event's `data:` is a `ScreenStateSchema` object: a `revision` (one higher for each state sent since the Pi started), the content (`screen`: which state, and what it shows), her settings as applied now (`version` is the server version they are built on, and `pending_local` says a change of hers sits on top that the server doesn't have yet), and the status strip (link, simulator, local clock or none).
- The page posts `ScreenShownSchema` to `POST /screen/shown` after drawing a revision, with its circle item id and settings version. It posts `ScreenPressSchema` to `POST /screen/press` for a tap; the Pi ignores a press on an older revision. A touch `confirm` goes through exactly the checks the handle does.
- **A per-boot token.** 127.0.0.1 is reachable from any page in a browser on the same machine (the simulator runs on a laptop). So the Pi makes a random token when it starts, embeds it in the page it serves, and requires it on every request: as a header (`X-Screen-Token`) on the POSTs, and as a query parameter on the event stream, because `EventSource` can't set headers. The Pi also refuses a request whose `Host` isn't `127.0.0.1:<port>`, or whose `Origin` (when present) isn't the page's own.
- The Pi's listener for the screen is wrapped so it can never throw into Talk or the heartbeat.

### Consent, retention and deletion

- **Consent.** A member joins only after the app shows "Messages show on Nan's walker screen when she opens them, and are deleted after 24 hours." (`consent.circle_data_notice`). She consents to each member with two Confirm presses. Nothing a member sends shows until she opens it, unless she turned on reading aloud. Her circle screen lists everyone, and says the owner can read her conversations on the Sophi website. A switch for that is not in this version and is never claimed.
- **Retention.** Messages: 24 hours after sending, opened or not (`CIRCLE_MESSAGE_RETENTION_MS`). Suggestions and joins: 5 minutes to answer, deleted 24 hours after they were made. Invites: 10 minutes, one use. Screen reports: only the last one. Settings versions: kept with the walker.
- **Deletion.** Removing a member (from her screen or the owner's page) deletes their messages and suggestions on the server at once, and the next feed deletes them from the walker's cache. A member leaving does the same. Forgetting the walker deletes its whole circle. The member's cookie then answers `401`.
- **Access control.** The server is the only database client and scopes every query by device, owner or member, as the walker tables do. If a circle table is ever exposed to Supabase clients, it needs row-level security first.

## Pi ↔ cloud action protocol

The assistant returns **intent**, never raw joint angles from the general conversation agent. A Pi action request might be:

```json
{
  "action_id": "9c7e35ad-7602-4c6a-8a29-306f69599edc",
  "kind": "manipulation.pick_place",
  "expires_at": "2026-10-23T20:00:00Z",
  "device_configuration_version": 7,
  "parameters": { "object_label": "cup", "destination_label": "tray" },
  "requires_user_start": true
}
```

The Pi verifies action ID, expiry, configuration version, capability, current state, and user start. The manipulation controller produces local bounded trajectories. The Pi reports `accepted`, `rejected`, `started`, `progress`, and terminal `completed`/`cancelled`/`failed` events. On uncertain retry, query action status before resending. `stop` and `cancel` are local controls; cloud cancellation is supplementary.

**Specified, v1** ([`device.ts`](../packages/contracts/src/device.ts), not implemented): `ActionRequestSchema` accepts only `manipulation.pick_place`, with `object_label` and `destination_label` (at most 64 characters each, treated as data to match against camera detections) and `requires_user_start` fixed to `true`, so no v1 request can skip the user's start. `ActionStatusReportSchema` carries `action_id`, a per-action `seq` (so a retried report is recognisable), `status`, `reported_at` and, for `rejected`, `cancelled` and `failed` only, a `reason` (`expired`, `configuration_mismatch`, `capability_unavailable`, `stale_sensors`, `stopped`, `busy`, `user_cancelled`, `cloud_cancelled`, `fault`). `canFollowActionStatus` encodes the order: `accepted` or `rejected` first; `started`, `cancelled` or `failed` after `accepted`; `progress` (repeatable), `completed`, `cancelled` or `failed` after `started`. Each action ends in exactly one terminal status (`rejected`, `completed`, `cancelled`, `failed`) and nothing follows it.

## Pi ↔ ESP32 USB serial

Use one USB serial port per controller. Native USB CDC is possible on some ESP32 variants; other boards expose a USB-to-UART bridge. Confirm the actual board before choosing firmware settings. Assign stable IDs from a provisioned device/module ID plus USB serial/udev mapping; never rely on `/dev/ttyUSB0` staying constant. Cameras and arm drivers may have their own USB protocols and are **not** forced through this ESP32 envelope.

**Framing proposal:** UTF-8 JSON Lines (`\n` terminated), maximum 1 KiB per line for control/sensor messages, version `1`. Simple for a hackathon and human-readable in a serial monitor. If bandwidth is insufficient after measurement, replace the payload codec while retaining the logical schema. Reject malformed/oversize lines and resynchronize at the next newline. Use a monotonic receive time on the Pi to judge freshness; do not rely solely on the ESP32 clock.

Example hello and report:

```json
{"v":1,"type":"hello","module_id":"hand-left-01","module_type":"hand","seq":0,"capabilities":["button.primary","trigger","haptic"]}
{"v":1,"type":"hand.input","module_id":"hand-left-01","seq":42,"uptime_ms":156205,"button":"primary","edge":"pressed","trigger":0.72}
{"v":1,"type":"perception.zones","module_id":"tof-front-01","seq":83,"uptime_ms":26851,"zones":[{"name":"front_left","mm":610,"quality":"valid"},{"name":"front_right","mm":null,"quality":"invalid"}]}
```

Example bounded command and acknowledgement:

```json
{"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":74,"request_id":"cue-172","pattern":"near_obstacle","duration_ms":400}
{"v":1,"type":"ack","module_id":"hand-left-01","seq":75,"request_id":"cue-172","result":"accepted"}
```

Example request for a hello (the Pi sends it when it opens a port), then heartbeat and error (a line the module could not read):

```json
{"v":1,"type":"hello.request","module_id":"any","seq":0}
{"v":1,"type":"heartbeat","module_id":"tof-front-01","seq":84,"uptime_ms":27002,"health":"ok"}
{"v":1,"type":"error","module_id":"hand-left-01","seq":77,"code":"malformed"}
```

**Specified, v1** ([`serial.ts`](../packages/contracts/src/serial.ts)). Implemented by the Pi service ([`devices/pi`](../devices/pi/README.md)) and the ESP32 firmware ([`firmware/`](../firmware/README.md)). One hand ESP32 and the Pi service have run together on their target hardware; the obstacle firmware has not. Fixtures any implementation can run: [`serial-v1.valid.jsonl`](../packages/contracts/test/fixtures/serial-v1.valid.jsonl) (includes every example line above) and [`serial-v1.invalid.json`](../packages/contracts/test/fixtures/serial-v1.invalid.json) (each bad line with the expected problem code).

- Types: `hello`, `heartbeat`, `hand.input`, `perception.zones` (module → Pi), `hello.request` and `haptic.play` (Pi → module), `ack` (module → Pi), `error` (either way). The Pi sends `hello.request` when it opens a port, so a module that didn't reboot when the Pi service restarted still announces itself; the module answers with a `hello` and keeps its `seq` running. Its `module_id` is `any` (`SERIAL_ANY_MODULE`, one module per port) or the module's own id, and no module may be provisioned as `any`. `module_id` names the sender on a module's message and the destination on a Pi command. `uptime_ms` is required on `heartbeat`, `hand.input` and `perception.zones`, optional on `hello`, `ack` and `error`, and absent on `haptic.play`.
- Every object is strict: a field v1 does not list is rejected, not ignored. Add a field to the schema (and update the receiver) before any sender emits it.
- 1 KiB means at most 1024 UTF-8 bytes **including** the `\n`, so a 1024-byte receive buffer holds any valid line. `parseSerialLine` checks size, then JSON, then `v`, then `type`, then fields, and returns one problem code (`oversize`, `malformed`, `unsupported_version`, `unknown_type`, `invalid_field`) without throwing. `ack.reason` and `error.code` use the same codes plus `unsupported` (the module lacks that capability) and `overflow` (a bounded queue was full).
- `hand.input` sends a `button` with its `edge`, a `trigger` value from 0 to 1, or both. `button` names one the module declared as `button.<name>` in its hello.
- The two hand ESP32s share firmware, so GPIO32 reports `button: "talk"` on both. The Pi maps that wire event from a `hand-left-*` module to the Confirm action; a right-hand module keeps the Talk action. The serial schema is unchanged. This side mapping is implemented in the Pi service and still needs a physical two-handle check.
- Zone `quality` is `valid` or `invalid`; `mm` is a number exactly when the reading is valid. Up to 16 uniquely named zones per line.
- `haptic.play`: the pattern must be one of `confirmation`, `recording`, `near_obstacle`, `error`; shape and strength are fixed per pattern in firmware, and no waveform or intensity travels over the wire. `duration_ms` is 1 to `HAPTIC_MAX_DURATION_MS` (1000, a placeholder until the actuator is bench-tested). Only the Pi sends it, from its local cue policy or as feedback for a button press on that same hand; cloud or model text never becomes a haptic command directly. The cue stops when its duration ends; a newer `haptic.play` replaces the one playing instead of queueing (proposal). On USB disconnect or a watchdog reset the firmware stops the cue, as the firmware guide requires.
- Not specified yet: the Pi's reply to `hello` beyond `hello.request` (protocol version and requested report rate), the heartbeat timeout after which the Pi marks a module unavailable, and the near/far thresholds. The Pi service ([`devices/pi`](../devices/pi/README.md)) uses placeholders until they are measured: `unavailable` after 3 s without a heartbeat, near under 500 mm, clear over 650 mm, a reading fresh for 500 ms. It sends no reply to `hello`. The 1 s heartbeat and 10–20 Hz ToF rate are exported as proposals (`SERIAL_HEARTBEAT_INTERVAL_MS`, `SERIAL_TOF_REPORT_HZ`), not enforced per line.

Firmware sends a hello on boot and on each `hello.request`, then heartbeat/health (proposed every 1 second) and events. Pi responds to hello with protocol version and requested report rate. Sensor reports should be bounded (proposed 10–20 Hz for ToF and edge-triggered controls); tune from measurements. Haptic commands expire after their duration and cannot be queued indefinitely. Sequence numbers detect drops; a reboot resets `seq` and is signaled by a new hello/boot ID. If heartbeats stop, Pi marks the module unavailable and acts on stale state conservatively.

**Safety path:** a physical stop must interrupt actuator power or driver enable through a hardware path independent of USB serial and cloud software. A Pi process may additionally issue a stop. Do not implement the physical stop as only a JSON message.

## Sensor and voice data

The Pi publishes a capability manifest with module IDs, protocol/firmware versions, and current availability. A sensor snapshot sent to cloud includes zone, value, quality, capture time, and expiry; omitted or stale data means unknown. Both are **specified, v1** in [`device.ts`](../packages/contracts/src/device.ts) (not implemented): `CapabilityManifestSchema` lists each detected part by catalog `module_id`, hardware `instance_id`, firmware and serial protocol versions (null where the part has none), `health` (`ok`, `degraded`, `fault`, or `unavailable` when the Pi stopped hearing from it), fault codes, `observed_at` and `simulated` (a fake adapter stands in for the part), plus `simulator` for a whole walker simulated on a computer. Device v1 is unreleased until a walker ships, so fields can still be added, with the Pi and cloud updated together. The Pi also reports the parts it hosts itself, under fixed instance ids with `protocol_version: null`: the coordinator as `base.walker` (`pi-coordinator`, or `sim-coordinator` in the simulator), its USB mic and speaker as `voice` (`pi-usb-audio` / `sim-audio`), and its GPIO buttons as `controls.hand` (`pi-gpio-buttons`) only when the installer declares them wired. `SensorSnapshotSchema` holds per-zone `mm`, `quality`, `captured_at` and `expires_at`, and `readZone(snapshot, zone, now)` returns `unknown` for a missing, invalid or expired zone, never clear. Store high-rate raw streams locally only if needed for debugging and consented. The cloud normally receives a compact snapshot, not continuous ToF samples.

Audio clips and camera frames use bounded uploads to private storage or authenticated streaming endpoints, with MIME type, duration/size checks, consent, and a short expiry. Return opaque media references in API JSON. Never log raw media URLs or location coordinates in ordinary application logs. Speech output carries text as a fallback; voice cannot be the only way to understand a reply.

## Failure semantics

| Failure | Expected behavior |
| --- | --- |
| Cloud timeout / network loss | Pi ends the pending turn with an offline cue; local controls and alerts continue; no delayed motion starts on reconnect |
| ESP32 unplug / malformed frames | Pi marks capability unavailable and raises a user-visible service status; stale obstacle values are unknown |
| Camera unavailable | Manipulation request is rejected or paused; no blind continuation |
| Arm/lift fault or limit hit | Driver is disabled/stopped, stop reason logged, user informed, manual reset/inspection required |
| Duplicate command | Same action ID produces same status; never repeats physical motion |
| Invalid auth/ownership | API rejects without revealing another user's device or session |

## Implementation checklist

When writing `packages/contracts/`, add schemas for module catalog, profile, configuration, serial envelope, capability manifest, sensor snapshot, action request/status, and agent tool arguments. Written so far: catalog, onboarding profile and configuration, serial envelope, capability manifest, sensor snapshot, action request/status. Still to write: agent tool arguments and the Pi's reply to `hello`. Define compatibility rules and fixtures. Document exact byte limits, timeout values, and error codes after device measurements. The examples above are contract proposals, not permission to skip validation.
