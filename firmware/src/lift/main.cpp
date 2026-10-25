// Lift firmware (one board, lift-01): drives the TB6600-type stepper driver's STEP, DIR and ENA inputs and
// speaks the lift serial contract to the Pi. The demo build shares this ESP32 with two ToF sensors and uses
// a journaled position estimate without switches. Its motor path has not yet been run on the assembled lift.
//
// Everything that decides what the lift does is in lib/lift/lift_core.* (tested on a computer). This file
// only sets the pins, wraps FastAccelStepper as the core's StepperPort, and reads the inputs.
// Normal installations put a hardware stop contact in the STEP signal, outside this code. The current demo
// does not have that contact; it needs a person observing every move while direction and travel are verified.
#include <Arduino.h>
#include <FastAccelStepper.h>
#include <Preferences.h>
#include <esp_task_wdt.h>
#if WALKER_LIFT_WITH_TOF
#include <VL53L1X.h>
#include <Wire.h>
#include "module_core.h"
#include "zone_names.h"
#include "zones.h"
#endif

#include "../common/board_serial.h"
#include "build_settings.h"
#include "lift_core.h"
#include "lift_protocol.h"

namespace {

namespace build = walker::lift::build;

Preferences positionStore;
bool positionStoreOpen = false;
bool positionDirty = false;

// Placeholder: the pause FastAccelStepper leaves between a DIR change and the next step. TB6600-type
// datasheets ask for about 5 µs; 50 µs is generous until the unit's timing is checked.
constexpr uint16_t kDirChangeDelayUs = 50;

// The core's motor: FastAccelStepper for the pulses (hardware timers, exact step count), the ENA pin by hand.
class FasStepper : public walker::lift::StepperPort {
 public:
  void attach(FastAccelStepper* stepper) { stepper_ = stepper; }

  void setDriverEnabled(bool enabled) override {
    digitalWrite(build::kEnablePin, enabled ? build::kEnableLevel : build::kDisableLevel);
  }

  bool moveTo(int32_t target, uint32_t speed, uint32_t accel) override {
    if (stepper_ == nullptr) return false;
    if (stepper_->setSpeedInHz(speed) != 0) return false;
    if (stepper_->setAcceleration(static_cast<int32_t>(accel)) != 0) return false;
    if (build::kEstimatedDemo && target != stepper_->getCurrentPosition()) {
      if (!positionStoreOpen || positionStore.putBool("valid", false) != 1) return false;
      positionDirty = true;
    }
    return stepper_->moveTo(target) == MOVE_OK;
  }

  void decelerate(uint32_t accel) override {
    if (stepper_ == nullptr) return;
    stepper_->setAcceleration(static_cast<int32_t>(accel));
    stepper_->applySpeedAcceleration();
    stepper_->stopMove();
  }

  // No further step is issued; the count is what was sent so far.
  void halt() override {
    if (stepper_ != nullptr) stepper_->forceStopAndNewPosition(stepper_->getCurrentPosition());
  }

  bool running() const override { return stepper_ != nullptr && stepper_->isRunning(); }
  int32_t position() const override { return stepper_ != nullptr ? stepper_->getCurrentPosition() : 0; }
  void setPosition(int32_t steps) override {
    if (stepper_ != nullptr) stepper_->setCurrentPosition(steps);
  }

