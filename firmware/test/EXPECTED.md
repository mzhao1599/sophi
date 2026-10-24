# Expected results for the ESP32 firmware (written before the tests)

Written 2026-10-24, before any firmware code or test. Rows marked *(review)* came from the break-it review and a differential fuzz against the contract, and were written before their fixes. Each row says what must happen. The test that checks it carries the row's id (for example `R4`) in its name or comment. Every time value comes from a fake clock passed in as a number, so no test sleeps.

What runs where:

- **Native tests** (`test/test_protocol`, `test/test_module`): plain C++17, built with the computer's own compiler by `test/run-native.sh` (with the address and undefined-behaviour sanitizers) and by `pio test -e native` in CI. They cover the protocol code in `lib/protocol/` and the board-independent behaviour in `lib/module/`.
- **Cross-check** (`packages/contracts/test/firmware-session.test.ts`): a native program (`test/session/session_main.cpp`) runs a scripted session through the same code and writes `test/session/transcript.txt`. The vitest test reads that file with the real `parseSerialLine` from `@walker/contracts`. `run-native.sh` fails if the committed transcript differs from what the program prints now, so the file can't go stale.
- **Board builds** (`pio run -e hand`, `pio run -e tof`): CI only. They prove the board code compiles against the pinned libraries, nothing more.
- The first hand ESP32 was flashed on 2026-10-24; a temporary P32-to-GND contact reported Talk presses and triggered a buzz felt by the owner. See the bench record in [firmware/README.md](../README.md). The final buttons and all VL53L1X behavior remain unverified. Rows marked *(board)* still need the remaining hands-on checks listed there.

All numbers marked *placeholder* are not measured. They live in `lib/protocol/serial_protocol.h` and `lib/module/*.h` and are labelled there too.

## Lines the module sends

| Id | Situation | Expected |
| --- | --- | --- |
| L1 | Boot | The first line is a `hello` with `seq` 0, the provisioned `module_id`, `module_type`, `capabilities`, `firmware_version` and `uptime_ms`. Hand: `["button.talk","button.confirm","haptic"]`. Hand whose haptic driver didn't answer at boot: `["button.talk","button.confirm"]`. Obstacle sensors: `["zones"]`. |
| L2 | Time passes | A `heartbeat` every 1,000 ms after boot (at 1000, 2000, 3000 on the fake clock), with `uptime_ms` and `health`. `faults` appears only when there is one. |
| L3 | Any line built | `seq` goes up by exactly one per line, across every type. A line the serial port couldn't take (its buffer was full) still uses its number, so the Pi sees the gap. Only a reboot (a new core) starts again at 0. |
| L4 | `hello.request` addressed to `any` or to this module | One `hello` with the next `seq` (not 0) and the same content as the boot hello. |
| L5 | Every line the firmware builds | Ends with `\n`, is at most 1,024 bytes counting the `\n`, and passes `parseSerialLine` with no problem (cross-check). |
| L6 | A line that would be longer than 1,024 bytes, or a name the contract forbids (for example 16 zones with 24-character names, or an uppercase zone name) | Nothing is written, not even part of a line, and `seq` is not used. The next heartbeat reports the fault `line_not_built`. |
| L7 | The serial port's buffer is full when a line is ready | The line is dropped, never half-written. The next heartbeat that goes out reports `tx_dropped` with health `degraded`; once that heartbeat is written, the fault clears. |

## Lines the module receives from the Pi

Each Pi line gets the reply below. "Same code as the contract" means the problem code `parseSerialLine` gives for that line.

