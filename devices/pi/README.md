# Sophi on the walker: the Raspberry Pi service

**Status, 2026-10-24.** The service is written and tested on a Mac. It runs the whole demo path end to end in **simulator mode** (simulated buttons, ToF sensor, hand module, microphone and speaker) against a **fake cloud** on the Mac. On the evening of 2026-10-23 it **ran on the real Raspberry Pi 5** for the first time: installed with `scripts/install-pi.sh`, paired with the deployed server on Render, shown Online on the walker page, and it noticed going offline and coming back by itself when the Pi changed Wi-Fi networks. Later that night (23:00 to 23:23 PDT) it ran with a real USB mic, a real USB soundbar, Piper, and the first ESP32 hand board, whose Talk wire event gave one real spoken turn, answered by Gemini on Render in about 4 s and heard through the soundbar. That was before the Pi-side change mapping the left board's GPIO32 event to Confirm; the new mapping was deployed on 2026-10-24; both hand boards announced distinct IDs and were healthy, while a physical two-button role check remains pending. Not yet tried on the Pi: Confirm, the GPIO buttons, an obstacle board, a haptic cue sent by the Pi, the offline beat since then, and the demo beats in order ([Set up the Pi](#set-up-the-pi) says what each step showed). It speaks the walker contract (`packages/contracts/src/walker.ts`); see [Cloud link](#cloud-link).

On 2026-10-24, the Pi's `/dev/serial/by-id` showed only one CP2102 symlink because both bridges reported serial `0001`. The deployed service now scans `/dev/serial/by-path`, removes duplicate aliases for the same tty, and saw `hand-right-01` and `hand-left-01` simultaneously, both healthy. The right board was reflashed and its app image verified before deployment. After the service restarted it logged the new fixed boot notice, "Sophi is on." Its systemd unit was active and its cloud link online. The owner's physical press check for right Talk and left Confirm is still pending.

On 2026-10-25, the Pi registered the combined lift/ToF board's `tof-front-01` identity as a healthy perception module and sent near-obstacle haptic commands to both hand modules at different times. The lift identity was also seen, but no `motion/lift.json` was installed, so the service did not run a lift client or move the lift. Four USB cameras and one serial adapter consistent with an SO-101 controller enumerated; camera frames and servo communication remain unverified. See [the hardware record](../../hardware/current-build.md#pi-inventory-and-obstacle-cues-2026-10-25).

The Pi later logged repeated five-second `stty` timeouts while scanning USB serial ports, followed by misleading hand and obstacle heartbeat alerts. Serial setup now runs asynchronously so a stalled USB adapter cannot block the main event loop past the three-second heartbeat deadline. A truly disconnected module still becomes unavailable. This software change has not been checked on the physical Pi yet; the intermittent Pi network and power fault still needs separate diagnosis.

