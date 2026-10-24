# Raspberry Pi runtime guide

**For:** the developer integrating Linux, USB, cameras, cloud calls, and physical actions. Home: [`devices/pi/`](../../devices/pi/README.md).

## What is built (2026-10-24)

The always-on service is in [`devices/pi`](../../devices/pi/README.md): TypeScript, bundled by esbuild into one file that Node 22 runs under systemd (`Restart=always`). It is tested on a Mac in simulator mode against a fake cloud, and on 2026-10-24 it **ran on the real Pi 5** for the first time, paired with the server on Render and online ([setup steps and what they showed](../../devices/pi/README.md#set-up-the-pi)). Later that night it recorded from a real USB mic, played through a real USB soundbar (Piper installed for its own lines), heard one ESP32 hand board say hello, and answered one real spoken turn from that board's Talk in about 4 s. The GPIO buttons, Confirm, an obstacle board and a haptic cue sent by the Pi are not yet tested on it. It covers the module manager (serial v1 over the tty file after `stty`, ports found under `/dev/serial/by-id`, `unavailable` after 3 s without a heartbeat), the input manager (two GPIO buttons through `gpiomon`, ESP32 `hand.input`, the simulator keyboard), the audio manager (push-to-talk clips with `arecord`; replies played in the server's voice when it sends one, otherwise Piper or espeak-ng), the local obstacle cue policy, the cloud client (pairing, 5 s heartbeat, configuration, turns, proposals) and the state store. Where it differs from the plan below:

- **Push-to-talk:** hold Talk to talk, release to send; a press while waiting cancels; a press while a reply plays stops it and starts listening. The cloud timeout ends the turn with a spoken offline line built from the configuration and health, and the clip is dropped, never kept for later.
- **Offline:** after 2 failed heartbeats or a turn past 10 s. Heartbeats retry at 5, 10, 15 s.
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

The left-hand ESP32 emits a `hand.input` edge. Pi input manager recognizes a configured push-to-talk action, gives an immediate recording cue, and captures audio with a maximum duration. On release/second press, the Pi uploads a bounded clip; cloud returns text and possibly audio. Pi plays the response and marks the turn complete. If the cloud times out, Pi says/shows “offline, try again” and discards or keeps the clip only according to the consent/retention setting. A second press while recording means stop/cancel according to the chosen interaction design. Ensure there is a way to cancel without precise finger movement.

## Example: local obstacle cue

The perception ESP32 reports `front_left=near` with timestamp and quality. Pi checks freshness, maps it to the user's preferred left-side haptic pattern, and commands the corresponding hand module. If the Pi is not responding, the perception firmware should still be able to issue an immediate local cue through a designed fallback path; the wiring for that path must be specified and bench-tested. Do not document a fallback as working until it is physically wired. The Pi rate-limits repeating cues so they remain understandable.

## Cloud exchange

Use the [API contract](../interfaces.md). The capability manifest, sensor snapshot and action request/status are specified (not implemented) in [`packages/contracts/src/device.ts`](../../packages/contracts/src/device.ts), and the serial envelope in [`serial.ts`](../../packages/contracts/src/serial.ts); a Python runtime needs equivalents that pass the same fixtures. Device credentials are separate from user sessions and can be revoked. Store credentials with restricted filesystem permissions. Validate server TLS and response schemas. Apply timeouts and backoff; do not block the sensor loop on network I/O. Every action has an ID and expiry. The Pi reports `rejected` with a reason when the device lacks a required module, is stopped, or has stale sensors.

## Motion guard

The guard is local, deterministic code and, where possible, hardware interlocks. It maintains an arm/lift state machine, checks limits before every motion segment, and watches feedback during execution. Motors disable on stop input, process crash/watchdog, communication loss, power fault, or limit fault. A physical emergency-stop circuit must work without Linux or cloud. The guard needs documented test limits for each arm and lift; do not guess numbers from a model response.

## First integration checklist

Document exact Pi OS image, power input, connected USB devices, `udev` rules, camera formats, arm driver access, service start command, logs, and safe stop procedure in `devices/pi/README.md`. Bench-test each adapter with recorded fixtures before mounting on a walker. Keep a table of measured CPU, memory, USB throughput, latency, and power with all modules active.
