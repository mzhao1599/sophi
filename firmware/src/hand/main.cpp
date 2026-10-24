// Hand control firmware (one board per handle): the Talk and Confirm buttons and the haptic cue, speaking
// serial protocol v1 to the Pi. First USB serial bench run is recorded in firmware/README.md.
//
// The only output is the DRV2605L haptic driver. Nothing here can move an arm or the lift. The driver is
// written only by Drv2605Output, and Drv2605Output is called only by the HapticController, which acts only
// on a valid haptic.play from the Pi (see lib/module/haptic.h for the rule 8 limits).
#include <Arduino.h>
#include <Wire.h>

#include "../common/board_serial.h"
#include "debounce.h"
#include "haptic.h"
#include "module_core.h"
#include "provision.h"

namespace {

// ---- Pins (assumptions until the handles are wired; see firmware/README.md) ----
// Each button connects its pin to ground; the internal pull-up holds the pin high, so pressed reads low.
constexpr uint8_t kTalkPin = 32;
constexpr uint8_t kConfirmPin = 33;
// The ESP32 Arduino core's default I2C pins.
constexpr int kSdaPin = 21;
constexpr int kSclPin = 22;
// Placeholder: 100 kHz standard mode, the safe choice for unmeasured wiring.
constexpr uint32_t kI2cHz = 100000;

// ---- DRV2605L (TI datasheet register map) ----
constexpr uint8_t kDrvAddress = 0x5A;  // fixed by the chip
constexpr uint8_t kRegStatus = 0x00;
constexpr uint8_t kRegMode = 0x01;
constexpr uint8_t kRegRealTime = 0x02;
constexpr uint8_t kRegLibrary = 0x03;
constexpr uint8_t kRegSequence = 0x04;  // 0x04 to 0x0B: the eight sequence slots
constexpr uint8_t kRegGo = 0x0C;
constexpr uint8_t kRegOverdrive = 0x0D;
constexpr uint8_t kRegSustainPositive = 0x0E;
constexpr uint8_t kRegSustainNegative = 0x0F;
constexpr uint8_t kRegBrake = 0x10;
constexpr uint8_t kRegFeedback = 0x1A;
constexpr uint8_t kRegControl3 = 0x1D;
// Placeholder: effect library 1 (ERM "Library A") in open loop, as Adafruit's DRV2605L examples use. The
// coin motors are assumed to be ERM (eccentric rotating mass) motors; check the motor's type and rated
// voltage, then pick the library from the datasheet's table.
constexpr uint8_t kEffectLibrary = 1;
// How often to ask the driver whether its sequence has finished, so the I2C bus isn't flooded.
constexpr uint32_t kFinishedPollMs = 5;
// While no cue plays, how often to ask the driver for its status, so haptic_error follows the driver.
constexpr uint32_t kIdleCheckMs = 1000;
// MODE register value for standby: the driver plays nothing until taken out of it.
constexpr uint8_t kModeStandby = 0x40;

bool writeRegister(uint8_t reg, uint8_t value) {
  Wire.beginTransmission(kDrvAddress);
  Wire.write(reg);
  Wire.write(value);
  return Wire.endTransmission() == 0;
}

bool readRegister(uint8_t reg, uint8_t* value) {
  Wire.beginTransmission(kDrvAddress);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(kDrvAddress, static_cast<size_t>(1), true) != 1) return false;
  *value = static_cast<uint8_t>(Wire.read());
  return true;
}

// The DRV2605L in internal-trigger mode: it plays a loaded sequence of its built-in effects when the GO
// bit is set and clears GO when the sequence ends. Real-time and external-trigger modes are never used,
// so the motor runs only while a finite sequence plays, even if the ESP32 stops.
class Drv2605Output : public walker::HapticOutput {
 public:
  // Puts the driver in a known, stopped state. False if it didn't answer as a DRV2605(L) or a write failed;
  // then whatever answered at 0x5A is still told to stop and go to standby, so a chip left playing by
  // earlier firmware can't keep running. Both writes do nothing if no chip answers.
  bool begin() {
    if (setUp()) return true;
    writeRegister(kRegGo, 0x00);
    writeRegister(kRegMode, kModeStandby);
    return false;
  }

  void start(walker::Pattern pattern) override {
    const walker::HapticSequence& sequence = walker::sequenceFor(pattern);
    bool ok = writeRegister(kRegGo, 0x00);
    for (uint8_t slot = 0; slot < 8; ++slot) ok = writeRegister(kRegSequence + slot, sequence.steps[slot]) && ok;
    ok = writeRegister(kRegGo, 0x01) && ok;
    noteTransfer(ok);
    lastCheck_ = millis();
  }

  void stop() override { noteTransfer(writeRegister(kRegGo, 0x00)); }

  bool finished() override {
    const uint32_t now = millis();
    if (now - lastCheck_ < kFinishedPollMs) return false;
    lastCheck_ = now;
    uint8_t go = 1;
    const bool ok = readRegister(kRegGo, &go);
    noteTransfer(ok);
    return ok && (go & 0x01) == 0;
  }

