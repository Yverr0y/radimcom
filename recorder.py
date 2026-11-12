"""Audio recording of one VFO to MP3 files in data/recordings, or in the folder set in SETTINGS › GENERAL › RECORDINGS.

Two independent recordings, each with its own button:
  cont     everything until it is switched off, a new file every MAX_FILE_S
  squelch  only while there is audio (open squelch), each session in its own file

The receiver thread only puts the blocks in a queue; encoding and writing to disk run in their own thread.
File name: [<memory name>_]<frequency>MHz_<mode>_<YYYYMMDD_HHMMSS of the start>.mp3
The RECORDINGS tab lists the files (Recorder.files) and plays them in the browser.
The folder is shared by all VFOs (data\recordings.json, read again when it changes); a file being written stays where it was opened.
"""
import json
import os
import queue
import re
import threading
import time

import numpy as np

import memories
from paths import data

try:
    import lameenc
except ImportError:
    lameenc = None                  # installation before this feature: upgrade.bat installs it

FOLDER = data("recordings")               # default folder
SETTINGS_PATH = data("recordings.json")    # {"folder": "<absolute path>"}; missing or empty = FOLDER
BITRATE = 128         # kbps
QUALITY = 2           # LAME: 2 = high quality (about 2 % of one CPU core per recording)
MAX_FILE_S = 15 * 60  # cont: longer recordings continue in the next file
SESSION_HOLD_S = 1.0  # squelch: a closed squelch ends the session after this long, so a short dip does not split it
SESSION_MIN_S = 0.3   # squelch: a shorter session is a noise burst, its file is deleted
SILENCE_PEAK = 1      # 16-bit samples: a block up to this level is silence (a closed squelch gives exactly 0)
QUEUE_BLOCKS = 256    # about 16 s of audio
NAME_RE = re.compile(r"^(?:(?P<memory>.+?)_)?(?P<mhz>\d+\.\d{6})MHz_(?P<mode>[A-Z0-9]+)_(?P<start>\d{8}_\d{6})(?:_\d+)?\.mp3$")


_settings_cache = [None, ""]   # (mtime, size) of SETTINGS_PATH, the folder from it


def custom_folder():
    """The folder set by the user, "" = the default one."""
    try:
        st = os.stat(SETTINGS_PATH)
        key = (st.st_mtime_ns, st.st_size)
    except OSError:
        return ""
    if _settings_cache[0] != key:
        try:
            with open(SETTINGS_PATH, encoding="utf-8") as f:
                s = json.load(f)
            folder = s.get("folder") if isinstance(s, dict) else ""
        except (OSError, ValueError):
            folder = ""
        _settings_cache[:] = [key, folder if isinstance(folder, str) else ""]
    return _settings_cache[1]


def current_folder():
    return custom_folder() or FOLDER


def settings():
    """For SETTINGS › GENERAL › RECORDINGS: the folder in use, the set one ("" = default) and the default one."""
    return {"folder": current_folder(), "custom": custom_folder(), "default": FOLDER}


def save_folder(folder):
    """Sets the recordings folder ("" or the default path = the default one); creates it and checks that it can be written.
    ValueError with the reason if it cannot be used."""
    folder = (folder or "").strip().strip('"').strip()
    if folder:
        folder = os.path.expandvars(os.path.expanduser(folder))
        if not os.path.isabs(folder):
            raise ValueError("enter a full path, for example D:\\Recordings")
        folder = os.path.normpath(folder)
        if os.path.normcase(folder) == os.path.normcase(os.path.normpath(FOLDER)):
            folder = ""
    if folder:
        try:
            os.makedirs(folder, exist_ok=True)
            probe = os.path.join(folder, f".radimcom_write_test_{os.getpid()}")
            with open(probe, "wb") as f:
                f.write(b"x")
            os.remove(probe)
        except OSError as e:
            raise ValueError(f"the folder cannot be used: {e.strerror or e}") from None
    tmp = f"{SETTINGS_PATH}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"folder": folder}, f, indent=2)
    os.replace(tmp, SETTINGS_PATH)
    return settings()


