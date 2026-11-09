"""Tests of the packet demodulators (packet.py, stages 2 and 3) on synthetic FM baseband.

The generators make what the receiver sees after its decimation: complex baseband at fs/DECIM with the tuned
frequency at 0 Hz, noise, a tuning error, pre-emphasis (1200 Bd) and Gaussian shaping (9600 Bd GFSK).
Run: python -m unittest tests.test_packet_demod
"""
import base64
import os
import sys
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import packet  # noqa: E402

RATES = (2048000 / 64, 2400000 / 64, 2500000 / 64, 1024000 / 64)   # baseband of the usual sample rates


def frames(n, seed=0):
    rnd = np.random.default_rng(seed)
    out = []
    for i in range(n):
        info = b"!4832.%02dN/01755.00E>frame %d " % (i % 60, i) + bytes(rnd.integers(32, 127, 40, dtype=np.uint8))
        out.append(packet.build(f"OM{i % 10}ABC-{i % 16}", "APRS", ["WIDE1-1"], info))
    return out


def line_bits(fr, gap_bits=300):
    bits, level = [], 0
    for f in fr:
        b, level = packet.hdlc_encode(f, preamble=24, level=level)
        bits += b + [level] * gap_bits      # idle carrier between frames
    return np.array(bits)


def fm(freq_hz, fs, snr_db, offset_hz, seed):
    """Instantaneous frequency (Hz, at fs) -> complex baseband with noise. snr_db in the 20 kHz channel."""
    rnd = np.random.default_rng(seed)
    ph = 2 * np.pi * np.cumsum(freq_hz + offset_hz) / fs
    z = np.exp(1j * ph)
    nvar = 10 ** (-snr_db / 10) * fs / 20000.0
    z += np.sqrt(nvar / 2) * (rnd.standard_normal(len(z)) + 1j * rnd.standard_normal(len(z)))
    return z.astype(np.complex64)


def afsk(fr, fs, snr_db=30, offset_hz=0.0, preemph=1.0, dev=3000.0, seed=1):
    """preemph: deviation of the 2200 Hz tone relative to the 1200 Hz one (pre-emphasised transmitter ~1.8)."""
    bits = line_bits(fr)
    spb = fs / 1200
    n = int(len(bits) * spb)
    t = np.arange(n)
    b = bits[np.minimum((t / spb).astype(int), len(bits) - 1)]
    tone = np.where(b == 1, 1200.0, 2200.0)
    amp = np.where(b == 1, 1.0, preemph)
    audio = amp * np.sin(np.cumsum(2 * np.pi * tone / fs))
    lead = np.zeros(int(0.2 * fs))
    return fm(np.concatenate((lead, dev / max(1.0, preemph) * audio, lead)), fs, snr_db, offset_hz, seed)


def g3ruh(fr, fs, snr_db=30, offset_hz=0.0, dev=3000.0, bt=0.5, scramble=True, invert=False, seed=2):
    bits = line_bits(fr)
    if scramble:
        bits = np.array(packet.Scrambler().feed(bits.tolist()))
    # made at 8x the rate, so the bit edges are not rounded to the samples (a real transmitter has no such jitter)
    os_ = 8
    spb = fs * os_ / 9600
    n = int(len(bits) * spb)
    t = np.arange(n)
    nrz = 2.0 * bits[np.minimum((t / spb).astype(int), len(bits) - 1)] - 1
    if invert:
        nrz = -nrz
    # Gaussian filter (GFSK, BT = bt)
    sigma = np.sqrt(np.log(2)) / (2 * np.pi * bt) * spb
    k = np.arange(-int(4 * sigma) - 1, int(4 * sigma) + 2)
    g = np.exp(-k ** 2 / (2 * sigma ** 2))
    shaped = np.convolve(nrz, g / g.sum(), mode="same")[::os_]
    lead = np.zeros(int(0.2 * fs))
    return fm(np.concatenate((lead, dev * shaped, lead)), fs, snr_db, offset_hz, seed)


def decode(demod, z, block=4096):
    got = []
    for i in range(0, len(z), block):
        got += demod.process(z[i:i + block])
    return got


