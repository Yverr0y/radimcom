"""FT8 dekodér: USB pásmo 0–3,1 kHz nad ladenou (dial) frekvenciou, dekódovanie cez PyFT8.

PyFT8 je stavaný na zvukovú kartu a hodiny PC (15 s cykly podľa UTC). Zvukovú kartu nahrádzame:
baseband z prijímača prefiltrujeme, prevzorkujeme na 12 kHz a plníme ním jeho časovo-frekvenčnú
mriežku v reálnom čase. Jeho vlastné vlákno potom v každom cykle hľadá a dekóduje signály.
"""
import collections
import sys
import threading
import time
import types
import warnings

import numpy as np

try:
    import pyaudio  # noqa: F401
except ImportError:
    # PyFT8 importuje pyaudio, no zvukovú kartu nepoužívame (vzorky dodávame sami). Pre nové verzie
    # Pythonu nemusí existovať hotový PyAudio, preto stačí prázdny modul.
    sys.modules["pyaudio"] = types.ModuleType("pyaudio")

try:
    with warnings.catch_warnings():
        # PyFT8 pri importe prepína všetky warnings na výnimky pre celý proces; catch_warnings to vráti.
        from PyFT8 import receiver as pft8
    IMPORT_ERROR = None
except Exception as e:  # bez PyFT8 prijímač beží ďalej, len FT8 dekodér nie je k dispozícii
    IMPORT_ERROR = f"FT8 decoder not available ({e})"
    pft8 = types.SimpleNamespace(AudioIn=object, Receiver=object, SAMP_RATE=12000)

from sdr import lowpass

FT8_RATE = pft8.SAMP_RATE  # 12 000 Hz
MAX_FREQ = 3100.0
FT8_FREQS = (1840000, 3573000, 5357000, 7074000, 10136000, 14074000, 18100000, 21074000, 24915000, 28074000)


