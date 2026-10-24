#include "zones.h"

namespace walker {

bool isValidRange(uint8_t rangeStatus, uint16_t mm) {
  return (rangeStatus == kRangeValid || rangeStatus == kRangeValidMinRangeClipped) && mm <= kMaxValidRangeMm;
}

ZoneTracker::ZoneTracker(const char* const* names, size_t count)
    : names_(names), count_(count < kMaxTrackedZones ? count : kMaxTrackedZones) {}

void ZoneTracker::begin(uint32_t now) { nextReport_ = now + kZoneReportIntervalMs; }

void ZoneTracker::setPresent(size_t zone, bool present) {
  if (zone >= count_) return;
  State& state = state_[zone];
  state.present = present;
  state.failed = false;
  state.hasReading = false;
}

void ZoneTracker::reading(size_t zone, uint8_t rangeStatus, uint16_t mm, uint32_t now) {
  if (zone >= count_) return;
  State& state = state_[zone];
  state.failed = false;
  state.hasReading = true;
  state.valid = isValidRange(rangeStatus, mm);
  state.mm = mm;
  state.at = now;
}

void ZoneTracker::readFailed(size_t zone) {
  if (zone < count_) state_[zone].failed = true;
}

bool ZoneTracker::fresh(const State& state, uint32_t now) const {
  return state.hasReading && now - state.at <= kZoneStaleMs;
}

size_t ZoneTracker::snapshot(uint32_t now, Zone* out) const {
  for (size_t i = 0; i < count_; ++i) {
    const State& state = state_[i];
    const bool valid = state.present && !state.failed && fresh(state, now) && state.valid;
    out[i] = Zone{names_[i], valid, valid ? state.mm : static_cast<uint16_t>(0)};
  }
  return count_;
}

bool ZoneTracker::reportDue(uint32_t now) {
  if (static_cast<int32_t>(now - nextReport_) < 0) return false;
  nextReport_ += kZoneReportIntervalMs;
  // After a long stall, don't burst to catch up: report once and start the interval again.
  if (static_cast<int32_t>(now - nextReport_) >= 0) nextReport_ = now + kZoneReportIntervalMs;
  return true;
}

bool ZoneTracker::anyMissing() const {
  for (size_t i = 0; i < count_; ++i) {
    if (!state_[i].present) return true;
  }
  return false;
}

bool ZoneTracker::allMissing() const {
  for (size_t i = 0; i < count_; ++i) {
    if (state_[i].present) return false;
  }
  return true;
}

bool ZoneTracker::anyError(uint32_t now) const {
  for (size_t i = 0; i < count_; ++i) {
    const State& state = state_[i];
    if (state.present && (state.failed || !fresh(state, now))) return true;
  }
  return false;
}

}  // namespace walker
