# Steady ESP32 firmware

**Status, 2026-10-24.** The firmware for the two hand controls and the obstacle sensor board is written and tested on a computer. **None of it has run on an ESP32, a haptic driver or a distance sensor yet.** Every hardware step below is marked *not yet run on hardware*, and every pin, address and timing is an assumption until Max wires a board and checks it. CI compiles both boards against the pinned libraries; that proves the code builds, not that it works on the bench.

Nothing in this firmware can move the arms or the lift. The hand board's only output is the haptic buzz, and the obstacle board has no output at all.

## What is here

| PlatformIO environment | Board | What it does |
| --- | --- | --- |
| `hand` | One ESP32-WROOM-32 per handle (`hand-left-01`, `hand-right-01`) | Reports the **Talk** and **Confirm** buttons, and plays the four haptic cues the Pi asks for. |
| `tof` | One ESP32 (`tof-front-01`) | Reads four VL53L1X time-of-flight distance sensors and reports them as obstacle zones. |
| `native` | Your computer | Runs the unit tests (`pio test -e native`). |

```text
firmware/
  platformio.ini        the three environments, with pinned versions
  lib/protocol/         serial protocol v1 in plain C++ (no Arduino code): builds and reads lines
  lib/module/           board-independent behaviour: hello, heartbeat, replies, haptic cue, buttons, zones
  src/hand/main.cpp     hand board: pins, I2C, the DRV2605L haptic driver
  src/tof/main.cpp      obstacle board: pins, I2C, the multiplexer and the VL53L1X sensors
  src/common/           the USB serial link both boards share
  test/                 expected results, native tests, the scripted session, run-native.sh
```

The split matters: everything that decides what the board says or does lives in `lib/` and has no Arduino code, so it is tested on a computer on a fake clock. `src/` only reads pins and talks to the chips.

## How a board talks to the Pi

