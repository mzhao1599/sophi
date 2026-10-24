// The haptic cue on a hand module: which pattern plays, for how long, and when it stops.
// Plain C++ (no Arduino headers) so the timing is tested natively on a fake clock.
//
// AGENTS.md rule 8, for the only output this firmware has:
//   - Authorization: only a valid haptic.play from the Pi, addressed to this module, reaches play().
//     The Pi sends it from its local cue policy; no cloud or model text becomes a cue.
//   - Range: one of four fixed patterns, 1 to kHapticMaxDurationMs (1,000 ms). No waveform or strength
//     travels over the wire.
//   - Cancellation: a newer cue replaces the one playing (no queue); the cue stops when its duration ends.
//   - Lost communication: the cue stops if no line has come from the Pi for kPiSilenceTimeoutMs, and on
//     reboot. Each pattern is a finite sequence the driver plays and ends by itself, so by design (from the
//     datasheet, not bench-checked) even an ESP32 that stops running shouldn't leave the motor on.
#pragma once

#include <cstdint>

#include "serial_protocol.h"

namespace walker {

// Placeholder, not measured: a cue stops if no line has come from the Pi for this long. With the
// 1,000 ms duration limit the duration always ends a cue first; this is a second lock in case a limit
// changes, so a cue never outlives a Pi that went away.
constexpr uint32_t kPiSilenceTimeoutMs = 3000;

// One pattern's fixed sequence for the DRV2605L's built-in effect library ("Waveform Library Effects
// List" in TI's DRV2605L datasheet). Up to 8 steps, played in order: a step from 1 to 123 is a library
// effect, a step with bit 7 set is a pause of (step & 0x7F) x 10 ms, and 0 ends the sequence.
// Placeholders: chosen from the effects' names, not yet felt on the real motor.
struct HapticSequence {
  uint8_t steps[8];
};
const HapticSequence& sequenceFor(Pattern pattern);

// What the cue controller drives. The hand board implements it with the DRV2605L; tests use a fake.
class HapticOutput {
 public:
  virtual ~HapticOutput() = default;
  // Stops anything playing, loads the pattern's sequence and starts it.
  virtual void start(Pattern pattern) = 0;
  virtual void stop() = 0;
  // True once the sequence last started has played to its end.
  virtual bool finished() = 0;
};

class HapticController {
 public:
  enum class StopReason : uint8_t { None, Duration, Replaced, PiSilent };

  // The limits are parameters only so a test can raise them; the firmware uses the defaults.
  explicit HapticController(HapticOutput& output, uint32_t maxDurationMs = kHapticMaxDurationMs,
                            uint32_t piSilenceTimeoutMs = kPiSilenceTimeoutMs);

  // Boot: stop the driver before anything else.
  void begin(uint32_t now);
  // Starts a cue, replacing any cue playing. A haptic.play is itself a line from the Pi. Returns false,
  // and changes nothing, when the duration is 0 or over the limit.
  bool play(Pattern pattern, uint32_t durationMs, uint32_t now);
  // Any valid line from the Pi.
  void heardFromPi(uint32_t now);
  // Call often: ends the cue at its duration or after the Pi goes quiet, and restarts the sequence when
  // it finishes early, so the cue lasts its duration.
  void poll(uint32_t now);

  bool active() const { return active_; }
  Pattern pattern() const { return pattern_; }
  StopReason lastStop() const { return lastStop_; }

 private:
  void end(StopReason reason);

  HapticOutput& output_;
  const uint32_t maxDurationMs_;
  const uint32_t piSilenceTimeoutMs_;
  bool active_ = false;
  Pattern pattern_ = Pattern::Confirmation;
  uint32_t startedAt_ = 0;
  uint32_t durationMs_ = 0;
  uint32_t lastHeard_ = 0;
  StopReason lastStop_ = StopReason::None;
};

}  // namespace walker
