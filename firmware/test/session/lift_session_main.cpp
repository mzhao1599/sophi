// Prints a scripted lift session through the firmware's own code (lib/protocol and lib/lift) on a fake
// clock and a simulated stepper, for the cross-check in
// packages/contracts/test/lift-firmware-session.test.ts. test/run-native.sh checks that
// test/session/lift_transcript.txt matches what this prints.
//
// Same line format as transcript.txt:
//   = <module_id> lift            the lift boots; the lines below are its session
//   @ <ms>                        the clock; module lines after it were sent on its own
//   > <line>                      a line from the Pi
//   < <line>                      a line from the lift; right after a '>' line, they are its replies
//   # <text>                      a note for people (the simulated carriage and switches)
//
// The motor, driver and switches are simulated (test/support/sim_stepper.h, lift_rig.h); nothing in
// this file proves anything about them.
#include <cstdio>
#include <string>

#include "../support/lift_rig.h"

using namespace walker;
using walker::sim::LiftRig;

namespace {

uint32_t* clock = nullptr;
bool stampDue = true;

void stamp() {
  if (stampDue) {
    std::printf("@ %u\n", *clock);
    stampDue = false;
  }
}

// Pi lines that test the reader. Every line of the contract's lift fixtures is here; the vitest checks that.
const char* const kPiLines[] = {
    // lift-serial-v1.valid.jsonl
    R"L({"v":1,"type":"lift.hello","module_id":"lift-01","seq":0,"firmware_version":"0.1.0","uptime_ms":0,"config":{"microsteps":8,"soft_min_mm":5,"soft_max_mm":600,"max_speed_mm_s":20,"max_accel_mm_s2":50,"top_switch_mm":null},"stop_sense":"wired"})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":1,"uptime_ms":50,"state":"unhomed","homed":false,"position_mm":null,"target_mm":null,"driver_enabled":true,"limits":{"top":"released","bottom":"released"},"stop_sense":"released","faults":[],"request_id":null,"heartbeat_age_ms":null})L",
    R"L({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":3,"hold_request_id":null})L",
    R"L({"v":1,"type":"lift.enable","module_id":"lift-01","seq":4,"request_id":"k3x9q2-1","enabled":true})L",
    R"L({"v":1,"type":"lift.ack","module_id":"lift-01","seq":2,"request_id":"k3x9q2-1","result":"accepted","uptime_ms":1210})L",
    R"L({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":5,"hold_request_id":"k3x9q2-2"})L",
    R"L({"v":1,"type":"lift.home","module_id":"lift-01","seq":6,"request_id":"k3x9q2-2"})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":9,"uptime_ms":1400,"state":"homing","homed":false,"position_mm":null,"target_mm":null,"driver_enabled":true,"limits":{"top":"released","bottom":"released"},"stop_sense":"released","faults":[],"request_id":"k3x9q2-2","heartbeat_age_ms":40})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":200,"uptime_ms":31500,"state":"homing","homed":false,"position_mm":null,"target_mm":5,"driver_enabled":true,"limits":{"top":"released","bottom":"pressed"},"stop_sense":"released","faults":[],"request_id":"k3x9q2-2","heartbeat_age_ms":30})L",
    R"L({"v":1,"type":"lift.done","module_id":"lift-01","seq":212,"request_id":"k3x9q2-2","uptime_ms":31800,"outcome":"completed","position_mm":5})L",
    R"L({"v":1,"type":"lift.move","module_id":"lift-01","seq":310,"request_id":"k3x9q2-3","target_mm":250,"speed_mm_s":20})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":260,"uptime_ms":34000,"state":"moving","homed":true,"position_mm":121.5,"target_mm":250,"driver_enabled":true,"limits":{"top":"released","bottom":"released"},"stop_sense":"released","faults":[],"request_id":"k3x9q2-3","heartbeat_age_ms":60})L",
    R"L({"v":1,"type":"lift.stop","module_id":"lift-01","seq":330,"request_id":"k3x9q2-4"})L",
    R"L({"v":1,"type":"lift.done","module_id":"lift-01","seq":281,"request_id":"k3x9q2-3","uptime_ms":35020,"outcome":"stopped","position_mm":140.2})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":30,"uptime_ms":2400,"state":"stopping","homed":false,"position_mm":null,"target_mm":null,"driver_enabled":true,"limits":{"top":"released","bottom":"released"},"stop_sense":"released","faults":[],"request_id":"k3x9q2-2","heartbeat_age_ms":20})L",
    R"L({"v":1,"type":"lift.ack","module_id":"lift-01","seq":290,"request_id":"k3x9q2-5","result":"rejected","reason":"not_homed","uptime_ms":36000})L",
    R"L({"v":1,"type":"lift.ack","module_id":"lift-01","seq":291,"request_id":"k3x9q2-9","result":"rejected","reason":"not_held","uptime_ms":36100})L",
    R"L({"v":1,"type":"lift.ack","module_id":"lift-01","seq":292,"request_id":"k3x9q2-3","result":"rejected","reason":"request_used","uptime_ms":36200})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":400,"uptime_ms":41000,"state":"fault","homed":true,"position_mm":140.2,"target_mm":null,"driver_enabled":true,"limits":{"top":"released","bottom":"released"},"stop_sense":"released","faults":["watchdog_expired"],"request_id":null,"heartbeat_age_ms":350})L",
    R"L({"v":1,"type":"lift.done","module_id":"lift-01","seq":401,"request_id":"k3x9q2-6","uptime_ms":41000,"outcome":"failed","fault":"watchdog_expired","position_mm":140.2})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":450,"uptime_ms":42000,"state":"fault","homed":false,"position_mm":null,"target_mm":null,"driver_enabled":true,"limits":{"top":"released","bottom":"released"},"stop_sense":"pressed","faults":["stop_circuit_opened"],"request_id":null,"heartbeat_age_ms":40})L",
    R"L({"v":1,"type":"lift.clear","module_id":"lift-01","seq":402,"request_id":"k3x9q2-7"})L",
    R"L({"v":1,"type":"lift.enable","module_id":"lift-01","seq":500,"request_id":"k3x9q2-8","enabled":false})L",
    R"L({"v":1,"type":"lift.ack","module_id":"lift-01","seq":501,"request_id":"k3x9q2-10","result":"rejected","reason":"disable_unsafe","uptime_ms":43000})L",
    R"L({"v":1,"type":"hello.request","module_id":"lift-01","seq":0})L",
    R"L({"v":1,"type":"error","module_id":"lift-01","seq":13,"code":"malformed","uptime_ms":2000})L",
    // lift-serial-v1.invalid.json
    R"L({"v":1,"type":"hand.input","module_id":"lift-01","seq":1,"uptime_ms":10,"button":"talk","edge":"pressed"})L",
    R"L({"v":1,"type":"lift.jog","module_id":"lift-01","seq":1,"request_id":"k3x9q2-1","mm":5})L",
    R"L({"v":2,"type":"lift.heartbeat","module_id":"lift-01","seq":1,"hold_request_id":null})L",
    R"L({"v":1,"type":"lift.move","module_id":"lift-01")L",
    R"L({"v":1,"type":"lift.move","module_id":"hand-left-01","seq":1,"request_id":"k3x9q2-1","target_mm":100,"speed_mm_s":10})L",
    R"L({"v":1,"type":"lift.move","module_id":"lift-01","seq":1,"request_id":"k3x9q2-1","target_mm":1001,"speed_mm_s":10})L",
    R"L({"v":1,"type":"lift.move","module_id":"lift-01","seq":1,"request_id":"k3x9q2-1","target_mm":-1,"speed_mm_s":10})L",
    R"L({"v":1,"type":"lift.move","module_id":"lift-01","seq":1,"request_id":"k3x9q2-1","target_mm":100,"speed_mm_s":51})L",
    R"L({"v":1,"type":"lift.move","module_id":"lift-01","seq":1,"request_id":"k3x9q2-1","target_mm":100})L",
    R"L({"v":1,"type":"lift.move","module_id":"lift-01","seq":1,"request_id":"k3x9q2-1","target_mm":100,"speed_mm_s":10,"accel_mm_s2":500})L",
    R"L({"v":1,"type":"lift.stop","module_id":"lift-01","seq":1})L",
    R"L({"v":1,"type":"lift.stop","module_id":"lift-01","seq":1,"request_id":"lift-2"})L",
    R"L({"v":1,"type":"lift.stop","module_id":"lift-01","seq":1,"request_id":"k3x9q2-0"})L",
    R"L({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":1})L",
    R"L({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":1,"hold_request_id":true})L",
    R"L({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":1,"hold_request_id":null,"motion_allowed":true})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":1,"uptime_ms":50,"state":"unhomed","homed":false,"position_mm":10,"target_mm":null,"driver_enabled":true,"limits":{"top":"released","bottom":"released"},"stop_sense":"released","faults":[],"request_id":null,"heartbeat_age_ms":null})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":1,"uptime_ms":50,"state":"moving","homed":true,"position_mm":10,"target_mm":50,"driver_enabled":false,"limits":{"top":"released","bottom":"released"},"stop_sense":"released","faults":[],"request_id":"k3x9q2-1","heartbeat_age_ms":10})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":1,"uptime_ms":50,"state":"moving","homed":true,"position_mm":10,"target_mm":null,"driver_enabled":true,"limits":{"top":"released","bottom":"released"},"stop_sense":"released","faults":[],"request_id":"k3x9q2-1","heartbeat_age_ms":10})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":1,"uptime_ms":50,"state":"moving","homed":true,"position_mm":10,"target_mm":50,"driver_enabled":true,"limits":{"top":"released","bottom":"released"},"stop_sense":"released","faults":[],"request_id":null,"heartbeat_age_ms":10})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":1,"uptime_ms":50,"state":"idle","homed":false,"position_mm":null,"target_mm":null,"driver_enabled":true,"limits":{"top":"released","bottom":"released"},"stop_sense":"released","faults":[],"request_id":null,"heartbeat_age_ms":10})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":1,"uptime_ms":50,"state":"homing","homed":true,"position_mm":10,"target_mm":null,"driver_enabled":true,"limits":{"top":"released","bottom":"released"},"stop_sense":"released","faults":[],"request_id":"k3x9q2-1","heartbeat_age_ms":10})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":1,"uptime_ms":50,"state":"stopping","homed":false,"position_mm":10,"target_mm":null,"driver_enabled":true,"limits":{"top":"released","bottom":"released"},"stop_sense":"released","faults":[],"request_id":"k3x9q2-1","heartbeat_age_ms":10})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":1,"uptime_ms":50,"state":"idle","homed":true,"position_mm":10,"target_mm":50,"driver_enabled":true,"limits":{"top":"released","bottom":"released"},"stop_sense":"released","faults":[],"request_id":null,"heartbeat_age_ms":10})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":1,"uptime_ms":50,"state":"fault","homed":false,"position_mm":null,"target_mm":null,"driver_enabled":true,"limits":{"top":"released","bottom":"pressed"},"stop_sense":"released","faults":[],"request_id":null,"heartbeat_age_ms":10})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":1,"uptime_ms":50,"state":"fault","homed":false,"position_mm":null,"target_mm":null,"driver_enabled":true,"limits":{"top":"released","bottom":"released"},"stop_sense":"released","faults":["overload"],"request_id":null,"heartbeat_age_ms":10})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":1,"uptime_ms":50,"state":"fault","homed":false,"position_mm":null,"target_mm":null,"driver_enabled":true,"limits":{"top":"pressed","bottom":"pressed"},"stop_sense":"released","faults":["limit_wiring","limit_wiring"],"request_id":null,"heartbeat_age_ms":10})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":1,"uptime_ms":50,"state":"unhomed","homed":false,"position_mm":null,"target_mm":null,"driver_enabled":true,"limits":{"top":"released","bottom":"released"},"stop_sense":"pressed","faults":[],"request_id":null,"heartbeat_age_ms":10})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":1,"uptime_ms":50,"state":"homing","homed":false,"position_mm":null,"target_mm":null,"driver_enabled":true,"limits":{"top":"released","bottom":"released"},"stop_sense":"pressed","faults":["stop_circuit_opened"],"request_id":"k3x9q2-1","heartbeat_age_ms":10})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01","seq":1,"uptime_ms":50,"state":"unhomed","homed":false,"position_mm":null,"target_mm":null,"driver_enabled":true,"limits":{"top":"unknown","bottom":"released"},"stop_sense":"released","faults":[],"request_id":null,"heartbeat_age_ms":null})L",
    R"L({"v":1,"type":"lift.ack","module_id":"lift-01","seq":1,"request_id":"k3x9q2-1","result":"rejected","uptime_ms":10})L",
    R"L({"v":1,"type":"lift.ack","module_id":"lift-01","seq":1,"request_id":"k3x9q2-1","result":"accepted","reason":"busy","uptime_ms":10})L",
    R"L({"v":1,"type":"lift.done","module_id":"lift-01","seq":1,"request_id":"k3x9q2-1","uptime_ms":10,"outcome":"failed","position_mm":null})L",
    R"L({"v":1,"type":"lift.hello","module_id":"lift-01","seq":0,"firmware_version":"0.1.0","uptime_ms":0,"config":{"microsteps":8,"soft_min_mm":600,"soft_max_mm":5,"max_speed_mm_s":20,"max_accel_mm_s2":50,"top_switch_mm":null},"stop_sense":"wired"})L",
    R"L({"v":1,"type":"lift.hello","module_id":"lift-01","seq":0,"firmware_version":"0.1.0","uptime_ms":0,"config":{"microsteps":3,"soft_min_mm":5,"soft_max_mm":600,"max_speed_mm_s":20,"max_accel_mm_s2":50,"top_switch_mm":null},"stop_sense":"wired"})L",
    R"L({"v":1,"type":"lift.hello","module_id":"lift-01","seq":0,"firmware_version":"0.1.0","uptime_ms":0,"config":{"microsteps":8,"soft_min_mm":5,"soft_max_mm":600,"max_speed_mm_s":20,"max_accel_mm_s2":50,"top_switch_mm":null}})L",
    // LR2, LR3: commands with bad fields, or for other modules
    R"L({"v":1,"type":"lift.move","module_id":"lift-01","seq":1,"request_id":"rdr002-1","target_mm":100,"speed_mm_s":0})L",
    R"L({"v":1,"type":"lift.move","module_id":"lift-01","seq":1,"request_id":"rdr002-2","target_mm":"100","speed_mm_s":10})L",
    R"L({"v":1,"type":"lift.move","module_id":"lift-01","seq":1,"request_id":"rdr002-3","target_mm":1e400,"speed_mm_s":10})L",
    R"L({"v":1,"type":"lift.move","module_id":"lift-01","seq":1,"request_id":"rdr002-4","target_mm":100,"speed_mm_s":50.0000000000001})L",
    R"L({"v":1,"type":"lift.enable","module_id":"lift-01","seq":1,"request_id":"rdr002-5","enabled":"true"})L",
    R"L({"v":1,"type":"lift.home","module_id":"any","seq":1,"request_id":"rdr002-6"})L",
    R"L({"v":1,"type":"lift.home","module_id":"lift-01","seq":1,"request_id":"has space"})L",
    R"L({"v":1,"type":"lift.home","module_id":"lift-01","seq":1,"request_id":"lift-2"})L",
    R"L({"v":1,"type":"lift.home","module_id":"lift-01","seq":1,"request_id":"rdr002-0"})L",
    R"L({"v":1,"type":"lift.home","module_id":"lift-01","seq":1.5,"request_id":"rdr002-7"})L",
    R"L({"v":1,"type":"lift.home","module_id":"lift-02","seq":1,"request_id":"rdr003-1"})L",
    R"L({"v":1,"type":"lift.heartbeat","module_id":"lift-02","seq":1,"hold_request_id":null})L",
    R"L({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":1,"hold_request_id":"has space"})L",
    R"L({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":1,"hold_request_id":"abcdefghijklmnopqrstuvwxyz0123456789ABCDE"})L",
    R"L({"v":1,"type":"hello.request","module_id":"hand-left-01","seq":1})L",
    // LR4, LR5: types, versions, framing
    R"L({"v":1,"type":"haptic.play","module_id":"lift-01","seq":1,"request_id":"x","pattern":"error","duration_ms":400})L",
    R"L({"v":1,"type":"heartbeat","module_id":"lift-01","seq":1,"uptime_ms":10,"health":"ok"})L",
    R"L({"v":1,"type":"hello","module_id":"lift-01","seq":0,"module_type":"hand","capabilities":[]})L",
    R"L({"v":1,"type":"lift.status","module_id":"lift-01"})L",
    R"L({"v":1.0,"type":"lift.heartbeat","module_id":"lift-01","seq":2,"hold_request_id":null})L",
    R"L({"v":"1","type":"lift.heartbeat","module_id":"lift-01","seq":2,"hold_request_id":null})L",
    R"L({"v":1,"type":"LIFT.HEARTBEAT","module_id":"lift-01","seq":2,"hold_request_id":null})L",
    R"L({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":2,"seq":3,"hold_request_id":null})L",
    R"L({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":-0,"hold_request_id":null})L",
    R"L({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":2,"hold_request_id":null})L",
    R"L({"v":1,"type":"error","module_id":"lift-01","seq":40,"code":"overflow","request_id":"cue-9","detail":"queue full"})L",
    R"L({"v":1,"type":"error","module_id":"lift-01","seq":41,"code":"stale_seq"})L",
    R"L(not json)L",
    R"L([1])L",
    R"L({})L",
    R"L(  {"v" : 1 , "type" : "hello.request" , "module_id" : "any" , "seq" : 0 }  )L",
};