Each board is one USB serial port on the Pi, at **115200 baud** (the Pi's `SERIAL_BAUD`). Both sides send one JSON object per line, as defined by the shared serial contract ([`packages/contracts/src/serial.ts`](../packages/contracts/src/serial.ts), described in [docs/interfaces.md](../docs/interfaces.md#pi--esp32-usb-serial)). A line is at most 1,024 bytes including its newline.

- **On boot**, the board sends a `hello` with `seq` 0: its id, its type, what it can do, and its firmware version. The Pi ignores a board until it has said hello.
- **Every second**, it sends a `heartbeat` with its health (`ok`, `degraded` or `fault`) and fault codes. If heartbeats stop for 3 s, the Pi marks the board unavailable.
- **`seq`** goes up by one on every line the board sends and only starts again at 0 when the board restarts, so the Pi can spot a lost line or a restart.
- **When the Pi sends `hello.request`**, the board sends its hello again, keeping its `seq` running, so the Pi knows it is the same board and not a restart. The Pi service asks each board for its hello when it opens the port, again while an unknown board keeps talking, and when a board comes back after going quiet (PR #32), so it doesn't matter whether a board started before or after the Pi.
- **Every line from the Pi gets an answer**: a `haptic.play` gets an `ack` (accepted, or rejected with a reason), anything unreadable gets an `error` with the contract's problem code, and a valid `error` from the Pi gets nothing back. The full table is in [test/EXPECTED.md](test/EXPECTED.md), rows R1 to R16.

Example lines, printed by the firmware's own code in the scripted session on a computer (not captured from a board):

```json
{"v":1,"type":"hello","module_id":"hand-left-01","seq":0,"module_type":"hand","capabilities":["button.talk","button.confirm","haptic"],"firmware_version":"0.1.0","uptime_ms":0}
{"v":1,"type":"hand.input","module_id":"hand-left-01","seq":2,"uptime_ms":128,"button":"talk","edge":"pressed"}
{"v":1,"type":"ack","module_id":"hand-left-01","seq":6,"request_id":"cue-1","result":"accepted","uptime_ms":800}
{"v":1,"type":"perception.zones","module_id":"tof-front-01","seq":1,"uptime_ms":80,"zones":[{"name":"front_left","mm":875,"quality":"valid"},{"name":"front_right","mm":null,"quality":"invalid"},{"name":"left","mm":1200,"quality":"valid"},{"name":"right","mm":null,"quality":"invalid"}]}
```

## Hand control board

### Parts (from [hardware/current-build.md](../hardware/current-build.md))

- ESP32-WROOM-32 USB-C development board. Its USB-C port goes through a USB-to-serial chip on the board; that chip's model isn't recorded yet.
- Two momentary push buttons.
- A DRV2605L haptic driver board. It drives a small vibration motor and has a built-in library of vibration effects; the ESP32 talks to it over **I2C**, a two-wire bus (data SDA and clock SCL) that several chips can share.
- One coin vibration motor. Assumed to be an **ERM** (eccentric rotating mass: a motor spinning an off-centre weight), the usual kind of coin motor. Check the motor's label or listing.

### Wiring (not yet run on hardware)

| ESP32 pin | Goes to | Why |
| --- | --- | --- |
| GPIO32 | Talk button, other leg to GND | The ESP32's internal pull-up holds the pin high; pressing pulls it low. No resistor needed. |
| GPIO33 | Confirm button, other leg to GND | Same. |
| GPIO21 (SDA) | DRV2605L SDA | The core's default I2C data pin. |
| GPIO22 (SCL) | DRV2605L SCL | The core's default I2C clock pin. |
| 3V3 | DRV2605L VIN | The driver board and the motor run from 3.3 V. |
| GND | DRV2605L GND | Common ground. |

The motor's two leads go to the DRV2605L's motor outputs (often labelled `+` and `-`). The DRV2605L's IN/TRIG pin stays unconnected: the firmware uses internal-trigger mode, which ignores it.

Assumptions to check: the DRV2605L board has its own I2C pull-up resistors (Adafruit's does; if yours doesn't, add 4.7 kΩ from SDA and from SCL to 3.3 V); GPIO32 and GPIO33 are free on your board; the motor's current is within what the dev board's 3.3 V regulator can supply alongside the ESP32 (measure it).

### Buttons

A button's level must stay the same for 20 ms (*placeholder, not measured*) before the board reports a `pressed` or `released` edge, which filters out contact bounce. A button already held down when the board starts is ignored until it has been released once, so a stuck button can't start a recording on its own. The buttons are named `talk` and `confirm` on the wire, matching `button.talk` and `button.confirm` in the hello, which is what the Pi expects.

### Haptic cues (AGENTS.md rule 8)

The hand board's only output. What may make it buzz, and what stops it:

- **Authorization:** only a valid `haptic.play` line from the Pi, addressed to this board's id, starts a cue. The Pi sends it from its local cue policy; no cloud or model text reaches the board. A cue addressed to another board, or to `any`, is rejected.
- **Range:** one of four fixed patterns, for 1 to 1,000 ms (`HAPTIC_MAX_DURATION_MS`, a placeholder from the contract). No waveform or strength travels over the wire. The firmware checks the duration twice: once when it reads the line and again in the cue controller.
- **Cancellation:** a newer `haptic.play` replaces the cue playing (no queue). The cue stops when its duration ends.
- **Watchdogs and lost communication:** the cue stops if no valid line has come from the Pi for 3 s (*placeholder*; with the 1 s duration limit the duration always ends it first, so this is a second lock). If the board's main loop stops for 5 s, the ESP32's task watchdog restarts it, and a restart stops the driver first thing. The driver only ever plays finite sequences of its built-in effects, never its real-time mode, so even an ESP32 that froze mid-cue shouldn't leave the motor running: the sequence ends by itself. That is by design, from the datasheet, and not checked on the bench (a freeze can't be caused without changing the code). If the driver answers at boot but fails its setup, the board still tells it to stop and go to standby. While no cue plays, the board checks the driver once a second: a driver that stops answering shows as `haptic_error`, one that lost power and came back in standby is set up again, and the fault clears once the driver answers in internal-trigger mode again.
- **Nothing else drives the motor.** Only the cue controller calls the driver code, and only the driver code writes the DRV2605L's GO register.

If the DRV2605L doesn't answer when the board starts, the hello leaves out `haptic`, the heartbeat says `degraded` with `haptic_missing`, and every `haptic.play` is rejected as `unsupported`, so the Pi falls back to its sound cue.

How each pattern maps to the DRV2605L's built-in effects (effect numbers from the "Waveform Library Effects List" in TI's DRV2605L datasheet). *Placeholders chosen from the effect names; nobody has felt them on the real motor yet.* The board repeats the sequence until the cue's duration ends; each sequence ends with a pause so repeats feel like separate pulses.

| Pattern | Sequence |
| --- | --- |
| `confirmation` | Effect 10, "Double Click 100%", then 200 ms of quiet |
| `recording` | Effect 7, "Soft Bump 100%", then 300 ms |
| `near_obstacle` | Effect 14, "Strong Buzz 100%", then 100 ms |
| `error` | Effect 12, "Triple Click 100%", then 200 ms |

