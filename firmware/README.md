# Sophi ESP32 firmware

**Status, 2026-10-24.** The firmware for the two hand controls and the obstacle sensor board is written and tested on a computer. The first hand board was flashed and answered USB serial commands on a Mac; its connected control reported a press and triggered a haptic cue felt by the owner. It was later identified as the physical right board, reflashed as `hand-right-01`, and verified on the Pi. Both hand boards now announce distinct IDs to the Pi. The ToF firmware was flashed to the assembled board and reported four missing sensors; I²C diagnosis is ongoing. CI builds these images against pinned libraries, which does not establish working sensor readings.

The normal lift firmware and Pi coordinator exist but have not controlled the assembled lift. A separate bounded bench jog image did rotate the motor and move the coupled carriage slightly; see [hardware/current-build.md](../hardware/current-build.md). The `lift_tof_demo` image announced both virtual modules over Mac USB and reported valid distances from the two selected sensors. A later 5 → 6 mm software move completed while driver power was off; its incorrect stored count was reset to the owner-confirmed 5 mm starting point. The ESP32 was temporarily flashed with `i2c_diagnostic` to investigate a low SCL line, then restored to `lift_tof_demo` after both sensor channels answered again. The Pi motion coordinator is now enabled and reports `ready`; two Confirm/hold attempts did not start motion. The existing direct bench tool later moved the coupled carriage from 5 to 10 to 30 mm while the walker service temporarily released the USB port; the owner observed the expected upward travel. See [hardware/current-build.md](../hardware/current-build.md).

## What is here

| PlatformIO environment | Board | What it does |
| --- | --- | --- |
| `hand` | One ESP32-WROOM-32 per handle (`hand-left-01`, `hand-right-01`) | Reports the **Talk** and **Confirm** button inputs, and plays the four haptic cues the Pi asks for. The intended physical Talk control is on the right handle. |
| `tof` | One ESP32 (`tof-front-01`) | Reads four VL53L1X time-of-flight distance sensors and reports them as obstacle zones. |
| `lift` | One ESP32-WROOM-32 (`lift-01`) | Drives the lift's stepper driver (STEP, DIR, ENA) and reads its two end switches and the stop's sense contact; moves only while the Pi's heartbeat holds the request. |
| `lift_tof_demo` | The as-wired single ESP32 | Reports lift and two ToF zones on one USB port. Uses an estimated, journaled lift position without a home switch; the scale and upward direction still need physical verification. |
| `i2c_diagnostic` | Combined ToF/lift ESP32, temporarily | Scans mux channel 2, 3, 6 and 7 without moving the lift. |
| `lift_jog` | Current combined board, temporarily | Allows supervised, bounded stepper pulses for bench checks. |
| `native` | Your computer | Runs the unit tests (`pio test -e native`). |