 private:
  FastAccelStepper* stepper_ = nullptr;
};

FastAccelStepperEngine engine;
FasStepper motor;
board::SerialOutput output;
walker::lift::LiftCore* core = nullptr;

// Set by the stop-sense interrupt on every edge to pressed, so a tap shorter than one loop still counts.
#if WALKER_LIFT_WITH_TOF
constexpr uint8_t kMuxAddress = 0x70;
constexpr uint8_t kSensorChannels[walker::kZoneCount] = {2, 3, 6, 7};
#ifndef WALKER_TOF_ACTIVE_SENSORS
#define WALKER_TOF_ACTIVE_SENSORS 4
#endif
static_assert(WALKER_TOF_ACTIVE_SENSORS >= 1 && WALKER_TOF_ACTIVE_SENSORS <= walker::kZoneCount,
              "active ToF count must fit the configured channel map");
constexpr size_t kActiveSensorCount = WALKER_TOF_ACTIVE_SENSORS;
constexpr const char* kTofCapabilities[] = {"zones"};
walker::ModuleCore tofCore({"tof-front-01", walker::ModuleType::Perception,
                            board::kFirmwareVersion, kTofCapabilities, 1}, output, nullptr);
walker::ZoneTracker zones(walker::kZoneNames, kActiveSensorCount);
VL53L1X sensors[walker::kZoneCount];
uint32_t lastResult[walker::kZoneCount] = {};
char serialLine[walker::kMaxLineBytes + 1] = {};
size_t serialUsed = 0;

bool selectChannel(size_t i) {
  Wire.beginTransmission(kMuxAddress);
  Wire.write(static_cast<uint8_t>(1u << kSensorChannels[i]));
  return Wire.endTransmission() == 0;
}

bool setUpSensor(size_t i) {
  if (!selectChannel(i)) return false;
  VL53L1X& sensor = sensors[i];
  sensor = VL53L1X();
  sensor.setBus(&Wire);
  sensor.setTimeout(100);
  if (!sensor.init()) return false;
  if (!sensor.setDistanceMode(VL53L1X::Long) || !sensor.setMeasurementTimingBudget(50000)) return false;
  sensor.startContinuous(50);
  return sensor.last_status == 0;
}

void pollSensors(uint32_t now) {
  for (size_t i = 0; i < kActiveSensorCount; ++i) {
    if (!zones.present(i)) continue;
    if (!selectChannel(i)) { zones.readFailed(i); continue; }
    VL53L1X& sensor = sensors[i];
    const bool ready = sensor.dataReady();
    if (sensor.last_status != 0) { zones.readFailed(i); continue; }
    if (ready) {
      sensor.read(false);
      if (sensor.last_status != 0) { zones.readFailed(i); continue; }
      lastResult[i] = now;
      zones.reading(i, static_cast<uint8_t>(sensor.ranging_data.range_status), sensor.ranging_data.range_mm, now);
    }
    if (now - lastResult[i] >= 500) zones.setPresent(i, false);
  }
  // A full VL53L1X reinitialization can take longer than the lift's one-second task watchdog
  // if an I2C branch is flaky. Report it missing until reboot rather than blocking motion control.
  tofCore.setFault(walker::Fault::SensorMissing, zones.anyMissing());
  tofCore.setFault(walker::Fault::SensorError, zones.anyError(now));
  tofCore.setCritical(zones.allMissing());
  if (zones.reportDue(now)) {
    walker::Zone readings[walker::kMaxTrackedZones];
    tofCore.sendZones(readings, zones.snapshot(now, readings), now);
  }
  tofCore.poll(now);
}

void pumpCombinedSerial(uint32_t now) {
  for (int n = 0; n < 256 && Serial.available() > 0; ++n) {
    const char c = static_cast<char>(Serial.read());
    if (serialUsed >= sizeof(serialLine) - 1) serialUsed = 0;
    serialLine[serialUsed++] = c;
    if (c != '\n') continue;
    serialLine[serialUsed] = '\0';
    const auto* bytes = reinterpret_cast<const uint8_t*>(serialLine);
    if (strstr(serialLine, "\"type\":\"hello.request\"") != nullptr) {
      char liftTarget[64];
      snprintf(liftTarget, sizeof(liftTarget), "\"module_id\":\"%s\"", WALKER_MODULE_ID);
      const bool forAny = strstr(serialLine, "\"module_id\":\"any\"") != nullptr;
      if (forAny || strstr(serialLine, liftTarget) != nullptr) core->receive(bytes, serialUsed, now);
      if (forAny || strstr(serialLine, "\"module_id\":\"tof-front-01\"") != nullptr) {
        tofCore.receive(bytes, serialUsed, now);
      }
    } else if (strstr(serialLine, "\"type\":\"lift.") != nullptr) {
      core->receive(bytes, serialUsed, now);
    } else {
      tofCore.receive(bytes, serialUsed, now);
    }
    serialUsed = 0;
  }
}
#endif

volatile bool stopTripped = false;

void IRAM_ATTR onStopEdge() { stopTripped = true; }

// Normally closed to GND with the pull-up: closed (released) reads LOW; pressed, or a cut wire, reads HIGH.
bool bottomPressed() { return !build::kEstimatedDemo && digitalRead(build::kBottomPin) == HIGH; }
bool topPressed() { return build::kSettings.has_top_switch && digitalRead(build::kTopPin) == HIGH; }

walker::StopSense stopSense() {
  if (!build::kStopSenseWired) return walker::StopSense::NotWired;
  noInterrupts();
  const bool tripped = stopTripped;
  stopTripped = false;
  interrupts();
  const bool pressed = tripped || digitalRead(build::kStopSensePin) == HIGH;
  return pressed ? walker::StopSense::Pressed : walker::StopSense::Released;
}

}  // namespace

