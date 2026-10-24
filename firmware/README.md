# Steady ESP32 firmware

**Status, 2026-10-24.** The firmware for the two hand controls and the obstacle sensor board is written and tested on a computer. One hand board was flashed and answered USB serial commands on a Mac; a temporary P32-to-GND contact reported Talk presses and triggered haptic cues felt by the owner. See the bench record below. The final button is not installed, and the obstacle firmware has not run on a board. CI compiles both boards against the pinned libraries; that proves the code builds, not that it works on the bench.

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

### Wiring (partly checked on one hand board; see bench record)

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

How each pattern maps to the DRV2605L's built-in effects (effect numbers from the "Waveform Library Effects List" in TI's DRV2605L datasheet). The board repeats the sequence until the cue's duration ends. Most patterns include a pause so repeats feel like separate pulses; `near_obstacle` repeats without an added pause to feel more continuous. The peak drive voltage is unchanged.

| Pattern | Sequence |
| --- | --- |
| `confirmation` | Effect 10, "Double Click 100%", then 200 ms of quiet |
| `recording` | Effect 7, "Soft Bump 100%", then 300 ms |
| `near_obstacle` | Effect 14, "Strong Buzz 100%", repeated without an added pause |
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

## Building and flashing

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

### Command the flashed hand board from a computer

Open a serial monitor at **115200 baud** on the board's USB serial port. On the Mac used for the first flash, the working port was `/dev/cu.SLAB_USBtoUART` (the other port, `/dev/cu.usbserial-0001`, did not flash reliably). With `arduino-cli` installed, run:

```bash
arduino-cli monitor --port /dev/cu.SLAB_USBtoUART --config baudrate=115200
```

Set the monitor's line ending to **Newline** if using a graphical monitor. Send this complete line, then press Enter:

```json
{"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":0,"request_id":"bench-1","pattern":"confirmation","duration_ms":150}
```

An `ack` with `"result":"accepted"` means the firmware accepted the command. It does not prove the motor moved; feel or observe the motor to confirm that separately. The other allowed patterns are `recording`, `near_obstacle`, and `error`; duration must be 1–1000 ms. Use a new `request_id` for each command. Press Ctrl-C to close the terminal monitor before another program opens the port. Later, the Pi sends these same contract messages over USB.

The planned P32 Talk input expects a momentary contact to GND, with the internal pull-up enabled. It is not yet a general capacitive-touch interface. If the eventual touch sensor has an active-high digital output, update and verify the input handling before connecting it.

For a **press → buzz bench test**, close any serial monitor and run this from the repository root after reconnecting the board:

```bash
python3 firmware/tools/press_to_haptic.py --port /dev/cu.SLAB_USBtoUART
```

The script uses only Python's standard library on macOS or Linux. It asks the board for `hello`, checks that `hand-left-01` advertises `haptic`, then sends one 1000 ms `near_obstacle` cue for each `talk` or `confirm` **pressed** event. This is the strong pattern already felt in the first bench check; a 150 ms `confirmation` cue was accepted after a P32 press but was not felt. Release events and heartbeats do not buzz. The script prints each press and the board's acknowledgement. Press Ctrl-C to stop; unplugging the board also ends the script. To use a right-hand board, pass `--module-id hand-right-01` with its serial port. This is a computer bench loopback, not the Pi's local cue policy.

The script's framing and press-to-cue behavior can be checked without a board using `python3 -m unittest discover -s firmware/tools`.

### First hand-board bench record (2026-10-24)

- Board: Teyleten ESP32-WROOM-32 38-pin USB-C board; CP2102 USB-to-UART bridge identified by macOS; ESP32-D0WD-V3 revision 3.1 reported during upload.
- Build: existing hand source, module ID `hand-left-01`, compiled with the locally installed Arduino-ESP32 core 3.3.5 and Arduino CLI 1.2.0 because PlatformIO was unavailable on this Mac. This is a separate build environment from the pinned PlatformIO core 2.0.17 used in CI.
- Flash: `/dev/cu.SLAB_USBtoUART`; uploader reported hashes verified for bootloader, partitions, boot app, and firmware, then reset the board.
- Reflash, 2026-10-24 23:42 PDT: rebuilt with the pinned PlatformIO environment (`WALKER_MODULE_ID=hand-left-01 pio run -e hand`) with the press patterns changed to Strong Buzz, and flashed from the walker's Pi over USB with esptool 5.6.0 (bootloader 0x1000, partitions 0x8000, boot_app0 0xe000, app 0x10000; all hashes verified). The board said hello to the Pi service as `hand-left-01`. The old `recording` (Soft Bump) buzz couldn't be felt on a Talk press; the new one could. Still the stock 100% effects in open loop: a stronger buzz needs the driver's voltage settings raised, which waits for the motor's voltage, current and temperature to be measured.
- Serial: a `hello.request` received a `hello` advertising `button.talk`, `button.confirm`, and `haptic`; subsequent heartbeats reported `health: ok`. A 150 ms `confirmation` request received `ack` `accepted`.
- Haptic feel: the owner felt the 1000 ms `near_obstacle` cue when P32 was touched to GND. After the no-pause `near_obstacle` firmware was flashed, the owner reported that it felt stronger. The computer loopback received press events and `accepted` acknowledgements; the serial session was then stopped.
- Motor: the owner identified the [VAKTOK 10 mm coin motor listing](https://www.amazon.com/dp/B0CC4LXNMZ), which advertises a 3 V rating. The DRV2605L's peak drive setting was not raised. Measure actual motor voltage, current, and temperature before sustained use; the listing does not establish those operating values in this wiring.
- Still unverified: motor voltage/current/temperature, all other cue patterns and durations, the final P32 button and P33 Confirm input, reconnect behavior, and operation with the Pi. The DRV2605L responded to firmware initialization, but its breakout revision was not recorded.

## Tests

Run every native check with your computer's own C++ compiler (no PlatformIO or ESP32 toolchain needed):

```bash
firmware/test/run-native.sh
```

It runs the unit tests (with the address and undefined-behaviour sanitizers, so any read outside a buffer fails), checks that bad ids and zone names stop the build, and checks that `test/session/transcript.txt` matches what the code prints now. After changing the firmware's output on purpose, run it with `--update` and commit the new transcript. The contract's tests (`pnpm test`) then read that transcript with the real `parseSerialLine` (`packages/contracts/test/firmware-session.test.ts`).

The expected results were written before the code, in [test/EXPECTED.md](test/EXPECTED.md). CI's `firmware` job runs `run-native.sh`, `pio test -e native`, both board builds, and a build with the id `any`, which must fail.

## Remaining bench checklist

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
