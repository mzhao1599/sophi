# ESP32 firmware guide

**For:** the firmware developer working on hand controls, ToF perception, and voice. Home: [`firmware/`](../../firmware/README.md), one PlatformIO project with an environment per board (`hand`, `tof`); voice stays planned in `firmware/voice/`.

**Status, 2026-10-24.** The hand control and obstacle sensor firmware is written (piece 7 of the always-on assistant) and tested on a computer: native unit tests, a scripted session cross-checked line by line against the contract's `parseSerialLine`, and board builds in CI. The left hand ESP32 (`hand-left-01`) was flashed and answered serial commands; its connected control produced a press event and a haptic buzz felt by the owner. The other ESP32 is intended for the right handle, where the physical Talk control belongs. The obstacle firmware has not run on an ESP32. [firmware/README.md](../../firmware/README.md) has the wiring, flashing steps, module ids, bench record, assumptions, and remaining checklist; [firmware/test/EXPECTED.md](../../firmware/test/EXPECTED.md) has the expected behaviour row by row. Decisions made there that this guide left open:

- **Boards and pins:** ESP32-WROOM-32 (`board = esp32dev`, Arduino-ESP32 core 2.0.17 in CI). The left hand board used Arduino-ESP32 core 3.3.5 for its Mac flash. Shared firmware reports GPIO32 as `talk` and GPIO33 as `confirm` on either board, both to ground with the internal pull-up; DRV2605L is on I2C (GPIO21/22). The Pi maps the left board's GPIO32 wire event to Confirm and keeps the right as Talk; this Pi mapping still needs a physical two-handle check. Obstacle: TCA9548A at 0x70 on I2C, VL53L1X sensors on channels 0 to 3 (zones `front_left`, `front_right`, `left`, `right`, renameable at build time). The right hand input and obstacle wiring remain unverified on hardware.
- **Module id:** set per board at build time (`WALKER_MODULE_ID=hand-left-01 pio run -e hand`); the build fails if it is missing or `any`.
- **Lines a module never acts on:** a valid line of a type only modules send (`hello`, `heartbeat`, `hand.input`, `perception.zones`, `ack`) is answered with `error` `unsupported`, without checking its fields. Every other line gets the contract's problem code; a valid `error` from the Pi gets no reply.
- **Destination:** a `haptic.play` for another id (or `any`) is rejected with `invalid_field`; a `hello.request` is answered only for `any` or the module's own id. The Pi service sends `hello.request` when it opens a port (#32), so a board that started first still announces itself.
- **Haptic stop rules:** duration end, a newer cue, 3 s without any valid line from the Pi (placeholder), and reboot. The driver only plays finite built-in effect sequences, so by design (from the datasheet, not bench-checked) a frozen ESP32 shouldn't leave the motor on.

## How the ESP32s and Pi talk

Each ESP32 is a small controller for one module. It samples local inputs or sensors, gives immediate cues, and exchanges short messages with the Pi over a USB serial connection. The Pi acts as USB host and opens each module's serial port. Depending on the chosen ESP32 board, the port may be native USB CDC or a USB-to-UART chip; both can carry the same messages. Select and document the exact board and pins before writing flash instructions.

The initial message format is newline-delimited JSON; see [interfaces](../interfaces.md) for framing, hello, heartbeat, reports, commands, and errors. The v1 shapes are specified in [`packages/contracts/src/serial.ts`](../../packages/contracts/src/serial.ts); a firmware parser must give each line in `packages/contracts/test/fixtures/serial-v1.valid.jsonl` and `serial-v1.invalid.json` the contract's problem code, except that it answers `unsupported` to the types only modules send (above). The firmware's cross-check sends it every fixture line. Keep serial parsing bounded and nonblocking. An invalid line must not crash firmware or hold a motor/haptic on. The Pi maps stable module IDs to logical roles such as `hand_left`; do not rely on connection order.

## Shared firmware responsibilities

- Boot into a safe state: haptics/speaker off, no action latched, valid firmware version and module ID available.
- Send hello with protocol and capabilities; wait for supported Pi configuration. Report a heartbeat and health flags.
- Sample input with debounce/filtering and edge events. Include sequence/boot IDs so the Pi can detect gaps and reboot.
- Validate every incoming command's type, range, duration, and destination; acknowledge acceptance or reject with a reason.
- Use local timers for expirations and a watchdog for firmware lockup. On USB disconnect, drop cloud/Pi-dependent commands and keep only the documented local behavior.
- Avoid dynamic allocations in a high-rate hot path if they cause unpredictable memory use; bound queues and drop/report overflow.
- Provide a documented flash/recovery method, pin map, and a serial-monitor example for each board.

## Hand controls (two modules)

Each side has buttons, a trigger, and a haptic actuator. Report pressed/released edges and bounded trigger values; do not spam every unchanged sample. Map button function at the Pi/profile layer so a user can choose a reachable side. Haptics accept a small allowlist of patterns (confirmation, recording, obstacle near, error) with maximum duration/intensity; no arbitrary waveform supplied by an LLM. Stop/critical controls need priority over ordinary messages. If a physical stop button is placed on a hand module, it must also have a wired path to the actuator disable circuit; USB reporting alone is insufficient.

## Perception module

Wire multiple ToF sensors with addresses/multiplexers as required by the chosen part. Calibrate mounting angle and zone names after installation. Sample at a measured rate, reject out-of-range/low-quality values, and report zone distance plus quality/freshness. Use hysteresis so one noisy sample does not rapidly toggle cues. Define near/far thresholds per sensor after bench tests; do not present them as universal safe stopping distances. Direct local cue behavior on Pi failure requires actual wiring to a buzzer/haptic driver or a tested direct link to hand modules.

ToF sensors have blind spots, reflectivity/environment limits, and possible cross-talk. This module provides proximity **cues**, not a guarantee of collision avoidance. The user must be told when a sensor is missing or faulted.

## Voice module

The requested module has an ESP32, microphone, and speaker. Decide whether the ESP32 digitizes audio and streams it to the Pi, or whether a Pi-compatible USB audio device is used for the first demo. USB serial JSON is suitable for controls/status, not assumed suitable for continuous high-quality audio. If the ESP32 carries audio, define a separate bounded binary framing/USB audio transport and measure sample rate, latency, packet loss, and CPU use. The microphone starts only after user action and a recording cue. Store no persistent audio on the ESP32 by default. Provide text/visual interaction as an alternative for users who cannot or do not want to speak.

## Build and bench notes to keep per target

Each `firmware/<module>/README.md` should include board model/revision, framework/toolchain version, exact wiring and voltage levels, flash command, serial port discovery, config/ID provisioning, expected hello/report examples, failure behavior, and how to update firmware safely. Include a short bench checklist for unplug/replug, malformed line, dropped heartbeat, brownout, stuck button, invalid sensor reading, and watchdog reset. Firmware updates should identify incompatible protocol versions before installation.
