"""DSD mode: digital voice (DMR, P25, D-Star, YSF, NXDN, dPMR, M17...) with DSD-FME (lib\\dsd-fme\\dsd-fme.exe).

DSD-FME (lwvmobile, https://github.com/lwvmobile/dsd-fme) runs as a separate process, one per VFO. It is not part of
the RADIMCOM package: its voice codec (mbelib, AMBE+2) may be covered by patents, so the user downloads it with
install_dsd.bat. Without it the mode stays silent and the card says how to install it.

    FM discriminator (before the squelch) --48 kHz S16--> TCP --> dsd-fme --UDP 8 kHz S16--> VFO audio
                                                                  dsd-fme --stderr--> CallTracker --> card, daily log

The TDMA protocols give stereo: left = slot 1, right = slot 2. Metadata comes from the text DSD-FME prints for people,
so an unknown line only means less information in the card; the audio does not depend on it.
No decryption: encrypted calls stay muted (DSD-FME does that without a key) and are marked ENC.
"""
import collections
import os
import queue
import re
import socket
import subprocess
import threading
import time

import numpy as np

from paths import BASE

EXE = os.path.join(BASE, "lib", "dsd-fme", "dsd-fme.exe")
NOT_INSTALLED = "DSD decoder is not installed: run install_dsd.bat in the RADIMCOM folder"
# protocol: (options, stereo). The automatic detection finds DMR, P25 phase 1 + 2, D-Star, YSF and X2-TDMA;
# the others have to be selected (they are marked as not auto-detectable in the DSD-FME help).
PROTOCOLS = {
    "auto": (["-fa"], True),
    "dmr": (["-fs"], True),
    "p25p1": (["-f1"], False),
    "p25p2": (["-f2", "-m2"], True),
    "dstar": (["-fd"], False),
    "ysf": (["-fy"], False),
    "nxdn48": (["-fi"], False),
    "nxdn96": (["-fn"], False),
    "dpmr": (["-fm"], False),
    "m17": (["-fz"], False),
    "x2tdma": (["-fx"], True),
    "provoice": (["-fp"], False),
}
SLOTS = {"both": "3", "1": "1", "2": "2"}   # -V: voice of which TDMA slot
INPUT_RATE = 48000
OUTPUT_RATE = 8000
INPUT_GAIN = 2.0              # FM demodulator: full scale = about 10 kHz deviation, DMR outer symbols are at 1.9 kHz
OUTPUT_LOWPASS_HZ = 3600.0    # removes the images of the 8 kHz voice after the linear interpolation
PREBUFFER_S = 0.15            # voice comes in bursts: buffered before playing, so that it does not stutter
OUTPUT_MAX_S = 1.0            # more than this waiting: the oldest is dropped (latency must not grow)
RESTART_S = 3.0               # pause before starting a stopped decoder again
HISTORY = 300                 # calls kept for the card
CALL_GAP_S = 1.5              # no voice for this long: the call has ended
SPLIT_AFTER_S = 2.0           # other IDs later than this in a call = a new call (earlier: the IDs were only late)
PENDING_S = 2.0               # link control (who is calling) arrives just before the voice
MIN_CALL_S = 0.5              # shorter, without IDs: false sync, not a call
PROTO_HOLD_S = 3.0            # how long the detected protocol is shown after the last sync

ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")
SYNC = re.compile(r"Sync: ?[+-](\S+)(.*)")
SLOT_MARK = re.compile(r"\[slot(\d)\]", re.I)
COLOR = re.compile(r"Color Code=(\d+)")
BURST = re.compile(r"\|\s*([A-Z][A-Z0-9]*)\*?\s*$")
DMR_LC = re.compile(r"SLOT (\d)\s+TGT=(\d+) SRC=(\d+)\s*(.*)")
ALIAS = re.compile(r"Slot (\d) - Talker Alias Block.*Talker Alias: (.*)")
# other protocols (best effort): P25 "TGT: 1; SRC: 2;", NXDN "Src=2 - Dst/TG=1", dPMR " TG=1" " Src=2", D-Star " DST: X"
OTHER_TGT = re.compile(r"(?:TGT: |Dst/TG=| TG=| DST: )([^\s;]+)")
OTHER_SRC = re.compile(r"(?:SRC: |Src=)([^\s;]+)")
OTHER_ENC = re.compile(r"\bENC\b|\bEncrypted\b")
# D-Star: on the same line as "Sync:", callsigns padded with spaces, then flags. The radio header has no CRC check in DSD-FME.
DSTAR_IDS = re.compile(r" DST: (.*?) SRC: (.*?)(?: DATA| REPEATER| INTERRUPTED| CONTROL SIGNAL| URGENT|\s*$)")
# Slow data: 5 characters per block, text and GPS blocks can alternate ("BlueD$$CRCV    B0CA,     K1ABC     >API52,DSTAR*:").
DSTAR_TEXT = re.compile(r" (?:TEXT|DATA): (.*)")
DSTAR_BLOCK = 5
GPS_MARK = "$$CRC"
GPS_SENDER = re.compile(r",([A-Z0-9]{3,8}(?:-[A-Z0-9]{1,2})?)>")      # $$CRCB0CA,K1ABC>API52,DSTAR*:
GPS_SYNTAX = re.compile(r"[,>*:]")
GPS_POSITION = re.compile(r"\d{3,5}\.\d{2}[NSEW]")                    # continuation of a GPS frame: 0500.00E
READABLE = re.compile(r"[A-Za-z0-9 .,:/_'!?()#&-]+$")                 # the message of a radio; not @ [ + > ; and the like
TEXTS_MAX = 200               # different texts remembered per call
CALLSIGN = re.compile(r"[A-Z0-9/ ]+$")


