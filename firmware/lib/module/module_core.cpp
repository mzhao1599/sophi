#include "module_core.h"

namespace walker {

namespace {

const char* const kFaultNames[kFaultCount] = {
    "line_not_built", "tx_dropped", "haptic_missing", "haptic_error", "sensor_missing", "sensor_error",
};

}  // namespace

const char* faultName(Fault fault) { return kFaultNames[static_cast<size_t>(fault)]; }

ModuleCore::ModuleCore(const ModuleIdentity& identity, LineOutput& output, HapticController* haptic)
    : identity_(identity), output_(output), haptic_(haptic) {}

void ModuleCore::begin(uint32_t now) {
  if (haptic_ != nullptr) haptic_->begin(now);
  nextHeartbeat_ = now + kHeartbeatIntervalMs;
  sendHello(now);
}

void ModuleCore::poll(uint32_t now) {
  if (haptic_ != nullptr) haptic_->poll(now);
  if (static_cast<int32_t>(now - nextHeartbeat_) >= 0) {
    nextHeartbeat_ += kHeartbeatIntervalMs;
    // After a long stall, send one heartbeat rather than a burst.
    if (static_cast<int32_t>(now - nextHeartbeat_) >= 0) nextHeartbeat_ = now + kHeartbeatIntervalMs;
    sendHeartbeat(now);
  }
}

void ModuleCore::receive(const uint8_t* data, size_t length, uint32_t now) {
  for (size_t i = 0; i < length; ++i) {
    switch (reader_.push(data[i])) {
      case LineReader::Event::Line:
        handleLine(reader_.line(), reader_.length(), now);
        break;
      case LineReader::Event::Oversize:
        sendError(Problem::Oversize, nullptr, now);
        break;
      case LineReader::Event::None:
        break;
    }
  }
}

void ModuleCore::handleLine(const char* line, size_t length, uint32_t now) {
  if (isBlankLine(line, length)) return;
  const PiLine command = parsePiLine(line, length);

  switch (command.problem) {
    case Problem::None:
      break;
    case Problem::InvalidField:
      if (command.type == MessageType::HapticPlay && command.has_request_id) {
        sendAck(command.request_id, Problem::InvalidField, now);
      } else {
        sendError(Problem::InvalidField, nullptr, now);
      }
      return;
    case Problem::Unsupported:
      sendError(Problem::Unsupported, "a type modules send; a module never acts on it", now);
      return;
    default:
      sendError(command.problem, nullptr, now);
      return;
  }

  // A valid line: the Pi is there.
  if (haptic_ != nullptr) haptic_->heardFromPi(now);
  const bool forThisModule = sameText(command.module_id, identity_.module_id);
  switch (command.type) {
    case MessageType::HelloRequest:
      if (forThisModule || sameText(command.module_id, kAnyModule)) {
        sendHello(now);
      } else {
        sendError(Problem::InvalidField, "module_id names another module", now);
      }
      return;
    case MessageType::HapticPlay:
      if (!forThisModule) {
        sendAck(command.request_id, Problem::InvalidField, now);
      } else if (haptic_ == nullptr) {
        sendAck(command.request_id, Problem::Unsupported, now);
      } else if (haptic_->play(command.pattern, command.duration_ms, now)) {
        sendAck(command.request_id, Problem::None, now);
      } else {
        sendAck(command.request_id, Problem::InvalidField, now);
      }
      return;
    default:
      // A valid error line from the Pi. Never answered, so two sides can't bounce errors forever.
      return;
  }
}

bool ModuleCore::sendButton(const char* button, Edge edge, uint32_t now) {
  return emit(buildHandInput(tx_, sizeof tx_, identity_.module_id, seq_, now, button, edge));
}

bool ModuleCore::sendZones(const Zone* zones, size_t count, uint32_t now) {
  return emit(buildZones(tx_, sizeof tx_, identity_.module_id, seq_, now, zones, count));
}

void ModuleCore::setFault(Fault fault, bool active) {
  const uint8_t mask = static_cast<uint8_t>(1u << static_cast<uint8_t>(fault));
  faults_ = static_cast<uint8_t>(active ? (faults_ | mask) : (faults_ & ~mask));
}

void ModuleCore::sendHello(uint32_t now) {
  HelloFields hello{identity_.module_id,   seq_, identity_.type, identity_.capabilities,
                    identity_.capability_count, identity_.firmware_version, now};
  emit(buildHello(tx_, sizeof tx_, hello));
}

void ModuleCore::sendHeartbeat(uint32_t now) {
  const char* names[kFaultCount];
  size_t count = 0;
  for (size_t f = 0; f < kFaultCount; ++f) {
    if (hasFault(static_cast<Fault>(f))) names[count++] = kFaultNames[f];
  }
  const Health health = critical_ ? Health::Fault : count > 0 ? Health::Degraded : Health::Ok;
  const bool reportsDrop = hasFault(Fault::TxDropped);
  const size_t length = buildHeartbeat(tx_, sizeof tx_, identity_.module_id, seq_, now, health, names, count);
  // The drop is reported once this heartbeat is out; a drop of this heartbeat sets it again.
  if (emit(length) && reportsDrop) setFault(Fault::TxDropped, false);
}

void ModuleCore::sendAck(const char* requestId, Problem reason, uint32_t now) {
  emit(buildAck(tx_, sizeof tx_, identity_.module_id, seq_, requestId, reason, now));
}

void ModuleCore::sendError(Problem code, const char* detail, uint32_t now) {
  emit(buildError(tx_, sizeof tx_, identity_.module_id, seq_, code, detail, now));
}

bool ModuleCore::emit(size_t length) {
  if (length == 0) {
    setFault(Fault::LineNotBuilt, true);
    return false;
  }
  ++seq_;
  if (!output_.writeLine(tx_, length)) {
    setFault(Fault::TxDropped, true);
    return false;
  }
  return true;
}

}  // namespace walker
