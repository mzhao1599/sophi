# Scope, decisions, and delivery plan

This page distinguishes what the team wants to build from what has been chosen or proven. Update it as hardware and software arrive.

## Product goals

The walker should let people with different access needs choose only the assistance they want. Examples include obstacle proximity cues for a blind or low-vision user, large and reachable controls for someone with limited dexterity, and optional manipulation for tasks that are difficult to reach or grasp. Age or diagnosis alone must not determine a recommendation. The user can reject any module and still use the base device.

The demonstration should show a complete path: accessible onboarding → explained module recommendation → a configured device → a local sensor cue → an assistant turn → a supervised physical task if the arm is ready. Judges should see which parts are real hardware, simulated data, and future work.

## Proposed MVP and stages

| Stage | Demo outcome | Minimum proof |
| --- | --- | --- |
| 0. Bench foundation | Modules enumerate and can be stopped | Power budget, fuse/stop circuit, USB inventory, watchdog, safe boot |
| 1. Accessible onboarding | User can explain needs and accept/reject module suggestions | Keyboard/screen-reader path, persisted session, deterministic module catalog |
| 2. Local assistance | Buttons and ToF cause appropriate haptic cues offline | Debounce, stale-sensor behavior, visible logs, Pi disconnect behavior |
| 3. Conversational walker | Push-to-talk turn uses current capabilities and settings | Authenticated Pi-to-cloud request, transcript, tool audit, offline fallback |
| 4. Supervised arm demo | One or both arms execute a bounded pick/place task | Physical stop, homing, workspace/lift limits, user start/cancel, fault recovery |
| Later | GPS/caregiver location, richer autonomy, broader connectors | Separate consent and safety reviews |

Two SO-101 arms, overhead/gripper cameras, and a lift are the target hardware. Stage 4 can demonstrate one arm first while the second arm and lift are integrated; the architecture and contracts should support both from the start. Do not represent a simulated arm as a working assistive feature.

The owner reported purchasing the arms, three USB 2.0 UVC cameras, walker, lift components, Pi, ESP32 boards, sensors, audio, and power converters on 2026-10-23. See the [current hardware inventory](../hardware/current-build.md) for exact items and unresolved assembly details. Purchase is not proof of integration or validation.

## Initial technology choices

| Area | Initial choice | Why / decision point |
| --- | --- | --- |
| Web | Next.js + TypeScript | One codebase for accessible UI and authenticated API; keep server and client logic separated |
| Hosting | Vercel | Fast previews and deployment for hackathon; verify request duration and streaming limits before choosing long-running tasks |
| Identity/data | Supabase Auth + Postgres + private Storage | Accessible team workflow and durable, owner-scoped state; use RLS and private media |
| Agent | TypeScript agent orchestration with typed tools | Shared contracts with web; choose the current supported AI SDK/model API when implementing, not a hard-coded model ID in docs |
| Pi | Python or TypeScript service, chosen by the device team after checking arm/camera libraries | Prioritize robust Linux serial/camera support and one language per component |
| ESP32 | ESP-IDF or Arduino framework chosen per board after bench validation | Use the same wire protocol regardless of firmware framework |
| Device transport | USB serial for ESP32 control/sensors; UVC cameras and arm drivers separately | Inspect exact board and arm interfaces before wiring; do not assume every ESP32 exposes native USB |

These are proposals, not installed dependencies. Pin versions and commit lockfiles when implementation begins. Keep external services behind adapters so local demos and tests can use recorded fixtures.

## Module catalog seed

