// The lift ESP32's serial lines, protocol v1: the same JSON Lines envelope as serial_protocol.h, with
// the lift's own types, which all start with `lift.`.
//
// The contract is packages/contracts/src/lift-serial.ts (proposed, under review) and the lift section of
// motion.ts; docs/interfaces.md, "Pi ↔ lift ESP32". Plain C++17, no Arduino headers, nothing allocated.
//   - builds every line the lift sends (lift.hello, lift.status, lift.done, lift.ack; `error` is
//     serial_protocol.h's buildError), and
//   - reads every line the Pi sends a lift, giving the problem code the contract's parseLiftSerialLine gives.
#pragma once

#include <cstddef>
#include <cstdint>

#include "serial_protocol.h"

namespace walker {

// ^lift-[a-z0-9-]+$ on top of the module id rule (LiftModuleIdSchema).
constexpr bool isLiftModuleId(const char* s) {
  if (!isModuleId(s)) return false;
  const char* prefix = "lift-";
  for (size_t i = 0; i < 5; ++i) {
    if (s[i] != prefix[i]) return false;
  }
  return s[5] != '\0';  // the rest is already [a-z0-9-] by isModuleId
}

// ^[a-z0-9]{6}-[1-9][0-9]{0,8}$ (LiftRequestIdSchema): the Pi service's boot prefix and a counter, such
// as k3x9q2-17. Every lift command, hold lease, ack, done and status uses it.
constexpr bool isLiftRequestId(const char* s, size_t length) {
  if (length < 8 || length > 16) return false;
  for (size_t i = 0; i < 6; ++i) {
    const char c = s[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return false;
  }
  if (s[6] != '-' || s[7] < '1' || s[7] > '9') return false;
  for (size_t i = 8; i < length; ++i) {
    if (s[i] < '0' || s[i] > '9') return false;
  }
  return true;
}

// The contract's LIFT_RAIL_LENGTH_MM: every height on the wire is between 0 and this.
constexpr uint32_t kLiftRailLengthMm = 1000;
// LIFT_SPEED_CEILING_MM_S: the most any lift.move may ask for.
constexpr uint32_t kLiftSpeedCeilingMmS = 50;

enum class LiftMessageType : uint8_t {
  Unknown,
  HelloRequest,
  Error,
  Heartbeat,
  Home,
  Move,
  Stop,
  Enable,
  Clear,
  // Types only the lift sends; a lift never acts on one (Problem::Unsupported).
  LiftHello,
  LiftStatus,
  LiftDone,
  LiftAck,
};

struct LiftPiLine {
  // None: a valid line the Pi sends. Unsupported: a type only the lift sends (fields not checked).
  // Anything else: the contract's code for this line.
  Problem problem = Problem::None;
  // Known once v and type pass, even when a field is invalid.
  LiftMessageType type = LiftMessageType::Unknown;
  // The destination, set when the line is valid.
  char module_id[kMaxModuleIdLength + 1] = {};
  // Set when the line is valid. Up to 2^53 - 1 (a JavaScript safe integer).
  uint64_t seq = 0;
  // Commands only: a request_id matching LiftRequestIdSchema, found even when another field is invalid,
  // so the rejection can be acked against it.
  bool has_request_id = false;
  char request_id[kMaxRequestIdLength + 1] = {};
  // lift.move only, set when valid.
  double target_mm = 0;
  double speed_mm_s = 0;
  // lift.enable only, set when valid.
  bool enabled = false;
  // lift.heartbeat only, set when valid: the hold lease, the request a person holds the control for
  // (has_hold false: null, nobody is holding).
  bool has_hold = false;
  char hold_request_id[kMaxRequestIdLength + 1] = {};
};

// Reads one line from the Pi on a lift port, without its '\n', in the contract's order: size, UTF-8 and
// JSON, v, type, fields. Never reads outside line[0..length).
LiftPiLine parseLiftPiLine(const char* line, size_t length);

// ---- Building lines (lift → Pi) ----
// Each builder writes one complete line, '\n' included, and returns its length, or 0 when the line
// would break the contract or not fit (nothing usable is written then).

// The lift's configuration, built into the firmware (LiftConfigSchema). Heights in thousandths of a mm.
struct LiftConfigLine {
  uint32_t microsteps;
  uint32_t soft_min_milli_mm;
  uint32_t soft_max_milli_mm;
  uint32_t max_speed_milli_mm_s;
  uint32_t max_accel_milli_mm_s2;
  bool has_top_switch;
  uint32_t top_switch_milli_mm;
  // Whether the firmware was built to read a stop-sense input (`stop_sense` "wired" or "not_wired").
  bool stop_sense_wired;
};

size_t buildLiftHello(char* out, size_t capacity, const char* module_id, uint32_t seq, const char* firmware_version,
                      uint32_t uptime_ms, const LiftConfigLine& config);

enum class LiftState : uint8_t { Unhomed, Homing, Idle, Moving, Stopping, Fault };
const char* liftStateName(LiftState state);

// The faults the lift latches (LiftSerialFaultSchema), as bits in this order.
enum class LiftFault : uint8_t { LimitHit, LimitWiring, HomingFailed, WatchdogExpired, StopCircuitOpened };
constexpr size_t kLiftFaultCount = 5;

// The lift's own reading of its stop-sense input (`stop_sense` in lift.status).
enum class StopSense : uint8_t { NotWired, Released, Pressed };
const char* liftFaultName(LiftFault fault);
constexpr uint8_t liftFaultBit(LiftFault fault) { return static_cast<uint8_t>(1u << static_cast<uint8_t>(fault)); }

struct LiftStatusLine {
  uint32_t uptime_ms;
  LiftState state;
  bool homed;
  // Thousandths of a mm, sent only when homed.
  uint32_t position_milli_mm;
  bool has_target;
  uint32_t target_milli_mm;
  bool driver_enabled;
  bool top_pressed;
  bool bottom_pressed;
  StopSense stop_sense;
  uint8_t faults;          // liftFaultBit()s
  const char* request_id;  // null: none
  bool has_heartbeat;
  uint32_t heartbeat_age_ms;
};

// Refuses a status the contract's refinements would reject (for example `moving` without a target).
size_t buildLiftStatus(char* out, size_t capacity, const char* module_id, uint32_t seq, const LiftStatusLine& status);

enum class LiftOutcome : uint8_t { Completed, Stopped, Failed };

// `fault` is used only when the outcome is Failed. position: only when homed.
size_t buildLiftDone(char* out, size_t capacity, const char* module_id, uint32_t seq, const char* request_id,
                     uint32_t uptime_ms, LiftOutcome outcome, LiftFault fault, bool homed, uint32_t position_milli_mm);

// Why the lift refused a command (LiftAckReasonSchema): None means accepted.
enum class LiftRefusal : uint8_t {
  None,
  InvalidField,
  Overflow,
  NotHomed,
  DriverDisabled,
  OutOfRange,
  FaultLatched,
  StopPressed,
  NoHeartbeat,
  NotHeld,
  Busy,
  StaleSeq,
  RequestUsed,
  CausePresent,
  DisableUnsafe,
};
const char* liftRefusalName(LiftRefusal refusal);

size_t buildLiftAck(char* out, size_t capacity, const char* module_id, uint32_t seq, const char* request_id,
                    LiftRefusal refusal, uint32_t uptime_ms);

}  // namespace walker
