// Temporary bench image for the assembled ToF board. It reads I2C only; it never drives lift pins.
// Flash the normal `tof` image again before returning the walker to use.
#include <Arduino.h>
#include <Wire.h>

namespace {
constexpr int kSdaPin = 22;  // This board's mux SDA is wired to GPIO22.
constexpr int kSclPin = 21;  // This board's mux SCL is wired to GPIO21.

}  // namespace

void setup() {
  Serial.begin(115200);
  Wire.begin(kSdaPin, kSclPin, 100000);
  Wire.setTimeOut(30);
  delay(250);
  Serial.println("I2C_DIAGNOSTIC_V1");
}

void loop() {
  const int sda = digitalRead(kSdaPin);
  const int scl = digitalRead(kSclPin);
  Wire.beginTransmission(0x70);
  const uint8_t muxError = Wire.endTransmission();
  Serial.printf("I2C root sda=%d scl=%d mux_error=%u uptime=%lu\n", sda, scl, muxError,
                static_cast<unsigned long>(millis()));
  if (muxError == 0) {
    constexpr uint8_t channels[] = {2, 3, 6, 7};
    for (const uint8_t channel : channels) {
      Wire.beginTransmission(0x70);
      Wire.write(static_cast<uint8_t>(1u << channel));
      const uint8_t selectError = Wire.endTransmission();
      uint8_t sensorError = 255;
      if (selectError == 0) {
        Wire.beginTransmission(0x29);
        sensorError = Wire.endTransmission();
      }
      Serial.printf("I2C channel=%u select_error=%u sensor_error=%u uptime=%lu\n", channel,
                    selectError, sensorError, static_cast<unsigned long>(millis()));
    }
  }
  delay(2000);
}