// A small fixed-seed generator, so the scrambled lines are the same on every run and every computer.
struct Random {
  uint32_t state;
  uint32_t next() {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return state;
  }
};

// Scrambles a line with printable ASCII only, as the hand session does.
std::string scramble(std::string line, Random& random) {
  static const char kAlphabet[] = "{}[]:,\"\\ 0123456789-+.eEuabcdefnlrst_xyzAZ/";
  const int edits = 1 + static_cast<int>(random.next() % 3);
  for (int e = 0; e < edits && !line.empty(); ++e) {
    const size_t at = random.next() % line.size();
    const char c = kAlphabet[random.next() % (sizeof kAlphabet - 1)];
    switch (random.next() % 3) {
      case 0:
        line[at] = c;
        break;
      case 1:
        line.insert(at, 1, c);
        break;
      default:
        line.erase(at, 1 + random.next() % 3);
        break;
    }
  }
  return line;
}

void note(LiftRig& rig, const char* text) {
  stamp();
  // Whole micrometres, in integers, so every computer prints the same digits.
  const long long um = static_cast<long long>(rig.stepper.physicalSteps()) * 1000 / 320;
  std::printf("# %s (simulated carriage %lld.%03lld mm above the bottom trip point)\n", text, um / 1000,
              (um < 0 ? -um : um) % 1000);
}

