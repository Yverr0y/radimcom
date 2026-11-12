"""Tests of the ADS-B / Mode S decoder (adsb.py): parity, field decoding of known messages (the examples of "The 1090
Megahertz Riddle"), CPR positions, and the whole demodulator on synthetic 1090 MHz pulses at several sample rates.

Run: python -m unittest tests.test_adsb
"""
import os
import sys
import time
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import adsb  # noqa: E402

IDENT = "8D4840D6202CC371C32CE0576098"          # KLM1023
POS_EVEN = "8D40621D58C382D690C8AC2863A7"       # airborne position, 38000 ft
POS_ODD = "8D40621D58C386435CC412692AD6"
VEL_GS = "8D485020994409940838175B284F"         # ground speed
VEL_AS = "8DA05F219B06B6AF189400CBC33F"         # airspeed and heading
SURF_EVEN = "8C4841753AAB238733C8CD4020B1"      # surface position
SURF_ODD = "8C4841753A8A35323FAEBDAC702D"


def msg(h):
    return bytes.fromhex(h)


class Fields(unittest.TestCase):
    def test_parity(self):
        for h in (IDENT, POS_EVEN, POS_ODD, VEL_GS, VEL_AS, SURF_EVEN, SURF_ODD):
            self.assertEqual(adsb.parity(msg(h)), 0, h)
        bad = bytearray(msg(IDENT))
        bad[6] ^= 0x10
        self.assertNotEqual(adsb.parity(bytes(bad)), 0)

    def test_bit_syndromes(self):
        bits = np.unpackbits(np.frombuffer(msg(IDENT), np.uint8))[None, :]
        df, nb, syn = adsb.check(bits)
        self.assertEqual((int(df[0]), int(nb[0]), int(syn[0])), (17, 112, 0))
        bits[0, 40] ^= 1
        _, _, syn = adsb.check(bits)
        self.assertEqual(adsb.FIX112[int(syn[0])], 40)

    def test_identification(self):
        r = adsb.decode(msg(IDENT))
        self.assertEqual((r["df"], r["icao"], r["flight"]), (17, "4840D6", "KLM1023"))

    def test_airborne_position(self):
        r = adsb.decode(msg(POS_EVEN))
        self.assertEqual(r["alt"], 38000)
        self.assertFalse(r["odd"])
        o = adsb.decode(msg(POS_ODD))
        lat, lon = adsb.cpr_global(r["cpr"], o["cpr"], newest_odd=False)
        self.assertAlmostEqual(lat, 52.25720, places=4)
        self.assertAlmostEqual(lon, 3.91937, places=4)
        lat, lon = adsb.cpr_local(r["cpr"], False, (52.258, 3.918))
        self.assertAlmostEqual(lat, 52.25720, places=4)
        self.assertAlmostEqual(lon, 3.91937, places=4)

    def test_surface_position(self):
        e, o = adsb.decode(msg(SURF_EVEN)), adsb.decode(msg(SURF_ODD))
        self.assertTrue(e["ground"])
        lat, lon = adsb.cpr_global(e["cpr"], o["cpr"], newest_odd=True, surface=True, ref=(51.990, 4.375))
        self.assertAlmostEqual(lat, 52.32061, places=4)
        self.assertAlmostEqual(lon, 4.73473, places=4)

    def test_velocity(self):
        r = adsb.decode(msg(VEL_GS))
        self.assertAlmostEqual(r["gs"], 159.2, places=1)
        self.assertAlmostEqual(r["track"], 182.9, places=1)
        self.assertEqual(r["vrate"], -832)
        r = adsb.decode(msg(VEL_AS))
        self.assertEqual((r["tas"], r["hdg"], r["vrate"]), (375, 244.0, -2304))

    def test_altitude_and_squawk_replies(self):
        self.assertEqual(adsb.decode(msg("20001838CA3E51"))["alt"], 38000)
        self.assertEqual(adsb.decode(msg("A0001838CA3E51F0A8000047A6E5"))["alt"], 38000)
        self.assertEqual(adsb.squawk(0b1000000000000 >> 1), "1000")
        self.assertEqual(adsb.gillham(0), None)

    def test_nl(self):
        self.assertEqual(adsb._nl(0), 59)
        self.assertEqual(adsb._nl(52.2572), 36)
        self.assertEqual(adsb._nl(88), 1)


def synth(hexes, fs, amp=0.3, noise=0.02, seed=1):
    """uint8 I/Q of an RTL dongle with the messages as 1090 MHz pulses (built at 10× the rate and averaged down)."""
    rng = np.random.default_rng(seed)
    u = 10
    spu = fs * u / 1e6
    gap = 300
    n = int((len(hexes) * (8 + 112 + gap) + 400) * fs / 1e6)
    hr = np.zeros(n * u, np.float32)
    pos = 200 * spu
    for h in hexes:
        bits = np.unpackbits(np.frombuffer(msg(h), np.uint8))
        for p in [0, 1, 3.5, 4.5] + [8 + i + (0 if b else 0.5) for i, b in enumerate(bits)]:
            a = int(round(pos + p * spu))
            hr[a:a + int(round(0.5 * spu))] = 1
        pos += (8 + 112 + gap) * spu + rng.uniform(0, u)
    env = hr.reshape(n, u).mean(axis=1)
    t = np.arange(n) / fs
    z = amp * env * np.exp(2j * np.pi * 150e3 * t) + rng.normal(0, noise, n) + 1j * rng.normal(0, noise, n)
    raw = np.empty(2 * n, np.uint8)
    raw[0::2] = np.clip(np.round(z.real * 127.5 + 127.5), 0, 255)
    raw[1::2] = np.clip(np.round(z.imag * 127.5 + 127.5), 0, 255)
    return raw


