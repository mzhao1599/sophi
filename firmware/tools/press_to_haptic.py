#!/usr/bin/env python3
"""Bench loopback: buzz the hand module once for each button press over USB serial."""

import argparse
import errno
import fcntl
import json
import os
import select
import struct
import termios
import time


MAX_LINE_BYTES = 1024


def open_serial(port: str) -> int:
    fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        settings = termios.tcgetattr(fd)
        settings[0] = 0  # No input translation or software flow control.
        settings[1] = 0  # No output translation.
        settings[2] = (
            (settings[2] & ~(termios.CSIZE | termios.PARENB | termios.CSTOPB))
            | termios.CS8 | termios.CREAD | termios.CLOCAL
        )
        settings[3] = 0  # Raw mode; the ESP32 protocol supplies its own newlines.
        settings[4] = settings[5] = termios.B115200
        settings[6][termios.VMIN] = 0
        settings[6][termios.VTIME] = 0
        termios.tcsetattr(fd, termios.TCSANOW, settings)
        # Match the Arduino serial monitor; CP2102 boards need modem lines asserted.
        try:
            fcntl.ioctl(fd, termios.TIOCMBIS, struct.pack("I", termios.TIOCM_DTR | termios.TIOCM_RTS))
        except OSError as exc:
            if exc.errno not in (errno.ENOTTY, errno.EINVAL):
                raise
        return fd
    except Exception:
        os.close(fd)
        raise


def send(fd: int, message: dict) -> None:
    data = memoryview((json.dumps(message, separators=(",", ":")) + "\n").encode("utf-8"))
    while data:
        if not select.select([], [fd], [], 2)[1]:
            raise TimeoutError("serial write timed out")
        written = os.write(fd, data)
        if written == 0:
            raise ConnectionError("serial device stopped accepting data")
        data = data[written:]


def messages(data: bytes, pending: bytearray, dropping: bool):
    """Decode one chunk; discard malformed and oversized lines through their newline."""
    parsed = []
    for byte in data:
        if dropping:
            if byte == 10:
                dropping = False
            continue
        if byte == 10:
            try:
                value = json.loads(pending)
                if isinstance(value, dict):
                    parsed.append(value)
            except (UnicodeDecodeError, json.JSONDecodeError):
                pass  # ESP32 boot text is not JSON.
            pending.clear()
        elif len(pending) < MAX_LINE_BYTES - 1:
            pending.append(byte)
        else:
            pending.clear()
            dropping = True
    return parsed, dropping


def run(port: str, module_id: str) -> None:
    fd = open_serial(port)
    pending = bytearray()
    dropping = False
    seq = 0
    ready = False
    next_hello = time.monotonic()
    try:
        print(f"Listening on {port} for {module_id}. Press Ctrl-C to stop.", flush=True)
        while True:
            if not ready and time.monotonic() >= next_hello:
                send(fd, {"v": 1, "type": "hello.request", "module_id": "any", "seq": seq})
                seq += 1
                next_hello = time.monotonic() + 2
            timeout = max(0, next_hello - time.monotonic()) if not ready else None
            if not select.select([fd], [], [], timeout)[0]:
                continue
            chunk = os.read(fd, 256)
            if not chunk:
                raise ConnectionError("serial device disconnected")
            decoded, dropping = messages(chunk, pending, dropping)
            for message in decoded:
                if message.get("module_id") != module_id or message.get("v") != 1:
                    continue
                if message.get("type") == "hello":
                    capabilities = message.get("capabilities")
                    ready = isinstance(capabilities, list) and "haptic" in capabilities
                    if not ready:
                        raise RuntimeError(f"{module_id} did not advertise haptic capability")
                    print("Hand module ready; press Talk or Confirm.", flush=True)
                elif (
                    ready
                    and message.get("type") == "hand.input"
                    and message.get("edge") == "pressed"
                    and message.get("button") in ("talk", "confirm")
                ):
                    request_id = f"press-{seq}"
                    send(fd, {
                        "v": 1, "type": "haptic.play", "module_id": module_id, "seq": seq,
                        "request_id": request_id, "pattern": "near_obstacle", "duration_ms": 1000,
                    })
                    seq += 1
                    print(f"{message['button']} pressed → buzz ({request_id})", flush=True)
                elif message.get("type") == "ack":
                    print(f"{message.get('request_id')}: {message.get('result')}", flush=True)
    finally:
        os.close(fd)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", required=True, help="USB serial port, e.g. /dev/cu.SLAB_USBtoUART")
    parser.add_argument("--module-id", default="hand-left-01", help="expected hand module ID")
    args = parser.parse_args()
    try:
        run(args.port, args.module_id)
    except KeyboardInterrupt:
        print("Stopped.")
    except (OSError, ConnectionError, RuntimeError, TimeoutError) as exc:
        parser.exit(1, f"{exc}\n")
