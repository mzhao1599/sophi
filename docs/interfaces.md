# Proposed interfaces and contracts

This is the first shared contract for web, cloud, Pi, and ESP32 work. The **onboarding routes are implemented** (demo mode only) with schemas in [`packages/contracts/src/onboarding.ts`](../packages/contracts/src/onboarding.ts). The serial envelope, capability manifest, sensor snapshot and action request/status are **specified** as v1 schemas in [`serial.ts`](../packages/contracts/src/serial.ts) and [`device.ts`](../packages/contracts/src/device.ts) but **not implemented** on any Pi, ESP32 or cloud route. The walker assistant's routes (pairing, heartbeat, turns, proposals, status) are **specified** in [`walker.ts`](../packages/contracts/src/walker.ts) and explained in the [walker assistant guide](subsystems/walker-assistant.md); none is built yet. Everything else here is still a proposal. Define each new schema in `packages/contracts/`, assign a protocol version, and validate on **both** sides. Prefer generated types where practical.

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
| `POST /walkers/pairing-codes` | Owner's page (`walker_owner` cookie) | A one-time 6-digit pairing code, valid 10 minutes (`PairingCodeResponseSchema`) | Specified ([`walker.ts`](../packages/contracts/src/walker.ts)), not built |
| `GET /walkers`, `GET /walkers/{id}` | Owner's page | The owner's walkers as status views (`WalkerStatusViewSchema`) | Specified, not built |
| `POST /walkers/{id}/turns` | Owner's page | A typed question to the walker's assistant (`PageTurnRequestSchema` → `WalkerTurnResponseSchema`) | Specified, not built |
| `POST /walkers/{id}/proposals/{proposalId}` | Owner's page | Confirm or decline the open proposal (`AnswerProposalRequestSchema` → `AnswerProposalResponseSchema`) | Specified, not built |
| `DELETE /walkers/{id}` | Owner's page | Forget the walker: delete it, its turns, lines, configurations and proposals, and revoke its credential; `204`, no body | Specified, not built |
| `POST /devices/pair` | Pi | Claim a pairing code; receive the device id, a device credential (shown once) and configuration version 1 (`PairDeviceRequestSchema`, `PairDeviceResponseSchema`) | Specified, not built |
| `POST /devices/{id}/heartbeat` | Pi | Every 5 s: the capability manifest, sensor snapshot and the walker's own lines since the last one; the answer names the current configuration version and the open proposal (`HeartbeatRequestSchema`, `HeartbeatResponseSchema`) | Specified, not built |
| `GET /devices/{id}/configuration` | Pi | The current walker configuration (`ConfigurationResponseSchema`) | Specified, not built |
| `POST /devices/{id}/turns` | Pi | A voice clip (WAV, ≤ 15 s, ≤ 1 MB) or text, with the current snapshot; the answer, any proposal it opened, the reply as speech when available, and the status (`DeviceTurnRequestSchema` → `WalkerTurnResponseSchema`) | Specified, not built |
| `POST /devices/{id}/proposals/{proposalId}` | Pi | The Confirm button: confirm or decline the open proposal (`AnswerProposalRequestSchema` → `AnswerProposalResponseSchema`) | Specified, not built |
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

**Walker assistant routes (specified, not built).** The Pi and the owner's page use separate proofs: device routes take `Authorization: Bearer <credential>`, where the credential is 32 random bytes in base64url, shown once at pairing, with only its SHA-256 kept. Page routes take the `walker_owner` cookie (`httpOnly`, `SameSite=Strict`, path `/api/v1/walkers`). Neither works on the other's routes, and an unknown or someone else's id reads as `404`, the same either way. Errors use `{ "error": { "code", "message", "trace_id", "proposal"? } }` with the codes in `WalkerErrorCodeSchema` and the HTTP status for each in `WALKER_ERROR_STATUS` (`400` invalid request or pairing code, `401`, `404`, `409` walker limit or proposal closed, `429` pairing locked or rate limited, `503`). A Pi that gets `401 unauthenticated` asks to be paired again. Turns are idempotent by `client_turn_id`. The only change a turn can propose is the walker's alert cues (`cues_change`), confirmed by id from the walker's Confirm button or the page, never by voice. Rules: [walker assistant guide](subsystems/walker-assistant.md#the-shared-nouns).

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

Example heartbeat and error (a line the module could not read):

```json
{"v":1,"type":"heartbeat","module_id":"tof-front-01","seq":84,"uptime_ms":27002,"health":"ok"}
{"v":1,"type":"error","module_id":"hand-left-01","seq":77,"code":"malformed"}
```

