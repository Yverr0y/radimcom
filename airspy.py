"""Airspy R2 (via airspy.dll from PothosSDR and ctypes) with the same interface as RtlSdr in sdr.py.

Receive only; read_async sends blocks already as complex samples complex64 in the range ±1, like LimeSdr.
The serial number is the 64-bit number of the device, written as 16 hex digits.
"""
import ctypes
import os
import threading

import numpy as np

# airspy.dll: first from the lib folder (bundled in the installer), otherwise from the installed PothosSDR
_LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib")
AIRSPY_BIN = _LIB if os.path.exists(os.path.join(_LIB, "airspy.dll")) else r"C:\Program Files\PothosSDR\bin"
SAMPLE_FLOAT32_IQ = 0
AIRSPY_TRUE = 1
MAX_DEVICES = 8
GAIN_MAX = 21       # the "linearity" gain presets of libairspy: LNA, mixer and VGA set together
VGA_AUTO = 5        # "auto" = LNA and mixer AGC; the VGA has no AGC, this is the default of airspy_rx
WATCH_S = 0.5       # how often read_async checks that the stream is still running


class _Transfer(ctypes.Structure):
    _fields_ = [("device", ctypes.c_void_p), ("ctx", ctypes.c_void_p), ("samples", ctypes.c_void_p),
                ("sample_count", ctypes.c_int), ("dropped_samples", ctypes.c_uint64),
                ("sample_type", ctypes.c_int)]


_CALLBACK = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(_Transfer))
_lib = None


def load_lib():
    global _lib
    if _lib is None:
        if not os.path.exists(os.path.join(AIRSPY_BIN, "airspy.dll")):
            raise RuntimeError("airspy.dll not found (put it into lib/ or install PothosSDR)")
        os.add_dll_directory(AIRSPY_BIN)
        lib = ctypes.CDLL(os.path.join(AIRSPY_BIN, "airspy.dll"))
        dev = ctypes.c_void_p
        lib.airspy_error_name.restype = ctypes.c_char_p
        lib.airspy_error_name.argtypes = [ctypes.c_int]
        lib.airspy_list_devices.argtypes = [ctypes.POINTER(ctypes.c_uint64), ctypes.c_int]
        lib.airspy_open_sn.argtypes = [ctypes.POINTER(dev), ctypes.c_uint64]
        lib.airspy_open.argtypes = [ctypes.POINTER(dev)]
        lib.airspy_start_rx.argtypes = [dev, _CALLBACK, ctypes.c_void_p]
        lib.airspy_set_sample_type.argtypes = [dev, ctypes.c_int]
        lib.airspy_set_samplerate.argtypes = [dev, ctypes.c_uint32]
        lib.airspy_set_freq.argtypes = [dev, ctypes.c_uint32]
        for name in ("airspy_set_lna_agc", "airspy_set_mixer_agc", "airspy_set_vga_gain",
                     "airspy_set_linearity_gain", "airspy_set_rf_bias"):
            getattr(lib, name).argtypes = [dev, ctypes.c_uint8]
        for name in ("airspy_close", "airspy_stop_rx", "airspy_is_streaming"):
            getattr(lib, name).argtypes = [dev]
        _lib = lib
    return _lib


def list_devices():
    """[{index, serial, name}] of the connected devices."""
    serials = (ctypes.c_uint64 * MAX_DEVICES)()
    n = load_lib().airspy_list_devices(serials, MAX_DEVICES)
    return [{"index": i, "serial": f"{serials[i]:016X}", "name": "Airspy"} for i in range(max(n, 0))]


