// What the lift ESP32 does, whatever its board: the serial lines (lift.hello, lift.status, lift.done,
// lift.ack), the commands (home, move, stop, enable, clear), the hold lease, homing, the end switches and
// the soft limits. It implements rules 1 to 10 in the header of packages/contracts/src/lift-serial.ts
// (proposed, under review); comments name the rule. Plain C++ (no Arduino headers): the board passes in the
// time, the bytes it read and the two switch readings, and drives the motor through StepperPort. The native
// tests and the scripted session drive the same code with a simulated stepper on a fake clock.
//
// Rule 8 of AGENTS.md for the lift, as built here:
//   - Authorization and user initiation: a move or homing starts only from a valid line addressed to this
//     lift, with a seq above the last Pi seq it accepted, while the Pi's latest heartbeat names it as the
//     request a person at the walker is holding a control for (the hold lease), and its own stop-sense input
//     reads released. The Pi decides whether a person started
//     it (motion.ts); this board checks every command again against limits built into it.
//   - Range and speed: soft limits, top speed and acceleration are built in (LiftSettings, checked at build
//     time against the contract's ceilings) and reported in lift.hello. Nothing over serial changes them.
//   - Cancellation: letting go (a heartbeat naming anything else) or lift.stop (always accepted) ramps down
//     and holds. lift.enable false stops stepping at once, then frees the motor, but only with the carriage on
//     the bottom switch or on a build made disable-safe after a passed drop test (rule 6); otherwise it is
//     refused disable_unsafe and any motion ramps down and holds.
//   - Watchdog and lost communication: no heartbeat for LIFT_WATCHDOG_TIMEOUT_MS ramps down, holds and
//     latches watchdog_expired. The driver stays enabled (LIFT_WATCHDOG_DRIVER_ACTION "hold").
//   - Hardware: either end switch pressing stops stepping at once. The hardware stop switch (README) cuts
//     the STEP signal outside this code; this board also reads it (stop-sense) and latches
//     stop_circuit_opened, because steps the stop cut were counted but never taken.
#pragma once

#include <cstddef>
#include <cstdint>

#include "lift_motion.h"
#include "lift_protocol.h"
#include "module_core.h"  // LineOutput

namespace walker {
namespace lift {

// ---- Contract constants (motion.ts), every one a placeholder until measured ----
// packages/contracts/test/lift-firmware-session.test.ts checks each against motion.ts.
constexpr uint32_t kHomingFastMilliMmS = 15000;        // LIFT_HOMING_FAST_MM_S
constexpr uint32_t kHomingSlowMilliMmS = 2000;         // LIFT_HOMING_SLOW_MM_S
constexpr uint32_t kHomingBackoffMilliMm = 5000;       // LIFT_HOMING_BACKOFF_MM
constexpr uint32_t kHomingReleaseMarginMilliMm = 3000; // LIFT_HOMING_RELEASE_MARGIN_MM
constexpr uint32_t kHomingMaxTravelMilliMm = 1000000;  // LIFT_HOMING_MAX_TRAVEL_MM
constexpr uint32_t kHomingTimeoutMs = 100334;          // LIFT_HOMING_TIMEOUT_MS
constexpr uint32_t kStopDecelMilliMmS2 = 200000;       // LIFT_STOP_DECEL_MM_S2
constexpr uint32_t kWatchdogTimeoutMs = 300;           // LIFT_WATCHDOG_TIMEOUT_MS (= LIFT_HOLD_LEASE_MS)
constexpr uint32_t kStatusIntervalMs = 50;             // 1000 / LIFT_STATUS_HZ (20)
// Rule 7: each back-off must see the bottom switch release, and the slow approach see it press, within this.
constexpr uint32_t kHomingSearchMilliMm = kHomingBackoffMilliMm + kHomingReleaseMarginMilliMm;
// Firmware placeholder, not a contract constant: a switch reads released in lift.status only after this
// long released without a break (rule 10's "change of switch" would otherwise flood the link while a roller
// chatters). Stopping uses the raw reading.
constexpr uint32_t kSwitchReleaseMs = 20;

enum class WatchdogDriverAction : uint8_t { Hold, Disable };  // LIFT_WATCHDOG_DRIVER_ACTION

// Built into the firmware (LiftConfigSchema) and reported in lift.hello. Thousandths of a mm.
struct LiftSettings {
  uint32_t microsteps;
  uint32_t soft_min_milli_mm;
  uint32_t soft_max_milli_mm;
  uint32_t max_speed_milli_mm_s;
  uint32_t max_accel_milli_mm_s2;
  bool has_top_switch;
  uint32_t top_switch_milli_mm;
  WatchdogDriverAction watchdog_action;
  // Built to read a stop-sense input (lift.hello `stop_sense` "wired"); false only for a bench build.
  bool stop_sense_wired;
  // Rule 6: lift.enable false may free the motor away from the bottom switch (WALKER_LIFT_DISABLE_SAFE, set
  // only after a recorded passed drop test or with a brake fitted).
  bool disable_safe;
};

// The checks LiftConfigSchema makes, plus: the stop ramp is at least as steep as a move's, so a stop never
// runs past a move's own target; home (LIFT_HOMING_BACKOFF_MM) is inside the soft limits. Usable in a
// static_assert.
constexpr bool settingsValid(const LiftSettings& s) {
  return isMicrostepSetting(s.microsteps) && s.soft_min_milli_mm < s.soft_max_milli_mm &&
         s.soft_max_milli_mm <= kRailLengthMm * 1000 && s.max_speed_milli_mm_s > 0 &&
         s.max_speed_milli_mm_s <= kSpeedCeilingMmS * 1000 && s.max_accel_milli_mm_s2 > 0 &&
         s.max_accel_milli_mm_s2 <= kAccelCeilingMmS2 * 1000 && s.max_accel_milli_mm_s2 <= kStopDecelMilliMmS2 &&
         (!s.has_top_switch ||
          (s.soft_max_milli_mm < s.top_switch_milli_mm && s.top_switch_milli_mm <= kRailLengthMm * 1000)) &&
         s.soft_min_milli_mm <= kHomingBackoffMilliMm;
}

// The motor, as the core sees it. Positive steps go up. On the board: FastAccelStepper and the ENA pin.
class StepperPort {
 public:
  virtual ~StepperPort() = default;
  // Sets the driver's enable input (on: the motor holds; off: it is free).
  virtual void setDriverEnabled(bool enabled) = 0;
  // Moves to `target` at up to `speed` steps/s, ramping at `accel` steps/s². While running it may only
  // change the target in the same direction. False if the move couldn't start.
  virtual bool moveTo(int32_t target, uint32_t speed, uint32_t accel) = 0;
  // Ramps the running move down to a stop at `accel` steps/s².
  virtual void decelerate(uint32_t accel) = 0;
  // No further step, now.
  virtual void halt() = 0;
  virtual bool running() const = 0;
  // Steps counted since the last setPosition.
  virtual int32_t position() const = 0;
  // Called only while stopped.
  virtual void setPosition(int32_t steps) = 0;
};

struct LiftIdentity {
  const char* module_id;
  const char* firmware_version;
};

class LiftCore {
 public:
  LiftCore(const LiftIdentity& identity, const LiftSettings& settings, LineOutput& output, StepperPort& stepper);

