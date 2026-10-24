#!/usr/bin/env python3
"""Golden vectors for the TypeScript Feetech driver, built by Feetech's Python SDK.

The SDK (`scservo_sdk` from the PyPI package `feetech-servo-sdk`, the one LeRobot installs) writes every
instruction packet into a fake port that records the bytes, and parses hand-built status packets fed to it.
devices/pi/test/feetech-golden.test.ts asserts our encoder and bus produce byte-identical packets and that our
parser agrees with the SDK's verdict on each status packet.

Regenerate (the venv lives outside the repo; nothing else is installed):

    python3 -m venv /tmp/feetech-ref && /tmp/feetech-ref/bin/pip install feetech-servo-sdk==1.0.0
    /tmp/feetech-ref/bin/python -I devices/pi/scripts/feetech_golden.py > devices/pi/test/fixtures/feetech-golden.json
"""

import json
import sys
from importlib.metadata import version

import scservo_sdk as scs

SDK_VERSION = version("feetech-servo-sdk")

# STS3215 control table as LeRobot v0.4.4 lists it (src/lerobot/motors/feetech/tables.py,
# STS_SMS_SERIES_CONTROL_TABLE and STS_SMS_SERIES_ENCODINGS_TABLE), under our field names, with the
# sign bit Feetech's own SDK uses where LeRobot has none (Present_Current: FTServo_Arduino ReadCurrent).
# name: (address, size, sign_bit or None, source)
TABLE = {
    "firmwareMajor": (0, 1, None, "lerobot"),
    "firmwareMinor": (1, 1, None, "lerobot"),
    "modelNumber": (3, 2, None, "lerobot"),
    "id": (5, 1, None, "lerobot"),
    "baudRate": (6, 1, None, "lerobot"),
    "returnDelayTime": (7, 1, None, "lerobot"),
    "responseStatusLevel": (8, 1, None, "lerobot"),
    "minPositionLimit": (9, 2, None, "lerobot"),
    "maxPositionLimit": (11, 2, None, "lerobot"),
    "maxTemperatureLimit": (13, 1, None, "lerobot"),
    "maxVoltageLimit": (14, 1, None, "lerobot"),
    "minVoltageLimit": (15, 1, None, "lerobot"),
    "maxTorqueLimit": (16, 2, None, "lerobot"),
    "phase": (18, 1, None, "lerobot"),
    "unloadingCondition": (19, 1, None, "lerobot"),
    "ledAlarmCondition": (20, 1, None, "lerobot"),
    "pCoefficient": (21, 1, None, "lerobot"),
    "dCoefficient": (22, 1, None, "lerobot"),
    "iCoefficient": (23, 1, None, "lerobot"),
    "minimumStartupForce": (24, 2, None, "lerobot"),
    "cwDeadZone": (26, 1, None, "lerobot"),
    "ccwDeadZone": (27, 1, None, "lerobot"),
    "protectionCurrent": (28, 2, None, "lerobot"),
    "angularResolution": (30, 1, None, "lerobot"),
    "homingOffset": (31, 2, 11, "lerobot"),
    "operatingMode": (33, 1, None, "lerobot"),
    "protectiveTorque": (34, 1, None, "lerobot"),
    "protectionTime": (35, 1, None, "lerobot"),
    "overloadTorque": (36, 1, None, "lerobot"),
    "velocityP": (37, 1, None, "lerobot"),
    "overCurrentProtectionTime": (38, 1, None, "lerobot"),
    "velocityI": (39, 1, None, "lerobot"),
    "torqueEnable": (40, 1, None, "lerobot"),
    "acceleration": (41, 1, None, "lerobot"),
    "goalPosition": (42, 2, 15, "lerobot"),
    "goalTime": (44, 2, None, "lerobot"),
    # LeRobot encodes Goal_Velocity with sign bit 15 (wheel mode's direction); Feetech's WritePosEx and
    # SyncWritePosEx take position-mode speed as a plain u16. Ours is unsigned and refuses bit 15.
    "goalSpeed": (46, 2, None, "lerobot address; unsigned as Feetech WritePosEx (LeRobot: sign bit 15)"),
    "torqueLimit": (48, 2, None, "lerobot"),
    "lock": (55, 1, None, "lerobot"),
    "presentPosition": (56, 2, 15, "lerobot"),
    "presentSpeed": (58, 2, 15, "lerobot Present_Velocity"),
    "presentLoad": (60, 2, 10, "lerobot"),
    "presentVoltage": (62, 1, None, "lerobot"),
    "presentTemperature": (63, 1, None, "lerobot"),
    "asyncWriteFlag": (64, 1, None, "feetech manual (LeRobot's SCS table: Sync_Write_Flag)"),
    "status": (65, 1, None, "lerobot"),
    "moving": (66, 1, None, "lerobot"),
    "presentCurrent": (69, 2, 15, "lerobot address; sign bit from FTServo_Arduino ReadCurrent"),
}

