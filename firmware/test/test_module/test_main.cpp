// Native tests for lib/module: the module core (hello, heartbeat, seq, replies), the haptic cue on a
// fake clock, button debouncing and obstacle zones. Row ids refer to test/EXPECTED.md.
#include <cstring>
#include <string>
#include <vector>

#include "../support/expect.h"
#include "debounce.h"
#include "haptic.h"
#include "module_core.h"
#include "zone_names.h"
#include "zones.h"

using namespace walker;

#ifdef PIO_UNIT_TESTING
void setUp() {}
void tearDown() {}
#endif

namespace {

// Collects the lines a module writes. `refuse` makes the next writes fail, like a full serial buffer.
struct FakeOutput : LineOutput {
  std::vector<std::string> lines;
  int refuse = 0;
  bool writeLine(const char* data, size_t length) override {
    if (refuse > 0) {
      --refuse;
      return false;
    }
    lines.emplace_back(data, length);
    return true;
  }
  std::string last() const { return lines.empty() ? std::string() : lines.back(); }
  bool lastContains(const std::string& text) const { return last().find(text) != std::string::npos; }
};

// Records what the cue controller asks of the driver.
struct FakeHaptic : HapticOutput {
  std::vector<std::string> calls;
  bool done = false;
  void start(Pattern pattern) override {
    calls.push_back(std::string("start ") + patternName(pattern));
    done = false;
  }
  void stop() override { calls.push_back("stop"); }
  bool finished() override { return done; }
};

const char* kHandCaps[] = {"button.talk", "button.confirm", "haptic"};
const char* kHandCapsNoHaptic[] = {"button.talk", "button.confirm"};
const char* kTofCaps[] = {"zones"};
const ModuleIdentity kHand{"hand-left-01", ModuleType::Hand, "0.1.0", kHandCaps, 3};
const ModuleIdentity kHandNoHaptic{"hand-left-01", ModuleType::Hand, "0.1.0", kHandCapsNoHaptic, 2};
const ModuleIdentity kTof{"tof-front-01", ModuleType::Perception, "0.1.0", kTofCaps, 1};

void send(ModuleCore& core, const std::string& text, uint32_t now) {
  core.receive(reinterpret_cast<const uint8_t*>(text.data()), text.size(), now);
}

std::string seqOf(const std::string& line) {
  const size_t at = line.find("\"seq\":");
  return line.substr(at + 6, line.find(',', at) - at - 6);
}

std::string hapticPlay(const std::string& moduleId, const std::string& request, const std::string& pattern,
                       uint32_t ms) {
  return "{\"v\":1,\"type\":\"haptic.play\",\"module_id\":\"" + moduleId + "\",\"seq\":1,\"request_id\":\"" + request +
         "\",\"pattern\":\"" + pattern + "\",\"duration_ms\":" + std::to_string(ms) + "}\n";
}

// ---- Module core ----

void test_L1_hello_on_boot() {
  FakeOutput out;
  FakeHaptic driver;
  HapticController cue(driver);
  ModuleCore core(kHand, out, &cue);
  core.begin(0);
  CHECK(out.lines.size() == 1);
  CHECK_STR(out.last(),
            "{\"v\":1,\"type\":\"hello\",\"module_id\":\"hand-left-01\",\"seq\":0,\"module_type\":\"hand\","
            "\"capabilities\":[\"button.talk\",\"button.confirm\",\"haptic\"],\"firmware_version\":\"0.1.0\","
            "\"uptime_ms\":0}\n");
  // H6: the driver is stopped before anything else.
  CHECK(driver.calls.size() == 1 && driver.calls[0] == "stop");

  FakeOutput tofOut;
  ModuleCore tof(kTof, tofOut, nullptr);
  tof.begin(5);
  CHECK(tofOut.lastContains("\"module_type\":\"perception\",\"capabilities\":[\"zones\"]"));
}

void test_L2_heartbeat_every_second() {
  FakeOutput out;
  ModuleCore core(kTof, out, nullptr);
  core.begin(0);
  for (uint32_t t = 0; t <= 3500; ++t) core.poll(t);
  CHECK(out.lines.size() == 4);
  CHECK_STR(out.lines[1], "{\"v\":1,\"type\":\"heartbeat\",\"module_id\":\"tof-front-01\",\"seq\":1,\"uptime_ms\":1000,"
                          "\"health\":\"ok\"}\n");
  CHECK(out.lines[2].find("\"uptime_ms\":2000") != std::string::npos);
  CHECK(out.lines[3].find("\"uptime_ms\":3000") != std::string::npos);
  // A long stall gives one heartbeat, not a burst.
  core.poll(9000);
  core.poll(9001);
  CHECK(out.lines.size() == 5);
}

void test_L3_seq_runs_across_types_and_counts_dropped_lines() {
  FakeOutput out;
  ModuleCore core(kHand, out, nullptr);
  core.begin(0);
  core.sendButton("talk", Edge::Pressed, 10);
  out.refuse = 1;
  CHECK(!core.sendButton("talk", Edge::Released, 20));  // dropped, but it used seq 2
  core.sendButton("confirm", Edge::Pressed, 30);
  CHECK(out.lines.size() == 3);
  CHECK(seqOf(out.lines[0]) == "0");
  CHECK(seqOf(out.lines[1]) == "1");
  CHECK(seqOf(out.lines[2]) == "3");
  CHECK(core.nextSeq() == 4);
}

void test_L4_hello_request_answers_with_the_running_seq() {
  FakeOutput out;
  ModuleCore core(kHand, out, nullptr);
  core.begin(0);
  core.sendButton("talk", Edge::Pressed, 10);
  send(core, "{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":0}\n", 20);
  CHECK(out.lines.size() == 3);
  CHECK(out.lastContains("\"type\":\"hello\""));
  CHECK(seqOf(out.last()) == "2");
  send(core, "{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"hand-left-01\",\"seq\":1}\n", 30);
  CHECK(out.lastContains("\"type\":\"hello\"") && seqOf(out.last()) == "3");
  // R6: addressed to another module, or with an extra field.
  send(core, "{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"hand-right-01\",\"seq\":2}\n", 40);
  CHECK(out.lastContains("\"type\":\"error\"") && out.lastContains("\"code\":\"invalid_field\""));
  send(core, "{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":3,\"rate_hz\":20}\n", 50);
  CHECK(out.lastContains("\"code\":\"invalid_field\""));
  CHECK(out.lines.size() == 6);
}

void test_L6_unbuildable_line_is_never_sent() {
  FakeOutput out;
  ModuleCore core(kTof, out, nullptr);
  core.begin(0);
  const Zone bad[] = {{"Front", true, 100}};
  CHECK(!core.sendZones(bad, 1, 10));
  CHECK(out.lines.size() == 1);
  CHECK(core.nextSeq() == 1);  // no seq used
  core.poll(1000);
  CHECK_STR(out.last(), "{\"v\":1,\"type\":\"heartbeat\",\"module_id\":\"tof-front-01\",\"seq\":1,\"uptime_ms\":1000,"
                        "\"health\":\"degraded\",\"faults\":[\"line_not_built\"]}\n");
}

void test_L7_dropped_line_is_reported_once() {
  FakeOutput out;
  ModuleCore core(kTof, out, nullptr);
  core.begin(0);
  out.refuse = 1;
  const Zone zones[] = {{"left", true, 100}};
  CHECK(!core.sendZones(zones, 1, 10));
  core.poll(1000);
  CHECK(out.lastContains("\"health\":\"degraded\",\"faults\":[\"tx_dropped\"]"));
  core.poll(2000);
  CHECK(out.lastContains("\"health\":\"ok\"}"));
  // A heartbeat that is itself dropped keeps the fault for the next one.
  out.refuse = 2;
  core.sendZones(zones, 1, 2100);
  core.poll(3000);
  core.poll(4000);
  CHECK(out.lastContains("\"faults\":[\"tx_dropped\"]") && out.lastContains("\"uptime_ms\":4000"));
}

void test_R1_to_R5_haptic_commands() {
  FakeOutput out;
  FakeHaptic driver;
  HapticController cue(driver);
  ModuleCore core(kHand, out, &cue);
  core.begin(0);
  send(core, hapticPlay("hand-left-01", "cue-1", "near_obstacle", 400), 10);
  CHECK_STR(out.last(), "{\"v\":1,\"type\":\"ack\",\"module_id\":\"hand-left-01\",\"seq\":1,\"request_id\":\"cue-1\","
                        "\"result\":\"accepted\",\"uptime_ms\":10}\n");
  CHECK(cue.active() && cue.pattern() == Pattern::NearObstacle);
  // R2: a bad field with a readable request_id is rejected against it, and the playing cue carries on.
  send(core, hapticPlay("hand-left-01", "cue-2", "custom", 400), 20);
  CHECK(out.lastContains("\"request_id\":\"cue-2\",\"result\":\"rejected\",\"reason\":\"invalid_field\""));
  send(core, hapticPlay("hand-left-01", "cue-3", "error", 1001), 30);
  CHECK(out.lastContains("\"request_id\":\"cue-3\",\"result\":\"rejected\",\"reason\":\"invalid_field\""));
  CHECK(cue.active() && cue.pattern() == Pattern::NearObstacle);
  // R3: no readable request_id, so an error instead of an ack.
  send(core, hapticPlay("hand-left-01", "cue 4", "error", 400), 40);
  CHECK(out.lastContains("\"type\":\"error\"") && out.lastContains("\"code\":\"invalid_field\""));
  // R4: addressed to another module or to "any".
  send(core, hapticPlay("hand-right-01", "cue-5", "error", 400), 50);
  CHECK(out.lastContains("\"request_id\":\"cue-5\",\"result\":\"rejected\",\"reason\":\"invalid_field\""));
  send(core, hapticPlay("any", "cue-6", "error", 400), 60);
  CHECK(out.lastContains("\"request_id\":\"cue-6\",\"result\":\"rejected\",\"reason\":\"invalid_field\""));
  CHECK(cue.active() && cue.pattern() == Pattern::NearObstacle);
  CHECK(driver.calls.size() == 2);  // stop at boot, start cue-1: nothing else touched the driver

  // R5: a module with no haptic driver.
  FakeOutput tofOut;
  ModuleCore tof(kTof, tofOut, nullptr);
  tof.begin(0);
  send(tof, hapticPlay("tof-front-01", "cue-7", "error", 400), 10);
  CHECK(tofOut.lastContains("\"request_id\":\"cue-7\",\"result\":\"rejected\",\"reason\":\"unsupported\""));
  FakeOutput handOut;
  ModuleCore noDriver(kHandNoHaptic, handOut, nullptr);
  noDriver.begin(0);
  CHECK(handOut.lastContains("\"capabilities\":[\"button.talk\",\"button.confirm\"]"));
  send(noDriver, hapticPlay("hand-left-01", "cue-8", "error", 400), 10);
  CHECK(handOut.lastContains("\"request_id\":\"cue-8\",\"result\":\"rejected\",\"reason\":\"unsupported\""));
}

void test_R7_to_R13_replies() {
  FakeOutput out;
  ModuleCore core(kHand, out, nullptr);
  core.begin(0);
  const struct {
    const char* line;
    const char* code;
  } cases[] = {
      {"not json\n", "malformed"},
      {"[1,2,3]\n", "malformed"},
      {"{\"v\":2,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":0}\n", "unsupported_version"},
      {"{\"v\":1,\"type\":\"motor.move\",\"module_id\":\"hand-left-01\",\"seq\":1,\"angle\":90}\n", "unknown_type"},
      {"{\"v\":1,\"type\":\"heartbeat\",\"module_id\":\"tof-front-01\",\"seq\":84,\"uptime_ms\":1,\"health\":\"ok\"}\n",
       "unsupported"},
      {"{\"v\":1,\"type\":\"error\",\"module_id\":\"hand-left-01\",\"seq\":77,\"code\":\"bad\"}\n", "invalid_field"},
  };
  for (const auto& c : cases) {
    const size_t before = out.lines.size();
    send(core, c.line, 10);
    CHECK(out.lines.size() == before + 1);
    CHECK(out.lastContains("\"type\":\"error\""));
    CHECK(out.lastContains(std::string("\"code\":\"") + c.code + "\""));
  }
  const size_t before = out.lines.size();
  // R11: a valid error line from the Pi gets no reply. R13: blank lines neither.
  send(core, "{\"v\":1,\"type\":\"error\",\"module_id\":\"hand-left-01\",\"seq\":77,\"code\":\"malformed\"}\n", 20);
  send(core, "\n \r\n\t\n", 20);
  CHECK(out.lines.size() == before);
  // R13: \r\n reads like \n.
  send(core, "{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":0}\r\n", 30);
  CHECK(out.lines.size() == before + 1 && out.lastContains("\"type\":\"hello\""));
  // R12: an oversize line gets one error, and the next line is read normally.
  send(core, std::string(3000, 'x') + "\n{\"v\":1,\"type\":\"hello.request\",\"module_id\":\"any\",\"seq\":0}\n", 40);
  CHECK(out.lines.size() == before + 3);
  CHECK(out.lines[before + 1].find("\"code\":\"oversize\"") != std::string::npos);
  CHECK(out.lastContains("\"type\":\"hello\""));
  // R7: bytes that aren't UTF-8.
  send(core, "{\"v\":1,\"a\":\"\xff\"}\n", 50);
  CHECK(out.lastContains("\"code\":\"malformed\""));
}

// ---- Haptic cue ----

void test_H1_cue_stops_at_its_duration() {
  FakeHaptic driver;
  HapticController cue(driver);
  cue.begin(0);
  CHECK(cue.play(Pattern::NearObstacle, 400, 0));
  CHECK(driver.calls.back() == "start near_obstacle");
  for (uint32_t t = 1; t < 400; ++t) cue.poll(t);
  CHECK(cue.active());
  cue.poll(400);
  CHECK(!cue.active() && cue.lastStop() == HapticController::StopReason::Duration);
  CHECK(driver.calls.back() == "stop");
}

void test_H2_sequence_repeats_until_the_duration_ends() {
  FakeHaptic driver;
  HapticController cue(driver);
  cue.begin(0);
  cue.play(Pattern::Confirmation, 1000, 0);
  size_t starts = 1;
  for (uint32_t t = 1; t <= 1200; ++t) {
    if (t % 300 == 0) driver.done = true;  // the sequence finishes every 300 ms
    const size_t before = driver.calls.size();
    cue.poll(t);
    if (driver.calls.size() > before && driver.calls.back() == "start confirmation") {
      ++starts;
      CHECK(t < 1000);
    }
  }
  CHECK(starts == 4);  // 0, 300, 600, 900
  CHECK(!cue.active() && driver.calls.back() == "stop");
}

void test_H3_newer_cue_replaces_the_one_playing() {
  FakeHaptic driver;
  HapticController cue(driver);
  cue.begin(0);
  cue.play(Pattern::Recording, 1000, 0);
  for (uint32_t t = 1; t < 200; ++t) cue.poll(t);
  CHECK(cue.play(Pattern::Error, 300, 200));
  CHECK(cue.lastStop() == HapticController::StopReason::Replaced);
  CHECK(driver.calls.back() == "start error");
  for (uint32_t t = 201; t < 500; ++t) cue.poll(t);
  CHECK(cue.active() && cue.pattern() == Pattern::Error);
  cue.poll(500);
  CHECK(!cue.active());
  const size_t calls = driver.calls.size();
  for (uint32_t t = 501; t <= 1100; ++t) cue.poll(t);
  CHECK(driver.calls.size() == calls);  // nothing happens at A's old end
}

void test_H4_out_of_range_durations_are_refused() {
  FakeHaptic driver;
  HapticController cue(driver);
  cue.begin(0);
  CHECK(!cue.play(Pattern::Error, 0, 0));
  CHECK(!cue.play(Pattern::Error, kHapticMaxDurationMs + 1, 0));
  CHECK(!cue.active() && driver.calls.size() == 1);
  CHECK(cue.play(Pattern::Error, kHapticMaxDurationMs, 0));
}

void test_H5_cue_stops_when_the_pi_goes_quiet() {
  // With the duration limit raised for this test only, the silence timer is what ends the cue.
  FakeHaptic driver;
  HapticController cue(driver, 10000);
  cue.begin(0);
  cue.play(Pattern::NearObstacle, 10000, 0);
  for (uint32_t t = 1; t < 4000; ++t) {
    if (t == 1000) cue.heardFromPi(t);  // the last line from the Pi
    cue.poll(t);
  }
  CHECK(cue.active());
  cue.poll(4000);
  CHECK(!cue.active() && cue.lastStop() == HapticController::StopReason::PiSilent);

  // With the real limits, the duration always ends a cue first.
  FakeHaptic realDriver;
  HapticController real(realDriver);
  real.begin(0);
  real.play(Pattern::NearObstacle, kHapticMaxDurationMs, 0);
  for (uint32_t t = 1; t <= kHapticMaxDurationMs; ++t) real.poll(t);
  CHECK(!real.active() && real.lastStop() == HapticController::StopReason::Duration);
  CHECK(kHapticMaxDurationMs < kPiSilenceTimeoutMs);
}

void test_H7_millisecond_clock_wraps() {
  FakeHaptic driver;
  HapticController cue(driver);
  const uint32_t start = 0xFFFFFF00u;
  cue.begin(start);
  cue.play(Pattern::NearObstacle, 400, start);
  cue.poll(start + 399);  // wraps past zero
  CHECK(cue.active());
  cue.poll(start + 400);
  CHECK(!cue.active() && cue.lastStop() == HapticController::StopReason::Duration);
}

void test_H8_each_pattern_is_a_finite_sequence() {
  const HapticSequence& strongBuzz = sequenceFor(Pattern::NearObstacle);
  CHECK(strongBuzz.steps[0] == 14 && strongBuzz.steps[1] == 0);
  for (size_t p = 0; p < kPatternCount; ++p) {
    const HapticSequence& sequence = sequenceFor(static_cast<Pattern>(p));
    bool ended = false;
    int effects = 0;
    for (uint8_t step : sequence.steps) {
      if (step == 0) {
        ended = true;
        break;
      }
      if (step & 0x80) continue;  // a pause
      CHECK(step >= 1 && step <= 123);
      ++effects;
    }
    CHECK(ended && effects >= 1);
  }
}

// ---- Buttons ----

void test_B1_B3_debounced_press_and_release() {
  Debouncer button;
  uint32_t t = 0;
  for (; t < 50; ++t) CHECK(button.update(false, t) == Debouncer::Result::None);
  Debouncer::Result result = Debouncer::Result::None;
  uint32_t pressedAt = 0;
  for (; t < 100; ++t) {
    result = button.update(true, t);
    if (result != Debouncer::Result::None) {
      CHECK(result == Debouncer::Result::Pressed);
      pressedAt = t;
    }
  }
  CHECK(pressedAt == 70);  // pressed at 50, held 20 ms
  uint32_t releasedAt = 0;
  for (; t < 150; ++t) {
    result = button.update(false, t);
    if (result != Debouncer::Result::None) {
      CHECK(result == Debouncer::Result::Released);
      releasedAt = t;
    }
  }
  CHECK(releasedAt == 120);
}

void test_B2_contact_bounce_gives_one_edge() {
  Debouncer button;
  for (uint32_t t = 0; t < 30; ++t) button.update(false, t);
  // The level flips at 30 (pressed), 33, 35, 37 and 38, then stays pressed.
  int edges = 0;
  uint32_t at = 0;
  for (uint32_t t = 30; t < 100; ++t) {
    const bool pressed = !(t >= 33 && t < 35) && t != 37;
    if (button.update(pressed, t) != Debouncer::Result::None) {
      ++edges;
      at = t;
    }
  }
  CHECK(edges == 1);
  CHECK(at == 58);  // 20 ms after the last flip at 38
}

void test_B2_short_release_during_hold_is_ignored() {
  Debouncer button(20, 250);
  for (uint32_t t = 0; t < 50; ++t) CHECK(button.update(false, t) == Debouncer::Result::None);
  int presses = 0;
  int releases = 0;
  for (uint32_t t = 50; t < 800; ++t) {
    // Two open-contact gaps while the user is still holding the button.
    const bool pressed = !(t >= 200 && t < 320) && !(t >= 400 && t < 570);
    const auto edge = button.update(pressed, t);
    if (edge == Debouncer::Result::Pressed) ++presses;
    if (edge == Debouncer::Result::Released) ++releases;
  }
  CHECK(presses == 1);
  CHECK(releases == 0);
  for (uint32_t t = 800; t <= 1050; ++t) {
    const auto edge = button.update(false, t);
    if (edge == Debouncer::Result::Released) ++releases;
  }
  CHECK(releases == 1);
}

void test_B4_button_held_at_boot_is_ignored_until_released() {
  Debouncer button;
  for (uint32_t t = 0; t < 500; ++t) CHECK(button.update(true, t) == Debouncer::Result::None);
  for (uint32_t t = 500; t < 600; ++t) CHECK(button.update(false, t) == Debouncer::Result::None);
  int presses = 0;
  for (uint32_t t = 600; t < 700; ++t) {
    if (button.update(true, t) == Debouncer::Result::Pressed) ++presses;
  }
  CHECK(presses == 1);
}

void test_B5_button_lines() {
  FakeOutput out;
  ModuleCore core(kHand, out, nullptr);
  core.begin(0);
  core.sendButton("talk", Edge::Pressed, 70);
  CHECK_STR(out.last(), "{\"v\":1,\"type\":\"hand.input\",\"module_id\":\"hand-left-01\",\"seq\":1,\"uptime_ms\":70,"
                        "\"button\":\"talk\",\"edge\":\"pressed\"}\n");
  core.sendButton("confirm", Edge::Released, 90);
  CHECK(out.lastContains("\"button\":\"confirm\",\"edge\":\"released\""));
}

// ---- Obstacle zones ----

void test_Z1_to_Z3_range_status() {
  CHECK(isValidRange(0, 0));
  CHECK(isValidRange(0, 4000));
  CHECK(!isValidRange(0, 4001));
  CHECK(isValidRange(3, 20));  // Z2: target closer than the minimum
  for (uint8_t status : {1, 2, 4, 5, 6, 7, 9, 10, 13, 255}) CHECK(!isValidRange(status, 500));
}

void test_Z4_missing_failed_and_stale_sensors_read_invalid() {
  const char* names[] = {"front_left", "front_right", "left", "right"};
  ZoneTracker tracker(names, 4);
  tracker.begin(0);
  tracker.setPresent(0, true);
  tracker.setPresent(1, true);
  tracker.setPresent(2, true);
  tracker.setPresent(3, false);  // never answered
  tracker.reading(0, 0, 610, 100);
  tracker.reading(1, 2, 610, 100);  // signal fail
  tracker.reading(2, 0, 300, 100);
  tracker.readFailed(2);  // the last transfer failed
  Zone zones[4];
  CHECK(tracker.snapshot(120, zones) == 4);
  CHECK(zones[0].valid && zones[0].mm == 610 && std::strcmp(zones[0].name, "front_left") == 0);
  CHECK(!zones[1].valid && !zones[2].valid && !zones[3].valid);
  CHECK(tracker.anyMissing() && !tracker.allMissing() && tracker.anyError(120));
  // Stale after 250 ms without a new result.
  tracker.snapshot(350, zones);
  CHECK(zones[0].valid);
  tracker.snapshot(351, zones);
  CHECK(!zones[0].valid);
}

void test_Z5_report_rate() {
  const char* names[] = {"front_left"};
  ZoneTracker tracker(names, 1);
  tracker.begin(0);
  std::vector<uint32_t> due;
  for (uint32_t t = 0; t <= 1000; ++t) {
    if (tracker.reportDue(t)) due.push_back(t);
  }
  CHECK(due.size() == 12 && due.front() == 80 && due.back() == 960);
  const double hz = 1000.0 / kZoneReportIntervalMs;
  CHECK(hz >= 10 && hz <= 20);
}

void test_Z6_default_zone_names() {
  CHECK(kZoneCount == 4);
  CHECK_STR(kZoneNames[0], "front_left");
  CHECK_STR(kZoneNames[1], "front_right");
  CHECK_STR(kZoneNames[2], "left");
  CHECK_STR(kZoneNames[3], "right");
  const char* repeated[] = {"left", "left"};
  CHECK(!zoneNamesValid(repeated, 2));
  const char* upper[] = {"Left"};
  CHECK(!zoneNamesValid(upper, 1));
}

void test_Z7_health() {
  const char* names[] = {"front_left", "front_right"};
  ZoneTracker tracker(names, 2);
  tracker.begin(0);
  CHECK(tracker.allMissing());
  tracker.setPresent(0, true);
  tracker.reading(0, 0, 500, 10);
  CHECK(tracker.anyMissing() && !tracker.allMissing() && !tracker.anyError(20));
  tracker.setPresent(1, true);
  tracker.reading(1, 0, 500, 10);
  CHECK(!tracker.anyMissing() && !tracker.anyError(20));
  CHECK(tracker.anyError(300));  // stale

  FakeOutput out;
  ModuleCore core(kTof, out, nullptr);
  core.begin(0);
  core.setFault(Fault::SensorMissing, true);
  core.setCritical(true);
  core.poll(1000);
  CHECK(out.lastContains("\"health\":\"fault\",\"faults\":[\"sensor_missing\"]"));
  core.setCritical(false);
  core.setFault(Fault::SensorError, true);
  core.poll(2000);
  CHECK(out.lastContains("\"health\":\"degraded\",\"faults\":[\"sensor_missing\",\"sensor_error\"]"));
}

}  // namespace

