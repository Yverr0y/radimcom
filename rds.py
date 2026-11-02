"""RDS dekodér z MPX signálu WFM: PI, PS (názov stanice), RadioText, PTY, TP/TA a čas (CT).

Postup: zmiešanie 57 kHz nosnej na 0 Hz, dolná priepusť a decimácia na ~24 kHz, fáza nosnej
z druhej mocniny signálu (BPSK; nejednoznačnosť π rieši diferenciálne kódovanie), prispôsobený
filter na bifázový symbol, časovanie bitov podľa energie v 32 fázach periódy bitu,
diferenciálne dekódovanie, synchronizácia blokov cez syndróm a dekódovanie skupín 0, 2 a 4A.
"""
import numpy as np

BIT_RATE = 1187.5
SUBCARRIER = 57e3
POLY = 0x5B9                      # g(x) = x^10 + x^8 + x^7 + x^5 + x^4 + x^3 + 1
OFFSETS = {0x0FC: 0, 0x198: 1, 0x168: 2, 0x350: 2, 0x1B4: 3}   # A, B, C, C', D -> poradie v skupine
TIMING_BINS = 32

PTY_NAMES = (
    "", "News", "Current Affairs", "Information", "Sport", "Education", "Drama", "Culture", "Science",
    "Varied", "Pop Music", "Rock Music", "Easy Listening", "Light Classical", "Serious Classical",
    "Other Music", "Weather", "Finance", "Children's", "Social Affairs", "Religion", "Phone-In", "Travel",
    "Leisure", "Jazz Music", "Country Music", "National Music", "Oldies Music", "Folk Music",
    "Documentary", "Alarm Test", "Alarm")

# Znaková sada RDS (EN 50067, príloha E): 0x20–0x7D ako ASCII, vyššie kódy podľa tabuľky.
_HIGH = ("áàéèíìóòúùÑÇŞβ¡Ĳâäêëîïôöûüñçşğıĳªα©‰Ğěňőπ€£$←↑→↓º¹²³±İńűµ¿÷°¼½¾§"
         "ÁÀÉÈÍÌÓÒÚÙŘČŠŽĐĿÂÄÊËÎÏÔÖÛÜřčšžđŀÃÅÆŒŷÝÕØÞŊŔĆŚŹŦðãåæœŵýõøþŋŕćśźŧ ")


def rds_char(code):
    if 0x20 <= code <= 0x7D:
        return chr(code)
    if code >= 0x80:
        return _HIGH[code - 0x80]
    return " "


def syndrome(word):
    """Zvyšok 26-bitového bloku po delení g(x); pre platný blok sa rovná jeho ofsetovému slovu."""
    for i in range(25, 9, -1):
        if word >> i & 1:
            word ^= POLY << (i - 10)
    return word


