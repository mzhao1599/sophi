// Prints a scripted session through the firmware's own code (lib/protocol and lib/module) on a fake
// clock, for the cross-check in packages/contracts/test/firmware-session.test.ts. test/run-native.sh
// checks that test/session/transcript.txt matches what this prints.
//
// Transcript lines:
//   = <module_id> <module_type>   a board boots; the lines below are its session
//   @ <ms>                        the clock; the module lines after it were sent on its own (hello at boot,
//                                 heartbeat, hand.input, perception.zones)
//   > <line>                      a line from the Pi
//   < <line>                      a line from the module; right after a '>' line, they are its replies
//   # <text>                      a note for people (haptic driver calls, raw button levels)
//
// The board-only parts (GPIO, I2C, the DRV2605L and VL53L1X drivers) are replaced by fakes here; nothing
// in this file proves anything about them.
#include <cstdio>
#include <string>
#include <vector>

#include "debounce.h"
#include "haptic.h"
#include "module_core.h"
#include "zone_names.h"
#include "zones.h"

using namespace walker;

namespace {

uint32_t now = 0;
bool stampDue = false;

void stamp() {
  if (stampDue) {
    std::printf("@ %u\n", now);
    stampDue = false;
  }
}

struct PrintOutput : LineOutput {
  bool writeLine(const char* data, size_t length) override {
    stamp();
    std::printf("< %.*s", static_cast<int>(length), data);
    return true;
  }
};

struct PrintHaptic : HapticOutput {
  int finishEvery = 0;  // ms after a start when the fake sequence reports finished; 0 = never
  uint32_t startedAt = 0;
  void start(Pattern pattern) override {
    stamp();
    std::printf("# haptic driver: start %s\n", patternName(pattern));
    startedAt = now;
  }
  void stop() override {
    stamp();
    std::printf("# haptic driver: stop\n");
  }
  bool finished() override { return finishEvery > 0 && now - startedAt >= static_cast<uint32_t>(finishEvery); }
};

PrintOutput output;

void section(const char* moduleId, const char* type) {
  std::printf("= %s %s\n", moduleId, type);
  now = 0;
  stampDue = true;
}

void fromPi(ModuleCore& core, const std::string& line) {
  stamp();
  std::printf("> %s\n", line.c_str());
  const std::string bytes = line + "\n";
  core.receive(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), now);
}

// Moves the clock forward one millisecond at a time, as the board's loop would.
template <typename Tick>
void advanceTo(ModuleCore& core, uint32_t until, Tick tick) {
  while (now < until) {
    ++now;
    stampDue = true;
    tick();
    core.poll(now);
  }
  stampDue = true;
}

void advanceTo(ModuleCore& core, uint32_t until) {
  advanceTo(core, until, [] {});
}

// ---- Pi lines that test the reader. Every line of the contract's fixtures is here too; the vitest
// checks that, so a new fixture line can't be missed. ----

