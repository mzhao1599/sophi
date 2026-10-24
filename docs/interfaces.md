# Proposed interfaces and contracts

This is the first shared contract for web, cloud, Pi, and ESP32 work. The **onboarding routes are implemented** (demo mode only) with schemas in [`packages/contracts/src/onboarding.ts`](../packages/contracts/src/onboarding.ts); everything else here is still a proposal. Define each new schema in `packages/contracts/`, assign a protocol version, and validate on **both** sides. Prefer generated types where practical.

## Rules shared by all transports

- Each event has a schema version, origin, timestamp, request/event ID, and correlation ID. Avoid embedding raw audio/images in ordinary JSON events.
- Commands have idempotency keys and explicit deadlines. A retry must not start the same motion twice.
- Acknowledgement means receipt/validation, not task completion. Completion or failure is a later event.
- Reject unknown command types or unsupported major versions. Allow only documented optional fields within a version.
- Validate length, numeric ranges, enum values, and payload size before using data. Do not treat a device's self-reported capability as sufficient authorization.
- Timestamps help ordering; use local monotonic timers for watchdogs because wall clocks can jump.

## Cloud API surface

Base path proposal: `/api/v1`. All user routes require an authenticated user session. Device routes require a distinct revocable device credential bound to one device. Pairing uses a short-lived, one-time challenge; never copy a user's session cookie to the Pi.

| Route | Caller | Purpose | Status |
| --- | --- | --- | --- |
| `POST /onboarding/sessions` | User web app | Start a session with consent and chosen input mode | Built (demo) |
| `POST /onboarding/sessions/{id}/turns` | User web app or approved integration | Answer, skip or revisit a question; returns the assistant turn, the acknowledgement and the updated session with recommendations | Built (demo), text only |
| `GET /onboarding/sessions/{id}` | User web app | Restore transcript/summary/recommendation after refresh | Built (demo) |
| `PATCH /onboarding/sessions/{id}/profile` | User web app | Edit or remove one item of the draft profile ("What I understood"); recommendations are recomputed | Built (demo) |
| `POST /onboarding/sessions/{id}/confirm` | User web app | Confirm the reviewed selection as configuration version 1 | Built (demo) |
| `DELETE /onboarding/sessions/{id}` | User web app | Delete the session and its answers now | Built (demo) |
| `POST /devices/pairing-challenges` | User web app | Create short-lived pairing challenge |
| `POST /devices/pair` | Pi | Claim challenge and receive device-scoped credential |
| `GET /devices/{id}/configuration` | Pi | Fetch signed/versioned configuration and preferences |
| `POST /devices/{id}/events` | Pi | Report bounded telemetry, capabilities, fault and task events |
| `POST /devices/{id}/assistant-turns` | Pi | Send bounded transcript/audio reference and fresh snapshot; receive response/action proposal |
| `POST /devices/{id}/actions/{actionId}/status` | Pi | Report local acceptance, progress, completion, cancellation, or fault |

**As built (demo mode):** a session's id is in the URL; a separate secret in an `httpOnly`, `SameSite=Strict` cookie scoped to `/api/v1/onboarding` proves the caller started it, and a missing or wrong secret reads as `404`, the same as an unknown id. Sessions live in server memory and are deleted an hour after the last change. Turn inputs are `text` (answers the current question), `answer` (`question_id`, `option_ids`, optional `text`), `skip`, `skip_rest` and `revisit`. Responses carry `ack`, a short acknowledgement for a screen-reader announcement, besides `assistant_text`. Errors use `{ "error": { "code", "message", "trace_id", "session"? } }`; a `409 revision_conflict` includes the current session so the client can recover.

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

Firmware sends a hello on boot, then heartbeat/health (proposed every 1 second) and events. Pi responds to hello with protocol version and requested report rate. Sensor reports should be bounded (proposed 10–20 Hz for ToF and edge-triggered controls); tune from measurements. Haptic commands expire after their duration and cannot be queued indefinitely. Sequence numbers detect drops; a reboot resets `seq` and is signaled by a new hello/boot ID. If heartbeats stop, Pi marks the module unavailable and acts on stale state conservatively.

**Safety path:** a physical stop must interrupt actuator power or driver enable through a hardware path independent of USB serial and cloud software. A Pi process may additionally issue a stop. Do not implement the physical stop as only a JSON message.

## Sensor and voice data

The Pi publishes a capability manifest with module IDs, protocol/firmware versions, and current availability. A sensor snapshot sent to cloud includes zone, value, quality, capture time, and expiry; omitted or stale data means unknown. Store high-rate raw streams locally only if needed for debugging and consented. The cloud normally receives a compact snapshot, not continuous ToF samples.

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

When writing `packages/contracts/`, add schemas for module catalog, profile, configuration, serial envelope, capability manifest, sensor snapshot, action request/status, and agent tool arguments. Define compatibility rules and fixtures. Document exact byte limits, timeout values, and error codes after device measurements. The examples above are contract proposals, not permission to skip validation.
