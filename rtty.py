"""RTTY dekodér (Baudot/ITA2) z basebandu s automatickou detekciou posunu, rýchlosti a polarity.

Postup: decimácia na 8 kHz -> AFC v spektre posledných 4 s nájde dvojicu tónov mark/space
(posun 90–1000 Hz, alebo zadaný) -> každý tón zmiešaný na 0 Hz a kĺzavý priemer dĺžky jedného
bitu -> rozdiel obálok (m - s)/(m + s) -> rýchlosť z polôh hrán (hrany ležia na mriežke 1/baud)
-> asynchrónny prijímač (štart, 5 bitov, stop) pre obe polarity naraz; text ide z tej, ktorá
má menej chýb rámca. Mark je vyšší tón na RF (bežná „normal“ polarita), nezávisle od módu.
"""
import collections
import threading

import numpy as np

from sdr import lowpass

RATE = 8000.0          # Hz, vzorkovanie po decimácii
NFFT = 2048            # rozlíšenie AFC ≈ 4 Hz
AFC_SEC = 4            # okno AFC
MIN_SNR = 5.0          # výkon slabšieho z tónov voči šumu (≈ 7 dB)
SHIFTS = (170, 200, 425, 450, 850)
BAUDS = (45.45, 50.0, 75.0, 100.0)
EDGE_SEC = 8           # okno odhadu rýchlosti
FAST_BOX = 24          # 3 ms, rýchly filter na polohu hrán
OVERSAMPLE = 16        # vzoriek na bit pre prijímač znakov
MAX_BOX = int(RATE / 40) + 1   # najdlhší filter bitu (pod 45,45 Bd)

# ITA2 v americkom variante (bežný v rádioamatérskom RTTY); kód = bity v poradí vysielania, LSB prvý.
LTRS = ["", "E", "\n", "A", " ", "S", "I", "U", "\r", "D", "R", "J", "N", "F", "C", "K",
        "T", "Z", "L", "W", "H", "Y", "P", "Q", "O", "B", "G", None, "M", "X", "V", None]
_FIG = {"E": "3", "A": "-", "S": "", "I": "8", "U": "7", "D": "$", "R": "4", "J": "'", "N": ",",
        "F": "!", "C": ":", "K": "(", "T": "5", "Z": '"', "L": ")", "W": "2", "H": "#", "Y": "6",
        "P": "0", "Q": "1", "O": "9", "B": "?", "G": "&", "M": ".", "X": "/", "V": ";"}
FIGS = [_FIG.get(c, c) for c in LTRS]
FIGS_CODE, LTRS_CODE = 27, 31


class _Uart:
    """Asynchrónny prijímač znakov pre jednu polaritu. Vstup: kladné = mark, záporné = space."""

    def __init__(self, sign):
        self.sign = sign
        self.events = collections.deque(maxlen=40)   # True = dobrý znak, False = chyba rámca
        self.reset()

    def reset(self):
        self.pos = None          # None = čaká na štart bit
        self.prev = 1.0
        self.figs = False
        self.events.clear()

    def step(self, v, T):
        """Jedna vzorka; T = dĺžka bitu vo vzorkách. Vráti kód znaku, -1 pri chybe rámca, inak None.
        Kĺzavý priemer oneskorí prechod o pol bitu, preto stred bitu k je v (k + 0,5)·T od prechodu."""
        if self.pos is None:
            if self.prev > 0 >= v:          # mark -> space: začiatok štart bitu
                self.pos, self.k, self.bits = 0, 0, 0
            self.prev = v
            return None
        self.pos += 1
        if self.pos < (self.k + 0.5) * T:
            return None
        bit = v > 0
        if self.k == 0:
            if bit:                         # záblesk šumu, nie štart bit
                self.pos, self.prev = None, v
                return None
        elif self.k <= 5:
            self.bits |= int(bit) << (self.k - 1)
        else:                               # stop bit musí byť mark
            self.pos, self.prev = None, v
            self.events.append(bool(bit))
            return self.bits if bit else -1
        self.k += 1
        return None

    def decode(self, code):
        if code == FIGS_CODE:
            self.figs = True
            return ""
        if code == LTRS_CODE:
            self.figs = False
            return ""
        ch = (FIGS if self.figs else LTRS)[code]
        if ch == " ":
            self.figs = False               # unshift on space
        return "" if ch == "\r" else ch

    def score(self):
        return 2 * sum(self.events) - len(self.events)


