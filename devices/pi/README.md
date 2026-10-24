# Sophi on the walker: the Raspberry Pi service

**Status, 2026-10-23.** The service is written and tested on a Mac. It runs the whole demo path end to end in **simulator mode** (simulated buttons, ToF sensor, hand module, microphone and speaker) against a **fake cloud** on the Mac. On the evening of 2026-10-24 it **ran on the real Raspberry Pi 5** for the first time: installed with `scripts/install-pi.sh`, paired with the deployed server on Render, shown Online on the walker page, and it noticed going offline and coming back by itself when the Pi changed Wi-Fi networks. Later that night (23:00 to 23:23 PDT) it ran with a real USB mic, a real USB soundbar, Piper, and the first ESP32 hand board, whose Talk wire event gave one real spoken turn, answered by Gemini on Render in about 4 s and heard through the soundbar. That was before the Pi-side change mapping the left board's GPIO32 event to Confirm; the new mapping has not been deployed or physically checked on the Pi. Not yet tried on the Pi: Confirm, the GPIO buttons, an obstacle board, a haptic cue sent by the Pi, the offline beat since then, and the demo beats in order ([Set up the Pi](#set-up-the-pi) says what each step showed). It speaks the walker contract (`packages/contracts/src/walker.ts`); see [Cloud link](#cloud-link).

Nothing in this service can move the arms or the lift. It has no motion command of any kind. The only thing it can make a module do is play one of the four fixed haptic patterns from serial v1, for at most a second.

## What runs where