class Afsk(unittest.TestCase):
    def test_clean_all_rates(self):
        fr = frames(5)
        for fs in RATES:
            got = decode(packet.Afsk1200(fs), afsk(fr, fs))
            self.assertEqual(set(got), set(fr), f"fs={fs}")

    def test_preemphasis_and_offset(self):
        fr = frames(5, 3)
        fs = RATES[0]
        for pre in (0.55, 1.0, 1.8):
            got = decode(packet.Afsk1200(fs), afsk(fr, fs, offset_hz=1500, preemph=pre))
            self.assertEqual(set(got), set(fr), f"preemph={pre}")

    def test_noise(self):
        fr = frames(20, 4)
        fs = RATES[1]
        d = packet.Afsk1200(fs)
        got = decode(d, afsk(fr, fs, snr_db=12, preemph=1.8))
        self.assertGreaterEqual(len(set(got) & set(fr)), 16)
        self.assertFalse(set(got) - set(fr))

    def test_noise_only(self):
        fs = RATES[0]
        rnd = np.random.default_rng(5)
        z = (rnd.standard_normal(int(fs * 20)) + 1j * rnd.standard_normal(int(fs * 20))).astype(np.complex64)
        d = packet.Afsk1200(fs)
        self.assertEqual(decode(d, z), [])


class G3ruh(unittest.TestCase):
    def test_clean(self):
        fr = frames(5, 6)
        for fs in RATES[:3]:
            got = decode(packet.G3ruh9600(fs), g3ruh(fr, fs))
            self.assertEqual(set(got), set(fr), f"fs={fs}")

    def test_offset_inverted(self):
        fr = frames(5, 7)
        fs = RATES[0]
        d = packet.G3ruh9600(fs)
        got = decode(d, g3ruh(fr, fs, offset_hz=2500, invert=True))
        self.assertEqual(set(got), set(fr))
        self.assertLess(abs(d.afc_hz - 2500), 300)

    def test_burst_after_noise(self):
        """Satellite burst: noise (no carrier), then a carrier 2 kHz off with frames right away."""
        fs = RATES[0]
        fr = frames(3, 11)
        rnd = np.random.default_rng(12)
        noise = (0.7 * (rnd.standard_normal(int(fs)) + 1j * rnd.standard_normal(int(fs)))).astype(np.complex64)
        burst = g3ruh(fr, fs, snr_db=20, offset_hz=2000)[int(0.2 * fs) - 200:]   # almost no idle carrier first
        d = packet.G3ruh9600(fs)
        got = decode(d, np.concatenate((noise, burst)), block=2048)               # 64 ms blocks as in the receiver
        self.assertEqual(set(got), set(fr))
        self.assertLess(abs(d.afc_hz - 2000), 200)

    def test_without_scrambler(self):
        fr = frames(3, 8)
        fs = RATES[1]
        self.assertEqual(set(decode(packet.G3ruh9600(fs, "auto"), g3ruh(fr, fs, scramble=False))), set(fr))
        self.assertEqual(decode(packet.G3ruh9600(fs, "on"), g3ruh(fr, fs, scramble=False)), [])

    def test_noise(self):
        fr = frames(20, 9)
        fs = RATES[0]
        got = decode(packet.G3ruh9600(fs), g3ruh(fr, fs, snr_db=16))
        self.assertGreaterEqual(len(set(got) & set(fr)), 16)