void setup() {
  // Rule 1 first: step output low, driver left enabled (holding), before anything else runs.
  digitalWrite(build::kStepPin, LOW);
  pinMode(build::kStepPin, OUTPUT);
  digitalWrite(build::kEnablePin, build::kEnableLevel);
  pinMode(build::kEnablePin, OUTPUT);
  if (!build::kEstimatedDemo) pinMode(build::kBottomPin, INPUT_PULLUP);
  if (build::kSettings.has_top_switch) pinMode(build::kTopPin, INPUT_PULLUP);
  if (build::kStopSenseWired) {
    pinMode(build::kStopSensePin, INPUT_PULLUP);
    // Pressed opens the contact, so the pin rises.
    attachInterrupt(digitalPinToInterrupt(build::kStopSensePin), onStopEdge, RISING);
  }

  board::beginSerial();
  engine.init();
  FastAccelStepper* stepper = engine.stepperConnectToPin(build::kStepPin);
  if (stepper != nullptr) {
    stepper->setDirectionPin(build::kDirPin, WALKER_LIFT_DIR_UP_LEVEL == 1, kDirChangeDelayUs);
    stepper->setAutoEnable(false);  // ENA is the core's alone
    stepper->setCurrentPosition(0);
  }
  // A step generator that didn't start leaves the motor holding: every homing fails (homing_failed).
  motor.attach(stepper);

  static walker::lift::LiftCore lift({WALKER_MODULE_ID, board::kFirmwareVersion}, build::kSettings, output, motor,
                                     !build::kEstimatedDemo);
  core = &lift;
  core->begin(millis(), bottomPressed(), topPressed(), stopSense());
#if WALKER_LIFT_WITH_TOF
  Wire.begin(22, 21, 100000);
  Wire.setTimeOut(30);
  for (size_t i = 0; i < kActiveSensorCount; ++i) {
    zones.setPresent(i, setUpSensor(i));
    lastResult[i] = millis();
  }
  zones.begin(millis());
  tofCore.begin(millis());
#endif
  if (build::kEstimatedDemo) {
    positionStoreOpen = positionStore.begin("sophi_lift", false);
    if (positionStoreOpen && !positionStore.isKey("steps")) {
      // shortcut: this one-time origin is the owner-confirmed 5 mm physical position; recheck it if the lift is moved by hand.
      const int32_t initialSteps = static_cast<int32_t>(walker::lift::milliMmToSteps(5000, build::kSettings.microsteps));
      positionStoreOpen = positionStore.putInt("steps", initialSteps) == sizeof(initialSteps) &&
                          positionStore.putBool("valid", true) == 1;
    }
    if (positionStoreOpen && positionStore.getBool("valid", false)) {
      core->assumePosition(positionStore.getInt("steps", -1), millis());
    }
  }

  // The ESP32's task watchdog restarts the board if loop() stops returning for 1 s (the core's default is
  // 5 s). FastAccelStepper's pulses come from hardware timers and its own task, so a frozen loop doesn't stop
  // a running move: it goes on towards its target (no lease or switch checks) until this reset. A restart
  // floats ENA (enabled, holding, with the default polarity and wiring) and stops the pulses; setup() then
  // starts again from rule 1.
  esp_task_wdt_init(1, true);
  enableLoopWDT();
}

void loop() {
  const uint32_t now = millis();
  // Inputs first, so a stop or switch pressed since the last loop is seen before a command is accepted.
  core->update(now, bottomPressed(), topPressed(), stopSense());
#if WALKER_LIFT_WITH_TOF
  pumpCombinedSerial(now);
  pollSensors(now);
#else
  board::pumpSerial(*core, now);
#endif
  if (build::kEstimatedDemo && positionDirty && core->state() == walker::LiftState::Idle &&
      core->homed() && !motor.running()) {
    const int32_t steps = motor.position();
    if (positionStore.putInt("steps", steps) == sizeof(steps) && positionStore.putBool("valid", true) == 1) {
      positionDirty = false;
    }
  }
  delay(1);
}
