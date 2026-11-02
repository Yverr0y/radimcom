"""CW (Morse) dekodér z basebandu prijímača s automatickým doladením tónu a rýchlosti.

Postup: decimácia na 8 kHz -> AFC nájde najsilnejší tón v pásme prijímača (Welchovo spektrum
posledných 6 s) -> zmiešanie tónu na 0 Hz a filter (kĺzavý priemer) so šírkou podľa rýchlosti
-> obálka každé 2 ms -> adaptívny prah s hysterézou -> dĺžky značiek a medzier -> bodka/čiarka
-> znaky podľa Morseovej tabuľky. Rýchlosť sa raz za sekundu odhaduje z posledných 15 s obálky
(vyhladenie s najlepším odstupom značka/šum, rozdelenie značiek na krátke a dlhé).
"""
import collections
import threading

import numpy as np
from scipy.ndimage import maximum_filter1d

from sdr import lowpass

RATE = 8000.0          # Hz, vzorkovanie po decimácii
TICK = 16              # vzoriek na jeden krok obálky (2 ms)
BOX = 64               # najkratší kĺzavý priemer (8 ms ≈ 125 Hz šírka filtra) pre rýchle CW
MAX_BOX = 800          # najdlhší (100 ms ≈ 10 Hz) pre veľmi pomalé CW
NFFT = 4096            # rozlíšenie AFC ≈ 2 Hz
AFC_SEC = 6            # okno AFC; aj pri pomalom CW musí obsiahnuť niekoľko značiek
MIN_SNR = 6.0          # pomer výkonu tónu k šumu v spektre (≈ 8 dB), pod ním dekodér mlčí

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
    """Dĺžka bodky z dĺžok značiek: najlepšie rozdelenie na krátke a dlhé (v log mierke),
    čiarka = 3 bodky. Vráti (bodka ms, podiel značiek, ktoré sedia na bodku alebo čiarku ±40 %),
    alebo None, ak značiek je málo alebo nie sú dve zreteľné skupiny."""
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
    """Najlepší prah medzi dvoma úrovňami (značka/šum) a jeho kvalita: rozdiel stredov
    delený súčtom rozptylov. Delenia s menej ako 10 % na jednej strane sa nepočítajú."""
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
    """Zacelí medzery kratšie ako k krokov a potom zmaže značky kratšie ako k (uzáver + otvorenie)."""
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
        self.tone = None         # Hz voči ladenej frekvencii
        self.snr = 0.0
        self.dot_ms = 60.0       # 20 WPM
        self.present = False
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
    def info(self):
        return {
            "enabled": self.enabled, "wpm": round(1200 / self.dot_ms), "present": self.present,
            "snr_db": round(10 * np.log10(max(self.snr, 1e-3)), 1),
            "tone_hz": None if self.tone is None else round(self.tone),
            "freq_hz": None if self.tone is None else round(self.dial + self.tone),
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
        self.buf = np.zeros(0, np.complex64)       # posledných AFC_SEC sekúnd pre AFC
        self.since_afc = 0
        self.nco = 0.0
        self.box_hist = np.zeros(MAX_BOX - 1, np.complex64)
        self.tick_off = 0
        self.ticks = 0
        self.jump = None
        self.fine = collections.deque(maxlen=7500)  # obálka s 8 ms filtrom za posledných 15 s
        self.tone = None
        self.snr = 0.0
        self.present = False
        self.lo = self.hi = None
        self.key = False
        self.cand_n = 0
        self.run = 0              # počet krokov v aktuálnom stave kľúča
        self.symbol = ""
        self.space_done = 0       # 0 = nič, 1 = znak ukončený, 2 = aj medzera slova
        self.since_state = 0

    def feed(self, base, fs, dial_hz, band):
        """base: komplexný baseband (ladená frekvencia = 0 Hz); band: (od, do) Hz hľadania tónu."""
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

    def _afc(self, band):
        """Najsilnejší tón v pásme; preskočí na iný len ak je výrazne silnejší ako ten súčasný."""
        if len(self.buf) < NFFT:
            return
        segs = self.buf[-(len(self.buf) // NFFT) * NFFT:].reshape(-1, NFFT) * np.hanning(NFFT)
        p = np.fft.fftshift(np.mean(np.abs(np.fft.fft(segs, axis=1)) ** 2, axis=0))
        f = np.fft.fftshift(np.fft.fftfreq(NFFT, 1 / self.r))
        lo, hi = max(band[0], -0.45 * self.r), min(band[1], 0.45 * self.r)
        sel = (f >= lo) & (f <= hi)
        if sel.sum() < 8:
            return
        ps = np.convolve(p, np.ones(5) / 5, mode="same")   # ±5 Hz, tón nie je presne v jednom koši
        noise = float(np.median(p[sel])) + 1e-20
        i = int(np.argmax(np.where(sel, ps, 0)))
        best, fbest = float(ps[i]), float(f[i])
        if self.tone is not None and lo <= self.tone <= hi:
            j = int(np.argmin(np.abs(f - self.tone)))
            cur = float(ps[j])
            if cur * 2 > best and cur / noise >= MIN_SNR:   # ostávame na súčasnej stanici
                i, best, fbest = j, cur, self.tone
        # Parabolická interpolácia vrcholu.
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
        self.lo = self.hi = None
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
        end = np.arange(MAX_BOX, len(c))            # koniec okna pre každú novú vzorku
        idx = np.arange(self.tick_off, len(end), TICK)
        self.tick_off = (idx[-1] + TICK - len(end)) if idx.size else self.tick_off - len(end)
        end = end[idx]
        # Šírka filtra podľa rýchlosti: okno ≈ tretina bodky (pomalé CW = úzky filter, lepší SNR).
        n = int(np.clip(self.dot_ms / 3 * self.r / 1000, BOX, MAX_BOX))
        self.fine.extend(np.abs(c[end] - c[end - BOX]) / BOX)
        for e in np.abs(c[end] - c[end - n]) / n:
            self._tick(float(e))
            self.ticks += 1
            if self.ticks % 500 == 0:
                self._estimate_speed()

    def _estimate_speed(self):
        """Rýchlosť z posledných 15 s obálky. Vyhladenie volíme podľa najlepšieho odstupu úrovní
        značka/šum: krátke necháva šum, príliš dlhé zlieva prvky. Obálku delíme miestnym maximom
        (≈ AGC), aby úniky (QSB) neposúvali prah. Odhad sa použije, len ak dĺžky značiek naozaj
        sedia na bodky a čiarky."""
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
        # Krátke medzery (úniky) zacelíme, krátke záblesky šumu odstránime.
        on = smooth_runs(on, max(1, int(0.75 * w / 2)))
        edges = np.flatnonzero(np.diff(on.astype(np.int8)))
        if len(edges) < 6:
            return
        runs = np.diff(edges) * 2.0
        res = dot_from_marks(runs[on[edges[:-1] + 1]])
        if res is None or res[1] < 0.7:
            return
        found = res[0]
        if abs(np.log(found / self.dot_ms)) > np.log(1.5):
            # Veľký skok (iná stanica, úvodný odhad) prijmeme až po 3 zhodných odhadoch za sebou.
            if self.jump and abs(np.log(found / self.jump[0])) < np.log(1.3):
                self.jump = (found, self.jump[1] + 1)
            else:
                self.jump = (found, 1)
            if self.jump[1] >= 3 or self.ticks < 5000:   # na začiatku (prvých 10 s) hneď
                self.dot_ms = found
                self.jump = None
        else:
            self.jump = None
            self.dot_ms = 0.6 * self.dot_ms + 0.4 * found
        self.dot_ms = float(np.clip(self.dot_ms, 20, 400))

    def _tick(self, e):
        # Sledovanie úrovne značky (hi) a šumu (lo); časové konštanty ≈ 20 bodiek.
        if self.lo is None:
            self.lo = self.hi = e
        slow = 2 / (20 * self.dot_ms)
        if e > self.hi:
            self.hi += (e - self.hi) * 0.2
        else:
            self.hi += (e - self.hi) * slow
        if e < self.lo:
            self.lo += (e - self.lo) * 0.05
        else:
            self.lo += (e - self.lo) * slow
        span = self.hi - self.lo
        on = e > self.lo + (0.4 if self.key else 0.6) * span
        if not self.present or self.hi < 1.8 * self.lo:
            on = False
        # Potlačenie zákmitov a krátkych únikov: zmena musí trvať aspoň tretinu bodky.
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
        """Koniec stavu kľúča trvajúceho dur_ms."""
        if self.key:   # končí značka
            self._mark(dur_ms)
        else:
            self.space_done = 0

    def _mark(self, ms):
        if ms > 10 * self.dot_ms and ms > 600:   # nosná alebo ladenie, nie značka
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