class AirspySdr:
    """Thin wrapper over airspy.dll, the methods match RtlSdr."""

    gains = list(range(GAIN_MAX + 1))
    gain_db_per_unit = 2.0   # AGC+: a linearity preset step is roughly 2 dB
    has_bias_tee = True
    has_rtl_agc = False

    def __init__(self, block, serial=None, index=0):
        self.lib = lib = load_lib()
        self.block = block
        self.dev = ctypes.c_void_p()
        if serial:
            rc = lib.airspy_open_sn(ctypes.byref(self.dev), int(serial, 16))
        else:
            devices = list_devices()
            if index >= len(devices):
                raise RuntimeError(f"Airspy {index} not found (connected: {len(devices)})")
            rc = lib.airspy_open_sn(ctypes.byref(self.dev), int(devices[index]["serial"], 16))
        self.dev = self.dev if rc == 0 else None
        self._check(rc, f"opening Airspy {serial or index}")
        self.rate = None
        self.freq = None
        self.ppm = 0
        self.lost = 0      # samples dropped between the USB and the conversion in libairspy
        self._stop = threading.Event()
        self._cb = None
        try:
            self._check(lib.airspy_set_sample_type(self.dev, SAMPLE_FLOAT32_IQ), "sample type")
        except Exception:
            self.close()
            raise

    def set_sample_rate(self, rate):
        if self.rate != int(rate):
            self._check(self.lib.airspy_set_samplerate(self.dev, int(rate)), f"sample rate {int(rate)}")
            self.rate = int(rate)

    def set_center_freq(self, hz):
        # The receiver sends the centre on every tuning step, even if it does not change.
        if self.freq != float(hz):
            self.freq = float(hz)
            self._tune()

    def _tune(self):
        # libairspy has no ppm correction: we shift the tuner by the oscillator error, as on the LimeSDR.
        self._check(self.lib.airspy_set_freq(self.dev, int(round(self.freq * (1 + self.ppm * 1e-6)))), "frequency")

    def set_gain(self, gain):
        if gain in ("auto", "", None):
            self._check(self.lib.airspy_set_lna_agc(self.dev, 1), "LNA AGC")
            self._check(self.lib.airspy_set_mixer_agc(self.dev, 1), "mixer AGC")
            self._check(self.lib.airspy_set_vga_gain(self.dev, VGA_AUTO), "VGA gain")
        else:   # this preset also turns both AGCs off
            g = max(0, min(GAIN_MAX, int(round(float(gain)))))
            self._check(self.lib.airspy_set_linearity_gain(self.dev, g), "gain")

    def set_bias_tee(self, on):
        self._check(self.lib.airspy_set_rf_bias(self.dev, 1 if on else 0), "bias-tee")

    def set_rtl_agc(self, on):
        pass  # digital AGC exists only in the RTL2832

    def set_ppm(self, ppm):
        self.ppm = int(ppm)
        if self.freq is not None:
            self._tune()

    def reset_buffer(self):
        pass  # libairspy starts with empty buffers in airspy_start_rx

    def read_async(self, on_block):
        """Blocks until cancel_async is called; sends blocks of self.block samples.
        libairspy calls back with its own block length from its own thread."""
        buf = np.empty(self.block, np.complex64)
        fill = 0

        def cb(transfer):
            nonlocal buf, fill
            t = transfer.contents
            self.lost += t.dropped_samples
            # with an IQ sample type sample_count is in complex samples; the buffer is reused after the return
            src = np.ctypeslib.as_array(ctypes.cast(t.samples, ctypes.POINTER(ctypes.c_float)), (t.sample_count * 2,))
            src = src.view(np.complex64)
            pos = 0
            while pos < len(src):
                n = min(self.block - fill, len(src) - pos)
                buf[fill:fill + n] = src[pos:pos + n]
                fill += n
                pos += n
                if fill == self.block:
                    on_block(buf)
                    buf = np.empty(self.block, np.complex64)
                    fill = 0
            return 0

        self._cb = _CALLBACK(cb)  # the reference must live while reading runs
        self._stop.clear()
        self._check(self.lib.airspy_start_rx(self.dev, self._cb, None), "starting the stream")
        try:
            while not self._stop.wait(WATCH_S):
                if self.lib.airspy_is_streaming(self.dev) != AIRSPY_TRUE:
                    raise RuntimeError("Airspy stopped streaming")
        finally:
            self.lib.airspy_stop_rx(self.dev)

    def cancel_async(self):
        self._stop.set()

    def close(self):
        if self.dev:
            self.lib.airspy_close(self.dev)
            self.dev = None

    def _check(self, rc, what):
        if rc != 0:
            raise RuntimeError(f"{what} failed: {(self.lib.airspy_error_name(rc) or b'').decode()} ({rc})")