const char* const kPiLines[] = {
    // serial-v1.valid.jsonl
    R"({"v":1,"type":"hello","module_id":"hand-left-01","module_type":"hand","seq":0,"capabilities":["button.primary","trigger","haptic"]})",
    R"({"v":1,"type":"hand.input","module_id":"hand-left-01","seq":42,"uptime_ms":156205,"button":"primary","edge":"pressed","trigger":0.72})",
    R"({"v":1,"type":"perception.zones","module_id":"tof-front-01","seq":83,"uptime_ms":26851,"zones":[{"name":"front_left","mm":610,"quality":"valid"},{"name":"front_right","mm":null,"quality":"invalid"}]})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":74,"request_id":"cue-172","pattern":"near_obstacle","duration_ms":400})",
    R"({"v":1,"type":"ack","module_id":"hand-left-01","seq":75,"request_id":"cue-172","result":"accepted"})",
    R"({"v":1,"type":"heartbeat","module_id":"tof-front-01","seq":84,"uptime_ms":27002,"health":"ok"})",
    R"({"v":1,"type":"hand.input","module_id":"hand-right-01","seq":9,"uptime_ms":30110,"trigger":0.15})",
    R"({"v":1,"type":"ack","module_id":"hand-left-01","seq":76,"request_id":"cue-173","result":"rejected","reason":"invalid_field"})",
    R"({"v":1,"type":"error","module_id":"hand-left-01","seq":77,"code":"malformed"})",
    R"({"v":1,"type":"hello.request","module_id":"any","seq":0})",
    // serial-v1.invalid.json
    R"({"v":1,"type":"hello","module_id":"hand-left-01")",
    R"([1,2,3])",
    R"({"v":2,"type":"heartbeat","module_id":"hand-left-01","seq":1,"uptime_ms":10,"health":"ok"})",
    R"({"v":1,"type":"motor.move","module_id":"hand-left-01","seq":1,"angle":90})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":2,"request_id":"cue-1","pattern":"custom","duration_ms":400})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":3,"request_id":"cue-2","pattern":"error","duration_ms":1001})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":4,"request_id":"cue-3","pattern":"error","duration_ms":400,"waveform":[255,0,255]})",
    R"({"v":1,"type":"perception.zones","module_id":"tof-front-01","seq":5,"uptime_ms":10,"zones":[{"name":"front_left","mm":610,"quality":"invalid"}]})",
    R"({"v":1,"type":"hand.input","module_id":"hand-left-01","seq":6,"uptime_ms":10,"button":"primary"})",
    R"({"v":1,"type":"ack","module_id":"hand-left-01","seq":7,"request_id":"cue-4","result":"rejected"})",
    R"({"v":1,"type":"hello","module_id":"any","module_type":"hand","seq":0,"capabilities":["button.primary"]})",
    R"({"v":1,"type":"hello.request","module_id":"any","seq":3,"rate_hz":20})",
    // R1, R4: each pattern, and the destination rules
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":10,"request_id":"c-conf","pattern":"confirmation","duration_ms":1})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":11,"request_id":"c-rec","pattern":"recording","duration_ms":1000})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":12,"request_id":"c_err","pattern":"error","duration_ms":250})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-right-01","seq":13,"request_id":"other","pattern":"error","duration_ms":250})",
    R"({"v":1,"type":"haptic.play","module_id":"any","seq":14,"request_id":"to-any","pattern":"error","duration_ms":250})",
    R"({"v":1,"type":"hello.request","module_id":"hand-left-01","seq":15})",
    R"({"v":1,"type":"hello.request","module_id":"hand-right-01","seq":16})",
    // R2, R3: bad fields, with and without a readable request_id
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":20,"request_id":"r2-a","pattern":"error","duration_ms":0})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":21,"request_id":"r2-b","pattern":"error","duration_ms":400.5})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":22,"request_id":"r2-c","pattern":"error","duration_ms":"400"})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":23,"request_id":"r2-d","pattern":"error","duration_ms":-1})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":24,"request_id":"r2-e","pattern":"error"})",
    R"({"v":1,"type":"haptic.play","module_id":"Hand-Left-01","seq":25,"request_id":"r2-f","pattern":"error","duration_ms":400})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":26.5,"request_id":"r2-g","pattern":"error","duration_ms":400})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":27,"request_id":"r2-h","pattern":null,"duration_ms":400})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":28,"pattern":"error","duration_ms":400})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":29,"request_id":"has space","pattern":"error","duration_ms":400})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":30,"request_id":"abcdefghijklmnopqrstuvwxyz0123456789ABCDE","pattern":"error","duration_ms":400})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":31,"request_id":"abcdefghijklmnopqrstuvwxyz0123456789ABCD","pattern":"error","duration_ms":400})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":32,"request_id":"","pattern":"error","duration_ms":400})",
    // R7, R8, R9: framing, version, type
    R"(not json)",
    R"(null)",
    R"({})",
    R"({"v":1,})",
    R"({"v":01})",
    R"({"v":"1","type":"hello.request","module_id":"any","seq":0})",
    R"({"type":"hello.request","module_id":"any","seq":0})",
    R"({"v":1.0,"type":"hello.request","module_id":"any","seq":0})",
    R"({"v":1e0,"type":"hello.request","module_id":"any","seq":0})",
    R"({"v":1,"v":2,"type":"hello.request","module_id":"any","seq":0})",
    R"({"v":1,"type":7})",
    R"({"v":1,"module_id":"any","seq":0})",
    R"({"v":1,"type":"HELLO.REQUEST","module_id":"any","seq":0})",
    R"({"v":1,"type":"hello\u0000","module_id":"any","seq":0})",
    // R11: error lines from the Pi
    R"({"v":1,"type":"error","module_id":"hand-left-01","seq":40,"code":"overflow","request_id":"cue-9","detail":"queue full","uptime_ms":5})",
    R"({"v":1,"type":"error","module_id":"hand-left-01","seq":41,"code":"nope"})",
    R"({"v":1,"type":"error","module_id":"hand-left-01","seq":42,"code":"malformed","detail":"café été 🙂"})",
    R"({"v":1,"type":"error","module_id":"hand-left-01","seq":43,"code":"malformed","detail":"été 🙂 ünïcödé"})",
    // R14: escapes, repeated keys, numbers
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":50,"request_id":"cue-50","pattern":"near_obstacle","duration_ms":4e2})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":51,"request_id":"r14-a","pattern":"custom","pattern":"error","duration_ms":400})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":52,"request_id":"r14-b","pattern":"error","pattern":"custom","duration_ms":400})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":-0,"request_id":"r14-c","pattern":"error","duration_ms":400.0})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":9007199254740991,"request_id":"r14-d","pattern":"error","duration_ms":4000E-1})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":9007199254740992,"request_id":"r14-e","pattern":"error","duration_ms":400})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":1e400,"request_id":"r14-f","pattern":"error","duration_ms":400})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":1e-400,"request_id":"r14-g","pattern":"error","duration_ms":400})",
    R"({"v":1.0000000000000001,"type":"haptic.play","module_id":"hand-left-01","seq":1,"request_id":"r14-h","pattern":"error","duration_ms":1000.0000000000001})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":1,"request_id":"r14-i","pattern":"error","duration_ms":999.99999999999999})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":1,"request_id":"r14-j","pattern":"error","duration_ms":400,"x":{"a":[1,{"b":null,"c":[]},"s\""],"d":{}}})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":1,"request_id":"r14-k","pattern":"error","duration_ms":400,"__proto__":{}})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":1,"request_id":"r14-l","pattern":"error","duration_ms":400,"":0})",
    R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":1,"request_id":"r14-m","pattern":"error","duration_ms":true})",
    R"(  {"v" : 1 , "type" : "hello.request" , "module_id" : "any" , "seq" : 0 }  )",
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

