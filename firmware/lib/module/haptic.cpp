#include "haptic.h"

namespace walker {

namespace {

constexpr uint8_t pause(uint32_t ms) { return static_cast<uint8_t>(0x80 | (ms / 10)); }

// Effect numbers from the datasheet's list (ERM libraries). Each sequence ends with a pause so a
// repeated pattern stays readable as separate pulses.
const HapticSequence kSequences[kPatternCount] = {
    // The clicks and the soft bump first used here (effects 10, 7, 12) couldn't be felt on these coin
    // motors at the Pi (2026-10-24); only Strong Buzz could. So every pattern is built from Strong Buzz,
    // told apart by count and gaps.
    {{14, pause(120), 14, pause(250), 0}},  // confirmation: two strong buzzes, then quiet
    {{14, pause(300), 0}},                  // recording: one strong buzz, then quiet
    {{14, 0}},                              // near_obstacle: repeat Strong Buzz with no added quiet interval
    {{14, pause(60), 14, pause(60), 14, pause(250), 0}},  // error: three quick strong buzzes
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