class RdsDecoder:
    def __init__(self, fs):
        from sdr import Decimator   # neskorý import: sdr importuje tento modul
        # Mocnina 2, aby delila dĺžku bloku MPX (Decimator potrebuje celé násobky).
        self.d = 1
        while fs / (self.d * 2) >= 20000:
            self.d *= 2
        self.rate = fs / self.d
        self.dec = Decimator(fs, cutoff=2600.0, decim=self.d, phases=96)
        self.w57 = 2 * np.pi * SUBCARRIER / fs
        self.tb = self.rate / BIT_RATE
        n = int(round(self.tb))
        t = np.arange(n) + 0.5
        self.mf = np.where(t < self.tb / 2, 1.0, -1.0)[::-1].astype(np.float32)
        self.reset()

    def reset(self):
        self.ph = 0.0
        self.sq = 0j                       # vyhladená druhá mocnina (fáza nosnej)
        self.carrier = 0.0
        self.hist = np.zeros(len(self.mf) - 1, np.float32)
        self.n0 = 0                        # absolútny index prvej vzorky bloku (pri self.rate)
        self.bins = np.zeros(TIMING_BINS)
        self.next_t = None
        self.prev_raw = 0
        self.reg = 0
        self.synced = False
        self.last_hit = None
        self.bitpos = 0
        self.blk_bits = 0
        self.expect = 0
        self.group = [None] * 4
        self.recent = []
        self.groups = 0
        self.pi = None
        self.pty = None
        self.tp = self.ta = False
        self.ps = [" "] * 8
        self.ps_seen = 0
        self.rt = [None] * 64
        self.rt_ab = None
        self.ct = None

    # ---------- signál -> bity ----------

    def process(self, mpx):
        n = len(mpx)
        mix = np.exp(-1j * (self.ph + self.w57 * np.arange(n))).astype(np.complex64)
        self.ph = (self.ph + self.w57 * n) % (2 * np.pi)
        z = self.dec.process(mpx.astype(np.float32) * mix)
        if not len(z):
            return
        # Fáza BPSK nosnej z z²; z dvoch možností (φ, φ+π) berieme tú bližšiu k predošlej.
        self.sq = 0.6 * self.sq + 0.4 * complex(np.sum(z.astype(np.complex128) ** 2)) / len(z)
        phi = np.angle(self.sq) / 2
        if abs(np.angle(np.exp(1j * (phi - self.carrier)))) > np.pi / 2:
            phi += np.pi
        self.carrier = phi
        s = (z * np.complex64(np.exp(-1j * phi))).real.astype(np.float32)

        buf = np.concatenate((self.hist, s))
        self.hist = buf[-(len(self.mf) - 1):]
        y = np.convolve(buf, self.mf, mode="valid")
        idx = self.n0 + np.arange(len(y))
        b = ((idx % self.tb) / self.tb * TIMING_BINS).astype(int) % TIMING_BINS
        self.bins = 0.8 * self.bins + np.bincount(b, weights=y.astype(np.float64) ** 2, minlength=TIMING_BINS)
        tau = (np.argmax(self.bins) + 0.5) / TIMING_BINS * self.tb

        end = self.n0 + len(y) - 1
        if self.next_t is None:
            self.next_t = self.n0 + (tau - self.n0 % self.tb) % self.tb
        while self.next_t < end:
            i = self.next_t - self.n0
            k = int(i)
            v = y[k] + (y[k + 1] - y[k]) * (i - k)
            raw = 1 if v > 0 else 0
            self._bit(raw ^ self.prev_raw)
            self.prev_raw = raw
            # Jemné doťahovanie hodín bitov k najsilnejšej fáze.
            err = (tau - self.next_t % self.tb + self.tb / 2) % self.tb - self.tb / 2
            self.next_t += self.tb + 0.05 * err
        self.n0 += len(y)

    # ---------- bity -> bloky -> skupiny ----------

    def _bit(self, bit):
        self.reg = ((self.reg << 1) | bit) & 0x3FFFFFF
        self.bitpos += 1
        if not self.synced:
            kind = OFFSETS.get(syndrome(self.reg))
            if kind is None:
                return
            if self.last_hit:
                pos, last = self.last_hit
                dist = self.bitpos - pos
                if dist % 26 == 0 and 0 < dist // 26 <= 6 and (last + dist // 26) % 4 == kind:
                    self.synced = True
                    self.recent = []
                    self.blk_bits = 0
                    self.group = [None] * 4
                    self._block(kind, True)
                    return
            self.last_hit = (self.bitpos, kind)
            return
        self.blk_bits += 1
        if self.blk_bits < 26:
            return
        self.blk_bits = 0
        kind = OFFSETS.get(syndrome(self.reg))
        ok = kind == self.expect
        self.recent = (self.recent + [ok])[-25:]
        if self.recent.count(False) > 12:
            self.synced = False
            self.last_hit = None
            return
        self._block(self.expect, ok)

    def _block(self, kind, ok):
        self.group[kind] = self.reg >> 10 if ok else None
        if kind == 3:
            self._group(*self.group)
            self.group = [None] * 4
        self.expect = (kind + 1) % 4

    def _group(self, a, b, c, d):
        if a is not None:
            self.pi = a
        if b is None:
            return
        self.groups += 1
        gtype, version_b = b >> 12, b >> 11 & 1
        self.tp = bool(b >> 10 & 1)
        self.pty = b >> 5 & 31
        if gtype == 0:
            self.ta = bool(b >> 4 & 1)
            if d is not None:
                i = 2 * (b & 3)
                self.ps[i], self.ps[i + 1] = rds_char(d >> 8), rds_char(d & 0xFF)
                self.ps_seen |= 1 << (b & 3)
        elif gtype == 2:
            ab = b >> 4 & 1
            if ab != self.rt_ab:
                self.rt = [None] * 64
                self.rt_ab = ab
            addr = b & 15
            if version_b:
                chunks = [(2 * addr, d)]
            else:
                chunks = [(4 * addr, c), (4 * addr + 2, d)]
            for pos, word in chunks:
                if word is not None:
                    self.rt[pos], self.rt[pos + 1] = word >> 8, word & 0xFF
        elif gtype == 4 and not version_b and c is not None and d is not None:
            mjd = (b & 3) << 15 | c >> 1
            hour, minute = (c & 1) << 4 | d >> 12, d >> 6 & 63
            off = (d & 31) * 30 * (-1 if d >> 5 & 1 else 1)
            if hour < 24 and minute < 60:
                # MJD -> dátum (EN 50067, príloha G)
                yp = int((mjd - 15078.2) / 365.25)
                mp = int((mjd - 14956.1 - int(yp * 365.25)) / 30.6001)
                day = mjd - 14956 - int(yp * 365.25) - int(mp * 30.6001)
                k = 1 if mp in (14, 15) else 0
                year, month = 1900 + yp + k, mp - 1 - 12 * k
                local = (hour * 60 + minute + off) % 1440
                self.ct = f"{year:04d}-{month:02d}-{day:02d} {hour:02d}:{minute:02d} UTC " \
                          f"(local {local // 60:02d}:{local % 60:02d})"

    def _radiotext(self):
        out = []
        for code in self.rt:
            if code == 0x0D:
                break
            out.append(" " if code is None else rds_char(code))
        return "".join(out).rstrip()

    def info(self):
        return {
            "sync": self.synced,
            "pi": None if self.pi is None else f"{self.pi:04X}",
            "ps": "".join(self.ps) if self.ps_seen else "",
            "rt": self._radiotext(),
            "pty": PTY_NAMES[self.pty] if self.pty else "",
            "tp": self.tp,
            "ta": self.ta,
            "ct": self.ct,
            "groups": self.groups,
        }
