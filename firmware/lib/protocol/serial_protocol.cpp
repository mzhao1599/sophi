#include "serial_protocol.h"

#include "protocol_internal.h"

#include <cmath>
#include <cstdlib>

namespace walker {

// Shared with lift_protocol.cpp through protocol_internal.h; nothing outside lib/protocol uses it.
namespace internal {

// ---------------------------------------------------------------------------------------------
// Names on the wire

const char* const kProblemNames[] = {
    "", "oversize", "malformed", "unsupported_version", "unknown_type", "invalid_field", "unsupported", "overflow",
};

const char* const kPatternNames[kPatternCount] = {"confirmation", "recording", "near_obstacle", "error"};

struct TypeName {
  const char* name;
  MessageType type;
};
const TypeName kTypeNames[] = {
    {"hello", MessageType::Hello},
    {"hello.request", MessageType::HelloRequest},
    {"heartbeat", MessageType::Heartbeat},
    {"hand.input", MessageType::HandInput},
    {"perception.zones", MessageType::PerceptionZones},
    {"haptic.play", MessageType::HapticPlay},
    {"ack", MessageType::Ack},
    {"error", MessageType::Error},
};

// Printable ASCII other than '"' and '\\', so a value never needs escaping.
bool isPlainChar(char c) { return c >= 0x20 && c <= 0x7e && c != '"' && c != '\\'; }

bool isPlainText(const char* s, size_t minLength, size_t maxLength) {
  if (s == nullptr) return false;
  size_t n = 0;
  for (; s[n] != '\0'; ++n) {
    if (!isPlainChar(s[n]) || n + 1 > maxLength) return false;
  }
  return n >= minLength;
}

// ^[A-Za-z0-9_-]+$, at most 40 characters (SerialRequestIdSchema).
bool isRequestIdChar(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-';
}

bool isRequestId(const char* s, size_t length) {
  if (length == 0 || length > kMaxRequestIdLength) return false;
  for (size_t i = 0; i < length; ++i) {
    if (!isRequestIdChar(s[i])) return false;
  }
  return true;
}

size_t textLength(const char* s) {
  size_t n = 0;
  while (s[n] != '\0') ++n;
  return n;
}

// ^[a-z][a-z0-9_.]*$, at most 32 characters (a hello capability).
bool isCapability(const char* s) {
  if (s == nullptr || !(s[0] >= 'a' && s[0] <= 'z')) return false;
  size_t n = 0;
  for (; s[n] != '\0'; ++n) {
    const char c = s[n];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '_' || c == '.')) return false;
    if (n + 1 > kMaxCapabilityLength) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------------
// Building lines: LineWriter is in protocol_internal.h

const char* healthName(Health health) {
  switch (health) {
    case Health::Ok:
      return "ok";
    case Health::Degraded:
      return "degraded";
    case Health::Fault:
      return "fault";
  }
  return "fault";
}

// ---------------------------------------------------------------------------------------------
// Reading lines: UTF-8 and JSON

// Strict UTF-8, as the Pi's TextDecoder({fatal: true}) reads it: no overlong forms, no surrogates,
// nothing above U+10FFFF.
bool isUtf8(const char* text, size_t length) {
  const unsigned char* s = reinterpret_cast<const unsigned char*>(text);
  size_t i = 0;
  while (i < length) {
    const unsigned char c = s[i];
    if (c < 0x80) {
      ++i;
      continue;
    }
    size_t extra = 0;
    unsigned char low = 0x80, high = 0xbf;  // the allowed range for the second byte
    if (c >= 0xc2 && c <= 0xdf) {
      extra = 1;
    } else if (c == 0xe0) {
      extra = 2;
      low = 0xa0;
    } else if ((c >= 0xe1 && c <= 0xec) || c == 0xee || c == 0xef) {
      extra = 2;
    } else if (c == 0xed) {
      extra = 2;
      high = 0x9f;
    } else if (c == 0xf0) {
      extra = 3;
      low = 0x90;
    } else if (c >= 0xf1 && c <= 0xf3) {
      extra = 3;
    } else if (c == 0xf4) {
      extra = 3;
      high = 0x8f;
    } else {
      return false;
    }
    if (length - i <= extra) return false;
    if (s[i + 1] < low || s[i + 1] > high) return false;
    for (size_t k = 2; k <= extra; ++k) {
      if (s[i + k] < 0x80 || s[i + k] > 0xbf) return false;
    }
    i += extra + 1;
  }
  return true;
}

// Kind, Value, Key, Fields: protocol_internal.h. The key names, in Key order:
const char* const kKeyNames[kKeyCount] = {
    "v", "type", "module_id", "seq", "request_id", "pattern", "duration_ms", "code", "detail", "uptime_ms",
    "target_mm", "speed_mm_s", "enabled", "hold_request_id",
};

bool isDigit(int c) { return c >= '0' && c <= '9'; }
bool isHex(int c) { return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
int hexValue(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  return c - 'A' + 10;
}

// A JSON reader over [start, end) that checks the grammar JSON.parse accepts (RFC 8259) without
// allocating. Nested arrays and objects are checked and skipped without recursion.
class Cursor {
 public:
  Cursor(const char* start, size_t length) : p_(start), end_(start + length) {}

  void ws() {
    while (p_ < end_ && (*p_ == ' ' || *p_ == '\t' || *p_ == '\n' || *p_ == '\r')) ++p_;
  }
  bool eat(char c) {
    if (p_ < end_ && *p_ == c) {
      ++p_;
      return true;
    }
    return false;
  }
  int peek() const { return p_ < end_ ? static_cast<unsigned char>(*p_) : -1; }
  bool atEnd() const { return p_ >= end_; }

  bool string(Value* out) {
    if (!eat('"')) return false;
    const char* start = p_;
    while (p_ < end_) {
      const unsigned char c = static_cast<unsigned char>(*p_);
      if (c == '"') {
        out->kind = Kind::String;
        out->start = start;
        out->length = static_cast<size_t>(p_ - start);
        ++p_;
        return true;
      }
      if (c < 0x20) return false;
      if (c == '\\') {
        ++p_;
        const int e = peek();
        if (e == '"' || e == '\\' || e == '/' || e == 'b' || e == 'f' || e == 'n' || e == 'r' || e == 't') {
          ++p_;
          continue;
        }
        if (e != 'u') return false;
        ++p_;
        for (int k = 0; k < 4; ++k) {
          if (!isHex(peek())) return false;
          ++p_;
        }
        continue;
      }
      ++p_;
    }
    return false;
  }

  bool number(Value* out) {
    const char* start = p_;
    eat('-');
    if (!eat('0')) {
      if (!isDigit(peek())) return false;
      while (isDigit(peek())) ++p_;
    }
    if (eat('.')) {
      if (!isDigit(peek())) return false;
      while (isDigit(peek())) ++p_;
    }
    if (peek() == 'e' || peek() == 'E') {
      ++p_;
      if (peek() == '+' || peek() == '-') ++p_;
      if (!isDigit(peek())) return false;
      while (isDigit(peek())) ++p_;
    }
    out->kind = Kind::Number;
    out->start = start;
    out->length = static_cast<size_t>(p_ - start);
    return true;
  }

  bool literal(const char* word, Kind kind, Value* out) {
    const char* start = p_;
    for (const char* w = word; *w != '\0'; ++w) {
      if (!eat(*w)) return false;
    }
    out->kind = kind;
    out->start = start;
    out->length = static_cast<size_t>(p_ - start);
    return true;
  }

  // Any value except a container.
  bool scalar(Value* out) {
    const int c = peek();
    if (c == '"') return string(out);
    if (c == '-' || isDigit(c)) return number(out);
    if (c == 't') return literal("true", Kind::True, out);
    if (c == 'f') return literal("false", Kind::False, out);
    if (c == 'n') return literal("null", Kind::Null, out);
    return false;
  }

  bool value(Value* out) {
    const int c = peek();
    if (c == '{' || c == '[') {
      out->kind = Kind::Container;
      out->start = p_;
      const bool ok = skipContainer();
      out->length = static_cast<size_t>(p_ - out->start);
      return ok;
    }
    return scalar(out);
  }

 private:
  // A member's key and colon, inside an object.
  bool memberKey() {
    ws();
    Value key;
    if (!string(&key)) return false;
    ws();
    return eat(':');
  }

  // Checks and skips the array or object starting at p_. Each nesting level uses at least one byte,
  // so a line can't nest deeper than kMaxLineBytes; one bit per level remembers object or array.
  bool skipContainer() {
    uint8_t isObject[kMaxLineBytes / 8] = {};
    size_t depth = 0;
    bool open = true;  // p_ is at '{' or '['
    for (;;) {
      if (open) {
        const bool object = *p_ == '{';
        ++p_;
        if (depth >= kMaxLineBytes) return false;
        const uint8_t mask = static_cast<uint8_t>(1u << (depth % 8));
        isObject[depth / 8] = static_cast<uint8_t>(object ? (isObject[depth / 8] | mask) : (isObject[depth / 8] & ~mask));
        ++depth;
        ws();
        if (eat(object ? '}' : ']')) {
          --depth;
          open = false;
          continue;
        }
        if (object && !memberKey()) return false;
        if (!element(&open)) return false;
        continue;
      }
      if (depth == 0) return true;
      ws();
      const size_t top = depth - 1;
      const bool object = (isObject[top / 8] >> (top % 8)) & 1u;
      if (eat(',')) {
        if (object && !memberKey()) return false;
        if (!element(&open)) return false;
        continue;
      }
      if (eat(object ? '}' : ']')) {
        --depth;
        continue;
      }
      return false;
    }
  }

  // The next element: opens a nested container, or reads a scalar.
  bool element(bool* open) {
    ws();
    const int c = peek();
    if (c == '{' || c == '[') {
      *open = true;
      return true;
    }
    Value ignored;
    *open = false;
    return scalar(&ignored);
  }

  const char* p_;
  const char* end_;
};

// Decodes a JSON string's contents into `out` as ASCII. Returns the length, or -1 when it holds a
// character above 0x7F (which no id, name or code in v1 allows) or needs more than capacity - 1 bytes.
// The result may contain NUL characters (from \u0000), so callers compare by length.
long decodeAscii(const Value& value, char* out, size_t capacity) {
  size_t n = 0;
  size_t i = 0;
  while (i < value.length) {
    char c = value.start[i];
    if (static_cast<unsigned char>(c) >= 0x80) return -1;
    if (c == '\\') {
      const char e = value.start[i + 1];
      if (e == 'u') {
        int code = 0;
        for (int k = 0; k < 4; ++k) code = code * 16 + hexValue(value.start[i + 2 + k]);
        if (code > 0x7f) return -1;
        c = static_cast<char>(code);
        i += 6;
      } else {
        c = e == 'b' ? '\b' : e == 'f' ? '\f' : e == 'n' ? '\n' : e == 'r' ? '\r' : e == 't' ? '\t' : e;
        i += 2;
      }
    } else {
      ++i;
    }
    if (n + 1 >= capacity) return -1;
    out[n++] = c;
  }
  out[n] = '\0';
  return static_cast<long>(n);
}

bool equals(const char* decoded, long length, const char* literal) {
  return length >= 0 && static_cast<size_t>(length) == textLength(literal) && sameText(decoded, literal);
}

// The string's length as the contract's zod (4.6.5) measures it: in Unicode code points, where a high
// surrogate followed by a low surrogate counts once and a lone surrogate counts as itself
// (zod's util.codePointLength). A raw 4-byte UTF-8 character is one pair; an escaped pair is \uD8xx\uDCxx.
size_t codePointLength(const Value& value) {
  size_t count = 0;
  bool unpairedHigh = false;  // the previous UTF-16 unit was a high surrogate not yet paired
  size_t i = 0;
  while (i < value.length) {
    const unsigned char c = static_cast<unsigned char>(value.start[i]);
    if (c >= 0xf0) {
      i += 4;  // a whole pair on its own
      count += 1;
      unpairedHigh = false;
      continue;
    }
    unsigned unit = 0;  // only its surrogate bits matter below
    if (c == '\\' && value.start[i + 1] == 'u') {
      for (int k = 0; k < 4; ++k) unit = unit * 16 + static_cast<unsigned>(hexValue(value.start[i + 2 + k]));
      i += 6;
    } else {
      i += c == '\\' ? 2 : c < 0x80 ? 1 : (c & 0xe0) == 0xc0 ? 2 : 3;  // valid UTF-8 never encodes a surrogate
    }
    if ((unit & 0xfc00) == 0xdc00 && unpairedHigh) {
      unpairedHigh = false;  // completes the pair: no new code point
      continue;
    }
    count += 1;
    unpairedHigh = (unit & 0xfc00) == 0xd800;
  }
  return count;
}

int keyIndex(const Value& key) {
  char name[16];
  const long n = decodeAscii(key, name, sizeof name);
  for (int k = 0; k < kKeyCount; ++k) {
    if (equals(name, n, kKeyNames[k])) return k;
  }
  return -1;
}

bool readObject(const char* line, size_t length, Fields* fields) {
  Cursor c(line, length);
  c.ws();
  if (!c.eat('{')) return false;  // not JSON, or JSON that isn't an object: both "malformed"
  c.ws();
  if (!c.eat('}')) {
    for (;;) {
      c.ws();
      Value key;
      if (!c.string(&key)) return false;
      c.ws();
      if (!c.eat(':')) return false;
      c.ws();
      Value value;
      if (!c.value(&value)) return false;
      const int index = keyIndex(key);
      if (index < 0) {
        fields->otherKey = true;
      } else {
        fields->values[index] = value;
      }
      c.ws();
      if (c.eat(',')) continue;
      if (c.eat('}')) break;
      return false;
    }
  }
  c.ws();
  return c.atEnd();
}

// ---------------------------------------------------------------------------------------------
// Reading lines: the contract's field rules

// The JavaScript number JSON.parse makes of the token. strtod rounds to the nearest double as
// JavaScript does. It stops at the first character that can't continue a number; the grammar check
// already found that character inside the line (a number is always followed by ',', '}' or space).
double numberOf(const Value& value) { return std::strtod(value.start, nullptr); }

// zod's z.int(): a safe integer.
bool isSafeInteger(double d) {
  return d >= -9007199254740991.0 && d <= 9007199254740991.0 && std::floor(d) == d;
}

bool isNonNegativeInteger(const Value& value) {
  if (value.kind != Kind::Number) return false;
  const double d = numberOf(value);
  return isSafeInteger(d) && d >= 0;
}

bool readModuleId(const Value& value, char* out) {
  if (value.kind != Kind::String) return false;
  const long n = decodeAscii(value, out, kMaxModuleIdLength + 1);
  return n > 0 && static_cast<size_t>(n) == textLength(out) && isModuleId(out);
}

bool readRequestId(const Value& value, char* out) {
  if (value.kind != Kind::String) return false;
  const long n = decodeAscii(value, out, kMaxRequestIdLength + 1);
  return n > 0 && isRequestId(out, static_cast<size_t>(n));
}

bool onlyKeys(const Fields& fields, uint16_t allowed) {
  if (fields.otherKey) return false;
  for (int k = 0; k < kKeyCount; ++k) {
    if (fields.values[k].kind != Kind::Missing && !(allowed & (1u << k))) return false;
  }
  return true;
}

bool readEnvelope(const Fields& fields, uint16_t allowed, PiLine* line) {
  return onlyKeys(fields, allowed) && readModuleId(fields.values[kModuleId], line->module_id) &&
         isNonNegativeInteger(fields.values[kSeq]);
}

Problem readHapticPlay(const Fields& fields, PiLine* line) {
  char requestId[kMaxRequestIdLength + 1] = {};
  if (readRequestId(fields.values[kRequestId], requestId)) {
    line->has_request_id = true;
    for (size_t i = 0; i <= kMaxRequestIdLength; ++i) line->request_id[i] = requestId[i];
  }
  const uint16_t allowed = kEnvelope | bit(kRequestId) | bit(kPattern) | bit(kDurationMs);
  if (!readEnvelope(fields, allowed, line) || !line->has_request_id) return Problem::InvalidField;

  const Value& pattern = fields.values[kPattern];
  if (pattern.kind != Kind::String) return Problem::InvalidField;
  char name[16];
  const long n = decodeAscii(pattern, name, sizeof name);
  bool found = false;
  for (size_t p = 0; p < kPatternCount; ++p) {
    if (equals(name, n, kPatternNames[p])) {
      line->pattern = static_cast<Pattern>(p);
      found = true;
    }
  }
  if (!found) return Problem::InvalidField;

  const Value& duration = fields.values[kDurationMs];
  if (duration.kind != Kind::Number) return Problem::InvalidField;
  const double ms = numberOf(duration);
  if (!isSafeInteger(ms) || ms < 1 || ms > kHapticMaxDurationMs) return Problem::InvalidField;
  line->duration_ms = static_cast<uint32_t>(ms);
  return Problem::None;
}

bool errorFieldsValid(const Fields& fields) {
  const Value& code = fields.values[kCode];
  if (code.kind != Kind::String) return false;
  char name[24];
  const long n = decodeAscii(code, name, sizeof name);
  bool known = false;
  for (size_t p = 1; p < sizeof kProblemNames / sizeof kProblemNames[0]; ++p) {
    if (equals(name, n, kProblemNames[p])) known = true;
  }
  if (!known) return false;

  char requestId[kMaxRequestIdLength + 1] = {};
  const Value& request = fields.values[kRequestId];
  if (request.kind != Kind::Missing && !readRequestId(request, requestId)) return false;
  const Value& detail = fields.values[kDetail];
  if (detail.kind != Kind::Missing && (detail.kind != Kind::String || codePointLength(detail) > kMaxDetailLength)) {
    return false;
  }
  const Value& uptime = fields.values[kUptimeMs];
  if (uptime.kind != Kind::Missing && !isNonNegativeInteger(uptime)) return false;
  return true;
}

Problem readError(const Fields& fields, PiLine* line) {
  if (!readEnvelope(fields, kErrorKeys, line) || !errorFieldsValid(fields)) return Problem::InvalidField;
  return Problem::None;
}

}  // namespace internal

using namespace internal;

const char* problemName(Problem problem) { return kProblemNames[static_cast<size_t>(problem)]; }

const char* patternName(Pattern pattern) { return kPatternNames[static_cast<size_t>(pattern)]; }

size_t buildHello(char* out, size_t capacity, const HelloFields& hello) {
  LineWriter w(out, capacity);
  w.begin("hello", hello.module_id, hello.seq)
      .raw(",\"module_type\":")
      .text(hello.type == ModuleType::Hand ? "hand" : "perception")
      .raw(",\"capabilities\":[");
  if (hello.capability_count > kMaxCapabilities) w.fail();
  for (size_t i = 0; i < hello.capability_count; ++i) {
    if (!isCapability(hello.capabilities[i])) w.fail();
    if (i > 0) w.raw(",");
    w.text(hello.capabilities[i]);
  }
  w.raw("]");
  if (hello.firmware_version != nullptr) {
    if (!isPlainText(hello.firmware_version, 1, kMaxFirmwareVersionLength)) w.fail();
    w.raw(",\"firmware_version\":").text(hello.firmware_version);
  }
  w.raw(",\"uptime_ms\":").number(hello.uptime_ms).raw("}");
  return w.finish();
}

size_t buildHeartbeat(char* out, size_t capacity, const char* module_id, uint32_t seq, uint32_t uptime_ms,
                      Health health, const char* const* faults, size_t fault_count) {
  LineWriter w(out, capacity);
  w.begin("heartbeat", module_id, seq).raw(",\"uptime_ms\":").number(uptime_ms).raw(",\"health\":").text(healthName(health));
  if (fault_count > kMaxFaults) w.fail();
  if (fault_count > 0) {
    w.raw(",\"faults\":[");
    for (size_t i = 0; i < fault_count; ++i) {
      if (!isSnakeName(faults[i], kMaxFaultNameLength)) w.fail();
      if (i > 0) w.raw(",");
      w.text(faults[i]);
    }
    w.raw("]");
  }
  w.raw("}");
  return w.finish();
}

size_t buildHandInput(char* out, size_t capacity, const char* module_id, uint32_t seq, uint32_t uptime_ms,
                      const char* button, Edge edge) {
  LineWriter w(out, capacity);
  if (!isSnakeName(button, kMaxButtonNameLength)) w.fail();
  w.begin("hand.input", module_id, seq)
      .raw(",\"uptime_ms\":")
      .number(uptime_ms)
      .raw(",\"button\":")
      .text(button)
      .raw(",\"edge\":")
      .text(edge == Edge::Pressed ? "pressed" : "released")
      .raw("}");
  return w.finish();
}

size_t buildZones(char* out, size_t capacity, const char* module_id, uint32_t seq, uint32_t uptime_ms,
                  const Zone* zones, size_t zone_count) {
  LineWriter w(out, capacity);
  if (zone_count == 0 || zone_count > kMaxZones) w.fail();
  w.begin("perception.zones", module_id, seq).raw(",\"uptime_ms\":").number(uptime_ms).raw(",\"zones\":[");
  for (size_t i = 0; i < zone_count && i < kMaxZones; ++i) {
    const Zone& zone = zones[i];
    if (!isSnakeName(zone.name, kMaxZoneNameLength)) {
      w.fail();
      break;
    }
    for (size_t j = 0; j < i; ++j) {
      if (sameText(zones[j].name, zone.name)) w.fail();
    }
    if (i > 0) w.raw(",");
    w.raw("{\"name\":").text(zone.name).raw(",\"mm\":");
    if (zone.valid) {
      w.number(zone.mm).raw(",\"quality\":\"valid\"}");
    } else {
      w.raw("null,\"quality\":\"invalid\"}");
    }
  }
  w.raw("]}");
  return w.finish();
}

size_t buildAck(char* out, size_t capacity, const char* module_id, uint32_t seq, const char* request_id,
                Problem reason, uint32_t uptime_ms) {
  LineWriter w(out, capacity);
  if (request_id == nullptr || !isRequestId(request_id, textLength(request_id))) w.fail();
  w.begin("ack", module_id, seq).raw(",\"request_id\":").text(request_id);
  if (reason == Problem::None) {
    w.raw(",\"result\":\"accepted\"");
  } else {
    w.raw(",\"result\":\"rejected\",\"reason\":").text(problemName(reason));
  }
  w.raw(",\"uptime_ms\":").number(uptime_ms).raw("}");
  return w.finish();
}

size_t buildError(char* out, size_t capacity, const char* module_id, uint32_t seq, Problem code,
                  const char* detail, uint32_t uptime_ms) {
  LineWriter w(out, capacity);
  if (code == Problem::None) w.fail();
  w.begin("error", module_id, seq).raw(",\"code\":").text(problemName(code));
  if (detail != nullptr) {
    if (!isPlainText(detail, 0, kMaxDetailLength)) w.fail();
    w.raw(",\"detail\":").text(detail);
  }
  w.raw(",\"uptime_ms\":").number(uptime_ms).raw("}");
  return w.finish();
}

PiLine parsePiLine(const char* line, size_t length) {
  PiLine result;
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
    for (const TypeName& known : kTypeNames) {
      if (equals(name, n, known.name)) result.type = known.type;
    }
  }

