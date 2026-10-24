# Hardware, power, and physical safety guide

**For:** electrical and mechanical builders. Proposed home: `hardware/` for schematics, CAD, BOM, and bench records.

## Proposed power tree

```text
12 V battery + protection + main fuse + master switch
  ├─ protected motor rail → arm drivers + lift driver (with hardware disable)
  ├─ rated buck converter → regulated 5 V input for Raspberry Pi 5
  ├─ rated 5 V/3.3 V rails → USB hub, ESP32 modules, cameras/audio as required
  └─ optional protected GPS/other modules
```

This is conceptual. The Pi 5 needs a regulated 5 V supply sized for its peak draw and USB peripheral load; never connect the 12 V battery directly to Pi power or GPIO. The [Raspberry Pi 5 product brief](https://datasheets.raspberrypi.com/rpi5/raspberry-pi-5-product-brief.pdf) specifies a 5 V / 5 A input. Determine actual cable drop, transient behavior, USB power allocation, and whether a powered hub is required with all cameras/controllers connected. Separate noisy motor power from logic power with appropriate grounding and protection. An electrical lead should select fuses, wire gauge, connectors, charging/protection, and enclosure based on measured current and battery chemistry.

## Required bench records

Before mounting on a mobility aid, record: battery and protection part numbers; each converter's rated voltage/current and measured output under load; arm/lift stall and startup currents; Pi undervoltage behavior; USB device inventory and peak consumption; run time; temperatures; fuse choices; connector polarity; and what happens when the battery is removed or low. Keep the schematic and wiring diagram in sync with the real build. Label every cable and module ID.

## Physical stop and movement

Provide a reachable, easily recognized stop control that disables arm/lift drive through a hardware path independent of Pi, ESP32 USB, cloud, or speech. Verify how the chosen drivers behave when disabled and whether gravity can move the lift/arms. Add hard travel limits and guards against pinch points and cable snags. The walker base must remain stable with arms extended and the lift at its highest tested position. Do not mount or demonstrate autonomous arm motion near a user until the bench rig and stop behavior have been checked.

## Sensing and audio placement

ToF zones need a documented mounting diagram, measured coverage, and known blind spots. Hand controls need reachable positions on both sides and distinct tactile patterns. Mic and speaker placement should work in a noisy room without blocking environmental sound. Camera mounts must preserve a view of the working area while avoiding an obstructive protrusion. Protect electronics from exposed wires and accidental contact.

## Location module (deferred)

GPS is optional and not needed for the first demo. It can support a user-initiated “where is my walker?” or explicitly consented caregiver location feature later. Define accuracy/failure display, indoor limitations, who can see location, how sharing is turned off, and retention before enabling it. A missing GPS fix must not become a fabricated location.

## Reference and validation boundary

The [SO-100/101 camera mount guide](https://github.com/TheRobotStudio/SO-ARM100/blob/main/Optional/Overhead_Cam_Mount_32x32_UVC_Module/README.md) is a mechanical reference for the overhead camera, not a tested integration plan for this walker. The [Raspberry Pi 5 brief](https://datasheets.raspberrypi.com/rpi5/raspberry-pi-5-product-brief.pdf) informs the Pi input requirement. Board, converter, sensor, arm, and motor-driver datasheets must be attached to the BOM when parts are selected. The team must validate the complete assembled system; these documents do not establish certification or safe public use.
