"""Overlay groups of the ROTOR CONTROL map: built-in lists, import check, edit, own groups, reset and delete."""
import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import overlays  # noqa: E402


class OverlayTest(unittest.TestCase):
    def test_builtin_lists_load(self):
        for k in overlays.BUILTIN:
            ov = overlays.normalize(k, overlays._read(overlays.builtin_path(k)))
            self.assertGreater(len(ov["points"]), 10, k)
            self.assertEqual(ov["skipped"], 0, k)
            for p in ov["points"]:
                self.assertTrue(47 < p["lat"] < 51.5 and 12 < p["lon"] < 23, (k, p))   # SK / CZ

    def test_normalize(self):
        ov = overlays.normalize("ham", [{"name": "A", "lat": "48,5", "lng": 17}, {"name": "", "lat": 1, "lon": 2},
                                        {"name": "B", "lat": 99, "lon": 0}, "x", {"name": "C", "lat": 48, "lon": 18, "freq": "145.6"}])
        self.assertEqual([p["name"] for p in ov["points"]], ["A", "C"])
        self.assertEqual(ov["points"][0], {"name": "A", "lat": 48.5, "lon": 17.0})
        self.assertEqual(ov["points"][1]["freq"], 145.6)
        self.assertEqual(ov["skipped"], 3)
        self.assertEqual(ov["color"], overlays.COLORS["ham"])
        with self.assertRaises(ValueError):
            overlays.normalize("ham", {"points": [{"name": "x"}]})
        with self.assertRaises(ValueError):
            overlays.normalize("../x", [])
        with self.assertRaises(ValueError):
            overlays.normalize("fm", {"foo": 1})
        self.assertEqual(overlays.normalize("g1", {"name": "E", "points": []}, allow_empty=True)["points"], [])

    def _tmp(self, d):
        return mock.patch.object(overlays, "custom_dir", lambda: os.path.join(d, "overlays"))

    def test_edit_builtin_and_reset(self):
        with tempfile.TemporaryDirectory() as d, self._tmp(d):
            self.assertFalse(overlays.load("dab")["custom"])
            overlays.save("dab", {"name": "Mine", "points": [{"name": "X", "lat": 48, "lon": 17}]})
            ov = overlays.load("dab")
            self.assertTrue(ov["custom"] and ov["builtin"])
            self.assertEqual((ov["name"], len(ov["points"])), ("Mine", 1))
            with open(overlays.custom_path("dab"), "w", encoding="utf-8") as f:
                f.write("{broken")
            ov = overlays.load("dab")
            self.assertFalse(ov["custom"])
            self.assertIn("broken", ov["error"])
            overlays.reset("dab")
            self.assertFalse(os.path.exists(overlays.custom_path("dab")))
            self.assertEqual([g["id"] for g in overlays.load_all()], ["dab", "fm", "ham"])

    def test_own_groups(self):
        with tempfile.TemporaryDirectory() as d, self._tmp(d):
            a = overlays.create({"name": "Beacons"})
            b = overlays.create({})
            self.assertEqual((a["id"], b["id"]), ("g1", "g2"))
            self.assertEqual(b["name"], "Group 2")
            self.assertNotEqual(a["color"], b["color"])
            overlays.save("g1", {"name": "Beacons 2m", "color": "#123456",
                                 "points": [{"name": "OK0EA", "lat": 50.1, "lon": 14.4, "freq": 144.4}]})
            groups = overlays.load_all()
            self.assertEqual([g["id"] for g in groups], ["dab", "fm", "ham", "g1", "g2"])
            g1 = groups[3]
            self.assertEqual((g1["name"], g1["color"], len(g1["points"]), g1["builtin"]), ("Beacons 2m", "#123456", 1, False))
            self.assertEqual(g1["created"], a["created"])        # the order stays after an edit
            overlays.delete("g1")
            self.assertEqual([g["id"] for g in overlays.load_all()], ["dab", "fm", "ham", "g2"])
            with self.assertRaises(ValueError):
                overlays.save("g1", {"points": []})              # deleted: no such group
            self.assertEqual(overlays.create({})["id"], "g1")


if __name__ == "__main__":
    unittest.main()
