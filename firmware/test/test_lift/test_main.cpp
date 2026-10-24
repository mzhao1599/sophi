// Native tests for the lift: step math (lib/lift/lift_motion.h), the lift's serial lines
// (lib/protocol/lift_protocol.*) and its behaviour (lib/lift/lift_core.*) on a simulated stepper.
// Row ids (LS1, LC3, LH1, ...) refer to test/EXPECTED.md, "Lift board"; "rule N" to the header of
// packages/contracts/src/lift-serial.ts.
#include <cstdio>
#include <string>
#include <vector>

#include "../support/expect.h"
#include "../support/lift_rig.h"
#include "lift_motion.h"
#include "lift_protocol.h"

using namespace walker;
using namespace walker::lift;
using walker::sim::has;
using walker::sim::LiftRig;

#ifdef PIO_UNIT_TESTING
void setUp() {}
void tearDown() {}
#endif

namespace {

LiftPiLine parse(const std::string& line) { return parseLiftPiLine(line.data(), line.size()); }
Problem problemOf(const std::string& line) { return parse(line).problem; }

std::vector<std::string> ofType(const LiftRig& rig, size_t from, const std::string& type) {
  std::vector<std::string> result;
  for (const std::string& line : rig.since(from)) {
    if (has(line, "\"type\":\"" + type + "\"")) result.push_back(line);
  }
  return result;
}

std::string lastOfType(const LiftRig& rig, const std::string& type) {
  for (auto it = rig.out.lines.rbegin(); it != rig.out.lines.rend(); ++it) {
    if (has(*it, "\"type\":\"" + type + "\"")) return *it;
  }
  return "";
}

std::string find(const LiftRig& rig, size_t from, const std::string& type, const std::string& requestId) {
  for (const std::string& line : ofType(rig, from, type)) {
    if (has(line, "\"request_id\":\"" + requestId + "\"")) return line;
  }
  return "";
}
std::string ackFor(const LiftRig& rig, size_t from, const std::string& id) { return find(rig, from, "lift.ack", id); }
std::string doneFor(const LiftRig& rig, size_t from, const std::string& id) { return find(rig, from, "lift.done", id); }

bool accepted(const std::string& ack) { return has(ack, "\"result\":\"accepted\""); }
bool rejected(const std::string& ack, const std::string& reason) {
  return has(ack, "\"result\":\"rejected\",\"reason\":\"" + reason + "\"");
}

// A build made disable-safe (WALKER_LIFT_DISABLE_SAFE=1, after a passed drop test).
LiftSettings disableSafe() {
  LiftSettings settings = sim::kDefaultSettings;
  settings.disable_safe = true;
  return settings;
}

// Boots with heartbeats on and homes (held throughout); returns with the lift idle at 5 mm.
void bootAndHome(LiftRig& rig) {
  rig.boot();
  rig.heartbeats = true;
  rig.run(100);
  rig.held("lift.home", "t00017-1");
  rig.runUntil([&] { return rig.core.state() != LiftState::Homing; }, 200000);
  rig.release();
}

// ---- Step math (LM1 to LM5) ----

void test_LM1_steps_per_mm() {
  CHECK(stepsPerMm(1) == 40);
  CHECK(stepsPerMm(8) == 320);
  CHECK(stepsPerMm(32) == 1280);
  CHECK(isMicrostepSetting(8) && !isMicrostepSetting(3) && !isMicrostepSetting(64) && !isMicrostepSetting(0));
}

void test_LM2_mm_and_steps() {
  CHECK(milliMmToSteps(600000, 8) == 192000);
  CHECK(milliMmToSteps(5000, 8) == 1600);
  CHECK(milliMmToSteps(1, 8) == 0);
  CHECK(milliMmToSteps(2, 8) == 1);
  CHECK(milliMmToSteps(-5000, 8) == -1600);
  CHECK(stepsToMilliMm(1, 8) == 3);
  CHECK(stepsToMilliMm(192000, 8) == 600000);
  CHECK(stepsToMilliMm(38880, 8) == 121500);
  CHECK(stepsToMilliMm(1, 32) == 1);
  CHECK(stepsToMilliMm(2, 1) == 50);
}

void test_LM3_rates() {
  CHECK(milliToStepRate(20000, 8) == 6400);
  CHECK(milliToStepRate(50000, 8) == 16000);
  CHECK(milliToStepRate(200000, 8) == 64000);
  CHECK(milliToStepRate(kHomingFastMilliMmS, 8) == 4800);
  CHECK(milliToStepRate(kHomingSlowMilliMmS, 8) == 640);
}

void test_LM4_stopping_distance_and_settings() {
  CHECK(stoppingSteps(6400, 64000) == 320);
  CHECK(stoppingSteps(6400, 16000) == 1280);
  CHECK(stoppingSteps(0, 16000) == 0);
  sim::SimStepper s(0);
  s.setDriverEnabled(true);
  s.moveTo(1000000, 6400, 16000);
  for (int i = 0; i < 2000 && s.peakSpeed < 6400 * 1000; ++i) s.tick();
  const int32_t at = s.position();
  s.decelerate(64000);
  while (s.running()) s.tick();
  const int32_t travelled = s.position() - at;
  CHECK(travelled >= 319 && travelled <= 321);
  // LL5
  CHECK(settingsValid(sim::kDefaultSettings));
  LiftSettings bad = sim::kDefaultSettings;
  bad.max_speed_milli_mm_s = 50001;
  CHECK(!settingsValid(bad));
  bad = sim::kDefaultSettings;
  bad.soft_min_milli_mm = 6000;  // above home
  CHECK(!settingsValid(bad));
  bad = sim::kDefaultSettings;
  bad.microsteps = 3;
  CHECK(!settingsValid(bad));
  bad = sim::kDefaultSettings;
  bad.max_accel_milli_mm_s2 = 200001;
  CHECK(!settingsValid(bad));
  bad = sim::kDefaultSettings;
  bad.has_top_switch = true;
  bad.top_switch_milli_mm = 500000;  // below the soft maximum
  CHECK(!settingsValid(bad));
}

void test_LM5_simulated_move_respects_its_ramp() {
  sim::SimStepper s(0);
  s.setDriverEnabled(true);
  CHECK(s.moveTo(64000, 6400, 16000));
  while (s.running()) s.tick();
  CHECK(s.position() == 64000 && s.physicalSteps() == 64000);
  CHECK(s.peakSpeed <= 6400 * 1000);
  CHECK(s.lastAccel <= 16000);
  CHECK(s.moveTo(63000, 6400, 16000));
  while (s.running()) s.tick();
  CHECK(s.position() == 63000);
  CHECK(s.peakSpeed < 6400 * 1000);
  // A driver that is off ignores the pulses: the count moves, the carriage doesn't.
  s.setDriverEnabled(false);
  CHECK(s.moveTo(64000, 6400, 16000));
  while (s.running()) s.tick();
  CHECK(s.position() == 64000 && s.physicalSteps() == 63000);
}

// ---- Boot and lines (LS1 to LS5) ----

void test_LS1_boot() {
  LiftRig rig;
  rig.boot();
  CHECK(rig.out.lines.size() == 2);
  CHECK_STR(rig.out.lines[0],
            R"({"v":1,"type":"lift.hello","module_id":"lift-01","seq":0,"firmware_version":"0.1.0","uptime_ms":0,)"
            R"("config":{"microsteps":8,"soft_min_mm":5,"soft_max_mm":600,"max_speed_mm_s":20,"max_accel_mm_s2":50,)"
            R"("top_switch_mm":null},"stop_sense":"wired"})");
  CHECK_STR(rig.out.lines[1],
            R"({"v":1,"type":"lift.status","module_id":"lift-01","seq":1,"uptime_ms":0,"state":"unhomed","homed":false,)"
            R"("position_mm":null,"target_mm":null,"driver_enabled":true,"limits":{"top":"released","bottom":"released"},"stop_sense":"released",)"
            R"("faults":[],"request_id":null,"heartbeat_age_ms":null})");
  CHECK(rig.stepper.enabled() && rig.core.driverEnabled());
  CHECK(rig.core.state() == LiftState::Unhomed && !rig.stepper.running());
  // An unplugged harness latches limit_wiring straight after.
  LiftRig unplugged;
  unplugged.forceBottom = unplugged.forceTop = true;
  unplugged.boot();
  CHECK(unplugged.out.lines.size() == 3);
  CHECK(has(unplugged.out.lines[1], R"("faults":[])"));
  CHECK(has(unplugged.out.lines[2], R"("state":"fault")") && has(unplugged.out.lines[2], R"("faults":["limit_wiring"])"));
}

void test_LS2_status_rate_and_changes() {
  LiftRig rig(0);  // on the bottom switch, where a disable is allowed
  rig.boot();
  const size_t from = rig.out.lines.size();
  rig.run(200);
  const std::vector<std::string> statuses = ofType(rig, from, "lift.status");
  CHECK(statuses.size() == 4);
  CHECK(has(statuses[0], "\"uptime_ms\":50,") && has(statuses[3], "\"uptime_ms\":200,"));
  rig.run(10);
  const size_t mark = rig.out.lines.size();
  rig.send(rig.command("lift.enable", "t00036-1", R"(,"enabled":false)"));
  const std::vector<std::string> after = rig.since(mark);
  CHECK(after.size() == 2);
  CHECK(has(after[0], "\"type\":\"lift.ack\""));
  CHECK(has(after[1], "\"uptime_ms\":210,") && has(after[1], "\"driver_enabled\":false"));
  rig.run(49);
  CHECK(rig.out.lines.size() == mark + 2);
  rig.run(1);
  CHECK(has(rig.out.lines.back(), "\"uptime_ms\":260,"));
}

void test_LS3_seq_and_hello_request() {
  LiftRig rig;
  rig.boot();
  rig.run(60);
  rig.send(R"({"v":1,"type":"hello.request","module_id":"any","seq":0})");
  const std::string hello = rig.out.lines.back();
  CHECK(has(hello, "\"type\":\"lift.hello\"") && has(hello, "\"seq\":3,") && has(hello, "\"uptime_ms\":60,"));
  rig.send(R"({"v":1,"type":"hello.request","module_id":"lift-01","seq":1})");
  CHECK(has(rig.out.lines.back(), "\"type\":\"lift.hello\"") && has(rig.out.lines.back(), "\"seq\":4,"));
  for (size_t i = 0; i < rig.out.lines.size(); ++i) CHECK(has(rig.out.lines[i], "\"seq\":" + std::to_string(i) + ","));
  rig.send(R"({"v":1,"type":"hello.request","module_id":"lift-02","seq":2})");
  CHECK(has(rig.out.lines.back(), R"("type":"error")") && has(rig.out.lines.back(), R"("code":"invalid_field")"));
  rig.send(R"({"v":1,"type":"hello.request","module_id":"any","seq":3,"rate_hz":20})");
  CHECK(has(rig.out.lines.back(), R"("code":"invalid_field")"));
}

void test_LS5_builders() {
  char out[kMaxLineBytes];
  LiftStatusLine s{};
  s.state = LiftState::Moving;
  s.homed = true;
  s.position_milli_mm = 121500;
  s.has_target = true;
  s.target_milli_mm = 250000;
  s.stop_sense = StopSense::Released;
  s.driver_enabled = true;
  s.request_id = "t00018-1";
  s.has_heartbeat = true;
  s.heartbeat_age_ms = 60;
  s.uptime_ms = 34000;
  CHECK_STR(std::string(out, buildLiftStatus(out, sizeof out, "lift-01", 260, s)),
            R"({"v":1,"type":"lift.status","module_id":"lift-01","seq":260,"uptime_ms":34000,"state":"moving","homed":true,)"
            R"("position_mm":121.5,"target_mm":250,"driver_enabled":true,"limits":{"top":"released","bottom":"released"},"stop_sense":"released",)"
            R"("faults":[],"request_id":"t00018-1","heartbeat_age_ms":60})"
            "\n");
  s.position_milli_mm = 3;
  CHECK(has(std::string(out, buildLiftStatus(out, sizeof out, "lift-01", 1, s)), "\"position_mm\":0.003,"));
  s.position_milli_mm = 1010;
  CHECK(has(std::string(out, buildLiftStatus(out, sizeof out, "lift-01", 1, s)), "\"position_mm\":1.01,"));
  // Allowed by the revised schema: stopping while unhomed, a target while homing.
  LiftStatusLine ok = s;
  ok.state = LiftState::Stopping;
  ok.homed = false;
  ok.has_target = false;
  CHECK(buildLiftStatus(out, sizeof out, "lift-01", 1, ok) != 0);
  ok.state = LiftState::Homing;
  ok.has_target = true;
  ok.target_milli_mm = 5000;
  CHECK(buildLiftStatus(out, sizeof out, "lift-01", 1, ok) != 0);
  // Each refused, as the schema's refinements refuse them.
  LiftStatusLine bad = s;
  bad.driver_enabled = false;
  CHECK(buildLiftStatus(out, sizeof out, "lift-01", 1, bad) == 0);  // stepping with the driver off
  bad = s;
  bad.has_target = false;
  CHECK(buildLiftStatus(out, sizeof out, "lift-01", 1, bad) == 0);  // a move without a target
  bad = s;
  bad.request_id = nullptr;
  CHECK(buildLiftStatus(out, sizeof out, "lift-01", 1, bad) == 0);  // a move without its request
  bad = s;
  bad.state = LiftState::Idle;
  CHECK(buildLiftStatus(out, sizeof out, "lift-01", 1, bad) == 0);  // a target while idle
  bad = s;
  bad.homed = false;
  CHECK(buildLiftStatus(out, sizeof out, "lift-01", 1, bad) == 0);  // moving unhomed
  bad = ok;
  bad.homed = true;
  CHECK(buildLiftStatus(out, sizeof out, "lift-01", 1, bad) == 0);  // homing while homed
  bad = s;
  bad.state = LiftState::Fault;
  bad.has_target = false;
  CHECK(buildLiftStatus(out, sizeof out, "lift-01", 1, bad) == 0);  // fault without a fault
  bad = s;
  bad.position_milli_mm = 1000001;
  CHECK(buildLiftStatus(out, sizeof out, "lift-01", 1, bad) == 0);  // past the rail
  CHECK(buildLiftStatus(out, sizeof out, "hand-left-01", 1, s) == 0);
  CHECK_STR(std::string(out, buildLiftDone(out, sizeof out, "lift-01", 401, "t00019-1", 41000, LiftOutcome::Failed,
                                           LiftFault::WatchdogExpired, true, 140200)),
            R"({"v":1,"type":"lift.done","module_id":"lift-01","seq":401,"request_id":"t00019-1","uptime_ms":41000,)"
            R"("outcome":"failed","fault":"watchdog_expired","position_mm":140.2})"
            "\n");
  CHECK_STR(std::string(out, buildLiftAck(out, sizeof out, "lift-01", 291, "t00020-1", LiftRefusal::NotHeld, 36100)),
            R"({"v":1,"type":"lift.ack","module_id":"lift-01","seq":291,"request_id":"t00020-1","result":"rejected","reason":"not_held","uptime_ms":36100})"
            "\n");
  CHECK(buildLiftAck(out, sizeof out, "lift-01", 1, "has space", LiftRefusal::None, 0) == 0);
  LiftConfigLine config{8, 600000, 5000, 20000, 50000, false, 0, true};
  CHECK(buildLiftHello(out, sizeof out, "lift-01", 0, "0.1.0", 0, config) == 0);
  config = {3, 5000, 600000, 20000, 50000, false, 0, true};
  CHECK(buildLiftHello(out, sizeof out, "lift-01", 0, "0.1.0", 0, config) == 0);
  config = {8, 5000, 600000, 20000, 50000, true, 650500, false};
  CHECK(has(std::string(out, buildLiftHello(out, sizeof out, "lift-01", 0, "0.1.0", 0, config)), "\"top_switch_mm\":650.5},\"stop_sense\":\"not_wired\"}"));
}

// ---- Reading lines (LR1 to LR6) ----

void test_LR_parser_codes() {
  const std::string move = R"({"v":1,"type":"lift.move","module_id":"lift-01","seq":1,"request_id":"k3x9q2-1",)";
  CHECK(problemOf(move + R"("target_mm":100,"speed_mm_s":10})") == Problem::None);
  const LiftPiLine m = parse(move + R"("target_mm":250.5,"speed_mm_s":20})");
  CHECK(m.type == LiftMessageType::Move && m.target_mm == 250.5 && m.speed_mm_s == 20 && m.seq == 1);
  CHECK(problemOf(move + R"("target_mm":0,"speed_mm_s":50})") == Problem::None);
  CHECK(problemOf(move + R"("target_mm":1000,"speed_mm_s":0.001})") == Problem::None);
  CHECK(problemOf(move + R"("target_mm":-0,"speed_mm_s":1})") == Problem::None);
  for (const char* tail : {R"("target_mm":1001,"speed_mm_s":10})", R"("target_mm":-1,"speed_mm_s":10})",
                           R"("target_mm":100,"speed_mm_s":51})", R"("target_mm":100,"speed_mm_s":0})",
                           R"("target_mm":100,"speed_mm_s":-1})", R"("target_mm":100})",
                           R"("target_mm":100,"speed_mm_s":10,"accel_mm_s2":500})", R"("target_mm":"100","speed_mm_s":10})",
                           R"("target_mm":1e400,"speed_mm_s":10})", R"("target_mm":100,"speed_mm_s":1e-400})",
                           R"("target_mm":null,"speed_mm_s":10})", R"("target_mm":100,"speed_mm_s":true})"}) {
    const LiftPiLine line = parse(move + tail);
    CHECK(line.problem == Problem::InvalidField && line.has_request_id);
  }
  CHECK(problemOf(R"({"v":1,"type":"lift.move","module_id":"hand-left-01","seq":1,"request_id":"k3x9q2-1","target_mm":100,"speed_mm_s":10})") ==
        Problem::InvalidField);
  CHECK(problemOf(R"({"v":1,"type":"lift.stop","module_id":"any","seq":1,"request_id":"k3x9q2-1"})") == Problem::InvalidField);
  CHECK(problemOf(R"({"v":1,"type":"lift.stop","module_id":"lift-","seq":1,"request_id":"k3x9q2-1"})") == Problem::InvalidField);
  CHECK(problemOf(R"({"v":1,"type":"lift.stop","module_id":"lift--","seq":1,"request_id":"k3x9q2-1"})") == Problem::None);
  const LiftPiLine stop = parse(R"({"v":1,"type":"lift.stop","module_id":"lift-01","seq":1})");
  CHECK(stop.problem == Problem::InvalidField && !stop.has_request_id);
  CHECK(problemOf(R"({"v":1,"type":"lift.enable","module_id":"lift-01","seq":1,"request_id":"k3x9q2-1","enabled":true})") == Problem::None);
  CHECK(!parse(R"({"v":1,"type":"lift.enable","module_id":"lift-01","seq":1,"request_id":"k3x9q2-1","enabled":false})").enabled);
  CHECK(problemOf(R"({"v":1,"type":"lift.enable","module_id":"lift-01","seq":1,"request_id":"k3x9q2-1","enabled":1})") == Problem::InvalidField);
  CHECK(problemOf(R"({"v":1,"type":"lift.clear","module_id":"lift-01","seq":1,"request_id":"k3x9q2-1","enabled":true})") == Problem::InvalidField);
  // LR1: the hold lease is required, a request id or null.
  const LiftPiLine beat = parse(R"({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":5,"hold_request_id":"k3x9q2-2"})");
  CHECK(beat.problem == Problem::None && beat.has_hold && std::string(beat.hold_request_id) == "k3x9q2-2");
  // LiftRequestIdSchema: six lowercase letters or digits, a dash, a counter from 1.
  CHECK(isLiftRequestId("k3x9q2-17", 9) && isLiftRequestId("000000-1", 8) && isLiftRequestId("abcdef-999999999", 16));
  CHECK(!isLiftRequestId("k3x9q2-0", 8) && !isLiftRequestId("k3x9q2-01", 9) && !isLiftRequestId("K3X9Q2-1", 8));
  CHECK(!isLiftRequestId("k3x9q-1", 7) && !isLiftRequestId("k3x9q2-1234567890", 17) && !isLiftRequestId("k3x9q2_1", 8));
  CHECK(problemOf(R"({"v":1,"type":"lift.stop","module_id":"lift-01","seq":1,"request_id":"lift-4"})") == Problem::InvalidField);
  CHECK(!parse(R"({"v":1,"type":"lift.stop","module_id":"lift-01","seq":1,"request_id":"lift-4"})").has_request_id);
  CHECK(problemOf(R"({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":5,"hold_request_id":"lift-2"})") ==
        Problem::InvalidField);
  const LiftPiLine idle = parse(R"({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":5,"hold_request_id":null})");
  CHECK(idle.problem == Problem::None && !idle.has_hold);
  CHECK(problemOf(R"({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":1})") == Problem::InvalidField);
  CHECK(problemOf(R"({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":1,"hold_request_id":true})") == Problem::InvalidField);
  CHECK(problemOf(R"({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":1,"hold_request_id":""})") == Problem::InvalidField);
  CHECK(problemOf(R"({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":1,"hold_request_id":null,"motion_allowed":true})") ==
        Problem::InvalidField);
  CHECK(problemOf(R"({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":9007199254740991,"hold_request_id":null})") ==
        Problem::None);
  CHECK(problemOf(R"({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":9007199254740992,"hold_request_id":null})") ==
        Problem::InvalidField);
  CHECK(problemOf(R"({"v":1,"type":"hello.request","module_id":"hand-left-01","seq":0})") == Problem::None);
  CHECK(problemOf(R"({"v":1,"type":"error","module_id":"lift-01","seq":13,"code":"malformed","uptime_ms":2000})") == Problem::None);
  CHECK(problemOf(R"({"v":1,"type":"error","module_id":"lift-01","seq":13,"code":"busy"})") == Problem::InvalidField);
  // LR4, LR5
  CHECK(problemOf(R"({"v":1,"type":"lift.status","module_id":"lift-01","seq":1})") == Problem::Unsupported);
  CHECK(problemOf(R"({"v":1,"type":"lift.done","module_id":"lift-01"})") == Problem::Unsupported);
  CHECK(problemOf(R"({"v":1,"type":"hand.input","module_id":"lift-01","seq":1,"uptime_ms":10,"button":"talk","edge":"pressed"})") ==
        Problem::UnknownType);
  CHECK(problemOf(R"({"v":1,"type":"heartbeat","module_id":"lift-01","seq":1})") == Problem::UnknownType);
  CHECK(problemOf(R"({"v":1,"type":"lift.jog","module_id":"lift-01","seq":1,"request_id":"k3x9q2-1","mm":5})") == Problem::UnknownType);
  CHECK(problemOf(R"({"v":2,"type":"lift.heartbeat","module_id":"lift-01","seq":1,"hold_request_id":null})") ==
        Problem::UnsupportedVersion);
  CHECK(problemOf(R"({"v":1,"type":"lift.move","module_id":"lift-01")") == Problem::Malformed);
  CHECK(problemOf(std::string(1024, ' ')) == Problem::Oversize);
}

