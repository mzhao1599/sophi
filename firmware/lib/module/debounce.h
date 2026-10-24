// Turns a noisy button level into clean pressed/released edges. Plain C++ so it is tested natively.
#pragma once

#include <cstdint>

namespace walker {

// Placeholder, not measured: a button's level must hold this long before an edge is reported.
constexpr uint32_t kButtonDebounceMs = 20;

class Debouncer {
 public:
  enum class Result : uint8_t { None, Pressed, Released };

  explicit Debouncer(uint32_t stableMs = kButtonDebounceMs) : stableMs_(stableMs) {}

  // `pressed` is the raw level read now. Returns an edge once the level has held for stableMs.
  // A button already held when the board starts reports nothing until it has been seen released,
  // so a stuck or held button can't start a recording on its own.
  Result update(bool pressed, uint32_t now);

 private:
  const uint32_t stableMs_;
  bool started_ = false;
  bool candidate_ = false;
  uint32_t candidateSince_ = 0;
  bool settled_ = false;  // a stable level has been seen at least once
  bool stable_ = false;   // the last stable level
  bool armed_ = false;    // seen released at least once, so edges are reported
};

}  // namespace walker
