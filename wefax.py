"""WEFAX (rádiofax) dekodér z basebandu prijímača s automatickou detekciou formátu.

Signál: FM subnosná, čierna = stred - 400 Hz, biela = stred + 400 Hz (pri USB ladení na
priradenú frekvenciu - 1,9 kHz je stred na 1900 Hz). Priebeh vysielania:
  štart tón (300 Hz = IOC 576, 675 Hz = IOC 288) -> fázovanie (riadky s impulzom na začiatku)
  -> obrázok -> stop tón 450 Hz.
Automatika: AFC nájde stred signálu v okolí ±3 kHz od ladenej frekvencie, IOC sa určí zo štart
tónu, rýchlosť riadkov (LPM) z autokorelácie a začiatok riadku z fázovacích impulzov. Bez štart
tónu (zapnuté uprostred vysielania) sa obrázok spustí sám, keď je v signáli periodicita riadkov.
"""
import base64
import math
import os
import struct
import threading
import time
import zlib

import numpy as np

from paths import data
from sdr import lowpass

LPMS = (60, 90, 120, 240)
IOCS = (576, 288)
DEV = 400.0            # Hz, odchýlka čierna/biela od stredu
DEFAULT_CENTER = 1900.0
RATE = 8000.0          # Hz, vzorkovanie po FM demodulácii
START_TONES = {300.0: 576, 675.0: 288}
STOP_TONE = 450.0
TONE_BLOCKS = 8        # tón musí trvať 8 × 0,25 s
SAVE_DIR = data("wefax")
# Priradené frekvencie DWD Pinneberg a Northwood GYA (Royal Navy, UK; 2618,5 kHz hlavne v noci),
# obe 120 LPM, IOC 576.
WEFAX_FREQS = ((3855000, "DWD 3855"), (7880000, "DWD 7880"), (13882500, "DWD 13882"),
               (2618500, "GYA 2618"), (4610000, "GYA 4610"), (8040000, "GYA 8040"), (11086500, "GYA 11086"))


def ioc_width(ioc):
    return int(round(math.pi * ioc))


def png_gray(rows, width):
    """8-bitový šedotónový PNG bez ďalších knižníc."""
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + r for r in rows)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, len(rows), 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