class Decoder(unittest.TestCase):
    def test_both_rates_events_and_duplicates(self):
        fs = RATES[0]
        ev = []
        dec = packet.PacketDecoder(on_event=lambda k, d: ev.append((k, d)))
        dec.set_enabled(True)
        fr = frames(3, 10)
        other = packet.build("OK1SAT", "TLM", info=b" telemetry")
        # fr[0] twice (a duplicate within DUP_SEC is shown once), then a frame at 9600 Bd
        z = np.concatenate((afsk(fr + fr[:1], fs), g3ruh([other], fs)))
        for i in range(0, len(z), 4096):
            dec.feed(z[i:i + 4096], fs, 144.8e6)
        pk = [d for k, d in ev if k == "packet"]
        self.assertEqual([(p["baud"], p["src"]) for p in pk],
                         [(1200, "OM0ABC"), (1200, "OM1ABC-1"), (1200, "OM2ABC-2"), (9600, "OK1SAT")])
        self.assertEqual(pk[0]["freq_hz"], 144.8e6)
        info = dec.info()
        self.assertEqual((info["ok"], len(info["frames"]), info["error"]), (4, 4, ""))

    def test_aprs_station_table(self):
        fs = RATES[0]
        dec = packet.PacketDecoder(on_event=lambda k, d: None, station=lambda: (48.5, 17.91667))
        dec.set_enabled(True)
        fr = [packet.build("OM0ABC-9", "APRS", [], b"!4832.00N/01755.00E>088/010 car"),
              packet.build("OM0ABC-9", "APRS", [], b">QRV 144.800")]
        z = afsk(fr, fs)
        for i in range(0, len(z), 4096):
            dec.feed(z[i:i + 4096], fs, 144.8e6)
        info = dec.info()
        self.assertEqual(info["frames"][0]["aprs"]["type"], "position")
        st = info["stations"]
        self.assertEqual(len(st), 1)
        s = st[0]
        self.assertEqual((s["call"], s["count"], s["status"], s["sym"], s["course"]), ("OM0ABC-9", 2, "QRV 144.800", "/>", 88))
        self.assertAlmostEqual(s["km"], 3.7, delta=0.1)

    def test_eye_diagram(self):
        """Eye data only while asked for; a clean 9600 Bd signal has an open eye, noise a closed one."""
        fs = RATES[0]
        ev = []
        dec = packet.PacketDecoder(on_event=lambda k, d: ev.append((k, d)))
        dec.set_enabled(True)
        z = g3ruh(frames(4, 13), fs, snr_db=30, offset_hz=1000)
        for i in range(0, len(z), 2048):
            dec.feed(z[i:i + 2048], fs, 0)
        self.assertFalse([d for k, d in ev if k == "packeteye"])           # nobody asked
        dec.command({"action": "eye", "rate": 9600})
        old, packet.EYE_EVERY = packet.EYE_EVERY, 0.0         # the test runs faster than real time
        self.addCleanup(setattr, packet, "EYE_EVERY", old)
        for i in range(0, len(z), 2048):
            dec.feed(z[i:i + 2048], fs, 0)
        eyes = [d for k, d in ev if k == "packeteye"]
        self.assertTrue(eyes)
        e = eyes[len(eyes) // 2]
        self.assertEqual((e["rate"], e["n"]), (9600, packet.EYE_POINTS))
        self.assertGreater(e["open"], 50)
        self.assertGreater(eyes[-1]["open_frame"], 50)                   # measured on a block with a frame
        self.assertAlmostEqual(e["dev_hz"], 3000, delta=900)
        self.assertEqual(len(base64.b64decode(e["data"])) % e["n"], 0)
        rnd = np.random.default_rng(14)
        ev.clear()
        nz = (rnd.standard_normal(int(fs * 2)) + 1j * rnd.standard_normal(int(fs * 2))).astype(np.complex64)
        for i in range(0, len(nz), 2048):
            dec.feed(nz[i:i + 2048], fs, 0)
        e = [d for k, d in ev if k == "packeteye"][-1]
        self.assertLess(e["open"] or 0, 20)

    def test_spectrum(self):
        """Spectrum only while asked for; a carrier 3 kHz above the tuned frequency is at +3 kHz, about 0 dB."""
        fs = RATES[0]
        ev = []
        dec = packet.PacketDecoder(on_event=lambda k, d: ev.append((k, d)))
        dec.set_enabled(True)
        t = np.arange(int(fs * 2))
        z = np.exp(2j * np.pi * 3000 / fs * t).astype(np.complex64)
        dec.feed(z[:2048], fs, 0)
        self.assertFalse([d for k, d in ev if k == "packetspec"])
        dec.command({"action": "spectrum"})
        old, packet.EYE_EVERY = packet.EYE_EVERY, 0.0
        self.addCleanup(setattr, packet, "EYE_EVERY", old)
        for i in range(0, len(z), 2048):
            dec.feed(z[i:i + 2048], fs, 0)
        sp = [d for k, d in ev if k == "packetspec"]
        self.assertTrue(sp)
        e = sp[-1]
        self.assertEqual(len(e["db"]), 2 * e["k"] + 1)
        peak = (int(np.argmax(e["db"])) - e["k"]) * e["df"]
        self.assertAlmostEqual(peak, 3000, delta=e["df"])
        self.assertAlmostEqual(max(e["db"]), 0, delta=2)
        self.assertLess(np.median(e["db"]), -60)

    def test_low_rate_error(self):
        dec = packet.PacketDecoder(on_event=lambda k, d: None)
        dec.set_enabled(True)
        dec.feed(np.zeros(1600, np.complex64), 16000.0, 0)
        i = dec.info()
        self.assertEqual(i["rates"], [1200])
        self.assertIn("9600", i["error"])


if __name__ == "__main__":
    unittest.main()