| Id | Pi line | Expected reply |
| --- | --- | --- |
| R1 | Valid `haptic.play` to this hand module | `ack` `accepted` with its `request_id`; the cue starts. |
| R2 | `haptic.play` with a readable `request_id` but a bad field: pattern outside the four, `duration_ms` 0, 1001, 400.5, `"400"` or negative, an extra field such as `waveform`, a missing field | `ack` `rejected`, reason `invalid_field`, with that `request_id`. Nothing starts, and a cue already playing carries on. |
| R3 | `haptic.play` whose `request_id` is missing, empty, over 40 characters or has other characters | `error` `invalid_field` (nothing to ack). |
| R4 | Valid `haptic.play` addressed to another module, or to `any` | `ack` `rejected`, reason `invalid_field`. Nothing plays. (A firmware check: the contract's parser can't know who "this module" is.) |
| R5 | Valid `haptic.play` to the obstacle module, or to a hand module whose haptic driver didn't answer at boot | `ack` `rejected`, reason `unsupported`. |
| R6 | `hello.request` addressed to another module, or with any extra field | `error` `invalid_field`. No hello. |
| R7 | Not JSON, cut off, a JSON value that isn't an object, or bytes that aren't UTF-8 | `error` `malformed`. |
| R8 | `v` missing, 2 or `"1"` | `error` `unsupported_version`. `v` written as `1.0` or `1e0` counts as 1, as `JSON.parse` reads it. |
| R9 | `type` missing, not a string, or not a v1 type (`motor.move`) | `error` `unknown_type`. |
| R10 | A type only modules send (`hello`, `heartbeat`, `hand.input`, `perception.zones`, `ack`) | `error` `unsupported`. The module doesn't act on these, so it doesn't check their fields. |
| R11 | A valid `error` line from the Pi | No reply (so two sides can't bounce errors). An invalid `error` line gets `error` `invalid_field`. *(review)* `detail` may hold up to 120 Unicode code points, as zod 4.6.5 counts them (a surrogate pair, raw or escaped, is one): 120 emoji or 120 lone `\ud83d` escapes pass, 121 fail, and 70 escaped pairs plus 50 letters pass. |
| R12 | Line sizes | 1,023 bytes plus `\n` is read normally. A longer line gets one `error` `oversize`, the rest of it up to its `\n` is dropped, and the next line is read normally. |
| R13 | A blank line, or only spaces and `\r` | No reply. A line ending in `\r\n` reads the same as one ending in `\n`. *(review)* Only ASCII spaces, tabs, `\r`, `\v` and `\f` count as blank, and a leading byte-order mark is `malformed`, as `parseSerialLine` reads them. (The Pi's own reader also strips a byte-order mark and trims Unicode spaces; the Pi never sends either, so the firmware doesn't copy that.) |
| R14 | JSON details: `\u` escapes in keys and values, a repeated key (the last one wins), exponents (`4e2`), `-0`, huge numbers, nested unknown values | Read exactly as `JSON.parse` and the contract schema read them, so the reply's code matches the contract's. |
| R15 | Every Pi line in the transcript, including every line of the contract's fixtures and about 200 scrambled lines | The reply's code equals the contract's code for that line, except for the firmware-only rows R4, R5, R6 (destination) and R10. The cross-check computes those exceptions itself from the parsed line. |
| R16 | Any byte sequence at all (a seeded run of 20,000 scrambled lines under the sanitizers) | No crash, no read outside the buffer, and exactly one problem code per line. |

## Haptic cue (hand module), on a fake clock

| Id | Sequence | Expected |
| --- | --- | --- |
| H1 | `near_obstacle` for 400 ms at t=0 | The driver starts the `near_obstacle` sequence at t=0. Still playing at 399; stopped at 400. |
| H2 | The driver reports its sequence finished while the cue still has time left | The same sequence starts again, so the cue lasts its duration. It never starts after the duration ends. |
| H3 | Cue A for 1,000 ms at t=0, then cue B for 300 ms at t=200 | B replaces A at 200 (the driver stops A and starts B, no queue) and ends at 500. Nothing plays at 1,000. |
| H4 | A duration of 0 or over `HAPTIC_MAX_DURATION_MS` (1000) reaches the cue controller directly | Refused; nothing starts. (The parser already rejects these; this is the second lock.) |
| H5 | No line from the Pi for 3,000 ms (*placeholder*) while a cue plays | The cue stops. Tested with the controller's duration limit raised for the test only, because with the real 1,000 ms limit the duration always ends first, which is also checked. |
| H6 | Boot | The controller tells the driver to stop before anything else, and nothing plays until a valid `haptic.play`. |
| H7 | The millisecond clock wraps (starts at 0xFFFFFF00) | The cue still ends 400 ms later. |
| H9 | *(review, board)* The driver stops answering after boot | The heartbeat says `degraded` with `haptic_error`. While no cue plays, the board asks the driver for its status once a second, so the fault clears when the driver answers again. *(review 2)* A driver that answers but is no longer in internal-trigger mode (it lost power and came back in standby) is set up again, and the fault stays until that works. |
| H10 | *(review, board)* A chip answers at 0x5A at boot but fails the setup (wrong id or a failed write) | The board still writes GO = 0 and standby to it, then treats the driver as missing. |
| H8 | Only the four patterns exist | Each pattern maps to a fixed sequence of library effects that ends by itself (no real-time or external-trigger mode), so a sequence can't run on if the ESP32 stops. *(board)*: the DRV2605L is put in internal-trigger mode and stopped at boot, and nothing else writes its GO register. |

## Buttons (hand module)

| Id | Sequence | Expected |
| --- | --- | --- |
| B1 | Talk pressed and held | One `hand.input` `{"button":"talk","edge":"pressed"}` 20 ms (*placeholder*) after the level settles. |
| B2 | Contact bounce: the level flips at 0, 3, 5, 7 and 8 ms, then stays pressed | No edge until the level has held for 20 ms, then exactly one `pressed`. |
| B3 | Released | One `released`, the same way. |
| B4 | A button held down at boot | No edge at all until it has been seen released; the next press reports normally. A stuck button can't start a recording on its own. |
| B5 | Talk and Confirm | Named `talk` and `confirm` on the wire, matching `button.talk` and `button.confirm` in the hello. |

## Obstacle zones

| Id | Situation | Expected |
| --- | --- | --- |
| Z1 | Range status 0 (valid) with 0 to 4,000 mm (*placeholder* ceiling) | `quality: valid` with that `mm`. |
| Z2 | Range status 3 (target closer than the sensor's minimum, distance clipped) | `valid` with the clipped `mm`: something very close must not read as unknown. An assumption to check on the bench. |
| Z3 | Any other range status, or `mm` over 4,000 | `invalid`, `mm: null`. |
| Z4 | Sensor missing at boot, I2C error on the last read, or no new reading for 250 ms (*placeholder*) | `invalid`, `mm: null`. |
| Z5 | Report rate | One `perception.zones` every 80 ms (12.5 Hz, inside the contract's 10 to 20 Hz), with all four zones every time, in a fixed order. |
| Z6 | Zone names | `front_left`, `front_right`, `left`, `right` by default, one per multiplexer channel 0 to 3. Each can be changed at build time. A name that breaks the contract (not snake_case, over 24 characters, or a repeat) stops the build. |
| Z8 | *(review, board; rule simplified in review 2)* A short I2C glitch, a sensor that stops answering, or one that reset and stopped measuring | A failing sensor reads invalid at once. A sensor that has produced no result for 500 ms (*placeholder*), whether its transfers fail or it has simply stopped measuring, counts as missing. One missing sensor is set up again each second, from a fresh driver object, so the loop never stalls for more than one sensor's setup. |
| Z7 | Health | Every sensor missing: health `fault`, fault `sensor_missing`. Some missing: `degraded`, `sensor_missing`. A present sensor erroring or stale: `degraded`, `sensor_error`. |

## Provisioning

| Id | Situation | Expected |
| --- | --- | --- |
| P1 | `WALKER_MODULE_ID` unset, empty, `any`, uppercase, or longer than 32 characters | The build fails with a message naming `WALKER_MODULE_ID`. Checked natively by compiling the same header with each bad value (`run-native.sh`), and in CI by a real `pio run -e hand` with `any`. |
| P2 | `hand-left-01`, `hand-right-01`, `tof-front-01` | The build succeeds and the hello carries that id. |
| P3 | Baud | 115200, matching the Pi's `SERIAL_BAUD`. *(board)* |
