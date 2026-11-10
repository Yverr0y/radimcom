"""Tests of the HFDL decoder (hfdl.py): system table, bands, channel selection and dumphfdl JSON messages.

Run: python -m unittest tests.test_hfdl
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import hfdl  # noqa: E402

META = {"app": {"name": "dumphfdl", "ver": "1.7.0"}, "t": {"sec": 1762800000, "usec": 500000}, "freq": 8942000,
        "bit_rate": 1200, "sig_level": -21.3, "noise_level": -45.1, "freq_skew": 1.2, "slot": "S"}


def decoder():
    events, states = [], []
    d = hfdl.HfdlDecoder(on_event=lambda k, m: events.append(m), on_state=states.append)
    d.adsb = False
    return d, events


class Table(unittest.TestCase):
    def test_stations(self):
        self.assertGreaterEqual(len(hfdl.STATIONS), 15)
        shannon = next(s for s in hfdl.STATIONS if s["id"] == 7)
        self.assertIn("Shannon", shannon["name"])
        self.assertIn(8942.0, shannon["freqs_khz"])

    def test_bands(self):
        self.assertLess(hfdl.FREQ_MIN_HZ, 3.1e6)
        self.assertGreater(hfdl.FREQ_MAX_HZ, 21.9e6)
        for b in hfdl.BANDS:
            self.assertLessEqual(b["lo"] - 10000, b["center"])
            self.assertLessEqual(b["center"], b["hi"] + 10000)
            # the centre is not on a channel (DC spike)
            self.assertTrue(all(abs(b["center"] - f * 1000) >= 3000 for f in hfdl.CHANNELS))

    def test_channels_in(self):
        ch = hfdl.channels_in(2400000, 8901000)
        self.assertIn(8942000, ch)
        self.assertTrue(all(abs(f - 8901000) < 1200000 for f in ch))
        self.assertEqual(hfdl.channels_in(2400000, 145e6), [])


class Messages(unittest.TestCase):
    def test_squitter(self):
        d, events = decoder()
        d._handle(dict(META, spdu={"err": False, "src": {"type": "Ground station", "id": 7, "name": "Shannon, Ireland"},
                                   "gs_status": []}))
        self.assertEqual(events, [])
        self.assertEqual(d.squitters, 1)
        self.assertEqual(d.info()["heard"][0]["freqs"], [8942.0])

    def test_acars_downlink(self):
        d, events = decoder()
        d._handle(dict(META, lpdu={
            "err": False, "src": {"type": "Aircraft", "id": 12, "ac_info": {"icao": "4ca7b5"}},
            "dst": {"type": "Ground station", "id": 7, "name": "Shannon, Ireland"},
            "type": {"id": 48, "name": "Unnumbered data"},
            "hfnpdu": {"err": False, "type": {"id": 255, "name": "Enveloped data"},
                       "acars": {"err": False, "crc_ok": True, "more": False, "reg": ".EI-FNH", "mode": "2", "label": "H1",
                                 "blk_id": "5", "ack": "!", "flight": "EI105", "msg_num": "M01", "msg_text": "POSN53123W012345"}}}))
        m = events[0]
        self.assertEqual((m["dir"], m["kind"], m["reg"], m["flight"], m["icao"], m["gs"]),
                         ("down", "ACARS", "EI-FNH", "EI105", "4CA7B5", "Shannon, Ireland"))
        self.assertEqual(m["freq_hz"], 8942000)
        self.assertEqual(d.messages()[0]["id"], 1)

    def test_position_report(self):
        d, events = decoder()
        d._handle(dict(META, lpdu={
            "err": False, "src": {"type": "Aircraft", "id": 3}, "dst": {"type": "Ground station", "id": 7},
            "type": {"id": 48, "name": "Unnumbered data"},
            "hfnpdu": {"err": False, "type": {"id": 209, "name": "Performance data"}, "flight_id": "BAW117",
                       "pos": {"lat": 54.25, "lon": -20.5}}}))
        m = events[0]
        self.assertEqual((m["kind"], m["flight"], m["lat"], m["lon"]), ("Performance data", "BAW117", 54.25, -20.5))
        self.assertEqual(m["gs"], hfdl.GS_NAMES[7])      # name from the system table when dumphfdl gives none

    def test_logon_uplink(self):
        d, events = decoder()
        d._handle(dict(META, lpdu={
            "err": False, "src": {"type": "Ground station", "id": 7, "name": "Shannon, Ireland"},
            "dst": {"type": "Aircraft", "id": 0}, "type": {"id": 159, "name": "Logon confirm"},
            "ac_info": {"icao": "3c6589"}, "assigned_ac_id": 21}))
        m = events[0]
        self.assertEqual((m["dir"], m["kind"], m["icao"], m["text"]), ("up", "Logon confirm", "3C6589", "aircraft ID 21"))
        self.assertEqual(d.info()["heard"][0]["id"], 7)

    def test_lookup_key(self):
        rec = {"icao": "4CA7B5", "reg": "EI-FNH", "crc_ok": True}
        self.assertEqual(hfdl._lookup_key(rec), "hex:4CA7B5")
        self.assertEqual(hfdl._lookup_key(dict(rec, icao="")), "reg:EI-FNH")
        self.assertIsNone(hfdl._lookup_key(dict(rec, icao="", crc_ok=False)))

    def test_errors_skipped(self):
        d, events = decoder()
        d._handle(dict(META, lpdu={"err": True}))
        d._handle(dict(META, spdu={"err": True}))
        self.assertEqual((events, d.squitters), ([], 0))


if __name__ == "__main__":
    unittest.main()