class RttyDecoder:
    def __init__(self, on_event):
        self.on_event = on_event
        self.enabled = False
        self.lock = threading.Lock()
        self.text = collections.deque(maxlen=8000)
        self.dial = 0.0
        self.opts = {"shift": "auto", "baud": "auto", "polarity": "auto"}
        self.center = None       # Hz voči ladenej frekvencii, stred medzi tónmi
        self.shift = None
        self.baud = BAUDS[0]
        self.snr = 0.0
        self.present = False
        self.sel = 0
        self._fs = None

    # ---------- ovládanie ----------

    def set_enabled(self, on):
        with self.lock:
            self.enabled = bool(on)
            self._fs = None
        self._emit_state()

    def clear(self):
        with self.lock:
            self.text.clear()

    def set_options(self, opts):
        """shift: "auto" alebo Hz; baud: "auto" alebo Bd; polarity: auto/normal/reverse."""
        with self.lock:
            o = dict(self.opts)
            if "shift" in opts:
                s = opts["shift"]
                o["shift"] = "auto" if s == "auto" else float(np.clip(float(s), 50, 1200))
            if "baud" in opts:
                b = opts["baud"]
                o["baud"] = "auto" if b == "auto" else float(np.clip(float(b), 30, 300))
            if opts.get("polarity") in ("auto", "normal", "reverse"):
                o["polarity"] = opts["polarity"]
            self.opts = o
            if o["baud"] != "auto":
                self.baud = o["baud"]
            if o["polarity"] != "auto":
                self.sel = 0 if o["polarity"] == "normal" else 1
            if self._fs:
                self._unlock()
        self._emit_state()

    def info(self):
        locked = self.center is not None
        std = None
        if locked:
            near = min(SHIFTS, key=lambda s: abs(s - self.shift))
            std = near if abs(near - self.shift) <= 15 else None
        return {
            "enabled": self.enabled, "present": self.present, "opts": self.opts,
            "snr_db": round(10 * np.log10(max(self.snr, 1e-3)), 1),
            "shift_hz": round(self.shift) if locked else None, "std_shift": std,
            "baud": self.baud, "polarity": "normal" if self.sel == 0 else "reverse",
            "mark_hz": round(self.dial + self.center + self.shift / 2) if locked else None,
            "space_hz": round(self.dial + self.center - self.shift / 2) if locked else None,
            "text": "".join(self.text),
        }

    # ---------- spracovanie signálu ----------

    def _setup(self, fs):
        self._fs = fs
        self.D = max(1, int(round(fs / RATE)))
        self.r = fs / self.D
        self.h = lowpass(0.45 * self.r, fs, 63)
        self.hist = np.zeros(len(self.h) - 1, np.complex64)
        self.dec_off = 0
        self.buf = np.zeros(0, np.complex64)
        self.since_afc = 0
        self.since_state = 0
        self.n = 0
        self.uarts = [_Uart(1), _Uart(-1)]
        self.baud_cand = None
        self._unlock()

    def _unlock(self):
        """Nové ladenie alebo nastavenia: zabudnúť tóny, hrany a rozpracované znaky."""
        self.center = self.shift = None
        self.present = False
        self.snr = 0.0
        self._reset_demod()

    def _reset_demod(self):
        self.box_hist = {k: np.zeros(MAX_BOX - 1, np.complex128) for k in ("m", "s")}
        self.fast_hist = [np.zeros(FAST_BOX - 1, np.complex128) for _ in range(2)]
        self.u_off = 0
        self.fstate = 0
        self.edges = collections.deque(maxlen=1000)
        for u in self.uarts:
            u.reset()

    def feed(self, base, fs, dial_hz, band):
        """base: komplexný baseband (ladená frekvencia = 0 Hz); band: (od, do) Hz hľadania tónov."""
        if not self.enabled:
            return
        with self.lock:
            if fs != self._fs:
                self._setup(fs)
            if dial_hz != self.dial:
                self.dial = dial_hz
                self._unlock()
            buf = np.concatenate((self.hist, base))
            self.hist = buf[-(len(self.h) - 1):]
            y = np.convolve(buf, self.h, mode="valid")[self.dec_off::self.D]
            self.dec_off = (self.dec_off - len(base)) % self.D
            self.buf = np.concatenate((self.buf, y))[-int(AFC_SEC * self.r):]
            self.since_afc += len(y)
            if self.since_afc >= self.r / 2:
                self.since_afc = 0
                self._afc(band)
                self._estimate_baud()
            out = self._demod(y)
            self.n += len(y)
            self.since_state += len(y)
            if out:
                self.text.extend(out)
        if out:
            self.on_event("rttytext", {"t": out})
        if self.since_state >= self.r:
            self.since_state = 0
            self._emit_state()

    def _afc(self, band):
        """Dvojica tónov s posunom v povolenom rozsahu; súčasnú drží, kým je aspoň polovične silná."""
        if len(self.buf) < NFFT:
            return
        segs = self.buf[-(len(self.buf) // NFFT) * NFFT:].reshape(-1, NFFT) * np.hanning(NFFT)
        p = np.fft.fftshift(np.mean(np.abs(np.fft.fft(segs, axis=1)) ** 2, axis=0))
        f = np.fft.fftshift(np.fft.fftfreq(NFFT, 1 / self.r))
        lo, hi = max(band[0], -0.45 * self.r), min(band[1], 0.45 * self.r)
        sel = (f >= lo) & (f <= hi)
        if sel.sum() < 16:
            return
        ps = np.convolve(p, np.ones(5) / 5, mode="same")
        noise = float(np.median(p[sel])) + 1e-20
        peak = np.zeros_like(sel)
        peak[1:-1] = sel[1:-1] & (ps[1:-1] >= ps[:-2]) & (ps[1:-1] > ps[2:]) & (ps[1:-1] > MIN_SNR * noise)
        cand = np.flatnonzero(peak)
        cand = cand[np.argsort(ps[cand])[::-1][:10]]
        if self.opts["shift"] == "auto":
            smin, smax = 90.0, 1000.0
        else:
            smin, smax = self.opts["shift"] - 25, self.opts["shift"] + 25
        best = keep = None
        for a in cand:
            for b in cand:
                if f[b] <= f[a] or not smin <= f[b] - f[a] <= smax:
                    continue
                pa, pb = ps[a], ps[b]
                if max(pa, pb) > 10 * min(pa, pb):
                    continue
                sc = min(pa, pb)
                if best is None or sc > best[0]:
                    best = (sc, a, b)
                if (self.center is not None and abs(f[a] - (self.center - self.shift / 2)) < 20
                        and abs(f[b] - (self.center + self.shift / 2)) < 20
                        and (keep is None or sc > keep[0])):
                    keep = (sc, a, b)
        if best is None:
            self.present = False
            self.snr = 0.0
            return
        if keep is not None and keep[0] * 2 > best[0]:
            best = keep
        sc, a, b = best
        fa, fb = self._refine(ps, f, a), self._refine(ps, f, b)
        center, shift = (fa + fb) / 2, fb - fa
        self.snr = sc / noise
        self.present = True
        if self.center is None or abs(center - self.center) > 15 or abs(shift - self.shift) > 15:
            self.center, self.shift = center, shift
            self._reset_demod()
        else:
            self.center = 0.8 * self.center + 0.2 * center
            self.shift = 0.8 * self.shift + 0.2 * shift

    @staticmethod
    def _refine(ps, f, i):
        """Parabolická interpolácia vrcholu."""
        if 0 < i < len(ps) - 1:
            a, b, c = ps[i - 1], ps[i], ps[i + 1]
            d = a - 2 * b + c
            if d < 0:
                return float(f[i]) + 0.5 * (a - c) / d * (f[1] - f[0])
        return float(f[i])

    def _estimate_baud(self):
        """Rýchlosť z dĺžok úsekov medzi hranami: žiadny nie je kratší ako bit a každý je násobkom
        pol bitu (1,5 stop bitu). Dvojnásobnej rýchlosti (100 pri 50 Bd) vyhovie každý signál,
        preto berieme najnižšiu vyhovujúcu; pomalšia, než je skutočná, má priveľa krátkych úsekov
        (jednotlivé bity). Medzi blízkymi (45,45 / 50) rozhodne lepšia zhoda."""
        if self.opts["baud"] != "auto" or not self.present:
            return
        e = np.array(self.edges, float)
        e = e[e > self.n - EDGE_SEC * self.r]
        if len(e) < 16:
            return
        iv = np.diff(e) / self.r
        iv = iv[iv < 0.2]                     # dlhé pokoje (mark) neurčujú rýchlosť
        if len(iv) < 12:
            return
        ok = []
        for b in BAUDS:
            ub = iv * b                       # v bitoch
            if np.mean(ub < 0.72) > 0.15:     # 75 Bd voči 50 je 0,67 bitu
                continue
            fit = float(np.mean(np.abs(ub * 2 - np.round(ub * 2)) < 0.24))
            if fit >= 0.6:
                ok.append((b, fit))
        if not ok:
            return
        b, fit = ok[0]
        if len(ok) > 1 and ok[1][0] / b < 1.2 and ok[1][1] > fit:
            b = ok[1][0]
        if b == self.baud:
            self.baud_cand = None
            return
        # zmenu prijmeme po troch zhodných odhadoch za sebou
        self.baud_cand = (b, self.baud_cand[1] + 1) if self.baud_cand and self.baud_cand[0] == b else (b, 1)
        if self.baud_cand[1] >= 3:
            self.baud = b
            self.baud_cand = None
            for u in self.uarts:
                u.reset()

    def _box(self, key, z, L):
        """|kĺzavý priemer| dĺžky L pre každú novú vzorku z."""
        h = self.box_hist[key]
        buf = np.concatenate((h, z))
        self.box_hist[key] = buf[-(MAX_BOX - 1):]
        c = np.concatenate(([0], np.cumsum(buf)))
        end = np.arange(len(h) + 1, len(buf) + 1)
        return np.abs(c[end] - c[end - L]) / L

    def _demod(self, y):
        if self.center is None:
            return ""
        t = (self.n + np.arange(len(y))) / self.r
        fm, fsp = self.center + self.shift / 2, self.center - self.shift / 2
        zm = y * np.exp(-2j * np.pi * ((fm * t) % 1.0))
        zs = y * np.exp(-2j * np.pi * ((fsp * t) % 1.0))
        L = int(np.clip(round(self.r / self.baud), FAST_BOX, MAX_BOX))
        m, s = self._box("m", zm, L), self._box("s", zs, L)
        d = (m - s) / (m + s + 1e-12)
        # rýchly filter: poloha hrán pre odhad rýchlosti (prechod cez ±0,3 s hysterézou)
        mf, sf = self._fast(zm, zs)
        df = (mf - sf) / (mf + sf + 1e-12)
        if self.present:
            q = np.where(df > 0.3, 1, np.where(df < -0.3, -1, 0))
            nz = np.flatnonzero(q)
            if nz.size:
                v = q[nz]
                prev = np.concatenate(([self.fstate], v[:-1]))
                ch = nz[(v != prev) & (prev != 0)]
                self.edges.extend((self.n + ch).tolist())
                self.fstate = int(v[-1])
        # prijímač znakov: ~16 vzoriek na bit
        k = max(1, int(self.r / (self.baud * OVERSAMPLE)))
        du = d[self.u_off::k]
        self.u_off = (self.u_off - len(d)) % k
        T = self.r / k / self.baud
        out = []
        auto = self.opts["polarity"] == "auto"
        for v in du.tolist():
            for i, u in enumerate(self.uarts):
                code = u.step(v * u.sign, T)
                if code is None or code < 0:
                    continue
                ch = u.decode(code)
                if ch and i == self.sel and self.present and self._good(u):
                    out.append(ch)
        if auto:
            a, b = self.uarts[0].score(), self.uarts[1].score()
            if self.sel == 0 and b > a + 6:
                self.sel = 1
            elif self.sel == 1 and a > b + 6:
                self.sel = 0
        return "".join(out)

    def _fast(self, zm, zs):
        """Obálky tónov s krátkym (3 ms) filtrom; vlastná história, nezávislá od dĺžky bitu."""
        res = []
        for i, z in enumerate((zm, zs)):
            buf = np.concatenate((self.fast_hist[i], z))
            self.fast_hist[i] = buf[-(FAST_BOX - 1):]
            c = np.concatenate(([0], np.cumsum(buf)))
            res.append(np.abs(c[FAST_BOX:] - c[:-FAST_BOX]) / FAST_BOX)
        return res

    @staticmethod
    def _good(u):
        """Text púšťame, len kým väčšina posledných znakov má správny rámec (šum ho nemá)."""
        ev = list(u.events)[-20:]
        return len(ev) < 4 or sum(ev) >= 0.6 * len(ev)

    def _emit_state(self):
        i = self.info()
        del i["text"]
        self.on_event("rttystate", i)
