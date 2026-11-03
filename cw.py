"""CW (Morse) decoder from the receiver's baseband with automatic tracking of tone and speed.

Method: decimation to 8 kHz -> AFC finds the strongest tone in the receiver passband (Welch spectrum
of the last 6 s) -> mixing the tone to 0 Hz and a filter (moving average) with a width set by the speed
-> envelope every 2 ms -> adaptive threshold with hysteresis -> mark and space lengths -> dot/dash
-> characters from the Morse table.
Reliability: a noise blanker removes short static crashes before the filters; the noise floor is measured
from the AFC spectrum (median over the band) and gives a minimum threshold, so noise alone does not decode; the mark
level is taken from the decoded marks themselves and after a pause it falls back quickly, so fading (QSB)
does not leave the threshold too high. Once a second the speed is estimated from the last 15 s of the envelope
(smoothing with the best mark/noise separation, splitting marks into short and long).
"""
import collections
import threading

import numpy as np
from scipy.ndimage import maximum_filter1d

from sdr import lowpass

RATE = 8000.0          # Hz, sample rate after decimation
TICK = 16              # samples per envelope step (2 ms)
BOX = 64               # shortest moving average (8 ms ≈ 125 Hz filter width) for fast CW
MAX_BOX = 800          # longest (100 ms ≈ 10 Hz) for very slow CW
NFFT = 4096            # AFC resolution ≈ 2 Hz
AFC_SEC = 6            # AFC window; even for slow CW it must contain several marks
MIN_SNR = 4.0          # tone-to-noise power ratio in the spectrum (≈ 6 dB), below it the decoder stays silent
FLOOR_ON = 2.6         # minimum threshold: noise Rayleigh sigma × this (noise exceeds it ≈ 3 % of the time)
FLOOR_OFF = 2.1        # ... and for the end of a mark (hysteresis)
TH_ON = 0.35           # threshold between the noise and the mark level for the start of a mark
TH_OFF = 0.22          # ... and for its end
HI_NEW = 0.7           # weight of the last mark in the mark level (higher = follows fast fading sooner)
NB_SIGMA = 4.5         # noise blanker: sample amplitude × noise RMS
NB_MARK = 3.0          # ... and × the mark level (whichever is higher)
FIT_MIN = 0.8          # speed estimate is used only if this share of marks fits dot or dash (noise fits ~0.6–0.8)
NB_MAX_MS = 20         # longer bursts are a signal, not a crash, and are kept

MORSE = {
    ".-": "A", "-...": "B", "-.-.": "C", "-..": "D", ".": "E", "..-.": "F", "--.": "G",
    "....": "H", "..": "I", ".---": "J", "-.-": "K", ".-..": "L", "--": "M", "-.": "N",
    "---": "O", ".--.": "P", "--.-": "Q", ".-.": "R", "...": "S", "-": "T", "..-": "U",
    "...-": "V", ".--": "W", "-..-": "X", "-.--": "Y", "--..": "Z",
    "-----": "0", ".----": "1", "..---": "2", "...--": "3", "....-": "4", ".....": "5",
    "-....": "6", "--...": "7", "---..": "8", "----.": "9",
    ".-.-.-": ".", "--..--": ",", "..--..": "?", "-..-.": "/", "-...-": "=", ".-.-.": "+",
    "-....-": "-", "---...": ":", ".----.": "'", "-.--.-": ")", ".-..-.": '"',
    ".--.-.": "@", "...-.-": "<SK>", "-.-.-": "<KA>", "-.--.": "<KN>", "...-.": "<SN>",
    "........": "<HH>", "-.-.--": "!",
}


def dot_from_marks(marks):
    """Dot length from mark lengths: the best split into short and long (on a log scale),
    dash = 3 dots. Returns (dot ms, share of marks that fit a dot or dash ±40 %),
    or None if there are too few marks or no two clear groups."""
    m = np.sort(np.log(np.asarray(marks, float)))
    if len(m) < 6:
        return None
    best, split = 0.0, None
    for k in range(1, len(m)):
        gap = m[k:].mean() - m[:k].mean()
        score = gap * k * (len(m) - k)
        if np.log(2) < gap < np.log(6) and score > best:
            best, split = score, k
    if split is None:
        return None
    dit = np.exp(m[:split].mean())
    dah = np.exp(m[split:].mean())
    dot = float((dit * split + dah / 3 * (len(m) - split)) / len(m))
    err = np.minimum(np.abs(m - np.log(dot)), np.abs(m - np.log(3 * dot)))
    return dot, float(np.mean(err < np.log(1.4)))


