"""Tests of the APRS parse (aprs.py) on the examples of the APRS 1.0.1 specification and typical packets.

Run: python -m unittest tests.test_aprs
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import aprs  # noqa: E402


def P(info, dest="APRS"):
    return aprs.parse(dest, info.encode("latin-1"))


class Positions(unittest.TestCase):
    def test_uncompressed(self):
        a = P("!4903.50N/07201.75W-Test 001234")
        self.assertEqual(a["type"], "position")
        self.assertAlmostEqual(a["lat"], 49.05833, places=4)
        self.assertAlmostEqual(a["lon"], -72.02917, places=4)
        self.assertEqual((a["sym"], a["comment"], a["messaging"]), ("/-", "Test 001234", False))

    def test_timestamp_course_speed_altitude(self):
        a = P("@092345z4903.50N/07201.75W>088/036/A=001234 mobile")
        self.assertEqual((a["timestamp"], a["sym"], a["course"]), ("092345z", "/>", 88))
        self.assertAlmostEqual(a["speed"], 36 * 1.852, places=1)
        self.assertEqual(a["alt_m"], round(1234 * 0.3048))
        self.assertEqual(a["comment"], "mobile")
        self.assertTrue(a["messaging"])

    def test_ambiguity(self):
        a = P("!4903.  N/07201.  W-")
        self.assertEqual(a["ambiguity"], 2)
        self.assertAlmostEqual(a["lat"], 49 + 3.5 / 60, places=4)

    def test_compressed(self):
        a = P("=/5L!!<*e7>7P[")
        self.assertAlmostEqual(a["lat"], 49.5, places=3)
        self.assertAlmostEqual(a["lon"], -72.75, places=3)
        self.assertEqual((a["sym"], a["course"]), ("/>", 88))
        self.assertAlmostEqual(a["speed"], 36.2 * 1.852, delta=0.3)

    def test_mic_e(self):
        a = P('`(_fn"Oj/', dest="S32U6T")
        self.assertAlmostEqual(a["lat"], 33 + 25.64 / 60, places=4)
        self.assertAlmostEqual(a["lon"], -(12 + 7.74 / 60), places=4)
        self.assertEqual((a["course"], a["sym"]), (251, "/j"))
        self.assertAlmostEqual(a["speed"], 20 * 1.852, places=1)

    def test_object_and_item(self):
        a = P(";LEADER   *092345z4903.50N/07201.75W>088/036")
        self.assertEqual((a["type"], a["name"], a["killed"]), ("object", "LEADER", False))
        a = P(")AID #2!4903.50N/07201.75WA")
        self.assertEqual((a["type"], a["name"], a["sym"]), ("item", "AID #2", "/A"))


class Others(unittest.TestCase):
    def test_weather_positionless(self):
        a = P("_10090556c220s004g005t077r000p000P000h50b09900wRSW")
        w = a["weather"]
        self.assertEqual((a["type"], w["wind_dir"], w["temp"], w["humidity"], w["pressure"]),
                         ("weather", 220, 25.0, 50, 990.0))
        self.assertAlmostEqual(w["wind"], 4 * 1.609344, places=1)

    def test_weather_with_position(self):
        a = P("!4903.50N/07201.75W_220/004g005t077r000p000P000h50b09900wRSW")
        self.assertEqual(a["type"], "weather")
        self.assertEqual((a["weather"]["wind_dir"], a["weather"]["temp"]), (220, 25.0))
        self.assertIn("25.0 °C", aprs.summary(a))

    def test_message(self):
        a = P(":OM2AMR   :Hello{12")
        self.assertEqual((a["type"], a["to"], a["text"], a["msgno"]), ("message", "OM2AMR", "Hello", "12"))
        self.assertEqual(P(":OM2AMR   :ack12")["ack"], "ack")
        self.assertEqual(P(":OM2AMR-1 :PARM.Volt,Temp")["type"], "telemetry")

    def test_status_telemetry(self):
        self.assertEqual(P(">Net tonight")["text"], "Net tonight")
        a = P("T#005,199,000,255,073,123,01101001")
        self.assertEqual((a["seq"], a["values"][0], a["bits"]), ("005", 199.0, "01101001"))

    def test_not_aprs(self):
        self.assertIsNone(aprs.parse("APRS", b""))
        self.assertIsNone(P("!garbage"))
        self.assertEqual(P("xyz")["type"], "other")

    def test_distance(self):
        km, brg = aprs.distance_bearing(48.0, 17.0, 49.0, 17.0)
        self.assertAlmostEqual(km, 111.2, delta=0.2)
        self.assertEqual(brg, 0)


if __name__ == "__main__":
    unittest.main()