def dstar_slow_data(text):
    """Printed slow data -> (message for people, callsign of the sender from a GPS frame or None)."""
    text = "".join(c for c in text if c.isprintable())
    if GPS_MARK not in text.replace(" ", ""):
        return text.strip(), None
    sender = GPS_SENDER.search(text.replace(" ", ""))
    sender = sender[1] if sender else None
    blocks = [text[i:i + DSTAR_BLOCK] for i in range(0, len(text), DSTAR_BLOCK)]
    if GPS_MARK not in blocks:
        return "", sender          # not aligned: better no message than pieces of the GPS frame
    mark = blocks.index(GPS_MARK)
    message = blocks[:mark]
    for block in blocks[mark + 1::2]:   # after the mark: every other block, until the text ends
        if not block.strip() or GPS_SYNTAX.search(block) or block.strip() == sender:
            break
        message.append(block)
    return "".join(message).strip(), sender


def _call_type(text):
    return "group" if "Group" in text else "private" if "Private" in text else ""


def _public(call, now=None):
    return {"time": round(call["time"], 1), "proto": call["proto"], "slot": call["slot"], "tgt": call["tgt"],
            "src": call["src"], "type": call["type"], "alias": call["alias"], "enc": call["enc"],
            "freq_hz": call["freq_hz"], "duration": round((now or call["last"]) - call["time"], 1)}


