"""Tone squelch for FM: CTCSS (sub-audio tone) and DCS (digital code), keys TSQ-C and TSQ-D.

Both work on the demodulated FM audio (before the LPF / HPF keys), filtered to the sub-audio band and decimated to
about 1 kHz. They add to the carrier squelch (SQL bar or ASQ): the audio passes only while the carrier squelch is
open AND the tone or code is received.

CTCSS: the power at the set tone over the last CTCSS_WINDOW_S, compared with the power at CTCSS_REF_HZ around it
(a tone is a narrow line, noise and voice are spread). With a 0.45 s window the closest standard tones
(67.0 / 69.3 Hz, 2.3 Hz apart) fall near the first null of the neighbour's response.

DCS: 23-bit Golay (23,12) codeword at 134.4 bit/s sent over and over (9 bits of the octal code, the marker 100,
11 parity bits, LSB first). The audio is folded over the codeword period (23 bits, 171 ms) by time, so the
repeating code adds up while noise and voice average out; the fold is correlated with the code at all shifts.
N = normal polarity (bit 1 = frequency up), I = inverted. A code is the same as its cyclic shifts, so as in every
radio a few codes outside the standard list are received as their standard aliases.
"""
import numpy as np

CTCSS_TONES = (67.0, 69.3, 71.9, 74.4, 77.0, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100.0, 103.5, 107.2, 110.9,
               114.8, 118.8, 123.0, 127.3, 131.8, 136.5, 141.3, 146.2, 151.4, 156.7, 159.8, 162.2, 165.5, 167.9, 171.3,
               173.8, 177.3, 179.9, 183.5, 186.2, 189.9, 192.8, 196.6, 199.5, 203.5, 206.5, 210.7, 218.1, 225.7, 229.1,
               233.6, 241.8, 250.3, 254.1)
DCS_CODES = tuple("023 025 026 031 032 036 043 047 051 053 054 065 071 072 073 074 114 115 116 122 125 131 132 134 "
                  "143 145 152 155 156 162 165 172 174 205 212 223 225 226 243 244 245 246 251 252 255 261 263 265 "
                  "266 271 274 306 311 315 325 331 332 343 346 351 356 364 365 371 411 412 413 423 431 432 445 446 "
                  "452 454 455 462 464 465 466 503 506 516 523 526 532 546 565 606 612 624 627 631 632 654 662 664 "
                  "703 712 723 731 732 734 743 754".split())
CTCSS_DEFAULT_HZ = 88.5
DCS_DEFAULT = "023N"

LOW_RATE = 1000.0          # Hz, approximate rate of the sub-audio signal
LOW_CUT_HZ = 320.0         # sub-audio band (CTCSS up to 254.1 Hz, DCS 134.4 bit/s)
TONE_HPF_HZ = 300.0        # with a tone squelch on, the tone is removed from what is heard (as in a radio)
CTCSS_WINDOW_S = 0.45
CTCSS_REF_HZ = (-11.0, -9.0, -7.0, -5.0, 5.0, 7.0, 9.0, 11.0)
CTCSS_OPEN_DB, CTCSS_CLOSE_DB = 12.0, 5.0
DCS_RATE = 134.4           # bit/s
DCS_BITS = 23
DCS_BIN = 4                # fold bins per bit
DCS_TAU_S = 0.3            # s, memory of the fold
DCS_OPEN, DCS_CLOSE = 0.75, 0.55  # normalised correlation
OPEN_S = 0.12              # the match must hold this long to open (no opening on a noise spike) ...
CLOSE_S = 0.25             # ... and be lost this long to close (no drop-outs in voice peaks)


def dcs_word(code):
    """23-bit DCS codeword for a 3-digit octal code ("023"): bits 0-8 code, 9-11 = 100, 12-22 Golay parity."""
    data = int(code, 8) | 0x800
    r = data << 11
    for i in range(22, 10, -1):                 # remainder of data·x^11 modulo the Golay polynomial 0xC75
        if r >> i & 1:
            r ^= 0xC75 << (i - 11)
    return data | r << 12


def norm_ctcss(hz):
    """The standard tone nearest to hz."""
    return min(CTCSS_TONES, key=lambda t: abs(t - float(hz)))


def norm_dcs(code):
    """'023N' / '23i' -> '023N'; ValueError for a code outside the standard list."""
    s = str(code).strip().upper()
    pol = s[-1] if s[-1:] in ("N", "I") else "N"
    num = s.rstrip("NI").zfill(3)
    if num not in DCS_CODES:
        raise ValueError(f"unknown DCS code {code}")
    return num + pol


