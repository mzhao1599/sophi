// Turns a noisy button level into clean pressed/released edges. Plain C++ so it is tested natively.
#pragma once

#include <cstdint>

namespace walker {

// Placeholder, not measured: a button's level must hold this long before an edge is reported.
constexpr uint32_t kButtonDebounceMs = 20;
// A loose handle contact briefly opening during a hold must not finish a recording.
// This is a prototype value based on the right-handle edge bursts seen on 2026-10-24.
constexpr uint32_t kHandReleaseDebounceMs = 250;

class Debouncer {
 public:
  enum class Result : uint8_t { None, Pressed, Released };

  explicit Debouncer(uint32_t stableMs = kButtonDebounceMs, uint32_t releaseStableMs = kButtonDebounceMs)
      : stableMs_(stableMs), releaseStableMs_(releaseStableMs) {}

  // `pressed` is the raw level read now. Returns an edge once the level has held for stableMs.
  // A button already held when the board starts reports nothing until it has been seen released,
  // so a stuck or held button can't start a recording on its own.
  Result update(bool pressed, uint32_t now);

 private:
  const uint32_t stableMs_;
  const uint32_t releaseStableMs_;
  bool started_ = false;
  bool candidate_ = false;
  uint32_t candidateSince_ = 0;
  bool settled_ = false;  // a stable level has been seen at least once
  bool stable_ = false;   // the last stable level
  bool armed_ = false;    // seen released at least once, so edges are reported
};

}  // namespace walker
