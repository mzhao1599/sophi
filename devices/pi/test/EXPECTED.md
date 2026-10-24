# Expected results for the Pi service (written before the tests)

Revised 2026-10-24 when the walker contract landed (PR #26): rows marked *(contract)* changed or were added then, before their tests were changed. Rows marked *(review)* were added from the break-it review, before their fixes.

Each row says what must happen. The test that checks it carries the row's id (for example `B4`) in its name. Every time value comes from an injected fake clock; no test sleeps, records the room or plays sound out loud.

All numbers marked *placeholder* are not measured. They live in `src/constants.ts` and are labelled there too.

## Boot and pairing

| Id | Situation | Expected |
| --- | --- | --- |
| P1 | Service starts | The first spoken line is "Steady is on." Nothing records until a Talk press. |
| P2 | No credential file, Talk pressed | Spoken "I'm not paired yet. Open the walker page to get a pairing code." No recording, no request. |
| P3 | `walker pair` succeeds | The credential file is written with mode 0600 in a 0700 folder, and the pairing's configuration 1 is saved *(contract)*. The command prints the device id, never the credential. |
| P4 | Credential file appears while running | The next heartbeat tick reads it; the link goes `connecting`, then `online` on the first good heartbeat. |
| P5 | Any log line | Never contains the credential, an `Authorization` header or audio bytes. |
| P7 | A credential file whose server isn't https (or http to this machine), or one the service can't read *(review)* | Treated as no credential ("I'm not paired yet"), with the reason logged; the service keeps running instead of crashing in a loop. |
| P8 | Saving a fetched configuration fails (read-only SD card) *(review)* | The new configuration still applies in memory; the failure is logged. |
| P9 | A credential appears while running with none before it (for example after fixing its permissions) *(review 2)* | The configuration is read again from disk, and a server version that differs from the local one, lower as well as higher, is fetched. |
| P6 | Heartbeat and turn snapshot *(contract)* | `null` when no obstacle sensor has said hello; otherwise the fresh zones. The manifest says `simulator` and each part's `simulated`. |

## Buttons (the design's button map)

| Id | Sequence | Expected |
| --- | --- | --- |
| B1 | Online, idle. Talk pressed (GPIO), released after 2 s | "listening" cue, then the mic opens. On release: "done" cue, one turn sent with a fresh `client_turn_id` and a 16 kHz mono 16-bit WAV of 2 s (64,044 bytes). The reply is spoken. The clip buffer is zeroed once the request settles. |
| B2 | Talk held past 15 s | Recording stops at 15 s and the turn is sent. The clip is at most 480,044 bytes (under 1 MB). The later release does nothing. |
| B3 | Talk tapped for under 300 ms (*placeholder*) | Nothing is sent. Spoken "I didn't catch that. Hold Talk while you speak." |
| B4 | Talk pressed while a turn is waiting | The request is aborted, "Cancelled." is spoken, and a late reply is never spoken. |
| B5 | Talk pressed while a reply is being spoken | Speech stops and a new recording starts. |
| B6 | Keyboard (simulator): Talk, Talk | First press starts recording, the second press sends. A terminal can't see key release, so no release events exist. |
| B7 | Online, open proposal, Confirm pressed | One `confirm` answer for that proposal id. The answer's proposal is `confirmed` with `configuration_version` 2: configuration 2 is fetched and saved, the "done" cue plays, "Done. Obstacle alerts now use short sounds." is spoken, and the next heartbeat's manifest reports version 2. |
| B8 | No open proposal, Confirm pressed | "nothing to confirm" cue and the status line "Nothing to confirm." (a `local_reply` event). No request. |
| B9 | Confirm pressed while recording | Ignored: no request, recording continues. |
| B10 | Confirm pressed twice quickly | One request. |
| B11 | Confirm answered `409 proposal_closed` with the proposal `expired`, `superseded` or `declined`, or `404` *(contract)* | The "nothing to confirm" cue and status line; the Pi forgets that proposal. Configuration unchanged. (The Pi never judges expiry by its own clock.) |
| B16 | Confirm answered `409 proposal_closed` with the proposal `confirmed` (the page's Confirm won first) *(contract)* | Treated as success: configuration 2 is fetched and "Done. Obstacle alerts now use short sounds." is spoken. |
| B17 | Talk cancels a turn whose request reached the server and opened a proposal *(contract)* | The next heartbeat's open proposal names that `client_turn_id`: the Pi declines it once, never offers it to Confirm, and a Confirm press says nothing to confirm. |
| B12 | ESP32 `hand.input` with `button: "talk"` from a module whose hello declared `button.talk` | Same as a GPIO Talk edge. From a module that didn't declare it, or before its hello: ignored. A trigger-only line: no button event. |
| B13 | GPIO bounce: pressed, released, pressed within 30 ms (*placeholder*) | One press, emitted once the line has been steady for 30 ms. A real tap (pressed, then released 100 ms later) gives one press and one release. |
| B14 | `gpiomon` output | libgpiod v1 `--format '%o %e'` lines (`17 0`, `17 1`) and v2 `--format '%o %E'` lines (`17 falling`, `17 rising`) both parse. Buttons wire to ground with the pull-up on, so falling is pressed. Unknown offsets and junk lines are ignored. |
| B15 | Talk pressed while offline, unpaired, connecting or needing a re-pair | A local line at once (see O4, P2, A2), no recording. |
| B18 | A heartbeat answer that left before a turn opened a proposal, or before a Confirm closed one, arrives late *(review)* | It doesn't overwrite the newer knowledge: the turn's proposal stays confirmable, and a closed one isn't reopened. |
| B19 | The button source that started a recording goes away while Talk is held: its hand module goes unavailable or says hello again (a reboot), or `gpiomon` exits *(review)* | The recording is discarded, nothing is sent, and "I stopped listening because the button stopped responding." is spoken. After `gpiomon` restarts, the next real press works. |
| B20 | The listening cue's player hangs *(review)* | The mic opens anyway after 1 s. |
| B21 | A turn that ends without its reply being heard: it timed out, failed, or came back unreadable *(review 2)* | Treated like a cancelled turn: a proposal it opened is declined on the next heartbeat, never offered to Confirm. *Decision for review.* |

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
| S11 | Manifest | One entry per module: catalog id (`hand` → `controls.hand`, `perception` → `perception.tof`), `instance_id`, firmware, protocol 1, health, faults, `observed_at`, `simulated`. |

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
| W4 | A turn's answer carries `speech` (the server's voice) *(contract)* | The WAV is played and the walker's own voice stays silent. If the WAV can't be read, or playing it fails, the walker speaks `turn.reply` itself. |

## Simulator end to end (run 3 times in a row, logs kept)

`walker simulate --script test/sim/demo-path.walk` against the fake cloud over local HTTP, with a generated clip as the mic. Every step must pass in order, three runs out of three:

1. "Steady is on." is spoken; the link goes online.
2. Talk, Talk: a turn is sent and the fake cloud's reply is spoken (it says it is the fake cloud).
3. ToF near: a `haptic.play` reaches the simulated hand (configuration 1 is vibration).
4. Talk, Talk: the fake cloud proposes short sounds. Confirm: configuration 2 is applied and "Done." is spoken.
5. ToF near: the obstacle sound plays, no haptic.
6. Network down: offline within 2 heartbeats; the offline notice is spoken; a Talk press gets the local line.
7. Network up: "I'm back online."; a Talk turn works.
8. The fake cloud forgets the walker: the next heartbeat gets 401 and "pair me again" is spoken.