```text
firmware/
  platformio.ini        production, bench and native environments, with pinned versions
  lib/protocol/         serial protocol v1 in plain C++ (no Arduino code): builds and reads lines, the lift's too
  lib/module/           board-independent behaviour: hello, heartbeat, replies, haptic cue, buttons, zones
  lib/lift/             the lift's behaviour: commands, hold lease, homing, switches, step math
  src/hand/main.cpp     hand board: pins, I2C, the DRV2605L haptic driver
  src/tof/main.cpp      obstacle board: pins, I2C, the multiplexer and the VL53L1X sensors
  src/lift/             lift board: pins and build settings, FastAccelStepper, the inputs
  src/common/           the USB serial link every board shares
  tools/                bench loopbacks from a computer (press_to_haptic.py, lift_bench.py)
  test/                 expected results, native tests, the scripted sessions, run-native.sh
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

### Physical side assignment

The ESP32 tested on the Mac was provisioned as `hand-left-01`, but the owner later confirmed that board is physically mounted on the **right** handle. On 2026-10-24 it was reflashed as `hand-right-01`; the app image was verified on the board. The other physical board reports `hand-left-01`. The physical **Talk** control is on the **right** handle. Shared ESP32 firmware reports a GPIO32 press as `button: "talk"` on either board; the Pi maps that wire event from `hand-left-*` to **Confirm** while keeping the right side as Talk. Both boards announced distinct IDs to the Pi after deployment, but the physical two-button role check is still pending. Keep each board labeled with its provisioned ID rather than identifying it by USB port order.

### Parts (from [hardware/current-build.md](../hardware/current-build.md))

- ESP32-WROOM-32 USB-C development board. The tested left board uses a CP2102 USB-to-serial bridge; confirm the right board's bridge when connected.
- Two momentary push buttons.
- A DRV2605L haptic driver board. It drives a small vibration motor and has a built-in library of vibration effects; the ESP32 talks to it over **I2C**, a two-wire bus (data SDA and clock SCL) that several chips can share.
- One coin vibration motor. Assumed to be an **ERM** (eccentric rotating mass: a motor spinning an off-centre weight), the usual kind of coin motor. Check the motor's label or listing.

### Wiring (partly checked on one hand board; see bench record)

| ESP32 pin | Goes to | Why |
| --- | --- | --- |
| GPIO32 | Handle control, other leg to GND | Firmware reports `talk` on the wire. The Pi interprets it as Confirm for `hand-left-*` and Talk for the right handle. The internal pull-up holds the pin high; pressing pulls it low. No resistor needed. |
| GPIO33 | Confirm button, other leg to GND | Same. |
| GPIO21 (SDA) | DRV2605L SDA | The core's default I2C data pin. |
| GPIO22 (SCL) | DRV2605L SCL | The core's default I2C clock pin. |
| 3V3 | DRV2605L VIN | The driver board and the motor run from 3.3 V. |
| GND | DRV2605L GND | Common ground. |

The motor's two leads go to the DRV2605L's motor outputs (often labelled `+` and `-`). The DRV2605L's IN/TRIG pin stays unconnected: the firmware uses internal-trigger mode, which ignores it.

Assumptions to check: the DRV2605L board has its own I2C pull-up resistors (Adafruit's does; if yours doesn't, add 4.7 kΩ from SDA and from SCL to 3.3 V); GPIO32 and GPIO33 are free on your board; the motor's current is within what the dev board's 3.3 V regulator can supply alongside the ESP32 (measure it).

### Buttons

A hand button must stay down for 20 ms before the board reports `pressed`. Once held, it must stay released for 250 ms before the board reports `released`. The longer release filter was added after the Pi logged repeated right-button releases followed by new presses only 65–170 ms later during an intended hold on 2026-10-24; each new press restarted the microphone. Both values are prototype choices, not a measurement of the switch's bounce specification. Release now reaches the Pi about 250 ms after the physical action. A button already held when the board starts is ignored until it has been released once, so a stuck button cannot start a recording on its own. The buttons are named `talk` and `confirm` on the wire, matching `button.talk` and `button.confirm` in the hello. If a hold still splits into multiple presses, inspect the GPIO32-to-button-to-GND wiring and strengthen the pull-up instead of increasing this delay indefinitely.

Firmware `0.1.1` with this filter was flashed to both physical handles on 2026-10-24; each app image was read back and verified. The Pi then logged `hand-right-01` and `hand-left-01`, both version `0.1.1` and healthy. The owner's repeat-hold check is pending.

### Haptic cues (AGENTS.md rule 8)

The hand board's only output. What may make it buzz, and what stops it:

- **Authorization:** only a valid `haptic.play` line from the Pi, addressed to this board's id, starts a cue. The Pi sends it from its local cue policy; no cloud or model text reaches the board. A cue addressed to another board, or to `any`, is rejected.
- **Range:** one of four fixed patterns, for 1 to 1,000 ms (`HAPTIC_MAX_DURATION_MS`, a placeholder from the contract). No waveform or strength travels over the wire. The firmware checks the duration twice: once when it reads the line and again in the cue controller.
- **Cancellation:** a newer `haptic.play` replaces the cue playing (no queue). The cue stops when its duration ends.
- **Watchdogs and lost communication:** the cue stops if no valid line has come from the Pi for 3 s (*placeholder*; with the 1 s duration limit the duration always ends it first, so this is a second lock). If the board's main loop stops for 5 s, the ESP32's task watchdog restarts it, and a restart stops the driver first thing. The driver only ever plays finite sequences of its built-in effects, never its real-time mode, so even an ESP32 that froze mid-cue shouldn't leave the motor running: the sequence ends by itself. That is by design, from the datasheet, and not checked on the bench (a freeze can't be caused without changing the code). If the driver answers at boot but fails its setup, the board still tells it to stop and go to standby. While no cue plays, the board checks the driver once a second: a driver that stops answering shows as `haptic_error`, one that lost power and came back in standby is set up again, and the fault clears once the driver answers in internal-trigger mode again.
- **Nothing else drives the motor.** Only the cue controller calls the driver code, and only the driver code writes the DRV2605L's GO register.

If the DRV2605L doesn't answer when the board starts, the hello leaves out `haptic`, the heartbeat says `degraded` with `haptic_missing`, and every `haptic.play` is rejected as `unsupported`, so the Pi falls back to its sound cue.

How each pattern maps to the DRV2605L's built-in effects (effect numbers from the "Waveform Library Effects List" in TI's DRV2605L datasheet). The board repeats the sequence until the cue's duration ends. On the tested coin motor, the earlier click and soft-bump effects were not felt on the Pi, so the current patterns use Strong Buzz with different gaps and counts. The peak drive voltage is unchanged.

| Pattern | Sequence |
| --- | --- |
| `confirmation` | Two effect 14 Strong Buzz pulses, 120 ms apart, then 250 ms of quiet |
| `recording` | Effect 14 Strong Buzz, then 300 ms of quiet |
| `near_obstacle` | Effect 14, "Strong Buzz 100%", repeated without an added pause |
| `error` | Three effect 14 Strong Buzz pulses, 60 ms apart, then 250 ms of quiet |

Driver setup, from the datasheet's register map (written in `src/hand/main.cpp`, no third-party library): I2C address 0x5A; device id 7 (DRV2605L) or 3 (DRV2605) checked at boot; internal-trigger mode; effect library 1 ("Library A", for ERM motors) in open loop, as Adafruit's examples use. *Assumptions:* choose the library from the datasheet's table once the motor's rated voltage is known. The drive voltage in ERM open loop comes from the OD_CLAMP register (0x17), which the firmware leaves at its power-on default; check it against the motor's rated voltage with the datasheet's formula before running the motor for long.

## Obstacle sensor board

### Parts

- One ESP32 board. **The inventory lists two ESP32 boards, both assigned to the handles**, so this board needs a third ESP32 (any ESP32-WROOM-32 development board works with `board = esp32dev`) or a handle's board reassigned.
- One TCA9548A I2C multiplexer: a switch that connects the ESP32's I2C bus to one of eight separate channels at a time. It lets four sensors that all answer at the same address share one bus.
- Four TOF400C modules (VL53L1X time-of-flight sensors: each measures distance by timing reflected infrared light).

### Wiring (not yet run on hardware)

| From | To | Notes |
| --- | --- | --- |
| ESP32 GPIO22 (SDA) | TCA9548A SDA | As soldered on the current ToF board; not the ESP32 default. |
| ESP32 GPIO21 (SCL) | TCA9548A SCL | As soldered on the current ToF board; not the ESP32 default. |
| ESP32 3V3 | TCA9548A VIN and each sensor's VIN | Check the TOF400C board accepts 3.3 V (most accept 3.3 to 5 V). |
| ESP32 GND | TCA9548A GND and each sensor's GND | Common ground. |
| TCA9548A A0, A1, A2 | GND | Sets the multiplexer's address to 0x70. |
| TCA9548A channel 2 (SD2, SC2) | Right sensor | Answers at 0x29 and ranges when pointed at a nearby target. |
| TCA9548A channel 3 (SD3, SC3) | Left sensor | Answers at 0x29 and ranges when pointed at a nearby target. |
| TCA9548A channel 6 (SD6, SC6) | Sensor slot 2 | Connected, but no ACK at 0x29 in the latest scan. |
| TCA9548A channel 7 (SD7, SC7) | Sensor slot 3 | Currently disconnected. |

Each sensor keeps the VL53L1X's default address 0x29 on its own channel, so the XSHUT (shut-down) and GPIO1 (interrupt) pins aren't used; leave them unconnected if the module pulls XSHUT high itself, which most do (check). The channel wires need pull-up resistors: TOF400C modules usually have them on board (check). I2C runs at 100 kHz (*placeholder*), the safe speed for leads whose length isn't measured; raise it to 400 kHz only after the bench shows clean signals.

### Readings

- Each sensor runs in long-distance mode with a 50 ms measurement time, measuring every 50 ms (*placeholders*). The driver is Pololu's VL53L1X library, version 1.3.1.
- The board sends a `perception.zones` line every 80 ms (12.5 Hz, inside the contract's 10 to 20 Hz) with all four zones in a fixed order.
- A zone is `valid` with its distance only when the sensor answered at setup, its last transfer worked, its result is under 250 ms old, its range status is 0 ("valid") or 3 ("closer than the sensor's minimum", counted as valid so a very close object reads near rather than unknown; *an assumption to check*), and the distance is at most 4,000 mm. Anything else is `invalid` with `mm: null`, which the Pi treats as unknown, never as clear. With nothing in front of a sensor, it reads invalid.
- A sensor reads invalid as soon as a transfer fails. It counts as missing once it has produced no result for 500 ms (*placeholder*), whether its transfers fail or it has stopped measuring (for example after a brownout reset it); the board sets up one missing sensor again each second, so a sensor that comes back is back within a few seconds and the loop never waits on more than one sensor's setup.
- In the combined `lift_tof_demo` image, a missing sensor stays missing until the ESP32 reboots. Its full reinitialization can block long enough to trip the lift task watchdog on flaky wiring; the lift control loop takes priority. An invalid zone is unknown, never a clear path.
- Health: every sensor missing gives `fault` with `sensor_missing`; some missing gives `degraded` with `sensor_missing`; a present sensor that is failing or stale adds `sensor_error`.

These are proximity readings for cues, with blind spots and limits, not collision avoidance.

### Zone names

The two-sensor `lift_tof_demo` image reports `right` from channel 2 and `left` from channel 3, as the owner identified their intended mounting sides. The four-sensor `tof` image retains slot names `front_left`, `front_right`, `left` and `right` on channels 2, 3, 6 and 7; use it only after those physical directions are verified. To rename a slot, add a flag to its PlatformIO environment, for example:

```ini
build_src_flags = ${board.build_src_flags} '-D WALKER_ZONE_2="left_low"'
```

The build stops if a name isn't snake_case, is over 24 characters, or repeats another.

## I²C diagnostic image

`i2c_diagnostic` is a temporary read-only image for the combined board. With the lift driver's 12 V **off**, flash `WALKER_MODULE_ID=tof-front-01 pio run -e i2c_diagnostic -t upload --upload-port <port>`, then read USB serial at 115200 baud. Every two seconds it probes mux address 0x70 and, when that answers, selects channels 2, 3, 6 and 7 and probes sensor address 0x29. Arduino Wire error `0` means acknowledged, `2` means no device acknowledged, and `5` means a bus timeout. In the latest observed wiring, channels 2 and 3 acknowledged; the sensor physically connected on channel 6 did not, and channel 7 was disconnected. A failed scan alone does not establish a damaged sensor. Reflash `lift_tof_demo` before returning this combined board to the Pi service.

## One-off lift position reseed

**No-switch demo only.** Support the carriage independently and turn the driver's 12 V off before reseeding. With the walker service stopped, build `WALKER_MODULE_ID=lift-01 WALKER_LIFT_REBASE_MM=<reference-mm> pio run -e lift_tof_rebase`, where the chosen reference is from 5 to 950 mm. Flash that image to the identified combined board, then restore the normal `lift_tof_demo` image before restarting the service. The temporary image writes `valid=false`, the new step count, then `valid=true` in NVS; a write failure leaves the estimate unusable. Check `walker lift status` reports the chosen reference after restoring normal firmware. On 2026-10-25 this process reseeded 650 mm, then temporarily 100 mm, then **650 mm** again after the owner corrected the current-pose estimate. The last 650 mm write and restoration of the normal 32-microstep image both passed flash verification; a read-only serial status reported 650.0 mm. This is a software reference, not a measured distance from the bottom or a measurement of remaining physical travel. The 5–950 mm software range does not establish physical clearance after an arbitrary rebase. Never run the service with the reseed image installed: it would overwrite the estimate again on each boot.

## Supervised lift jog image

`lift_jog` is the bounded bench image used with the current combined ToF/stepper ESP32. It is **not** the normal `lift` controller, knows no height, reads no end switch, and must never be used for an unattended move. The driver has a separate 12 V feed; leave it off while flashing. `WALKER_MODULE_ID=lift-01 pio run -e lift_jog -t upload --upload-port <port>` flashes the image. With the carriage observed, driver power on, and travel clear, `python3 tools/lift_jog_host.py --port <port> --direction 0 --steps 320 --repeat 1` sends one bounded segment; `--repeat 4` sends four (1280 pulses total), each separately acknowledged. `--direction 0` is the expected upward polarity based on a downward level-1 bench observation, but it still needs a short physical direction check before repeats. The board stops if keepalive is lost for 200 ms, after 5 seconds, or after 320 pulses; the host sends STOP on exit. Pulse count is **not millimetres** until the driver microstep setting is confirmed. Reflash `lift_tof_demo` before reconnecting this shared board to the Pi.

## Lift board

**Status, 2026-10-24:** the normal lift firmware below remains untried on the assembled device. Separate bounded bench pulses on the shared ESP32 made the uncoupled motor rotate and the coupled carriage move slightly downward; see the bench record in hardware/current-build.md. No end switch or stop is fitted. The firmware implements rules 1 to 10 in the header of [`lift-serial.ts`](../packages/contracts/src/lift-serial.ts) (the contract, PR #71); the expected behaviour is in [test/EXPECTED.md](test/EXPECTED.md#lift-board-lift-01), rows LS to LB. The Pi's lift client ([`devices/pi/src/motion/lift/`](../devices/pi/src/motion/lift/README.md)) is driven by the Pi's motion coordinator (held on the walker's screen, started by a Confirm press), tested only against a simulated lift; until the Pi's bench steps ([devices/pi/README.md](../devices/pi/README.md#the-lift-under-the-motion-coordinator)), the lift moves only from the bench tool below.

### What it does (AGENTS.md rule 8)

The lift is a NEMA 17 stepper turning a 5 mm-per-turn ball screw that raises a carriage on two rails. A stepper moves one small step for each pulse on the driver's STEP (PUL) input, in the direction set by DIR, while ENA lets the driver hold or free the motor. This board makes those pulses and counts them; the count is the height (there is no height sensor).

- **Authorization and user initiation.** It moves only for a `lift.home` or `lift.move` from the Pi, addressed to `lift-01`, with a sequence number above the last one it accepted, whose request id it has never accepted before, and only while the Pi's heartbeat (every 100 ms) names that request as the one a person is holding the screen's hold control for. The Pi decides whether a person started it; this board checks every command again.
- **Range and speed.** Soft limits 5 to 600 mm above the bottom switch, 20 mm/s and 50 mm/s², built into the firmware, reported in `lift.hello`, checked at build time against the contract's ceilings (50 mm/s, 200 mm/s²). Nothing over serial changes them. *(Placeholders: the usable travel, the top switch position and the speed without lost steps are not measured.)*
- **Cancellation.** Letting go (the next heartbeat names nobody), `lift.stop` (always accepted), or a `hello.request` ramps down at 200 mm/s² and holds. A request that stopped never resumes. `lift.enable` `false` stops stepping at once and frees the motor, but only with the carriage on the bottom switch, or on a build made disable-safe (`WALKER_LIFT_DISABLE_SAFE=1`) after a recorded passed drop test or with a brake fitted; anywhere else it is refused `disable_unsafe`, the driver keeps holding, and any motion ramps down as for a stop (rule 6).
- **Watchdog and lost link.** No heartbeat for 300 ms: it ramps down, holds, and latches `watchdog_expired`. The driver stays enabled, so the motor keeps holding the carriage (`LIFT_WATCHDOG_DRIVER_ACTION` `hold`). If the board's loop stops for 1 s, the ESP32's task watchdog restarts it (set to 1 s in `setup()`; the core's default is 5 s); a restart stops the pulses and, wired as below, leaves the driver enabled. Until that reset, a running move keeps going towards its target, because the pulses come from hardware timers and FastAccelStepper's own task, not the loop: for up to 1 s nothing checks the lease or the switches (the hardware stop still cuts STEP).
- **Switches and the stop.** Either end switch pressing while homed stops stepping at once (`limit_hit`); both at once means a wiring fault (`limit_wiring`). The hardware stop switch cuts the STEP signal itself, outside the firmware; a second contact on it tells the board (stop-sense), which latches `stop_circuit_opened`. Every fault clears homed: the lift must home again.

### Parts (from [hardware/current-build.md](../hardware/current-build.md))

- One ESP32-WROOM-32 development board, provisioned `lift-01`. The inventory's two ESP32s are the hand boards, so this is a third board.
- An Ophiner TB6600-type step/dir driver (9 to 42 V; opto-isolated PUL, DIR and ENA inputs).
- A STEPPERONLINE 17HS19-2004S1 NEMA 17 (2.0 A per phase, 1.8°, so 200 full steps a turn).
- The RM1605 ball screw (5 mm a turn) and HGR20 rails.
- Two roller limit switches with normally open (NO), normally closed (NC) and common (C) terminals; one at the bottom (home), one at the top.
- The hardware stop: a latching switch with two normally closed contacts, one to cut STEP and one for stop-sense (the switch itself is not chosen yet).

### Wiring (not yet run on hardware)

Signals use the "common cathode" wiring: every `-` input of the driver goes to the ESP32's GND, and each `+` input is driven by a GPIO, so a GPIO at 3.3 V pushes current through that input's opto-coupler and 0 V doesn't.

| ESP32 pin | Goes to | Why this pin |
| --- | --- | --- |
| GPIO33 | Stop switch contact 1 (NC), then the driver's PUL+ | STEP. A plain output, not a strapping pin, so it is low and quiet while the ESP32 boots. The stop switch opens this line, so no pulse reaches the driver while the stop is pressed. |
| GPIO25 | DIR+ | DIR. A plain output. |
| GPIO26 | ENA+ | ENA. A plain output; floating while the ESP32 resets, which (with no current through ENA) leaves a typical TB6600 enabled and holding. |
| GPIO32 | Bottom switch C; the switch's NC to GND | Home switch. Closed (released) reads LOW, pressed or a cut wire reads HIGH, so a broken wire stops the lift. |
| GPIO27 | Optional top switch C; NC to GND | The current build does not fit this switch; the configured firmware does not read it. |
| GPIO13 | Stop switch contact 2 (NC) to GND | Stop-sense. Read on an interrupt, so a quick tap is caught. |
| GND | PUL-, DIR-, ENA-, both switches' NC, the stop-sense contact | Common ground for the signals only. The motor supply's ground stays on the driver's power side. |

**Each switch and stop-sense line also gets an external pull-up and a capacitor at the ESP32 end:** 1 to 4.7 kΩ from the pin to 3.3 V, and about 100 nF from the pin to GND. The internal pull-ups (about 45 kΩ) are too weak for leads that run the length of the rail past the stepper's wiring: noise could read as pressed (a spurious stop, which is safe) or hold a pin low (a missed press, which isn't). The capacitor slows the edge by well under a millisecond with these values. The firmware also wants two pressed samples in a row (about 2 ms) before homing counts the bottom switch as tripped; any switch pressing still stops homed motion on its first sample.

Pins avoided, as rule 1 requires: the strapping pins GPIO 0, 2, 5, 12 and 15 (their level at reset changes how the ESP32 boots, and some pulse during boot), the flash pins GPIO 6 to 11, GPIO 34 to 39 (inputs only, no pull-ups), and GPIO 1 and 3 (the USB serial port). The build checks this (`src/lift/build_settings.h`).

The motor's four wires go to the driver's A+, A-, B+ and B- (one coil to A, the other to B, per the motor's datasheet), and the driver's power input to the 12 V lift branch with its own fuse. **Assumptions to check:** that this TB6600 unit's inputs switch reliably at 3.3 V (many are specified for 5 V; if pulses are missed, drive them through a 5 V buffer such as a 74HCT245, or ULN-style transistors); that its PUL input accepts FastAccelStepper's pulse width; and the switch's NC terminal markings.

### The hardware stop (documented, not firmware)

The stop is a physical switch that works without the ESP32, the Pi or the cloud:

1. **It cuts STEP, never ENA.** Contact 1 sits in the wire from GPIO33 to PUL+. Pressed, the driver gets no pulses, so the motor holds the carriage (it stays powered and enabled) but cannot step. ENA is never wired through the stop, because freeing the motor could let the loaded carriage slide down the ball screw.
2. **Contact 2 tells the board** (GPIO13): the board latches `stop_circuit_opened` and refuses moves (`stop_pressed`). The steps it sent while the stop cut them were counted but never taken, so the height is no longer known and the lift must home again.
3. **Cutting the lift's motor power** (rather than only STEP) is allowed only after the drop test below has passed, or with a brake fitted, and is recorded in the installation record (`stop_cuts_lift_power`, motion.ts).

### Driver settings (DIP switches) to start with

- **Current demo calibration:** the image reports 32 microsteps. The owner measured 350 mm of upward travel for a spoken 100 mm upward request with that image. `lift_tof_demo` now multiplies the nominal 1,280 pulses/mm by **2/7**, yielding about 365.7 pulses/mm. The same ratio applies to speed and acceleration. This corrects the measured 3.5× travel error; recheck it with a short observed move. The driver DIP table is still unverified. `lift.hello` reports the microstep setting, while this demo-only calibration is documented here and compiled into the image.
- **Current:** the lowest setting on the unit's printed table that still lifts the measured load, and never above the motor's 2.0 A. For the decoupled bench steps below, start at the lowest setting. Record it (`driver_current_setting`). The lift's computed thrust is a crushing force (motion.ts), which is why the current stays low and pinch guards are required.

### Build settings

Set in `[env:lift]` in `platformio.ini` (or as `-D` flags); the build stops on a value outside the allowed ones.

| Setting | Default | Meaning |
| --- | --- | --- |
| `WALKER_LIFT_MICROSTEPS` | 32 | Inferred from the observed fourfold distance mismatch; valid values are 1, 2, 4, 8, 16 or 32. Confirm with a measured short move. |
| `WALKER_LIFT_SCALE_NUMERATOR` / `WALKER_LIFT_SCALE_DENOMINATOR` | 2 / 7 in `lift_demo`, 1 / 1 otherwise | Multiplies the nominal pulses per mm. The demo value comes from the owner's 100 mm command → 350 mm measured travel. Existing NVS step counts are converted at boot to preserve their software position reference. |
| `WALKER_LIFT_ENA_ENABLE_LEVEL` | 0 | The GPIO26 level that leaves the driver **enabled** (holding). 0 suits a driver whose ENA is an active-disable input, the usual TB6600: a resetting ESP32 (pin floating) then leaves it holding. Check it (below). If the unit only holds with current through ENA, **rewire, don't rebuild**: an inverter, or a pull-up that keeps ENA enabled while the pin floats. Level 1 builds only together with `WALKER_LIFT_HW_INVERTER=1`, which says that hardware is fitted. |
| `WALKER_LIFT_HW_INVERTER` | 0 | 1 only when ENA is wired through an inverter or pull-up as above; allows `WALKER_LIFT_ENA_ENABLE_LEVEL=1`. |
| `WALKER_LIFT_DIR_UP_LEVEL` | 1 | GPIO25 (DIR+) level observed moving the carriage **up** when the owner asked for an upward move. The prior level 0 made a downward request physically move up. |
| `WALKER_LIFT_STOP_SENSE` | 1 | 1: the stop's second contact is wired to GPIO13. 0 only on a bench without it: `lift.hello` then says `not_wired`, and the Pi refuses motion outside bench mode. |
| `WALKER_LIFT_DISABLE_SAFE` | 0 | 1 lets `lift.enable` `false` free the motor away from the bottom switch. Set it only after the drop test passed and is recorded in hardware/current-build.md, or with a brake fitted. |

Build and flash with the id, as for the other boards: `WALKER_MODULE_ID=lift-01 pio run -e lift -t upload`. The build stops for any id that isn't a lift id. The library doing the pulses is FastAccelStepper 1.2.8 (pinned; it uses the ESP32's hardware pulse timers and counts every step).

### Bench procedure (do these in order; the motor decoupled from the screw first)

Run each step with the bench tool, which speaks the lift's lines from a computer: `python3 firmware/tools/lift_bench.py --port <port> <command>` (standard library only; not yet run against a board; its lines are checked against the contract's parser in `packages/contracts/test/lift-bench-tool.test.ts`). Each run uses a fresh request-id prefix, so the lift never sees an id twice. For `home` and `move` it is hold-to-run: it keeps naming the request in its heartbeats while it runs, for at most `--hold-seconds` (10); **Ctrl-C is letting go** (the lift ramps down and holds). Record every result in [hardware/current-build.md](../hardware/current-build.md).

1. **Decouple the motor from the screw** (loosen the coupler), switches unplugged, carriage resting on a soft landing. Driver current at its lowest setting. Power the driver, plug the ESP32 into the computer.
2. **Boot.** `status`: a `lift.hello` for `lift-01` with the configuration above and `stop_sense` `wired`, then statuses: `unhomed`, `driver=on`. With the switch harness unplugged it must read `limit_wiring` (both switches read pressed): that is the safe failure.
3. **Enable polarity.** With the board running (driver enabled), try to turn the motor shaft by hand: it should resist (holding). `enable off` (accepted here because the unplugged harness reads the bottom switch as pressed): it should turn freely. `enable on`: it holds again. If it is the other way round, rewire ENA (an inverter, or a pull-up so a floating pin still holds; see Build settings) rather than rebuilding, then build with `WALKER_LIFT_ENA_ENABLE_LEVEL=1 WALKER_LIFT_HW_INVERTER=1` and repeat. Then press the ESP32's reset button and hold the shaft during the reset: it should keep holding (a resetting ESP32 must leave the driver enabled, rule 1). If it goes free, the ENA wiring or the polarity is wrong; fix it before going on.
4. **Switches and stop.** Plug the switch harness in. Press each switch by hand: the status shows it `pressed` at once and `released` about 20 ms after letting go. Press the stop: `stop_sense` `pressed` and `stop_circuit_opened`; release it and `clear`.
5. **Direction, decoupled.** Hold the bottom switch's lever away from anything. `home`: the shaft turns (fast approach, 15 mm/s is 4,800 pulses a second at 8 microsteps). Note which way; press the bottom switch's lever by hand: it stops and turns the other way slowly; let the lever go within a few turns (the back-off needs the switch released within 8 mm, about 1.6 turns); it reverses slowly; press the lever again: it backs off once more (let go again) and reports `completed` at 5 mm. Verify that a small positive move physically raises the current assembly; if it does not, correct `WALKER_LIFT_DIR_UP_LEVEL` before a longer move. Letting go (Ctrl-C) mid-homing must stop it with `lift.done` `stopped`.
6. **Steps per mm, decoupled.** Mark the shaft; `move 10 --speed 5` from home (5 mm) to 10 mm is exactly one turn at 5 mm a turn. Repeat to 25 mm (four turns). A shortfall means the microstep DIP and the build setting differ, or pulses are being missed (see the 3.3 V assumption above).
7. **Stop cuts STEP, in hardware.** The firmware also stops on stop-sense, so a live test on the normal build can't show the switch itself cuts the pulses. Do both of these: (a) power off, and with a meter on continuity between GPIO33's wire and the driver's PUL+ terminal: closed with the stop released, open with it pressed; (b) on a bench build with `WALKER_LIFT_STOP_SENSE=0`, start a slow decoupled `move` and press the stop: the shaft must stop and hold while the status still says `moving` (the firmware doesn't know, so only the switch can have stopped it); release it and Ctrl-C. Then reflash the normal build and check pressing the stop during a move latches `stop_circuit_opened`.
8. **Couple the screw, carriage unloaded,** pinch guards and physical end stops fitted. A bottom switch that is stuck released (or whose wire is shorted to GND) never trips: homing then drives the carriage into the bottom end at 15 mm/s until the switch releases, the 1000 mm of travel runs out or the homing deadline passes. That is why the guards and end stops are required before coupling. Home from a few millimetres up. Check homing repeats: home five times and measure the carriage height above a fixed mark each time. Then a slow `move 50 --speed 5` and back, measuring the real height against `position_mm`.
9. **Drop test (required before normal lift motion, and before any `WALKER_LIFT_DISABLE_SAFE=1` build).** With the arms mounted and the carriage raised a little over a soft landing, cut the lift's motor power and measure how far the carriage slides down in 10 s. Record `drop_test` as `passed` (it stays put) or `failed`. Outside bench mode the Pi refuses lift motion until it passed or a brake is fitted, and only then may the stop also cut motor power.
10. **Speed and current.** Raise speed in small steps to the built-in 20 mm/s with the loaded carriage and check for lost steps (home, move up and down ten times, home again: `position_mm` should still match a measured height). Record the lowest current that lifts the load without lost steps, the motor's temperature after a run, and the usable travel and top switch position (`top_switch_mm`).

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

   ```bash
   WALKER_MODULE_ID=lift-01 pio run -e lift -t upload
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

