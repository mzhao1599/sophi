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
| B3 | Hand button released | One `released` after 250 ms continuously released. A shorter open-contact gap during a hold produces no edge; the next stable press is still the same hold. |
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

## Lift board (`lift-01`)

Written 2026-10-23 before the lift code, and rewritten before the code changed each time the contract was revised (hold-to-run on 2026-10-24, then the stop-sense input, seq on every line and single-use request ids) and after the independent review (disable only on the bottom switch, two-sample homing trips, the serial outbox; rows LC8, LH7, LS6). The contract is rules 1 to 10 in the header of `packages/contracts/src/lift-serial.ts` and the lift constants in `motion.ts` (proposed, PR #71); every timing below is that contract's placeholder, not a measurement. The motor runs on a simulated stepper in the native tests and the scripted session: nothing here proves anything about the TB6600, the motor, the screw or the switches.

What runs where: `test/test_lift` (native unit tests, run both ways like the others); `test/session/lift_session_main.cpp` prints `test/session/lift_transcript.txt`, which `run-native.sh` keeps current and `packages/contracts/test/lift-firmware-session.test.ts` reads with the real `parseLiftSerialLine`. That test also checks the firmware's copies of the contract's constants against `motion.ts`. A scratch differential fuzz (50,000 generated lines through the C++ reader and `parseLiftSerialLine`, 0 disagreements on 2026-10-24) and scratch mutation checks (19 mutants of `lift_core.cpp`, then the review's new guards) were run and are not committed.

### Boot and lines the lift sends

| Id | Situation | Expected |
| --- | --- | --- |
| LS1 | Boot (rule 1) | Step output low, not stepping, unhomed, no fault, the driver left enabled so the motor holds. The first line is a `lift.hello` with `seq` 0, the configuration built into the firmware (8 microsteps, soft limits 5 to 600 mm, 20 mm/s, 50 mm/s², `top_switch_mm` null) and `stop_sense` `wired`. Then a `lift.status`: `unhomed`, `homed` false, `position_mm` null, `target_mm` null, `driver_enabled` true, `stop_sense` `released`, no faults, `request_id` null, `heartbeat_age_ms` null. If both switches read pressed (`limit_wiring`) or the stop does (`stop_circuit_opened`), the fault latches straight after (rule 8). |
| LS2 | Time passes (rule 10) | A `lift.status` every 50 ms (`LIFT_STATUS_HZ` 20), and at once on any change of state, homed, driver, a reported switch, the stop, the faults, the request or the target. After one sent at once, the next regular one is 50 ms later. |
| LS3 | Any line | `seq` goes up by one per line across every type; a `hello.request` gets a `lift.hello` with the next `seq` and the same configuration. |
| LS4 | Every line the lift builds | At most 1,024 bytes with its `\n`, and passes `parseLiftSerialLine` (cross-check); a status the schema's refinements would reject (for example `stop_sense` `pressed` without `stop_circuit_opened`) is never built. |
| LS6 | The serial port can't take a line (its buffer is full) | An ack, done, hello or error waits in a four-line outbox and goes out, in order, before anything newer; no status is built while one waits. A status the port can't take with nothing waiting is dropped and counted, and its seq is used, so the Pi sees the gap. A fifth waiting line is dropped and counted. |
| LS5 | Position and target | `position_mm` is the counted steps divided by steps per mm, rounded to 0.001 mm, null whenever not homed; never a measurement. `request_id` names the move or homing while it runs or stops; `target_mm` is the move's target while moving, 5 during homing's last back-off until it passes 5 mm (beyond that, where it ends depends on where the switch releases, so null), else null. A homing being stopped reads `stopping` with `homed` false. |

### Lines the lift receives

| Id | Pi line | Expected reply |
| --- | --- | --- |
| LR1 | `lift.heartbeat` to this lift, with `hold_request_id` a lift request id (`k3x9q2-17`) or null | No reply. A fresh one resets the watchdog and sets the hold lease (rule 3). Without `hold_request_id`, or with one that isn't a lift request id: `error` `invalid_field`. To another lift (`lift-02`): `error` `invalid_field`, and it changes nothing. |
| LR2 | A command (`lift.home`, `lift.move`, `lift.stop`, `lift.enable`, `lift.clear`) with a request id matching `LiftRequestIdSchema` but a bad field: `target_mm` 1001 or -1, `speed_mm_s` 0 or 51, a missing field, an extra field such as `accel_mm_s2`, addressed to `hand-left-01` or `any` | `lift.ack` `rejected`, reason `invalid_field`, with that `request_id`. Nothing happens. Without a request id the lift may use (`lift-4`, `k3x9q2-0`, missing): `error` `invalid_field`. |
| LR3 | A valid command addressed to another lift (`lift-02`) | `lift.ack` `rejected` `invalid_field`. Nothing happens. (Firmware rule: the contract can't know who "this lift" is.) |
| LR4 | A type only the lift sends (`lift.hello`, `lift.status`, `lift.done`, `lift.ack`) | `error` `unsupported`, fields unchecked. The hand protocol's types (`hand.input`, `haptic.play`, `hello`, `heartbeat`, `ack`) are `error` `unknown_type`, as `parseLiftSerialLine` reads them. |
| LR5 | Framing, version, type, size, blank lines, a Pi `error` line | As R7 to R14, with the lift parser's codes; blank lines and a valid `error` get no reply. |
| LR6 | `hello.request` to `any` or `lift-01` (rule 2) | A `lift.hello`; a running move or homing ramps down and holds (`lift.done` `stopped`); the seq threshold starts again. To another module, or with an extra field: `error` `invalid_field`. |
| LR7 | Every Pi line in the lift transcript: all 26 lines of `lift-serial-v1.valid.jsonl` and 36 of `lift-serial-v1.invalid.json`, plus 200 scrambled lines | The reply's code is the contract's code for that line; the firmware-only rows LR1, LR3, LR4 and the acceptance rules below are computed by the cross-check itself. |
| LR8 | A heartbeat whose `seq` isn't above the last accepted Pi seq (rule 3) | Ignored as if it never arrived: no watchdog reset, no lease. |

### Commands (rules 3, 4, 6, 9)

| Id | Situation | Expected |
| --- | --- | --- |
| LC1 | Any command but `lift.stop` and `lift.enable` `false` whose `seq` isn't above the last accepted Pi seq since the last `hello.request` | `lift.ack` `rejected` `stale_seq`; nothing happens. Fresh heartbeats and accepted commands raise the threshold; a refused command doesn't, and a stale stop or disable never lowers it. |
| LC2 | `lift.stop` (rule 6) | Always `accepted`, whatever the seq, state, faults, stop or heartbeat. `lift.enable` `false` is never refused for its seq, state, faults, stop or heartbeat either (LC8 is its one refusal). |
| LC3 | `lift.move` (rule 4) | Refused, first match wins: `stale_seq`; `request_used` (LQ1); `no_heartbeat` (none in the last 300 ms); `not_held` (the latest heartbeat's `hold_request_id` isn't this request); `stop_pressed`; `fault_latched`; `busy` (a move or homing running or stopping); `driver_disabled`; `not_homed`; `out_of_range` (target outside 5 to 600 mm, or speed above the built-in 20 mm/s). Accepted: `moving` with `target_mm`, up to the requested speed at 50 mm/s², and one `lift.done` `completed` on the target's exact step. A move to where it already is completes at once. |
| LC4 | `lift.home` (rule 4) | Refused in the same order without the last two. Allowed when already homed (homes again; homed clears at the start). |
| LC5 | `lift.stop` | Accepted, with no `lift.done` of its own. A running move or homing ramps down at `LIFT_STOP_DECEL_MM_S2` (200 mm/s²), state `stopping`, and ends with its `lift.done` `stopped`; a move stays homed, a homing ends `unhomed`. Idle: nothing changes. |
| LC6 | `lift.enable` | `true` turns the driver on; refused only for `stale_seq`. `false`, when allowed (LC8), stops a running move or homing at once (its `lift.done` `stopped`, with the height the count held), then frees the motor and clears homed (rule 6). |
| LC8 | `lift.enable` `false` with the bottom switch released, on a build without `WALKER_LIFT_DISABLE_SAFE=1` (rule 6 as amended) | `lift.ack` `rejected` `disable_unsafe`; the driver stays enabled; a running move or homing ramps down and holds as for `lift.stop`. With the bottom switch pressed, or on a disable-safe build: accepted (LC6). |
| LC7 | `lift.clear` (rule 9) | Refused `cause_present` while a fault is latched and the stop reads pressed, the top switch reads pressed (both pressed included), or no heartbeat arrived in the last 300 ms. The bottom switch alone may stay pressed. Otherwise every fault clears; the lift stays unhomed. With nothing latched: `accepted`, nothing changes. |
| LQ1 | A move or homing whose request counter isn't above the highest accepted under the same boot prefix since the lift booted (rules 4, 5) | `lift.ack` `rejected` `request_used`: a stopped or finished request is never resumed or run again, and neither is an older one under that prefix. A new prefix (the Pi service restarted) starts again. Sixteen prefixes are remembered; once full, a new prefix is refused `request_used` rather than forgetting an old one, until the lift board restarts (firmware limit). |

### Hold lease and watchdog (rule 5)

| Id | Situation | Expected |
| --- | --- | --- |
| LW1 | A heartbeat naming the running request | Renews the lease; nothing else. |
| LW2 | A heartbeat naming anything else, or null (the person let go) | Ramps down at 200 mm/s², holds, `lift.done` `stopped`, no fault. Later heartbeats naming it again resume nothing. |
| LW3 | No heartbeat for `LIFT_WATCHDOG_TIMEOUT_MS` (300 ms) while a move or homing runs | Ramps down the same way (state `stopping`), then `lift.done` `failed` `watchdog_expired`, the fault latches and homed clears. The driver stays enabled (`LIFT_WATCHDOG_DRIVER_ACTION` `hold`). |
| LW4 | No heartbeat while idle or unhomed | Nothing latches; `lift.move` and `lift.home` are refused `no_heartbeat` until heartbeats return. |
| LW5 | `heartbeat_age_ms` | Milliseconds since the last fresh heartbeat on the lift's clock; null before the first. |

### Homing (rule 7)

| Id | Situation | Expected |
| --- | --- | --- |
| LH1 | `lift.home` above the bottom switch | Down at `LIFT_HOMING_FAST_MM_S` (15 mm/s) until the bottom switch reads pressed; stop at once; up at `LIFT_HOMING_SLOW_MM_S` (2 mm/s) by `LIFT_HOMING_BACKOFF_MM` (5 mm), the switch released (if it releases between 5 and 8 mm, the back-off ends where it released); down at 2 mm/s until it presses: that point is 0 mm; up 5 mm the same way. `lift.done` `completed` with `position_mm` 5, state `idle`, homed. |
| LH2 | Bottom switch already pressed when homing starts | Skips the fast approach and starts at the back-off. |
| LH3 | `homing_failed` | Stop at once, `lift.done` `failed` `homing_failed`, the fault latches, when: a back-off doesn't see the switch release within `LIFT_HOMING_BACKOFF_MM` + `LIFT_HOMING_RELEASE_MARGIN_MM` (8 mm); the slow approach doesn't see it press within 8 mm; the travel over all phases passes `LIFT_HOMING_MAX_TRAVEL_MM` (1000 mm); or the homing passes `LIFT_HOMING_TIMEOUT_MS` (100,334 ms, the firmware's own copy of the Pi's deadline). |
| LH4 | The top switch reads pressed at any point during homing (including a motor wired to turn the wrong way, which drives the carriage up) | Stop at once, `homing_failed`. |
| LH5 | Steps taken after a trip, before the motor stops | Don't move the zero: the position is read when the switch is first seen pressed. |
| LH7 | One sample of the bottom switch reading pressed during an approach (noise) | Not a trip; homing carries on. Two samples in a row are, and the zero is the first one's position. (Homed motion still stops on a switch's first pressed sample: LL1.) |

### Switches and the stop (rule 8)

| Id | Situation | Expected |
| --- | --- | --- |
| LL1 | Either switch reads pressed while homed (moving, stopping or idle) | Steps stop at once (no ramp); a running move ends `lift.done` `failed` `limit_hit` (with the height the count held); `limit_hit` latches and homed clears. |
| LL2 | While a homing is stopping: the top switch reads pressed, or the bottom switch goes from released to pressed | The same: stop at once, `limit_hit`. A homing stopped while backing off the switch it is still sitting on latches nothing. |
| LL3 | Both switches read pressed, in any state (an unplugged harness reads this way, since the switches are normally closed) | `limit_wiring` latches; any motion stops at once. At boot too. |
| LL4 | Reported switch states | `pressed` as soon as one sample reads pressed; `released` only after 20 ms (*placeholder*) of steady released readings. Stopping always uses the raw reading. |
| LL5 | Built-in limits and pins | Checked at build time: soft minimum below soft maximum and at most home (5 mm), speed at most `LIFT_SPEED_CEILING_MM_S` (50), acceleration at most `LIFT_ACCEL_CEILING_MM_S2` (200) and at most the stop ramp's, microsteps one of 1, 2, 4, 8, 16, 32; no pin is a strapping, flash or input-only pin. Nothing over serial changes them. |
| LP1 | The stop-sense input reads pressed, even for less than one loop (the board latches the edge in an interrupt) | `stop_circuit_opened` latches and homed clears; a running move or homing stops counting at once and ends `lift.done` `failed` `stop_circuit_opened`. `lift.status` says `stop_sense` `pressed` while it is. A build without the input reports `not_wired` and never latches it. |

### Ramp and step math

| Id | Situation | Expected |
| --- | --- | --- |
| LM1 | Steps per mm | 200 × microsteps / 5: 40 at 1, 320 at 8, 1,280 at 32. |
| LM2 | Millimetres to steps and back | Rounded to the nearest step: 600 mm at 8 microsteps is 192,000 steps; one step at 8 reports as 0.003 mm (0.003125 rounded). |
| LM3 | Speed and acceleration | 20 mm/s at 8 microsteps is 6,400 steps/s; 50 mm/s² is 16,000 steps/s²; 200 mm/s² is 64,000; 15 mm/s is 4,800; 2 mm/s is 640. |
| LM4 | Stopping distance | v² / 2a: from 20 mm/s at 200 mm/s², 1 mm (320 steps at 8). The simulated ramp matches within one step. |
| LM5 | A simulated move | Never faster than the requested speed, never accelerating faster than requested, ends on the target step exactly. |

### Build

| Id | Situation | Expected |
| --- | --- | --- |
| LB1 | Power-up or reset | The step output is driven low and the enable output to its enabling level before anything else (rule 1). |
| LB2 | `WALKER_MODULE_ID` | Must be a lift id (`lift-` and more); `hand-left-01`, `any` or `lift-` stops the build. |
| LB3 | Build settings | `WALKER_LIFT_MICROSTEPS` outside 1, 2, 4, 8, 16, 32 stops the build; `WALKER_LIFT_ENA_ENABLE_LEVEL`, `WALKER_LIFT_HW_INVERTER`, `WALKER_LIFT_DIR_UP_LEVEL`, `WALKER_LIFT_STOP_SENSE` and `WALKER_LIFT_DISABLE_SAFE` must be 0 or 1; `WALKER_LIFT_ENA_ENABLE_LEVEL=1` stops the build unless `WALKER_LIFT_HW_INVERTER=1` (a resetting ESP32 would otherwise free the motor). |
| LB4 | A stuck loop | The task watchdog, set to 1 s in `setup()`, restarts the board; a restart starts again at LB1. Until then a running move continues on FastAccelStepper's own timers. *(board)* |
