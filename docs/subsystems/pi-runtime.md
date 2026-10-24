# Raspberry Pi runtime guide

**For:** the developer integrating Linux, USB, cameras, cloud calls, and physical actions. Home: [`devices/pi/`](../../devices/pi/README.md).

## What is built (2026-10-24)

The always-on service is in [`devices/pi`](../../devices/pi/README.md): TypeScript, bundled by esbuild into one file that Node 22 runs under systemd (`Restart=always`). It is tested on a Mac in simulator mode against a fake cloud, and on 2026-10-24 it **ran on the real Pi 5** for the first time, paired with the server on Render and online ([setup steps and what they showed](../../devices/pi/README.md#set-up-the-pi)). Later that night it recorded from a real USB mic, played through a real USB soundbar (Piper installed for its own lines), heard one ESP32 hand board say hello, and answered one real spoken turn from that board's Talk in about 4 s. On 2026-10-24 the Pi discovered both hand boards after switching serial discovery to `/dev/serial/by-path`; a physical two-button role check is still pending. The GPIO buttons, Confirm, and an obstacle board are not yet tested on it. It covers the module manager (serial v1 over the tty file after `stty`, ports found under `/dev/serial/by-path`, `unavailable` after 3 s without a heartbeat), the input manager (two GPIO buttons through `gpiomon`, ESP32 `hand.input`, the simulator keyboard), the audio manager (push-to-talk clips with `arecord`; replies played in the server's voice when it sends one, otherwise Piper or espeak-ng), the local obstacle cue policy, the cloud client (pairing, 5 s heartbeat, configuration, turns, proposals) and the state store. Where it differs from the plan below:

- **Push-to-talk:** hold Talk to talk, release to send; a press while waiting cancels; a press while a reply plays stops it and starts listening. The cloud timeout ends the turn with a spoken offline line built from the configuration and health, and the clip is dropped, never kept for later.
- **Offline:** after 2 failed heartbeats or a turn past 10 s. Heartbeats retry at 5, 10, 15 s.
- **Arm servo bus:** a Feetech STS3215 driver for the SO-101 arms is in [`src/motion/feetech/`](../../devices/pi/src/motion/feetech/README.md) (2026-10-23), tested against Feetech's SDK and a simulated bus only, and not wired into the service.
- **Lift client:** the Pi side of the lift's serial lines is in [`src/motion/lift/`](../../devices/pi/src/motion/lift/README.md) (2026-10-24): hello and configuration check, the heartbeat and hold lease from a tick the coordinator drives, stop and disable, lost-lift handling, and the lift preconditions. Tested against a simulated lift only (`walker simulate --lift`), and not wired into the service or the motion coordinator.
- **Not built in this service:** the camera manager, the action manager and the motion guard. There is no motion command at all; the only module command is `haptic.play`, from the local cue policy or as a short buzz on the hand whose button was pressed.
- **Placeholders, not measured:** every timing and threshold is in `devices/pi/src/constants.ts`, labelled.

## The Pi's job in plain language

The Raspberry Pi 5 is the walker coordinator. It listens to buttons and sensors, knows which modules are actually attached, sends user-initiated requests to the cloud, plays responses, and refuses unsafe or stale action requests. It does not have to run a large language model locally. A cloud outage must not prevent stops, input handling, or basic proximity cues.

## Service layout

One supervised process can host these adapters initially; split processes only when a failure or resource measurement warrants it:

- **Module manager:** discover serial ports by stable USB identity, negotiate protocol, record firmware version and health, reconnect with backoff.
- **Input manager:** turn button edges/trigger state into named user intents. Debounce at firmware and Pi boundaries; avoid duplicate voice starts.
- **Perception manager:** timestamp and validate ToF zones; map them to local alert policy. Invalid and stale measurements are unknown.
- **Audio manager:** capture bounded push-to-talk clips, show record/playback state through cues, and play speech/text fallback. Choose ESP32 or Pi USB audio after bench measurement.
- **Camera manager:** discover overhead and gripper feeds, set resolution/frame rate, check actual codec and USB bandwidth, publish a bounded frame capture interface.
- **Cloud client:** authenticated HTTPS, short timeouts, idempotent retries, configuration fetch, and offline status.
- **Optional GPS bring-up:** an explicit USB serial port is excluded from ESP32 scanning; `walker gps` reads one checksum-verified NMEA RMC fix locally. No service, cloud, or caregiver location flow exists yet. See the [Pi GPS steps](../../devices/pi/README.md#usb-gps-bring-up-local-only).
- **Action manager:** validate cloud task requests against current capabilities and config; ask for user start; execute through a motion guard; publish status.
- **State store:** local config version, device ID, calibration, recent faults, and bounded unsent event queue. Do not store an unlimited transcript or raw camera feed.

Run the service under a supervisor such as systemd with restart policy and a hardware/software watchdog where supported. A process restart must leave motors disabled and require revalidation before any movement.

## Boot and reconnect behavior

1. Start with motor drivers disabled; read local stop input before enabling anything.
2. Load signed/provisioned device identity and last known safe configuration. Check local file integrity and schema version.
3. Enumerate USB modules, perform hello/version handshake, and read health. Missing optional modules produce `degraded`; a missing stop/control path blocks manipulation.
4. Initialize cameras and arm/lift drivers with no motion. Verify homing/calibration only through a safe, explicit procedure.
5. Connect to cloud, reconcile configuration revision and reported capabilities. An internet failure yields `offline` while local alerts remain active.
6. Publish a clear state (`ready`, `degraded`, `offline`, `stopped`) for the web app and local cues. Reconnection never resumes an expired or interrupted motion.

The Pi should maintain a capability manifest based on **detected and healthy** modules, not only the user's selected configuration. For example, if an arm is selected but its camera is unplugged, the manipulation capability is unavailable and the cloud must see that.

## Example: hand button to voice answer

The right-hand ESP32 emits a `hand.input` edge for GPIO32. The Pi treats that as Talk, gives an immediate recording cue, and captures audio with a maximum duration. The left-hand ESP32 uses the same wire event for its GPIO32 control, but the Pi maps it to Confirm. On right-hand Talk release, the firmware requires 250 ms of continuous release and the Pi waits another 900 ms before closing the recording. A re-press from the same hand during that grace continues one recording; a duplicate press while held is ignored. After the grace, the Pi uploads a bounded clip; the cloud returns text and possibly audio, and the Pi plays the response. If the cloud times out, it discards the clip and gives a local offline line. A Talk press after upload while waiting for the answer cancels that turn. Ensure there is a way to cancel without precise finger movement. This side mapping needs a physical two-handle check.

## Example: local obstacle cue

The perception ESP32 reports `front_left=near` with timestamp and quality. Pi checks freshness, maps it to the user's preferred left-side haptic pattern, and commands the corresponding hand module. If the Pi is not responding, the perception firmware should still be able to issue an immediate local cue through a designed fallback path; the wiring for that path must be specified and bench-tested. Do not document a fallback as working until it is physically wired. The Pi rate-limits repeating cues so they remain understandable.

## Cloud exchange

Use the [API contract](../interfaces.md). The capability manifest, sensor snapshot and action request/status are specified (not implemented) in [`packages/contracts/src/device.ts`](../../packages/contracts/src/device.ts), and the serial envelope in [`serial.ts`](../../packages/contracts/src/serial.ts); a Python runtime needs equivalents that pass the same fixtures. Device credentials are separate from user sessions and can be revoked. Store credentials with restricted filesystem permissions. Validate server TLS and response schemas. Apply timeouts and backoff; do not block the sensor loop on network I/O. Every action has an ID and expiry. The Pi reports `rejected` with a reason when the device lacks a required module, is stopped, or has stale sensors.

## Motion guard

The guard is local, deterministic code and, where possible, hardware interlocks. It maintains an arm/lift state machine, checks limits before every motion segment, and watches feedback during execution. Its commands, preconditions, limits, watchdogs and fault reactions are proposed in [`motion.ts`](../../packages/contracts/src/motion.ts) and the [manipulation guide](manipulation.md#commands-agentsmd-rule-8) (not built). On a fault, a lost link or a stop, motion stops and holds: arm goals are set to their measured positions and the lift holds, because a limp arm sags and a disabled lift driver may let the carriage slide; overload and overtemperature release that arm, and the hardware stop cuts power. A crashed Pi can no longer command anything, so each servo goal never leads its measured position by more than a few degrees and the lift ESP32 stops on its own watchdog. The one rule (motion.ts, manipulation guide): motors start only when a person at the walker acts, and the lift moves only while a person holds its control. Every command except a stop starts only from a handle Confirm press on the one pending Confirm target, which the walker shows and says in the Pi's words; the press counts only after the button was seen released for 2 s, all after the target appeared, with no reset of that hand module since. Targets live in memory and are withdrawn on start, on any hand module hello or loss, and when the mode leaves ready. The terminal, the screen and the cloud's id-only offers can only prepare that target, and anyone local can stop. Every lift motion is hold-to-run, held only by the screen's hold control (any pointerup, pointercancel, touchcancel, blur or visibility change releases it), and leased through the lift heartbeat, which the coordinator's control loop sends. The screen's token is readable only by the `sophi-screen` OS user. **Test requirement:** the manifest builder must omit `manipulation.arm` while `MANIFEST_MAY_LIST_ARMS` (motion.ts) is false, because listing it changes demo beat 5's fixed reply. A physical emergency-stop circuit must work without Linux or cloud. The guard needs documented test limits for each arm and lift; do not guess numbers from a model response.

## First integration checklist

Document exact Pi OS image, power input, connected USB devices, `udev` rules, camera formats, arm driver access, service start command, logs, and safe stop procedure in `devices/pi/README.md`. Bench-test each adapter with recorded fixtures before mounting on a walker. Keep a table of measured CPU, memory, USB throughput, latency, and power with all modules active.
