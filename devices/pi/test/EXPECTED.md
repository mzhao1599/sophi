# Expected results for the Pi service (written before the tests)

Revised 2026-10-24 when the walker contract landed (PR #26): rows marked *(contract)* changed or were added then, before their tests were changed. Rows marked *(review)* were added from the break-it review, before their fixes.

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

1. "Sophi is on." is spoken; the link goes online.
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

The walker's own screen states only: the circle's (suggestions, joins, messages, My screen) come with the circle feed. Rows D1 to D9 run on a fake clock (`test/screen.test.ts`), D10 to D13 on a real socket on 127.0.0.1 (`test/screen-server.test.ts`). D14 and D15 are runs with headless Chromium at 800x480, not in the test suite (the README's "The walker screen's page" says how). Timings marked *placeholder* are in `src/constants.ts`.

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
