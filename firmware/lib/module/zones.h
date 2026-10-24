// Obstacle zones: turns each time-of-flight sensor's latest result into a zone reading that is either
// valid with a distance, or invalid (unknown, never clear). Plain C++ so it is tested natively.
#pragma once

#include <cstddef>
#include <cstdint>

#include "serial_protocol.h"

namespace walker {

// Placeholder, not measured: one perception.zones line every 80 ms (12.5 Hz, inside the contract's
// 10 to 20 Hz proposal, SERIAL_TOF_REPORT_HZ).
constexpr uint32_t kZoneReportIntervalMs = 80;
// Placeholder, not measured: a sensor with no new result for this long reads invalid. Each sensor is
// set to measure every 50 ms, so this allows four missed results.
constexpr uint32_t kZoneStaleMs = 250;
// Placeholder: the VL53L1X's stated ceiling in long-distance mode. A larger distance reads invalid.
constexpr uint16_t kMaxValidRangeMm = 4000;
constexpr size_t kMaxTrackedZones = 8;

// Range statuses as the Pololu VL53L1X library reports them (VL53L1X::RangeStatus).
constexpr uint8_t kRangeValid = 0;
// "Target is below minimum detection threshold": something is closer than the sensor can measure,
// and the distance is clipped to the minimum. Counted as valid so a very close object reads near, not
// unknown. An assumption to check on the bench.
constexpr uint8_t kRangeValidMinRangeClipped = 3;

// True when a result with this status and distance is a reading the Pi may act on.
bool isValidRange(uint8_t rangeStatus, uint16_t mm);

class ZoneTracker {
 public:
  // names must stay alive; at most kMaxTrackedZones of them.
  ZoneTracker(const char* const* names, size_t count);

  void begin(uint32_t now);
  // Whether the sensor answered when it was last set up. A missing sensor always reads invalid.
  void setPresent(size_t zone, bool present);
  // A finished measurement.
  void reading(size_t zone, uint8_t rangeStatus, uint16_t mm, uint32_t now);
  // An I2C transfer to this sensor failed.
  void readFailed(size_t zone);

  // Fills out[0..count) with each zone's reading as of now, in the order the names were given.
  size_t snapshot(uint32_t now, Zone* out) const;
  // True once every kZoneReportIntervalMs; each true moves the next report on by one interval.
  bool reportDue(uint32_t now);

  size_t count() const { return count_; }
  bool present(size_t zone) const { return zone < count_ && state_[zone].present; }
  bool anyMissing() const;
  bool allMissing() const;
  // A present sensor whose last transfer failed or whose result is stale.
  bool anyError(uint32_t now) const;

 private:
  struct State {
    bool present = false;
    bool failed = false;
    bool hasReading = false;
    bool valid = false;
    uint16_t mm = 0;
    uint32_t at = 0;
  };
  bool fresh(const State& state, uint32_t now) const;

  const char* const* names_;
  size_t count_;
  State state_[kMaxTrackedZones];
  uint32_t nextReport_ = 0;
};

}  // namespace walker