// Scrambles a line with printable ASCII only, so the transcript stays plain text. The characters are
// the ones that matter to JSON and to the contract's fields.
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

void handSession() {
  section("hand-left-01", "hand");
  PrintHaptic driver;
  driver.finishEvery = 150;
  HapticController cue(driver);
  const char* caps[] = {"button.talk", "button.confirm", "haptic"};
  ModuleCore core({"hand-left-01", ModuleType::Hand, "0.1.0", caps, 3}, output, &cue);
  core.begin(now);

  // L4: the Pi restarted and asks who is on this port.
  advanceTo(core, 50);
  fromPi(core, R"({"v":1,"type":"hello.request","module_id":"any","seq":0})");

  // B1-B3: Talk pressed with contact bounce at 100-108, held, released at 400; Confirm tapped at 600.
  Debouncer talk, confirm;
  std::printf("# talk: pressed at 100 with bounce until 108, released at 400; confirm: pressed 600 to 700\n");
  auto buttons = [&] {
    const bool talkDown = now >= 100 && now < 400 && !(now >= 103 && now < 105) && now != 107;
    const bool confirmDown = now >= 600 && now < 700;
    const Debouncer::Result t = talk.update(talkDown, now);
    if (t != Debouncer::Result::None) core.sendButton("talk", t == Debouncer::Result::Pressed ? Edge::Pressed : Edge::Released, now);
    const Debouncer::Result c = confirm.update(confirmDown, now);
    if (c != Debouncer::Result::None) {
      core.sendButton("confirm", c == Debouncer::Result::Pressed ? Edge::Pressed : Edge::Released, now);
    }
  };
  advanceTo(core, 800, buttons);

  // H1, H2: a 400 ms near_obstacle cue; the fake sequence finishes every 150 ms, so it restarts twice.
  fromPi(core, R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":1,"request_id":"cue-1","pattern":"near_obstacle","duration_ms":400})");
  advanceTo(core, 1300);

  // H3: a newer cue replaces the one playing.
  fromPi(core, R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":2,"request_id":"cue-2","pattern":"recording","duration_ms":1000})");
  advanceTo(core, 1500);
  fromPi(core, R"({"v":1,"type":"haptic.play","module_id":"hand-left-01","seq":3,"request_id":"cue-3","pattern":"error","duration_ms":300})");
  advanceTo(core, 2600);

  // R1-R14: every reader case, ten milliseconds apart.
  for (const char* line : kPiLines) {
    fromPi(core, line);
    advanceTo(core, now + 10);
  }

  // R12: the longest line (1,023 bytes and its newline) and one byte more.
  std::string longest = R"({"v":1,"type":"hello.request","module_id":"any","seq":0})";
  longest.insert(1, 1023 - longest.size(), ' ');
  fromPi(core, longest);
  advanceTo(core, now + 10);
  fromPi(core, " " + longest);
  advanceTo(core, now + 10);

  // R11 (review): an error's detail is measured in code points, as zod counts it.
  auto repeat = [](const std::string& piece, int times) {
    std::string out;
    for (int i = 0; i < times; ++i) out += piece;
    return out;
  };
  const std::string errorLine = R"({"v":1,"type":"error","module_id":"hand-left-01","seq":44,"code":"malformed","detail":")";
  const std::string emoji = "\xf0\x9f\x99\x82";
  for (const std::string& detail : {repeat(emoji, 61), repeat(emoji, 120), repeat(emoji, 121),
                                    repeat("\\ud83d\\ude42", 70) + std::string(50, 'x'), repeat("\\ud83d", 121)}) {
    fromPi(core, errorLine + detail + "\"}");
    advanceTo(core, now + 10);
  }

  // R15: scrambled lines.
  Random random{0x51ea7u};
  const size_t count = sizeof kPiLines / sizeof kPiLines[0];
  for (int i = 0; i < 200; ++i) {
    fromPi(core, scramble(kPiLines[random.next() % count], random));
    advanceTo(core, now + 5);
  }
  advanceTo(core, now + 1000);
}

