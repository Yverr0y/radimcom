"""RTL-SDR (via librtlsdr and ctypes), LimeSDR (lime.py) or Airspy R2 (airspy.py) and DSP for RADIMCOM
(HF via upconverter, VHF/UHF direct).

Chain: IQ samples -> shift to the tuned frequency (NCO) -> polyphase FIR and decimation /64
-> channel filter by mode (AM/FM/LSB/USB) -> demodulation -> AGC -> 16-bit audio.
The waterfall line is computed from the same samples.
"""
import ctypes
import os
import queue
import threading
import time

import numpy as np

from autotune import AutoTune
from scanner import Scanner
from tonesq import CTCSS_DEFAULT_HZ, DCS_DEFAULT, TONE_HPF_HZ, ToneSquelch

BASE = os.path.dirname(os.path.abspath(__file__))
LIB_DIR = os.path.join(BASE, "lib")

DECIM = 64            # input rate / DECIM = channel and audio rate
READ_SAMPLES = 131072  # samples per read (~85 ms at 1.536 MS/s)
WF_BINS = 1024        # points in the waterfall line sent to the browser
WF_FFT = 32768        # fine FFT (47 Hz/point at 1.536 MS/s); the zoom takes a section of it
WF_SEGMENTS = READ_SAMPLES // WF_FFT
ZOOMS = (1, 2, 4, 8, 16, 32)   # at 32× the section has exactly WF_BINS points of the fine FFT
WF_DB_MIN = -130.0
WF_DB_STEP = 0.5
MODES = ("AM", "FM", "WFM", "LSB", "USB", "CW", "DSD")
DSD_MODE = "DSD"       # digital voice (dsd.py): FM discriminator to the decoder, its voice to the audio output
DSD_BW = 12500.0       # channel width of the DSD mode; fixed, 12.5 kHz covers the protocols it decodes
UPCONV_MAX_HZ = 30e6   # in auto mode only HF (below 30 MHz) goes through the upconverter
TUNER_MIN_HZ = 24e6    # R820T tuner range without a converter
V4_MIN_HZ = 0.5e6      # RTL-SDR Blog V4: HF direct (its driver switches on the built-in upconverter below 28.8 MHz)
TUNER_MAX_HZ = 1766e6
# Tuning range by device type (driver in vfos.json / config).
# LimeSDR Mini officially starts at 10 MHz; lower (via the NCO) it receives weaker, but usable.
TUNER_LIMITS = {"rtl": (TUNER_MIN_HZ, TUNER_MAX_HZ), "lime": (1e6, 3500e6), "airspy": (24e6, 1750e6)}
SSB_LOW_CUT = 300.0   # Hz, lower edge of the SSB passband
CW_PITCH = 700.0      # Hz, tone pitch of a CW signal tuned exactly to the frequency
SQUELCH_OFF = -120.0  # dBFS, squelch at this level and below is off
SQUELCH_HANG_S = 0.02  # s, how long the squelch stays open after the signal drops
FM_NARROW_MAX = 18000.0   # FM up to this width in the narrow channel (input / DECIM), wider via WideFm (up to 50 kHz)
SQUELCH_SUB = 8      # the squelch decides 8× per block (~8 ms) so it does not cut off the start of a transmission
BAND_EDGE = 0.95      # chained VFO: usable part of the shared band (the edges are cut by the dongle filter)
ASQ_WINDOW_S = 15.0   # s, auto squelch: second estimate = ASQ_PCT percentile of the channel power over this time
ASQ_PCT = 10          # percentile, for the channel power over time and for the spectrum points
ASQ_SPAN = 0.7        # part of the dongle band (around its centre) whose spectrum gives the noise density
ASQ_SMOOTH = 0.2      # EMA of the spectral noise estimate per block
ASQ_DEFAULT_DB = 6.0  # dB, auto squelch opens this much above the noise floor
ASQ_MIN_DB, ASQ_MAX_DB = 2.0, 30.0
SQUELCH_MODES = ("AM", "FM", "WFM")   # each mode has its own level (airband AM differs from broadcast)
_w = np.hanning(WF_FFT)
ASQ_WIN_K = float(_w.sum() ** 2 / (_w ** 2).sum())   # Hann: waterfall point power (sine-normalised) -> noise power per point
# a low percentile of the spectrum points (each an average of WF_SEGMENTS FFTs) lies this many dB under the mean noise
ASQ_PCT_BIAS_DB = float(-10 * np.log10(np.percentile(
    np.random.default_rng(0).exponential(size=(WF_SEGMENTS, 50000)).mean(axis=0), ASQ_PCT)))
del _w
NOTCH_MODES = ("AM", "LSB", "USB")    # automatic notch (in CW it would cut out the signal itself)
AGC_MODES = ("AM", "LSB", "USB", "CW")  # audio AGC (ALC); FM and WFM have a constant level from the demodulator
AGC_TARGET = 0.3                        # target audio peak with AGC
READ_CB = ctypes.CFUNCTYPE(None, ctypes.POINTER(ctypes.c_ubyte), ctypes.c_uint32, ctypes.c_void_p)


class ResetRequested(Exception):
    """The user wants to close and reopen the dongle."""


_lib = None


def load_lib():
    global _lib
    if _lib is None:
        os.add_dll_directory(LIB_DIR)
        lib = ctypes.CDLL(os.path.join(LIB_DIR, "librtlsdr.dll"))
        lib.rtlsdr_get_device_count.restype = ctypes.c_uint32
        lib.rtlsdr_get_device_name.restype = ctypes.c_char_p
        lib.rtlsdr_get_device_name.argtypes = [ctypes.c_uint32]
        lib.rtlsdr_get_device_usb_strings.argtypes = [ctypes.c_uint32] + [ctypes.c_char_p] * 3
        lib.rtlsdr_open.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_uint32]
        for name, args in {
            "rtlsdr_close": [], "rtlsdr_set_sample_rate": [ctypes.c_uint32],
            "rtlsdr_set_center_freq": [ctypes.c_uint32], "rtlsdr_set_tuner_gain_mode": [ctypes.c_int],
            "rtlsdr_set_tuner_gain": [ctypes.c_int], "rtlsdr_set_freq_correction": [ctypes.c_int],
            "rtlsdr_reset_buffer": [], "rtlsdr_get_tuner_gains": [ctypes.POINTER(ctypes.c_int)],
            "rtlsdr_read_async": [READ_CB, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32],
            "rtlsdr_cancel_async": [], "rtlsdr_set_bias_tee": [ctypes.c_int], "rtlsdr_set_agc_mode": [ctypes.c_int],
        }.items():
            getattr(lib, name).argtypes = [ctypes.c_void_p] + args
        _lib = lib
    return _lib


def list_devices():
    """Connected dongles [{index, name, vendor, product, serial}]. The USB data may not be readable
    from a dongle that is currently open; then they stay empty."""
    lib = load_lib()
    out = []
    for i in range(lib.rtlsdr_get_device_count()):
        bufs = [ctypes.create_string_buffer(256) for _ in range(3)]
        rc = lib.rtlsdr_get_device_usb_strings(i, *bufs)
        vendor, product, serial = (b.value.decode(errors="replace").strip() if rc == 0 else "" for b in bufs)
        out.append({"index": i, "name": (lib.rtlsdr_get_device_name(i) or b"").decode(errors="replace"),
                    "vendor": vendor, "product": product, "serial": serial})
    return out


def index_by_serial(serial):
    """Index of the dongle with a serial number (the index may change after replugging USB, the number does not)."""
    lib = load_lib()
    lib.rtlsdr_get_index_by_serial.argtypes = [ctypes.c_char_p]
    idx = lib.rtlsdr_get_index_by_serial(serial.encode())
    if idx < 0:
        raise RuntimeError(f"dongle {serial} not found")
    return idx


def open_device(cfg):
    """Opens the device by cfg["driver"] (rtl / lime / airspy); the classes have the same interface."""
    serial = cfg.get("serial")
    if cfg.get("chain"):
        # chained VFO: the samples come from the VFO that owns the dongle (iqshare.py)
        from iqshare import ChainedSdr
        return ChainedSdr(cfg["chain"]["port"], cfg["chain"]["owner"])
    if cfg.get("driver", "rtl") == "lime":
        from lime import LimeSdr
        return LimeSdr(READ_SAMPLES, serial=serial, index=int(cfg["device"]))
    if cfg.get("driver", "rtl") == "airspy":
        from airspy import AirspySdr
        return AirspySdr(READ_SAMPLES, serial=serial, index=int(cfg["device"]))
    return RtlSdr(index_by_serial(serial) if serial else int(cfg["device"]))


class RtlSdr:
    """Thin wrapper over librtlsdr.dll."""

    has_bias_tee = True
    has_rtl_agc = True

    def __init__(self, index):
        self.lib = lib = load_lib()
        count = lib.rtlsdr_get_device_count()
        if index >= count:
            raise RuntimeError(f"dongle {index} not found (connected: {count})")
        # the USB strings can be read only before opening; RTL-SDR Blog V4 receives HF without a converter
        bufs = [ctypes.create_string_buffer(256) for _ in range(3)]
        product = bufs[1].value.decode(errors="replace") if lib.rtlsdr_get_device_usb_strings(index, *bufs) == 0 else ""
        self.tuner_min_hz = V4_MIN_HZ if "Blog V4" in product else TUNER_MIN_HZ
        self.dev = ctypes.c_void_p()
        rc = lib.rtlsdr_open(ctypes.byref(self.dev), index)
        if rc != 0:
            raise RuntimeError(f"cannot open dongle {index} (code {rc}, maybe another program is using it)")
        n = lib.rtlsdr_get_tuner_gains(self.dev, None)
        arr = (ctypes.c_int * max(n, 0))()
        lib.rtlsdr_get_tuner_gains(self.dev, arr)
        self.gains = [g / 10 for g in arr]
        self._cb = None

    def set_sample_rate(self, rate):
        self._check(self.lib.rtlsdr_set_sample_rate(self.dev, int(rate)), "sample rate")

    def set_center_freq(self, hz):
        self._check(self.lib.rtlsdr_set_center_freq(self.dev, int(hz)), "frequency")

    def set_gain(self, gain):
        if gain in ("auto", "", None):
            self.lib.rtlsdr_set_tuner_gain_mode(self.dev, 0)
        else:
            self.lib.rtlsdr_set_tuner_gain_mode(self.dev, 1)
            self.lib.rtlsdr_set_tuner_gain(self.dev, int(round(float(gain) * 10)))

    def set_rtl_agc(self, on):
        """Digital AGC in the RTL2832 (gain after the A/D converter), independent of the tuner gain."""
        self._check(self.lib.rtlsdr_set_agc_mode(self.dev, 1 if on else 0), "RTL2832 AGC")

    def set_bias_tee(self, on):
        """4.5 V on the antenna connector (e.g. for an upconverter or LNA)."""
        self._check(self.lib.rtlsdr_set_bias_tee(self.dev, 1 if on else 0), "bias-tee")

    def set_ppm(self, ppm):
        # Returns -2 if the value is the same as the current one; that is not an error.
        self.lib.rtlsdr_set_freq_correction(self.dev, int(ppm))

    def reset_buffer(self):
        self.lib.rtlsdr_reset_buffer(self.dev)

    def read_async(self, on_block):
        """Blocks until cancel_async is called. librtlsdr keeps several USB transfers at once,
        so no samples are lost even during processing (unlike read_sync)."""
        def cb(ptr, length, _ctx):
            on_block(np.frombuffer(ctypes.string_at(ptr, length), np.uint8))
        self._cb = READ_CB(cb)  # the reference must live while reading runs
        rc = self.lib.rtlsdr_read_async(self.dev, self._cb, None, 8, READ_SAMPLES * 2)
        if rc != 0:
            raise RuntimeError(f"read failed (code {rc})")

    def cancel_async(self):
        self.lib.rtlsdr_cancel_async(self.dev)

    def close(self):
        if self.dev:
            self.lib.rtlsdr_close(self.dev)
            self.dev = None

    @staticmethod
    def _check(rc, what):
        if rc != 0:
            raise RuntimeError(f"setting {what} failed (code {rc})")


