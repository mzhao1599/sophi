// Obstacle sensor firmware (one board): four VL53L1X time-of-flight sensors behind a TCA9548A I2C
// multiplexer, reported to the Pi as perception.zones. Not yet run on hardware; wiring is in
// firmware/README.md. These are proximity readings for cues, not collision avoidance: a zone that can't
// be trusted is sent as invalid (unknown), never as clear.
#include <Arduino.h>
#include <VL53L1X.h>
#include <Wire.h>

#include "../common/board_serial.h"
#include "module_core.h"
#include "provision.h"
#include "zone_names.h"
#include "zones.h"

namespace {

// ---- Wiring (assumptions until the board is wired; see firmware/README.md) ----
constexpr int kSdaPin = 21;
constexpr int kSclPin = 22;
// Placeholder: 100 kHz standard mode, the safe choice for sensor leads of unmeasured length.
constexpr uint32_t kI2cHz = 100000;
// TCA9548A with A0, A1 and A2 tied low. Sensor i sits on channel i and keeps the VL53L1X's default
// address 0x29, so no XSHUT pins are needed.
constexpr uint8_t kMuxAddress = 0x70;

// ---- Sensor settings (placeholders, not measured) ----
// Long distance mode with a 50 ms timing budget, one measurement every 50 ms (20 Hz per sensor).
constexpr uint32_t kTimingBudgetUs = 50000;
constexpr uint32_t kMeasurePeriodMs = 50;
// The library's own timeout for one blocking step during setup.
constexpr uint16_t kSensorTimeoutMs = 100;
// A sensor that has produced no result for this long counts as missing until it answers a fresh setup,
// whether its transfers fail or it has stopped measuring (for example after a brownout reset it). A failing
// sensor reads invalid at once either way; this only decides when to set it up again.
constexpr uint32_t kMissingAfterSilentMs = 500;
// How often one missing sensor is set up again (a loose plug pushed back in comes back). One at a time, so
// a setup that waits on a slow sensor stalls the loop for at most one sensor's setup.
constexpr uint32_t kRetryMissingMs = 1000;

board::SerialOutput output;
const char* const kCapabilities[] = {"zones"};
walker::ModuleCore core(walker::ModuleIdentity{WALKER_MODULE_ID, walker::ModuleType::Perception,
                                               board::kFirmwareVersion, kCapabilities, 1},
                        output, nullptr);
walker::ZoneTracker zones(walker::kZoneNames, walker::kZoneCount);
VL53L1X sensors[walker::kZoneCount];
uint32_t lastResult[walker::kZoneCount] = {};
uint32_t lastRetry = 0;
size_t nextRetry = 0;

bool selectChannel(size_t channel) {
  Wire.beginTransmission(kMuxAddress);
  Wire.write(static_cast<uint8_t>(1u << channel));
  return Wire.endTransmission() == 0;
}

// Sets one sensor up and starts it measuring. False if it didn't answer.
bool setUpSensor(size_t i) {
  if (!selectChannel(i)) return false;
  VL53L1X& sensor = sensors[i];
  sensor.setBus(&Wire);
  sensor.setTimeout(kSensorTimeoutMs);
  if (!sensor.init()) return false;
  if (!sensor.setDistanceMode(VL53L1X::Long) || !sensor.setMeasurementTimingBudget(kTimingBudgetUs)) return false;
  sensor.startContinuous(kMeasurePeriodMs);
  return sensor.last_status == 0;
}

void setUp(size_t i) {
  // A fresh driver object: the library redoes its calibration step only on a new one.
  sensors[i] = VL53L1X();
  zones.setPresent(i, setUpSensor(i));
  lastResult[i] = millis();
}

// Reads sensor i if it has a new result, without waiting for one. True when it got a result.
bool readSensor(size_t i, uint32_t now) {
  if (!selectChannel(i)) return zones.readFailed(i), false;
  VL53L1X& sensor = sensors[i];
  const bool ready = sensor.dataReady();
  if (sensor.last_status != 0) return zones.readFailed(i), false;
  if (!ready) return false;
  sensor.read(false);
  if (sensor.last_status != 0) return zones.readFailed(i), false;
  lastResult[i] = now;
  zones.reading(i, static_cast<uint8_t>(sensor.ranging_data.range_status), sensor.ranging_data.range_mm, now);
  return true;
}

void poll(size_t i, uint32_t now) {
  if (!zones.present(i) || readSensor(i, now)) return;
  if (now - lastResult[i] >= kMissingAfterSilentMs) zones.setPresent(i, false);
}

}  // namespace

void setup() {
  board::beginSerial();
  Wire.begin(kSdaPin, kSclPin, kI2cHz);
  for (size_t i = 0; i < walker::kZoneCount; ++i) setUp(i);
  const uint32_t now = millis();
  zones.begin(now);
  lastRetry = now;
  core.begin(now);
  // The ESP32's task watchdog restarts the board if loop() stops returning for 5 s.
  enableLoopWDT();
}

void loop() {
  const uint32_t now = millis();
  board::pumpSerial(core, now);
  for (size_t i = 0; i < walker::kZoneCount; ++i) poll(i, now);

  if (now - lastRetry >= kRetryMissingMs) {
    lastRetry = now;
    for (size_t step = 0; step < walker::kZoneCount; ++step) {
      const size_t i = (nextRetry + step) % walker::kZoneCount;
      if (!zones.present(i)) {
        setUp(i);
        nextRetry = (i + 1) % walker::kZoneCount;
        break;
      }
    }
  }

  core.setFault(walker::Fault::SensorMissing, zones.anyMissing());
  core.setFault(walker::Fault::SensorError, zones.anyError(now));
  core.setCritical(zones.allMissing());
  if (zones.reportDue(now)) {
    walker::Zone readings[walker::kMaxTrackedZones];
    core.sendZones(readings, zones.snapshot(now, readings), now);
  }
  core.poll(now);
  delay(1);
}
