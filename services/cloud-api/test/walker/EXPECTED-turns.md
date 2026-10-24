# Walker cloud, piece 3: expected results for the assistant turn

Written before the code (2026-10-24). Rows marked *(review)* were added or corrected after the break-it review. The walker in every case is the demo walker: the `WALKER_SETUP` configuration (hand controls, obstacle sensors, voice; alerts by buzzing and speech), running as the simulator with real hand controls and a simulated ToF sensor whose front zone reads 640 mm. Stub-model cases run against both stores; the live rows run against Gemini (`gemini-3.7-flash`) with Max's key.

## The demo path (design beats 2 to 5)

Each line runs 3 of 3 as typed text and 3 of 3 as a synthetic `say` clip (16 kHz mono WAV), live.

| Beat | She says | Expected |
| --- | --- | --- |
| 2 | "What can you help me with?" | `answered_by: "model"`. The reply names what this walker has (hand controls, obstacle sensors, voice) and its alerts, in at most two short sentences, and claims nothing the walker doesn't report (no navigation, no arms). No proposal. Voice: `heard` is the transcript, `heard_by: "gemini"`; text: `heard` is what she typed, `heard_by: "typed"` |
| 3 | "Is anything in front of me?" | `topics` includes `obstacles`. The reply gives the front zone's measured distance (640 mm, said in a person's words such as "about 64 centimetres") and how old the reading is, and never says "clear". It ends "These readings are simulated." because the ToF part is simulated. With the front zone unknown, it says it doesn't know |
| 4 | "Stop buzzing me, use short sounds instead." | `cues_change: { cues: ["sound", "spoken"] }`. A proposal opens: `from_cues` `["vibration","spoken"]`, `cues` `["sound","spoken"]`, base version 1, `summary` "Switch your alerts from buzzing to short sounds." (written by the server), the turn's `client_turn_id`, expiring 60 s later. *(review)* The reply is written from that payload, so she hears exactly what Confirm will do: "I can switch your alerts from buzzing to short sounds. Press Confirm to do it." Nothing changes until Confirm; Confirm makes version 2 (piece 2) |
| 5 | "Can you pick up my keys?" | `topics` includes `arms`. The reply is the fixed line "This walker doesn't have robot arms, so I can't pick things up or move things." with `answered_by: "fixed"`. No proposal, no action request |
| + | 3 fresh wordings (not in the prompt or the script) | Same rules: a question about the walker, one about obstacles, one asking for a cues change |

## Server rules (stub model)

| Case | Expected |
| --- | --- |
| A reply longer than 350 characters | Rejected; one retry with a note that names the rule (never her words); a second long reply falls back |
| A `cues_change` that fails `checkCuesChange` (`alerts_off`, `undeliverable`, `unchanged`, `duplicate`) | Dropped, no proposal, and the reply is a fixed line saying why, `answered_by: "fixed"`. *(review)* An empty list never reaches the check: the reply schema refuses it, so it's retried and then falls back |
| A valid `cues_change` while the walker is offline | No proposal opens; a fixed line says the walker is offline |
| `topics` includes `arms` | The fixed line built from the manifest (no arm reported: "doesn't have robot arms"; an arm reported: "can't move the robot arms from a conversation"), `answered_by: "fixed"`, and any `cues_change` is dropped |
| `topics` includes `obstacles` and a reported ToF part is simulated | " These readings are simulated." is added; with a real ToF part, it isn't |
| A proposal opens | Its summary comes from the payload, it records the turn's `client_turn_id`, and the reply ends " Press Confirm to do it." |
| A turn arrives with a proposal already open | The reply ends " Press Confirm to do it." too (once, not twice) |
| A model reply that already says it made the change | Nothing changes: only Confirm by id changes the configuration (the model has no way to confirm). *(review)* Its words aren't spoken: the reply is the payload's offer, so a change that also drops speech says so |
| *(review)* `topics` includes `parts` and a reported part is simulated (and the obstacles line didn't apply) | " Some of this walker's parts are simulated." is added; when every reported part is simulated (the simulator), " All of this walker's parts are simulated." instead (rehearsal, 2026-10-24) |
| *(review)* A replay after the proposal expired, or the walker dropping offline during the model call | The response's `proposal` is read after expiry: `expired`, never `open` |
| *(review)* The walker is forgotten while the model answers | `404 not_found`, not `503` |
| A device turn carries its own snapshot | That snapshot, received now, is the turn's context instead of the heartbeat's (a stale heartbeat zone reads as measured from the turn's snapshot) |
| The last 10 turns and the open proposal | In the context, in the order: policy (the system prompt), walker and consent, configuration, parts and health with `simulated`, zones, open proposal, last 10 turns, her words |

## Fallback

| Case | Expected |
| --- | --- |
| The model throws, refuses, or replies badly twice, or 8 s pass | A fixed line from the status view (what still works: the walker's alerts), `answered_by: "fixed"` |
| A voice turn that falls back before a transcript came back | `heard: null`, `heard_by: null` |
| A text turn that falls back | `heard` is what she typed, `heard_by: "typed"` |
| No `GEMINI_API_KEY` on the server | Every turn gets the fixed line, `answered_by: "fixed"` |

## Idempotency

| Case | Expected |
| --- | --- |
| The same `client_turn_id` again | The stored turn and proposal, a fresh status, `speech: null`; the model isn't called again |
| Two uploads of one `client_turn_id` at once | One turn and at most one proposal are stored; both get the same turn |

## Speech (Cartesia; stubbed fetch, live check waits for Max's key)

| Case | Expected |
| --- | --- |
| A walker turn with `CARTESIA_API_KEY` set and Cartesia answering a 16 kHz mono 16-bit WAV | `speech: { mime: "audio/wav", data_base64 }`, `voiced_by: "cartesia"`. The request is `POST https://api.cartesia.ai/tts/bytes` with `Authorization: Bearer`, `Cartesia-Version: 2026-08-14`, model `sonic-3.6`, a stock voice id, `output_format` `{ container: "wav", encoding: "pcm_s16le", sample_rate: 16000 }`, `language: "en"`, and the reply text only |
| No key; an HTTP error; more than 3 s; audio over `SPEECH_MAX_BYTES`; audio that isn't 16 kHz mono 16-bit WAV | `speech: null`, `voiced_by: "walker"` |
| A page turn | Never spoken: `speech: null`, `voiced_by: null` |
| The whole walker turn *(review)* | The server's part, from reading the upload to the reply and its audio, stays within 8 s, leaving time for the audio's download before the Pi's 10 s: the model gets at most 8 s and only what's left of the budget, the voice at most 3 s and only what's left |
| *(review)* Speech Cartesia returns as `WAVE_FORMAT_EXTENSIBLE`, or with no samples | Refused like other unplayable audio, matching the Pi's player: `speech: null`, `voiced_by: "walker"` |

## Routes and privacy

| Case | Expected |
| --- | --- |
| `POST /devices/{id}/turns` with a voice clip of up to 500,000 bytes (15 s is 480,044) | Accepted (body limit 800 KB, which refuses a larger body before parsing; a longer clip is refused by the contract); the clip isn't stored or logged |
| A clip that isn't a RIFF/WAVE file | `400 invalid_request` |
| `POST /walkers/{id}/turns` | Text only, with the owner cookie; device and page proofs stay separate |
| Every turn response | Parses with `WalkerTurnResponseSchema` |
| Logs | Ids, outcomes, attempts and milliseconds (model and voice); never words or audio |
| Stored turn text | NUL and half surrogate pairs become U+FFFD, as in piece 2 |