void test_LR1_LR3_LR4_replies() {
  LiftRig rig;
  rig.boot();
  size_t from = rig.out.lines.size();
  rig.heartbeat();
  CHECK(rig.out.lines.size() == from);
  rig.send(R"({"v":1,"type":"lift.heartbeat","module_id":"lift-02","seq":5,"hold_request_id":null})");
  CHECK(rig.since(from).size() == 1 && has(rig.out.lines.back(), R"("code":"invalid_field")"));
  rig.send(R"({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":5})");
  CHECK(has(rig.out.lines.back(), R"("code":"invalid_field")"));
  rig.send(R"({"v":1,"type":"lift.stop","module_id":"lift-02","seq":6,"request_id":"t00041-1"})");
  CHECK(rejected(ackFor(rig, from, "t00041-1"), "invalid_field"));
  rig.send(R"({"v":1,"type":"lift.move","module_id":"lift-01","seq":7,"request_id":"t00004-1","target_mm":100,"speed_mm_s":51})");
  CHECK(rejected(ackFor(rig, from, "t00004-1"), "invalid_field"));
  rig.send(R"({"v":1,"type":"lift.status","module_id":"lift-01","seq":8})");
  CHECK(has(rig.out.lines.back(), R"("code":"unsupported")"));
  from = rig.out.lines.size();
  rig.send(R"({"v":1,"type":"error","module_id":"lift-01","seq":9,"code":"malformed"})");
  rig.send("   \r");
  CHECK(rig.out.lines.size() == from);
}