  switch (result.type) {
    case MessageType::Unknown:
      result.problem = Problem::UnknownType;
      break;
    case MessageType::HapticPlay:
      result.problem = readHapticPlay(fields, &result);
      break;
    case MessageType::HelloRequest:
      result.problem = readEnvelope(fields, kEnvelope, &result) ? Problem::None : Problem::InvalidField;
      break;
    case MessageType::Error:
      result.problem = readError(fields, &result);
      break;
    default:
      // hello, heartbeat, hand.input, perception.zones, ack: only modules send these.
      result.problem = Problem::Unsupported;
      break;
  }
  if (result.problem != Problem::None) result.module_id[0] = '\0';
  return result;
}

bool isBlankLine(const char* line, size_t length) {
  for (size_t i = 0; i < length; ++i) {
    const char c = line[i];
    if (c != ' ' && c != '\t' && c != '\r' && c != '\v' && c != '\f') return false;
  }
  return true;
}

LineReader::Event LineReader::push(uint8_t byte) {
  if (complete_) {
    length_ = 0;
    complete_ = false;
  }
  if (byte == '\n') {
    if (discarding_) {
      discarding_ = false;
      length_ = 0;
      return Event::None;
    }
    buffer_[length_] = '\0';
    complete_ = true;
    return Event::Line;
  }
  if (discarding_) return Event::None;
  // A line may hold at most kMaxLineBytes - 1 bytes before its '\n'.
  if (length_ >= kMaxLineBytes - 1) {
    length_ = 0;
    discarding_ = true;
    return Event::Oversize;
  }
  buffer_[length_++] = static_cast<char>(byte);
  return Event::None;
}

}  // namespace walker
