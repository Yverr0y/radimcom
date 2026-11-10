"""Packet radio (AX.25) decoder: 1200 Bd AFSK and 9600 Bd G3RUH from the baseband of the VFO (design: data/poznamky_packet.md).

  baseband -> channel filter -> FM discriminator -> demodulator (Afsk1200 / G3ruh9600) -> bit clock (PLL)
  -> [G3RUH descrambler, 9600 Bd only] -> NRZI -> HDLC deframer -> CRC-16 (FCS) -> AX.25 parse
  -> TNC2 text "SRC>DEST,DIGI*:info" -> APRS (aprs.py) -> PacketDecoder: events, frame list, station table.
NRZI: a 0 is a change of the level, a 1 keeps it, so the polarity of the demodulator does not matter.
HDLC: frames are separated by the flag 0x7E; after five 1s the transmitter inserts a 0 (bit stuffing),
seven 1s abort the frame. Bytes are sent LSB first, the FCS low byte first.
G3RUH: scrambler x^17 + x^12 + 1; the descrambler is self-synchronising (17 bits) and an inverted input
only inverts its output, which NRZI then cancels.
The encoders (hdlc_encode, Scrambler) are the inverse of the decoders: for the tests and the signal generator.
"""
import base64
import collections
import re
import threading
import time

import numpy as np

import aprs
from sdr import lowpass

FLAG = 0x7E
MIN_FRAME = 17          # 2 addresses (14) + control (1) + FCS (2)
MAX_FRAME = 400         # AX.25 allows 256 info bytes + 8 digipeaters; longer = noise between flags
MAX_DIGIS = 8

# ---------------------------------------------------------------- CRC-16 (FCS, CRC-16/X-25)

_CRC_TABLE = []
for _i in range(256):
    _c = _i
    for _ in range(8):
        _c = (_c >> 1) ^ 0x8408 if _c & 1 else _c >> 1
    _CRC_TABLE.append(_c)


def crc16(data):
    """FCS of AX.25 (reflected CCITT, init 0xFFFF, final XOR 0xFFFF). crc16(b"123456789") == 0x906E."""
    crc = 0xFFFF
    for b in data:
        crc = (crc >> 8) ^ _CRC_TABLE[(crc ^ b) & 0xFF]
    return crc ^ 0xFFFF


def fcs_ok(frame):
    """frame: bytes including the 2 FCS bytes (low byte first)."""
    return len(frame) >= 3 and crc16(frame[:-2]) == (frame[-2] | frame[-1] << 8)


# ---------------------------------------------------------------- HDLC

class HdlcDeframer:
    """Bits -> frames with a valid FCS (returned without the FCS).

    feed(bits) takes line levels (0/1) when nrzi=True, otherwise already NRZI-decoded data bits.
    Detection of flag, abort and stuffed bit on the last 8 received bits, as in Direwolf:
    a frame is complete when a flag comes exactly 7 bits after a byte boundary (the 7 bits are the flag itself).
    Counters: ok = valid frames, bad = frames with a valid AX.25 address field but a wrong FCS
    (only counted, never returned; random bits between flags in noise are not counted).
    """

    def __init__(self, nrzi=True, min_frame=MIN_FRAME, max_frame=MAX_FRAME, header_ok=None):
        """min_frame / max_frame: length limits with the FCS (AX.25 by default); header_ok(frame): a frame with a
        wrong FCS counts as bad only when it passes this test (AX.25 addresses by default; AIS gives its own)."""
        self.nrzi = nrzi
        self.min_frame = min_frame
        self.max_frame = max_frame
        self.header_ok = header_ok or _header_ok
        self.ok = 0
        self.bad = 0
        self.reset()

    def reset(self):
        self.prev = 0           # previous line level (NRZI)
        self.pat = 0            # last 8 data bits, the newest in bit 7
        self.acc = 0            # byte being assembled (LSB first)
        self.nbits = 0
        self.buf = bytearray()
        self.inframe = False    # after a flag; seven 1s (abort / idle) end it

    def feed(self, bits):
        out = []
        prev, pat, acc, nbits, buf, inframe = self.prev, self.pat, self.acc, self.nbits, self.buf, self.inframe
        nrzi, min_frame, max_frame, header_ok = self.nrzi, self.min_frame, self.max_frame, self.header_ok
        for lv in bits:
            if nrzi:
                b = 1 if lv == prev else 0
                prev = lv
            else:
                b = lv
            pat = (pat >> 1) | (0x80 if b else 0)
            if pat == 0x7E:                         # flag: end of the previous frame, start of the next one
                if inframe and nbits == 7 and min_frame <= len(buf) <= max_frame:
                    frame = bytes(buf)
                    if fcs_ok(frame):
                        self.ok += 1
                        out.append(frame[:-2])
                    elif header_ok(frame):              # noise makes flags too: only a real damaged frame counts
                        self.bad += 1
                buf = bytearray()
                acc = nbits = 0
                inframe = True
            elif pat == 0xFE:                       # seven 1s: abort
                buf = bytearray()
                acc = nbits = 0
                inframe = False
            elif (pat & 0xFC) == 0x7C:              # 0 after five 1s: stuffed bit, dropped
                pass
            elif inframe:
                acc = (acc >> 1) | (0x80 if b else 0)
                nbits += 1
                if nbits == 8:
                    if len(buf) < max_frame:
                        buf.append(acc)
                    else:                           # too long: noise, wait for the next flag
                        inframe = False
                        buf = bytearray()
                    acc = nbits = 0
        self.prev, self.pat, self.acc, self.nbits, self.buf, self.inframe = prev, pat, acc, nbits, buf, inframe
        return out


