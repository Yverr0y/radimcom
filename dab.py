"""DAB / DAB+ digital radio: raw dongle samples -> welle-cli.exe (lib\\dab\\) -> services, DLS, slides, MP3 audio.

The demodulation and audio decoding (OFDM, FIC, Viterbi, Reed-Solomon, AAC / MP2) is done by welle-cli,
the command line part of welle.io (Albrecht Lohofener and contributors, GPLv2+, https://github.com/AlbrechtL/welle.io).
It runs as a separate process. The dongle stays in RADIMCOM: welle-cli connects to a small rtl_tcp server here
(127.0.0.1, free port) and gets the raw I/Q bytes of this VFO, exactly like from a network dongle.

    receiver thread --raw u8 I/Q--> queue --> rtl_tcp socket --> welle-cli  (-F rtl_tcp,127.0.0.1:PORT)
    welle-cli --"tune to f" command (rtl_tcp 0x01)--> on_tune(f) --> the VFO goes to f at 2.048 MS/s
    welle-cli web server (127.0.0.1:WEB) --/mux.json, /mp3/SID, /slide/SID--> app.py proxies them to the browser

The rtl_tcp header says "unknown tuner", so welle-cli does not run its own gain control: gain stays the VFO's.
"""
import collections
import json
import os
import queue
import socket
import struct
import subprocess
import threading
import time
import urllib.error
import urllib.request

import numpy as np

from paths import BASE

EXE = os.path.join(BASE, "lib", "dab", "welle-cli.exe")
DAB_RATE = 2048000            # DAB mode I: 2.048 MS/s, the only rate welle-cli works with
DAB_DEFAULT = "12C"
# Band III channels (ETSI EN 300 401), centre frequencies in Hz - the same names welle-cli uses.
DAB_CHANNELS = [(n, k * 1000) for n, k in (
    ("5A", 174928), ("5B", 176640), ("5C", 178352), ("5D", 180064),
    ("6A", 181936), ("6B", 183648), ("6C", 185360), ("6D", 187072),
    ("7A", 188928), ("7B", 190640), ("7C", 192352), ("7D", 194064),
    ("8A", 195936), ("8B", 197648), ("8C", 199360), ("8D", 201072),
    ("9A", 202928), ("9B", 204640), ("9C", 206352), ("9D", 208064),
    ("10A", 209936), ("10N", 210096), ("10B", 211648), ("10C", 213360), ("10D", 215072),
    ("11A", 216928), ("11N", 217088), ("11B", 218640), ("11C", 220352), ("11D", 222064),
    ("12A", 223936), ("12N", 224096), ("12B", 225648), ("12C", 227360), ("12D", 229072),
    ("13A", 230784), ("13B", 232496), ("13C", 234208), ("13D", 235776), ("13E", 237488), ("13F", 239200))]
CHANNEL_HZ = dict(DAB_CHANNELS)
TCP_QUEUE = 64                # raw blocks waiting for welle-cli (~2 s); more = welle-cli is stuck, drop


def channel_of(hz):
    return next((n for n, f in DAB_CHANNELS if abs(f - hz) < 1000), None)


def _free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


