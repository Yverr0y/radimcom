"""SSTV dekodér z demodulovaného audia (USB/LSB na KV, FM napr. ISS 145,800 MHz).

Tóny: synchronizácia 1200 Hz, čierna 1500 Hz, biela 2300 Hz. Pred obrázkom ide VIS kód:
  vodiaci tón 1900 Hz (300 ms) -> prerušenie 1200 Hz -> vodiaci tón 300 ms -> štart bit 1200 Hz
  -> 7 dátových bitov + parita (30 ms, 1100 Hz = 1, 1300 Hz = 0, LSB prvý) -> stop bit 1200 Hz.
Automatika: VIS určí režim a začiatok obrázka, odchýlka vodiaceho tónu od 1900 Hz je AFC (zle
naladené SSB). Bez VIS (zapnuté uprostred vysielania) sa obrázok spustí, keď sa v signáli nájdu
synchronizačné impulzy s periódou riadku niektorého režimu. Čas riadku sa dolaďuje podľa
synchronizačných impulzov (náklon obrázka); hotový obrázok sa s konečným odhadom vykreslí znova.
"""
import base64
import os
import struct
import threading
import time
import zlib

import numpy as np

from paths import data
from sdr import lowpass

RATE = 12000.0          # Hz, vzorkovanie okamžitej frekvencie
MIX = 1700.0            # Hz, stred pásma SSTV (1100–2300 Hz)
SYNC_HZ = 1350.0        # pod touto frekvenciou je synchronizačný impulz (1200 Hz)
IDLE_KEEP = 6.0         # s histórie bez obrázka (VIS + hľadanie impulzov)
MAX_KEEP = 420.0        # s, najdlhší režim PD290 trvá ~290 s
SAVE_DIR = data("sstv")
SSTV_FREQS = ((3735000, "80m", "LSB"), (7165000, "40m", "LSB"), (14230000, "20m", "USB"),
              (21340000, "15m", "USB"), (28680000, "10m", "USB"), (145800000, "ISS", "FM"))


class Mode:
    """Režim: segmenty jedného rámca (ms) a spôsob skladania farieb."""

    def __init__(self, name, vis, w, h, color, segs, start=0.0):
        self.name, self.vis, self.w, self.h, self.color, self.start = name, vis, w, h, color, start
        self.chans, self.syncs, t = {}, [], 0.0
        for kind, ms in segs:
            if kind == "sync":
                self.syncs.append(t)
                self.sync_ms = ms
            elif kind != "gap":
                self.chans[kind] = (t, ms)
            t += ms
        self.P = t                                  # ms na rámec
        self.rows = 2 if color == "yc2" else 1     # obrazových riadkov na rámec
        self.spacing = t / len(self.syncs)          # ms medzi synchronizačnými impulzmi


def _martin(name, vis, px):
    s = 320 * px
    return Mode(name, vis, 320, 256, "gbr", [("sync", 4.862), ("gap", 0.572), ("G", s), ("gap", 0.572),
                                            ("B", s), ("gap", 0.572), ("R", s), ("gap", 0.572)])


def _scottie(name, vis, px):
    s = 320 * px
    # Pred prvým riadkom ide ešte jeden synchronizačný impulz 9 ms.
    return Mode(name, vis, 320, 256, "gbr", [("gap", 1.5), ("G", s), ("gap", 1.5), ("B", s), ("sync", 9.0),
                                            ("gap", 1.5), ("R", s)], start=9.0)


def _pd(name, vis, w, h, px):
    s = w * px
    return Mode(name, vis, w, h, "yc2", [("sync", 20.0), ("gap", 2.08), ("Y0", s), ("RY", s), ("BY", s), ("Y1", s)])