class Demodulator(unittest.TestCase):
    def run_rate(self, fs, need=38):
        hexes = [IDENT, POS_EVEN, POS_ODD, VEL_GS] * 10
        raw = synth(hexes, fs)
        events = []
        d = adsb.AdsbDecoder(lambda k, v: events.append(v), lambda i: None, station=lambda: (52.0, 4.4))
        dm = adsb.Demod(fs)
        block = 2 * 65536
        for i in range(0, len(raw), block):
            d._block(dm, adsb.MAG_LUT[raw[i:i + block].view(np.uint16)], time.time())
        self.assertGreaterEqual(d.count, need, f"{fs / 1e6} MS/s")
        ac = {a["icao"]: a for a in d.aircraft_list(False)}
        self.assertEqual(ac["4840D6"]["flight"], "KLM1023")
        self.assertEqual(ac["40621D"]["alt"], 38000)
        self.assertIsNotNone(ac["40621D"]["lat"])
        self.assertAlmostEqual(ac["485020"]["gs"], 159.2, places=1)

    def test_2_4_msps(self):
        self.run_rate(2.4e6)

    def test_2_msps(self):
        self.run_rate(2.0e6, need=24)      # 1 sample per half bit: the phase of the pulses matters, fewer get through

    def test_2_5_msps(self):
        self.run_rate(2.5e6)

    def test_noise_gives_nothing(self):
        rng = np.random.default_rng(3)
        d = adsb.AdsbDecoder(lambda k, v: None, lambda i: None)
        dm = adsb.Demod(2.4e6)
        for _ in range(20):
            raw = np.clip(np.round(rng.normal(0, 0.05, 2 * 131072) * 127.5 + 127.5), 0, 255).astype(np.uint8)
            d._block(dm, adsb.MAG_LUT[raw.view(np.uint16)], time.time())
        self.assertEqual(d.count, 0)


class Range(unittest.TestCase):
    def test_bands_and_merge(self):
        import tempfile
        path = os.path.join(tempfile.mkdtemp(), "adsb_range.json")
        qth, now = (48.15, 17.1), time.time()
        r = adsb.RangeMap(path)
        r.add(qth, 48.9, 17.8, 38000, now)          # high: only "max"
        r.add(qth, 48.3, 17.2, 8000, now)           # low: every band
        r.save(force=True)
        mk = adsb.RangeMap(path).info()["max_km"]
        self.assertLess(mk["10000"], 30)
        self.assertGreater(mk["max"], 90)
        other = adsb.RangeMap(path)                 # another run finds a farther one
        other.add(qth, 49.5, 17.1, 9000, now)
        other.save(force=True)
        r.add(qth, 48.2, 17.1, 5000, now)
        r.save(force=True)                          # merged with the file: the farther one stays
        self.assertGreater(adsb.RangeMap(path).info()["max_km"]["10000"], 140)
        r.add((50.0, 14.4), 50.1, 14.4, 5000, now)  # the station moved: starts again
        self.assertLess(r.info()["max_km"]["max"], 20)


class NetLookup(unittest.TestCase):
    def test_parse_adsb_fi_answer(self):
        import io
        import json
        from unittest import mock
        body = {"ac": [{"hex": "896216", "r": "A6-EOV", "t": "A388", "desc": "AIRBUS A-380-800", "flight": "UAE149  ",
                        "alt_baro": 36000, "gs": 431.2, "track": 290.1, "lat": 48.5, "lon": 16.9, "seen_pos": 1.2}]}
        with mock.patch("urllib.request.urlopen", return_value=io.BytesIO(json.dumps(body).encode())):
            r = adsb.net_lookup("896216")
        self.assertEqual((r["reg"], r["type"], r["callsign"], r["alt"], r["lat"]), ("A6-EOV", "A388", "UAE149", 36000, 48.5))
        with mock.patch("urllib.request.urlopen", return_value=io.BytesIO(b'{"ac": []}')):
            self.assertFalse(adsb.net_lookup("896216")["found"])
        with mock.patch("urllib.request.urlopen", side_effect=OSError("no internet")):
            self.assertIsNone(adsb.net_lookup("896216"))

    def test_net_position_in_range_map(self):
        import tempfile
        d = adsb.AdsbDecoder(lambda k, v: None, lambda i: None, station=lambda: (48.15, 17.1),
                             range_path=os.path.join(tempfile.mkdtemp(), "r.json"))
        now = time.time()
        a = {"lat": None, "alt": 12000, "alt_geo": None, "last": now - 5}
        info = {"lat": 49.0, "lon": 17.1, "seen_pos": 2.0, "alt": 12100, "ground": False}
        d._net_range(a, info, (48.15, 17.1), now)
        r = d.range.info()
        self.assertGreater(r["max_km"]["20000"], 90)
        self.assertIsNone(r["max_km"]["10000"])
        self.assertEqual(next(iter(r["bands"]["max"].values()))[5], 1)        # marked: from adsb.fi
        d.range.clear()
        a["last"] = now - 100                                                   # not heard here lately: not counted
        d._net_range(a, info, (48.15, 17.1), now)
        a["last"], a["lat"] = now, 49.0                                         # has its own position: not counted
        d._net_range(a, info, (48.15, 17.1), now)
        self.assertIsNone(d.range.info()["max_km"]["max"])


if __name__ == "__main__":
    unittest.main()
