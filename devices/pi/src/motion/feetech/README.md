# Feetech STS3215 servo-bus driver

The low-level driver for the two SO-101 arms: each arm is six Feetech STS3215 servos (ids 1 to 6 by SO-101 convention) daisy-chained on one half-duplex serial line, reached through one USB adapter board. This folder turns "read joint 3's position" into bytes on that line and checks the bytes that come back.

**Status (2026-10-23):** built and unit-tested on a Mac against Feetech's Python SDK (golden vectors) and a simulated bus. **Not yet run against a real servo, adapter or Pi.** It has no motion policy and isn't wired into the Pi service: joint names, limits, faults and who may move an arm belong to the motion contract in `packages/contracts` and the motion coordinator (rule 8 in AGENTS.md). Nothing here decides that a motion is safe.

| File | What it holds |
|---|---|
| `protocol.ts` | Packet encoders (PING, READ, WRITE, REG_WRITE, ACTION, SYNC READ, SYNC WRITE), the checksum, the status-packet parser, error bits |
| `controlTable.ts` | The STS3215 register map as typed constants, sign-magnitude and little-endian helpers |
| `bus.ts` | `FeetechBus`: one transaction at a time, deadlines, retries, reply checks, echo handling, the separate EEPROM method |
| `port.ts` | `FeetechPort`, the byte-pipe the bus needs, and `openFeetechPort` for a real tty |
| `../../sim/fakeFeetech.ts` | `FakeStsBus`: simulated servos at the byte level, for tests and the simulator |

## How a request travels

```
FeetechBus.read(3, "presentPosition")
  -> waits its turn in the bus queue (one transaction on the wire at a time)
  -> encodeRead(3, 56, 2)            FF FF 03 04 02 38 02 BC
  -> port.write(bytes)               USB adapter puts them on the servo line
  <- servo 3 replies                 FF FF 03 04 00 00 08 F0   (id, length, error byte, 2 data bytes, checksum)
  <- StatusParser finds FF FF, checks the checksum, the id (3) and the length (2 data bytes)
  -> decodeField: 0x0800 little-endian, sign bit 15 clear  = 2048 steps
  -> { value: 2048, error: 0 }
```

**Packet format.** Instruction: `FF FF ID LEN INST PARAMS... CHK`. Status: `FF FF ID LEN ERROR PARAMS... CHK`. `LEN` is the parameter count plus 2, and `CHK = ~(ID + LEN + INST/ERROR + PARAMS) & 0xFF`. Broadcast id `0xFE` reaches every servo and none replies. A SYNC READ (`0x82`) names several ids and each answers with its own status packet; a SYNC WRITE (`0x83`) carries `id + data` for each servo and nobody answers.

