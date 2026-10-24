"""Run with: python3 -m unittest discover -s firmware/tools"""

import json
import os
import pty
import select
import subprocess
import sys
import time
import unittest
from pathlib import Path

import press_to_haptic


class PressToHapticTest(unittest.TestCase):
    def test_framing_recovers_after_bad_and_oversized_lines(self):
        pending = bytearray()
        decoded, dropping = press_to_haptic.messages(
            b"boot text\n" + b"x" * 1100 + b'\n{"type":"hello"}\n', pending, False
        )
        self.assertEqual(decoded, [{"type": "hello"}])
        self.assertFalse(dropping)

    def test_release_is_ignored_and_press_sends_bounded_cue(self):
        master, slave = pty.openpty()
        script = Path(__file__).with_name("press_to_haptic.py")
        process = subprocess.Popen(
            [sys.executable, str(script), "--port", os.ttyname(slave)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        )

        def read_command():
            line = bytearray()
            deadline = time.monotonic() + 3
            while time.monotonic() < deadline:
                if select.select([master], [], [], max(0, deadline - time.monotonic()))[0]:
                    line.extend(os.read(master, 256))
                    if b"\n" in line:
                        return json.loads(line.partition(b"\n")[0])
            self.fail("timed out waiting for serial command")

        def report(seq, edge):
            os.write(master, (json.dumps({
                "v": 1, "type": "hand.input", "module_id": "hand-left-01", "seq": seq,
                "uptime_ms": seq * 100, "button": "talk", "edge": edge,
            }) + "\n").encode())

        try:
            self.assertEqual(read_command()["type"], "hello.request")
            # The first request can land during an ESP32 reset; heartbeats must not block retries.
            retried = False
            for seq in range(6):
                os.write(master, (json.dumps({
                    "v": 1, "type": "heartbeat", "module_id": "hand-left-01", "seq": seq,
                    "uptime_ms": seq * 500, "health": "ok",
                }) + "\n").encode())
                if select.select([master], [], [], 0.5)[0]:
                    self.assertEqual(read_command()["type"], "hello.request")
                    retried = True
                    break
            self.assertTrue(retried, "hello request was not retried while heartbeats arrived")
            os.write(master, (json.dumps({
                "v": 1, "type": "hello", "module_id": "hand-left-01", "seq": 0,
                "module_type": "hand", "capabilities": ["button.talk", "haptic"],
            }) + "\n").encode())
            time.sleep(0.1)
            report(1, "released")
            self.assertFalse(select.select([master], [], [], 0.2)[0])
            report(2, "pressed")
            cue = read_command()
            self.assertEqual((cue["type"], cue["pattern"], cue["duration_ms"]),
                             ("haptic.play", "near_obstacle", 1000))
            self.assertEqual(cue["module_id"], "hand-left-01")
        finally:
            process.terminate()
            process.communicate(timeout=3)
            os.close(master)
            os.close(slave)