MODES = [
    _martin("Martin M1", 44, 0.4576), _martin("Martin M2", 40, 0.2288),
    _scottie("Scottie S1", 60, 0.4320), _scottie("Scottie S2", 56, 0.2752), _scottie("Scottie DX", 76, 1.08),
    # Robot 36: párny riadok nesie R-Y (oddeľovač 1500 Hz), nepárny B-Y (2300 Hz); rámec = 2 riadky.
    Mode("Robot 36", 8, 320, 240, "yc2", [("sync", 9.0), ("gap", 3.0), ("Y0", 88.0), ("SEP", 4.5), ("gap", 1.5),
                                          ("RY", 44.0), ("sync", 9.0), ("gap", 3.0), ("Y1", 88.0), ("gap", 6.0),
                                          ("BY", 44.0)]),
    Mode("Robot 72", 12, 320, 240, "yc", [("sync", 9.0), ("gap", 3.0), ("Y", 138.0), ("gap", 6.0), ("RY", 69.0),
                                          ("gap", 6.0), ("BY", 69.0)]),
    _pd("PD 50", 93, 320, 256, 0.286), _pd("PD 90", 99, 320, 256, 0.532), _pd("PD 120", 95, 640, 496, 0.19),
    _pd("PD 160", 98, 512, 400, 0.382), _pd("PD 180", 96, 640, 496, 0.286), _pd("PD 240", 97, 640, 496, 0.382),
    _pd("PD 290", 94, 800, 616, 0.286),
]
BY_VIS = {m.vis: m for m in MODES}
BY_NAME = {m.name: m for m in MODES}


def png_rgb(rows, width):
    """24-bitový RGB PNG bez ďalších knižníc."""
    def chunk(kind, data):
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)
    raw = b"".join(b"\x00" + r for r in rows)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, len(rows), 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 6)) + chunk(b"IEND", b""))


def ycc_rgb(y, ry, by):
    """YCrCb (0–255, ako slowrx) na RGB."""
    r = (100 * y + 140 * ry - 17850) / 100
    g = (100 * y - 71 * ry - 33 * by + 13260) / 100
    b = (100 * y + 178 * by - 22695) / 100
    return np.clip(np.stack((r, g, b), axis=1) + 0.5, 0, 255).astype(np.uint8)