def otsu(s):
    """The best threshold between two levels (mark/noise) and its quality: difference of the means
    divided by the sum of the variances. Splits with less than 10 % on one side are not counted."""
    v = np.sort(s)
    n = len(v)
    c1, c2 = np.cumsum(v), np.cumsum(v * v)
    k = np.arange(1, n)
    m0 = c1[:-1] / k
    m1 = (c1[-1] - c1[:-1]) / (n - k)
    sd0 = np.sqrt(np.maximum(c2[:-1] / k - m0 ** 2, 0))
    sd1 = np.sqrt(np.maximum((c2[-1] - c2[:-1]) / (n - k) - m1 ** 2, 0))
    q = np.where((k > 0.1 * n) & (k < 0.9 * n), (m1 - m0) / (sd0 + sd1 + 1e-12), -1)
    i = int(np.argmax(q))
    return float(q[i]), float((v[i] + v[i + 1]) / 2)


def smooth_runs(on, k):
    """Fills gaps shorter than k steps and then removes marks shorter than k (closing + opening)."""
    if k < 2:
        return on
    box = np.ones(k)

    def dil(b):
        return np.convolve(b.astype(float), box, mode="same") > 0.5

    def ero(b):
        return ~dil(~b)
    return dil(ero(ero(dil(on))))