| Where | What | How |
| --- | --- | --- |
| Pi, always (systemd) | `walker run` | One Node 22 process: buttons, serial modules, mic, speaker, obstacle cues, cloud link. Starts at boot and restarts if it stops. |
| Pi, always, optional (systemd) | `sophi-screen` | The 5-inch screen: Chromium full screen inside cage, showing a local page. Separate from the walker service, which never waits for it. Not yet run on the Pi; see [The screen](#the-screen). |
| Pi, once | `walker pair <code> --server <url>` | Trades the walker page's 6-digit code for a device credential, saved with mode 0600. |
| Pi, at bring-up | `walker check` | Read-only checks of everything the demo uses, one PASS / WARN / FAIL / SKIP line each ([Check the walker first](#check-the-walker-first-walker-check)). |
| Pi, when a board needs firmware | `scripts/flash-esp32.sh <module id>` | Flashes a prebuilt ESP32 image with esptool ([Flash a board from the Pi](#flash-a-board-from-the-pi)). |
| Mac | `walker simulate` | The same service with every part simulated, and a fake cloud unless `--server` is given. |
| Cloud (pieces 2 and 3) | Render web service | Pairing, heartbeats, the assistant turn, proposals. Not in this package. |
| ESP32s (piece 7) | Hand controls, ToF | Serial v1 JSON Lines over USB, spoken by the firmware in [`firmware/`](../../firmware/README.md). One hand board ran with this service on the Pi on 2026-10-24 (step 12); no obstacle board yet, and the simulator stands in for what isn't connected. |

The Pi runs one file, `dist/walker.mjs`, made by esbuild from `src/`. It has to be bundled because the shared contracts ship raw TypeScript with extensionless imports, which Node can't load directly. The bundle carries zod and the contracts inside it, so the Pi needs only Node 22.

### Inside the service

```text
GPIO buttons (gpiomon) ─┐
ESP32 hand.input ───────┼─► button events ─► Talk / Confirm ─► mic (arecord) ─► cloud turn ─► speech (Piper/espeak-ng)
simulator keyboard ─────┘                                  └─► Confirm ─► answer proposal ─► new configuration
ESP32 serial ports ─► line reader (1 KiB, parseSerialLine) ─► module manager ─► fresh zones ─► local cue policy ─► haptic.play / short sound
heartbeat every 5 s ◄─► cloud: manifest + snapshot + status events out; configuration version + open proposal back
```

- `src/service.ts`: the Talk and Confirm state machine, the heartbeat loop, offline and re-pair handling, the manifest and snapshot.
- `src/serial/`: `lineReader.ts` (JSON Lines framing), `modules.ts` (hello and `hello.request`, heartbeat, health, zones, hand buttons, `haptic.play`), `port.ts` (tty file plus `stty`, ports found under `/dev/serial/by-id`).
- `src/buttons.ts`: `gpiomon` for the two Pi buttons, with a 30 ms debounce.
- `src/audio/`: clip capture (`arecord`, a WAV file, or the Mac mic behind a flag), speech out (Piper, espeak-ng, `say`), generated cue sounds.
- `src/cues.ts`: the local obstacle cue policy. `src/notices.ts`: every fixed line the Pi says on its own.
- `src/cloud/client.ts`: the cloud client interface and its HTTP version, on the walker contract's device routes.
- `src/sim/`: the fake cloud, simulated modules, and the simulator itself.
- `src/check/`: `walker check`. Each check is a small function over an injected command runner and file reader (`core.ts`); `system.ts` (OS, clock, power, memory, disk, the service, network, pairing), `devices.ts` (mic, speaker, voice, screen, GPIO), `modules.ts` (the serial boards, through the service's own `openSerialPort` and `ModuleManager`).
- `src/constants.ts`: every timing and threshold, each labelled measured or placeholder.

## How it behaves

**Buttons (the design's button map).** GPIO and keyboard sources use the action names directly. Both ESP32s run the same firmware, so both report GPIO32 as `button: "talk"` over serial. At the Pi's serial boundary, `hand-left-*` GPIO32 events become **Confirm**; the right hand's GPIO32 events remain **Talk**. The event keeps the originating module ID so feedback buzzes on the pressed hand. This is a Pi-side mapping; no ESP32 protocol change is needed.

- **Talk:** hold to talk, release to send. A short "listening" sound plays, then the mic opens. Recording stops at 15 s even if Talk is still held. A press under 0.3 s sends nothing ("I didn't catch that. Hold Talk while you speak."). A press while waiting for the answer cancels it ("Cancelled."), and a late answer is never spoken. A press while a reply is playing stops the reply and starts listening.
- **Confirm:** confirms the open proposal by its id, which the Pi learns from the turn that made it or from a heartbeat. The Pi never judges expiry by its own clock: the server answers. If the server says the proposal is closed (`409 proposal_closed`), Confirm plays the short "nothing to confirm" sound, unless the proposal came back `confirmed` (the page's Confirm won first), which counts as done. With nothing open it plays the same sound without asking. It is ignored while Talk is recording, and a second press while the first is being answered does nothing. Voice can never confirm; the walker page's Confirm button is the other way to do it.
- **An unheard turn's proposal is declined.** If a turn ends without its reply being heard (Talk cancelled it, it timed out, or it failed), the server may still finish it and open a proposal. The next heartbeat shows that proposal (it names its `client_turn_id`), and the Pi declines it instead of leaving it for Confirm, since the person never heard what it would change. Declining after a timeout or failure, not only after a cancel, is a decision for review.
- **A lost release drops the recording.** If the button that started a recording can no longer report its release (its hand module unplugs or reboots, or `gpiomon` exits), the recording is discarded instead of being sent at 15 s: "I stopped listening because the button stopped responding."
- **In the simulator, Talk toggles:** a terminal can't see a key being released, so the first `t` starts recording and the second `t` sends.

**Listening and speaking.** Nothing records until Talk is pressed: no wake word. The model never speaks unprompted. A reply comes back with the server's voice (Cartesia) when the server sends one, and the Pi plays it; otherwise, or if that audio can't be read or played, the Pi speaks the reply text with its own voice. The Pi's own lines are fixed and built from local state: "Sophi is on." at boot, offline and back online, a part that stopped responding, "I need to be paired again" after a 401, and its local answers to a button press (such as the offline line and "Nothing to confirm."). Each of these is queued as an event and sent with the next heartbeat, so the walker page can show everything the walker said (voice is never the only way to get it). Each event carries how long ago it was said, measured on the Pi's monotonic clock: the Pi has no battery clock, and its date jumps at the boot-time sync. The page already shows replies and Confirm results (as the turn and the proposal's state), so those aren't events.

**The parts it reports.** Every heartbeat's manifest lists each part the walker has, once, and nothing it doesn't: the coordinator itself as `base.walker` (`pi-coordinator`, or `sim-coordinator` under `walker simulate`, where it is marked simulated); each ESP32 module by its own id (hand controls, and the ToF sensor only from an ESP32 sensor board); the Pi's GPIO Talk and Confirm buttons as `controls.hand` (`pi-gpio-buttons`), but only when the installer has declared them wired with `WALKER_GPIO_BUTTONS=wired` (the Pi can't sense whether a button is wired, so it never guesses); and the USB mic and speaker as `voice`. Declared GPIO buttons read "ok" once `gpiomon` has watched their lines for a second; one that keeps exiting (a wrong chip name) reads unavailable. Without the declaration the Pi doesn't watch GPIO at all.

**Obstacle cues (local only).** A ToF zone under 500 mm becomes near; it clears only over 650 mm. A near zone gives the cue the confirmed configuration asks for: `vibration` sends `haptic.play` `near_obstacle` for 400 ms to each working hand module, `sound` plays a short double beep. A zone that stays near repeats every 3 s; a new near zone cues at most once a second. A reading is fresh for 500 ms after the Pi receives it; a missing, stale or invalid zone is unknown, never clear, and never cues. The cloud never commands a cue: its only influence is the user-confirmed `cues` list. Every number here is a placeholder, not measured (see `src/constants.ts`). These are proximity cues, not collision avoidance.

Two decisions for review: before the Pi has fetched any configuration it gives both vibration and sound, and if vibration is chosen but no haptic actually goes out (no hand board that can buzz, or its port busy) it plays the sound instead, so an obstacle is never silently ignored. A hand board can buzz only when its health is `ok`, it declared `haptic`, and it reports neither `haptic_missing` nor `haptic_error` (the firmware's codes for a driver that didn't answer at boot or stopped answering, such as a loose wire). A reading that flickers between near and invalid repeats at most every 3 s.

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

Keys: `t` Talk, `c` Confirm, `n` hand in front of the ToF, `f` nothing in front, `i` invalid readings, `x` the ToF stops responding (and `x` again brings it back), `o` network down and up, `g` network hangs (no answers) and back, `r` the fake cloud forgets the walker (401), `p` pair again, `?` help, `q` quit. The `o` and `g` keys act on the walker's own requests, so they work against a real server too (`--server`): that is how the offline beat can be shown on a Mac.

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
- **Scripted run:** `--script devices/pi/test/sim/demo-path.walk` runs the demo path with no keyboard and exits 0 only if every step happened in order. A step can wait longer than the default 20 s with `expect <ms> <event> <text>`.

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

The expected results were written first, in [test/EXPECTED.md](test/EXPECTED.md); each test names the row it checks. All time comes from an injected fake clock, so no test sleeps, records the room or makes a sound. The serial tests run the shared fixtures in `packages/contracts/test/fixtures/`.

## Set up the Pi

### Check the walker first (`walker check`)

**Run this first, every time the walker is assembled or moved.** One command tells you in well under a minute what works: one plain line per item with `PASS`, `WARN`, `FAIL` or `SKIP` and the evidence (device names, numbers), then a summary. It exits 1 if anything failed, else 0. **Written 2026-10-23 and tested only on a Mac** (fake command output, simulated boards, and a fake board on a macOS pseudo-terminal); it hasn't run on the Pi yet, so its first Pi run is itself a check of the check.

It only reads. It never moves anything, never changes a setting, never stops or starts the service, sends no haptic unless you pass `--buzz` and plays no sound unless you pass `--sound`. It does record **1 s from the mic** to see a level: the audio stays in memory, is never saved or sent, and is zeroed straight away. The credential is never printed.

After copying a new bundle to the Pi (step 7; the bundle installed on 2026-10-24 predates `check`):

```bash
sudo node /opt/steady-walker/walker.mjs check
```

It needs `sudo` because the settings file (`/etc/steady-walker.env`, mode 0640) and the credential (`/var/lib/steady-walker`, mode 0700) are readable only by root and the service. It reads the same settings file the service does.

**The serial boards need the service stopped.** The running service holds every serial port, and two programs on one port corrupt each other's reads, so with the service running the module line is `SKIP` and lists the boards the service's log says hello from since boot. For the live check, with the button and buzz tests:

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
| `--port <tty,...>` | Check these ports instead of everything under `/dev/serial/by-id`. |
| `--server <url>` | Check this server's DNS and health instead of the paired one. |
| `--state <dir>`, `--env <file>` | Another state folder or settings file. |
| `--sim` | Simulated boards instead of real ports (on a Mac). |

What each group checks, and the only commands it runs:

| Group | Checks | Reads with |
| --- | --- | --- |
| settings | The settings file parses as the service would read it | `/etc/steady-walker.env` |
| system | Trixie on aarch64; clock synchronized (HTTPS needs the date); no under-voltage or throttling now (fail) or since boot (warn); memory and disk (fail under 200 MB / 500 MB, warn under 500 MB / 2 GB, *placeholders*); `steady-walker` enabled and running (inactive only warns) | `/etc/os-release`, `timedatectl show`, `vcgencmd get_throttled` and `measure_temp`, `/proc/meminfo`, `df -Pk /`, `systemctl is-active` and `is-enabled` |
| network | The default route is on Ethernet (Wi-Fi warns: the venue plan is the hardline); no saved Wi-Fi connection autoconnects (one that does warns, because unplugging Ethernet for the offline beat would fail over to it; the line gives the `nmcli` command to turn it off, which the check doesn't run); DNS for the server; `GET /api/v1/health` and its time (20 s limit, *placeholder*) | `ip route show default`, `nmcli -t -f NAME,TYPE,AUTOCONNECT connection show`, DNS, HTTPS |
| pairing | The credential exists and parses (never printed); the server accepts it, through `GET /api/v1/devices/{id}/configuration`, the one device route that changes nothing on the server (it only reads the current configuration) | the state folder, HTTPS |
| audio | 1 s from `WALKER_ALSA_CAPTURE` with a nonzero level; `WALKER_ALSA_PLAYBACK` is listed; `--sound` plays the tone | `arecord` (the service's own format), `aplay -L`, `aplay` with the tone piped in |
| voice | With `WALKER_PIPER_MODEL`: the voice files exist and Piper speaks "Sophi check." into a private temp file (deleted) within 15 s (*placeholder*; 3.3 to 3.8 s measured). Piper failing with espeak-ng present only warns, since the walker falls back to it | `piper`, `espeak-ng --version` |
| serial | Each port's board: id, type, firmware, protocol, capabilities, health and faults; two boards with one id; each expected id; for the ToF board, each zone's mm and quality over 1.2 s; `--press`, `--buzz` | the service's own `openSerialPort` and `ModuleManager` (so the same `hello.request`); `journalctl -u steady-walker -b` while the service runs |
| screen | An HDMI connector reports connected, with 800x480 among its modes (other modes warn); an input device reports an absolute X and Y (a touch screen; the ELECROW's touch is expected over USB) | `/sys/class/drm/*-HDMI-*/status` and `modes`, `/proc/bus/input/devices` |
| gpio | Only with `WALKER_GPIO_BUTTONS=wired`: the chip has both lines. The press test is step 3 | `gpioinfo` |

Every command has a time limit (5 s unless the table says otherwise), and so does each group as a whole: past it, the line is `FAIL` "no answer within N s" and the run carries on. `WARN` and `SKIP` never fail the run.

Example output, **illustrative**: written by hand to show the format, from what the checks print in the tests, not captured on the Pi. It shows a Pi with the service stopped, run with `--press --buzz`, before `hand-right-01` and `tof-front-01` have been flashed:

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

**On a Mac:** `node devices/pi/dist/walker.mjs check --sim` runs the serial check against simulated boards (every such line says `simulated`), and the Pi-only lines `SKIP`. `--state ./walker-state` (after `walker pair ... --state ./walker-state` against a local server, see [Against the real server on this Mac](#against-the-real-server-on-this-mac)) adds the DNS, health and pairing lines. `--port /dev/cu.SLAB_USBtoUART` checks a real board plugged into the Mac (not tried with a real board; checked with a fake board on a pseudo-terminal).

### The setup steps

The real Pi came up for the first time on the evening of 2026-10-24. Steps marked **Run 2026-10-24** were done then, and each says what it showed. Steps marked **Not yet run** are unverified: each says what to check, so a step that doesn't match can be fixed before the next one. Write what you find (device names, chip name) into `hardware/current-build.md`.

What it ran on (2026-10-24): a Raspberry Pi 5, 4 GB, on the official 27 W USB-C supply (`vcgencmd get_throttled` read `0x0`, so no undervoltage or throttling had happened), with Raspberry Pi OS Lite image "2026-10-06": Debian 13 "trixie", aarch64, NetworkManager 1.52.1, cloud-init 25.2.

**The power button.** On a stock Pi 5, one short press of the power button while it's running shuts it down cleanly (its light turns red); press it again to start. On 2026-10-24 the Pi shut down twice that way by accident while it was being handled (the journal said `systemd-logind: Power key pressed short`). So the installer now sets `HandlePowerKey=ignore` ([`systemd/logind-walker.conf`](systemd/logind-walker.conf)): a short press does nothing, and holding the button about 10 s still forces the Pi off. Set by hand that night and applied with `sudo systemctl kill -s HUP systemd-logind`. When the Pi is off, one press starts it.

**The journal is in memory on Raspberry Pi OS.** The OS ships `/usr/lib/systemd/journald.conf.d/40-rpi-volatile-storage.conf` (`Storage=volatile`), so every log vanishes at power-off, even with `/var/log/journal` present. The installer adds [`systemd/journald-walker.conf`](systemd/journald-walker.conf) as `/etc/systemd/journald.conf.d/90-walker-persistent.conf` (`Storage=persistent`), restarts journald and runs `journalctl --flush`. Set by hand on 2026-10-24: `journalctl --list-boots` then listed earlier boots, so `journalctl -b -1 -u steady-walker` can show the walker's log from before a power loss.

1. **Raspberry Pi OS.** *Run 2026-10-24.* Flash Raspberry Pi OS Lite (64-bit), for example with Raspberry Pi Imager, and set the hostname, user, SSH key and Wi-Fi (on 2026-10-24, the phone hotspot, which is banned at Cal Hacks; at the venue the Pi uses Ethernet, which needs no setting here, and more networks can be added later; see [The network](#the-network-ethernet-first-wi-fi-as-a-backup)). On this image those settings are cloud-init files on the card's `bootfs` drive (`user-data`, `network-config`, `meta-data`). Check: `cat /etc/os-release` says trixie, and `uname -m` says aarch64. Seen: trixie, aarch64.
   - **Trap: cloud-init reads those files only once per instance id.** The image's `meta-data` says `instance_id:` (underscore), which cloud-init ignores, so once the card has booted, later edits to `user-data` or `network-config` are skipped. On 2026-10-24 an SSH key added that way was never installed. To make cloud-init read the files again, add a line `instance-id: <any new value>` (hyphen) to `meta-data`.
   - **After the first login,** these were set on 2026-10-24: cloud-init turned off so it can't redo or undo later changes (`sudo touch /etc/cloud/cloud-init.disabled`; make further changes over SSH); an attempt at a persistent journal (`sudo mkdir -p /var/log/journal`, then `sudo systemctl restart systemd-journald`), which isn't enough on this OS (see "The journal is in memory" above; the installer now sets it); and Wi-Fi power saving off, in `/etc/NetworkManager/conf.d/10-walker-no-powersave.conf`:

     ```ini
     [connection]
     wifi.powersave = 2
     ```

     then `sudo systemctl restart NetworkManager`. (These are the usual commands for those settings; what was recorded that night is the resulting settings, not the exact commands.)
2. **Node 22 and tools.** *Run 2026-10-24.* Install Node 22 from NodeSource (`curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -` then `sudo apt install -y nodejs`), and the tools: `sudo apt install -y alsa-utils gpiod espeak-ng`. Check: `node --version` prints v22 or newer; `gpiomon --version` prints a version (1.6.x means `WALKER_GPIOMON=v1`, 2.x means `v2`). Seen: Node v22.23.4, `gpiomon` from libgpiod v2.2.1 (so `v2`, which is now the example settings file's default), espeak-ng 1.52.0, alsa-utils 1.2.14.
3. **Wire the two buttons.** *Not yet run.* Each momentary button goes between a GPIO pin and a ground pin; the service turns on the internal pull-up, so no resistor is needed. Talk: GPIO17 (physical pin 11) and ground (pin 9). Confirm: GPIO27 (pin 13) and ground (pin 14). Never wire a button to 5 V. Check: run `gpioinfo` and find the chip whose lines are named `GPIO17` and `GPIO27` (on current Pi 5 kernels it is `gpiochip0`; older ones called it `gpiochip4`); then `gpiomon --chip gpiochip0 --bias=pull-up --edges=both 17 27` (v2; on v1 it's `gpiomon --bias=pull-up gpiochip0 17 27`) prints a falling edge when you press and a rising edge when you let go. Press Ctrl-C to stop it. Once both buttons work, you'll declare them in step 8 with `WALKER_GPIO_BUTTONS=wired`.
4. **Plug in the USB mic and soundbar.** *Run 2026-10-24.* Go through the powered hub if the Pi's USB power budget is tight; see `hardware/current-build.md`. Check: `lsusb` lists both. Seen: the mic, an SF-558 USB gooseneck (`1b3f:0906`), and the soundbar, `5a47:5858` "USB Composite Device". Plugging the mic, the soundbar and an ESP32 board in while the Pi ran didn't by itself shut anything down (the journal shows no shutdown at those times). One hard power loss, at 23:19, came at the same moment the soundbar disappeared from USB; a knocked cable is likely but unproven.
5. **Find the ALSA names.** *Run 2026-10-24, except the two-sounds check.* `arecord -L` lists capture devices and `aplay -L` playback devices; prefer the `CARD=` names (they survive replugging). Check the mic: `arecord -D plughw:CARD=<mic>,DEV=0 -f S16_LE -r 16000 -c 1 -d 3 /tmp/test.wav && aplay -D default:CARD=<soundbar> /tmp/test.wav` plays your voice back. Then delete the test clip. Check two sounds at once: run `speaker-test -D default:CARD=<soundbar> -c 2 -t sine -l 1 &` and `aplay -D default:CARD=<soundbar> /usr/share/sounds/alsa/Front_Center.wav` together; if the second says "device busy", note it, because cues and speech would then wait for each other. Seen: the kernel names the mic's card `SF558` (no rule needed), with its `Mic` control at 87%. The soundbar's card is named `Speaker` by the installer's udev rule [`systemd/85-walker-audio.rules`](systemd/85-walker-audio.rules), keyed on its USB id; another speaker needs its own id there. So the example settings file now has `WALKER_ALSA_CAPTURE=plughw:CARD=SF558,DEV=0` and `WALKER_ALSA_PLAYBACK=default:CARD=Speaker`. A 5 s test recording peaked at about 10,100 of 32,767 (RMS about 1,000), and Max heard his voice played back. The soundbar's `PCM` control came up at 30%; the service's drop-in [`systemd/steady-walker.service.d/10-volume.conf`](systemd/steady-walker.service.d/10-volume.conf) sets it at every start: first 100%, then 75% at Max's request (it read 75% after a restart). An `amixer` command inside the udev rule didn't take effect, so the service sets the volume instead. The two-sounds-at-once check hasn't been run.
6. **Optional, a nicer voice (Piper).** *Run 2026-10-24.* Follow [Optional: the Piper voice](#optional-the-piper-voice). Without Piper, or if it fails, the walker speaks with espeak-ng. Seen: installed as written there; Max chose Piper's voice over espeak-ng by ear.
7. **Build and copy the service.** *Run 2026-10-24.* On the Mac: `pnpm --filter @walker/pi bundle`, then copy `devices/pi/dist/walker.mjs`, `devices/pi/systemd/` and `devices/pi/scripts/` to the Pi (for example `scp -r`), keeping the folder layout. For the screen, copy `devices/pi/screen/` too ([The screen](#the-screen)).
8. **Install.** *Run 2026-10-24, with the Wi-Fi part.* On the Pi: `sudo ./scripts/install-pi.sh walker.mjs` (from the copied folder). It creates the `steady` user, puts the bundle in `/opt/steady-walker`, makes `/var/lib/steady-walker` (mode 0700), installs and enables the unit, and writes `/etc/steady-walker.env` from the example if it's missing. It also installs the Wi-Fi helpers: both scripts go into `/opt/steady-walker` (with `walker-wifi-add.sh` linked into `/usr/local/sbin`), `walker-wifi.service` is installed and enabled, and `wifi.txt` is copied onto the card's boot partition if the card has none. It also installs four files from `systemd/`: the soundbar's udev name and the service's full-volume drop-in (step 5), the persistent journal, and the power button that ignores a short press (both above the steps). Those four were set by hand on 2026-10-24; the installer putting them in place hasn't been run on the Pi yet. It does not start anything. Edit `/etc/steady-walker.env` with the names from steps 3 and 5, and set `WALKER_GPIO_BUTTONS=wired` if step 3 showed both buttons working. Seen: the walker service part ran as written and installed and enabled `steady-walker`. Run again with the Wi-Fi part the same night: it installed both helpers and enabled `walker-wifi.service` and `steady-walker`, kept the existing `/etc/steady-walker.env`, and the walker was online again after a restart.
9. **Pair.** *Run 2026-10-24.* On the walker page, start pairing to get a 6-digit code (valid 10 minutes). On the Pi: `sudo -u steady WALKER_STATE_DIR=/var/lib/steady-walker node /opt/steady-walker/walker.mjs pair <code> --server https://steady-walker.onrender.com`. It first prints "Waking the server…" and can wait up to 90 s for a sleeping server. Check: it prints `Paired as device ...`, and `sudo ls -l /var/lib/steady-walker/credential.json` shows `-rw-------` owned by `steady`. Seen: "Waking the server…", then "Paired as device …".
10. **Start it.** *Run 2026-10-24, with no mic or speaker plugged in.* `sudo systemctl start steady-walker`, then `journalctl -u steady-walker -f` to watch. Check: you hear "Sophi is on.", the log shows `link state state="online"`, and the walker page shows the walker online with its parts. Seen: the log showed `link state state="online"` and Max's walker page showed the walker Online. With no speaker, every spoken line logs `warn speaker failed ... cannot find card 'Soundbar'` and the service keeps running (`systemctl show -p NRestarts steady-walker` stayed 0). Hearing "Sophi is on." is still to check. Later that night, with the mic, the soundbar and the settings from step 5 in place, the soundbar's volume read 100% after a restart (later set to 75%).
11. **Try the demo path.** *Not yet run, apart from offline and back.* Hold Talk, ask "What can you help me with?", release: a reply. Press Confirm with nothing open: the short low double beep. Unplug the Ethernet cable at the Pi's end, with any Wi-Fi backup off (see [The network](#the-network-ethernet-first-wi-fi-as-a-backup)): within about 10 s it says it's offline, and Talk gets the local line. Plug it back in: "I'm back online." Reboot the Pi: the service comes back by itself and says "Sophi is on." Seen so far: when the Pi was moved from the phone hotspot to home Wi-Fi, the service logged "I'm offline right now." and then "I'm back online." about 10 s later, by itself. After `sudo systemctl reboot` the Pi rejoined home Wi-Fi, `walker-wifi.service` ran, and the service logged `link state state="online"` by itself (no speaker was plugged in, so "Sophi is on." wasn't heard). Later that night, with Talk on the ESP32 hand board (step 12): held about 3 s asking "What can you help me with?", the log said `turn answered ms=3957 answered_by="model" voice="server"` (3.96 s from letting go to the answer arriving, from Gemini on Render with Cartesia's voice), and Max heard the reply. Not yet tried on the Pi: Confirm, the obstacle cues, the offline beat with the mic and speaker in, a reboot with them in, and the beats in order.
12. **ESP32 modules (after firmware, piece 7).** *Run 2026-10-24 with one hand board; no obstacle board.* Plug each board in and check `ls -l /dev/serial/by-id/`: each board appears under a name with its USB serial number, and the service log shows `module said hello`. The service only listens to a module after its hello, and asks for one (`hello.request`) whenever it opens a port, so a board that kept running while the service restarted still announces itself. If a board's buttons do nothing, check the log for `hasn't said hello`: the board isn't answering `hello.request` (a firmware question for piece 7). Seen: the first hand board (`hand-left-01`, CP2102 USB bridge `10c4:ea60`): the log showed `serial port opened … simulated=false`, then `module said hello module="hand-left-01" type="hand" firmware="0.1.0" simulated=false`, and its health `ok`. Its Talk button is for now a wire from P32 touched to ground. Brushed briefly, it gave press-and-release bursts of 80 to 110 ms, each under the 0.3 s minimum, so each got "I didn't catch that. Hold Talk while you speak."; held firmly for 3 s it gave the spoken turn in step 11. Not yet checked through the Pi: the board's Confirm, and a haptic cue sent by the service (the buzz was felt only in the firmware's own bench test; see `hardware/current-build.md`). To put firmware on `hand-right-01` or `tof-front-01` from the Pi, see [Flash a board from the Pi](#flash-a-board-from-the-pi); then [`walker check --press --buzz`](#check-the-walker-first-walker-check) with the service stopped shows every board, its health, the ToF zones, a press on each hand and a buzz.

To stop it: `sudo systemctl stop steady-walker`. To keep it from starting at boot: `sudo systemctl disable steady-walker`.

### Optional: the Piper voice

Piper is a voice that runs on the Pi itself. The walker uses it for its own lines, and for a reply whenever the server sends no voice. It isn't in the installer, since the walker works without it (espeak-ng is the fallback). Run on the Pi 5 on 2026-10-24, which installed piper-tts 1.8.0 from pip:

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

`scripts/flash-esp32.sh <module id>` writes a prebuilt image onto one ESP32 plugged into the Pi, with the esptool already on the Pi in `/opt/esptool` (the one that reflashed `hand-left-01` on 2026-10-24, esptool 5.6.0). **Not yet run on the Pi**; checked on a Mac against fake `systemctl`, `fuser` and `esptool` (`test/flash-esp32.test.ts`), and dry-run against the real `hand-right-01` and `tof-front-01` images with `echo` standing in for esptool. Build the image on the Mac first ([firmware/README.md, "Build an image on a Mac, flash it from the Pi"](../../firmware/README.md#build-an-image-on-a-mac-flash-it-from-the-pi)) and copy its folder to the Pi, then, from the copied `devices/pi` folder (step 7):

```bash
sudo systemctl stop steady-walker
sudo ./scripts/flash-esp32.sh hand-right-01 --images ~/firmware
sudo node /opt/steady-walker/walker.mjs check --expect hand-left-01,hand-right-01 --press
sudo systemctl start steady-walker
```

It writes the same four files at the same addresses as the 2026-10-24 reflash (bootloader `0x1000`, partitions `0x8000`, boot_app0 `0xe000`, app `0x10000`) at 460800 baud. It refuses, without touching the board, when:

- `steady-walker` is running (it holds the ports; the script never stops it for you);
- another program has the port open (`fuser`);
- one of the four files is missing from `<images>/<module id>/`;
- `firmware.bin` doesn't contain the id (the build bakes the id in as text, so this catches a `hand-left-01` image about to go onto the right board);
- more than one board is plugged in and `--port` isn't given (it lists them; with exactly one it uses that one and says so).

It looks for esptool as `ESPTOOL`, then `/opt/esptool/bin/esptool` or `esptool.py`, then the `PATH` (the exact file name inside `/opt/esptool` isn't recorded, so this is a guess to check), and uses `write-flash` for esptool 5 or `write_flash` for esptool 4. With more than one board plugged in, `ls -l /dev/serial/by-id/` names each port by its USB serial number; `walker check` shows which id is on which port. If it can't connect, hold the board's BOOT button while it says "Connecting...".

### The network: Ethernet first, Wi-Fi as a backup

The walker needs the internet for the assistant; its offline lines and obstacle cues work without it. The walker page is on Render (<https://steady-walker.onrender.com>), so any computer with a browser can show it, on any network.

**At Cal Hacks: Ethernet.** Cal Hacks prohibits personal hotspots, routers and other broadcasting equipment in the venue, and says it can detect them; never unplug its access points or switches. There's a hardline switch every 3 tables: request a cable in the Cal Hacks app, then pick it up at the Hardware Checkout window. The Pi 5 has its own gigabit Ethernet port, so no adapter is needed. On Raspberry Pi OS Lite trixie, NetworkManager is expected to bring up `eth0` with DHCP by itself, with no setup; this hasn't been run on our Pi yet. Check: `nmcli device` shows `eth0` as `connected`, and `ip -4 addr show eth0` shows an address. When Ethernet and Wi-Fi are both connected, NetworkManager's default route metrics (100 for Ethernet, 600 for Wi-Fi) are expected to send traffic over Ethernet; not checked on the Pi.

**The venue Wi-Fi: a backup, kept off.** About 3,000 people share it. Use it only if Ethernet fails, and only if it has no sign-in web page and doesn't ask for a username (see "Networks that won't work" below). The Pi 5's Wi-Fi is Wi-Fi 5 on 5 GHz: it works with the venue's Wi-Fi 6 access points (which Cal Hacks says work best), but expect congestion; 2.4 GHz is only on the Mezzanine. Add it in one of the ways below, then turn its autoconnect off. With a working Wi-Fi network saved and on, unplugging Ethernet for the offline beat fails over to Wi-Fi and the walker does not go offline. The commands, not yet run on the Pi, are in the walker script's [setup B, step 3](../../docs/demo/walker-script.md#b-the-real-pi-on-the-venue-network-server-on-render).

**Reaching the Pi at the venue.** Venue networks often isolate clients from each other, so the laptop may not reach the Pi by SSH there; not yet tried. Fallbacks: the Pi's own screen with a USB keyboard (the walker is getting a 5-inch HDMI touch screen; while it shows the kiosk, Ctrl+Alt+F2 is expected to give a login prompt, not yet tried, see [The screen](#the-screen)), or plugging the laptop and the Pi into the same hardline switch (a laptop without an Ethernet port needs an adapter), which may still be isolated. Do what needs SSH, such as pairing (step 9), before the venue where you can.

**Wi-Fi.** The Pi joins any Wi-Fi network that NetworkManager has saved. There are two ways to give it one, plus a phone hotspot away from the venue:

- **From any computer, with the SD card (`wifi.txt`).** Shut the walker down (one press of the power button), take out the SD card and put it in any computer: its boot partition shows up as a drive called `bootfs`. Open `wifi.txt` there and add a block like this one (illustrative):

  ```text
  name: Venue Guest
  password: the-password
  ```

  Leave the password empty for an open network. Save, eject, put the card back and start the walker. At boot, `walker-wifi.service` runs `walker-wifi-import.sh`, which adds each new block to NetworkManager as a connection called `walker: <name>` and then replaces its password in the file with `(saved)`, so the password doesn't stay on the card. Blocks already `(saved)` are skipped, and comment lines are left alone. Each connection has `ipv4.may-fail yes` and `ipv6.method auto`, so a network that hands out only IPv4 or only IPv6 still counts as connected. Checked on the Pi on 2026-10-24 by running the script on a `wifi.txt` with two dummy networks (one WPA, one open): both were added with those settings, both password lines became `(saved)`, and a second run added nothing. Not yet checked: the service doing it at boot (no reboot test was done), or the walker joining a real network added this way. `test/wifi-import.test.ts` checks the file handling on a Mac against a fake `nmcli`.
- **Over SSH:** `sudo walker-wifi-add.sh` asks for the network's name and its password (not shown as you type) and saves it with `connection.autoconnect-priority 10`, so it's preferred over saved networks with the default priority (0) when both are in range. It wasn't part of the 2026-10-24 checks. Both ways turn autoconnect on; for a backup that should stay off, such as the venue Wi-Fi, run `sudo nmcli connection modify "walker: <name>" connection.autoconnect no` afterwards (not yet run on the Pi).
- **A phone hotspot, away from the venue only.** It's banned at Cal Hacks: personal hotspots, routers and other broadcasting equipment are prohibited there, and Cal Hacks says it can detect them. Elsewhere it's the fallback that works anywhere there's a phone signal. On an iPhone, turn on **Maximize Compatibility** (2.4 GHz, WPA2) and keep the Personal Hotspot screen open while the Pi joins; on 2026-10-24 the Pi didn't join until Maximize Compatibility was on. On that T-Mobile iPhone hotspot the Pi got an IPv4 address (172.20.10.x) and IPv6, and reached Render. A Mac on the same hotspot got no IPv4 address, because macOS honours the hotspot's "IPv6-only preferred" setting; that doesn't affect the Pi.

**Networks that won't work:** ones that need a sign-in web page first (many venue, hotel and campus guest networks), because the walker has no browser to sign in with, and enterprise networks that ask for a username (WPA2-Enterprise, such as eduroam), which these scripts don't set up. At Cal Hacks, use Ethernet there; elsewhere, a phone hotspot. No venue network has been tried yet.

### The screen

**Not yet run on the Pi.** Everything in this section was written on 2026-10-23 from the vendor's documents and the software's own documentation; none of it has been tried on our Pi or panel. Each step says what to check.

**The panel.** An ELECROW 5-inch 800x480 capacitive touch screen, model DIS05490T (Amazon B0CYKXCM8J, sold as "driver-free"). Elecrow's [user manual](https://www.elecrow.com/download/product/DIS05490T/5inch_HDMI_Display_User_Manual.pdf) shows it on a Pi 5 with two cables, both in the box: the Pi's micro-HDMI port (through the included micro-HDMI-to-HDMI adapter) to the panel's HDMI socket for the picture, and the panel's USB-C socket to a Pi USB-A port for **power and touch**; the panel also has its own power switch. Not confirmed: whether the panel reports 800x480 correctly to the Pi (its EDID), how its touch shows up in Linux (the listing says five-point touch on Windows but single-point "with Raspberry Pi running Raspbian"), its USB vendor and product ids, and how much current it draws (Elecrow's product page lists a 5 V 2 A supply; the Pi 5 on the official 27 W supply gives its USB ports 1.6 A in all). Record what you find in `hardware/current-build.md`.

**How it works.** `install-pi.sh --screen` adds a second systemd service, [`sophi-screen`](systemd/sophi-screen.service), separate from the walker service: the walker service never waits for it, and it never stops or delays the walker. It runs [cage](https://github.com/cage-kiosk/cage), a small Wayland "kiosk" compositor that shows one app full screen and nothing else, with Chromium inside it in kiosk mode (no address bar, no tabs). It runs as its own user, `sophi-screen`, so the browser can't read the walker's credential, with a login session on the first text console (tty1, which is what the panel shows) so cage may use the display and the touch panel ([`systemd/sophi-screen.pam`](systemd/sophi-screen.pam)). Chromium's profile lives in memory under `/run/sophi-screen` and is thrown away each time the service stops, so there are no first-run screens, "restore pages?" bubbles or keyring prompts; translate offers, pinch zoom and swipe-back are off. The service's main command is [`scripts/sophi-screen-wait.sh`](scripts/sophi-screen-wait.sh), which waits, for as long as it takes, for a connected screen and an answering page, then starts cage and Chromium in its place; so boot never waits for the screen, and a screen plugged in later, or a walker service that starts later, just means the page appears then. If cage or Chromium exits, the service starts again after 5 s, backing off to at most every 2 minutes if it keeps failing at once (`RestartSteps=6`, `RestartMaxDelaySec=120`). It shows only local pages: a file on the Pi, or `http://127.0.0.1`. If memory runs out, the kernel stops the browser before the walker service (`OOMScoreAdjust=800`), and the walker gets the processor first (`CPUWeight=50`). The text console never blanks (`consoleblank=0`), and neither cage nor Chromium blanks the screen or turns it off.

**The page.** Until the walker service serves the real screen (a later change, which will serve it on `http://127.0.0.1:<port>/` with a per-boot token), the screen shows [`screen/placeholder.html`](screen/placeholder.html), installed as `/opt/steady-walker/screen/placeholder.html`: "Sophi", "Screen connected." and "The walker's screen starts when the walker service is updated.", in the web app's light colours, at 88, 48 and 40 px. To show another local page: `sudo systemctl edit sophi-screen`, add `[Service]` and `Environment=SOPHI_SCREEN_URL=<the page>`, then `sudo systemctl restart sophi-screen`.

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

## Settings (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `WALKER_ALSA_CAPTURE` | (required) | ALSA capture device for the mic. Ours (the SF-558): `plughw:CARD=SF558,DEV=0`. |
| `WALKER_ALSA_PLAYBACK` | (required) | ALSA playback device for the soundbar. Ours, with the udev rule: `default:CARD=Speaker`. |
| `WALKER_PIPER_MODEL` | none | Path to a Piper `.onnx` voice, such as `/opt/steady-walker/voices/en_US-lessac-medium.onnx`. Without it, espeak-ng. |
| `WALKER_GPIO_CHIP` | `gpiochip0` | The GPIO chip with the header pins (`gpioinfo`). |
| `WALKER_GPIO_TALK`, `WALKER_GPIO_CONFIRM` | `17`, `27` | BCM GPIO line numbers. |
| `WALKER_GPIOMON` | `v1` | libgpiod command-line version (`gpiomon --version`). The example settings file sets `v2`, which is what Raspberry Pi OS trixie ships (2.2.1 on 2026-10-24). |
| `WALKER_GPIO_BUTTONS` | unset | Set to `wired` once step 3 shows both buttons working. Only then does the Pi watch the GPIO buttons and report them as hand controls. |
| `WALKER_STATE_DIR` | `/var/lib/steady-walker` | Credential, configuration and cue sounds. |
| `WALKER_SERIAL_DIR` | `/dev/serial/by-id` | Where serial ports are looked for. |

## Cloud link

The client ([src/cloud/client.ts](src/cloud/client.ts)) speaks the walker contract in `packages/contracts/src/walker.ts` (guide: [docs/subsystems/walker-assistant.md](../../docs/subsystems/walker-assistant.md)) and checks every response against it:

| Call | Route | Pi sends | Pi uses |
| --- | --- | --- | --- |
| Pair (CLI) | `POST /api/v1/devices/pair` | `{code, name?, service_version}` | `device_id`, `credential` (saved 0600), configuration 1 |
| Heartbeat, every 5 s | `POST /api/v1/devices/{id}/heartbeat` | `{sent_at, service_version, manifest, snapshot or null, events}` | `configuration_version` (fetch when newer), `open_proposal` |
| Configuration | `GET /api/v1/devices/{id}/configuration` | | `configuration.cues`, reported back as `device_configuration_version` |
| Turn | `POST /api/v1/devices/{id}/turns` | `{client_turn_id, input: {type: "audio", mime, data_base64, duration_ms}, snapshot}` | `turn.reply`, `speech` (played if present), `proposal` |
| Answer | `POST /api/v1/devices/{id}/proposals/{proposal_id}` | `{answer: "confirm" or "decline"}` | the proposal's state; `409 proposal_closed` carries it as it stands |

A `401 unauthenticated` from any of them means "pair me again". The real server is pieces 2 and 3, deployed on Render; the simulator's fake cloud stands in for it in tests and Mac runs, so the simulator proves the Pi's side only.

## Assumptions and open questions

- **Placeholders, not measured:** module heartbeat timeout 3 s; zone freshness 500 ms; near under 500 mm, clear over 650 mm; cue repeat 3 s and minimum gap 1 s; haptic 400 ms; GPIO debounce 30 ms; shortest clip 0.3 s; heartbeat deadline 5 s; retry delays 5, 10, 15 s. All in `src/constants.ts`.
- **From the design:** heartbeat every 5 s; offline after 2 failed heartbeats or a 10 s turn; clips at most 15 s, 16 kHz mono 16-bit, at most 500,000 bytes.
- **Serial:** 115200 baud (to confirm with the firmware). One module per port. A module is known only after its hello. The Pi asks for one with `hello.request` when it opens a port, again (at most every 2 s, *placeholder*) while an unknown module keeps talking, and when a module that went silent comes back. A hello whose `seq` kept running is an answer. Any line whose `seq` went back (a hello or not, since a boot hello can be lost) is a reboot, which drops any recording that module's button started and asks for a fresh hello. Two boards flashed with the same id: whichever said hello last keeps the id (each board's reboot takes it again); the Pi ignores the other port, logs it once, and never asks it for a hello, so the two don't trade the id back and forth. The Pi's reply to a hello beyond that (protocol version, report rate) is still unspecified, so it sends none. Assumed, to confirm with the firmware: a module's `seq` starts at 0 on boot, strictly increases on the wire (two tasks must never send the same number), and never wraps during a demo.
- **Reads:** serial ports are read with blocking file reads on libuv's thread pool, so the unit sets `UV_THREADPOOL_SIZE=8`. Checked only through a macOS pseudo-terminal, not on a Pi.
- **GPIO:** buttons wire to ground with the internal pull-up (so pressed reads low). Pin and chip defaults are assumptions to check with `gpioinfo`.
- **Audio:** the soundbar's `default:CARD=` device mixes, so a cue can play over speech (step 5 checks it). The mic records with `arecord` in raw PCM; the Pi builds the WAV header itself.
- **The snapshot travels with each turn** (the contract asks for it), and is `null` when no obstacle sensor has said hello.
