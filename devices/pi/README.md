# Steady on the walker: the Raspberry Pi service

**Status, 2026-10-23.** The service is written and tested on a Mac. It runs the whole demo path end to end in **simulator mode** (simulated buttons, ToF sensor, hand module, microphone and speaker) against a **fake cloud** on the Mac. On the evening of 2026-10-24 it **ran on the real Raspberry Pi 5** for the first time: installed with `scripts/install-pi.sh`, paired with the deployed server on Render, shown Online on the walker page, and it noticed going offline and coming back by itself when the Pi changed Wi-Fi networks. Later that night (23:00 to 23:23 PDT) it ran with a real USB mic, a real USB soundbar, Piper, and the first ESP32 hand board, whose Talk wire event gave one real spoken turn, answered by Gemini on Render in about 4 s and heard through the soundbar. That was before the Pi-side change mapping the left board's GPIO32 event to Confirm; the new mapping has not been deployed or physically checked on the Pi. Not yet tried on the Pi: Confirm, the GPIO buttons, an obstacle board, a haptic cue sent by the Pi, the offline beat since then, and the demo beats in order ([Set up the Pi](#set-up-the-pi) says what each step showed). It speaks the walker contract (`packages/contracts/src/walker.ts`); see [Cloud link](#cloud-link).

Nothing in this service can move the arms or the lift. It has no motion command of any kind. The only thing it can make a module do is play one of the four fixed haptic patterns from serial v1, for at most a second.

## What runs where

| Where | What | How |
| --- | --- | --- |
| Pi, always (systemd) | `walker run` | One Node 22 process: buttons, serial modules, mic, speaker, obstacle cues, cloud link. Starts at boot and restarts if it stops. |
| Pi, once | `walker pair <code> --server <url>` | Trades the walker page's 6-digit code for a device credential, saved with mode 0600. |
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
- `src/constants.ts`: every timing and threshold, each labelled measured or placeholder.

## How it behaves

