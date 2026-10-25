# Asking for help: expected results (written before the code)

The server piece of [docs/subsystems/help.md](../../../../docs/subsystems/help.md): the store (memory, Postgres, SpacetimeDB), `CircleService`'s help methods, the routes in `apps/web`, and the voice path. Tests: `help.test.ts` (service and stores, all three stores), `turn.test.ts` (voice path, memory and Postgres), `apps/web/test/help-routes.test.ts` (HTTP), `care-db-views.test.ts` (`my_help`).

**Seed (messy, used by most rows):** a paired, online walker named "Rose's walker" (13 characters, longer than a circle name). Her phone Rose (`walker_user`). Caretakers, in joining order: Maya (approved first), Ana (approved second), Ben (typed a code, still waiting), Cy (approved, then removed before the ask). A second walker with its own caretaker Zed, whose requests must never show up here.

Clock: a fake clock (`now` injected); nothing sleeps.

## Asking

| # | Caller, state | Expected |
| --- | --- | --- |
| A1 | walker (Bearer), `source: handles`, seed | `201`, `help.source: handles`, `told: ["Maya", "Ana"]` (approved now, joining order; not Ben waiting, not Cy removed), `coming: []`, `closed: null`, `age_seconds: 0` |
| A2 | walker, same `client_help_id` again | `200`, the same `help_id`, nothing new stored |
| A3 | walker, new `client_help_id` while A1 is open | `200`, A1's request (one open per walker), nothing new stored |
| A4 | her phone, `POST /circle/help`, while A1 is open | `200`, A1's request |
| A5 | her phone, no request open | `201`, `source: phone`, `told: ["Maya", "Ana"]` |
| A6 | a caretaker's phone `POST /circle/help` | `403 not_allowed`, nothing stored |
| A7 | waiting Ben's phone `POST /circle/help` | `403 not_allowed` |
| A8 | walker with no approved caretaker (only her phone, and a waiting one) | `409 no_caretaker`, nothing stored (dump has no request), log outcome `no_caretaker` |
| A9 | walker, after A1 closed, A1's `client_help_id` again | `200`, A1 as closed (a repeated id returns its request even once closed) |
| A10 | walker, after A1 closed, new id | `201`, a new request; A1 stays as it was |
| A11 | wrong or missing Bearer; another walker's id with this walker's Bearer | `401 unauthenticated`; `404 not_found` |
| A12 | `source: phone` from the walker, or extra fields | `400 invalid_request` |
| A13 | voice ask with `source: voice` | `201`, `source: voice` |
| A14 | the walker's whole circle removed after the ask, then the same `client_help_id` | `200`, the request (told still names them) |

## Answering