With no arm ports configured (the default), the service cannot move the arms. The explicit `WALKER_LIFT_UNSWITCHED_DEMO=1` setting can enable the lift coordinator without arm ports when a matching `motion/lift.json` is installed; this path has **not yet moved the assembled lift**. With arm ports set in its settings file, it also runs the **motion coordinator for the two SO-101 arms** ([The arms](#the-arms-motion-coordinator)), built 2026-10-24 and tested only against simulated servos. It includes taught skills (record a movement with the teaching arm, replay it, "Let go?"), also tested only against simulated servos.

## What runs where

| Where | What | How |
| --- | --- | --- |
| Pi, always (systemd) | `walker run` | One Node 22 process: buttons, serial modules, mic, speaker, obstacle cues, cloud link. Starts at boot and restarts if it stops. |
| Pi, always, optional (systemd) | `sophi-screen` | The 5-inch screen: Chromium full screen inside cage, showing a local page: the walker service's own screen page on `http://127.0.0.1:8740/`. Separate from the walker service, which never waits for it. Not yet run on the Pi; see [The screen](#the-screen). |
| Pi, once | `walker pair <code> --server <url>` | Trades the walker page's 6-digit code for a device credential, saved with mode 0600. |
| Pi, at bring-up | `walker check` | Read-only checks of everything the demo uses, one PASS / WARN / FAIL / SKIP line each ([Check the walker first](#check-the-walker-first-walker-check)). |
| Pi, when a board needs firmware | `scripts/flash-esp32.sh <module id>` | Flashes a prebuilt ESP32 image with esptool ([Flash a board from the Pi](#flash-a-board-from-the-pi)). |
| Pi, when USB GPS is connected | `walker gps --port <tty>` | Reads one checksum-verified NMEA fix locally; does not upload coordinates or enable sharing. |
| Mac | `walker simulate` | The same service with every part simulated, and a fake cloud unless `--server` is given. |
| Cloud (pieces 2 and 3) | Render web service | Pairing, heartbeats, the assistant turn, proposals. Not in this package. |
| ESP32s (piece 7) | Hand controls, ToF | Serial v1 JSON Lines over USB, spoken by the firmware in [`firmware/`](../../firmware/README.md). One hand board ran with this service on the Pi on 2026-10-23 (step 12); no obstacle board yet, and the simulator stands in for what isn't connected. |

The Pi runs one file, `dist/walker.mjs`, made by esbuild from `src/`. It has to be bundled because the shared contracts ship raw TypeScript with extensionless imports, which Node can't load directly. The bundle carries zod and the contracts inside it, so the Pi needs only Node 22. The same command builds the walker screen's page for the browser into `dist/screen-page/` (`page.js` with React, `page.css`, the Atkinson Hyperlegible Next fonts and their licence `OFL.txt`); the service serves that folder from beside `walker.mjs`.

### Inside the service

```text
GPIO buttons (gpiomon) ─┐
ESP32 hand.input ───────┼─► button events ─► Talk / Confirm ─► mic (arecord) ─► cloud turn ─► speech (Piper/espeak-ng)
simulator keyboard ─────┘                                  └─► Confirm ─► answer proposal ─► new configuration
ESP32 serial ports ─► line reader (1 KiB, parseSerialLine) ─► module manager ─► fresh zones ─► local cue policy ─► haptic.play / short sound
heartbeat every 5 s ◄─► cloud: manifest + snapshot + status events out; configuration version + open proposal back
```

- `src/service.ts`: the Talk and Confirm state machine, the heartbeat loop, offline and re-pair handling, the manifest and snapshot.
- `src/serial/`: `lineReader.ts` (JSON Lines framing), `modules.ts` (hello and `hello.request`, heartbeat, health, zones, hand buttons, `haptic.play`), `port.ts` (tty file plus `stty`, ports found under `/dev/serial/by-path`).
- `src/gps.ts`: local NMEA RMC reader for an explicitly selected USB serial GPS port, sampling for caretaker sharing or an active route (two separate flags). `src/location.ts` turns an on-demand fix into an approximate spoken place through HTTPS reverse geocoding. Neither feeds cloud snapshots.
- `src/navigation/`: walking directions ([below](#walking-directions)). `osm.ts` (the map services: the shared Nominatim limiter, the user agent, an injectable `fetch`), `places.ts` (finding a place near her), `route.ts` (the walking route and the words for each step), `navigator.ts` (following it: snapping, progress, the spoken lines, planning again, arrival), `position.ts` (the position source interface) and `simulated.ts` (the SIMULATED position).
- `src/buttons.ts`: `gpiomon` for the two Pi buttons, with a 30 ms debounce.
- `src/audio/`: clip capture (`arecord`, a WAV file, or the Mac mic behind a flag), speech out (Piper, espeak-ng, `say`), generated cue sounds.
- `src/cues.ts`: the local obstacle cue policy. `src/notices.ts`: every fixed line the Pi says on its own.
- `src/cloud/client.ts`: the cloud client interface and its HTTP version, on the walker contract's device routes.
- `src/sim/`: the fake cloud, simulated modules, and the simulator itself. `fakeMaps.ts` answers map requests from the responses recorded in `test/fixtures/navigation/`. `fakeLift.ts` is a SIMULATED lift board (a TypeScript port of the lift firmware's rules) and `liftSim.ts` the `--lift` mode.
- `src/motion/lift/`: the lift client, driven by the motion coordinator (tested against a simulated lift only); see [its README](src/motion/lift/README.md). Lift lines reach it through `src/serial/modules.ts`: the first `hello` or `lift.hello` on a port decides its parser (`liftPort.ts`).
- `src/screen/`: the walker screen. `machine.ts` picks the state (a pure `pickScreen` and a small machine with timers), `motion.ts` turns the motion coordinator's state into motion screens, `attach.ts` feeds it from the bus with every listener wrapped, `server.ts` is the local server, `page.tsx` the page it serves (`pageView.tsx` what it draws, `hold.ts` the lift's hold control). See [The walker screen's page](#the-walker-screens-page).
- `src/camera/`: the live camera for a caretaker's phone: the MJPEG splitter and Huffman tables (`jpeg.ts`), ffmpeg on demand (`capture.ts`) and the cloud loop (`link.ts`). Off unless `WALKER_CAMERA_DEVICE` is set. See [The live camera](#the-live-camera-added-2026-10-24-not-yet-run-on-the-pi-or-its-innomaker-cameras).
- `src/check/`: `walker check`. Each check is a small function over an injected command runner and file reader (`core.ts`); `system.ts` (OS, clock, power, memory, disk, the service, network, pairing), `devices.ts` (mic, speaker, voice, screen, GPIO, the stop's input), `modules.ts` (the serial boards, through the service's own `openSerialPort` and `ModuleManager`), `lift.ts` (the lift board's lines, read on those ports), `arms.ts` (the servo adapters, through the Feetech driver, PING and READ only), `cameras.ts` (`v4l2-ctl`).
- `src/constants.ts`: every timing and threshold, each labelled measured or placeholder.

## How it behaves

**Buttons (the design's button map).** GPIO and keyboard sources use the action names directly. Both ESP32s run the same firmware, so both report GPIO32 as `button: "talk"` over serial. At the Pi's serial boundary, `hand-left-*` GPIO32 events become **Confirm**; the right hand's GPIO32 events remain **Talk**. The event keeps the originating module ID so feedback buzzes on the pressed hand. This is a Pi-side mapping; no ESP32 protocol change is needed.

- **Talk:** hold to talk, release to send. A short "listening" sound plays, then the mic opens. Recording stops at 15 s even if Talk is still held. A press that leaves under 0.3 s of recorded audio sends nothing ("I didn't catch that. Hold Talk while you speak."). The ESP32 hand firmware waits for 250 ms of continuous release; after that event, the Pi keeps recording for another 900 ms. A re-press from the same hand during that grace continues one recording. A full release adds about 1.15 s from physical release to upload. Once the turn has been sent, a Talk press while waiting for the answer cancels it ("Cancelled."); a press while a reply plays starts listening again.
- **Confirm:** confirms the open proposal by its id, which the Pi learns from the turn that made it or from a heartbeat. The Pi never judges expiry by its own clock: the server answers. If the server says the proposal is closed (`409 proposal_closed`), Confirm plays the short "nothing to confirm" sound, unless the proposal came back `confirmed` (the page's Confirm won first), which counts as done. With nothing open it plays the same sound without asking, unless she has a message or a route is on: a caretaker's message still on screen (being read, or within its 20 s) is read again; otherwise a route's next instruction is said again; otherwise her newest message is read again (see below). It is ignored while Talk is recording, and a second press while the first is being answered does nothing. Voice can never confirm; the walker page's Confirm button is the other way to do it.
- **An unheard turn's proposal is declined.** If a turn ends without its reply being heard (Talk cancelled it, it timed out, or it failed), the server may still finish it and open a proposal. The next heartbeat shows that proposal (it names its `client_turn_id`), and the Pi declines it instead of leaving it for Confirm, since the person never heard what it would change. Declining after a timeout or failure, not only after a cancel, is a decision for review.
- **A lost release drops the recording.** If the button that started a recording can no longer report its release (its hand module unplugs or reboots, or `gpiomon` exits), the recording is discarded instead of being sent at 15 s: "I stopped listening because the button stopped responding."
- **In the simulator, Talk toggles:** a terminal can't see a key being released, so the first `t` starts recording and the second `t` sends.
- **Both buttons together ask for help** *(added 2026-10-24, [help design](../../docs/subsystems/help.md))*. Every handle edge goes to the help code first, before the motion coordinator's claim, so Talk and Confirm held together are a chord whatever else is happening (a press still stops a running motion at once). Both down: the `help` cue (a calm rising three-note) and "Keep holding to ask for help." on the screen; a recording that Talk press opened is dropped (no turn is sent). Still both down 2 s later: the walker asks (see below). Either let go before then: nothing is sent or said, and the screen goes back.
- **Confirm waits 250 ms when it would start something** *(changed 2026-10-24)*. A Confirm press that would answer the open proposal, send a message draft, accept a motion target, or arm or close "I'm okay" acts `HELP_CHORD_WINDOW_MS` (250 ms) after its press, and not at all if Talk goes down in that window (then it is part of a chord). A Confirm that starts nothing (reading her message again, the "nothing to confirm" sound) acts at once, so a Confirm-first chord still does that. Stopping a motion never waits. The simulator keyboard can't make a chord, so its `c` never waits. Confirm while the keyboard's Talk records is still ignored; Confirm while a held Talk records is the chord.

**Listening and speaking.** Nothing records until Talk is pressed: no wake word. The model never speaks unprompted. A reply comes back with the server's voice (Cartesia) when the server sends one, and the Pi plays it. For the Pi's own lines, including "Sophi is on." and "Nothing to confirm.", the paired Pi requests that same voice through `POST /devices/{id}/speech`; this does not create a model turn. The request has a 3 s limit; without a connection, a server voice, or valid audio, the Pi uses Piper or espeak-ng. Thus offline lines may still sound different. Each local line is queued as an event and sent with the next heartbeat, so the walker page can show everything the walker said (voice is never the only way to get it). Each event carries how long ago it was said, measured on the Pi's monotonic clock: the Pi has no battery clock, and its date jumps at the boot-time sync. The page already shows replies and Confirm results (as the turn and the proposal's state), so those aren't events.

**Her messages, read aloud** *(added 2026-10-24)*. After each heartbeat that succeeds, the walker asks the server for the newest messages a caretaker sent to her phone (`GET /devices/{id}/messages`). It reads each new one aloud once in its own voice, "Message from Maya. Dinner at six. I'll get you.", and the screen shows the words. It waits while she holds Talk or her turn is waiting, then reads after the reply, and waits while a message draft of hers waits for Confirm. What is already there when the service starts or is paired is not read out. Confirm with nothing to confirm reads the newest message again, also offline. A message the server deletes (after 24 hours, or when a phone is removed) is not read or heard again. The words never go to the walker page, a model, Cartesia or the logs (the log says `kind="message"` and its length). An older server without the route gets one warning and is asked again a minute later. Tested with fake clocks (`test/messages.test.ts`), in the simulator (`test/sim/messages.walk`, its `m` key plays a made-up message from "Maya") and against a local server and Render with two phones linked; not yet on the real Pi.

<a id="walking-directions"></a>**Walking directions** *(added 2026-10-24; [the navigation guide](../../docs/subsystems/navigation.md))*. With a position source (the USB GPS, or the SIMULATED position below), every device turn carries `navigation: {route}`, so the server can offer the two route tools; `route` is null with no route on, else a summary (the place's name, the next instruction, metres to it and to the end, minutes left, `simulated`), never coordinates.

- **"Take me to the Lake Merritt Boating Center."** When the model asks for `start_route` with her words, the Pi takes one position, searches Nominatim for the place within about 5 km (a bounded `viewbox`), and plans a walking route with OSRM's foot profile on `routing.openstreetmap.de`, all within 12 s. The tool result for the model names the place, the distance, the minutes and the first instruction. Then, once the turn's reply has finished, the Pi says its own first line: "Walking to the Lake Merritt Boating Center, about 750 meters. Head west on the path. Directions come from OpenStreetMap and may include steps or curbs." A place it can't find, no fix, no route, a route over 5 km ("That's about 7 kilometers, farther than I can guide on foot."), a map error or the 12 s limit each give a fixed line, and no route starts. `stop_route` ends the route.
- **Along the way** (`src/navigation/navigator.ts`), about once a second: her position is snapped to the route, and progress is measured along it (not a radius around each turn, so a fast walk can't skip one). Each step is said once when 40 m or less away ("In 30 meters, turn left onto Lenox Avenue.") and once at 8 m or once passed ("Turn left now."). Steps under 10 m are folded into the next; unnamed ways are "the path"; the words are built on the Pi, never copied from the router, and never say "clear" or "safe". Two positions in a row more than 30 m from the route plan again from where she is (at most every 20 s, 5 times a route): "You seem to be off the route. Finding the way again.", then the new first instruction, or "I can't find the way from here." 15 s without a position: "I've lost the GPS position. I'll keep trying." Within 15 m of the end: "You've arrived near the Lake Merritt Boating Center.", kept on screen 20 s, then the route ends. Every number is the guide's placeholder (`src/constants.ts`), not measured on a walk.
- **When it speaks.** Guidance lines are speech kind `guidance`: never sent to the page or the server as walker lines, and logged by length only. They wait while Talk is held, a turn waits, an answer or a message plays; the newest waiting line replaces an older one, and a line about a turn she has since passed is dropped. A Talk press doesn't end the route. Guidance keeps going offline: the route, the position and the lines are all on the Pi; only planning needs the internet.
- **Buttons.** Confirm with nothing else to confirm says the next instruction again (see Confirm above). The walker screen's End route and Repeat (`screenPress` on the bus) act only when they were drawn on the route's screen. Forget (a 401), unpairing and stopping the service end the route.
- **The screen.** The Navigator puts the screen's view on the bus (`navigation`, `NavigatingScreenSchema`: the instruction, the arrow, distances and the map's points, at most 200 route points). Drawing it is the walker screen's part (`src/screen/`, a separate piece).
- **Privacy.** Coordinates go only to Nominatim and the router (and to caretakers in a heartbeat when sharing is on, never a simulated position). Not to the cloud, a model or the logs: logs carry step counts and distances rounded to 10 m, never coordinates, place or street names. The route lives in memory and is gone when it ends.
- **The SIMULATED position** (`src/navigation/simulated.ts`): the real receiver has no indoor fix (2026-10-24), so `walker simulate` always uses a simulated position, and the Pi does with `WALKER_GPS_SIMULATED=1`. It starts by Lake Merritt, Oakland (37.8098, -122.2575) and, while a route is on, walks along it at 1.2 m/s times `WALKER_SIM_WALK_SPEEDUP` (default 3: about 4 minutes for the 773 m route). It is labelled everywhere: the manifest's `location.gps` part says simulated (`simulated-gps`), the route summary and screen view say `simulated`, and "Where am I?" says "Your simulated GPS puts you near 451 Lee Street, Oakland, California." It is never put in a heartbeat, even with sharing on.
- **What was tested, and how (2026-10-24).** Unit tests on fake clocks with three map responses recorded once (`test/fixtures/navigation/`: a Nominatim search for "Lake Merritt Boating Center", a reverse lookup at the simulated start, and the OSRM foot route from there): `test/navigation.test.ts` (the map services, places, routes, the Navigator), `test/navigation-service.test.ts` (the tools in the turn loop, guidance timing, Confirm, the screen's presses, the GPS sampler's flags, the simulated position, the privacy rows) and `test/navigation-walk.test.ts` (the `.walk` script on a fake clock). `test/sim/navigation.walk` ran in the simulator in real time against the fake cloud and the recorded map services: 3 runs in a row passed on 2026-10-24 (each about 4 min 22 s: "Where am I?", the route, the Lenox Avenue turn, Confirm repeating, 50 m off the route and the new plan, the arrival, the end 20 s later, and a second route stopped with `stop_route`). **Not verified:** anything on the real Pi, a real outdoor GPS walk, the live public map services from the Pi, and a live Gemini turn choosing the route tools (the cloud piece).
**Asking for help** *(added 2026-10-24; `src/help.ts`; tested with fake clocks in `test/help.test.ts`, `test/help-motion.test.ts`, `test/help-screen.test.ts`, and in real time in the simulator, `test/sim/help-voice.walk` and `test/sim/help-chord.walk`, 3 of 3 each; not yet on the real Pi, its buttons or its panel, and not yet against the real server's help routes, which another piece builds).* Three ways in: the chord (above); her voice, when a turn's answer has `ask_for_help` (the reply, "I'll ask Maya for help in 8 seconds. Press any button to stop.", then a countdown from 8 on the screen; any handle press stops it, "Okay. I didn't ask anyone.", and that press does nothing else); or her phone (the walker shows a request made there from the poll after a heartbeat). Then:

- **Sending.** "Asking for help.", then `POST /devices/{id}/help` with one `client_help_id` kept for every try. A network error, a 10 s timeout or a 5xx: "No internet yet. I'll keep trying." once, and a try 5 s after each failure while it would start within 2 minutes of the first; then "I couldn't reach the internet, so nothing was sent. Use your phone if you can." `409 no_caretaker`: "No caretaker's phone is linked to this walker, so nothing was sent." Any other 4xx: "Something went wrong, so nothing was sent. Use your phone if you can." (a 401 also asks to pair again). Those results show 10 s.
- **Open.** "Sent to Maya's phone." Then it asks `GET /devices/{id}/help` every 2 s and after each heartbeat, and says each phone that shows it once ("It's showing on Maya's phone.", told apart by member id) and each caretaker coming once ("Maya is on the way."). While her hold, the countdown or an open request shows, help owns Confirm: the motion coordinator withdraws a pending target (a pending "Let go?" stays pending) and refuses new ones, and a proposal or message draft from a turn is declined. A lone Confirm arms "Press Confirm again to tell Maya you're okay." for 30 s; a second closes it (`POST …/okay`): "Okay. Maya will see that you're okay." If that doesn't get through: "I couldn't reach the internet. Press Confirm twice to try again." A close seen in a poll is said once and shown 10 s, only for a request this run saw open: "Maya says they're with you.", "Your request for help has ended." or her okay.
- **Older servers.** Turns carry `can_ask_for_help: true` only after a `GET /help` answered 200 in this run, because the turn request is strict. A 404 there: no poll for 60 s, and a chord gets the "Something went wrong" line.
- **Privacy.** Help lines hold caretakers' names: they are never heartbeat events (the owner's page doesn't see help), and on the Pi they are logged by length (`kind="help"`); log lines carry ids, sources and outcomes only.

**The parts it reports.** Every heartbeat's manifest lists each part the walker has, once, and nothing it doesn't: the coordinator itself as `base.walker` (`pi-coordinator`, or `sim-coordinator` under `walker simulate`, where it is marked simulated); each ESP32 module by its own id (hand controls, and the ToF sensor only from an ESP32 sensor board); the Pi's GPIO Talk and Confirm buttons as `controls.hand` (`pi-gpio-buttons`), but only when the installer has declared them wired with `WALKER_GPIO_BUTTONS=wired` (the Pi can't sense whether a button is wired, so it never guesses); and the USB mic and speaker as `voice`. Declared GPIO buttons read "ok" once `gpiomon` has watched their lines for a second; one that keeps exiting (a wrong chip name) reads unavailable. Without the declaration the Pi doesn't watch GPIO at all.

**Obstacle cues (local only).** A ToF zone under 500 mm becomes near; it clears only over 650 mm. For the current two-sensor build, a `right` zone sends the 400 ms `near_obstacle` buzz only to a healthy `hand-right-*` module, and `left` only to `hand-left-*`; other zone names retain the older all-hand cue. Each zone has its own one-second minimum gap and repeats at most every 3 s while near, so a new obstacle on the other side can buzz immediately. `sound` plays one short double beep when any zone needs a cue; separate sides can sound independently. A reading is fresh for 500 ms after the Pi receives it; a missing, stale or invalid zone is unknown, never clear, and never cues. The cloud never commands a cue: its only influence is the user-confirmed `cues` list. Every number here is a placeholder, not measured (see `src/constants.ts`). These are proximity cues, not collision avoidance.

Two decisions for review: before the Pi has fetched any configuration it gives both vibration and sound, and if vibration is chosen but a side's haptic is unavailable or its write fails, it plays the sound instead. It does not redirect a right-side warning to the left handle or vice versa. A hand board can buzz only when its health is `ok`, it declared `haptic`, and it reports neither `haptic_missing` nor `haptic_error` (the firmware's codes for a driver that didn't answer at boot or stopped answering, such as a loose wire). A reading that flickers between near and invalid repeats at most every 3 s.

**Offline.** The walker counts itself offline after 2 heartbeats fail in a row, or when a turn (or a Confirm) gets no answer within 10 s. It then says, once, a line built from its configuration and the parts it can see, for example "I'm offline right now. Your short-sound alerts still work." A Talk press while offline gets that line at once, records nothing and never reaches the model, and also triggers an immediate retry. Buttons and obstacle cues keep working. After failures, heartbeats retry at 5, 10, 15, 15 s. When a heartbeat succeeds again it says "I'm back online."

**Re-pair.** A 401 from the cloud (the walker was forgotten on the page, or the credential is unknown) puts the walker in "pair me again": it says so once, and Talk repeats it. Running `walker pair` again while the service runs is picked up on the next heartbeat tick, with no restart.

**Pairing.** A code works once, and a free Render server can take about a minute to wake, so `walker pair` first says "Waking the server…" and calls `GET /api/v1/health` until it answers (retrying every 2 s, for up to 90 s). Only then does it claim the code, once, never retried: if that request times out (20 s), the code may have been used, and it says to get a new one. The walker then adopts the configuration the pairing returns (versions start again at 1 for every pairing).

### The voice clip (AGENTS.md rule 9)

- **Consent:** only the presenter speaks to the walker in the demo; a card on the walker says so. Recording starts only on a Talk press and the "listening" sound.
- **What is captured:** at most 15 s of 16 kHz mono 16-bit audio, so at most 480,044 bytes (the contract caps clips at 500,000).
- **Where it goes:** only to the paired cloud server, over HTTPS (plain HTTP is refused except to this machine: `127.0.0.1`, `localhost` or `[::1]`), with the device credential. Nowhere else.
- **Retention on the Pi:** in memory only. `arecord` writes to a pipe, never a file. The raw buffer is zeroed as soon as it is encoded into the request, the rest is dropped when the turn ends, and a cancelled or too-short recording is thrown away. Clips are never logged, never queued for later and never retried offline. The cloud's own handling (in memory, deleted after the turn) is pieces 2 and 3.
- **A lost release:** a recording whose button can't report its release is discarded, never sent (see Talk above).
- **Replies on the Pi:** the server's voiced reply is piped straight into `aplay`, never written to a file. A reply the Pi synthesizes itself (Piper or espeak-ng) is written for a moment to `/run/steady-walker/speech` (systemd `RuntimeDirectory`: in memory, removed whenever the service stops) and deleted after playing; that folder is also emptied at startup. Nothing goes to the SD card. A line still playing after 90 s is stopped, and a cue player after 2 s, so one stuck player can't silence everything after it.
- **Logs:** on the Pi, the cloud's reply text is logged only by its length, because journald keeps logs much longer than the cloud's one hour. The same holds for `walker simulate --server`, which also deletes its audio folder at exit. The credential is never printed or logged.

### Haptic commands (AGENTS.md rule 8)

`haptic.play` is the only command the Pi sends to a module. Authorization: only the local cue policy (from fresh local sensor readings) and a button press on that same hand send it; no cloud or model output reaches it. User initiation: obstacle cues are automatic alerts the user chose in their configuration; a hand's Talk press buzzes it `recording` for 150 ms and its Confirm press `confirmation` or `error` for 250 ms (button feedback, whatever the obstacle cue setting; GPIO buttons have no motor). Limits: one of the four serial v1 patterns, at most 1,000 ms (the contract's placeholder), validated against the shared schema before it is written, and rate-limited by the cue policy (a reading that flickers between near and invalid still repeats at most every 3 s). At most one write is in flight per port; a cue sent while the port is busy is dropped, never queued. Cancellation and watchdog: the firmware stops a cue when its duration ends, and a newer `haptic.play` replaces it rather than queueing (serial v1 proposal; firmware is piece 7). Lost communication: the firmware guide requires it to stop the cue on USB disconnect or a watchdog reset; the Pi marks a silent module `unavailable` after 3 s and stops sending it cues.

## Run it on a Mac (simulator)

```bash
pnpm install
pnpm --filter @walker/pi bundle
node devices/pi/dist/walker.mjs simulate
```

Keys: `t` Talk, `c` Confirm, `h` both handle buttons held 2.5 s (asking for help, through the simulated hand board), `+` the fake cloud's next turn asks for help by voice, `,` Maya's (fake) phone shows the request, `.` Maya says "I'm on my way", `/` Maya says "I'm with Rose", `;` Rose's (fake) phone asks for help, `n` hand in front of the ToF, `f` nothing in front, `i` invalid readings, `x` the ToF stops responding (and `x` again brings it back), `o` network down and up, `g` network hangs (no answers) and back, `m` a fake caretaker ("Maya") sends a message (fake cloud only; made-up words), `r` the fake cloud forgets the walker (401), `p` pair again, `?` help, `q` quit. The `o` and `g` keys act on the walker's own requests, so they work against a real server too (`--server`): that is how the offline beat can be shown on a Mac.

**`--lift`** adds a SIMULATED lift board, found by the real module manager and driven by the real lift client under the real motion coordinator, with the SIMULATED arms (`--lift` turns `--arms` on): see [The lift](#the-lift-under-the-motion-coordinator) for its keys. `node devices/pi/dist/walker.mjs simulate --arms --lift --script devices/pi/test/sim/lift/01-demo-flow.walk` runs the demo flow (home, raise to the tray, the tray skill, "Let go?", fold, lower) in about 60 s, and `.../02-hold-release-stop.walk` the hold, a release, a Talk press and the stop switch in about 45 s (each passed 3 of 3 in a row in real time, 2026-10-24, after one demo run had failed on a "Let go?" bug, now fixed: E14).

- **Silent by default.** Speech is written by `say -o` into numbered `.aiff` files and cues into `.wav` files in the run's folder (printed at start). `--loud` plays them through the Mac's speakers instead.
- **The microphone is a file.** By default each recording is a generated 2-second tone. To send a spoken question, make a clip and pass it:

  ```bash
  say -o ask.aiff "What can you help me with?" && ffmpeg -i ask.aiff -ar 16000 -ac 1 -sample_fmt s16 ask.wav
  ```

  ```bash
  node devices/pi/dist/walker.mjs simulate --mic-file ask.wav
  ```

  `--mic-file` also takes a comma-separated list or a folder of clips (its `.wav` files in name order): each Talk press plays the next one, starting again after the last, so a whole beat sequence runs from one command. Each clip is read again at its press.

  `--mic mac` records the Mac's real microphone through ffmpeg instead. It records whoever is nearby and makes macOS ask for microphone permission, so no test or default run uses it.
- **The fake cloud is not the assistant.** It understands no speech; its replies are scripted lines that start "Fake cloud", and every answer is marked `answered_by: "fixed"`. It speaks the walker contract and checks what the Pi sends against it, so it exercises the Pi's pairing, heartbeats, turns, proposals and offline handling. `--server <url>` points the simulator at a real cloud instead (pair first with `walker pair <code> --server <url> --state <dir>` and pass the same `--state`); replies are then logged by length only.
- **Scripted run:** `--script devices/pi/test/sim/demo-path.walk` runs the demo path with no keyboard and exits 0 only if every step happened in order. A step can wait longer than the default 20 s with `expect <ms> <event> <text>`. `chord <ms>` holds both handle buttons of the simulated hand board for that long, then lets go; `expect help <text>` waits for the help layer (`help_hold`, `help_countdown 8`, `help open shown coming`, `help closed okay`, `none`); the help keys have names for scripts (`help-next-turn`, `help-shown`, `help-coming`, `help-with-her`, `help-phone`). `test/sim/help-voice.walk` (the demo beat by voice, about 35 s) and `test/sim/help-chord.walk` (about 40 s) passed 3 of 3 in a row in real time on 2026-10-24. With `--screen`, `expect screen <state>` waits for a walker screen state (`test/sim/screen-beats.walk`). `expect navigation <phase>` waits for the route's phase (`none` once it ends); `gps at|walk|off_route|pause|resume` moves the simulated position; `fake tool <name> [destination]` and `fake reply <text>` script the fake cloud's next answer (a script with any `fake` step starts with none of the demo's answers). `test/sim/navigation.walk` runs walking directions this way, in about 5 minutes.
- **The position and the maps are simulated.** The GPS is always the SIMULATED position (see [Walking directions](#walking-directions)). Map requests are answered from the recorded responses (offline, repeatable): a search finds only the Lake Merritt Boating Center, every reverse lookup gets the recorded address, and a route from anywhere but the recorded start is the recorded route cut where it passes nearest to her, with a straight first leg (a simulated route, not a router's). That is the default with the fake cloud. Against a real server (`--server`), scripted or not, the simulator uses the real public services, so a recorded route never reaches the real assistant as if it were planned live; `WALKER_SIM_MAPS=live` or `recorded` overrides either way (recorded against a real server is for tests only).
- **Show on screen:** `--gps` adds a SIMULATED GPS receiver (a made-up fix that is never shared) with SIMULATED weather and address samples that say so, so weather, location and `show_on_screen` questions run with no receiver and no internet. A script's `key show-weather` (or `show-location`, `show-sensors`, `show-message`, `show-parts`) makes the fake cloud's next turn ask the walker to show that view; it relays the walker's result as its reply. The walker offers the screen only while a page is connected, so open the page first: `node dist/walker.mjs simulate --screen --gps --script test/sim/show-weather.walk` with a browser on the printed address.
- **The walker screen:** `--screen` also serves the walker screen's page and prints its address, `http://127.0.0.1:8740/` (set `WALKER_SCREEN_PORT` for another). Open it in a browser window sized 800x480 to watch the screen while the keys (or a script) run the beats. The strip says "Simulator" and the obstacle line "Simulated". The fake cloud answers at once, so "One moment" only flashes; `WALKER_FAKE_TURN_MS=1500` makes it take 1.5 s per turn, closer to a real model.

### Against the real server on this Mac

The walker server (`apps/web`) runs locally with an in-memory store when `DATABASE_URL` is unset:

```bash
pnpm --filter @walker/web exec next dev --port 3008
```

Get a pairing code as the page would (the cookie jar keeps the `walker_owner` cookie for later page calls), pair, then run the simulator against it:

```bash
curl -s -c jar.txt -X POST http://localhost:3008/api/v1/walkers/pairing-codes
```

```bash
node devices/pi/dist/walker.mjs pair <code> --server http://localhost:3008 --state ./walker-state
```

```bash
node devices/pi/dist/walker.mjs simulate --server http://localhost:3008 --state ./walker-state
```

`scripts/real-server-check.sh` does all of that in one go and runs `test/sim/real-server.walk`, driving what a script can't: it plants an older configuration so the walker has to fetch one, pauses the dev server (`kill -STOP`) to take the walker offline, resumes it (`kill -CONT`), then forgets the walker (`DELETE /api/v1/walkers/{id}` with the cookie jar) for the 401. It saves the log and the page's status view before and after. Restarting the dev server instead wipes its in-memory store, so the walker's credential becomes unknown and it asks to be paired again. Turns aren't on the server yet (piece 3): a Talk press gets the fixed line "Something went wrong on the server. Please try again."

## Tests

```bash
pnpm --filter @walker/pi test
pnpm --filter @walker/pi typecheck
```

The expected results were written first, in [test/EXPECTED.md](test/EXPECTED.md); each test names the row it checks. All time comes from an injected fake clock, so no test sleeps, records the room or makes a sound. The serial tests run the shared fixtures in `packages/contracts/test/fixtures/`. The Feetech servo-bus tests (`test/feetech*.test.ts`) run golden vectors made by Feetech's Python SDK; see [src/motion/feetech/README.md](src/motion/feetech/README.md) to regenerate them.

## Set up the Pi

### Check the walker first (`walker check`)

**Run this first, every time the walker is assembled or moved.** One command tells you in well under a minute what works: one plain line per item with `PASS`, `WARN`, `FAIL` or `SKIP` and the evidence (device names, numbers), then a summary. It exits 1 if anything failed, else 0. **Written 2026-10-23 and tested only on a Mac** (fake command output, simulated boards, and a fake board on a macOS pseudo-terminal); it hasn't run on the Pi yet, so its first Pi run is itself a check of the check.

It only reads. It never moves anything, never changes a setting, never stops or starts the service, sends no haptic unless you pass `--buzz` and plays no sound unless you pass `--sound`. It does record **1 s from the mic** to see a level: the audio stays in memory, is never saved or sent, and is zeroed straight away. The credential is never printed.

**The arms, the lift and the stop are read, never commanded** (added 2026-10-24, tested only on a Mac against simulated servos and a simulated lift board). On each arm adapter the check sends only Feetech PING and READ packets: it never enables torque, writes a goal, or touches EEPROM, and a guard on the port refuses any other packet before it reaches the adapter. The lift board is sent only the `hello.request` every serial board gets, never a heartbeat, so it refuses every move while the check runs (`no_heartbeat`). The stop's input is read once as an input; the cameras are only listed.

After copying a new bundle to the Pi (step 7; the bundle installed on 2026-10-23 predates `check`):

```bash
sudo node /opt/steady-walker/walker.mjs check
```

It needs `sudo` because the settings file (`/etc/steady-walker.env`, mode 0640) and the credential (`/var/lib/steady-walker`, mode 0700) are readable only by root and the service. It reads the same settings file the service does.

**The serial boards and the arms need the service stopped.** The running service holds every serial port (today its scan opens the arm adapters too), and two programs on one port corrupt each other's reads, so with the service running the module line is `SKIP` and lists the boards the service's log says hello from since boot, and the arms line is `SKIP`. For the live check, with the button and buzz tests:

```bash
sudo systemctl stop steady-walker
sudo node /opt/steady-walker/walker.mjs check --press --buzz
sudo systemctl start steady-walker
```

| Flag | What it adds |
| --- | --- |
| `--press` | For each hand board: "Press a button on the left hand (hand-left-01) now", then waits 10 s for a press and says which button the Pi reads it as (the left hand's GPIO32 is Confirm). |
| `--buzz` | One 300 ms `recording` buzz (the Talk-press buzz) to each hand that can buzz, and its `ack`. Feel for it: an `ack` proves the board accepted it, not that the motor moved. |
| `--sound` | One short tone (the 0.2 s "listening" sound) on the speaker. |
| `--expect <ids>` | The boards the walker should have (default `hand-left-01,hand-right-01,tof-front-01`); each one missing fails. |
| `--port <tty,...>` | Check these ports instead of everything under `/dev/serial/by-path` (servo adapters are still left out). |
| `--server <url>` | Check this server's DNS and health instead of the paired one. |
| `--state <dir>`, `--env <file>` | Another state folder or settings file. |
| `--sim` | Simulated boards, a simulated lift board and two simulated arms instead of real ports (on a Mac). |

What each group checks, and the only commands it runs:

| Group | Checks | Reads with |
| --- | --- | --- |
| settings | The settings file parses as the service would read it | `/etc/steady-walker.env` |
| system | Trixie on aarch64; clock synchronized (HTTPS needs the date); no under-voltage or throttling now (fail) or since boot (warn); memory and disk (fail under 200 MB / 500 MB, warn under 500 MB / 2 GB, *placeholders*); `steady-walker` enabled and running (inactive only warns) | `/etc/os-release`, `timedatectl show`, `vcgencmd get_throttled` and `measure_temp`, `/proc/meminfo`, `df -Pk /`, `systemctl is-active` and `is-enabled` |
| network | The default route is on Ethernet (Wi-Fi warns: the venue plan is the hardline); no saved Wi-Fi connection autoconnects (one that does warns, because unplugging Ethernet for the offline beat would fail over to it; the line gives the `nmcli` command to turn it off, which the check doesn't run); DNS for the server; `GET /api/v1/health` and its time (20 s limit, *placeholder*) | `ip route show default`, `nmcli -t -f NAME,TYPE,AUTOCONNECT connection show`, DNS, HTTPS |
| pairing | The credential exists and parses (never printed); the server accepts it, through `GET /api/v1/devices/{id}/configuration`, the one device route that changes nothing on the server (it only reads the current configuration) | the state folder, HTTPS |
| audio | 1 s from `WALKER_ALSA_CAPTURE` with a nonzero level; `WALKER_ALSA_PLAYBACK` is listed; `--sound` plays the tone | `arecord` (the service's own format), `aplay -L`, `aplay` with the tone piped in |
| voice | With `WALKER_PIPER_MODEL`: the voice files exist and Piper speaks "Sophi check." into a private temp file (deleted) within 15 s (*placeholder*; 3.3 to 3.8 s measured). Piper failing with espeak-ng present only warns, since the walker falls back to it | `piper`, `espeak-ng --version` |
| arms | Runs before `serial`. The adapters named by `WALKER_ARM_LEFT_PORT`, `WALKER_ARM_RIGHT_PORT`, `WALKER_LEADER_LEFT_PORT`, `WALKER_LEADER_RIGHT_PORT` (a link that isn't in `/dev/serial/by-id` or `by-path`, or isn't there, fails); with none set, every `/dev/serial/by-id/usb-1a86_USB_Single_Serial_*` link (the CH343 bridge of the Waveshare adapter, *assumed*: our kits' board isn't read yet), with a warning to configure them. Each is opened at 1,000,000 baud; the driver's `detectEcho` (an echoing adapter warns: its bus needs `echo: true`); PING ids 1 to 6 (SO-101 joint order); then READs of model (777 expected), firmware, voltage limits, torque enable, position, voltage, temperature and status. Per joint, a warning for a missing id, torque already on, a follower under 10.5 V (`ARM_UNDERVOLTAGE_V`), above the servo's own voltage limit, over 60 °C (`ARM_TEMPERATURE_LIMIT_C`; both *placeholders* in the contract), another model, or a fault bit. No servo answering fails ("is the arm's 12 V supply on?"). Ports configured, or where a servo answered, are left out of `serial` | the driver's `openFeetechPort` (`stty`) and `FeetechBus`, PING and READ only |
| serial | Each port's board: id, type, firmware, protocol, capabilities, health and faults; two boards with one id; each expected id; for the ToF board, each zone's mm and quality over 1.2 s; `--press`, `--buzz` | the service's own `openSerialPort` and `ModuleManager` (so the same `hello.request`); `journalctl -u steady-walker -b` while the service runs |
| lift | Read on the serial ports: a board answering `lift.hello` shows its firmware, built-in limits (soft range, speed, acceleration, microsteps) and whether it was built with a stop-sense input; then its latest `lift.status` from the 1.2 s sample: state, homed and height, both switches, the stop, the driver, faults, heartbeat age. Not homed, the stop pressed or not wired, a latched fault, or the driver disabled warns; no status fails; no lift board skips | the serial check's ports; only `hello.request` is sent |
| stop | `WALKER_STOP_SENSE` (the coordinator's name): `gpio:<BCM line>` reads the line once with the pull-up: low is released (pass), high is pressed or a cut wire (warn). `not_wired` or unset warns that motion is refused outside bench mode (`WALKER_MOTION_BENCH=no-hardware-stop`); anything else fails | `gpioget` (as an input; never drives the line) |
| camera | The USB video devices `v4l2-ctl` lists (the Pi's own video blocks are left out), and each one's capture formats with sizes and the top frame rate of each: three cameras pass, any other number warns; a camera with neither MJPG nor YUYV warns. `v4l2-ctl` missing skips (`sudo apt install v4l-utils`) | `v4l2-ctl --list-devices`, `v4l2-ctl -d /dev/videoN --list-formats-ext` (only lists; nothing streams) |
| screen | An HDMI connector reports connected, with 800x480 among its modes (other modes warn); an input device reports an absolute X and Y (a touch screen; the ELECROW's touch is expected over USB) | `/sys/class/drm/*-HDMI-*/status` and `modes`, `/proc/bus/input/devices` |
| gpio | Only with `WALKER_GPIO_BUTTONS=wired`: the chip has both lines. The press test is step 3 | `gpioinfo` |

Every command has a time limit (5 s unless the table says otherwise), and so does each group as a whole: past it, the line is `FAIL` "no answer within N s" and the run carries on. `WARN` and `SKIP` never fail the run.

Example output, **illustrative**: written by hand to show the format, from what the checks print in the tests, not captured on the Pi. It shows a Pi with the service stopped, run with `--press --buzz`, before `hand-right-01` and `tof-front-01` have been flashed (and before the arm, lift, stop and camera groups existed; their lines are shown in the next example):

```text
walker check (walker-pi 0.1.0) on walker, 2026-10-24T15:02:11.204Z. Read-only; --buzz sends one short buzz per hand.
PASS  settings walker settings      from /etc/steady-walker.env: mic plughw:CARD=SF558,DEV=0, speaker default:CARD=Speaker, voice piper, GPIO buttons not declared
PASS  system   OS                   Debian GNU/Linux 13 (trixie), aarch64, Node 22.23.4
PASS  system   clock                synchronized, 2026-10-24T15:02:11Z
PASS  system   power                get_throttled 0x0 (no under-voltage or throttling since boot), 52.1 °C
PASS  system   memory               3301 MB available of 4049 MB
PASS  system   disk                 49.1 GB free of 56.8 GB on /
WARN  system   service              steady-walker is inactive, starts at boot. Start it after this check: sudo systemctl start steady-walker
PASS  network  default route        eth0 10.0.40.23 via 10.0.40.1, metric 100
WARN  network  wifi autoconnect     autoconnect on for "walker: Home": unplugging Ethernet would fail over to Wi-Fi instead of going offline (beat 6). To turn one off: sudo nmcli connection modify "<name>" connection.autoconnect no
PASS  network  dns                  steady-walker.onrender.com → 216.24.57.4, 216.24.57.252
PASS  network  server health        https://steady-walker.onrender.com/api/v1/health ok in 212 ms
PASS  pairing  credential           device 11111111-2222-4333-8444-555555555555 on https://steady-walker.onrender.com, mode 600
PASS  pairing  server accepts       configuration version 4, cues: vibration, spoken
PASS  audio    microphone           plughw:CARD=SF558,DEV=0: 1.0 s recorded, peak 431 of 32767, RMS 37
PASS  audio    speaker              default:CARD=Speaker is listed by aplay -L
SKIP  audio    test tone            pass --sound to play one short tone
PASS  voice    piper                "Sophi check." synthesized in 3.5 s with en_US-lessac-medium.onnx; espeak-ng 1.52.0 is the fallback
PASS  serial   hand-left-01         hand, firmware 0.1.0, protocol v1, health ok, can button.talk button.confirm haptic, port usb-Silicon_Labs_CP2102_USB_to_UART_Bridge_Controller_0001-if00-port0
FAIL  serial   hand-right-01        not seen on any port (not flashed yet? scripts/flash-esp32.sh hand-right-01)
FAIL  serial   tof-front-01         not seen on any port
      Press a button on the left hand (hand-left-01) now. Waiting 10 s...
PASS  serial   hand-left-01 press   pressed after 2.3 s: the board said "talk", the Pi reads it as Confirm
PASS  serial   hand-left-01 buzz    recording 300 ms accepted: feel for one buzz on that hand
PASS  screen   hdmi                 HDMI-A-1 connected, modes 800x480
PASS  screen   touch                "ELECROW Touch" (event4, USB)
SKIP  gpio     buttons              WALKER_GPIO_BUTTONS isn't wired, so the walker doesn't use the Pi's GPIO buttons
Summary: 19 pass, 2 warn, 2 fail, 2 skip, in 21.4 s.
Failed: serial hand-right-01, serial tof-front-01.
Warnings: system service, network wifi autoconnect.
```

The arm, lift, stop and camera lines, **illustrative** in the same way (the wording is what the tests print; the numbers and names are made up, not read from our servos, lift board or cameras). It shows the first run on the assembled walker: arm ports not yet set, so the adapters are found by name; one arm's wrist servo not answering; the lift just powered on; the stop not yet declared. Only one arm's joints are shown:

```text
WARN  arms     ports                not configured; found 2 likely servo adapters by name. Once you know which arm each is, set WALKER_ARM_LEFT_PORT and WALKER_ARM_RIGHT_PORT (and WALKER_LEADER_*_PORT) in /etc/steady-walker.env
WARN  arms     adapter 1            5 of 6 servos on usb-1a86_USB_Single_Serial_5A46083061-if00, role unknown, 1000000 baud, no echo, 12.1 to 12.2 V, 2 retries: wrist_roll: id 5 missing
PASS  arms     adapter 1 shoulder_pan id 1, model 777, firmware 3.10, position 2047, 12.2 V, 27 °C, torque off
...
WARN  arms     adapter 1 wrist_roll id 5 didn't answer a PING (timeout)
...
PASS  lift     lift-01              firmware 0.1.0, protocol v1, port platform-xhci-hcd.1-usb-0:2.3:1.0-port0; built-in limits 5 to 600 mm, at most 20 mm/s and 50 mm/s², 8 microsteps (320 steps/mm), top switch not measured; stop-sense input wired
WARN  lift     lift-01 status       unhomed, height unknown, top switch released, bottom switch released, stop released, driver enabled, no faults, last Pi heartbeat none (this check sends none); 24 reports in 1.2 s: not homed (normal after power-on; homing is a held move from the walker, never from this check)
WARN  stop     stop switch          not_wired (WALKER_STOP_SENSE unset): with no stop-sense input, the lift never moves, and arm motion is refused unless WALKER_MOTION_BENCH=no-hardware-stop (bench mode)
PASS  camera   count                3 USB cameras
PASS  camera   camera 1             "USB 2.0 Camera: USB Camera" on usb-xhci-hcd.0-1.1, /dev/video0: MJPG 1280x720@30 640x480@30; YUYV 1280x720@10 640x480@30
```

On the first run, once each adapter's arm is known (move one joint by hand and see which adapter's position changes), set its port in `/etc/steady-walker.env` and run the check again; from then on only the configured ports are opened.

**On a Mac:** `node devices/pi/dist/walker.mjs check --sim` runs the serial check against simulated boards and a simulated lift board, and the arms check against two simulated arms of six servos (every such line says `simulated`), and the Pi-only lines `SKIP`. `--state ./walker-state` (after `walker pair ... --state ./walker-state` against a local server, see [Against the real server on this Mac](#against-the-real-server-on-this-mac)) adds the DNS, health and pairing lines. `--port /dev/cu.SLAB_USBtoUART` checks a real board plugged into the Mac (not tried with a real board; checked with a fake board on a pseudo-terminal).

### The setup steps

The real Pi came up for the first time on the evening of 2026-10-23. Steps marked **Run 2026-10-23** were done then, and each says what it showed. Steps marked **Not yet run** are unverified: each says what to check, so a step that doesn't match can be fixed before the next one. Write what you find (device names, chip name) into `hardware/current-build.md`.

What it ran on (2026-10-23): a Raspberry Pi 5, 4 GB, on the official 27 W USB-C supply (`vcgencmd get_throttled` read `0x0`, so no undervoltage or throttling had happened), with Raspberry Pi OS Lite image "2026-10-23": Debian 13 "trixie", aarch64, NetworkManager 1.52.1, cloud-init 25.2.

**The power button.** On a stock Pi 5, one short press of the power button while it's running shuts it down cleanly (its light turns red); press it again to start. On 2026-10-23 the Pi shut down twice that way by accident while it was being handled (the journal said `systemd-logind: Power key pressed short`). So the installer now sets `HandlePowerKey=ignore` ([`systemd/logind-walker.conf`](systemd/logind-walker.conf)): a short press does nothing, and holding the button about 10 s still forces the Pi off. Set by hand that night and applied with `sudo systemctl kill -s HUP systemd-logind`. When the Pi is off, one press starts it.

**The journal is in memory on Raspberry Pi OS.** The OS ships `/usr/lib/systemd/journald.conf.d/40-rpi-volatile-storage.conf` (`Storage=volatile`), so every log vanishes at power-off, even with `/var/log/journal` present. The installer adds [`systemd/journald-walker.conf`](systemd/journald-walker.conf) as `/etc/systemd/journald.conf.d/90-walker-persistent.conf` (`Storage=persistent`), restarts journald and runs `journalctl --flush`. Set by hand on 2026-10-23: `journalctl --list-boots` then listed earlier boots, so `journalctl -b -1 -u steady-walker` can show the walker's log from before a power loss.

1. **Raspberry Pi OS.** *Run 2026-10-23.* Flash Raspberry Pi OS Lite (64-bit), for example with Raspberry Pi Imager, and set the hostname, user, SSH key and Wi-Fi (on 2026-10-23, the phone hotspot, which is banned at Cal Hacks; at the venue the Pi uses Ethernet, which needs no setting here, and more networks can be added later; see [The network](#the-network-ethernet-first-wi-fi-as-a-backup)). On this image those settings are cloud-init files on the card's `bootfs` drive (`user-data`, `network-config`, `meta-data`). Check: `cat /etc/os-release` says trixie, and `uname -m` says aarch64. Seen: trixie, aarch64.
   - **Trap: cloud-init reads those files only once per instance id.** The image's `meta-data` says `instance_id:` (underscore), which cloud-init ignores, so once the card has booted, later edits to `user-data` or `network-config` are skipped. On 2026-10-23 an SSH key added that way was never installed. To make cloud-init read the files again, add a line `instance-id: <any new value>` (hyphen) to `meta-data`.
   - **After the first login,** these were set on 2026-10-23: cloud-init turned off so it can't redo or undo later changes (`sudo touch /etc/cloud/cloud-init.disabled`; make further changes over SSH); an attempt at a persistent journal (`sudo mkdir -p /var/log/journal`, then `sudo systemctl restart systemd-journald`), which isn't enough on this OS (see "The journal is in memory" above; the installer now sets it); and Wi-Fi power saving off, in `/etc/NetworkManager/conf.d/10-walker-no-powersave.conf`:

     ```ini
     [connection]
     wifi.powersave = 2
     ```

     then `sudo systemctl restart NetworkManager`. (These are the usual commands for those settings; what was recorded that night is the resulting settings, not the exact commands.)
2. **Node 22 and tools.** *Run 2026-10-23.* Install Node 22 from NodeSource (`curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -` then `sudo apt install -y nodejs`), and the tools: `sudo apt install -y alsa-utils gpiod espeak-ng`. Check: `node --version` prints v22 or newer; `gpiomon --version` prints a version (1.6.x means `WALKER_GPIOMON=v1`, 2.x means `v2`). Seen: Node v22.23.4, `gpiomon` from libgpiod v2.2.1 (so `v2`, which is now the example settings file's default), espeak-ng 1.52.0, alsa-utils 1.2.14.
3. **Wire the two buttons.** *Not yet run.* Each momentary button goes between a GPIO pin and a ground pin; the service turns on the internal pull-up, so no resistor is needed. Talk: GPIO17 (physical pin 11) and ground (pin 9). Confirm: GPIO27 (pin 13) and ground (pin 14). Never wire a button to 5 V. Check: run `gpioinfo` and find the chip whose lines are named `GPIO17` and `GPIO27` (on current Pi 5 kernels it is `gpiochip0`; older ones called it `gpiochip4`); then `gpiomon --chip gpiochip0 --bias=pull-up --edges=both 17 27` (v2; on v1 it's `gpiomon --bias=pull-up gpiochip0 17 27`) prints a falling edge when you press and a rising edge when you let go. Press Ctrl-C to stop it. Once both buttons work, you'll declare them in step 8 with `WALKER_GPIO_BUTTONS=wired`.
4. **Plug in the USB mic and soundbar.** *Run 2026-10-23.* Go through the powered hub if the Pi's USB power budget is tight; see `hardware/current-build.md`. Check: `lsusb` lists both. Seen: the mic, an SF-558 USB gooseneck (`1b3f:0906`), and the soundbar, `5a47:5858` "USB Composite Device". Plugging the mic, the soundbar and an ESP32 board in while the Pi ran didn't by itself shut anything down (the journal shows no shutdown at those times). One hard power loss, at 23:19, came at the same moment the soundbar disappeared from USB; a knocked cable is likely but unproven.
5. **Find the ALSA names.** *Run 2026-10-23, except the two-sounds check.* `arecord -L` lists capture devices and `aplay -L` playback devices; prefer the `CARD=` names (they survive replugging). Check the mic: `arecord -D plughw:CARD=<mic>,DEV=0 -f S16_LE -r 16000 -c 1 -d 3 /tmp/test.wav && aplay -D default:CARD=<soundbar> /tmp/test.wav` plays your voice back. Then delete the test clip. Check two sounds at once: run `speaker-test -D default:CARD=<soundbar> -c 2 -t sine -l 1 &` and `aplay -D default:CARD=<soundbar> /usr/share/sounds/alsa/Front_Center.wav` together; if the second says "device busy", note it, because cues and speech would then wait for each other. Seen: the kernel names the mic's card `SF558` (no rule needed), with its `Mic` control at 87%. The soundbar's card is named `Speaker` by the installer's udev rule [`systemd/85-walker-audio.rules`](systemd/85-walker-audio.rules), keyed on its USB id; another speaker needs its own id there. So the example settings file now has `WALKER_ALSA_CAPTURE=plughw:CARD=SF558,DEV=0` and `WALKER_ALSA_PLAYBACK=default:CARD=Speaker`. A 5 s test recording peaked at about 10,100 of 32,767 (RMS about 1,000), and Max heard his voice played back. The soundbar's `PCM` control came up at 30%; the service's drop-in [`systemd/steady-walker.service.d/10-volume.conf`](systemd/steady-walker.service.d/10-volume.conf) sets it at every start: first 100%, then 75% at Max's request (it read 75% after a restart). An `amixer` command inside the udev rule didn't take effect, so the service sets the volume instead. The two-sounds-at-once check hasn't been run.
6. **Optional, a nicer voice (Piper).** *Run 2026-10-23.* Follow [Optional: the Piper voice](#optional-the-piper-voice). Without Piper, or if it fails, the walker speaks with espeak-ng. Seen: installed as written there; Max chose Piper's voice over espeak-ng by ear.
7. **Build and copy the service.** *Run 2026-10-23.* On the Mac: `pnpm --filter @walker/pi bundle`, then copy `devices/pi/dist/walker.mjs`, `devices/pi/dist/screen-page/` (beside it), `devices/pi/systemd/` and `devices/pi/scripts/` to the Pi (for example `scp -r`), keeping the folder layout. The installer copies `screen-page/` to `/opt/steady-walker/screen-page` (without it the walker runs with no screen page). For the screen, copy `devices/pi/screen/` too ([The screen](#the-screen)).
8. **Install.** *Run 2026-10-23, with the Wi-Fi part.* On the Pi: `sudo ./scripts/install-pi.sh walker.mjs` (from the copied folder). It creates the `steady` user, puts the bundle in `/opt/steady-walker`, makes `/var/lib/steady-walker` (mode 0700), installs and enables the unit, and writes `/etc/steady-walker.env` from the example if it's missing. It also installs the Wi-Fi helpers: both scripts go into `/opt/steady-walker` (with `walker-wifi-add.sh` linked into `/usr/local/sbin`), `walker-wifi.service` is installed and enabled, and `wifi.txt` is copied onto the card's boot partition if the card has none. It also installs four files from `systemd/`: the soundbar's udev name and the service's full-volume drop-in (step 5), the persistent journal, and the power button that ignores a short press (both above the steps). Those four were set by hand on 2026-10-23; the installer putting them in place hasn't been run on the Pi yet. It does not start anything. Edit `/etc/steady-walker.env` with the names from steps 3 and 5, and set `WALKER_GPIO_BUTTONS=wired` if step 3 showed both buttons working. Seen: the walker service part ran as written and installed and enabled `steady-walker`. Run again with the Wi-Fi part the same night: it installed both helpers and enabled `walker-wifi.service` and `steady-walker`, kept the existing `/etc/steady-walker.env`, and the walker was online again after a restart.
9. **Pair.** *Run 2026-10-23.* On the walker page, start pairing to get a 6-digit code (valid 10 minutes). On the Pi: `sudo -u steady WALKER_STATE_DIR=/var/lib/steady-walker node /opt/steady-walker/walker.mjs pair <code> --server https://steady-walker.onrender.com`. It first prints "Waking the server…" and can wait up to 90 s for a sleeping server. Check: it prints `Paired as device ...`, and `sudo ls -l /var/lib/steady-walker/credential.json` shows `-rw-------` owned by `steady`. Seen: "Waking the server…", then "Paired as device …".
10. **Start it.** *Run 2026-10-23, with no mic or speaker plugged in.* `sudo systemctl start steady-walker`, then `journalctl -u steady-walker -f` to watch. Check: you hear "Sophi is on.", the log shows `link state state="online"`, and the walker page shows the walker online with its parts. Seen: the log showed `link state state="online"` and Max's walker page showed the walker Online. With no speaker, every spoken line logs `warn speaker failed ... cannot find card 'Soundbar'` and the service keeps running (`systemctl show -p NRestarts steady-walker` stayed 0). Hearing "Sophi is on." is still to check. Later that night, with the mic, the soundbar and the settings from step 5 in place, the soundbar's volume read 100% after a restart (later set to 75%).
11. **Try the demo path.** *Not yet run, apart from offline and back.* Hold Talk, ask "What can you help me with?", release: a reply. Press Confirm with nothing open: the short low double beep. Unplug the Ethernet cable at the Pi's end, with any Wi-Fi backup off (see [The network](#the-network-ethernet-first-wi-fi-as-a-backup)): within about 10 s it says it's offline, and Talk gets the local line. Plug it back in: "I'm back online." Reboot the Pi: the service comes back by itself and says "Sophi is on." Seen so far: when the Pi was moved from the phone hotspot to home Wi-Fi, the service logged "I'm offline right now." and then "I'm back online." about 10 s later, by itself. After `sudo systemctl reboot` the Pi rejoined home Wi-Fi, `walker-wifi.service` ran, and the service logged `link state state="online"` by itself (no speaker was plugged in, so "Sophi is on." wasn't heard). Later that night, with Talk on the ESP32 hand board (step 12): held about 3 s asking "What can you help me with?", the log said `turn answered ms=3957 answered_by="model" voice="server"` (3.96 s from letting go to the answer arriving, from Gemini on Render with Cartesia's voice), and Max heard the reply. Not yet tried on the Pi: Confirm, the obstacle cues, the offline beat with the mic and speaker in, a reboot with them in, and the beats in order.
12. **ESP32 modules (after firmware, piece 7).** *Run 2026-10-23 with one hand board; no obstacle board.* Plug each board in and check `ls -l /dev/serial/by-path/`: each board appears under its physical USB path, and the service log shows `module said hello`. The service only listens to a module after its hello, and asks for one (`hello.request`) whenever it opens a port, so a board that kept running while the service restarted still announces itself. If a board's buttons do nothing, check the log for `hasn't said hello`: the board isn't answering `hello.request` (a firmware question for piece 7). Seen: the first hand board (`hand-left-01`, CP2102 USB bridge `10c4:ea60`): the log showed `serial port opened … simulated=false`, then `module said hello module="hand-left-01" type="hand" firmware="0.1.0" simulated=false`, and its health `ok`. Its Talk button is for now a wire from P32 touched to ground. Brushed briefly, it gave press-and-release bursts of 80 to 110 ms, each under the 0.3 s minimum, so each got "I didn't catch that. Hold Talk while you speak."; held firmly for 3 s it gave the spoken turn in step 11. Not yet checked through the Pi: the board's Confirm, and a haptic cue sent by the service (the buzz was felt only in the firmware's own bench test; see `hardware/current-build.md`). To put firmware on `hand-right-01` or `tof-front-01` from the Pi, see [Flash a board from the Pi](#flash-a-board-from-the-pi); then [`walker check --press --buzz`](#check-the-walker-first-walker-check) with the service stopped shows every board, its health, the ToF zones, a press on each hand and a buzz.

To stop it: `sudo systemctl stop steady-walker`. To keep it from starting at boot: `sudo systemctl disable steady-walker`.

### USB GPS bring-up and sharing

`walker gps` was installed on the Pi on 2026-10-24 for a USB receiver that exposes a Linux serial tty and sends NMEA RMC sentences. Later that day, the connected receiver identified as u-blox 7 (`1546:01a7`) and sent checksum-valid RMC sentences at 9600 baud, but reported **no fix** during a 10-second indoor read. A bare UART GPS board needs a USB-to-UART adapter; a USB power cable alone does not carry its data.

1. Plug the GPS in and compare `ls -l /dev/serial/by-path/` with the two existing hand-controller ports. Pick the new GPS link, not a `/dev/ttyUSB0` number (those numbers can change after reboot). If no new serial link appears, inspect `lsusb` and the receiver's USB wiring before changing software.
2. Add `WALKER_GPS_PORT=/dev/serial/by-path/<GPS link>` to `/etc/steady-walker.env` and restart `steady-walker`. A unique `/dev/serial/by-id/` link also works and survives a move between USB ports; our u-blox receiver is configured that way. This makes the ESP32 scanner skip that tty. `WALKER_GPS_BAUD` defaults to 9600; set it to the receiver's actual baud if different. Sharing remains off until the walker user turns it on from their own phone.
3. Run `sudo -u steady node /opt/steady-walker/walker.mjs gps --port /dev/serial/by-path/<GPS link> --wait 90`. It listens for at most 90 seconds and prints one receiver-reported fix to **that terminal only**, then exits. It validates each RMC checksum and the valid-fix flag. No fix means the receiver is talking but has not reported a valid position; no RMC data means check the path, NMEA mode, and baud. `--baud` defaults to 9600 as a bring-up choice, **not** a confirmed setting for this unit. Use the receiver's documented baud if different.

Try for a fix outdoors with a view of the sky. The reported coordinates do not establish navigation-grade accuracy, and GPS often fails indoors. A connected receiver appears as a GPS part in the walker's capability report; this reports hardware presence, not a satellite fix. Once the walker user enables sharing in **My walker** on their phone, the running Pi samples this port, sends a fresh fix in its heartbeat, and the server shows only the latest fix to approved caretakers. If sharing is off, the Pi closes the GPS port except for an explicit spoken location question; turning sharing off erases the saved fix. A fix older than one minute or from an offline walker is hidden. The server does not store a trail, send coordinates to the assistant, or write them to ordinary logs. While sharing is on, stop the service before running `walker gps` directly, since both processes would otherwise read the same tty.

**Spoken location, separate from caregiver sharing.** Hold right Talk and ask “Where am I?” or “What address am I near?” The cloud classifies that turn but receives no coordinates. The Pi reads the receiver for up to 20 seconds and sends one coordinate to the configured HTTPS reverse geocoder. It says “near” an address or mapped venue, not that you are inside a building. If the receiver has no fix, it asks you to try outdoors; if the map request fails, it says it could not find an address. The text and coordinates live only in process memory, though the spoken answer becomes a normal short-lived walker line/caption. The default is the public OpenStreetMap Nominatim service: it receives that coordinate, is rate-limited to one request per second on this Pi, and uses a 5-minute in-memory cache. Map attribution appears visually beside the location caption on the walker screen and web page; it is not spoken. Its [usage policy](https://operations.osmfoundation.org/policies/nominatim/) permits modest user-triggered lookups but sets a 1 request/second application-wide maximum. For more than one prototype walker, use another geocoder; set `WALKER_GEOCODER_URL` to its Nominatim-compatible HTTPS reverse endpoint and restart the service. This feature has not yet produced a real outdoor fix or a verified spoken place on the Pi.

**Spoken current weather and follow-up tools.** Hold right Talk and ask “What's the weather near me?” Gemini may request `get_weather`; the Pi reads one GPS fix and calls [Open-Meteo's forecast API](https://open-meteo.com/en/docs) over HTTPS. It returns the summary to the cloud so Gemini can answer or request another tool, such as `get_location`, in the same turn. Up to eight read-only tool calls are allowed; the Pi sends no raw coordinates to the cloud, but a location description or weather summary becomes part of the model context. Missing GPS or an API failure is reported as unavailable, not guessed. Open-Meteo's no-key API is for this noncommercial prototype and receives the coordinates; the weather answer credits it. The request does not enable caregiver sharing. A city-specific forecast or a typed page weather question is not implemented. A real multi-tool turn has not yet been checked on the Pi.

**Show it on the screen (`show_on_screen`, added 2026-10-24; tested with fakes and in the simulator only, not on the Pi).** While a page is connected to the walker screen's server, every turn request (and each tool continuation) carries `screen.views`: the views the walker can fill now (`weather` and `location` with the GPS connected, `sensors` with an obstacle-sensor module, `message` when it holds a caretaker message, `parts` always). With no page connected the field is left out, so the server never offers the tool. When the model asks for one, the Pi builds the card from its own data, puts it on the screen (under Listening, over One moment and the captions, with the answer's caption page under it; it goes 30 s after the answer has played, at a Talk press, or when a newer card replaces it) and returns a short result: `weather` and `location` use the same GPS fix and providers as `get_weather` and `get_location`, and their result is "Showing the weather on the screen: " or "Showing the nearest address on the screen: " followed by those tools' own sentence; `sensors` is every zone heard of, unknown when not freshly measured (never clear), kept current while it is up; `message` names the sender only ("Showing the newest message, from Maya, on the screen."), never the words; `parts` comes from the capability manifest. A view it can't fill shows nothing and says why ("Nothing was shown on the screen. …"). The log line has the view, whether it was shown and the time only. The design is [docs/subsystems/show-on-screen.md](../../docs/subsystems/show-on-screen.md); the screen's real card layouts are a separate piece.

**Spoken messages.** Ask right Talk to send a short message to an approved Circle caregiver. Sophi reads the recipient and exact text back; after readback and 1.5 seconds, press left Confirm to send it to their Circle phone. The draft expires 30 seconds later and is cancelled by another Talk press, disconnection or restart. This sends in-app Circle messages only, up to 30 characters; it does not send SMS. Both the walker user's phone and the caregiver's approved phone must be in the Circle. The Pi never treats a model draft alone as permission to send. This flow has not yet been exercised on the physical Pi.

### Optional: the Piper voice

Piper is a voice that runs on the Pi itself. The walker uses it for its own lines, and for a reply whenever the server sends no voice. It isn't in the installer, since the walker works without it (espeak-ng is the fallback). Run on the Pi 5 on 2026-10-23, which installed piper-tts 1.8.0 from pip:

```bash
sudo python3 -m venv /opt/piper
sudo /opt/piper/bin/pip install piper-tts
sudo ln -sf /opt/piper/bin/piper /usr/local/bin/piper
```

Then one voice (its `.onnx` file and `.onnx.json`):

```bash
sudo mkdir -p /opt/steady-walker/voices
cd /opt/steady-walker/voices && sudo /opt/piper/bin/python -m piper.download_voices en_US-lessac-medium
```

Set `WALKER_PIPER_MODEL=/opt/steady-walker/voices/en_US-lessac-medium.onnx` in `/etc/steady-walker.env` and restart the service. The service's existing call, `piper --model <voice> --output_file <file>` with the text on its input, works with this version. Check: `echo "Sophi is on." | piper --model /opt/steady-walker/voices/en_US-lessac-medium.onnx --output_file /tmp/p.wav && aplay -D default:CARD=Speaker /tmp/p.wav`, then delete `/tmp/p.wav`. Measured: 3.3 to 3.8 s per line on the Pi 5, because Piper loads the voice again for each line. A reply in the server's voice doesn't go through Piper.

### Flash a board from the Pi

`scripts/flash-esp32.sh <module id>` writes a prebuilt image onto one ESP32 plugged into the Pi, with the esptool already on the Pi in `/opt/esptool` (the one that reflashed `hand-left-01` on 2026-10-23, esptool 5.6.0). **Not yet run on the Pi**; checked on a Mac against fake `systemctl`, `fuser` and `esptool` (`test/flash-esp32.test.ts`), and dry-run against the real `hand-right-01` and `tof-front-01` images with `echo` standing in for esptool. Build the image on the Mac first ([firmware/README.md, "Build an image on a Mac, flash it from the Pi"](../../firmware/README.md#build-an-image-on-a-mac-flash-it-from-the-pi)) and copy its folder to the Pi, then, from the copied `devices/pi` folder (step 7):

```bash
sudo systemctl stop steady-walker
sudo ./scripts/flash-esp32.sh hand-right-01 --images ~/firmware
sudo node /opt/steady-walker/walker.mjs check --expect hand-left-01,hand-right-01 --press
sudo systemctl start steady-walker
```

It writes the same four files at the same addresses as the 2026-10-23 reflash (bootloader `0x1000`, partitions `0x8000`, boot_app0 `0xe000`, app `0x10000`) at 460800 baud. It refuses, without touching the board, when:

- `steady-walker` is running (it holds the ports; the script never stops it for you);
- another program has the port open (`fuser`);
- one of the four files is missing from `<images>/<module id>/`;
- `firmware.bin` doesn't contain the id (the build bakes the id in as text, so this catches a `hand-left-01` image about to go onto the right board);
- more than one board is plugged in and `--port` isn't given (it lists them; with exactly one it uses that one and says so).

It looks for esptool as `ESPTOOL`, then `/opt/esptool/bin/esptool` or `esptool.py`, then the `PATH` (the exact file name inside `/opt/esptool` isn't recorded, so this is a guess to check), and uses `write-flash` for esptool 5 or `write_flash` for esptool 4. With more than one board plugged in, `ls -l /dev/serial/by-id/` names each port by its USB serial number; `walker check` shows which id is on which port. If it can't connect, hold the board's BOOT button while it says "Connecting...".

### The live camera (added 2026-10-24; not yet run on the Pi or its InnoMaker cameras)

The walker can send one camera's picture to an approved caretaker's phone in the two-phone app, only while the walker user has camera sharing on from her own phone and only while a caretaker is watching (contract: [`packages/contracts/src/camera.ts`](../../packages/contracts/src/camera.ts)). Code: [`src/camera/`](src/camera/).

- **How it flows.** The Pi keeps one long-held request open, `GET /api/v1/devices/{id}/camera?source=…`, which the server answers at once when a caretaker starts watching (otherwise `wanted: false` after 25 s, and the Pi asks again). Only then does it start ffmpeg, which copies the camera's own MJPEG (`-f v4l2 -input_format mjpeg -c:v copy`, no re-encoding, so the Pi's CPU barely notices). Each new frame is posted to `POST /api/v1/devices/{id}/camera/frames` as `image/jpeg`, one at a time and at most 10 a second; a slow link just skips frames. When the server answers `keep_sending: false` (nobody watching, or sharing turned off), ffmpeg is stopped, so the camera is closed whenever nobody watches.
- **The frames.** `src/camera/jpeg.ts` splits ffmpeg's output into whole JPEGs by walking each frame's segments (not by searching for the end bytes), drops any over 256 KB, and adds the standard Huffman tables to a frame that has none: UVC cameras often leave them out, and browsers can't show such a frame. Only the newest frame is held, in memory; nothing is written to disk or logged but counts and exit codes.
- **Failures never reach the walker.** ffmpeg exiting while wanted is restarted after 1 s, doubling to 30 s. No frame for 5 s stops the camera and the Pi waits again. Failing posts are retried every 0.5 s for 10 s, then the camera stops. A failed wait is retried after 2 s, doubling to 30 s. A `401` stops the link until the walker is paired again (it rereads the credential every 5 s). All of these are placeholders, not measured.
- **Turn it on.** `sudo apt install ffmpeg` (the install script notes it when missing and adds the service user to `video`). Find the camera's stable link with `ls -l /dev/v4l/by-id/` (use the `-video-index0` one; `walker check` lists each camera's formats), then add `WALKER_CAMERA_DEVICE=/dev/v4l/by-id/<link>` to `/etc/steady-walker.env` and restart `steady-walker`. `WALKER_CAMERA_SIZE` (default `640x480`) and `WALKER_CAMERA_FPS` (default 15) must be a size and rate the camera offers as MJPG. `WALKER_CAMERA_DEVICE=test-pattern` sends ffmpeg's generated picture instead, which every phone labels as a test pattern, not a camera.
- **Checked on a Mac (2026-10-24), not on the Pi:** the unit tests (`test/camera.test.ts`, rows CJ, CC and CL in `test/EXPECTED.md`); the test-pattern capture with the real ffmpeg 8.1.1 (49 frames in 5 s, 20 to 23 KB each at 640 x 480, ffmpeg gone after stop); the link with that capture against a local stand-in server (39 frames posted in about 4 s, 9.98 a second, from a 15 a second source; every posted frame decodes; it stopped on `keep_sending: false`). The Huffman tables were checked against ffmpeg's own: a JPEG encoded with `-huffman default` has all four tables byte for byte the same as ours, and with its tables removed macOS ImageIO refuses it, while with ours inserted ImageIO decodes it to the same pixels as the original. **Not yet:** the v4l2 path on the Pi, the InnoMaker cameras' real MJPEG (whether they omit the tables, their sizes and rates, USB bandwidth with all three open), CPU use on the Pi, and a real phone over the venue network.

To try it on a Mac against the local web server (from "Against the real server on this Mac" above), pair as there, then add `--camera test-pattern` to the simulator:

```bash
node devices/pi/dist/walker.mjs simulate --server http://localhost:3008 --state ./walker-state --camera test-pattern
```

### The network: Ethernet first, Wi-Fi as a backup

The walker needs the internet for the assistant; its offline lines and obstacle cues work without it. The walker page is on Render at <https://sophi.work> (the same server is also at <https://steady-walker.onrender.com>, which is the address the Pi is paired to), so any computer with a browser can show it, on any network.

**At Cal Hacks: Ethernet.** Cal Hacks prohibits personal hotspots, routers and other broadcasting equipment in the venue, and says it can detect them; never unplug its access points or switches. There's a hardline switch every 3 tables: request a cable in the Cal Hacks app, then pick it up at the Hardware Checkout window. The Pi 5 has its own gigabit Ethernet port, so no adapter is needed. On Raspberry Pi OS Lite trixie, NetworkManager is expected to bring up `eth0` with DHCP by itself, with no setup; this hasn't been run on our Pi yet. Check: `nmcli device` shows `eth0` as `connected`, and `ip -4 addr show eth0` shows an address. When Ethernet and Wi-Fi are both connected, NetworkManager's default route metrics (100 for Ethernet, 600 for Wi-Fi) are expected to send traffic over Ethernet; not checked on the Pi.

**The venue Wi-Fi: a backup, kept off.** About 3,000 people share it. Use it only if Ethernet fails, and only if it has no sign-in web page and doesn't ask for a username (see "Networks that won't work" below). The Pi 5's Wi-Fi is Wi-Fi 5 on 5 GHz: it works with the venue's Wi-Fi 6 access points (which Cal Hacks says work best), but expect congestion; 2.4 GHz is only on the Mezzanine. Add it in one of the ways below, then turn its autoconnect off. With a working Wi-Fi network saved and on, unplugging Ethernet for the offline beat fails over to Wi-Fi and the walker does not go offline. The commands, not yet run on the Pi, are in the walker script's [setup B, step 3](../../docs/demo/walker-script.md#b-the-real-pi-on-the-venue-network-server-on-render).

**Reaching the Pi at the venue.** Venue networks often isolate clients from each other, so the laptop may not reach the Pi by SSH there; not yet tried. Fallbacks: the Pi's own screen with a USB keyboard (the walker is getting a 5-inch HDMI touch screen; while it shows the kiosk, Ctrl+Alt+F2 is expected to give a login prompt, not yet tried, see [The screen](#the-screen)), or plugging the laptop and the Pi into the same hardline switch (a laptop without an Ethernet port needs an adapter), which may still be isolated. Do what needs SSH, such as pairing (step 9), before the venue where you can.

**Wi-Fi.** The Pi joins any Wi-Fi network that NetworkManager has saved. There are two ways to give it one, plus a phone hotspot away from the venue:

- **From any computer, with the SD card (`wifi.txt`).** Shut the walker down (one press of the power button), take out the SD card and put it in any computer: its boot partition shows up as a drive called `bootfs`. Open `wifi.txt` there and add a block like this one (illustrative):

  ```text
  name: Venue Guest
  password: the-password
  ```

  Leave the password empty for an open network. Save, eject, put the card back and start the walker. At boot, `walker-wifi.service` runs `walker-wifi-import.sh`, which adds each new block to NetworkManager as a connection called `walker: <name>` and then replaces its password in the file with `(saved)`, so the password doesn't stay on the card. Blocks already `(saved)` are skipped, and comment lines are left alone. Each connection has `ipv4.may-fail yes` and `ipv6.method auto`, so a network that hands out only IPv4 or only IPv6 still counts as connected. Checked on the Pi on 2026-10-23 by running the script on a `wifi.txt` with two dummy networks (one WPA, one open): both were added with those settings, both password lines became `(saved)`, and a second run added nothing. Not yet checked: the service doing it at boot (no reboot test was done), or the walker joining a real network added this way. `test/wifi-import.test.ts` checks the file handling on a Mac against a fake `nmcli`.
- **Over SSH:** `sudo walker-wifi-add.sh` asks for the network's name and its password (not shown as you type) and saves it with `connection.autoconnect-priority 10`, so it's preferred over saved networks with the default priority (0) when both are in range. It wasn't part of the 2026-10-23 checks. Both ways turn autoconnect on; for a backup that should stay off, such as the venue Wi-Fi, run `sudo nmcli connection modify "walker: <name>" connection.autoconnect no` afterwards (not yet run on the Pi).
- **A phone hotspot, away from the venue only.** It's banned at Cal Hacks: personal hotspots, routers and other broadcasting equipment are prohibited there, and Cal Hacks says it can detect them. Elsewhere it's the fallback that works anywhere there's a phone signal. On an iPhone, turn on **Maximize Compatibility** (2.4 GHz, WPA2) and keep the Personal Hotspot screen open while the Pi joins; on 2026-10-23 the Pi didn't join until Maximize Compatibility was on. On that T-Mobile iPhone hotspot the Pi got an IPv4 address (172.20.10.x) and IPv6, and reached Render. A Mac on the same hotspot got no IPv4 address, because macOS honours the hotspot's "IPv6-only preferred" setting; that doesn't affect the Pi.

**Networks that won't work:** ones that need a sign-in web page first (many venue, hotel and campus guest networks), because the walker has no browser to sign in with, and enterprise networks that ask for a username (WPA2-Enterprise, such as eduroam), which these scripts don't set up. At Cal Hacks, use Ethernet there; elsewhere, a phone hotspot. No venue network has been tried yet.

### The screen

**Not yet run on the Pi.** Everything in this section was written on 2026-10-23 from the vendor's documents and the software's own documentation; none of it has been tried on our Pi or panel. Each step says what to check.

**The panel.** An ELECROW 5-inch 800x480 capacitive touch screen, model DIS05490T (Amazon B0CYKXCM8J, sold as "driver-free"). Elecrow's [user manual](https://www.elecrow.com/download/product/DIS05490T/5inch_HDMI_Display_User_Manual.pdf) shows it on a Pi 5 with two cables, both in the box: the Pi's micro-HDMI port (through the included micro-HDMI-to-HDMI adapter) to the panel's HDMI socket for the picture, and the panel's USB-C socket to a Pi USB-A port for **power and touch**; the panel also has its own power switch. Not confirmed: whether the panel reports 800x480 correctly to the Pi (its EDID), how its touch shows up in Linux (the listing says five-point touch on Windows but single-point "with Raspberry Pi running Raspbian"), its USB vendor and product ids, and how much current it draws (Elecrow's product page lists a 5 V 2 A supply; the Pi 5 on the official 27 W supply gives its USB ports 1.6 A in all). Record what you find in `hardware/current-build.md`.

**How it works.** `install-pi.sh --screen` adds a second systemd service, [`sophi-screen`](systemd/sophi-screen.service), separate from the walker service: the walker service never waits for it, and it never stops or delays the walker. It runs [cage](https://github.com/cage-kiosk/cage), a small Wayland "kiosk" compositor that shows one app full screen and nothing else, with Chromium inside it in kiosk mode (no address bar, no tabs). It runs as its own user, `sophi-screen`, so the browser can't read the walker's credential, with a login session on the first text console (tty1, which is what the panel shows) so cage may use the display and the touch panel ([`systemd/sophi-screen.pam`](systemd/sophi-screen.pam)). Chromium's profile lives in memory under `/run/sophi-screen` and is thrown away each time the service stops, so there are no first-run screens, "restore pages?" bubbles or keyring prompts; translate offers, pinch zoom and swipe-back are off. The service's main command is [`scripts/sophi-screen-wait.sh`](scripts/sophi-screen-wait.sh), which waits, for as long as it takes, for a connected screen and an answering page, then starts cage and Chromium in its place; so boot never waits for the screen, and a screen plugged in later, or a walker service that starts later, just means the page appears then. If cage or Chromium exits, the service starts again after 5 s, backing off to at most every 2 minutes if it keeps failing at once (`RestartSteps=6`, `RestartMaxDelaySec=120`). It shows only local pages: a file on the Pi, or `http://127.0.0.1`. If memory runs out, the kernel stops the browser before the walker service (`OOMScoreAdjust=800`), and the walker gets the processor first (`CPUWeight=50`). The text console never blanks (`consoleblank=0`), and neither cage nor Chromium blanks the screen or turns it off.

**The page.** The kiosk opens [`screen/placeholder.html`](screen/placeholder.html), installed as `/opt/steady-walker/screen/placeholder.html`: "Sophi", "Screen connected." and "Waiting for the walker service.", in the web app's light colours, at 88, 48 and 40 px. Every 2 s it checks whether the walker service answers on `http://127.0.0.1:8740/`, and goes there once it does ([The walker screen's page](#the-walker-screens-page)); so a browser that restarts while the walker service is down shows the placeholder, not an error page. If you change `WALKER_SCREEN_PORT`, change the address in the placeholder too. The placeholder trusts whatever answers on `127.0.0.1:8740`. **After installing the walker screen**, run `sudo ./scripts/install-screen.sh` (or `install-pi.sh --screen` again) so the kiosk gets this placeholder; an older one never moves to the walker's page. *Not yet seen on the Pi:* that the Pi's Chromium lets the `file://` placeholder check `http://127.0.0.1:8740/` and go there (it does in headless Chromium on the Mac). Rehearse it three times on the panel. To show another local page: `sudo systemctl edit sophi-screen`, add `[Service]` and `Environment=SOPHI_SCREEN_URL=<the page>`, then `sudo systemctl restart sophi-screen`.

**The display settings.** A Pi 5 on Raspberry Pi OS trixie drives HDMI with the kernel's KMS driver, which ignores the old `hdmi_group`, `hdmi_mode` and `hdmi_cvt` lines in `config.txt` (Raspberry Pi says those legacy options don't work from Bookworm on); older instructions for Elecrow's 5-inch screens use them, and their `dtoverlay=ads7846` line is for a resistive touch chip on the GPIO pins, not this panel's USB touch, so don't copy those. With KMS, the resolution is a `video=` argument in `/boot/firmware/cmdline.txt`. [`scripts/screen-display.sh`](scripts/screen-display.sh) (run by the installer) adds to that one line:

```text
video=HDMI-A-1:800x480M@60 video=HDMI-A-2:800x480M@60 consoleblank=0
```

`HDMI-A-1` is the port labelled HDMI0 on the board (next to the USB-C power socket) and `HDMI-A-2` is HDMI1. `800x480M@60` is 800x480 at 60 Hz with VESA CVT timings, the same timings Elecrow's legacy instructions ask for (`hdmi_cvt 800 480 60 6 0 0 0`). It replaces any other `video=` for those two ports and any other `consoleblank` (the old values stay in the backup), leaves every other argument alone, and records which arguments it added in `sophi-screen-added.txt` next to `cmdline.txt`, so `--remove` never takes out one you had before. It refuses, changing nothing, a `cmdline.txt` with no `root=` argument or with more than one line, since a damaged `cmdline.txt` stops the Pi booting. `config.txt` needs `dtoverlay=vc4-kms-v3d` and `disable_fw_kms_setup=1` (so the firmware doesn't pass its own `video=` from the panel's EDID), both in effect for every model (before any `[section]`, or under `[all]`); stock Raspberry Pi OS has both, so on a stock card `config.txt` isn't changed, and if the second is missing the script adds a marked block at the end. The script backs up every file it changes as `<file>.sophi-backup-<date>-<time>` in `/boot/firmware`, changes nothing on a second run, and stops without changing anything if `dtoverlay=vc4-kms-v3d` is missing. The settings apply at the next boot. The panel is mounted in landscape, so nothing is rotated.

**Touch.** The panel's touch is a USB device (HID), so the kernel's own driver reads it and cage gets it through libinput, with no driver to install. With one screen, cage maps touches onto it; no calibration is expected. If it needs one, see "Touch not working" below.

1. **Plug it in.** *Not yet run on the Pi.* Micro-HDMI into the Pi's HDMI0 port, the panel's USB-C into a Pi USB port (the included cable carries data as well as power), and the panel's power switch on. Check: `lsusb` lists a new device (write its id into `hardware/current-build.md`), and `cat /sys/class/drm/card*-HDMI-A-1/status` says `connected`.
2. **Install.** *Not yet run on the Pi.* `sudo apt install -y cage chromium curl` (on 2026-10-23, the package index of Raspberry Pi's trixie archive, `archive.raspberrypi.com/debian/dists/trixie/main/binary-arm64/Packages.gz`, listed cage 0.3.1 and Chromium 155; not installed on our Pi yet). Copy `devices/pi/screen/` along with the rest (step 7), then from the copied folder: `sudo ./scripts/install-pi.sh --screen walker.mjs`. It first checks that `/usr/bin/cage`, `/usr/bin/chromium` and `curl` are there, and stops before changing anything if not. After everything step 8 does (the walker installed and enabled), it runs [`scripts/install-screen.sh`](scripts/install-screen.sh), which sets the display settings above, creates the `sophi-screen` user (in the `video`, `render` and `input` groups), installs the PAM file, the placeholder, the wait script and the unit, and enables the unit. If that fails, the installer prints "Screen not installed: <reason>", the walker install still stands, and `sudo ./scripts/install-screen.sh` redoes just the screen once it's fixed. Without `--screen` the installer never touches display settings. Then `sudo systemctl reboot`.
3. **Check.** *Not yet run on the Pi.* After the reboot the panel shows the placeholder (how long it takes after power-on isn't measured). `systemctl status sophi-screen` says `active (running)` (it says that while it waits, too, so read the journal), and `journalctl -u sophi-screen -b` shows "Screen connected and the page answers: starting the kiosk." `systemctl show -p NRestarts sophi-screen` stays 0 over a few minutes. The walker is unaffected: `systemctl is-active steady-walker` says `active`. Touch: `sudo apt install -y libinput-tools`, then `sudo libinput list-devices` lists the panel with `Capabilities: touch` (or `pointer`, see below), and `sudo libinput debug-events` prints an event when you tap. `walker check` will report the screen too, once that change lands (another change is adding it).

**Turn it off.** `sudo systemctl disable --now sophi-screen`; the console's login prompt comes back at the next boot (or now, with `sudo systemctl start getty@tty1`). To undo the display settings: `sudo ./scripts/screen-display.sh --remove` from the copied folder, then reboot. It takes out only the arguments it recorded as added (in `/boot/firmware/sophi-screen-added.txt`) and its `config.txt` block; anything it had replaced, such as an earlier `consoleblank=600` or another `video=` mode, is not put back: copy it from the oldest `cmdline.txt.sophi-backup-*` in `/boot/firmware` by hand. With a keyboard plugged into the Pi, Ctrl+Alt+F2 is expected to give a login prompt while the screen runs, and Ctrl+Alt+F1 to go back (not yet tried).

**Troubleshooting** (none of it tried yet):

- **Black screen.** Check the panel's power switch and its USB-C cable (it's powered from USB), and that the HDMI cable is in HDMI0. Then `cat /sys/class/drm/card*-HDMI-A-*/status`. If it says `disconnected` with the panel plugged in and on, the Pi doesn't see the panel's hot-plug signal: `sudo ./scripts/screen-display.sh --force-on` makes HDMI0's entry `800x480M@60D`, which turns the output on regardless (later runs keep it), then reboot. If it says `connected`, read `journalctl -u sophi-screen -b`: "Waiting: …" says what it's waiting for, and cage's or Chromium's own errors appear there too.
- **Wrong resolution** (stretched, cut off, or "no signal" / "out of range" on the panel). Check that `cat /boot/firmware/cmdline.txt` has `video=HDMI-A-1:800x480M@60` and that `config.txt` has `disable_fw_kms_setup=1`, and remove any `hdmi_cvt`, `hdmi_group` or `hdmi_mode` lines (the script warns about them). `cat /sys/class/drm/card*-HDMI-A-1/modes` lists the modes the Pi offers for that port. If the panel refuses the 800x480 CVT mode, `sudo ./scripts/screen-display.sh --remove` and a reboot let the panel's own EDID choose; compare its `modes` list.
- **Touch not working, or touching the wrong place.** If `lsusb` shows nothing new for the panel, the USB-C cable may carry power only: use the one from the box. If `libinput list-devices` shows it as a pointer rather than touch, taps should still click, and a mouse arrow may appear: the page hides it (`cursor: none`). If touches land mirrored or rotated, give libinput a calibration matrix with a udev rule, for example (illustrative) `/etc/udev/rules.d/90-sophi-touch.rules` containing `ENV{ID_INPUT_TOUCHSCREEN}=="1", ENV{LIBINPUT_CALIBRATION_MATRIX}="-1 0 1 0 1 0"` for left and right swapped (`1 0 0 0 -1 1` swaps top and bottom; `-1 0 1 0 -1 1` turns it 180 degrees), then `sudo udevadm control --reload && sudo udevadm trigger` and `sudo systemctl restart sophi-screen`. If the panel shows up as a pointer, match it by its USB id instead of `ID_INPUT_TOUCHSCREEN`.
- **The page doesn't load.** "Waiting: the page doesn't answer yet" with a `file://` page means the file is missing: `ls -l /opt/steady-walker/screen/`. With an `http://127.0.0.1` page it means the walker service isn't serving it (yet): `systemctl status steady-walker`. "shows only local pages" means the page set with `systemctl edit` isn't a local one.

How much memory Chromium takes next to Piper on the 4 GB Pi isn't measured yet; `hardware/current-build.md` says how to measure it.

### The walker screen's page

*Written 2026-10-24 and run on a Mac only: the simulator under headless Chromium at 800x480 (test/EXPECTED.md, D14 and D15). Not yet run on the Pi or seen on the panel.*

The walker service draws its own screen: it decides which state shows, and a page it serves on `http://127.0.0.1:8740/` draws it with [`packages/walker-screen`](../../packages/walker-screen/README.md). The page decides nothing. This first piece covers the walker's own states and a caretaker's message as it is read aloud; the circle's other states (suggestions, joins, the "message waiting" notice, My screen) come with the circle feed.

| State | When | Shows |
| --- | --- | --- |
| Obstacle | A ToF zone is near (the cue policy's thresholds), and 1 s after | "Something close", the zone and distance ("Unknown" when the reading went bad), "Simulated" for a simulated sensor |
| Listening | Talk is held | "Listening", "Let go of Talk when you're done." |
| One moment | Talk is let go and the answer hasn't come | "One moment", "Your question is with Sophi." Nothing moves |
| Answering | The reply is playing, and 3 s after | The reply as captions, paged at her text size; "You said: …" when the server transcribed her; who answered (Gemini, the fixed replies, or the walker's own offline line) |
| Sophi's offer | Today's model offer is open | "Short sounds?", "Alerts: short sounds", Confirm lit over the left handle |
| Done | 4 s after Confirm settles the offer | "Done" and the alerts now in force, or "Nothing changed" |
| Message | A caretaker's message is being read aloud, and 20 s after (also when Confirm reads it again, offline too) | The words, "From Maya", "Press Confirm to hear it again." and "Confirm" named over the left handle |
| Asking for help *(added 2026-10-24)* | Her hold, the countdown, or a request sending, not sent (10 s), open, or closed (10 s); under her Talk turns and an obstacle, above everything below | "Keep holding" / "to ask for help."; the seconds left with "Asking for help in 8 seconds." and "Stop" over both handles; "Asking for help"; "Not sent" and why; "Sent to Maya's phone" (then "It's showing on…", "Maya is on the way") with "Press Confirm twice to say you're okay."; the close. No touch button |
| Offline / Not set up | The link is offline / unpaired or needs a re-pair | "No internet" / "Not set up yet" |
| Clock | Otherwise | The time (only once the clock has synced), the day, an optional greeting (`WALKER_SCREEN_GREETING`), the alerts in force |

The status strip says Online or Offline, the time when the clock has synced, "Simulator" under `walker simulate`, and "Bench mode" when the motion coordinator runs in bench mode (not on the simulator, whose tag takes the room). Timings are placeholders in `src/constants.ts`. No screen shows a button yet: "My screen" is hidden until the circle piece makes it do something.

**Motion on the screen** *(added 2026-10-24; tested with fake clocks, on a real socket and in headless Chromium on a Mac; not yet seen with the real coordinator driving real arms or the lift; with the coordinator and a simulated lift, the hold control is tested end to end in `test/lift-screen.test.ts`, row E11).* The screen draws the motion coordinator's state (the `motionState` bus event, 5 times a second) and decides nothing about motion. Every motion screen says "Bench mode: no hardware stop" in full when it is on.

| State | When | Shows |
| --- | --- | --- |
| Moving | A motion runs (above her own screens: it is about motors near her now) | What moves in the Pi's words ("Bring the cup", "Moving the left arm"), "Press any handle button to stop.", and "Stop" over both handles. The lift: "Keep holding", "Let go, or press a handle button, to stop.", the hold control under her finger; "Stopping" once it ramps down |
| Stopped (fault) | A motion fault is latched (same priority) | "Stopped", the fault's own sentence, "Ask a helper to clear it at the walker.", how many more; with a pending target that clears it, that target's title and "Press Confirm to go ahead." |
| Confirm target | The one pending Confirm target (after her own Talk turn) | The target's title ("Bring the cup?") and the rest of its prompt ("Park the walker and lock the brakes, then press Confirm."), "Confirm" named over the left handle and nothing to tap: only a handle press starts motion. A lift target adds the hold control, "Hold to raise" (or lower, home, move) "and press Confirm" |
| Done / Stopped / Not started | 4 s after a motion ends, matched by its command id; or after the press on a target was refused | "Done" or "Stopped" and "Holding still."; or "Not started" and the coordinator's reason ("Keep holding the lift control to move it.") |

A motion state older than 1 s shows nothing about motion (and so no hold control): the coordinator has stopped publishing, and the lift stops on its own when its heartbeats stop.

**The lift's hold control.** A 147 px button, shown only while a hold-to-run lift target (`lift.home`, `lift.move`) is pending or its motion runs held. While her finger (or Space or Enter) is on it, the page posts `{ pressed: true, at }` to `POST /screen/hold` at once and then every 50 ms, four times per `HOLD_CONTROL_REFRESH_MS` (200 ms), because the lift's lease ends for good the first time a refresh is late. It posts one `{ pressed: false }` on the first of: pointerup, pointercancel, touchend, touchcancel, blur, visibilitychange (the contract's `SCREEN_HOLD_RELEASE_EVENTS`, heard on the whole page so a release is never missed when the button moves or goes) or keyup; the control leaving the screen; the stream from the Pi dropping (at once, not 5 s later). Long-press menus and panning are off on it, so a long hold isn't cancelled by the browser. The server stamps every message with the Pi's monotonic clock on receipt and never trusts the page's `at` for freshness; it uses `at` only to drop a "still held" that a release overtook. It counts a "still held" only while a stream is open and the state it last sent shows the control, and treats a stream closing and its own shutdown as releases. Each one goes on the bus as `screenHold` (`{ pressed: true, atMono }` or `{ pressed: false, atMono, reason }`). The motion coordinator turns that into the lift's hold lease with one line (`coordinator.ts`, `start`; wired 2026-10-24):

```ts
bus.on("screenHold", (h) => (h.pressed ? lift.holdRefresh(h.atMono) : lift.holdRelease(h.atMono)));
```

`test/screen-hold-browser.test.ts` checks it in a real browser (off unless `PLAYWRIGHT_CORE` and `CHROMIUM_PATH` are set and the page is bundled): a one-second hold with the mouse sent 15 to 25 refreshes (the bound the test allows), never more than 150 ms apart, and lifting the mouse, a window blur, the page being hidden, the control going and a dropped stream each let go; passed 3 of 3 on 2026-10-24.

**How it is kept safe.** The server listens on 127.0.0.1 only. Any page in a browser on the same machine can reach 127.0.0.1, so every request must name `Host: 127.0.0.1:8740` (which stops DNS rebinding) and, when it carries an `Origin`, the page's own; the event stream and the page's POSTs (`/screen/shown`, `/screen/press`, `/screen/hold`) also need a token the service makes at each start and puts only in the page it serves (no CORS headers, so no other site can read it). The token stops other websites, not local users: any process on the same machine can fetch the page, read the token and watch the stream, captions included (her words and Sophi's replies). On the Pi that means someone already logged in to it; presses aren't acted on yet. Such a process could also send "still held" for the lift: it can never start the lift (only a handle Confirm press does) and any handle press or the hardware stop still stops it, but it could keep a running lift held after her finger left the screen. The motion contract's token readable only by the `sophi-screen` user isn't built; until it is, that is the gap. A screen that stops reading is dropped once 256 KB waits for it, and the server takes at most 32 connections. Nothing the screen does can throw into Talk, Confirm, the heartbeat or the cues: its bus listeners are wrapped, and a failure is logged once. If the port is taken or the page files are missing, the service logs one line and runs without its screen. It never logs a state, her words, a reply, the token or a request URL.

**The page.** On the Mac it drew each new state within about 100 ms of the key that caused it, usually 10 to 40 ms (D14). If the walker service stops, it shows "Waiting for the walker service." after 5 s rather than a state that may no longer be true. Every 2 s it then asks `/screen/check` whether its token is still good: if the service restarted (a new token) it reloads itself; if the stream was only refused (too many screens) or dropped, it connects again without reloading. Captions appear when the reply starts playing, and "Done" only once the new configuration is in force on the walker; if it can't be fetched, the offer simply closes.

## The arms (motion coordinator)

**Status, 2026-10-24: built and tested on a Mac against simulated STS3215 servos only. Not yet run on a real servo, adapter, Pi, stop switch or person.** The coordinator follows the motion contract ([`packages/contracts/src/motion.ts`](../../packages/contracts/src/motion.ts), [manipulation guide](../../docs/subsystems/manipulation.md)). It covers the arms: safety, calibration, named poses, teleop, **taught skills** (recording, replay and "Let go?", [below](#taught-skills-record-and-replay)) and the simulator. It also drives the lift ([below](#the-lift-under-the-motion-coordinator); its client is in `src/motion/lift/`). Every number not from the contract is a placeholder, not measured.

**The rule: motors move only while a person at the walker is acting.** Nothing but a handle Confirm press starts anything:

- **Preparing.** The terminal (`walker arms ...`, `walker motion clear`), the cloud's id-only offers of a pose or a skill (the coordinator takes them; nothing sends one yet) and, later, the screen can only *prepare* a command. The Pi also prepares its own "Let go?" after a skill ends holding. A prepared command becomes the walker's one pending Confirm target. The walker says it aloud in the Pi's own words, such as "Turn on the left arm's motors. Park the walker and lock the brakes, then press Confirm."
- **Starting.** The target runs only on a handle Confirm press at least 2 s and less than 30 s after it appeared. That button must have been seen released for the whole 2 s, with no hello, gap or loss from its hand module since. A press too early is ignored, and its 2 s starts again from its release.
- **What withdraws a target.** It is single use. A hand module's hello or loss withdraws it, and so do a Talk press, a fault, a stop, the mode leaving `ready`, and the terminal that prepared it going away (Ctrl-C).
- **Stopping.** Any Talk or Confirm press while anything moves stops it and holds; that press does nothing else. `walker motion stop` stops too.
- **The guard stops and latches a fault on:**
  - the stop-sense input reading pressed (any mode, idle or at boot);
  - the last hand control going away, or a hand module rebooting or losing a line during motion;
  - a reading older than 100 ms (that arm then gets no more goals at all);
  - goal and position more than 10° apart for 300 ms (that arm goes soft at 25% torque);
  - **a blocked joint:** while its arm is being moved, a goal more than 3° ahead of a joint moving under 3°/s, for 300 ms; or, moving or holding, a load above 80% of the joint's own torque limit for 300 ms. Both are this coordinator's rules, mapped to the contract's `feedback_divergence` and its comply reaction. Without them the 5° lead clamp hides a blocked joint from the 10° rule, and the contract's 80% overload sits above the 60% torque limit, so the joint was pushed at its limit until the deadline. (Placeholders: `STALL_*` in `coordinator.ts`.)
  - a move past its deadline;
  - a teaching arm faster than 2× the teleop limit for 200 ms, or a follower 20° behind its leader for 1 s;
  - servo temperature, supply and load limits, and the servos' own fault bits.
- **Clearing a fault.** Faults clear only with `walker motion clear --reason "..."` and a Confirm press, once the cause is gone. The reason is logged.
- **Goals.** Every goal is clamped to within 5° of the measured position, at most 2° a control step (50 Hz). The servo's own speed register is set as a second layer.
- **READ BEFORE ACT.** The coordinator never acts on what it believes a servo is doing, only on what it read from the servo.
  - **Every reading carries the control registers.** Each 50 Hz read takes, per servo, torque enable, goal, goal speed, acceleration and torque limit along with the feedback. Torque counts as on only when the latest fresh reading says so; otherwise it is unknown.
  - **Torque on reads back every write, and aborts on any mismatch:**
    1. the torque limits (acknowledged, then read back);
    2. goal = the position just read, with nonzero speed and acceleration (an unacknowledged SYNC WRITE, so read back);
    3. torque, read back with the limits.

    An abort turns that arm's torque off. So does a fault, the stop, or a handle press part-way through: the press stops it and does nothing else.
  - **Moving needs `limitsWritten`.** A pose or teleop needs torque to have written and read back its limits. A reading that shows torque off, or a torque limit other than the one written (a power loss resets both), ends that, and stops anything moving that arm. So do stale readings and a lost bus. The arm must then be turned on again from the terminal with Confirm.
  - **Holds read first.** A hold (a stop, a fault, a clear) reads the arm, then writes goal = the position just read, only to servos that read torque on. A torque off always wins: each torque off bumps a counter before it is sent, and a hold or re-read that started before it writes nothing.
  - **Each arm is read on its own.** A slow bus (retries) never makes a healthy arm's reading stale, and no goal is queued behind an arm's read that is still on the bus. A Feetech servo may turn torque on when it gets a goal, so a limp arm (calibration, or released after a fault) never gets one. A clear reads every arm before anything holds.
  - Leaders never get torque, and one that reads torque on gets it turned off.
- **Start-up check.** Before anything is written, each arm gets an echo check (the bus is reopened in echo mode if the adapter echoes), then a ping and a model check (777, STS3215) on all six servos, then one read. Servos that read torque on get goal = the measured position and the mode's torque limits, so they hold where they are. Servos that read torque off get nothing. This narrows the contract's restart rule, and `manipulation.md` says so.
- **Stopping the service.** On SIGTERM it holds every arm where it is, then closes its buses. **A follower whose torque was on stays torqued and holding, and nothing watches it any more:** no stall, divergence, temperature or stop-sense checks. Before stopping the service with an arm torqued, support the arm and turn torque off (`arms torque off` with Confirm), or switch the arms' 12 V off.
- **No broadcast** except one torque off, when an acknowledged torque off fails.
- **Bench mode** (`WALKER_MOTION_BENCH=no-hardware-stop`) is the only way to move without a wired stop. It uses the bench limits: poses 20°/s, teleop 45°/s, torque 40% (gripper 35%). It logs the moving arm's angles twice a second. It still needs Confirm for everything, and a lost hand control mid-motion still stops it.

**Files** (`src/motion/`): `coordinator.ts` (the loop, Confirm targets, commands, guards, faults, calibration, recording and replay, the published `MotionStateSchema` state on the bus as `motionState`), `arm.ts` (the start-up check and the few writes motion needs, over `feetech/`), `limits.ts` (goal ramps and clamps), `skills.ts` (the recording and replay arithmetic), `stopSense.ts` (the GPIO stop-sense input), `operator.ts` (the terminal's local socket), `cli.ts` (`walker arms`, `walker motion`), `files.ts` (calibration, pose and skill files), `settings.ts`, `handControls.ts`, `runtime.ts`. The simulator's arms are `src/sim/motionSim.ts`, and its made-up sample skill `src/sim/sampleSkill.ts`.

**Kept on the Pi** in `/var/lib/steady-walker/motion/` (0700, files 0600, no secrets and no one's words):
- `calibration-<side>-<follower|leader>.json`, each a contract `ArmCalibrationSchema`. A calibration made on another adapter (`bus_id`) isn't used.
- `poses.json`, the follower poses, each a `NamedPoseSchema`.
- `lift.json`, the lift's configuration and installation record ([The lift](#the-lift-under-the-motion-coordinator)); no file means no lift.
- `skills/<skill_id>.json` (folder 0700), each a contract `SkillSchema` whose `skill_id` is its file name, one waypoint a line. Written atomically. A file that fails the schema is listed as unable to run, never repaired.

Every file carries the motion contract's version, now **2** (2026-10-24: two new faults, and letting go allowed with a fault latched). A file written under version 1 doesn't parse, so it counts as missing and must be made again. None exists on a walker yet: the arms haven't been calibrated.

Old files are renamed `*.replaced-<time>` (or `*.removed-<time>` for a removed skill), never deleted. Recalibrating a follower sets its poses aside, since its angles change. The contract's single `MotionSetupSchema` file isn't used: it needs a `stowed` pose for each calibrated follower, which can't exist before the first calibration.

**Terminal commands** (on the Pi, as root: `sudo node /opt/steady-walker/walker.mjs arms status`, and so on). Each talks to the running service's socket. Everything but `stop` waits for a Confirm press on the walker:

```text
walker arms status
walker arms torque <on|off> [--arm left|right]
walker arms calibrate <left|right> [--leader]
walker arms pose save <name> [--arm left|right] [--title "<words the walker says>"]
walker arms pose go <name> [--arm left|right]
walker arms pose list
walker arms teleop <left|right>
walker arms record <skill-id> --title "<words the walker says>" --arm left|right [--replace] [--let-go <degrees>]
walker arms skills
walker arms skill run <skill-id>
walker arms skill rm <skill-id>
walker arms let-go [--arm left|right] [--deg <degrees>]
walker lift home
walker lift move <millimetres>
walker lift disable
walker lift status
walker motion stop
walker motion clear --reason "<why it is safe>"
walker motion status
```

The lift's commands also need someone holding the lift control on the walker's screen while it moves: letting go stops it.

**In the simulator:** `node dist/walker.mjs simulate --arms` adds four SIMULATED servo buses (two followers, two leaders) with made-up calibrations and poses (`stowed`, `ready`, `handover`), and a simulated stop switch. The simulated servos use the dangerous default, where turning torque on drives to whatever goal is in the register. Press `?` for the keys (`s` stop switch, `-` unplug the handle (it was `h` until 2026-10-24; `h` is now the help chord), `1` torque on left, then `c`, and so on). For skills: `M` then `R` (then `c`) records the left arm, `T` moves its teaching arm through a made-up pick, `3` marks a grasp, `S` ends it, `E` saves it, `X` puts an object in the left gripper (or takes it away), `b` a finger-sized blocker, `5` replays it, `N` runs a made-up sample skill (`sim_sample_handover`, titled "SIMULATED sample: hold it out"; written only into a simulator's state folder, never a taught skill). The terminal commands work against it with `--socket <state folder>/motion.sock` (a relative `--state` folder keeps the socket path under macOS's 104-byte limit). The scripts in `test/sim/motion/*.walk` and `test/sim/skills/*.walk` run there too (`simulate --arms --script ...`), and `test/motion-walk.test.ts` runs them all on a fake clock.

### Taught skills (record and replay)

A skill is a movement taught once with the teaching arm and replayed on the walker's arm after a Confirm press, such as the first demo skill, `tray_pick_handover`: take a light object from a fixed tray and hold it out. Built 2026-10-24, tested only against simulated servos (`test/sim/skills/`, `test/skills.test.ts`, rows T1 to T35).

**LETTING GO IS ALWAYS POSSIBLE.** Releasing a grasp ("Let go?", `gripper.release`) is a safety action:

- **Allowed** with a fault latched, and on an arm gone soft after a push. It is refused only when the gripper physically can't move: the stop pressed, no fresh reading, or the gripper's servo not reading torque on.
- **Gripper only, and opening only.** Which way a grasp closed is fixed once, on the first tick the gripper is 1° or more from where the grasp began; opening is the other way.
  - It opens toward the let-go angle, which may not be more closed than where the grasp began.
  - It never moves back toward closing, even if someone pulls the gripper open faster than it opens.
  - Already open at least to the let-go angle (jaws pulled open)? It ends at once and moves nothing.
  - While the direction isn't known yet (a mark that came late, the gripper not closed), an angle typed at the terminal (`--deg`) is refused; the taught one still works.
- **On a frozen arm too.** After a servo stops answering (`feedback_stale` freezes that arm), the gripper's squeeze goal stays only until the first fresh read. Then only the gripper's goal goes to where it is, and the rest of the arm stays frozen. "Let go?" then opens it, gripper only.
- **While it runs**, with a fault latched, the screen says "Letting go" (not the fault). A clear is refused (`busy`) until it ends. A deadline passed again while that fault is already latched still ends it.
- **Offered at once** by the Pi itself whenever anything ends a motion with a grasp active (a replay completing, a stop, a fault, a recording ending), and again after a fault clears.
- **A stop or a fault lets off the squeeze:** the gripper's goal goes to where it is, in case it is on a finger.
- **Not holding what was taught** (`grasp_mismatch`). During a replay, a grasping gripper more than 10° from where the skill has it, for 300 ms (placeholders), has something else in it, such as a finger. The Pi latches `grasp_mismatch` (hold), lets off the squeeze, drops that gripper to 25% torque, says why, and offers "Let go?". Opening it still takes that Confirm press.

- **Recording is teleop.** `walker arms record <id> --title "..." --arm left` prepares teleop for that arm with `record_skill_id`. The walker says "Record a movement: the left arm copies its teaching arm. Park the walker and lock the brakes, then press Confirm." It needs everything teleop needs: torque on, calibrated, the teaching arm within 10° of the arm.
  - While recording, the arm follows at most 60°/s (45°/s in bench mode), the contract's skill ceiling.
  - It samples **the walker's arm's own readings, never the teaching arm's**, every 50 Hz control tick.
  - The terminal marks the gripper: `g` + Enter just before it closes on the object (a grasp), `r` + Enter when it lets go (a release). A mark names its recording (the socket's `record.mark` needs the recording's request `id`), so another terminal can't mark it.
  - It ends on Enter at the terminal, any handle press, `walker motion stop`, or by itself at 55 s (`RECORD_MAX_MS`: the contract's 60 s less a margin for the slowing below). Each is a stop: the arm holds where it is, and if it is grasping, "Let go?" is offered.
  - **Nothing is saved** if it ends with a fault, or if the terminal goes away (Ctrl-C, a dropped SSH).
- **Saving.** Each sample is clamped into the arm's calibrated range less 2°, as teleop's goals already are, and rounded toward the inside of it. A stretch where a joint moved faster than the recording's own limit (a servo overshooting its goal, reading noise) is slowed to that limit; the path stays the same. Then it must pass the contract's `SkillSchema` and `checkSkillAgainstSetup`, or it isn't saved, with the reason.
  - It starts where the arm was at the press, with an 8° start tolerance (placeholder; the contract allows up to 10°).
  - A recording that ends grasping needs **the angle its gripper opens to** for "Let go?". The terminal asks: Enter takes where the gripper was when the grasp was marked, or type one (`--let-go` gives it up front). An angle outside the gripper's range, or one that would close it further, is asked again.
  - It never records over an existing skill without `--replace`, and then the old file is set aside.
- **Replay.** `walker arms skill run <id>`, or an id-only offer, prepares `skill.run`, worded from the skill file's own title (for a skill titled "Hand you the cup": "Hand you the cup. Park the walker and lock the brakes, then press Confirm."). Refused at once, before anyone is asked to press Confirm, when:
  - the arm isn't within the skill's start tolerance (`not_at_start`). The reason names a taught pose at its start, such as "walker arms pose go ready --arm left". The Pi doesn't move it there by itself: going to the start is its own Confirmed move.
  - torque is off or its limits weren't written by torque on (after a power loss, `torque_off`);
  - the file fails either check (`skill_invalid`, which also latches the `skill_invalid` fault). An offer of such a skill is dropped with a log line instead, and latches nothing.

  At the press the file is read again and must be exactly the one the walker asked about; a changed one is refused (`confirm_target_mismatch`).
- **Running.**
  - The arm first goes to the skill's first waypoint, and the timeline starts once every joint is within 3° of it.
  - The timeline then moves on with each control tick and doesn't wait for a lagging joint. The exception is a gripper event: there it waits until that arm is within 3° of the event's point, so a grasp never closes somewhere else. All of this is bounded by the deadline.
  - Each tick advances the timeline by the time since the last tick, capped at two control periods (40 ms). A control loop running late therefore slows the timeline, while the deadline counts real time. A loop that is late for long could end the skill with `motion_timeout`; the `BENCH loop` log lines show the slowest tick.
  - Each goal moves at most 2° a step and stays within 5° of where the joint is, at the skill's own speeds, capped at the mode's replay speed (60°/s; bench 30°/s, where a faster skill's whole timeline is stretched).
  - Any handle press stops it, and it never resumes.
  - A torque or torque limit that changes under the moving arm (a power dip) latches `torque_lost` (hold).
  - It ends **holding** the last waypoint, still squeezing. The Pi offers "Let go?" (`walker_local`): "Let go? Park the walker and lock the brakes, then press Confirm." The person takes hold of the object, then presses Confirm. Only the gripper opens, slowly (the pose speed), to the taught angle.
  - If "Let go?" expired, `walker arms let-go` asks again from the terminal.
- **A grasp** (from a `g` mark while recording, or a grasp event in a replay) holds at 30% torque (`GRIPPER_HOLD_TORQUE_PCT`). A grasp whose 30% can't be written isn't active.
  - That gripper is exempt from the divergence, stall and load rules and the teleop gap, since an object stops it, as the contract says.
  - If the arm goes soft (a push), the gripper keeps 30%.
  - The grasp ends with a release, "Let go?", or the arm's torque going off.
- **Listing and removing.** `walker arms skills` lists each skill: its title, length, grasps, whether it ends holding, and whether it would run on this walker now (or why not). `walker arms skill rm <id>` sets the file aside with no Confirm. Removing moves nothing and can only take a movement away, like `pose save`, which also changes files and not motors. It withdraws a pending target to run it, and is refused while it runs.

These choices aren't in the contract:
- refusing (rather than moving) when the arm is away from the start;
- a recording ending at 55 s, as a stop, not a `motion_timeout` fault;
- recording a grasping gripper's goal (up to 5° past the object) instead of its reading, so a replay squeezes as the teaching did;
- exempting a grasping gripper from the teleop gap;
- the `grasp_mismatch` thresholds;
- dropping offers of failing skills without a fault.

[`manipulation.md`](../../docs/subsystems/manipulation.md#taught-skills-built-2026-10-24-simulated-servos-only) lists them.

### Bench bring-up with real arms (2026-10-25 plan; nothing below has been done yet)

Two people: one at the arm, one at the terminal. The person at the arm keeps a hand on the **arms' 12 V switch**, which is the stop until the latching stop switch is wired. Do the left side completely before the right. If anything moves that shouldn't, switch the 12 V off first and read the log after (`journalctl -u steady-walker -f`).

**Gate: nobody else within the arms' reach.** The walker's user, and any bystander, stay out of the arms' reach (on a walker, that means off it) until the hardware stop (step 21) has passed **three times in a row**, idle and mid-move. Until then only the two bring-up people are near, and only the person at the switch is within reach.

**Before power**

1. **Settings.** Stop the walker service first (`sudo systemctl stop steady-walker`), so nothing opens the adapters while you look. Plug in only the left follower's adapter (USB, no 12 V yet). Find its stable name with `ls -l /dev/serial/by-id/ /dev/serial/by-path/`, then repeat for each adapter in turn. Put the names into `/etc/steady-walker.env` **before** the arms are plugged in together:

   ```text
   WALKER_ARM_LEFT_PORT=/dev/serial/by-id/<name>
   WALKER_LEADER_LEFT_PORT=/dev/serial/by-id/<name>
   WALKER_MOTION_BENCH=no-hardware-stop
   WALKER_STOP_SENSE=not_wired
   ```

   - If two adapters show one shared by-id name (as the hand boards' CP2102s do), use their by-path names instead. By-path names stay valid only while each adapter stays in the same USB socket.
   - Plug in the left hand board, which carries Confirm: nothing starts without a Confirm press.
   - Then `sudo systemctl restart steady-walker`.
2. **Support the arm.** Rest the follower in a folded pose on the bench or a stand, gripper empty, with nothing and nobody within its reach except the person at the switch.

**Power on and the start-up check**

3. **Unpowered.** With the 12 V still off, the servos can't answer. The check is retried every 3 s and logged at most every 30 s as `arm check failed ... nothing is written to it`. `arms status` says `NOT connected`.
4. **Power on.** Switch the 12 V on. Within 3 s the log shows `arm check passed arm="left follower" echo=false firmware=...`, then the startup event: `torque-off no-goals`, or `torque-on=N goals-at-present` if the servos power up with torque on. Record which, the echo result and the firmware versions. **Unverified until now:** every control tick reads, per servo, one SYNC READ of addresses 40 to 70 (31 bytes: the control registers and the feedback). If `arms status` shows no readings, or the log shows read timeouts once the check has passed, the firmware may not answer a span that long, so record it and stop. If the check fails (a missing id, model not 777), stop here: ids and wiring come first.
5. **Status.** `arms status` shows the left follower connected, `NOT calibrated`, and torque `off` (or `on`, if the servos power up with torque on: record which).
6. **Limp before torque on.** Gently move one joint by hand: with torque off it must move freely. The coordinator wrote nothing to it: start-up writes goals only to servos that read torque on, since Feetech servos are reported to turn torque on when they get a goal (`feetech/README.md` doesn't settle it). If it resists, stop: something turned torque on.

**Calibration** (torque off; the arm goes limp)

7. **Left follower.** Run `arms calibrate left`.
   - The walker says "Calibrate the left arm. Its motors turn off, so hold it. Park the walker and lock the brakes, then press Confirm." Hold the arm, wait 2 s, press Confirm on the handle.
   - Move every joint to the middle of its range, gripper half open, and press Enter. The servos' offset registers are written so the middle reads 2048. If a servo then doesn't read about 2048, the old offsets are written back and it stops: the offset convention is wrong, so record it and stop.
   - Move each joint slowly through its whole range, one at a time, and press Enter. Any joint that moved less than 20° is refused.
8. **Left leader.** Run `arms calibrate left --leader`. No Confirm is needed, because a leader never gets torque.
9. **Record.** Copy the two calibration files into `hardware/current-build.md` with the date.

**Poses** (taught by hand, torque off)

10. Move the follower by hand to each pose and save it:
    - `arms pose save stowed --arm left --title "Fold the left arm away"`
    - then `ready`, and `handover` (title "Hold it out to you").

    A pose outside the calibrated range less 2° is refused.

**First torque on, at the bench limits**

11. Support the arm where it is. Run `arms torque on --arm left`, wait 2 s, press Confirm.
    - **Expected: no motion at all.** The arm now holds at 40% torque (gripper 35%), and `arms status` shows torque `on`.
    - Any jump means goal = present failed: switch off and stop.
12. **Push test.** Push the elbow gently about 15° and hold it.
    - Within half a second the log shows `motion fault code="feedback_divergence"`, and the arm goes soft (25%) and stops resisting.
    - Check that it doesn't sag onto your hand: 25% is a placeholder that must be at least the torque that holds the arm up.
    - Then `motion clear --reason "push test"` and Confirm, and `arms torque on --arm left` and Confirm again.

**First pose**

13. **Short move, with the stop tests on this very first move.** Move the arm near `ready` by hand, or use a pose a few degrees away. Run `arms pose go ready --arm left`, wait 2 s, press Confirm. It moves at 20°/s and the log shows `BENCH motion` lines.
    - Expected: `completed`. Hand on the switch throughout.
    - Before any other move, do step 15 on this one: start it again and press Talk mid-move, then Confirm mid-move, then `motion stop` from the terminal. Each must stop it within a moment and hold.
14. **Back and forth.** Then `stowed`, then `ready`.

**Stop tests** (start a pose move each time; each must stop and hold where it is; step 15 was first done on the first move)

15. **Handle presses:**
    - a Talk press mid-move (`stopped`);
    - a Confirm press mid-move (`stopped`);
    - `motion stop` from the terminal.
16. **Hand board unplugged mid-move.** Expected: fault `hand_controls_lost`. Plug it back, `motion clear` and Confirm.
17. **Arm adapter USB unplugged mid-move.** Expected: fault `servo_bus_lost`. **Measure how far each joint went after the unplug**: the design says at most 5° and then it holds, and only the 12 V switch can make it limp now. Plug it back; it reconnects within 3 s; then `motion clear`.
18. **12 V off mid-move.** The arm goes limp, and the readings stop (`feedback_stale`). Record whether it sags. Power back on, then `motion clear`.
19. **Blocked.** Start a pose, and block one joint with a soft object (a folded towel or a foam block, never a hand first). **It must go limp within about 0.5 s:** the log shows `motion fault code="feedback_divergence" ... detail="stalled: ..."`, and the arm drops to 25% torque and stops pushing. Then `motion clear` and Confirm, and torque on again with Confirm.
    - Also lean on a *holding* joint gently: above 80% of its torque limit (32% of full torque in bench mode) for 0.3 s, it goes soft the same way (`detail="load ..."`).
    - **Check while holding still, in every pose:** if it trips with nothing touching it (its own weight takes more than 80% of the limit), record the load `arms status` shows. Raise `STALL_LOAD_FRACTION` or the torque limit only after measuring, and never above what lets it yield to a push.

**Teleop**

20. Turn torque on for the follower, and move the leader by hand to within 10° of the follower on every joint (compare them in `arms status`). Run `arms teleop left`, wait 2 s, press Confirm.
    - Move the leader slowly; the follower copies it at up to 45°/s.
    - Any handle press, or Ctrl-C at the terminal, stops it.
    - A very fast leader move (over 90°/s for 0.2 s) latches `teleop_overspeed`.

**The real stop, once it is wired**

21. Set `WALKER_STOP_SENSE=gpio:<line>`, remove `WALKER_MOTION_BENCH`, and restart.
    - Idle, press the latching stop: `stop_circuit_opened`. Release it, then `motion clear` and Confirm.
    - Then mid-move. Record what the arms do when it cuts their 12 V.

22. **Power loss without the stop.** With the arm holding (torque on, nothing moving), pull its 12 V plug for a moment and put it back.
    - Expected: `feedback_stale` while it is out. Once it answers, `arms status` shows torque `off`: the servos rebooted, and their limits reset.
    - `motion clear` and Confirm. Then a pose is refused ("That arm's motors are off") until `arms torque on` and Confirm again. No goal is written to it meanwhile.

Afterwards, write every result, measured value and surprise into `hardware/current-build.md`, with the date. In bench mode the log also shows `BENCH loop` every 5 s, with the slowest control tick and each bus's retries and timeouts: record them.

### Teach the tray task (`tray_pick_handover`), after the bench bring-up (2026-10-25 plan; not done yet)

The first demo skill: the left arm takes a light object from a fixed tray and holds it out, then lets go when the person holding it presses Confirm. Teach it only once steps 1 to 20 above have passed on the left side: both arms calibrated, the `stowed`, `ready` and `handover` poses saved, the push test, the stop tests and teleop. The gate still holds: nobody else within reach. Bench mode stays on until the real stop is wired (step 21), and the person at the arm keeps a hand on the 12 V switch.

Two people: **the teacher** moves the teaching arm. **The operator** is at the terminal and the 12 V switch, and presses the handle buttons.

**Set up**

1. **The tray.** Fix the tray where the arm reaches it comfortably from `ready`, and tape its outline and the object's spot, so both go back to the same place for every replay. Use a light object that can't break or cut, such as a plastic cup or a foam block. Weigh it. Record the tray's position and the object's weight in `hardware/current-build.md`.
2. **Start pose.** `arms torque on --arm left`, wait 2 s, Confirm. Then `arms pose go ready --arm left`, wait 2 s, Confirm. Every teaching and every replay starts from `ready`.
3. **Match the teaching arm.** Move the teaching arm by hand to within 10° of the arm on every joint (compare them in `arms status`), gripper open.

**Record**

4. `sudo node /opt/steady-walker/walker.mjs arms record tray_pick_handover --title "<the words the walker says to start it>" --arm left`.
   - The title is at most 60 characters, such as "Hand you the cup". It is what the walker says before every replay.
   - The walker says "Record a movement: the left arm copies its teaching arm. Park the walker and lock the brakes, then press Confirm." Wait 2 s, then press Confirm.
5. **Teach, slowly.** The arm follows at up to 45°/s in bench mode, and lags if the teacher is faster. Keep the whole movement under 55 s, where the recording ends by itself; 10 to 20 s is plenty.
   - Lower the teaching arm to the object on the tray.
   - **Just before the gripper touches the object**, the operator types `g` and Enter (a grasp). Late is worse than early: once it closes on the object without a grasp marked, the stall rule makes the arm go soft within about 0.3 s.
   - Close the teaching arm's gripper fully. The arm's gripper stops on the object: that is the grasp, now at 30% torque.
   - Lift, and move out to where the person will take it (near `handover`). Hold still for a moment.
   - The operator presses Enter (or any handle button). The arm holds where it is, the gripper's squeeze let off, and the walker asks "Let go?" at once (leave it for now: take the object in step 6).
6. **The let-go angle.** The terminal asks where the gripper opens to. Enter takes where it was when the grasp was marked (open, just before it closed), or type an angle (one that would close it is asked again). The terminal says "Saved tray_pick_handover: ..." with its length. Take hold of the object, wait 2 s, press Confirm on "Let go?": only the gripper opens. If "Let go?" has expired, `arms let-go` asks again.
   - If it says "Not done: not saved: ...", read why. A fault while teaching (`walker motion status`) means clear it, torque on again, and record again with `--replace`.
7. **Check it.** `arms skills` lists it as able to run, with its length and one grasp, ending holding.

**Replay**

8. **Empty first.** With no object on the tray, `arms pose go ready --arm left` and Confirm, then `arms skill run tray_pick_handover`. The walker says the title and the park prompt. Wait 2 s, then press Confirm. Watch the whole path, with a hand on the 12 V switch.
   - If it says the arm isn't where the movement starts, the reason names the pose: go there first.
   - It ends `completed` and holding, and the walker asks "Let go?": press Confirm (nothing to take).
9. **Stop tests on the replay**, before any replay with the object: start it again and press Talk mid-way, then Confirm mid-way, then `motion stop`. Each must stop it at once and hold. A stopped replay never resumes; if it had grasped, the gripper's squeeze is let off and the walker asks "Let go?" at once.
   - **The finger check** (a soft stand-in first, such as a foam block thicker than the object): put it where the object goes and replay. The gripper stops well short of where it was taught. Within about 0.3 s the walker says "The hand met something it wasn't taught to hold, so it loosened and stopped." and asks "Let go?". Confirm opens it, with the fault still latched; then `motion clear`.
10. **With the object.** Put it on its spot, go to `ready`, replay. It picks the object up and holds it out. The person takes hold of it, waits 2 s and presses Confirm on "Let go?". While it holds, read the gripper's load in `arms status`. If the object slips, record how: the 30% hold torque and the 5° squeeze are placeholders.
11. **Rehearse it three times in a row** (AGENTS.md), each from `ready` with the object on its spot. Record each run in `hardware/current-build.md`: completed or not, picked and held without slipping, the time, any fault, and the gripper's load and temperature while holding.

Only the real arms can show:
- whether the follower keeps up with the teaching arm closely enough that the recorded path picks the object again;
- whether the grasp mark's timing works for a person typing;
- how hard the 30% hold and the 5° squeeze really grip, and whether the gripper heats while holding;
- whether the 10° / 300 ms `grasp_mismatch` thresholds catch a finger without tripping on the real object;
- whether replay lands within the tray's tolerance each time (repeatability);
- how much the arm sags under the object at `handover`;
- whether its own weight trips the load rule while it holds out the object.

## The lift (under the motion coordinator)

**Status, 2026-10-24: wired into the motion coordinator and tested on a Mac against a SIMULATED lift board (`src/sim/fakeLift.ts`) and simulated servos only. It has never talked to the lift board, driver, motor or switches, and nothing about them is measured.** The lift client ([`src/motion/lift/`](src/motion/lift/README.md)) owns the lift's serial lines; the coordinator owns its Confirm targets, presses, faults and the motion state, exactly as for an arm. Expected results: [test/EXPECTED.md](test/EXPECTED.md#the-lift-under-the-motion-coordinator-added-2026-10-24-simulated-lift-and-servos-only), rows E1 to E17.

**The rule for the lift** (AGENTS.md rule 8; the contract's `lift.home`, `lift.move`, `lift.disable`):

- **Prepared** only at the terminal (`walker lift home`, `walker lift move <mm>`, `walker lift disable`), and later at the screen. It becomes the walker's one pending Confirm target, worded by the Pi ("Raise the lift to 300 mm. Park the walker and lock the brakes, then press Confirm."), and the screen shows the lift's hold control under it.
- **Started** only by a handle Confirm press on that target, and only while someone holds the hold control on the walker's screen and every fitted arm holds its `stowed` pose with its motors on. Otherwise the press is refused (`not_held`, `arms_not_stowed`), and nothing goes to the lift.
- **Held** only by the screen's hold control: the page posts "still held" every 50 ms, the Pi stamps each on receipt, and each 100 ms heartbeat names the running request only while the latest is at most 200 ms old. Letting go, an obstacle or a Talk press taking the screen, or the page losing its stream, stops it. A stopped request never resumes.
- **Stop input policy.** Normal lift motion requires both hardware stop-sense inputs. A separate, explicit two-sensor demo build may run without them only with `WALKER_MOTION_BENCH=no-hardware-stop`, `WALKER_STOP_SENSE=not_wired` and `WALKER_LIFT_UNSWITCHED_DEMO=1`. It uses a saved position estimate rather than a homing switch; a person still has to Confirm and hold the screen control. Motor direction, step scale and usable travel must be checked on the assembled lift before trying a named preset.
- **Stopped** by any handle press, `walker motion stop`, any fault (an arm's too, and a fault repeated while the lift still moves), and the stop switch (which also cuts the lift's step signal itself). `lift.stop` goes out at once on every motion.stop and every fault; a fault in the contract's FAULTS_THAT_UNHOME_LIFT also means it must home again.
- **One motion at a time.** An arm command is refused `busy` while the lift moves or ramps down (letting go excepted, which only opens a gripper), and a lift target while an arm moves.
- **Lost communication.** The coordinator's control loop is the only caller of the client's `tick`, which writes the heartbeats: if the loop stalls, or the lift's status stops for 300 ms (`lift_module_lost`), the heartbeats stop and the lift's own watchdog stops it within 300 ms.
- **Faults the lift board latched** clear only when the lift accepts `lift.clear`: `walker motion clear` clears the Pi's own faults at once and the lift's when the lift answers `cleared`.
- **Taught skills and the lift.** A skill names the lift height it was taught at (`lift_mm`): recording needs the lift homed, and a skill runs only with the lift homed and within 1 mm of that height (`lift_not_homed`, `lift_not_at_height`, whose reason gives the `walker lift move` that fixes it). A skill never moves the lift.

**The lift file**, `/var/lib/steady-walker/motion/lift.json` (0600), written by the installer, read at start. No file: no lift on this walker. A file that fails the contract's schemas: no lift either, logged. Example (illustrative: the firmware's default build settings, an installation not yet inspected):

```json
{
  "format": "sophi.lift",
  "version": 2,
  "config": { "microsteps": 8, "soft_min_mm": 5, "soft_max_mm": 600, "max_speed_mm_s": 20, "max_accel_mm_s2": 50, "top_switch_mm": null },
  "installation": { "guards_fitted": false, "drop_test": "not_done", "brake_fitted": false, "stop_cuts_lift_power": false, "driver_current_setting": null, "recorded_at": "2026-10-25T00:00:00.000Z" }
}
```

`config` must equal the configuration built into the lift board, which `lift.hello` reports (a mismatch refuses lift motion: `lift_config_mismatch`). Outside bench mode, motion is also refused until `guards_fitted` is true and `drop_test` is `passed` (or a brake is fitted). A file that isn't JSON or fails the schemas means no lift, and the log and every lift refusal say it is malformed.

**Current two-sensor demo:** [`config/lift-two-sensor-demo.json`](config/lift-two-sensor-demo.json) matches the flashed `lift_tof_demo` image: 5–710 mm, 10 mm/s, 25 mm/s², 8 configured microsteps. Channels 2 and 3 report `right` and `left`. The file records guards, brake and drop test as unverified; bench mode bypasses those installation checks only for this supervised demo. The ESP32 journals its *estimated* position in NVS, initially 5 mm as confirmed by the owner. It invalidates the estimate before a move and restores it only after stopping cleanly; an interrupted or manually moved lift needs its position re-established before further motion. Configure the three environment values in the preceding stop-input policy, install this file as `/var/lib/steady-walker/motion/lift.json` owned by `steady` with mode `0600`, and restart `steady-walker`. This configuration has not yet been deployed to the Pi or used to move the lift. Verify the actual microstep DIP pattern, up direction and distance scale with a short observed move before requesting the 605 mm preset (600 mm above ground).

**In the simulator:** `node dist/walker.mjs simulate --arms --lift` (`--lift` turns `--arms` on), without `WALKER_MOTION_BENCH`: in bench mode the lift refuses every target, as on the walker. The SIMULATED arms start folded at `stowed`; turn both on first (`1` then `c`, `2` then `c`). `l` holds the screen's control (or let go), `e` prepares homing, `u` raising to 300 mm, `d` lowering to 50 mm, each then `c`; `[` and `]` fold the left or right arm away. Fault keys: `k` stop, `y` the stop switch (the same as `s`), `w` a stuck bottom switch, `j` a cut switch harness, `v` the line from the lift lost, `a` a frozen lift board, `z` the control loop stops calling the lift, `K` clear (then `c`), `D` the lift's motor off (then `c`). With `--screen` the page's own hold control works too. The scripts: `test/sim/lift/01-demo-flow.walk` (home, raise to the tray, the tray skill, "Let go?", fold, lower) and `test/sim/lift/02-hold-release-stop.walk` (a Confirm with nothing held, a release partway, a Talk press, the stop switch and clearing).

### Bench bring-up with the real lift, after the arms (2026-10-25 plan; nothing below has been done yet)

**The lift never moves without the hardware stop, and it can't run in bench mode.** Bench mode waives the stop for the arms only; for the lift it waives just the installation checks (guards, drop test), and its lower limits apply (10 mm/s, 25 mm/s²). Homing runs at the contract's fixed 15 mm/s fast approach, above bench's 10 mm/s, and the firmware's built-in 50 mm/s² is above bench's 25, so in bench mode every lift target is refused `lift_over_limits` ("The lift's built-in speed is above this mode's limit, so it won't move."). The Pi's lift steps therefore run in normal mode: the real stop wired, guards fitted, the drop test passed. The decoupled direction and homing checks are the firmware's own, with its bench tool.

Do this only after:
- the arms' bring-up above has passed, including step 21 (the real stop wired, `WALKER_MOTION_BENCH` removed);
- the lift board's own bench steps 1 to 10 in [firmware/README.md](../../firmware/README.md#lift-board) passed with `lift_bench.py`: boot, switches, direction and homing with the motor decoupled, the drop test (its step 9) with the carriage coupled, speed and current;
- the pinch guards are fitted and checked.

Two people: one at the lift with a hand on the **lift's 12 V switch**, one at the terminal and the screen. Nobody else within reach of the carriage or the arms. Record every result in `hardware/current-build.md`.

1. **Wire the stop to the lift too.** The latching stop's second contact goes to the lift board's stop-sense input (GPIO13, built with `WALKER_LIFT_STOP_SENSE=1`), and the stop cuts the driver's PUL signal (firmware/README.md, "The stop"). Press the stop with the lift board connected: both the Pi (`stop_circuit_opened`, part `system`) and the lift (`stop_circuit_opened`, part `lift`) latch it (`walker lift status`). Release, `walker motion clear`, Confirm. The lift refuses every target until both read wired (`no_hardware_stop`).
2. **The lift file.** Write `lift.json` as above, with the configuration the board was built with, the drop test as measured (`passed`, or `failed` and a brake fitted: otherwise the lift won't move), `guards_fitted` true, the driver current as set, and no `WALKER_MOTION_BENCH`. Plug the lift board into the Pi and restart the service. The log shows `lift fitted (lift.json)`; `walker lift status` shows it connected and `NOT homed`. A `lift_config_mismatch` fault means the file and the firmware differ: fix the file, never the check. A malformed file shows `the lift is off` with the reason.
3. **The hold control and the arms.** Open the walker screen: the kiosk, or a laptop's browser at `http://127.0.0.1:8740/` through `ssh -L 8740:127.0.0.1:8740 <pi>` (untested). Turn both arms on and fold them (`walker arms pose go stowed`, with Confirm): the lift won't move otherwise.
4. **Homing, with the hold.** Hand on the lift's 12 V switch. `walker lift home`; the screen shows the hold control under "Home the lift". Press Confirm **without** holding: refused ("Keep holding the lift control to move it."), nothing moves. Hold the control and press Confirm: it approaches the bottom switch at 15 mm/s, backs off, approaches at 2 mm/s and ends homed at 5 mm. Start it again and **let go** mid-homing: it ramps down at once and the request ends `stopped`, unhomed. Then the same with a Talk press, `walker motion stop`, and the stop switch: each stops it.
5. **First move.** Hold, `walker lift move 50`, Confirm: the carriage rises 45 mm at up to 20 mm/s (normal limits, 50 mm/s²) and stops at 50 mm. Measure the real height against `walker lift status` (counted steps, not measured).
6. **Stop tests on a move.** Let go, a Talk press, a Confirm press, `walker motion stop`, the stop switch, an arm fault (unplug the handle: `hand_controls_lost`), and unplugging the lift board's USB (`lift_module_lost`, then the lift's own watchdog). Each must stop it; record how far it went after each.
7. **Then the demo heights.** Move to the tray height the skill will be taught at, and only then teach `tray_pick_handover` (it records that height).

Only the real lift can show: whether the TB6600 takes the ESP32's 3.3 V pulses; how far the carriage coasts after a release, a stop or a lost heartbeat (the 200 mm/s² ramp, the 300 ms watchdog); whether the counted height matches the measured one after many moves (lost steps); the drop test; whether the stop switch's two contacts and the end switches are wired as assumed; the motor's temperature and the current that lifts the load; and whether a person can keep the screen's hold control held comfortably for a 15 s move.

## Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `WALKER_ALSA_CAPTURE` | (required) | ALSA capture device for the mic. Ours (the SF-558): `plughw:CARD=SF558,DEV=0`. |
| `WALKER_ALSA_PLAYBACK` | (required) | ALSA playback device for the soundbar. Ours, with the udev rule: `default:CARD=Speaker`. |
| `WALKER_PIPER_MODEL` | none | Path to a Piper `.onnx` voice, such as `/opt/steady-walker/voices/en_US-lessac-medium.onnx`. Without it, espeak-ng. |
| `WALKER_GPIO_CHIP` | `gpiochip0` | The GPIO chip with the header pins (`gpioinfo`). |
| `WALKER_GPIO_TALK`, `WALKER_GPIO_CONFIRM` | `17`, `27` | BCM GPIO line numbers. |
| `WALKER_GPIOMON` | `v1` | libgpiod command-line version (`gpiomon --version`). The example settings file sets `v2`, which is what Raspberry Pi OS trixie ships (2.2.1 on 2026-10-23). |
| `WALKER_GPIO_BUTTONS` | unset | Set to `wired` once step 3 shows both buttons working. Only then does the Pi watch the GPIO buttons and report them as hand controls. |
| `WALKER_STATE_DIR` | `/var/lib/steady-walker` | Credential, configuration and cue sounds. |
| `WALKER_SERIAL_DIR` | `/dev/serial/by-path` | Where serial ports are looked for. Both CP2102 bridges report serial `0001`, so `/dev/serial/by-id` exposes only one. The Pi reads the module ID from each firmware hello. |
| `WALKER_ARM_LEFT_PORT`, `WALKER_ARM_RIGHT_PORT` | unset | The follower arms' servo adapters: a link in `/dev/serial/by-id/` (or `/dev/serial/by-path/` for adapters that share a serial number), never `/dev/ttyACM0`. Read by `walker check` today; the motion coordinator (branch `claude/motion-arms`, not merged) reads the same names. |
| `WALKER_LEADER_LEFT_PORT`, `WALKER_LEADER_RIGHT_PORT` | unset | The leader (teaching) arms' adapters, the same way. |
| `WALKER_STOP_SENSE` | `not_wired` | `gpio:<BCM line>` when the hardware stop's normally closed stop-sense contact is wired to that Pi line, else `not_wired`. Declared by the installer, never inferred. Read by `walker check` today (and by the coordinator, not merged). |
| `WALKER_GPS_PORT` | unset | Explicit USB serial path for an optional NMEA GPS receiver. The service excludes the same tty from ESP32 scanning. It samples for caregiver sharing after opt-in, or reads once for an explicit spoken location question. |
| `WALKER_CAMERA_DEVICE` | unset | The live camera: a `/dev/v4l/by-id/...-video-index0` link, or `test-pattern` for ffmpeg's generated picture. Unset: no camera link. Needs ffmpeg. See [The live camera](#the-live-camera-added-2026-10-24-not-yet-run-on-the-pi-or-its-innomaker-cameras). |
| `WALKER_CAMERA_SIZE`, `WALKER_CAMERA_FPS` | `640x480`, `15` (`10` for `test-pattern`) | What ffmpeg asks the camera for, as MJPG. Placeholders, not checked against our cameras. |
| `WALKER_GPS_BAUD` | `9600` | GPS serial baud rate. Confirm it from the receiver or bring-up command. |
| `WALKER_GEOCODER_URL` | Nominatim public reverse endpoint | Nominatim-compatible HTTPS reverse endpoint for user-initiated spoken location lookup. Set another provider before deploying more than one walker. |
| `WALKER_PLACES_URL` | `https://nominatim.openstreetmap.org/search` | Nominatim-compatible HTTPS search endpoint for `start_route` (finding the place she named). Shares the one-request-a-second limiter with the reverse lookup. |
| `WALKER_ROUTER_URL` | `https://routing.openstreetmap.de/routed-foot/route/v1/foot` | OSRM-compatible HTTPS route endpoint (foot profile); the Pi appends `/{lon},{lat};{lon},{lat}?steps=true&overview=full&geometries=geojson`. |
| `WALKER_GPS_SIMULATED` | unset | Exactly `1`: use the SIMULATED position instead of the receiver (indoor demos). Labelled Simulated everywhere and never sent in a heartbeat. `walker simulate` always uses it. |
| `WALKER_SIM_WALK_SPEEDUP` | `3` | How many times faster than 1.2 m/s the simulated position walks a route (0.1 to 50). |
| `WALKER_SIM_MAPS` | unset | `walker simulate` only: `live` (the real public map services) or `recorded` (the recorded responses). Unset: live against a real server, recorded with the fake cloud. |
| `WALKER_SCREEN_PORT` | `8740` | The walker screen page's port on 127.0.0.1 (1024 to 65535), or `off` for no screen page. Also read by `walker simulate --screen`. |
| `WALKER_SCREEN_ASSETS` | `screen-page` beside `walker.mjs` | Where the page's built files are (`/opt/steady-walker/screen-page` on the Pi). |
| `WALKER_SCREEN_GREETING` | unset | A name for "Good evening, Nan" on the clock (up to 12 characters), until the circle brings her own. |
| `WALKER_ARM_LEFT_PORT`, `WALKER_ARM_RIGHT_PORT` | unset | The follower arms' Feetech adapters, as `/dev/serial/by-id/<name>` or `/dev/serial/by-path/<name>`. Unset: no arm, and no motion at all. Set them **before** plugging an arm into a running Pi, so the ESP32 scanner never opens a servo bus. See [The arms](#the-arms-motion-coordinator). |
| `WALKER_LEADER_LEFT_PORT`, `WALKER_LEADER_RIGHT_PORT` | unset | The leader (teaching) arms' adapters, the same way. |
| `WALKER_STOP_SENSE` | `not_wired` | `gpio:<BCM line>` once the hardware stop's normally closed stop-sense contact is wired to that pin (to ground, pull-up on). `not_wired` refuses all motion unless bench mode is on. |
| `WALKER_MOTION_BENCH` | unset | Exactly `no-hardware-stop` for bench mode: the bench speed and torque limits, every motion logged, no hardware stop required. Anything else is an error that turns motion off. |
| `WALKER_MOTION_SOCKET` | `/run/steady-walker/motion.sock` | Read by `walker arms` and `walker motion` (the service puts the socket in its runtime folder). |

## Cloud link

The client ([src/cloud/client.ts](src/cloud/client.ts)) speaks the walker contract in `packages/contracts/src/walker.ts` (guide: [docs/subsystems/walker-assistant.md](../../docs/subsystems/walker-assistant.md)) and checks every response against it:

| Call | Route | Pi sends | Pi uses |
| --- | --- | --- | --- |
| Pair (CLI) | `POST /api/v1/devices/pair` | `{code, name?, service_version}` | `device_id`, `credential` (saved 0600), configuration 1 |
| Heartbeat, every 5 s | `POST /api/v1/devices/{id}/heartbeat` | `{sent_at, service_version, manifest, snapshot or null, events}` | `configuration_version` (fetch when newer), `open_proposal` |
| Configuration | `GET /api/v1/devices/{id}/configuration` | | `configuration.cues`, reported back as `device_configuration_version` |
| Turn | `POST /api/v1/devices/{id}/turns` | `{client_turn_id, input: {type: "audio", mime, data_base64, duration_ms}, snapshot}` | `turn.reply`, `speech` (played if present), `proposal` |
| Answer | `POST /api/v1/devices/{id}/proposals/{proposal_id}` | `{answer: "confirm" or "decline"}` | the proposal's state; `409 proposal_closed` carries it as it stands |
| Camera wait (only with `WALKER_CAMERA_DEVICE`) | `GET /api/v1/devices/{id}/camera?source=camera\|test_pattern` | | `wanted` (held up to 25 s by the server) |
| Camera frame | `POST /api/v1/devices/{id}/camera/frames` | the JPEG itself (`image/jpeg`, `x-walker-camera-source` header) | `keep_sending` |

A `401 unauthenticated` from any of them means "pair me again". The real server is pieces 2 and 3, deployed on Render; the simulator's fake cloud stands in for it in tests and Mac runs, so the simulator proves the Pi's side only.

## Assumptions and open questions

- **Placeholders, not measured:** module heartbeat timeout 3 s; zone freshness 500 ms; near under 500 mm, clear over 650 mm; cue repeat 3 s and minimum gap 1 s; haptic 400 ms; GPIO debounce 30 ms; shortest clip 0.3 s; heartbeat deadline 5 s; retry delays 5, 10, 15 s. All in `src/constants.ts`.
- **From the design:** heartbeat every 5 s; offline after 2 failed heartbeats or a 10 s turn; clips at most 15 s, 16 kHz mono 16-bit, at most 500,000 bytes.
- **Serial:** 115200 baud (to confirm with the firmware). One module per port. A module is known only after its hello. The Pi asks for one with `hello.request` when it opens a port, again (at most every 2 s, *placeholder*) while an unknown module keeps talking, and when a module that went silent comes back. A hello whose `seq` kept running is an answer. Any line whose `seq` went back (a hello or not, since a boot hello can be lost) is a reboot, which drops any recording that module's button started and asks for a fresh hello. Two boards flashed with the same id: whichever said hello last keeps the id (each board's reboot takes it again); the Pi ignores the other port, logs it once, and never asks it for a hello, so the two don't trade the id back and forth. The Pi's reply to a hello beyond that (protocol version, report rate) is still unspecified, so it sends none. Assumed, to confirm with the firmware: a module's `seq` starts at 0 on boot, strictly increases on the wire (two tasks must never send the same number), and never wraps during a demo.
- **Reads:** serial ports are read with blocking file reads on libuv's thread pool, so the unit sets `UV_THREADPOOL_SIZE=12`: three ESP32 boards and four arm adapters each hold a thread, with room for file work and reopened ports. Checked only through a macOS pseudo-terminal, not on a Pi.
- **GPIO:** buttons wire to ground with the internal pull-up (so pressed reads low). Pin and chip defaults are assumptions to check with `gpioinfo`.
- **Audio:** the soundbar's `default:CARD=` device mixes, so a cue can play over speech (step 5 checks it). The mic records with `arecord` in raw PCM; the Pi builds the WAV header itself.
- **The snapshot travels with each turn** (the contract asks for it), and is `null` when no obstacle sensor has said hello.