Driver setup, from the datasheet's register map (written in `src/hand/main.cpp`, no third-party library): I2C address 0x5A; device id 7 (DRV2605L) or 3 (DRV2605) checked at boot; internal-trigger mode; effect library 1 ("Library A", for ERM motors) in open loop, as Adafruit's examples use. *Assumptions:* choose the library from the datasheet's table once the motor's rated voltage is known. The drive voltage in ERM open loop comes from the OD_CLAMP register (0x17), which the firmware leaves at its power-on default; check it against the motor's rated voltage with the datasheet's formula before running the motor for long.

## Obstacle sensor board

### Parts

- One ESP32 board. **The inventory lists two ESP32 boards, both assigned to the handles**, so this board needs a third ESP32 (any ESP32-WROOM-32 development board works with `board = esp32dev`) or a handle's board reassigned.
- One TCA9548A I2C multiplexer: a switch that connects the ESP32's I2C bus to one of eight separate channels at a time. It lets four sensors that all answer at the same address share one bus.
- Four TOF400C modules (VL53L1X time-of-flight sensors: each measures distance by timing reflected infrared light).

### Wiring (not yet run on hardware)

| From | To | Notes |
| --- | --- | --- |
| ESP32 GPIO21 (SDA) | TCA9548A SDA | |
| ESP32 GPIO22 (SCL) | TCA9548A SCL | |
| ESP32 3V3 | TCA9548A VIN and each sensor's VIN | Check the TOF400C board accepts 3.3 V (most accept 3.3 to 5 V). |
| ESP32 GND | TCA9548A GND and each sensor's GND | Common ground. |
| TCA9548A A0, A1, A2 | GND | Sets the multiplexer's address to 0x70. |
| TCA9548A channel 0 (SD0, SC0) | `front_left` sensor SDA, SCL | |
| TCA9548A channel 1 (SD1, SC1) | `front_right` sensor | |
| TCA9548A channel 2 (SD2, SC2) | `left` sensor | |
| TCA9548A channel 3 (SD3, SC3) | `right` sensor | |

Each sensor keeps the VL53L1X's default address 0x29 on its own channel, so the XSHUT (shut-down) and GPIO1 (interrupt) pins aren't used; leave them unconnected if the module pulls XSHUT high itself, which most do (check). The channel wires need pull-up resistors: TOF400C modules usually have them on board (check). I2C runs at 100 kHz (*placeholder*), the safe speed for leads whose length isn't measured; raise it to 400 kHz only after the bench shows clean signals.

### Readings