def has_audio(pcm):
    x = np.frombuffer(pcm, "<i2")
    return x.size > 0 and (int(x.max()) > SILENCE_PEAK or int(x.min()) < -SILENCE_PEAK)


def memory_prefix(hz, mode):
    """Name of the memory on this frequency for the file name: "Piestany TWR" -> "Piestany_TWR_", no memory -> ""."""
    try:
        name = memories.name_at(hz, mode)
    except (OSError, ValueError, KeyError, TypeError):   # an unreadable memory file must not stop the recording
        return ""
    name = re.sub(r'[\s\\/:*?"<>|\x00-\x1f]+', "_", name).strip("_.")    # also characters Windows forbids in a file name
    return name + "_" if name else ""


def parse_name(name):
    """Frequency, mode, start and memory name from a file name of a recording (empty for a foreign file)."""
    m = NAME_RE.match(name)
    if not m:
        return {"memory": "", "hz": 0, "mode": "", "start": ""}
    memory = m.group("memory") or ""
    s = m.group("start")
    return {"memory": memory.replace("_", " "), "hz": int(round(float(m.group("mhz")) * 1e6)), "mode": m.group("mode"),
            "start": f"{s[:4]}-{s[4:6]}-{s[6:8]} {s[9:11]}:{s[11:13]}:{s[13:15]}"}


class Track:
    """One recording. Only the recorder's thread touches the open file; `on` is the switch from outside."""

    def __init__(self, gated, folder):
        self.gated = gated
        self.folder = folder          # callable: the folder for the next file
        self.on = False
        self.error = ""
        self.file = ""       # file being written, otherwise the last saved one
        self.saved = 0       # files finished since the button was pressed
        self.enc = None
        self.out = None
        self.path = ""
        self.rate = 0
        self.frames = 0
        self.held = []       # squelch: silent blocks after the audio, written only if the audio returns
        self.held_frames = 0
        self.last_block = 0.0

    def _open(self, rate, hz, mode):
        folder = self.folder()
        os.makedirs(folder, exist_ok=True)
        stem = f"{memory_prefix(hz, mode)}{hz / 1e6:.6f}MHz_{mode}_{time.strftime('%Y%m%d_%H%M%S')}"
        path, n = os.path.join(folder, stem + ".mp3"), 1
        while os.path.exists(path):          # both recordings, or two VFOs, in the same second
            n += 1
            path = os.path.join(folder, f"{stem}_{n}.mp3")
        enc = lameenc.Encoder()
        enc.set_bit_rate(BITRATE)
        enc.set_in_sample_rate(int(round(rate)))   # LAME resamples rates that MP3 does not have
        enc.set_channels(2)
        enc.set_quality(QUALITY)
        self.out = open(path, "xb")
        self.enc, self.path, self.rate, self.frames, self.file = enc, path, rate, 0, os.path.basename(path)

    def _encode(self, pcm):
        self.out.write(self.enc.encode(pcm))
        self.frames += len(pcm) // 4

    def close(self):
        if self.enc is None:
            return
        enc, out, self.enc, self.out = self.enc, self.out, None, None
        self.held, self.held_frames = [], 0
        frames, self.frames = self.frames, 0
        try:
            out.write(enc.flush())
        finally:
            out.close()
        if self.gated and frames < SESSION_MIN_S * self.rate:
            os.remove(self.path)
            self.file = ""
        else:
            self.saved += 1

    def write(self, pcm, rate, hz, mode):
        self.last_block = time.monotonic()
        if self.enc is not None and rate != self.rate:
            self.close()                         # one file has one sample rate
        if self.gated:
            self._write_gated(pcm, rate, hz, mode)
            return
        if self.enc is not None and self.frames + len(pcm) // 4 > MAX_FILE_S * self.rate:
            self.close()
        if self.enc is None:
            self._open(rate, hz, mode)
        self._encode(pcm)

    def _write_gated(self, pcm, rate, hz, mode):
        if has_audio(pcm):
            if self.enc is None:
                self._open(rate, hz, mode)
            for block in self.held:              # the pause inside the session stays in the file
                self._encode(block)
            self.held, self.held_frames = [], 0
            self._encode(pcm)
        elif self.enc is not None:
            self.held.append(pcm)
            self.held_frames += len(pcm) // 4
            if self.held_frames >= SESSION_HOLD_S * self.rate:
                self.close()

    def idle(self):
        """No blocks are coming (a decoder muted the audio, band of the owner VFO left): the session is over."""
        if self.gated and self.enc is not None and time.monotonic() - self.last_block > SESSION_HOLD_S:
            self.close()

    def fail(self, e):
        self.on, self.error = False, f"Recording stopped: {e}"
        print(self.error, flush=True)
        try:
            self.close()
        except (OSError, RuntimeError):
            pass

    def state(self):
        enc, rate, frames = self.enc, self.rate, self.frames
        return {"on": self.on, "open": enc is not None, "file": self.file, "saved": self.saved,
                "secs": int(frames / rate) if enc is not None and rate else 0, "error": self.error}