# AGC+ (smart AGC): tuner gain as high as possible while the A/D converter is not clipped. The tuner AGC of the
# R820T (gain "auto") watches only its LNA and mixer and keeps the IF gain fixed, so it does not see the A/D;
# this loop measures the raw samples of the whole band and sets the manual tuner gain from them.
# Settings of AGC+ (SET, DONGLE tab), name: (default, min, max). Kept in the config as "sagc".
SAGC_PARAMS = {
    "clip_ppm": (20, 0, 1000),        # clipped samples per million in a block above which the gain goes down
    "heavy_ppm": (1000, 1, 100000),   # above this the gain goes down by heavy_db at once
    "down_db": (3.0, 0.5, 15),        # gain down on clipping
    "heavy_db": (6.0, 1, 30),         # gain down on heavy clipping
    "low_dbfs": (-8.0, -40, -1),      # A/D peak over hold_s below this -> gain up
    "target_dbfs": (-5.0, -30, 0),    # where a gain increase aims
    "hold_s": (0.2, 0.1, 30),         # no clipping for this long before going up
    "up_db": (6.0, 0.5, 30),          # at most per step up
    "settle": (2, 0, 20),             # blocks ignored after a gain change (the tuner settles), plus those already queued
}
SAGC_SETTLE = SAGC_PARAMS["settle"][0]


def sagc_params(cfg):
    """The AGC+ settings of a config, missing ones by default."""
    own = cfg.get("sagc") or {}
    return {k: own.get(k, d) for k, (d, _lo, _hi) in SAGC_PARAMS.items()}


class SmartAgc:
    """AGC+: decides a new tuner gain from the raw samples of each block (None = keep it)."""

    def __init__(self):
        self.peak, self.clip = 0.0, 0.0          # last block, for the state on the web page
        self.reset()

    def reset(self, settle=0):
        self.win_peak, self.quiet_s, self.skip = 0.0, 0.0, settle

    @staticmethod
    def measure(raw):
        """(share of clipped samples, peak 0..1) of the A/D: uint8 (RTL) or complex64 ±1 (Airspy, Lime)."""
        if raw.dtype == np.uint8:
            lo, hi = int(raw.min()), int(raw.max())
            peak = max(hi - 127.5, 127.5 - lo) / 127.5
            n = (np.count_nonzero(raw == 0) if lo == 0 else 0) + (np.count_nonzero(raw == 255) if hi == 255 else 0)
        else:
            a = np.abs(raw.view(np.float32))
            peak = float(a.max())
            n = np.count_nonzero(a >= 0.99) if peak >= 0.99 else 0
        return float(n) / raw.size, float(peak)   # plain floats: the state goes to JSON

    def step(self, raw, gains, gain, block_s, backlog, p, db_per_unit=1.0):
        """p = sagc_params(): the settings from SET."""
        self.clip, self.peak = self.measure(raw)
        if self.skip > 0:
            self.skip -= 1
            return None
        if self.clip * 1e6 > p["clip_ppm"]:
            db = p["heavy_db"] if self.clip * 1e6 > p["heavy_ppm"] else p["down_db"]
            lower = [g for g in gains if g <= gain - db / db_per_unit]
            new = lower[-1] if lower else gains[0]
        elif self.clip > 0:
            self.quiet_s = 0.0                    # tolerated, but no reason to go up
            return None
        else:
            self.win_peak = max(self.win_peak, self.peak)
            self.quiet_s += block_s
            if self.quiet_s < p["hold_s"]:
                return None
            peak, self.win_peak, self.quiet_s = self.win_peak, 0.0, 0.0
            if 20 * np.log10(max(peak, 1e-4)) >= p["low_dbfs"]:
                return None
            db = min(p["up_db"], p["target_dbfs"] - 20 * np.log10(max(peak, 1e-3)))
            up = [g for g in gains if gain < g <= gain + db / db_per_unit]
            new = up[-1] if up else None
        if new is None or new == gain:
            return None
        self.reset(backlog + int(p["settle"]))
        return new


def lowpass(cutoff, fs, taps):
    """FIR low-pass (windowed sinc, Blackman), unity gain at DC."""
    n = np.arange(taps) - (taps - 1) / 2
    h = np.sinc(2 * cutoff / fs * n) * np.blackman(taps)
    return (h / h.sum()).astype(np.float32)


class Decimator:
    """Polyphase FIR with decimation: y[m] = sum_k h[k] x[m*D + P-1 - k]."""

    def __init__(self, fs, cutoff, decim=DECIM, phases=32):
        self.d = decim
        self.t = phases
        h = lowpass(cutoff, fs, decim * phases)
        self.h = h.astype(np.complex64)
        self.hr = h[::-1].reshape(phases, decim).astype(np.complex64)
        self.hist = np.zeros((phases - 1) * decim, np.complex64)

    def process(self, x):
        x = np.concatenate((self.hist, x))
        if len(x) < 65536:
            # Short blocks (WFM audio, RDS): faster via FFT, the result is the same.
            from scipy.signal import oaconvolve
            self.hist = x[-(self.t - 1) * self.d:]
            return oaconvolve(x, self.h, mode="valid")[::self.d].astype(np.complex64)
        rows = x.reshape(-1, self.d)
        nout = rows.shape[0] - self.t + 1
        y = np.zeros(nout, np.complex64)
        for t in range(self.t):
            y += rows[t:t + nout] @ self.hr[t]
        self.hist = x[-(self.t - 1) * self.d:]
        return y


