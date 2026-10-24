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
| B12 | ESP32 `hand.input` with `button: "talk"` from a module whose hello declared `button.talk` | On `hand-left-*`, the Pi maps the GPIO32 wire event to Confirm, including its release; on the right hand it remains Talk. From a module that didn't declare it, or before its hello: ignored. A trigger-only line: no button event. |
| B13 | GPIO bounce: pressed, released, pressed within 30 ms (*placeholder*) | One press, emitted once the line has been steady for 30 ms. A real tap (pressed, then released 100 ms later) gives one press and one release. |
| B14 | `gpiomon` output | libgpiod v1 `--format '%o %e'` lines (`17 0`, `17 1`) and v2 `--format '%o %E'` lines (`17 falling`, `17 rising`) both parse. Buttons wire to ground with the pull-up on, so falling is pressed. Unknown offsets and junk lines are ignored. |
| B22 | A new configuration is applied (after Confirm, or learned from a heartbeat) *(rehearsal)* | The walker reports it at once with an extra heartbeat (or right after the one in flight), so the page shows "Applied" within about a second, not at the next 5 s tick. Only when the version actually changed, so a server whose two answers disagree can't make it loop. A failed heartbeat keeps its backoff. |
| B15 | Talk pressed while offline, unpaired, connecting or needing a re-pair | A local line at once (see O4, P2, A2), no recording. |
| B18 | A heartbeat answer that left before a turn opened a proposal, or before a Confirm closed one, arrives late *(review)* | It doesn't overwrite the newer knowledge: the turn's proposal stays confirmable, and a closed one isn't reopened. |
| B19 | The button source that started a recording goes away while Talk is held: its hand module goes unavailable or says hello again (a reboot), or `gpiomon` exits *(review)* | The recording is discarded, nothing is sent, and "I stopped listening because the button stopped responding." is spoken. After `gpiomon` restarts, the next real press works. |
| B20 | The listening cue's player hangs *(review)* | The mic opens anyway after 1 s. |
| B21 | A turn that ends without its reply being heard: it timed out, failed, or came back unreadable *(review 2)* | Treated like a cancelled turn: a proposal it opened is declined on the next heartbeat, never offered to Confirm. *Decision for review.* |
| B23 | Talk pressed on an ESP32 hand that declared `haptic` and is `ok` *(press buzz, 2026-10-24: "I click it and it buzzes")* | One `haptic.play` `recording` 150 ms (*placeholder*) to that same hand, as well as the "listening" sound. Recording starts exactly as without it (the mic opens, one turn is sent on release). Every Talk press from a hand buzzes, including one that cancels a wait or gets a local line. A release never buzzes. |
| B24 | Confirm pressed on that hand, and it confirms the open proposal *(press buzz)* | One `haptic.play` `confirmation` 250 ms (*placeholder*) to that hand, as soon as the server says confirmed, as well as the "done" sound. |
| B25 | Confirm pressed on that hand, and it confirms nothing: nothing open, the proposal closed, ignored while recording, a second press while the first is answered, offline or a failed request *(press buzz)* | One `haptic.play` `error` 250 ms (*placeholder*) to that hand. The sounds and lines are unchanged. Each Confirm press buzzes once. |
| B26 | A GPIO press or a simulator keyboard press *(press buzz)* | No haptic: the Pi's header buttons and the keyboard have no motor. |
| B27 | A press from a hand that can't buzz (no `haptic` in its hello, a haptic fault, not `ok`) or whose port is busy *(press buzz)* | No haptic and no error; the sounds, the recording and the turn are unchanged. |
| B28 | Press buzz and obstacle alerts *(press buzz)* | The press buzz plays whatever the obstacle cue setting is (also with `cues: ["sound"]`): it is button feedback, not an obstacle alert. It doesn't count as one: a near zone right after a press still gets its own `near_obstacle` buzz, and with `cues: ["sound"]` still only the obstacle sound. |

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

1. "Steady is on." is spoken; the link goes online.
2. Talk, Talk: a turn is sent and the fake cloud's reply is spoken (it says it is the fake cloud).
3. ToF near: a `haptic.play` reaches the simulated hand (configuration 1 is vibration).
4. Talk, Talk: the fake cloud proposes short sounds. Confirm: configuration 2 is applied and "Done." is spoken.
5. ToF near: the obstacle sound plays, no haptic.
6. Network down: offline within 2 heartbeats; the offline notice is spoken; a Talk press gets the local line.
7. Network up: "I'm back online."; a Talk turn works.
8. The fake cloud forgets the walker: the next heartbeat gets 401 and "pair me again" is spoken.

## Wi-Fi from the SD card (`scripts/walker-wifi-import.sh`, added 2026-10-24)

Run with bash on a temporary `wifi.txt`, with a fake `nmcli` first on `PATH` that only records its arguments, so no test touches the Mac's or a Pi's networks. What real NetworkManager does with the result was checked once on the Pi (devices/pi/README.md, "Wi-Fi on any network"), not here.

| Id | Situation | Expected |
| --- | --- | --- |
| W1 | A `name:` / `password:` block | One `nmcli connection add` named `walker: <name>` for that SSID, with WPA-PSK and the password, `connection.autoconnect yes`, `ipv4.may-fail yes`, `ipv6.method auto`, `ipv6.may-fail yes`. Any older connection of the same name is deleted first. The password line becomes `password: (saved)`. |
| W2 | A name with spaces, a straight apostrophe or a typographic one ("M’s Phone"), or spaces around the values | The SSID is passed exactly, trimmed, as one argument. |
| W3 | `password:` left empty | An open network: the same add without any `wifi-sec` setting. The line still becomes `password: (saved)`. |
| W4 | A block already `password: (saved)` | Skipped: no `nmcli` call for it. |
| W5 | Comment lines (including the example's `# name:` and `# password:`), blank lines and other text; a file saved with Windows line endings | Comments and other lines stay byte for byte and are never read as a network. A `password:` line with no `name:` line since the last block (for example under a commented-out name) adds nothing and is left as it is. A block with Windows line endings parses the same (the carriage return is not part of the name or password). |
| W6 | A second run over the rewritten file | No `nmcli` call and the file is unchanged. A missing `wifi.txt` exits 0 with no call. |
