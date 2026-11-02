"""LimeSDR (cez LimeSuite.dll z PothosSDR a ctypes) s rovnakým rozhraním ako RtlSdr v sdr.py.

Príjem: RX kanál 0; read_async posiela bloky už ako komplexné vzorky complex64 v rozsahu ±1.
Vysielanie: TX kanál 0 sa zapína len počas PTT (tx_start/tx_stop); zatiaľ nemodulovaná nosná.
"""
import ctypes
import os
import threading

import numpy as np

# LimeSuite.dll: najprv z priečinka lib (pribalená v inštalačke), inak z nainštalovaného PothosSDR
_LIB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib")
LIME_BIN = _LIB if os.path.exists(os.path.join(_LIB, "LimeSuite.dll")) else r"C:\Program Files\PothosSDR\bin"
RX = False
TX = True
FMT_F32 = 0
TX_GAIN = 0.6       # normalizovaný zisk TX 0..1 pre prvé skúšky (nie plný výkon)
TX_LEVEL = 0.7      # amplitúda vzoriek nosnej (rezerva pred orezaním DAC)
GAIN_MAX = 73
GAIN_AUTO = 50  # Lime nemá AGC tunera; „auto“ = rozumný stredný zisk
LO_MIN_HZ = 30e6  # pod touto frekvenciou LimeSuite ladí cez NCO (LO ostáva na 30 MHz)
# S-meter: Lime pri zisku 0 dB ukazuje o toľkoto menej než VFO A (RTL, zisk 22,9 dB) na rovnakom
# signáli zo splittera. Zmerané pri ziskoch 14–64 dB, údaj rastie so ziskom ~1 dB/dB.
# Meralo sa na KV cez up-konvertor; Lime je odvtedy na VHF anténe, na VHF to nie je overené.
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
    """FM modulátor: audio (float, ±1, vzorkovanie audio_rate) dookola -> komplexné vzorky pri fs.
    Audio sa na fs prevzorkuje lineárnou interpoláciou (má byť už obmedzené na ~3 kHz)."""

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
    """Tenký obal nad LimeSuite.dll, metódy zodpovedajú RtlSdr."""

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
            # Info reťazec obsahuje „serial=1D3C042ED93935“; podľa neho, nie podľa poradia.
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
        self.lost = 0      # vzorky stratené v LimeSuite/USB (medzery v časových značkách)
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
            self._tune()   # zmena vzorkovania v LimeSuite môže zmeniť nastavenie NCO

    def set_center_freq(self, hz):
        # Prijímač posiela stred pri každom kroku ladenia, aj keď sa nemení. RTL to nevadí, ale Lime
        # pri každom nastavení LO znova ladí PLL a v prúde vzoriek vznikne výpadok (praskanie).
        if self.freq == float(hz):
            return
        self.freq = float(hz)
        self._tune()

    def _tune(self):
        # Lime nemá korekciu ppm v hardvéri: posunieme LO o chybu oscilátora.
        self._check(self.lib.LMS_SetLOFrequency(self.dev, RX, 0, self.freq * (1 + self.ppm * 1e-6)), "frequency")
        self.retunes += 1
        self._set_lpf()

    def _set_lpf(self):
        """Analógový filter RX. Nad 30 MHz o niečo širší než zobrazené pásmo (LimeSuite pod 1,4 MHz
        nejde). Pod 30 MHz LimeSuite ladí LO na 30 MHz a zvyšok posúva NCO, takže filter musí
        prepustiť aj tento posun, inak KV signál odreže."""
        if self.rate is None or self.freq is None:
            return
        f = self.freq
        bw = max(self.rate * 1.2, 1.5e6) if f >= LO_MIN_HZ else 2 * (LO_MIN_HZ - f) + 2 * self.rate
        # Kalibrácia filtra trvá; pri ladení po kúskoch ho nastavíme len pri väčšej zmene.
        if self.lpf and abs(bw - self.lpf) < 0.1 * self.lpf and self.lpf_hf == (f < LO_MIN_HZ):
            return
        self._check(self.lib.LMS_SetLPFBW(self.dev, RX, 0, bw), "RX filter")
        self.lpf, self.lpf_hf = bw, f < LO_MIN_HZ

    def set_gain(self, gain):
        g = GAIN_AUTO if gain in ("auto", "", None) else int(round(float(gain)))
        g = max(0, min(GAIN_MAX, g))
        self._check(self.lib.LMS_SetGaindB(self.dev, RX, 0, g), "gain")
        # Korekcia S-metra a squelchu: údaj nezávisí od zisku a zhoduje sa s VFO A.
        self.smeter_offset = SMETER_REF_DB - g

    def set_bias_tee(self, on):
        pass  # LimeSDR Mini nemá bias-tee

    def set_rtl_agc(self, on):
        pass  # digitálne AGC je len v RTL2832

    def set_ppm(self, ppm):
        self.ppm = int(ppm)
        if self.freq is not None:
            self._tune()

    def calibrate(self):
        """Kalibrácia DC a IQ nerovnováhy RX; na nízkych frekvenciách môže zlyhať, nie je povinná."""
        ok = self.lib.LMS_Calibrate(self.dev, RX, 0, max(self.rate or 0, 2.5e6), 0) == 0
        self.lpf = None
        self._set_lpf()   # kalibrácia mení nastavenie analógového filtra
        return ok

    def reset_buffer(self):
        pass  # stream sa zakladá nanovo v read_async

    def read_async(self, on_block):
        """Blokuje, kým sa nezavolá cancel_async; posiela bloky po self.block vzoriek."""
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

    # ---------- vysielanie ----------

    def tx_start(self, hz, gain=TX_GAIN, fm=None):
        """Zapne TX kanál na frekvencii hz a vysiela, kým sa nezavolá tx_stop: FM z audia
        fm = (audio, audio_rate, zdvih_hz), inak nemodulovanú nosnú."""
        with self._tx_lock:
            if self.tx_on:
                return self.tx_info
            lib = self.lib
            try:
                self._check(lib.LMS_EnableChannel(self.dev, TX, 0, True), "enabling TX")
                ant = self._tx_antenna(hz)
                self._check(lib.LMS_SetLOFrequency(self.dev, TX, 0, hz * (1 + self.ppm * 1e-6)), "TX frequency")
                lib.LMS_SetLPFBW(self.dev, TX, 0, 10e6)   # nepovinné; niektoré verzie majú iné minimum
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
        """Mini má dve TX cesty: BAND1 (vyššie pásma) a BAND2 (do ~2 GHz). Vyberieme podľa frekvencie."""
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
        buf = np.full(self.block, TX_LEVEL, np.complex64)   # DC v basebande = nosná presne na LO
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
            lib.LMS_EnableChannel(self.dev, TX, 0, False)   # vypnutý TX = žiadny únik LO do antény

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
