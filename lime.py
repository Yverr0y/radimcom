"""LimeSDR (via LimeSuite.dll from PothosSDR and ctypes) with the same interface as RtlSdr in sdr.py.

Receive: RX channel 0; read_async sends blocks already as complex samples complex64 in the range ±1.
Transmit: TX channel 0 is turned on only during PTT (tx_start/tx_stop); FM from audio or an unmodulated carrier.
"""
import ctypes
import os
import threading

import numpy as np

# LimeSuite.dll: first from the lib folder (bundled in the installer), otherwise from the installed PothosSDR
_LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib")
LIME_BIN = _LIB if os.path.exists(os.path.join(_LIB, "LimeSuite.dll")) else r"C:\Program Files\PothosSDR\bin"
RX = False
TX = True
FMT_F32 = 0
TX_GAIN = 0.6       # normalised TX gain 0..1 for first tests (not full power)
TX_LEVEL = 0.7      # amplitude of the carrier samples (headroom before DAC clipping)
GAIN_MAX = 73
GAIN_AUTO = 50  # Lime has no tuner AGC; "auto" = a reasonable middle gain
LO_MIN_HZ = 30e6  # below this frequency LimeSuite tunes via the NCO (the LO stays at 30 MHz)
# S-meter: at 0 dB gain the Lime shows this much less than VFO A (RTL, gain 22.9 dB) on the same
# signal from a splitter. Measured at gains of 14–64 dB, the reading rises with gain by ~1 dB/dB.
# Measured on HF through an upconverter; the Lime has since been on a VHF antenna, on VHF this is not verified.
SMETER_REF_DB = 52.0


class _Stream(ctypes.Structure):
    _fields_ = [("handle", ctypes.c_size_t), ("isTx", ctypes.c_bool), ("channel", ctypes.c_uint32),
                ("fifoSize", ctypes.c_uint32), ("throughputVsLatency", ctypes.c_float),
                ("dataFmt", ctypes.c_int), ("linkFmt", ctypes.c_int)]


class _Meta(ctypes.Structure):
    _fields_ = [("timestamp", ctypes.c_uint64), ("waitForTimestamp", ctypes.c_bool),
                ("flushPartialPacket", ctypes.c_bool)]


class _StreamStatus(ctypes.Structure):
    _fields_ = [("active", ctypes.c_bool), ("fifoFilledCount", ctypes.c_uint32), ("fifoSize", ctypes.c_uint32),
                ("underrun", ctypes.c_uint32), ("overrun", ctypes.c_uint32), ("droppedPackets", ctypes.c_uint32),
                ("sampleRate", ctypes.c_double), ("linkRate", ctypes.c_double), ("timestamp", ctypes.c_uint64)]


_lib = None


def load_lib():
    global _lib
    if _lib is None:
        if not os.path.exists(os.path.join(LIME_BIN, "LimeSuite.dll")):
            raise RuntimeError("LimeSuite.dll not found (put it into lib/ or install PothosSDR)")
        os.add_dll_directory(LIME_BIN)
        lib = ctypes.CDLL(os.path.join(LIME_BIN, "LimeSuite.dll"))
        lib.LMS_GetLastErrorMessage.restype = ctypes.c_char_p
        lib.LMS_SetSampleRate.argtypes = [ctypes.c_void_p, ctypes.c_double, ctypes.c_size_t]
        lib.LMS_SetLOFrequency.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_size_t, ctypes.c_double]
        lib.LMS_SetLPFBW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_size_t, ctypes.c_double]
        lib.LMS_SetGaindB.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_size_t, ctypes.c_uint]
        lib.LMS_Calibrate.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_size_t, ctypes.c_double, ctypes.c_uint]
        lib.LMS_RecvStream.argtypes = [ctypes.POINTER(_Stream), ctypes.c_void_p, ctypes.c_size_t,
                                       ctypes.POINTER(_Meta), ctypes.c_uint]
        lib.LMS_SendStream.argtypes = [ctypes.POINTER(_Stream), ctypes.c_void_p, ctypes.c_size_t,
                                       ctypes.POINTER(_Meta), ctypes.c_uint]
        lib.LMS_SetNormalizedGain.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_size_t, ctypes.c_double]
        lib.LMS_GetGaindB.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_size_t, ctypes.POINTER(ctypes.c_uint)]
        lib.LMS_GetAntennaList.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_size_t, ctypes.c_void_p]
        lib.LMS_SetAntenna.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_size_t, ctypes.c_size_t]
        lib.LMS_GetAntenna.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_size_t]
        _lib = lib
    return _lib


