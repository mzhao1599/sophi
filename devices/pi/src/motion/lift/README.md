# The lift client (`src/motion/lift/`)

**Status, 2026-10-24: written and tested against a simulated lift only.** It has never talked to the lift board. The motion coordinator drives it ([Wired into the coordinator](#wired-into-the-coordinator)), on the walker when `<state>/motion/lift.json` exists and in `walker simulate --arms --lift`. Expected results: [test/EXPECTED.md](../../../test/EXPECTED.md#the-lift-adapter-srcmotionlift-added-2026-10-24), rows L, LP, LF and LW, and the coordinator's rows E1 to E14.

It is the Pi side of the lift's serial lines ([`lift-serial.ts`](../../../../../packages/contracts/src/lift-serial.ts), rules 1 to 10). The motion coordinator owns Confirm targets and presses, faults and the motion state. This client owns the lift's lines and gives the coordinator verdicts and events.

## How a lift line gets here

The lift board (`lift-01`) is a serial module like the hand boards. `ModuleManager` sends `hello.request` when it opens a port. The first `hello` or `lift.hello` on a port decides which parser reads it from then on:

- A `lift.hello` makes it a lift port. Every later line is parsed with `parseLiftSerialLine` and handed to the registered `LiftLineHandler` (this client). Lift lines never reach the module list, the manifest or the "serial line refused" log.
- A lift line before any hello is ignored, and answered with a `hello.request` (at most every 2 s).

The client writes through a `LiftPortLink` ([`serial/liftPort.ts`](../../serial/liftPort.ts)). Each tick's lines go out in **one** write, because a real port takes one write at a time. The port stamps `v` and each line's `seq` from its own counter, which `hello.request` shares, and checks every line against the contract first.

## The interface for the coordinator

```ts
const lift = new LiftClient({ log, setup: motionSetup.lift!, bench, monotonic: () => clock.monotonic() });
modules.setLiftHandler(lift);           // once, before ports open
lift.on((event) => { /* see Events */ });
```

| Call | When | What it does |
| --- | --- | --- |
| `tick(nowMono)` | Every control-loop tick (MOTION_CONTROL_PERIOD_MS) | The only place heartbeats and commands are written. It writes a heartbeat every LIFT_HEARTBEAT_INTERVAL_MS, and at once when the lease changes. It also checks for a lost status, deadlines and missing acks. If the loop stalls, heartbeats stop and the lift's own watchdog stops the lift. |
| `holdRefresh(atMono)` / `holdRelease(atMono)` | On the screen's hold-control messages (refresh at least every HOLD_CONTROL_REFRESH_MS; any SCREEN_HOLD_RELEASE_EVENTS releases) | The hold lease. A heartbeat names the running request only while the latest refresh is at most HOLD_CONTROL_REFRESH_MS old. A refresh stamped in the future counts as stale. Once the hold lapses, that request is never named again. |
| `verdict(action, inputs, "prepare", now)` | Before preparing a `lift.home`, `lift.move` or `lift.disable` Confirm target | Returns `null` or the first `MotionRefusal` in policy order (LP1). It leaves out the Confirm checks and `no_hand_control`, which belong to the coordinator. |
| `start(action, inputs, now, lease)` | After Confirm for the screen hold flow, or from a completed local Talk turn for a spoken lift move | Rechecks the live interlocks and limits, then queues the request. `lease="screen"` requires fresh hold input; `lease="voice"` keeps the request in Pi heartbeats until completion or Stop. A stalled Pi loop, serial loss, timeout, or fault stops it. |
| `stop()` | Any `motion.stop` (handle press, screen, terminal, guard), and **on every fault the coordinator latches** | Writes `lift.stop` at once in every state. If the port is busy, it goes on the next tick. With no ack, it is resent up to LIFT_STOP_RETRIES times. The running request is never named again. |
| `disable(inputs, now)` | After the Confirm press on a `lift.disable` target | Writes `lift.enable` false only when `liftMayDisable`. The firmware may still refuse it with `disable_unsafe` (rule 6); see the `disable` event. Never use it as a stop. |
| `clearFaults()` | After a confirmed local `fault.clear` | Queues `lift.clear`; the answer comes as the `clear` event. |
| `markUnhomed()` | The coordinator latched a fault in FAULTS_THAT_UNHOME_LIFT from elsewhere (its own stop-sense, say) | The Pi's homed goes false until a homing completes. |
| `state(now)` | Building `MotionState.lift` | Returns a `LiftStateSchema` value (L18). |
| `active()` | Building `MotionState.active` | Returns `{ requestId, kind, phase: "starting" \| "running" \| "stopping", held, target_mm }` or null. The coordinator reports the active lease as `screen_hold_control` or `local_voice_request`. |

Spoken lift moves do not create a Confirm target. A local right Talk press starts the recorded turn; the cloud may return a bounded lift offer, and the Pi computes the target from the current counted position. It checks the installed soft limits and all live motion interlocks before starting. The left Confirm press, the screen's Cancel control, faults, communication loss, and the request deadline stop the move. The right Talk button remains available while it runs. The clock or route screen stays visible with Cancel over the left handle, styled like the Talk hint. On 2026-10-25, a spoken down 100 mm command completed in the controller but physically raised the carriage. The owner then designated the current pose as a new 100 mm software reference. The corrected direction firmware is installed, but its polarity has not been physically verified; keep driver power off until a short observed direction check. The 100 mm count is not a measured distance from a physical end stop.

`inputs` (`LiftCheckInputs`) is what only the coordinator knows: `stopCircuit` (its own stop-sense reading), `faultLatched` (any motion fault latched), `armsStowed` (every fitted follower at `stowed`, torque on), and `otherMotion` (an arm command is running).

**Events** (`LiftEvent`):

- `link`: the lift is heard, or lost.
- `accepted`, then `ended` with `outcome`: `completed`, `stopped`, `failed` (with `fault`), `refused` (with `reason`), `no_ack`, `timeout` or `lost`.
- `fault` with a `MotionFaultCode` for the coordinator to latch. This is every lift fault newly seen in `lift.status`, plus the client's own: `lift_module_lost`, `lift_config_mismatch`, `motion_timeout` and `lift_unhomed`. The coordinator latches it, applies FAULT_REACTION, and calls `stop()`.
- `clear`: the answer to `lift.clear` (`cleared`, `refused` with `cause_present`, or `no_ack`).
- `disable`: the answer to a disable (`disabled`, `refused` with `disable_unsafe`, or `no_ack`).

## Wired into the coordinator

Done 2026-10-24 (`claude/motion-wiring`), tested only against the simulated lift (`test/lift-coordinator.test.ts`, `test/lift-screen.test.ts`, `test/sim/lift/*.walk`):

1. `createPiMotion` (`../runtime.ts`) reads `<state>/motion/lift.json` (`MotionFiles.readLift`, the contract's LiftConfigSchema and LiftInstallationSchema). When there is one, it builds the client with it, the bench flag and the service's clock, calls `modules.setLiftHandler(lift)` and passes the client to the coordinator. `run.ts` passes `modules` in, and calls it before `scanner.start()`.
2. The coordinator's control loop calls `lift.tick(now)` on every tick (`afterRead`), and nothing else does.
3. The coordinator routes `screenHold` from the bus: `bus.on("screenHold", (h) => (h.pressed ? lift.holdRefresh(h.atMono) : lift.holdRelease(h.atMono)))`.
4. Preparing a lift target and pressing Confirm on it run `lift.verdict` (`prepare`, then `start`), in the policy's order with the coordinator's own `no_hand_control`; its inputs are the coordinator's stop reading, its latched faults, whether every follower holds `stowed` with torque on, and whether anything else runs. An accepted press calls `lift.start` (home, move) or `lift.disable`. `fault.clear` clears the Pi's faults at once and calls `lift.clearFaults()` when the lift board reports faults; those stay latched until the `clear` event says `cleared`.
5. Every `motion.stop` and every newly latched fault (an arm's too) calls `lift.stop()`; a fault in FAULTS_THAT_UNHOME_LIFT also calls `lift.markUnhomed()`.
6. Events: `fault` latches with part `lift`; `ended` ends the coordinator's lift motion (`completed`, `stopped`, a refusal with the contract's reason, else `faulted`) and so `last_command`; `state()` is `MotionState.lift`; `active()` gives the active motion's phase: `running` with `hold_source: "screen_hold_control"` exactly while the hold lease still names it, else `stopping`.
7. `walker simulate --arms --lift`: `src/sim/liftSim.ts` no longer plays the coordinator. It puts the `SimulatedLiftBoard` on a simulated port, hands the real client to the real coordinator, plays the screen's hold control on the bus, prepares lift targets as the terminal does, and keeps the fault keys.

## What isn't here

- Accel on the line: `lift.move` carries no acceleration; the firmware uses its built-in `max_accel_mm_s2`. So the verdict refuses lift motion (`lift_over_limits`) when that (the configuration, equal to what `lift.hello` reports) is above the mode's `lift_accel_mm_s2`, and homing when its fixed speeds are above the mode's `lift_speed_mm_s`: today, everything in bench mode. The verdict also refuses `no_hardware_stop` in bench mode: the lift never moves without the hardware stop.
- The lift isn't listed in the walker's manifest (`manipulation.lift`). The module list holds serial-v1 modules only.
