"""Checks of the lift bench tool's lines (python3 -m unittest discover -s firmware/tools).

The contract's own parser checks the same lines in packages/contracts/test/lift-bench-tool.test.ts.
"""

import argparse
import re
import unittest

import lift_bench


def args(command, **extra):
    return argparse.Namespace(command=command, module_id="lift-01", **extra)


class LiftBenchLines(unittest.TestCase):
    def test_request_ids_match_the_contract(self):
        for _ in range(200):
            session = lift_bench.Session()
            self.assertRegex(session.prefix, r"^[0-9a-f]{6}$")
            ids = [session.next_request_id() for _ in range(3)]
            for request_id in ids:
                self.assertRegex(request_id, lift_bench.REQUEST_ID)
            self.assertEqual(ids, [f"{session.prefix}-1", f"{session.prefix}-2", f"{session.prefix}-3"])

    def test_a_held_move_names_itself_first_and_lets_go_with_a_new_stop_id(self):
        session = lift_bench.Session(prefix="ab12cd")
        lines = lift_bench.planned_lines(args("move", target_mm=20.0, speed=5.0), session)
        types = [line["type"] for line in lines]
        self.assertEqual(types, ["hello.request", "lift.heartbeat", "lift.move", "lift.heartbeat", "lift.heartbeat", "lift.stop"])
        self.assertEqual(lines[1]["hold_request_id"], "ab12cd-1")
        self.assertEqual(lines[2]["request_id"], "ab12cd-1")
        self.assertIsNone(lines[4]["hold_request_id"])
        self.assertEqual(lines[5]["request_id"], "ab12cd-2")
        self.assertEqual([line["seq"] for line in lines], list(range(len(lines))))

    def test_every_command_uses_a_valid_id_and_only_contract_fields(self):
        allowed = {
            "hello.request": {"v", "type", "module_id", "seq"},
            "lift.heartbeat": {"v", "type", "module_id", "seq", "hold_request_id"},
            "lift.home": {"v", "type", "module_id", "seq", "request_id"},
            "lift.move": {"v", "type", "module_id", "seq", "request_id", "target_mm", "speed_mm_s"},
            "lift.stop": {"v", "type", "module_id", "seq", "request_id"},
            "lift.clear": {"v", "type", "module_id", "seq", "request_id"},
            "lift.enable": {"v", "type", "module_id", "seq", "request_id", "enabled"},
        }
        for command in (args("status"), args("home"), args("move", target_mm=20.0, speed=5.0), args("stop"),
                        args("clear"), args("enable", state="on"), args("enable", state="off")):
            for line in lift_bench.planned_lines(command, lift_bench.Session()):
                self.assertEqual(set(line), allowed[line["type"]], line)
                if "request_id" in line:
                    self.assertRegex(line["request_id"], lift_bench.REQUEST_ID)
                hold = line.get("hold_request_id")
                if hold is not None:
                    self.assertTrue(re.match(lift_bench.REQUEST_ID, hold), hold)


if __name__ == "__main__":
    unittest.main()