# Sample values to write, logical (signed where the field is sign-magnitude). Some lie outside the range our
# driver accepts (negative or multi-turn goals, speed or acceleration 0 = "maximum"): the test checks our encoder's
# byte layout for them and that FeetechBus refuses them.
WRITE_SAMPLES = {
    "torqueEnable": [0, 1],
    "acceleration": [0, 50, 254],
    "goalPosition": [0, 1, 2048, 4095, -1, -2048, 32767, -32767],
    "goalTime": [0, 1000],
    "goalSpeed": [0, 1, 2400, 3400, 32767],
    "torqueLimit": [0, 500, 1000],
    "id": [1, 6, 253],
    "minPositionLimit": [0, 700],
    "maxPositionLimit": [4095, 3300],
    "homingOffset": [0, 1000, -1000, 2047, -2047],
    "operatingMode": [0, 3],
    "returnDelayTime": [0, 250],
    "lock": [0, 1],
}


class RecordingPort:
    """Stands in for scservo_sdk.PortHandler: records writes, serves queued replies, times out when empty."""

    def __init__(self):
        self.is_using = False
        self.baudrate = 1_000_000
        self.tx_time_per_byte = 0.01
        self.written = []
        self.rx = bytearray()

    def clearPort(self):
        pass

    def writePort(self, packet):
        self.written.append(bytes(packet))
        return len(packet)

    def readPort(self, length):
        chunk = bytes(self.rx[:length])
        del self.rx[:length]
        return chunk

    def setPacketTimeout(self, packet_length):
        pass

    def setPacketTimeoutMillis(self, msec):
        pass

    def isPacketTimeout(self):
        return len(self.rx) == 0

    def getCurrentTime(self):
        return 0.0

    def take(self):
        # A sync read's txPacket leaves the port marked busy until its replies are read; release it here.
        self.is_using = False
        out, self.written = self.written, []
        return [h(p) for p in out]


def h(data):
    return " ".join(f"{b:02x}" for b in data)


def status(scs_id, error, params=()):
    body = [scs_id, len(params) + 2, error, *params]
    return bytes([0xFF, 0xFF, *body, ~sum(body) & 0xFF])


def to_raw(value, sign_bit):
    return scs.SCS_TOSCS(value, sign_bit) if sign_bit is not None else value


def to_bytes(raw, size):
    return [raw] if size == 1 else [scs.SCS_LOBYTE(raw), scs.SCS_HIBYTE(raw)]


