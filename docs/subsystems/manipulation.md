# Arms, cameras, and lift guide

**For:** the robotics and Pi developers integrating two SO-101 arms, an overhead camera, gripper cameras, and a ball-screw linear lift.

## Intended hardware

Two SO-101 arms are mounted on/near the walker and move in a bounded work area. The referenced [SO-100/101 overhead camera mount guide](https://github.com/TheRobotStudio/SO-ARM100/blob/main/Optional/Overhead_Cam_Mount_32x32_UVC_Module/README.md) describes a 32 × 32 mm camera module mount and optional gripper cameras. It does not validate a walker installation, USB bandwidth, payload, or lift design. The Pi should connect to the actual arm driver/controller and UVC camera devices only after their exact models are confirmed. A stepper driver moves the ball-screw lift, with homing and limit switches independent of camera inference.

## What a manipulation task does

1. User requests a concrete task (e.g., pick up a light cup) and confirms the target/destination if ambiguous.
2. Pi verifies arms/cameras/lift/stop circuit are healthy and the workspace has been calibrated. It captures a bounded set of frames and arm/lift state.
3. A manipulation planner proposes a short plan. It must identify uncertainty or ask the user instead of guessing an unseen object.
4. User gives an explicit start signal. Pi checks hard limits and a deterministic motion policy, then executes one short segment at a time.
5. Pi monitors feedback and local stop input continuously. It can pause, reobserve, replan, or abort. It reports progress and a plain-language outcome.

Start with a fixed, repeatable tabletop pickup on a bench rig before mounting arms to a walker. A moving walker base changes the geometry; manipulation should be disabled unless the base is stationary/braked and this is detected or explicitly enforced. Document every supported object, payload, reach, and surface after testing.

## Planning versus control

The cloud planner can decide *what* object or goal to try and use camera frames for scene understanding. It cannot set raw servo targets, skip homing, change limits, or disable stops. The Pi holds calibration, kinematics, workspace boundaries, lift travel limits, speed/acceleration limits, current/force thresholds where measurable, and a watchdog. Inverse kinematics, collision checks, and trajectory generation belong in deterministic robotics code. The planner receives success/failure observations and may ask for another bounded attempt within an explicit retry budget.

Avoid sending continuous video to the cloud by default. Capture just the frames needed for a task, resize/compress after measuring quality, and apply short retention. Verify camera codec (for example UVC MJPEG if supported by the actual camera), USB bandwidth, frame timing, and whether all cameras can run concurrently on the Pi. Do not assume the linked mount's recommended settings will work on this walker.

## Lift and mechanical controls

The ball-screw lift needs a load-rated mount, anti-pinch design, home sensor, upper/lower limits, a driver enable line, and behavior for power loss. Its safe travel, speed, and allowable arm poses must be measured. Plan lift motion as a separate guarded segment; keep arms in a documented stowed pose while the lift moves unless a tested procedure allows otherwise. Cable routing must tolerate full lift travel and arm movement without snagging. The physical stop should disable lift and arm motion through hardware.

## Fault states

Do not start if camera or pose feedback is stale, arm is unhomed, lift is unhomed, base is moving, stop is active, or capability/configuration is mismatched. Stop and latch a fault on limit hit, driver error, unexpected current/force, feedback divergence, watchdog expiry, or communication loss. A cloud retry cannot reset a fault. A human inspects and deliberately clears it through a documented local procedure.

## Integration deliverables

Keep an arm/lift wiring diagram, calibration record, tested workspace diagram, safe pose and stop procedure, sample camera frames, power measurements, and command/feedback logs in `hardware/` or `devices/pi/` as appropriate. Label the exact SO-101 variant and controller firmware. Demonstrate stop behavior with cloud disconnected before connecting the manipulation planner.
