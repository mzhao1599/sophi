# ESP32 firmware guide

**For:** the firmware developer working on hand controls, ToF perception, and voice. Proposed homes: `firmware/hand-controls/`, `firmware/perception/`, `firmware/voice/`.

## How the ESP32s and Pi talk

Each ESP32 is a small controller for one module. It samples local inputs or sensors, gives immediate cues, and exchanges short messages with the Pi over a USB serial connection. The Pi acts as USB host and opens each module's serial port. Depending on the chosen ESP32 board, the port may be native USB CDC or a USB-to-UART chip; both can carry the same messages. Select and document the exact board and pins before writing flash instructions.

The initial message format is newline-delimited JSON; see [interfaces](../interfaces.md) for framing, hello, heartbeat, reports, commands, and errors. Keep serial parsing bounded and nonblocking. An invalid line must not crash firmware or hold a motor/haptic on. The Pi maps stable module IDs to logical roles such as `hand_left`; do not rely on connection order.

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