class ToneSquelch:
    """CTCSS or DCS detector of one VFO. process() returns True while the set tone / code is received."""

    def __init__(self):
        self.key = None
        self.reset()

    def reset(self):
        self.match = False          # the set tone / code is received now (with OPEN_S / CLOSE_S)
        self.metric = None          # CTCSS: dB over the neighbourhood, DCS: correlation (diagnostics)
        self.run_s = 0.0            # how long the raw decision differs from match
        self.n = 0                  # low-rate samples so far (DCS time base)
        self.buf = np.zeros(0)
        self.acc = self.cnt = None
        self.zi = None
        self.skip = 0

    def _setup(self, fs):
        from scipy.signal import butter, sosfilt, sosfilt_zi
        self.d = max(1, int(round(fs / LOW_RATE)))
        self.r = fs / self.d
        self.sos = butter(6, LOW_CUT_HZ, "low", fs=fs, output="sos")
        self._sosfilt, self._zi0 = sosfilt, sosfilt_zi(self.sos)

    def _low(self, audio, fs):
        """Sub-audio band at about LOW_RATE."""
        if self.key != fs:
            self.key = fs
            self.reset()
            self._setup(fs)
        if self.zi is None:
            self.zi = self._zi0 * float(audio[0])
        y, self.zi = self._sosfilt(self.sos, audio, zi=self.zi)
        out = y[self.skip::self.d]
        self.skip = (self.skip - len(audio)) % self.d
        return out

    def _decide(self, hit, keep, dt):
        """Hysteresis in time: open after OPEN_S of hits, close after CLOSE_S without 'keep'."""
        raw = hit if not self.match else keep
        if raw == self.match:
            self.run_s = 0.0
        else:
            self.run_s += dt
            if self.run_s >= (OPEN_S if raw else CLOSE_S):
                self.match, self.run_s = raw, 0.0
        return self.match

    def process(self, audio, fs, ctcss_hz=None, dcs_code=None):
        """audio: mono FM audio at fs. Exactly one of ctcss_hz / dcs_code is given."""
        x = self._low(np.asarray(audio, np.float64), fs)
        dt = len(audio) / fs
        start, self.n = self.n, self.n + len(x)
        if ctcss_hz:
            return self._ctcss(x, float(ctcss_hz), dt)
        return self._dcs(x, start, dcs_code, dt)

    def _ctcss(self, x, hz, dt):
        n = int(round(CTCSS_WINDOW_S * self.r))
        self.buf = np.concatenate((self.buf, x))[-n:]
        if len(self.buf) < n:
            return self._decide(False, False, dt)
        if getattr(self, "ct_key", None) != (hz, n, self.r):
            self.ct_key = (hz, n, self.r)
            f = hz + np.concatenate(([0.0], CTCSS_REF_HZ))
            self.ct_e = np.exp(-2j * np.pi * np.outer(f, np.arange(n)) / self.r)
        p = np.abs(self.ct_e @ self.buf) ** 2
        db = float(10 * np.log10(p[0] / (p[1:].mean() + 1e-30) + 1e-30))
        self.metric = round(db, 1)
        return self._decide(db > CTCSS_OPEN_DB, db > CTCSS_CLOSE_DB, dt)

    def _dcs(self, x, start, code, dt):
        nb = DCS_BITS * DCS_BIN
        if getattr(self, "dcs_key", None) != code:
            self.dcs_key = code
            w = dcs_word(code[:3])
            bits = np.array([1.0 if w >> i & 1 else -1.0 for i in range(DCS_BITS)])
            t = np.repeat(bits if code[3] == "N" else -bits, DCS_BIN)
            t -= t.mean()
            self.dcs_t = np.conj(np.fft.rfft(t)) / np.linalg.norm(t)
            self.acc = self.cnt = None
        if self.acc is None:
            self.acc, self.cnt = np.zeros(nb), np.zeros(nb)
        pos = (np.arange(start, start + len(x)) * (DCS_RATE / self.r)) % DCS_BITS
        idx = np.minimum((pos * DCS_BIN).astype(int), nb - 1)
        k = np.exp(-dt / DCS_TAU_S)
        self.acc = self.acc * k + np.bincount(idx, x, nb)
        self.cnt = self.cnt * k + np.bincount(idx, None, nb)
        if self.cnt.min() < 0.3:                # not every bin has a sample yet
            return self._decide(False, False, dt)
        fold = self.acc / self.cnt
        fold -= fold.mean()
        norm = np.linalg.norm(fold)
        c = float(np.fft.irfft(np.fft.rfft(fold) * self.dcs_t, nb).max() / norm) if norm > 0 else 0.0
        self.metric = round(c, 2)
        return self._decide(c > DCS_OPEN, c > DCS_CLOSE, dt)