class SstvDecoder:
    def __init__(self, on_event, save_dir=SAVE_DIR):
        self.on_event = on_event
        self.save_dir = save_dir
        self.enabled = False
        self.mode_sel = "auto"
        self.lock = threading.Lock()
        self.state = "idle"
        self.mode = None
        self.image_id = 0
        self.rows = []
        self.nrows = 0
        self.vis = None
        self.off = 0.0
        self.lam = 1.0
        self.saved = None
        self._fs = None
        self._state_at = 0.0

    # ---------- ovládanie ----------

    def set_enabled(self, on):
        with self.lock:
            if self.enabled and not on and self.state != "idle":
                self._finish()
            self.enabled = bool(on)
            self._fs = None
            self.state = "idle"
        self._emit_state()

    def command(self, b):
        """Príkazy z webu: mode (auto alebo názov režimu), action stop."""
        with self.lock:
            if "mode" in b:
                m = str(b["mode"])
                if m != "auto" and m not in BY_NAME:
                    raise ValueError("unsupported SSTV mode")
                self.mode_sel = m
            if b.get("action") == "stop" and self.state != "idle":
                self._finish()
        self._emit_state()

    def files(self):
        try:
            names = [n for n in os.listdir(self.save_dir) if n.endswith(".png")]
        except OSError:
            return []
        return sorted(names, reverse=True)[:12]

    def info(self):
        m = self.mode
        return {
            "enabled": self.enabled, "state": self.state, "mode": m.name if m else None,
            "mode_sel": self.mode_sel, "width": m.w if m else 320, "height": m.h if m else 256,
            "rows": self.nrows, "image_id": self.image_id, "vis": self.vis, "afc_hz": round(self.off),
            "slant_ppm": round((self.lam - 1) * 1e6), "saved": self.saved, "files": self.files(),
            "freqs": SSTV_FREQS, "modes": [x.name for x in MODES],
        }

    def image_png(self):
        with self.lock:
            rows = [r for r in self.rows[:self.nrows] if r is not None]
            if not rows:
                return None
            return png_rgb(rows, self.mode.w)

    # ---------- spracovanie signálu ----------

    def S(self, ms):
        return ms * self.r / 1000.0

    @property
    def n(self):
        """Absolútny index nasledujúcej vzorky za koncom bufra."""
        return self.f0 + len(self.f)

    def _setup(self, fs):
        self._fs = fs
        self.D = max(1, int(round(fs / RATE)))
        self.r = fs / self.D
        self.h = lowpass(1100.0, fs, 129)
        self.hist = np.zeros(len(self.h) - 1, np.complex64)
        self.nco = 0.0
        self.dec_off = 0
        self.zprev = np.complex64(1)
        self.f = np.zeros(0, np.float32)
        self.f0 = 0
        self.vscan = 0
        self.pscan = 0
        self.pulses = []
        self.state = "idle"

    def feed(self, audio, fs):
        if not self.enabled:
            return
        with self.lock:
            if fs != self._fs:
                self._setup(fs)
            self._demod(audio, fs)
            self._find_vis()
            if self.state == "idle":
                self._find_free()
            else:
                self._frames()
            keep = int(self.r * IDLE_KEEP)
            if self.state != "idle":
                keep = max(keep, min(self.n - int(self.img_f0), int(self.r * MAX_KEEP)))
            if len(self.f) > keep:
                cut = len(self.f) - keep
                self.f, self.f0 = self.f[cut:], self.f0 + cut
        if time.time() - self._state_at > 1.0:
            self._emit_state()

    def _demod(self, x, fs):
        """Okamžitá frekvencia audia: zmiešanie 1700 Hz na nulu, dolná priepusť, diskriminátor."""
        n = len(x)
        step = -2 * np.pi * MIX / fs
        mix = np.exp(1j * (self.nco + step * np.arange(n))).astype(np.complex64)
        self.nco = (self.nco + step * n) % (2 * np.pi)
        buf = np.concatenate((self.hist, x.astype(np.float32) * mix))
        self.hist = buf[-(len(self.h) - 1):]
        y = np.convolve(buf, self.h, mode="valid")
        z = y[self.dec_off::self.D]
        self.dec_off += self.D * len(z) - n
        if not len(z):
            return
        zz = np.concatenate(([self.zprev], z))
        self.zprev = z[-1]
        f = MIX + np.angle(zz[1:] * np.conj(zz[:-1])) * (self.r / (2 * np.pi))
        self.f = np.concatenate((self.f, f.astype(np.float32)))

    def _mean(self, a, b):
        """Priemer frekvencie na absolútnom intervale vzoriek [a, b)."""
        i, j = int(round(a)) - self.f0, int(round(b)) - self.f0
        if i < 0 or j > len(self.f) or j <= i:
            return None
        return float(self.f[i:j].mean())

    # ---------- VIS ----------

    def _find_vis(self):
        S = self.S
        f = self.f
        lo = max(self.vscan - self.f0, int(S(200)) + 1)
        hi = len(f) - int(S(310))
        if hi <= lo:
            return
        C = np.concatenate(([0.0], np.cumsum(f, dtype=np.float64)))
        t = np.arange(lo, hi)

        def win(a_ms, b_ms):
            a, b = t + int(S(a_ms)), t + int(S(b_ms))
            return (C[b] - C[a]) / (b - a)
        m1, m2, m3 = win(-190, -130), win(-130, -70), win(-70, -10)
        lead = (m1 + m2 + m3) / 3
        start = win(5, 25)
        ok = ((np.abs(lead - 1900) < 250) & (np.abs(m1 - lead) < 50) & (np.abs(m2 - lead) < 50)
              & (np.abs(m3 - lead) < 50) & (np.abs(start - lead + 700) < 100))
        self.vscan = self.f0 + hi
        skip = -1
        for i in np.flatnonzero(ok)[:400]:
            cand = self.f0 + int(t[i])
            if cand < skip:
                continue
            if self._read_vis(cand, float(lead[i]) - 1900):
                return
            skip = cand + S(20)

    def _read_vis(self, cand, off):
        S = self.S
        # Hrana štart bitu: prvé miesto, kde 2 ms priemer klesne pod polovicu medzi 1900 a 1200 Hz.
        edge = None
        for e in range(int(cand - S(15)), int(cand + S(15))):
            g = self._mean(e, e + S(2))
            if g is not None and g - off < 1550:
                edge = e
                break
        if edge is None:
            return False

        def tone(a_ms, b_ms):
            v = self._mean(edge + S(a_ms), edge + S(b_ms))
            return None if v is None else v - off
        st, sp = tone(5, 25), tone(275, 295)
        if st is None or sp is None or abs(st - 1200) > 100 or abs(sp - 1200) > 100:
            return False
        bits = []
        for k in range(8):
            v = tone(30 * (k + 1) + 5, 30 * (k + 1) + 25)
            if abs(v - 1100) < 100:
                bits.append(1)
            elif abs(v - 1300) < 100:
                bits.append(0)
            else:
                return False
        if sum(bits) % 2:
            return False
        code = sum(b << k for k, b in enumerate(bits[:7]))
        mode = BY_VIS.get(code)
        if mode is None and self.mode_sel != "auto":
            mode = BY_NAME[self.mode_sel]
        if mode is None:
            return False
        if self.state != "idle":
            self._finish()
        self.vis = code
        self.vscan = int(edge + S(300))
        self._start(mode, edge + S(300 + mode.start), off)
        return True

    # ---------- štart bez VIS ----------

    def _find_free(self):
        """Synchronizačné impulzy s periódou riadku niektorého režimu (zapnuté uprostred obrázka)."""
        S = self.S
        a = max(self.pscan - self.f0, 0)
        b = len(self.f) - int(S(30))
        if b - a < S(5):
            return
        k = max(1, int(S(1)))
        seg = self.f[a:b]
        g = np.convolve(seg, np.ones(k) / k, mode="same")
        q = ((g < SYNC_HZ) & (g > 950)).astype(np.int8)
        d = np.diff(np.concatenate(([0], q, [0])))
        starts, ends = np.flatnonzero(d == 1), np.flatnonzero(d == -1)
        tail = 0
        for s, e in zip(starts, ends):
            if e == len(q):                         # impulz ešte neskončil: dokončí sa v ďalšom bloku
                tail = e - s
                break
            if s == 0 and a == 0:                   # začiatok bufra: impulz mohol začať skôr
                continue
            ms = (e - s) / self.r * 1000
            if ms >= 3:
                self.pulses.append((self.f0 + a + s, ms, float(seg[s:e].mean())))
        self.pulses = self.pulses[-12:]
        self.pscan = self.f0 + b - tail
        modes = MODES if self.mode_sel == "auto" else [BY_NAME[self.mode_sel]]
        for m in modes:
            ps = [p for p in self.pulses if 0.6 * m.sync_ms <= p[1] <= 1.5 * m.sync_ms][-4:]
            if len(ps) < 4:
                continue
            sp = S(m.spacing)
            if all(abs((ps[i + 1][0] - ps[i][0]) / sp - 1) < 0.006 for i in range(3)):
                off = float(np.median([p[2] for p in ps])) - 1200
                # Posledný impulz = prvý impulz rámca; rámec začína o jeho posun skôr.
                self.vis = None
                self._start(m, ps[-1][0] - S(m.syncs[0]), off, free=True)
                return

    # ---------- obrázok ----------

    def _start(self, mode, t0, off, free=False):
        self.mode = mode
        self.t0 = float(t0)
        self.img_f0 = self.t0 - self.S(100)
        self.off = off
        self.lam = 1.0
        self.pts = []
        self.k = 0
        self.nosync = 0
        self.free = free
        self.rows = [None] * mode.h
        self.nrows = 0
        self.image_id += 1
        self.state = "free" if free else "rx"
        self.pulses = []
        self.on_event("sstvnew", {"id": self.image_id, "width": mode.w, "height": mode.h, "mode": mode.name})
        self._emit_state()

    def _time(self, x_ms):
        """Absolútny čas vzorky pre nominálny posun x (ms) od začiatku obrázka."""
        return self.t0 + self.lam * self.S(x_ms)

    def _fit(self):
        """Začiatok a mierka času z nameraných impulzov (lineárna regresia, odľahlé body preč)."""
        if not self.pts:
            return
        x = np.array([p[0] for p in self.pts]) * self.r / 1000
        y = np.array([p[1] for p in self.pts])
        use = np.ones(len(x), bool)
        for _ in range(2):
            if use.sum() >= 6 and np.ptp(x[use]) > 0:
                lam, t0 = np.polyfit(x[use], y[use], 1)
                lam = float(np.clip(lam, 0.99, 1.01))
            else:
                lam = self.lam
            t0 = float(np.median(y[use] - lam * x[use]))
            res = y - (t0 + lam * x)
            use = np.abs(res) < self.S(3)
            if not use.any():
                return
        self.t0, self.lam = t0, lam

    def _sync_at(self, x_ms):
        """Nájde synchronizačný impulz pri nominálnom čase x; vráti jeho absolútnu polohu alebo None."""
        m = self.mode
        L = max(2, int(self.S(m.sync_ms)))
        exp = self._time(x_ms)
        dl = self.S(8)
        a, b = int(exp - dl - L), int(exp + dl + 2 * L)
        i, j = a - self.f0, b - self.f0
        if i < 0 or j > len(self.f):
            return None
        q = ((self.f[i:j] - self.off) < SYNC_HZ).astype(np.float64)
        C = np.concatenate(([0.0], np.cumsum(q)))
        pos = np.arange(L, len(q) - L)
        inside = (C[pos + L] - C[pos]) / L
        before = (C[pos] - C[pos - L // 2]) / (L // 2)
        score = inside - before
        best = int(np.argmax(score))
        if inside[best] < 0.6 or score[best] < 0.3:
            return None
        return a + pos[best]

    def _frames(self):
        m = self.mode
        while self.k * m.rows < m.h:
            end = self._time((self.k + 1) * m.P) + self.S(8 + m.sync_ms * 2)
            if end > self.n:
                return
            found = 0
            for s in m.syncs:
                x = self.k * m.P + s
                p = self._sync_at(x)
                if p is not None:
                    self.pts.append((x, p))
                    found += 1
            self._fit()
            self.nosync = 0 if found else self.nosync + 1
            if self.nosync >= 10:                   # signál zmizol
                self._finish()
                return
            if m.name == "Robot 36" and self.k == 0 and self.free:
                # Bez VIS nevieme, či sme začali párnym riadkom: oddeľovač 2300 Hz = nepárny (B-Y).
                o, d = m.chans["SEP"]
                v = self._mean(self._time(o), self._time(o + d))
                if v is not None and v - self.off > 1900:
                    self.t0 += self.lam * self.S(m.spacing)
                    self.pts = []
                    continue
            for i, row in enumerate(self._decode(self.k)):
                y = self.k * m.rows + i
                if y < m.h:
                    self.rows[y] = row.tobytes()
                    self.nrows = y + 1
                    self.on_event("sstvrow", {"id": self.image_id, "y": y,
                                              "row": base64.b64encode(row.tobytes()).decode()})
            self.k += 1
        self._finish()

    def _px(self, x_ms, dur_ms, w):
        """Jas w bodov v kanáli (priemer okamžitej frekvencie cez každý bod), 0–255."""
        a = self._time(x_ms)
        L = self.lam * self.S(dur_ms)
        i0 = int(a) - 1
        i, j = i0 - self.f0, int(a + L) + 2 - self.f0
        if i < 0 or j > len(self.f):
            return np.zeros(w)
        cs = np.concatenate(([0.0], np.cumsum(self.f[i:j] - self.off, dtype=np.float64)))
        edges = a - i0 + np.arange(w + 1) * (L / w)
        v = np.diff(np.interp(edges, np.arange(len(cs)), cs)) / (L / w)
        return np.clip((v - 1500) / 800 * 255, 0, 255)

    def _decode(self, k):
        m = self.mode
        base = k * m.P
        ch = {name: self._px(base + o, d, m.w) for name, (o, d) in m.chans.items() if name != "SEP"}
        if m.color == "gbr":
            return [np.clip(np.stack((ch["R"], ch["G"], ch["B"]), axis=1) + 0.5, 0, 255).astype(np.uint8)]
        if m.color == "yc":
            return [ycc_rgb(ch["Y"], ch["RY"], ch["BY"])]
        return [ycc_rgb(ch["Y0"], ch["RY"], ch["BY"]), ycc_rgb(ch["Y1"], ch["RY"], ch["BY"])]

    def _finish(self):
        """Koniec obrázka: prekreslenie s konečným odhadom času, uloženie do priečinka sstv/."""
        m = self.mode
        if self.state == "idle" or m is None:
            return
        done = min(self.k, -(-self.nrows // m.rows))
        for k in range(done):
            for i, row in enumerate(self._decode(k)):
                y = k * m.rows + i
                if y < self.nrows:
                    self.rows[y] = row.tobytes()
        self.state = "idle"
        self.pscan = self.n
        if self.nrows >= 16:
            os.makedirs(self.save_dir, exist_ok=True)
            name = time.strftime("sstv_%Y%m%d_%H%M%S_") + m.name.replace(" ", "") + ".png"
            with open(os.path.join(self.save_dir, name), "wb") as fh:
                fh.write(png_rgb([r for r in self.rows[:self.nrows] if r is not None], m.w))
            self.saved = name
        self.on_event("sstvdone", {"id": self.image_id, "rows": self.nrows})
        self._emit_state()

    def _emit_state(self):
        self._state_at = time.time()
        self.on_event("sstvstate", self.info())
