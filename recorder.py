"""Audio recording of one VFO to MP3 files in data/recordings.

Two independent recordings, each with its own button:
  cont     everything until it is switched off, a new file every MAX_FILE_S
  squelch  only while there is audio (open squelch), each session in its own file

The receiver thread only puts the blocks in a queue; encoding and writing to disk run in their own thread.
File name: [<memory name>_]<frequency>MHz_<mode>_<YYYYMMDD_HHMMSS of the start>.mp3
"""
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

FOLDER = data("recordings")
BITRATE = 128         # kbps
QUALITY = 2           # LAME: 2 = high quality (about 2 % of one CPU core per recording)
MAX_FILE_S = 15 * 60  # cont: longer recordings continue in the next file
SESSION_HOLD_S = 1.0  # squelch: a closed squelch ends the session after this long, so a short dip does not split it
SESSION_MIN_S = 0.3   # squelch: a shorter session is a noise burst, its file is deleted
SILENCE_PEAK = 1      # 16-bit samples: a block up to this level is silence (a closed squelch gives exactly 0)
QUEUE_BLOCKS = 256    # about 16 s of audio


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


class Track:
    """One recording. Only the recorder's thread touches the open file; `on` is the switch from outside."""

    def __init__(self, gated, folder):
        self.gated = gated
        self.folder = folder
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
        os.makedirs(self.folder, exist_ok=True)
        stem = f"{memory_prefix(hz, mode)}{hz / 1e6:.6f}MHz_{mode}_{time.strftime('%Y%m%d_%H%M%S')}"
        path, n = os.path.join(self.folder, stem + ".mp3"), 1
        while os.path.exists(path):          # both recordings, or two VFOs, in the same second
            n += 1
            path = os.path.join(self.folder, f"{stem}_{n}.mp3")
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
    def __init__(self, folder=FOLDER):
        self.tracks = {"cont": Track(False, folder), "squelch": Track(True, folder)}
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

    def state(self):
        return dict({kind: t.state() for kind, t in self.tracks.items()}, dropped=self.dropped)