class DabDecoder:
    def __init__(self, on_tune, on_state):
        self.on_tune = on_tune        # on_tune(hz): welle-cli wants the dongle at hz (2.048 MS/s)
        self.on_state = on_state
        self.enabled = False
        self.error = None
        self.channel = DAB_DEFAULT
        self.want_hz = None           # frequency welle-cli asked for
        self.on_channel = False       # the dongle really is at want_hz and 2.048 MS/s
        self.dropped = 0
        self.lock = threading.Lock()
        self.proc = None
        self.web_port = None
        self.srv = None               # rtl_tcp listening socket
        self.conn = None              # welle-cli connection
        self.q = queue.Queue(maxsize=TCP_QUEUE)
        self.log = collections.deque(maxlen=30)    # last lines welle-cli printed (for errors)

    # ---------- control ----------

    def set_enabled(self, on, channel=None):
        with self.lock:
            if channel in CHANNEL_HZ:
                self.channel = channel
            self.enabled = bool(on)
            self._stop()
            self.error = None
            if self.enabled:
                self._start()
        self._emit_state()

    def set_channel(self, channel):
        """Another ensemble: welle-cli retunes itself (and asks for the new frequency through rtl_tcp)."""
        if channel not in CHANNEL_HZ:
            raise ValueError("unknown DAB channel")
        self.channel = channel
        if not self.enabled:
            return
        self.on_tune(CHANNEL_HZ[channel])
        try:
            self._web("/channel", data=channel.encode(), timeout=3).close()
        except OSError:
            with self.lock:                  # welle-cli not answering: start it again on the new channel
                self._stop()
                self._start()
        self._emit_state()

    def info(self):
        return {"enabled": self.enabled, "error": self.error, "channel": self.channel,
                "freq_hz": CHANNEL_HZ.get(self.channel), "connected": self.conn is not None,
                "on_channel": self.on_channel, "dropped": self.dropped}

    # ---------- samples from the receiver thread ----------

    def feed_raw(self, raw, fs, center_hz, lo=0.0):
        """raw: uint8 I/Q from an RTL dongle (complex64 from LimeSDR is converted); fs and centre of the dongle."""
        if not self.enabled or self.conn is None:
            return
        ok = int(fs) == DAB_RATE and not lo and self.want_hz is not None and abs(center_hz - self.want_hz) < 1
        if ok != self.on_channel:
            self.on_channel = ok
            self._emit_state()
        if not ok:
            return                   # retuning: welle-cli waits for the right samples
        if raw.dtype != np.uint8:
            raw = np.clip(raw.view(np.float32) * 127.5 + 127.5, 0, 255).astype(np.uint8)
        try:
            self.q.put_nowait(raw.tobytes())
        except queue.Full:
            self.dropped += 1

    # ---------- welle-cli process and the rtl_tcp server ----------

    def _start(self):
        if not os.path.exists(EXE):
            self.error = f"{EXE} is missing (see installer\\DAB.txt)"
            return
        try:
            self.srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.srv.bind(("127.0.0.1", 0))
            self.srv.listen(1)
            tcp_port = self.srv.getsockname()[1]
            self.web_port = _free_port()
        except OSError as e:
            self.error = f"cannot open a local port: {e}"
            return
        self.want_hz = CHANNEL_HZ[self.channel]
        self.on_tune(self.want_hz)           # the dongle goes there now, welle-cli confirms it after connecting
        self.q = queue.Queue(maxsize=TCP_QUEUE)
        threading.Thread(target=self._accept, args=(self.srv, self.q), name="dab-tcp", daemon=True).start()
        cmd = [EXE, "-F", f"rtl_tcp,127.0.0.1:{tcp_port}", "-c", self.channel, "-w", str(self.web_port), "-T"]
        try:
            self.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                         cwd=os.path.dirname(EXE), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except OSError as e:
            self.proc = None
            self.error = f"cannot start welle-cli: {e}"
            self._close_server()
            return
        threading.Thread(target=self._stderr, args=(self.proc,), name="dab-log", daemon=True).start()

    def _stop(self):
        p, self.proc = self.proc, None
        self._close_server()
        if p:
            try:
                p.terminate()
                p.wait(timeout=3)
            except (OSError, subprocess.TimeoutExpired):
                p.kill()
        self.on_channel = False

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
        while True:
            try:
                conn, _ = srv.accept()
            except OSError:
                return                       # server closed
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            # rtl_tcp header: magic, tuner type 0 (unknown -> no AGC in welle-cli), 0 gain steps
            try:
                conn.sendall(b"RTL0" + struct.pack(">II", 0, 0))
            except OSError:
                conn.close()
                continue
            while not q.empty():
                q.get_nowait()
            self.conn = conn
            self._emit_state()
            threading.Thread(target=self._commands, args=(conn,), name="dab-cmd", daemon=True).start()
            self._send(conn, q)
            if self.conn is conn:
                self.conn = None
                self._emit_state()

    def _send(self, conn, q):
        while True:
            data = q.get()
            if data is None or self.conn is not conn:
                return
            try:
                conn.sendall(data)
            except OSError:
                return

    def _commands(self, conn):
        """rtl_tcp commands from welle-cli: 5 bytes, command + 32-bit big endian parameter."""
        buf = b""
        while True:
            try:
                chunk = conn.recv(64)
            except OSError:
                return
            if not chunk:
                return
            buf += chunk
            while len(buf) >= 5:
                cmd, param = buf[0], struct.unpack(">I", buf[1:5])[0]
                buf = buf[5:]
                if cmd == 0x01 and param:                     # centre frequency
                    self.want_hz = param
                    self.channel = channel_of(param) or self.channel
                    self.on_tune(param)
                    self._emit_state()
                elif cmd == 0x02 and param != DAB_RATE:       # sample rate
                    self.error = f"welle-cli asks for {param} S/s"
                    self._emit_state()
                # gain, AGC, ppm…: the VFO's own settings stay

    def _stderr(self, p):
        for line in p.stderr:
            self.log.append(line.decode("utf-8", "replace").rstrip())
        if self.proc is p and self.enabled:
            last = next((x for x in reversed(self.log) if x), "")
            self.error = f"welle-cli ended (code {p.poll()})" + (f": {last}" if last else "")
            self.proc = None
            self._close_server()
            self._emit_state()

    # ---------- welle-cli web server (proxied by app.py) ----------

    def _web(self, path, data=None, timeout=3):
        if not self.proc or not self.web_port:
            raise OSError("DAB is off")
        req = urllib.request.Request(f"http://127.0.0.1:{self.web_port}{path}", data=data,
                                     method="POST" if data is not None else "GET")
        return urllib.request.urlopen(req, timeout=timeout)

    def mux(self):
        """Ensemble, services, DLS and signal from welle-cli's mux.json, in a smaller form for the web page."""
        out = dict(self.info(), ensemble="", services=[], snr=None, freq_corr=None, fic_errors=None, utc=None)
        if not self.proc:
            return out
        try:
            with self._web("/mux.json", timeout=2) as r:
                j = json.loads(r.read())
        except (OSError, ValueError):
            return out                       # still starting
        lab = lambda x: ((x or {}).get("label") or "").strip() if isinstance(x, dict) else str(x or "").strip()
        out["ensemble"] = lab((j.get("ensemble") or {}).get("label"))
        dem = j.get("demodulator") or {}
        out.update(snr=dem.get("snr"), freq_corr=dem.get("frequencycorrection"),
                   fic_errors=(dem.get("fic") or {}).get("numcrcerrors"))
        u = j.get("utctime") or {}
        if u.get("year"):
            out["utc"] = f"{u['year']:04d}-{u['month']:02d}-{u['day']:02d} {u['hour']:02d}:{u['minutes']:02d}"
        for s in j.get("services") or []:
            comp = next((c for c in s.get("components") or [] if c.get("transportmode") == "audio"), None)
            sub = (comp or {}).get("subchannel") or {}
            err = s.get("errorcounters") or {}
            out["services"].append({
                "sid": s.get("sid"), "label": lab(s.get("label")), "pty": s.get("ptystring") or "",
                "audio": bool(s.get("url_mp3")), "type": (comp or {}).get("ascty") or "",
                "bitrate": sub.get("bitrate"), "mode": s.get("mode") if s.get("samplerate") else "",
                "samplerate": s.get("samplerate") or 0,
                "dls": ((s.get("dls") or {}).get("label") or "").strip(),
                "mot_time": (s.get("mot") or {}).get("time") or 0,
                "errors": {k: err.get(k, 0) for k in ("frameerrors", "rserrors", "aacerrors")},
            })
        out["services"].sort(key=lambda x: (not x["audio"], x["label"].lower()))
        return out

    def slide(self, sid):
        """(bytes, content type) of the last slideshow picture of the service, or None."""
        try:
            with self._web(f"/slide/{sid}", timeout=3) as r:
                return r.read(), r.headers.get("Content-Type", "image/jpeg")
        except (OSError, urllib.error.HTTPError):
            return None

    def audio(self, sid):
        """MP3 stream of the service (welle-cli starts decoding it while somebody listens)."""
        r = self._web(f"/mp3/{sid}", timeout=10)

        def gen():
            try:
                while True:
                    chunk = r.read(4096)
                    if not chunk:
                        return
                    yield chunk
            except OSError:
                return
            finally:
                r.close()

        return gen()

    def _emit_state(self):
        self.on_state(self.info())