def list_devices():
    lib = load_lib()
    infos = (ctypes.c_char * 256 * 8)()
    n = lib.LMS_GetDeviceList(infos)
    return [{"index": i, "name": infos[i].value.decode(errors="replace")} for i in range(max(n, 0))]


class FmSource:
    """FM modulator: audio (float, ±1, sample rate audio_rate) in a loop -> complex samples at fs.
    The audio is resampled to fs by linear interpolation (it should already be limited to ~3 kHz)."""

    def __init__(self, audio, audio_rate, fs, dev_hz):
        self.audio = np.asarray(audio, np.float64)
        self.idx = np.arange(len(self.audio))
        self.step = audio_rate / fs
        self.k = 2 * np.pi * dev_hz / fs
        self.pos = 0.0
        self.phase = 0.0

    def next(self, n):
        pos = (self.pos + np.arange(n) * self.step) % (len(self.audio) - 1)
        a = np.interp(pos, self.idx, self.audio)
        ph = self.phase + np.cumsum(a) * self.k
        self.pos = (pos[-1] + self.step) % (len(self.audio) - 1)
        self.phase = float(ph[-1] % (2 * np.pi))
        return (TX_LEVEL * np.exp(1j * ph)).astype(np.complex64)


class LimeSdr:
    """Thin wrapper over LimeSuite.dll, the methods match RtlSdr."""

    gains = list(range(GAIN_MAX + 1))
    has_bias_tee = False
    has_rtl_agc = False

    def __init__(self, block, serial=None, index=0):
        self.lib = lib = load_lib()
        self.block = block
        infos = (ctypes.c_char * 256 * 8)()
        n = max(lib.LMS_GetDeviceList(infos), 0)
        names = [infos[i].value.decode(errors="replace") for i in range(n)]
        if serial:
            # The info string contains "serial=<serial number>"; open by it, not by the order.
            index = next((i for i, s in enumerate(names) if f"serial={serial}".lower() in s.lower()), -1)
            if index < 0:
                raise RuntimeError(f"LimeSDR {serial} not found (connected: {n})")
        elif index >= n:
            raise RuntimeError(f"LimeSDR {index} not found (connected: {n})")
        self.name = names[index]
        self.dev = ctypes.c_void_p()
        self._check(lib.LMS_Open(ctypes.byref(self.dev), infos[index], None), "opening LimeSDR")
        self.stream = None
        self.rate = None
        self.freq = None
        self.lpf, self.lpf_hf = None, None
        self.retunes = 0
        self.lost = 0      # samples lost in LimeSuite/USB (gaps in the timestamps)
        self.gaps = 0
        self.ppm = 0
        self._stop = threading.Event()
        self.tx_on = False
        self.tx_info = None
        self._tx_stream = None
        self._tx_thread = None
        self._tx_lock = threading.Lock()
        try:
            self._check(lib.LMS_Init(self.dev), "init")
            self._check(lib.LMS_EnableChannel(self.dev, RX, 0, True), "enabling RX")
        except Exception:
            self.close()
            raise

    def set_sample_rate(self, rate):
        self.rate = float(rate)
        self._check(self.lib.LMS_SetSampleRate(self.dev, self.rate, 0), "sample rate")
        self.lpf = None
        if self.freq is not None:
            self._tune()   # changing the sample rate in LimeSuite may change the NCO setting

    def set_center_freq(self, hz):
        # The receiver sends the centre on every tuning step, even if it does not change. RTL does not mind, but the Lime
        # retunes the PLL on every LO setting and the sample stream gets a gap (crackling).
        if self.freq == float(hz):
            return
        self.freq = float(hz)
        self._tune()

    def _tune(self):
        # The Lime has no ppm correction in hardware: we shift the LO by the oscillator error.
        self._check(self.lib.LMS_SetLOFrequency(self.dev, RX, 0, self.freq * (1 + self.ppm * 1e-6)), "frequency")
        self.retunes += 1
        self._set_lpf()

    def _set_lpf(self):
        """Analogue RX filter. Above 30 MHz a bit wider than the displayed band (LimeSuite does not go below
        1.4 MHz). Below 30 MHz LimeSuite tunes the LO to 30 MHz and the NCO shifts the rest, so the filter must
        also pass this shift, otherwise it cuts off the HF signal."""
        if self.rate is None or self.freq is None:
            return
        f = self.freq
        bw = max(self.rate * 1.2, 1.5e6) if f >= LO_MIN_HZ else 2 * (LO_MIN_HZ - f) + 2 * self.rate
        # Filter calibration takes time; when tuning in small steps it is set only on a larger change.
        if self.lpf and abs(bw - self.lpf) < 0.1 * self.lpf and self.lpf_hf == (f < LO_MIN_HZ):
            return
        self._check(self.lib.LMS_SetLPFBW(self.dev, RX, 0, bw), "RX filter")
        self.lpf, self.lpf_hf = bw, f < LO_MIN_HZ

    def set_gain(self, gain):
        g = GAIN_AUTO if gain in ("auto", "", None) else int(round(float(gain)))
        g = max(0, min(GAIN_MAX, g))
        self._check(self.lib.LMS_SetGaindB(self.dev, RX, 0, g), "gain")
        # Correction of the S-meter and squelch: the reading does not depend on gain and matches VFO A.
        self.smeter_offset = SMETER_REF_DB - g

    def set_bias_tee(self, on):
        pass  # LimeSDR Mini has no bias-tee

    def set_rtl_agc(self, on):
        pass  # digital AGC exists only in the RTL2832

    def set_ppm(self, ppm):
        self.ppm = int(ppm)
        if self.freq is not None:
            self._tune()

    def calibrate(self):
        """Calibration of the RX DC and IQ imbalance; may fail at low frequencies, it is not mandatory."""
        ok = self.lib.LMS_Calibrate(self.dev, RX, 0, max(self.rate or 0, 2.5e6), 0) == 0
        self.lpf = None
        self._set_lpf()   # calibration changes the analogue filter setting
        return ok

    def reset_buffer(self):
        pass  # the stream is created anew in read_async

    def read_async(self, on_block):
        """Blocks until cancel_async is called; sends blocks of self.block samples."""
        lib = self.lib
        st = _Stream(isTx=RX, channel=0, fifoSize=self.block * 8, throughputVsLatency=0.5, dataFmt=FMT_F32)
        self._check(lib.LMS_SetupStream(self.dev, ctypes.byref(st)), "stream setup")
        self.stream = st
        self._stop.clear()
        meta = _Meta()
        expect = None
        try:
            self._check(lib.LMS_StartStream(ctypes.byref(st)), "stream start")
            while not self._stop.is_set():
                buf = np.empty(self.block, np.complex64)
                got = 0
                while got < self.block and not self._stop.is_set():
                    rc = lib.LMS_RecvStream(ctypes.byref(st), buf[got:].ctypes.data, self.block - got,
                                            ctypes.byref(meta), 1000)
                    if rc < 0:
                        raise RuntimeError(f"read failed: {self._err()}")
                    if rc and expect is not None and meta.timestamp != expect:
                        self.gaps += 1
                        self.lost += max(0, int(meta.timestamp) - int(expect))
                    if rc:
                        expect = meta.timestamp + rc
                    got += rc
                if got == self.block:
                    on_block(buf)
        finally:
            lib.LMS_StopStream(ctypes.byref(st))
            lib.LMS_DestroyStream(self.dev, ctypes.byref(st))
            self.stream = None

    def cancel_async(self):
        self._stop.set()

    def stream_status(self):
        st = self.stream
        if st is None:
            return None
        s = _StreamStatus()
        self.lib.LMS_GetStreamStatus(ctypes.byref(st), ctypes.byref(s))
        return {"overrun": s.overrun, "dropped": s.droppedPackets, "fifo": round(s.fifoFilledCount / max(s.fifoSize, 1), 3),
                "gaps": self.gaps, "lost": self.lost, "retunes": self.retunes,
                "rate": s.sampleRate, "link_mbs": round(s.linkRate / 1e6, 2)}

    # ---------- transmitting ----------

    def tx_start(self, hz, gain=TX_GAIN, fm=None):
        """Turns on the TX channel at frequency hz and transmits until tx_stop is called: FM from audio
        fm = (audio, audio_rate, deviation_hz), otherwise an unmodulated carrier."""
        with self._tx_lock:
            if self.tx_on:
                return self.tx_info
            lib = self.lib
            try:
                self._check(lib.LMS_EnableChannel(self.dev, TX, 0, True), "enabling TX")
                ant = self._tx_antenna(hz)
                self._check(lib.LMS_SetLOFrequency(self.dev, TX, 0, hz * (1 + self.ppm * 1e-6)), "TX frequency")
                lib.LMS_SetLPFBW(self.dev, TX, 0, 10e6)   # optional; some versions have a different minimum
                self._check(lib.LMS_SetNormalizedGain(self.dev, TX, 0, max(0.0, min(1.0, gain))), "TX gain")
                g = ctypes.c_uint()
                lib.LMS_GetGaindB(self.dev, TX, 0, ctypes.byref(g))
                st = _Stream(isTx=TX, channel=0, fifoSize=self.block * 8, throughputVsLatency=0.5, dataFmt=FMT_F32)
                self._check(lib.LMS_SetupStream(self.dev, ctypes.byref(st)), "TX stream setup")
                self._tx_stream = st
                self._check(lib.LMS_StartStream(ctypes.byref(st)), "TX stream start")
            except Exception:
                self._tx_teardown()
                raise
            src = FmSource(fm[0], fm[1], self.rate, fm[2]) if fm else None
            self.tx_on = True
            self.tx_info = {"freq": hz, "gain_norm": gain, "gain_db": g.value, "antenna": ant,
                            "mod": f"FM ±{fm[2] / 1e3:g} kHz" if fm else "carrier"}
            self._tx_thread = threading.Thread(target=self._tx_loop, args=(src,), name="lime-tx", daemon=True)
            self._tx_thread.start()
            return self.tx_info

    def _tx_antenna(self, hz):
        """The Mini has two TX paths: BAND1 (higher bands) and BAND2 (up to ~2 GHz). Chosen by frequency."""
        lib = self.lib
        n = lib.LMS_GetAntennaList(self.dev, TX, 0, None)
        names = (ctypes.c_char * 16 * max(n, 1))()
        lib.LMS_GetAntennaList(self.dev, TX, 0, ctypes.cast(names, ctypes.c_void_p))
        names = [names[i].value.decode(errors="replace") for i in range(max(n, 0))]
        want = "BAND2" if hz < 2e9 else "BAND1"
        if want in names:
            self._check(lib.LMS_SetAntenna(self.dev, TX, 0, names.index(want)), "TX antenna")
        i = lib.LMS_GetAntenna(self.dev, TX, 0)
        return names[i] if 0 <= i < len(names) else str(i)

    def _tx_loop(self, src):
        buf = np.full(self.block, TX_LEVEL, np.complex64)   # DC in the baseband = carrier exactly on the LO
        meta = _Meta()
        st = self._tx_stream
        while self.tx_on:
            if src:
                buf = src.next(self.block)
            if self.lib.LMS_SendStream(ctypes.byref(st), buf.ctypes.data, len(buf), ctypes.byref(meta), 1000) < 0:
                self.tx_info = dict(self.tx_info or {}, error=self._err())
                break

    def tx_stop(self):
        with self._tx_lock:
            self.tx_on = False
            if self._tx_thread:
                self._tx_thread.join(timeout=2)
                self._tx_thread = None
            self._tx_teardown()

    def _tx_teardown(self):
        lib = self.lib
        if self._tx_stream is not None:
            lib.LMS_StopStream(ctypes.byref(self._tx_stream))
            lib.LMS_DestroyStream(self.dev, ctypes.byref(self._tx_stream))
            self._tx_stream = None
        if self.dev:
            lib.LMS_SetNormalizedGain(self.dev, TX, 0, 0.0)
            lib.LMS_EnableChannel(self.dev, TX, 0, False)   # TX off = no LO leakage into the antenna

    def close(self):
        if self.tx_on or self._tx_stream is not None:
            self.tx_stop()
        if self.dev:
            self.lib.LMS_Close(self.dev)
            self.dev = None

    def _err(self):
        return (self.lib.LMS_GetLastErrorMessage() or b"").decode(errors="replace")

    def _check(self, rc, what):
        if rc != 0:
            raise RuntimeError(f"setting {what} failed: {self._err()}")
