# Hardware inventory and integration plan

**Updated:** 2026-10-23. **Status:** purchased parts and proposed wiring, not an assembled or electrically verified device. The owner reports buying the two SO-101 kits, the InnoMaker cameras, and every item in the latest shopping cart. Delivery and exact contents of the boxes still need checking. A goBILDA battery and charger were discussed but have **not** been reported as purchased.

This page is the working inventory for the Cal Hacks prototype. Record substitutions, actual labels, measurements, and photos of the final wiring here before changing firmware assumptions. [Hardware and power guidance](../docs/subsystems/hardware-and-power.md) explains the safety and bench checks.

## Tested on 2026-10-24

The Raspberry Pi 5, 4 GB, from the compute row below ran on the official 27 W USB-C supply with Raspberry Pi OS Lite image "2026-10-06" (Debian 13 trixie, aarch64), and `vcgencmd get_throttled` read `0x0` (no undervoltage or throttling flagged since boot). Later that night the Pi ran the walker service with the USB gooseneck mic (SF-558, USB id `1b3f:0906`, ALSA card `SF558`), the USB soundbar (USB id `5a47:5858`, named `Speaker` by a udev rule) and the first hand ESP32 (`hand-left-01`, CP2102 `10c4:ea60`), and one spoken turn went through them end to end. Plugging those in while the Pi ran caused no shutdown; one hard power loss at 23:19 coincided with the soundbar dropping off USB (likely a knocked cable, unproven). Power draw, the hub and a battery or power bank aren't measured. What the Pi service did at each step is in [devices/pi/README.md](../devices/pi/README.md#set-up-the-pi).

## Purchased inventory

