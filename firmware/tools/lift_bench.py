#!/usr/bin/env python3
"""Bench loopback for the lift board: send one lift command over USB serial and print what the lift says.

Not the Pi's motion coordinator, and not run against a board yet. It speaks the lift's serial lines
(packages/contracts/src/lift-serial.ts) from a computer so the bench procedure in firmware/README.md can run
before the Pi side exists:

  - Request ids are a fresh six-character boot prefix and a counter (`3fa91c-1`, `3fa91c-2`, ...), as the
    Pi's are, so each run's ids are new to the lift.
  - It sends `lift.heartbeat` every 100 ms (LIFT_HEARTBEAT_INTERVAL_MS) the whole time it runs.
  - For `home` and `move` it is hold-to-run: the heartbeats name the request while the script keeps running,
    for at most --hold-seconds (10 by default). Ctrl-C is letting go: the next heartbeat names nobody and a
    `lift.stop` follows, so the lift ramps down and holds.
  - It prints every lift.ack and lift.done, and each lift.status whose state, switches or faults changed.
  - --print-lines prints the lines it would send, without a port (the contract tests parse them).

Examples (from the repository root):
  python3 firmware/tools/lift_bench.py --port /dev/cu.SLAB_USBtoUART status
  python3 firmware/tools/lift_bench.py --port /dev/cu.SLAB_USBtoUART enable off
  python3 firmware/tools/lift_bench.py --port /dev/cu.SLAB_USBtoUART home
  python3 firmware/tools/lift_bench.py --port /dev/cu.SLAB_USBtoUART move 20 --speed 5
"""

import argparse
import json
import os
import re
import secrets
import select
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from press_to_haptic import messages, open_serial, send  # noqa: E402  (same folder; standard library only)

HEARTBEAT_S = 0.1
# LiftRequestIdSchema (lift-serial.ts).
REQUEST_ID = re.compile(r"^[a-z0-9]{6}-[1-9][0-9]{0,8}$")


class Session:
    """Builds the Pi lines for one run: one seq counter, one boot prefix, request ids counting from 1."""

    def __init__(self, module_id: str = "lift-01", prefix=None):
        self.module_id = module_id
        self.prefix = prefix if prefix is not None else secrets.token_hex(3)  # six of [0-9a-f]
        self.seq = 0
        self.counter = 0
        self.hold = None

    def _line(self, message: dict) -> dict:
        message = {"v": 1, **message, "module_id": self.module_id, "seq": self.seq}
        self.seq += 1
        return message

    def next_request_id(self) -> str:
        self.counter += 1
        return f"{self.prefix}-{self.counter}"

    def hello_request(self) -> dict:
        return self._line({"type": "hello.request"})

    def heartbeat(self) -> dict:
        return self._line({"type": "lift.heartbeat", "hold_request_id": self.hold})

    def command(self, kind: str, request_id: str, **fields) -> dict:
        return self._line({"type": kind, "request_id": request_id, **fields})


def build_command(args, session: Session, request_id: str):
    if args.command == "home":
        return session.command("lift.home", request_id)
    if args.command == "move":
        return session.command("lift.move", request_id, target_mm=args.target_mm, speed_mm_s=args.speed)
    if args.command == "stop":
        return session.command("lift.stop", request_id)
    if args.command == "clear":
        return session.command("lift.clear", request_id)
    if args.command == "enable":
        return session.command("lift.enable", request_id, enabled=args.state == "on")
    return None


def planned_lines(args, session: Session):
    """The lines a run sends when nothing answers and it is let go after one heartbeat (for --print-lines)."""
    held = args.command in ("home", "move")
    request_id = session.next_request_id()
    lines = [session.hello_request()]
    if held:
        session.hold = request_id
    lines.append(session.heartbeat())
    command = build_command(args, session, request_id)
    if command is not None:
        lines.append(command)
    lines.append(session.heartbeat())
    if held:
        session.hold = None
        lines.append(session.heartbeat())
        lines.append(session.command("lift.stop", session.next_request_id()))
    return lines


