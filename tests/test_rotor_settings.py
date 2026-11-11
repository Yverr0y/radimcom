"""Tests of the station-wide rotor settings (rotor.py: load_settings, save_settings, migrate).

Run: python -m unittest tests.test_rotor_settings
"""
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import rotor  # noqa: E402


def write(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f)


def read(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


class MigrateTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.rot = os.path.join(self.dir.name, "rotor.json")
        self.cfgs = [os.path.join(self.dir.name, f"config_{n}.json") for n in "ABC"]

    def tearDown(self):
        self.dir.cleanup()

    def test_enabled_one_wins_and_all_are_cleaned(self):
        write(self.cfgs[0], {"mode": "FM", "rotor": {"enabled": False, "port": "COM3"}})
        write(self.cfgs[1], {"mode": "AM"})
        write(self.cfgs[2], {"mode": "USB", "rotor": {"enabled": True, "port": "COM11", "usb_serial": "X", "k3ng_az": 222.0}})
        self.assertEqual(rotor.migrate(self.rot, self.cfgs), "config_C.json")
        self.assertEqual(rotor.load_settings(self.rot), {"enabled": True, "port": "COM11", "usb_serial": "X", "k3ng_az": 222.0})
        self.assertEqual(read(self.cfgs[0]), {"mode": "FM"})
        self.assertEqual(read(self.cfgs[2]), {"mode": "USB"})

    def test_nothing_to_move(self):
        write(self.cfgs[0], {"mode": "FM"})
        self.assertIsNone(rotor.migrate(self.rot, self.cfgs))
        self.assertFalse(os.path.exists(self.rot))
        self.assertEqual(rotor.load_settings(self.rot), {})

    def test_existing_file_is_kept(self):
        rotor.save_settings(self.rot, {"enabled": False, "az_cal": [10.0, 460.0], "junk": 1})
        write(self.cfgs[0], {"rotor": {"enabled": True, "port": "COM5"}})
        self.assertIsNone(rotor.migrate(self.rot, self.cfgs))
        self.assertEqual(rotor.load_settings(self.rot), {"enabled": False, "az_cal": [10.0, 460.0]})
        self.assertIn("rotor", read(self.cfgs[0]))

    def test_damaged_file_reads_empty(self):
        with open(self.rot, "w", encoding="utf-8") as f:
            f.write("{bad")
        self.assertEqual(rotor.load_settings(self.rot), {})


if __name__ == "__main__":
    unittest.main()
