# Walker cloud, piece 3: expected results for the assistant turn

Written before the code (2026-10-23). Rows marked *(review)* were added or corrected after the break-it review. The walker in every case is the demo walker: the `WALKER_SETUP` configuration (hand controls, obstacle sensors, voice; alerts by buzzing and speech), running as the simulator with real hand controls and a simulated ToF sensor whose front zone reads 640 mm. Stub-model cases run against both stores; the live rows run against the server's own models with Max's keys (since 2026-10-25: Claude, `claude-haiku-5-5` with `claude-opus-5-5` as the backup, and Cartesia `ink-whisper` hearing the clips).

## The demo path (design beats 2 to 5)

Each line runs 3 of 3 as typed text and 3 of 3 as a synthetic `say` clip (16 kHz mono WAV), live.

| Beat | She says | Expected |
| --- | --- | --- |
| 2 | "What can you help me with?" | `answered_by: "model"`. The reply names what this walker has (hand controls, obstacle sensors, voice) and its alerts, in at most two short sentences, and claims nothing the walker doesn't report (no navigation, no arms). No proposal. Voice: `heard` is Cartesia's transcript, `heard_by: "cartesia"`; text: `heard` is what she typed, `heard_by: "typed"` |
| 3 | "Is anything in front of me?" | `topics` includes `obstacles`. The reply gives the front zone's measured distance (640 mm, said in a person's words such as "about 64 centimetres") and how old the reading is, and never says "clear". It ends "These readings are simulated." because the ToF part is simulated. With the front zone unknown, it says it doesn't know |
| 4 | "Stop buzzing me, use short sounds instead." | `cues_change: { cues: ["sound", "spoken"] }`. A proposal opens: `from_cues` `["vibration","spoken"]`, `cues` `["sound","spoken"]`, base version 1, `summary` "Switch your alerts from buzzing to short sounds." (written by the server), the turn's `client_turn_id`, expiring 60 s later. *(review)* The reply is written from that payload, so she hears exactly what Confirm will do: "I can switch your alerts from buzzing to short sounds. Press Confirm to do it." Nothing changes until Confirm; Confirm makes version 2 (piece 2) |
| 5 | "Can you pick up my keys?" | `topics` includes `arms`. The reply is the fixed line "This walker doesn't have robot arms, so I can't pick things up or move things." with `answered_by: "fixed"`. No proposal, no action request |
| + | 3 fresh wordings (not in the prompt or the script) | Same rules: a question about the walker, one about obstacles, one asking for a cues change |

## Server rules (stub model)

