#include "lift_core.h"

#include <cmath>

namespace walker {
namespace lift {

namespace {

bool isCommand(LiftMessageType type) {
  return type == LiftMessageType::Home || type == LiftMessageType::Move || type == LiftMessageType::Stop ||
         type == LiftMessageType::Enable || type == LiftMessageType::Clear || type == LiftMessageType::SetPosition;
}

void copyId(char* out, const char* in) {
  size_t i = 0;
  for (; i < kMaxRequestIdLength && in[i] != '\0'; ++i) out[i] = in[i];
  out[i] = '\0';
}

// What rule 10 counts as a change: everything in a status except the clock, the height and the heartbeat age.
bool sameStatus(const LiftStatusLine& a, const LiftStatusLine& b, bool aRequest, bool bRequest) {
  return a.state == b.state && a.homed == b.homed && a.driver_enabled == b.driver_enabled &&
         a.top_pressed == b.top_pressed && a.bottom_pressed == b.bottom_pressed && a.stop_sense == b.stop_sense &&
         a.faults == b.faults &&
         aRequest == bRequest && a.has_target == b.has_target && a.target_milli_mm == b.target_milli_mm;
}

}  // namespace

LiftCore::LiftCore(const LiftIdentity& identity, const LiftSettings& settings, LineOutput& output, StepperPort& stepper,
                   bool allowHoming, PositionSaver savePosition)
    : identity_(identity), settings_(settings), allowHoming_(allowHoming), savePosition_(savePosition), output_(output), stepper_(stepper) {}

// ---- Boot, input, loop ----

void LiftCore::begin(uint32_t now, bool bottomPressed, bool topPressed, StopSense stop) {
  // Rule 1. (The board already set the step and enable pins before anything else; see src/lift/main.cpp.)
  stepper_.halt();
  setDriver(true);
  rawBottom_ = reportedBottom_ = bottomPressed;
  rawTop_ = reportedTop_ = topPressed;
  stop_ = stop;
  bottomReleasedSince_ = topReleasedSince_ = now;
  sendHello(now);
  sendStatus(now);
  checkSwitches(now);  // rule 8 "at any time": an unplugged harness or a pressed stop latches at boot
  maybeSendStatus(now);
}

bool LiftCore::assumePosition(int32_t position, uint32_t now) {
  if (position < 0 || activity_ != Activity::None || stepper_.running() || faults_ != 0 ||
      rawBottom_ || rawTop_ || stop_ == StopSense::Pressed) return false;
  const int64_t milli = calibratedStepsToMilliMm(position, settings_.microsteps, settings_.scale_numerator,
                                                  settings_.scale_denominator);
  if (milli < settings_.soft_min_milli_mm || milli > settings_.soft_max_milli_mm) return false;
  stepper_.setPosition(position);
  homed_ = true;
  sendStatus(now);
  return true;
}

void LiftCore::receive(const uint8_t* data, size_t length, uint32_t now) {
  for (size_t i = 0; i < length; ++i) {
    switch (reader_.push(data[i])) {
      case LineReader::Event::Line:
        handleLine(reader_.line(), reader_.length(), now);
        maybeSendStatus(now);
        break;
      case LineReader::Event::Oversize:
        sendError(Problem::Oversize, nullptr, now);
        break;
      case LineReader::Event::None:
        break;
    }
  }
}

void LiftCore::update(uint32_t now, bool bottomPressed, bool topPressed, StopSense stop) {
  drainOutbox();
  readSwitches(now, bottomPressed, topPressed, stop);
  checkSwitches(now);
  checkWatchdog(now);
  advance(now);
  maybeSendStatus(now);
}

// ---- Serial lines from the Pi ----

void LiftCore::handleLine(const char* line, size_t length, uint32_t now) {
  if (isBlankLine(line, length)) return;
  const LiftPiLine command = parseLiftPiLine(line, length);

  switch (command.problem) {
    case Problem::None:
      break;
    case Problem::InvalidField:
      if (isCommand(command.type) && command.has_request_id) {
        sendAck(command.request_id, LiftRefusal::InvalidField, now);
      } else {
        sendError(Problem::InvalidField, nullptr, now);
      }
      return;
    case Problem::Unsupported:
      sendError(Problem::Unsupported, "a type the lift sends; the lift never acts on it", now);
      return;
    default:
      sendError(command.problem, nullptr, now);
      return;
  }

  const bool forThisLift = sameText(command.module_id, identity_.module_id);
  switch (command.type) {
    case LiftMessageType::HelloRequest:
      if (forThisLift || sameText(command.module_id, kAnyModule)) {
        // Rule 2: the Pi reconnected or restarted. Stop whatever runs, forget its seq, say hello.
        if (activity_ != Activity::None && stopCause_ == StopCause::None) startStop(StopCause::Command);
        hasAcceptedSeq_ = false;
        sendHello(now);
      } else {
        sendError(Problem::InvalidField, "module_id names another module", now);
      }
      return;
    case LiftMessageType::Heartbeat:
      if (forThisLift) {
        heartbeat(command, now);
      } else {
        sendError(Problem::InvalidField, "module_id names another lift", now);
      }
      return;
    case LiftMessageType::Error:
      return;  // never answered, so two sides can't bounce errors
    default:
      break;
  }
  if (!forThisLift) {
    sendAck(command.request_id, LiftRefusal::InvalidField, now);  // a command for another lift
    return;
  }
  handleCommand(command, now);
}

void LiftCore::heartbeat(const LiftPiLine& line, uint32_t now) {
  // Rule 3: a stale heartbeat is ignored, as if it never arrived. A fresh one resets the watchdog and
  // carries the hold lease.
  if (hasAcceptedSeq_ && line.seq <= lastAcceptedSeq_) return;
  hasAcceptedSeq_ = true;
  lastAcceptedSeq_ = line.seq;
  hasHeartbeat_ = true;
  lastHeartbeat_ = now;
  hasHold_ = line.has_hold;
  copyId(hold_, line.has_hold ? line.hold_request_id : "");
  // Rule 5: a heartbeat naming anything else than the running request means the person let go.
  if (activity_ != Activity::None && stopCause_ == StopCause::None &&
      !(hasHold_ && sameText(hold_, activeRequest_))) {
    startStop(StopCause::Release);
  }
}

void LiftCore::handleCommand(const LiftPiLine& command, uint32_t now) {
  // Rule 6: stop and disable are accepted whatever the seq; everything else needs a seq above the last
  // accepted Pi seq since the last hello.request (rule 3).
  const bool alwaysAccepted =
      command.type == LiftMessageType::Stop || (command.type == LiftMessageType::Enable && !command.enabled);
  if (!alwaysAccepted && hasAcceptedSeq_ && command.seq <= lastAcceptedSeq_) {
    sendAck(command.request_id, LiftRefusal::StaleSeq, now);
    return;
  }
  switch (command.type) {
    case LiftMessageType::Move:
      return commandMove(command, now);
    case LiftMessageType::SetPosition:
      return commandSetPosition(command, now);
    case LiftMessageType::Home:
      return commandHome(command, now);
    case LiftMessageType::Stop:
      return commandStop(command, now);
    case LiftMessageType::Enable:
      return commandEnable(command, now);
    case LiftMessageType::Clear:
      return commandClear(command, now);
    default:
      return;
  }
}

void LiftCore::accept(const LiftPiLine& command, uint32_t now) {
  // A stale stop or disable never lowers the threshold.
  if (!hasAcceptedSeq_ || command.seq > lastAcceptedSeq_) lastAcceptedSeq_ = command.seq;
  hasAcceptedSeq_ = true;
  sendAck(command.request_id, LiftRefusal::None, now);
}

namespace {

// A lift request id's counter (the digits after its six-character prefix and dash).
uint32_t requestCounter(const char* requestId) {
  uint32_t n = 0;
  for (const char* p = requestId + 7; *p != '\0'; ++p) n = n * 10 + static_cast<uint32_t>(*p - '0');
  return n;
}

bool samePrefix(const char* a, const char* b) {
  for (size_t i = 0; i < 6; ++i) {
    if (a[i] != b[i]) return false;
  }
  return true;
}

}  // namespace

bool LiftCore::requestUsed(const char* requestId) const {
  for (const PrefixCounter& entry : prefixes_) {
    if (entry.prefix[0] != '\0' && samePrefix(entry.prefix, requestId)) {
      return requestCounter(requestId) <= entry.highest;
    }
  }
  // A prefix not seen since boot starts again, while there is room to remember it.
  for (const PrefixCounter& entry : prefixes_) {
    if (entry.prefix[0] == '\0') return false;
  }
  return true;
}

void LiftCore::recordRequest(const char* requestId) {
  const uint32_t counter = requestCounter(requestId);
  PrefixCounter* slot = nullptr;
  for (PrefixCounter& entry : prefixes_) {
    if (entry.prefix[0] != '\0' && samePrefix(entry.prefix, requestId)) slot = &entry;
  }
  if (slot == nullptr) {
    for (PrefixCounter& entry : prefixes_) {
      if (entry.prefix[0] == '\0') {
        slot = &entry;
        break;
      }
    }
    if (slot == nullptr) return;  // can't happen: requestUsed refused a new prefix with the table full
    for (size_t i = 0; i < 6; ++i) slot->prefix[i] = requestId[i];
    slot->prefix[6] = '\0';
    slot->highest = 0;
  }
  if (counter > slot->highest) slot->highest = counter;
}

LiftRefusal LiftCore::motionRefusal(const LiftPiLine& command, uint32_t now) const {
  // Rule 4, after stale_seq, in order. A request runs at most once, so a stopping or finished one never
  // resumes (rule 5).
  if (requestUsed(command.request_id)) return LiftRefusal::RequestUsed;
  if (!heartbeatFresh(now)) return LiftRefusal::NoHeartbeat;
  if (!hasHold_ || !sameText(hold_, command.request_id)) return LiftRefusal::NotHeld;
  if (stop_ == StopSense::Pressed) return LiftRefusal::StopPressed;
  if (faults_ != 0) return LiftRefusal::FaultLatched;
  if (activity_ != Activity::None) return LiftRefusal::Busy;
  if (!driverEnabled_) return LiftRefusal::DriverDisabled;
  if (command.type != LiftMessageType::Move) return LiftRefusal::None;
  if (!homed_) return LiftRefusal::NotHomed;
  const double softMin = settings_.soft_min_milli_mm / 1000.0;
  const double softMax = settings_.soft_max_milli_mm / 1000.0;
  const double maxSpeed = settings_.max_speed_milli_mm_s / 1000.0;
  if (command.target_mm < softMin || command.target_mm > softMax || command.speed_mm_s > maxSpeed) {
    return LiftRefusal::OutOfRange;
  }
  return LiftRefusal::None;
}

void LiftCore::commandMove(const LiftPiLine& command, uint32_t now) {
  const LiftRefusal refusal = motionRefusal(command, now);
  if (refusal != LiftRefusal::None) return sendAck(command.request_id, refusal, now);
  // (llround of one product: no fused multiply-add, so every compiler gets the same number.)
  const uint32_t targetMilli = static_cast<uint32_t>(std::llround(command.target_mm * 1000.0));
  const int32_t target = steps(targetMilli);
  uint32_t speed = static_cast<uint32_t>(std::llround(command.speed_mm_s * stepsPerMm(settings_.microsteps) *
                                                     settings_.scale_numerator / settings_.scale_denominator));
  if (speed == 0) speed = 1;
  if (target != stepper_.position() && !stepper_.moveTo(target, speed, rate(settings_.max_accel_milli_mm_s2))) {
    stepper_.halt();
    return sendAck(command.request_id, LiftRefusal::OutOfRange, now);  // the step generator refused the numbers
  }
  copyId(activeRequest_, command.request_id);
  recordRequest(command.request_id);
  activity_ = Activity::Move;
  stopCause_ = StopCause::None;
  targetMilliMm_ = targetMilli;
  accept(command, now);
  if (target == stepper_.position()) finish(LiftOutcome::Completed, LiftFault::LimitHit, now);  // already there
}

void LiftCore::commandSetPosition(const LiftPiLine& command, uint32_t now) {
  // No steps are sent. Only the demo build with a persistent-position callback supports this command.
  if (savePosition_ == nullptr) return sendAck(command.request_id, LiftRefusal::InvalidField, now);
  const LiftRefusal refusal = motionRefusal(command, now);
  if (refusal != LiftRefusal::None) return sendAck(command.request_id, refusal, now);
  const uint32_t milli = static_cast<uint32_t>(std::llround(command.target_mm * 1000.0));
  if (milli < settings_.soft_min_milli_mm || milli > settings_.soft_max_milli_mm ||
      stepper_.running() || rawBottom_ || rawTop_) return sendAck(command.request_id, LiftRefusal::OutOfRange, now);
  const int32_t target = steps(milli);
  if (!assumePosition(target, now)) return sendAck(command.request_id, LiftRefusal::OutOfRange, now);
  if (!savePosition_(target)) {
    homed_ = false;  // A failed journal write makes the estimate unusable until repaired.
    sendStatus(now);
    return sendAck(command.request_id, LiftRefusal::InvalidField, now);
  }
  recordRequest(command.request_id);
  accept(command, now);
  sendStatus(now);
}

void LiftCore::commandHome(const LiftPiLine& command, uint32_t now) {
  if (!allowHoming_) return sendAck(command.request_id, LiftRefusal::InvalidField, now);
  const LiftRefusal refusal = motionRefusal(command, now);
  if (refusal != LiftRefusal::None) return sendAck(command.request_id, refusal, now);
  copyId(activeRequest_, command.request_id);
  recordRequest(command.request_id);
  homed_ = false;
  activity_ = Activity::Home;
  stopCause_ = StopCause::None;
  homingStarted_ = now;
  travelBefore_ = 0;
  accept(command, now);
  const int32_t here = stepper_.position();
  if (rawBottom_) {
    // Rule 7: already pressed, so skip the fast approach.
    startHomingMove(Phase::BackOff, here + steps(kHomingSearchMilliMm), kHomingSlowMilliMmS, now);
  } else {
    startHomingMove(Phase::FastApproach, here - steps(kHomingMaxTravelMilliMm), kHomingFastMilliMmS, now);
  }
}

void LiftCore::commandStop(const LiftPiLine& command, uint32_t now) {
  // Rule 6: always accepted; ramps down and holds. No lift.done of its own.
  accept(command, now);
  if (activity_ != Activity::None && stopCause_ == StopCause::None) startStop(StopCause::Command);
}

void LiftCore::commandEnable(const LiftPiLine& command, uint32_t now) {
  // Rule 6: true is refused only for stale_seq (above). False skips every check but one: it frees the motor
  // only with the carriage on the bottom switch or on a disable-safe build, because a back-driven ball screw
  // could let the loaded carriage drop. Refused, the driver stays enabled and any motion stops as for a stop.
  if (!command.enabled && !rawBottom_ && !settings_.disable_safe) {
    sendAck(command.request_id, LiftRefusal::DisableUnsafe, now);
    if (activity_ != Activity::None && stopCause_ == StopCause::None) startStop(StopCause::Command);
    return;
  }
  accept(command, now);
  if (command.enabled) {
    setDriver(true);
    return;
  }
  if (activity_ != Activity::None) {
    stepper_.halt();  // the driver is about to let go: no more steps, now
    finish(LiftOutcome::Stopped, LiftFault::LimitHit, now);
  }
  setDriver(false);
}

void LiftCore::commandClear(const LiftPiLine& command, uint32_t now) {
  // Rule 9. The lift stays unhomed (every latched fault already cleared homed).
  if (faults_ != 0 && causePresent(now)) return sendAck(command.request_id, LiftRefusal::CausePresent, now);
  faults_ = 0;
  accept(command, now);
}

// ---- Switches, watchdog, motion ----

void LiftCore::readSwitches(uint32_t now, bool bottomPressed, bool topPressed, StopSense stop) {
  stop_ = stop;
  bottomEdge_ = bottomPressed && !rawBottom_;
  if (!bottomPressed) {
    bottomStreak_ = 0;
  } else if (bottomStreak_ < 2) {
    if (bottomStreak_ == 0) bottomFirstPressed_ = stepper_.position();
    ++bottomStreak_;
  }
  rawBottom_ = bottomPressed;
  rawTop_ = topPressed;
  // Reported: pressed at once; released after kSwitchReleaseMs without a break.
  if (bottomPressed) {
    reportedBottom_ = true;
    bottomReleasedSince_ = now;
  } else if (now - bottomReleasedSince_ >= kSwitchReleaseMs) {
    reportedBottom_ = false;
  }
  if (topPressed) {
    reportedTop_ = true;
    topReleasedSince_ = now;
  } else if (now - topReleasedSince_ >= kSwitchReleaseMs) {
    reportedTop_ = false;
  }
}

void LiftCore::checkSwitches(uint32_t now) {
  // Rule 8. The stop first: it cut the step signal, so steps were counted that never happened.
  if (stop_ == StopSense::Pressed) {
    if (activity_ != Activity::None) return failNow(LiftFault::StopCircuitOpened, now);
    latch(LiftFault::StopCircuitOpened);
  }
  if (rawBottom_ && rawTop_) {
    if (activity_ != Activity::None) return failNow(LiftFault::LimitWiring, now);
    return latch(LiftFault::LimitWiring);
  }
  if (homed_ && (rawBottom_ || rawTop_)) {
    // Homed (moving, stopping or idle): every switch reads released on the way in (homing ends with both
    // released), so reading pressed is a switch pressing.
    if (activity_ != Activity::None) return failNow(LiftFault::LimitHit, now);
    return latch(LiftFault::LimitHit);
  }
  if (activity_ != Activity::Home) return;
  if (stopCause_ != StopCause::None) {
    // Stopping from a homing: the bottom switch is no longer homing's own, so pressing it is a limit hit.
    // (An edge: a homing stopped while backing off the switch is still sitting on it.)
    if (rawTop_ || bottomEdge_) failNow(LiftFault::LimitHit, now);
    return;
  }
  if (rawTop_) failNow(LiftFault::HomingFailed, now);  // rule 7 (and a motor wired to turn the wrong way)
}

void LiftCore::checkWatchdog(uint32_t now) {
  if (activity_ == Activity::None) return;
  if (activity_ == Activity::Home && stopCause_ == StopCause::None && now - homingStarted_ >= kHomingTimeoutMs) {
    return failNow(LiftFault::HomingFailed, now);  // LIFT_HOMING_TIMEOUT_MS: the firmware's own deadline
  }
  // Rule 5: no heartbeat for LIFT_WATCHDOG_TIMEOUT_MS ramps down; watchdog_expired latches at standstill.
  if (stopCause_ == StopCause::None && !heartbeatFresh(now)) startStop(StopCause::Watchdog);
}

void LiftCore::advance(uint32_t now) {
  if (activity_ == Activity::Home && stopCause_ == StopCause::None) {
    const int32_t here = stepper_.position();
    const int64_t travelled = here > phaseStart_ ? here - phaseStart_ : phaseStart_ - here;
    if (travelBefore_ + travelled > steps(kHomingMaxTravelMilliMm)) {
      return failNow(LiftFault::HomingFailed, now);  // rule 7: over all phases
    }
    if ((phase_ == Phase::FastApproach || phase_ == Phase::SlowApproach) && bottomStreak_ >= 2) {
      // Two pressed samples in a row. The first one's position is the trip point, whatever the motor does
      // next. (Any switch pressing still stops homed motion on its first sample: that direction is safe.)
      stepper_.halt();
      travelBefore_ += travelled;
      const int32_t trip = bottomFirstPressed_;
      if (phase_ == Phase::FastApproach) {
        startHomingMove(Phase::BackOff, stepper_.position() + steps(kHomingSearchMilliMm), kHomingSlowMilliMmS, now);
      } else {
        stepper_.setPosition(stepper_.position() - trip);  // the trip point is 0 mm
        startHomingMove(Phase::FinalBackOff, steps(kHomingSearchMilliMm), kHomingSlowMilliMmS, now);
      }
      return;
    }
    if ((phase_ == Phase::BackOff || phase_ == Phase::FinalBackOff) && !rawBottom_ &&
        travelled >= steps(kHomingBackoffMilliMm)) {
      // Backed off LIFT_HOMING_BACKOFF_MM with the switch released (it may release up to the margin later,
      // in which case the back-off ends where it released).
      stepper_.halt();
      travelBefore_ += travelled;
      if (phase_ == Phase::BackOff) {
        startHomingMove(Phase::SlowApproach, stepper_.position() - steps(kHomingSearchMilliMm), kHomingSlowMilliMmS,
                        now);
      } else {
        homed_ = true;
        finish(LiftOutcome::Completed, LiftFault::LimitHit, now);
      }
      return;
    }
  }
  if (activity_ == Activity::None || stepper_.running()) return;
  switch (stopCause_) {
    case StopCause::Command:
    case StopCause::Release:
      return finish(LiftOutcome::Stopped, LiftFault::LimitHit, now);
    case StopCause::Watchdog:
      finish(LiftOutcome::Failed, LiftFault::WatchdogExpired, now);
      latch(LiftFault::WatchdogExpired);
      if (settings_.watchdog_action == WatchdogDriverAction::Disable) setDriver(false);
      return;
    case StopCause::None:
      break;
  }
  if (activity_ == Activity::Move) return finish(LiftOutcome::Completed, LiftFault::LimitHit, now);
  advanceHoming(now);
}

void LiftCore::advanceHoming(uint32_t now) {
  // A homing phase's move ran its whole distance without what it was looking for: no press within the
  // fast approach's travel or the slow approach's search, or no release within a back-off's search.
  failNow(LiftFault::HomingFailed, now);
}

void LiftCore::startHomingMove(Phase phase, int32_t target, uint32_t speedMilli, uint32_t now) {
  phase_ = phase;
  phaseStart_ = stepper_.position();
  if (!stepper_.moveTo(target, rate(speedMilli), rate(settings_.max_accel_milli_mm_s2))) {
    failNow(LiftFault::HomingFailed, now);
  }
}

// ---- Helpers ----

bool LiftCore::heartbeatFresh(uint32_t now) const {
  return hasHeartbeat_ && now - lastHeartbeat_ < kWatchdogTimeoutMs;
}

bool LiftCore::causePresent(uint32_t now) const {
  // Rule 9: the stop pressed, the top switch pressed (both pressed included), or no heartbeat arriving. The
  // bottom switch alone may stay pressed: homing backs off it.
  return stop_ == StopSense::Pressed || rawTop_ || !heartbeatFresh(now);
}

void LiftCore::latch(LiftFault fault) {
  faults_ = static_cast<uint8_t>(faults_ | liftFaultBit(fault));
  homed_ = false;  // rule 8: every latched fault clears homed
}

void LiftCore::startStop(StopCause cause) {
  stopCause_ = cause;
  stepper_.decelerate(rate(kStopDecelMilliMmS2));
}

void LiftCore::failNow(LiftFault fault, uint32_t now) {
  stepper_.halt();
  // lift.done first, so it carries the height the count still held; then the fault clears homed.
  finish(LiftOutcome::Failed, fault, now);
  latch(fault);
}

void LiftCore::finish(LiftOutcome outcome, LiftFault fault, uint32_t now) {
  if (activity_ == Activity::None) return;
  activity_ = Activity::None;
  stopCause_ = StopCause::None;
  emit(buildLiftDone(tx_, sizeof tx_, identity_.module_id, seq_, activeRequest_, now, outcome, fault, homed_,
                     homed_ ? positionMilliMm() : 0));
  activeRequest_[0] = '\0';
}

void LiftCore::setDriver(bool enabled) {
  stepper_.setDriverEnabled(enabled);
  driverEnabled_ = enabled;
  // With the motor free the carriage may slide, so the step count stops being its height.
  if (!enabled) homed_ = false;
}

LiftState LiftCore::state() const {
  if (faults_ != 0) return LiftState::Fault;
  if (activity_ != Activity::None && stopCause_ != StopCause::None) return LiftState::Stopping;
  if (activity_ == Activity::Home) return LiftState::Homing;
  if (activity_ == Activity::Move) return LiftState::Moving;
  return homed_ ? LiftState::Idle : LiftState::Unhomed;
}

uint32_t LiftCore::positionMilliMm() const {
  const int64_t milli = calibratedStepsToMilliMm(stepper_.position(), settings_.microsteps,
                                                  settings_.scale_numerator, settings_.scale_denominator);
  // Below zero can't happen while homed (the soft minimum is above it, and a switch would latch first);
  // the builder refuses anything over the rail, so a count gone wrong stops status lines rather than
  // sending a false height, and the Pi then treats the lift as lost.
  return milli < 0 ? UINT32_MAX : static_cast<uint32_t>(milli);
}

LiftStatusLine LiftCore::snapshot(uint32_t now) const {
  LiftStatusLine s{};
  s.uptime_ms = now;
  s.state = state();
  s.homed = homed_;
  s.position_milli_mm = homed_ ? positionMilliMm() : 0;
  if (s.state == LiftState::Moving) {
    s.has_target = true;
    s.target_milli_mm = targetMilliMm_;
  } else if (s.state == LiftState::Homing && phase_ == Phase::FinalBackOff &&
             stepper_.position() < steps(kHomingBackoffMilliMm)) {
    // The last back-off ends at LIFT_HOMING_BACKOFF_MM unless the switch is still pressed there; past that
    // point the end (where it releases) isn't known, so no target is reported.
    s.has_target = true;
    s.target_milli_mm = kHomingBackoffMilliMm;
  }
  s.driver_enabled = driverEnabled_;
  s.top_pressed = reportedTop_;
  s.bottom_pressed = reportedBottom_;
  s.stop_sense = stop_;
  s.faults = faults_;
  s.request_id = activity_ != Activity::None ? activeRequest_ : nullptr;
  s.has_heartbeat = hasHeartbeat_;
  s.heartbeat_age_ms = hasHeartbeat_ ? now - lastHeartbeat_ : 0;
  return s;
}

// ---- Lines to the Pi ----

void LiftCore::sendHello(uint32_t now) {
  const LiftConfigLine config{settings_.microsteps,           settings_.soft_min_milli_mm,
                              settings_.soft_max_milli_mm,    settings_.max_speed_milli_mm_s,
                              settings_.max_accel_milli_mm_s2, settings_.has_top_switch,
                              settings_.top_switch_milli_mm,  settings_.stop_sense_wired};
  emit(buildLiftHello(tx_, sizeof tx_, identity_.module_id, seq_, identity_.firmware_version, now, config));
}

void LiftCore::sendStatus(uint32_t now) {
  // Nothing newer than a waiting ack or done goes out; this status is retried once the outbox drains.
  if (outboxCount_ > 0) return;
  const LiftStatusLine s = snapshot(now);
  last_ = s;
  lastHadRequest_ = s.request_id != nullptr;
  sentAny_ = true;
  nextStatus_ = now + kStatusIntervalMs;
  emit(buildLiftStatus(tx_, sizeof tx_, identity_.module_id, seq_, s), false);
}

void LiftCore::maybeSendStatus(uint32_t now) {
  // Rule 10: every kStatusIntervalMs, and at once on a change.
  const LiftStatusLine s = snapshot(now);
  if (!sentAny_ || !sameStatus(s, last_, s.request_id != nullptr, lastHadRequest_) ||
      static_cast<int32_t>(now - nextStatus_) >= 0) {
    sendStatus(now);
  }
}

void LiftCore::sendAck(const char* requestId, LiftRefusal refusal, uint32_t now) {
  emit(buildLiftAck(tx_, sizeof tx_, identity_.module_id, seq_, requestId, refusal, now));
}

void LiftCore::sendError(Problem code, const char* detail, uint32_t now) {
  emit(buildError(tx_, sizeof tx_, identity_.module_id, seq_, code, detail, now));
}

bool LiftCore::emit(size_t length, bool critical) {
  // A line the builder refused (length 0) is never sent and uses no seq. The lift has no free-form fault list
  // to report it in; a refused status shows as missing statuses, which the Pi treats as a lost lift.
  if (length == 0) return false;
  ++seq_;
  if (outboxCount_ == 0 && output_.writeLine(tx_, length)) return true;
  if (!critical || outboxCount_ == kOutboxLines) {
    ++txDropped_;  // its seq is used, so the Pi sees the gap
    return false;
  }
  const size_t slot = (outboxHead_ + outboxCount_) % kOutboxLines;
  for (size_t i = 0; i < length; ++i) outbox_[slot][i] = tx_[i];
  outboxLength_[slot] = length;
  ++outboxCount_;
  return false;
}

void LiftCore::drainOutbox() {
  while (outboxCount_ > 0 && output_.writeLine(outbox_[outboxHead_], outboxLength_[outboxHead_])) {
    outboxHead_ = (outboxHead_ + 1) % kOutboxLines;
    --outboxCount_;
  }
}

}  // namespace lift
}  // namespace walker