def hdlc_encode(payload, preamble=16, postamble=2, nrzi=True, level=0):
    """AX.25 frame without FCS -> list of bits: flags, stuffed data + FCS, flags; NRZI line levels if nrzi.
    level: line level before the first bit. Returns (bits, last level)."""
    fcs = crc16(payload)
    data = bytes(payload) + bytes((fcs & 0xFF, fcs >> 8))
    raw = []
    flag = [(FLAG >> i) & 1 for i in range(8)]
    for _ in range(preamble):
        raw += flag
    ones = 0
    for byte in data:
        for i in range(8):
            b = (byte >> i) & 1
            raw.append(b)
            if b:
                ones += 1
                if ones == 5:
                    raw.append(0)
                    ones = 0
            else:
                ones = 0
    for _ in range(postamble):
        raw += flag
    if not nrzi:
        return raw, level
    out = []
    for b in raw:
        if not b:
            level ^= 1
        out.append(level)
    return out, level


# ---------------------------------------------------------------- G3RUH scrambler (9600 Bd)

class Scrambler:
    """G3RUH scrambler x^17 + x^12 + 1 (transmit side; for the tests and the signal generator)."""

    def __init__(self):
        self.reg = 0

    def feed(self, bits):
        out = []
        reg = self.reg
        for b in bits:
            s = b ^ ((reg >> 11) & 1) ^ ((reg >> 16) & 1)
            reg = ((reg << 1) | s) & 0x1FFFF
            out.append(s)
        self.reg = reg
        return out


class Descrambler:
    """G3RUH descrambler: y = x ^ x[-12] ^ x[-17]. Self-synchronising: correct from the 18th bit on."""

    def __init__(self):
        self.reg = 0

    def feed(self, bits):
        out = []
        reg = self.reg
        for b in bits:
            out.append(b ^ ((reg >> 11) & 1) ^ ((reg >> 16) & 1))
            reg = ((reg << 1) | b) & 0x1FFFF
        self.reg = reg
        return out


# ---------------------------------------------------------------- AX.25

_CALL_RE = re.compile(r"^[A-Z0-9]{1,6}$")
_U_NAMES = {0x03: "UI", 0x2F: "SABM", 0x6F: "SABME", 0x43: "DISC", 0x63: "UA", 0x0F: "DM", 0x87: "FRMR",
            0xAF: "XID", 0xE3: "TEST"}
_S_NAMES = {0: "RR", 1: "RNR", 2: "REJ", 3: "SREJ"}


class Address:
    __slots__ = ("call", "ssid", "h")

    def __init__(self, call, ssid, h):
        self.call, self.ssid, self.h = call, ssid, h

    def __str__(self):
        return f"{self.call}-{self.ssid}" if self.ssid else self.call


def _address(b):
    """7 address bytes -> Address, or None if they are not a valid callsign."""
    call = "".join(chr(c >> 1) for c in b[:6]).rstrip(" ")
    if not _CALL_RE.match(call) or any(c & 1 for c in b[:6]):
        return None
    return Address(call, (b[6] >> 1) & 0x0F, bool(b[6] & 0x80))