int main() {
  TESTS_BEGIN();
  RUN(test_L1_hello_on_boot);
  RUN(test_L2_heartbeat_every_second);
  RUN(test_L3_seq_runs_across_types_and_counts_dropped_lines);
  RUN(test_L4_hello_request_answers_with_the_running_seq);
  RUN(test_L6_unbuildable_line_is_never_sent);
  RUN(test_L7_dropped_line_is_reported_once);
  RUN(test_R1_to_R5_haptic_commands);
  RUN(test_R7_to_R13_replies);
  RUN(test_H1_cue_stops_at_its_duration);
  RUN(test_H2_sequence_repeats_until_the_duration_ends);
  RUN(test_H3_newer_cue_replaces_the_one_playing);
  RUN(test_H4_out_of_range_durations_are_refused);
  RUN(test_H5_cue_stops_when_the_pi_goes_quiet);
  RUN(test_H7_millisecond_clock_wraps);
  RUN(test_H8_each_pattern_is_a_finite_sequence);
  RUN(test_B1_B3_debounced_press_and_release);
  RUN(test_B2_contact_bounce_gives_one_edge);
  RUN(test_B2_short_release_during_hold_is_ignored);
  RUN(test_B4_button_held_at_boot_is_ignored_until_released);
  RUN(test_B5_button_lines);
  RUN(test_Z1_to_Z3_range_status);
  RUN(test_Z4_missing_failed_and_stale_sensors_read_invalid);
  RUN(test_Z5_report_rate);
  RUN(test_Z6_default_zone_names);
  RUN(test_Z7_health);
  TESTS_END();
}
