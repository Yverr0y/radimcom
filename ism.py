"""ISM decoder: 433 / 868 MHz devices (weather sensors, remote controls, tyre sensors...) with rtl_433 (lib\\ism\\rtl_433.exe).

rtl_433 (Benjamin Larsson and contributors, GPLv2+, https://github.com/merbanan/rtl_433) runs as a separate process,
one per VFO. The dongle stays in RADIMCOM: rtl_433 connects to a small rtl_tcp server here (127.0.0.1, free port) and
gets the raw I/Q bytes of this VFO, exactly like from a network dongle. Reading the samples from standard input is not
an option on Windows: rtl_433 leaves its stdin in text mode there, so the byte 0x1A would end the stream.

    receiver thread --raw u8 I/Q--> queue --> rtl_tcp socket --> rtl_433 --stdout JSON--> card, daily log

Its commands (frequency, gain...) are ignored: the VFO decides where the dongle is, gain included. rtl_433 is told the
frequency only because it chooses the FSK detector by it and reports it; a smaller retune needs no restart.

Channels: rtl_433 does not filter, it finds pulses in the envelope of everything it gets. Given the whole 2 MHz, the noise
of the whole band and all transmitters in it merge into long "packages", and of those at most one device is decoded. So the
2.048 MS/s of the dongle are cut here into narrow channels of 256 kS/s (mixed down, low-pass filtered, decimated by 8),
each with its own rtl_433: 433.92 MHz (most devices) and 433.42 MHz (Somfy and others), 868.30 MHz. Measured on a 5 min
recording at 433.92 MHz: 107 messages in the whole band, 236 in the 256 kS/s channel, and rtl_433 needs 6x less CPU.
The filtering runs in the thread that sends the samples of each channel, not in the receiver thread.

RAW: with the RAW option rtl_433 also runs its pulse analyzer (-A); a package of at least RAW_MIN_PULSES pulses that no
decoder read is shown as a RAW row (modulation guess, pulses, length, level, a pulse view link at triq.org).
"""
import collections
import json
import os
import queue
import re
import socket
import struct
import subprocess
import threading
import time

import numpy as np

from paths import BASE

EXE = os.path.join(BASE, "lib", "ism", "rtl_433.exe")
# A rate rtl_433 lists as valid. It covers all of 433.05-434.79 MHz, and the spectrum is twice as fast as at 1.024 MS/s
# (one waterfall line per block of samples, so the speed of the picture follows the sample rate).
ISM_RATE = 2048000
# middle of the 433.05-434.79 MHz band; middle of the 868.0-868.6 MHz sub-band
ISM_FREQS = (433920000, 868300000)
ISM_DEFAULT = ISM_FREQS[0]
CH_RATE = 256000              # sample rate of a channel for rtl_433
CH_TAPS = 129                 # low-pass of a channel: (taps - 1) must be a multiple of the decimation (8 at 2.048 MS/s)
CH_CUTOFF_HZ = 115000         # its -6 dB point
CH_GAIN = 1.0                 # the channel back to u8 bytes, same scale as the dongle (measured: clipping stays ~0.002 %)
# channels around each preset, as offsets from the centre of the dongle
CHANNELS = {433920000: (0, -500000), 868300000: (0,)}
RAW_MIN_PULSES = 20           # smaller undecoded packages are noise
RAW_WAIT_S = 1.5              # a RAW row waits this long for a decoded message of the same package (they come on stdout)
RESTART_HZ = 5000000          # a bigger retune restarts rtl_433 (its FSK detector depends on the frequency)
RESTART_WAIT_S = 2.0          # at least this long between two starts, if rtl_433 keeps ending
REPEAT_S = 2.0                # a device repeats its message: same text within this time = one row with a count
SAME_PACKET_S = 0.5           # two decoders reporting one packet (same level and frequency) come this close together
TCP_QUEUE = 64                # raw blocks waiting for rtl_433; more = it is stuck, drop
MAX_HISTORY = 300