class WefaxDecoder:
    def __init__(self, on_event, save_dir=SAVE_DIR):
        self.on_event = on_event
        self.save_dir = save_dir
        self.enabled = False
        self.lpm_mode = "auto"
        self.ioc_mode = "auto"
        self.lock = threading.Lock()
        self.state = "idle"
        self.lpm = 120
        self.ioc = 576
        self.rows = []
        self.image_id = 0
        self.saved = None
        self._saved_id = None
        self.center = DEFAULT_CENTER
        self.afc_lock = False
        self.lpm_conf = 0.0
        self.dial = None
        self._fs = None
        self._state_at = 0.0

    # ---------- ovládanie ----------

    def set_enabled(self, on):
        with self.lock:
            if self.enabled and not on:
                self._finish()
            self.enabled = bool(on)
            self._fs = None
            self.state = "idle"
        self._emit_state()

    def command(self, b):
        """Príkazy z webu: action new/phase, lpm_mode, ioc_mode."""
        with self.lock:
            if "lpm_mode" in b:
                m = str(b["lpm_mode"])
                if m != "auto" and int(m) not in LPMS:
                    raise ValueError("unsupported LPM")
                self.lpm_mode = m
                if m != "auto" and int(m) != self.lpm:
                    self.lpm = int(m)
                    if self.state != "idle":
                        self._start_image("free")
            if "ioc_mode" in b:
                m = str(b["ioc_mode"])
                if m != "auto" and int(m) not in IOCS:
                    raise ValueError("unsupported IOC")
                self.ioc_mode = m
                if m != "auto" and int(m) != self.ioc:
                    self.ioc = int(m)
                    if self.state != "idle":
                        self._start_image("free")
            if b.get("action") == "new" and self._fs:
                self._start_image("free")
            if b.get("action") == "phase" and self._fs and self.state != "idle":
                # Klik do obrázka: zvolené miesto sa stane ľavým okrajom ďalších riadkov.
                x = float(b.get("x", 0)) % 1.0
                self.pos += (x - 1 if x > 0.5 else x) * self._line_len()
        self._emit_state()

    def info(self):
        return {
            "enabled": self.enabled, "state": self.state, "lpm": self.lpm, "ioc": self.ioc,
            "width": ioc_width(self.ioc), "rows": len(self.rows), "image_id": self.image_id,
            "center_hz": round(self.center), "afc": self.afc_lock, "lpm_mode": self.lpm_mode,
            "ioc_mode": self.ioc_mode, "saved": self.saved, "conf": round(self.lpm_conf, 2),
            "freqs": WEFAX_FREQS,
        }

    def image_png(self):
        with self.lock:
            if not self.rows:
                return None
            return png_gray(list(self.rows), len(self.rows[0]))

    # ---------- spracovanie signálu ----------

    @property
    def n(self):
        """Absolútny index nasledujúcej vzorky za koncom bufra."""
        return self.v0 + len(self.v)

    def _setup(self, fs):
        self._fs = fs
        self.D = max(1, int(round(fs / RATE)))
        self.r = fs / self.D
        self.h = lowpass(1100.0, fs, 129)
        self.hist = np.zeros(len(self.h) - 1, np.complex64)
        self.nco = 0.0
        self.dec_off = 0
        self.zprev = np.complex64(1)
        self.v = np.zeros(0, np.float32)
        self.f = np.zeros(0, np.float32)
        self.v0 = 0
        self.pos = 0.0
        self.tone_cnt = {t: 0 for t in (*START_TONES, STOP_TONE)}
        self.tone_seen = -10 ** 9
        self.next_tone = self.next_lpm = self.next_afc = 0
        self.spec = None
        self.afc_blocks = 0
        self.afc_bad = 0
        self.vote = (None, 0)
        self.weak = 0
        self.nolock = 0
        self.levels_ok = False
        self.phase_rows = []
        self.pending = []
        self.nonphase = 0

    def feed(self, base, fs, dial_hz):
        if not self.enabled:
            return
        with self.lock:
            if fs != self._fs:
                self._setup(fs)
            if dial_hz != self.dial:
                self.dial = dial_hz
                self.afc_lock = False
            self._coarse_afc(base, fs)
            self._demod(base, fs)
            self._fine_afc()
            self._tones()
            self._auto_lpm()
            self._lines()
            keep = int(self.r * 12)
            if len(self.v) > keep:
                cut = len(self.v) - keep
                self.v, self.f, self.v0 = self.v[cut:], self.f[cut:], self.v0 + cut
        if time.time() - self._state_at > 1.0:
            self._emit_state()

    def _demod(self, base, fs):
        n = len(base)
        step = -2 * np.pi * self.center / fs
        mix = np.exp(1j * (self.nco + step * np.arange(n))).astype(np.complex64)
        self.nco = (self.nco + step * n) % (2 * np.pi)
        buf = np.concatenate((self.hist, base * mix))
        self.hist = buf[-(len(self.h) - 1):]
        y = np.convolve(buf, self.h, mode="valid")
        z = y[self.dec_off::self.D]
        self.dec_off += self.D * len(z) - n
        if not len(z):
            return
        zz = np.concatenate(([self.zprev], z))
        self.zprev = z[-1]
        f = (np.angle(zz[1:] * np.conj(zz[:-1])) * (self.r / (2 * np.pi))).astype(np.float32)
        self.f = np.concatenate((self.f, f))
        self.v = np.concatenate((self.v, np.clip((f + DEV) / (2 * DEV), 0, 1)))

    def _coarse_afc(self, base, fs):
        """Bez zámku AFC: stred = stred najsilnejšieho 900 Hz okna v ±3 kHz."""
        if self.afc_lock:
            self.spec = None
            return
        n = len(base)
        p = np.abs(np.fft.fftshift(np.fft.fft(base * np.hanning(n)))) ** 2
        fr = np.fft.fftshift(np.fft.fftfreq(n, 1 / fs))
        sel = np.abs(fr) <= 3000
        p, fr = p[sel], fr[sel]
        self.spec = p if self.spec is None or len(self.spec) != len(p) else 0.85 * self.spec + 0.15 * p
        self.afc_blocks += 1
        if self.afc_blocks % 8:
            return
        win = max(3, int(round(900 / (fs / n))))
        cs = np.convolve(self.spec, np.ones(win), mode="valid")
        k = int(np.argmax(cs))
        if cs[k] / win > 4 * (np.median(self.spec) + 1e-30):
            self.center = float(fr[k + win // 2])

    def _fine_afc(self):
        """Stred z percentilov okamžitej frekvencie (čierna a biela sú ±400 Hz)."""
        if self.n < self.next_afc:
            return
        self.next_afc = self.n + int(2 * self.r)
        f = self.f[-int(2 * self.r):]
        if len(f) < self.r:
            return
        # Signál je prítomný, keď okamžitá frekvencia ostáva v pásme ±600 Hz (šum ju rozhádže
        # po celom ±4 kHz). Doladenie len keď sú v signáli obe úrovne (čierna aj biela).
        present = float(np.mean(np.abs(f) < 600)) > 0.8
        lo, hi = np.percentile(f, [2, 98])
        self.levels_ok = present and 550 < hi - lo < 1600  # 800 Hz + šum na okrajoch
        if self.levels_ok:
            self.center += 0.7 * float(lo + hi) / 2
        self.afc_bad = 0 if present else self.afc_bad + 1
        if present:
            self.afc_lock = True
        elif self.afc_bad >= 2:
            self.afc_lock = False

    def _tones(self):
        if self.n < self.next_tone:
            return
        self.next_tone = self.n + int(self.r / 4)
        N = int(self.r)
        if len(self.v) < N:
            return
        x = self.v[-N:] - self.v[-N:].mean()
        X = np.abs(np.fft.rfft(x * np.hanning(N))) ** 2
        fr = np.fft.rfftfreq(N, 1 / self.r)
        tot = X[(fr > 100) & (fr < 1500)].sum() + 1e-12
        for tone in self.tone_cnt:
            hit = x.std() > 0.15 and X[np.abs(fr - tone) < 12].sum() / tot > 0.35
            if hit:
                self.tone_seen = self.n
            self.tone_cnt[tone] = self.tone_cnt[tone] + 1 if hit else 0
            if self.tone_cnt[tone] == TONE_BLOCKS:
                if tone == STOP_TONE:
                    if self.state != "idle":
                        # Riadky zo stop tónu (okno 1 s + 2 s potvrdenia) do obrázka nepatria.
                        drop = min(len(self.rows), math.ceil(3.0 * self.lpm / 60))
                        del self.rows[len(self.rows) - drop:]
                        self.on_event("wefaxtrim", {"id": self.image_id, "rows": len(self.rows)})
                        self._finish()
                        self.state = "idle"
                        self._emit_state()
                else:
                    self._start_image("phasing", START_TONES[tone])

    def _auto_lpm(self):
        if self.n < self.next_lpm:
            return
        self.next_lpm = self.n + int(2 * self.r)
        start = max(len(self.v) - int(8 * self.r), self.tone_seen + int(0.3 * self.r) - self.v0, 0)
        x = self.v[start:]
        if len(x) < 3 * self.r or self.lpm_mode != "auto" and self.state != "idle":
            return
        x = x - x.mean()
        # Signál WEFAX: AFC zachytené (odchýlka ±400 Hz) a jas sa naozaj mení; inak šum či nosná.
        sig_ok = self.afc_lock and self.levels_ok and x.std() > 0.15
        self.nolock = 0 if self.afc_lock else self.nolock + 1
        scores = {}
        for lpm in LPMS:
            lag = int(round(self.r * 60 / lpm))
            if lag > len(x) - self.r:
                continue
            a, b = x[:-lag], x[lag:]
            scores[lpm] = float(a @ b / (math.sqrt((a @ a) * (b @ b)) + 1e-12))
        if not scores:
            return
        best = max(scores.values())
        # Násobky periódy korelujú tiež: z takmer rovnako dobrých berieme najkratšiu periódu.
        pick = max(l for l, c in scores.items() if c >= 0.85 * best)
        if self.lpm_mode != "auto":
            pick = int(self.lpm_mode)
        self.lpm_conf = best
        self.weak = self.weak + 1 if best < 0.3 else 0
        same = self.vote[0] == pick
        self.vote = (pick, self.vote[1] + 1 if same else 1)
        if self.state == "idle":
            if sig_ok and best > 0.7 and self.vote[1] >= 3:
                self.lpm = pick
                self._start_image("free")
        elif self.state == "phasing":
            # Po zarovnaní (16 riadkov) už LPM nemeníme: okno by zachytilo prechod do obrázka.
            if best > 0.5 and pick != self.lpm and self.lpm_mode == "auto" and len(self.phase_rows) < 16:
                self.lpm = pick
                self.phase_rows, self.pending = [], []
        elif self.state == "rx":
            # Po riadnom štarte a fázovaní je formát známy, sledujeme len koniec signálu.
            if self.weak >= 15 or self.nolock >= 10:
                self._finish()
                self.state = "idle"
        else:
            if sig_ok and best > 0.7 and pick != self.lpm and self.vote[1] >= 3:
                self.lpm = pick
                self._start_image("free")
            elif self.weak >= 15 or self.nolock >= 5:  # signál zmizol alebo nemá riadkovú štruktúru
                self._finish()
                self.state = "idle"

    def _line_len(self):
        return self.r * 60 / self.lpm

    def _lines(self):
        if self.state == "idle":
            self.pos = float(self.n)
            return
        L = self._line_len()
        W = ioc_width(self.ioc)
        if self.pos < self.v0:
            self.pos += math.ceil((self.v0 - self.pos) / L) * L
        if self.pos + L > self.n:
            return
        cs = np.concatenate(([0.0], np.cumsum(self.v, dtype=np.float64)))
        grid = np.arange(len(cs))
        while self.pos + L <= self.n:
            # Priemer vzoriek v rámci každého bodu (integrál cez kumulatívny súčet).
            edges = self.pos - self.v0 + np.arange(W + 1) * (L / W)
            row = np.diff(np.interp(edges, grid, cs)) / (L / W)
            self.pos += L
            self._row(np.clip(row * 255 + 0.5, 0, 255).astype(np.uint8))

    def _row(self, row):
        if self.state == "phasing":
            self.phase_rows.append(row.astype(np.float32) / 255)
            k = len(self.phase_rows)
            if k in (8, 16):
                self._align()
                return
            if k > 16:
                W = len(row)
                # Vyhladenie, aby šum (pri 240 LPM ~1 vzorka na bod) nevyzeral ako obsah obrázka.
                k = max(3, W // 100)
                r = np.convolve(self.phase_rows[-1], np.ones(k) / k, mode="same")
                rest = r[int(0.1 * W):-k]
                is_phase = rest.std() < 0.12 and abs(r[:int(0.04 * W)].mean() - rest.mean()) > 0.35
                self.nonphase = 0 if is_phase else self.nonphase + 1
                self.pending = [] if is_phase else self.pending + [row]
                if self.nonphase < 2 and k < 90:
                    return
                self.state = "rx"
                rows, self.pending = self.pending or [row], []
                for r in rows:
                    self._add_row(r)
                self._emit_state()
            return
        self._add_row(row)

    def _add_row(self, row):
        self.rows.append(row.tobytes())
        self.on_event("wefaxrow", {"id": self.image_id, "row": base64.b64encode(row.tobytes()).decode()})

    def _align(self):
        """Fázovanie: impulz na začiatku riadku posunieme na ľavý okraj."""
        prof = np.mean(self.phase_rows[-8:], axis=0)
        W = len(prof)
        d = np.abs(prof - np.median(prof))
        k = max(3, W // 50)
        ds = np.convolve(np.concatenate((d[-k:], d, d[:k])), np.ones(k) / k, mode="same")[k:-k]
        shift = int(np.argmax(ds)) / W - 0.025
        if shift > 0.5:
            shift -= 1
        self.pos += shift * self._line_len()

    def _start_image(self, state, ioc=None):
        self._finish()
        if self.ioc_mode != "auto":
            self.ioc = int(self.ioc_mode)
        elif ioc:
            self.ioc = ioc
        if self.lpm_mode != "auto":
            self.lpm = int(self.lpm_mode)
        self.rows = []
        self.image_id += 1
        self.state = state
        self.phase_rows, self.pending, self.nonphase = [], [], 0
        self.weak = 0
        self.pos = float(self.n)
        self.on_event("wefaxnew", {"id": self.image_id, "width": ioc_width(self.ioc)})
        self._emit_state()

    def _finish(self):
        """Uloží dokončený obrázok (aspoň 30 riadkov) do priečinka wefax/."""
        if len(self.rows) < 30 or self._saved_id == self.image_id:
            return
        os.makedirs(self.save_dir, exist_ok=True)
        name = time.strftime("wefax_%Y%m%d_%H%M%S.png")
        with open(os.path.join(self.save_dir, name), "wb") as f:
            f.write(png_gray(self.rows, len(self.rows[0])))
        self.saved = name
        self._saved_id = self.image_id

    def _emit_state(self):
        self._state_at = time.time()
        self.on_event("wefaxstate", self.info())