class _Grid(pft8.AudioIn):
    """AudioIn z PyFT8 bez zvukovej karty: vzorky (12 kHz) dodávame cez feed()."""

    def __init__(self, max_freq):
        hop = int(FT8_RATE / (pft8.SYM_RATE * pft8.HPS))
        self.hop = hop
        self.samples_per_half_hop = hop // 2
        fft_len = int(pft8.BPT * FT8_RATE // pft8.SYM_RATE)
        self.nFreqs = int((fft_len // 2 + 1) * 2 * max_freq / FT8_RATE)
        self.audio_buffer = np.zeros(fft_len + self.samples_per_half_hop, dtype=np.float32)
        self.fft_in = np.zeros(fft_len, dtype=np.float32)
        self.fft_window = np.hanning(fft_len).astype(np.float32)
        self.tfgrid = np.ones((2, pft8.HPC, self.nFreqs), dtype=np.float32)
        self.indev = True
        self.tfgrid_ptr = 0
        self.check_pointer()
        self.pending = np.zeros(0, np.float32)

    def feed(self, x):
        self.pending = np.concatenate((self.pending, x))
        while len(self.pending) >= self.hop:
            self._hop(self.pending[:self.hop])
            self.pending = self.pending[self.hop:]

    def _hop(self, samples):
        # Rovnaké ako AudioIn._callback, len s float vstupom a bez log(0).
        ns = len(samples)
        self.audio_buffer[:-ns] = self.audio_buffer[ns:]
        self.audio_buffer[-ns:] = samples
        self.tfgrid_ptr = (self.tfgrid_ptr + 1) % pft8.HPC
        np.multiply(self.audio_buffer[self.samples_per_half_hop:], self.fft_window, out=self.fft_in)
        z = np.fft.rfft(self.fft_in)[:self.nFreqs]
        self.tfgrid[0, self.tfgrid_ptr, :] = 20 * np.log10(np.abs(z) + 1e-6)
        np.multiply(self.audio_buffer[:-self.samples_per_half_hop], self.fft_window, out=self.fft_in)
        z = np.fft.rfft(self.fft_in)[:self.nFreqs]
        self.tfgrid[1, self.tfgrid_ptr, :] = 20 * np.log10(np.abs(z) + 1e-6)


class _NoUdp:
    def udp_send_dict(self, _msg):
        pass


class _Decoder(pft8.Receiver):
    """Receiver z PyFT8 bez UDP a zvukovej karty; výsledky posiela do on_message."""

    def __init__(self, grid, on_message):
        self.latest_decode = 2
        self.max_freq = MAX_FREQ
        self.output_type = "callback"
        self.on_message = on_message
        self.candidates = []
        self.duplicate_filter = []
        payload_symb_idxs = list(range(7, 36)) + list(range(43, 72))
        self.base_payload_hops = np.array([pft8.HPS * s for s in payload_symb_idxs])
        self.hop_idxs_Costas = np.arange(7) * pft8.HPS
        self.base_freq_idxs = np.array([pft8.BPT * t for t in range(8)])
        csync = np.full((7, 8 * pft8.BPT), -1 / (8 * pft8.BPT - 1), np.float32)
        for sym_idx, tone in enumerate([3, 1, 4, 0, 6, 5, 2]):
            csync[sym_idx, tone * pft8.BPT] = 1
        self.csync_flat = csync.ravel()
        self.waterfall_max = 0
        self.udp_comms = _NoUdp()
        self.audio_in = grid
        self.running = True
        threading.Thread(target=self._cycle, name="ft8", daemon=True).start()

    def _cycle(self):
        try:
            self.manage_cycle()
        except Exception as e:  # chyba v knižnici nesmie zhodiť aplikáciu
            self.on_message({"mtype": "error", "info": str(e)})

    def send_output(self, msg_dict, noprint=False):
        self.on_message(msg_dict)


class Ft8Decoder:
    """Zapína/vypína dekódovanie a pripravuje 12 kHz audio z basebandu prijímača."""

    def __init__(self, on_decode, on_cycle=None):
        self.on_decode = on_decode
        self.on_cycle = on_cycle or (lambda info: None)
        self.decodes = collections.deque(maxlen=400)
        self.enabled = False
        self.error = None
        self.dial_hz = 0.0
        self._dec = None
        self._grid = None
        self._fs = None
        self.lock = threading.Lock()

    def set_enabled(self, on):
        if on and IMPORT_ERROR:
            self.error = IMPORT_ERROR
            on = False
        with self.lock:
            if on and not self._dec:
                self._grid = _Grid(MAX_FREQ)
                self._dec = _Decoder(self._grid, self._message)
            elif not on and self._dec:
                self._dec.running = False
                self._dec = None
                self._grid = None
            self.enabled = bool(on)

    def _setup(self, fs):
        """Komplexná pásmová priepusť 0..3,2 kHz (USB) a stav prevzorkovania."""
        self._fs = fs
        taps = 255
        n = np.arange(taps) - (taps - 1) / 2
        mid = MAX_FREQ / 2 + 50
        self._h = (lowpass(mid, fs, taps) * np.exp(2j * np.pi * mid / fs * n)).astype(np.complex64)
        self._hist = np.zeros(taps - 1, np.complex64)
        self._t = 0.0
        self._last = 0.0

    def feed(self, base, fs, dial_hz):
        """base: komplexný baseband (ladená frekvencia = 0 Hz) pri vzorkovaní fs."""
        grid = self._grid
        if grid is None:
            return
        if fs != self._fs:
            self._setup(fs)
        self.dial_hz = dial_hz
        buf = np.concatenate((self._hist, base))
        self._hist = buf[-(len(self._h) - 1):]
        usb = np.convolve(buf, self._h, mode="valid").real
        # Lineárna interpolácia na 12 kHz; signál je už obmedzený na 3,2 kHz.
        y = np.concatenate(([self._last], usb))
        step = fs / FT8_RATE
        pos = np.arange(self._t, len(y) - 1, step)
        self._last = y[-1]
        if pos.size:
            self._t = pos[-1] + step - (len(y) - 1)
            grid.feed((np.interp(pos, np.arange(len(y)), y) * 3000).astype(np.float32))
        else:
            self._t -= len(y) - 1

    def _message(self, m):
        kind = m.get("mtype")
        if kind == "decode":
            cs = m["cyclestart_string"]  # "yymmdd_HHMMSS" (UTC)
            f = float(m["fHz"])
            d = {
                "time": f"{cs[7:9]}:{cs[9:11]}:{cs[11:13]}",
                "snr": int(m["their_snr"]),
                "dt": float(m["dt"]),
                "df": round(f),
                "freq_hz": round(self.dial_hz + f),
                "msg": " ".join(x for x in m["msg_tuple"] if x),
            }
            self.decodes.append(d)
            self.on_decode(d)
        elif kind == "rollover":
            self.on_cycle(time.strftime("%H:%M:%S", time.gmtime(15 * int(time.time() / 15))))
        elif kind == "error":
            self.error = m["info"]
