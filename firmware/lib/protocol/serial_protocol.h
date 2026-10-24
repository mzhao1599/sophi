// Serial protocol v1 between the Pi and one ESP32 module: UTF-8 JSON Lines over USB serial.
//
// The contract is packages/contracts/src/serial.ts (and docs/interfaces.md, "Pi ↔ ESP32 USB serial").
// This file is plain C++17 with no Arduino headers, so the same code runs on the boards and in the
// native tests on a computer. It does two jobs:
//   - builds every line a module sends (hello, heartbeat, hand.input, perception.zones, ack, error), and
//   - reads every line the Pi sends, returning the same problem code the contract's parseSerialLine gives.
// Nothing here allocates memory.
#pragma once

#include <cstddef>
#include <cstdint>

namespace walker {

constexpr int kProtocolVersion = 1;
// At most 1,024 UTF-8 bytes per line, counting its '\n' (SERIAL_MAX_LINE_BYTES).
constexpr size_t kMaxLineBytes = 1024;
// Proposal, not measured: a heartbeat about once a second (SERIAL_HEARTBEAT_INTERVAL_MS).
constexpr uint32_t kHeartbeatIntervalMs = 1000;
// Placeholder, not bench-tested: the longest haptic cue the Pi may ask for (HAPTIC_MAX_DURATION_MS).
constexpr uint32_t kHapticMaxDurationMs = 1000;

constexpr size_t kMaxModuleIdLength = 32;
constexpr size_t kMaxRequestIdLength = 40;
constexpr size_t kMaxButtonNameLength = 16;
constexpr size_t kMaxZoneNameLength = 24;
constexpr size_t kMaxZones = 16;
constexpr size_t kMaxFaultNameLength = 32;
constexpr size_t kMaxFaults = 8;
constexpr size_t kMaxCapabilityLength = 32;
constexpr size_t kMaxCapabilities = 16;
constexpr size_t kMaxFirmwareVersionLength = 32;
// Counted in Unicode code points, as the contract's zod (4.6.5) measures string length: a surrogate pair
// is one, a lone surrogate is one.
constexpr size_t kMaxDetailLength = 120;
constexpr uint16_t kMaxZoneMm = 65535;

// The destination of a hello.request meaning "whichever module is on this port" (SERIAL_ANY_MODULE).
// No module is ever provisioned with it.
constexpr const char* kAnyModule = "any";

// Why a line or command was refused: the contract's SerialProblemSchema, plus None.
enum class Problem : uint8_t {
  None,
  Oversize,
  Malformed,
  UnsupportedVersion,
  UnknownType,
  InvalidField,
  Unsupported,
  Overflow,
};
// The contract's code ("oversize", ...), or "" for None.
const char* problemName(Problem problem);

enum class MessageType : uint8_t {
  Unknown,
  Hello,
  HelloRequest,
  Heartbeat,
  HandInput,
  PerceptionZones,
  HapticPlay,
  Ack,
  Error,
};

// The only cues firmware plays. Shape and strength are fixed per pattern in firmware.
enum class Pattern : uint8_t { Confirmation, Recording, NearObstacle, Error };
constexpr size_t kPatternCount = 4;
const char* patternName(Pattern pattern);

enum class ModuleType : uint8_t { Hand, Perception };
enum class Health : uint8_t { Ok, Degraded, Fault };
enum class Edge : uint8_t { Pressed, Released };

// ---- Checks shared by the builders and by the compile-time provisioning checks ----

// ^[a-z0-9][a-z0-9-]*$, at most 32 characters (SerialModuleIdSchema).
constexpr bool isModuleId(const char* s) {
  if (s == nullptr || s[0] == '\0') return false;
  size_t n = 0;
  for (; s[n] != '\0'; ++n) {
    const char c = s[n];
    const bool lowerOrDigit = (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
    if (!(lowerOrDigit || (n > 0 && c == '-'))) return false;
    if (n + 1 > kMaxModuleIdLength) return false;
  }
  return true;
}

constexpr bool sameText(const char* a, const char* b) {
  size_t i = 0;
  for (; a[i] != '\0' && b[i] != '\0'; ++i) {
    if (a[i] != b[i]) return false;
  }
  return a[i] == b[i];
}

// A module's own id: a valid id that isn't "any".
constexpr bool isProvisionableModuleId(const char* s) { return isModuleId(s) && !sameText(s, kAnyModule); }

// ^[a-z][a-z0-9_]*$ with a maximum length (the contract's snakeName).
constexpr bool isSnakeName(const char* s, size_t maxLength) {
  if (s == nullptr || !(s[0] >= 'a' && s[0] <= 'z')) return false;
  size_t n = 0;
  for (; s[n] != '\0'; ++n) {
    const char c = s[n];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_')) return false;
    if (n + 1 > maxLength) return false;
  }
  return true;
}

// ---- Building lines (module → Pi) ----
//
// Each builder writes one complete line, '\n' included, into `out` and returns its length in bytes.
// It returns 0 and leaves no usable line if the result would not fit in `capacity` or in 1,024 bytes,
// or if any value breaks the contract (an id, name or count the schema forbids). So every line a
// builder returns passes the contract's parseSerialLine.

struct Zone {
  const char* name;
  bool valid;   // false: the reading is unknown and mm is sent as null
  uint16_t mm;  // millimetres; only sent when valid
};

struct HelloFields {
  const char* module_id;
  uint32_t seq;
  ModuleType type;
  const char* const* capabilities;
  size_t capability_count;
  const char* firmware_version;
  uint32_t uptime_ms;
};

size_t buildHello(char* out, size_t capacity, const HelloFields& hello);
size_t buildHeartbeat(char* out, size_t capacity, const char* module_id, uint32_t seq, uint32_t uptime_ms,
                      Health health, const char* const* faults, size_t fault_count);
size_t buildHandInput(char* out, size_t capacity, const char* module_id, uint32_t seq, uint32_t uptime_ms,
                      const char* button, Edge edge);
size_t buildZones(char* out, size_t capacity, const char* module_id, uint32_t seq, uint32_t uptime_ms,
                  const Zone* zones, size_t zone_count);
// reason Problem::None means accepted; anything else is a rejection naming that reason.
size_t buildAck(char* out, size_t capacity, const char* module_id, uint32_t seq, const char* request_id,
                Problem reason, uint32_t uptime_ms);
// detail may be null. It is for logs, so it holds only printable ASCII without quotes or backslashes.
size_t buildError(char* out, size_t capacity, const char* module_id, uint32_t seq, Problem code,
                  const char* detail, uint32_t uptime_ms);

// ---- Reading lines (Pi → module) ----

struct PiLine {
  // None: a valid v1 line. Unsupported: a v1 type only modules send, which a module never acts on
  // (its fields are not checked). Anything else: the contract's code for this line.
  Problem problem = Problem::None;
  // Known once v and type pass, even when a field is invalid.
  MessageType type = MessageType::Unknown;
  // The destination, set when the line is valid.
  char module_id[kMaxModuleIdLength + 1] = {};
  // haptic.play only: a request_id matching the contract, found even when another field is invalid,
  // so the rejection can be acked against it.
  bool has_request_id = false;
  char request_id[kMaxRequestIdLength + 1] = {};
  // haptic.play only, set when the line is valid.
  Pattern pattern = Pattern::Confirmation;
  uint32_t duration_ms = 0;
};

// Reads one line from the Pi, without its '\n', checking in the contract's order: size, UTF-8 and
// JSON, then v, then type, then fields. Never reads outside line[0..length).
PiLine parsePiLine(const char* line, size_t length);

// True when the line holds nothing but spaces, tabs and '\r' (the Pi's reader skips blank lines too).
bool isBlankLine(const char* line, size_t length);

// ---- Splitting the byte stream into lines ----
//
// Holds at most one line's worth of bytes. A line longer than 1,024 bytes (counting its '\n') is
// reported once as Oversize, dropped up to its '\n', and reading starts again at the next line: the
// "resync at a newline" rule, the same as the Pi's LineReader.
class LineReader {
 public:
  enum class Event : uint8_t { None, Line, Oversize };

  Event push(uint8_t byte);
  // After Event::Line: the line without its '\n' (NUL-terminated for convenience).
  const char* line() const { return buffer_; }
  size_t length() const { return length_; }

 private:
  // Up to 1,023 bytes of line plus a terminating NUL.
  char buffer_[kMaxLineBytes] = {};
  size_t length_ = 0;
  bool complete_ = false;
  bool discarding_ = false;
};

}  // namespace walker