**Two-byte fields are little-endian** on STS servos (Feetech's `End = 0`; the older SCS series is big-endian, not supported here).

**Sign-magnitude, not two's complement.** Some fields keep the sign in one bit and the size in the bits below it: goal position, goal speed, present position, present speed and present current use bit 15; the homing offset uses bit 11; present load uses bit 10. So `0x8064` is -100, not -32668. `encodeSignMagnitude`/`decodeSignMagnitude` do this; the control table names each field's sign bit.

## What the bus guarantees

- **One transaction at a time.** Every public call waits in a strict queue; the next request is written only after the previous one got its reply or gave up. Retries happen inside the call's turn.
- **Every reply is checked:** checksum, id, and length. A reply from another id is ignored (and counted) while the right one is awaited. Bytes outside a transaction are discarded.
- **Deadlines and retries.** Each attempt waits `timeoutMs` (default 50 ms, LeRobot's figure; placeholder, not measured) plus wire time. A failed call is retried at most `retries` times (default 2). Sync reads retry only the ids still missing, then fail with the others' data attached (`error.details.partial`). After a failed attempt the bus ignores input for `settleMs` (5 ms) so a late reply can't be taken for the next request's answer. The deadline is armed before the write, so a write that never completes times out too. Everything is counted in `bus.stats`. The protocol has no sequence numbers, so a reply that arrives more than about 55 ms late (the timeout plus the settle gap) from the same id with the same length can still be taken as the next request's answer; both numbers are placeholders to set from the bench latency.
- **Fault bits are data, not retries.** The error byte of every reply (voltage 0x01, angle sensor 0x02, overheat 0x04, overcurrent 0x08, overload 0x20) comes back with the value and in `bus.lastError(id)`. The motion coordinator decides what to do.
- **No broadcast but one.** `write`, `setTorque`, `syncWrite`, `syncWriteGoals` and `unlockAndWriteEeprom` refuse the broadcast id 0xFE (one packet would move every servo on the arm); only `broadcastTorqueOff` builds a broadcast packet.
- **Goals are one turn, with speed and acceleration.** Goal position is 0..4095 (negative and multi-turn goals are refused). Goal speed is 1..32767 and acceleration 1..254: both power up at 0, which the servo reads as "as fast as possible", so the driver never writes 0 and there is no goal-position-only sync write. `syncWriteGoals` sends acceleration, position and speed together, as Feetech's `SyncWritePosEx` does.
- **EEPROM is off the motion path.** `write`/`syncWrite` accept RAM registers only, never Lock, and torque values 0 or 1 only (the servo also accepts 2 = damping and 128 = recalibrate the offset). Ids, angle limits, offsets and mode change only through `unlockAndWriteEeprom(id, field, value)`, which refuses while torque is on, refuses an id already on the bus, opens the lock, writes, closes the lock (at the new id after an id change), and reads the value back.
- **Half-duplex echo.** Some adapters hand our own bytes back before the reply. `echo: true` consumes and checks them. With the default `echo: false`, a frame identical to our request is set aside as a probable echo and the real reply that follows is used; if nothing follows, the call fails as `echo_mismatch` ("set echo: true") rather than taking our own bytes as data. The cost: a PING answered with the voltage fault bit is byte-identical to the PING and fails the same way. **Startup must run `detectEcho(id)` before any motion** and build the bus with the `echo` it reports; it reads the model number, whose genuine reply from an STS3215 can never equal the request.
- **Torque on: write the goal first.** Whether an STS3215 drives to a goal written while torque was off, or holds where it is, is unknown. The motion layer must write goal = present position (with speed and acceleration) before enabling torque. The fake bus defaults to the dangerous behaviour (it drives to the old goal) so tests catch a coordinator that forgets.
- **A closed port is final.** After an unplug or `close()` every call fails with `closed`; reconnecting needs a new `FeetechPort` and a new `FeetechBus`.

Illustrative use, not wired anywhere yet:

```ts
import { FeetechBus, openFeetechPort } from "./index";
import { systemClock } from "../../clock";

const bus = new FeetechBus({ port: openFeetechPort("/dev/serial/by-id/usb-1a86_USB_Single_Serial_XXXX-if00"), clock: systemClock });
console.log(await bus.detectEcho(1));                      // { echo: false, replied: true, ... } expected on the Waveshare board
const feedback = await bus.readFeedback([1, 2, 3, 4, 5, 6]); // one SYNC READ of addresses 56..70
```

## References

- **Feetech's official SDKs:** [FTServo_Python](https://github.com/ftservo/FTServo_Python) (`scservo_sdk/sms_sts.py`, `protocol_packet_handler.py`, read 2026-10-23) and [FTServo_Arduino](https://github.com/ftservo/FTServo_Arduino) (`src/SMS_STS.h`, `SMS_STS.cpp`, `SCS.cpp`, `INST.h`, dated 2024-11/12 in their headers).
- **`feetech-servo-sdk` 1.0.0 on PyPI** (`scservo_sdk`), the package LeRobot installs. It is a third-party mirror (Adam-Software/FEETECH-Servo-Python-SDK) of Feetech's code; LeRobot calls it unofficial. Its packet builders are the same as FTServo_Python's. The golden vectors come from it.
- **LeRobot v0.4.4** [`src/lerobot/motors/feetech/tables.py`](https://github.com/huggingface/lerobot/blob/v0.4.4/src/lerobot/motors/feetech/tables.py) and `feetech.py`, which drove SO-100/SO-101 arms. LeRobot's `main` (2026-10) has since replaced these with the `rustypot` crate and removed `tables.py`.
- **Waveshare Bus Servo Adapter (A)** [wiki](https://www.waveshare.com/wiki/Bus_Servo_Adapter_(A)) and [schematic](https://files.waveshare.com/wiki/Bus-Servo-Adapter-(A)/Bus%20Servo%20Adapter%20(A)-Sch.pdf), a common SO-101 adapter. Which board came in our kits is still to be read off the boxes.
- An unofficial transcription of Feetech's STS memory table ([aifitlab wiki](https://aifitlab-wiki.super.site/feetech-servo-motor-docs/feetech-sts-servo-memory-table-analysis)) for units, defaults and bit meanings; used only where the SDKs are silent, and marked "assumed".

### Where the sources disagree

| Point | Feetech official | LeRobot v0.4.4 | This driver |
|---|---|---|---|
| Baud index 5, 6, 7 | 76800, 57600, 38400 (Arduino adds 8 = 19200) | 57600, 38400, 19200 | Never changes baud; index 0 (1,000,000) is the same in both |
| Address 24 | (not named) | Minimum startup force, 2 bytes | LeRobot's; never written. The memory-table transcription has 1 byte at 24 and an integral limit at 25 |
| Present current (69) | Sign bit 15 (`ReadCurrent`) | Unsigned | Bit 15; identical for any value below 32768 |
| Bits above the sign bit | Kept in the magnitude (`SCS_TOHOST`) | Masked off | Masked; identical for every valid value |
| Lock (55) | Separate `unLockEprom`/`LockEprom` | `disable_torque` also writes Lock = 0 (EEPROM writes then persist); `enable_torque` writes 1 | Lock is touched only by `unlockAndWriteEeprom` |
| Reset instructions | RECOVERY 0x06, RESET 0x0A, CAL 0x0B | (none) | Constants only; never sent. The PyPI 1.0.0 SDK has none, so they have no golden vector |
| Highest id | SDK `MAX_ID` = 252 for scans; PING/READ allowed to 253 | (from SDK) | 0..253 addressable |
| Goal speed sign (46) | `WritePosEx`/`SyncWritePosEx` take it as an unsigned u16; `WriteSpe` (wheel mode) uses bit 15 as direction | `Goal_Velocity` with sign bit 15 | Unsigned 1..32767 (position mode only); identical bytes for those values |
| Speed unit (46, 58) | Examples write 2400 to 3400 | (raw) | Raw steps/s assumed; the transcription says 0.732 rpm per unit, which doesn't fit those examples. Check on the bench |
| Address 44 | `GOAL_TIME`, written as 0 in position mode | `Goal_Time` | Raw unsigned; the transcription calls it PWM output (sign bit 10) in mode 2 |
| 67, 71 | (not named) | `Goal_Position_2` at 71 | Left out |
| Packet timeout | Fixed in FTServo_Python | Patches the PyPI SDK's timeout to bytes + 50 ms | 50 ms + wire time |

### Does the adapter echo?

Not by its schematic. On the Waveshare Bus Servo Adapter (A), the CH343P's TXD drives a PNP transistor that makes `TXEN`: while TXD is low, an SN74LVC1G126 drives the servo line and the SN74LVC1G125 that feeds RXD is switched off (RXD is held high by a pull-up); while TXD is high, the line floats high through a pull-up and the receive buffer passes it. Either way RXD sees idle-high during our own transmission, so no echo. This is a reading of the schematic, not a measurement; `detectEcho` checks it on the real board, and the bus works either way.

## The golden-vector test

`test/feetech-golden.test.ts` runs vectors from `test/fixtures/feetech-golden.json`, generated by `scripts/feetech_golden.py` with `feetech-servo-sdk` 1.0.0 writing into a recording fake port:

- **Encoding (122 operations, byte-identical, through both the encoder and `FeetechBus`):** PING (with the SDK's follow-up model-number READ) for ids 0..6, 252, 253; READ of every field in the table and of the 15-byte feedback block; WRITE of sample values for every RAM field and the EEPROM fields the setup method writes, including negative sign-magnitude values (the encoder's byte layout is checked for all of them; for values outside the driver's ranges, such as negative goals or speed 0, the test checks the bus refuses them and sends nothing); torque on/off for ids 1..6; broadcast torque off; REG_WRITE and ACTION; SYNC READ of positions and feedback for ids 1..6 and a reordered subset; SYNC WRITE of goal positions (encoder only; the bus has no such call), of Feetech's 7-byte `SyncWritePosEx` block (acceleration, position, time, speed), and of torque.
- **Decoding (47 status packets, the SDK's verdict vs ours, through both the parser and `FeetechBus.read`):** realistic values for every feedback field including negative speeds and loads and ±2047 offsets, each error bit, a corrupt checksum, another id's reply first, noise and an extra FF before the header, no reply, an error byte above 0x7F; and two SYNC READ reply streams parsed by the SDK's `GroupSyncRead`.
- **The control table:** every field's address, size and sign bit against LeRobot's table as transcribed in the script.

Regenerate with a venv outside the repo:

```bash
python3 -m venv /tmp/feetech-ref && /tmp/feetech-ref/bin/pip install feetech-servo-sdk==1.0.0
/tmp/feetech-ref/bin/python -I devices/pi/scripts/feetech_golden.py > devices/pi/test/fixtures/feetech-golden.json
```

What it can't show: that a real servo answers as the SDK expects, its timing, or that our table's units and defaults are right. Both sides could share a wrong address only where LeRobot's table and Feetech's constants agree on it.

## The fake bus

`FakeStsBus` (src/sim/fakeFeetech.ts) is a `FeetechPort` that parses our packets and answers like six STS3215s: register memory with plausible (not measured) EEPROM defaults, trapezoidal motion toward the goal at goal speed and acceleration (0 = fastest), angle limits, torque on/off, Lock and power cycles (EEPROM written with Lock = 1 is lost at power-off), an injectable external load with Feetech's overload protection (Overload Torque for Protection Time, then torque off when the Unloading Condition bit is set), heating with load, and a supply voltage. Faults: `silent` (unplugged), `noReply`, `corruptReplies: n`, `errorBits`, plus `inject(bytes)` for noise or a stray reply, `echo` for an echoing adapter and `unplug()`.

Modelled assumptions to check on the bench (they are not facts about the servo): by default turning torque on drives to whatever goal is in the register, including one written while torque was off (`torqueOnHoldsPosition: true` makes it hold instead); turning torque on clears a latched overload; in a SYNC READ an absent servo is skipped and the rest still answer in order.

## Only real servos can show

1. The adapter's echo (`detectEcho`), and that `stty` sets 1,000,000 baud on the Pi's CH343 port; reply latency through USB, to replace the 50 ms timeout and 5 ms settle placeholders.
2. Model number 777 and the firmware version on all 12 servos; Response Status Level (address 8) and Return Delay Time (7) as shipped.
3. SYNC READ support in that firmware, reply order, and what the others do when one servo is missing.
4. Units: goal/present speed (step/s?), acceleration (100 step/s² per unit?), load and current scaling, voltage against a multimeter.
5. Torque-on behavior: with the arm supported, write a goal a few steps away while torque is off, then enable torque: does it move?
6. Which id acknowledges an id change, and that Lock = 0 writes survive a power cycle.
7. Whether an overload latch clears on torque re-enable, and the shipped Unloading Condition (19) and LED Alarm (20) bits.
8. The servo variant in each kit (leader vs follower, 7.4 V vs 12 V) and its voltage limits (14, 15).