| Module ID | Capability | Typical user task | Prerequisites | Default |
| --- | --- | --- | --- | --- |
| `base.walker` | Physical support and Pi coordination | Use the walker and controls | Bench-tested base | Required |
| `controls.hand` | Reachable buttons, trigger, haptics | Start/cancel speech, receive tactile cues | At least one accessible hand control | Recommend when useful |
| `perception.tof` | Proximity cues for nearby obstacles | Notice an obstacle near a measured zone | Calibrated sensors and haptic/audio output | Optional |
| `voice` | Push-to-talk input and spoken output | Ask a question without typing | Microphone/speaker and consent | Optional |
| `manipulation.arm` | Supervised reach/grasp | Retrieve a light object in a tested workspace | Camera, arm(s), power, stop circuit, user start | Optional |
| `manipulation.lift` | Change arm working height | Reach objects at tested heights | Homed lift, hard limits, guarded motion | Optional |
| `location.gps` | Location display/sharing | Locate a device after an opt-in request | Receiver, connectivity, caregiver consent | Deferred |

Catalog metadata should also carry cost/weight/power estimates, compatibility, availability, limitations, and a human-readable rationale. Unknown estimates must be labeled unknown rather than filled with guesses. The agent may recommend from this catalog but cannot invent modules or treat a disability label as consent.

## Acceptance criteria for the first integrated demo

- Onboarding works with keyboard alone and has visible focus, clear labels, editable recommendations, and text equivalents for speech.
- The Pi discovers connected module IDs and reports a capability manifest; the cloud only offers tools the device actually has.
- A hand control can start and cancel a voice turn; cue timing and state are apparent in audio and haptics.
- A near-obstacle cue is triggered locally, including while the internet is disconnected; stale or failed sensors are shown as unavailable.
- A physical stop prevents arm/lift motion and remains latched through a cloud retry or Pi service restart.
- Every attempted physical task has a trace from user request to tool proposal, policy check, local guard result, and completion/fault.
- The demo has a written list of supported scenarios and known limitations. No claim of autonomous navigation or clinical suitability.

## Open decisions to settle with measurements

1. Exact ESP32 boards and whether each USB port is native CDC or a USB-to-UART bridge; stable device IDs and power behavior.
2. Exact SO-101 arm controller and servo driver, included cables, camera Linux enumeration, and measured USB bandwidth with all three purchased cameras active.
3. Purchased lift motor/driver configuration, mechanical end stops, homing sensor wiring, emergency-stop wiring, and payload/workspace limits.
4. Battery purchase and charger, branch protection and fuse values, 12 V load budget, validation of the purchased 5 V Pi converter and USB leads, motor rail isolation, and runtime.
5. ToF sensor model/count/mounting, interference/crosstalk, effective range under daylight, and haptic mapping with user feedback.
6. Whether voice hardware uses an ESP32 audio path or a Pi USB microphone/speaker for the first demo. Both fit the same app-level contract.
7. Model, speech providers, data retention durations, and costs. Pick only after measuring latency and accessibility of the full voice turn.
8. GPS use case, caregiver authorization, and consent UX. Leave disabled until specified.

Record each resolved decision with date, owner, evidence, and affected files in this document or a small `docs/decisions/` entry. Bench measurements supersede design assumptions.

## Decisions made