class Wfm:
    """Wide FM (broadcast 88–108 MHz) directly from the input samples: decimation to ~256 kHz,
    FM discriminator (75 kHz deviation), stereo decoder, 50 µs de-emphasis, 15 kHz low-pass
    and decimation to the audio rate (input / DECIM). RDS is also decoded from the MPX signal.

    Stereo: the 19 kHz pilot has an exact frequency, so its phase is measured coherently over the whole block
    (bandwidth ~16 Hz, even with a noisy MPX) and a small frequency drift is tracked between blocks.
    L−R is demodulated with a 38 kHz carrier = 2× pilot. Without a pilot or with a noisy pilot it is mono."""

    DEVIATION = 75e3
    DEEMPHASIS = 50e-6   # Europe (USA 75 µs)
    PILOT = 19e3
    PILOT_REF = 19.6e3   # neither pilot nor audio here: noise estimate for comparison with the pilot
    MPX_FFT = 4096       # MPX spectrum for the page (~62 Hz per bin at 256 kHz)

    def __init__(self, fs, bw):
        from scipy.signal import lfilter
        from rds import RdsDecoder
        self._lfilter = lfilter
        d1 = 8 if fs / 8 >= 240e3 else 4        # DECIM must be divisible by d1
        self.r1 = fs / d1
        self.dec1 = Decimator(fs, cutoff=min(bw / 2, 0.45 * self.r1), decim=d1, phases=32)
        self.dec2 = Decimator(self.r1, cutoff=min(15e3, 0.45 * fs / DECIM), decim=DECIM // d1, phases=64)
        a = 1 - np.exp(-1 / (self.r1 * self.DEEMPHASIS))
        self.b, self.a = [a], [1, a - 1]
        self.zi = np.zeros(1, np.complex128)
        self.prev = np.complex64(1)
        self.w19 = 2 * np.pi * self.PILOT / self.r1
        self.wref = 2 * np.pi * self.PILOT_REF / self.r1
        self.ph19 = self.phref = 0.0
        self.q_prev = None
        self.drift = 0.0                         # rad/block: pilot phase drift between blocks
        self.pilot_snr = 0.0
        self.stereo = False                      # pilot locked (ST flag)
        self.allow_stereo = True                 # False = forced mono (STEREO button off)
        self.st_count = 0
        self.rds = RdsDecoder(self.r1)
        self.mpx_tail = None                     # last MPX block, before the pilot is subtracted

    def mpx_spectrum(self, top_hz=20000.0):
        """Spectrum of the last MPX block from 0 to top_hz: (Hz per bin, dB list; 0 dB = sine at 75 kHz deviation).
        Computed only on request, so it costs nothing while nobody is looking."""
        x = self.mpx_tail
        if x is None:
            return None
        x = x[-self.MPX_FFT:]
        win = np.hanning(len(x))
        mag = 2 * np.abs(np.fft.rfft(x * win)) / win.sum()
        hz = self.r1 / len(x)
        db = 20 * np.log10(mag[:int(top_hz / hz) + 2] + 1e-12)
        return hz, [round(float(v), 1) for v in db]

    def process(self, iq):
        """iq: input shifted so that the tuned frequency is at 0 Hz.
        Returns (stereo audio of shape (n, 2), power in dBFS)."""
        z = self.dec1.process(iq)
        pw = np.abs(z) ** 2
        power = float(np.mean(pw)) + 1e-20
        self.sub_db = 10 * np.log10(pw.reshape(SQUELCH_SUB, -1).mean(axis=1) + 1e-20)   # for the squelch
        prev = np.concatenate(([self.prev], z[:-1]))
        self.prev = z[-1]
        mpx = (np.angle(z * np.conj(prev)) * (self.r1 / (2 * np.pi * self.DEVIATION))).astype(np.float32)
        n = len(mpx)
        self.mpx_tail = mpx
        self.rds.process(mpx)

        # Pilot: q = (A/2)·e^{jφ} for the pilot A·cos(ω·n + φ) in the middle of the block.
        ph0 = self.ph19
        k = np.arange(n)
        osc = np.exp(1j * (ph0 + self.w19 * k)).astype(np.complex64)
        self.ph19 = (ph0 + self.w19 * n) % (2 * np.pi)
        q = complex(np.mean(mpx * osc.conj()))
        ref = abs(np.mean(mpx * np.exp(-1j * (self.phref + self.wref * k))))
        self.phref = (self.phref + self.wref * n) % (2 * np.pi)
        if self.q_prev is not None:
            step = np.angle(q * np.conj(self.q_prev))
            self.drift = 0.8 * self.drift + 0.2 * step if abs(step) < 0.5 else self.drift
        self.q_prev = q
        level = 2 * abs(q)
        self.pilot_snr = 0.8 * self.pilot_snr + 0.2 * 20 * np.log10(abs(q) / (ref + 1e-12) + 1e-12)
        good = level > 0.02 and self.pilot_snr > 10
        # Hysteresis: stereo after 3 good blocks, mono after 3 bad ones.
        self.st_count = min(self.st_count + 1, 3) if good else max(self.st_count - 1, 0)
        if self.st_count == 3:
            self.stereo = True
        elif self.st_count == 0:
            self.stereo = False

        if self.stereo and self.allow_stereo:
            # Pilot phase in the block: measured in the middle + tracked drift. The pilot is subtracted (otherwise
            # 19 kHz would leak into the audio), then the 38 kHz carrier: sin(2θ'), where pilot = sin(θ') = cos(θ),
            # θ' = θ + π/2  ->  −sin(2θ).
            c = osc * np.exp(1j * (np.angle(q) + self.drift * (k - n / 2) / n)).astype(np.complex64)
            mpx = mpx - level * c.real
            diff = -2 * mpx * (c * c).imag
        else:
            diff = np.zeros(n, np.float32)
        x = mpx + 1j * diff                         # (L+R)/2 + j(L−R)/2
        x, self.zi = self._lfilter(self.b, self.a, x, zi=self.zi)
        y = self.dec2.process(x.astype(np.complex64))
        audio = np.stack((y.real + y.imag, y.real - y.imag), axis=1)
        return np.clip(audio * 0.8, -1, 1).astype(np.float32), 10 * np.log10(power)


def fm_deviation(bw):
    """Assumed FM deviation for the channel width: 12 kHz -> 5 kHz, proportionally (volume does not depend on the width)."""
    return max(bw, 300.0) * 5000.0 / 12000.0


class WideFm:
    """FM wider than FM_NARROW_MAX (up to 50 kHz): the narrow channel (input / DECIM) would cut it,
    so like Wfm: decimation from the input, channel filter, discriminator and audio decimation to input / DECIM."""

    def __init__(self, fs, bw):
        d1 = 16 if fs / 16 >= 1.25 * bw else 8        # DECIM must be divisible by d1
        self.r1 = fs / d1
        self.dec1 = Decimator(fs, cutoff=min(0.6 * bw, 0.45 * self.r1), decim=d1, phases=32)
        self.h = lowpass(bw / 2, self.r1, 127).astype(np.complex64)   # exact channel filter
        self.hist = np.zeros(len(self.h) - 1, np.complex64)
        self.dec2 = Decimator(self.r1, cutoff=min(15e3, 0.45 * fs / DECIM), decim=DECIM // d1, phases=32)
        self.scale = self.r1 / (2 * np.pi * fm_deviation(bw))
        self.prev = np.complex64(1)

    def process(self, iq):
        """iq: input shifted so that the tuned frequency is at 0 Hz. Returns (audio, power in dBFS)."""
        buf = np.concatenate((self.hist, self.dec1.process(iq)))
        self.hist = buf[-(len(self.h) - 1):]
        z = np.convolve(buf, self.h, mode="valid").astype(np.complex64)
        pw = np.abs(z) ** 2
        power = float(np.mean(pw)) + 1e-20
        pw = pw[:len(pw) - len(pw) % SQUELCH_SUB]
        self.sub_db = 10 * np.log10(pw.reshape(SQUELCH_SUB, -1).mean(axis=1) + 1e-20)   # for the squelch
        prev = np.concatenate(([self.prev], z[:-1]))
        self.prev = z[-1]
        audio = (np.angle(z * np.conj(prev)) * self.scale).astype(np.complex64)
        y = self.dec2.process(audio).real
        return np.clip(y * 0.5, -1, 1).astype(np.float32), 10 * np.log10(power)


class AutoNotch:
    """Automatic notch: in the short-time spectrum (STFT, 75 % overlap) it looks for steady tones
    (whistles, carriers) and cuts them out. Tone = mean power in a bin over ~1 s is at least NOTCH_DB above
    the median of its neighbourhood; speech moves, so it does not stand out in a long average. Delay N samples."""

    N, H = 512, 128
    TAU_S = 1.0
    NOTCH_DB = 15.0
    REF_BINS = 31          # neighbourhood for the median (±15 bins)
    WIDEN = 2              # also cut ±2 neighbouring bins (main lobe of the Hann window)

    def __init__(self, fs):
        self.fs = fs
        self.win = np.hanning(self.N + 1)[:-1].astype(np.float32)
        self.a = float(np.exp(-self.H / fs / self.TAU_S))
        self.reset()

    def reset(self):
        nb = self.N // 2 + 1
        self.inp = np.zeros(self.N - self.H, np.float32)
        self.ola = np.zeros(self.N, np.float32)
        self.pending = np.zeros(self.H, np.float32)
        self.avg = np.zeros(nb)
        self.gain = np.ones(nb, np.float32)
        self.notched = 0

    def process(self, x):
        N, H, w = self.N, self.H, self.win
        buf = np.concatenate((self.inp, x))
        nf = (len(buf) - N) // H + 1
        out = np.empty(nf * H, np.float32)
        half = self.REF_BINS // 2
        thr = 10 ** (self.NOTCH_DB / 10)
        lo = int(250 * N / self.fs)          # nothing below 250 Hz (DC, voice fundamental; SSB cuts there anyway)
        for k in range(nf):
            X = np.fft.rfft(buf[k * H:k * H + N] * w)
            self.avg = self.a * self.avg + (1 - self.a) * (X.real ** 2 + X.imag ** 2)
            padded = np.pad(self.avg, half, mode="edge")
            ref = np.median(np.lib.stride_tricks.sliding_window_view(padded, self.REF_BINS), axis=1)
            tone = self.avg > thr * ref + 1e-20
            tone[:lo] = False
            if self.WIDEN:
                t = tone.copy()
                for d in range(1, self.WIDEN + 1):
                    t[d:] |= tone[:-d]
                    t[:-d] |= tone[d:]
                tone = t
                tone[:lo] = False
            target = np.where(tone, 0.01, 1.0).astype(np.float32)
            self.gain += (target - self.gain) * 0.3   # smoothly, so it does not click
            y = np.fft.irfft(X * self.gain, N).astype(np.float32) * w / 1.5   # Hann² at 75 % = 1.5
            self.ola += y
            out[k * H:(k + 1) * H] = self.ola[:H]
            self.ola = np.concatenate((self.ola[H:], np.zeros(H, np.float32)))
        self.inp = buf[nf * H:]
        self.notched = int(np.count_nonzero(self.gain < 0.5))
        allout = np.concatenate((self.pending, out))
        self.pending = allout[len(x):]
        return allout[:len(x)]


SPUR_WIDTH_DEFAULT = 3000 # Hz, stopband of each line
SPUR_EDGE_DEFAULT = 1000  # Hz, side of the band-stop from full depth to none
SPUR_DB_DEFAULT = 40
SPUR_LEARN_S = 5.0        # LEARN: seconds of averaged spectrum
SPUR_MIN_DB = 4.0         # a line stands at least this much above its surroundings; the chain rule stops the rest
SPUR_MIN_SPACING = 12000  # Hz; below this a broadcast grid (5, 9, 10 kHz) would look like a comb
SPUR_MAX_SPACING = 250000
SPUR_TRACK_BLOCKS = 16    # how often the lines are measured again (~1 s)
SPUR_EMA = 0.97           # averaging of that measurement per block (~2 s)
SPUR_MIN_CHAIN = 4        # lines at the same spacing that make a comb; a single line is a station


def find_spurs(power, lo_edge, bin_hz, center_hz):
    """Spurs in an averaged spectrum: lines repeating at a regular spacing (a switching supply and its harmonics).
    Other peaks are stations and stay. Returns [[Hz, dB above the surroundings], ...]."""
    from scipy.ndimage import percentile_filter, uniform_filter1d
    from scipy.signal import find_peaks
    def coarse(step_hz):
        k = max(1, int(step_hz / bin_hz))
        p = power[:len(power) // k * k].reshape(-1, k).mean(axis=1)
        return lo_edge + (np.arange(len(p)) + 0.5) * bin_hz * k - bin_hz / 2, uniform_filter1d(10 * np.log10(p + 1e-20), 3), bin_hz * k

    fine_hz, fine_db, _ = coarse(250)
    hz, db, res = coarse(1000)                      # weak lines wander and split into several peaks at finer resolution
    excess = db - percentile_filter(db, 15, size=int(60000 / res) | 1)    # low and wide: under the skirts of the lines
    pk = find_peaks(excess, height=SPUR_MIN_DB, prominence=SPUR_MIN_DB, distance=max(1, int(1000 / res)))[0]
    pk = pk[np.abs(hz[pk] - center_hz) > 3000]      # the DC peak has its own filter
    tol = max(300.0, 1.5 * res)
    left, found = [(float(hz[i]), float(excess[i])) for i in pk], []
    for _ in range(3):                              # up to three different spacings
        f = np.array([p[0] for p in left])
        if len(f) < SPUR_MIN_CHAIN:
            break
        all_diffs = np.sort((f[None, :] - f[:, None])[np.triu_indices(len(f), 1)])
        diffs = all_diffs[(all_diffs >= SPUR_MIN_SPACING) & (all_diffs <= SPUR_MAX_SPACING)]
        if not len(diffs):
            break
        counts = np.searchsorted(diffs, diffs + tol) - np.searchsorted(diffs, diffs - tol)
        best = diffs[int(np.argmax(counts))]
        d = float(diffs[np.abs(diffs - best) <= tol].mean())
        n_d = np.count_nonzero(np.abs(all_diffs - d) <= tol)
        if any(d / m < SPUR_MIN_SPACING and np.count_nonzero(np.abs(all_diffs - d / m) <= tol) >= n_d / 2 for m in (2, 3, 4)):
            break                                   # really a finer grid (18 kHz here = 9 kHz stations)
        # Chains of lines d apart; one missing line does not break a chain.
        chain = list(range(len(f)))

        def root(a):
            while chain[a] != a:
                a = chain[a]
            return a

        for a in range(len(f)):
            for step in (d, 2 * d):
                b = int(np.argmin(np.abs(f - (f[a] + step))))
                if abs(f[b] - f[a] - step) <= tol:
                    chain[root(b)] = root(a)
        groups = {}
        for a in range(len(f)):
            groups.setdefault(root(a), []).append(a)
        members = {a for g in groups.values() if len(g) >= SPUR_MIN_CHAIN for a in g}
        if not members:
            break
        found += [left[a] for a in members]
        left = [p for a, p in enumerate(left) if a not in members]
    placed = []
    for h, e in found:
        near = np.abs(fine_hz - h) <= 1000
        placed.append([round(float(fine_hz[near][np.argmax(fine_db[near])]), 1), round(e, 1)])
    return sorted(placed)


def spur_profile(ema, lo_edge, bin_hz, lines, width, edge, db, shift):
    """Depth in dB over the spectrum ema: a band-stop on each line, flat over width, with sides edge Hz wide.
    Inside it each point goes down to the noise around the band-stop and no further (at most db): a line is tall in the
    middle and low at the sides, so one depth for all of them would leave its tip standing in a hole dug into the noise."""
    from scipy.ndimage import uniform_filter1d
    level = 10 * np.log10(uniform_filter1d(ema, max(1, int(125 / bin_hz))) + 1e-30)
    depth = np.zeros(len(ema), np.float32)
    reach = width / 2 + edge
    inner = int(max(reach, 1000) / bin_hz)
    outer = inner + int(2000 / bin_hz)
    r = int(reach / bin_hz) + 1
    for hz, _ in lines:
        hz += shift
        i = int(round((hz - lo_edge) / bin_hz))
        if not outer <= i < len(ema) - outer:
            continue
        noise = 10 * np.log10(np.median(np.concatenate((ema[i - outer:i - inner], ema[i + inner:i + outer]))) + 1e-30)
        band = np.arange(i - r, i + r + 1)
        d = np.abs(lo_edge + band * bin_hz - hz) - width / 2    # below 0 = in the stopband
        side = np.where(d < edge, np.cos(np.pi / 2 * np.clip(d / max(edge, 1e-9), 0, 1)) ** 2, 0.0)
        depth[band] = np.maximum(depth[band], side * np.clip(level[band] - noise, 0, db))
    return depth


class SpurFilter:
    """Learned spurs in the narrow channel: gain per FFT bin (STFT, 75 % overlap). Delay N samples."""

    N, H = 1024, 256

    def __init__(self, fs):
        self.freqs = np.fft.fftfreq(self.N, 1 / fs)
        self.win = np.hanning(self.N + 1)[:-1].astype(np.float32)
        self.key = None
        self.gain = None
        self.reset()

    def reset(self):
        self.inp = np.zeros(self.N - self.H, np.complex64)
        self.ola = np.zeros(self.N, np.complex64)
        self.pending = np.zeros(self.H, np.complex64)
        self.active = False

    def process(self, x, tune_hz, depth, lo_edge, bin_hz, version):
        """x = channel with the tuned frequency at 0 Hz; depth = spur_profile over the band; version changes with it."""
        self.active = True
        key = (tune_hz, version)
        if key != self.key:
            self.key = key
            db = np.interp(self.freqs + tune_hz, lo_edge + np.arange(len(depth)) * bin_hz, depth, left=0, right=0)
            self.gain = (10 ** (-db / 20)).astype(np.float32)
        N, H, w = self.N, self.H, self.win
        buf = np.concatenate((self.inp, x))
        nf = (len(buf) - N) // H + 1
        out = np.empty(nf * H, np.complex64)
        for k in range(nf):
            y = np.fft.ifft(np.fft.fft(buf[k * H:k * H + N] * w) * self.gain).astype(np.complex64) * w / 1.5   # Hann² at 75 % = 1.5
            self.ola += y
            out[k * H:(k + 1) * H] = self.ola[:H]
            self.ola = np.concatenate((self.ola[H:], np.zeros(H, np.complex64)))
        self.inp = buf[nf * H:]
        allout = np.concatenate((self.pending, out))
        self.pending = allout[len(x):]
        return allout[:len(x)]


AFI_DEFAULT_HZ = 1750.0  # Hz, mirror point of the audio frequency inversion (f -> 2*AFI - f)
AFI_MIN_HZ, AFI_MAX_HZ = 500.0, 4000.0


class FreqInverter:
    """Audio frequency inversion (voice inversion scrambler / descrambler).
    The audio band 0 .. 2·F is mirrored around F: low-pass at 2·F, multiply by a 2·F carrier, low-pass again
    (removes the upper image). The operation is its own inverse, so the same block scrambles and descrambles."""

    def __init__(self):
        self.key = None
        self.phase = 0.0

    def _setup(self, fs, hz):
        self.key = (fs, hz)
        self.carrier = min(2 * hz, 0.45 * fs)        # the carrier must stay below Nyquist
        taps = 255
        self.h = lowpass(self.carrier * 0.97, fs, taps).astype(np.float32)
        self.hist1 = np.zeros(taps - 1, np.float32)
        self.hist2 = np.zeros(taps - 1, np.float32)
        self.phase = 0.0

    def process(self, x, fs, hz):
        if self.key != (fs, hz):
            self._setup(fs, hz)
        buf = np.concatenate((self.hist1, x))
        self.hist1 = buf[-len(self.hist1):]
        y = np.convolve(buf, self.h, mode="valid")
        step = 2 * np.pi * self.carrier / fs
        y = y * (2 * np.cos(self.phase + step * np.arange(len(y))))
        self.phase = (self.phase + step * len(y)) % (2 * np.pi)
        buf = np.concatenate((self.hist2, y.astype(np.float32)))
        self.hist2 = buf[-len(self.hist2):]
        return np.clip(np.convolve(buf, self.h, mode="valid"), -1, 1).astype(np.float32)


PASS_ORDER = 6             # Butterworth order of the LPF / HPF keys: 36 dB per octave
LPF_DEFAULT_HZ, LPF_MIN_HZ, LPF_MAX_HZ = 3000.0, 100.0, 15000.0
HPF_DEFAULT_HZ, HPF_MIN_HZ, HPF_MAX_HZ = 300.0, 20.0, 5000.0


class PassFilter:
    """Audio low-pass or high-pass (LPF / HPF keys), an IIR because a FIR would need thousands of taps at a low
    cutoff. Input (n, 2). A change of the cutoff or on/off crossfades over one block, so it does not click."""

    def __init__(self, btype):
        from scipy.signal import butter, sosfilt
        self.btype = btype
        self._butter, self._sosfilt = butter, sosfilt
        self.key = None             # (fs, hz) of the running filter, None = off
        self.sos = self.zi = None

    def _run(self, x):
        if self.sos is None:
            return x
        y, self.zi = self._sosfilt(self.sos, x, axis=0, zi=self.zi)
        return y

    def process(self, x, fs, hz):
        """hz = cutoff, or None = off (passes the input through)."""
        y = self._run(x)
        key = (fs, hz) if hz else None
        if key != self.key:
            self.key = key
            self.sos = self.zi = None
            if key:
                # a low sample rate has a low Nyquist: the cutoff stays below it
                self.sos = self._butter(PASS_ORDER, min(hz, 0.45 * fs), self.btype, fs=fs, output="sos")
                self.zi = np.zeros((len(self.sos), 2, 2))
            ramp = np.linspace(0.0, 1.0, len(x))[:, None]
            y = y * (1 - ramp) + self._run(x) * ramp
        return y


class Channel:
    """Channel filter, demodulation and AGC at rate fs (= input / DECIM)."""

    def __init__(self, fs):
        self.fs = fs
        self.taps = 255
        self.hist = np.zeros(self.taps - 1, np.complex64)
        self.prev = np.complex64(1)
        self.bfo_phase = 0.0
        self.dc = 0.0
        self.level = 1e-4
        self.hang = 0
        self.mode = None
        self.bw = None
        self.h = None
        self.notch_on = False
        self.notch = AutoNotch(fs)
        self.agc_on = True       # off = fixed gain frozen when turned off (volume only with the slider)
        self.fixed_level = None

    def configure(self, mode, bw):
        if (mode, bw) == (self.mode, self.bw):
            return
        self.mode, self.bw = mode, bw
        # Narrow filters (CW, FM 500 Hz) need a longer FIR (Blackman transition band ~ 5.5·fs/taps).
        taps = 1023 if mode == "CW" or bw < 2500 else 255
        if taps != self.taps:
            self.taps = taps
            self.hist = np.zeros(taps - 1, np.complex64)
        n = np.arange(self.taps) - (self.taps - 1) / 2
        if mode in ("LSB", "USB"):
            # Complex band-pass: low-pass shifted to the centre of the SSB passband.
            width = max(bw - SSB_LOW_CUT, 300.0)
            mid = SSB_LOW_CUT + width / 2
            if mode == "LSB":
                mid = -mid
            h = lowpass(width / 2, self.fs, self.taps) * np.exp(2j * np.pi * mid / self.fs * n)
        else:
            h = lowpass(bw / 2, self.fs, self.taps)
        self.h = h.astype(np.complex64)
        self.level = 1e-4
        self.dc = 0.0
        self.notch.reset()

    def process(self, x):
        """Returns (audio float32 in ±1, channel power in dBFS)."""
        buf = np.concatenate((self.hist, x))
        self.hist = buf[-(self.taps - 1):]
        ch = np.convolve(buf, self.h, mode="valid").astype(np.complex64)
        pw = np.abs(ch) ** 2
        power = float(np.mean(pw)) + 1e-20
        smeter = 10 * np.log10(power)
        self.sub_db = 10 * np.log10(pw.reshape(SQUELCH_SUB, -1).mean(axis=1) + 1e-20)   # for the squelch

        if self.mode == "FM":
            prev = np.concatenate(([self.prev], ch[:-1]))
            self.prev = ch[-1]
            audio = np.angle(ch * np.conj(prev)) * (self.fs / (2 * np.pi * fm_deviation(self.bw)))
            return np.clip(audio * 0.5, -1, 1).astype(np.float32), smeter

        if self.mode == "AM":
            env = np.abs(ch)
            # Carrier = DC component of the envelope; the first block sets it at once, then it is tracked.
            m = float(env.mean())
            self.dc = m if self.dc == 0.0 else 0.6 * self.dc + 0.4 * m
            audio = env - self.dc
        elif self.mode == "CW":
            # BFO: the signal on the tuned frequency (0 Hz) is shifted to CW_PITCH so it is heard as a tone.
            step = 2 * np.pi * CW_PITCH / self.fs
            bfo = np.exp(1j * (self.bfo_phase + step * np.arange(len(ch)))).astype(np.complex64)
            self.bfo_phase = (self.bfo_phase + step * len(ch)) % (2 * np.pi)
            audio = (ch * bfo).real
        else:
            audio = ch.real
        audio = audio.astype(np.float32)
        if self.notch_on and self.mode in NOTCH_MODES:   # before the AGC, so whistles do not push the gain down
            audio = self.notch.process(audio)
        else:
            self.notch.notched = 0
        if self.agc_on:
            self.fixed_level = None
            return self.agc(audio), smeter
        # Without AGC: gain from the last AGC level (at most 40 dB, so it does not roar after starting with AGC off).
        if self.fixed_level is None:
            self.fixed_level = max(self.level, AGC_TARGET / 100)
        return np.clip(audio * (AGC_TARGET / self.fixed_level), -1, 1), smeter

    def agc(self, x, block=120, target=AGC_TARGET):
        """Block AGC with fast attack, 0.4 s hold and slow decay."""
        nb = len(x) // block
        if nb == 0:
            return x
        peaks = np.abs(x[:nb * block]).reshape(nb, block).max(axis=1)
        decay = np.exp(-block / self.fs / 1.5)
        hang_blocks = int(0.4 * self.fs / block)
        gains = np.empty(nb, np.float32)
        level = self.level
        for i, p in enumerate(peaks):
            if p > level:
                level = p
                self.hang = hang_blocks
            elif self.hang > 0:
                self.hang -= 1
            else:
                level = max(level * decay, 1e-6)
            gains[i] = target / level
        self.level = level
        g = np.repeat(gains, block)
        if len(g) < len(x):
            g = np.concatenate((g, np.full(len(x) - len(g), gains[-1], np.float32)))
        return np.clip(x * g, -1, 1)


class Receiver:
    """Thread that reads from the dongle and produces waterfall lines and audio."""

    def __init__(self, cfg, on_row, on_audio, on_status, on_baseband=None, on_demod=None, on_meter=None, on_dsd=None):
        self.cfg = cfg
        cfg.setdefault("bandwidth", {}).setdefault("CW", 500)
        cfg["bandwidth"].setdefault("WFM", 200000)
        cfg["bandwidth"][DSD_MODE] = DSD_BW
        sq = cfg.get("squelch")
        if not isinstance(sq, dict):               # older version: one level for FM and WFM
            cfg["squelch"] = {} if sq is None else {"FM": float(sq), "WFM": float(sq)}
        if str(cfg["device"]) not in cfg.get("dongles", {}):
            self._save_profile()
        self.on_row = on_row
        self.on_audio = on_audio
        self.on_baseband = on_baseband
        self.on_demod = on_demod
        self.on_dsd = on_dsd      # DSD mode: gets the discriminator, returns the voice
        self.on_raw = None        # raw dongle samples (VDL2), set by app.py
        self.on_spurs = None      # LEARN finished: the settings have to be saved, set by app.py
        self.spur_learning = False
        self.spur_found = None    # lines found by the last LEARN
        self.spur_version = 0     # changes with the learned lines: the filters are rebuilt
        self.on_status = on_status
        self.on_meter = on_meter   # S-meter level of every block; the status goes out only every 0.2 s
        self.lock = threading.Lock()
        self.pending = {}
        self.status = "stopped"
        self.error = None
        self.gains = []
        self.has_bias_tee = cfg.get("driver", "rtl") in ("rtl", "airspy")
        self.has_rtl_agc = cfg.get("driver", "rtl") == "rtl"
        self.smeter = -150.0
        self.sagc = SmartAgc()
        self.sq_open, self.sq_hang, self.sq_gain = True, 0, 1.0
        self.tsq = ToneSquelch()                 # TSQ-C / TSQ-D: CTCSS / DCS detector (tonesq.py)
        self.tsq_hpf = PassFilter("highpass")    # with a tone squelch on, the tone is not heard
        self.tone_open, self.tone_key = None, None   # set tone / code received; None = no tone squelch now
        self.asq_hist, self.asq_key, self.asq_floor = [], None, None   # auto squelch: (time, dB) and noise floor
        self.asq_spec, self.wf_power = None, None   # auto squelch: noise in the channel from the spectrum (dBFS)
        self.dropped = 0
        self.opened = 0
        self.sdr = None
        self.dev_tuner_min = None   # lower tuning limit reported by the opened dongle (None = by the driver)
        self.thread = None
        self._stop = threading.Event()
        # VFO chaining (iqshare.py): the owner of the dongle sends its blocks to iq_server (set by app.py);
        # a chained VFO (cfg["chain"]) follows the owner's centre, LO and sample rate.
        self.iq_server = None
        self.shared_lo = None
        self.out_of_band = False
        self.atune = AutoTune(self._autotune_done)   # ATU: click -> exact carrier (autotune.py)
        self.scan = Scanner()                        # SCAN tab: memory scanner (scanner.py), runs in _loop

    def _autotune_done(self, old_hz, new_hz):
        """Autotune result (from its thread): retune only if nobody has tuned elsewhere meanwhile."""
        if self.cfg["tune_hz"] == old_hz and not self.pending.get("tune_hz"):
            self.update({"tune_hz": float(new_hz)})

    @property
    def chained(self):
        return bool(self.cfg.get("chain"))

    # --- control from the web page (applied in the receiver thread between reads) ---

    def update(self, changes):
        with self.lock:
            self.pending.update(changes)
            if changes.get("autotune_go"):
                self.atune.arm()                    # "listen" at once, before the receiver thread starts the job
            # Dongle in error (e.g. wrong LO -> frequency outside the tuner range): dongle setting changes
            # are written immediately, so the next open attempt uses them and the error can be fixed in SET.
            if self.status == "error":
                for k in ("lo_offset_hz", "upconv", "ppm"):
                    if k in changes:
                        self.cfg[k] = changes[k]

    @property
    def fs(self):
        return float(self.cfg["sample_rate"])

    def lo_for(self, tune_hz):
        """Upconverter LO for the given frequency: HF goes through the converter, VHF/UHF directly to the dongle.
        upconv: "auto" (converter up to UPCONV_MAX_HZ), "on" (always), "off" (never)."""
        mode = self.cfg.get("upconv", "auto")
        if mode == "off" or (mode == "auto" and tune_hz >= UPCONV_MAX_HZ):
            return 0.0
        return float(self.cfg.get("lo_offset_hz", 0))

    @property
    def lo(self):
        if self.chained and self.shared_lo is not None:
            return self.shared_lo                   # the owner VFO decides the upconverter LO
        return self.lo_for(self.cfg["tune_hz"])

    @property
    def tuner_min(self):
        # the opened dongle knows it better (RTL-SDR Blog V4 from 500 kHz); kept while the dongle is reopened
        return self.dev_tuner_min or TUNER_LIMITS[self.cfg.get("driver", "rtl")][0]

    @property
    def tuner_max(self):
        return TUNER_LIMITS[self.cfg.get("driver", "rtl")][1]

    # Settings that belong to a specific dongle (converter, LO, crystal correction).
    PROFILE_KEYS = ("upconv", "lo_offset_hz", "ppm")

    def _save_profile(self):
        c = self.cfg
        c.setdefault("dongles", {})[str(c["device"])] = {
            "upconv": c.get("upconv", "auto"), "lo_offset_hz": c.get("lo_offset_hz", 0), "ppm": c.get("ppm", 0)}

    def _load_profile(self):
        """After switching dongles: its saved settings; a new dongle takes over the current ones."""
        c = self.cfg
        p = c.get("dongles", {}).get(str(c["device"]))
        if p:
            c.update({k: p[k] for k in self.PROFILE_KEYS if k in p})
        else:
            self._save_profile()
        if not self.tuner_min <= c["tune_hz"] + self.lo <= self.tuner_max:
            # E.g. an HF frequency on a dongle without a converter -> switch to 2 m.
            c["tune_hz"], c["mode"] = 145.5e6, "FM"
            self._recenter(c["tune_hz"])

    def start(self):
        self._stop.clear()
        self.thread = threading.Thread(target=self._run, name="sdr", daemon=True)
        self.thread.start()

    def stop(self):
        self._stop.set()
        if self.thread:
            self.thread.join(timeout=3)

    def _run(self):
        while not self._stop.is_set():
            sdr = None
            reader = None
            try:
                self.status = "opening dongle"
                sdr = open_device(self.cfg)
                self.sdr = sdr
                self.opened += 1
                self.gains = sdr.gains
                self.has_bias_tee, self.has_rtl_agc = sdr.has_bias_tee, sdr.has_rtl_agc
                self.dev_tuner_min = getattr(sdr, "tuner_min_hz", None)
                self._configure(sdr)
                if hasattr(sdr, "calibrate"):
                    # LimeSDR: DC and IQ calibration when opening (may fail on HF, does not matter).
                    self.status = "calibrating"
                    self.on_status()
                    sdr.calibrate()
                sdr.reset_buffer()
                blocks = queue.Queue(maxsize=24)
                self.dropped = 0

                def on_block(raw):
                    try:
                        blocks.put_nowait(raw)
                    except queue.Full:
                        self.dropped += 1

                reader = threading.Thread(target=sdr.read_async, args=(on_block,), name="sdr-usb", daemon=True)
                reader.start()
                self.error = None
                self.status = "running"
                self._loop(sdr, blocks, reader)
            except ResetRequested:
                self.status = "restarting dongle"
                self.on_status()
            except Exception as e:  # device error: show it and try again
                self.error = str(e)
                self.status = "error"
                self.on_status()
                self._stop.wait(5)
            finally:
                if sdr:
                    if reader:
                        sdr.cancel_async()
                        reader.join(timeout=3)
                    sdr.close()

    def _configure(self, sdr):
        c = self.cfg
        sdr.set_sample_rate(c["sample_rate"])
        sdr.set_ppm(c.get("ppm", 0))
        sdr.set_gain(c.get("gain", "auto"))
        sdr.set_rtl_agc(c.get("rtl_agc", False))
        sdr.set_bias_tee(c.get("bias_tee", False))
        sdr.set_center_freq(c["center_hz"] + self.lo)
        # ±10 kHz, so that the 18 kHz filter (AM/FM) also passes; less at a low sample rate (alias).
        self.dec_cutoff = min(10000.0, self.fs / DECIM / 3)
        self.dec = Decimator(self.fs, cutoff=self.dec_cutoff)
        self.chan = Channel(self.fs / DECIM)
        self.spur = SpurFilter(self.fs / DECIM)
        self.spur_mask, self.spur_depth, self.spur_grid, self.spur_settings = None, None, None, None
        self.spur_acc, self.spur_n, self.spur_acc_key = None, 0, None
        self.spur_ema, self.spur_ema_key, self.spur_ema_n = None, None, 0
        self.afi = FreqInverter()
        self.lpf = PassFilter("lowpass")
        self.hpf = PassFilter("highpass")
        self.wfm, self.wfm_key = None, None
        self.phase = 0.0
        self.win = np.hanning(WF_FFT).astype(np.float32)
        self.wf_norm = 1.0 / (self.win.sum() ** 2)
        self.view_start = None
        self.dc_zi = None
        self.view_key = None
        self.view_req = None

    def _apply_pending(self, sdr):
        with self.lock:
            changes, self.pending = self.pending, {}
        if not changes:
            return
        c = self.cfg
        if self.chained:
            # the dongle belongs to the owner VFO: centre, sample rate and device are not ours to change
            for k in ("center_hz", "sample_rate", "device"):
                changes.pop(k, None)
        if "sample_rate" in changes and changes["sample_rate"] != c["sample_rate"]:
            c["sample_rate"] = changes["sample_rate"]
            self._recenter(c["tune_hz"])
            self._configure(sdr)
        if "tune_hz" in changes and changes["tune_hz"] != c["tune_hz"] and isinstance(self.wfm, Wfm):
            self.wfm.rds.reset()                    # another station: old RDS data is not valid
        for k in ("tune_hz", "mode", "zoom"):
            if k in changes:
                c[k] = changes[k]
        if "bandwidth" in changes:
            c.setdefault("bandwidth", {})[c["mode"]] = changes["bandwidth"]
        if "center_hz" in changes:
            c["center_hz"] = changes["center_hz"]
        elif "tune_hz" in changes:
            self._recenter(c["tune_hz"], only_if_outside=True)
        if "lo_offset_hz" in changes:
            c["lo_offset_hz"] = changes["lo_offset_hz"]
        if "upconv" in changes:
            c["upconv"] = changes["upconv"]
        if "view_hz" in changes:
            self._request_view(changes["view_hz"])
        if {"center_hz", "tune_hz", "lo_offset_hz", "view_hz", "upconv"} & changes.keys():
            sdr.set_center_freq(c["center_hz"] + self.lo)
            self.sagc.reset(SAGC_SETTLE)            # another band: the peak window starts again
        if "sagc" in changes:
            c["sagc"] = changes["sagc"]
        if "smart_agc" in changes and not self.chained:
            c["smart_agc"] = bool(changes["smart_agc"])
            if c["smart_agc"]:
                if c.get("gain", "auto") == "auto" and self.gains:
                    c["gain"] = self.gains[len(self.gains) // 2]   # AGC+ starts in the middle and finds its way
                    sdr.set_gain(c["gain"])
                if c.get("rtl_agc"):                # digital gain after the A/D would hide its level
                    c["rtl_agc"] = False
                    sdr.set_rtl_agc(False)
                self.sagc.reset(SAGC_SETTLE)
        elif "gain" in changes or changes.get("rtl_agc"):
            c["smart_agc"] = False                  # a manual gain, tuner AGC or RTL AGC ends AGC+
        if "gain" in changes:
            c["gain"] = changes["gain"]
            sdr.set_gain(c["gain"])
        if "stereo_on" in changes:
            c["stereo_on"] = changes["stereo_on"]
        if "notch" in changes:
            c["notch"] = changes["notch"]
        if "audio_agc" in changes:
            c["audio_agc"] = changes["audio_agc"]
        if "afi" in changes:
            c["afi"] = changes["afi"]
        if "autotune" in changes:
            c["autotune"] = changes["autotune"]
            if not c["autotune"]:
                self.atune.cancel()
        if changes.get("autotune_go"):
            # after the click's tune_hz above; ATU off or another mode: start() only clears the armed "listen"
            self.atune.start(c["mode"] if c.get("autotune") else None, c["tune_hz"], c["center_hz"])
        if "afi_hz" in changes:
            c["afi_hz"] = changes["afi_hz"]
        if "auto_sql" in changes:
            c["auto_sql"] = changes["auto_sql"]
        if "auto_sql_db" in changes:
            c["auto_sql_db"] = changes["auto_sql_db"]
        for k in ("ctcss_hz", "dcs_code"):
            if k in changes:
                c[k] = changes[k]
        # TSQ-C and TSQ-D: one of them at a time (as in a radio)
        if "ctcss" in changes:
            c["ctcss"] = changes["ctcss"]
            if c["ctcss"]:
                c["dcs"] = False
        if "dcs" in changes:
            c["dcs"] = changes["dcs"]
            if c["dcs"]:
                c["ctcss"] = False
        for k in ("lpf", "lpf_hz", "hpf", "hpf_hz"):
            if k in changes:
                c[k] = changes[k]
        for k in ("dc_remove", "dc_hz", "dc_db", "spur_on", "spur_hz", "spur_edge", "spur_db", "spur_shift"):
            if k in changes:
                c[k] = changes[k]
        if changes.get("spur_learn"):
            self.spur_learning, self.spur_acc_key = True, None
        if changes.get("spur_clear"):
            c["spur_lines"], self.spur_found, self.spur_ema_key = [], None, None
            self.spur_version += 1
        if "rtl_agc" in changes:
            c["rtl_agc"] = changes["rtl_agc"]
            sdr.set_rtl_agc(c["rtl_agc"])
        if "ppm" in changes:
            c["ppm"] = changes["ppm"]
            sdr.set_ppm(c["ppm"])
        if "bias_tee" in changes:
            c["bias_tee"] = changes["bias_tee"]
            sdr.set_bias_tee(c["bias_tee"])
        if "squelch" in changes:
            mode = changes.get("squelch_mode", c["mode"])
            if mode in SQUELCH_MODES:
                c["squelch"][mode] = changes["squelch"]
        if set(self.PROFILE_KEYS) & changes.keys():
            self._save_profile()
        if "device" in changes and changes["device"] != c["device"]:
            c["device"] = changes["device"]
            self._load_profile()
            raise ResetRequested()
        if changes.get("reset"):
            # Closes and reopens the dongle (the loop in _run opens it again at once).
            raise ResetRequested()
        self.on_status()

    def scan_tune(self, hz, mode, bw):
        """Scanner (receiver thread): tunes a channel like a recalled memory, but without its decoder and recording."""
        c = self.cfg
        if c["tune_hz"] != hz and isinstance(self.wfm, Wfm):
            self.wfm.rds.reset()
        c["tune_hz"], c["mode"] = float(hz), mode
        if mode != DSD_MODE:
            c.setdefault("bandwidth", {})[mode] = float(bw)
        old = c["center_hz"]
        self._recenter(c["tune_hz"], only_if_outside=True)
        if c["center_hz"] != old and self.sdr:
            self.sdr.set_center_freq(c["center_hz"] + self.lo)
            self.sagc.reset(SAGC_SETTLE)

    def scan_center(self, center, tune):
        """Scanner (receiver thread): the tuner to the next window; the VFO waits on its first channel (muted)."""
        if self.chained:
            return
        c = self.cfg
        c["center_hz"], c["tune_hz"] = float(center), float(tune)
        if self.sdr:
            self.sdr.set_center_freq(c["center_hz"] + self.lo)
        self.sagc.reset(SAGC_SETTLE)

    def _recenter(self, tune, only_if_outside=False):
        """Tuned frequency outside the displayed band -> move the centre (away from the DC spike)."""
        c = self.cfg
        if self.chained:
            return                                  # the centre follows the owner VFO
        half = self.fs / 2 * 0.9
        if only_if_outside and abs(tune - c["center_hz"]) < half:
            return
        c["center_hz"] = max(tune + self.fs * 0.2, self.fs / 2)

    def _request_view(self, view_hz):
        """Dragging the waterfall: the centre of the section is set by the web page. If the section leaves the received band,
        the dongle is retuned so that the section is in its centre."""
        c = self.cfg
        span = self.fs / int(c.get("zoom", 1))
        self.view_req = view_hz
        if self.chained:
            return                                  # dragging stays inside the band of the shared dongle
        if abs(view_hz - c["center_hz"]) + span / 2 > self.fs / 2 * 0.98:
            c["center_hz"] = max(view_hz, self.fs / 2)

    def _learn_spurs(self, power, lo_edge, bin_hz):
        """LEARN: averages the spectrum (retuning the dongle starts it again), then replaces the lines of this band."""
        c = self.cfg
        key = (lo_edge, bin_hz)
        if self.spur_acc_key != key:
            self.spur_acc, self.spur_n, self.spur_acc_key = np.zeros(len(power)), 0, key
        self.spur_acc += power
        self.spur_n += 1
        if self.spur_n * READ_SAMPLES / self.fs < SPUR_LEARN_S:
            return
        found = find_spurs(self.spur_acc / self.spur_n, lo_edge, bin_hz, c["center_hz"])
        if found:                                   # nothing found: the lines learned before stay
            hi_edge = lo_edge + len(power) * bin_hz
            c["spur_lines"] = sorted([ln for ln in c.get("spur_lines", []) if not lo_edge <= ln[0] < hi_edge] + found)
            self.spur_ema_key = None
            self.spur_version += 1
        self.spur_found, self.spur_learning, self.spur_acc = len(found), False, None
        if self.on_spurs:
            self.on_spurs()
        self.on_status()

    def _track_spurs(self, power, lo_edge, bin_hz, lines):
        """Measures the learned lines in the spectrum of now: they change with the gain, and the filter follows their shape.
        Averaged over ~2 s, so that speech on a line is not followed. The filter of the channel is rebuilt from it."""
        c = self.cfg
        key = (lo_edge, bin_hz, c.get("gain"))
        if self.spur_ema_key != key:
            self.spur_ema, self.spur_ema_key, self.spur_ema_n = power.copy(), key, SPUR_TRACK_BLOCKS
        else:
            self.spur_ema = SPUR_EMA * self.spur_ema + (1 - SPUR_EMA) * power
            self.spur_ema_n += 1
        settings = (c.get("spur_hz", SPUR_WIDTH_DEFAULT), c.get("spur_edge", SPUR_EDGE_DEFAULT),
                    c.get("spur_db", SPUR_DB_DEFAULT), c.get("spur_shift", 0))
        if self.spur_ema_n < SPUR_TRACK_BLOCKS and settings == self.spur_settings:
            return
        self.spur_ema_n, self.spur_settings = 0, settings
        width, edge, db, shift = settings
        self.spur_depth = spur_profile(self.spur_ema, lo_edge, bin_hz, lines, width, edge, db, shift)
        self.spur_mask = 10 ** (-self.spur_depth / 10)
        self.spur_grid = (lo_edge, bin_hz)
        self.spur_version += 1

    def _remove_dc(self, iq):
        """DC peak in the centre of the band. Returns new samples: raw is shared, so not in place.

        Width 0 removes only the block mean. A wider peak (LimeSDR has wide skirts) needs a high-pass, width = its cutoff.
        Suppression (dB) sets how much of what they take out is really subtracted.
        """
        if not self.cfg.get("dc_remove", True):
            self.dc_zi = None
            return iq
        k = np.float32(1 - 10 ** (-self.cfg.get("dc_db", 60) / 20))
        hz = self.cfg.get("dc_hz", 0)
        if not hz:
            self.dc_zi = None
            return iq - k * iq.mean()
        from scipy.signal import lfilter
        p = np.exp(-2 * np.pi * hz / self.fs)               # one-pole high-pass; keeps its state between blocks
        g = (1 + p) / 2
        if self.dc_zi is None:
            self.dc_zi = np.array([-g * iq[0]], np.complex64)   # start as if DC had always been there: no click
        out, self.dc_zi = lfilter(np.array([g, -g], np.float32), np.array([1, -p], np.float32), iq, zi=self.dc_zi)
        return (1 - k) * iq + k * out

    def _waterfall(self, iq):
        """Waterfall line: fine FFT of the whole band, from which a section is taken by zoom (WF_BINS points).

        The section moves only when the tuned frequency comes close to its edge, so the picture does not jump
        on every tuning step.
        """
        segs = iq[:WF_SEGMENTS * WF_FFT].reshape(WF_SEGMENTS, WF_FFT) * self.win
        power = np.fft.fftshift(np.mean(np.abs(np.fft.fft(segs, axis=1)) ** 2, axis=0)) * self.wf_norm
        if self.cfg.get("dc_remove", True):
            mid = WF_FFT // 2
            power[mid] = (power[mid - 1] + power[mid + 1]) / 2  # what is left of the DC spike after _loop removed the mean
        self.wf_power = power                       # for the auto squelch (before the spur mask)

        c = self.cfg
        zoom = int(c.get("zoom", 1))
        span_bins = WF_FFT // zoom
        bin_hz = self.fs / WF_FFT
        lo_edge = c["center_hz"] - self.fs / 2
        tune_bin = (c["tune_hz"] - lo_edge) / bin_hz
        start = self.view_start
        if self.view_req is not None:
            # A section set by dragging on the web page is valid while the tuned frequency is in it and the zoom does not change.
            req = int(round((self.view_req - lo_edge) / bin_hz - span_bins / 2))
            req = max(0, min(WF_FFT - span_bins, req))
            if self.view_key and self.view_key[0] == zoom and req <= tune_bin <= req + span_bins:
                start = req
            else:
                self.view_req = None
        if self.view_req is None and (start is None or self.view_key != (zoom, c["center_hz"])
                or not start + 0.1 * span_bins < tune_bin < start + 0.9 * span_bins):
            start = int(round(tune_bin - span_bins / 2))
        start = max(0, min(WF_FFT - span_bins, start))
        self.view_start, self.view_key = start, (zoom, c["center_hz"])

        if self.spur_learning:
            self._learn_spurs(power, lo_edge, bin_hz)   # from the spectrum before the filter
        lines = c.get("spur_lines")
        if c.get("spur_on") and lines:
            self._track_spurs(power, lo_edge, bin_hz, lines)
            power = power * self.spur_mask
        else:
            self.spur_ema_key = None                # measured afresh when switched on again
        def to_row(p):
            db = 10 * np.log10(p.reshape(WF_BINS, -1).mean(axis=1) + 1e-20)
            return np.clip((db - WF_DB_MIN) / WF_DB_STEP, 0, 255).astype(np.uint8).tobytes()

        view_center = lo_edge + (start + span_bins / 2) * bin_hz
        # Zoomed in: also a coarse line of the whole band, so the browser can show the history of the parts hidden
        # by the zoom when zooming out. At 1× the line itself is the whole band.
        full = to_row(power) if zoom > 1 else None
        self.on_row(to_row(power[start:start + span_bins]), view_center, span_bins * bin_hz, full, c["center_hz"], self.fs)

    def _loop(self, sdr, blocks, reader):
        last_status = 0
        while not self._stop.is_set():
            self._apply_pending(sdr)
            try:
                raw = blocks.get(timeout=2)
            except queue.Empty:
                raise RuntimeError("dongle is not sending data" if reader.is_alive() else "dongle reading stopped")
            if isinstance(raw, tuple):              # chained VFO: (owner's metadata, samples)
                meta, raw = raw
                self._follow(meta, sdr)
            elif self.iq_server:
                self.iq_server.publish(raw, self._share_meta())
            if self.cfg.get("smart_agc") and not self.chained and self.gains:
                self._smart_agc(sdr, raw, blocks.qsize())
            if self.on_raw and (raw.dtype == np.complex64 or len(raw) == READ_SAMPLES * 2):
                self.on_raw(raw, self.fs, self.cfg["center_hz"])   # VDL2: raw samples to dumpvdl2
            if raw.dtype == np.complex64:
                iq = raw                            # LimeSDR, Airspy: already normalised complex samples
            elif len(raw) != READ_SAMPLES * 2:
                continue
            else:
                iq = raw.astype(np.float32).view(np.complex64)
                iq -= np.complex64(127.5 + 127.5j)
                iq *= np.float32(1 / 127.5)
            iq = self._remove_dc(iq)

            self._waterfall(iq)
            if self.scan.on or self.scan.cmds:
                self.scan.block(self, blocks.qsize())   # may retune for this very block (scanner.py)

            # Channel: shift of the tuned frequency to zero, decimation, demodulation.
            c = self.cfg
            offset = c["tune_hz"] - c["center_hz"]
            n = len(iq)
            self.out_of_band = self.chained and abs(offset) > self.fs / 2 * BAND_EDGE
            if self.out_of_band:
                # the owner VFO moved the dongle away: this VFO is silent until it is tuned into the band again
                self.smeter = -150.0
                self.on_audio(bytes(n // DECIM * 4))
                now = time.time()
                if now - last_status > 0.2:
                    last_status = now
                    self.on_status()
                continue
            step = -2 * np.pi * offset / self.fs
            mixer = np.exp(1j * (self.phase + step * np.arange(n, dtype=np.float64))).astype(np.complex64)
            self.phase = (self.phase + step * n) % (2 * np.pi)
            shifted = iq * mixer
            base = self.dec.process(shifted)
            if c.get("spur_on") and c.get("spur_lines"):
                base = self.spur.process(base, c["tune_hz"], self.spur_depth, *self.spur_grid, self.spur_version)
            elif self.spur.active:
                self.spur.reset()
            if self.on_baseband:
                self.on_baseband(base, self.fs / DECIM, c["tune_hz"])
            if self.atune.active:
                self.atune.feed(base, self.fs / DECIM, c["tune_hz"], c["mode"])
            mode = c["mode"]
            dsd = mode == DSD_MODE
            bw = DSD_BW if dsd else float(c.get("bandwidth", {}).get(mode, 3000))
            if mode == "WFM" or (mode == "FM" and bw > FM_NARROW_MAX):
                # Wide FM does not fit the narrow channel: it is demodulated from the input samples.
                if self.wfm_key != (self.fs, mode, bw):
                    self.wfm = Wfm(self.fs, bw) if mode == "WFM" else WideFm(self.fs, bw)
                    self.wfm_key = (self.fs, mode, bw)
                self.wfm.allow_stereo = c.get("stereo_on", True)
                audio, self.smeter = self.wfm.process(shifted)
                sub_db = self.wfm.sub_db
            else:
                self.chan.configure("FM" if dsd else mode, bw)
                self.chan.notch_on = bool(c.get("notch", False))
                self.chan.agc_on = bool(c.get("audio_agc", True))
                audio, self.smeter = self.chan.process(base)
                sub_db = self.chan.sub_db
            cal = getattr(self.sdr, "smeter_offset", 0.0)   # Lime: matched to RTL, RTL: 0
            if cal:
                self.smeter += cal
                sub_db = sub_db + cal
            if self.on_meter:
                self.on_meter(self.smeter)
            # tone squelch on the plain FM audio (before AFI, LPF and HPF would change the sub-audio band)
            self.tone_open = self._tone_squelch(audio, mode)
            if c.get("afi") and mode not in ("WFM", DSD_MODE) and audio.ndim == 1:   # AFI: voice inversion (de)scrambler
                audio = self.afi.process(audio, self.fs / DECIM, float(c.get("afi_hz", AFI_DEFAULT_HZ)))
            if self.on_demod:                       # demodulated audio before the squelch (SSTV)
                self.on_demod(audio if audio.ndim == 1 else audio.mean(axis=1), self.fs / DECIM)
            if dsd and self.on_dsd:                 # from here on the audio is the decoded voice
                audio = self.on_dsd(audio, self.fs / DECIM, c["tune_hz"])
            audio = self._audio_pass(audio)         # after the SSTV feed: LPF / HPF are for listening, not for decoders
            if self.tone_open is not None or self.tsq_hpf.key is not None:   # also the block after, for the crossfade
                mono = audio.ndim == 1
                x = self.tsq_hpf.process(np.stack((audio, audio), axis=1) if mono else audio, self.fs / DECIM,
                                         TONE_HPF_HZ if self.tone_open is not None else None)
                audio = (x[:, 0] if mono else x).astype(np.float32)
            if self.scan.on:
                self.scan.audio(audio, self.fs / DECIM)   # scan: recording of each activity (before the squelch)
            self._noise_floor(mode, bw, sub_db, cal)
            audio = self._squelch(audio, mode, sub_db, self.tone_open)
            if audio.ndim == 1:                     # the browser always gets stereo (L, R interleaved)
                audio = np.repeat(audio[:, None], 2, axis=1)
            self.on_audio((audio * 32767).astype("<i2").tobytes())

            now = time.time()
            if now - last_status > 0.2:
                last_status = now
                self.on_status()

    def _smart_agc(self, sdr, raw, backlog):
        """AGC+: the tuner gain from the A/D level of this block (SmartAgc)."""
        c = self.cfg
        gain = c.get("gain", "auto")
        if gain == "auto":
            return
        new = self.sagc.step(raw, self.gains, float(gain), len(raw) / (2 if raw.dtype == np.uint8 else 1) / self.fs,
                             backlog, sagc_params(c), getattr(sdr, "gain_db_per_unit", 1.0))
        if new is not None:
            c["gain"] = new
            sdr.set_gain(new)
            self.on_status()

    def _share_meta(self):
        """Dongle state sent with every block to the chained VFOs."""
        c = self.cfg
        return {"center_hz": c["center_hz"], "lo": self.lo, "fs": c["sample_rate"], "gain": c.get("gain", "auto"),
                "gains": self.gains, "rtl_agc": bool(c.get("rtl_agc", False)), "smart_agc": bool(c.get("smart_agc", False)),
                "sagc": sagc_params(c), "bias_tee": bool(c.get("bias_tee", False)),
                "ppm": c.get("ppm", 0), "has_bias_tee": self.has_bias_tee, "has_rtl_agc": self.has_rtl_agc,
                "smeter_offset": getattr(self.sdr, "smeter_offset", 0.0)}

    def _follow(self, meta, sdr):
        """Chained VFO: takes over the dongle state of the owner VFO."""
        c = self.cfg
        self.shared_lo = float(meta["lo"])
        self.gains = meta.get("gains", self.gains)
        self.has_bias_tee, self.has_rtl_agc = meta.get("has_bias_tee", True), meta.get("has_rtl_agc", True)
        for k in ("gain", "rtl_agc", "smart_agc", "sagc", "bias_tee", "ppm"):
            if k in meta:
                c[k] = meta[k]
        c["center_hz"] = float(meta["center_hz"])
        if int(meta["fs"]) != int(c["sample_rate"]):
            c["sample_rate"] = int(meta["fs"])
            self._configure(sdr)                    # new decimator and FFT window for the new rate

    def _audio_pass(self, audio):
        """LPF and HPF keys. Runs also in the block after switching off, for the crossfade."""
        c = self.cfg
        lp = float(c.get("lpf_hz", LPF_DEFAULT_HZ)) if c.get("lpf") else None
        hp = float(c.get("hpf_hz", HPF_DEFAULT_HZ)) if c.get("hpf") else None
        if lp is None and hp is None and self.lpf.key is None and self.hpf.key is None:
            return audio
        fs = self.fs / DECIM
        mono = audio.ndim == 1                      # 2 channels always: WFM changes between mono and stereo
        x = np.stack((audio, audio), axis=1) if mono else audio
        x = self.hpf.process(self.lpf.process(x, fs, lp), fs, hp)
        return np.clip(x[:, 0] if mono else x, -1, 1).astype(np.float32)   # overshoot must not wrap in 16 bits

    def tsq_on(self, mode=None):
        """A tone squelch (TSQ-C CTCSS or TSQ-D DCS) works now: only in FM."""
        c = self.cfg
        return (mode or c["mode"]) == "FM" and bool(c.get("ctcss") or c.get("dcs"))

    def _tone_squelch(self, audio, mode):
        """TSQ-C / TSQ-D: True / False = the set tone / code is / is not received, None = no tone squelch."""
        c = self.cfg
        if not self.tsq_on(mode) or audio.ndim != 1:
            if self.tone_open is not None:
                self.tsq.reset()
                self.tone_key = None
            return None
        key = ("C", float(c.get("ctcss_hz", CTCSS_DEFAULT_HZ))) if c.get("ctcss") else ("D", c.get("dcs_code", DCS_DEFAULT))
        if key != self.tone_key:                # another tone / code: start again (no match carried over)
            self.tone_key = key
            self.tsq.reset()
        if c.get("ctcss"):
            return self.tsq.process(audio, self.fs / DECIM, ctcss_hz=float(c.get("ctcss_hz", CTCSS_DEFAULT_HZ)))
        return self.tsq.process(audio, self.fs / DECIM, dcs_code=c.get("dcs_code", DCS_DEFAULT))

    def _squelch(self, audio, mode, sub_db, tone=None):
        """Squelch for AM/FM/WFM: mutes the sound while the channel power is below the mode's level.
        It decides per part of a block (sub_db, ~8 ms), with 2 dB hysteresis and SQUELCH_HANG_S hold.
        In AM the carrier is measured too, so the squelch is opened by the transmission's carrier (airband).
        tone: tone squelch (TSQ-C / TSQ-D) in addition: False mutes the whole block, None = not used.
        The volume change goes smoothly over one part, so it does not click."""
        level = self.squelch_level(mode)
        parts = len(sub_db)
        gains = np.ones(parts, np.float32)
        if self.scan.on and not self.scan.paused:
            # scanning: the scanner decides (its level per channel, from the same block's spectrum)
            self.sq_open, self.sq_hang = self.scan.audio_open, 0
            gains[:] = 1.0 if self.sq_open else 0.0
        elif level <= SQUELCH_OFF:
            self.sq_open, self.sq_hang = True, 0
        else:
            part_s = len(audio) / parts / (self.fs / DECIM)
            hang = max(1, int(round(SQUELCH_HANG_S / part_s)))
            for i, p in enumerate(sub_db):
                if p > level + (-2 if self.sq_open else 2):
                    self.sq_open, self.sq_hang = True, hang
                elif self.sq_hang > 0:
                    self.sq_hang -= 1
                else:
                    self.sq_open = False
                gains[i] = 1.0 if self.sq_open else 0.0
        if tone is False:
            gains[:] = 0.0
        start = np.concatenate(([self.sq_gain], gains[:-1])).astype(np.float32)
        self.sq_gain = float(gains[-1])
        if start.min() == 1.0 and gains.min() == 1.0:
            return audio
        t = np.arange(len(audio) // parts, dtype=np.float32) / (len(audio) // parts)
        env = (start[:, None] + (gains - start)[:, None] * t).ravel()
        return audio * (env[:, None] if audio.ndim == 2 else env)

    def tune_range(self):
        """(from, to) Hz that can be tuned: by the converter and the optional limit max_hz (HF VFO)."""
        c = self.cfg
        if self.chained:
            # only the band the shared dongle receives right now
            half = self.fs / 2 * BAND_EDGE
            return c["center_hz"] - half, c["center_hz"] + half
        mode, lo = c.get("upconv", "auto"), float(c.get("lo_offset_hz", 0))
        tmin, tmax = self.tuner_min, self.tuner_max
        if mode == "off" or (mode == "on" and lo == 0):
            lo_hz, hi_hz = tmin, tmax
        elif mode == "on":
            lo_hz, hi_hz = max(0.0, tmin - lo), tmax - lo
        else:
            lo_hz, hi_hz = 0.0, tmax
        return lo_hz, min(hi_hz, float(c.get("max_hz", hi_hz)))

    def auto_sql_on(self, mode):
        """Auto squelch: the ASQ key, or AGC+ with the squelch set (a fixed level would not fit a changing gain)."""
        c = self.cfg
        if mode not in SQUELCH_MODES:
            return False
        if c.get("auto_sql"):
            return True
        return bool(c.get("smart_agc")) and self.manual_squelch(mode) > SQUELCH_OFF

    def _noise_floor(self, mode, bw, sub_db, cal=0.0):
        """Auto squelch: noise floor of the channel, measured on the noise, not on the signal.
        Main estimate: noise density from the spectrum of the dongle band (a low percentile of its points, so
        signals do not count), times the channel bandwidth. A transmission in the channel does not move it.
        It is limited by the quietest channel power over the last ASQ_WINDOW_S (crowded bands, e.g. FM broadcast,
        where the spectrum is mostly signals). Starts again after a change of frequency, mode, bandwidth or gain."""
        if not self.auto_sql_on(mode):
            self.asq_hist, self.asq_key, self.asq_floor, self.asq_spec = [], None, None, None
            return
        c = self.cfg
        key = (c["tune_hz"], mode, bw, c.get("gain"))
        if key != self.asq_key:
            self.asq_hist, self.asq_key, self.asq_spec = [], key, None
        now = time.monotonic()
        self.asq_hist.extend((now, float(p)) for p in sub_db)
        while self.asq_hist and now - self.asq_hist[0][0] > ASQ_WINDOW_S:
            self.asq_hist.pop(0)
        floor = float(np.percentile([p for _, p in self.asq_hist], ASQ_PCT))
        pw = self.wf_power
        if pw is not None:
            n = len(pw)
            lo, hi = int(n * (1 - ASQ_SPAN) / 2), int(n * (1 + ASQ_SPAN) / 2)
            mid = n // 2
            pts = np.concatenate((pw[lo:mid - 4], pw[mid + 5:hi]))   # without what is left of the DC spike
            enbw = bw if mode == "WFM" or (mode == "FM" and bw > FM_NARROW_MAX) else min(bw, 2 * self.dec_cutoff)
            # point power -> density per Hz (Hann window) -> power in the channel bandwidth; + percentile bias
            noise = float(np.percentile(pts, ASQ_PCT)) * ASQ_WIN_K / self.fs * enbw
            db = 10 * np.log10(noise + 1e-20) + ASQ_PCT_BIAS_DB + cal
            self.asq_spec = db if self.asq_spec is None else self.asq_spec + ASQ_SMOOTH * (db - self.asq_spec)
            floor = min(floor, self.asq_spec)
        self.asq_floor = floor

    def manual_squelch(self, mode):
        if mode not in SQUELCH_MODES:
            return SQUELCH_OFF
        return float(self.cfg["squelch"].get(mode, SQUELCH_OFF))

    def auto_sql_level(self):
        """Level of the auto squelch: noise floor + margin, or None before it is known."""
        if self.asq_floor is None:
            return None
        margin = float(self.cfg.get("auto_sql_db", ASQ_DEFAULT_DB))
        return round(max(self.asq_floor + margin, SQUELCH_OFF + 1), 1)

    def squelch_level(self, mode):
        """Squelch level in use: the auto squelch level when it runs, else the level set for the mode."""
        if self.auto_sql_on(mode):
            lvl = self.auto_sql_level()
            return SQUELCH_OFF if lvl is None else lvl
        return self.manual_squelch(mode)

    def mpx_spectrum(self):
        """MPX spectrum of the WFM demodulator, or None when not receiving WFM."""
        wfm = getattr(self, "wfm", None) if self.cfg["mode"] == "WFM" else None
        return wfm.mpx_spectrum() if isinstance(wfm, Wfm) else None

    def state(self):
        c = self.cfg
        wfm = getattr(self, "wfm", None) if c["mode"] == "WFM" else None   # does not exist yet before the thread starts
        if not isinstance(wfm, Wfm):                # after FM -> WFM it stays WideFm until the thread's next block
            wfm = None
        return {
            "stereo": bool(wfm and wfm.stereo and c.get("stereo_on", True)),   # L-R really decoded
            "pilot": bool(wfm and wfm.stereo),                                    # 19 kHz pilot locked
            "stereo_on": bool(c.get("stereo_on", True)),
            "notch": bool(c.get("notch", False)),
            "audio_agc": bool(c.get("audio_agc", True)),
            "afi": bool(c.get("afi", False)),
            "afi_hz": float(c.get("afi_hz", AFI_DEFAULT_HZ)),
            "autotune": bool(c.get("autotune", False)),
            "autotune_info": self.atune.info(),
            "lpf": bool(c.get("lpf", False)),
            "lpf_hz": float(c.get("lpf_hz", LPF_DEFAULT_HZ)),
            "hpf": bool(c.get("hpf", False)),
            "hpf_hz": float(c.get("hpf_hz", HPF_DEFAULT_HZ)),
            "notch_active": bool(getattr(getattr(self, "chan", None), "notch", None)
                                 and self.chan.notch.notched and c["mode"] in NOTCH_MODES),
            "rds": wfm.rds.info() if wfm else None,
            "squelch": self.squelch_level(c["mode"]),      # level for the current mode
            "squelch_levels": {m: self.manual_squelch(m) for m in SQUELCH_MODES},   # set levels (slider)
            "auto_sql": bool(c.get("auto_sql", False)),            # ASQ key
            "auto_sql_on": self.auto_sql_on(c["mode"]),            # auto squelch runs (ASQ key, or AGC+ with squelch set)
            "auto_sql_db": float(c.get("auto_sql_db", ASQ_DEFAULT_DB)),
            "auto_sql_level": self.auto_sql_level() if self.auto_sql_on(c["mode"]) else None,
            "squelch_open": self.sq_open and self.tone_open is not False,   # carrier and tone squelch together
            "scan": self.scan.info(),                              # SCAN tab (scanner.py)
            "ctcss": bool(c.get("ctcss", False)),                  # TSQ-C key
            "ctcss_hz": float(c.get("ctcss_hz", CTCSS_DEFAULT_HZ)),
            "dcs": bool(c.get("dcs", False)),                      # TSQ-D key
            "dcs_code": c.get("dcs_code", DCS_DEFAULT),
            "tsq_on": self.tsq_on(),                               # a tone squelch works (FM)
            "tone_match": bool(self.tone_open),                    # the set tone / code is received now
            "tone_metric": self.tsq.metric if self.tone_open is not None else None,   # CTCSS dB / DCS correlation
            "status": self.status,
            "error": self.error,
            "device": c["device"],
            "vfo": c.get("vfo"),
            "serial": c.get("serial"),
            "chain_owner": (c.get("chain") or {}).get("owner"),   # chained VFO: name of the VFO with the dongle
            "out_of_band": self.out_of_band,
            "chained_vfos": self.iq_server.count if self.iq_server else 0,
            "driver": c.get("driver", "rtl"),
            "has_bias_tee": self.has_bias_tee,
            "has_rtl_agc": self.has_rtl_agc,
            "range": self.tune_range(),
            "tune_hz": c["tune_hz"],
            "center_hz": c["center_hz"],
            "lo_offset_hz": c.get("lo_offset_hz", 0),
            "lo_hz": self.lo,                       # LO currently used (0 = direct without a converter)
            "upconv": c.get("upconv", "auto"),
            "sample_rate": c["sample_rate"],
            "audio_rate": c["sample_rate"] / DECIM,
            "mode": c["mode"],
            "bandwidth": c.get("bandwidth", {}),
            "gain": c.get("gain", "auto"),
            "gains": self.gains,
            "rtl_agc": bool(c.get("rtl_agc", False)),
            "smart_agc": bool(c.get("smart_agc", False)),
            "adc_peak": round(float(20 * np.log10(max(self.sagc.peak, 1e-4))), 1),   # dBFS of the last block measured by AGC+
            "adc_clip": bool(self.sagc.clip > 0),
            "adc_clip_ppm": round(self.sagc.clip * 1e6, 1),
            "sagc": sagc_params(c),
            "ppm": c.get("ppm", 0),
            "dc_remove": bool(c.get("dc_remove", True)),
            "dc_hz": c.get("dc_hz", 0),
            "dc_db": c.get("dc_db", 60),
            "spur_on": bool(c.get("spur_on", False)),
            "spur_hz": c.get("spur_hz", SPUR_WIDTH_DEFAULT),
            "spur_edge": c.get("spur_edge", SPUR_EDGE_DEFAULT),
            "spur_shift": c.get("spur_shift", 0),
            "spur_db": c.get("spur_db", SPUR_DB_DEFAULT),
            "spur_count": len(c.get("spur_lines", [])),
            "spur_learning": self.spur_learning,
            "spur_found": self.spur_found,
            "bias_tee": bool(c.get("bias_tee", False)),
            "smeter": round(self.smeter, 1),
            "dropped": self.dropped,
            "opened": self.opened,
            # LimeSDR: stream state in LimeSuite (lost samples, PLL retunes) for diagnostics
            "hw": self.sdr.stream_status() if hasattr(self.sdr, "stream_status") else None,
            "can_tx": hasattr(self.sdr, "tx_start"),
            "tx": bool(getattr(self.sdr, "tx_on", False)),
            "tx_info": getattr(self.sdr, "tx_info", None),
            "zoom": int(c.get("zoom", 1)),
            "zooms": ZOOMS,
            "wf": {"bins": WF_BINS, "db_min": WF_DB_MIN, "db_step": WF_DB_STEP,
                   "rows_per_s": c["sample_rate"] / READ_SAMPLES},
        }