class CallTracker:
    """Calls from the text output of DSD-FME. Key of a running call: TDMA slot (1, 2), or 0 in other protocols."""

    def __init__(self, on_call):
        self.on_call = on_call
        self.lock = threading.RLock()
        self.dial = 0.0           # tuned frequency, written to the calls
        self.reset()

    def reset(self):
        with self.lock:
            self.calls = {}
            self.pending = {}
            self.kind = {}
            self.proto = ""
            self.proto_t = 0.0
            self.cc = None

    # ---------- lines ----------

    def feed(self, line, t):
        with self.lock:
            m = SYNC.search(line)
            if m:
                self._sync(m[1], m[2], t)
                return
            m = DMR_LC.search(line)
            if m:
                self._link_control(int(m[1]), {"tgt": m[2], "src": m[3], "type": _call_type(m[4]),
                                               "enc": "Encrypted" in m[4]}, t)
                return
            m = ALIAS.search(line)
            if m:
                self._alias(int(m[1]) + 1, m[2].strip())
                return
            self._other(line, t)

    def _other(self, text, t):
        """Protocols other than DMR: whatever is known."""
        call = self.calls.get(0)
        if not call:
            return
        if call["proto"] == "DSTAR":
            self._dstar(call, text, t)
            return
        tgt, src = OTHER_TGT.search(text), OTHER_SRC.search(text)
        if tgt:
            call["tgt"] = tgt[1]
        if src:
            call["src"] = src[1]
        if OTHER_ENC.search(text):
            call["enc"] = True

    def _dstar(self, call, text, t):
        ids = DSTAR_IDS.search(text)
        if ids:
            dst, src = " ".join(ids[1].split()), " ".join(ids[2].split())
            if dst and src and CALLSIGN.match(dst) and CALLSIGN.match(src):
                self._link_control(0, {"tgt": dst, "src": src, "type": "", "enc": False}, t)
                self.calls[0]["from_header"] = True
        words = DSTAR_TEXT.search(text)
        if words:
            message, sender = dstar_slow_data(words[1])
            call = self.calls[0]
            # The sender from GPS only without a radio header, which is the better source. Slow data has no error
            # correction: the same callsign twice in a row, so a damaged one neither shows nor splits the call.
            if sender and sender == call.get("gps_sender") and sender != call["src"] and not call.get("from_header"):
                self._link_control(0, {"tgt": None, "src": sender, "type": "", "enc": False}, t)
            if sender:
                self.calls[0]["gps_sender"] = sender
            if READABLE.match(message) and not GPS_POSITION.search(message):
                # also GPS frames without the mark come here, and slow data has no error correction: only repeated text
                seen = self.calls[0].setdefault("texts", set())
                if message in seen:
                    self._alias(0, message)
                elif len(seen) < TEXTS_MAX:
                    seen.add(message)

    def _sync(self, proto, rest, t):
        self.proto, self.proto_t = proto, t
        cc = COLOR.search(rest)
        if cc:
            self.cc = int(cc[1])
        if proto != "DMR":
            self._voice(0, proto, t)
            self._other(rest, t)
            return
        slot = SLOT_MARK.search(rest)
        burst = BURST.search(rest)
        if not slot or not burst:
            return
        slot, burst = int(slot[1]), burst[1]
        self.kind[slot] = burst
        if burst.startswith("VC"):
            self._voice(slot, proto, t)
        elif burst == "TLC":
            self._end(slot)        # terminator with link control

    def _voice(self, slot, proto, t):
        call = self.calls.get(slot)
        if call and t - call["last"] > CALL_GAP_S:
            self._end(slot)
            call = None
        if not call:
            call = self._new(slot, proto, t)
            info, at = self.pending.pop(slot, (None, 0.0))
            if info and t - at <= PENDING_S:
                call.update(info)
        call["last"] = t

    def _new(self, slot, proto, t):
        call = {"time": t, "last": t, "proto": proto, "slot": slot or None, "tgt": None, "src": None, "type": "",
                "alias": "", "enc": False, "freq_hz": self.dial}
        self.calls[slot] = call
        return call

    def _link_control(self, slot, info, t):
        if self.kind.get(slot) == "TLC":
            return                 # repeats of the call that has just ended
        call = self.calls.get(slot)
        if not call:
            self.pending[slot] = (info, t)
            return
        if call["src"] and (call["src"], call["tgt"]) != (info["src"], info["tgt"]):
            if t - call["time"] > SPLIT_AFTER_S:
                proto, last = call["proto"], call["last"]
                self._end(slot)
                call = self._new(slot, proto, t)
                call["last"] = max(last, t)
            else:
                call["alias"] = ""     # the first IDs were of the previous caller
        enc = call["enc"] or info["enc"]
        call.update(info)
        call["enc"] = enc

    def _alias(self, slot, text):
        call = self.calls.get(slot)
        if call and len(text) >= len(call["alias"]):      # the alias grows block by block
            call["alias"] = text

    def _end(self, slot):
        call = self.calls.pop(slot, None)
        self.pending.pop(slot, None)
        if not call:
            return
        duration = call["last"] - call["time"]
        if not call["src"] and not call["tgt"] and duration < MIN_CALL_S:
            return
        self.on_call(_public(call))

    # ---------- state ----------

    def tick(self, t):
        with self.lock:
            for slot in [s for s, c in self.calls.items() if t - c["last"] > CALL_GAP_S]:
                self._end(slot)

    def finish(self):
        with self.lock:
            for slot in list(self.calls):
                self._end(slot)

    def state(self, t):
        with self.lock:
            live = t - self.proto_t <= PROTO_HOLD_S
            return {"proto": self.proto if live else "", "cc": self.cc if live else None,
                    "active": [_public(self.calls[s], t) for s in sorted(self.calls)]}