| Case | Expected |
| --- | --- |
| A reply longer than 350 characters | Rejected; one retry with a note that names the rule (never her words); a second long reply falls back |
| *(2026-10-23)* A reply the server will speak in the model's words says "clear" or "safe" in any form ("clears", "cleared", "clearance", "safer", "safest", "safety", "safely", "unsafe"; any case; even to deny it: "I cannot say if the way is clear"), whatever its `topics` | Rejected like a broken reply: one retry with a note naming the rule (never her words); a good second reply is used as is (`attempts: 2`); a second such reply falls back to the fixed line (`invalid_reply`). "clearly" passes. Not checked when the server replaces the words anyway: `topics` has `arms`, or a `cues_change` came with it |
| A `cues_change` that fails `checkCuesChange` (`alerts_off`, `undeliverable`, `unchanged`, `duplicate`) | Dropped, no proposal, and the reply is a fixed line saying why, `answered_by: "fixed"`. *(review)* An empty list never reaches the check: the reply schema refuses it, so it's retried and then falls back |
| A valid `cues_change` while the walker is offline | No proposal opens; a fixed line says the walker is offline |
| `topics` includes `arms` | The fixed line built from the manifest (no arm reported: "doesn't have robot arms"; an arm reported: "can't move the robot arms from a conversation"), `answered_by: "fixed"`, and any `cues_change` is dropped |
| `topics` includes `obstacles` and a reported ToF part is simulated | " These readings are simulated." is added; with a real ToF part, it isn't |
| A proposal opens | Its summary comes from the payload, it records the turn's `client_turn_id`, and the reply ends " Press Confirm to do it." |
| A turn arrives with a proposal already open | The reply ends " Press Confirm to do it." too (once, not twice) |
| A model reply that already says it made the change | Nothing changes: only Confirm by id changes the configuration (the model has no way to confirm). *(review)* Its words aren't spoken: the reply is the payload's offer, so a change that also drops speech says so |
| *(review)* `topics` includes `parts` and a reported part is simulated (and the obstacles line didn't apply) | " Some of this walker's parts are simulated." is added; when every reported part is simulated (the simulator), " All of this walker's parts are simulated." instead (rehearsal, 2026-10-23) |
| *(rehearsal, 2026-10-23)* A measured zone in the context | `reading_age` is the reading's age as it should be said, never milliseconds: 0 ms and 999 ms are "just now", 1,000 ms is "1 second ago", 44,000 ms is "44 seconds ago" (whole seconds, rounded down). With no age there's no wording, and an unknown zone has only `unknown` (why). The status view keeps the contract's `age_ms` for the page |
| *(rehearsal, 2026-10-23)* The policy, for a walker whose every reported part is simulated | It says the server adds "All of this walker's parts are simulated." itself when obstacles isn't in topics, so the model leaves that out. The server's rule above is unchanged |
| *(review)* A replay after the proposal expired, or the walker dropping offline during the model call | The response's `proposal` is read after expiry: `expired`, never `open` |
| *(review)* The walker is forgotten while the model answers | `404 not_found`, not `503` |
| A device turn carries its own snapshot | That snapshot, received now, is the turn's context instead of the heartbeat's (a stale heartbeat zone reads as measured from the turn's snapshot) |
| The last 10 turns and the open proposal | In the context, in the order: policy (the system prompt), walker and consent, configuration, parts and health with `simulated`, zones, open proposal, last 10 turns, her words |

## Fallback

| Case | Expected |
| --- | --- |
| The model throws, refuses, or replies badly twice, or 8 s pass | A fixed line from the status view (what still works: the walker's alerts), `answered_by: "fixed"` |
| A voice turn whose model call falls back | `heard` is Cartesia's transcript, `heard_by: "cartesia"` (added 2026-10-25: the transcript now comes before the model) |
| A text turn that falls back | `heard` is what she typed, `heard_by: "typed"` |
| No `ANTHROPIC_API_KEY` on the server | Every turn gets the fixed line, `answered_by: "fixed"` |

## Hearing a Talk press (added 2026-10-25)

Cartesia's speech-to-text turns the clip into words before Claude reads them; the clip itself never reaches the model.

| Case | Expected |
| --- | --- |
| A clip Cartesia hears as words | The model gets those words as `person_words`, with `how_they_asked` "spoke while holding Talk"; no audio in the request; the turn stores `heard` = the transcript, `heard_by: "cartesia"` |
| Cartesia hears no words (`""`) | "I didn't catch that. Please hold Talk and say it again.", `answered_by: "fixed"`, reason `not_heard`, no model call, `heard: null` |
| No `CARTESIA_API_KEY`, a Cartesia error, or no transcript within 2.5 s | "I can't hear you right now. You can type your question on the walker's page.", reason `cant_hear`, no model call |
| The request to Cartesia | `POST https://api.cartesia.ai/stt`, `Authorization: Bearer <key>`, `Cartesia-Version: 2026-08-14`, multipart `file` (the clip, unchanged), `model` `ink-whisper`, `language` `en`; the reply's `text`, trimmed |

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

## Activity log (page only, the /walker page's live companion)

Written before the code (2026-10-23). The server keeps one `ActivityLog` per process (on `globalThis`), in memory only, and returns it on `GET /walkers` as `activity` (`WalkerActivityViewSchema`). It holds ids, kinds, rule codes and milliseconds, never anyone's words. Stub model, in-memory store, fake clock.

| Case | Expected |
| --- | --- |
| A turn while the model is still answering (a slow stub) | The owner's list shows one `in_flight` entry for that walker: its `client_turn_id`, `input`, `since` (the server's clock when the clip or text was accepted), `clip_ms` (from the WAV's samples, 1,200 ms clip → 1200; null for text), `stage: "hearing"` and `model`: the family of the model asked ("claude"), null without one |
| A spoken turn while Cartesia is still transcribing (a slow stub) *(2026-10-25)* | `stage: "transcribing"`, then `"hearing"` once the model is asked; its trace has `transcribe_ms` a number (null on a typed turn) |
| A spoken turn, and the text continuation of a spoken turn after a tool (`original_audio: true`) | Answered by Claude like a typed one; `heard_by: "cartesia"` on both, never `"typed"` |
| The main model with its backup (hedge.ts), on a turn with tool results and message recipients | Both models get the same tool results and recipients |
| The same turn while Cartesia is making the audio (a slow stub voice) | `stage: "voicing"` |
| After the turn answers | `in_flight` is empty, and one trace is there |
| The model throws; the model passes its deadline (fallback line); the walker is forgotten during the model (`saveTurn` returns null, 404); the response fails its schema; the store throws while saving | `in_flight` is empty afterwards every time |
| A clip that isn't a 16 kHz mono WAV; a replay of a stored `client_turn_id` | Never shows in `in_flight` (it's set only after those checks) and adds no trace |
| Two uploads of one `client_turn_id` at once | One `in_flight` entry while both run; it stays while the second is still running after the first ends; it clears when both end. One trace (the second saved nothing new) |
| Trace for the model's own words (typed on the walker, no voice configured) | `model_ran: true`, `model: "claude"`, `model_ms` a number, `transcribe_ms: null`, `rule: null`, `answered_by: "model"`, `proposal_opened: false`, `voiced_by: "walker"`, `voice_ms: null` (no Cartesia call), `input: "text"`, `clip_ms: null`, `at` = when it was saved, `total_ms` a number, `turn_id` and `client_turn_id` the stored turn's |
| Trace for the arms line | `rule: "arms"`, `answered_by: "fixed"`, `model_ran: true` |
| Trace for a cues change that would turn alerts off | `rule: "cues_alerts_off"`, `answered_by: "fixed"`, `proposal_opened: false` |
| Trace for an opened proposal | `proposal_opened: true`, `answered_by: "model"`, `rule: null` |
| Trace for a typed page turn | `input: "text"`, `voiced_by: null`, `voice_ms: null` |
| Trace for a spoken walker turn with Cartesia answering | `input: "audio"`, `clip_ms: 1200`, `voiced_by: "cartesia"`, `voice_ms` a number |
| No model configured | `model_ran: false`, `model_ms: null`, `rule: "no_model"`, `answered_by: "fixed"` |
| 12 turns on one walker | 10 traces (`RECENT_TURNS`), the newest 10, oldest first |
| 5 turns of one walker in flight at once | 4 `in_flight` entries; the fifth isn't shown. *(design, while building)* Its trace is still recorded when it saves, so 5 traces afterwards |
| The clock moves past `WALKER_HISTORY_RETENTION_MS` (an hour) after a trace | The trace is gone, and a walker with nothing left is left out of `activity` |
| The owner forgets the walker | Its activity entry is deleted at once |
| Owner A and owner B each have a walker with activity | A's list carries only A's walker's activity, B's only B's; an owner with no activity gets no `activity` key at all (`{ walkers: [...] }` as before) |
| The log, dumped as JSON after typed and spoken turns | Contains none of the person's words or the replies |
| `GET /api/v1/walkers` after a page turn, over HTTP | 200, parses with `WalkerListResponseSchema`, and carries that walker's trace |

## Walking directions (route tools)

Written before the code (2026-10-24), from [the navigation guide](../../../../docs/subsystems/navigation.md#the-cloud-servicescloud-api). The Pi runs `start_route` and `stop_route`; the cloud only offers them, passes `destination` on, and ends the loop. Stub model unless marked live. "Route summary" below is `{ destination: "Lake Merritt Boating Center", phase: "guiding", next: "Turn left onto Lenox Avenue.", to_next_m: 120, remaining_m: 620, remaining_min: 9, simulated: true }`.

| Case | Expected |
| --- | --- |
| A device turn with `navigation` (route null or a route summary) | The schema sent to the model offers `start_route` (with `destination`) and `stop_route`; the system prompt carries the walking-directions rules (not "can't navigate"); the context's `walking_directions` is the route summary, or null with no route on |
| A device turn without `navigation` (an older Pi, or no position source) | The schema offers neither route tool; the prompt keeps "This walker can't navigate, plan routes"; `walking_directions` is null |
| A page turn | The schema offers neither route tool; the prompt says directions work only through Talk, asks her to use Talk for them, and doesn't list directions among what Sophi can do (the page can't tell whether the walker has a position source). *(live, 2026-10-24)* The first version gave the page the walker's rules, and beat 2 on the page then offered "walking directions" on 3 of 3 runs |
| The model asks for `start_route` with `destination` on a spoken walker turn with `navigation` | Unfinished response: `tool_call: { name: "start_route", destination: "the Lake Merritt Boating Center" }` (her words as the model passed them, trimmed), reply "Let me find that.", `answered_by: "fixed"`; nothing stored |
| The model asks for `stop_route` | `tool_call: { name: "stop_route" }`, reply "Stopping the directions." |
| `destination` over 80 characters, empty, or with a line break | The reply breaks the schema: one retry with a note naming the rule (never her words); a second such reply falls back to the fixed line; no `tool_call` |
| A route tool the server didn't offer: on a device turn without `navigation` | No `tool_call`; the fixed line "I can't give walking directions on this walker.", reason `route_unavailable` |
| A route tool on a page turn | "Please use Talk on the walker for that request.", reason `device_tool_only`; no `tool_call` |
| A continuation whose `tool_results` holds a `start_route` (or `stop_route`) result, and the model answers | The model's reply is the final turn (stored once, spoken), as with any tool |
| *(live, 2026-10-24)* Any continuation of a spoken turn (`original_audio: true`) | The context's `how_they_asked` is "spoke while holding Talk", not "typed on the walker" (the first live run had the model answer "please use Talk" after `get_location` on 3 of 3 runs, and once after `start_route`) |
| The same continuation, but the model asks for another tool (a second route tool, or `get_location`) | Not run: no `tool_call`; the fixed line "I couldn't finish checking all of that right now.", reason `route_once`. At most one route tool per turn |
| "Take me to ..." with `topics: ["directions"]` and `start_route` | Runs `start_route`, not the arms line. (With `arms` in topics the arms rule still drops every tool call, as before; the live rows check the model doesn't tag it so) |
| The "I'll check" line | Comes from one record over every `WalkerToolName`, so each tool has its own line: location, weather, sensors, "Let me find that.", "Stopping the directions." |
| A final reply after a route result says "clear" or "safe" | Retried like any final reply (the clear/safe check still applies) |
| Existing tool loop | `get_location` on a spoken walker turn still returns `tool_call: { name: "get_location" }` with "I'll check your GPS location now."; on a page turn the Talk line; `get_distance` on a page turn the server's sensor line |

Live (the server's real models and its spoken path: a synthetic `say` clip, continuations as text with `original_audio`, the Pi's tool results faked by the harness), fresh wording, three runs each:

| She says | Context | Expected |
| --- | --- | --- |
| "Take me to the Lake Merritt Boating Center" | `navigation: { route: null }` | `start_route` with a destination naming the Lake Merritt Boating Center; after the result, one short sentence that it found the place and is starting directions |
| "Can you give me walking directions to the library?" | `navigation: { route: null }` | `start_route` with a destination naming the library |
| "How far is it now?" | the route summary | No tool; the reply gives the remaining distance (620 m, in a person's words) and says it's simulated |
| "Stop the directions" | the route summary | `stop_route` |
| "Where am I?" | `navigation: { route: null }` | `get_location` |
| "Pick up the cup" | `navigation: { route: null }` | The arms line, no route tool |
## Pulling something up on the walker's screen (`show_on_screen`)

Written before the code (2026-10-24), from [the show-on-screen guide](../../../../docs/subsystems/show-on-screen.md). Stub model, both stores. The walker is the demo walker; "with a screen" means the turn request carries `screen: { views: [...] }`, as the Pi sends while a screen page is connected.

| Case | Expected |
| --- | --- |
| A walker turn with `screen: { views: ["weather", "sensors"] }` | The schema sent to the model offers `show_on_screen`, with `view` limited to `weather` and `sensors` (not `location`, `message` or `parts`); the context's `screen_views` is `["weather", "sensors"]` |
| A walker turn without `screen` (an older Pi, or no screen page connected), and a page turn | The schema doesn't offer `show_on_screen` at all; `screen_views` is `[]` |
| The system prompt | Says to request `show_on_screen` when she asks to see, show, display or pull up one of the five things, only for a view in `screen_views`; never to say it's on the screen until a `show_on_screen` result says so; that a message's words aren't in the result and mustn't be invented; Talk on a page turn. The old rules stay (never "clear" or "safe") and nothing says the walker has no screen |
| The model asks for a listed view on a spoken walker turn | Unfinished response: `tool_call: { name: "show_on_screen", view: "weather" }` (parses with `WalkerToolCallSchema`), reply "Putting that on your screen.", `answered_by: "fixed"`, `heard` her transcript; nothing stored |
| The model asks for a listed view with an empty `reply` (added 2026-10-24 after the live check: both live models often left `reply` empty when asking for `show_on_screen`, on 15 of 18 logged first attempts, and the reply check rejected it, costing a retry and, in 2 of 4 runs, the turn) | Accepted on the first call, no retry: the same unfinished response with "Putting that on your screen." (the server's line, never the model's) |
| *(2026-10-25)* The model asks for `get_distance`, `get_weather` or `get_location` on a spoken turn with an empty `reply` (Claude Haiku did this with `get_distance` on "Is anything in front of me?" on 5 of 5 live first attempts) | Accepted on the first call, no retry: the server's "I'll check…" line. With nothing copied back in `transcript`, still retried |
| An empty `reply` with `show_on_screen` but an empty transcript on a spoken turn (nothing was heard), or with no `tool_call` | Rejected as before and retried once; a second empty reply gets the fixed fallback line, never an empty answer |
| The model asks for a view the turn didn't list (`location` with `["weather"]`), or any view on a walker turn without `screen` | No `tool_call`; the fixed line "I can't show that on this walker's screen right now.", reason `show_unavailable` |
| The model asks for `show_on_screen` on a page turn | No `tool_call`; "Please use Talk on the walker for that request.", reason `device_tool_only` |
| A continuation whose `tool_results` holds a `show_on_screen` result, and the model answers | The model's reply is the final turn (stored once, spoken), `answered_by: "model"`; the context carries the result, `screen_views`, and `how_they_asked: "spoke while holding Talk"` |
| That continuation after a sensors card, the reply tagged `obstacles` | The model's reply is used, not the fixed distance line (the card's result is the reading she asked about). A reply that says "clear" or "safe" is still retried once (`attempts: 2`) and a good second reply is used |
| That continuation after a weather card whose result says "Weather data from Open-Meteo." | The reply ends with " Weather data from Open-Meteo." when the model left it out, as after `get_weather` |
| A continuation already holding `WALKER_MAX_TOOL_CALLS` results, and the model asks for `show_on_screen` | Not run: the fixed line "I couldn't finish checking all of that right now.", reason `tool_limit` |
| The "I'll check" line | Comes from one record over every `WalkerToolName`, so each tool has its own: "I'll check your GPS location now.", "I'll check the weather near you now.", "I'll check the obstacle sensors now.", "Putting that on your screen." |
| The backup model (hedge.ts) | Gets the same `screen` views as the main model |