// ---- Commands (LC1 to LC7) ----

void test_LC1_stale_seq() {
  LiftRig rig;
  rig.boot();
  rig.heartbeat();
  rig.send(R"({"v":1,"type":"lift.enable","module_id":"lift-01","seq":10,"request_id":"t00001-1","enabled":true})");
  rig.send(R"({"v":1,"type":"lift.enable","module_id":"lift-01","seq":10,"request_id":"t00002-1","enabled":true})");
  rig.send(R"({"v":1,"type":"lift.clear","module_id":"lift-01","seq":3,"request_id":"t00005-1"})");
  CHECK(accepted(ackFor(rig, 0, "t00001-1")));
  CHECK(rejected(ackFor(rig, 0, "t00002-1"), "stale_seq"));
  CHECK(rejected(ackFor(rig, 0, "t00005-1"), "stale_seq"));
  // Stale beats every other reason, for a move too.
  rig.send(R"({"v":1,"type":"lift.move","module_id":"lift-01","seq":9,"request_id":"t00021-1","target_mm":100,"speed_mm_s":10})");
  CHECK(rejected(ackFor(rig, 0, "t00021-1"), "stale_seq"));
  // A refused command doesn't raise the threshold (only accepted ones do).
  rig.send(R"({"v":1,"type":"lift.move","module_id":"lift-01","seq":20,"request_id":"t00026-1","target_mm":100,"speed_mm_s":10})");
  CHECK(rejected(ackFor(rig, 0, "t00026-1"), "not_held"));
  rig.send(R"({"v":1,"type":"lift.enable","module_id":"lift-01","seq":11,"request_id":"t00011-1","enabled":true})");
  CHECK(accepted(ackFor(rig, 0, "t00011-1")));
  // A hello.request starts the numbering again.
  rig.send(R"({"v":1,"type":"hello.request","module_id":"any","seq":0})");
  rig.send(R"({"v":1,"type":"lift.enable","module_id":"lift-01","seq":1,"request_id":"t00012-1","enabled":true})");
  CHECK(accepted(ackFor(rig, 0, "t00012-1")));
}

