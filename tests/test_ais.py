"""Tests of the AIS decoder (ais.py): payload decoding of known NMEA sentences, the NMEA armouring, MMSI countries,
channel selection and the whole DSP chain on a synthetic GMSK burst.

Run: python -m unittest tests.test_ais
"""
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ais  # noqa: E402
import packet  # noqa: E402


def dearmor(payload, fill=0):
    """NMEA payload -> message bytes as the HDLC deframer gives them (LSB first on the air)."""
    bits = ""
    for ch in payload:
        v = ord(ch) - 48
        if v > 40:
            v -= 8
        bits += f"{v:06b}"
    bits = bits[:len(bits) - fill]
    bits = bits[:len(bits) // 8 * 8]
    return bytes(int(bits[k:k + 8][::-1], 2) for k in range(0, len(bits), 8))


# the examples of the gpsd AIVDM documentation
POS_A = "177KQJ5000G?tO`K>RA1wUbN0TKH"                                     # type 1
STATIC = "55?MbV02;H;s<HtKR20EHE:0@T4@Dn2222222216L961O5Gf0NSQEp6ClRp8" + "88888888880"   # type 5 (two parts, fill 2)


class Payload(unittest.TestCase):
    def test_position_class_a(self):
        r = ais.decode(dearmor(POS_A))
        self.assertEqual(r["type"], 1)
        self.assertEqual(r["mmsi"], 477553000)
        self.assertEqual(r["cc"], "hk")
        self.assertEqual(r["status"], "moored")
        self.assertAlmostEqual(r["lat"], 47.5828, places=3)
        self.assertAlmostEqual(r["lon"], -122.3458, places=3)
        self.assertEqual(r["sog"], 0.0)
        self.assertEqual(r["cog"], 51.0)
        self.assertEqual(r["hdg"], 181)

    def test_static_data(self):
        r = ais.decode(dearmor(STATIC, 2))
        self.assertEqual(r["type"], 5)
        self.assertEqual(r["mmsi"], 351759000)
        self.assertEqual(r["cc"], "pa")
        self.assertEqual(r["callsign"], "3FOF8")
        self.assertEqual(r["name"], "EVER DIADEM")
        self.assertEqual(r["shiptype"], "Cargo")
        self.assertEqual(r["dest"], "NEW YORK")
        self.assertEqual(r["imo"], 9134270)
        self.assertEqual(r["draught"], 12.2)
        self.assertEqual(r["size"], "295 × 32 m")

    def test_armor_round_trip(self):
        data = dearmor(POS_A)
        payload, fill = ais.armor(data)
        self.assertEqual(payload, POS_A)
        self.assertEqual(fill, 0)
        self.assertEqual(ais.nmea(payload, fill, "B"), "!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5C")

    def test_short_frame(self):
        self.assertIsNone(ais.decode(b"\x01\x02"))

    def test_mmsi_kinds(self):
        self.assertEqual(ais.mmsi_info(244670316), ("nl", "Netherlands", "ship"))
        self.assertEqual(ais.mmsi_info(2320002)[2], "coast station")
        self.assertEqual(ais.mmsi_info(992471234), ("it", "Italy", "aid to navigation"))
        self.assertEqual(ais.mmsi_info(111232001)[2], "SAR aircraft")
        self.assertEqual(ais.mmsi_info(970123456)[2], "AIS-SART")

    def test_ship_type(self):
        self.assertEqual(ais.ship_type(70), "Cargo")
        self.assertEqual(ais.ship_type(81), "Tanker, hazardous cat. A")
        self.assertEqual(ais.ship_type(36), "Sailing")
        self.assertEqual(ais.ship_type(0), "")


class Channels(unittest.TestCase):
    def test_channels_in(self):
        self.assertEqual(ais.channels_in(2400000, 162000000), [161975000, 162025000])
        self.assertEqual(ais.channels_in(240000, 161975000), [162025000])     # the tuned one is on the DC spike
        self.assertEqual(ais.channels_in(2400000, 145000000), [])


def burst(fs, offset_hz, data, snr_db=20, lead=0.05):
    """A GMSK-like burst of one AIS message at offset_hz in a band sampled at fs, as uint8 I/Q of an RTL dongle."""
    bits, _ = packet.hdlc_encode(data, preamble=4, postamble=2, nrzi=True)
    levels = np.repeat(np.array([1.0 if b else -1.0 for b in bits]), int(round(fs / ais.BAUD)))
    # Gaussian pulse shaping (BT 0.4)
    sps = fs / ais.BAUD
    t = np.arange(-2 * sps, 2 * sps + 1) / sps
    g = np.exp(-2 * np.pi ** 2 * 0.4 ** 2 * t ** 2 / np.log(2))
    levels = np.convolve(levels, g / g.sum(), mode="same")
    phase = np.cumsum(2 * np.pi * 2400.0 * levels / fs)
    sig = np.exp(1j * phase) * np.exp(2j * np.pi * offset_hz * np.arange(len(phase)) / fs)
    n = int(lead * fs)
    x = np.concatenate((np.zeros(n), sig, np.zeros(n))) * 0.3
    rng = np.random.default_rng(1)
    noise = 0.3 * 10 ** (-snr_db / 20) * (rng.standard_normal(len(x)) + 1j * rng.standard_normal(len(x))) / np.sqrt(2)
    x += noise
    iq = np.empty(2 * len(x), np.uint8)
    iq[0::2] = np.clip(np.round(x.real * 127.5 + 127.5), 0, 255)
    iq[1::2] = np.clip(np.round(x.imag * 127.5 + 127.5), 0, 255)
    return iq


class Dsp(unittest.TestCase):
    def run_chain(self, fs, offset):
        data = dearmor(POS_A)
        iq = burst(fs, offset, data)
        ch = ais._Channel(fs, offset)
        frames, peak = [], -99.0
        block = 2 * 131072
        f32 = (iq.astype(np.float32) - 127.5) / 127.5
        for k in range(0, len(f32), block):
            frames += ch.process(f32[k:k + block])
            peak = max(peak, ch.level)
        return data, frames, peak

    def test_decodes_burst_2400k(self):
        data, frames, peak = self.run_chain(2400000, 25000)
        self.assertEqual(frames, [data])
        self.assertGreater(peak, -15)          # the burst is at 0.3 of full scale: about -10 dBFS

    def test_decodes_burst_1024k_negative_offset(self):
        data, frames, _ = self.run_chain(1024000, -25000)
        self.assertEqual(frames, [data])

    def test_decoder_end_to_end(self):
        events, states = [], []
        d = ais.AisDecoder(on_event=lambda k, m: events.append(m), on_state=states.append)
        d.set_enabled(True)
        fs = 2400000
        iq = burst(fs, 25000, dearmor(POS_A))
        d.feed_raw(iq, fs, 162000000)          # first block: the VFO must settle
        import time
        time.sleep(ais.SETTLE_S + 0.1)
        d.feed_raw(iq, fs, 162000000)
        for _ in range(100):
            if events:
                break
            time.sleep(0.05)
        self.assertEqual(len(events), 1)
        m = events[0]
        self.assertEqual(m["mmsi"], 477553000)
        self.assertEqual(m["channel"], "B")
        self.assertEqual(m["freq_hz"], 162025000)
        self.assertEqual(m["nmea"], "!AIVDM,1,1,,B,177KQJ5000G?tO`K>RA1wUbN0TKH,0*5C")
        self.assertEqual(m["ship"]["name"], "")
        self.assertEqual(d.info()["count"], 1)
        self.assertEqual(d.ship_list()[0]["mmsi"], 477553000)
        d.set_enabled(False)


if __name__ == "__main__":
    unittest.main()
