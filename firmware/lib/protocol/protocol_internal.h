// The JSON line reader and writer that serial_protocol.cpp (hand and obstacle boards) and
// lift_protocol.cpp (the lift board) share. Internal to lib/protocol: nothing else includes it.
// Defined in serial_protocol.cpp, except LineWriter, which lives here whole.
#pragma once

#include <cstddef>
#include <cstdint>

#include "serial_protocol.h"

namespace walker {
namespace internal {

// Printable ASCII other than '"' and '\\', so a value never needs escaping.
bool isPlainChar(char c);
bool isPlainText(const char* s, size_t minLength, size_t maxLength);
// ^[A-Za-z0-9_-]+$, at most 40 characters (SerialRequestIdSchema).
bool isRequestId(const char* s, size_t length);
size_t textLength(const char* s);

// ---- Building lines ----

// Appends to a fixed buffer. Any overflow or forbidden value marks the line failed, and finish()
// then returns 0, so a caller never sends part of a line.
class LineWriter {
 public:
  LineWriter(char* out, size_t capacity)
      : out_(out), capacity_(capacity < kMaxLineBytes ? capacity : kMaxLineBytes) {}

  LineWriter& raw(const char* text) {
    while (*text != '\0') put(*text++);
    return *this;
  }

  // A JSON string whose characters never need escaping (checked here).
  LineWriter& text(const char* value) {
    if (value == nullptr) {
      ok_ = false;
      return *this;
    }
    put('"');
    for (const char* p = value; *p != '\0'; ++p) {
      if (!isPlainChar(*p)) ok_ = false;
      put(*p);
    }
    put('"');
    return *this;
  }

  LineWriter& number(uint32_t value) {
    char digits[10];
    size_t n = 0;
    do {
      digits[n++] = static_cast<char>('0' + value % 10);
      value /= 10;
    } while (value != 0);
    while (n > 0) put(digits[--n]);
    return *this;
  }

  // A non-negative number given in thousandths, written with no trailing zeros: 121500 -> 121.5,
  // 5000 -> 5, 3 -> 0.003. Integer arithmetic only, so every computer prints the same digits.
  LineWriter& thousandths(uint32_t value) {
    number(value / 1000);
    uint32_t fraction = value % 1000;
    if (fraction != 0) {
      put('.');
      uint32_t place = 100;
      while (fraction != 0) {
        put(static_cast<char>('0' + fraction / place));
        fraction %= place;
        place /= 10;
      }
    }
    return *this;
  }

  LineWriter& boolean(bool value) { return raw(value ? "true" : "false"); }

  // The envelope every line starts with.
  LineWriter& begin(const char* type, const char* moduleId, uint32_t seq) {
    if (!isProvisionableModuleId(moduleId)) ok_ = false;
    return raw("{\"v\":1,\"type\":").text(type).raw(",\"module_id\":").text(moduleId).raw(",\"seq\":").number(seq);
  }

  void fail() { ok_ = false; }

  size_t finish() {
    put('\n');
    return ok_ ? length_ : 0;
  }

 private:
  void put(char c) {
    if (length_ >= capacity_) {
      ok_ = false;
      return;
    }
    out_[length_++] = c;
  }

  char* out_;
  size_t capacity_;
  size_t length_ = 0;
  bool ok_ = true;
};

// ---- Reading lines ----

// Strict UTF-8, as the Pi's TextDecoder({fatal: true}) reads it.
bool isUtf8(const char* text, size_t length);

enum class Kind : uint8_t { Missing, String, Number, True, False, Null, Container };

// One JSON value inside the line. For a string, start/length cover its contents without the quotes
// (escapes still in place); for a number, the token itself.
struct Value {
  Kind kind = Kind::Missing;
  const char* start = nullptr;
  size_t length = 0;
};

// Every top-level key either protocol reads. A key in neither list sets Fields::otherKey; a key a
// type doesn't allow is refused by onlyKeys, so sharing the list changes no verdict.
enum Key : uint8_t {
  kV,
  kType,
  kModuleId,
  kSeq,
  kRequestId,
  kPattern,
  kDurationMs,
  kCode,
  kDetail,
  kUptimeMs,
  kTargetMm,
  kSpeedMmS,
  kEnabled,
  kHoldRequestId,
  kKeyCount
};
constexpr uint16_t bit(Key key) { return static_cast<uint16_t>(1u << key); }
static_assert(kKeyCount <= 16, "Key bits must fit in uint16_t");

// v, type, module_id and seq: present on every line.
constexpr uint16_t kEnvelope = bit(kV) | bit(kType) | bit(kModuleId) | bit(kSeq);
// The keys an `error` line may carry (SerialErrorSchema).
constexpr uint16_t kErrorKeys = kEnvelope | bit(kCode) | bit(kRequestId) | bit(kDetail) | bit(kUptimeMs);

// The top-level members of the line's object. A repeated key keeps its last value, as JSON.parse does.
struct Fields {
  Value values[kKeyCount];
  bool otherKey = false;
};

// Checks the line is one JSON object (RFC 8259, as JSON.parse reads it) and collects its members.
bool readObject(const char* line, size_t length, Fields* fields);
// A JSON string's contents as ASCII; -1 when it holds a character above 0x7F or doesn't fit.
long decodeAscii(const Value& value, char* out, size_t capacity);
bool equals(const char* decoded, long length, const char* literal);
// The JavaScript number JSON.parse makes of a number token.
double numberOf(const Value& value);
// zod's z.int(): a safe integer.
bool isSafeInteger(double d);
bool isNonNegativeInteger(const Value& value);
// SerialModuleIdSchema; `out` holds kMaxModuleIdLength + 1 bytes.
bool readModuleId(const Value& value, char* out);
// SerialRequestIdSchema; `out` holds kMaxRequestIdLength + 1 bytes.
bool readRequestId(const Value& value, char* out);
// No key outside `allowed`, and no key outside the shared list.
bool onlyKeys(const Fields& fields, uint16_t allowed);
// An `error` line's own fields (code, request_id, detail, uptime_ms), keys already checked.
bool errorFieldsValid(const Fields& fields);

}  // namespace internal
}  // namespace walker
