#include <Arduino.h>

namespace {
constexpr uint8_t kStep = 33;
constexpr uint8_t kDir = 25;
constexpr uint8_t kEnable = 26;
constexpr uint32_t kStepIntervalUs = 1250;  // 800 pulses/s; bench only, with the carriage observed and travel clear.
constexpr uint32_t kLinkTimeoutMs = 200;
constexpr uint32_t kMoveTimeoutMs = 5000;
constexpr uint16_t kMaxSteps = 320;

char line[32] = {};
size_t lineLength = 0;
bool moving = false;
uint16_t targetSteps = 0;
uint16_t sentSteps = 0;
uint32_t startedMs = 0;
uint32_t lastKeepaliveMs = 0;
uint32_t nextStepUs = 0;

void stop(const char* reason) {
  digitalWrite(kStep, LOW);
  if (moving) Serial.printf("STOPPED %s %u/%u\n", reason, sentSteps, targetSteps);
  moving = false;
}

void command(const char* text) {
  if (strcmp(text, "STATUS") == 0) {
    Serial.println("READY");
    return;
  }
  if (strcmp(text, "PING") == 0) {
    lastKeepaliveMs = millis();
    return;
  }
  if (strcmp(text, "STOP") == 0) {
    stop("operator");
    return;
  }
  int direction = -1;
  unsigned int steps = 0;
  char tail = '\0';
  if (sscanf(text, "JOG %d %u %c", &direction, &steps, &tail) != 2 ||
      (direction != 0 && direction != 1) || steps == 0 || steps > kMaxSteps || moving) {
    Serial.println("REJECTED");
    return;
  }
  digitalWrite(kDir, direction);
  targetSteps = static_cast<uint16_t>(steps);
  sentSteps = 0;
  startedMs = millis();
  lastKeepaliveMs = startedMs;
  nextStepUs = micros() + kStepIntervalUs;
  moving = true;
  Serial.printf("ACCEPTED dir=%d steps=%u\n", direction, steps);
}
}  // namespace

void setup() {
  digitalWrite(kStep, LOW);
  pinMode(kStep, OUTPUT);
  digitalWrite(kDir, LOW);
  pinMode(kDir, OUTPUT);
  digitalWrite(kEnable, LOW);  // Bench wiring: LOW enables/holds; verify driver polarity before use.
  pinMode(kEnable, OUTPUT);
  Serial.begin(115200);
  Serial.println("WALKER JOG READY max_steps=320 rate=800Hz link_timeout=200ms");
}

void loop() {
  while (Serial.available() > 0) {
    const char byte = static_cast<char>(Serial.read());
    if (byte == '\n') {
      line[lineLength] = '\0';
      command(line);
      lineLength = 0;
    } else if (byte != '\r') {
      if (lineLength < sizeof(line) - 1) line[lineLength++] = byte;
      else lineLength = 0;
    }
  }

  if (moving) {
    const uint32_t nowMs = millis();
    if (nowMs - lastKeepaliveMs > kLinkTimeoutMs) stop("link_timeout");
    else if (nowMs - startedMs > kMoveTimeoutMs) stop("move_timeout");
    else if (static_cast<int32_t>(micros() - nextStepUs) >= 0) {
      digitalWrite(kStep, HIGH);
      delayMicroseconds(10);
      digitalWrite(kStep, LOW);
      ++sentSteps;
      nextStepUs += kStepIntervalUs;
      if (sentSteps >= targetSteps) stop("done");
    }
  }
  delay(1);
}