### Build an image on a Mac, flash it from the Pi

When a board is already wired into the walker, build its image on a computer with PlatformIO and flash it from the Pi with [`devices/pi/scripts/flash-esp32.sh`](../devices/pi/README.md#flash-a-board-from-the-pi), which uses the esptool already on the Pi.

The module id is not a PlatformIO environment: `platformio.ini` reads it from the `WALKER_MODULE_ID` variable at build time (`${sysenv.WALKER_MODULE_ID}`), so the one `hand` environment builds either hand and no new environment is needed for `hand-right-01`. **Built on this Mac on 2026-10-23** (PlatformIO Core 6.1.19, the pinned `espressif32` 6.12.0, about 10 s each with the toolchain already downloaded) for `hand-right-01` and for `tof-front-01`; in each, `firmware.bin` contains its own id and not the other hand's. Neither image has been flashed onto a board yet. From `firmware/`:

```bash
WALKER_MODULE_ID=hand-right-01 pio run -e hand
mkdir -p ~/firmware-images/hand-right-01
cp .pio/build/hand/bootloader.bin .pio/build/hand/partitions.bin .pio/build/hand/firmware.bin ~/firmware-images/hand-right-01/
cp ~/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin ~/firmware-images/hand-right-01/
```

```bash
WALKER_MODULE_ID=tof-front-01 pio run -e tof
mkdir -p ~/firmware-images/tof-front-01
cp .pio/build/tof/bootloader.bin .pio/build/tof/partitions.bin .pio/build/tof/firmware.bin ~/firmware-images/tof-front-01/
cp ~/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin ~/firmware-images/tof-front-01/
```

The lift board the same way (built on this Mac on 2026-10-24 with FastAccelStepper 1.2.8; not flashed onto a board yet):

```bash
WALKER_MODULE_ID=lift-01 pio run -e lift
mkdir -p ~/firmware-images/lift-01
cp .pio/build/lift/bootloader.bin .pio/build/lift/partitions.bin .pio/build/lift/firmware.bin ~/firmware-images/lift-01/
cp ~/.platformio/packages/framework-arduinoespressif32/tools/partitions/boot_app0.bin ~/firmware-images/lift-01/
```

**Copy each image out before building the next one.** Changing `WALKER_MODULE_ID` changes the project's checksum, and PlatformIO then empties `.pio/build` for every environment: on 2026-10-23 building `tof-front-01` deleted the `hand` build. `boot_app0.bin` comes with the Arduino core, not the build.

Then copy the folders to the Pi (one folder per id; `<pi>` is the Pi's SSH address) and flash there from the copied `devices/pi` folder (Pi README step 7), with the walker service stopped:

```bash
ssh <pi> mkdir -p firmware
scp -r ~/firmware-images/hand-right-01 ~/firmware-images/tof-front-01 <pi>:firmware/
```

```bash
sudo systemctl stop steady-walker
sudo ./scripts/flash-esp32.sh hand-right-01 --images ~/firmware --port /dev/serial/by-id/<the right board>
```

Label the board with its id, then check it with `sudo node /opt/steady-walker/walker.mjs check --press` before starting the service again.

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

The GPIO32 handle input expects a momentary contact to GND, with the internal pull-up enabled. The Pi decides whether that wire event means left Confirm or right Talk. This is not yet a general capacitive-touch interface. If the eventual touch sensor has an active-high digital output, update and verify the input handling before connecting it.

For a **press → buzz bench test**, close any serial monitor and run this from the repository root after reconnecting the board:

```bash
python3 firmware/tools/press_to_haptic.py --port /dev/cu.SLAB_USBtoUART
```

The script uses only Python's standard library on macOS or Linux. It asks the board for `hello`, checks that `hand-left-01` advertises `haptic`, then sends one 1000 ms `near_obstacle` cue for each `talk` or `confirm` **pressed** event. This is the strong pattern already felt in the first bench check; a 150 ms `confirmation` cue was accepted after a P32 press but was not felt. Release events and heartbeats do not buzz. The script prints each press and the board's acknowledgement. Press Ctrl-C to stop; unplugging the board also ends the script. To use a right-hand board, pass `--module-id hand-right-01` with its serial port. This is a computer bench loopback, not the Pi's local cue policy.

The script's framing and press-to-cue behavior can be checked without a board using `python3 -m unittest discover -s firmware/tools`.

### First hand-board bench record (2026-10-23)

- Board: Teyleten ESP32-WROOM-32 38-pin USB-C board; CP2102 USB-to-UART bridge identified by macOS; ESP32-D0WD-V3 revision 3.1 reported during upload.
- Build: existing hand source, module ID `hand-left-01`, compiled with the locally installed Arduino-ESP32 core 3.3.5 and Arduino CLI 1.2.0 because PlatformIO was unavailable on this Mac. This is a separate build environment from the pinned PlatformIO core 2.0.17 used in CI.
- Flash: `/dev/cu.SLAB_USBtoUART`; uploader reported hashes verified for bootloader, partitions, boot app, and firmware, then reset the board.
- Reflash, 2026-10-23 23:42 PDT: rebuilt with the pinned PlatformIO environment (`WALKER_MODULE_ID=hand-left-01 pio run -e hand`) with the press patterns changed to Strong Buzz, and flashed from the walker's Pi over USB with esptool 5.6.0 (bootloader 0x1000, partitions 0x8000, boot_app0 0xe000, app 0x10000; all hashes verified). The board said hello to the Pi service as `hand-left-01`. The old `recording` (Soft Bump) buzz couldn't be felt on a Talk press; the new one could. Still the stock 100% effects in open loop: a stronger buzz needs the driver's voltage settings raised, which waits for the motor's voltage, current and temperature to be measured.
- Left handle Mac bench: rebuilt the current Strong Buzz patterns from `main` with Arduino CLI 1.2.0 and Arduino-ESP32 core 3.3.5, provisioned as `hand-left-01`, then reflashed over `/dev/cu.SLAB_USBtoUART`. All upload hashes verified. The computer loopback saw a connected-control `talk` press and an accepted cue; the owner felt the buzz after the final reflash. The listener was stopped afterward. This identifies the tested ESP32 as the left board; the other board is reserved for the right handle and its intended Talk control.
- Serial: a `hello.request` received a `hello` advertising `button.talk`, `button.confirm`, and `haptic`; subsequent heartbeats reported `health: ok`. A 150 ms `confirmation` request received `ack` `accepted`.
- Haptic feel: the owner felt the 1000 ms `near_obstacle` cue when P32 was touched to GND. After the no-pause `near_obstacle` firmware was flashed, the owner reported that it felt stronger. The computer loopback received press events and `accepted` acknowledgements; the serial session was then stopped.
- Motor: the owner identified the [VAKTOK 10 mm coin motor listing](https://www.amazon.com/dp/B0CC4LXNMZ), which advertises a 3 V rating. The DRV2605L's peak drive setting was not raised. Measure actual motor voltage, current, and temperature before sustained use; the listing does not establish those operating values in this wiring.
- Still unverified: motor voltage/current/temperature, all other cue patterns and durations on this Mac bench, the exact final left-control wiring, P33 Confirm input, reconnect behavior, and the Pi's new left-to-Confirm mapping on both physical handles. The DRV2605L responded to firmware initialization, but its breakout revision was not recorded.

## Tests

Run every native check with your computer's own C++ compiler (no PlatformIO or ESP32 toolchain needed):

```bash
firmware/test/run-native.sh
```

It runs the unit tests (with the address and undefined-behaviour sanitizers, so any read outside a buffer fails), checks that bad ids, zone names and lift settings stop the build, and checks that `test/session/transcript.txt` and `test/session/lift_transcript.txt` match what the code prints now. After changing the firmware's output on purpose, run it with `--update` and commit the new transcripts. The contract's tests (`pnpm test`) then read them with the real `parseSerialLine` and `parseLiftSerialLine` (`packages/contracts/test/firmware-session.test.ts` and `lift-firmware-session.test.ts`). The lift's tests drive the same code with a simulated stepper and carriage (`test/support/sim_stepper.h`, `lift_rig.h`), so they prove the logic, not the motor.

The expected results were written before the code, in [test/EXPECTED.md](test/EXPECTED.md). CI's `firmware` job runs `run-native.sh`, `pio test -e native`, the hand, obstacle and lift board builds, and a build with the id `any`, which must fail.

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

Pins (GPIO32 Talk, GPIO33 Confirm, GPIO21/22 I2C); I2C at 100 kHz with on-board pull-ups; DRV2605L at 0x5A with id 7 or 3; ERM motor, library 1, open loop, OD_CLAMP at its default; the four effect sequences; TCA9548A at 0x70 with sensors on channels 0 to 3; VL53L1X long mode, 50 ms budget and period; range status 3 counted as valid; 4,000 mm ceiling; 250 ms freshness; 80 ms report interval; 20 ms debounce; 3 s silence stop; 500 ms without a result before a sensor counts as missing; one sensor retried per second; 115200 baud; the ESP32's task watchdog at its default 5 s. Lift: pins GPIO33 STEP, GPIO25 DIR, GPIO26 ENA, GPIO32 bottom, GPIO27 optional top, GPIO13 stop-sense; common-cathode signal wiring at 3.3 V; external 1 to 4.7 kΩ pull-ups and 100 nF on the switch and stop-sense lines; ENA active-disable (enabled at level 0); 8 microsteps; DIR level 0 is the unverified up candidate; 50 µs DIR-change delay; 20 ms switch release report delay; two samples for a homing trip; a 1 s task watchdog; sixteen remembered request prefixes (a seventeenth is refused until the lift restarts); four lines of serial outbox; the contract's homing, stop, watchdog and status timings; the simulated stepper's ramp standing in for FastAccelStepper's. Versions: PlatformIO platform `espressif32` 6.12.0 (Arduino-ESP32 core 2.0.17), Pololu VL53L1X 1.3.1, FastAccelStepper 1.2.8, `native` 1.2.1, PlatformIO Core 6.1.19 in CI. Unity, the test framework, is the one PlatformIO picks (`throwtheswitch/Unity@^2.6.1`; 2.6.1 when tested).
