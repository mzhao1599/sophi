# The lift client (`src/motion/lift/`)

**Status, 2026-10-24: written and tested against a simulated lift only.** It has never talked to the lift board, and the walker service and the motion coordinator don't use it yet. Only `walker simulate --lift` runs it, from a labelled stand-in loop. Expected results: [test/EXPECTED.md](../../../test/EXPECTED.md#the-lift-adapter-srcmotionlift-added-2026-10-24), rows L, LP, LF and LW.

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
| `start(action, inputs, now)` | After the handle Confirm press on a `lift.home` / `lift.move` target is accepted | Runs the `"start"` verdict again, which adds `not_held`. Then it queues the request; the next tick writes `[lift.enable true if the driver is off,] heartbeat naming R, lift.home / lift.move`. Returns `{ ok, requestId }` or `{ ok: false, refusal }`. |
| `stop()` | Any `motion.stop` (handle press, screen, terminal, guard), and **on every fault the coordinator latches** | Writes `lift.stop` at once in every state. If the port is busy, it goes on the next tick. With no ack, it is resent up to LIFT_STOP_RETRIES times. The running request is never named again. |
| `disable(inputs, now)` | After the Confirm press on a `lift.disable` target | Writes `lift.enable` false only when `liftMayDisable`. The firmware may still refuse it with `disable_unsafe` (rule 6); see the `disable` event. Never use it as a stop. |
| `clearFaults()` | After a confirmed local `fault.clear` | Queues `lift.clear`; the answer comes as the `clear` event. |
| `markUnhomed()` | The coordinator latched a fault in FAULTS_THAT_UNHOME_LIFT from elsewhere (its own stop-sense, say) | The Pi's homed goes false until a homing completes. |
| `state(now)` | Building `MotionState.lift` | Returns a `LiftStateSchema` value (L18). |
| `active()` | Building `MotionState.active` | Returns `{ requestId, kind, phase: "starting" \| "running" \| "stopping", held, target_mm }` or null. Use `hold_source: "screen_hold_control"` exactly while `phase === "running"`. |

`inputs` (`LiftCheckInputs`) is what only the coordinator knows: `stopCircuit` (its own stop-sense reading), `faultLatched` (any motion fault latched), `armsStowed` (every fitted follower at `stowed`, torque on), and `otherMotion` (an arm command is running).

**Events** (`LiftEvent`):

- `link`: the lift is heard, or lost.
- `accepted`, then `ended` with `outcome`: `completed`, `stopped`, `failed` (with `fault`), `refused` (with `reason`), `no_ack`, `timeout` or `lost`.
- `fault` with a `MotionFaultCode` for the coordinator to latch. This is every lift fault newly seen in `lift.status`, plus the client's own: `lift_module_lost`, `lift_config_mismatch`, `motion_timeout` and `lift_unhomed`. The coordinator latches it, applies FAULT_REACTION, and calls `stop()`.
- `clear`: the answer to `lift.clear` (`cleared`, `refused` with `cause_present`, or `no_ack`).
- `disable`: the answer to a disable (`disabled`, `refused` with `disable_unsafe`, or `no_ack`).

## Wiring it into the coordinator (not done here)

This branch doesn't edit the coordinator's files (`claude/motion-arms`). To wire the client in:

1. In `createPiMotion` (or wherever `MotionSetup` is loaded): when `setup.lift` isn't null, build the `LiftClient` with `setup.lift`, the bench flag and the coordinator's clock, and call `modules.setLiftHandler(lift)` before `scanner.start()`. In `run.ts`, that means passing `modules` into `createPiMotion`.
2. In the coordinator's control loop, call `lift.tick(now)` on every tick, and from nowhere else.
3. Route the screen's hold-control refresh and release to `holdRefresh` and `holdRelease`. The walker screen's server already stamps each with the Pi's monotonic receive time and puts it on the bus as `screenHold` (`src/screen/server.ts`), so this is one line: `bus.on("screenHold", (h) => (h.pressed ? lift.holdRefresh(h.atMono) : lift.holdRelease(h.atMono)))`.
4. When preparing a lift Confirm target, call `lift.verdict(action, inputs, "prepare", now)`. When the press is accepted, call `lift.start` (home or move) or `lift.disable`. For `fault.clear`, call `lift.clearFaults()` along with the coordinator's own clear, and clear lift faults only on the `clear` event's `cleared`.
5. On `motion.stop` and on every latched fault, call `lift.stop()`. On a fault in FAULTS_THAT_UNHOME_LIFT, also call `lift.markUnhomed()`.
6. Map events to the motion state: `fault` → latch with part `lift`; `ended` → `last_command`; `state()` and `active()` → `MotionState.lift` and `active`.
7. `walker simulate --arms --lift`: drop the stand-in in `src/sim/liftSim.ts` and give the real coordinator the `SimulatedLiftBoard`, keeping its fault keys.

## What isn't here

- Accel: `lift.move` carries no acceleration, so the bench mode's lower `lift_accel_mm_s2` (MOTION_LIMITS) can't be applied. The firmware uses its built-in `max_accel_mm_s2`.
- The lift isn't listed in the walker's manifest (`manipulation.lift`). The module list holds serial-v1 modules only.
