# Walker cloud, piece 2: expected results

Written before the code (2026-10-23). Rows marked *(review)* were added after the break-it review found the gap. Each row is a test case. The service cases run against both stores: the in-memory one always, and Postgres when `WALKER_TEST_DATABASE_URL` points at a local cluster. Times come from a fake clock, so nothing sleeps. "Owner A" and "owner B" are two browsers' `walker_owner` cookies; "walker 1" belongs to owner A.

## Auth

| Case | Expected |
| --- | --- |
| Owner A reads walker 1 | `200`, its status view |
| Owner B reads walker 1 | `404 not_found`, the same body as an unknown id |
| Owner A reads an unknown id, and a string that isn't a uuid | `404 not_found` both |
| A page route with no cookie, or a cookie that isn't 43 base64url characters | `401 unauthenticated` |
| Walker 1's own device credential sent as the `walker_owner` cookie | It names no owner: `GET /walkers` lists nothing, `GET /walkers/{1}` is `404` |
| Owner A's cookie value sent as `Authorization: Bearer` on walker 1's heartbeat | `401 unauthenticated` |
| A page route sent with walker 1's valid Bearer and no cookie | `401 unauthenticated`: the header is ignored there |
| A device route sent with owner A's cookie and no Bearer | `401 unauthenticated`: the cookie is ignored there |
| A forged credential (43 random characters) on walker 1's routes | `401 unauthenticated` |
| Walker 1's credential on walker 2's id | `404 not_found` |
| Walker 1 forgotten, then its old credential used | `401 unauthenticated` (revoked) |
| The store keeps the cookie and the credential | Only their SHA-256 (hex); neither secret appears in any stored row |
| A wrong code's client address *(review)* | Kept only as a hash keyed with a secret held in server memory: neither the address nor its plain SHA-256 is stored |
| The `Bearer` scheme in lower case *(review)* | Accepted: HTTP scheme names are case-insensitive |

## Pairing