def _header_ok(frame):
    """Destination and source are valid callsigns (for the bad-FCS counter)."""
    return len(frame) >= 14 and _address(frame[0:7]) is not None and _address(frame[7:14]) is not None


class Frame:
    """Parsed AX.25 frame. info: bytes (empty for frames without an information field)."""

    __slots__ = ("raw", "dest", "src", "digis", "ctrl", "pid", "info", "kind")

    def tnc2(self):
        """Monitor format SRC>DEST,DIGI1,DIGI2*:info (* after the last digipeater that has repeated it)."""
        path = [str(self.dest)]
        last = max((i for i, d in enumerate(self.digis) if d.h), default=-1)
        path += [str(d) + ("*" if i == last else "") for i, d in enumerate(self.digis)]
        head = f"{self.src}>{','.join(path)}"
        if self.kind not in ("UI", "I"):
            head += f" <{self.kind}>"
        return f"{head}:{info_text(self.info)}"

    def is_text(self):
        return is_text(self.info)


def parse(frame):
    """Frame bytes without FCS -> Frame, or None if the address field is not valid AX.25."""
    n = len(frame)
    i = 0
    addrs = []
    while True:
        if i + 7 > n or len(addrs) > 2 + MAX_DIGIS:
            return None
        a = _address(frame[i:i + 7])
        if a is None:
            return None
        addrs.append(a)
        last = frame[i + 6] & 1
        i += 7
        if last:
            break
    if len(addrs) < 2 or len(addrs) > 2 + MAX_DIGIS or i >= n:
        return None
    f = Frame()
    f.raw = bytes(frame)
    f.dest, f.src, f.digis = addrs[0], addrs[1], addrs[2:]
    f.ctrl = frame[i]
    i += 1
    f.pid = None
    if f.ctrl & 1 == 0:                             # I frame
        f.kind = "I"
    elif f.ctrl & 3 == 1:                           # S frame
        f.kind = _S_NAMES[(f.ctrl >> 2) & 3]
    else:                                           # U frame (P/F bit 0x10 ignored)
        f.kind = _U_NAMES.get(f.ctrl & 0xEF, f"U{f.ctrl:02X}")
    if f.kind in ("I", "UI"):
        if i >= n:
            return None
        f.pid = frame[i]
        i += 1
    f.info = bytes(frame[i:])
    return f


def is_text(data):
    """Mostly printable text (APRS, beacons) rather than binary telemetry."""
    if not data:
        return True
    printable = sum(1 for c in data if 32 <= c < 127 or c in (9, 10, 13) or c >= 160)
    return printable >= 0.9 * len(data)


def info_text(data):
    """Info field for display: text with <0xNN> for non-printable bytes; binary data as hex."""
    if not is_text(data):
        return "hex " + data.hex(" ")
    return "".join(chr(c) if 32 <= c < 127 or c >= 160 else f"<0x{c:02x}>" for c in data)


def build(src, dest, digis=(), info=b"", ctrl=0x03, pid=0xF0):
    """Assembles an AX.25 frame (without FCS): for the tests. Calls as "CALL-SSID", "CALL*" = repeated (H bit)."""
    calls = [dest, src] + list(digis)
    out = bytearray()
    for k, c in enumerate(calls):
        h = c.endswith("*")
        c = c.rstrip("*")
        call, _, ssid = c.partition("-")
        out += bytes(ord(ch) << 1 for ch in call.upper().ljust(6))
        out.append(0x60 | (int(ssid or 0) << 1) | (0x80 if h and k >= 2 else 0) | (1 if k == len(calls) - 1 else 0))
    out.append(ctrl)
    if ctrl & 1 == 0 or ctrl & 0xEF == 0x03:
        out.append(pid)
    return bytes(out) + bytes(info)


# ================================================================ demodulators (stages 2 and 3)