def main():
    scs.PacketHandler(0)  # STS/SMS: little-endian (SCS_END = 0)
    ph = scs.PacketHandler(0)
    port = RecordingPort()
    encode = []

    def record(name, op, args, replies=b""):
        port.take()
        port.rx = bytearray(replies)

        def done():
            packets = port.take()
            assert packets, f"the SDK sent nothing for {name}"
            encode.append({"name": name, "op": op, "args": args, "packets": packets})

        return done

    # PING: the SDK pings, then reads the model number (address 3, 2 bytes).
    for scs_id in [0, 1, 2, 3, 4, 5, 6, 252, 253]:
        done = record(f"ping {scs_id}", "ping", {"id": scs_id}, status(scs_id, 0) + status(scs_id, 0, [0x09, 0x03]))
        model, result, error = ph.ping(port, scs_id)
        assert result == scs.COMM_SUCCESS and model == 777, (scs_id, model, result)
        done()

    # READ every field from id 1, and the feedback block from ids 1 and 6.
    for name, (address, size, _, _) in TABLE.items():
        done = record(f"read {name}", "read", {"id": 1, "field": name}, status(1, 0, [0] * size))
        ph.readTxRx(port, 1, address, size)
        done()
    for scs_id in [1, 6]:
        done = record(f"read feedback {scs_id}", "readRaw", {"id": scs_id, "address": 56, "length": 15}, status(scs_id, 0, [0] * 15))
        ph.readTxRx(port, scs_id, 56, 15)
        done()

    # WRITE sample values, acknowledged.
    for name, values in WRITE_SAMPLES.items():
        address, size, sign_bit, _ = TABLE[name]
        for value in values:
            done = record(f"write {name}={value}", "write", {"id": 1, "field": name, "value": value}, status(1, 0))
            raw = to_raw(value, sign_bit)
            if size == 1:
                ph.write1ByteTxRx(port, 1, address, raw)
            else:
                ph.write2ByteTxRx(port, 1, address, raw)
            done()

    # Torque on and off for each joint of an SO-101 (ids 1..6).
    for scs_id in range(1, 7):
        for on in [1, 0]:
            done = record(f"torque {on} id {scs_id}", "write", {"id": scs_id, "field": "torqueEnable", "value": on}, status(scs_id, 0))
            ph.write1ByteTxRx(port, scs_id, 40, on)
            done()

    # Broadcast torque off: no reply.
    done = record("broadcast torque off", "broadcastTorqueOff", {})
    ph.write1ByteTxOnly(port, scs.BROADCAST_ID, 40, 0)
    done()

    # REG_WRITE then ACTION.
    done = record("reg write goal 1", "regWrite", {"id": 1, "field": "goalPosition", "value": 1500}, status(1, 0))
    ph.regWriteTxRx(port, 1, 42, 2, to_bytes(1500, 2))
    done()
    for scs_id in [scs.BROADCAST_ID, 3]:
        done = record(f"action {scs_id}", "action", {"id": scs_id}, status(scs_id, 0) if scs_id != scs.BROADCAST_ID else b"")
        ph.action(port, scs_id)
        done()

    # SYNC READ.
    for ids, address, length in [(list(range(1, 7)), 56, 2), (list(range(1, 7)), 56, 15), ([3, 1, 5], 62, 2), ([1], 40, 1)]:
        reader = scs.GroupSyncRead(port, ph, address, length)
        for scs_id in ids:
            reader.addParam(scs_id)
        done = record(f"sync read {address}+{length} {ids}", "syncRead", {"ids": ids, "address": address, "length": length})
        reader.txPacket()
        done()

    # SYNC WRITE: goal positions, Feetech's SyncWritePosEx block (acc, position, time 0, speed), torque.
    positions = {1: 2048, 2: 1000, 3: 3000, 4: 0, 5: 4095, 6: -100}
    writer = scs.GroupSyncWrite(port, ph, 42, 2)
    for scs_id, pos in positions.items():
        writer.addParam(scs_id, to_bytes(to_raw(pos, 15), 2))
    done = record("sync write goal positions", "syncWriteGoalPositions", {"goals": [{"id": i, "position": p} for i, p in positions.items()]})
    writer.txPacket()
    done()

    goals = [(1, 2048, 2400, 50), (2, 1024, 3400, 1), (3, 3072, 1, 254), (4, 0, 100, 10), (5, 4095, 1, 1), (6, 100, 32767, 100)]
    writer = scs.GroupSyncWrite(port, ph, 41, 7)
    for scs_id, pos, speed, acc in goals:
        p = to_raw(pos, 15)
        writer.addParam(scs_id, [acc, scs.SCS_LOBYTE(p), scs.SCS_HIBYTE(p), 0, 0, scs.SCS_LOBYTE(speed), scs.SCS_HIBYTE(speed)])
    done = record("sync write goals (SyncWritePosEx)", "syncWriteGoals", {"goals": [{"id": i, "position": p, "speed": s, "acceleration": a} for i, p, s, a in goals]})
    writer.txPacket()
    done()

    writer = scs.GroupSyncWrite(port, ph, 40, 1)
    for scs_id in range(1, 7):
        writer.addParam(scs_id, [0])
    done = record("sync write torque off", "syncWrite", {"field": "torqueEnable", "values": [{"id": i, "value": 0} for i in range(1, 7)]})
    writer.txPacket()
    done()

    # ---- Status packets the SDK parses ----
    decode = []

    def read_case(name, scs_id, field, rx):
        address, size, sign_bit, _ = TABLE[field]
        port.take()
        port.rx = bytearray(rx)
        data, result, error = ph.readTxRx(port, scs_id, address, size)
        port.take()
        case = {"name": name, "id": scs_id, "field": field, "rx": h(rx), "result": result, "error": error}
        if result == scs.COMM_SUCCESS:
            raw = data[0] if size == 1 else scs.SCS_MAKEWORD(data[0], data[1])
            case["data"] = list(data)
            case["value"] = scs.SCS_TOHOST(raw, sign_bit) if sign_bit is not None else raw
        decode.append(case)

    samples = {
        "presentPosition": [0, 2048, 4095],
        "presentSpeed": [0, 300, -300, 3400, -3400],
        "presentLoad": [0, 120, -120, 1000, -1000],
        "presentVoltage": [0, 74, 120],
        "presentTemperature": [25, 70],
        "presentCurrent": [0, 15, 500],
        "status": [0, 0x20, 0x25],
        "moving": [0, 1],
        "modelNumber": [777],
        "homingOffset": [0, 1000, -1000, 2047, -2047],
        "goalPosition": [2048, -2048],
        "torqueLimit": [1000],
    }
    for field, values in samples.items():
        _, size, sign_bit, _ = TABLE[field]
        for value in values:
            read_case(f"{field}={value}", 1, field, status(1, 0, to_bytes(to_raw(value, sign_bit), size)))

    good = status(1, 0, to_bytes(2048, 2))
    for bits in [0x01, 0x02, 0x04, 0x08, 0x20, 0x24]:
        read_case(f"error byte {bits:#04x}", 1, "presentPosition", status(1, bits, to_bytes(2048, 2)))
    bad = bytearray(good)
    bad[-1] ^= 0xFF
    read_case("corrupt checksum", 1, "presentPosition", bytes(bad))
    read_case("other id first, then ours", 1, "presentPosition", status(2, 0, to_bytes(100, 2)) + good)
    read_case("garbage before the header", 1, "presentPosition", bytes([0x00, 0x13, 0xFF]) + good)
    read_case("extra FF before the header", 1, "presentPosition", bytes([0xFF]) + good)
    read_case("no reply", 1, "presentPosition", b"")
    read_case("error byte above 0x7f", 1, "presentPosition", status(1, 0x80, to_bytes(2048, 2)))

    # A sync read's replies, parsed by GroupSyncRead.
    sync_cases = []
    for ids, values in [([1, 2, 3, 4, 5, 6], [2048, 1000, 3000, 0, 4095, 17]), ([3, 1, 5], [10, 20, 30])]:
        rx = b"".join(status(i, 0, to_bytes(v, 2)) for i, v in zip(ids, values))
        reader = scs.GroupSyncRead(port, ph, 56, 2)
        for i in ids:
            reader.addParam(i)
        port.take()
        port.rx = bytearray(rx)
        result = reader.rxPacket()
        sync_cases.append({
            "ids": ids,
            "address": 56,
            "length": 2,
            "rx": h(rx),
            "result": result,
            "values": {str(i): reader.getData(i, 56, 2) for i in ids},
        })

    json.dump(
        {
            "about": "Generated by devices/pi/scripts/feetech_golden.py with Feetech's Python SDK; do not edit by hand.",
            "sdk": {"package": "feetech-servo-sdk", "version": SDK_VERSION},
            "comm": {name: getattr(scs, name) for name in ["COMM_SUCCESS", "COMM_RX_TIMEOUT", "COMM_RX_CORRUPT"]},
            "table": {name: {"address": a, "size": s, "signBit": b, "source": src} for name, (a, s, b, src) in TABLE.items()},
            "encode": encode,
            "decode": decode,
            "syncRead": sync_cases,
        },
        sys.stdout,
        indent=1,
    )
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