| Case | Expected |
| --- | --- |
| Owner A asks for a code | `201`, a 6-digit code expiring 10 minutes later; a browser with no cookie gets a new `walker_owner` cookie (httpOnly, SameSite=Strict, path `/api/v1/walkers`, Secure in production) |
| A second code for owner A | Replaces the first; the first no longer pairs |
| The Pi claims the code | `201`: a device id, a 43-character credential, and configuration version 1 equal to `WALKER_SETUP` |
| The same code again | `400 pairing_code_invalid` (one-time) |
| A code claimed 10 minutes and 1 ms after it was made | `400 pairing_code_invalid` (expired) |
| 5 wrong codes from one address, then a 6th try with the right code | `429 pairing_locked`; the right code is not used up |
| The same address after the window (10 minutes after the wrong tries) | Pairs: the window slides, lifting 10 minutes after the oldest of the 5 wrong tries |
| 20 wrong codes sent at once from one address *(review)* | At most 5 are checked and recorded; the rest get `pairing_locked`, or `429 rate_limited` when another try from that address is still running (Postgres doesn't wait for it). The 6th wrong code sent after them is locked |
| On Render, an IPv6 client *(review)* | Locked out by its /64 network, so it can't take a fresh address for each try |
| A pairing-code request another site made the browser send (`Sec-Fetch-Site: cross-site`) *(review)* | `400 invalid_request`, and no new cookie replaces the owner's |
| 5 wrong codes from address X, then address Y with its right code | Y pairs: the lockout is per address |
| Owner A has 8 walkers and asks for a code, or claims one made earlier | `409 walker_limit` both times; the code is not used up |
| On Render, an address taken from `CF-Connecting-IP`; a forged leftmost `X-Forwarded-For` entry changes nothing | The lockout follows `CF-Connecting-IP` (unit test on headers, then a live check after deploy) |

## Heartbeat and status

| Case | Expected |
| --- | --- |
| A heartbeat | `200 { configuration_version: 1, open_proposal: null }`; the manifest and snapshot are stored with the server's receive time |
| Status 14,999 ms after the last heartbeat, and 15,001 ms after | Online, then offline |
| An offline walker's status | Every part `unavailable`, every zone `unknown`, no open proposal; it parses with `WalkerStatusViewSchema` |
| Walker lines with `ago_ms` 0, 2,000 and 30,000 | `at` is the receive time minus each `ago_ms`; the page lists them oldest first |
| The same `event_id` in two heartbeats | Stored once |
| Two lines with the same `ago_ms` in one heartbeat *(review)* | Listed in the order the walker sent them, in both stores |
| A NUL character or half a surrogate pair in a line, a part's firmware version or the service version *(review)* | Stored as U+FFFD; the heartbeat succeeds (Postgres would refuse it, and the walker would resend the line for a day) |
| A heartbeat line older than an hour (`ago_ms` > 1 h) | Not stored |
| The status of a simulator with a simulated ToF part and a real hand control | Each part keeps its own `simulated` flag; zones take theirs from `zoneViews` |
| A configured part the walker never reported (voice) | `unavailable`, `instance_id: null`, `in_configuration: true` |
| A part the walker reports that isn't configured | Listed with `in_configuration: false` |
| A zone from a snapshot received 7,001 ms ago | `unknown`, reason `stale` |
| A zone whose part isn't in the manifest | `unknown`, reason `missing`, simulated |
| `GET /devices/{id}/configuration` | The current configuration |
| Every status view the service returns, in every test | Parses with `WalkerStatusViewSchema` |

## Proposals

| Case | Expected |
| --- | --- |
| An open proposal on an online walker | In the heartbeat answer and the status view |
| Confirm it | `200`, `confirmed` with `configuration_version: 2`; configuration 2 has the proposal's cues and version 1 is unchanged; the next heartbeat says version 2 |
| Two Confirms at the same moment | The first `200 confirmed`; the second `409 proposal_closed` carrying the confirmed proposal; only one version 2 exists |
| Decline | `declined`; no new version |
| A Confirm against a configuration that moved | `409 proposal_closed`, the proposal `superseded`; no new version |
| A new proposal while one is open | The old one becomes `superseded` |
| A new proposal after the open one passed its 60 s *(review)* | The old one becomes `expired`, not `superseded` |
| A retried turn with the same `client_turn_id` *(review)* | The stored turn and its proposal come back; no second proposal opens |
| A Confirm 60 s after the proposal was made | `409 proposal_closed`, `expired` |
| No heartbeat for 15,001 ms, then the walker comes back | The proposal is `expired` on the first read after the gap (status, heartbeat or answer) and stays expired after the walker reconnects |
| Answering an unknown proposal id, or another walker's | `404 not_found` |
| A walker's Confirm button and the owner's page | Both reach the same proposal by id, each with its own proof |

## Retention and Forget

| Case | Expected |
| --- | --- |
| A turn and a walker line 60 min + 1 ms old, swept on a heartbeat | Deleted; a 59-minute-old one stays |
| Server start | Runs the same sweep, plus expired pairing codes and old pairing tries |
| The page reads a walker that has stopped sending heartbeats *(review)* | The same sweep runs first, once per request, so an hour-old turn is gone from the view and the database |
| Forget walker 1 | `204`; the device, its configurations, turns, lines and proposals are gone in one transaction; owner A's other walker and owner B's data are untouched |

## Postgres store

| Case | Expected |
| --- | --- |
| Migrations run twice, and twice at once from two pools | The same schema, no error (advisory lock) |
| Every case above | The same result as the in-memory store |

## Routes

| Case | Expected |
| --- | --- |
| Every error | `{ error: { code, message, trace_id } }` parsing with `WalkerErrorSchema`, with the HTTP status from `WALKER_ERROR_STATUS` |
| A body that isn't JSON, or is too large | `400 invalid_request` |
| `GET /api/v1/health` | `200` with the store kind when it is ready and answers a query now; `503` when the database can't be reached |
| Production with no `DATABASE_URL` (Vercel) | Walker routes answer `503 unavailable`; onboarding is unaffected |
| Server logs | Route, ids, outcome and milliseconds only, plus the error body's `trace_id` on errors: no words, credentials or cookies |