| Area | Item and quantity | Integration note |
| --- | --- | --- |
| Manipulation | Two SO-101 leader/follower kits; owner plans 12 V arm power | Mount the two follower arms; read the received servo/controller labels before applying 12 V, then inspect the power connector and included USB cables. The Amazon listing does not clearly inventory the cables or printed parts. |
| Cameras | One [InnoMaker 720p USB 2.0 UVC camera](https://www.amazon.com/dp/B0CLRJZG8D) and two [InnoMaker 1080p USB 2.0 UVC cameras](https://www.amazon.com/dp/B0CNCSFQC1), according to the order summary | Both models advertise MJPEG and YUY2. USB 3 cables do not increase their link speed. Confirm the physical plug and included cable on arrival. |
| Walker | Medline steel rollator, 350 lb user rating, 8-inch wheels | The user rating does not rate an added lift, high-mounted arms, or resistance to tipping. Keep battery mass low and preserve access to the handles. |
| Lift | VEVOR two HGR20 1000 mm rails, four blocks, RM1605 1000 mm ball screw, nut, BK12/BF12 supports, and a plum coupler | [VEVOR lists the kit at 11 kg](https://www.vevor.com/linear-guide-rail-c_10531/2x-linear-rail-hgr20-1000mm-4x-blocks-ballscrew-rm1605-1000mm-bf12-bk12-cnc-set-p_010531549953). The separately bought 5-to-10 mm coupler may be redundant; verify both bores before assembly. |
| Lift drive | STEPPERONLINE 17HS19-2004S1 NEMA 17, 2 A/phase, 59 Ncm, 5 mm shaft; Ophiner TB6600-type 9–42 V step/dir driver; ten roller limit switches | Set driver current from the *unit's* labeled table and motor specification. Home slowly, limit travel in firmware, and provide physical end stops. Measure lift behavior when power is removed. |
| Structure and fabrication | Four 2020 × 1000 mm aluminum extrusions; M5 T-nut/screw kit; M5 screw assortment; M5 nylon locknuts; 1 kg PLA filament | Printed parts can position or enclose hardware. Use a bolted, load-bearing path for the rail and arm assembly. Verify rail/block thread sizes; the M5 assortment is not a universal fit. The bought extrusion was estimated to arrive after the requested Thursday deadline. |
| Compute | Raspberry Pi 5 4 GB kit with case and active cooler; 64 GB microSD; 27 W USB-C AC supply | AC supply is for bench use. The 4 GB model is the planned Pi for cloud speech/agent processing. Confirm cooler and case fit together. |
| Battery power | 12/24 V-to-5 V 15 A buck; two DROK 9–36 V-to-12 V 5 A buck-boost regulators; two bare-wire-to-USB-C 20 AWG power pigtails; five small rocker switches | One 12 V regulator is proposed per follower arm; ratings are unverified against arm transients. The 5 V buck can feed Pi and powered USB hubs on separate branches. Do not use an unverified small rocker as the whole battery's disconnect. |
| USB | One Acer four-port USB 3 hub in this order, plus another already owned | The hub's USB-A lead carries data to the Pi; its USB-C socket is a **5 V input**. Power the hub from a separate 5 V branch. Count all devices and hub power leads before final routing. |
| Hand controls | Two ESP32-WROOM-32 USB-C dev boards; ten momentary buttons; two DRV2605L haptic boards; eight [VAKTOK 10 mm coin motors](https://www.amazon.com/dp/B0CC4LXNMZ) (listing advertises 3 V) | First Teyleten 38-pin board flashed as `hand-left-01` on 2026-10-24; its CP2102 bridge was identified, firmware detected the DRV2605L over I2C, and the owner confirmed the motor buzzed. A temporary P32-to-GND contact produced `talk` press events and accepted haptic commands; the owner felt the 1000 ms cue and reported the no-pause version felt stronger. The final button/touch sensor remains unsoldered. Measure motor voltage/current/temperature in this wiring before sustained use. |
| Proximity | Four TOF400C/VL53L1X ToF modules and two TCA9548A multiplexers (one two-pack) | One 8-channel mux is enough for four sensors sharing an I2C address. Keep I2C runs short; select ESP32 placement after measuring the walker. Proximity cues are advisory, not verified collision avoidance. |
| Audio and optional location | USB gooseneck microphone (SF-558), USB soundbar, NEO-6M GPS receiver | Pi USB audio replaces the proposed ESP32 voice hardware for the first build. Mic and soundbar recorded and played on the Pi 5 on 2026-10-24 (names and levels in the Pi README, step 5). GPS remains an unimplemented optional feature; it does not transmit a location by itself. |
| Assembly | Zip ties and prototyping perfboards | Use zip ties for cable management and strain relief, not as the sole lift mount. |

The latest pasted cart was about **$665.67 before battery, charger, tax, or shipping changes**. This is a snapshot of the user's cart, not a current quote. Do not publish the user's shipping address or order details in this repository.

## Proposed electrical layout

```text
12 V battery (candidate: goBILDA 3000 mAh NiMH with XT30 and 20 A fuse)
  → main disconnect and protected distribution (parts/circuit not selected)
      ├─ branch protection → 12 V buck-boost A → left follower arm
      ├─ branch protection → 12 V buck-boost B → right follower arm
      ├─ branch protection → TB6600-type lift driver → NEMA 17
      └─ branch protection → 5 V / 15 A buck
                                 ├─ short USB-C power lead → Pi 5
                                 ├─ separate 5 V USB-C lead → Acer hub 1
                                 └─ separate 5 V USB-C lead → hub 2, if used

Pi USB-A host → each hub's attached USB-A data lead → UVC cameras / ESP32 / audio / arm controllers
```

The 15 A rating is the converter's advertised *maximum available* current, not what the Pi consumes. Two bundled power pigtails cover the Pi and only **one** powered hub; powering both hubs requires another appropriate lead. The Pi 5 defaults to a 600 mA **total** downstream USB current limit when its USB-C input does not advertise 5 V/5 A. The project should use separately powered hubs for cameras/audio rather than assume a firmware override is safe. Raspberry Pi documents `usb_max_current_enable=1` as an option after supply capacity and cable voltage drop are verified. [Pi 5 USB power guidance](https://pip-assets.raspberrypi.com/categories/685-app-notes-guides-whitepapers/documents/RP-009856-WP-1-USB%20Power%20delivery%20on%20Raspberry%20Pi%205.pdf)

The candidate [goBILDA 12 V 3000 mAh NiMH battery](https://www.gobilda.com/content/user_manuals/3100-0012-0020_user-manual.pdf) has a 20 A fuse. Its nominal voltage and amp-hour rating are not a measured runtime or proof that the combined arm/lift peak loads will fit. Do not connect 12 V to the Pi or hub. Verify regulator input range over battery discharge, output polarity, branch protection, and 5 V *at the Pi* while the assembled USB load is active. Charge only with the battery's specified compatible charger, disconnected from the walker power tree unless a charging circuit is intentionally designed.

## USB and controller allocation (proposed)

| Connection | Interface | Notes |
| --- | --- | --- |
| Two follower arm controller boards | Inspect kit; likely USB serial | Confirm ports and provided leads from the actual kits. Do not infer a USB-C connector from the servo voltage. |
| Three InnoMaker cameras | USB 2.0 UVC | Prefer MJPEG at the required frame rate; check simultaneous enumeration and bandwidth. |
| Two hand ESP32 boards | USB serial through dev-board bridge | USB 2 data cables required if the board boxes do not include them. |
| USB microphone and soundbar | USB audio | Check Linux enumeration, capture/playback device selection, and combined hub power. |
| Lift controller | Prefer a dedicated ESP32 driving STEP/DIR/ENABLE and reading both end switches | The two purchased ESP32s are assigned to handles. A third board is a future purchase or the team must explicitly reassign one. The Pi must still authorize bounded moves. |

## Still to select or verify

1. **Battery and charger:** exact goBILDA part, actual purchase, charge procedure, runtime, and combined peak-current measurements.
2. **Power distribution:** branch fuses and holders, a connectorized main disconnect/stop path, insulated distribution, strain relief, and a wiring diagram. The candidate battery's built-in fuse is not a substitute for selecting branch protection.
3. **Mechanical mounts:** rail-to-frame clamps, bolted cross members, motor bracket, carriage/arm plate, travel stops, and a way to support the vertical carriage with power off. Print trial-fit parts; confirm that load-bearing joints are supported by appropriate metal hardware and the actual walker tubing.
4. **Fasteners:** compare actual rail, block, ball-nut, motor, and walker clamp hole sizes before buying M4/M5/M6 lengths. Assorted M5 nuts and screws do not establish fit.
5. **USB leads:** count the cables included in the arm/camera boxes; buy only missing USB 2 data cables. Another 5 V USB-C power lead is needed if both Acer hubs are externally powered from the battery.
6. **Arm and lift behavior:** controller pinout, arm startup/stall current, driver current setting, emergency stop wiring, end-switch wiring, homing repeatability, and worst-case gravity motion when disabled.
7. **Sensor placement:** ToF cable lengths, I2C voltage and stability, sensor blind spots, camera mounts, and audio feedback at walking height.

No moving- or human-support function should be described as validated until measurements and stop-path evidence are recorded.