void test_LC2_stop_and_disable_always_accepted() {
  LiftRig rig(0);  // on the bottom switch, where a disable is allowed
  rig.boot();
  rig.send(R"({"v":1,"type":"lift.enable","module_id":"lift-01","seq":50,"request_id":"t00038-1","enabled":true})");
  // No heartbeat, unhomed, stale seq: still accepted.
  const size_t from = rig.out.lines.size();
  rig.send(R"({"v":1,"type":"lift.stop","module_id":"lift-01","seq":2,"request_id":"t00043-1"})");
  rig.send(R"({"v":1,"type":"lift.enable","module_id":"lift-01","seq":3,"request_id":"t00036-1","enabled":false})");
  CHECK(accepted(ackFor(rig, from, "t00043-1")) && accepted(ackFor(rig, from, "t00036-1")));
  CHECK(ofType(rig, from, "lift.done").empty());  // a stop has no lift.done of its own
  CHECK(!rig.core.driverEnabled() && !rig.stepper.enabled());
  // The stale ones didn't lower the threshold.
  rig.send(R"({"v":1,"type":"lift.enable","module_id":"lift-01","seq":49,"request_id":"t00039-1","enabled":true})");
  CHECK(rejected(ackFor(rig, from, "t00039-1"), "stale_seq"));
  // With a fault latched.
  LiftRig wired(100);
  wired.forceBottom = wired.forceTop = true;
  wired.boot();
  CHECK(wired.core.state() == LiftState::Fault);
  wired.send(wired.command("lift.stop", "t00044-1"));
  wired.send(wired.command("lift.enable", "t00037-1", R"(,"enabled":false)"));
  wired.send(wired.command("lift.enable", "t00040-1", R"(,"enabled":true)"));
  CHECK(accepted(ackFor(wired, 0, "t00044-1")) && accepted(ackFor(wired, 0, "t00037-1")) && accepted(ackFor(wired, 0, "t00040-1")));
}

void test_LC3_move_refusals_in_order() {
  LiftRig rig(100, disableSafe());
  rig.boot();
  auto move = [&](const std::string& id, const std::string& target = "100", const std::string& speed = "10",
                  bool hold = true) {
    const size_t from = rig.out.lines.size();
    const std::string extra = R"(,"target_mm":)" + target + R"(,"speed_mm_s":)" + speed;
    if (hold) {
      rig.held("lift.move", id, extra);
    } else {
      rig.send(rig.command("lift.move", id, extra));
    }
    return ackFor(rig, from, id);
  };
  rig.send(rig.command("lift.move", "t00022-1", R"(,"target_mm":100,"speed_mm_s":10)"));
  CHECK(rejected(ackFor(rig, 0, "t00022-1"), "no_heartbeat"));
  rig.heartbeats = true;
  rig.run(100);
  CHECK(rejected(move("t00023-1", "100", "10", false), "not_held"));
  rig.send(rig.command("lift.enable", "t00036-1", R"(,"enabled":false)"));
  CHECK(rejected(move("t00026-1"), "driver_disabled"));
  rig.send(rig.command("lift.enable", "t00038-1", R"(,"enabled":true)"));
  CHECK(rejected(move("t00027-1"), "not_homed"));
  rig.held("lift.home", "t00017-1");
  rig.run(10);
  CHECK(rejected(move("t00028-1", "100", "10", false), "not_held"));  // the hold names the homing, not m4
  rig.runUntil([&] { return rig.core.state() == LiftState::Idle; }, 200000);
  CHECK(rig.core.homed());
  CHECK(rejected(move("t00029-1", "4.999"), "out_of_range"));
  CHECK(rejected(move("t00030-1", "600.001"), "out_of_range"));
  CHECK(rejected(move("t00031-1", "100", "20.001"), "out_of_range"));
  // Accepted: moving with a target and the request, then completed on the exact step.
  size_t from = rig.out.lines.size();
  CHECK(accepted(move("t00032-1", "250", "20")));
  rig.run(1);
  CHECK(rig.core.state() == LiftState::Moving);
  const std::string moving = lastOfType(rig, "lift.status");
  CHECK(has(moving, R"("state":"moving")") && has(moving, R"("target_mm":250,)") && has(moving, R"("request_id":"t00032-1")"));
  CHECK(rejected(move("t00034-1", "100", "10", false), "not_held"));
  rig.runUntil([&] { return rig.core.state() == LiftState::Idle; }, 100000);
  CHECK(has(doneFor(rig, from, "t00032-1"), R"("outcome":"completed","position_mm":250})"));
  CHECK(rig.stepper.position() == 80000);
  CHECK(rig.stepper.peakSpeed <= 6400 * 1000 && rig.stepper.lastAccel <= 16000);
  // busy: a move still ramping down after its person let go, when the next one is held.
  rig.held("lift.move", "t00033-1", R"(,"target_mm":400,"speed_mm_s":20)");
  rig.run(500);
  rig.release();
  CHECK(rig.core.state() == LiftState::Stopping);
  CHECK(rejected(move("t00035-1"), "busy"));
  rig.runUntil([&] { return rig.core.state() == LiftState::Idle; }, 1000);
  rig.held("lift.move", "t00003-1", R"(,"target_mm":250,"speed_mm_s":20)");
  rig.runUntil([&] { return rig.core.state() == LiftState::Idle; }, 100000);
  // A move to where it is completes at once.
  from = rig.out.lines.size();
  CHECK(accepted(move("t00024-1", "250", "5")));
  CHECK(has(doneFor(rig, from, "t00024-1"), R"("outcome":"completed","position_mm":250})"));
  // fault_latched comes after not_held and before busy.
  rig.forceTop = true;
  rig.run(1);
  CHECK(rig.core.state() == LiftState::Fault);
  CHECK(rejected(move("t00025-1"), "fault_latched"));
}

void test_LC4_home_refusals() {
  LiftRig rig(100, disableSafe());
  rig.boot();
  rig.send(rig.command("lift.home", "t00014-1"));
  CHECK(rejected(ackFor(rig, 0, "t00014-1"), "no_heartbeat"));
  rig.heartbeat();
  rig.send(rig.command("lift.home", "t00015-1"));
  CHECK(rejected(ackFor(rig, 0, "t00015-1"), "not_held"));
  rig.send(rig.command("lift.enable", "t00036-1", R"(,"enabled":false)"));
  rig.held("lift.home", "t00016-1");
  CHECK(rejected(ackFor(rig, 0, "t00016-1"), "driver_disabled"));
}

