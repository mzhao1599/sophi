# Arms, cameras, and lift guide

**For:** the robotics and Pi developers integrating two SO-101 arms (with their leader arms), the cameras, and the ball-screw lift.

**Status, 2026-10-24: proposed, partly built, nothing run on the walker.** The motion contract exists as schemas and tests in [`packages/contracts/src/motion.ts`](../../packages/contracts/src/motion.ts) and [`lift-serial.ts`](../../packages/contracts/src/lift-serial.ts). Built on 2026-10-24, and tested only against simulated or bench-free stand-ins:

- the lift ESP32 firmware, written and tested on a computer ([firmware/README.md](../../firmware/README.md#lift-board));
- the Pi's Feetech servo driver;
- the Pi's motion coordinator for the arms ([`devices/pi/src/motion/`](../../devices/pi/README.md#the-arms-motion-coordinator-part-a)): Confirm targets, guards, calibration, poses, teleop and a simulator.

None of these has run on real arms or a real lift. Not built: the lift's side of the coordinator, taught skills, and the screen's motion controls. Nothing on this page has been measured, and every number is a placeholder until a bench record in [`hardware/`](../../hardware/current-build.md) replaces it.

## The rule

**Motors start only when a person at the walker acts, and the lift moves only while a person holds its control.**

- **Starting.** Starting any motion, and every other command except a stop, needs a **handle Confirm press** on the **one pending Confirm target**. The walker shows that target on its screen and says it aloud, in the Pi's own words.
  - The press counts only if the Pi saw that Confirm button released for the whole 2 s before it, all after the target appeared.
  - It also needs no hello, sequence gap, error line or loss from that hand module since the target appeared.
  - Any ignored press restarts the 2 s.
  - Once started, a skill or teleop runs on after that one press until it ends or anything stops it.
- **Holding the lift.** The lift keeps moving only while a person holds the **screen's hold control**.
  - Lifting the finger releases it, and so do the browser cancelling the touch, the page losing focus or being hidden, and a missed refresh (`SCREEN_HOLD_RELEASE_EVENTS`, `HOLD_CONTROL_REFRESH_MS`).
  - **A handle button is not a hold source.** A serial hand module reports edges, so a lost `released` line or a hung board could keep the lift moving for up to 3 s.
  - A handle could become a hold source later only if its firmware sends a "still held" refresh at least every 200 ms (a sequence gap, an error line or a missed refresh then counts as released). The Pi's own GPIO buttons could count only if their level is read every control tick.
- **Preparing.** The terminal (SSH, scripts, coding agents), the walker's screen, the cloud's offers and the Pi's own follow-ups can only **prepare** a command, which becomes the pending Confirm target. The screen also holds the lift.
- **Stopping.** Anyone local can always **stop**.
- Nothing but a handle Confirm press ever starts motion, and nothing but the screen's hold control ever holds the lift.

The schemas enforce this:

- A confirmed command doesn't parse without a `confirm` record. That record names the handle, a press 2 s to 30 s after its target appeared, and a release at least 2 s before the press.
- `HoldSourceSchema` has only `screen_hold_control`.
- `PreparerSchema` has no cloud or model value apart from `offer`, which can carry ids only.
- The only commands sent directly are `motion.stop` and `teleop.stop`.

## Hardware (purchased, not measured)

| Part | What we have | What the contract assumes (check on arrival) |
| --- | --- | --- |
| Arms | Two SO-101 follower arms on the walker and their two leader arms. Six Feetech STS3215 servos per arm, each arm on its own Feetech bus controller board over USB serial | 1,000,000 baud (LeRobot's default), servo ids 1 to 6 in joint order (`shoulder_pan`, `shoulder_lift`, `elbow_flex`, `wrist_flex`, `wrist_roll`, `gripper`), 4096 ticks per turn. Followers on 12 V regulators |
| Lift | Two HGR20 1000 mm rails, an RM1605 ball screw (5 mm per turn), a NEMA 17 17HS19-2004S1 (1.8°, 59 N·cm) on a TB6600-type step/dir/enable driver, roller limit switches at top and bottom | Usable travel is shorter than 1000 mm (not measured). Height is counted in steps from the bottom switch; there is no position sensor. **Computed, not measured: about 450 to 670 N of thrust, a crushing force** |
| Lift controller | A dedicated ESP32, provisioned `lift-01`, as [current-build.md](../../hardware/current-build.md) prefers | A third board is needed, because the two we bought are for the handles. If there isn't one, the obstacle board could later run a combined build (not part of this contract). PUL, DIR, ENA and the inputs must avoid the strapping pins (GPIO 0, 2, 5, 12, 15) and the flash pins (6 to 11) |
| Stop | Not chosen yet | A **latching, twist-to-release** mushroom switch; see [The stop circuit](#the-stop-circuit-decided) |
| Cameras | Three UVC cameras | Not used for motion in this version |

## What the first demo does (decided)

1. **Teleop** (`teleop.start`): a person moves a leader arm and the follower copies it. Used for bring-up and for teaching.
2. **Taught skills** (`skill.run`): a recorded teleop session, replayed on the follower after the walker's Confirm press. The first skill, `tray_pick_handover`, picks a light object from a fixed tray and holds it out.
   - A skill ends **holding**.
   - Letting go is its own step: the Pi then shows and says "Let go?", and the person at the walker presses Confirm when they have hold of the object (`gripper.release`).
3. **No camera-guided grasping** in this version.

## Confirm targets (decided)

There is at most **one pending Confirm target** at a time, across everything Confirm can answer (`ConfirmTargetSchema`). It names the exact action, who prepared it, the Pi-written title, and the words shown and said (`confirmPrompt`). A target that can lead to motion ends with "Park the walker and lock the brakes, then press Confirm."; clearing faults ends with "Press Confirm to go ahead."

- **Who may prepare.** The preparers are `walker_screen`, `operator_cli` (the terminal), `offer` (the cloud's id-only request) and `walker_local` (the Pi's own "Let go?"). The policy lists, for each command, who may prepare it.
  - The cloud may offer only a locally taught skill or pose, by id (`MotionOfferRequestSchema`). The Pi drops the request if it has no such skill or pose, and words the target from its own titles. No cloud text is ever shown or spoken.
- **Timing, on the Pi's monotonic clock.**
  - A target expires after `WALKER_CONFIRM_WAIT_MS` (30 s).
  - A press is accepted only after the button was seen released for the whole `CONFIRM_ARM_DELAY_MS` (2 s), all after the target appeared, with no reset of that hand module since (`confirmPressVerdict`). Otherwise it is ignored, and the ignored press restarts the window.
  - A new target can't replace the pending one in its first 2 s (`mayReplaceConfirmTarget`). A replacement gets a new id and a new window.
- **Targets live in the coordinator's memory only.** They are withdrawn when the coordinator starts, when any hand module says hello or is lost, and whenever the mode leaves `ready`. In `fault`, only `allowedWhileFaulted` actions may then be prepared: `fault.clear`, `arm.torque` off and `lift.disable`.
- **Single use.** The first accepted press consumes the target. The command that runs must be exactly the target's action, with a press in its window (`commandMatchesTarget`). Otherwise it is refused with `confirm_target_expired` or `confirm_target_mismatch`.
- **With the walker's own proposals** (`walker.ts`, the `cues_change` that Confirm already answers): whichever the walker showed first owns Confirm until it is answered, expires or is withdrawn.
  - The Pi prepares no motion target while a walker proposal is open; preparing is refused with `confirm_busy`.
  - The Pi doesn't announce a walker proposal while a motion target is pending or a motion is running. While a motion runs, a Confirm press is only a stop.
- **Only the walker's handle Confirm answers a target.** The owner's web page never can.

## Input channels (decided)

The coordinator builds every command itself from the channel an input arrived on. No network API accepts a command.

| Channel | May |
| --- | --- |
| A handle Confirm press (a serial `hand.input` edge or a Pi GPIO edge) | answer the pending Confirm target. **Never hold the lift** |
| Any new handle press (Talk or Confirm) during motion | stop (`handle_press`); a bounce that looks like a press also stops, which fails safe. A `pressed` line lost on the serial link is caught by nothing in software: **the hardware stop is the backstop** |
| The walker's screen, over 127.0.0.1 with a token in a file readable only by the `sophi-screen` OS user (the kiosk's own) | prepare, hold the lift, stop. **Never start** |
| The Pi's terminal (SSH, scripts, coding agents) | prepare and stop. **Never start or hold** |
| The cloud | ask for an offer of a taught skill or pose, by id; never anything else |
| The Pi's own guard | stop (`motion_guard`) |

A Feetech servo keeps driving towards its last goal when nothing more arrives. So each joint's goal is clamped to within `MAX_GOAL_LEAD_DEG` (5°) of its measured position: if the Pi dies mid-motion, a joint goes at most 5° further and holds. A skill's timeline keeps its own clock and never pauses for a lagging joint.

## The stop circuit (decided)

The stop is a **latching (twist-to-release)** switch, wired so it doesn't depend on the Pi, an ESP32, USB or the cloud.

- **What it cuts.**
  - The follower arms' 12 V.
  - The lift driver's **step (PUL) signal**: the motor keeps holding but can't step.
  - Never the lift's enable. On most TB6600-type drivers ENA is an active-disable input.
  - The lift's motor power too, only once the drop test passed or a brake is fitted (`stop_cuts_lift_power`).
- **How it is sensed.** A **normally closed** stop-sense contact (so a cut wire reads as pressed) is read twice:
  - by the Pi, **edge-triggered**, so even a quick tap is caught;
  - by the lift ESP32 on its own input, so a stop the Pi missed can't silently let the lift resume stepping with a wrong count.

  Whether the input is wired is declared in the motion setup (`stop_sense`), never inferred from a reading.
- **Any press latches.** Any press, in any mode, idle or at boot, latches `stop_circuit_opened`, on the Pi and on the lift. Afterwards:
  - The lift must home again: the step signal was cut, so its counted height can't be trusted.
  - Every arm's torque and position are read afresh, and torque stays off until it is turned on again.
- **All arm and lift motion is refused unless the stop reads `released`.** With no stop-sense input it reads `not_wired`, and motion is refused with `no_hardware_stop`.
- **Bench mode.** `WALKER_MOTION_BENCH=no-hardware-stop` in the Pi's local service environment file is the only way to move without a hardware stop. It is read once at start, never set by the cloud, a model, the screen or a command.
  - Bench mode lowers every speed and torque limit and logs every motion. The screen and page show "Bench mode: no hardware stop".
  - It waives the hardware stop, the hand-control requirement, and the lift's guards and drop-test requirements. It never waives the rule: Confirm to start, a hold to keep the lift moving.

## Base stationary (decided)

The walker has no wheel or brake sensor, so being parked is **not detected**. Every Confirm target that can lead to motion says "Park the walker and lock the brakes, then press Confirm.", and the command carries `base_parked: true` only after that press. The demo must say this is a confirmation, not a sensor.

## Commands (AGENTS.md rule 8)

Each row comes from `MOTION_COMMAND_POLICY` in `motion.ts`, which the coordinator follows and the tests check.

- **Every confirmed command** (all but the two stops) is prepared, becomes the Confirm target, and runs only on a handle Confirm press inside the target's window.
- **Every moving command is also refused when:** the stop is pressed or not wired (outside bench mode), a fault is latched, another command is running (`busy`), a part is missing, no hand control is connected (outside bench mode), or feedback is stale.
- **"Stops"** means a new handle press, the screen, the terminal or the guard sending `motion.stop`; the hardware stop; or any fault.
- **Deadlines.** Every moving command has a deadline of its expected time × 1.25 + 2 s (`motionTimeoutMs`). Past it, motion stops and holds, and `motion_timeout` latches.
- **Lost links.** A lost cloud never changes anything. A lost servo bus, lift ESP32 or hand control means stop and hold for every moving command.

| Command | Prepared by | Also refused when | Limits | Cancelled by | Watchdog and deadline | Ends in |
| --- | --- | --- | --- | --- | --- | --- |
| `lift.home` | screen, terminal. **Hold-to-run** | not held, guards not recorded, drop test not passed and no brake, arms not stowed | Fast approach 15 mm/s to the bottom switch; back off 5 mm at 2 mm/s (released within 8 mm, or `homing_failed`); slow approach 2 mm/s (0 mm); back off 5 mm at 2 mm/s: home. `homing_failed` past `LIFT_HOMING_MAX_TRAVEL_MM` over all phases, or if the top switch trips. Deadline `LIFT_HOMING_TIMEOUT_MS` | Letting go; stops | Runs only while each heartbeat carries its hold lease (300 ms). No heartbeat for 300 ms stops it and latches `watchdog_expired`. The Pi stops heartbeating after 300 ms without lift status | ready and homed; released or stopped: ready, unhomed |
| `lift.move` | screen, terminal. **Hold-to-run** | as `lift.home`, plus not homed, target outside the soft limits | Soft limits; speed and acceleration the lower of the configuration's and the mode's (20 mm/s, 50 mm/s² normal; 10, 25 bench) | Letting go; stops | As `lift.home`; deadline from distance and speed | ready at the target; released or stopped: ready where it stopped |
| `lift.disable` | screen, terminal; also while a fault is latched | busy, the carriage could drop (`lift_may_drop`: no passed drop test, no brake, not on the bottom switch) | Sends `lift.enable(false)`. Nothing else ever disables the lift driver; no fault reaction does | Immediate | None | driver off, **lift unhomed** (firmware and Pi) |
| `arm.torque` | screen, terminal; turning off also while a fault is latched | turning on: stop, fault, busy, part missing, stale, not calibrated | On: goals set to the measured position first, so nothing moves; torque limit 60% (gripper 50%), bench 40% (35%). Off: the arm goes limp and may sag. Leaders never get torque | Immediate | None | ready (on) or disabled for that arm (off) |
| `arm.go_to_pose` | screen, terminal, an offer | not calibrated, torque off, unknown pose, pose out of range | 45°/s (bench 20°/s); goals at most 2° a step and within 5° of the measured position; arrived within 3° | Stops | Control loop at 50 Hz. Readings older than 100 ms freeze and latch. Goal and position more than 10° apart for 300 ms goes compliant and latches. Deadline from the longest joint move | ready at the pose |
| `skill.run` | screen, terminal, an offer | not calibrated, torque off, unknown skill, skill fails its checks (also latches `skill_invalid`), not within the start tolerance, lift not homed or not at the skill's height | The skill's own speeds (at most 60°/s; its timeline stretched to 30°/s in bench mode, never paused). After a `grasp` event, that gripper's grasp is active: 30% torque, exempt from divergence. Never moves the lift | Stops; never resumes | As `arm.go_to_pose`; deadline from the last waypoint | ready, **holding** the last waypoint; for each arm still grasping, the Pi prepares "Let go?" |
| `gripper.release` | the Pi's own follow-up, screen, terminal | no active grasp, torque off, open angle out of range | Only the gripper moves, to the skill's `let_go` angle, at the pose speed and 30% torque | Stops | As `arm.go_to_pose` | ready, holding, grasp no longer active |
| `teleop.start` | screen, terminal | not calibrated, torque off, a follower more than 10° from its leader | Followers track leaders at most 90°/s (bench 45°/s); **60°/s while recording**, which also ends at 60 s. Beyond the clamp the follower just lags | `teleop.stop`; stops | As `arm.go_to_pose`. Only far beyond the clamp does it latch: a leader joint over 2× the limit for 200 ms (`teleop_overspeed`), or a gap over 20° for 1 s (`teleop_gap`). A stale leader freezes its follower. Ends after 5 minutes | teleop until stopped; a recording is saved only if it passes the skill checks |
| `fault.clear` | screen, terminal | a cause is still present | Clears all latched faults or none | n/a | n/a | ready or disabled; see the faults below |
| `teleop.stop` | sent directly by any handle press, the screen, the terminal or the guard | never | None | n/a | n/a | ready, holding |
| `motion.stop` | sent directly by any handle press, the screen, the terminal or the guard | never, in any mode, with or without a fault | Arm goals to measured positions; lift ramps down at 200 mm/s² and holds | n/a | n/a | ready, holding (or fault); nothing resumes |

More rules behind the table:

- **One motion at a time,** and one Confirm target at a time.
- **Lift moves only with the arms stowed.** Every fitted follower must hold its `stowed` pose with torque on, within 3°. A skill never moves the lift. With a lift fitted, a skill must name a `lift_mm`, and the lift must be homed and already within 1 mm of it.
- **While `ready` (holding), the control loop keeps watching** (`CHECKS_WHILE_HOLDING`): overload, overtemperature, undervoltage, stale feedback, divergence, the bus and the stop. A gripper with an active grasp stays exempt from divergence and at 30%, so a held object isn't dropped or crushed.
- **Lost servo bus:** each servo keeps its last goal, at most 5° away. The Pi stops the lift and latches `servo_bus_lost`. Only the hardware stop can cut those arms now.
- **Lost lift ESP32:** the Pi stops all arm motion, latches `lift_module_lost`, and stops sending heartbeats, so the lift's own watchdog stops it too.
- **Lost hand controls:** motion stops and holds, and `hand_controls_lost` latches. Outside bench mode, nothing starts without a hand control.
- **Pi restart:** the coordinator starts `disabled` and reads every arm before writing any goal. On each servo that reads torque on, it sets the goal to the measured position. A servo that reads torque off gets no goal, because a Feetech goal may turn torque on. It needs a torque on before it moves. Its first line to the lift is a `hello.request`, which stops any lift motion.
- **Two skill checks,** at load and before every run: `SkillSchema` (time order, gaps, duration, speeds, start pose, gripper events, `let_go` for exactly the arms still grasping), then `checkSkillAgainstSetup` (calibration, the let-go angle, the lift).

## Faults

All faults latch. The screen shows the fault's sentence, then "Someone needs to check the walker and clear it there."

| Code | Sentence | Hardware left |
| --- | --- | --- |
| `limit_hit` | The lift touched an end switch it wasn't heading for, so it stopped. | hold (lift unhomed) |
| `limit_wiring` | Both lift end switches read pressed at once, so a switch or its wire needs checking. | hold (lift unhomed) |
| `homing_failed` | The lift couldn't find its bottom switch while homing, so it stopped. | hold (lift unhomed) |
| `overload` | An arm was working too hard, so it stopped. | release that arm |
| `overtemperature` | An arm motor got too warm, so it stopped to cool down. | release that arm |
| `undervoltage` | The arms' power supply dropped too low, so they stopped. | hold |
| `feedback_stale` | An arm stopped reporting its position, so motion stopped. | freeze that arm |
| `feedback_divergence` | An arm didn't move as told, as if it was blocked or pushed, so it went soft and stopped. | comply |
| `watchdog_expired` | The lift lost contact with the walker's computer, so it stopped. | hold (lift unhomed) |
| `servo_bus_lost` | The walker lost its connection to an arm, so motion stopped. | freeze that arm |
| `lift_module_lost` | The walker lost its connection to the lift, so motion stopped. | hold (lift unhomed) |
| `lift_config_mismatch` | The lift's settings don't match the walker's, so the lift won't move. | hold |
| `hand_controls_lost` | The walker lost its handle controls, so motion stopped. | hold |
| `stop_circuit_opened` | The stop switch was pressed, so the arms and lift stopped. | released by the hardware (lift unhomed, arm torque re-read) |
| `calibration_missing` | An arm has no calibration, so it won't move until it is calibrated. | hold |
| `lift_unhomed` | The lift lost track of its height, so it needs homing again. | hold |
| `skill_invalid` | A taught movement failed its checks, so it didn't run. | hold |
| `motion_timeout` | A movement took much longer than it should, so it stopped. | hold |
| `teleop_overspeed` | The teaching arm moved far too fast to follow, so the walker's arm stopped. | hold |
| `teleop_gap` | The walker's arm fell too far behind the teaching arm, so it stopped. | hold |

What each reaction does (`FAULT_REACTION`). In every case all other motion stops, and the lift holds with its driver enabled.

- **Hold:** every arm goal is set to its fresh measured position, and torque stays on.
- **Freeze:** the Pi stops writing goals to that arm, because it has no fresh reading or no bus. It never writes a goal from a stale reading.
- **Comply:** that arm's torque limit drops to `ARM_COMPLIANT_TORQUE_PCT`, so it yields to whatever is pushing it. That value must be at least the measured torque that holds the arm against its own weight in its worst pose; 25% is a placeholder. A gripper with an active grasp keeps 30% so it doesn't drop the object.
- **Release:** that arm's torque goes off. It goes limp and may sag.

## The lift (proposed)

- **Hold-to-run.** Hold the screen's lift control, then press Confirm on a handle. The lift moves only while the screen control stays held; the screen reports it at least every 200 ms, and lifting the finger, a cancelled touch, losing focus or being hidden all release it at once.
  - The coordinator puts the held request's id in every `lift.heartbeat` as a lease. The lift ramps down and holds when a heartbeat names anything else, or after 300 ms without one.
  - Letting go always means stop. The state shows the ramp-down after a release as `phase: stopping`. A stopping or finished request never resumes, and the lift refuses a request id it already accepted (`request_used`).
- **Force.** Set the TB6600 current DIP to the **lowest setting that still lifts the measured load**, and record it. Pinch guards are a precondition outside bench mode (`guards_fitted`).
- **Drop test.** With the arms mounted and the carriage a little above a soft landing, cut the lift's motor power and see whether the carriage slides. Record the result as `drop_test`.
  - Outside bench mode, lift motion needs the test `passed` or a brake fitted. This is stricter than "not `not_done`", because after a failed test any power loss could drop a raised carriage.
  - `LIFT_WATCHDOG_DRIVER_ACTION` stays `hold`.
- **Homing** goes through the four phases in the table. From the very top the fast approach takes about 67 s (at 5 mm/s it would be 200 s), so home near the bottom where possible. `LIFT_HOMING_MAX_TRAVEL_MM` covers every phase. It is a placeholder, to be set from the measured travel plus a margin.
- **Height is counted in steps** (320 per mm at 8 microsteps), not measured. That is why every lift fault, the stop and `lift.disable` leave it unhomed; the Pi's `homed` stays false until a `lift.home` completes.
- **Switches and stop-sense** are wired normally closed. Both limit switches reading pressed latches `limit_wiring`.
- **Limits live in the firmware,** reported in `lift.hello`. A mismatch refuses lift motion (`lift_config_mismatch`).
- **Boot:** not stepping, unhomed, driver enabled and holding. ENA is wired so that a resetting ESP32 leaves the driver enabled.
- **The Pi side:** the lift client in [`devices/pi/src/motion/lift/`](../../devices/pi/src/motion/lift/README.md) sends these lines (tested against a simulated lift only, not yet used by the motion coordinator).
- **Serial:** a heartbeat or command whose `seq` isn't above the last is ignored or rejected. A `hello.request` stops the lift. Request ids carry the Pi service's boot prefix. `lift.stop` is always accepted. `lift.enable(false)` is never refused for its sequence number, state or heartbeat, but the firmware frees the motor only on the bottom switch or on a build made disable-safe after a passed drop test (or with a brake); otherwise it answers `disable_unsafe` and keeps holding. The exact firmware rules are numbered 1 to 10 at the top of `lift-serial.ts`; see also [interfaces, Pi ↔ lift ESP32](../interfaces.md#pi--lift-esp32-usb-serial-proposed).

## Feetech behaviour the design relies on (check on the received servos)

- A servo keeps driving to its last goal when commands stop (hence the 5° lead clamp).
- Turning torque on drives it to whatever goal it holds, so the Pi writes goal = present position first.
- The servo's own speed and acceleration registers can cap how fast it chases a goal: worth setting as a second layer.
- Whether the servos power up with torque on, the offset register's range (±2047 in LeRobot's convention), and the load and voltage units.

## Motion state

`MotionStateSchema` is what the Pi reports to its screen, and later with its heartbeat:

- the mode, the bench flag, the stop reading, and whether a hand control is connected
- each arm: connected, calibrated, torque, pose, per-joint readings, whether its grasp is active, and its faults
- the lift: connected, homed, height, target, moving, driver, switches and faults
- the active command; for the lift, its phase and hold source
- the **pending Confirm target**, exactly as shown and said
- the last command's outcome or refusal reason
- every latched fault with its sentence

A pending target is allowed only while nothing moves. During a fault, the only pending target can be `fault.clear`. Each refusal reason has a sentence (`REFUSAL_SENTENCES`), so the screen never shows a code.

## Compatibility and deployment order

Today's Pi, server and firmware parse `device.ts`, `walker.ts` and `serial.ts` strictly, so this contract changes none of their shapes (pinned by `test/existing-shapes.test.ts`).

- **Manifest.** A lift entry parses on today's server. The arms are different: listing `manipulation.arm` changes the server's fixed arms reply, which demo beat 5 expects word for word. `MANIFEST_MAY_LIST_ARMS` is `false`, and a contracts test ties it to the walker script. **Pi requirement:** the manifest builder must test that it omits `manipulation.arm` while that constant is false.
- **Serial.** Every lift line's type starts with `lift.`, so today's `parseSerialLine` answers `unknown_type` to all of them.
- **Motion state and offers to the cloud.** These would be new heartbeat fields. Deploy a server that accepts them as optional first, then the Pi that sends them.

## Servo bus driver (built 2026-10-23, not yet run on hardware)

Each SO-101 arm is six Feetech STS3215 servos on one half-duplex serial bus behind a USB adapter. The Pi's low-level driver for that bus is in [`devices/pi/src/motion/feetech/`](../../devices/pi/src/motion/feetech/README.md): packet encoding checked byte for byte against Feetech's Python SDK, the STS3215 control table, a bus class (one transaction at a time, deadlines, limited and counted retries, reply checks, echo handling) and a simulated servo bus for tests. It holds no motion policy: limits, faults and who may move an arm belong to the motion contract and coordinator. Its README lists what only real servos can confirm.

## Planning versus control

The cloud planner, when it comes, can decide *what* to try, and only by choosing a taught skill or pose by id. It cannot set servo targets, skip homing, change limits, disable stops, word what the walker says, or confirm anything. The Pi holds calibration, poses, skills, workspace and lift limits, speed and torque limits, and the watchdogs. Avoid sending continuous video to the cloud.

## What must be measured

Record these in `hardware/current-build.md`:

1. **Servos:** labels, controller boards, baud, ids and firmware; whether they power up with torque on; the offset register range.
2. **Calibration:** each arm, the `stowed`, `ready` and `handover` poses with their titles, and the handover skill's let-go angle.
3. **Arms under load:** speed without overshoot; the torque to lift the arm and a light object; **the torque that holds each arm against its own weight in its worst pose**, which sets `ARM_COMPLIANT_TORQUE_PCT`; temperature after a run; the 12 V regulators under load.
4. **Lift travel and speed:** usable travel, which sets `LIFT_HOMING_MAX_TRAVEL_MM`; the top switch position; the microstep DIP setting; speed and acceleration without lost steps; homing repeatability and how far the switch takes to release; the lowest driver current that lifts the load.
5. **Lift safety:** the drop test with the arms mounted; the pinch guards; the TB6600 ENA polarity; whether a resetting ESP32 leaves the driver enabled.
6. **Stop:** the latching switch chosen; its wiring to the arms' 12 V, the lift's step signal, and the two stop-sense inputs (Pi GPIO and lift ESP32); what everything does when it is pressed and tapped.
7. **Timing:** the servo-bus loop rate, and how long a person takes to read a Confirm target, which checks `CONFIRM_ARM_DELAY_MS`.

## Integration deliverables

Keep an arm and lift wiring diagram, calibration records, the tested workspace and tray position, the stop procedure, the drop-test record, power measurements, and command and feedback logs in `hardware/` or `devices/pi/`. Demonstrate the stop with the cloud disconnected before connecting any offer to motion.
