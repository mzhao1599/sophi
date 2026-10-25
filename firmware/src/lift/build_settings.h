// The lift board's pins, build settings and the checks that stop a build breaking the contract. Included by
// src/lift/main.cpp, and by test/provision/lift_check.cpp so run-native.sh can show bad settings stop the build.
#pragma once

#include <cstdint>

#include "lift_core.h"
#include "lift_protocol.h"
#include "provision.h"

// ---- Build settings (platformio.ini [env:lift], or WALKER_LIFT_* flags; see firmware/README.md) ----

// Inferred from an approximately 4:1 commanded-to-actual travel mismatch with 8 configured.
// Confirm against a measured short move; the driver's DIP table has not been verified.
#ifndef WALKER_LIFT_MICROSTEPS
#define WALKER_LIFT_MICROSTEPS 32
#endif
#ifndef WALKER_LIFT_SCALE_NUMERATOR
#define WALKER_LIFT_SCALE_NUMERATOR 1
#endif
#ifndef WALKER_LIFT_SCALE_DENOMINATOR
#define WALKER_LIFT_SCALE_DENOMINATOR 1
#endif
// The GPIO level on ENA+ that leaves the driver ENABLED (holding). Most TB6600-type drivers treat current
// through the ENA opto as "disable" (free the motor), so with ENA- to GND the default 0 (LOW, no current)
// is enabled, and an ESP32 that is resetting or unpowered (pin floating, no current) leaves it enabled too.
// If the received unit only holds with current through ENA, rewire it (an inverter, or a pull-up that keeps
// it enabled while the pin floats) rather than rebuilding: with level 1 a resetting ESP32 would free the
// motor. Level 1 builds only with WALKER_LIFT_HW_INVERTER=1, which says that hardware is fitted.
#ifndef WALKER_LIFT_ENA_ENABLE_LEVEL
#define WALKER_LIFT_ENA_ENABLE_LEVEL 0
#endif
#ifndef WALKER_LIFT_HW_INVERTER
#define WALKER_LIFT_HW_INVERTER 0
#endif
// The GPIO level on DIR+ expected to move the carriage UP. On 2026-10-25 a commanded 650 -> 550 mm move
// physically raised the assembled carriage to 750 mm with level 0 configured. With level 1, an
// owner-commanded upward move physically went up. There is no physical height sensor.
#ifndef WALKER_LIFT_DIR_UP_LEVEL
#define WALKER_LIFT_DIR_UP_LEVEL 1
#endif
// 1: the stop switch's second (normally closed) contact is wired to the stop-sense pin. 0 only for a bench
// build without it: lift.hello then says "not_wired", and the Pi refuses motion outside bench mode.
#ifndef WALKER_LIFT_STOP_SENSE
#define WALKER_LIFT_STOP_SENSE 1
#endif
// One-off supervised demo: no switches, an estimated origin journaled on this ESP32.
#ifndef WALKER_LIFT_ESTIMATED_DEMO
#define WALKER_LIFT_ESTIMATED_DEMO 0
#endif
// 1 lets lift.enable false free the motor away from the bottom switch (rule 6). Set only after the drop test
// passed and is recorded in hardware/current-build.md, or with a brake fitted.
#ifndef WALKER_LIFT_DISABLE_SAFE
#define WALKER_LIFT_DISABLE_SAFE 0
#endif

static_assert(walker::isLiftModuleId(WALKER_MODULE_ID),
              "WALKER_MODULE_ID must be a lift id such as lift-01 (see firmware/README.md)");
static_assert(walker::lift::isMicrostepSetting(WALKER_LIFT_MICROSTEPS),
              "WALKER_LIFT_MICROSTEPS must be 1, 2, 4, 8, 16 or 32, matching the driver's DIP switches");
static_assert(WALKER_LIFT_ENA_ENABLE_LEVEL == 0 || WALKER_LIFT_ENA_ENABLE_LEVEL == 1,
              "WALKER_LIFT_ENA_ENABLE_LEVEL must be 0 or 1");
