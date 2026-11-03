"""RTL-SDR (via librtlsdr and ctypes) or LimeSDR (lime.py) and DSP for RADIMCOM
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
MODES = ("AM", "FM", "WFM", "LSB", "USB", "CW")
UPCONV_MAX_HZ = 30e6   # in auto mode only HF (below 30 MHz) goes through the upconverter
TUNER_MIN_HZ = 24e6    # R820T tuner range without a converter
TUNER_MAX_HZ = 1766e6
# Tuning range by device type (driver in vfos.json / config).
# LimeSDR Mini officially starts at 10 MHz; lower (via the NCO) it receives weaker, but usable.
TUNER_LIMITS = {"rtl": (TUNER_MIN_HZ, TUNER_MAX_HZ), "lime": (1e6, 3500e6)}
SSB_LOW_CUT = 300.0   # Hz, lower edge of the SSB passband
CW_PITCH = 700.0      # Hz, tone pitch of a CW signal tuned exactly to the frequency
SQUELCH_OFF = -120.0  # dBFS, squelch at this level and below is off
SQUELCH_HANG_S = 0.2  # s, how long the squelch stays open after the signal drops
FM_NARROW_MAX = 18000.0   # FM up to this width in the narrow channel (input / DECIM), wider via WideFm (up to 50 kHz)
SQUELCH_SUB = 8      # the squelch decides 8× per block (~8 ms) so it does not cut off the start of a transmission
SQUELCH_MODES = ("AM", "FM", "WFM")   # each mode has its own level (airband AM differs from broadcast)
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
    """Opens the device by cfg["driver"] (rtl / lime); both classes have the same interface."""
    serial = cfg.get("serial")
    if cfg.get("driver", "rtl") == "lime":
        from lime import LimeSdr
        return LimeSdr(READ_SAMPLES, serial=serial, index=int(cfg["device"]))
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

    def __init__(self, cfg, on_row, on_audio, on_status, on_baseband=None, on_demod=None):
        self.cfg = cfg
        cfg.setdefault("bandwidth", {}).setdefault("CW", 500)
        cfg["bandwidth"].setdefault("WFM", 200000)
        sq = cfg.get("squelch")
        if not isinstance(sq, dict):               # older version: one level for FM and WFM
            cfg["squelch"] = {} if sq is None else {"FM": float(sq), "WFM": float(sq)}
        if str(cfg["device"]) not in cfg.get("dongles", {}):
            self._save_profile()
        self.on_row = on_row
        self.on_audio = on_audio
        self.on_baseband = on_baseband
        self.on_demod = on_demod
        self.on_raw = None        # raw dongle samples (VDL2), set by app.py
        self.on_status = on_status
        self.lock = threading.Lock()
        self.pending = {}
        self.status = "stopped"
        self.error = None
        self.gains = []
        self.has_bias_tee = self.has_rtl_agc = cfg.get("driver", "rtl") == "rtl"
        self.smeter = -150.0
        self.sq_open, self.sq_hang, self.sq_gain = True, 0, 1.0
        self.dropped = 0
        self.opened = 0
        self.sdr = None
        self.thread = None
        self._stop = threading.Event()

    # --- control from the web page (applied in the receiver thread between reads) ---

    def update(self, changes):
        with self.lock:
            self.pending.update(changes)
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
        return self.lo_for(self.cfg["tune_hz"])

    @property
    def tuner_min(self):
        return TUNER_LIMITS[self.cfg.get("driver", "rtl")][0]

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
        self.dec = Decimator(self.fs, cutoff=min(10000.0, self.fs / DECIM / 3))
        self.chan = Channel(self.fs / DECIM)
        self.wfm, self.wfm_key = None, None
        self.phase = 0.0
        self.win = np.hanning(WF_FFT).astype(np.float32)
        self.wf_norm = 1.0 / (self.win.sum() ** 2)
        self.view_start = None
        self.view_key = None
        self.view_req = None

    def _apply_pending(self, sdr):
        with self.lock:
            changes, self.pending = self.pending, {}
        if not changes:
            return
        c = self.cfg
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
        if "gain" in changes:
            c["gain"] = changes["gain"]
            sdr.set_gain(c["gain"])
        if "stereo_on" in changes:
            c["stereo_on"] = changes["stereo_on"]
        if "notch" in changes:
            c["notch"] = changes["notch"]
        if "audio_agc" in changes:
            c["audio_agc"] = changes["audio_agc"]
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

    def _recenter(self, tune, only_if_outside=False):
        """Tuned frequency outside the displayed band -> move the centre (away from the DC spike)."""
        c = self.cfg
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
        if abs(view_hz - c["center_hz"]) + span / 2 > self.fs / 2 * 0.98:
            c["center_hz"] = max(view_hz, self.fs / 2)

    def _waterfall(self, iq):
        """Waterfall line: fine FFT of the whole band, from which a section is taken by zoom (WF_BINS points).

        The section moves only when the tuned frequency comes close to its edge, so the picture does not jump
        on every tuning step.
        """
        segs = iq[:WF_SEGMENTS * WF_FFT].reshape(WF_SEGMENTS, WF_FFT) * self.win
        power = np.fft.fftshift(np.mean(np.abs(np.fft.fft(segs, axis=1)) ** 2, axis=0)) * self.wf_norm
        mid = WF_FFT // 2
        power[mid] = (power[mid - 1] + power[mid + 1]) / 2  # RTL-SDR DC spike

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

        view = power[start:start + span_bins].reshape(WF_BINS, -1).mean(axis=1)
        db = 10 * np.log10(view + 1e-20)
        row = np.clip((db - WF_DB_MIN) / WF_DB_STEP, 0, 255).astype(np.uint8)
        view_center = lo_edge + (start + span_bins / 2) * bin_hz
        self.on_row(row.tobytes(), view_center, span_bins * bin_hz)

    def _loop(self, sdr, blocks, reader):
        last_status = 0
        while not self._stop.is_set():
            self._apply_pending(sdr)
            try:
                raw = blocks.get(timeout=2)
            except queue.Empty:
                raise RuntimeError("dongle is not sending data" if reader.is_alive() else "dongle reading stopped")
            if self.on_raw and (raw.dtype == np.complex64 or len(raw) == READ_SAMPLES * 2):
                self.on_raw(raw, self.fs, self.cfg["center_hz"])   # VDL2: raw samples to dumpvdl2
            if raw.dtype == np.complex64:
                iq = raw                            # LimeSDR: already normalised complex samples
            elif len(raw) != READ_SAMPLES * 2:
                continue
            else:
                iq = raw.astype(np.float32).view(np.complex64)
                iq -= np.complex64(127.5 + 127.5j)
                iq *= np.float32(1 / 127.5)

            self._waterfall(iq)

            # Channel: shift of the tuned frequency to zero, decimation, demodulation.
            c = self.cfg
            offset = c["tune_hz"] - c["center_hz"]
            n = len(iq)
            step = -2 * np.pi * offset / self.fs
            mixer = np.exp(1j * (self.phase + step * np.arange(n, dtype=np.float64))).astype(np.complex64)
            self.phase = (self.phase + step * n) % (2 * np.pi)
            shifted = iq * mixer
            base = self.dec.process(shifted)
            if self.on_baseband:
                self.on_baseband(base, self.fs / DECIM, c["tune_hz"])
            mode = c["mode"]
            bw = float(c.get("bandwidth", {}).get(mode, 3000))
            if mode == "WFM" or (mode == "FM" and bw > FM_NARROW_MAX):
                # Wide FM does not fit the narrow channel: it is demodulated from the input samples.
                if self.wfm_key != (self.fs, mode, bw):
                    self.wfm = Wfm(self.fs, bw) if mode == "WFM" else WideFm(self.fs, bw)
                    self.wfm_key = (self.fs, mode, bw)
                self.wfm.allow_stereo = c.get("stereo_on", True)
                audio, self.smeter = self.wfm.process(shifted)
                sub_db = self.wfm.sub_db
            else:
                self.chan.configure(mode, bw)
                self.chan.notch_on = bool(c.get("notch", False))
                self.chan.agc_on = bool(c.get("audio_agc", True))
                audio, self.smeter = self.chan.process(base)
                sub_db = self.chan.sub_db
            cal = getattr(self.sdr, "smeter_offset", 0.0)   # Lime: matched to RTL, RTL: 0
            if cal:
                self.smeter += cal
                sub_db = sub_db + cal
            if self.on_demod:                       # demodulated audio before the squelch (SSTV)
                self.on_demod(audio if audio.ndim == 1 else audio.mean(axis=1), self.fs / DECIM)
            audio = self._squelch(audio, mode, sub_db)
            if audio.ndim == 1:                     # the browser always gets stereo (L, R interleaved)
                audio = np.repeat(audio[:, None], 2, axis=1)
            self.on_audio((audio * 32767).astype("<i2").tobytes())

            now = time.time()
            if now - last_status > 0.2:
                last_status = now
                self.on_status()

    def _squelch(self, audio, mode, sub_db):
        """Squelch for AM/FM/WFM: mutes the sound while the channel power is below the mode's level.
        It decides per part of a block (sub_db, ~8 ms), with 2 dB hysteresis and SQUELCH_HANG_S hold.
        In AM the carrier is measured too, so the squelch is opened by the transmission's carrier (airband).
        The volume change goes smoothly over one part, so it does not click."""
        level = self.squelch_level(mode)
        parts = len(sub_db)
        gains = np.ones(parts, np.float32)
        if level <= SQUELCH_OFF:
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
        mode, lo = c.get("upconv", "auto"), float(c.get("lo_offset_hz", 0))
        tmin, tmax = self.tuner_min, self.tuner_max
        if mode == "off" or (mode == "on" and lo == 0):
            lo_hz, hi_hz = tmin, tmax
        elif mode == "on":
            lo_hz, hi_hz = max(0.0, tmin - lo), tmax - lo
        else:
            lo_hz, hi_hz = 0.0, tmax
        return lo_hz, min(hi_hz, float(c.get("max_hz", hi_hz)))

    def squelch_level(self, mode):
        if mode not in SQUELCH_MODES:
            return SQUELCH_OFF
        return float(self.cfg["squelch"].get(mode, SQUELCH_OFF))

    def state(self):
        c = self.cfg
        wfm = getattr(self, "wfm", None) if c["mode"] == "WFM" else None   # does not exist yet before the thread starts
        return {
            "stereo": bool(wfm and wfm.stereo),
            "stereo_on": bool(c.get("stereo_on", True)),
            "notch": bool(c.get("notch", False)),
            "audio_agc": bool(c.get("audio_agc", True)),
            "notch_active": bool(getattr(getattr(self, "chan", None), "notch", None)
                                 and self.chan.notch.notched and c["mode"] in NOTCH_MODES),
            "rds": wfm.rds.info() if wfm else None,
            "squelch": self.squelch_level(c["mode"]),      # level for the current mode
            "squelch_levels": {m: self.squelch_level(m) for m in SQUELCH_MODES},
            "squelch_open": self.sq_open,
            "status": self.status,
            "error": self.error,
            "device": c["device"],
            "vfo": c.get("vfo"),
            "serial": c.get("serial"),
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
            "ppm": c.get("ppm", 0),
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
