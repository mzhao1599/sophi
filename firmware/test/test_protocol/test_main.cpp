// Native tests for lib/protocol: building lines, reading the Pi's lines, the size limit and framing.
// Row ids (L5, R2, ...) refer to test/EXPECTED.md.
#include <cstring>
#include <string>
#include <vector>

#include "../support/expect.h"
#include "serial_protocol.h"

using namespace walker;

#ifdef PIO_UNIT_TESTING
void setUp() {}
void tearDown() {}
#endif

namespace {

std::string built(size_t length, const char* buffer) { return length == 0 ? std::string() : std::string(buffer, length); }

PiLine parse(const std::string& line) { return parsePiLine(line.data(), line.size()); }

Problem problemOf(const std::string& line) { return parse(line).problem; }

const char* kHandCaps[] = {"button.talk", "button.confirm", "haptic"};

std::string haptic(const std::string& middle) {
  return "{\"v\":1,\"type\":\"haptic.play\",\"module_id\":\"hand-left-01\",\"seq\":3," + middle + "}";
}

const std::string kGoodHaptic = haptic("\"request_id\":\"cue-1\",\"pattern\":\"near_obstacle\",\"duration_ms\":400");

// ---- Building (L1, L2, L5, L6) ----

void test_L1_hello_line() {
  char out[kMaxLineBytes];
  HelloFields hello{"hand-left-01", 0, ModuleType::Hand, kHandCaps, 3, "0.1.0", 12};
  CHECK_STR(built(buildHello(out, sizeof out, hello), out),
            "{\"v\":1,\"type\":\"hello\",\"module_id\":\"hand-left-01\",\"seq\":0,\"module_type\":\"hand\","
            "\"capabilities\":[\"button.talk\",\"button.confirm\",\"haptic\"],\"firmware_version\":\"0.1.0\","
            "\"uptime_ms\":12}\n");
  const char* zones[] = {"zones"};
  HelloFields tof{"tof-front-01", 7, ModuleType::Perception, zones, 1, "0.1.0", 4294967295u};
  CHECK_STR(built(buildHello(out, sizeof out, tof), out),
            "{\"v\":1,\"type\":\"hello\",\"module_id\":\"tof-front-01\",\"seq\":7,\"module_type\":\"perception\","
            "\"capabilities\":[\"zones\"],\"firmware_version\":\"0.1.0\",\"uptime_ms\":4294967295}\n");
}

void test_L2_heartbeat_line() {
  char out[kMaxLineBytes];
  CHECK_STR(built(buildHeartbeat(out, sizeof out, "tof-front-01", 84, 27002, Health::Ok, nullptr, 0), out),
            "{\"v\":1,\"type\":\"heartbeat\",\"module_id\":\"tof-front-01\",\"seq\":84,\"uptime_ms\":27002,"
            "\"health\":\"ok\"}\n");
  const char* faults[] = {"sensor_missing", "sensor_error"};
  CHECK_STR(built(buildHeartbeat(out, sizeof out, "tof-front-01", 85, 28002, Health::Degraded, faults, 2), out),
            "{\"v\":1,\"type\":\"heartbeat\",\"module_id\":\"tof-front-01\",\"seq\":85,\"uptime_ms\":28002,"
            "\"health\":\"degraded\",\"faults\":[\"sensor_missing\",\"sensor_error\"]}\n");
}

void test_B5_hand_input_line() {
  char out[kMaxLineBytes];
  CHECK_STR(built(buildHandInput(out, sizeof out, "hand-left-01", 42, 156205, "talk", Edge::Pressed), out),
            "{\"v\":1,\"type\":\"hand.input\",\"module_id\":\"hand-left-01\",\"seq\":42,\"uptime_ms\":156205,"
            "\"button\":\"talk\",\"edge\":\"pressed\"}\n");
  CHECK_STR(built(buildHandInput(out, sizeof out, "hand-right-01", 43, 156300, "confirm", Edge::Released), out),
            "{\"v\":1,\"type\":\"hand.input\",\"module_id\":\"hand-right-01\",\"seq\":43,\"uptime_ms\":156300,"
            "\"button\":\"confirm\",\"edge\":\"released\"}\n");
}

void test_Z1_zones_line() {
  char out[kMaxLineBytes];
  const Zone zones[] = {{"front_left", true, 610}, {"front_right", false, 0}, {"left", true, 0}, {"right", true, 65535}};
  CHECK_STR(built(buildZones(out, sizeof out, "tof-front-01", 83, 26851, zones, 4), out),
            "{\"v\":1,\"type\":\"perception.zones\",\"module_id\":\"tof-front-01\",\"seq\":83,\"uptime_ms\":26851,"
            "\"zones\":[{\"name\":\"front_left\",\"mm\":610,\"quality\":\"valid\"},{\"name\":\"front_right\","
            "\"mm\":null,\"quality\":\"invalid\"},{\"name\":\"left\",\"mm\":0,\"quality\":\"valid\"},"
            "{\"name\":\"right\",\"mm\":65535,\"quality\":\"valid\"}]}\n");
}

void test_R1_ack_and_error_lines() {
  char out[kMaxLineBytes];
  CHECK_STR(built(buildAck(out, sizeof out, "hand-left-01", 75, "cue-172", Problem::None, 9), out),
            "{\"v\":1,\"type\":\"ack\",\"module_id\":\"hand-left-01\",\"seq\":75,\"request_id\":\"cue-172\","
            "\"result\":\"accepted\",\"uptime_ms\":9}\n");
  CHECK_STR(built(buildAck(out, sizeof out, "hand-left-01", 76, "cue-173", Problem::InvalidField, 9), out),
            "{\"v\":1,\"type\":\"ack\",\"module_id\":\"hand-left-01\",\"seq\":76,\"request_id\":\"cue-173\","
            "\"result\":\"rejected\",\"reason\":\"invalid_field\",\"uptime_ms\":9}\n");
  CHECK_STR(built(buildError(out, sizeof out, "hand-left-01", 77, Problem::Malformed, nullptr, 9), out),
            "{\"v\":1,\"type\":\"error\",\"module_id\":\"hand-left-01\",\"seq\":77,\"code\":\"malformed\","
            "\"uptime_ms\":9}\n");
  CHECK_STR(built(buildError(out, sizeof out, "hand-left-01", 78, Problem::Unsupported, "not for a module", 9), out),
            "{\"v\":1,\"type\":\"error\",\"module_id\":\"hand-left-01\",\"seq\":78,\"code\":\"unsupported\","
            "\"detail\":\"not for a module\",\"uptime_ms\":9}\n");
}

void test_L6_builders_refuse_what_the_contract_forbids() {
  char out[kMaxLineBytes];
  // Sixteen 24-character zone names make a line over 1,024 bytes: nothing is built.
  static char names[16][25];
  Zone zones[16];
  for (int i = 0; i < 16; ++i) {
    const std::string name = std::string("zone_") + static_cast<char>('a' + i) + "_abcdefghijklmnopq";
    std::memcpy(names[i], name.c_str(), name.size() + 1);
    zones[i] = Zone{names[i], false, 0};
  }
  CHECK(std::strlen(names[0]) == 24);
  CHECK(buildZones(out, sizeof out, "tof-front-01", 1, 1, zones, 16) == 0);
  // Five of them fit.
  const size_t five = buildZones(out, sizeof out, "tof-front-01", 1, 1, zones, 5);
  CHECK(five > 0 && five <= kMaxLineBytes && out[five - 1] == '\n');

  const Zone upper[] = {{"Front", true, 1}};
  CHECK(buildZones(out, sizeof out, "tof-front-01", 1, 1, upper, 1) == 0);
  const Zone repeated[] = {{"left", true, 1}, {"left", true, 2}};
  CHECK(buildZones(out, sizeof out, "tof-front-01", 1, 1, repeated, 2) == 0);
  CHECK(buildZones(out, sizeof out, "tof-front-01", 1, 1, zones, 0) == 0);
  const Zone tooLong[] = {{"abcdefghijklmnopqrstuvwxy", true, 1}};  // 25 characters
  CHECK(buildZones(out, sizeof out, "tof-front-01", 1, 1, tooLong, 1) == 0);

  CHECK(buildHeartbeat(out, sizeof out, "any", 1, 1, Health::Ok, nullptr, 0) == 0);
  CHECK(buildHeartbeat(out, sizeof out, "Hand-Left", 1, 1, Health::Ok, nullptr, 0) == 0);
  CHECK(buildHeartbeat(out, sizeof out, "", 1, 1, Health::Ok, nullptr, 0) == 0);
  CHECK(buildHeartbeat(out, sizeof out, "abcdefghijklmnopqrstuvwxyz0123456", 1, 1, Health::Ok, nullptr, 0) == 0);
  const char* badFault[] = {"Sensor"};
  CHECK(buildHeartbeat(out, sizeof out, "tof-front-01", 1, 1, Health::Degraded, badFault, 1) == 0);
  const char* nineFaults[] = {"a", "b", "c", "d", "e", "f", "g", "h", "i"};
  CHECK(buildHeartbeat(out, sizeof out, "tof-front-01", 1, 1, Health::Degraded, nineFaults, 9) == 0);
  CHECK(buildHandInput(out, sizeof out, "hand-left-01", 1, 1, "Talk", Edge::Pressed) == 0);
  CHECK(buildHandInput(out, sizeof out, "hand-left-01", 1, 1, "a_seventeen_chars", Edge::Pressed) == 0);
  CHECK(buildAck(out, sizeof out, "hand-left-01", 1, "cue 1", Problem::None, 1) == 0);
  CHECK(buildAck(out, sizeof out, "hand-left-01", 1, "", Problem::None, 1) == 0);
  CHECK(buildError(out, sizeof out, "hand-left-01", 1, Problem::None, nullptr, 1) == 0);
  CHECK(buildError(out, sizeof out, "hand-left-01", 1, Problem::Malformed, "has \"quotes\"", 1) == 0);
  const char* badCaps[] = {"Button.talk"};
  HelloFields hello{"hand-left-01", 0, ModuleType::Hand, badCaps, 1, "0.1.0", 0};
  CHECK(buildHello(out, sizeof out, hello) == 0);

  // The output buffer's own size is respected to the byte.
  HelloFields good{"hand-left-01", 0, ModuleType::Hand, kHandCaps, 3, "0.1.0", 0};
  const size_t full = buildHello(out, sizeof out, good);
  char exact[kMaxLineBytes];
  CHECK(buildHello(exact, full, good) == full);
  CHECK(buildHello(exact, full - 1, good) == 0);
}

// ---- Reading the Pi's lines ----

void test_R1_valid_haptic_play() {
  const PiLine line = parse(kGoodHaptic);
  CHECK(line.problem == Problem::None);
  CHECK(line.type == MessageType::HapticPlay);
  CHECK_STR(line.module_id, "hand-left-01");
  CHECK(line.has_request_id);
  CHECK_STR(line.request_id, "cue-1");
  CHECK(line.pattern == Pattern::NearObstacle);
  CHECK(line.duration_ms == 400);
  for (const char* name : {"confirmation", "recording", "near_obstacle", "error"}) {
    const PiLine p = parse(haptic(std::string("\"request_id\":\"c\",\"pattern\":\"") + name + "\",\"duration_ms\":1"));
    CHECK(p.problem == Problem::None);
    CHECK_STR(patternName(p.pattern), name);
  }
  CHECK(parse(haptic("\"request_id\":\"c\",\"pattern\":\"error\",\"duration_ms\":1000")).duration_ms == 1000);
}

void test_R2_bad_field_with_readable_request_id() {
  const char* middles[] = {
      "\"request_id\":\"cue-2\",\"pattern\":\"custom\",\"duration_ms\":400",
      "\"request_id\":\"cue-2\",\"pattern\":\"near_obstacle\",\"duration_ms\":0",
      "\"request_id\":\"cue-2\",\"pattern\":\"near_obstacle\",\"duration_ms\":1001",
      "\"request_id\":\"cue-2\",\"pattern\":\"near_obstacle\",\"duration_ms\":400.5",
      "\"request_id\":\"cue-2\",\"pattern\":\"near_obstacle\",\"duration_ms\":\"400\"",
      "\"request_id\":\"cue-2\",\"pattern\":\"near_obstacle\",\"duration_ms\":-400",
      "\"request_id\":\"cue-2\",\"pattern\":\"near_obstacle\",\"duration_ms\":400,\"waveform\":[255,0,255]",
      "\"request_id\":\"cue-2\",\"pattern\":\"near_obstacle\"",
      "\"request_id\":\"cue-2\",\"duration_ms\":400",
      "\"request_id\":\"cue-2\",\"pattern\":\"NEAR_OBSTACLE\",\"duration_ms\":400",
      "\"request_id\":\"cue-2\",\"pattern\":null,\"duration_ms\":400",
      "\"request_id\":\"cue-2\",\"pattern\":\"near_obstacle\",\"duration_ms\":400,\"uptime_ms\":5",
  };
  for (const char* middle : middles) {
    const PiLine line = parse(haptic(middle));
    CHECK(line.problem == Problem::InvalidField);
    CHECK(line.type == MessageType::HapticPlay);
    CHECK(line.has_request_id);
    CHECK_STR(line.request_id, "cue-2");
  }
  // A bad envelope field, with a good request_id.
  const PiLine badSeq = parse(
      "{\"v\":1,\"type\":\"haptic.play\",\"module_id\":\"hand-left-01\",\"seq\":-1,\"request_id\":\"cue-3\","
      "\"pattern\":\"error\",\"duration_ms\":400}");
  CHECK(badSeq.problem == Problem::InvalidField && badSeq.has_request_id);
  const PiLine noModule = parse("{\"v\":1,\"type\":\"haptic.play\",\"seq\":1,\"request_id\":\"cue-4\","
                                "\"pattern\":\"error\",\"duration_ms\":400}");
  CHECK(noModule.problem == Problem::InvalidField && noModule.has_request_id);
}

void test_R3_unreadable_request_id() {
  const char* middles[] = {
      "\"pattern\":\"error\",\"duration_ms\":400",
      "\"request_id\":\"\",\"pattern\":\"error\",\"duration_ms\":400",
      "\"request_id\":\"cue 1\",\"pattern\":\"error\",\"duration_ms\":400",
      "\"request_id\":\"abcdefghijklmnopqrstuvwxyz0123456789ABCDE\",\"pattern\":\"error\",\"duration_ms\":400",
      "\"request_id\":42,\"pattern\":\"error\",\"duration_ms\":400",
      "\"request_id\":\"c\\u00e9\",\"pattern\":\"error\",\"duration_ms\":400",
  };
  for (const char* middle : middles) {
    const PiLine line = parse(haptic(middle));
    CHECK(line.problem == Problem::InvalidField);
    CHECK(!line.has_request_id);
  }
  // Exactly 40 characters is fine.
  CHECK(problemOf(haptic("\"request_id\":\"abcdefghijklmnopqrstuvwxyz0123456789ABCD\",\"pattern\":\"error\","
                         "\"duration_ms\":400")) == Problem::None);
}

void test_R6_hello_request() {
  const PiLine any = parse("{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":0}");
  CHECK(any.problem == Problem::None && any.type == MessageType::HelloRequest);
  CHECK_STR(any.module_id, "any");
  CHECK(problemOf("{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":3,\"rate_hz\":20}") ==
        Problem::InvalidField);
  CHECK(problemOf("{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"any\"}") == Problem::InvalidField);
  CHECK(problemOf("{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"ANY\",\"seq\":0}") == Problem::InvalidField);
  CHECK(problemOf("{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":0,\"request_id\":\"x\"}") ==
        Problem::InvalidField);
}

void test_R7_malformed() {
  const std::string lines[] = {
      "{\"v\":1,\"type\":\"hello\",\"module_id\":\"hand-left-01\"",
      "[1,2,3]",
      "null",
      "42",
      "\"hello\"",
      "",
      "{",
      "}",
      "{\"v\":1,}",
      "{\"v\":1 \"type\":\"error\"}",
      "{'v':1}",
      "{\"v\":01}",
      "{\"v\":1.}",
      "{\"v\":.5}",
      "{\"v\":+1}",
      "{\"v\":1e}",
      "{\"v\":NaN}",
      "{\"v\":tru}",
      "{\"v\":1}x",
      "{\"v\":1}{\"v\":1}",
      "{\"a\":\"\\x\"}",
      "{\"a\":\"\\u12g4\"}",
      std::string("{\"a\":\"tab\there\"}"),
      std::string("{\"v\":1,\"a\":\"\0\"}", 15),  // a raw NUL inside a string
      "{\"a\":[1,2,}",
      "{\"a\":[1,2]]}",
      "{\"a\":{\"b\" 1}}",
      "{\"a\":{\"b\":1,}}",
      "{\"a\":[}",
      std::string("\xef\xbb\xbf{\"v\":1}"),  // a byte-order mark is not JSON whitespace
  };
  for (const std::string& line : lines) CHECK(problemOf(line) == Problem::Malformed);
  // Bytes that aren't UTF-8, inside an otherwise valid string.
  const char* badUtf8[] = {"\xc0\x80", "\xed\xa0\x80", "\xf5\x80\x80\x80", "\xe2\x82", "\x80", "\xf4\x90\x80\x80", "\xe0\x80\x80"};
  for (const char* bytes : badUtf8) {
    CHECK(problemOf(std::string("{\"v\":1,\"type\":\"error\",\"module_id\":\"a\",\"seq\":0,\"code\":\"malformed\","
                                "\"detail\":\"") +
                    bytes + "\"}") == Problem::Malformed);
  }
}

void test_R8_version() {
  CHECK(problemOf("{\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":0}") == Problem::UnsupportedVersion);
  CHECK(problemOf("{\"v\":2,\"type\":\"heartbeat\",\"module_id\":\"hand-left-01\",\"seq\":1,\"uptime_ms\":10,"
                  "\"health\":\"ok\"}") == Problem::UnsupportedVersion);
  CHECK(problemOf("{\"v\":\"1\",\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":0}") ==
        Problem::UnsupportedVersion);
  CHECK(problemOf("{\"v\":true,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":0}") ==
        Problem::UnsupportedVersion);
  CHECK(problemOf("{}") == Problem::UnsupportedVersion);
  // JSON.parse reads all of these as the number 1.
  for (const char* v : {"1.0", "1e0", "10e-1", "0.1e1", "1.0000000000000000001"}) {
    CHECK(problemOf(std::string("{\"v\":") + v + ",\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":0}") ==
          Problem::None);
  }
  // A repeated key keeps its last value.
  CHECK(problemOf("{\"v\":1,\"v\":2,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":0}") ==
        Problem::UnsupportedVersion);
  CHECK(problemOf("{\"v\":2,\"v\":1,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":0}") == Problem::None);
}

void test_R9_type() {
  CHECK(problemOf("{\"v\":1,\"module_id\":\"any\",\"seq\":0}") == Problem::UnknownType);
  CHECK(problemOf("{\"v\":1,\"type\":\"motor.move\",\"module_id\":\"hand-left-01\",\"seq\":1,\"angle\":90}") ==
        Problem::UnknownType);
  CHECK(problemOf("{\"v\":1,\"type\":7}") == Problem::UnknownType);
  CHECK(problemOf("{\"v\":1,\"type\":\"HELLO.REQUEST\"}") == Problem::UnknownType);
  CHECK(problemOf("{\"v\":1,\"type\":\"hello.request.extra.long.name\"}") == Problem::UnknownType);
  CHECK(problemOf("{\"v\":1,\"type\":\"hello\\u0000\"}") == Problem::UnknownType);
}

void test_R10_types_only_modules_send() {
  const char* lines[] = {
      ("{\"v\":1,\"type\":\"hello\",\"module_id\":\"hand-left-01\",\"module_type\":\"hand\",\"seq\":0,"
       "\"capabilities\":[\"button.primary\",\"trigger\",\"haptic\"]}"),
      "{\"v\":1,\"type\":\"heartbeat\",\"module_id\":\"tof-front-01\",\"seq\":84,\"uptime_ms\":27002,\"health\":\"ok\"}",
      "{\"v\":1,\"type\":\"hand.input\",\"module_id\":\"hand-left-01\",\"seq\":6,\"uptime_ms\":10,\"button\":\"primary\"}",
      "{\"v\":1,\"type\":\"perception.zones\",\"module_id\":\"tof-front-01\",\"seq\":5,\"uptime_ms\":10,\"zones\":[]}",
      "{\"v\":1,\"type\":\"ack\",\"module_id\":\"hand-left-01\",\"seq\":75,\"request_id\":\"cue-172\",\"result\":\"accepted\"}",
  };
  for (const char* line : lines) {
    const PiLine parsed = parse(line);
    CHECK(parsed.problem == Problem::Unsupported);
    CHECK(parsed.type != MessageType::Unknown);
  }
}

void test_R11_error_lines_from_the_pi() {
  CHECK(problemOf("{\"v\":1,\"type\":\"error\",\"module_id\":\"hand-left-01\",\"seq\":77,\"code\":\"malformed\"}") ==
        Problem::None);
  CHECK(problemOf("{\"v\":1,\"type\":\"error\",\"module_id\":\"hand-left-01\",\"seq\":77,\"code\":\"overflow\","
                  "\"request_id\":\"cue-1\",\"detail\":\"queue full\",\"uptime_ms\":5}") == Problem::None);
  CHECK(problemOf("{\"v\":1,\"type\":\"error\",\"module_id\":\"hand-left-01\",\"seq\":77,\"code\":\"bad\"}") ==
        Problem::InvalidField);
  CHECK(problemOf("{\"v\":1,\"type\":\"error\",\"module_id\":\"hand-left-01\",\"seq\":77}") == Problem::InvalidField);
  CHECK(problemOf("{\"v\":1,\"type\":\"error\",\"module_id\":\"hand-left-01\",\"seq\":77,\"code\":\"malformed\","
                  "\"request_id\":\"no spaces\"}") == Problem::InvalidField);
  CHECK(problemOf("{\"v\":1,\"type\":\"error\",\"module_id\":\"hand-left-01\",\"seq\":77,\"code\":\"malformed\","
                  "\"uptime_ms\":-1}") == Problem::InvalidField);
  // R11 (review): detail holds at most 120 Unicode code points, as zod 4.6.5 counts them: a surrogate pair,
  // raw or escaped, is one; a lone surrogate is one.
  const std::string base = "{\"v\":1,\"type\":\"error\",\"module_id\":\"a\",\"seq\":0,\"code\":\"malformed\",\"detail\":\"";
  auto repeat = [](const std::string& piece, int times) {
    std::string out;
    for (int i = 0; i < times; ++i) out += piece;
    return out;
  };
  CHECK(problemOf(base + std::string(120, 'x') + "\"}") == Problem::None);
  CHECK(problemOf(base + std::string(121, 'x') + "\"}") == Problem::InvalidField);
  CHECK(problemOf(base + repeat("\xc3\xa9", 120) + "\"}") == Problem::None);  // é: 2 bytes, 1 code point
  CHECK(problemOf(base + repeat("\xc3\xa9", 121) + "\"}") == Problem::InvalidField);
  const std::string emoji = "\xf0\x9f\x99\x82";  // 4 bytes, 2 UTF-16 units, 1 code point
  CHECK(problemOf(base + repeat(emoji, 60) + "x\"}") == Problem::None);
  CHECK(problemOf(base + repeat(emoji, 120) + "\"}") == Problem::None);
  CHECK(problemOf(base + repeat(emoji, 121) + "\"}") == Problem::InvalidField);
  CHECK(problemOf(base + repeat("\\u0041", 120) + "\"}") == Problem::None);
  CHECK(problemOf(base + repeat("\\u0041", 120) + "\\n\"}") == Problem::InvalidField);
  // Escaped pairs count once; lone surrogates count one each, paired or not with what follows.
  CHECK(problemOf(base + repeat("\\ud83d\\ude42", 70) + std::string(50, 'x') + "\"}") == Problem::None);
  CHECK(problemOf(base + repeat("\\ud83d\\ude42", 70) + std::string(51, 'x') + "\"}") == Problem::InvalidField);
  CHECK(problemOf(base + repeat("\\ud83d", 120) + "\"}") == Problem::None);
  CHECK(problemOf(base + repeat("\\ud83d", 121) + "\"}") == Problem::InvalidField);
  CHECK(problemOf(base + repeat("\\ude42", 120) + "\"}") == Problem::None);
  CHECK(problemOf(base + repeat("\\ude42", 121) + "\"}") == Problem::InvalidField);
  // "low, high" repeated: each high pairs with the next repeat's low, so 60 repeats are 61 code points.
  CHECK(problemOf(base + repeat("\\ude42\\ud83d", 60) + "x\"}") == Problem::None);
  CHECK(problemOf(base + "\\ud83d" + repeat(emoji, 119) + "\"}") == Problem::None);  // a lone high, then pairs: 120
  CHECK(problemOf(base + "\\ud83d" + repeat(emoji, 120) + "\"}") == Problem::InvalidField);
}

void test_R12_size_limit() {
  // 1,023 bytes before the '\n' is the longest line: padded with spaces, still valid.
  std::string longest = kGoodHaptic;
  longest.insert(1, kMaxLineBytes - 1 - kGoodHaptic.size(), ' ');
  CHECK(longest.size() == kMaxLineBytes - 1);
  CHECK(problemOf(longest) == Problem::None);
  std::string tooLong = longest;
  tooLong.insert(1, " ");
  CHECK(problemOf(tooLong) == Problem::Oversize);
  CHECK(problemOf(std::string(5000, 'x')) == Problem::Oversize);
}

void test_R12_line_reader_framing() {
  LineReader reader;
  std::vector<std::string> lines;
  int oversize = 0;
  auto feed = [&](const std::string& bytes) {
    for (char c : bytes) {
      switch (reader.push(static_cast<uint8_t>(c))) {
        case LineReader::Event::Line:
          lines.emplace_back(reader.line(), reader.length());
          break;
        case LineReader::Event::Oversize:
          ++oversize;
          break;
        case LineReader::Event::None:
          break;
      }
    }
  };
  feed(std::string(kMaxLineBytes - 1, 'a') + "\n");
  CHECK(lines.size() == 1 && lines[0].size() == kMaxLineBytes - 1 && oversize == 0);
  feed(std::string(kMaxLineBytes, 'b') + std::string(3000, 'c') + "\nnext\n");
  CHECK(oversize == 1);
  CHECK(lines.size() == 2 && lines[1] == "next");
  feed("\n");
  CHECK(lines.size() == 3 && lines[2].empty());
  // Split across reads.
  feed("{\"v\":");
  feed("1}\n");
  CHECK(lines.size() == 4 && lines[3] == "{\"v\":1}");
}

void test_R13_blank_and_crlf() {
  CHECK(isBlankLine("", 0));
  CHECK(isBlankLine(" \t\r", 3));
  CHECK(!isBlankLine(" x", 2));
  CHECK(problemOf(kGoodHaptic + "\r") == Problem::None);
  CHECK(problemOf("\t " + kGoodHaptic + " \r") == Problem::None);
}

void test_R14_json_details() {
  // Escapes in keys and values are decoded before matching, as JSON.parse does.
  const PiLine escaped = parse(
      "{\"\\u0076\":1,\"t\\u0079pe\":\"haptic\\u002eplay\",\"module_id\":\"hand\\u002dleft-01\",\"seq\":3,"
      "\"request_id\":\"cue\\u002d1\",\"pattern\":\"near\\u005fobstacle\",\"duration_ms\":400}");
  CHECK(escaped.problem == Problem::None);
  CHECK_STR(escaped.module_id, "hand-left-01");
  CHECK_STR(escaped.request_id, "cue-1");
  CHECK(problemOf(haptic("\"request_id\":\"cue\\/1\",\"pattern\":\"error\",\"duration_ms\":400")) ==
        Problem::InvalidField);
  // Numbers as JSON.parse reads them.
  CHECK(parse(haptic("\"request_id\":\"c\",\"pattern\":\"error\",\"duration_ms\":4e2")).duration_ms == 400);
  CHECK(parse(haptic("\"request_id\":\"c\",\"pattern\":\"error\",\"duration_ms\":400.0")).duration_ms == 400);
  CHECK(parse(haptic("\"request_id\":\"c\",\"pattern\":\"error\",\"duration_ms\":4000E-1")).duration_ms == 400);
  CHECK(problemOf("{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":-0}") == Problem::None);
  CHECK(problemOf("{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":9007199254740991}") ==
        Problem::None);
  CHECK(problemOf("{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":9007199254740992}") ==
        Problem::InvalidField);
  CHECK(problemOf("{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":1e400}") == Problem::InvalidField);
  CHECK(problemOf("{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":1e-400}") == Problem::None);
  CHECK(problemOf("{\"v\":1e400,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":0}") ==
        Problem::UnsupportedVersion);
  // The last of a repeated key wins.
  CHECK(problemOf(haptic("\"request_id\":\"c\",\"pattern\":\"error\",\"pattern\":\"custom\",\"duration_ms\":400")) ==
        Problem::InvalidField);
  CHECK(problemOf(haptic("\"request_id\":\"c\",\"pattern\":\"custom\",\"pattern\":\"error\",\"duration_ms\":400")) ==
        Problem::None);
  // Nested values of unknown keys are checked as JSON, then refused as extra fields.
  CHECK(problemOf(haptic("\"request_id\":\"c\",\"pattern\":\"error\",\"duration_ms\":400,"
                         "\"x\":{\"a\":[1,{\"b\":null,\"c\":[]},\"s\\\"\"],\"d\":{}}")) == Problem::InvalidField);
  CHECK(problemOf(haptic("\"request_id\":\"c\",\"pattern\":\"error\",\"duration_ms\":400,\"\":0")) ==
        Problem::InvalidField);
  CHECK(problemOf(haptic("\"request_id\":\"c\",\"pattern\":\"error\",\"duration_ms\":400,\"__proto__\":{}")) ==
        Problem::InvalidField);
  // Deep nesting, as deep as a line allows, is still just JSON.
  const std::string open(480, '['), close(480, ']');
  CHECK(problemOf("{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":0,\"x\":" + open + close + "}") ==
        Problem::InvalidField);
  CHECK(problemOf("{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":0,\"x\":" + open + close.substr(1) +
                  "}") == Problem::Malformed);
  std::string objects;
  for (int i = 0; i < 150; ++i) objects += "{\"k\":";
  objects += "1" + std::string(150, '}');
  CHECK(problemOf("{\"v\":1,\"x\":" + objects + ",\"type\":\"error\"}") == Problem::InvalidField);
  // Mixed: an empty object at one depth doesn't confuse an array at the same depth later.
  CHECK(problemOf("{\"v\":1,\"x\":[{},[1],{\"a\":[]},[{}]],\"type\":\"error\"}") == Problem::InvalidField);
  CHECK(problemOf("{\"v\":1,\"x\":[{},[1],{\"a\":[]},[{}]}],\"type\":\"error\"}") == Problem::Malformed);
}

// A small fixed-seed generator, so every run scrambles the same way.
struct Random {
  uint32_t state;
  uint32_t next() {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return state;
  }
};

void test_R16_scrambled_lines_never_crash() {
  const std::string seeds[] = {
      kGoodHaptic,
      "{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":0}",
      "{\"v\":1,\"type\":\"error\",\"module_id\":\"hand-left-01\",\"seq\":77,\"code\":\"malformed\",\"detail\":\"x\"}",
      "{\"v\":1,\"type\":\"perception.zones\",\"module_id\":\"tof-front-01\",\"seq\":83,\"zones\":[{\"name\":\"a\"}]}",
  };
  Random random{0x5eed1234u};
  int counts[8] = {};
  for (int i = 0; i < 20000; ++i) {
    std::string line = seeds[random.next() % 4];
    const int edits = 1 + static_cast<int>(random.next() % 6);
    for (int e = 0; e < edits && !line.empty(); ++e) {
      const size_t at = random.next() % line.size();
      const char byte = static_cast<char>(random.next() % 256);
      switch (random.next() % 3) {
        case 0:
          line[at] = byte;
          break;
        case 1:
          line.insert(at, 1, byte);
          break;
        default:
          line.erase(at, 1 + random.next() % 4);
          break;
      }
    }
    // Copy into a buffer of exactly the line's size, so the sanitizer catches any read past the end.
    std::vector<char> exact(line.begin(), line.end());
    const PiLine first = parsePiLine(exact.data(), exact.size());
    const PiLine again = parsePiLine(exact.data(), exact.size());
    CHECK(first.problem == again.problem);
    CHECK(static_cast<int>(first.problem) <= static_cast<int>(Problem::Unsupported));
    ++counts[static_cast<int>(first.problem)];
  }
  // The scrambling reaches every code the parser can give, so this isn't testing only one path.
  for (Problem p : {Problem::None, Problem::Malformed, Problem::UnsupportedVersion, Problem::UnknownType,
                    Problem::InvalidField, Problem::Unsupported}) {
    CHECK(counts[static_cast<int>(p)] > 0);
  }
}

}  // namespace

int main() {
  TESTS_BEGIN();
  RUN(test_L1_hello_line);
  RUN(test_L2_heartbeat_line);
  RUN(test_B5_hand_input_line);
  RUN(test_Z1_zones_line);
  RUN(test_R1_ack_and_error_lines);
  RUN(test_L6_builders_refuse_what_the_contract_forbids);
  RUN(test_R1_valid_haptic_play);
  RUN(test_R2_bad_field_with_readable_request_id);
  RUN(test_R3_unreadable_request_id);
  RUN(test_R6_hello_request);
  RUN(test_R7_malformed);
  RUN(test_R8_version);
  RUN(test_R9_type);
  RUN(test_R10_types_only_modules_send);
  RUN(test_R11_error_lines_from_the_pi);
  RUN(test_R12_size_limit);
  RUN(test_R12_line_reader_framing);
  RUN(test_R13_blank_and_crlf);
  RUN(test_R14_json_details);
  RUN(test_R16_scrambled_lines_never_crash);
  TESTS_END();
}