class Resampler:
    """Linear interpolation that continues from block to block (mono or multi-channel, along the first axis)."""

    def __init__(self, rate_in, rate_out):
        self.step = rate_in / rate_out
        self.pos = 0.0
        self.last = None

    def run(self, x):
        n = len(x)
        if not n:
            return x[:0]
        if self.last is None:
            self.last = x[0]
        idx = np.arange(self.pos, n, self.step)
        self.pos = float(idx[-1] + self.step - n) if len(idx) else self.pos - n
        grid = np.arange(n + 1)
        buf = np.concatenate(([self.last], x))
        self.last = x[-1]
        if x.ndim == 1:
            return np.interp(idx, grid, buf)
        return np.stack([np.interp(idx, grid, buf[:, c]) for c in range(x.shape[1])], axis=1)


def voice_frames(data, stereo):
    """UDP packet -> float stereo. One talking TDMA slot (the other channel exactly silent) is heard in both ears."""
    x = np.frombuffer(data[:len(data) & ~1], "<i2").astype(np.float64) / 32768
    if not stereo:
        return np.repeat(x[:, None], 2, axis=1)
    x = x[:len(x) & ~1].reshape(-1, 2)
    if len(x):
        left, right = np.any(x[:, 0]), np.any(x[:, 1])
        if left != right:
            x = np.repeat(x[:, [0 if left else 1]], 2, axis=1)
    return x


class _Session:
    """One running dsd-fme with its sockets."""

    def __init__(self, proc, server, udp, stereo):
        self.proc, self.server, self.udp, self.stereo = proc, server, udp, stereo
        self.q = queue.Queue(maxsize=24)
        self.stop = False


