// A lift on the bench, in software: the core, a simulated stepper, and a carriage whose position sets
// the two end switches. Shared by test/test_lift and the scripted lift session.
#pragma once

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

#include "lift_core.h"
#include "sim_stepper.h"

namespace walker {
namespace sim {

// The configuration built into the lift-01 firmware (src/lift/main.cpp) at its default build settings.
constexpr lift::LiftSettings kDefaultSettings{8, 5000, 600000, 20000, 50000, false, 0, lift::WatchdogDriverAction::Hold,
                                              true, false};

struct CaptureOutput : LineOutput {
  std::vector<std::string> lines;
  std::function<void(const std::string&)> onLine;
  // True: the serial port's buffer is full and takes nothing.
  bool full = false;
  bool writeLine(const char* data, size_t length) override {
    if (full) return false;
    std::string line(data, length);
    if (!line.empty() && line.back() == '\n') line.pop_back();
    lines.push_back(line);
    if (onLine) onLine(line);
    return true;
  }
};

struct LiftRig {
  // startMm: where the carriage sits above the bottom switch's trip point at power-up.
  explicit LiftRig(double startMm = 100, lift::LiftSettings settings = kDefaultSettings)
      : settings_(settings),
        stepper(static_cast<int64_t>(startMm * lift::stepsPerMm(settings.microsteps))),
        core({"lift-01", "0.1.0"}, settings, out, stepper) {}

  lift::LiftSettings settings_;
  CaptureOutput out;
  SimStepper stepper;
  lift::LiftCore core;
  uint32_t now = 0;
  // The top switch trips this far above the bottom one (the real rail's is not measured).
  double topSwitchMm = 700;
  // Forced readings, as a broken or unplugged wire would give (true: reads pressed).
  bool forceBottom = false;
  bool forceTop = false;
  // The stop switch's own contact, read by the lift (stop-sense): true while pressed.
  bool stopPressed = false;
  StopSense stop() const {
    if (!settings_.stop_sense_wired) return StopSense::NotWired;
    return stopPressed ? StopSense::Pressed : StopSense::Released;
  }
  // When set, the Pi sends a heartbeat every 100 ms (LIFT_HEARTBEAT_INTERVAL_MS).
  bool heartbeats = false;
  uint32_t piSeq = 1;
  // The session uses these to print: each new millisecond, and each line the Pi sends.
  std::function<void()> onTick;
  std::function<void(const std::string&)> onSend;

  double physicalMm() const {
    return static_cast<double>(stepper.physicalSteps()) / lift::stepsPerMm(settings_.microsteps);
  }
  // A roller switch presses at its trip point and releases a little higher (its hysteresis; not measured).
  int64_t bottomHysteresisSteps = 160;  // 0.5 mm at 8 microsteps
  bool bottomHeld_ = false;
  bool bottom() {
    const int64_t at = stepper.physicalSteps();
    bottomHeld_ = at <= 0 || (bottomHeld_ && at <= bottomHysteresisSteps);
    return forceBottom || bottomHeld_;
  }
  bool top() const {
    return forceTop || stepper.physicalSteps() >= static_cast<int64_t>(topSwitchMm * lift::stepsPerMm(settings_.microsteps));
  }

  void boot() { core.begin(now, bottom(), top(), stop()); }

  void send(const std::string& line) {
    if (onSend) onSend(line);
    const std::string bytes = line + "\n";
    core.receive(reinterpret_cast<const uint8_t*>(bytes.data()), bytes.size(), now);
  }

  // The hold lease the Pi's heartbeats carry: the request a person holds the control for, or "" (null).
  std::string hold;

  std::string heartbeatLine() {
    const std::string lease = hold.empty() ? "null" : "\"" + hold + "\"";
    return R"({"v":1,"type":"lift.heartbeat","module_id":"lift-01","seq":)" + std::to_string(piSeq++) +
           R"(,"hold_request_id":)" + lease + "}";
  }

  // A command line with the next Pi seq.
  std::string command(const std::string& type, const std::string& requestId, const std::string& extra = "") {
    return R"({"v":1,"type":")" + type + R"(","module_id":"lift-01","seq":)" + std::to_string(piSeq++) +
           R"(,"request_id":")" + requestId + "\"" + extra + "}";
  }

  void heartbeat() { send(heartbeatLine()); }

  // What the Pi does for a hold-to-run command: a heartbeat naming it first, then the command (rule 3).
  void held(const std::string& type, const std::string& requestId, const std::string& extra = "") {
    hold = requestId;
    heartbeat();
    send(command(type, requestId, extra));
  }

  // The person lets go: the next heartbeat names nobody.
  void release() {
    hold.clear();
    heartbeat();
  }

  // Advances the clock one millisecond at a time, as the board's loop would.
  void run(uint32_t ms) {
    for (uint32_t i = 0; i < ms; ++i) {
      ++now;
      if (onTick) onTick();
      if (heartbeats && now % 100 == 0) heartbeat();
      stepper.tick();
      core.update(now, bottom(), top(), stop());
    }
  }

  // Runs until `done` holds or `limit` ms pass; returns whether it held.
  bool runUntil(const std::function<bool()>& done, uint32_t limit) {
    for (uint32_t i = 0; i < limit; ++i) {
      if (done()) return true;
      run(1);
    }
    return done();
  }

  // The lines sent since `from`.
  std::vector<std::string> since(size_t from) const {
    return std::vector<std::string>(out.lines.begin() + static_cast<long>(from), out.lines.end());
  }
};

inline bool has(const std::string& line, const std::string& part) { return line.find(part) != std::string::npos; }

}  // namespace sim
}  // namespace walker