**Specified, v1** ([`serial.ts`](../packages/contracts/src/serial.ts), not implemented on any Pi or ESP32). Fixtures any implementation can run: [`serial-v1.valid.jsonl`](../packages/contracts/test/fixtures/serial-v1.valid.jsonl) (includes every example line above) and [`serial-v1.invalid.json`](../packages/contracts/test/fixtures/serial-v1.invalid.json) (each bad line with the expected problem code).

- Types: `hello`, `heartbeat`, `hand.input`, `perception.zones` (module → Pi), `haptic.play` (Pi → module), `ack` (module → Pi), `error` (either way). `module_id` names the sender on a module's message and the destination on a Pi command. `uptime_ms` is required on `heartbeat`, `hand.input` and `perception.zones`, optional on `hello`, `ack` and `error`, and absent on `haptic.play`.
- Every object is strict: a field v1 does not list is rejected, not ignored. Add a field to the schema (and update the receiver) before any sender emits it.
- 1 KiB means at most 1024 UTF-8 bytes **including** the `\n`, so a 1024-byte receive buffer holds any valid line. `parseSerialLine` checks size, then JSON, then `v`, then `type`, then fields, and returns one problem code (`oversize`, `malformed`, `unsupported_version`, `unknown_type`, `invalid_field`) without throwing. `ack.reason` and `error.code` use the same codes plus `unsupported` (the module lacks that capability) and `overflow` (a bounded queue was full).
- `hand.input` sends a `button` with its `edge`, a `trigger` value from 0 to 1, or both. `button` names one the module declared as `button.<name>` in its hello.
- Zone `quality` is `valid` or `invalid`; `mm` is a number exactly when the reading is valid. Up to 16 uniquely named zones per line.
- `haptic.play`: the pattern must be one of `confirmation`, `recording`, `near_obstacle`, `error`; shape and strength are fixed per pattern in firmware, and no waveform or intensity travels over the wire. `duration_ms` is 1 to `HAPTIC_MAX_DURATION_MS` (1000, a placeholder until the actuator is bench-tested). Only the Pi sends it, from its local cue policy; cloud or model text never becomes a haptic command directly. The cue stops when its duration ends; a newer `haptic.play` replaces the one playing instead of queueing (proposal). On USB disconnect or a watchdog reset the firmware stops the cue, as the firmware guide requires.
- Not specified yet: the Pi's reply to `hello` (protocol version and requested report rate), the heartbeat timeout after which the Pi marks a module unavailable, and the near/far thresholds. The 1 s heartbeat and 10–20 Hz ToF rate are exported as proposals (`SERIAL_HEARTBEAT_INTERVAL_MS`, `SERIAL_TOF_REPORT_HZ`), not enforced per line.

Firmware sends a hello on boot, then heartbeat/health (proposed every 1 second) and events. Pi responds to hello with protocol version and requested report rate. Sensor reports should be bounded (proposed 10–20 Hz for ToF and edge-triggered controls); tune from measurements. Haptic commands expire after their duration and cannot be queued indefinitely. Sequence numbers detect drops; a reboot resets `seq` and is signaled by a new hello/boot ID. If heartbeats stop, Pi marks the module unavailable and acts on stale state conservatively.

**Safety path:** a physical stop must interrupt actuator power or driver enable through a hardware path independent of USB serial and cloud software. A Pi process may additionally issue a stop. Do not implement the physical stop as only a JSON message.

## Sensor and voice data

The Pi publishes a capability manifest with module IDs, protocol/firmware versions, and current availability. A sensor snapshot sent to cloud includes zone, value, quality, capture time, and expiry; omitted or stale data means unknown. Both are **specified, v1** in [`device.ts`](../packages/contracts/src/device.ts) (not implemented): `CapabilityManifestSchema` lists each detected part by catalog `module_id`, hardware `instance_id`, firmware and serial protocol versions (null where the part has none), `health` (`ok`, `degraded`, `fault`, or `unavailable` when the Pi stopped hearing from it), fault codes, `observed_at` and `simulated` (a fake adapter stands in for the part), plus `simulator` for a whole walker simulated on a computer. Device v1 is unreleased until a walker ships, so fields can still be added, with the Pi and cloud updated together. `SensorSnapshotSchema` holds per-zone `mm`, `quality`, `captured_at` and `expires_at`, and `readZone(snapshot, zone, now)` returns `unknown` for a missing, invalid or expired zone, never clear. Store high-rate raw streams locally only if needed for debugging and consented. The cloud normally receives a compact snapshot, not continuous ToF samples.

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