void liftSession() {
  std::printf("= lift-01 lift\n");
  LiftRig rig(12);
  clock = &rig.now;
  rig.onTick = [] { stampDue = true; };
  rig.onSend = [](const std::string& line) {
    stamp();
    std::printf("> %s\n", line.c_str());
  };
  rig.out.onLine = [](const std::string& line) {
    stamp();
    std::printf("< %s\n", line.c_str());
  };
  note(rig, "boot; both switches read released");
  rig.boot();

  // LS3, LR6: the Pi opens the port.
  rig.run(50);
  rig.send(R"({"v":1,"type":"hello.request","module_id":"any","seq":0})");

  // LR1 to LR7: every reader case, ten milliseconds apart, then scrambled lines.
  for (const char* line : kPiLines) {
    rig.send(line);
    rig.run(10);
  }
  // The longest line (1,023 bytes and its newline) and one byte more.
  std::string longest = R"({"v":1,"type":"hello.request","module_id":"any","seq":0})";
  longest.insert(1, 1023 - longest.size(), ' ');
  rig.send(longest);
  rig.run(10);
  rig.send(" " + longest);
  rig.run(10);
  Random random{0x11f7u};
  const size_t count = sizeof kPiLines / sizeof kPiLines[0];
  for (int i = 0; i < 200; ++i) {
    rig.send(scramble(kPiLines[random.next() % count], random));
    rig.run(5);
  }
  // End whatever those lines started: stop, wait, driver off.
  rig.send(R"({"v":1,"type":"lift.stop","module_id":"lift-01","seq":0,"request_id":"tidy00-1"})");
  rig.run(500);
  rig.send(R"({"v":1,"type":"lift.enable","module_id":"lift-01","seq":0,"request_id":"tidy00-2","enabled":false})");
  rig.run(100);

  // The scripted path: the Pi opens the port again and sends heartbeats every 100 ms. Each hold-to-run
  // command is preceded by a heartbeat naming it (the person pressing and holding the control), and the
  // heartbeats go on naming it until the person lets go.
  note(rig, "the scripted path starts");
  rig.send(R"({"v":1,"type":"hello.request","module_id":"lift-01","seq":0})");
  rig.piSeq = 1;
  rig.hold.clear();
  rig.heartbeats = true;
  rig.run(100);
  rig.send(rig.command("lift.clear", "path00-1"));
  rig.send(rig.command("lift.enable", "path00-2", R"(,"enabled":true)"));
  // Rule 3: a replayed line is stale, and a stale heartbeat is ignored as if it never arrived.
  rig.send(R"({"v":1,"type":"lift.enable","module_id":"lift-01","seq":1,"request_id":"path00-3","enabled":true})");
  rig.send(R"({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":1,"hold_request_id":"path00-4"})");
  rig.send(rig.command("lift.home", "path00-4"));                                        // not_held
  rig.held("lift.move", "path00-5", R"(,"target_mm":30,"speed_mm_s":20)");              // not_homed
  rig.held("lift.home", "path00-6");
  rig.runUntil([&] { return rig.core.state() != LiftState::Homing; }, 60000);
  note(rig, "homed");
  rig.release();
  rig.run(100);

  // Up to 30 mm at 20 mm/s, held all the way.
  rig.held("lift.move", "path00-7", R"(,"target_mm":30,"speed_mm_s":20)");
  rig.runUntil([&] { return rig.core.state() == LiftState::Idle; }, 10000);
  note(rig, "at 30 mm");
  rig.release();
  rig.run(100);

  // Towards 60 mm; the person lets go part way (rule 5). Holding it again resumes nothing, and sending it
  // again is refused: a request runs once.
  rig.held("lift.move", "path00-8", R"(,"target_mm":60,"speed_mm_s":20)");
  rig.run(650);
  rig.release();
  note(rig, "let go");
  rig.runUntil([&] { return rig.core.state() == LiftState::Idle; }, 10000);
  rig.run(100);
  rig.held("lift.move", "path00-8", R"(,"target_mm":60,"speed_mm_s":20)");
  rig.run(200);
  rig.release();
  rig.run(100);

  // Towards 90 mm, ended by lift.stop (rule 6).
  rig.held("lift.move", "path00-9", R"(,"target_mm":90,"speed_mm_s":20)");
  rig.run(650);
  rig.send(rig.command("lift.stop", "path00-10"));
  rig.runUntil([&] { return rig.core.state() == LiftState::Idle; }, 10000);
  note(rig, "stopped");
  rig.release();
  rig.run(100);

  // Towards 120 mm; the Pi restarts mid-move and sends hello.request (rule 2).
  rig.held("lift.move", "path00-11", R"(,"target_mm":120,"speed_mm_s":20)");
  rig.run(500);
  rig.heartbeats = false;
  rig.send(R"({"v":1,"type":"hello.request","module_id":"any","seq":0})");
  note(rig, "the Pi restarted");
  rig.runUntil([&] { return rig.core.state() == LiftState::Idle; }, 10000);
  rig.piSeq = 1;
  rig.hold.clear();
  rig.heartbeats = true;
  rig.run(200);

  // Down towards 40 mm; the heartbeats stop altogether (the link broke).
  rig.held("lift.move", "path00-12", R"(,"target_mm":40,"speed_mm_s":20)");
  rig.run(550);
  rig.heartbeats = false;
  note(rig, "the Pi's heartbeats stop");
  rig.runUntil([&] { return rig.core.state() == LiftState::Fault; }, 2000);
  rig.run(200);
  rig.send(rig.command("lift.clear", "path00-13"));  // cause_present: no heartbeat
  rig.hold.clear();
  rig.heartbeats = true;
  rig.run(100);
  rig.send(rig.command("lift.clear", "path00-14"));
  rig.run(100);

  // Home again, move, and someone presses the stop (rule 8).
  rig.held("lift.home", "path00-15");
  rig.runUntil([&] { return rig.core.state() != LiftState::Homing; }, 60000);
  rig.release();
  rig.run(100);
  rig.held("lift.move", "path00-16", R"(,"target_mm":50,"speed_mm_s":20)");
  rig.run(600);
  rig.stopPressed = true;
  note(rig, "the stop is pressed");
  rig.run(100);
  rig.held("lift.move", "path00-17", R"(,"target_mm":20,"speed_mm_s":20)");  // stop_pressed
  rig.send(rig.command("lift.clear", "path00-18"));                          // cause_present: the stop
  rig.stopPressed = false;
  note(rig, "the stop is released");
  rig.release();
  rig.run(100);
  rig.send(rig.command("lift.clear", "path00-19"));
  rig.run(100);

  // The switch harness comes unplugged, then is plugged back in (rule 8).
  rig.forceBottom = rig.forceTop = true;
  note(rig, "switch harness unplugged: both read pressed");
  rig.run(100);
  rig.send(rig.command("lift.clear", "path00-20"));  // cause_present: the top reads pressed
  rig.forceBottom = rig.forceTop = false;
  note(rig, "harness plugged back in");
  rig.run(100);
  rig.send(rig.command("lift.clear", "path00-21"));
  // Rule 6: freeing the motor off the bottom switch is refused; on it, it is allowed.
  rig.send(rig.command("lift.enable", "path00-22", R"(,"enabled":false)"));  // disable_unsafe
  rig.run(100);
  rig.forceBottom = true;
  note(rig, "the bottom switch reads pressed (as with the carriage resting on it)");
  rig.run(100);
  rig.send(rig.command("lift.enable", "path00-23", R"(,"enabled":false)"));
  rig.run(100);
  rig.forceBottom = false;
  rig.run(200);
  // The contract's lift.set_position fixture, sent last so it doesn't shift the path's timing. This normal build
  // keeps no saved position to relabel (only the no-switch demo build does), so it is refused invalid_field.
  rig.send(R"({"v":1,"type":"lift.set_position","module_id":"lift-01","seq":311,"request_id":"k3x9q2-10","target_mm":650})");
  rig.run(100);
}

}  // namespace

int main() {
  std::printf("# Sophi lift firmware, scripted session. Generated by firmware/test/session/lift_session_main.cpp; do not edit.\n");
  liftSession();
  return 0;
}