**Buttons (the design's button map).** GPIO and keyboard sources use the action names directly. Both ESP32s run the same firmware, so both report GPIO32 as `button: "talk"` over serial. At the Pi's serial boundary, `hand-left-*` GPIO32 events become **Confirm**; the right hand's GPIO32 events remain **Talk**. The event keeps the originating module ID so feedback buzzes on the pressed hand. This is a Pi-side mapping; no ESP32 protocol change is needed.

- **Talk:** hold to talk, release to send. A short "listening" sound plays, then the mic opens. Recording stops at 15 s even if Talk is still held. A press under 0.3 s sends nothing ("I didn't catch that. Hold Talk while you speak."). A press while waiting for the answer cancels it ("Cancelled."), and a late answer is never spoken. A press while a reply is playing stops the reply and starts listening.
- **Confirm:** confirms the open proposal by its id, which the Pi learns from the turn that made it or from a heartbeat. The Pi never judges expiry by its own clock: the server answers. If the server says the proposal is closed (`409 proposal_closed`), Confirm plays the short "nothing to confirm" sound, unless the proposal came back `confirmed` (the page's Confirm won first), which counts as done. With nothing open it plays the same sound without asking. It is ignored while Talk is recording, and a second press while the first is being answered does nothing. Voice can never confirm; the walker page's Confirm button is the other way to do it.
- **An unheard turn's proposal is declined.** If a turn ends without its reply being heard (Talk cancelled it, it timed out, or it failed), the server may still finish it and open a proposal. The next heartbeat shows that proposal (it names its `client_turn_id`), and the Pi declines it instead of leaving it for Confirm, since the person never heard what it would change. Declining after a timeout or failure, not only after a cancel, is a decision for review.
- **A lost release drops the recording.** If the button that started a recording can no longer report its release (its hand module unplugs or reboots, or `gpiomon` exits), the recording is discarded instead of being sent at 15 s: "I stopped listening because the button stopped responding."
- **In the simulator, Talk toggles:** a terminal can't see a key being released, so the first `t` starts recording and the second `t` sends.

**Listening and speaking.** Nothing records until Talk is pressed: no wake word. The model never speaks unprompted. A reply comes back with the server's voice (Cartesia) when the server sends one, and the Pi plays it; otherwise, or if that audio can't be read or played, the Pi speaks the reply text with its own voice. The Pi's own lines are fixed and built from local state: "Steady is on." at boot, offline and back online, a part that stopped responding, "I need to be paired again" after a 401, and its local answers to a button press (such as the offline line and "Nothing to confirm."). Each of these is queued as an event and sent with the next heartbeat, so the walker page can show everything the walker said (voice is never the only way to get it). Each event carries how long ago it was said, measured on the Pi's monotonic clock: the Pi has no battery clock, and its date jumps at the boot-time sync. The page already shows replies and Confirm results (as the turn and the proposal's state), so those aren't events.

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

The real Pi came up for the first time on the evening of 2026-10-24. Steps marked **Run 2026-10-24** were done then, and each says what it showed. Steps marked **Not yet run** are unverified: each says what to check, so a step that doesn't match can be fixed before the next one. Write what you find (device names, chip name) into `hardware/current-build.md`.

What it ran on (2026-10-24): a Raspberry Pi 5, 4 GB, on the official 27 W USB-C supply (`vcgencmd get_throttled` read `0x0`, so no undervoltage or throttling had happened), with Raspberry Pi OS Lite image "2026-10-06": Debian 13 "trixie", aarch64, NetworkManager 1.52.1, cloud-init 25.2.

**The power button.** On a stock Pi 5, one short press of the power button while it's running shuts it down cleanly (its light turns red); press it again to start. On 2026-10-24 the Pi shut down twice that way by accident while it was being handled (the journal said `systemd-logind: Power key pressed short`). So the installer now sets `HandlePowerKey=ignore` ([`systemd/logind-walker.conf`](systemd/logind-walker.conf)): a short press does nothing, and holding the button about 10 s still forces the Pi off. Set by hand that night and applied with `sudo systemctl kill -s HUP systemd-logind`. When the Pi is off, one press starts it.

**The journal is in memory on Raspberry Pi OS.** The OS ships `/usr/lib/systemd/journald.conf.d/40-rpi-volatile-storage.conf` (`Storage=volatile`), so every log vanishes at power-off, even with `/var/log/journal` present. The installer adds [`systemd/journald-walker.conf`](systemd/journald-walker.conf) as `/etc/systemd/journald.conf.d/90-walker-persistent.conf` (`Storage=persistent`), restarts journald and runs `journalctl --flush`. Set by hand on 2026-10-24: `journalctl --list-boots` then listed earlier boots, so `journalctl -b -1 -u steady-walker` can show the walker's log from before a power loss.

1. **Raspberry Pi OS.** *Run 2026-10-24.* Flash Raspberry Pi OS Lite (64-bit), for example with Raspberry Pi Imager, and set the hostname, user, SSH key and Wi-Fi (the phone hotspot; more networks can be added later, see [Wi-Fi on any network](#wi-fi-on-any-network)). On this image those settings are cloud-init files on the card's `bootfs` drive (`user-data`, `network-config`, `meta-data`). Check: `cat /etc/os-release` says trixie, and `uname -m` says aarch64. Seen: trixie, aarch64.
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
7. **Build and copy the service.** *Run 2026-10-24.* On the Mac: `pnpm --filter @walker/pi bundle`, then copy `devices/pi/dist/walker.mjs`, `devices/pi/systemd/` and `devices/pi/scripts/` to the Pi (for example `scp -r`), keeping the folder layout.
8. **Install.** *Run 2026-10-24, with the Wi-Fi part.* On the Pi: `sudo ./scripts/install-pi.sh walker.mjs` (from the copied folder). It creates the `steady` user, puts the bundle in `/opt/steady-walker`, makes `/var/lib/steady-walker` (mode 0700), installs and enables the unit, and writes `/etc/steady-walker.env` from the example if it's missing. It also installs the Wi-Fi helpers: both scripts go into `/opt/steady-walker` (with `walker-wifi-add.sh` linked into `/usr/local/sbin`), `walker-wifi.service` is installed and enabled, and `wifi.txt` is copied onto the card's boot partition if the card has none. It also installs four files from `systemd/`: the soundbar's udev name and the service's full-volume drop-in (step 5), the persistent journal, and the power button that ignores a short press (both above the steps). Those four were set by hand on 2026-10-24; the installer putting them in place hasn't been run on the Pi yet. It does not start anything. Edit `/etc/steady-walker.env` with the names from steps 3 and 5, and set `WALKER_GPIO_BUTTONS=wired` if step 3 showed both buttons working. Seen: the walker service part ran as written and installed and enabled `steady-walker`. Run again with the Wi-Fi part the same night: it installed both helpers and enabled `walker-wifi.service` and `steady-walker`, kept the existing `/etc/steady-walker.env`, and the walker was online again after a restart.
9. **Pair.** *Run 2026-10-24.* On the walker page, start pairing to get a 6-digit code (valid 10 minutes). On the Pi: `sudo -u steady WALKER_STATE_DIR=/var/lib/steady-walker node /opt/steady-walker/walker.mjs pair <code> --server https://steady-walker.onrender.com`. It first prints "Waking the server…" and can wait up to 90 s for a sleeping server. Check: it prints `Paired as device ...`, and `sudo ls -l /var/lib/steady-walker/credential.json` shows `-rw-------` owned by `steady`. Seen: "Waking the server…", then "Paired as device …".
10. **Start it.** *Run 2026-10-24, with no mic or speaker plugged in.* `sudo systemctl start steady-walker`, then `journalctl -u steady-walker -f` to watch. Check: you hear "Steady is on.", the log shows `link state state="online"`, and the walker page shows the walker online with its parts. Seen: the log showed `link state state="online"` and Max's walker page showed the walker Online. With no speaker, every spoken line logs `warn speaker failed ... cannot find card 'Soundbar'` and the service keeps running (`systemctl show -p NRestarts steady-walker` stayed 0). Hearing "Steady is on." is still to check. Later that night, with the mic, the soundbar and the settings from step 5 in place, the soundbar's volume read 100% after a restart (later set to 75%).
11. **Try the demo path.** *Not yet run, apart from offline and back.* Hold Talk, ask "What can you help me with?", release: a reply. Press Confirm with nothing open: the short low double beep. Turn off the phone hotspot the Pi is on: within about 10 s it says it's offline, and Talk gets the local line. Turn it back on: "I'm back online." Reboot the Pi: the service comes back by itself and says "Steady is on." Seen so far: when the Pi was moved from the phone hotspot to home Wi-Fi, the service logged "I'm offline right now." and then "I'm back online." about 10 s later, by itself. After `sudo systemctl reboot` the Pi rejoined home Wi-Fi, `walker-wifi.service` ran, and the service logged `link state state="online"` by itself (no speaker was plugged in, so "Steady is on." wasn't heard). Later that night, with Talk on the ESP32 hand board (step 12): held about 3 s asking "What can you help me with?", the log said `turn answered ms=3957 answered_by="model" voice="server"` (3.96 s from letting go to the answer arriving, from Gemini on Render with Cartesia's voice), and Max heard the reply. Not yet tried on the Pi: Confirm, the obstacle cues, the offline beat with the mic and speaker in, a reboot with them in, and the beats in order.
12. **ESP32 modules (after firmware, piece 7).** *Run 2026-10-24 with one hand board; no obstacle board.* Plug each board in and check `ls -l /dev/serial/by-id/`: each board appears under a name with its USB serial number, and the service log shows `module said hello`. The service only listens to a module after its hello, and asks for one (`hello.request`) whenever it opens a port, so a board that kept running while the service restarted still announces itself. If a board's buttons do nothing, check the log for `hasn't said hello`: the board isn't answering `hello.request` (a firmware question for piece 7). Seen: the first hand board (`hand-left-01`, CP2102 USB bridge `10c4:ea60`): the log showed `serial port opened … simulated=false`, then `module said hello module="hand-left-01" type="hand" firmware="0.1.0" simulated=false`, and its health `ok`. Its Talk button is for now a wire from P32 touched to ground. Brushed briefly, it gave press-and-release bursts of 80 to 110 ms, each under the 0.3 s minimum, so each got "I didn't catch that. Hold Talk while you speak."; held firmly for 3 s it gave the spoken turn in step 11. Not yet checked through the Pi: the board's Confirm, and a haptic cue sent by the service (the buzz was felt only in the firmware's own bench test; see `hardware/current-build.md`).

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

Set `WALKER_PIPER_MODEL=/opt/steady-walker/voices/en_US-lessac-medium.onnx` in `/etc/steady-walker.env` and restart the service. The service's existing call, `piper --model <voice> --output_file <file>` with the text on its input, works with this version. Check: `echo "Steady is on." | piper --model /opt/steady-walker/voices/en_US-lessac-medium.onnx --output_file /tmp/p.wav && aplay -D default:CARD=Speaker /tmp/p.wav`, then delete `/tmp/p.wav`. Measured: 3.3 to 3.8 s per line on the Pi 5, because Piper loads the voice again for each line. A reply in the server's voice doesn't go through Piper.

### Wi-Fi on any network

The walker needs the internet for the assistant; its offline lines and obstacle cues work without it. The walker page is on Render (<https://steady-walker.onrender.com>), so any computer with a browser can show it, on any network. The Pi itself joins any Wi-Fi network that NetworkManager has saved. There are three ways to give it one:

- **From any computer, with the SD card (`wifi.txt`).** Shut the walker down (one press of the power button), take out the SD card and put it in any computer: its boot partition shows up as a drive called `bootfs`. Open `wifi.txt` there and add a block like this one (illustrative):

  ```text
  name: Venue Guest
  password: the-password
  ```

  Leave the password empty for an open network. Save, eject, put the card back and start the walker. At boot, `walker-wifi.service` runs `walker-wifi-import.sh`, which adds each new block to NetworkManager as a connection called `walker: <name>` and then replaces its password in the file with `(saved)`, so the password doesn't stay on the card. Blocks already `(saved)` are skipped, and comment lines are left alone. Each connection has `ipv4.may-fail yes` and `ipv6.method auto`, so a network that hands out only IPv4 or only IPv6 still counts as connected. Checked on the Pi on 2026-10-24 by running the script on a `wifi.txt` with two dummy networks (one WPA, one open): both were added with those settings, both password lines became `(saved)`, and a second run added nothing. Not yet checked: the service doing it at boot (no reboot test was done), or the walker joining a real network added this way. `test/wifi-import.test.ts` checks the file handling on a Mac against a fake `nmcli`.
- **Over SSH:** `sudo walker-wifi-add.sh` asks for the network's name and its password (not shown as you type) and saves it with `connection.autoconnect-priority 10`, so it's preferred over the phone hotspot when both are in range. It wasn't part of the 2026-10-24 checks.
- **A phone hotspot,** the fallback that works anywhere there's a phone signal. On an iPhone, turn on **Maximize Compatibility** (2.4 GHz, WPA2) and keep the Personal Hotspot screen open while the Pi joins; on 2026-10-24 the Pi didn't join until Maximize Compatibility was on. On that T-Mobile iPhone hotspot the Pi got an IPv4 address (172.20.10.x) and IPv6, and reached Render. A Mac on the same hotspot got no IPv4 address, because macOS honours the hotspot's "IPv6-only preferred" setting; that doesn't affect the Pi.

**Networks that won't work:** ones that need a sign-in web page first (many venue, hotel and campus guest networks), because the walker has no browser to sign in with, and enterprise networks that ask for a username (WPA2-Enterprise, such as eduroam), which these scripts don't set up. Use the phone hotspot there. No venue network has been tried yet.

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