void test_LC5_stop_ramps_down() {
  LiftRig rig;
  bootAndHome(rig);
  rig.held("lift.move", "t00048-1", R"(,"target_mm":500,"speed_mm_s":20)");
  rig.run(1000);
  CHECK(rig.core.state() == LiftState::Moving);
  const size_t from = rig.out.lines.size();
  const int32_t at = rig.stepper.position();
  rig.send(rig.command("lift.stop", "t00046-1"));
  CHECK(accepted(ackFor(rig, from, "t00046-1")));
  rig.run(1);
  CHECK(rig.core.state() == LiftState::Stopping);
  CHECK(has(lastOfType(rig, "lift.status"), R"("state":"stopping","homed":true,)") &&
        has(lastOfType(rig, "lift.status"), R"("target_mm":null)") && has(lastOfType(rig, "lift.status"), R"("request_id":"t00048-1")"));
  rig.runUntil([&] { return rig.core.state() == LiftState::Idle; }, 1000);
  const int32_t travelled = rig.stepper.position() - at;
  CHECK(travelled >= 300 && travelled <= 340);  // about 1 mm (LM4)
  const std::vector<std::string> dones = ofType(rig, from, "lift.done");
  CHECK(dones.size() == 1 && has(dones[0], R"("request_id":"t00048-1")") && has(dones[0], R"("outcome":"stopped")"));
  CHECK(rig.core.homed() && rig.core.driverEnabled());
  // A homing stopped reads stopping, unhomed, then unhomed.
  const size_t mark = rig.out.lines.size();
  rig.held("lift.home", "t00042-1");
  rig.run(300);
  rig.send(rig.command("lift.stop", "t00047-1"));
  rig.run(1);
  CHECK(has(lastOfType(rig, "lift.status"), R"("state":"stopping","homed":false,"position_mm":null,)") &&
        has(lastOfType(rig, "lift.status"), R"("request_id":"t00042-1")"));
  rig.runUntil([&] { return rig.core.state() != LiftState::Stopping; }, 1000);
  CHECK(rig.core.state() == LiftState::Unhomed);
  CHECK(has(doneFor(rig, mark, "t00042-1"), R"("outcome":"stopped","position_mm":null)"));
  CHECK(rig.core.faults() == 0);
}

void test_LC6_disable_mid_move() {
  LiftRig rig(100, disableSafe());
  bootAndHome(rig);
  rig.held("lift.move", "t00048-1", R"(,"target_mm":400,"speed_mm_s":20)");
  rig.run(500);
  const size_t from = rig.out.lines.size();
  const int halts = rig.stepper.halts;
  rig.send(rig.command("lift.enable", "t00036-1", R"(,"enabled":false)"));
  CHECK(rig.stepper.halts == halts + 1 && !rig.stepper.running());
  CHECK(accepted(ackFor(rig, from, "t00036-1")));
  CHECK(has(doneFor(rig, from, "t00048-1"), R"("outcome":"stopped","position_mm":)") &&
        !has(doneFor(rig, from, "t00048-1"), R"("position_mm":null)"));
  CHECK(!rig.core.driverEnabled() && !rig.core.homed() && rig.core.state() == LiftState::Unhomed);
}

void test_LC7_clear() {
  LiftRig rig;
  bootAndHome(rig);
  rig.send(rig.command("lift.clear", "t00006-1"));
  CHECK(accepted(ackFor(rig, 0, "t00006-1")) && rig.core.homed());  // nothing latched: nothing changes
  // A limit hit at the top while the top switch stays pressed.
  rig.held("lift.move", "t00048-1", R"(,"target_mm":300,"speed_mm_s":20)");
  rig.run(200);
  rig.forceTop = true;
  rig.run(1);
  CHECK(rig.core.faults() == liftFaultBit(LiftFault::LimitHit) && !rig.core.homed());
  size_t from = rig.out.lines.size();
  rig.send(rig.command("lift.clear", "t00007-1"));
  CHECK(rejected(ackFor(rig, from, "t00007-1"), "cause_present"));
  rig.forceTop = false;
  rig.run(30);
  rig.send(rig.command("lift.clear", "t00008-1"));
  CHECK(accepted(ackFor(rig, from, "t00008-1")));
  CHECK(rig.core.faults() == 0 && !rig.core.homed() && rig.core.state() == LiftState::Unhomed);
  // The bottom switch alone may stay pressed.
  rig.forceBottom = true;
  rig.run(1);
  rig.forceBottom = false;
  rig.run(1);
  CHECK(rig.core.faults() == 0);  // unhomed: a bottom press latches nothing
  // watchdog_expired can't clear without a heartbeat.
  rig.held("lift.home", "t00013-1");
  rig.run(200);
  rig.heartbeats = false;
  rig.run(600);
  CHECK(rig.core.faults() == liftFaultBit(LiftFault::WatchdogExpired));
  from = rig.out.lines.size();
  rig.send(rig.command("lift.clear", "t00009-1"));
  CHECK(rejected(ackFor(rig, from, "t00009-1"), "cause_present"));
  rig.heartbeat();
  rig.send(rig.command("lift.clear", "t00010-1"));
  CHECK(accepted(ackFor(rig, from, "t00010-1")) && rig.core.faults() == 0);
}

// ---- Lease and watchdog (LW1 to LW5) ----

void test_LW1_LW2_hold_and_release() {
  LiftRig rig;
  bootAndHome(rig);
  rig.held("lift.move", "t00048-1", R"(,"target_mm":500,"speed_mm_s":20)");
  rig.run(2000);  // heartbeats every 100 ms keep naming "t00048-1"
  CHECK(rig.core.state() == LiftState::Moving);
  const size_t from = rig.out.lines.size();
  rig.release();  // the person lets go
  rig.run(1);
  CHECK(rig.core.state() == LiftState::Stopping);
  rig.runUntil([&] { return rig.core.state() != LiftState::Stopping; }, 1000);
  CHECK(rig.core.state() == LiftState::Idle && rig.core.faults() == 0 && rig.core.homed());
  CHECK(has(doneFor(rig, from, "t00048-1"), R"("outcome":"stopped")"));
  // A heartbeat naming another request lets go too.
  rig.held("lift.move", "t00049-1", R"(,"target_mm":100,"speed_mm_s":20)");
  rig.run(300);
  rig.hold = "t00045-1";
  rig.heartbeat();
  rig.run(1);
  CHECK(rig.core.state() == LiftState::Stopping);
}

void test_LW3_watchdog_mid_move() {
  LiftRig rig;
  bootAndHome(rig);
  rig.held("lift.move", "t00048-1", R"(,"target_mm":500,"speed_mm_s":20)");
  rig.run(1000);
  const size_t from = rig.out.lines.size();
  rig.heartbeats = false;  // the link breaks
  const uint32_t lastBeat = rig.now - rig.now % 100;
  rig.runUntil([&] { return rig.core.state() != LiftState::Moving; }, 1000);
  CHECK(rig.now == lastBeat + 300);
  CHECK(rig.core.state() == LiftState::Stopping && rig.core.faults() == 0);
  rig.runUntil([&] { return rig.core.state() != LiftState::Stopping; }, 1000);
  CHECK(rig.core.faults() == liftFaultBit(LiftFault::WatchdogExpired) && !rig.core.homed());
  CHECK(has(doneFor(rig, from, "t00048-1"), R"("outcome":"failed","fault":"watchdog_expired","position_mm":)") &&
        !has(doneFor(rig, from, "t00048-1"), R"("position_mm":null)"));
  CHECK(rig.core.driverEnabled() && rig.stepper.enabled());  // hold
  CHECK(!rig.stepper.running());
}

void test_LW4_idle_lapse_latches_nothing() {
  LiftRig rig;
  bootAndHome(rig);
  rig.heartbeats = false;
  rig.run(1000);
  CHECK(rig.core.faults() == 0 && rig.core.state() == LiftState::Idle);
  const size_t from = rig.out.lines.size();
  rig.send(rig.command("lift.move", "t00021-1", R"(,"target_mm":100,"speed_mm_s":10)"));
  rig.send(rig.command("lift.home", "t00013-1"));
  CHECK(rejected(ackFor(rig, from, "t00021-1"), "no_heartbeat") && rejected(ackFor(rig, from, "t00013-1"), "no_heartbeat"));
  rig.held("lift.move", "t00026-1", R"(,"target_mm":100,"speed_mm_s":10)");
  CHECK(accepted(ackFor(rig, from, "t00026-1")));
}

void test_LW5_heartbeat_age() {
  LiftRig rig;
  rig.boot();
  rig.run(50);
  CHECK(has(lastOfType(rig, "lift.status"), R"("heartbeat_age_ms":null)"));
  rig.heartbeat();
  rig.run(50);
  CHECK(has(lastOfType(rig, "lift.status"), R"("heartbeat_age_ms":50})"));
}

// ---- Homing (LH1 to LH5) ----