class CwDecoder:
    def __init__(self, on_event):
        self.on_event = on_event
        self.enabled = False
        self.lock = threading.Lock()
        self.text = collections.deque(maxlen=6000)
        self.dial = 0.0
        self.tone = None         # Hz relative to the tuned frequency
        self.snr = 0.0
        self.dot_ms = 60.0       # 20 WPM
        self.present = False
        self._fs = None

    # ---------- control ----------

    def set_enabled(self, on):
        with self.lock:
            self.enabled = bool(on)
            self._fs = None
        self._emit_state()

    def clear(self):
        with self.lock:
            self.text.clear()
    def info(self):
        return {
            "enabled": self.enabled, "wpm": round(1200 / self.dot_ms), "present": self.present,
            "snr_db": round(10 * np.log10(max(self.snr, 1e-3)), 1),
            "tone_hz": None if self.tone is None else round(self.tone),
            "freq_hz": None if self.tone is None else round(self.dial + self.tone),
            "text": "".join(self.text),
        }

    # ---------- signal processing ----------

    def _setup(self, fs):
        self._fs = fs
        self.D = max(1, int(round(fs / RATE)))
        self.r = fs / self.D
        self.h = lowpass(0.45 * self.r, fs, 63)
        self.hist = np.zeros(len(self.h) - 1, np.complex64)
        self.dec_off = 0
        self.buf = np.zeros(0, np.complex64)       # the last AFC_SEC seconds for the AFC
        self.since_afc = 0
        self.nco = 0.0
        self.box_hist = np.zeros(MAX_BOX - 1, np.complex64)
        self.tick_off = 0
        self.ticks = 0
        self.jump = None
        self.fine = collections.deque(maxlen=7500)  # envelope with the 8 ms filter over the last 15 s
        self.tone = None
        self.snr = 0.0
        self.present = False
        self.lo = self.hi = None
        self.sig_r = None         # noise Rayleigh sigma of the envelope × sqrt(filter width)
        self.sqn = 1.0
        self.mark_e = []
        self.key = False
        self.cand_n = 0
        self.run = 0              # number of steps in the current key state
        self.symbol = ""
        self.space_done = 0       # 0 = nothing, 1 = character finished, 2 = word space too
        self.since_state = 0

    def feed(self, base, fs, dial_hz, band):
        """base: complex baseband (tuned frequency = 0 Hz); band: (from, to) Hz to search for the tone."""
        if not self.enabled:
            return
        with self.lock:
            if fs != self._fs:
                self._setup(fs)
            if dial_hz != self.dial:
                self.dial = dial_hz
                self.tone = None
            buf = np.concatenate((self.hist, base))
            self.hist = buf[-(len(self.h) - 1):]
            y = np.convolve(buf, self.h, mode="valid")[self.dec_off::self.D]
            self.dec_off = (self.dec_off - len(base)) % self.D
            y = self._blank(y)
            self.buf = np.concatenate((self.buf, y))[-int(AFC_SEC * self.r):]
            self.since_afc += len(y)
            if self.since_afc >= self.r / 2:
                self.since_afc = 0
                self._afc(band)
            self._envelope(y)
            self.since_state += len(y)
        if self.since_state >= self.r:
            self.since_state = 0
            self._emit_state()

    def _blank(self, y):
        """Noise blanker: short bursts far above the noise and the mark level (static crashes) are set to zero.
        Bursts longer than NB_MAX_MS are kept: that is a strong station, not a crash."""
        if len(y) < 32:
            return y
        a = np.abs(y)
        rms = np.sqrt(np.median(a * a) / np.log(2))       # complex noise: median |y|² = P·ln 2
        lim = max(NB_SIGMA * rms, NB_MARK * (self.hi or 0.0))
        over = a > lim
        if not over.any():
            return y
        # Each burst is widened by the decimation filter length (the filter smears the impulse).
        pad = len(self.h) // self.D + 1
        over = np.convolve(over, np.ones(2 * pad + 1), mode="same") > 0
        edges = np.flatnonzero(np.diff(np.concatenate(([0], over.astype(np.int8), [0]))))
        y = y.copy()
        for s0, s1 in zip(edges[::2], edges[1::2]):
            if (s1 - s0) * 1000 / self.r <= NB_MAX_MS:
                y[s0:s1] = 0
        return y

    def _afc(self, band):
        """The strongest tone in the band; jumps to another only if it is clearly stronger than the current one."""
        if len(self.buf) < NFFT:
            return
        segs = self.buf[-(len(self.buf) // NFFT) * NFFT:].reshape(-1, NFFT) * np.hanning(NFFT)
        p = np.fft.fftshift(np.mean(np.abs(np.fft.fft(segs, axis=1)) ** 2, axis=0))
        f = np.fft.fftshift(np.fft.fftfreq(NFFT, 1 / self.r))
        lo, hi = max(band[0], -0.45 * self.r), min(band[1], 0.45 * self.r)
        sel = (f >= lo) & (f <= hi)
        if sel.sum() < 8:
            return
        ps = np.convolve(p, np.ones(5) / 5, mode="same")   # ±5 Hz, the tone is not exactly in one bin
        noise = float(np.median(p[sel])) + 1e-20
        # Noise floor for the keying threshold. A bin of the Hann-windowed FFT has E|X|² = N·r·Σw² (N = noise density),
        # a moving average of n samples has variance N·r/n, the Rayleigh sigma of its magnitude is sqrt(variance / 2).
        # The median of a mean of K exponential values is ≈ (1 - 2/9K)³ of its mean.
        k = len(segs)
        mean = noise / (1 - 2 / (9 * k)) ** 3
        self.sig_r = float(np.sqrt(mean / np.sum(np.hanning(NFFT) ** 2) / 2))
        i = int(np.argmax(np.where(sel, ps, 0)))
        best, fbest = float(ps[i]), float(f[i])
        if self.tone is not None and lo <= self.tone <= hi:
            j = int(np.argmin(np.abs(f - self.tone)))
            cur = float(ps[j])
            if cur * 2 > best and cur / noise >= MIN_SNR:   # stay on the current station
                i, best, fbest = j, cur, self.tone
        # Parabolic interpolation of the peak.
        if 0 < i < len(ps) - 1:
            a, b, c = ps[i - 1], ps[i], ps[i + 1]
            d = a - 2 * b + c
            if d < 0:
                fbest = float(f[i]) + 0.5 * (a - c) / d * (f[1] - f[0])
        self.snr = best / noise
        if self.snr >= MIN_SNR:
            if self.tone is None or abs(fbest - self.tone) > 30:
                self._reset_keying()
            self.tone = fbest
            self.present = True
        else:
            self.present = False

    def _reset_keying(self):
        self.hi = None
        self.mark_e = []
        self.key = False
        self.run = 0
        self.symbol = ""
        self.space_done = 2

    def _envelope(self, y):
        if self.tone is None:
            return
        step = -2 * np.pi * self.tone / self.r
        z = y * np.exp(1j * (self.nco + step * np.arange(len(y)))).astype(np.complex64)
        self.nco = (self.nco + step * len(y)) % (2 * np.pi)
        buf = np.concatenate((self.box_hist, z))
        self.box_hist = buf[-(MAX_BOX - 1):]
        c = np.concatenate(([0], np.cumsum(buf)))
        end = np.arange(MAX_BOX, len(c))            # end of the window for each new sample
        idx = np.arange(self.tick_off, len(end), TICK)
        self.tick_off = (idx[-1] + TICK - len(end)) if idx.size else self.tick_off - len(end)
        end = end[idx]
        # Filter width by speed: window ≈ a third of a dot (slow CW = narrow filter, better SNR).
        n = int(np.clip(self.dot_ms / 3 * self.r / 1000, BOX, MAX_BOX))
        self.sqn = np.sqrt(n)
        self.fine.extend(np.abs(c[end] - c[end - BOX]) / BOX)
        for e in np.abs(c[end] - c[end - n]) / n:
            self._tick(float(e))
            self.ticks += 1
            if self.ticks % 500 == 0:
                self._estimate_speed()

    def _estimate_speed(self):
        """Speed from the last 15 s of the envelope. The smoothing is chosen by the best separation of the
        mark/noise levels: short leaves noise, too long merges elements. The envelope is divided by the local maximum
        (≈ AGC) so that fading (QSB) does not move the threshold. The estimate is used only if the mark lengths really
        fit dots and dashes."""
        x = np.array(self.fine)
        if len(x) < 1500 or not self.present:
            return
        best = None
        for w in (8, 12, 16, 24, 32, 48, 64, 96, 128):   # ms
            k = max(1, (w - 8) // 2)
            s = np.convolve(x, np.ones(k) / k, mode="valid") if k > 1 else x
            s = s / (maximum_filter1d(s, 1000) + 1e-12)
            q, th = otsu(s)
            if best is None or q > best[0]:
                best = (q, w, s > th)
        _, w, on = best
        # Short gaps (fading) are filled, short noise bursts removed.
        on = smooth_runs(on, max(1, int(0.75 * w / 2)))
        edges = np.flatnonzero(np.diff(on.astype(np.int8)))
        if len(edges) < 6:
            return
        runs = np.diff(edges) * 2.0
        res = dot_from_marks(runs[on[edges[:-1] + 1]])
        if res is None or res[1] < FIT_MIN:
            return
        found = res[0]
        if abs(np.log(found / self.dot_ms)) > np.log(1.5):
            # A big jump (another station, initial estimate) is accepted only after 3 matching estimates in a row.
            if self.jump and abs(np.log(found / self.jump[0])) < np.log(1.3):
                self.jump = (found, self.jump[1] + 1)
            else:
                self.jump = (found, 1)
            if self.jump[1] >= 3 or self.ticks < 5000:   # at the start (first 10 s) immediately
                self.dot_ms = found
                self.jump = None
        else:
            self.jump = None
            self.dot_ms = 0.6 * self.dot_ms + 0.4 * found
        self.dot_ms = float(np.clip(self.dot_ms, 20, 400))

    def _tick(self, e):
        # Noise floor from the AFC (Rayleigh sigma, mean = 1.253 sigma), scaled to the current filter width.
        if self.sig_r is None:
            return
        sig = self.sig_r / self.sqn
        self.lo = 1.253 * sig
        # Mark level (hi): from the decoded marks (see _edge); it rises at once with a stronger signal; after a pause
        # longer than a word space it falls back to the noise within a few dots (after a fade the threshold is not too high).
        if self.key and self.hi is not None and e > self.hi:
            self.hi += (e - self.hi) * 0.1
        elif not self.key and self.hi is not None and self.run * 2 > 7 * self.dot_ms:
            self.hi = self.lo + (self.hi - self.lo) * (1 - 2 / (6 * self.dot_ms))
        rel = self.lo + (TH_OFF if self.key else TH_ON) * ((self.hi or 0.0) - self.lo)
        on = e > max(rel, (FLOOR_OFF if self.key else FLOOR_ON) * sig)
        if not self.present:
            on = False
        if self.key:
            self.mark_e.append(e)
        # Suppressing glitches and short fades: a change must last at least a third of a dot.
        deb = max(2, int(self.dot_ms / 2 * 0.35))
        if on != self.key:
            self.cand_n += 1
            if self.cand_n >= deb:
                self._edge(self.run * 2 + 0)
                self.key = on
                self.run = self.cand_n
                self.cand_n = 0
        else:
            self.cand_n = 0
            self.run += 1
        if not self.key:
            self._space_check(self.run * 2)

    def _edge(self, dur_ms):
        """End of a key state that lasted dur_ms."""
        if self.key:   # a mark ends
            self._mark(dur_ms)
            m = self.mark_e
            # Only real elements: noise blips just above the floor would pull the mark level down.
            if 0.6 * self.dot_ms <= dur_ms <= 10 * self.dot_ms and len(m) >= 3:
                lvl = float(np.median(m[len(m) // 4: len(m) - len(m) // 4 or None]))
                self.hi = lvl if self.hi is None else (1 - HI_NEW) * self.hi + HI_NEW * lvl
            self.mark_e = []
        else:
            self.space_done = 0

    def _mark(self, ms):
        if ms > 10 * self.dot_ms and ms > 600:   # a carrier or tuning, not a mark
            return
        self.symbol += "." if ms < 2 * self.dot_ms else "-"
        if len(self.symbol) > 9:
            self.symbol = self.symbol[-9:]

    def _space_check(self, ms):
        if self.space_done == 0 and ms > 2 * self.dot_ms:
            if self.symbol:
                self._emit(MORSE.get(self.symbol, "*"))
            self.symbol = ""
            self.space_done = 1
        if self.space_done == 1 and ms > 5 * self.dot_ms:
            if self.text and self.text[-1] != " ":
                self._emit(" ")
            self.space_done = 2

    def _emit(self, s):
        self.text.extend(s)
        self.on_event("cwtext", {"t": s})

    def _emit_state(self):
        i = self.info()
        del i["text"]
        self.on_event("cwstate", i)
