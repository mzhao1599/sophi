// What every module does on the serial link, whatever its board: hello on boot and on each
// hello.request, a heartbeat every second, a running seq, and an answer to every line from the Pi.
// Plain C++ (no Arduino headers): the board passes in the time and the bytes it read, and gets lines
// out through LineOutput, so the same code runs in the native tests and the scripted session.
#pragma once

#include <cstddef>
#include <cstdint>

#include "haptic.h"
#include "serial_protocol.h"

namespace walker {

// Short codes reported in a heartbeat's `faults` (snake_case, at most 32 characters).
enum class Fault : uint8_t {
  LineNotBuilt,   // a line broke the contract or the size limit and was never sent (a firmware bug)
  TxDropped,      // the serial buffer was full, so a line was dropped; cleared once a heartbeat reports it
  HapticMissing,  // the haptic driver didn't answer at boot
  HapticError,    // the last transfer to the haptic driver failed
  SensorMissing,  // a distance sensor didn't answer when it was set up
  SensorError,    // a present distance sensor failed a transfer or stopped producing results
};
constexpr size_t kFaultCount = 6;
const char* faultName(Fault fault);

// Writes one finished line ('\n' included). Returns false when the line was not written (for example
// the serial buffer is full); the line is then dropped whole, never sent in part.
class LineOutput {
 public:
  virtual ~LineOutput() = default;
  virtual bool writeLine(const char* data, size_t length) = 0;
};

struct ModuleIdentity {
  const char* module_id;
  ModuleType type;
  const char* firmware_version;
  const char* const* capabilities;
  size_t capability_count;
};

class ModuleCore {
 public:
  // haptic is null on a module that can't play cues (the obstacle sensors, or a hand module whose
  // driver didn't answer at boot); its haptic.play commands are then rejected as unsupported.
  ModuleCore(const ModuleIdentity& identity, LineOutput& output, HapticController* haptic);

  // Boot: stops the haptic driver and sends the hello with seq 0.
  void begin(uint32_t now);
  // Call often: sends a heartbeat when one is due and ends or repeats the haptic cue.
  void poll(uint32_t now);
  // Bytes read from the serial port.
  void receive(const uint8_t* data, size_t length, uint32_t now);

  bool sendButton(const char* button, Edge edge, uint32_t now);
  bool sendZones(const Zone* zones, size_t count, uint32_t now);

  void setFault(Fault fault, bool active);
  // Health "fault" (the module can't do its job at all) instead of "degraded".
  void setCritical(bool critical) { critical_ = critical; }
  // The seq the next line will carry.
  uint32_t nextSeq() const { return seq_; }

 private:
  void handleLine(const char* line, size_t length, uint32_t now);
  void sendHello(uint32_t now);
  void sendHeartbeat(uint32_t now);
  void sendAck(const char* requestId, Problem reason, uint32_t now);
  void sendError(Problem code, const char* detail, uint32_t now);
  // Sends the line just built into tx_, using one seq. length 0 means it couldn't be built.
  bool emit(size_t length);
  bool hasFault(Fault fault) const { return (faults_ >> static_cast<uint8_t>(fault)) & 1u; }

  const ModuleIdentity identity_;
  LineOutput& output_;
  HapticController* haptic_;
  LineReader reader_;
  char tx_[kMaxLineBytes] = {};
  uint32_t seq_ = 0;
  uint32_t nextHeartbeat_ = 0;
  uint8_t faults_ = 0;
  bool critical_ = false;
};

}  // namespace walker
