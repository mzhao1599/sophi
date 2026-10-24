#include "haptic.h"

namespace walker {

namespace {

constexpr uint8_t pause(uint32_t ms) { return static_cast<uint8_t>(0x80 | (ms / 10)); }

// Effect numbers from the datasheet's list (ERM libraries). Each sequence ends with a pause so a
// repeated pattern stays readable as separate pulses.
const HapticSequence kSequences[kPatternCount] = {
    {{10, pause(200), 0}},  // confirmation: "Double Click - 100%", then 200 ms of quiet
    {{7, pause(300), 0}},   // recording: "Soft Bump - 100%", then 300 ms
    {{14, 0}},              // near_obstacle: repeat Strong Buzz with no added quiet interval
    {{12, pause(200), 0}},  // error: "Triple Click - 100%", then 200 ms
};

}  // namespace

const HapticSequence& sequenceFor(Pattern pattern) { return kSequences[static_cast<size_t>(pattern)]; }

HapticController::HapticController(HapticOutput& output, uint32_t maxDurationMs, uint32_t piSilenceTimeoutMs)
    : output_(output), maxDurationMs_(maxDurationMs), piSilenceTimeoutMs_(piSilenceTimeoutMs) {}

void HapticController::begin(uint32_t now) {
  output_.stop();
  active_ = false;
  lastHeard_ = now;
  lastStop_ = StopReason::None;
}

bool HapticController::play(Pattern pattern, uint32_t durationMs, uint32_t now) {
  if (durationMs == 0 || durationMs > maxDurationMs_) return false;
  if (active_) lastStop_ = StopReason::Replaced;
  pattern_ = pattern;
  startedAt_ = now;
  durationMs_ = durationMs;
  lastHeard_ = now;
  active_ = true;
  output_.start(pattern);
  return true;
}

void HapticController::heardFromPi(uint32_t now) { lastHeard_ = now; }

void HapticController::poll(uint32_t now) {
  if (!active_) return;
  // Unsigned differences stay right when the millisecond clock wraps (every 49.7 days).
  if (now - startedAt_ >= durationMs_) {
    end(StopReason::Duration);
  } else if (now - lastHeard_ >= piSilenceTimeoutMs_) {
    end(StopReason::PiSilent);
  } else if (output_.finished()) {
    output_.start(pattern_);
  }
}

void HapticController::end(StopReason reason) {
  output_.stop();
  active_ = false;
  lastStop_ = reason;
}

}  // namespace walker