AFSK_MARK, AFSK_SPACE = 1200.0, 2200.0
AFSK_GAINS = (1.8, 1.0, 0.55, 0.3)   # space tone weight: the transmitter may (or may not) pre-emphasise
G3RUH_MIN_RATE = 24000.0             # baseband needed for 9600 Bd FM (±8 kHz)
AFC_SEC = 0.02                       # 9600 Bd AFC window (s), scrambled
AFC_PLAIN_SEC = 0.2                  # the same without the scrambler (the line signal has DC of its own)
PLL_GAIN = 0.2                       # share of the edge timing error corrected at once
MAX_STATIONS = 1000
EYE_POINTS = 33                      # points of one eye-diagram trace (two bits)
EYE_PER_BLOCK = 120                  # newest traces taken from one block
EYE_TRACES = 240                     # traces sent at once
EYE_HOLD = 4.0                       # s: the eye data stops when the page stops asking for it
EYE_EVERY = 0.25                     # s between two eye events
SPEC_NFFT = 512                      # spectrum: FFT length on the baseband (about 62 Hz per bin at 32 kHz)
SPEC_SPAN = 0.45                     # shown part of the baseband rate on each side (the decimation filter cuts more)
DUP_SEC = 2.0                        # the same frame from several slicers / chains is shown once
RATES = ("both", "1200", "9600")
SCRAMBLER = ("auto", "on", "off")


class _Fir:
    """Streaming FIR filter (real or complex) with decimation."""

    def __init__(self, h, decim=1, dtype=np.float32):
        self.h = np.asarray(h, dtype)
        self.d = decim
        self.hist = np.zeros(len(h) - 1, dtype)
        self.off = 0

    def process(self, x):
        buf = np.concatenate((self.hist, x.astype(self.hist.dtype, copy=False)))
        self.hist = buf[len(buf) - (len(self.h) - 1):]
        y = np.convolve(buf, self.h, mode="valid")
        if self.d > 1:
            y = y[self.off::self.d]
            self.off = (self.off - len(x)) % self.d
        return y


class _Disc:
    """FM discriminator: instantaneous frequency in Hz."""

    def __init__(self, fs):
        self.k = fs / (2 * np.pi)
        self.prev = np.complex64(1)

    def process(self, z):
        if not len(z):
            return np.zeros(0, np.float32)
        prev = np.concatenate(([self.prev], z[:-1]))
        self.prev = z[-1]
        return (np.angle(z * np.conj(prev)) * self.k).astype(np.float32)


class _Clock:
    """Bit clock: digital PLL steered by the zero crossings (expected half a bit before each sampling instant);
    samples by linear interpolation, so any (non-integer) number of samples per bit works."""

    def __init__(self, sps):
        self.T = float(sps)
        self.t = self.T / 2            # next sampling instant; index 0 = last sample of the previous block
        self.prev = 0.0
        self.rec = False               # eye diagram: keep the signal and the sampling instants of the block
        self.rec_x, self.rec_ts = None, []

    def process(self, y):
        if not len(y):
            return []
        x = np.concatenate(([self.prev], y)).astype(np.float64)
        self.prev = float(y[-1])
        neg = x < 0
        idx = np.nonzero(neg[1:] != neg[:-1])[0]
        cross = (idx + x[idx] / (x[idx] - x[idx + 1])).tolist()
        xs = x.tolist()
        T, t, half, last = self.T, self.t, self.T / 2, len(xs) - 1
        bits, j, nc = [], 0, len(cross)
        ts = [] if self.rec else None
        while True:
            if j < nc and cross[j] < t:
                t += PLL_GAIN * (cross[j] - (t - half))
                j += 1
            elif t < last:
                i = int(t)
                bits.append(1 if xs[i] + (xs[i + 1] - xs[i]) * (t - i) >= 0 else 0)
                if ts is not None:
                    ts.append(t)
                t += T
            else:
                break
        self.t = t - last
        if ts is not None:
            self.rec_x, self.rec_ts = x, ts
        return bits

    def eye(self, n=None, most=None):
        """Traces of the last block for the eye diagram: the signal from one bit before to one bit after each
        sampling instant (n points), at most `most` of them (the newest). Returns an array (traces, n)."""
        n = n or EYE_POINTS
        most = most or EYE_PER_BLOCK
        x, ts = self.rec_x, self.rec_ts
        if x is None or not ts:
            return np.zeros((0, n), np.float32)
        t = np.array(ts[-most:])
        t = t[(t - self.T >= 0) & (t + self.T <= len(x) - 1)]
        pos = t[:, None] + self.T * np.linspace(-1, 1, n)[None, :]
        return np.interp(pos.ravel(), np.arange(len(x)), x).reshape(len(t), n).astype(np.float32)