- Each sensor runs in long-distance mode with a 50 ms measurement time, measuring every 50 ms (*placeholders*). The driver is Pololu's VL53L1X library, version 1.3.1.
- The board sends a `perception.zones` line every 80 ms (12.5 Hz, inside the contract's 10 to 20 Hz) with all four zones in a fixed order.
- A zone is `valid` with its distance only when the sensor answered at setup, its last transfer worked, its result is under 250 ms old, its range status is 0 ("valid") or 3 ("closer than the sensor's minimum", counted as valid so a very close object reads near rather than unknown; *an assumption to check*), and the distance is at most 4,000 mm. Anything else is `invalid` with `mm: null`, which the Pi treats as unknown, never as clear. With nothing in front of a sensor, it reads invalid.
- A sensor reads invalid as soon as a transfer fails. It counts as missing once it has produced no result for 500 ms (*placeholder*), whether its transfers fail or it has stopped measuring (for example after a brownout reset it); the board sets up one missing sensor again each second, so a sensor that comes back is back within a few seconds and the loop never waits on more than one sensor's setup.
- Health: every sensor missing gives `fault` with `sensor_missing`; some missing gives `degraded` with `sensor_missing`; a present sensor that is failing or stale adds `sensor_error`.

These are proximity readings for cues, with blind spots and limits, not collision avoidance.

### Zone names

The defaults are `front_left`, `front_right`, `left` and `right`, for channels 0 to 3. To rename one, add a flag to `[env:tof]` in `platformio.ini`, for example:

```ini
build_src_flags = ${board.build_src_flags} '-D WALKER_ZONE_2="left_low"'
```

The build stops if a name isn't snake_case, is over 24 characters, or repeats another.

## Building and flashing (not yet run on hardware)

1. Install PlatformIO Core (`pip install platformio==6.1.19`) or the PlatformIO extension for VS Code. The first build downloads the ESP32 toolchain, about 1.5 GB.
2. Plug in one board with a USB-C cable that carries data, and find its port:

   ```bash
   pio device list
   ```

3. Build and flash it with its id. The id is required: the build stops if `WALKER_MODULE_ID` is missing, empty, `any`, or not lowercase letters, digits and dashes (at most 32 characters). Run these from `firmware/`:

   ```bash
   WALKER_MODULE_ID=hand-left-01 pio run -e hand -t upload
   ```

   ```bash
   WALKER_MODULE_ID=hand-right-01 pio run -e hand -t upload
   ```

   ```bash
   WALKER_MODULE_ID=tof-front-01 pio run -e tof -t upload
   ```

   With more than one board plugged in, add `--upload-port <port>` from step 2. If the upload can't connect, hold the board's BOOT button while it says "Connecting...".
4. Label the board with its id.
5. Check it on its own:

   ```bash
   pio device monitor -b 115200
   ```

   Expect a `hello` with the board's id, then a `heartbeat` every second (and, on the obstacle board, a `perception.zones` line about 12 times a second). Paste `{"v":1,"type":"hello.request","module_id":"any","seq":0}` and press Enter: the board answers with a hello whose `seq` isn't 0. Press each button: one `hand.input` line per press and per release. Press Ctrl-C to leave.
6. Plug the boards into the Pi and follow step 12 of the [Pi service setup](../devices/pi/README.md). The Pi asks each board for its hello when it opens the board's port (#32), so the boards can be plugged in before or after the service starts. Check its log for `module said hello` from each id.

When an ESP32 resets, its built-in boot code prints a few lines of text on the same port before the firmware starts. The Pi logs them as unreadable lines; that is expected.

## Tests

Run every native check with your computer's own C++ compiler (no PlatformIO or ESP32 toolchain needed):

```bash
firmware/test/run-native.sh
```

It runs the unit tests (with the address and undefined-behaviour sanitizers, so any read outside a buffer fails), checks that bad ids and zone names stop the build, and checks that `test/session/transcript.txt` matches what the code prints now. After changing the firmware's output on purpose, run it with `--update` and commit the new transcript. The contract's tests (`pnpm test`) then read that transcript with the real `parseSerialLine` (`packages/contracts/test/firmware-session.test.ts`).

The expected results were written before the code, in [test/EXPECTED.md](test/EXPECTED.md). CI's `firmware` job runs `run-native.sh`, `pio test -e native`, both board builds, and a build with the id `any`, which must fail.

## Bench checklist (not yet run on hardware)

Do these once the boards are wired, and record what you measured in [hardware/current-build.md](../hardware/current-build.md):

1. **Boot:** hello within a second of power-up, then a heartbeat every second.
2. **Buttons:** one press gives exactly one `pressed` and one `released`, including fast taps. Hold a button while plugging in: nothing is reported until you let go and press again.
3. **Haptic:** each of the four patterns feels distinct and lasts its duration; a 1,001 ms request is rejected; a second cue cuts off the first.
4. **Unplug and replug:** the board restarts with a new hello (`seq` 0) in the serial monitor. On the Pi, `module said hello` appears again within about 5 s of plugging back in (the Pi finds the port on its next rescan and asks for a hello). With a cue playing, unplugging stops the motor (the board loses power).
5. **Malformed line:** typing junk in the monitor gives one `error` line and the board keeps working.
6. **Watchdog and a frozen board:** not testable without changing the code; read `enableLoopWDT()` in both programs. The claim that a frozen ESP32 can't leave the motor on rests on the datasheet, not on a test.
7. **Brownout:** run the motor and watch for resets (a new hello with `seq` 0) while the Pi's other USB devices are busy.
8. **Sensors:** a hand at 20 cm, 50 cm and 1 m reads close to those distances; nothing in front reads invalid; unplugging one sensor makes that zone invalid and the heartbeat `degraded` with `sensor_error`, then `sensor_missing`; plugging it back in brings it back within a few seconds.
9. **Timing:** measure the zones rate and the button latency on the Pi's log.

## Assumptions in one place

Pins (GPIO32 Talk, GPIO33 Confirm, GPIO21/22 I2C); I2C at 100 kHz with on-board pull-ups; DRV2605L at 0x5A with id 7 or 3; ERM motor, library 1, open loop, OD_CLAMP at its default; the four effect sequences; TCA9548A at 0x70 with sensors on channels 0 to 3; VL53L1X long mode, 50 ms budget and period; range status 3 counted as valid; 4,000 mm ceiling; 250 ms freshness; 80 ms report interval; 20 ms debounce; 3 s silence stop; 500 ms without a result before a sensor counts as missing; one sensor retried per second; 115200 baud; the ESP32's task watchdog at its default 5 s. Versions: PlatformIO platform `espressif32` 6.12.0 (Arduino-ESP32 core 2.0.17), Pololu VL53L1X 1.3.1, `native` 1.2.1, PlatformIO Core 6.1.19 in CI. Unity, the test framework, is the one PlatformIO picks (`throwtheswitch/Unity@^2.6.1`; 2.6.1 when tested).