static_assert(WALKER_LIFT_HW_INVERTER == 0 || WALKER_LIFT_HW_INVERTER == 1, "WALKER_LIFT_HW_INVERTER must be 0 or 1");
static_assert(WALKER_LIFT_ENA_ENABLE_LEVEL == 0 || WALKER_LIFT_HW_INVERTER == 1,
              "WALKER_LIFT_ENA_ENABLE_LEVEL=1 would free the motor whenever the ESP32 resets: rewire ENA (an "
              "inverter or a pull-up, firmware/README.md) and say so with WALKER_LIFT_HW_INVERTER=1");
static_assert(WALKER_LIFT_DISABLE_SAFE == 0 || WALKER_LIFT_DISABLE_SAFE == 1, "WALKER_LIFT_DISABLE_SAFE must be 0 or 1");
static_assert(WALKER_LIFT_DIR_UP_LEVEL == 0 || WALKER_LIFT_DIR_UP_LEVEL == 1,
              "WALKER_LIFT_DIR_UP_LEVEL must be 0 or 1");
static_assert(WALKER_LIFT_STOP_SENSE == 0 || WALKER_LIFT_STOP_SENSE == 1, "WALKER_LIFT_STOP_SENSE must be 0 or 1");
static_assert(WALKER_LIFT_ESTIMATED_DEMO == 0 || WALKER_LIFT_ESTIMATED_DEMO == 1,
              "WALKER_LIFT_ESTIMATED_DEMO must be 0 or 1");
static_assert(!WALKER_LIFT_ESTIMATED_DEMO || !WALKER_LIFT_STOP_SENSE,
              "the estimated demo build has no wired stop sense");

namespace walker {
namespace lift {
namespace build {

// ---- Pins (README "Lift board: wiring" says why each) ----
constexpr uint8_t kStepPin = 33;       // directly to PUL+ on the bench; through the stop contact when fitted
constexpr uint8_t kDirPin = 25;        // DIR+
constexpr uint8_t kEnablePin = 26;     // ENA+
constexpr uint8_t kBottomPin = 32;     // bottom (home) switch, normally closed to GND
constexpr uint8_t kTopPin = 27;        // optional top switch, normally closed to GND
constexpr uint8_t kStopSensePin = 13;  // the stop switch's sense contact, normally closed to GND

// Rule 1: never a strapping pin (GPIO 0, 2, 5, 12, 15) or a flash pin (6 to 11); every input needs the
// internal pull-up, which GPIO 34 to 39 don't have.
constexpr bool usablePin(uint8_t pin) {
  return pin != 0 && pin != 2 && pin != 5 && pin != 12 && pin != 15 && !(pin >= 6 && pin <= 11) && pin < 34;
}
static_assert(usablePin(kStepPin) && usablePin(kDirPin) && usablePin(kEnablePin) && usablePin(kBottomPin) &&
                  usablePin(kTopPin) && usablePin(kStopSensePin),
              "a lift pin is a strapping, flash or input-only pin (WALKER_ pin rule, lift-serial.ts rule 1)");

constexpr uint8_t kEnableLevel = WALKER_LIFT_ENA_ENABLE_LEVEL;
constexpr uint8_t kDisableLevel = WALKER_LIFT_ENA_ENABLE_LEVEL == 0 ? 1 : 0;
constexpr bool kStopSenseWired = WALKER_LIFT_STOP_SENSE == 1;
constexpr bool kDisableSafe = WALKER_LIFT_DISABLE_SAFE == 1;
constexpr bool kEstimatedDemo = WALKER_LIFT_ESTIMATED_DEMO == 1;

// The configuration built into this firmware and reported in lift.hello (placeholders, not measured):
// soft limits 5 to 600 mm, 20 mm/s and 50 mm/s² (MOTION_LIMITS.normal), top switch position unmeasured.
constexpr LiftSettings kSettings{WALKER_LIFT_MICROSTEPS, 5000, kEstimatedDemo ? 950000u : 600000u,
                                 kEstimatedDemo ? 10000u : 20000u, kEstimatedDemo ? 25000u : 50000u, false, 0,
                                 WatchdogDriverAction::Hold, kStopSenseWired, kDisableSafe,
                                 WALKER_LIFT_SCALE_NUMERATOR, WALKER_LIFT_SCALE_DENOMINATOR};
static_assert(settingsValid(kSettings), "the lift's built-in limits break the contract");

}  // namespace build
}  // namespace lift
}  // namespace walker