void handWithoutDriverSession() {
  section("hand-right-01", "hand");
  // L1, R5: the DRV2605L didn't answer at boot, so no haptic capability and no cue controller.
  const char* caps[] = {"button.talk", "button.confirm"};
  ModuleCore core({"hand-right-01", ModuleType::Hand, "0.1.0", caps, 2}, output, nullptr);
  core.setFault(Fault::HapticMissing, true);
  core.begin(now);
  advanceTo(core, 100);
  fromPi(core, R"({"v":1,"type":"haptic.play","module_id":"hand-right-01","seq":0,"request_id":"cue-1","pattern":"near_obstacle","duration_ms":400})");
  advanceTo(core, 1100);
  fromPi(core, R"({"v":1,"type":"hello.request","module_id":"any","seq":1})");
  advanceTo(core, 2100);
}

void obstacleSession() {
  section("tof-front-01", "perception");
  const char* caps[] = {"zones"};
  ModuleCore core({"tof-front-01", ModuleType::Perception, "0.1.0", caps, 1}, output, nullptr);
  ZoneTracker zones(kZoneNames, kZoneCount);
  zones.begin(now);
  zones.setPresent(0, true);
  zones.setPresent(1, true);
  zones.setPresent(2, true);
  zones.setPresent(3, false);
  core.begin(now);
  std::printf("# front_left: valid, closing from 900 mm; front_right: signal fail (status 2); left: valid 1200 mm "
              "until 500, then silent; right: never answered; front_left reads status 3 (closer than minimum) at "
              "800 and 4001 mm (too far) from 900 to 950\n");
  auto sensors = [&] {
    if (now % 50 == 0) {  // each sensor finishes a measurement every 50 ms
      uint16_t frontLeft = static_cast<uint16_t>(900 - now / 2);
      uint8_t status = 0;
      if (now == 800) status = 3;
      if (now >= 900 && now < 1000) frontLeft = 4001;
      zones.reading(0, status, frontLeft, now);
      zones.reading(1, 2, 0, now);
      if (now <= 500) zones.reading(2, 0, 1200, now);
    }
    core.setFault(Fault::SensorMissing, zones.anyMissing());
    core.setFault(Fault::SensorError, zones.anyError(now));
    core.setCritical(zones.allMissing());
    if (zones.reportDue(now)) {
      Zone out[kMaxTrackedZones];
      core.sendZones(out, zones.snapshot(now, out), now);
    }
  };
  advanceTo(core, 1100, sensors);
  fromPi(core, R"({"v":1,"type":"haptic.play","module_id":"tof-front-01","seq":0,"request_id":"cue-1","pattern":"near_obstacle","duration_ms":400})");
  fromPi(core, R"({"v":1,"type":"hello.request","module_id":"tof-front-01","seq":1})");
  advanceTo(core, 1200, sensors);
}

}  // namespace

int main() {
  std::printf("# Sophi firmware, scripted session. Generated by firmware/test/session/session_main.cpp; do not edit.\n");
  handSession();
  handWithoutDriverSession();
  obstacleSession();
  return 0;
}