| Date | Owner | Decision | Evidence / reason | Files |
| --- | --- | --- | --- | --- |
| 2026-10-23 | mzhao1599 | pnpm workspace (`apps/*`, `packages/*`, `services/*`); Next.js 16.3, React 19.3, TypeScript 6.0, zod 4.6, Vitest 5.0, versions pinned at least two weeks old | TypeScript 7 lacks the compiler JS API that Next's type check uses | `package.json`, `pnpm-workspace.yaml`, `apps/web/package.json` |
| 2026-10-23 | mzhao1599 | Onboarding starts with a deterministic question bank and recommendation rules; the LLM agent comes next behind the same API | Usable, testable UI first (web guide, "Handoff for the first PR"); the rules become the agent's baseline and fallback | `services/cloud-api/src/onboarding/` |
| 2026-10-23 | mzhao1599 | Onboarding agent: Claude through the Anthropic TypeScript SDK, one structured-output call per text or answer turn (no tool loop). The model reads typed words as `NeedTag`s and picks and words the next bank question, choosing from the bank's options; recommendations stay rule-based. Off unless `ONBOARDING_ENGINE=agent` and `ANTHROPIC_API_KEY` are set; a failed or slow turn falls back to the deterministic engine | One call keeps a turn inside a 15 s deadline and every output field checkable; bank options mean a choice never carries a model-made tag; the provider sits behind the `AgentModel` adapter, so a swap touches one file. Checked with stub-model scenario tests and a local mock API, not yet with a live model | `services/cloud-api/src/onboarding/agent.ts`, `anthropic.ts`, `config.ts`, `apps/web/src/server/onboarding.ts` |
| 2026-10-23 | mzhao1599 | Demo sessions in server memory with a cookie-held secret, deleted an hour after the last change | No accounts yet; nothing sensitive persists | `services/cloud-api/src/onboarding/store.ts`, `apps/web/src/server/onboarding.ts` |
| 2026-10-23 | mzhao1599 | Supabase Postgres store for onboarding sessions, chosen by env: `onboarding_sessions`, `onboarding_turn_results`, `device_configurations` (immutable, numbered per user); RLS on all three, no `anon` access; owners read their rows and write their sessions, but turn results and setups are written only by one `security definer` save function that checks ownership, the revision and the next setup number; demo rows reached only by the server by token hash; expiry bounded by a trigger on every write; `pg_cron` deletes expired sessions every 5 minutes; at most 500 live demo sessions and 200 turns per conversation. No Supabase env keeps the memory store, which production refuses unless `ONBOARDING_ALLOW_MEMORY_STORE=true`. Supabase CLI 2.119.0 through npx, `@supabase/supabase-js` 2.117.2 | Vercel instances don't share memory; the revision check had to be atomic across instances. No `profiles` table yet: confirmed facts stay in their session. Setup numbers can repeat after the newest is deleted; per-device versions come with the device API. No per-address rate limit yet. Verified against a local stack only: RLS and store tests fail when a policy or the revision check is removed | `supabase/`, `services/cloud-api/src/onboarding/store.ts`, `supabase-store.ts`, `config.ts`, `services/cloud-api/test/` |
| 2026-10-23 | mzhao1599 | Sign-in with Supabase Auth, passwordless: one email with a 6-digit code and a `token_hash` link (`/auth/confirm`, redeemed by a button press so link scanners can't use it up), through `@supabase/ssr` 0.12.7 and server actions only, so the session cookies are `httpOnly`; `proxy.ts` refreshes tokens. A signed-in user's sessions are account sessions read through their own token (RLS); the start screen's notice picks demo or account. `/setups` lists saved setups with delete and deletes the account (cascading) | A code works when the email is opened on another device, where a PKCE link can't; no passwords to store or reset; nothing in the browser needs the token. Checked against a local stack with Mailpit, not a hosted project | `apps/web/app/login`, `app/auth/confirm`, `app/setups`, `apps/web/src/server/`, `apps/web/proxy.ts`, `supabase/templates/` |
| 2026-10-23 | mzhao1599 | Visual design with taste-skill v2: app style `editorial-greeting`, landing direction `page-is-the-object`, Instrument Sans and Serif, teal accent | Dealt sheets and inspector results in `apps/web/README.md` | `apps/web/app/globals.css`, `.taste-skill/` |

## Implementation references

Check current documentation when choosing exact APIs and parts: [Next.js](https://nextjs.org/docs), [Vercel AI SDK](https://ai-sdk.dev/docs), [Supabase Auth](https://supabase.com/docs/guides/auth), [Supabase row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security), [Espressif USB device support](https://docs.espressif.com/projects/esp-usb/en/latest/esp32s3/usb_device.html) for an ESP32-S3 candidate, [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [Raspberry Pi 5 product brief](https://datasheets.raspberrypi.com/rpi5/raspberry-pi-5-product-brief.pdf), and the [SO-100/101 overhead camera mount](https://github.com/TheRobotStudio/SO-ARM100/blob/main/Optional/Overhead_Cam_Mount_32x32_UVC_Module/README.md). These references do not resolve the open hardware decisions above.