  // Rule 1: not stepping, unhomed, no fault, driver enabled (holding); then lift.hello (seq 0) and a status.
  // `stop` is the stop-sense reading: Pressed if it read pressed at any moment since the last call (the
  // board latches the edge in an interrupt), NotWired on a build without the input.
  void begin(uint32_t now, bool bottomPressed, bool topPressed, StopSense stop);
  // Bytes read from the serial port.
  void receive(const uint8_t* data, size_t length, uint32_t now);
  // Call every loop with the raw switch readings (true: the switch reads pressed, or its wire is open).
  void update(uint32_t now, bool bottomPressed, bool topPressed, StopSense stop);

  // For tests.
  LiftState state() const;
  bool homed() const { return homed_; }
  bool driverEnabled() const { return driverEnabled_; }
  uint8_t faults() const { return faults_; }
  uint32_t nextSeq() const { return seq_; }
  // Lines the serial port couldn't take: statuses dropped (their seq is used, so the Pi sees the gap) and
  // acks, dones, hellos and errors that didn't fit in the outbox.
  uint32_t txDropped() const { return txDropped_; }

 private:
  enum class Activity : uint8_t { None, Move, Home };
  // Rule 7's four phases, in order.
  enum class Phase : uint8_t { FastApproach, BackOff, SlowApproach, FinalBackOff };
  // Why a running move or homing is ramping down: lift.stop, the person letting go, or the watchdog.
  enum class StopCause : uint8_t { None, Command, Release, Watchdog };

  void handleLine(const char* line, size_t length, uint32_t now);
  void handleCommand(const LiftPiLine& command, uint32_t now);
  void heartbeat(const LiftPiLine& line, uint32_t now);
  LiftRefusal motionRefusal(const LiftPiLine& command, uint32_t now) const;
  void commandMove(const LiftPiLine& command, uint32_t now);
  void commandHome(const LiftPiLine& command, uint32_t now);
  void commandStop(const LiftPiLine& command, uint32_t now);
  void commandEnable(const LiftPiLine& command, uint32_t now);
  void commandClear(const LiftPiLine& command, uint32_t now);

