# Walker assistant guide (the always-on agent)

**For:** whoever builds or demos the assistant that lives on the walker after setup: the Pi service (`devices/pi`), the cloud routes (`services/cloud-api/src/walker/`, served by `apps/web`), and the "Your walker" page (`apps/web/app/walker`).

**Status (2026-10-24):** the shared contract is written ([`packages/contracts/src/walker.ts`](../../packages/contracts/src/walker.ts), with tests). The Pi service ([`devices/pi`](../../devices/pi/README.md)) is built and tested on a Mac only: unit tests and its simulator against a fake cloud. It has not run on a Pi or on real hardware, and it hasn't talked to the real cloud. The cloud's pairing, device credentials, heartbeat, status view, proposal answers and Forget are built in [`services/cloud-api`](../../services/cloud-api/README.md#walker-store) and served by `apps/web`, tested against an in-memory store and a local Postgres; the Render deployment ([`render.yaml`](../../render.yaml)) isn't created yet. The assistant turn, Cartesia speech and the page are being built and don't work yet.

## What it is

Steady's onboarding page helps a person choose a walker. The walker assistant is the helper on the walker itself, for every day after that. It runs whenever the walker's Raspberry Pi is on: a system service starts it at boot and restarts it if it stops. It is available whenever she asks, by holding the Talk button or by typing on the page. It is not a microphone that is always listening:

- Listening starts only on a Talk press. There is no wake word (the [cloud agent guide](cloud-agents.md#what-always-on-means-here) requires opt-in and local processing for one).
- The model never speaks unprompted. The Pi says a few fixed lines on its own (it's on, offline or online again, a part stopped responding, it needs pairing again), and those are written in Pi code, not by a model.
- Local alerts (an obstacle near a sensor → a buzz or a short sound) run on the Pi without the network.
- Nothing it does can move the arms or the lift. The only change a conversation can make is the walker's alert cues, and only after a person presses Confirm.

## How a spoken question travels

1. She holds Talk (a button on the handle, or a Pi GPIO button) and hears a short listening sound. The Pi records at most 15 seconds of 16 kHz mono WAV, then stops at release.
2. The Pi sends the clip to the server over HTTPS (`POST /api/v1/devices/{id}/turns`). The server hosts the cloud side on Render.
3. The server sends the clip, the walker's configuration, the parts it reports and their health, its fresh sensor readings, any open proposal and the last 10 turns to Google's Gemini in one call. The reply carries the transcript, the answer and, at most, one suggested cues change. The clip is dropped after the call. Nothing stores or logs it.
4. The server checks the reply. A suggested change that breaks a rule is dropped, and a fixed line replaces the answer. A question about the arms gets a fixed line built from what the walker reports. Readings from a simulated sensor are said to be simulated. If the model fails or takes longer than 8 seconds, a fixed answer from the walker's status is used, marked "answered by the fixed replies".
5. The server sends the reply text to Cartesia for speech and returns the audio with the answer. The Pi plays it, or speaks the reply with its own local text-to-speech when there's no audio. The page shows both sides of the conversation.

When the Pi can't reach the server (2 missed heartbeats, or a turn past 10 seconds), a Talk press gets a local line built from its own configuration, such as "I'm offline right now. Your short-sound alerts still work."

## The shared nouns

Everything below is defined once in [`walker.ts`](../../packages/contracts/src/walker.ts), and both the Pi and the cloud validate against it.

| Noun | What it is | Notes |
| --- | --- | --- |
| Device | A paired walker | Paired with a one-time 6-digit code from the page (10 minutes; 5 wrong codes from one address lock that address out for 10 minutes). The Pi gets a 32-byte credential once; the server keeps only its SHA-256. The credential works only on `/api/v1/devices/...`, and the owner's `walker_owner` cookie only on `/api/v1/walkers/...`. An owner can have up to 8 walkers; re-pairing makes a new one, so forget the old one first. |
| Walker configuration | The walker's own numbered settings | Version 1 is `WALKER_SETUP` (hand controls, obstacle sensors, voice; alerts by vibration and speech), made at pairing. Each confirmed change adds a version and never edits an old one. It is applied when the Pi's manifest reports that version. |
| Heartbeat | The Pi's report, every 5 s | Carries the capability manifest (each part's health and `simulated`, and `simulator` when the walker program runs on a computer; a simulator can still have a real part plugged in, so each part's own flag is what counts), the sensor snapshot, and the lines the walker said on its own since the last heartbeat (its notices and offline replies, at most the newest 50, each with how long ago it was said), so the page shows everything the walker said, in order. The answer says which configuration version is current and which proposal is open. 15 s without one means offline: then no part shows as available, no zone as measured, and any open proposal expires for good. |
| Assistant turn | One question and its answer | Voice or text from the Pi, with the snapshot it has at that moment; text from the page. A repeated `client_turn_id` returns the stored answer with a fresh status and runs nothing again. A walker turn's answer can carry the reply as speech in Cartesia's voice (16 kHz mono WAV, at most about a minute); without it (no key, the voice service failed, or the reply is too long), the walker speaks the reply with its own voice. `voiced_by` records the voice the server offered. Each turn records who heard it (typed, or Gemini's transcript, or nothing when transcription failed), who answered (the model or the fixed replies) and which voice the server offered to speak it. |
| Proposal | A change the assistant offers | Only `cues_change` exists. One open per walker; a newer one supersedes it; it expires after 60 s, or for good when the walker goes offline. It is confirmed only by its id, from the Confirm button or the page; voice can't confirm. The first answer wins: answering a proposal that isn't open gets `409 proposal_closed` with the proposal as it stands. The walker never judges expiry by its own clock; a Confirm press always asks the server. The summary is written by the server from the change itself. A proposal names the turn that made it, so a walker that cancelled that turn declines it. |
| Status view | What the page shows and the model reads | Parts with health and `simulated`, zones as measured with their age or as unknown (never clear), the open proposal, the last 10 turns and the last 10 lines the walker said on its own. A zone takes its `simulated` flag from the part that reported it; a zone from a part the walker doesn't list reads as unknown. |
| Button map | Talk and Confirm | Talk: hold to talk and release to send; a press while waiting cancels. Confirm: confirms the open proposal, or plays a "nothing to confirm" sound. The same names apply to GPIO buttons, ESP32 hand buttons and the simulator's keyboard. |

**Rules a cues change must pass** (`checkCuesChange`): at least one cue, no repeats, different from now, every cue deliverable by a part the walker has (vibration needs hand controls; sound and speech need voice; a walker has no screen), and a walker with obstacle sensors keeps vibration or sound, so a conversation can't silently turn obstacle alerts off.

**Freshness across two clocks** (`zoneViewReading`, `zoneViews`): the Pi's own timestamps decide whether a reading was still valid when the Pi sent it. The server's clock decides how long ago the server received it (more than 7 s, one heartbeat plus 2 s, is stale). The two clocks are never compared with each other, so a Pi with the wrong time can't make an old reading look fresh.

## Privacy and consent

- Spoken words go to Google's Gemini, and the text of Steady's replies goes to Cartesia to be spoken (a reply can repeat some of her words). The page and a card on the walker say so before anyone speaks. Both keys live only on the server (Render environment variables entered by Max); the Pi and the page never see them. Cartesia's data retention and training terms haven't been checked yet: until they are, the same rule as Gemini's free tier applies, scripted and fictional lines only. The project's Gemini decision says the free tier is for scripted, fictional lines only, so in the demo only the presenter speaks to the walker. Judges can type on the page instead, and the page says where typed words go.
- Voice clips stay in memory for one turn and are never stored or logged. Turns and the walker's lines are deleted an hour after they happen. "Forget this walker" on the page deletes the device, its turns, configurations and proposals, and revokes its credential.
- Logs carry ids, outcomes and timings, never words or audio.

## Accessibility

Voice is never the only path. Every spoken answer also appears on the page, every proposal can be confirmed from the page as well as the button, and the page works by keyboard and screen reader, with large text and reduced motion.

## Build plan

The full design, including the demo beats and what changed after the plan review, is kept by the lead. The pieces are: (1) this contract; (2) the cloud store, pairing, device auth and heartbeat on Render with Postgres; (3) the assistant turn and proposals; (4) the Pi service with a simulator on a Mac; (5) the "Your walker" page; (6) the demo script; (7) ESP32 firmware for the hand controls and obstacle sensors. Update this guide as each one lands.
