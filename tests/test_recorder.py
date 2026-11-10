"""Tests of the recordings list (recorder.py): file names, the list for the RECORDINGS tab and deleting.

Run: python -m unittest tests.test_recorder
"""
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import recorder  # noqa: E402


class ParseNameTest(unittest.TestCase):
    def test_memory_name(self):
        f = recorder.parse_name("Piestany_TWR_118.575000MHz_AM_20261105_155300.mp3")
        self.assertEqual(f, {"memory": "Piestany TWR", "hz": 118575000, "mode": "AM", "start": "2026-11-05 15:53:00"})

    def test_plain_and_numbered(self):
        f = recorder.parse_name("134.475670MHz_AM_20261110_221021_2.mp3")
        self.assertEqual((f["memory"], f["hz"], f["mode"], f["start"]), ("", 134475670, "AM", "2026-11-10 22:10:21"))

    def test_foreign_file(self):
        self.assertEqual(recorder.parse_name("song.mp3"), {"memory": "", "hz": 0, "mode": "", "start": ""})


class FilesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.rec = recorder.Recorder(self.tmp.name)
        self.old = os.path.join(self.tmp.name, "145.500000MHz_FM_20261105_155300.mp3")
        self.new = os.path.join(self.tmp.name, "Piestany_TWR_118.575000MHz_AM_20261105_160000.mp3")
        with open(self.old, "wb") as f:
            f.write(b"\0" * 16000)      # 1 s at 128 kbps
        with open(self.new, "wb") as f:
            f.write(b"\0" * 32000)
        os.utime(self.old, (1_700_000_000, 1_700_000_000))
        os.utime(self.new, (1_700_000_100, 1_700_000_100))
        with open(os.path.join(self.tmp.name, "notes.txt"), "w") as f:
            f.write("x")

    def tearDown(self):
        self.rec.stop_all(0)
        self.tmp.cleanup()

    def test_list_newest_first(self):
        files = self.rec.files()
        self.assertEqual([f["name"] for f in files], [os.path.basename(self.new), os.path.basename(self.old)])
        self.assertEqual((files[0]["memory"], files[0]["secs"], files[0]["size"], files[0]["writing"]), ("Piestany TWR", 2, 32000, False))
        self.assertEqual((files[1]["hz"], files[1]["mode"], files[1]["secs"]), (145500000, "FM", 1))

    def test_missing_folder(self):
        self.assertEqual(recorder.Recorder(os.path.join(self.tmp.name, "none")).files(), [])

    def test_delete(self):
        self.rec.delete(os.path.basename(self.old))
        self.assertFalse(os.path.exists(self.old))
        with self.assertRaises(ValueError):
            self.rec.delete("nothing.mp3")
        with self.assertRaises(ValueError):
            self.rec.delete("../notes.txt")

    def test_delete_while_writing(self):
        t = self.rec.tracks["cont"]
        t.enc, t.file = object(), os.path.basename(self.new)
        self.assertTrue(self.rec.files()[0]["writing"])
        with self.assertRaises(ValueError):
            self.rec.delete(os.path.basename(self.new))
        t.enc = None


if __name__ == "__main__":
    unittest.main()