class Recorder:
    def __init__(self, folder=None):
        self.fixed_folder = folder    # None = the folder of the settings (tests give their own)
        self.tracks = {"cont": Track(False, lambda: self.folder), "squelch": Track(True, lambda: self.folder)}
        self.q = queue.Queue(maxsize=QUEUE_BLOCKS)
        self.dropped = 0
        threading.Thread(target=self._run, daemon=True, name="recorder").start()

    def set(self, kind, on):
        """Button of a recording; ValueError if it cannot be started."""
        t = self.tracks[kind]
        if on and not t.on:
            if lameenc is None:
                raise ValueError("MP3 encoder is missing: run upgrade.bat")
            t.error, t.file, t.saved = "", "", 0
        t.on = bool(on)

    def feed(self, pcm, rate, hz, mode):
        """16-bit stereo block from the receiver thread; never blocks it."""
        if not any(t.on for t in self.tracks.values()):
            return
        try:
            self.q.put_nowait((pcm, rate, hz, mode))
        except queue.Full:
            self.dropped += 1                    # the disk does not keep up

    def _run(self):
        while True:
            try:
                block = self.q.get(timeout=0.25)
            except queue.Empty:
                block = None
            for t in self.tracks.values():
                try:
                    if not t.on:
                        t.close()
                    elif block:
                        t.write(*block)
                    else:
                        t.idle()
                except (OSError, RuntimeError) as e:
                    t.fail(e)

    def stop_all(self, wait_s=2.0):
        """Closes the files properly when the program ends."""
        for t in self.tracks.values():
            t.on = False
        end = time.monotonic() + wait_s
        while any(t.enc is not None for t in self.tracks.values()) and time.monotonic() < end:
            time.sleep(0.02)

    @property
    def folder(self):
        return self.fixed_folder or current_folder()

    def state(self):
        return dict({kind: t.state() for kind, t in self.tracks.items()}, dropped=self.dropped)

    def writing(self):
        """Names of the files being written now into the current folder."""
        folder = os.path.normcase(os.path.normpath(self.folder))
        return {t.file for t in self.tracks.values() if t.enc is not None and t.file
                and (not t.path or os.path.normcase(os.path.dirname(t.path)) == folder)}

    def files(self):
        """The MP3 files in the recordings folder, newest first: name, size, time of the last change, length
        (from the size, CBR), the frequency / mode / start / memory name from the file name, and whether it is being written."""
        try:
            names = [n for n in os.listdir(self.folder) if n.lower().endswith(".mp3")]
        except OSError:
            return []
        writing, out = self.writing(), []
        for name in names:
            try:
                stat = os.stat(os.path.join(self.folder, name))
            except OSError:
                continue
            out.append(dict(parse_name(name), name=name, size=stat.st_size, mtime=int(stat.st_mtime),
                            secs=int(stat.st_size * 8 / (BITRATE * 1000)), writing=name in writing))
        out.sort(key=lambda f: (f["mtime"], f["name"]), reverse=True)
        return out

    def delete(self, name):
        """Deletes one recording; ValueError if it does not exist or is being written."""
        if name in self.writing():
            raise ValueError("The file is being written: stop the recording first")
        path = os.path.join(self.folder, name)
        if os.sep in name or "/" in name or not os.path.isfile(path):
            raise ValueError("No such recording")
        os.remove(path)