# fields with their own column, or not worth showing
_COLUMNS = {"time", "model", "id", "channel", "mod", "freq", "freq1", "freq2", "rssi", "snr", "noise", "protocol", "mic"}
# field name -> unit; other fields are shown as name=value
# (rtl_433 runs with -C si, so °F, mph, inch... arrive converted)
_UNITS = {"temperature_C": " °C", "temperature_F": " °F", "humidity": " %", "moisture": " %", "pressure_hPa": " hPa",
          "pressure_kPa": " kPa", "pressure_PSI": " PSI", "wind_avg_km_h": " km/h", "wind_max_km_h": " km/h",
          "wind_avg_m_s": " m/s", "wind_max_m_s": " m/s", "wind_dir_deg": "°", "rain_mm": " mm", "uv": " UV",
          "rain_rate_mm_h": " mm/h", "light_lux": " lux", "battery_mV": " mV", "power_W": " W", "energy_kWh": " kWh"}
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
# pulse analyzer (stderr): one block per package
_AN_START = re.compile(r"^Detected (OOK|FSK) package")
_AN_COUNT = re.compile(r"^Total count:\s*(\d+),\s*width:\s*([\d.]+) ms")
_AN_LEVEL = re.compile(r"^RSSI:\s*(-?[\d.]+) dB SNR:\s*(-?[\d.]+) dB")
_AN_FREQ = re.compile(r"^Frequency offsets.*\(([+-][\d.]+) kHz")
_AN_GUESS = re.compile(r"^Guessing modulation:\s*(.*)")
_AN_VIEW = re.compile(r"^view at (https://triq\.org/\S+)")
_AN_FLEX = re.compile(r"^Use a flex decoder with (.*)")
# with -F log the analyzer's demodulation attempt prints one line on stdout, in the order of the stderr blocks
_AN_CODES = re.compile(r"Analyzer Device codes \[(.*)\]")
RAW_CODES_MAX = 160           # characters of the codes shown in a RAW row


def _clean(value):
    """Text from a radio message: control characters could break a line of the log."""
    return _CONTROL.sub(" ", str(value))


def _field(name, value):
    if name == "battery_ok":
        return f"Batt {'OK' if value else 'LOW'}"
    unit = _UNITS.get(name)
    return f"{_clean(value)}{unit}" if unit else f"{_clean(name)}={_clean(value)}"


def message_text(j):
    """All fields of a device message that have no column of their own, readable."""
    return " · ".join(_field(k, v) for k, v in j.items() if k not in _COLUMNS)


