#include "debounce.h"

namespace walker {

Debouncer::Result Debouncer::update(bool pressed, uint32_t now) {
  if (!started_ || pressed != candidate_) {
    started_ = true;
    candidate_ = pressed;
    candidateSince_ = now;
    return Result::None;
  }
  const uint32_t settleMs = settled_ && stable_ && !candidate_ ? releaseStableMs_ : stableMs_;
  if (now - candidateSince_ < settleMs) return Result::None;
  if (!settled_) {
    settled_ = true;
    stable_ = candidate_;
    armed_ = !stable_;
    return Result::None;
  }
  if (candidate_ == stable_) return Result::None;
  stable_ = candidate_;
  if (!armed_) {
    // The first release of a button held since boot: report nothing, but report from now on.
    armed_ = true;
    return Result::None;
  }
  return stable_ ? Result::Pressed : Result::Released;
}

}  // namespace walker
