# Asking for help: expected results (written before the code)

The server piece of [docs/subsystems/help.md](../../../../docs/subsystems/help.md): the store (memory, Postgres, SpacetimeDB), the help methods (the walker's in `WalkerService`, the phones' in `CircleService`, shared rules in `help.ts`), the routes in `apps/web`, and the voice path. Tests: `help.test.ts` (services and stores, all three stores), `turn.test.ts` (voice path, memory and Postgres), `apps/web/test/help-routes.test.ts` (HTTP), `care-db-views.test.ts` (`my_help`).

Revised 2026-10-24 after the contract's review (c9aba72): `told` became `sent_to`, people are `{ member_id, name }`, `shown_to` is new, a device ask while one is open records its id as an alias, `closed.by` replaces `by_name`, the walker's routes answer in the walker envelope.

**Seed (messy, used by most rows):** a paired, online walker named "Rose's walker" (13 characters, longer than a circle name). Her phone Rose (`walker_user`). Caretakers, in joining order: Maya (approved first), a second caretaker also named "Maya" (approved second: names repeat, ids don't), Ben (typed a code, still waiting), Cy (approved, then removed before the ask). A second walker with its own caretaker Zed, whose requests must never show up here.

Clock: a fake clock (`now` injected); nothing sleeps.

## Asking

| # | Caller, state | Expected |
| --- | --- | --- |
| A1 | walker (Bearer), `source: handles`, seed | `201`, `source: handles`, `sent_to` = both Mayas by member id in joining order (not Ben waiting, not Cy removed), `shown_to: []`, `coming: []`, `closed: null`, `age_seconds: 0` |
| A2 | walker, same `client_help_id` again | `200`, the same `help_id`, nothing new stored |
| A3 | walker, new `client_help_id` while A1 is open | `200`, A1's request (one open per walker); the new id is now an alias of A1 |
| A3b | after A1 closes, A3's id again (a retry after a lost answer) | `200`, A1 as closed, not a new request |
| A4 | her phone, `POST /circle/help`, while A1 is open | `200`, A1's request |
| A5 | her phone, no request open | `201`, `source: phone`, `sent_to` both Mayas |
| A6 | a caretaker's phone `POST /circle/help` | `403 not_allowed` (circle envelope), nothing stored |
| A7 | waiting Ben's phone `POST /circle/help` | `403 not_allowed` |
| A8 | walker with no approved caretaker (only her phone, and a waiting one) | `409 no_caretaker` in the walker envelope, nothing stored (dump has no request), log outcome `no_caretaker`; her phone gets `409 no_caretaker` in the circle envelope |
| A9 | walker, after A1 closed, A1's `client_help_id` again | `200`, A1 as closed |
| A10 | walker, after A1 closed, new id | `201`, a new request; A1 stays as it was |
| A11 | wrong or missing Bearer; another walker's id with this walker's Bearer | `401 unauthenticated`; `404 not_found` (walker envelope) |
| A12 | `source: phone` from the walker, or extra fields | `400 invalid_request` |
| A13 | voice ask with `source: voice` | `201`, `source: voice` |
| A14 | the walker's caretakers all removed after the ask, then the same `client_help_id` | `200`, the request (`sent_to` still names them) |

## Answering

| # | Caller, state | Expected |
| --- | --- | --- |
| B1 | Maya `coming` on the open request | `200`, `coming` = [Maya] |
| B2 | Maya `coming` again | `200`, unchanged (each phone once, no new revision in SpacetimeDB) |
| B3 | the second Maya `coming` after the first | `coming` = both Mayas, first answer first, told apart by member id |
| B4 | her phone `coming` | `403 not_allowed` |
| B5 | waiting Ben `coming`, `okay` | `403 not_allowed` |
| B6 | a caretaker approved after the ask: `GET /circle` | sees it, not in `sent_to`; is added to `shown_to`; `coming` adds them |
| B7 | her phone `okay` | `200`, `closed: { how: okay, by: Rose }` |
| B8 | Maya `okay` | `200`, `closed: { how: with_her, by: Maya }` |
| B9 | walker `POST /devices/{id}/help/{help_id}/okay`, her phone in | `closed: { how: okay, by: Rose }` |
| B10 | walker okay, her phone not in | `closed: { how: okay, by: null }` (the contract's rule; no walker name is used) |
| B11 | any answer (`coming`, `okay`, walker okay) on a closed request | `409 help_closed` with `error.help` = the request as it stands (walker envelope on the walker's route, circle envelope on the phones'); the first close wins |
| B12 | unknown `help_id`, malformed id, or another walker's request id | `404 not_found` |
| B13 | a removed caretaker's cookie | `401 unauthenticated` |
| B14 | two closes at once (her phone `okay` and Maya `okay`, `Promise.all`) | exactly one `200`, the other `409 help_closed` carrying the winner's close |

## Reading, and `shown_to`

| # | Caller, state | Expected |
| --- | --- | --- |
| C1 | walker `GET /devices/{id}/help`, none ever | `{ help: null }` |
| C2 | open | the open request; `age_seconds` = whole seconds since the ask by the server's clock |
| C3 | closed 4 min 59 s ago | shown; at 5 min 0 s (`HELP_CLOSED_SHOWN_MS`) `null` |
| C4 | an approved caretaker's `GET /circle` while open | `help` carries the request with this phone in `shown_to`; the walker's GET then shows the same `shown_to` |
| C5 | the same caretaker's GET again, then the other Maya's | `shown_to` = [first, second], each once, first first |
| C6 | her phone's GET, and the walker's GET | never add to `shown_to` |
| C7 | a caretaker's GET while the request is closed | `shown_to` unchanged |
| C8 | waiting caretaker `GET /circle` | `waiting` answer (no `help`), not added |
| C9 | owner's page | no help anywhere in `GET /walkers/{id}/circle` |
| C10 | the second walker's phones | never see this walker's request |
| C11 | no location in any help view or log line, even with sharing on and a fix | none |

## Time and deletion

| # | Case | Expected |
| --- | --- | --- |
| D1 | open, clock + `HELP_OPEN_MAX_MS` - 1 s | still open |
| D2 | open, clock + `HELP_OPEN_MAX_MS` | read as `closed: { how: expired, by: null }`, closed at ask + 1 hour, so shown until ask + 1 h 5 min, then `null` |
| D3 | after D2, a new ask | `201`, a new request (the expired one doesn't block it) |
| D4 | answering an expired one | `409 help_closed`, `how: expired` |
| D5 | retention: clock + `HELP_RETENTION_MS` and a heartbeat (the walker's sweep) | the row is gone from storage (dump), open or closed; at + 24 h - 1 min still there |
| D6 | "Forget this walker" | every request deleted at once (dump) |
| D7 | removing a caretaker | requests stay; `sent_to` still names them; that phone gets `401` |
| D8 | removing her phone | requests stay; the walker's okay then closes with `by: null` |
| D9 | sweep at server start (`prepare`) | also deletes requests past retention |

## Voice path (turn.test.ts)

| # | Case | Expected |
| --- | --- | --- |
| V1 | walker turn with `can_ask_for_help: true`, two approved caretakers (Maya, Ana), model picks `ask_for_help` | reply exactly "I'll ask Maya and Ana for help in 8 seconds. Press any button to stop.", `answered_by: fixed`, `ask_for_help: true`, no proposal, draft or tool call, no request stored, reason `ask_for_help` |
| V2 | the model's request on that turn | the schema offers `ask_for_help` in `tool_call`; the prompt has the rule ("never claim to have called, told or reached anyone, or closed a request") |
| V3 | walker turn without `can_ask_for_help` (an older Pi) | the schema doesn't offer `ask_for_help`; a model that sets it anyway is ignored: no `ask_for_help`, a fixed line, nothing stored |
| V4 | page turn (owner's page) | never offered; a model that sets it anyway: no `ask_for_help`, fixed "Please use Talk on the walker for that request." |
| V5 | `can_ask_for_help: true`, no approved caretaker (her phone and a waiting one only), model picks it | reply exactly "No caretaker's phone is linked to this walker, so I can't ask anyone. If you need help now, call 911 from your phone.", no `ask_for_help` |
| V6 | while a request is open, a walker turn | the context has one line with sent to, showing on and coming, no location, no ids; none on a page turn; none once closed |
| V7 | replay of V1's `client_turn_id` (same request) | the same reply and `ask_for_help: true` again (the Pi may have lost the first answer); nothing stored twice |
| V8 | the circle unreachable (SpacetimeDB timing out) | `ask_for_help` isn't offered; the turn still answers |
| V9 | the model answers `ask_for_help` with `reply: ""` (Gemini did this in 4 of 6 live answers on 2026-10-24) | accepted on the first call, no retry; the countdown line and `ask_for_help` |
| V10 | the model answers `reply: ""` with no `ask_for_help` | sent back once with a note naming `reply`; never spoken empty (a fixed line if the retry is empty too) |
| V11 | the prompt | tells the model to leave `reply` empty for `ask_for_help`, and never to say it can call anyone |

## Logs

| # | Case | Expected |
| --- | --- | --- |
| L1 | every ask and answer | one `[circle] help` event with device id, help id, action, `via` (`handles`/`voice`/`phone`/`walker`/`walker_user`/`caregiver`), outcome, sent-to count, age in ms; never a name or a location |

## SpacetimeDB (`care-db-views.test.ts`)

| # | Case | Expected |
| --- | --- | --- |
| S1 | an approved caretaker subscribed to `my_help` when her walker asks | one row `{ help_id, rev }` within 2 s; no other field |
| S2 | `coming`, then a repeated `coming`, then `okay` | `rev` goes up on each change, not on the repeat |
| S3 | a waiting caretaker and another walker's phone | `my_help` empty |
| S4 | the walker forgotten | the row leaves `my_help` |