class Channel:
    """One rtl_433 with its rtl_tcp server, fed by a narrow channel cut from the dongle samples (or by all of them)."""

    def __init__(self, dec, fs, center_hz, offset_hz, raw):
        self.dec = dec
        self.offset = offset_hz
        self.fs_in = fs
        self.down = fs // CH_RATE if fs % CH_RATE == 0 and fs > CH_RATE else 1
        self.fs = fs // self.down
        self.start_hz = center_hz + offset_hz          # what rtl_433 is told
        self.raw = raw
        self.proc = self.srv = self.conn = None
        self.q = queue.Queue(maxsize=TCP_QUEUE)
        self.log = collections.deque(maxlen=10)       # last lines rtl_433 printed (for errors)
        self.decoded = collections.deque(maxlen=50)   # (time, rssi, snr) of decoded packages, to tell RAW ones apart
        self.pending = []                             # RAW candidates waiting RAW_WAIT_S
        self.attempts = 0                             # analyzer blocks with a demodulation attempt (stderr)
        self.n_codes = 0                              # their codes lines (stdout), in the same order
        self.codes = {}
        if self.down > 1:
            from scipy.signal import firwin
            n = CH_TAPS + (-(CH_TAPS - 1)) % self.down   # (taps - 1) a multiple of the decimation
            self.h = firwin(n, CH_CUTOFF_HZ, fs=fs, window=("kaiser", 7.0)).astype(np.float32)
            self.tail = np.zeros(n - 1, np.complex64)
            self.phase = 0.0
            self.lut = None
            self.w = -2 * np.pi * offset_hz / fs       # rad per input sample

    # ---------- the narrow channel ----------

    def channel(self, raw):
        """u8 I/Q of the dongle -> u8 I/Q of this channel (mixed to 0 Hz, filtered, decimated)."""
        if self.down == 1:
            return raw
        from scipy.signal import upfirdn
        x = raw.astype(np.float32)
        x -= 127.5
        x = x.view(np.complex64)
        if self.offset:
            if self.lut is None or self.lut.size != x.size:
                self.lut = np.exp(1j * self.w * np.arange(x.size)).astype(np.complex64)
            x = x * (self.lut * np.complex64(np.exp(1j * self.phase)))
            self.phase = (self.phase + self.w * x.size) % (2 * np.pi)
        xe = np.concatenate((self.tail, x))
        y = upfirdn(self.h, xe, down=self.down)
        # outputs whose filter window lies inside xe: index k*down with k*down >= len(h) - 1
        k0 = (self.h.size - 1) // self.down
        k1 = (xe.size - 1) // self.down
        y = y[k0:k1 + 1]
        self.tail = xe[(k1 + 1) * self.down - (self.h.size - 1):]
        out = np.empty(y.size * 2, np.float32)
        out[0::2] = y.real
        out[1::2] = y.imag
        out *= CH_GAIN
        out += 127.5
        np.clip(out, 0, 255, out=out)
        return out.astype(np.uint8).tobytes()

    # ---------- process and server ----------

    def command(self, port):
        cmd = [EXE, "-c", "0", "-d", f"rtl_tcp:127.0.0.1:{port}", "-f", str(int(self.start_hz)), "-s", str(self.fs),
               "-F", "json", "-F", "log", "-C", "si", "-M", "time:off", "-M", "level", "-M", "protocol"]
        return cmd + ["-A"] if self.raw else cmd

    def start(self):
        self.srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.srv.bind(("127.0.0.1", 0))
        self.srv.listen(1)
        port = self.srv.getsockname()[1]
        threading.Thread(target=self._accept, args=(self.srv, self.q), name="ism-tcp", daemon=True).start()
        self.proc = subprocess.Popen(self.command(port), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, cwd=os.path.dirname(EXE),
                                     creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        threading.Thread(target=self._reader, args=(self.proc,), name="ism-out", daemon=True).start()
        threading.Thread(target=self._stderr, args=(self.proc,), name="ism-log", daemon=True).start()

    def stop(self):
        p, self.proc = self.proc, None
        self.close_server()
        if p:
            try:
                p.terminate()
                p.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                p.kill()

    def close_server(self):
        srv, conn, self.srv, self.conn = self.srv, self.conn, None, None
        for s in (conn, srv):
            if s:
                try:
                    s.close()
                except OSError:
                    pass
        try:
            self.q.put_nowait(None)
        except queue.Full:
            pass

    def feed(self, raw):
        if self.conn is None:
            return
        try:
            self.q.put_nowait(raw)
        except queue.Full:
            self.dec.dropped += 1

    def _accept(self, srv, q):
        try:
            conn, _ = srv.accept()
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            conn.sendall(b"RTL0" + struct.pack(">II", 0, 0))     # rtl_tcp header: tuner 0 (unknown), 0 gain steps
        except OSError:
            return                           # server closed
        with self.dec.lock:
            if self.srv is not srv:          # stopped in the meantime
                conn.close()
                return
            self.conn = conn
        self.dec._emit_state()
        while True:
            data = q.get()
            if data is None or self.conn is not conn:
                return
            try:
                conn.sendall(self.channel(data))
            except OSError:
                return
            except Exception as e:           # a bug in the filter must not stop quietly
                self.log.append(f"channel: {e!r}")
                self.close_server()
                return

    def _reader(self, p):
        for line in p.stdout:
            if not line.startswith(b"{"):
                text = line.decode("utf-8", "replace").strip()
                m = _AN_CODES.search(text)
                if m:
                    self.codes[self.n_codes] = m.group(1)
                    self.n_codes += 1
                    while len(self.codes) > 200:
                        self.codes.pop(next(iter(self.codes)))
                elif text:
                    self.log.append(text)    # -F log: messages, warnings and errors of rtl_433
                continue
            try:
                j = json.loads(line)
                if isinstance(j, dict) and j.get("model"):
                    self.decoded.append((time.time(), j.get("rssi"), j.get("snr")))
                    self.dec._handle(j, self)
            except (ValueError, TypeError):
                continue                     # one odd line must not stop the decoder
        p.wait()
        self.dec._ended(self, p)

    def _stderr(self, p):
        block = None                         # the analyzer block being read
        for line in p.stderr:
            text = line.decode("utf-8", "replace").rstrip()
            if _AN_START.match(text):
                self._raw_block(block)
                block = {"mod": text.split()[1]}
                continue
            if block is None:
                if text.strip():
                    self.log.append(text.strip())
                continue
            if text.startswith("Attempting demodulation"):
                block["attempt"] = self.attempts    # its codes line on stdout has this number
                self.attempts += 1
            for key, rx in (("count", _AN_COUNT), ("level", _AN_LEVEL), ("foff", _AN_FREQ), ("guess", _AN_GUESS),
                            ("view", _AN_VIEW), ("flex", _AN_FLEX)):
                m = rx.match(text.strip())
                if m and key not in block:
                    block[key] = m.groups()
                    break
            if "flex" in block:              # the last line of a block
                self._raw_block(block)
                block = None
            self._raw_flush()
        self._raw_block(block)

    # ---------- RAW: packages no decoder read ----------

    def _raw_block(self, b):
        if not b or "count" not in b or int(b["count"][0]) < RAW_MIN_PULSES:
            return
        self.pending.append((time.time(), b))
        self._raw_flush()

    def _raw_flush(self):
        now = time.time()
        while self.pending and now - self.pending[0][0] >= RAW_WAIT_S:
            t, b = self.pending.pop(0)
            if self._was_decoded(t, b):
                continue
            self.dec._handle_raw(b, self)

    def _was_decoded(self, t, b):
        if "level" not in b:
            return False
        rssi, snr = float(b["level"][0]), float(b["level"][1])
        for td, r, s in list(self.decoded):
            if abs(td - t) < RAW_WAIT_S + 1 and r is not None and s is not None \
                    and abs(float(r) - rssi) < 0.06 and abs(float(s) - snr) < 0.06:
                return True
        return False


class IsmDecoder:
    def __init__(self, on_event, on_state):
        self.on_event = on_event      # on_event("ism", message)
        self.on_state = on_state
        self.enabled = False
        self.raw = False              # RAW rows for packages no decoder read (rtl_433 -A)
        self.error = None
        self.count = 0                # all messages, also repeated ones
        self.raw_count = 0
        self.dropped = 0
        self.fs = 0
        self.center_hz = 0.0          # where the dongle is now
        self.start_hz = 0.0           # where it was when the channels started
        self.next_id = 1
        self.history = collections.deque(maxlen=MAX_HISTORY)
        self.lock = threading.Lock()
        self.chans = []
        self.not_before = 0.0

    # ---------- control ----------

    def set_enabled(self, on):
        with self.lock:
            self.enabled = bool(on)
            self.error = None
            self.not_before = 0.0
            if not self.enabled:
                self._stop()
        self._emit_state()

    def set_raw(self, on):
        """RAW on / off: rtl_433 starts again with or without its pulse analyzer."""
        on = bool(on)
        if on == self.raw:
            return
        with self.lock:
            self.raw = on
            self._stop()                     # the next samples start the channels again
            self.not_before = 0.0
        self._emit_state()

    def info(self):
        return {"enabled": self.enabled, "error": self.error, "count": self.count, "dropped": self.dropped,
                "raw": self.raw, "raw_count": self.raw_count,
                "running": bool(self.chans) and all(c.conn is not None for c in self.chans),
                "channels": [round(c.start_hz) for c in self.chans]}

    def messages(self):
        with self.lock:
            return list(self.history)

    def clear(self):
        with self.lock:
            self.history.clear()
            self.count = self.raw_count = 0
        self._emit_state()

    # ---------- samples from the receiver thread ----------

    def feed_raw(self, raw, fs, center_hz):
        """raw: uint8 I/Q from an RTL dongle (the ISM key is not offered on LimeSDR); fs and centre of the dongle."""
        if not self.enabled or raw.dtype != np.uint8:
            return
        self.center_hz = center_hz
        if not self.chans or fs != self.fs or abs(center_hz - self.start_hz) > RESTART_HZ:
            if time.monotonic() < self.not_before:
                return
            with self.lock:
                if self.enabled:
                    self._start(int(fs), center_hz)
            self._emit_state()
        for c in self.chans:
            c.feed(raw)                      # the same array for all: it is only read

    # ---------- rtl_433 processes ----------

    def _offsets(self, fs, center_hz):
        if fs % CH_RATE or fs <= CH_RATE:
            return (0,)                      # cannot be cut into channels: rtl_433 gets the whole band, as before
        near = min(CHANNELS, key=lambda f: abs(f - center_hz))
        offs = CHANNELS[near] if abs(near - center_hz) < 1e6 else (0,)
        return tuple(o for o in offs if abs(o) + CH_RATE / 2 <= fs / 2) or (0,)

    def _start(self, fs, center_hz):
        self._stop()
        self.fs, self.start_hz = fs, center_hz
        self.not_before = time.monotonic() + RESTART_WAIT_S
        if not os.path.exists(EXE):
            self.error = f"{EXE} is missing"
            return
        chans = []
        try:
            for off in self._offsets(fs, center_hz):
                c = Channel(self, fs, center_hz, off, self.raw)
                chans.append(c)
                c.start()
        except (OSError, ImportError, ValueError) as e:
            for c in chans:
                c.stop()
            self.error = f"cannot start rtl_433: {e}"
            return
        self.chans = chans
        self.error = None

    def _stop(self):
        chans, self.chans = self.chans, []
        for c in chans:
            c.stop()

    def _ended(self, c, p):
        """rtl_433 of a channel ended by itself: all channels start again with the next samples."""
        with self.lock:
            if c not in self.chans or c.proc is not p or not self.enabled:
                return
            last = next((x for x in reversed(c.log) if x), "")
            self.error = f"rtl_433 ended (code {p.returncode}){': ' + last if last else ''}"
            self._stop()                     # the next samples start it again, after RESTART_WAIT_S
        self._emit_state()

    # ---------- messages ----------

    def _handle(self, j, ch):
        now = time.time()
        # rtl_433 knows the frequency its channel was started with; the dongle may have moved a little since
        shift = self.center_hz - self.start_hz
        mhz = j.get("freq") if j.get("freq") is not None else j.get("freq1")
        freq_hz = round(float(mhz) * 1e6 + shift) if isinstance(mhz, (int, float)) else round(ch.start_hz + shift)
        model = _clean(j["model"])
        dev_id = "" if j.get("id") is None else _clean(j["id"])
        channel = "" if j.get("channel") is None else _clean(j["channel"])
        text = message_text(j)
        pkt = [mhz, j.get("rssi"), j.get("snr")]     # equal for every decoder that read the same packet
        with self.lock:
            m = None
            for row in reversed(self.history):
                if now - row["last"] > REPEAT_S:
                    break
                if now - row["last"] < SAME_PACKET_S and pkt == row["pkt"] and j.get("rssi") is not None:
                    if model in row["models"]:
                        m = dict(row, again=True)         # the same packet again: nothing new
                    else:
                        row["models"].append(model)       # another decoder of rtl_433 read the same packet: one row
                        row["model"] = " / ".join(row["models"])
                        m = dict(row, again=True)
                    break
                if model in row["models"] and (row["dev_id"], row["channel"], row["text"]) == (dev_id, channel, text):
                    row["n"] += 1                         # the device repeats its message (maybe with another in between)
                    row["last"] = now
                    row["pkt"] = pkt
                    m = dict(row)
                    break
            if m is None:
                m = {"id": self.next_id, "time": round(now, 1), "last": now, "n": 1, "freq_hz": freq_hz, "model": model,
                     "models": [model], "pkt": pkt,
                     "dev_id": dev_id, "channel": channel, "text": text, "mod": _clean(j.get("mod", "")),
                     "rssi": j.get("rssi"), "snr": j.get("snr"), "protocol": j.get("protocol"), "mic": _clean(j.get("mic", ""))}
                self.next_id += 1
                self.history.append(m)
                m = dict(m)
            if not m.get("again"):
                self.count += 1
        self.on_event("ism", m)
        self._emit_state()

    def _handle_raw(self, b, ch):
        """A package of pulses no decoder read (pulse analyzer of rtl_433)."""
        now = time.time()
        pulses, width = int(b["count"][0]), float(b["count"][1])
        rssi, snr = (float(b["level"][0]), float(b["level"][1])) if "level" in b else (None, None)
        foff = float(b["foff"][0]) * 1e3 if "foff" in b else 0.0
        guess = _clean(b["guess"][0]) if "guess" in b else "?"
        parts = [guess, f"{pulses} pulses", f"{width:g} ms"]
        codes = ch.codes.get(b.get("attempt", -1), "")
        if codes:
            parts.append(_clean(codes if len(codes) <= RAW_CODES_MAX else codes[:RAW_CODES_MAX] + "…"))
        with self.lock:
            self.raw_count += 1
            m = {"id": self.next_id, "time": round(now, 1), "last": now, "n": 1,
                 "freq_hz": round(ch.start_hz + self.center_hz - self.start_hz + foff), "model": "RAW", "models": ["RAW"],
                 "pkt": None, "dev_id": "", "channel": "", "text": " · ".join(parts), "mod": b.get("mod", ""),
                 "rssi": rssi, "snr": snr, "protocol": None, "mic": "", "raw": True,
                 "view": b["view"][0] if "view" in b else "", "flex": _clean(b["flex"][0]) if "flex" in b else ""}
            self.next_id += 1
            self.history.append(m)
            m = dict(m)
        self.on_event("ism", m)
        self._emit_state()

    def _emit_state(self):
        self.on_state(self.info())