void test_LH1_homing_phases() {
  LiftRig rig(40);
  rig.boot();
  rig.heartbeats = true;
  rig.run(100);
  const size_t from = rig.out.lines.size();
  rig.held("lift.home", "t00017-1");
  CHECK(accepted(ackFor(rig, from, "t00017-1")));
  rig.run(1);
  CHECK(has(lastOfType(rig, "lift.status"), R"("state":"homing","homed":false,"position_mm":null,"target_mm":null,)") &&
        has(lastOfType(rig, "lift.status"), R"("request_id":"t00017-1")"));
  rig.run(1000);
  CHECK(rig.stepper.peakSpeed == 4800 * 1000);  // the fast approach, 15 mm/s
  CHECK(rig.stepper.lastAccel <= 16000);         // at the built-in 50 mm/s²
  bool sawFinalTarget = false;
  rig.out.onLine = [&](const std::string& line) {
    if (has(line, R"("state":"homing")") && has(line, R"("target_mm":5,)")) sawFinalTarget = true;
  };
  rig.runUntil([&] { return rig.core.state() != LiftState::Homing; }, 200000);
  CHECK(rig.core.state() == LiftState::Idle && rig.core.homed());
  CHECK(has(doneFor(rig, from, "t00017-1"), R"("outcome":"completed","position_mm":5})"));
  CHECK(rig.stepper.position() == 1600);
  // Four moves: fast approach, back-off, slow approach, final back-off.
  CHECK(rig.stepper.moves == 4);
  CHECK(rig.stepper.lastAccel <= 16000);
  // The zero is where the slow approach pressed the switch.
  CHECK(rig.stepper.physicalSteps() >= 1599 && rig.stepper.physicalSteps() <= 1601);
  CHECK(sawFinalTarget);
  CHECK(has(lastOfType(rig, "lift.status"), R"("state":"idle","homed":true,"position_mm":5,)"));
}

void test_LH2_homing_from_the_switch() {
  LiftRig rig(0);
  rig.boot();
  CHECK(has(rig.out.lines[1], R"("bottom":"pressed")"));
  rig.heartbeats = true;
  rig.run(100);
  rig.held("lift.home", "t00017-1");
  rig.runUntil([&] { return rig.core.state() != LiftState::Homing; }, 100000);
  CHECK(rig.core.homed() && rig.stepper.moves == 3);
  CHECK(rig.stepper.physicalSteps() >= 1599 && rig.stepper.physicalSteps() <= 1601);
}

void test_LH3_homing_fails() {
  // The bottom switch never presses (missing, or its wire shorted to GND): 1,000 mm of fast approach.
  LiftRig far(2000);
  far.topSwitchMm = 5000;
  far.boot();
  far.heartbeats = true;
  far.run(100);
  const size_t from = far.out.lines.size();
  far.held("lift.home", "t00017-1");
  far.runUntil([&] { return far.core.state() != LiftState::Homing; }, 200000);
  CHECK(far.core.faults() == liftFaultBit(LiftFault::HomingFailed));
  CHECK(has(doneFor(far, from, "t00017-1"), R"("outcome":"failed","fault":"homing_failed","position_mm":null)"));
  CHECK(far.stepper.physicalSteps() == static_cast<int64_t>(2000 - 1000) * 320);
  CHECK(far.core.driverEnabled());
  // A switch stuck pressed never releases on the back-off.
  LiftRig stuck(0);
  stuck.forceBottom = true;
  stuck.boot();
  stuck.heartbeats = true;
  stuck.run(100);
  stuck.held("lift.home", "t00017-1");
  stuck.runUntil([&] { return stuck.core.state() != LiftState::Homing; }, 100000);
  CHECK(stuck.core.faults() == liftFaultBit(LiftFault::HomingFailed));
  CHECK(stuck.stepper.physicalSteps() == 8 * 320);  // the back-off's 8 mm search, no further
  // A switch that releases 6 mm up: inside LIFT_HOMING_BACKOFF_MM + LIFT_HOMING_RELEASE_MARGIN_MM, so each
  // back-off ends where it released, and home is there.
  LiftRig late(20);
  late.bottomHysteresisSteps = 6 * 320;
  late.boot();
  late.heartbeats = true;
  late.run(100);
  const size_t lateFrom = late.out.lines.size();
  late.held("lift.home", "t00060-1");
  late.runUntil([&] { return late.core.state() != LiftState::Homing; }, 100000);
  CHECK(late.core.homed());
  CHECK(has(doneFor(late, lateFrom, "t00060-1"), R"("outcome":"completed","position_mm":6.003})"));
  // One that releases 9 mm up never releases within the 8 mm.
  LiftRig sticky(20);
  sticky.bottomHysteresisSteps = 9 * 320;
  sticky.boot();
  sticky.heartbeats = true;
  sticky.run(100);
  sticky.held("lift.home", "t00017-1");
  sticky.runUntil([&] { return sticky.core.state() != LiftState::Homing; }, 100000);
  CHECK(sticky.core.faults() == liftFaultBit(LiftFault::HomingFailed));
  // LIFT_HOMING_TIMEOUT_MS: a homing still going after 94,709 ms (here the step generator stalls, so no
  // travel limit ever ends it).
  LiftRig slow(100);
  slow.boot();
  slow.heartbeats = true;
  slow.run(100);
  slow.held("lift.home", "t00017-1");
  const uint32_t started = slow.now;
  slow.stepper.stalled = true;
  slow.runUntil([&] { return slow.core.state() != LiftState::Homing; }, 200000);
  CHECK(slow.core.faults() == liftFaultBit(LiftFault::HomingFailed));
  CHECK(slow.now - started == kHomingTimeoutMs);
}

void test_LH4_top_switch_or_reversed_motor_fails_homing() {
  LiftRig rig(100);
  rig.stepper.inverted = true;  // counted down is physically up
  rig.topSwitchMm = 110;
  rig.boot();
  rig.heartbeats = true;
  rig.run(100);
  const size_t from = rig.out.lines.size();
  rig.held("lift.home", "t00017-1");
  rig.runUntil([&] { return rig.core.state() != LiftState::Homing; }, 200000);
  CHECK(rig.core.faults() == liftFaultBit(LiftFault::HomingFailed));
  CHECK(has(doneFor(rig, from, "t00017-1"), R"("fault":"homing_failed")"));
  CHECK(rig.physicalMm() < 110.1);
}

void test_LH5_zero_is_the_trip_point() {
  LiftRig rig(20);
  rig.stepper.haltOvershootSteps = 3;  // the motor runs on 3 steps after every stop at a switch
  bootAndHome(rig);
  CHECK(rig.core.homed());
  const int64_t error = rig.stepper.physicalSteps() - rig.stepper.position();
  CHECK(error >= -1 && error <= 1);
}

// ---- Switches (LL1 to LL4) ----

void test_LL1_limit_hit_when_homed() {
  LiftRig rig;
  bootAndHome(rig);
  rig.held("lift.move", "t00048-1", R"(,"target_mm":500,"speed_mm_s":20)");
  rig.run(800);
  const size_t from = rig.out.lines.size();
  const int32_t at = rig.stepper.position();
  rig.forceTop = true;
  rig.run(1);
  CHECK(!rig.stepper.running());
  CHECK(rig.stepper.position() - at <= 7);
  CHECK(rig.core.state() == LiftState::Fault && !rig.core.homed());
  CHECK(has(doneFor(rig, from, "t00048-1"), R"("outcome":"failed","fault":"limit_hit","position_mm":)") &&
        !has(doneFor(rig, from, "t00048-1"), R"("position_mm":null)"));
  CHECK(has(lastOfType(rig, "lift.status"), R"("state":"fault","homed":false,)") &&
        has(lastOfType(rig, "lift.status"), R"("limits":{"top":"pressed","bottom":"released"},"stop_sense":"released","faults":["limit_hit"])"));
  // Idle and homed: a switch pressing latches too.
  LiftRig idle;
  bootAndHome(idle);
  idle.forceBottom = true;
  idle.run(1);
  CHECK(idle.core.faults() == liftFaultBit(LiftFault::LimitHit));
}

