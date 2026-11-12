"""Tests of the tone squelch (tonesq.py): DCS codewords, CTCSS and DCS detection on synthetic FM audio.

Run: python -m unittest tests.test_tonesq
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from tonesq import DCS_CODES, ToneSquelch, dcs_word, norm_ctcss, norm_dcs  # noqa: E402

FS = 24000.0
BLK = 2048
AMP = 0.05      # ~500 Hz deviation in the receiver's FM audio scale


def rot(w, k):
    return ((w << k) | (w >> (23 - k))) & ((1 << 23) - 1)


def canon(w):
    return min(rot(w, k) for k in range(23))


def run(sig, **kw):
    """Share of blocks with a match."""
    d = ToneSquelch()
    out = [d.process(sig[i:i + BLK], FS, **kw) for i in range(0, len(sig) - BLK + 1, BLK)]
    return float(np.mean(out))


def ctcss(hz, n):
    return AMP * np.sin(2 * np.pi * hz * np.arange(n) / FS)


def dcs(code, n, inv=False):
    w = dcs_word(code)
    bits = np.array([1.0 if w >> i & 1 else -1.0 for i in range(23)]) * (-1 if inv else 1)
    return AMP * bits[np.floor(np.arange(n) / FS * 134.4).astype(int) % 23]


class DcsWordTest(unittest.TestCase):
    def test_standard_codes_are_distinct(self):
        # no standard code is a cyclic shift of another one
        self.assertEqual(len({canon(dcs_word(c)) for c in DCS_CODES}), len(DCS_CODES))

    def test_known_inverse_pair(self):
        # 023N is received as 047I
        m = (1 << 23) - 1
        self.assertEqual(canon(m ^ dcs_word("023")), canon(dcs_word("047")))

    def test_norm(self):
        self.assertEqual(norm_dcs("23i"), "023I")
        self.assertEqual(norm_dcs("754"), "754N")
        self.assertRaises(ValueError, norm_dcs, "024N")
        self.assertEqual(norm_ctcss(88.4), 88.5)


class DetectTest(unittest.TestCase):
    def setUp(self):
        self.rng = np.random.default_rng(1)
        self.n = int(FS * 4)

    def noise(self, sd=0.15):
        return self.rng.normal(0, sd, self.n)

    def test_ctcss(self):
        self.assertGreater(run(ctcss(88.5, self.n) + self.noise(), ctcss_hz=88.5), 0.8)

    def test_ctcss_neighbour(self):
        self.assertEqual(run(ctcss(69.3, self.n) + self.noise(), ctcss_hz=67.0), 0.0)

    def test_dcs(self):
        self.assertGreater(run(dcs("023", self.n) + self.noise(), dcs_code="023N"), 0.8)

    def test_dcs_other_code_and_polarity(self):
        sig = dcs("023", self.n) + self.noise()
        self.assertEqual(run(sig, dcs_code="025N"), 0.0)
        self.assertEqual(run(sig, dcs_code="023I"), 0.0)

    def test_noise_only(self):
        sig = self.rng.normal(0, 0.3, int(FS * 60))
        self.assertEqual(run(sig, ctcss_hz=67.0), 0.0)
        self.assertEqual(run(sig, dcs_code="023N"), 0.0)


if __name__ == "__main__":
    unittest.main()
