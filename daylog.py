"""Daily decoder logs: logs/<decoder>_YYYY-MM-DD.txt (UTC), one line per message.

The log is shared by all VFOs (each runs in its own process), so every line carries the VFO name
and is written in one piece. Text decoders (CW, RTTY) send characters one by one; they are joined
into lines: end of line, 80 characters or 5 s of silence.
"""
import os
import threading
import time

from paths import data

LOG_DIR = data("logs")
LINE_MAX = 80
IDLE_S = 5.0


def stamp(t=None):
    return time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(t))


class DayLog:
    def __init__(self, name, tag="", log_dir=LOG_DIR):
        self.name = name
        self.tag = f"VFO-{tag}" if tag else "VFO"
        self.log_dir = log_dir
        self.lock = threading.Lock()

    def path(self, t=None):
        return os.path.join(self.log_dir, f"{self.name}_{time.strftime('%Y-%m-%d', time.gmtime(t))}.txt")

    def write(self, line, t=None):
        try:
            os.makedirs(self.log_dir, exist_ok=True)
            with self.lock, open(self.path(t), "a", encoding="utf-8") as f:
                f.write(f"{stamp(t)} {self.tag} {line}\n")
        except OSError:
            pass            # a full disk / locked file must not stop the receiver


class TextLog(DayLog):
    """Log for character decoders: line = start (time, frequency) + text."""

    def __init__(self, name, tag="", log_dir=LOG_DIR):
        super().__init__(name, tag, log_dir)
        self.buf = ""
        self.start = None
        self.prefix = ""
        self.last = 0.0
        threading.Thread(target=self._idle, name=f"log-{name}", daemon=True).start()

    def add(self, text, prefix):
        """text: new characters; prefix: e.g. the frequency, written at the start of the line."""
        with self.lock:
            now = time.time()
            for ch in text:
                if ch == "\n":
                    self._flush()
                    continue
                if not self.buf:
                    if ch == " ":
                        continue
                    self.start, self.prefix = now, prefix
                self.buf += ch
                if len(self.buf) >= LINE_MAX:
                    self._flush()
            self.last = now

    def flush(self):
        with self.lock:
            self._flush()

    def _flush(self):
        text = self.buf.strip()
        self.buf = ""
        if not text:
            return
        try:
            os.makedirs(self.log_dir, exist_ok=True)
            with open(self.path(self.start), "a", encoding="utf-8") as f:
                f.write(f"{stamp(self.start)} {self.tag} {self.prefix} | {text}\n")
        except OSError:
            pass

    def _idle(self):
        while True:
            time.sleep(1.0)
            with self.lock:
                if self.buf and time.time() - self.last > IDLE_S:
                    self._flush()