void test_LL2_stopping_from_a_homing() {
  // Stopped during the fast approach, and the bottom switch presses during the ramp: a limit hit.
  LiftRig rig(50);
  rig.boot();
  rig.heartbeats = true;
  rig.run(100);
  rig.held("lift.home", "t00017-1");
  rig.run(500);
  rig.send(rig.command("lift.stop", "t00046-1"));
  rig.run(1);
  CHECK(rig.core.state() == LiftState::Stopping);
  rig.forceBottom = true;
  rig.run(1);
  CHECK(!rig.stepper.running());
  CHECK(rig.core.faults() == liftFaultBit(LiftFault::LimitHit));
  CHECK(has(lastOfType(rig, "lift.done"), R"("outcome":"failed","fault":"limit_hit","position_mm":null)"));
  // Stopped while backing off the switch it still sits on: nothing latches.
  LiftRig on(0);
  on.boot();
  on.heartbeats = true;
  on.run(100);
  on.held("lift.home", "t00017-1");
  on.run(20);
  on.send(on.command("lift.stop", "t00046-1"));
  on.runUntil([&] { return on.core.state() != LiftState::Stopping; }, 1000);
  CHECK(on.core.faults() == 0 && on.core.state() == LiftState::Unhomed);
}

void test_LL3_both_switches_mean_wiring() {
  LiftRig moving;
  bootAndHome(moving);
  moving.held("lift.move", "t00048-1", R"(,"target_mm":500,"speed_mm_s":20)");
  moving.run(300);
  moving.forceBottom = moving.forceTop = true;
  moving.run(1);
  CHECK(!moving.stepper.running());
  CHECK(moving.core.faults() == liftFaultBit(LiftFault::LimitWiring));
  CHECK(has(lastOfType(moving, "lift.done"), R"("fault":"limit_wiring")"));
}

void test_LL4_switch_reports_debounced_release() {
  LiftRig rig(100);
  rig.boot();
  const size_t from = rig.out.lines.size();
  rig.forceBottom = true;
  rig.run(1);
  CHECK(has(rig.out.lines.back(), R"("bottom":"pressed")"));
  rig.forceBottom = false;
  rig.run(5);
  rig.forceBottom = true;
  rig.run(1);
  rig.forceBottom = false;
  rig.run(19);
  CHECK(has(lastOfType(rig, "lift.status"), R"("bottom":"pressed")"));
  rig.run(1);
  CHECK(has(lastOfType(rig, "lift.status"), R"("bottom":"released")"));
  CHECK(ofType(rig, from, "lift.status").size() <= 3);
}

// ---- Round 3: seq on every Pi line, hello.request stops, the stop-sense input; round 4: ids run once ----

void test_LR8_stale_heartbeat_is_ignored() {
  LiftRig rig;
  rig.boot();
  rig.send(R"({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":50,"hold_request_id":null})");
  rig.run(200);
  // A heartbeat with a seq at or below 50 never arrived: no watchdog reset, no lease.
  rig.send(R"({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":50,"hold_request_id":"t00070-1"})");
  rig.send(R"({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":7,"hold_request_id":"t00070-1"})");
  rig.run(100);
  CHECK(has(lastOfType(rig, "lift.status"), R"("heartbeat_age_ms":300})"));
  rig.send(R"({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":51,"hold_request_id":"t00070-1"})");
  rig.send(R"({"v":1,"type":"lift.home","module_id":"lift-01","seq":51,"request_id":"t00070-1"})");
  CHECK(rejected(ackFor(rig, 0, "t00070-1"), "stale_seq"));  // the heartbeat took seq 51
  const size_t mark = rig.out.lines.size();
  rig.send(R"({"v":1,"type":"lift.home","module_id":"lift-01","seq":52,"request_id":"t00070-1"})");
  CHECK(accepted(ackFor(rig, mark, "t00070-1")));
}

void test_LR9_hello_request_stops_the_lift() {
  LiftRig rig;
  bootAndHome(rig);
  rig.held("lift.move", "t00071-1", R"(,"target_mm":300,"speed_mm_s":20)");
  rig.run(500);
  const size_t from = rig.out.lines.size();
  rig.send(R"({"v":1,"type":"hello.request","module_id":"any","seq":0})");
  CHECK(rig.core.state() == LiftState::Stopping);
  rig.runUntil([&] { return rig.core.state() != LiftState::Stopping; }, 1000);
  CHECK(has(doneFor(rig, from, "t00071-1"), R"("outcome":"stopped")"));
  CHECK(rig.core.state() == LiftState::Idle && rig.core.homed() && rig.core.faults() == 0);
}

void test_LP1_stop_sense() {
  // Pressed while moving: steps stop at once and stop_circuit_opened latches.
  LiftRig rig;
  bootAndHome(rig);
  CHECK(has(rig.out.lines[0], R"("stop_sense":"wired"})"));
  rig.held("lift.move", "t00072-1", R"(,"target_mm":300,"speed_mm_s":20)");
  rig.run(500);
  const size_t from = rig.out.lines.size();
  rig.stopPressed = true;
  rig.run(1);
  CHECK(!rig.stepper.running());
  CHECK(rig.core.faults() == liftFaultBit(LiftFault::StopCircuitOpened) && !rig.core.homed());
  CHECK(has(doneFor(rig, from, "t00072-1"), R"("outcome":"failed","fault":"stop_circuit_opened")"));
  CHECK(has(lastOfType(rig, "lift.status"), R"("stop_sense":"pressed","faults":["stop_circuit_opened"])"));
  // A move held while the stop is pressed: stop_pressed (after not_held, before fault_latched).
  rig.held("lift.move", "t00073-1", R"(,"target_mm":100,"speed_mm_s":10)");
  CHECK(rejected(ackFor(rig, from, "t00073-1"), "stop_pressed"));
  // No clear while it is pressed; released, it clears.
  rig.send(rig.command("lift.clear", "t00074-1"));
  CHECK(rejected(ackFor(rig, from, "t00074-1"), "cause_present"));
  rig.stopPressed = false;
  rig.run(1);
  rig.send(rig.command("lift.clear", "t00075-1"));
  CHECK(accepted(ackFor(rig, from, "t00075-1")) && rig.core.faults() == 0);
  // A tap seen for one loop (the board's edge interrupt reports it) latches too, even idle.
  rig.stopPressed = true;
  rig.run(1);
  rig.stopPressed = false;
  rig.run(1);
  CHECK(rig.core.faults() == liftFaultBit(LiftFault::StopCircuitOpened));
  // Built without the input (bench): reports not_wired and never latches it.
  LiftSettings bench = sim::kDefaultSettings;
  bench.stop_sense_wired = false;
  LiftRig unwired(100, bench);
  unwired.boot();
  CHECK(has(unwired.out.lines[0], R"("stop_sense":"not_wired"})") && has(unwired.out.lines[1], R"("stop_sense":"not_wired")"));
  unwired.stopPressed = true;
  unwired.run(10);
  CHECK(unwired.core.faults() == 0);
}

void test_LH6_max_travel_over_all_phases() {
  // 999 mm of fast approach leaves 1 mm for the rest: the back-off runs out of homing travel.
  LiftRig rig(999);
  rig.topSwitchMm = 5000;
  rig.boot();
  rig.heartbeats = true;
  rig.run(100);
  rig.held("lift.home", "t00076-1");
  rig.runUntil([&] { return rig.core.state() != LiftState::Homing; }, 200000);
  CHECK(rig.core.faults() == liftFaultBit(LiftFault::HomingFailed));
  CHECK(rig.physicalMm() <= 1.01);
}

void test_LQ1_a_request_runs_once() {
  LiftRig rig;
  bootAndHome(rig);
  const size_t from = rig.out.lines.size();
  rig.held("lift.move", "t00077-1", R"(,"target_mm":100,"speed_mm_s":20)");
  rig.run(300);
  rig.release();
  rig.runUntil([&] { return rig.core.state() == LiftState::Idle; }, 1000);
  CHECK(has(doneFor(rig, from, "t00077-1"), R"("outcome":"stopped")"));
  // Holding it again doesn't resume it, and sending it again is refused.
  rig.hold = "t00077-1";
  rig.heartbeat();
  rig.run(200);
  CHECK(rig.core.state() == LiftState::Idle);
  const size_t again = rig.out.lines.size();
  rig.send(rig.command("lift.move", "t00077-1", R"(,"target_mm":100,"speed_mm_s":20)"));
  CHECK(rejected(ackFor(rig, again, "t00077-1"), "request_used"));
  // The home that already finished can't run again either.
  rig.held("lift.home", "t00017-1");  // bootAndHome's homing, which completed
  CHECK(rejected(ackFor(rig, again, "t00017-1"), "request_used"));
  // A lower counter under the same prefix is used too, even one never sent; a new prefix starts again.
  rig.held("lift.move", "ordpfx-5", R"(,"target_mm":120,"speed_mm_s":20)");
  rig.runUntil([&] { return rig.core.state() == LiftState::Idle; }, 10000);
  rig.held("lift.move", "ordpfx-3", R"(,"target_mm":100,"speed_mm_s":20)");
  CHECK(accepted(ackFor(rig, again, "ordpfx-5")) && rejected(ackFor(rig, again, "ordpfx-3"), "request_used"));
  rig.held("lift.move", "newpfx-1", R"(,"target_mm":100,"speed_mm_s":20)");
  CHECK(accepted(ackFor(rig, again, "newpfx-1")));
}