  // Call while no cue plays: once a second, checks the driver is still answering and still in
  // internal-trigger mode. A driver that lost power comes back in standby with its power-on settings and
  // would ignore GO, so it is set up again; the fault stays until that works.
  void checkIdle(uint32_t now) {
    if (now - lastIdleCheck_ < kIdleCheckMs) return;
    lastIdleCheck_ = now;
    uint8_t mode = 0xFF;
    if (!readRegister(kRegMode, &mode)) return noteTransfer(false);
    noteTransfer((mode == 0x00 && configured_) || setUp());
  }

  // The last transfer to the driver failed.
  bool failing() const { return failing_; }

 private:
  // Records whether every step worked, so a half-finished setup is never reported healthy.
  bool setUp() {
    configured_ = configure();
    return configured_;
  }

  bool configure() {
    uint8_t status = 0;
    if (!readRegister(kRegStatus, &status)) return false;
    const uint8_t deviceId = status >> 5;  // 3: DRV2605, 7: DRV2605L
    if (deviceId != 3 && deviceId != 7) return false;
    uint8_t feedback = 0;
    uint8_t control3 = 0;
    bool ok = writeRegister(kRegGo, 0x00) &&    // stop anything playing first
              writeRegister(kRegMode, 0x00) &&  // out of standby, internal trigger
              writeRegister(kRegRealTime, 0x00) &&
              writeRegister(kRegLibrary, kEffectLibrary) && writeRegister(kRegOverdrive, 0x00) &&
              writeRegister(kRegSustainPositive, 0x00) && writeRegister(kRegSustainNegative, 0x00) &&
              writeRegister(kRegBrake, 0x00) && readRegister(kRegFeedback, &feedback) &&
              writeRegister(kRegFeedback, feedback & 0x7F) &&  // ERM, not LRA
              readRegister(kRegControl3, &control3) &&
              writeRegister(kRegControl3, control3 | 0x20);  // ERM open loop
    for (uint8_t slot = 0; ok && slot < 8; ++slot) ok = writeRegister(kRegSequence + slot, 0);
    return ok;
  }

  void noteTransfer(bool ok) { failing_ = !ok; }

  uint32_t lastCheck_ = 0;
  uint32_t lastIdleCheck_ = 0;
  bool failing_ = false;
  bool configured_ = false;
};

board::SerialOutput output;
Drv2605Output driver;
walker::HapticController cue(driver);
walker::Debouncer talk(walker::kButtonDebounceMs, walker::kHandReleaseDebounceMs);
walker::Debouncer confirm(walker::kButtonDebounceMs, walker::kHandReleaseDebounceMs);
walker::ModuleCore* core = nullptr;
bool hasHaptic = false;

const char* const kCapabilitiesWithHaptic[] = {"button.talk", "button.confirm", "haptic"};
const char* const kCapabilitiesWithoutHaptic[] = {"button.talk", "button.confirm"};

void reportEdge(walker::Debouncer::Result result, const char* button, uint32_t now) {
  if (result == walker::Debouncer::Result::None) return;
  core->sendButton(button, result == walker::Debouncer::Result::Pressed ? walker::Edge::Pressed : walker::Edge::Released,
                   now);
}

}  // namespace

void setup() {
  board::beginSerial();
  pinMode(kTalkPin, INPUT_PULLUP);
  pinMode(kConfirmPin, INPUT_PULLUP);
  Wire.begin(kSdaPin, kSclPin, kI2cHz);

  // A driver that doesn't answer now is left alone: no haptic capability in the hello, and every
  // haptic.play is rejected as unsupported, so the Pi falls back to its sound cue.
  hasHaptic = driver.begin();
  static walker::ModuleCore module(
      walker::ModuleIdentity{WALKER_MODULE_ID, walker::ModuleType::Hand, board::kFirmwareVersion,
                             hasHaptic ? kCapabilitiesWithHaptic : kCapabilitiesWithoutHaptic,
                             hasHaptic ? 3u : 2u},
      output, hasHaptic ? &cue : nullptr);
  core = &module;
  core->setFault(walker::Fault::HapticMissing, !hasHaptic);
  core->begin(millis());  // stops the driver, then sends the hello

  // The ESP32's task watchdog restarts the board if loop() stops returning for 5 s; a restart stops the
  // driver again in begin().
  enableLoopWDT();
}

void loop() {
  const uint32_t now = millis();
  board::pumpSerial(*core, now);
  reportEdge(talk.update(digitalRead(kTalkPin) == LOW, now), "talk", now);
  reportEdge(confirm.update(digitalRead(kConfirmPin) == LOW, now), "confirm", now);
  core->poll(now);
  if (hasHaptic && !cue.active()) driver.checkIdle(now);
  core->setFault(walker::Fault::HapticError, driver.failing());
  delay(1);
}
