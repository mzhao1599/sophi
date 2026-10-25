# Expected results for the Pi service (written before the tests)

Revised 2026-10-23 when the walker contract landed (PR #26): rows marked *(contract)* changed or were added then, before their tests were changed. Rows marked *(review)* were added from the break-it review, before their fixes.

Each row says what must happen. The test that checks it carries the row's id (for example `B4`) in its name. Every time value comes from an injected fake clock; no test sleeps, records the room or plays sound out loud.

All numbers marked *placeholder* are not measured. They live in `src/constants.ts` and are labelled there too.

## Boot and pairing

| Id | Situation | Expected |
| --- | --- | --- |
| P1 | Service starts | The first spoken line is "Sophi is on." Nothing records until a Talk press. |
| P2 | No credential file, Talk pressed | Spoken "I'm not paired yet. Open the walker page to get a pairing code." No recording, no request. |
| P3 | `walker pair` succeeds | The credential file is written with mode 0600 in a 0700 folder, and the pairing's configuration 1 is saved *(contract)*. The command prints the device id, never the credential. |
| P4 | Credential file appears while running | The next heartbeat tick reads it; the link goes `connecting`, then `online` on the first good heartbeat. |
| P5 | Any log line | Never contains the credential, an `Authorization` header or audio bytes. |
| P7 | A credential file whose server isn't https (or http to this machine), or one the service can't read *(review)* | Treated as no credential ("I'm not paired yet"), with the reason logged; the service keeps running instead of crashing in a loop. |
| P8 | Saving a fetched configuration fails (read-only SD card) *(review)* | The new configuration still applies in memory; the failure is logged. |
| P9 | A credential appears while running with none before it (for example after fixing its permissions) *(review 2)* | The configuration is read again from disk, and a server version that differs from the local one, lower as well as higher, is fetched. |
| P10 | `walker pair` against a server that is asleep or starting *(contract notes, PR #33)* | It says "Waking the server…" and calls `GET /api/v1/health`, retrying every 2 s through refused connections and 503s, for up to 90 s in all. It claims the code only after a 200 whose body says `"status": "ok"` (an HTML or other 200 is not awake). A server that never wakes, or holds the health request open, gets "The server didn't wake up within 90 seconds…", and the code is never sent. |
| P14 | `--server` isn't https (or http to this machine) *(review)* | Fails at once with "The server must use https://", before "Waking the server…" and without waiting. |
| P11 | The pairing request itself *(contract notes)* | Sent once: a code works once, so a pairing that fails or times out (20 s, *placeholder*) is never retried. Every failure after the code may have been spent (a timeout, a dropped connection, a server error, an unreadable answer, a failed save) says the code may have been used and to get a new one. |
| P12 | Health says `walker_store: "off"` *(contract notes)* | Stops before claiming the code: "This server has walkers turned off." |
| P13 | Pairing returns configuration 1 *(contract notes)* | The walker adopts it, replacing any configuration from an earlier pairing, even one with a higher version. |
| P6 | Heartbeat and turn snapshot *(contract)* | `null` when no obstacle sensor has said hello; otherwise the fresh zones. The manifest says `simulator` and each part's `simulated`. |

## Buttons (the design's button map)

| Id | Sequence | Expected |
| --- | --- | --- |
| B1 | Online, idle. Talk pressed (GPIO), released after 2 s | "listening" cue, then the mic opens. On release: "done" cue, one turn sent with a fresh `client_turn_id` and a 16 kHz mono 16-bit WAV of 2 s (64,044 bytes). The reply is spoken. The clip buffer is zeroed once the request settles. |
| B2 | Talk held past 15 s | Recording stops at 15 s and the turn is sent. The clip is at most 480,044 bytes (under 1 MB). The later release does nothing. |
| B3 | Talk tapped for under 300 ms (*placeholder*) | Nothing is sent. Spoken "I didn't catch that. Hold Talk while you speak." |
| B24 | ESP32 Talk briefly released and re-pressed | The firmware filters releases shorter than 250 ms. If a release reaches the Pi, it waits another 900 ms before sending; a re-press from that same hand during the grace continues the original recording, with one mic start and one turn. A duplicate pressed edge during the hold is ignored. An actual release adds 900 ms before the clip is sent. |
| B4 | Talk pressed while a turn is waiting | The request is aborted, "Cancelled." is spoken, and a late reply is never spoken. |
| B5 | Talk pressed while a reply is being spoken | Speech stops and a new recording starts. |
| B6 | Keyboard (simulator): Talk, Talk | First press starts recording, the second press sends. A terminal can't see key release, so no release events exist. |
| B7 | Online, open proposal, Confirm pressed | One `confirm` answer for that proposal id. The answer's proposal is `confirmed` with `configuration_version` 2: configuration 2 is fetched and saved, the "done" cue plays, "Done. Obstacle alerts now use short sounds." is spoken, and the next heartbeat's manifest reports version 2. |
| B8 | No open proposal and no message of hers to hear again, Confirm pressed | "nothing to confirm" cue and the status line "Nothing to confirm." (a `local_reply` event). No request. (With a message, see CM6.) |
| B9 | Confirm pressed while recording | From the simulator keyboard (Talk toggles): ignored, no request, recording continues. From a held Talk on GPIO or a hand board it is the help chord instead: the recording is dropped (GH3, *changed 2026-10-24*). |
| B10 | Confirm pressed twice quickly | One request. |
| B11 | Confirm answered `409 proposal_closed` with the proposal `expired`, `superseded` or `declined`, or `404` *(contract)* | The "nothing to confirm" cue and status line; the Pi forgets that proposal. Configuration unchanged. (The Pi never judges expiry by its own clock.) |
| B16 | Confirm answered `409 proposal_closed` with the proposal `confirmed` (the page's Confirm won first) *(contract)* | Treated as success: configuration 2 is fetched and "Done. Obstacle alerts now use short sounds." is spoken. |
| B17 | Talk cancels a turn whose request reached the server and opened a proposal *(contract)* | The next heartbeat's open proposal names that `client_turn_id`: the Pi declines it once, never offers it to Confirm, and a Confirm press says nothing to confirm. |
| B12 | ESP32 `hand.input` with `button: "talk"` from a module whose hello declared `button.talk` | On `hand-left-*`, the Pi maps the GPIO32 wire event to Confirm, including its release; on the right hand it remains Talk. From a module that didn't declare it, or before its hello: ignored. A trigger-only line: no button event. |
| B13 | GPIO bounce: pressed, released, pressed within 30 ms (*placeholder*) | One press, emitted once the line has been steady for 30 ms. A real tap (pressed, then released 100 ms later) gives one press and one release. |
| B14 | `gpiomon` output | libgpiod v1 `--format '%o %e'` lines (`17 0`, `17 1`) and v2 `--format '%o %E'` lines (`17 falling`, `17 rising`) both parse. Buttons wire to ground with the pull-up on, so falling is pressed. Unknown offsets and junk lines are ignored. |
| B22 | A new configuration is applied (after Confirm, or learned from a heartbeat) *(rehearsal)* | The walker reports it at once with an extra heartbeat (or right after the one in flight), so the page shows "Applied" within about a second, not at the next 5 s tick. Only when the version actually changed, so a server whose two answers disagree can't make it loop. A failed heartbeat keeps its backoff. |
| B15 | Talk pressed while offline, unpaired, connecting or needing a re-pair | A local line at once (see O4, P2, A2), no recording. |
| B18 | A heartbeat answer that left before a turn opened a proposal, or before a Confirm closed one, arrives late *(review)* | It doesn't overwrite the newer knowledge: the turn's proposal stays confirmable, and a closed one isn't reopened. |
| B19 | The button source that started a recording goes away while Talk is held: its hand module goes unavailable or says hello again (a reboot), or `gpiomon` exits *(review)* | The recording is discarded, nothing is sent, and "I stopped listening because the button stopped responding." is spoken. After `gpiomon` restarts, the next real press works. |
| B20 | The listening cue's player hangs *(review)* | The mic opens anyway after 1 s. |
| B21 | A turn that ends without its reply being heard: it timed out, failed, or came back unreadable *(review 2)* | Treated like a cancelled turn: a proposal it opened is declined on the next heartbeat, never offered to Confirm. *Decision for review.* |
| B23 | Talk pressed on an ESP32 hand that declared `haptic` and is `ok` *(press buzz, 2026-10-23: "I click it and it buzzes")* | One `haptic.play` `recording` 150 ms (*placeholder*) to that same hand, as well as the "listening" sound. Recording starts exactly as without it (the mic opens, one turn is sent on release). Every Talk press from a hand buzzes, including one that cancels a wait or gets a local line. A release never buzzes. |
| B24 | Confirm pressed on that hand, and it confirms the open proposal *(press buzz)* | One `haptic.play` `confirmation` 250 ms (*placeholder*) to that hand, as soon as the server says confirmed, as well as the "done" sound. |
| B25 | Confirm pressed on that hand, and it confirms nothing: nothing open, the proposal closed, a second press while the first is answered, offline or a failed request *(press buzz)* | One `haptic.play` `error` 250 ms (*placeholder*) to that hand. The sounds and lines are unchanged. Each Confirm press buzzes once. A Confirm that makes the help chord (Talk held) doesn't buzz: the `help` cue plays (GH1, *changed 2026-10-24*). |
| B26 | A GPIO press or a simulator keyboard press *(press buzz)* | No haptic: the Pi's header buttons and the keyboard have no motor. |
| B27 | A press from a hand that can't buzz (no `haptic` in its hello, a haptic fault, not `ok`) or whose port is busy *(press buzz)* | No haptic and no error; the sounds, the recording and the turn are unchanged. |
| B28 | Press buzz and obstacle alerts *(press buzz)* | The press buzz plays whatever the obstacle cue setting is (also with `cues: ["sound"]`): it is button feedback, not an obstacle alert. It doesn't count as one: a near zone right after a press still gets its own `near_obstacle` buzz, and with `cues: ["sound"]` still only the obstacle sound. |

## Her messages (`src/service.ts`, added 2026-10-24)

A caretaker's message to her phone, read aloud by the walker (`test/messages.test.ts`, fake clock and fake cloud). The words are someone's own: never on the page, in a model or voice-service request, or in a log line.

| Id | Situation | Expected |
| --- | --- | --- |
| CM1 | Messages already there at the first messages answer after start or pairing | None is read aloud. Confirm with nothing to confirm reads the newest one (CM6). |
| CM2 | A new message arrives (the fetch after a heartbeat that succeeded) | Spoken once, in the walker's own voice: "Message from Maya. Dinner at six. I'll get you." (kind `message`). No heartbeat event carries its words, and no turn or speech request is made (only heartbeats, the messages fetch and, since 2026-10-24, the help status poll). |
| CM3 | The same message in later answers | Not read again. |
| CM4 | A message arrives while Talk is held or her turn is waiting | Read only once Talk is idle, after the reply. |
| CM5 | A message arrives while a spoken message draft waits for Confirm | Read once the draft is sent, cleared or past its 30 s. |
| CM6 | Confirm pressed with nothing to confirm and a message of hers | The newest message is read again, the same line; offline too. No request, no "nothing to confirm" cue, and a hand that can buzz gets `confirmation`. A press while a message is being read does nothing more. |
| CM7 | Confirm pressed with an open proposal and a message | The proposal is answered (B7); no message is read. |
| CM8 | A message the server no longer sends (deleted after 24 hours, or a phone removed) | Not read if still waiting; not heard again (Confirm then says nothing to confirm). |
| CM9 | The server has no messages route (an older one answers 404) | One warning ("couldn't fetch messages"), asked again after 60 s (*placeholder*); heartbeats, turns and Confirm are unaffected. A network failure is left to the heartbeat (no warning, no wait). |
| CM10 | The walker is unpaired, gets a 401, or is paired to another walker | Every message is forgotten: none is read or heard again, and the next walker's first answer is CM1. |
| CM11 | Talk pressed while a message is being read | The message stops and listening starts (B5); Confirm reads it again afterwards. |
| CM12 | A `message` line in the logs *(the logging rule)* | Logged by length only on the Pi ("(29 characters)"), like a reply. |

## Asking for help (`src/help.ts`, added 2026-10-24)

The walker's side of "Get help" ([docs/subsystems/help.md](../../../docs/subsystems/help.md), "The walker (Pi)"; revised the same day for the reviewed contract, c9aba72, before its code). Rows GH1 to GH36 run on a fake clock against the fake cloud's help routes (`test/help.test.ts`); GM rows are the motion coordinator's part (`test/help-motion.test.ts`); GS rows are the screen machine (`test/help-screen.test.ts`); GW rows are real-time runs of the bundled CLI against the simulator, not in the suite. Every spoken line is the design's table word for word, gender-neutral. Times are from the press that made both buttons down (the chord) or from the start of the countdown. Timings marked *placeholder* are in `src/constants.ts`; the others are the contract's (`HELP_*` in `walker.ts`).

### The chord and who owns Confirm

| Id | Situation | Expected |
| --- | --- | --- |
| GH1 | The chord: Talk (right) and Confirm (left) both down, on GPIO or on the ESP32 hand boards, held | At the press that makes both down: the `help` cue, the screen `help_hold`, any line playing stops. At 2,000 ms (HELP_HOLD_MS), both still down: "Asking for help." (kind `help`), the screen `help` `sending` (not retrying), and exactly one `POST /devices/{id}/help` with `{ client_help_id, source: "handles" }`. Releasing both afterwards sends nothing more. |
| GH2 | Either button let go at 1,900 ms | Nothing sent (no help call at 2 s, 2.5 s or later), nothing said, the screen back to what was under it (the clock). Pressing both again starts a new hold from 0. |
| GH3 | Talk first (it started listening), then Confirm | The recording that Talk press opened is dropped: the mic session is aborted, Talk goes idle, the `turn` outcome is `discarded`, no turn request is made, "I stopped listening…" is not said. The Talk release that follows sends nothing. |
| GH4 | Confirm first with nothing to start (no proposal, draft, motion target or open help), then Talk within 250 ms | Confirm acts on its press at once as today (the "nothing to confirm" sound; with a message of hers, it is read again). Talk's press makes the chord: no listening sound, no mic opened. |
| GH5 | Confirm that would start something (an open proposal, a ready message draft, arming "I'm okay"), then Talk within 250 ms (HELP_CHORD_WINDOW_MS) | The Confirm does nothing: no proposal answer, no message sent, nothing armed. The chord goes on (GH1). |
| GH6 | The same Confirm alone (no Talk within 250 ms) | It acts 250 ms after its press: the proposal is answered, the draft sent, or "I'm okay" armed, exactly once. A Talk press after the window is a Talk press. |
| GH7 | The simulator keyboard's `t` and `c` | Never a chord (a terminal sees only presses) and never delayed. The simulator's `h` key and the script's `chord <ms>` press the simulated hand board's two buttons and release them after the hold (`h`: 2.5 s), through the real ESP32 path. |
| GH8 | A motion runs when the chord starts | The first press stops it at once (the coordinator claims the press; stopping never waits), and the chord still goes on: the `help` cue, `help_hold`, and the ask at 2 s. |
| GH9 | While `help_hold`, `help_countdown` or an open request (not `sending`, `not_sent` or `closed`) | Help owns Confirm: the coordinator is told (`helpActive(true)`), a proposal from a turn is declined and a message draft from a turn is dropped (as while a motion target owns Confirm), a heartbeat's proposal isn't adopted. When help no longer owns it, `helpActive(false)`. |

### Voice, sending and polling

| Id | Situation | Expected |
| --- | --- | --- |
| GH10 | Talk turns before any `GET /devices/{id}/help` answered 200 in this run (an older server, or before the first poll) | Carry no `can_ask_for_help`. |
| GH11 | Talk turns after a 200 | Every request of the turn carries `can_ask_for_help: true`, the first and a tool continuation alike. |
| GH12 | A turn answer with `ask_for_help: true` | The reply is spoken as an answer (captions, kind `reply`). Once it has played: `help_countdown` 8, then 7, … 1, once a second; no other line. At 8 s after the countdown began: "Asking for help." and one POST with `source: "voice"`. |
| GH13 | A handle press during the countdown (Talk at 3 s; Confirm at 3 s; either while the reply itself still plays) | "Okay. I didn't ask anyone.", the screen back, no POST then or later. The press does nothing else: Talk opens no mic, Confirm answers nothing, reads no message and arms nothing; a press during the reply stops the reply and no countdown starts. The next press acts as usual. |
| GH14 | The first try fails (network down, no answer by the 10 s deadline (*placeholder*), or a 5xx) | "No internet yet. I'll keep trying." once; the screen `sending` with `retrying: true`. Tries again 5 s (*placeholder*) after each failure with the same `client_help_id`. When a try gets through: the sent line (GH20). |
| GH15 | It never gets through | A try starts 5 s after each failure only while it would start within HELP_SEND_RETRY_MS (120 s) of the first. After the last failure: "I couldn't reach the internet, so nothing was sent. Use your phone if you can.", `not_sent` `offline`. No try after that. |
| GH16 | `409 no_caretaker` (walker envelope) | "No caretaker's phone is linked to this walker, so nothing was sent.", `not_sent` `no_caretaker`; no retry. |
| GH17 | Any other 4xx (400, 403, 429) | "Something went wrong, so nothing was sent. Use your phone if you can.", `not_sent` `failed`; no retry. A 401 says that and then the pair-again line (the walker needs pairing). |
| GH18 | An older server (`404` on `/help`) | The ask gets `not_sent` `failed`. `GET /devices/{id}/help` isn't asked again for 60 s (*placeholder*) while heartbeats go on; then the poll after a heartbeat asks again. Turns carry no `can_ask_for_help`. |
| GH19 | `not_sent` | Stays on screen 10 s (*placeholder*, as `closed`), then the screen goes back. |
| GH20 | The server took it (201, or 200 for one already open) | "Sent to Maya's phone." (one phone) / "Sent to Maya and Sam's phones." (more); the screen `help` `open` with `sent_to`, `shown_to`, `coming` as names, `confirm_okay: false`. While open it asks `GET /devices/{id}/help` every 2 s (HELP_POLL_MS) and after each heartbeat. |
| GH21 | A poll while sending finds the request open (the POST's answer was lost) | Taken as the answer: the sent line, `open`; no more tries. |
| GH22 | `shown_to` grows in the polls | Each new phone once, one line each: "It's showing on Maya's phone."; the same phones again say nothing. Phones are told apart by `member_id` (two "Sam"s are two phones). |
| GH23 | `coming` grows in the polls | `[Maya]`: "Maya is on the way." once; again: nothing. Then `[Maya, Sam]`: "Sam is on the way." only. Two new in one poll: "Maya and Sam are on the way." |
| GH24 | A lone Confirm twice while open | The first (250 ms after its press): "Press Confirm again to tell Maya you're okay.", `confirm_okay: true`, no request. The second within 30 s (HELP_OKAY_ARMED_TTL_MS): one `POST /help/{help_id}/okay`, then "Okay. Maya will see that you're okay." (names: `sent_to`), `closed` `okay` for 10 s, then back. A press while that is answered sends nothing more. |
| GH25 | Armed, and no second press for 30 s | `confirm_okay` goes back to false; the next lone Confirm arms again (the line again, no request). |
| GH26 | `/okay` answered `409 help_closed` | With `closed.how` `okay` (a retry whose first try got through): success, as GH24. With `with_her`: "Maya says they're with you.", `closed` `with_her`. |
| GH27 | `/okay` doesn't get through (network down) | Disarmed; "I couldn't reach the internet. Press Confirm twice to try again."; still open. |
| GH28 | Closed, seen in a poll, for a `help_id` seen open in this run | `with_her` by Maya: "Maya says they're with you."; `expired`: "Your request for help has ended."; `okay` from her phone: "Okay. Maya will see that you're okay." Each said once, shown 10 s; later polls with the same closed request say and show nothing. |
| GH29 | A request made on her phone | The poll after a heartbeat finds it open: the screen `open`, "Sent to Maya's phone." A closed request this walker never saw open in this run (after a restart) is neither said nor shown. |
| GH30 | A request open, then gone from the server (`help: null`) | The screen goes back, nothing said, polling every 2 s stops. |
| GH31 | Help open, and an obstacle | The obstacle takes the screen; help comes back after the obstacle's tail. |
| GH32 | Help open, and a Talk turn | Listening, One moment, the answer, then `help` `open` again; the turn is sent as usual. |
| GH33 | Logs and the walker page | On the Pi, help lines (kind `help`: they hold names) are logged by length, never in full; none becomes a heartbeat event (the owner's page doesn't see help); no log line holds a name. |
| GH34 | Unpaired, a 401, or paired to another walker while help is open | Help leaves the screen, its polling stops, and Confirm is no longer help's. |
| GH35 | A caretaker's message arrives during the hold, the countdown or sending | Not read until that is over; read then. |
| GH36 | The chord while help is sending | The hold shows, and at 2 s nothing new is sent (the one in flight carries on). |

### The motion coordinator while help owns Confirm (`src/motion/coordinator.ts`)

| Id | Situation | Expected |
| --- | --- | --- |
| GM1 | `helpActive(true)` with a pending target | It is withdrawn (`target-ended withdrawn`), except a pending "Let go?" (`gripper.release`), which stays pending (the arm keeps holding). |
| GM2 | A new target while help is active | Refused `confirm_busy`, like a walker proposal owning Confirm. |
| GM3 | A Confirm press while help is active and "Let go?" is pending | Not answered: the coordinator doesn't claim it (help gets it). |
| GM4 | A Confirm press with a target pending, help not active | Taken by the coordinator at once (the service gets nothing), answered 250 ms later with the evidence from the press itself; a Talk press within those 250 ms withdraws the target (as any Talk press does) and the Confirm answers nothing. Stopping a motion never waits. |

### The screen (help states in `pickScreen`)

| Id | Situation | Expected |
| --- | --- | --- |
| GS1 | Priority | Highest first: obstacle; a running motion or a fault; her Talk (listening, thinking, answering); help (`help_hold`, `help_countdown`, `help`); the pending motion Confirm target; Sophi's offer; Done; the motion's own ending; a caretaker's message; offline or not set up; the clock. |
| GS2 | `help_hold` or `help_countdown` starts while an answer is on screen | The answer (and any Done or message) is dropped, so the countdown shows from its first second. A `help` `open` arriving from a poll doesn't drop an answer: it shows once the answer ends. |
| GS3 | The countdown ticks | One new state a second (8 to 1); the walker-screen view keeps one scene key for the whole countdown (no cross-fade every second). |

### The walker screen's help views (`packages/walker-screen`, `test/view.test.ts` and the screenshot check)

| Id | Situation | Expected |
| --- | --- | --- |
| GV1 | Every help state at every text size (fixtures: hold, countdown 8 and 1, sending and retrying, the three `not_sent`, open sent / shown / coming with one name and with the longest seven, armed, the three `closed`, dark, simulator and bench strips) | Valid `ScreenState`s; the coverage test passes (every state in the contract has a fixture). |
| GV2 | The words | `help_hold`: "Keep holding" / "to ask for help.". `help_countdown`: the seconds left large, "Asking for help in 8 seconds." and "Press any button to stop."; "Stop" over both handles. `sending`: "Asking for help" (and "No internet yet. I'll keep trying." while retrying). `not_sent`: "Not sent" and the reason, word for word as spoken. `open`: the newest news without its full stop ("Sent to Maya's phone", "It's showing on Maya's phone", "Maya is on the way"), "Press Confirm twice to say you're okay.", "Confirm" named over the left handle; armed: "Press Confirm again" / "to tell Maya you're okay.". `closed`: "Okay" / "Maya will see that you're okay." (the spoken line, word for word, from `closed`'s `sent_to` names, added to the contract after this row was first written), "Maya says they're with you", "Your request for help has ended". No touch button on any help screen. |
| GV3 | Calm words | No help screen says emergency, fall, danger, alarm, warning, clear or safe (the existing test). |
| GV4 | Headless Chromium at 800x480 | Every help fixture: no overflow, no main line over two lines, no word broken, text at least 40 px, contrast at least 7:1. Names are never cut. |

### Real-time runs (the bundled CLI, `node dist/walker.mjs simulate --screen --script …`)

| Id | Script | Expected |
| --- | --- | --- |
| GW1 | `test/sim/help-voice.walk`: the demo beat. The fake cloud's next turn answers as a voice help request; Talk; the reply; the countdown to zero; "Asking for help."; "Sent to Maya's phone."; the fake caretaker's app shows it ("It's showing on Maya's phone."); she taps "I'm on my way" ("Maya is on the way."); Confirm twice; "Okay. Maya will see that you're okay."; back to the clock | Passes 3 of 3 in a row in real time. |
| GW2 | `test/sim/help-chord.walk`: a chord let go at 1.9 s (nothing sent), a chord held 2.5 s, sent, the fake caretaker says "I'm with Rose", closed, back; a voice countdown stopped by Confirm | Passes 3 of 3 in a row in real time. |

## Serial (shared fixtures in `packages/contracts/test/fixtures/`)

| Id | Input | Expected |
| --- | --- | --- |
| S1 | Every line of `serial-v1.valid.jsonl`, fed through the line reader | Each parses to its message. |
| S2 | Every line of `serial-v1.invalid.json`, each followed by a valid heartbeat | The reader reports exactly the listed problem code, then the heartbeat still parses. |
| S3 | A valid line split at every byte boundary, including inside a multi-byte UTF-8 character | Parses the same as unsplit. |
| S4 | 2,000 bytes with no newline, then a newline, then a valid line | One `oversize` report, the long line is dropped up to the newline, the valid line parses. The buffer never holds more than 1,024 bytes. |
| S5 | A line ending `\r\n`, an empty line, invalid UTF-8 | Parses; ignored; `malformed`. |
| S6 | hello, then heartbeats | The module is registered with its type, capabilities and firmware, health `ok`. |
| S7 | No heartbeat for 3 s (*placeholder*) | Health `unavailable`, its zones count as unknown, and "Your obstacle sensor stopped responding." is spoken once. A new hello brings it back to `ok` without another notice. |
| S8 | The port closes (unplug) | `unavailable` at once, same notice. |
| S9 | Heartbeat, zones or hand input before any hello | Ignored and counted. |
| S10 | Pi sends `haptic.play` | The line passes `SerialHapticPlaySchema`, fits in 1,024 bytes, and the Pi's `seq` counts up per port. |
| S12 | Serial writes *(review)* | At most one write in flight per port; a cue while one is pending is dropped, not queued. `stty` also sets `clocal`, so opening a port never waits for a carrier signal. |
| S13 | The Pi opens a port *(hello.request, PR #28)* | It sends `{"v":1,"type":"hello.request","module_id":"any","seq":0}` (checked against `SerialHelloRequestSchema`). A module that was already running when the Pi service started (its boot hello went unheard) answers with a hello and is registered, and its buttons work. |
| S14 | Lines keep arriving on a port with no known module *(hello.request)* | The Pi asks again with `hello.request` addressed to `any` (never to an id it guessed), at most once every 2 s (*placeholder*), never per line. |
| S15 | A module went `unavailable` (no heartbeat for 3 s) and its heartbeats resume *(hello.request)* | The Pi sends a `hello.request` addressed to that module's own id, so its capabilities are fresh; it comes back `ok` with no second "stopped responding" line. If the port was busy and the request couldn't be written, it is tried again on the module's next line until it goes out or a hello arrives. |
| S16 | A re-hello from a module the Pi already knows *(hello.request)* | Accepted. If its `seq` kept running (an answer to a request), it is not a reboot: a recording started from that hand carries on. If its `seq` went back (a reboot), it is a reboot: a recording started from that hand is discarded (B19). |
| S17 | A known module's `seq` goes back on a line that isn't a hello (it rebooted and its hello was lost, or another line came first) *(hello.request review)* | Treated as a reboot all the same: a recording that hand started is discarded, and the Pi asks for a hello. |
| S18 | Two boards with the same id on two ports *(hello.request review)* | Whichever said hello last holds the id. The Pi never asks the other one for a hello while the holder is available, so the two never trade the id back and forth through the Pi's requests; the duplicate is logged once per port. |
| S19 | The manifest's coordinator *(parts)* | The walker reports itself as `base.walker`, instance `pi-coordinator` (`sim-coordinator` under `walker simulate`), `health: "ok"` while the service runs, `firmware_version` = the service version, `protocol_version: null`, `simulated` true only under `walker simulate`. The page then shows the walker frame as healthy, not "unavailable". |
| S20 | The Pi's own GPIO buttons *(parts, revised after review)* | The Pi can't sense whether a button is wired, so it watches and reports them only when the installer declares them wired (`WALKER_GPIO_BUTTONS=wired`, after the `gpiomon` check in setup step 3). Then they are `controls.hand`, instance `pi-gpio-buttons`, `simulated: false`, alongside any ESP32 hand board. `ok` only once `gpiomon` has stayed up for 1 s (*placeholder*), so one that exits at once (a wrong chip) never reads ok. Before that, `unavailable` with fault `gpiomon_starting`; after it stops, fault `gpiomon_stopped`. The moment they count as watched, the Pi sends a heartbeat, so the page's boot-time "unavailable" lasts about a second, not a whole heartbeat. Not declared: no `gpiomon`, no GPIO part. Any value other than `wired` (or unset) is refused at startup, never silently treated as "not wired". |
| S21 | Every part, once *(parts)* | `base.walker` once; `voice` once (the USB mic and speaker; simulated when either is); each ESP32 module once by its id (a ToF only from an ESP32 sensor board); the GPIO buttons once, only when declared wired; no GPIO part in the simulator (its keyboard isn't a part). Nothing is reported that the walker doesn't have. Past 32 parts, ESP32 modules are cut first, never the coordinator, the GPIO buttons or voice, and available modules are kept before unavailable ones. |
| S11 | Manifest | One entry per ESP32 module: catalog id (`hand` → `controls.hand`, `perception` → `perception.tof`), `instance_id`, firmware, protocol 1, health, faults, `observed_at`, `simulated`. The Pi's own parts (S19–S21) have protocol `null`. |

## Local cue policy

Near is entered under 500 mm and left over 650 mm (*placeholder*, hysteresis). A zone is fresh for 500 ms after the Pi receives it (*placeholder*), by the Pi's monotonic clock. While a zone stays near, the cue repeats at most every 3 s (*placeholder*); a new entry cues at most once a second across all zones (*placeholder*). Haptic cues are `near_obstacle` for 400 ms (*placeholder*).

| Id | Situation | Expected |
| --- | --- | --- |
| C1 | `cues: ["vibration"]`, fresh near zone, healthy haptic hand | One `haptic.play` `near_obstacle` 400 ms to each healthy hand that declared `haptic`. No sound. |
| C2 | `cues: ["sound"]` | The obstacle sound. No haptic. |
| C3 | Both | Both. |
| C4 | Stale: the snapshot read 500 ms after the reading | The zone is left out of the snapshot (unknown), never reported clear. |
| C5 | `quality: "invalid"` | Unknown: no cue, and the zone's state is not "clear". |
| C6 | Near every 100 ms for 10 s | Cues at 0, 3, 6 and 9 s: four. |
| C7 | 490, 510, 490, 510 mm | One cue (hysteresis keeps it near). Clear at 700 mm, near again 1.2 s after the first cue: a new cue. Near again 0.5 s after a cue: none. |
| C8 | No configuration fetched yet | Both vibration and sound (nothing is silently dropped). |
| C9 | `cues: ["vibration"]` but no healthy haptic hand | Falls back to the obstacle sound. *Decision for review.* |
| C10 | Zones from a module that is `unavailable` | Unknown: no cue. |
| C12 | A zone that flickers between near and invalid *(review)* | Coming back from unknown within 3 s of its last cue counts as staying near: cues at most every 3 s, not every second. Only if it was near before it went unknown: near, clear, invalid, near is a new entry and cues after the 1 s gap *(review 2)*. |
| C13 | Vibration chosen, but no haptic actually went out (every hand's port busy) *(review 2)* | The obstacle sound plays instead, so the cue is never silently lost. |
| C14 | A hand board that can't buzz *(haptic faults, from the firmware's codes)* | A buzz goes only to a hand whose health is `ok`, that declared `haptic`, and whose faults include neither `haptic_missing` nor `haptic_error`. Any other hand is skipped; when none can buzz, the obstacle sound plays instead (C9, C13). The offline line follows the same rule, so it never says "Your vibration alerts still work" when they don't. |
| C11 | Anything from the cloud | Never causes a cue. Only the confirmed configuration's `cues` list chooses the kind. |

## Offline and online

| Id | Situation | Expected |
| --- | --- | --- |
| O1 | Two heartbeats fail in a row | Link `offline`; spoken once: "I'm offline right now. Your vibration alerts still work." (built from configuration and health). |
| O2 | One failure, then success | Stays online. No notice. |
| O3 | A turn gets no answer for 10 s | Aborted at 10 s, link `offline`, the offline line is spoken. |
| O4 | Offline, Talk pressed | The offline line at once. No recording, no turn, never the model. A heartbeat probe goes out right away. |
| O5 | The offline line | `sound` in cues, sensor healthy: "Your short-sound alerts still work." Sensor `unavailable`: "The obstacle sensor isn't responding, so obstacle alerts are off." Simulated sensor: adds "The obstacle sensor is simulated." |
| O6 | Offline, then a heartbeat succeeds | "I'm back online." Talk works again. |
| O7 | Offline | Local obstacle cues keep working. |
| O8 | Status events while offline | Queued (at most 50, oldest dropped), sent with the next good heartbeat, then removed. Each carries `ago_ms` from the monotonic clock, so the page's time equals when it was said; a line older than 24 h is dropped *(contract)*. Only notices and local replies are events: replies and Confirm results are on the page already. Voice clips are never queued. |
| O9 | Retry timing after failures | 5, 10, 15, 15 s (*placeholder*). |
| O11 | The same local line twice in a row within 30 s (*placeholder*), such as the offline notice and then a Talk press's offline reply *(rehearsal)* | Spoken both times, but sent to the page once. Only a true repeat: a recording started, a reply or a Confirm result in between makes the next line new again, so a second "Cancelled." or "Nothing to confirm." after something else happened still reaches the page. |
| O12 | The simulator's network keys `o` (down) and `g` (hangs) *(rehearsal)* | Act on the simulator's own requests to any server, the fake cloud or a real one: down fails them at once as unreachable, hangs leaves them unanswered until their deadline. So beat 6 (offline) can be shown on the Mac against the real server. |
| O10 | Going offline, then Confirm pressed | The open proposal is forgotten (the server expires it too). Confirm speaks "I'm offline right now, so I can't change settings." and sends nothing. |

## Re-pair (401)

| Id | Situation | Expected |
| --- | --- | --- |
| A1 | Heartbeat answered 401 | Link `unauthorized`; "I need to be paired again. Open the walker page to get a new pairing code." spoken once, not every heartbeat. |
| A2 | Talk pressed while `unauthorized` | The same line, no recording. |
| A3 | A turn answered 401 | The same. |
| A4 | A new credential written by `walker pair` | Picked up on the next tick; back to online. |

## Audio

| Id | Situation | Expected |
| --- | --- | --- |
| W1 | Building a WAV | 44-byte RIFF header, PCM, 16,000 Hz, 1 channel, 16 bits; sizes match. |
| W2 | The `--mic-file` source | Accepts a 16 kHz mono 16-bit WAV and caps it at 15 s; refuses anything else with a message naming the `ffmpeg` command. |
| W3 | Cue sounds | listening, done, error, nothing_to_confirm and obstacle are short generated WAVs (under 0.5 s). |
| W5 | Synthesized speech files on the Pi *(review)* | Only in the service's runtime folder in memory (systemd `RuntimeDirectory`, `/run/steady-walker`, removed when the service stops) *(review 2)*, emptied again at startup; never on the SD card. A speech command that ignores SIGTERM is killed 2 s later. |
| W7 | A player that never finishes *(review 2)* | A spoken line is stopped after 90 s (*placeholder*; the server's longest reply is about a minute) and the queue moves on; a cue player is killed after 2 s. |
| W6 | `walker simulate --server <real cloud>` *(review)* | Replies are logged by length only, and the auto-created audio folder is deleted at exit. |
| W8 | `--mic-file` in the simulator *(rehearsal)* | Takes one WAV, a comma-separated list, or a folder (its `.wav` files in natural name order, so `2-` before `10-`, skipping hidden files such as macOS `._` files). Each turn actually sent uses the next clip, starting again after the last (a press too short to send doesn't use one up), and the file is read again at that press, so a whole beat sequence runs from one command and an edited clip is picked up. A clip that isn't a 16 kHz mono 16-bit WAV (or isn't a WAV at all) is refused at start, naming the file, with the `ffmpeg` command to fix it. |
| W4 | A turn's answer carries `speech` (the server's voice) *(contract)* | The WAV is played and the walker's own voice stays silent. If the WAV can't be read, or playing it fails, the walker speaks `turn.reply` itself. |

## Simulator end to end (run 3 times in a row, logs kept)

`walker simulate --script test/sim/demo-path.walk` against the fake cloud over local HTTP, with a generated clip as the mic. Every step must pass in order, three runs out of three:

1. "Sophi is on." is spoken; the link goes online.
2. Talk, Talk: a turn is sent and the fake cloud's reply is spoken (it says it is the fake cloud).
3. ToF near: a `haptic.play` reaches the simulated hand (configuration 1 is vibration).
4. Talk, Talk: the fake cloud proposes short sounds. Confirm: configuration 2 is applied and "Done." is spoken.
5. ToF near: the obstacle sound plays, no haptic.
6. Network down: offline within 2 heartbeats; the offline notice is spoken; a Talk press gets the local line.
7. Network up: "I'm back online."; a Talk turn works.
8. The fake cloud forgets the walker: the next heartbeat gets 401 and "pair me again" is spoken.

## Wi-Fi from the SD card (`scripts/walker-wifi-import.sh`, added 2026-10-23)

Run with bash on a temporary `wifi.txt`, with a fake `nmcli` first on `PATH` that only records its arguments, so no test touches the Mac's or a Pi's networks. What real NetworkManager does with the result was checked once on the Pi (devices/pi/README.md, "Wi-Fi on any network"), not here.

| Id | Situation | Expected |
| --- | --- | --- |
| W1 | A `name:` / `password:` block | One `nmcli connection add` named `walker: <name>` for that SSID, with WPA-PSK and the password, `connection.autoconnect yes`, `ipv4.may-fail yes`, `ipv6.method auto`, `ipv6.may-fail yes`. Any older connection of the same name is deleted first. The password line becomes `password: (saved)`. |
| W2 | A name with spaces, a straight apostrophe or a typographic one ("M’s Phone"), or spaces around the values | The SSID is passed exactly, trimmed, as one argument. |
| W3 | `password:` left empty | An open network: the same add without any `wifi-sec` setting. The line still becomes `password: (saved)`. |
| W4 | A block already `password: (saved)` | Skipped: no `nmcli` call for it. |
| W5 | Comment lines (including the example's `# name:` and `# password:`), blank lines and other text; a file saved with Windows line endings | Comments and other lines stay byte for byte and are never read as a network. A `password:` line with no `name:` line since the last block (for example under a commented-out name) adds nothing and is left as it is. A block with Windows line endings parses the same (the carriage return is not part of the name or password). |
| W6 | A second run over the rewritten file | No `nmcli` call and the file is unchanged. A missing `wifi.txt` exits 0 with no call. |

## Bring-up check (`walker check`, added 2026-10-23)

Each check is a small function run against an injected command runner and file reader, so these rows run on a Mac with fake command output (`test/check.test.ts`) and with simulated serial modules on a fake clock (`test/check-modules.test.ts`). The tests never saw what real `ip`, `nmcli`, `arecord`, `piper`, `/sys/class/drm` and ESP32 boards print on the Pi; the parsers follow those tools' documented formats. Thresholds marked *placeholder* are not measured.

| Id | Situation | Expected |
| --- | --- | --- |
| K1 | Any run | One plain line per item: `PASS`, `WARN`, `FAIL` or `SKIP`, the group, the item and its evidence (names, numbers). Then a summary with the counts and the failed items. Exit 1 if any line is `FAIL`, else 0. `WARN` and `SKIP` never fail the run. No colour or symbols, so a screen reader and a log read it the same. |
| K2 | Read-only | Nothing in the check moves, changes a setting or writes outside a private temp folder it deletes. No haptic unless `--buzz`; no sound unless `--sound`. |
| K3 | The credential | Never printed, in any line, even when the server refuses it. |
| K4 | A check that hangs | Each command has a time limit, and each check as a whole too: past it, the line is `FAIL` "no answer within N s" and the run carries on. |
| K5 | Not on Linux (a Mac) | System, route, Wi-Fi, audio, voice, screen and GPIO lines are `SKIP` "not a Pi". DNS, health and pairing still run when a server and state folder are known. |
| K6 | System | OS line from `/etc/os-release` and the architecture: trixie on arm64 passes, anything else warns. Clock: `timedatectl` NTPSynchronized `yes` passes, `no` fails (HTTPS needs the date). `vcgencmd get_throttled`: `0x0` passes; a current under-voltage, cap or throttle (bits 0 to 3) fails; only past ones (bits 16 to 19) warn; each set bit is named. Memory available under 200 MB fails, under 500 MB warns; free disk on `/` under 500 MB fails, under 2 GB warns (*placeholders*). |
| K7 | The walker service | `systemctl is-active` and `is-enabled` for `steady-walker`: active and enabled passes; inactive warns (it may be stopped on purpose for this check); failed, not enabled, or not installed fails. |
| K8 | Default route | From `ip route show default`, the lowest metric wins. On `eth*`/`en*` it passes; on `wlan*` it warns (the venue plan is Ethernet); none fails. |
| K9 | Wi-Fi autoconnect | From `nmcli -t` connections: any Wi-Fi connection with autoconnect on warns, naming each (unplugging Ethernet would fail over to it, which defeats the offline beat), with the command to turn it off; the check doesn't run it. None passes. `nmcli` missing skips. A name containing `:` (escaped `\:` by nmcli) is read whole. |
| K10 | DNS and health | The server is `--server`, else the credential's. Its host resolves (addresses shown) or fails. `GET /api/v1/health` passes on `{"status":"ok"}` with the time it took; `walker_store: "off"`, any other answer, a refused connection or no answer within 20 s (*placeholder*) fails. With no server known, both skip. |
| K11 | Pairing | `credential.json` in the state folder: missing fails ("not paired"); unreadable fails (run with sudo); malformed fails; a file readable by others warns. A valid one shows the device id and server, then `GET /api/v1/devices/{id}/configuration` (read-only on the server): 200 passes with the configuration version and cues; 401 fails ("pair again"); unreachable fails. |
| K12 | Microphone | `arecord` on `WALKER_ALSA_CAPTURE` in the service's own format for 1 s, kept in memory, then zeroed: some nonzero sample passes with the peak and RMS; all zero fails; an error (device busy, no such card) fails with its message; no setting fails. |
| K13 | Speaker | `aplay -L` lists `WALKER_ALSA_PLAYBACK` exactly: pass; else fail, naming the cards it does list. `--sound` plays one short generated tone there (piped in, no file); without it, a `SKIP` line says how. |
| K14 | Voice | With `WALKER_PIPER_MODEL`: the `.onnx` and `.onnx.json` are present and Piper turns a short line into a WAV within 15 s (*placeholder*; 3.3 to 3.8 s measured per line on the Pi 5): pass with the time. Piper failing or slow, with espeak-ng present, warns (the walker falls back to it); with neither, fails. Without a model: espeak-ng's version passes. The WAV goes to a private temp folder that is deleted. |
| K15 | Serial, service running | The service holds the ports, so the live module check skips, saying how to stop the service, and lists the modules the service's log says hello from since boot. |
| K16 | Serial, live | Every port under `WALKER_SERIAL_DIR` (or `--port`) is opened with the service's own code (`openSerialPort`, `ModuleManager`, so the same `hello.request`). Per module: id, type, firmware, protocol, capabilities, health and faults. `ok` passes, `degraded` warns, `fault` fails. A port with no hello within 3 s (*placeholder*) fails. Two ports saying the same id fail, naming both ports. Each expected id (`hand-left-01`, `hand-right-01`, `tof-front-01`, or `--expect`) not seen fails. No ports at all fails on Linux. |
| K17 | ToF zones | For each perception module, about 1 s of `perception.zones` reports: each zone's mm and quality, and how many reports came. Some valid zone passes; every zone invalid warns (nothing in range, or sensors missing); no report fails. |
| K18 | Hand buttons (`--press`) | For each hand, "Press a button on the <side> hand (<id>) now", then the first pressed edge within 10 s (*placeholder*) passes with the time and the button as the Pi maps it (GPIO32 on `hand-left-*` is Confirm). None fails. Without `--press`, a `SKIP` line says how. |
| K19 | Haptic (`--buzz`) | One `haptic.play` `recording` 300 ms (the Talk-press buzz) to each hand that can buzz: an accepted `ack` within 1 s passes ("feel for it"); rejected or no ack fails; a hand that can't buzz (no `haptic`, a haptic fault, not ok) fails without sending. Without `--buzz`: no haptic at all. |
| K20 | Screen | `/sys/class/drm/*-HDMI-*/status`: a connected HDMI connector with `800x480` in its `modes` passes; connected without it warns, listing the modes; none connected fails. Touch: an input device in `/proc/bus/input/devices` reporting an absolute X and Y (`ABS_X`/`ABS_Y`, or the multitouch pair) passes, by name; none fails (a volume knob's absolute axis doesn't count). |
| K21 | GPIO buttons | Only with `WALKER_GPIO_BUTTONS=wired`: `gpioinfo` on the chip lists both lines (with their names and consumer): pass; a missing chip or line fails. Not declared: skip. |
| K22 | `walker check --sim` | Simulated hand and ToF modules go through the same serial check, and every such line says `simulated`. |

## Bring-up check: arms, lift, stop and cameras (added 2026-10-24)

`test/check-motion.test.ts`. The arms run the real Feetech driver (`FeetechBus`, `detectEcho`) against simulated STS3215s (`FakeStsBus`); the lift rows feed a simulated board the contract's own fixture lines (`packages/contracts/test/fixtures/lift-serial-v1.valid.jsonl`); `v4l2-ctl` and `gpioget` output is written from the tools' documented formats. No real servo, adapter, lift board, stop switch or camera was used. The read-only rows were mutation-checked: a torque write, a goal write, a guard that lets everything through, a tap that lets every line through, a heartbeat to the lift, opening the arms with the service running, and the serial check opening servo ports each make a test fail.

| Id | Situation | Expected |
| --- | --- | --- |
| H1 | Read-only | On a servo bus only PING and READ packets to one servo go out (never broadcast, WRITE, REG_WRITE, ACTION, SYNC READ or SYNC WRITE); afterwards every servo's EEPROM, torque enable, acceleration, goal, goal time, goal speed, torque limit and Lock are as before. A guard on the port refuses any other packet (and one with a bad checksum) before it reaches the adapter. On a lift port only `hello.request` goes out, even with `--buzz`; the serial tap refuses `lift.heartbeat`, `lift.home`, `lift.move`, `lift.enable`, `lift.stop`, `lift.clear` and a haptic to a lift. A refused line is reported as a `FAIL` (a bug in the check). |
| H2 | A healthy arm | One line for the arm (servos answering, port and setting name, role, 1,000,000 baud, echo or not, the voltage range, retries) and one per joint (SO-101 ids 1 to 6 by joint name: id, model, firmware, position, voltage, temperature, torque on/off). All pass. The arm's port is recorded as a servo bus (by its tty) and the serial check leaves it out, even when named with `--port`. |
| H3 | A sick arm | Each warns on its joint and is listed on the arm's line: an id that doesn't answer a PING; torque already on (the check never turns it on); a follower under `ARM_UNDERVOLTAGE_V` (10.5 V); any servo above its own EEPROM voltage limit; over `ARM_TEMPERATURE_LIMIT_C` (60 °C); a model other than 777; a fault bit in a reply or the status register. Leaders aren't judged against the follower undervoltage. A servo whose PING reply carries only the voltage bit (byte-identical to the PING) is found by a READ and warns. |
| H4 | An echoing adapter | Warns that the coordinator must build this bus with `echo: true`; the readings still come through (the check rebuilds its bus with the echo it detected). |
| H5 | Nothing answers | No servo on ids 1 to 6 fails ("is the arm's 12 V supply on and its servo cable seated?"); a port that can't be opened fails with the error ("run with sudo?"). A configured port still counts as a servo bus. |
| H6 | Which adapters | The coordinator's setting names (`WALKER_ARM_LEFT_PORT`, `WALKER_ARM_RIGHT_PORT`, `WALKER_LEADER_LEFT_PORT`, `WALKER_LEADER_RIGHT_PORT`): a value outside `/dev/serial/by-id` and `by-path` fails, a link that isn't there fails, and a `usb-1a86_USB_Single_Serial_*` link no setting names skips ("not opened"). With none set, those links are found by name and checked, with one warning to configure them; none found skips. A link found by name counts as a servo bus only once a servo answers on it. With the service running, or on a Mac without `--sim`, no adapter is opened (skip). |
| H7 | The lift board | Its `lift.hello` (firmware, protocol, port, built-in soft range, speed and acceleration limits, microsteps and steps/mm, top switch, stop-sense input) passes; built without stop sense warns ("bench only"). Its latest `lift.status` (state, height, both switches, stop, driver, faults, heartbeat age, report count): homed with the stop released, no faults and the driver on passes; not homed, the stop pressed or not wired, a latched fault, or the driver disabled each warn, by name. A hello and no status fails. |
| H8 | No lift board | No board answers `lift.hello` on any port: one `SKIP` ("not fitted yet?"); `--expect lift-01` makes it a failure like any other expected id. |
| H9 | Cameras | From `v4l2-ctl --list-devices`, only `usb-` devices count (not the Pi's own video blocks). For each, the first `/dev/video` node with Video Capture formats (a metadata node has none): each format with its sizes and the top frame rate of each. Exactly three pass; any other number warns ("expected 3"); a camera with neither MJPG nor YUYV warns; no device at all warns; `v4l2-ctl` missing skips with `sudo apt install v4l-utils`; a Mac skips. |
| H10 | Stop switch | `WALKER_STOP_SENSE=gpio:<line>`: one `gpioget` with the pull-up on `WALKER_GPIO_CHIP` (v1 or v2 syntax per `WALKER_GPIOMON`): low passes (released), high warns (pressed or a cut wire), an error fails (the coordinator counts an unreadable stop as pressed). Unset or `not_wired` warns that motion is refused outside bench mode (and says so when `WALKER_MOTION_BENCH` is on). Any other value fails. A Mac skips; nothing runs. |
| H11 | `--sim` | Two simulated follower arms and a simulated lift board go through the same checks; every such line says `simulated`; the arms pass and stay untouched; the lift warns it isn't homed; nothing fails. |

## Flashing a board from the Pi (`scripts/flash-esp32.sh`, added 2026-10-23)

Run with bash against fake `systemctl`, `fuser` and `esptool` first on `PATH`, so no test touches a board.

| Id | Situation | Expected |
| --- | --- | --- |
| F1 | `steady-walker` is active | Refuses ("stop it first"), exit 1; esptool never runs. |
| F2 | The port is held by another process (`fuser` prints its id) | Refuses, exit 1; esptool never runs. A `fuser` that exits 0 but prints no id (macOS) doesn't count as held. |
| F3 | No image folder for the id, or one of its four files missing | Refuses, naming the missing file. |
| F4 | `firmware.bin` doesn't contain the id it is being flashed as | Refuses (a wrong image for this board). |
| F5 | More than one serial port and no `--port` | Refuses, listing the ports. Exactly one: it is used and named. |
| F6 | Everything in place | `esptool version`, then one flash: `--chip esp32 --port <port> --baud 460800 write-flash 0x1000 bootloader.bin 0x8000 partitions.bin 0xe000 boot_app0.bin 0x10000 firmware.bin` (in the image folder), and exit 0. esptool 4 (which knows only `write_flash`) gets that spelling. |
| F7 | A bad id (not lowercase letters, digits and dashes, or `any`) or no id | Usage, exit 2. |

## The screen kiosk (`install-pi.sh --screen`, added 2026-10-23)

Run with bash on a temporary boot folder (copies of Raspberry Pi OS's stock `config.txt` and `cmdline.txt` from pi-gen), on a fake `/sys/class/drm` folder with a fake `curl` first on `PATH`, and (V9) the whole installer with every system command replaced by a fake that only records its arguments, so no test touches a real boot partition, screen, network or system setting. What the Pi, cage and Chromium do with the result is not checked here: none of it has run on the Pi yet (devices/pi/README.md, "The screen"). Rows marked *(review)* were added or changed from the review of the first commit, before their fixes.

| Id | Situation | Expected |
| --- | --- | --- |
| V1 | `screen-display.sh` on the stock files | `cmdline.txt` stays one line, keeps every token in order, and gains `video=HDMI-A-1:800x480M@60 video=HDMI-A-2:800x480M@60 consoleblank=0`. It is first copied byte for byte to `cmdline.txt.sophi-backup-<time>`. The three arguments it added are recorded in `sophi-screen-added.txt` next to it *(review)*. The stock `config.txt` already has `dtoverlay=vc4-kms-v3d` and `disable_fw_kms_setup=1`, so it is left alone and not backed up. |
| V2 | A second run | Both files unchanged byte for byte, no new backup, and it says nothing changed. |
| V3 | `cmdline.txt` already has `video=HDMI-A-1:1024x768@60`, `consoleblank=600` and `video=DSI-1:800x480@60`; `config.txt` lacks `disable_fw_kms_setup=1`, or has it only under a model section such as `[cm4]` *(review)* | The HDMI and `consoleblank` tokens are replaced and the DSI one kept. `config.txt` is backed up, then gains one marked block at its end (`[all]`, `disable_fw_kms_setup=1`); a second run doesn't add another. A line under `[all]`, or before any section, counts as present. |
| V4 | `--force-on` | `video=HDMI-A-1:800x480M@60D` (the output is on even if the panel's hot-plug signal isn't seen). A later run without the flag keeps the `D`. |
| V5 | `--remove` after V3 or V4 | The marked block and the arguments recorded as added are gone, then the record; everything else is as it was; each changed file is backed up first, never over an earlier backup (even one from the same second). A `consoleblank=0` that was there before the first run stays *(review)*. Values it replaced (such as `consoleblank=600`) are only in the backup. |
| V6 | No `config.txt` or no `cmdline.txt`; a `config.txt` without `dtoverlay=vc4-kms-v3d`; a `cmdline.txt` with no `root=` argument or with more than one line *(review)* | Exits non-zero with the reason on its last line, and writes nothing (no backup either). |
| V7 | `sophi-screen-wait.sh <command…>` *(review: it now runs as the unit's main command and starts the kiosk itself)*: a `file://` page that exists and an HDMI connector reading `connected` | Runs the command (exec), without calling `curl`. With no connector reading `connected`, it keeps waiting, saying once that no screen is connected; with a time limit set (tests only) it exits 1 when it runs out, without running the command. An `http://127.0.0.1:<port>/` page: waits while `curl` fails, runs the command once it succeeds. Any other address (for example `https://example.com/`): exits 1 saying it shows only local pages; `curl` and the command are never run. |
| V8 | The unit files and the placeholder page | `steady-walker.service` never names the screen unit, and `sophi-screen.service` has no `Requires=`, `BindsTo=` or `PartOf=` on anything, so neither waits for or stops the other. The wait is the main command (`ExecStart=` starts with the wait script, no `ExecStartPre=`), so boot never waits for a screen *(review)*. The screen unit restarts forever (`Restart=always`, `StartLimitIntervalSec=0`), backing off from 5 s to at most 2 minutes (`RestartSteps=`, `RestartMaxDelaySec=120`) *(review)*, keeps Chromium's profile under `/run`, and is the first the kernel's out-of-memory killer picks (`OOMScoreAdjust=` above 0). The placeholder says "Sophi" and "Screen connected. Waiting for the walker service." *(changed with the walker screen, D15: it now goes to the walker's page at `http://127.0.0.1:8740/` once that answers)* |
| V9 | `install-pi.sh` with fake system commands *(review)* | `--screen` works before or after the bundle path; an unknown option or an extra argument exits 2 before changing anything. With `--screen`, missing `cage` or `chromium` (at the paths the unit runs) exits 1 before changing anything. When the screen step fails after the walker is installed (for example no `cmdline.txt`), the walker's `daemon-reload` and `enable` have already run, it prints "Screen not installed: <reason>", never enables `sophi-screen`, and exits 0. When it succeeds, `sophi-screen` is enabled after the walker's units. Without `--screen` it never touches the boot folder. |

## The walker screen (`src/screen/`, added 2026-10-24)

The walker's own screen states, motion (the arms and the lift) and a caretaker's message as it is read aloud: the circle's other states (suggestions, joins, the "message waiting" notice, My screen) come with the circle feed. Rows D1 to D9 run on a fake clock (`test/screen.test.ts`), D10 to D13 on a real socket on 127.0.0.1 (`test/screen-server.test.ts`); D19 to D23 likewise (`test/screen-motion.test.ts`, `test/screen-server.test.ts`, `test/screen-hold.test.tsx`). D14 and D15 are runs with headless Chromium at 800x480, not in the test suite (the README's "The walker screen's page" says how). Timings marked *placeholder* are in `src/constants.ts`.

| Id | Situation | Expected |
| --- | --- | --- |
| D1 | Any mix of inputs | One state, by priority: obstacle; listening (Talk held); thinking ("One moment": Talk let go, no answer yet) *(added 2026-10-24)*; answering (captions while the reply plays); Sophi's offer (an open proposal); Done or Nothing changed (4 s, *placeholder*, after Confirm settles an offer); offline; not set up (unpaired, or the server no longer knows the walker); otherwise the clock with the alerts in force. |
| D2 | An obstacle or Talk interrupts | When it ends, the screen is whatever is still underneath (the offer, the clock), sent with a new revision. A new Talk press drops the previous answer and any Done. |
| D3 | A reply arrives | Captions pages from `captionPages` at her text size, each shown for its characters at 15 a second, at least 2.5 s (*placeholders*). The answer ends 3 s (*placeholder*) after it has been spoken and every page has had its time; with an offer open, no hold, so Confirm lights as soon as Sophi has asked. The source line says who answered (`model`, `fixed`, or the walker's own offline line). Confirm settling the offer shows Done at once, ahead of captions still up, in the same state change as the offer closing (no clock in between). |
| D4 | ToF zones | Near and clear use the cue policy's thresholds and hysteresis (under 500 mm, over 650 mm). Entering is drawn at once; a moving distance at most every 250 ms (*placeholder*), rounded to 10 mm. "Something close" stays 1 s (*placeholder*) after the last near reading; a near zone whose reading goes invalid or stale (no reading for 500 ms) reads Unknown for that tail. "Simulated" when the sensor module is simulated. |
| D5 | The clock | No time until the clock has synced (on the Pi: systemd-timesyncd's `/run/systemd/timesync/synchronized`; the simulator: always). The time is redrawn on the minute, never on a seconds change. |
| D6 | The demo beats on the whole service (fake cloud, simulated hand and ToF): ask; the alerts offer and Confirm; obstacle; offline, a Talk press there, and back | States in order: ambient, listening, thinking, answering, ambient, listening, thinking, answering, model_offer, done, ambient, obstacle, ambient, offline, answering (the walker's own line, source `walker`), offline, ambient. Confirm on an offer that closed meanwhile: Nothing changed. |
| D7 | Anything in the screen throws (the clock, the state sink, a bus listener) | Logged once per kind, with no state, words or reply; Talk, the turn and Confirm carry on (the reply is spoken, configuration 2 applies). |
| D8 | Every state the walker sends | Passes `ScreenStateSchema`; revisions count up by one; the strip says Simulator under `walker simulate`. |
| D9 | The `offer` bus event | Sent when the open proposal's id changes (opened, closed), not on every heartbeat that repeats it. |
| D10 | The server's page and stream | `GET /` is the page with the per-boot token in a meta tag, no CORS headers, a CSP with `frame-ancestors 'none'`. Only the built files are served (`/screen/assets/<name>`, no paths). The stream starts with the current state. `POST /screen/shown` and `/screen/press` take exactly a `ScreenShown` and a `ScreenPress` (400 otherwise, 413 over 4 KB). Presses are logged and not acted on: no screen shows a button that does nothing, so "My screen" is hidden until the circle piece builds it (walker-screen's view test checks every fixture). |
| D11 | Token, Host, Origin | A missing or wrong token: 403 on the stream (query parameter) and the POSTs (`X-Screen-Token`). A `Host` other than `127.0.0.1:<port>` (including `localhost`): 421 on every route, the page too. An `Origin` other than `http://127.0.0.1:<port>`: 421. |
| D12 | Another address | It listens on 127.0.0.1 only; a request whose socket isn't loopback is refused (403) as a second check. |
| D13 | The port is taken, or the page files are missing | One log line, no server, and the walker runs on. Logs never hold a state body, words, the token or a request URL. |
| D14 | `walker simulate --screen --script test/sim/screen-beats.walk` under headless Chromium at 800x480 | The script passes; every state is drawn and photographed; key to drawn within about 100 ms for listening, answering, Done and the obstacle (the offline beat takes the walker's own two failed heartbeats, about 5 s). |
| D15 | The kiosk's placeholder and a walker service that stops or restarts | The placeholder (`file://`) goes to the walker's page once it answers. The walker's page shows "Waiting for the walker service." 5 s after its stream drops, and reloads itself once a restarted service (a new token) answers. |
| D16 | Confirm on Sophi's offer *(review, 2026-10-24)* | While Confirm is answered and the new configuration fetched, the offer stays on screen. "Done" only once the new configuration is in force, naming its own cues. If the fetch fails ("Confirmed. The change will apply in a moment."), the screen never says Done: the offer closes and the clock shows what is in force now. |
| D17 | A reply queued behind another line *(review)* | Its captions appear when it starts playing, not when it was queued. |
| D18 | A stream refused or stuck *(review)* | `GET /screen/check` says whether the page's token is still good (204) or the service restarted (403); the page reloads only on 403, so a full server (503) never starts a reload loop. A screen that stops reading is dropped once 256 KB waits for it; at most 32 connections. While no time is shown, the clock is looked at again every 30 s (D5). |
| D19 | Motion on the screen: priority *(added 2026-10-24, `test/screen-motion.test.ts`)* | Highest first: obstacle; a running motion or a latched motion fault (with its clearing target if one is pending); listening, thinking, answering; the pending motion Confirm target; Sophi's offer; Done; the motion's own Done, Stopped or Not started; offline or not set up; the clock. A running motion covers her own screens (listening, say), which come back underneath once it has stopped. |
| D20 | The coordinator's `motionState` | A pending target while ready: `motion_confirm` with the target's own title and prompt word for word, and the hold control only for a hold-to-run lift target (`lift.home`: home; `lift.move`: raise or lower from the lift's height, or move when the height is unknown), its way fixed when the target is first seen. Active: `motion_running` with the Pi's words (the skill's title, "Moving the left arm", "Raising the lift"), the lift's phase. Fault mode: `motion_fault` with each code once, oldest first, and the pending target that may clear it. A motion state older than 1 s (*placeholder*) shows nothing about motion, and so no hold control. The strip says bench mode from the coordinator's state; false with no coordinator. While letting go runs with a fault latched (*re-review, 2026-10-24*): `motion_running` "Letting go", not the fault screen; the fault comes back once it ends. |
| D21 | A motion ends, or its press is refused | The running motion gone and the coordinator's last command is that motion's id: Done (completed) or Stopped (stopped) for 4 s (SCREEN_DONE_MS). The pending target gone and the last command a new refusal of that kind: Not started, with the refusal. A fault, an unmatched id or a refused prepare shows none of these. |
| D22 | `POST /screen/hold` | Token, Host and Origin as D11 (403, 421, 421), and nothing reaches the bus. Only a `ScreenHold` (400 otherwise). Each message is stamped with the Pi's monotonic time on receipt; the page's `at` never changes that stamp. "Still held" counts only while a stream is open and the state last sent shows the hold control; otherwise 409 and a release. A "still held" whose `at` is not after the page's last release is dropped (409, nothing sent). A stream closing and the server closing are releases. Every refresh that counts is one `screenHold` event, in order. |
| D23 | The page's hold control (`HoldControl`, fake timers and events) | Pressing does nothing unless the control is shown. Held: "still held" at once, then every 50 ms (a quarter of HOLD_CONTROL_REFRESH_MS). Each of pointerup, pointercancel, touchend, touchcancel, blur (window), visibilitychange (document) and keyup sends exactly one release and stops the refreshes. So do the control leaving the screen and the stream dropping. The confirm screen turning into the running one, with the control still shown, doesn't let go. The page draws no hold control on any screen without a lift target, and draws one on the lift's confirm and running screens. |
| D25 | A caretaker's message read aloud *(added 2026-10-24)* | `message` with its words and "From Maya" from the moment it starts playing until 20 s (*placeholder*) after it has played, then whatever is underneath. Priority: under her own Talk, the answer, a motion target, Sophi's offer and Done; over offline (so a Confirm replay offline shows it) and the clock. A new Talk press drops it. The view names "Confirm" over the left handle and says "Press Confirm to hear it again."; no touch button. |
| D26 | The message heard again on Confirm | The same screen again, its 20 s starting from the end of that reading. |
| D24 | The real page in headless Chromium against the real server *(run, not in the suite)* | Holding the control with the mouse sends a refresh about every 50 ms, each reaching the bus as `screenHold` with the Pi's time; lifting the mouse, blurring the window and the stream dropping each send one release. |

## Show on screen (`show_on_screen`, added 2026-10-24)

The walker's half of the assistant's `show_on_screen` tool (docs/subsystems/show-on-screen.md): the model names a view, the Pi fills the card from its own data and puts it on the screen machine's `showing` layer. Rows SH1 to SH12 run on a fake clock with the fake cloud and fake GPS and weather lookups (`test/show.test.ts`); no test reaches the internet. SH13 is the scripted simulator run. Written before the tests.

| Id | Situation | Expected |
| --- | --- | --- |
| SH1 | A turn request, first step and every continuation | Carries `screen: {views}` only while a screen page's stream is open on the Pi's screen server. Views, in this order: `weather` and `location` when the GPS receiver is connected, `sensors` when the walker has an obstacle-sensor module, `message` when it holds a caretaker message (the one Confirm would read again), `parts` always. No page connected, or no screen at all: no `screen` field. |
| SH2 | `weather` | One GPS fix, then the same weather lookup as `get_weather`. The card: whole degrees Fahrenheit, the conditions ("partly cloudy skies"), whole miles per hour, and `simulated` from the GPS receiver's own flag. The result: "Showing the weather on the screen: " and `get_weather`'s sentence, unchanged. `get_weather` and `get_location` say exactly what they said before. |
| SH3 | `location` | One GPS fix, then the same reverse lookup as `get_location`. The card: the nearest address as `get_location` cleans it (the venue and the area, or the area alone when both don't fit 120 characters), `simulated` from the GPS. The result: "Showing the nearest address on the screen: " and `get_location`'s sentence. No coordinates on the card, in the result or in a log line. |
| SH4 | `sensors` | Every zone the walker has heard of, in the order first heard: measured (rounded to 10 mm) only when the reading is valid and fresh (under ZONE_VALIDITY_MS old, from a module that isn't unavailable), otherwise unknown; never "clear". Each zone's `simulated` comes from the module that reported it. The result lists each zone in centimetres, as the card shows them ("front left 42 centimetres, front right unknown"). |
| SH5 | The sensors card while it is up | Rebuilt from each new reading, at most every SCREEN_ZONES_MIN_MS (250 ms, *placeholder*) like the obstacle screen, so a steady reading sends no new revision. A zone that goes stale with no new reading turns unknown at that moment; a zone a reading leaves out stays on the card as unknown. |
| SH6 | `message` | The newest message the walker holds: the card has its id, the sender's name and its words. The result is "Showing the newest message, from Maya, on the screen." The words never appear in the result, in any turn request or heartbeat, or in a log line. |
| SH7 | `parts` | The capability manifest's parts (the first 16), each with its health and its own `simulated` flag. The result says how many parts, how many aren't ok, and how many are simulated. |
| SH8 | A view that can't be filled: no GPS receiver, no fix, the lookup fails, no reliable address, no zone heard yet, no message held, or the page disconnected meanwhile | Nothing is shown (the screen doesn't change). The result starts "Nothing was shown on the screen." and says why, with `get_weather`'s or `get_location`'s own sentence where one applies. The turn goes on to the model's answer. |
| SH9 | Logs | One line per show: `show_on_screen` with the view, whether it was shown, and how long it took. No card contents, words, address, weather or coordinates. |
| SH10 | Priority | Obstacle; a running motion or a motion fault; listening; **the card**; thinking; answering; then the rest as D19. An obstacle or a running motion covers the card, which comes back underneath while its time lasts. Never over help (merged with the help layer, 2026-10-24): while help shows (her hold, the countdown, a request), help keeps the screen and the card waits under it, coming back while its time lasts. |
| SH11 | The caption under the card | While the turn's answer would be captioned (it is playing, its pages are still having their time, or in its 3 s hold), `caption` is its current page. Under a card the reply is paged by the screen's `showingCaptionPages` (75 characters a page at every text size, so no page is cut), and each page shows for its own characters at the speaking rate, as on the answering screen. Null when captions are off or no answer is up. *(Paging changed 2026-10-24, before its test, when the screen piece set the card's caption line.)* |
| SH12 | When the card goes | A Talk press ends it at once (listening, then whatever is underneath, not the card). A newer card replaces it. Otherwise it goes SCREEN_SHOW_MS (30 s) after the answer finished playing, or after it was drawn when no answer was playing. A later answer never brings back a card that has gone. |
| SH13 | Fake cloud and simulator | A `show-<view>` key (fake cloud only) makes the next walker turn ask for that view, but only if the turn's `screen.views` lists it (otherwise a fake-cloud line saying it can't). Its step line is "Fake cloud: putting that on your screen."; the continuation's reply relays the walker's result word for word ("Fake cloud: Showing the weather on the screen: …"). `walker simulate --screen --gps` has a SIMULATED GPS receiver and SIMULATED weather and address samples that say so (no internet), and never shares the simulated position. `test/sim/show-weather.walk`, with a headless browser on the page: ambient, listening, showing, the reply spoken, no ambient for 25 s, then ambient within 15 s more. Three runs in a row; the same script also runs on a fake clock in the suite. |

## The lift adapter (`src/motion/lift/`, added 2026-10-24)

Written before the tests. **Simulated only:** no lift board has run against this code; the board side is the simulated lift in `src/sim/fakeLift.ts` (a TypeScript port of the lift firmware's rules, labelled SIMULATED). Since 2026-10-24 the motion coordinator drives the client (rows E1 to E14 below); the LW rows now run under it too. Contract constants come from `motion.ts` and `lift-serial.ts` (all placeholders there); the Pi's own lift timings are in `src/constants.ts` (*placeholders*).

### The lift client (L)

| Id | Situation | Expected |
| --- | --- | --- |
| L1 | A port whose first lift line is `lift.hello` | The port becomes a lift port: every later line goes to the lift client through `parseLiftSerialLine`, never into the module list, the manifest or the "serial line refused" log. A port whose first line is `hello` stays a serial port as today. A `lift.status` before any hello on a port is ignored and answered with a `hello.request` (at most every 2 s). With no lift client running, a lift port beside two hands and a ToF board (boot garbage, a status, then its hello and statuses, a hand rebooting partway) leaves all three boards `ok`, the lift out of the module list, one `buttonsLost` for the rebooted hand, only throttled `hello.request`s on the lift port, and no lift line in the log. |
| L2 | `lift.hello` whose `config` differs from the Pi's lift configuration in any field (compared at the firmware's resolution, a thousandth of a millimetre) | `lift_config_mismatch` reported once for that hello; heartbeats go on naming nobody; every lift verdict and `start` refuse (`fault_latched`). A later matching hello lets verdicts pass again (the latched fault is the coordinator's to clear). |
| L3 | `lift.hello` from a lift id other than the configured one (`lift-01`) | Ignored and logged once; that port is never driven. |
| L4 | Heartbeat cadence | Heartbeats are written only from `tick(now)`: one when at least LIFT_HEARTBEAT_INTERVAL_MS (100) has passed since the last one written, never from a timer of its own. Ticks every 20 ms for 1 s write 10 heartbeats; when ticks stop, heartbeats stop. None before a `lift.hello`. |
| L5 | The hold lease | `hold_request_id` names the running request only while the latest hold refresh is at most HOLD_CONTROL_REFRESH_MS (200) old at that tick, and only after the request was started; otherwise null. A refresh stamped later than the tick's time counts as stale. A hold with no request names nobody. |
| L6 | The hold goes stale or is released while request R runs | The very next tick writes a heartbeat naming nobody (without waiting for the cadence); R is `stopping` and is never named again, even if the hold comes back. |
| L7 | `start` of a home or move | Refused unless the start verdict passes (LP4). Otherwise the next tick writes, in one write: `lift.enable` true (only if the last status shows the driver off, and only in the write that carries the command: a tick that refuses it, or a stop before it, never turns the driver on), a heartbeat naming R, then the command. Every command has its own new request id `<prefix>-<n>`, n rising from 1; the prefix is six lowercase letters or digits, new for each client. |
| L8 | Pi seq | Every Pi line on the port, `hello.request` included, carries a seq one above the previous line written there. A write refused because the port is busy uses no seq, and what it held is written on the next tick. |
| L9 | Acks and done | Ack accepted: running. `lift.done` completed for a homing: the Pi counts the lift homed. Done `stopped` or `failed`: the request ends with that outcome (and its fault). A status that doesn't name the request means it ended unseen (`lost`) only after its ack; before the ack the status is just older than the command, so a stop sent right after the command still ends `stopped` (and an unacked request still ends `no_ack`). |
| L10 | Rejections | `stale_seq`: the request ends refused and the Pi sends a `hello.request` (which resets the lift's seq memory). `request_used`: ends refused, and the client takes a new boot prefix so its next id can't have been used. Any other reason: ends refused with that reason. |
| L11 | No ack | No ack within LIFT_ACK_TIMEOUT_MS (500, *placeholder*): a `lift.stop` is sent and the request ends `no_ack`. |
| L12 | `stop()` | Writes `lift.stop` at once in every state (no hello, a config mismatch, a latched fault, status lost, idle). If the port is busy it goes on the next tick. Resent with a new id if no ack comes within LIFT_ACK_TIMEOUT_MS, at most LIFT_STOP_RETRIES (3, *placeholder*) times. A running request is stopping and never named again. |
| L13 | `disable()` | Writes `lift.enable` false only when `liftMayDisable` (drop test passed, a brake, or the last status shows the bottom switch pressed); otherwise refuses `lift_may_drop`. Sent with a fault latched or a config mismatch. Accepted: the Pi's homed goes false. Rejected `disable_unsafe` (rule 6 as amended in the firmware review): reported as refused, the lift stays enabled and homed. Never sent as a stop. |
| L20 | Acked, then a status that no longer names the request, with no `lift.done` seen | `lift.stop`, ended `lost`, the Pi's homed false, `lift_unhomed` reported (it doesn't know how it ended). |
| L21 | `lift.home` written | The Pi counts the lift unhomed from that write until the homing completes; a homing stopped part way leaves it unhomed (no `lift_unhomed` fault for it). |
| L19 | A gap in the lift's seq (the firmware counts dropped TX lines) | Not a loss and not a reboot: only seq going back is a reboot, and only missing status for LIFT_STATUS_STALE_MS is a loss. |
| L14 | Status lost | No `lift.status` for LIFT_STATUS_STALE_MS (300): `lift_module_lost` reported once, a running request ends `lost` after a best-effort `lift.stop`, heartbeats stop, the Pi's homed goes false. The port closing does the same. When statuses return the Pi sends a `hello.request`, and heartbeats resume (naming nobody) only after a fresh `lift.hello`. |
| L15 | Lift faults and stray motion | A fault newly latched in `lift.status` is reported once per latch and the Pi's homed goes false. A status showing the lift moving or homing for a request the Pi isn't running gets a `lift.stop`. |
| L16 | Deadline | A homing past LIFT_HOMING_TIMEOUT_MS, or a move past `motionTimeoutMs(distance / speed)`: `lift.stop`, the request ends `timeout`, `motion_timeout` reported. |
| L17 | The lift's seq goes back without a hello (it rebooted) | The Pi's homed goes false (`lift_unhomed` reported if it was homed) and a `hello.request` is sent. |
| L18 | `state()` | Always passes `LiftStateSchema`: disconnected means unknown switches and no position; a position only while connected and homed in the Pi's view. |

### Preconditions (LP)

| Id | Situation | Expected |
| --- | --- | --- |
| LP1 | Verdict for `lift.home` / `lift.move`, first failing check wins | `stop_pressed` (the Pi's stop or the lift's stop-sense reads pressed), `no_hardware_stop` (the Pi's stop isn't wired, or the lift was built without stop-sense: bench mode or not, since 2026-10-24), `fault_latched` (the coordinator's faults, a fault the lift reports, or a config mismatch), `busy`, `part_missing` (no lift port or hello), `feedback_stale` (status stale), `not_held` (at start only), `lift_guards_missing`, `lift_drop_test_missing` (outside bench mode, from the installation record), `lift_over_limits` (the lift's built-in acceleration above the mode's, or for homing its fixed speeds above the mode's), `arms_not_stowed`; for a move also `lift_not_homed` and `out_of_range` (outside the soft limits). |
| LP2 | Bench mode | Only the installation checks don't apply. `no_hardware_stop`, `stop_pressed` and everything else still do (the lift never moves without the hardware stop), and bench's limits refuse `lift_over_limits`: the firmware's 50 mm/s² is over its 25, and homing's 15 mm/s over its 10, so today the lift can't home in bench mode. Outside bench mode both fit; an acceleration over 50 doesn't. |
| LP3 | Verdict for `lift.disable` | Only `busy`, `part_missing` and `lift_may_drop`; allowed with a fault latched. |
| LP4 | `start` itself | Runs the start verdict again, so a refused action never reaches the lift. |
| LP5 | Move speed | The lower of the configuration's `max_speed_mm_s` and the mode's `MOTION_LIMITS` lift speed (bench's 10 checked on `liftMoveSpeed`, since the lift can't home in bench mode). |

### The simulated lift (LF)

| Id | Situation | Expected |
| --- | --- | --- |
| LF1 | Rules 1 to 10 of `lift-serial.ts` against the simulated lift | Boot: `lift.hello` seq 0, then status `unhomed`, driver enabled. A `hello.request` stops a running move. A stale heartbeat is ignored, a stale command rejected `stale_seq` (stop and disable excepted). Home and move refusals in rule 4's order. A heartbeat naming anything else ramps down to `stopped`; no heartbeat for 300 ms ramps down and latches `watchdog_expired` (driver still enabled). Homing's four phases end homed at 5 mm. A switch pressing while homed latches `limit_hit`, both at once `limit_wiring`, the stop `stop_circuit_opened`; each clears homed. `lift.clear` refuses `cause_present` while the stop is pressed. `lift.enable` false off the bottom switch on a build that isn't disable-safe is rejected `disable_unsafe`, the driver stays enabled and a running move ramps down as for a stop; on the bottom switch (or disable-safe) it frees the motor and unhomes. Homing trips on two pressed samples in a row. After 16 boot prefixes, a new one is refused `request_used`. Status at 20 Hz and on change. Every line it writes passes `parseLiftSerialLine`. |
| LF2 | Injected faults | A stuck bottom switch while homed: `limit_hit`. A cut harness (both switches read pressed): `limit_wiring`. Lost line from the lift: the Pi reports `lift_module_lost`, sends a best-effort `lift.stop` and stops heartbeating, so the lift stops (on that stop; if the line to the lift is lost too, on its own watchdog, latching `watchdog_expired`). Frozen board: no lines in or out, the motor finishes its current move (the pulse hardware runs on), the board restarts after 5 s (*placeholder*: the firmware's task watchdog) unhomed. Stop pressed: steps stop at once, `stop_circuit_opened`, unhomed. |

### Scripted runs (LW)

These first ran from a stand-in loop that played the coordinator; since 2026-10-24 they run under the real coordinator (`test/lift-coordinator.test.ts`, the E rows say where).

| Id | Situation | Expected |
| --- | --- | --- |
| LW1 | Home while the hold is refreshed | Completes at 5 mm; the Pi counts the lift homed. (E1) |
| LW2 | Move to 300 mm while held, released halfway | A heartbeat naming nobody within one tick; the lift ramps down; done `stopped`; still homed, stopped between the two heights; never resumes when held again. (E1) |
| LW3 | The coordinator's ticks stop mid-move | No heartbeats; within 300 ms plus the ramp the lift latches `watchdog_expired` and ends `failed`; the Pi latches `watchdog_expired` (part `lift`) and counts the lift unhomed. (E6) |
| LW4 | The stop switch mid-move | `stop_circuit_opened`, ended `failed`, unhomed. A clear refused `cause_present` while pressed, accepted (by the lift too) after release; a move is then refused `lift_not_homed`. (E5) |
| LW5 | `walker simulate --arms --lift --script test/sim/lift/02-hold-release-stop.walk` | The script passes. (E10) |

Mutation checks (run by hand, results in the PR): naming the request in heartbeats regardless of the hold, and dropping `lift.stop` when the port is busy, must each fail a test.

## Motion: the arms (`src/motion/`, added 2026-10-24; simulated servos only)

Written from the motion contract (`packages/contracts/src/motion.ts`) before the tests. M1 to M10 are the `.walk` scripts in `test/sim/motion/`, run on a fake clock by `test/motion-walk.test.ts` (and by `walker simulate --arms --script`); the rest are in `test/motion.test.ts`. Every published motion state must pass `MotionStateSchema`. The simulated servos take the dangerous side of both unknowns: they drive to whatever goal is in the register when torque comes on, and a goal written with torque off turns torque on (`goalEnablesTorque`). Nothing here is a hardware result.

| Id | Situation | Expected |
| --- | --- | --- |
| M1 | Start-up *(read before act, review 2026-10-24)* | Each arm: echo check, then a ping and model 777 for all six servos, then one read, before any write. The simulated followers read torque off, so no goal is written to them: the goal left 300 steps away stays on both, unused. Mode `ready`. No torque comes on and no goal is written. |
| M2 | The terminal asks for torque on | It becomes the Confirm target, said with the park prompt. Nothing happens without a Confirm press. A press in the first 2 s is ignored, and so is one less than 2 s after that button's last press. Then: every servo's goal equals its present position when torque comes on (limits first, then the goal, each read back). A second press doesn't run it again. |
| M3 | An offer (ids only) for the left arm's `ready` | Worded from the pose's own title. Confirm runs it, prepared by `offer`, and it completes within 3°. A second Confirm starts nothing and writes no goal. |
| M4 | A Talk press during an offered move; a Confirm press during a terminal move | Each stops (`handle_press`) and holds. On the servos: every torqued one's goal within 5° of where it is, and no goal written in the next second. The goals are within 0.5° of where the arm was at the press (the hold read first). The Talk press starts no recording. M5, M6 and M7 check the servos the same way (M6 with the 0.5° check too). |
| M5 | The stop switch, idle and mid-move | Latches `stop_circuit_opened` (mode `fault`, the move `faulted`). Releasing it re-reads torque. Clearing is refused while it is pressed, and allowed (with Confirm) after. |
| M6 | The handle unplugged mid-move; then idle | Mid-move: `hand_controls_lost`, the move `faulted`, clear refused until the handle is back. A pending target is withdrawn when the handle goes. With no handle, a move is refused `no_hand_control` before any Confirm. |
| M7 | A servo stops answering mid-move | `feedback_stale` on that arm, and no goal is written to it afterwards. Once it answers again, the fault clears. |
| M8 | The elbow pushed 25° from its goal while holding | `feedback_divergence` after 300 ms. Every joint's torque limit is 25% (no grasp is active). A pose is then refused `torque_off` until torque is turned on again. |
| M9 | Teleop | Confirm engages it. A slow leader (15°/s) is followed with no fault. A leader at 360°/s for 250 ms latches `teleop_overspeed` (over 2× 90°/s for 200 ms). |
| M10 | A stiff elbow that moves at about 5°/s | Not a stall (it moves faster than 3°/s) and no divergence (the goal waits within 5°). The deadline latches `motion_timeout`. |
| M11 | Settings | Bench mode only for exactly `no-hardware-stop`, and anything else is an error. Ports only under `/dev/serial/by-id` or `by-path`. `WALKER_STOP_SENSE` is `not_wired` or `gpio:<n>`. An arm port is recognised under another link to the same device. |
| M12 | Limits | A goal leads the measured position by at most 5°, and moves at most 2° a step. Teleop is capped at 60°/s while recording. The servo speed is never 0. The centring offset makes the middle read 2048. |
| M13 | The start-up check | An echoing adapter is reopened in echo mode. A missing servo or a wrong model fails the check, with only pings and reads sent. |
| M14 | The terminal channel | Fields claiming an initiator, a preparer, a confirm record or `base_parked` are ignored. The target is `operator_cli`, and no torque comes on. A terminal that disconnects withdraws its target. |
| M15 | The manifest | Never lists `manipulation.arm` while `MANIFEST_MAY_LIST_ARMS` is false. |
| M16 | Real handle presses (ESP32) | Ignored: in the target's first 2 s, within 2 s of that button's release, or a second press edge with no release seen. Accepted 2 s after a seen release. A hand's hello withdraws a pending target. |
| M17 | The walker's own proposal is open | Preparing is refused `confirm_busy`. |
| M18 | Calibration of a follower | Its Confirm turns torque off. The middle offsets make every servo read 2048, then ranges are recorded. It is saved as a valid `ArmCalibrationSchema`, the old file and the arm's old poses set aside. |
| M19 | An offer with words, or an unknown pose | Dropped. |
| M20 | Torque on for both followers | Every leader servo's torque stays 0. |
| M21 | The stop reads pressed right after the torque-on Confirm | Torque on is abandoned, and every servo's torque ends at 0. |
| M22 | A servo stops answering while holding | `feedback_stale` on that arm. |
| M23 | The GPIO stop-sense input | Reads pressed until the first gpioget answer. Released only after 30 ms low; pressed at once on a rising edge; pressed when gpiomon exits. |
| M24 | A stop while a follower's torque is off | No goal is written to it (one would turn its torque on). |
| M25 | A joint blocked mid-move *(stall rule, 2026-10-24)* | Its goal more than 3° ahead while it moves under 3°/s, for 300 ms (*placeholders*), latches `feedback_divergence` for that arm (the contract's fault, `comply`). That is within 300 ms + the lead building (about 67 ms at 45°/s) + 2 ticks of the block, and not before 300 ms. Afterwards the blocked joint's goal is where it is, every joint is at 25% torque, and no further goal is sent. |
| M26 | A load on a holding joint *(load rule)* | 40% against a 60% limit (threshold 80% of it, 48%, *placeholder*): no fault in 1 s. 50% (under the limit, so the 80% overload rule can't see it): `feedback_divergence` and comply within 300 ms + 2 ticks, not before 300 ms. |
| M27 | Torque on, and one servo misses the unacknowledged goal write *(read before act)* | The read-back finds it (`read-back mismatch (goal, speed, acceleration) on servo 4`). Torque on aborts, every servo ends with torque off, and the request is `error`. |
| M28 | A torque limit changes under a torqued arm | `limits-lost`. A pose is then refused `torque_off` until torque is turned on again. |
| M29 | A Talk or Confirm press while torque on is running | It stops it, torque ends off, and the press starts no recording. |
| M30 | A torque limit write that doesn't take (acknowledged, not stored) | `read-back mismatch (torque limit)`. No goal is written, and torque ends off. |
| M31 | The arm's 12 V drops for 300 ms while it holds, with no stop-sense edge (`test/sim/motion/31-power-loss.walk`) | `feedback_stale` while silent. After the clear, the re-read shows torque off. No goal is written and no torque comes on. A pose is refused `torque_off`. |
| M32 | A stop press during a pose, then a release latched in the same turn (an overload; or a miswired stop that doesn't cut power), with goals turning torque on | The stop's hold had queued its read before the torque off, and writes no goal after it. After 500 ms every servo of that arm reads torque 0. |
| M33 | A stop press during a terminal torque off | The arm ends torque off. |
| M34 | A stop press after torque on's last write, before its read-back | Torque ends off, and the request is `error`, not `completed`. |
| M35 | Every terminal command's title | Fits the contract's 60 characters, so it can be prepared (a too-long torque-off title used to throw). |
| M36 | One arm's bus keeps retrying (a silent servo on the right) | The healthy left arm's reading never goes stale: no fault on it, torque still on. |

## Taught skills: record and replay (`src/motion/`, added 2026-10-24; simulated servos only)

Written from the motion contract's skill rules (`SkillSchema`, `checkSkillAgainstSetup`, `skill.run`, `gripper.release`, `MOTION_COMMAND_POLICY`) before the tests. T1 to T7 are the `.walk` scripts in `test/sim/skills/`, run on a fake clock by `test/motion-walk.test.ts` (and by `walker simulate --arms --script`); T8 to T35 are in `test/skills.test.ts`. The skills they replay are the simulator's: one taught in the script with the simulated teaching arm, and a made-up sample (`sim_sample_handover`, `src/sim/sampleSkill.ts`), SIMULATED, never a taught skill. The simulated object stops the gripper closing at 12° and loads it at its torque limit. Nothing here is a hardware result.

| Id | Situation | Expected |
| --- | --- | --- |
| T1 | The demo path: teach a pick on the left arm, save it, replay it (`01-record-replay-let-go.walk`) | Recording is a teleop Confirm target ("Record a movement: the left arm copies its teaching arm."). A grasp marked before the gripper closes: grasp active, 30% gripper torque, and no fault while the gripper is stopped 20° or more short of its teaching arm. Ended with a terminal stop: the gripper's goal is where it is (squeeze let off) and the Pi offers "Let go?" (`walker_local`) at once. Saved. Confirm opens it. Back to `ready`, the replay is worded from the skill's own title, grasps at its event, completes holding, and "Let go?" is offered again. No fault throughout. |
| T2 | A Talk press mid-replay, holding the object | Stops (`handle_press`) and holds: every torqued servo's goal within 0.5° of where it was at the press, the gripper's too (squeeze let off), at 30%. No goal is written in the next second. "Let go?" is offered at once (`walker_local`); Confirm opens the gripper to the taught angle. |
| T3 | The object stops the gripper at 12° while the skill closes it to 4° | No fault (a grasping gripper is exempt from the stall and load rules and divergence). The timeline doesn't wait: it completes within 6 s of the press (the skill is 4.5 s; its deadline 7.6 s). Holding with the squeeze, then "Let go?". It was an id-only offer, worded from the skill file. |
| T4 | The arm isn't at the skill's start | Refused `not_at_start` before any Confirm target. An offer of it is dropped. From `ready` it is prepared. |
| T5 | The skill file edited by hand: one waypoint too fast; the wrist out of range throughout; valid when asked, too fast at the press | Each refused `skill_invalid` and latches the `skill_invalid` fault (the last one at the press, after the file is read again). Nothing moves. Put back, it is prepared again. |
| T6 | The arm loses its 12 V while holding at the start | After the clear, a replay is refused `torque_off` before any Confirm, and no torque comes on, until torque on (with Confirm). |
| T7 | A recording left running; a recording that ends with a fault | The first ends by itself at 55 s (`RECORD_MAX_MS`, within 56 s of starting; a stop: the arm holds) and is saved; nothing is grasped, so no "Let go?". The listing shows it able to run. The second (a servo stops answering) isn't saved. |
| T8 | The recording and replay arithmetic | Samples are clamped into the calibrated range less 2° and rounded toward its inside (94.67°, never 94.68° past a 94.6777° end), so a recording pinned at both ends passes `checkSkillAgainstSetup`. A stretch over the speed limit is lengthened to it (75°/s over 20 ms becomes 25 ms at 60°/s), never shortened; a gap is at least 10 ms; past 60 s or a 1 s gap it is refused. Events move with their samples. A grasping end needs a let-go angle. Bench mode stretches a 60°/s skill 2× (caps at 30°/s). The sample skill passes `SkillSchema`, is titled SIMULATED and isn't `tray_pick_handover`. |
| T9 | Skill files | 0600 in a 0700 folder, no temporary file left. Never written over an existing file without replace (`EEXIST`); with replace, the old one renamed `.replaced-<time>`. A file whose `skill_id` isn't its name is invalid. Removed: renamed `.removed-<time>`. One waypoint a line. |
| T10 | Recording samples the walker's arm, not the teaching arm | With the arm's wrist held at 0° and its teaching arm at 2.5°, every recorded wrist angle is under 0.2°. The file is a `recorded` contract skill at 60°/s, `lift_mm` null, 0600. |
| T11 | A skill by that id exists | Recording it without `--replace` is refused at once (no target). With it, the old file is set aside. |
| T12 | A recording that ends grasping (marked at 0°, the gripper then closing 20°) | A mark with another recording's id is refused. At the stop, "Let go?" is offered at once to 0°. Saving without an angle asks for one (suggesting 0°); 170° (outside the range) and −30° (it would close further) ask again and save nothing. With 25°, saved with `let_go` 25°, and "Let go?" is asked again to 25°. |
| T13 | The terminal goes away: Ctrl-C after the stop; the socket simply closing mid-recording | Nothing to save. Mid-recording, the close stops it first, then throws it away. |
| T14 | While recording | The arm's goals ramp at most 60°/s (a 40° jump of the teaching arm: at most 30.5° in 0.5 s), and its servos' speed register is the 60°/s one, not teleop's 90°/s. It can't be saved until it ends. |
| T15 | Every goal a replay writes | Within 5° (57 steps) of the measured position and 2° a step. Its grasp becomes active. It ends `completed`, every joint but the gripper within 3° of the last waypoint, still grasping. |
| T16 | A 60°/s skill in bench mode | Takes at least twice its length (stretched to 30°/s). In normal mode it isn't stretched. |
| T17 | The file changes or goes between the walker asking and the press | Changed: refused `confirm_target_mismatch`. Removed: refused `unknown_skill`. Nothing moves. |
| T18 | Not at the start, from the terminal | Refused at once; the reason gives the worst joint and "walker arms pose go ready --arm left". |
| T19 | Offers | One with words, or an unknown id, is dropped. A known id is prepared as `offer`, worded from the file's title. |
| T20 | A push while it holds the object after a replay | `feedback_divergence` and comply: every joint at 25%, the grasping gripper at 30%. |
| T21 | Listing, removing, let-go | The list shows a file failing `checkSkillAgainstSetup` as unable to run, with the reason. Removing needs no Confirm, withdraws a pending target to run it (not another skill's), and is refused while it runs; a second removal says it's unknown. "Let go?": `no_grasp` when nothing is held; after a stop it is offered at once (`walker_local`, the taught 30°); from the terminal, `out_of_range` at 170° and at 5° (more closed than where the grasp began, near 20°), and otherwise prepared with the taught angle. |
| T22 | A servo's torque limit changes under a replaying arm (not the one torque on wrote) | `limits-lost`, and the replay ends `faulted` with `torque_lost` (hold) on that arm within a few ticks, so a helper must clear it; no goal is written to that arm in the next second. (Before, the move ran on with no goals until its deadline.) |
| T23 | The arm's 12 V drops while it holds the object after a replay | Once its servos answer with torque off, its grasp ends (the limp gripper holds nothing). After the clear, "Let go?" is refused `torque_off`; after torque on (with Confirm) the gripper's limit is the mode's 50%, not the 30% hold, and "Let go?" is refused `no_grasp`. |
| T24 | A finger-sized blocker (stops the gripper at 18°, where the skill closes to 4°) mid-replay; and the same with a stop just after the grasp | Mid-replay: `grasp_mismatch` on `arm_left` gripper (more than 10° from the taught goal for 300 ms), the replay `faulted`, the reason logged. The gripper's goal is where it is and its limit 25%. "Let go?" is offered at once with the fault latched. Confirm runs it in `fault` mode, only the gripper moves (the other five goals unchanged), it opens to 30°, and every published state passes the contract. After a stop: the squeeze is let off and "Let go?" offered, with no `grasp_mismatch` after (no taught goal any more). |
| T25 | A push while it holds the object after a replay (`feedback_divergence`, the arm compliant) | Limits 25% with the gripper at 30%. "Let go?" is offered with the fault latched. Confirm opens only the gripper, on the compliant arm, and the grasp ends. |
| T26 | A fault while holding, then cleared | The clear replaces the pending "Let go?"; once cleared, "Let go?" is offered again (`walker_local`). |
| T27 | A stiff elbow (about 5°/s); a skill whose start is 4° off where the arm is | The grasp event waits until the elbow is within 3° of the event's point (over 2.5 s after the press, not 1.6 s), with no fault, and the skill then completes. From 4° off, progress stays 0 until every joint is within 3° of the first waypoint ("at its start"). |
| T28 | A recording's length | It ends at 55 s (60 s less 5 s). 55 s of samples overshooting 5% all along still saves (stretched past 55 s, under 60 s); 60 s of them couldn't be saved. |
| T29 | A grasp whose 30% hold torque can't be written (no acknowledgement) | The grasp isn't active (no exemption), and the replay stops. |
| T30 | An offer of a skill edited to be too fast, then out of range | Dropped, with a log line each; no fault latches and no target is prepared. |
| T31 | Someone pulls the gripper open (to 25°) faster than "Let go?" opens it | Its goal never goes back toward closing: never below where it is. |
| T32 | A grasp from 30° closed to 10° (no object), then the jaws pulled open to 50° and held; also a grasp marked but never closed | The closing direction is fixed once per grasp (the first tick 1° or more from where it began). Pulled to 50°: `grasp_mismatch`, "Let go?" offered again to 30°, and Confirm completes at once: already open past 30°, so nothing moves and no goal goes toward closing. Never closed: a typed angle (`--deg`) is refused (the direction isn't known); the taught angle is prepared. |
| T33 | "Let go?" with the gripper held shut, twice | The first passes its deadline: `motion_timeout` on that arm, and "Let go?" is offered again. The second also passes its deadline with that fault already latched, and still ends (`faulted`): nothing runs for ever. |
| T34 | A servo stops answering while it holds the object (freeze) | While no reading comes, the gripper's squeeze goal stays (nothing is written from a stale reading). At the first fresh read, only the gripper's goal goes to where it is; the other five stay frozen. "Let go?" from the terminal then opens it on the frozen arm, with the fault latched, the other five goals unchanged. |
| T35 | A clear asked for while "Let go?" runs (a fault latched) | Refused `busy`. |

## The lift under the motion coordinator (added 2026-10-24; simulated lift and servos only)

Written before the tests, from the motion contract (`lift.home`, `lift.move`, `lift.disable`, HOLD_CONTROL_REFRESH_MS, FAULTS_THAT_UNHOME_LIFT) and the lift client's interface (`src/motion/lift/README.md`); E14 to E17 and E5b after the review of 2026-10-24. E1 to E8 and E12 to E17 are in `test/lift-coordinator.test.ts`, E9 and E10 are the `.walk` scripts in `test/sim/lift/` (run on a fake clock by `test/motion-walk.test.ts`, and in real time by `walker simulate --arms --lift --script`), and E11 is `test/lift-screen.test.ts`. The lift board is the SIMULATED one (`src/sim/fakeLift.ts`), the servos the simulated STS3215s, and the arms start folded at the simulator's made-up `stowed` pose. Every published motion state must pass the contract's MotionStateSchema. Nothing here is a hardware result.

| Id | Situation | Expected |
| --- | --- | --- |
| E1 | `lift.home` prepared at the terminal, the screen's hold control held, Confirm pressed; then a move to 300 mm let go partway | The target says "Home the lift. Park the walker and lock the brakes, then press Confirm."; nothing goes to the lift before the press. After it: active `lift.home`, `running`, `hold_source` `screen_hold_control`, mode `moving`; completed, homed at 5 mm, last command `completed`. The move, let go at 150 mm or more: `stopping` with no hold source at once, a heartbeat naming nobody within 20 ms, ended `stopped`, still homed, stopped between 150 and 300 mm, last command `stopped`; held again, it never moves. |
| E2 | Confirm with nothing held; and the hold let go between the press and the first control tick | Refused `not_held` (last command and the terminal's request); no `lift.home` line is ever written. |
| E3 | The arms' motors off; then an arm out at `ready`; then folded again | `lift.home` refused `arms_not_stowed` at once (no target), "isn't holding with its motors on". A move refused the same, naming the arm, the joint, how far, and `walker arms pose go stowed --arm left`. Folded: prepared ("Raise the lift to 300 mm"). Unhomed, a move is refused `lift_not_homed`; homed, 900 mm is `out_of_range`. |
| E4 | A Talk press, a Confirm press, the terminal's stop mid-move; a stop with nothing moving | `motion.stop` (`handle_press`), and a `lift.stop` written in the same moment, not at the next tick; `stopping`, then ended `stopped`, still homed, ready, no fault, no target left. The terminal's stop sends `lift.stop` too, moving or not. |
| E5 | The stop switch mid-move (the walker's one switch: it also opens the lift's own stop-sense input) | `stop_circuit_opened` latched for `system` (the Pi) and for `lift` (the lift board); the move ends `failed` (last command `faulted`), the lift unhomed and still, the arms limp. A clear is refused `cause_present` while pressed. Released, the clear clears the Pi's faults at once and the lift's when the lift accepts `lift.clear` (no fault left, ready). With the line to the lift down at that moment, only the lift's stays latched (`lift clear no_ack`) and the mode stays `fault`. Afterwards a move is refused `lift_not_homed` (once the arms are on again). |
| E6 | The line from the lift lost mid-move; both directions lost; a frozen board; the control loop stops calling the lift | Lost: `lift_module_lost` (part `lift`, hold: the arms keep their torque), the move ends `faulted`, the lift stops on the best-effort stop, no heartbeat after, disconnected and unhomed; a clear is refused `cause_present` until it is heard again; then cleared, and a move needs homing. Both directions: the lift's own watchdog stops it within 300 ms plus a tick and the ramp, latching `watchdog_expired`, driver still on. Frozen: `lift_module_lost` within 400 ms, back unhomed once it restarts. Stalled loop (LW3): `watchdog_expired` on the lift within 550 ms, latched by the Pi, unhomed. |
| E7 | One Confirm target and one motion at a time | A lift target pending: a skill can't replace it in its first 2 s (`confirm_busy`); once the lift runs, an arm pose and another lift target are refused `busy`. A skill pending: a lift target is refused `confirm_busy` in its first 2 s and `arms_not_stowed` after (the skill's target stays); once the skill runs, a lift target is refused `busy`. |
| E8 | A skill taught at 300 mm, asked for before homing and at 5 mm | `lift_not_homed`, then `lift_not_at_height` with "the lift is at 5 mm; this movement was taught at 300 mm: walker lift move 300". |
| E9 | The demo flow (`01-demo-flow.walk`) | Both arms on, home (held), raise to 300 mm (held), the arm to `ready`, the tray skill (grasps, completes holding), "Let go?" (`walker_local`) Confirmed, the arm folded, lowered to 50 mm (held). No fault. Passes 3 times in a row in real time. |
| E10 | `02-hold-release-stop.walk` (LW5) | Confirm with nothing held refused; homing held; a release partway ends `stopped`; a Talk press stops it; the stop switch latches both `stop_circuit_opened` faults; the clear is refused while pressed and cleared after (by the lift too); with the arms on again, a move is refused `lift_not_homed`. Passes 3 times in a row in real time. |
| E11 | The real walker screen (machine and server on 127.0.0.1) beside the coordinator; the test plays the page | A lift target shows the hold control (`motion_confirm`); a still-held while it shows is accepted; Confirm then raises the lift (`motion_running`, `running`). The page's release stops it (ended `stopped`, "Stopped" on screen), and a still-held after is refused 409 and moves nothing. An obstacle taking the screen mid-move: the next still-held is refused 409 with a `not_shown` release, and the lift stops. Talk with a lift target pending and the control held: the target is withdrawn, the next still-held refused, and a later Confirm starts nothing. Talk while it runs stops it (`handle_press`). |
| E12 | `lift.disable` Confirmed | The lift frees its motor (`lift disable disabled`), last command `completed`, unhomed, driver off. A stop never sends `lift.enable`. |
| E13 | Recording a skill with a lift fitted | Refused before the lift is homed ("the lift isn't homed"). At 300 mm, the saved skill's `lift_mm` is 300. |
| E5b | `lift.clear` answered `cleared` | Drops only the lift faults latched when the clear was asked for; a lift fault latched after stays, and so does `fault`. |
| E14 | Any fault mid lift move, held: the handle unplugged; an arm's servo going silent; the Pi's stop latching again every tick while the lift, which can't hear the first stop, still moves. And "Let go?" after the tray skill with a gripper that opens slower than asked (15°/s) | `hand_controls_lost` (system) or `feedback_stale` (`arm_left`) latches and a `lift.stop` is written within a tick, though the screen's control is still held; the lift stops and stays, mode `fault`, last command `faulted`. A repeated fault sends `lift.stop` again at most every 100 ms while the lift reports itself moving, and once it stops, nothing more after the client's bounded resends. "Let go?" completes with no fault: letting go clears the skill's taught gripper goal, so `grasp_mismatch` can't fire on the opening (it did once, in a real-time demo run, before the fix). |
| E15 | lift.json's configuration differs from the board's; no guards, no drop test outside bench mode; bench mode | Mismatch: `lift_config_mismatch` (part `lift`) latches, a lift target is refused `fault_latched`, a clear `cause_present`, and nothing goes to the lift. Outside bench mode: `lift_guards_missing`, `lift_drop_test_missing`. Bench mode with neither: homing refused `lift_over_limits` with its sentence; the board built without stop-sense, or the Pi's stop not wired: the arms still prepare in bench mode, the lift is refused `no_hardware_stop`. |
| E16 | The service stopping (SIGTERM) and the terminal that started it going away, mid lift move | SIGTERM: one `lift.stop` written at once, no heartbeat after, the lift stops. The terminal's socket closing: `motion.stop` (`operator_cli`), ended `stopped`. |
| E17 | lift.json missing, valid, not JSON, failing the schema, version 1, an installation the schema forbids; `createPiMotion` with a malformed one | Read as missing, ok, or invalid with the reason ("lift.json is malformed: it isn't JSON", "lift.json is malformed (config.max_speed_mm_s: ...)"). Malformed: no client, no lift handler registered, "the lift is off" logged with the reason, and a lift target refused `part_missing` "this walker has no lift: lift.json is malformed: it isn't JSON". Valid: the client is built and registered as the lift handler. |

Mutation checks (run by hand, results in the PR): the screen's hold not routed to the client, the client's `tick` not called from the control loop, `lift.stop` not sent on a motion.stop, the lift's verdict skipped when preparing, `lift.stop` not sent when a fault latches, a release keeping the taught gripper goal, bench mode waiving the lift's hardware stop, the acceleration and homing-speed limit skipped, no `lift.stop` on a repeated fault, and `lift.clear` dropping every lift fault must each fail a test.

## Live camera (`src/camera/`, added 2026-10-24; ffmpeg's test source and recorded frames only)

`test/camera.test.ts`. Times come from the fake clock; ffmpeg is a fake child in the capture rows; the cloud is a fake in the link rows and a real local HTTP server in CL1. No camera, Pi or real server was used for these rows. Contract: `packages/contracts/src/camera.ts`.

| Id | Situation | Expected |
| --- | --- | --- |
| CJ1 | A stream of JPEGs split at every possible byte boundary | The same frames come out, byte for byte, in order, whatever the chunking. |
| CJ2 | Garbage before, between and after frames; a frame cut off mid-scan followed by a new SOI | Garbage is skipped; the cut frame is dropped; the frames around it come out whole. |
| CJ3 | A frame with stuffed bytes (`FF 00`) and restart markers (`FF D0`–`FF D7`) in its scan, and an APP segment holding `FF D9` | None of them ends the frame; only the EOI after the scan does. |
| CJ4 | A frame longer than CAMERA_FRAME_MAX_BYTES | Dropped (counted), never emitted, and the next frame comes out whole. |
| CJ5 | A frame without a DHT segment | `withHuffmanTables` inserts the standard Annex K tables (one 418-byte DHT segment: 12 + 12 + 162 + 162 values) right before SOS; a frame that has a DHT, or that can't be parsed, is returned unchanged. ffmpeg decodes the result to the same pixels as the original with tables (checked by hand with framemd5, see the README). |
| CC1 | Capture started (camera source) | Spawns `ffmpeg … -f v4l2 -input_format mjpeg -video_size 640x480 -framerate 15 -i <device> -c:v copy -f mjpeg pipe:1`; test pattern spawns lavfi `testsrc2` encoded to MJPEG. Only the newest frame is kept, numbered from 1, with DHT added. `start()` twice spawns once. |
| CC2 | ffmpeg exits while wanted | Logged with its exit code only; restarted after 1 s, then 2 s, 4 s… up to 30 s; the delay resets after a frame arrives. |
| CC3 | `stop()` | SIGTERM, then SIGKILL after 2 s if it hasn't exited; the newest frame is dropped; no restart. A child that failed to spawn (no pid) is never signalled. |
| CL1 | HTTP client against a local server | The wait is `GET /api/v1/devices/{id}/camera?source=…` with the Bearer credential; a frame is `POST …/camera/frames` with `Content-Type: image/jpeg`, the source header and the JPEG bytes as the body. A 401 is `unauthorized`. |
| CL2 | Wait answers `wanted: false` | Asked again at once; the camera never starts. |
| CL3 | Wait answers `wanted: true` | The camera starts; each new frame is posted once (a frame already sent isn't sent again), one request at a time, at most CAMERA_MAX_FPS (10) a second. |
| CL4 | A frame's answer is `keep_sending: false` | The camera stops and the link waits again. |
| CL5 | A 401 on the wait or a frame | The camera stops; nothing more is sent with that credential; a new credential (re-pairing) starts it again. |
| CL6 | The wait fails (unreachable, 500) | Retried after 2 s, doubling to 30 s; reset after a good answer. |
| CL7 | Frame posts keep failing | Retried every 0.5 s; after 10 s of failures the camera stops and the link waits again. |
| CL8 | No credential | Nothing is sent; checked again every 5 s. |
| CL9 | `stop()` | The open request is aborted and the camera stops; nothing is sent afterwards. |
| CL10 | Wanted, but the camera gives no frame for 5 s | The camera stops and the link waits again (a wait still wanted starts it again). |
