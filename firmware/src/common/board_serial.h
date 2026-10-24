// The USB serial link both boards share: serial protocol v1 at 115200 baud (the Pi's SERIAL_BAUD).
// Not yet run on hardware.
#pragma once

#include <Arduino.h>

#include "module_core.h"

namespace board {

constexpr unsigned long kBaud = 115200;
constexpr const char* kFirmwareVersion = "0.1.0";

// Writes a whole line or nothing: if the transmit buffer can't take all of it now, the line is dropped
// (the core then counts it as tx_dropped), so the loop never blocks on a slow port.
class SerialOutput : public walker::LineOutput {
 public:
  bool writeLine(const char* data, size_t length) override {
    if (Serial.availableForWrite() < static_cast<int>(length)) return false;
    return Serial.write(reinterpret_cast<const uint8_t*>(data), length) == length;
  }
};

inline void beginSerial() {
  // Room for a full 1,024-byte line each way, set before begin() as the core requires.
  Serial.setRxBufferSize(2048);
  Serial.setTxBufferSize(2048);
  Serial.begin(kBaud);
}

// Hands the core whatever arrived since the last loop, at most 256 bytes per call so the loop stays quick.
inline void pumpSerial(walker::ModuleCore& core, uint32_t now) {
  uint8_t buffer[256];
  const int available = Serial.available();
  if (available <= 0) return;
  const size_t want = static_cast<size_t>(available) < sizeof buffer ? static_cast<size_t>(available) : sizeof buffer;
  const size_t got = Serial.read(buffer, want);
  core.receive(buffer, got, now);
}

}  // namespace board
