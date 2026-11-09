"""Tests of the packet link layer (packet.py, stage 1): synthetic frames, no radio.

Run: python -m unittest tests.test_packet   (from the RADIMCOM folder)
"""
import os
import random
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import packet  # noqa: E402

APRS = packet.build("OM0ABC-9", "APRS", ["OK0NMA*", "WIDE2-1"], b"!4832.00N/01755.00E>test 73")


def noise(n, rnd):
    return [rnd.randint(0, 1) for _ in range(n)]


def stream(frames, rnd, gap=200):
    """Several frames separated by random bits, as NRZI line levels."""
    bits, level = noise(gap, rnd), 0
    for f in frames:
        b, level = packet.hdlc_encode(f, level=level)
        bits += b + noise(rnd.randint(1, gap), rnd)
        level = bits[-1]
    return bits


class Crc(unittest.TestCase):
    def test_check_value(self):
        self.assertEqual(packet.crc16(b"123456789"), 0x906E)

    def test_fcs_ok(self):
        c = packet.crc16(APRS)
        self.assertTrue(packet.fcs_ok(APRS + bytes((c & 0xFF, c >> 8))))
        self.assertFalse(packet.fcs_ok(APRS + bytes((c >> 8, c & 0xFF))))


class Hdlc(unittest.TestCase):
    def test_roundtrip_with_noise(self):
        rnd = random.Random(1)
        frames = [APRS, packet.build("OM2AMR", "CQ", info=bytes(range(256)) * 1)[:300],
                  packet.build("N0CALL-15", "BEACON", info=b"\x7e\x7e\xff\xff\xfe\x7c\x3f" * 10)]
        d = packet.HdlcDeframer()
        got = d.feed(stream(frames, rnd))
        self.assertEqual(got, frames)
        self.assertEqual(d.ok, 3)

    def test_split_feed(self):
        """Bits arriving in blocks of any size give the same frames."""
        rnd = random.Random(2)
        frames = [APRS] * 5
        bits = stream(frames, rnd)
        d = packet.HdlcDeframer()
        got, i = [], 0
        while i < len(bits):
            n = rnd.randint(1, 97)
            got += d.feed(bits[i:i + n])
            i += n
        self.assertEqual(got, frames)

    def test_inverted_polarity(self):
        bits = stream([APRS], random.Random(3))
        self.assertEqual(packet.HdlcDeframer().feed([1 - b for b in bits]), [APRS])

    def test_bit_error_is_counted_not_returned(self):
        rnd = random.Random(4)
        b, _ = packet.hdlc_encode(APRS)
        bits = noise(50, rnd) + b + noise(50, rnd)
        k = 50 + 16 * 8 + 8 * 20                   # inside the info field (the address stays valid)
        bits[k:] = [1 - x for x in bits[k:]]       # NRZI: inverting the rest of the line = one data bit flipped
        d = packet.HdlcDeframer()
        self.assertEqual(d.feed(bits), [])
        self.assertEqual((d.ok, d.bad), (0, 1))

    def test_noise_only(self):
        """Random bits: no false frames; the FCS rejects them."""
        d = packet.HdlcDeframer()
        self.assertEqual(d.feed(noise(200000, random.Random(5))), [])

    def test_too_short(self):
        d = packet.HdlcDeframer()
        b, _ = packet.hdlc_encode(b"\x01\x02\x03")
        self.assertEqual(d.feed(b), [])
        self.assertEqual(d.bad, 0)


class G3ruh(unittest.TestCase):
    def test_scramble_roundtrip(self):
        rnd = random.Random(6)
        bits = stream([APRS, APRS], rnd)
        s = packet.Scrambler().feed(bits)
        self.assertNotEqual(s, bits)
        d = packet.Descrambler().feed(s)
        self.assertEqual(d[17:], bits[17:])

    def test_9600_chain_any_polarity(self):
        """Scrambled line signal -> descrambler -> NRZI -> HDLC, normal and inverted demodulator output."""
        rnd = random.Random(7)
        frames = [APRS, packet.build("OM2AMR-1", "TLM", info=bytes(rnd.randrange(256) for _ in range(200)))]
        line = packet.Scrambler().feed(stream(frames, rnd))
        for inv in (0, 1):
            d = packet.HdlcDeframer()
            got = d.feed(packet.Descrambler().feed([b ^ inv for b in line]))
            self.assertEqual(got, frames, f"inverted={inv}")


class Ax25(unittest.TestCase):
    def test_parse_and_tnc2(self):
        f = packet.parse(APRS)
        self.assertEqual(str(f.src), "OM0ABC-9")
        self.assertEqual(str(f.dest), "APRS")
        self.assertEqual([str(d) for d in f.digis], ["OK0NMA", "WIDE2-1"])
        self.assertEqual((f.kind, f.pid), ("UI", 0xF0))
        self.assertEqual(f.tnc2(), "OM0ABC-9>APRS,OK0NMA*,WIDE2-1:!4832.00N/01755.00E>test 73")

    def test_star_on_last_repeated_digi_only(self):
        f = packet.parse(packet.build("A1A", "APRS", ["D1*", "D2*", "D3"], b">x"))
        self.assertEqual(f.tnc2(), "A1A>APRS,D1,D2*,D3:>x")

    def test_binary_info_as_hex(self):
        f = packet.parse(packet.build("SAT1", "TLM", info=b"\x00\x01\x02\xff"))
        self.assertEqual(f.tnc2(), "SAT1>TLM:hex 00 01 02 ff")

    def test_control_frames(self):
        f = packet.parse(packet.build("OM2AMR", "OK0NMA", ctrl=0x3F))        # SABM with P bit
        self.assertEqual((f.kind, f.pid, f.info), ("SABM", None, b""))
        self.assertIn("<SABM>", f.tnc2())
        self.assertEqual(packet.parse(packet.build("A1", "B2", ctrl=0x41)).kind, "RR")

    def test_invalid_address(self):
        bad = bytearray(APRS)
        bad[0] = ord("a") << 1
        self.assertIsNone(packet.parse(bytes(bad)))
        self.assertIsNone(packet.parse(APRS[:10]))


if __name__ == "__main__":
    unittest.main()