class DsdDecoder:
    def __init__(self, on_event):
        self.on_event = on_event
        self.enabled = False
        self.error = None
        self.protocol = "auto"
        self.slot = "both"
        self.count = 0
        self.dropped = 0
        self.calls = collections.deque(maxlen=HISTORY)
        self.tracker = CallTracker(self._call_ended)
        self.lock = threading.Lock()
        self.session = None
        self.starting = False
        self.next_start = 0.0
        self.out_lock = threading.Lock()
        self.fs = 0.0
        self.to_input = None
        self.to_output = None
        self.sos = None
        self.zi = None
        self.out = np.zeros((0, 2), np.float32)
        self.playing = False
        threading.Thread(target=self._ticker, name="dsd-tick", daemon=True).start()

    # ---------- control ----------

    def set_enabled(self, on):
        on = bool(on)
        with self.lock:
            if on == self.enabled:
                return
            self.enabled = on
            self.error = None
            self.next_start = 0.0
            self._stop()

    def set_options(self, protocol=None, slot=None):
        """A change restarts the decoder (its options are given on the command line)."""
        with self.lock:
            changed = (protocol is not None and protocol != self.protocol) or (slot is not None and slot != self.slot)
            if protocol is not None:
                self.protocol = protocol
            if slot is not None:
                self.slot = slot
            if changed:
                self.next_start = 0.0
                self._stop()

    def clear(self):
        self.calls.clear()
        self.count = 0

    def info(self):
        return dict(self.tracker.state(time.time()), enabled=self.enabled, installed=os.path.exists(EXE), error=self.error,
                    protocol=self.protocol, slot=self.slot, count=self.count, dropped=self.dropped)

    def history(self):
        return list(self.calls)

    def _call_ended(self, call):
        self.calls.append(call)
        self.count += 1
        self.on_event("dsdcall", call)

    def _ticker(self):
        while True:
            time.sleep(0.25)
            self.tracker.tick(time.time())

    # ---------- samples from the receiver thread ----------

    def process(self, audio, fs, dial_hz):
        """audio: FM discriminator (float, ±1). Returns the voice for the same time: float32 stereo, as many samples."""
        n = len(audio)
        if not self.enabled:
            return np.zeros((n, 2), np.float32)
        self.tracker.dial = dial_hz
        if fs != self.fs:
            self._set_rate(fs)
        s = self.session
        if s is None:
            self._start_later()
        else:
            pcm = np.clip(self.to_input.run(audio.astype(np.float64)) * INPUT_GAIN * 32767, -32767, 32767).astype("<i2")
            try:
                s.q.put_nowait(pcm.tobytes())
            except queue.Full:
                self.dropped += 1
        return self._pop(n)

    def _set_rate(self, fs):
        from scipy.signal import butter
        with self.out_lock:
            self.fs = fs
            self.to_input = Resampler(fs, INPUT_RATE)
            self.to_output = Resampler(OUTPUT_RATE, fs)
            self.sos = butter(4, OUTPUT_LOWPASS_HZ / (fs / 2), output="sos")
            self.zi = np.zeros((len(self.sos), 2, 2))
            self.out = self.out[:0]
            self.playing = False

    def _pop(self, n):
        with self.out_lock:
            have = len(self.out)
            if not self.playing:
                if have < n + PREBUFFER_S * self.fs:
                    return np.zeros((n, 2), np.float32)
                self.playing = True
            if have >= n:
                y, self.out = self.out[:n], self.out[n:]
                return y
            y = np.concatenate((self.out, np.zeros((n - have, 2), np.float32)))
            self.out = self.out[:0]
            self.playing = False
            return y

    def _push_voice(self, x):
        """x: float stereo at OUTPUT_RATE."""
        from scipy.signal import sosfilt
        with self.out_lock:
            if self.to_output is None or not len(x):
                return
            y, self.zi = sosfilt(self.sos, self.to_output.run(x), axis=0, zi=self.zi)
            self.out = np.concatenate((self.out, y.astype(np.float32)))
            if len(self.out) > OUTPUT_MAX_S * self.fs:
                self.out = self.out[-int(PREBUFFER_S * self.fs):]

    # ---------- process ----------

    def _start_later(self):
        now = time.time()
        with self.lock:
            if self.starting or not self.enabled or now < self.next_start or self.session:
                return
            self.starting = True
            self.next_start = now + RESTART_S
        threading.Thread(target=self._start, name="dsd-start", daemon=True).start()   # not in the receiver thread

    def _start(self):
        server = udp = None
        try:
            if not os.path.exists(EXE):
                self.error = NOT_INSTALLED
                return
            server = socket.create_server(("127.0.0.1", 0))
            server.settimeout(15)
            udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            udp.bind(("127.0.0.1", 0))
            udp.settimeout(0.5)
            with self.lock:
                options, stereo = PROTOCOLS[self.protocol]
                slots = SLOTS[self.slot]
            cmd = [EXE, "-i", f"tcp:127.0.0.1:{server.getsockname()[1]}", "-o", f"udp:127.0.0.1:{udp.getsockname()[1]}",
                   *options, "-V", slots]
            proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                                    cwd=os.path.dirname(EXE), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            s = _Session(proc, server, udp, stereo)
            with self.lock:
                self.session = s
                self.error = None
                if not self.enabled:           # switched off in the meantime
                    self._stop()
                    return
            for target, name in ((self._writer, "in"), (self._voice, "voice"), (self._reader, "text")):
                threading.Thread(target=target, args=(s,), name=f"dsd-{name}", daemon=True).start()
        except OSError as e:
            self.error = f"cannot start dsd-fme: {e}"
            for sock in (server, udp):
                if sock:
                    sock.close()
        finally:
            self.starting = False

    def _stop(self):
        """Called with self.lock held."""
        s, self.session = self.session, None
        if s:
            s.stop = True
            try:
                s.proc.kill()
            except OSError:
                pass
            s.server.close()
            s.udp.close()
        self.tracker.finish()
        self.tracker.reset()
        with self.out_lock:
            self.out = self.out[:0]
            self.playing = False

    def _writer(self, s):
        try:
            conn, _ = s.server.accept()
        except OSError:
            return
        with conn:
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            while not s.stop:
                try:
                    conn.sendall(s.q.get(timeout=1))
                except queue.Empty:
                    continue
                except OSError:
                    return

    def _voice(self, s):
        while not s.stop:
            try:
                data = s.udp.recv(65535)
            except socket.timeout:
                continue
            except OSError:
                return
            self._push_voice(voice_frames(data, s.stereo))

    def _reader(self, s):
        for raw in s.proc.stderr:
            line = ANSI.sub("", raw.decode("utf-8", "replace")).rstrip("\r\n")
            try:
                self.tracker.feed(line, time.time())
            except Exception:
                pass                # one odd line must not stop the decoder
        with self.lock:
            if self.session is s and self.enabled:
                self.error = f"dsd-fme ended (code {s.proc.poll()})"
                self._stop()