  void readSwitches(uint32_t now, bool bottomPressed, bool topPressed, StopSense stop);
  void checkSwitches(uint32_t now);
  void checkWatchdog(uint32_t now);
  void advance(uint32_t now);
  void advanceHoming(uint32_t now);

  bool heartbeatFresh(uint32_t now) const;
  bool causePresent(uint32_t now) const;
  void latch(LiftFault fault);
  void startStop(StopCause cause);
  void startHomingMove(Phase phase, int32_t target, uint32_t speedMilli, uint32_t now);
  // Stops at once, ends the running move or homing as failed, and latches the fault.
  void failNow(LiftFault fault, uint32_t now);
  // Ends the running move or homing with its one lift.done.
  void finish(LiftOutcome outcome, LiftFault fault, uint32_t now);
  void setDriver(bool enabled);
  void accept(const LiftPiLine& command, uint32_t now);

  void sendHello(uint32_t now);
  void sendStatus(uint32_t now);
  void maybeSendStatus(uint32_t now);
  void sendAck(const char* requestId, LiftRefusal refusal, uint32_t now);
  void sendError(Problem code, const char* detail, uint32_t now);
  // Sends the line just built in tx_. A status (critical false) that the port can't take is dropped; any
  // other line waits in the outbox, in order, and nothing newer goes out before it.
  bool emit(size_t length, bool critical = true);
  void drainOutbox();

  LiftStatusLine snapshot(uint32_t now) const;
  uint32_t positionMilliMm() const;
  int32_t steps(int64_t milliMm) const { return static_cast<int32_t>(milliMmToSteps(milliMm, settings_.microsteps)); }
  uint32_t rate(uint32_t milli) const { return milliToStepRate(milli, settings_.microsteps); }

  const LiftIdentity identity_;
  const LiftSettings settings_;
  LineOutput& output_;
  StepperPort& stepper_;
  LineReader reader_;
  char tx_[kMaxLineBytes] = {};
  uint32_t seq_ = 0;

  // Commands and the lease
  // Rule 3: the last Pi seq accepted (a fresh heartbeat or an accepted command) since the last hello.request.
  bool hasAcceptedSeq_ = false;
  uint64_t lastAcceptedSeq_ = 0;
  bool hasHeartbeat_ = false;
  uint32_t lastHeartbeat_ = 0;
  bool hasHold_ = false;
  char hold_[kMaxRequestIdLength + 1] = {};

  // Motion
  Activity activity_ = Activity::None;
  Phase phase_ = Phase::FastApproach;
  StopCause stopCause_ = StopCause::None;
  char activeRequest_[kMaxRequestIdLength + 1] = {};
  // Rule 4's request_used: the highest request counter accepted for a move or homing under each Pi boot
  // prefix since this lift booted. Sixteen prefixes are kept (sixteen Pi service restarts without a lift
  // reboot); once full, a new prefix is refused request_used rather than forgetting an old one, until the
  // lift board restarts.
  struct PrefixCounter {
    char prefix[7];
    uint32_t highest;
  };
  static constexpr size_t kPrefixCount = 16;
  PrefixCounter prefixes_[kPrefixCount] = {};
  bool requestUsed(const char* requestId) const;
  void recordRequest(const char* requestId);
  uint32_t targetMilliMm_ = 0;
  uint32_t homingStarted_ = 0;
  int32_t phaseStart_ = 0;     // where the current homing phase began, in steps
  int64_t travelBefore_ = 0;   // steps travelled by the homing's earlier phases
  bool homed_ = false;
  bool driverEnabled_ = false;
  uint8_t faults_ = 0;

  // Switches: raw readings stop the motor; reported ones drop to released only after kSwitchReleaseMs.
  bool rawBottom_ = false;
  bool rawTop_ = false;
  StopSense stop_ = StopSense::NotWired;
  bool bottomEdge_ = false;  // pressed this sample, released the one before
  // Homing trips only after two pressed samples in a row (one is noise); the zero is the first one's position.
  uint8_t bottomStreak_ = 0;
  int32_t bottomFirstPressed_ = 0;
  bool reportedBottom_ = false;
  bool reportedTop_ = false;
  uint32_t bottomReleasedSince_ = 0;
  uint32_t topReleasedSince_ = 0;

  // Status
  uint32_t nextStatus_ = 0;
  bool sentAny_ = false;
  LiftStatusLine last_ = {};
  bool lastHadRequest_ = false;

  // Outbox for lines the port couldn't take yet (acks, dones, hellos, errors), oldest first.
  static constexpr size_t kOutboxLines = 4;
  char outbox_[kOutboxLines][kMaxLineBytes] = {};
  size_t outboxLength_[kOutboxLines] = {};
  size_t outboxHead_ = 0;
  size_t outboxCount_ = 0;
  uint32_t txDropped_ = 0;
};

}  // namespace lift
}  // namespace walker
