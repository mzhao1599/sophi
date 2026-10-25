#include "lift_protocol.h"

#include <cmath>

#include "protocol_internal.h"

namespace walker {

using namespace internal;

namespace {

struct LiftTypeName {
  const char* name;
  LiftMessageType type;
};
// Every type in LiftSerialMessageSchema. Anything else, the hand protocol's types included, is unknown_type.
const LiftTypeName kLiftTypeNames[] = {
    {"hello.request", LiftMessageType::HelloRequest}, {"error", LiftMessageType::Error},
    {"lift.hello", LiftMessageType::LiftHello},       {"lift.status", LiftMessageType::LiftStatus},
    {"lift.done", LiftMessageType::LiftDone},         {"lift.ack", LiftMessageType::LiftAck},
    {"lift.heartbeat", LiftMessageType::Heartbeat},   {"lift.home", LiftMessageType::Home},
    {"lift.move", LiftMessageType::Move},             {"lift.set_position", LiftMessageType::SetPosition},
    {"lift.stop", LiftMessageType::Stop},
    {"lift.enable", LiftMessageType::Enable},         {"lift.clear", LiftMessageType::Clear},
};

const char* const kStateNames[] = {"unhomed", "homing", "idle", "moving", "stopping", "fault"};
const char* const kFaultNames[kLiftFaultCount] = {"limit_hit", "limit_wiring", "homing_failed", "watchdog_expired",
                                                   "stop_circuit_opened"};
const char* const kRefusalNames[] = {
    "",           "invalid_field", "overflow", "not_homed", "driver_disabled", "out_of_range",
    "fault_latched", "stop_pressed", "no_heartbeat", "not_held", "busy", "stale_seq", "request_used",
    "cause_present", "disable_unsafe",
};

constexpr uint32_t kRailMilliMm = kLiftRailLengthMm * 1000;

// The envelope of a line the Pi sends: only `allowed` keys, a module id, a non-negative integer seq.
// Lift types need a lift id; hello.request and error take any module id (serial.ts's own schemas).
bool readLiftEnvelope(const Fields& fields, uint16_t allowed, bool liftId, LiftPiLine* line) {
  if (!onlyKeys(fields, allowed) || !readModuleId(fields.values[kModuleId], line->module_id)) return false;
  if (liftId && !isLiftModuleId(line->module_id)) return false;
  if (!isNonNegativeInteger(fields.values[kSeq])) return false;
  line->seq = static_cast<uint64_t>(numberOf(fields.values[kSeq]));
  return true;
}

// A finite JSON number (z.number() refuses Infinity, which JSON.parse makes of 1e400).
bool readFinite(const Value& value, double* out) {
  if (value.kind != Kind::Number) return false;
  const double d = numberOf(value);
  if (!std::isfinite(d)) return false;
  *out = d;
  return true;
}

// A string matching LiftRequestIdSchema; `out` holds kMaxRequestIdLength + 1 bytes.
bool readLiftRequestId(const Value& value, char* out) {
  if (!readRequestId(value, out)) return false;
  return isLiftRequestId(out, textLength(out));
}

Problem readCommand(const Fields& fields, LiftPiLine* line) {
  char requestId[kMaxRequestIdLength + 1] = {};
  if (readLiftRequestId(fields.values[kRequestId], requestId)) {
    line->has_request_id = true;
    for (size_t i = 0; i <= kMaxRequestIdLength; ++i) line->request_id[i] = requestId[i];
  }
  uint16_t allowed = kEnvelope | bit(kRequestId);
  if (line->type == LiftMessageType::Move) allowed |= bit(kTargetMm) | bit(kSpeedMmS);
  if (line->type == LiftMessageType::SetPosition) allowed |= bit(kTargetMm);
  if (line->type == LiftMessageType::Enable) allowed |= bit(kEnabled);
  if (!readLiftEnvelope(fields, allowed, true, line) || !line->has_request_id) return Problem::InvalidField;

  if (line->type == LiftMessageType::Move || line->type == LiftMessageType::SetPosition) {
    double target = 0;
    // z.number().min(0).max(1000) and z.number().positive().max(50).
    if (!readFinite(fields.values[kTargetMm], &target) || !(target >= 0) || target > kLiftRailLengthMm) {
      return Problem::InvalidField;
    }
    line->target_mm = target == 0 ? 0 : target;  // -0 reads as 0
    if (line->type == LiftMessageType::Move) {
      double speed = 0;
      if (!readFinite(fields.values[kSpeedMmS], &speed) || !(speed > 0) || speed > kLiftSpeedCeilingMmS) return Problem::InvalidField;
      line->speed_mm_s = speed;
    }
  }
  if (line->type == LiftMessageType::Enable) {
    const Kind kind = fields.values[kEnabled].kind;
    if (kind != Kind::True && kind != Kind::False) return Problem::InvalidField;
    line->enabled = kind == Kind::True;
  }
  return Problem::None;
}

// lift.heartbeat: the envelope and a required hold_request_id, a request id or null.
Problem readHeartbeat(const Fields& fields, LiftPiLine* line) {
  if (!readLiftEnvelope(fields, kEnvelope | bit(kHoldRequestId), true, line)) return Problem::InvalidField;
  const Value& hold = fields.values[kHoldRequestId];
  if (hold.kind == Kind::Null) return Problem::None;
  if (!readLiftRequestId(hold, line->hold_request_id)) return Problem::InvalidField;
  line->has_hold = true;
  return Problem::None;
}

}  // namespace

const char* liftStateName(LiftState state) { return kStateNames[static_cast<size_t>(state)]; }
const char* liftFaultName(LiftFault fault) { return kFaultNames[static_cast<size_t>(fault)]; }
const char* liftRefusalName(LiftRefusal refusal) { return kRefusalNames[static_cast<size_t>(refusal)]; }

LiftPiLine parseLiftPiLine(const char* line, size_t length) {
  LiftPiLine result;
  if (length + 1 > kMaxLineBytes) {
    result.problem = Problem::Oversize;
    return result;
  }
  Fields fields;
  if (!isUtf8(line, length) || !readObject(line, length, &fields)) {
    result.problem = Problem::Malformed;
    return result;
  }
  const Value& v = fields.values[kV];
  if (v.kind != Kind::Number || numberOf(v) != kProtocolVersion) {
    result.problem = Problem::UnsupportedVersion;
    return result;
  }
  const Value& type = fields.values[kType];
  if (type.kind == Kind::String) {
    char name[24];
    const long n = decodeAscii(type, name, sizeof name);
    for (const LiftTypeName& known : kLiftTypeNames) {
      if (equals(name, n, known.name)) result.type = known.type;
    }
  }

  switch (result.type) {
    case LiftMessageType::Unknown:
      result.problem = Problem::UnknownType;
      break;
    case LiftMessageType::HelloRequest:
      result.problem = readLiftEnvelope(fields, kEnvelope, false, &result) ? Problem::None : Problem::InvalidField;
      break;
    case LiftMessageType::Error:
      result.problem = readLiftEnvelope(fields, kErrorKeys, false, &result) && errorFieldsValid(fields)
                           ? Problem::None
                           : Problem::InvalidField;
      break;
    case LiftMessageType::Heartbeat:
      result.problem = readHeartbeat(fields, &result);
      break;
    case LiftMessageType::Home:
    case LiftMessageType::Move:
    case LiftMessageType::SetPosition:
    case LiftMessageType::Stop:
    case LiftMessageType::Enable:
    case LiftMessageType::Clear:
      result.problem = readCommand(fields, &result);
      break;
    default:
      // lift.hello, lift.status, lift.done, lift.ack: only the lift sends these.
      result.problem = Problem::Unsupported;
      break;
  }
  if (result.problem != Problem::None) {
    result.module_id[0] = '\0';
    result.seq = 0;
  }
  return result;
}

size_t buildLiftHello(char* out, size_t capacity, const char* module_id, uint32_t seq, const char* firmware_version,
                      uint32_t uptime_ms, const LiftConfigLine& c) {
  LineWriter w(out, capacity);
  // LiftConfigSchema and its refinements.
  const uint32_t m = c.microsteps;
  if (!(m == 1 || m == 2 || m == 4 || m == 8 || m == 16 || m == 32)) w.fail();
  if (c.soft_min_milli_mm > kRailMilliMm || c.soft_max_milli_mm > kRailMilliMm) w.fail();
  if (!(c.soft_min_milli_mm < c.soft_max_milli_mm)) w.fail();
  if (c.max_speed_milli_mm_s == 0 || c.max_speed_milli_mm_s > kLiftSpeedCeilingMmS * 1000) w.fail();
  if (c.max_accel_milli_mm_s2 == 0 || c.max_accel_milli_mm_s2 > 200 * 1000) w.fail();  // LIFT_ACCEL_CEILING_MM_S2
  if (c.has_top_switch && (c.top_switch_milli_mm == 0 || c.top_switch_milli_mm > kRailMilliMm ||
                           !(c.soft_max_milli_mm < c.top_switch_milli_mm))) {
    w.fail();
  }
  if (!isLiftModuleId(module_id) || !isPlainText(firmware_version, 1, kMaxFirmwareVersionLength)) w.fail();
  w.begin("lift.hello", module_id, seq)
      .raw(",\"firmware_version\":")
      .text(firmware_version)
      .raw(",\"uptime_ms\":")
      .number(uptime_ms)
      .raw(",\"config\":{\"microsteps\":")
      .number(m)
      .raw(",\"soft_min_mm\":")
      .thousandths(c.soft_min_milli_mm)
      .raw(",\"soft_max_mm\":")
      .thousandths(c.soft_max_milli_mm)
      .raw(",\"max_speed_mm_s\":")
      .thousandths(c.max_speed_milli_mm_s)
      .raw(",\"max_accel_mm_s2\":")
      .thousandths(c.max_accel_milli_mm_s2)
      .raw(",\"top_switch_mm\":");
  if (c.has_top_switch) {
    w.thousandths(c.top_switch_milli_mm);
  } else {
    w.raw("null");
  }
  w.raw("},\"stop_sense\":").text(c.stop_sense_wired ? "wired" : "not_wired").raw("}");
  return w.finish();
}

size_t buildLiftStatus(char* out, size_t capacity, const char* module_id, uint32_t seq, const LiftStatusLine& s) {
  LineWriter w(out, capacity);
  const LiftState st = s.state;
  const bool moves = st == LiftState::Moving || st == LiftState::Homing || st == LiftState::Stopping;
  // LiftStatusSchema's refinements.
  if ((st == LiftState::Idle || st == LiftState::Moving) && !s.homed) w.fail();
  if ((st == LiftState::Unhomed || st == LiftState::Homing) && s.homed) w.fail();
  if ((st == LiftState::Fault) != (s.faults != 0)) w.fail();
  if (moves && !s.driver_enabled) w.fail();
  if (st == LiftState::Moving && !s.has_target) w.fail();
  if (s.has_target && !(st == LiftState::Moving || st == LiftState::Homing)) w.fail();
  if ((st == LiftState::Moving || st == LiftState::Homing) && s.request_id == nullptr) w.fail();
  if (s.homed && s.position_milli_mm > kRailMilliMm) w.fail();
  if (s.has_target && s.target_milli_mm > kRailMilliMm) w.fail();
  if (s.faults >= (1u << kLiftFaultCount)) w.fail();
  if (s.request_id != nullptr && !isLiftRequestId(s.request_id, textLength(s.request_id))) w.fail();
  // A pressed stop always has stop_circuit_opened latched.
  if (s.stop_sense == StopSense::Pressed && !(s.faults & liftFaultBit(LiftFault::StopCircuitOpened))) w.fail();
  if (!isLiftModuleId(module_id)) w.fail();

  w.begin("lift.status", module_id, seq)
      .raw(",\"uptime_ms\":")
      .number(s.uptime_ms)
      .raw(",\"state\":")
      .text(liftStateName(s.state))
      .raw(",\"homed\":")
      .boolean(s.homed)
      .raw(",\"position_mm\":");
  if (s.homed) {
    w.thousandths(s.position_milli_mm);
  } else {
    w.raw("null");
  }
  w.raw(",\"target_mm\":");
  if (s.has_target) {
    w.thousandths(s.target_milli_mm);
  } else {
    w.raw("null");
  }
  w.raw(",\"driver_enabled\":")
      .boolean(s.driver_enabled)
      .raw(",\"limits\":{\"top\":")
      .text(s.top_pressed ? "pressed" : "released")
      .raw(",\"bottom\":")
      .text(s.bottom_pressed ? "pressed" : "released")
      .raw("},\"stop_sense\":")
      .text(s.stop_sense == StopSense::Pressed ? "pressed" : s.stop_sense == StopSense::Released ? "released" : "not_wired")
      .raw(",\"faults\":[");
  bool first = true;
  for (size_t f = 0; f < kLiftFaultCount; ++f) {
    if (!(s.faults & (1u << f))) continue;
    if (!first) w.raw(",");
    w.text(kFaultNames[f]);
    first = false;
  }
  w.raw("],\"request_id\":");
  if (s.request_id != nullptr) {
    w.text(s.request_id);
  } else {
    w.raw("null");
  }
  w.raw(",\"heartbeat_age_ms\":");
  if (s.has_heartbeat) {
    w.number(s.heartbeat_age_ms);
  } else {
    w.raw("null");
  }
  w.raw("}");
  return w.finish();
}

size_t buildLiftDone(char* out, size_t capacity, const char* module_id, uint32_t seq, const char* request_id,
                     uint32_t uptime_ms, LiftOutcome outcome, LiftFault fault, bool homed, uint32_t position_milli_mm) {
  LineWriter w(out, capacity);
  if (request_id == nullptr || !isLiftRequestId(request_id, textLength(request_id))) w.fail();
  if (homed && position_milli_mm > kRailMilliMm) w.fail();
  if (!isLiftModuleId(module_id)) w.fail();
  const char* outcomeName = outcome == LiftOutcome::Completed ? "completed"
                            : outcome == LiftOutcome::Stopped ? "stopped"
                                                               : "failed";
  w.begin("lift.done", module_id, seq)
      .raw(",\"request_id\":")
      .text(request_id)
      .raw(",\"uptime_ms\":")
      .number(uptime_ms)
      .raw(",\"outcome\":")
      .text(outcomeName);
  if (outcome == LiftOutcome::Failed) w.raw(",\"fault\":").text(liftFaultName(fault));
  w.raw(",\"position_mm\":");
  if (homed) {
    w.thousandths(position_milli_mm);
  } else {
    w.raw("null");
  }
  w.raw("}");
  return w.finish();
}

size_t buildLiftAck(char* out, size_t capacity, const char* module_id, uint32_t seq, const char* request_id,
                    LiftRefusal refusal, uint32_t uptime_ms) {
  LineWriter w(out, capacity);
  if (request_id == nullptr || !isLiftRequestId(request_id, textLength(request_id))) w.fail();
  if (!isLiftModuleId(module_id)) w.fail();
  w.begin("lift.ack", module_id, seq).raw(",\"request_id\":").text(request_id);
  if (refusal == LiftRefusal::None) {
    w.raw(",\"result\":\"accepted\"");
  } else {
    w.raw(",\"result\":\"rejected\",\"reason\":").text(liftRefusalName(refusal));
  }
  w.raw(",\"uptime_ms\":").number(uptime_ms).raw("}");
  return w.finish();
}

}  // namespace walker