def summary(status: dict) -> str:
    limits = status.get("limits", {})
    return (
        f"{status.get('state')} homed={status.get('homed')} position_mm={status.get('position_mm')} "
        f"target_mm={status.get('target_mm')} driver={'on' if status.get('driver_enabled') else 'off'} "
        f"top={limits.get('top')} bottom={limits.get('bottom')} stop={status.get('stop_sense')} "
        f"faults={status.get('faults')} request={status.get('request_id')}"
    )


def run(args) -> None:
    fd = open_serial(args.port)
    session = Session(args.module_id)
    pending = bytearray()
    dropping = False
    request_id = session.next_request_id()
    held = args.command in ("home", "move")
    last_summary = None
    sent_command = False
    finished = False
    deadline = time.monotonic() + (args.hold_seconds if held else args.listen_seconds)
    next_beat = time.monotonic()
    try:
        send(fd, session.hello_request())
        while True:
            now = time.monotonic()
            if now >= deadline or finished:
                break
            if now >= next_beat:
                if not sent_command and held:
                    session.hold = request_id  # rule 4: the heartbeat naming the request goes first
                send(fd, session.heartbeat())
                next_beat = now + HEARTBEAT_S
                command = build_command(args, session, request_id) if not sent_command else None
                if command is not None:
                    send(fd, command)
                    print(f"> {command['type']} {request_id}", flush=True)
                sent_command = True
            if not select.select([fd], [], [], max(0.0, min(next_beat, deadline) - time.monotonic()))[0]:
                continue
            chunk = os.read(fd, 512)
            if not chunk:
                raise ConnectionError("serial device disconnected")
            decoded, dropping = messages(chunk, pending, dropping)
            for message in decoded:
                kind = message.get("type")
                if kind == "lift.hello":
                    print(f"< lift.hello {message.get('module_id')} config={message.get('config')} "
                          f"stop_sense={message.get('stop_sense')}", flush=True)
                elif kind == "lift.status":
                    text = summary(message)
                    if text != last_summary:
                        print(f"< status {text}", flush=True)
                        last_summary = text
                elif kind in ("lift.ack", "lift.done", "error"):
                    shown = {k: v for k, v in message.items() if k not in ("v", "type", "module_id")}
                    print(f"< {kind} {shown}", flush=True)
                    if kind == "lift.done" and message.get("request_id") == request_id:
                        finished = True
                    if kind == "lift.ack" and message.get("request_id") == request_id and message.get("result") == "rejected":
                        finished = True
    except KeyboardInterrupt:
        print("Let go.", flush=True)
    finally:
        try:
            if held and sent_command and not finished:
                session.hold = None
                send(fd, session.heartbeat())  # names nobody: the lift ramps down and holds (rule 5)
                send(fd, session.command("lift.stop", session.next_request_id()))
                print("> lift.stop", flush=True)
        finally:
            os.close(fd)


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--port", help="USB serial port, e.g. /dev/cu.SLAB_USBtoUART")
    p.add_argument("--module-id", default="lift-01")
    p.add_argument("--hold-seconds", type=float, default=10, help="longest a home or move is held (default 10)")
    p.add_argument("--listen-seconds", type=float, default=3, help="how long other commands listen (default 3)")
    p.add_argument("--print-lines", action="store_true", help="print the lines it would send and exit (no port)")
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("status", help="send heartbeats and print the lift's status")
    sub.add_parser("home", help="home, held while the script runs")
    move = sub.add_parser("move", help="move to a height, held while the script runs")
    move.add_argument("target_mm", type=float)
    move.add_argument("--speed", type=float, default=5, help="mm/s (default 5)")
    sub.add_parser("stop")
    sub.add_parser("clear")
    enable = sub.add_parser("enable")
    enable.add_argument("state", choices=["on", "off"])
    return p


if __name__ == "__main__":
    command_line = parser()
    arguments = command_line.parse_args()
    if arguments.print_lines:
        for line in planned_lines(arguments, Session(arguments.module_id)):
            print(json.dumps(line, separators=(",", ":")))
        sys.exit(0)
    if not arguments.port:
        command_line.exit(2, "--port is required\n")
    try:
        run(arguments)
    except (OSError, ConnectionError, TimeoutError) as exc:
        command_line.exit(1, f"{exc}\n")
