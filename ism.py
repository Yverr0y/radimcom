"""ISM decoder: 433 / 868 MHz devices (weather sensors, remote controls, tyre sensors...) with rtl_433 (lib\\ism\\rtl_433.exe).

rtl_433 (Benjamin Larsson and contributors, GPLv2+, https://github.com/merbanan/rtl_433) runs as a separate process,
one per VFO. The dongle stays in RADIMCOM: rtl_433 connects to a small rtl_tcp server here (127.0.0.1, free port) and
gets the raw I/Q bytes of this VFO, exactly like from a network dongle. Reading the samples from standard input is not
an option on Windows: rtl_433 leaves its stdin in text mode there, so the byte 0x1A would end the stream.

    receiver thread --raw u8 I/Q--> queue --> rtl_tcp socket --> rtl_433 --stdout JSON--> card, daily log

Its commands (frequency, gain...) are ignored: the VFO decides where the dongle is, gain included. rtl_433 is told the
frequency only because it chooses the FSK detector by it and reports it; a smaller retune needs no restart.
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
RESTART_HZ = 5000000          # a bigger retune restarts rtl_433 (its FSK detector depends on the frequency)
RESTART_WAIT_S = 2.0          # at least this long between two starts, if rtl_433 keeps ending
REPEAT_S = 2.0                # a device repeats its message: same text within this time = one row with a count
TCP_QUEUE = 64                # raw blocks waiting for rtl_433; more = it is stuck, drop
MAX_HISTORY = 300

# fields with their own column, or not worth showing
_COLUMNS = {"time", "model", "id", "channel", "mod", "freq", "freq1", "freq2", "rssi", "snr", "noise", "protocol", "mic"}
# field name -> unit; other fields are shown as name=value
_UNITS = {"temperature_C": " °C", "temperature_F": " °F", "humidity": " %", "moisture": " %", "pressure_hPa": " hPa",
          "pressure_kPa": " kPa", "pressure_PSI": " PSI", "wind_avg_km_h": " km/h", "wind_max_km_h": " km/h",
          "wind_avg_m_s": " m/s", "wind_max_m_s": " m/s", "wind_dir_deg": "°", "rain_mm": " mm", "uv": " UV",
          "light_lux": " lux", "battery_mV": " mV", "power_W": " W", "energy_kWh": " kWh"}
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


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


class IsmDecoder:
    def __init__(self, on_event, on_state):
        self.on_event = on_event      # on_event("ism", message)
        self.on_state = on_state
        self.enabled = False
        self.error = None
        self.count = 0                # all messages, also repeated ones
        self.dropped = 0
        self.fs = 0
        self.center_hz = 0.0          # where the dongle is now
        self.start_hz = 0.0           # what rtl_433 was told
        self.next_id = 1
        self.history = collections.deque(maxlen=MAX_HISTORY)
        self.lock = threading.Lock()
        self.proc = None
        self.srv = None
        self.conn = None
        self.q = queue.Queue(maxsize=TCP_QUEUE)
        self.log = collections.deque(maxlen=10)    # last lines rtl_433 printed (for errors)
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

    def info(self):
        return {"enabled": self.enabled, "error": self.error, "count": self.count, "dropped": self.dropped,
                "running": self.conn is not None}

    def messages(self):
        with self.lock:
            return list(self.history)

    def clear(self):
        with self.lock:
            self.history.clear()
            self.count = 0
        self._emit_state()

    # ---------- samples from the receiver thread ----------

    def feed_raw(self, raw, fs, center_hz):
        """raw: uint8 I/Q from an RTL dongle (the ISM key is not offered on LimeSDR); fs and centre of the dongle."""
        if not self.enabled or raw.dtype != np.uint8:
            return
        self.center_hz = center_hz
        if self.proc is None or fs != self.fs or abs(center_hz - self.start_hz) > RESTART_HZ:
            if time.monotonic() < self.not_before:
                return
            with self.lock:
                if self.enabled:
                    self._start(int(fs), center_hz)
            self._emit_state()
        if self.conn is None:
            return
        try:
            self.q.put_nowait(raw.tobytes())
        except queue.Full:
            self.dropped += 1

    # ---------- rtl_433 process and the rtl_tcp server ----------

    def _command(self, port, fs, center_hz):
        return [EXE, "-c", "0", "-d", f"rtl_tcp:127.0.0.1:{port}", "-f", str(int(center_hz)), "-s", str(fs),
                "-F", "json", "-M", "time:off", "-M", "level", "-M", "protocol"]

    def _start(self, fs, center_hz):
        self._stop()
        self.fs, self.start_hz = fs, center_hz
        self.not_before = time.monotonic() + RESTART_WAIT_S
        if not os.path.exists(EXE):
            self.error = f"{EXE} is missing"
            return
        self.log.clear()
        self.q = queue.Queue(maxsize=TCP_QUEUE)
        try:
            self.srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.srv.bind(("127.0.0.1", 0))
            self.srv.listen(1)
            port = self.srv.getsockname()[1]
            threading.Thread(target=self._accept, args=(self.srv, self.q), name="ism-tcp", daemon=True).start()
            self.proc = subprocess.Popen(self._command(port, fs, center_hz), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                         stderr=subprocess.PIPE, cwd=os.path.dirname(EXE),
                                         creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except OSError as e:
            self.proc = None
            self.error = f"cannot start rtl_433: {e}"
            self._close_server()
            return
        self.error = None
        threading.Thread(target=self._reader, args=(self.proc,), name="ism-out", daemon=True).start()
        threading.Thread(target=self._stderr, args=(self.proc,), name="ism-log", daemon=True).start()

    def _stop(self):
        p, self.proc = self.proc, None
        self._close_server()
        if p:
            try:
                p.terminate()
                p.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                p.kill()

    def _close_server(self):
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

    def _accept(self, srv, q):
        try:
            conn, _ = srv.accept()
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            conn.sendall(b"RTL0" + struct.pack(">II", 0, 0))     # rtl_tcp header: tuner 0 (unknown), 0 gain steps
        except OSError:
            return                           # server closed
        with self.lock:
            if self.srv is not srv:          # stopped in the meantime
                conn.close()
                return
            self.conn = conn
        self._emit_state()
        while True:
            data = q.get()
            if data is None or self.conn is not conn:
                return
            try:
                conn.sendall(data)
            except OSError:
                return

    def _reader(self, p):
        for line in p.stdout:
            try:
                j = json.loads(line)
                if isinstance(j, dict) and j.get("model"):
                    self._handle(j)
            except (ValueError, TypeError):
                continue                     # one odd line must not stop the decoder
        p.wait()
        with self.lock:
            if self.proc is not p or not self.enabled:
                return
            last = next((x for x in reversed(self.log) if x), "")
            self.error = f"rtl_433 ended (code {p.returncode}){': ' + last if last else ''}"
            self.proc = None                 # the next samples start it again, after RESTART_WAIT_S
            self._close_server()
        self._emit_state()

    def _stderr(self, p):
        for line in p.stderr:
            self.log.append(line.decode("utf-8", "replace").strip())

    # ---------- messages ----------

    def _handle(self, j):
        now = time.time()
        # rtl_433 knows the frequency it was started with; the dongle may have moved a little since
        shift = self.center_hz - self.start_hz
        mhz = j.get("freq") if j.get("freq") is not None else j.get("freq1")
        freq_hz = round(float(mhz) * 1e6 + shift) if isinstance(mhz, (int, float)) else round(self.center_hz)
        model = _clean(j["model"])
        dev_id = "" if j.get("id") is None else _clean(j["id"])
        channel = "" if j.get("channel") is None else _clean(j["channel"])
        text = message_text(j)
        with self.lock:
            self.count += 1
            last = self.history[-1] if self.history else None
            if last and now - last["last"] < REPEAT_S and (last["model"], last["dev_id"], last["channel"], last["text"]) == (model, dev_id, channel, text):
                last["n"] += 1
                last["last"] = now
                m = dict(last)
            else:
                m = {"id": self.next_id, "time": round(now, 1), "last": now, "n": 1, "freq_hz": freq_hz, "model": model,
                     "dev_id": dev_id, "channel": channel, "text": text, "mod": _clean(j.get("mod", "")),
                     "rssi": j.get("rssi"), "snr": j.get("snr"), "protocol": j.get("protocol"), "mic": _clean(j.get("mic", ""))}
                self.next_id += 1
                self.history.append(m)
                m = dict(m)
        self.on_event("ism", m)
        self._emit_state()

    def _emit_state(self):
        self.on_state(self.info())
