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
2. Exact SO-101 arm controller, servo driver, camera models, and Linux support; measured USB bandwidth with all cameras active.
3. Lift motor, stepper driver, mechanical end stops, encoder/homing sensor, emergency-stop wiring, and payload/workspace limits.
4. Battery chemistry, protection, fuse values, 12 V load budget, 5 V Pi regulator, motor rail isolation, charging approach, and runtime.
5. ToF sensor model/count/mounting, interference/crosstalk, effective range under daylight, and haptic mapping with user feedback.
6. Whether voice hardware uses an ESP32 audio path or a Pi USB microphone/speaker for the first demo. Both fit the same app-level contract.
7. Model, speech providers, data retention durations, and costs. Pick only after measuring latency and accessibility of the full voice turn.
8. GPS use case, caregiver authorization, and consent UX. Leave disabled until specified.

Record each resolved decision with date, owner, evidence, and affected files in this document or a small `docs/decisions/` entry. Bench measurements supersede design assumptions.

## Implementation references

Check current documentation when choosing exact APIs and parts: [Next.js](https://nextjs.org/docs), [Vercel AI SDK](https://ai-sdk.dev/docs), [Supabase Auth](https://supabase.com/docs/guides/auth), [Supabase row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security), [Espressif USB device support](https://docs.espressif.com/projects/esp-usb/en/latest/esp32s3/usb_device.html) for an ESP32-S3 candidate, [WCAG 2.2](https://www.w3.org/TR/WCAG22/), [Raspberry Pi 5 product brief](https://datasheets.raspberrypi.com/rpi5/raspberry-pi-5-product-brief.pdf), and the [SO-100/101 overhead camera mount](https://github.com/TheRobotStudio/SO-ARM100/blob/main/Optional/Overhead_Cam_Mount_32x32_UVC_Module/README.md). These references do not resolve the open hardware decisions above.
