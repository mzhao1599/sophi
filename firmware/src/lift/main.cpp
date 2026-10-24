// Lift firmware (one board, lift-01): drives the TB6600-type stepper driver's STEP, DIR and ENA inputs and
// reads the two end switches and the stop's sense contact, speaking the lift's serial lines
// (packages/contracts/src/lift-serial.ts) to the Pi. Not yet run on hardware: nothing about the driver,
// motor, screw or switches has been measured.
//
// Everything that decides what the lift does is in lib/lift/lift_core.* (tested on a computer). This file
// only sets the pins, wraps FastAccelStepper as the core's StepperPort, and reads the inputs.
// The hardware stop switch cuts the STEP signal between GPIO25 and the driver (firmware/README.md), outside
// this code: with it pressed no pulse reaches the driver, whatever this firmware does, and the motor holds.
#include <Arduino.h>
#include <FastAccelStepper.h>
#include <esp_task_wdt.h>

#include "../common/board_serial.h"
#include "build_settings.h"
#include "lift_core.h"
#include "lift_protocol.h"

namespace {

namespace build = walker::lift::build;

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
volatile bool stopTripped = false;

void IRAM_ATTR onStopEdge() { stopTripped = true; }

// Normally closed to GND with the pull-up: closed (released) reads LOW; pressed, or a cut wire, reads HIGH.
bool bottomPressed() { return digitalRead(build::kBottomPin) == HIGH; }
bool topPressed() { return digitalRead(build::kTopPin) == HIGH; }

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
  pinMode(build::kBottomPin, INPUT_PULLUP);
  pinMode(build::kTopPin, INPUT_PULLUP);
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

  static walker::lift::LiftCore lift({WALKER_MODULE_ID, board::kFirmwareVersion}, build::kSettings, output, motor);
  core = &lift;
  core->begin(millis(), bottomPressed(), topPressed(), stopSense());

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
  board::pumpSerial(*core, now);
  delay(1);
}