| # | Caller, state | Expected |
| --- | --- | --- |
| B1 | Maya `coming` on the open request | `200`, `coming: ["Maya"]` |
| B2 | Maya `coming` again | `200`, unchanged, `coming: ["Maya"]` (each once, no new revision in SpacetimeDB) |
| B3 | Ana `coming` after Maya | `coming: ["Maya", "Ana"]` (first answer first) |
| B4 | her phone `coming` | `403 not_allowed` |
| B5 | waiting Ben `coming`, `okay` | `403 not_allowed` |
| B6 | a caretaker who joined (approved) after the ask: sees it on `GET /circle`, not in `told`; `coming` | sees it; `coming` includes their name; `told` unchanged |
| B7 | her phone `okay` | `200`, `closed: { how: okay, by_name: "Rose" }` |
| B8 | Maya `okay` | `200`, `closed: { how: with_her, by_name: "Maya" }` |
| B9 | walker `POST /devices/{id}/help/{help_id}/okay`, her phone in | `closed: { how: okay, by_name: "Rose" }` |
| B10 | walker okay, her phone not in, walker named "Rose's walker" (13 characters) | `closed: { how: okay, by_name: "The walker" }`: the walker's name doesn't fit a circle name (12), so a fixed fallback (contract issue, reported); a walker named "Walker" (fits) gives `by_name: "Walker"` |
| B11 | any answer (`coming`, `okay`, walker okay) on a closed request | `409 help_closed` with `error.help` = the request as it stands (the first close wins: a second close doesn't change `how` or `by_name`) |
| B12 | unknown `help_id`, malformed id, or another walker's request id | `404 not_found` |
| B13 | a removed caretaker's cookie | `401 unauthenticated` |
| B14 | two closes at once (her phone `okay` and Maya `okay`, `Promise.all`) | exactly one `200`, the other `409 help_closed` carrying the winner's close |

## Reading

| # | Caller, state | Expected |
| --- | --- | --- |
| C1 | walker `GET /devices/{id}/help`, none ever | `{ help: null }` |
| C2 | open | the open request; `age_seconds` = whole seconds since the ask by the server's clock |
| C3 | closed 4 min 59 s ago | shown; at 5 min 0 s (`HELP_CLOSED_SHOWN_MS`) `null` |
| C4 | her phone and an approved caretaker `GET /circle` | `help` equal to the walker's GET |
| C5 | waiting caretaker `GET /circle` | `waiting` answer (has no `help`) |
| C6 | owner's page | no help anywhere in `GET /walkers/{id}/circle` |
| C7 | the second walker's phones | never see this walker's request |
| C8 | no location in any help view or log line, even with sharing on and a fix | none |

## Time and deletion

| # | Case | Expected |
| --- | --- | --- |
| D1 | open, clock + `HELP_OPEN_MAX_MS` - 1 s | still open |
| D2 | open, clock + `HELP_OPEN_MAX_MS` | read as `closed: { how: expired, by_name: null }`, closed at ask + 1 hour, so shown until ask + 1 h 5 min, then `null` |
| D3 | after D2, a new ask | `201`, a new request (the expired one doesn't block it) |
| D4 | answering an expired one | `409 help_closed`, `how: expired` |
| D5 | retention: clock + `HELP_RETENTION_MS` and a heartbeat (the walker's sweep) | the row is gone from storage (dump), open or closed; at + 24 h - 1 min still there |
| D6 | "Forget this walker" | every request deleted at once (dump) |
| D7 | removing a caretaker | requests stay; `told` still names them; that phone gets `401` |
| D8 | removing her phone | requests stay; the walker's okay then closes with the walker's name or fallback |
| D9 | sweep at server start (`prepare`) | also deletes requests past retention |

## Voice path (turn.test.ts)

| # | Case | Expected |
| --- | --- | --- |
| V1 | walker turn with `can_ask_for_help: true`, two approved caretakers, model picks `ask_for_help` | reply exactly "I'll ask Maya and Ana for help in 8 seconds. Press any button to stop.", `answered_by: fixed`, `ask_for_help: true`, no request stored, reason `ask_for_help` |
| V2 | the model's request schema on that turn | offers `ask_for_help` in `tool_call`; the context carries the help rule's inputs (caretakers can be asked) |
| V3 | walker turn without `can_ask_for_help` (an older Pi) | the schema doesn't offer `ask_for_help`; a model that sets it anyway is ignored: no `ask_for_help` in the response, a fixed line, no request |
| V4 | page turn (owner's page) | never offered; a model that sets it anyway: no `ask_for_help`, fixed "Please use Talk on the walker for that request." |
| V5 | `can_ask_for_help: true`, no approved caretaker (her phone and a waiting one only), model picks it | reply exactly "No caretaker's phone is linked to this walker, so I can't ask anyone. If you need help now, call 911 from your phone.", no `ask_for_help` |
| V6 | while a request is open, a walker turn | the context has one line with state, told and coming ("open; told Maya and Ana; Maya is coming"), no location, no help id; none on a page turn; none when closed |
| V7 | replay of V1's `client_turn_id` (same request) | the same reply and `ask_for_help: true` again (the Pi may have lost the first answer); nothing stored twice |
| V8 | the circle unreachable (SpacetimeDB timing out) | `ask_for_help` isn't offered; the turn still answers |

## Logs

| # | Case | Expected |
| --- | --- | --- |
| L1 | every ask and answer | one `[circle] help` event with device id, help id, action, `via` (`handles`/`voice`/`phone`/`walker`/`walker_user`/`caregiver`), outcome, told count, age in ms; never a name, a location or the walker's name |

## SpacetimeDB (`care-db-views.test.ts`)

| # | Case | Expected |
| --- | --- | --- |
| S1 | an approved caretaker subscribed to `my_help` when her walker asks | one row `{ help_id, rev }` within 2 s; no other field |
| S2 | `coming`, then a repeated `coming`, then `okay` | `rev` goes up on each change, not on the repeat |
| S3 | a waiting caretaker and another walker's phone | `my_help` empty |
| S4 | retention sweep (fake clock past 24 h) | the row leaves `my_help` |
