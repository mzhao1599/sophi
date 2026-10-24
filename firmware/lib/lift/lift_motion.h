// Step and ramp arithmetic for the lift: millimetres to steps and back, speeds and accelerations in
// steps, and stopping distances. Plain C++, integer arithmetic wherever a number reaches the wire, so
// every computer (and the ESP32) prints the same digits.
//
// Mechanics, from part names and the contract (motion.ts), none measured on our parts:
//   17HS19-2004S1 stepper: 200 full steps a turn (LIFT_MOTOR_FULL_STEPS_PER_TURN)
//   RM1605 ball screw: 5 mm a turn (LIFT_SCREW_LEAD_MM)
//   microsteps: set on the TB6600's DIP switches, and built into the firmware to match
#pragma once

#include <cstdint>

namespace walker {
namespace lift {

constexpr uint32_t kFullStepsPerTurn = 200;  // LIFT_MOTOR_FULL_STEPS_PER_TURN
constexpr uint32_t kScrewLeadMm = 5;         // LIFT_SCREW_LEAD_MM
constexpr uint32_t kRailLengthMm = 1000;     // LIFT_RAIL_LENGTH_MM
constexpr uint32_t kSpeedCeilingMmS = 50;    // LIFT_SPEED_CEILING_MM_S
constexpr uint32_t kAccelCeilingMmS2 = 200;  // LIFT_ACCEL_CEILING_MM_S2

constexpr bool isMicrostepSetting(uint32_t m) { return m == 1 || m == 2 || m == 4 || m == 8 || m == 16 || m == 32; }

// 200 × microsteps / 5: 40 at full step, 320 at 8. Always a whole number, because 200 / 5 is.
constexpr uint32_t stepsPerMm(uint32_t microsteps) { return kFullStepsPerTurn * microsteps / kScrewLeadMm; }
static_assert(kFullStepsPerTurn % kScrewLeadMm == 0, "steps per mm must be a whole number");

// Thousandths of a millimetre to the nearest step.
constexpr int64_t milliMmToSteps(int64_t milliMm, uint32_t microsteps) {
  const int64_t scaled = milliMm * static_cast<int64_t>(stepsPerMm(microsteps));
  return scaled >= 0 ? (scaled + 500) / 1000 : -((-scaled + 500) / 1000);
}

// Steps to the nearest thousandth of a millimetre (what lift.status reports). Halves round up.
constexpr int64_t stepsToMilliMm(int64_t steps, uint32_t microsteps) {
  const int64_t spm = static_cast<int64_t>(stepsPerMm(microsteps));
  const int64_t scaled = steps * 1000 * 2;
  return scaled >= 0 ? (scaled / spm + 1) / 2 : -((-scaled / spm + 1) / 2);
}

// A speed or acceleration given in thousandths (of mm/s or mm/s²) in steps per second (or per second²),
// rounded to the nearest whole step.
constexpr uint32_t milliToStepRate(uint32_t milli, uint32_t microsteps) {
  return static_cast<uint32_t>((static_cast<uint64_t>(milli) * stepsPerMm(microsteps) + 500) / 1000);
}

// Steps needed to stop from `speed` steps/s at `accel` steps/s²: v² / 2a, rounded up.
constexpr uint64_t stoppingSteps(uint64_t speed, uint64_t accel) {
  return accel == 0 ? 0 : (speed * speed + 2 * accel - 1) / (2 * accel);
}

}  // namespace lift
}  // namespace walker
