// A simulated stepper for the native tests and the scripted session: a trapezoidal ramp (constant
// acceleration up to a top speed, constant deceleration to the target) stepped once per millisecond, in
// integers only (micro-steps and milli-steps per second), so every computer gets the same numbers.
//
// It stands in for FastAccelStepper on the board. It proves the lift logic drives "a stepper with a
// ramp" correctly; it proves nothing about FastAccelStepper, the TB6600 or the motor.
#pragma once

#include <cstdint>
#include <cstdio>

#include "lift_core.h"

namespace walker {
namespace sim {

class SimStepper : public lift::StepperPort {
 public:
  // Physical carriage: steps above where the bottom switch trips, at power-up.
  explicit SimStepper(int64_t startAboveBottomSteps = 0) : physical_(startAboveBottomSteps * kMicro) {}

  void setDriverEnabled(bool enabled) override {
    enabled_ = enabled;
    ++driverCalls;
  }
  bool moveTo(int32_t target, uint32_t speed, uint32_t accel) override {
    if (speed == 0 || accel == 0) return false;
    if (running()) {
      // FastAccelStepper re-plans a running move; the core only ever extends one in the same direction.
      const int64_t to = static_cast<int64_t>(target) * kMicro;
      if ((to - count_) * direction_ < 0 || decelerating_) return false;
      target_ = to;
      maxSpeed_ = static_cast<int64_t>(speed) * kMilli;
      accel_ = accel;
      ++moves;
      return true;
    }
    target_ = static_cast<int64_t>(target) * kMicro;
    direction_ = target_ >= count_ ? 1 : -1;
    maxSpeed_ = static_cast<int64_t>(speed) * kMilli;
    accel_ = accel;
    lastAccel = 0;
    active_ = true;
    peakSpeed = 0;
    ++moves;
    return true;
  }
  void decelerate(uint32_t accel) override {
    if (!active_) return;
    accel_ = accel;
    // The new target is where a ramp at `accel` from the present speed comes to rest.
    const int64_t stop = speed_ * speed_ / (2 * static_cast<int64_t>(accel));  // micro-steps
    target_ = count_ + direction_ * stop;
    decelerating_ = true;
  }
  void halt() override {
    if (active_ && haltOvershootSteps > 0) {
      // Steps already queued in the step generator go out before it stops.
      const int64_t extra = direction_ * haltOvershootSteps * kMicro;
      count_ += extra;
      if (enabled_) physical_ += (inverted ? -1 : 1) * extra;
    }
    active_ = false;
    decelerating_ = false;
    speed_ = 0;
    count_ = floorDiv(count_, kMicro) * kMicro;  // the step in progress isn't taken
    ++halts;
  }
  bool running() const override { return active_; }
  int32_t position() const override { return static_cast<int32_t>(floorDiv(count_, kMicro)); }
  void setPosition(int32_t steps) override {
    // The carriage doesn't move; only the count changes.
    count_ = static_cast<int64_t>(steps) * kMicro;
  }

  // One millisecond. Moves only with the driver enabled (a disabled driver ignores step pulses, so the
  // count would run on while the carriage stays: the reason the core clears homed when it disables).
  void tick() {
    if (!active_ || stalled) return;
    const int64_t a = static_cast<int64_t>(accel_);  // milli-steps/s gained or lost in 1 ms
    const int64_t remaining = (target_ - count_) * direction_;
    // Micro-steps needed to stop from the present speed: v² / 2a.
    const int64_t stopping = speed_ * speed_ / (2 * a);
    int64_t next;
    if (decelerating_) {
      next = speed_ > a ? speed_ - a : 0;
    } else if (stopping >= remaining) {
      next = speed_ > 2 * a ? speed_ - a : a;  // ramp down, creeping at the lowest rate near the end
    } else {
      next = speed_ + a < maxSpeed_ ? speed_ + a : maxSpeed_;
    }
    const int64_t change = next > speed_ ? next - speed_ : speed_ - next;
    if (change > lastAccel) lastAccel = change;
    // Micro-steps moved in 1 ms at v milli-steps/s is v itself; the average of the speeds at the tick's
    // two ends makes a ramp cover exactly v² / 2a.
    int64_t moved = (speed_ + next) / 2;
    speed_ = next;
    if (speed_ > peakSpeed) peakSpeed = speed_;
    if (moved >= remaining) {
      moved = remaining > 0 ? remaining : 0;
      active_ = false;
    } else if (decelerating_ && speed_ == 0) {
      active_ = false;
    }
    if (!active_) {
      decelerating_ = false;
      speed_ = 0;
    }
    const int64_t before = floorDiv(count_, kMicro);
    count_ += direction_ * moved;
    if (enabled_) physical_ += (inverted ? -1 : 1) * (floorDiv(count_, kMicro) - before) * kMicro;
  }

  // Steps above the bottom switch's trip point, where the carriage really is.
  int64_t physicalSteps() const { return floorDiv(physical_, kMicro); }
  bool enabled() const { return enabled_; }

  // For the ramp checks (LM5): milli-steps/s.
  int64_t peakSpeed = 0;
  int64_t lastAccel = 0;  // largest speed change in one tick, milli-steps/s
  // Steps a halt still sends (the step generator's queue); 0: none.
  int64_t haltOvershootSteps = 0;
  // A step generator that stopped producing pulses: a move never ends.
  bool stalled = false;
  // A motor wired to turn the other way: counted up is physically down.
  bool inverted = false;
  int moves = 0;
  int halts = 0;
  int driverCalls = 0;

 private:
  static constexpr int64_t kMicro = 1000000;  // micro-steps per step
  static constexpr int64_t kMilli = 1000;     // milli-steps/s per step/s
  static int64_t floorDiv(int64_t a, int64_t b) { return a >= 0 ? a / b : -((-a + b - 1) / b); }

  int64_t count_ = 0;     // micro-steps, as counted
  int64_t physical_ = 0;  // micro-steps above the bottom trip point
  int64_t target_ = 0;
  int64_t speed_ = 0;  // milli-steps/s, never negative
  int64_t maxSpeed_ = 0;
  uint32_t accel_ = 0;
  int64_t direction_ = 1;
  bool active_ = false;
  bool decelerating_ = false;
  bool enabled_ = false;
};

}  // namespace sim
}  // namespace walker
