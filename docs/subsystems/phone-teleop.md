# Two phones, two follower arms

**Status, 2026-10-25:** standalone operator harness imported into
[`devices/pi/phone-teleop`](../../devices/pi/phone-teleop/README.md). The originating
Pi 5 installation communicated with six motors and matched saved calibration on
each SO-101 follower; its operator demonstrated phone translation and gripper
control. The combined dashboard was served from that Pi. Session reset was
verified with simulated controller processes and deployed there, but was not
physically exercised during dashboard deployment. This repository import was
checked offline, not redeployed to the walker. Intermittent network loss and
implausible temperature packets remain unresolved in that installation.

## Boundary and ownership

This Python tool is separate from the TypeScript walker motion coordinator,
its Confirm flow, taught skills, lift control, and cloud-facing contracts. It is
not evidence that those components have moved real arms, and it does not connect
the phones to `sophi.work` or the walker screen on port 8740. `follower_1` and
`follower_2` are installation identities, not a verified left/right assignment.

```text
HEBI/mobileIO-follower1 -> receiver :8766 -> follower_1 state -> controller -> USB board 1
HEBI/mobileIO           -> receiver :8765 -> follower_2 state -> controller -> USB board 2
                                    ^
                        combined dashboard :8767
                         status / pause / release / reset
```

Each controller owns one serial adapter and uses that physical arm's calibration.
Receivers bind distinct phone identities, and all processes use per-device locks.
Only the controller opens serial; the dashboard reads receiver HTTP state and can
request a supported release before starting a replacement controller. On Linux,
serial ownership also uses `TIOCEXCL`. This cannot evict an already-open descriptor.

Keep `steady-walker.service` running when others use it. Before starting the
harness, arrange exact adapter access/exclusions so neither its serial scanner
nor its motion coordinator opens these two adapters. **Do not set the walker's
`WALKER_ARM_*` variables to the harness-owned ports as a shortcut for exclusion:**
those settings also enable its arm coordinator. Use dedicated adapter permissions
and verify actual ownership as described in the harness's
[USB guide](../../devices/pi/phone-teleop/docs/operations.md#usb-ownership).
No blanket USB rules, shared-hub resets, or service restarts are part of this import.
Do not run arm diagnostics, another receiver, or another controller against an
owned channel. Do not switch stacks while either owns the arm port.

## Run and use it

Follow the component's [install and setup steps](../../devices/pi/phone-teleop/README.md).
It has its own Python environment and config; it is not installed by pnpm or
`scripts/install-pi.sh`. Keep calibration, pairings, USB paths, and logs local.
The example config has placeholders that must be replaced for the actual arms.

After both phone receivers and controllers are running, from that component's
folder and Python environment:

```bash
python harness/dual_dashboard.py --config config.toml --manage-sessions
```

From the operator's computer, forward port 8767 with SSH to the chosen Pi, then
open `http://127.0.0.1:8767/`. The component README includes the tunnel command.
Opening the page starts no motor session. Do not expose the local HTTP service
through a public reverse proxy: loopback and the authenticated SSH tunnel are its
access boundary, not Sophi account authentication.

Hold the phone flat, screen up, top forward. Hold B1 and translate the phone to
move; release B1 to hold and recenter. A3 controls the gripper while B1 is held.
A phone's AR tracking is required; the robot cameras are not used here.

## Command authority and failure behavior

The following describe this harness, not `motion.ts` or the lift contract:

| Action | Authorization and effect | Completion / interruption |
| --- | --- | --- |
| B1 + translation | Paired phone; fresh B1 release/press starts at measured pose, then hold-to-move with positional IK | Release B1 or lose fresh phone input: hold, require release/repress to resume |
| A3 while B1 held | Same paired phone; normalized slider in [-1, 1], clamped to calibrated gripper range | Release B1 stops new gripper goals; unreachable IK also pauses gripper commands |
| Pause | Operator on local dashboard; requests a pose hold | Fresh B1 release/press resumes; not torque-off |
| Release | Explicit support confirmation on that arm's card | Controller disables torque, verifies it, reports motors off and exits; failure stays explicit |
| Reset | Support/base/workspace confirmation; B1 released and A3 centered when phone is connected | Releases existing session, waits up to 12 s for its lock and fresh verified-off status, starts replacement, waits up to 30 s for matching process ID/status; failure never force-kills an owner or claims readiness |

Code limits: phone input must be under 0.3 s old, goal speed is 120 ticks/s with
at most 8 ticks per update, lead is 32 ticks, tracking faults above 40 ticks,
and body targets keep a 40-tick calibration margin. Translation is half scale.
The [operating-limit table](../../devices/pi/phone-teleop/docs/operations.md#implemented-operating-limits)
records temperature/current/voltage/output caps. These are implemented values,
not independently measured safety guarantees. No limits were raised for this import.

There is no autonomous motion, collision avoidance, lift coordination, or handle
Confirm integration. Ordinary phone loss pauses/holds; hard health faults release
torque. A process crash can leave the last goal holding: no separate hardware
watchdog is implemented by this harness. Dashboard disconnection does not stop
phone control, and the page reports unavailable motor state as unknown. SIGINT
and SIGTERM request a controller pause; use supported release to end it.

## Local data and verification

The local state directory contains phone pairing/MAC data, phone input, motor
status, positions, command files and event logs. These are operator-only files,
ignored by Git, with no cloud upload or automatic retention limit in this harness.
After sessions and receivers stop, the operator can archive/delete these local
files; preserve each arm's calibration and intentional phone pairing for reuse.
The dashboard reset log also stays in that arm's state directory.

Run the 57-test Python suite from the component folder, as documented there.
It tests motion pacing and guards offline plus actual local HTTP requests and
file-lock/process handoff against fake receivers/controllers. Tests never open
robot serial ports or subscribe to live phones. The existing Sophi CI still runs
its own TypeScript/firmware checks; it does not cover this Python suite.

Code is MIT licensed; the bundled unmodified SO-101 model retains its Apache-2.0
license, source commit and asset hashes. HEBI/LeRobot/Placo are installed externally.