// ---- Review fixes: disable_unsafe (rule 6), two-sample homing trips, the outbox, the prefix table ----

void test_LC8_disable_needs_the_bottom_switch() {
  LiftRig rig;
  bootAndHome(rig);
  size_t from = rig.out.lines.size();
  // Idle at 5 mm, off the switch: refused, the driver stays on, nothing else changes.
  rig.send(rig.command("lift.enable", "dis001-1", R"(,"enabled":false)"));
  CHECK(rejected(ackFor(rig, from, "dis001-1"), "disable_unsafe"));
  CHECK(rig.core.driverEnabled() && rig.stepper.enabled() && rig.core.homed());
  // While moving: refused too, and the move ramps down and holds as for a stop.
  rig.held("lift.move", "dis001-2", R"(,"target_mm":200,"speed_mm_s":20)");
  rig.run(500);
  from = rig.out.lines.size();
  rig.send(rig.command("lift.enable", "dis001-3", R"(,"enabled":false)"));
  CHECK(rejected(ackFor(rig, from, "dis001-3"), "disable_unsafe"));
  CHECK(rig.core.state() == LiftState::Stopping);
  rig.runUntil([&] { return rig.core.state() != LiftState::Stopping; }, 1000);
  CHECK(has(doneFor(rig, from, "dis001-2"), R"("outcome":"stopped")") && rig.core.driverEnabled());
  // Even a stale disable is answered (never stale_seq), still disable_unsafe.
  rig.send(R"({"v":1,"type":"lift.enable","module_id":"lift-01","seq":1,"request_id":"dis001-4","enabled":false})");
  CHECK(rejected(ackFor(rig, from, "dis001-4"), "disable_unsafe"));
  // On the bottom switch it frees the motor; a disable-safe build does so anywhere.
  LiftRig onSwitch(0);
  onSwitch.boot();
  onSwitch.send(onSwitch.command("lift.enable", "dis002-1", R"(,"enabled":false)"));
  CHECK(accepted(ackFor(onSwitch, 0, "dis002-1")) && !onSwitch.core.driverEnabled());
  LiftRig safe(100, disableSafe());
  safe.boot();
  safe.send(safe.command("lift.enable", "dis003-1", R"(,"enabled":false)"));
  CHECK(accepted(ackFor(safe, 0, "dis003-1")) && !safe.core.driverEnabled());
}

void test_LH7_one_noisy_sample_is_not_a_trip() {
  LiftRig rig(30);
  rig.boot();
  rig.heartbeats = true;
  rig.run(100);
  rig.held("lift.home", "nse001-1");
  rig.run(300);
  // One sample of the bottom switch reading pressed (noise on the line): homing carries on.
  rig.forceBottom = true;
  rig.run(1);
  rig.forceBottom = false;
  rig.run(50);
  CHECK(rig.core.state() == LiftState::Homing && rig.stepper.moves == 1);
  // Two in a row trip it, and the zero is where the first one was read.
  rig.runUntil([&] { return rig.core.state() != LiftState::Homing; }, 200000);
  CHECK(rig.core.homed());
  const int64_t error = rig.stepper.physicalSteps() - rig.stepper.position();
  CHECK(error >= -1 && error <= 1);
}

void test_LS6_lines_wait_when_the_port_is_full() {
  LiftRig rig;
  rig.boot();
  rig.heartbeat();
  rig.run(10);
  const size_t from = rig.out.lines.size();
  const uint32_t seqBefore = rig.core.nextSeq();
  rig.out.full = true;
  rig.send(rig.command("lift.enable", "out001-1", R"(,"enabled":true)"));
  rig.send(rig.command("lift.clear", "out001-2"));
  rig.run(120);  // statuses fall due meanwhile: none is built while the acks wait
  CHECK(rig.out.lines.size() == from);
  CHECK(rig.core.nextSeq() == seqBefore + 2 && rig.core.txDropped() == 0);
  rig.out.full = false;
  rig.run(1);
  const std::vector<std::string> sent = rig.since(from);
  CHECK(sent.size() >= 3);
  if (sent.size() < 3) return;
  CHECK(has(sent[0], R"("request_id":"out001-1")") && has(sent[0], "\"seq\":" + std::to_string(seqBefore) + ","));
  CHECK(has(sent[1], R"("request_id":"out001-2")") && has(sent[1], "\"seq\":" + std::to_string(seqBefore + 1) + ","));
  CHECK(has(sent[2], R"("type":"lift.status")"));
  // A status the port can't take, with nothing waiting, is dropped and its seq used (the Pi sees the gap).
  rig.out.full = true;
  rig.run(50);
  CHECK(rig.core.txDropped() == 1);
  rig.out.full = false;
  rig.run(50);
  CHECK(rig.core.nextSeq() > seqBefore + 4);
}

void test_LQ2_a_full_prefix_table_refuses_new_prefixes() {
  LiftRig rig;
  bootAndHome(rig);  // its homing used one prefix
  const size_t from = rig.out.lines.size();
  for (int i = 0; i < 15; ++i) {
    char id[16];
    std::snprintf(id, sizeof id, "pfx%03d-1", i);
    rig.held("lift.move", id, R"(,"target_mm":)" + std::to_string(6 + i) + R"(,"speed_mm_s":20)");
    rig.runUntil([&] { return rig.core.state() == LiftState::Idle; }, 10000);
    CHECK(accepted(ackFor(rig, from, id)));
  }
  // Sixteen prefixes remembered: a seventeenth is refused rather than forgetting one.
  rig.held("lift.move", "pfx999-1", R"(,"target_mm":40,"speed_mm_s":20)");
  CHECK(rejected(ackFor(rig, from, "pfx999-1"), "request_used"));
  // A known prefix still works with a higher counter.
  rig.held("lift.move", "pfx000-2", R"(,"target_mm":40,"speed_mm_s":20)");
  CHECK(accepted(ackFor(rig, from, "pfx000-2")));
}

}  // namespace

int main() {
  TESTS_BEGIN();
  RUN(test_LM1_steps_per_mm);
  RUN(test_LM2_mm_and_steps);
  RUN(test_LM3_rates);
  RUN(test_LM4_stopping_distance_and_settings);
  RUN(test_LM5_simulated_move_respects_its_ramp);
  RUN(test_LS1_boot);
  RUN(test_LS2_status_rate_and_changes);
  RUN(test_LS3_seq_and_hello_request);
  RUN(test_LS5_builders);
  RUN(test_LR_parser_codes);
  RUN(test_LR1_LR3_LR4_replies);
  RUN(test_LC1_stale_seq);
  RUN(test_LC2_stop_and_disable_always_accepted);
  RUN(test_LC3_move_refusals_in_order);
  RUN(test_LC4_home_refusals);
  RUN(test_LC5_stop_ramps_down);
  RUN(test_LC6_disable_mid_move);
  RUN(test_LC7_clear);
  RUN(test_LW1_LW2_hold_and_release);
  RUN(test_LW3_watchdog_mid_move);
  RUN(test_LW4_idle_lapse_latches_nothing);
  RUN(test_LW5_heartbeat_age);
  RUN(test_LH1_homing_phases);
  RUN(test_LH2_homing_from_the_switch);
  RUN(test_LH3_homing_fails);
  RUN(test_LH4_top_switch_or_reversed_motor_fails_homing);
  RUN(test_LH5_zero_is_the_trip_point);
  RUN(test_LL1_limit_hit_when_homed);
  RUN(test_LL2_stopping_from_a_homing);
  RUN(test_LL3_both_switches_mean_wiring);
  RUN(test_LL4_switch_reports_debounced_release);
  RUN(test_LR8_stale_heartbeat_is_ignored);
  RUN(test_LR9_hello_request_stops_the_lift);
  RUN(test_LP1_stop_sense);
  RUN(test_LH6_max_travel_over_all_phases);
  RUN(test_LQ1_a_request_runs_once);
  RUN(test_LC8_disable_needs_the_bottom_switch);
  RUN(test_LH7_one_noisy_sample_is_not_a_trip);
  RUN(test_LS6_lines_wait_when_the_port_is_full);
  RUN(test_LQ2_a_full_prefix_table_refuses_new_prefixes);
  TESTS_END();
}