class Afsk1200:
    """Bell 202 AFSK from the complex baseband: channel filter -> discriminator -> audio ~10–16 kHz ->
    tone envelopes over one bit -> several slicers (weights of the space tone) -> PLL -> NRZI/HDLC."""

    baud = 1200

    def __init__(self, fs):
        self.chan = _Fir(lowpass(min(6500.0, 0.45 * fs), fs, 63), 1, np.complex64)
        self.disc = _Disc(fs)
        self.D = max(1, int(fs // 9600))
        self.r = fs / self.D
        self.aud = _Fir(lowpass(min(3200.0, 0.45 * self.r), fs, 63), self.D)
        self.L = max(2, int(round(self.r / self.baud)))
        self.box = np.ones(self.L, np.float32)
        self.lo = {f: 0.0 for f in (AFSK_MARK, AFSK_SPACE)}
        self.hist = {f: np.zeros(self.L - 1, np.complex64) for f in self.lo}
        self.level = 1.0
        self.clocks = [_Clock(self.r / self.baud) for _ in AFSK_GAINS]
        self.hdlc = [HdlcDeframer() for _ in AFSK_GAINS]
        self.best = AFSK_GAINS.index(1.0)       # the slicer of the last frame: its signal goes to the eye diagram

    def _env(self, a, f):
        w = 2 * np.pi * f / self.r
        ph = self.lo[f] + w * np.arange(len(a))
        self.lo[f] = float((self.lo[f] + w * len(a)) % (2 * np.pi))
        z = np.concatenate((self.hist[f], (a * np.exp(-1j * ph)).astype(np.complex64)))
        self.hist[f] = z[len(z) - (self.L - 1):]
        return np.abs(np.convolve(z, self.box, mode="valid"))

    def process(self, base):
        a = self.aud.process(self.disc.process(self.chan.process(base)))
        if not len(a):
            return []
        m, s = self._env(a, AFSK_MARK), self._env(a, AFSK_SPACE)
        out = []
        for k, (g, clk, hd) in enumerate(zip(AFSK_GAINS, self.clocks, self.hdlc)):
            d = (m - g * s) / (m + g * s + 1e-9)
            got = hd.feed(clk.process(d))
            if got:
                self.best = k
                out += got
        return out

    @property
    def eye_clock(self):
        return self.clocks[self.best]

    @property
    def bad(self):
        return min(h.bad for h in self.hdlc)


class _Afc:
    """Removes the DC of the discriminator (tuning error): centred moving average over sec seconds."""

    def __init__(self, fs, sec):
        self.W = max(8, int(sec * fs))
        self.hist = np.zeros(self.W - 1, np.float64)
        self.dc = 0.0

    def process(self, f):
        x = np.concatenate((self.hist, f.astype(np.float64)))
        self.hist = x[len(x) - (self.W - 1):]
        c = np.cumsum(np.concatenate(([0.0], x)))
        dc = (c[self.W:] - c[:-self.W]) / self.W            # mean of x[i : i + W], one per new sample
        mid = x[self.W // 2: self.W // 2 + len(dc)]          # the sample in the middle of each window
        self.dc = float(np.median(dc))
        return (mid - dc).astype(np.float32)


class _Path9600:
    """AFC -> low-pass -> bit clock -> [descrambler] -> NRZI/HDLC."""

    def __init__(self, fs, baud, scrambled):
        self.afc = _Afc(fs, AFC_SEC if scrambled else AFC_PLAIN_SEC)
        self.aud = _Fir(lowpass(0.6 * baud, fs, 31))
        self.clock = _Clock(fs / baud)
        self.desc = Descrambler() if scrambled else None
        self.hdlc = HdlcDeframer()

    def process(self, f):
        bits = self.clock.process(self.aud.process(self.afc.process(f)))
        return self.hdlc.feed(self.desc.feed(bits) if self.desc else bits)


class G3ruh9600:
    """9600 Bd FSK/GFSK/GMSK: channel filter -> discriminator -> paths: AFC (DC = tuning error) -> low-pass ->
    PLL -> descrambler -> NRZI/HDLC, and the same without the descrambler. Runs at the baseband rate (>= 24 kHz).
    AFC: centred moving average of the discriminator. Scrambled data has no DC over ~200 bits, so a 20 ms window
    follows a satellite burst that starts off frequency within a few flags; without the scrambler the line signal
    has DC of its own and the window is longer."""

    baud = 9600

    def __init__(self, fs, scrambler="auto"):
        self.chan = _Fir(lowpass(min(9500.0, 0.45 * fs), fs, 63), 1, np.complex64)
        self.disc = _Disc(fs)
        self.paths = []
        if scrambler in ("auto", "on"):
            self.paths.append(_Path9600(fs, self.baud, True))
        if scrambler in ("auto", "off"):
            self.paths.append(_Path9600(fs, self.baud, False))
        self.last = self.paths[0]                     # the path of the last frame (its AFC is shown)

    def process(self, base):
        f = self.disc.process(self.chan.process(base))
        if not len(f):
            return []
        out = []
        for p in self.paths:
            got = p.process(f)
            if got:
                self.last = p
                out += got
        return out

    @property
    def bad(self):
        return min(p.hdlc.bad for p in self.paths)

    @property
    def afc_hz(self):
        return self.last.afc.dc

    @property
    def eye_clock(self):
        return self.last.clock


def _eye_opening(mid):
    """Eye opening 0..1 from the values at the sampling instants: the gap between the inner edges of the two
    bands (5th percentile of the upper one, 95th of the lower one) relative to the distance of their medians."""
    pos, neg = mid[mid > 0], mid[mid < 0]
    if len(pos) <= 10 or len(neg) <= 10:
        return None
    span = float(np.median(pos) - np.median(neg))
    if span <= 0:
        return None
    return max(0.0, min(1.0, float(np.percentile(pos, 5) - np.percentile(neg, 95)) / span))


class PacketDecoder:
    """Packet radio decoder of one VFO: 1200 Bd AFSK and/or 9600 Bd G3RUH from the baseband, independent of
    the listening mode and bandwidth. Valid frames go to on_event("packet", ...); a wrong FCS is only counted."""

    def __init__(self, on_event, max_frames=500, station=None):
        self.on_event = on_event
        self.station = station or (lambda: None)   # () -> (lat, lon) of the own station, or None
        self.stations = {}                          # APRS: callsign / object name -> last known state
        self.enabled = False
        self.lock = threading.Lock()
        self.opts = {"rate": "both", "scrambler": "auto"}
        self.frames = collections.deque(maxlen=max_frames)
        self.next_id = 1
        self.ok = 0
        self.bad_base = 0
        self.last_rx = None
        self.last_afc = None                        # AFC at the last 9600 Bd frame (Hz)
        self.error = ""
        self.dial = 0.0
        self._fs = None
        self.demods = []
        self.recent = collections.OrderedDict()   # frame bytes -> time (duplicates)
        self.since_state = 0.0
        self.eye_until = 0.0                        # monotonic time until which the page wants the eye diagram
        self.eye_rate = 9600
        self.eye_buf = collections.deque(maxlen=EYE_TRACES)
        self.eye_sent = 0.0
        self.eye_full = None                        # smoothed full scale of the 9600 Bd eye (Hz)
        self.eye_frame = None                       # eye opening (0..1) in the block of the last good frame
        self.spec_until = 0.0                       # the same for the spectrum
        self.spec_acc = None                        # summed power of the FFT segments since the last event
        self.spec_n = 0
        self.spec_sent = 0.0
        self._spec_win = None

    # ---------- control ----------

    def set_enabled(self, on):
        with self.lock:
            self.enabled = bool(on)
            self._fs = None
        self._emit_state()

    def set_options(self, opts):
        with self.lock:
            o = dict(self.opts)
            if opts.get("rate") in RATES:
                o["rate"] = opts["rate"]
            if opts.get("scrambler") in SCRAMBLER:
                o["scrambler"] = opts["scrambler"]
            self.opts = o
            self._fs = None                     # rebuild the demodulators
        self._emit_state()

    def clear(self):
        with self.lock:
            self.frames.clear()
            self.stations.clear()
            self.last_afc = None
            self.ok = 0
            self.bad_base = self._bad_now()

    def _bad_now(self):
        return sum(d.bad for d in self.demods)

    def info(self, frames=True):
        with self.lock:
            i = {"enabled": self.enabled, "opts": dict(self.opts), "ok": self.ok,
                 "bad": self._bad_now() - self.bad_base, "last_rx": self.last_rx, "error": self.error,
                 "afc_hz": self.last_afc, "rates": [d.baud for d in self.demods]}
            if frames:
                i["frames"] = list(self.frames)
                i["stations"] = sorted(self.stations.values(), key=lambda x: -x["last"])
            return i

    def command(self, body):
        if body.get("action") == "clear":
            self.clear()
        if body.get("action") == "eye":             # renewed by the page every ~2 s while the PACKET page is open
            with self.lock:
                rate = 1200 if int(body.get("rate") or 9600) == 1200 else 9600
                if rate != self.eye_rate:
                    self.eye_buf.clear()
                    self.eye_frame = None
                self.eye_rate = rate
                self.eye_until = time.monotonic() + EYE_HOLD
        if body.get("action") == "spectrum":        # renewed the same way while the spectrum is shown
            with self.lock:
                self.spec_until = time.monotonic() + EYE_HOLD
        if isinstance(body.get("opts"), dict):
            self.set_options(body["opts"])

    # ---------- signal ----------

    def _setup(self, fs):
        self._fs = fs
        self.error = ""
        self.bad_base -= self._bad_now()       # the bad count goes on across a rebuild
        self.demods = []
        rate = self.opts["rate"]
        if rate in ("both", "1200"):
            self.demods.append(Afsk1200(fs))
        if rate in ("both", "9600"):
            if fs >= G3RUH_MIN_RATE:
                self.demods.append(G3ruh9600(fs, self.opts["scrambler"]))
            else:
                self.error = f"9600 Bd needs a sample rate of at least {G3RUH_MIN_RATE * 64 / 1e6:.3f} MS/s"

    def feed(self, base, fs, dial_hz):
        if not self.enabled:
            return
        new = []
        with self.lock:
            if fs != self._fs:
                self._setup(fs)
            self.dial = dial_hz
            now = time.time()
            eye_on = time.monotonic() < self.eye_until
            eye_dem = next((d for d in self.demods if d.baud == self.eye_rate), None) if eye_on else None
            eye_got = False
            for d in self.demods:
                for c in getattr(d, "clocks", None) or [p.clock for p in getattr(d, "paths", [])]:
                    c.rec = d is eye_dem
                for raw in d.process(base):
                    eye_got = eye_got or d is eye_dem
                    if now - self.recent.get(raw, -1e9) < DUP_SEC:
                        continue
                    self.recent[raw] = now
                    self.recent.move_to_end(raw)
                    f = parse(raw)
                    if f is not None:
                        m = self._record(f, d.baud, now)
                        if isinstance(d, G3ruh9600):    # tuning error while the frame came (on noise it means nothing)
                            m["afc_hz"] = self.last_afc = round(d.afc_hz)
                        new.append(m)
            while self.recent and now - next(iter(self.recent.values())) > DUP_SEC:
                self.recent.popitem(last=False)
            self.since_state += len(base) / fs
            eye = None
            if eye_dem is not None:
                tr = eye_dem.eye_clock.eye()
                self.eye_buf.extend(tr)
                if eye_got and len(tr):                 # the block with a good frame: its eye is the signal's quality
                    self.eye_frame = _eye_opening(tr[:, EYE_POINTS // 2])
                if time.monotonic() - self.eye_sent >= EYE_EVERY and self.eye_buf:
                    self.eye_sent = time.monotonic()
                    eye = self._eye_event(eye_dem)
            spec = self._spectrum(base, fs) if time.monotonic() < self.spec_until else None
        if eye:
            self.on_event("packeteye", eye)
        if spec:
            self.on_event("packetspec", spec)
        for m in new:
            self.on_event("packet", m)
        if new or self.since_state >= 1.0:
            self.since_state = 0.0
            self._emit_state()

    def _record(self, f, baud, now):
        m = {"id": self.next_id, "time": now, "freq_hz": self.dial, "baud": baud,
             "src": str(f.src), "dest": str(f.dest), "path": [str(d) + ("*" if d.h else "") for d in f.digis],
             "kind": f.kind, "text": f.is_text(), "info": info_text(f.info), "tnc2": f.tnc2(), "len": len(f.raw)}
        self.next_id += 1
        self.ok += 1
        self.last_rx = now
        if f.kind == "UI":
            a = aprs.parse(str(f.dest), f.info)
            if a is not None and a["type"] != "other":
                m["aprs"] = a
                m["summary"] = aprs.summary(a)
                m["station"] = self._station(m, a)
        self.frames.append(m)
        return m

    def _station(self, m, a):
        """Station table: the newest state of each sender (an object or item under its own name)."""
        key = a.get("name") if a["type"] in ("object", "item") else m["src"]
        st = self.stations.get(key) or {"call": key, "count": 0, "first": m["time"]}
        st.update(last=m["time"], via=m["path"], baud=m["baud"], freq_hz=m["freq_hz"], type=a["type"],
                  count=st["count"] + 1)
        if a["type"] in ("object", "item"):
            st["owner"] = m["src"]
        if "lat" in a:
            st.update(lat=a["lat"], lon=a["lon"], sym=a.get("sym", ""), pos_time=m["time"])
            for k in ("course", "speed", "alt_m"):
                st.pop(k, None)
                if k in a:
                    st[k] = a[k]
            me = self.station()
            if me:
                st["km"], st["brg"] = aprs.distance_bearing(me[0], me[1], a["lat"], a["lon"])
        if a["type"] == "status":
            st["status"] = a["text"]
        elif a["type"] in ("position", "weather", "object", "item"):
            st["summary"] = m["summary"]
        if a.get("weather"):
            st["weather"] = a["weather"]
        if len(self.stations) >= MAX_STATIONS and key not in self.stations:
            del self.stations[min(self.stations, key=lambda k: self.stations[k]["last"])]
        self.stations[key] = st
        return dict(st)

    def _spectrum(self, base, fs):
        """Power spectrum of the baseband around the tuned frequency (Welch, Hann, half overlap). Summed over the
        blocks and sent every EYE_EVERY s in dB relative to a full-scale carrier; the page averages it further."""
        n = SPEC_NFFT
        if self._spec_win is None:
            self._spec_win = np.hanning(n).astype(np.float32)
        w = self._spec_win
        x = np.asarray(base, np.complex64)
        if len(x) >= n:
            starts = np.arange(0, len(x) - n + 1, n // 2)
            seg = x[starts[:, None] + np.arange(n)[None, :]] * w
            p = (np.abs(np.fft.fft(seg, axis=1)) ** 2).sum(axis=0)
            self.spec_acc = p if self.spec_acc is None or len(self.spec_acc) != n else self.spec_acc + p
            self.spec_n += len(starts)
        if self.spec_acc is None or not self.spec_n or time.monotonic() - self.spec_sent < EYE_EVERY:
            return None
        self.spec_sent = time.monotonic()
        p = np.fft.fftshift(self.spec_acc / self.spec_n) / float(w.sum()) ** 2
        self.spec_acc, self.spec_n = None, 0
        df = fs / n
        k = int(SPEC_SPAN * fs / df)
        mid = n // 2
        db = 10 * np.log10(p[mid - k:mid + k + 1] + 1e-12)
        g = next((d for d in self.demods if d.baud == 9600), None)
        return {"df": round(df, 3), "k": k, "db": [round(float(v), 1) for v in db],
                "afc_live": round(g.afc_hz) if g is not None else None}

    def _eye_event(self, d):
        """Eye diagram for the page: traces as int8 (base64), full scale, deviation, eye opening, live AFC."""
        tr = np.array(self.eye_buf, np.float32)
        mid = tr[:, EYE_POINTS // 2]
        dev = float(np.median(np.abs(mid))) if len(mid) else 0.0
        opening = _eye_opening(mid)
        if d.baud == 9600:
            target = max(500.0, float(np.percentile(np.abs(tr), 98)) * 1.15)
            self.eye_full = target if self.eye_full is None else self.eye_full + 0.3 * (target - self.eye_full)
            full = self.eye_full
        else:
            full = 1.2                                  # the 1200 Bd decision signal is -1..+1
        q = np.clip(np.round(tr / full * 127), -127, 127).astype(np.int8)
        return {"rate": d.baud, "n": EYE_POINTS, "full": round(full, 3),
                "dev_hz": round(dev) if d.baud == 9600 else None,
                "open": None if opening is None else round(opening * 100),
                "open_frame": None if self.eye_frame is None else round(self.eye_frame * 100),
                "afc_live": round(d.afc_hz) if d.baud == 9600 else None,
                "data": base64.b64encode(q.tobytes()).decode()}

    def _emit_state(self):
        self.on_event("packetstate", self.info(frames=False))
