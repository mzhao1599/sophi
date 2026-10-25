#!/usr/bin/env python3
"""Bounded local jog segments; STOP on exit. Run only with walker service paused."""

import argparse
import time

import serial


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", default="/dev/ttyUSB2")
    parser.add_argument("--direction", type=int, choices=(0, 1), required=True)
    parser.add_argument("--steps", type=int, required=True)
    parser.add_argument("--repeat", type=int, default=1)
    args = parser.parse_args()
    if not 1 <= args.steps <= 320:
        parser.error("steps must be 1..320")
    if not 1 <= args.repeat <= 10:
        parser.error("repeat must be 1..10")

    with serial.Serial(args.port, 115200, timeout=0.05) as port:
        port.reset_input_buffer()
        ready_by = time.monotonic() + 3
        next_status = 0.0
        bad_lines = 0
        while time.monotonic() < ready_by:
            if time.monotonic() >= next_status:
                port.write(b"STATUS\n")
                next_status = time.monotonic() + 0.25
            line = port.readline().decode("utf-8", "replace").strip()
            if line == "READY":
                break
            if line:
                bad_lines += 1
                if bad_lines > 30:
                    raise RuntimeError("unexpected serial flood; no jog sent")
        else:
            raise RuntimeError("controller did not answer STATUS; no jog sent")

        try:
            for segment in range(args.repeat):
                accepted = False
                completed = False
                deadline = time.monotonic() + 5
                next_ping = time.monotonic()
                print(f"segment {segment + 1}/{args.repeat}", flush=True)
                port.write(f"JOG {args.direction} {args.steps}\n".encode("ascii"))
                while time.monotonic() < deadline:
                    now = time.monotonic()
                    if now >= next_ping:
                        port.write(b"PING\n")
                        next_ping = now + 0.05
                    line = port.readline().decode("utf-8", "replace").strip()
                    if line:
                        print(line, flush=True)
                    if line.startswith("ACCEPTED "):
                        accepted = True
                    elif line == f"STOPPED done {args.steps}/{args.steps}":
                        completed = True
                        break
                    elif line.startswith(("REJECTED", "STOPPED ")):
                        break
                if not accepted or not completed:
                    raise RuntimeError("jog did not complete as commanded")
        finally:
            port.write(b"STOP\n")
            port.flush()


if __name__ == "__main__":
    main()
