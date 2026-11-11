"""Scanner (SCAN tab; design in data/poznamky_scan.md, steps 1–5).

It runs inside the receiver thread: Receiver._loop calls block() once per block, right after the waterfall FFT, so it
retunes without the delay of the web API. It does not step through the channels one by one: every block measures the
power of all channels in the band the dongle receives now from the fine FFT of the waterfall (wf_power, spur mask
applied when SP is on), so a whole tuner window is checked in one block (~85 ms at 1.536 MS/s). The tuner is retuned
only to reach the next window; the channels are sorted into windows of SCAN_SPAN × sample rate.

Sources: memories (ALL, FAVOURITES or a group) or a RANGE FROM / TO / STEP / MODE / BW (a grid of channels; VIEW is a
range set to the part of the spectrum shown by the page). All channels are kept in numpy arrays, so a range of
thousands of channels costs only a few ms per block.

Squelch of a channel: its own level (scan_sq of a memory), or its noise floor + a margin (scan_asq of a memory, or the
margin of the scan with "ASQ for all"), or else the squelch level of its mode. Noise floor: a low percentile of its
own last measurements once there are FLOOR_MIN_N of them (it knows spurs, the DC spike and local noise; it learns only
while the channel is quiet), before that the noise density of the spectrum (as the auto squelch of sdr.py). All in the
units of the squelch slider (channel power, dBFS).

Also: priority channels (in the band: at once; in another window: a look every prio_s), SKIP / LOCKOUT, carrier
lockout (a channel open longer than carrier_min), activity log (data/logs/scan_YYYY-MM-DD.csv), recording of each
activity to WAV with the audio from before the signal came back, search & store (range: active frequencies into the
memory group "Scan YYYY-MM-DD").

The decoder and record fields of the memories are ignored: only frequency, mode and bandwidth are set. The decoders
of the VFO are paused while the scan runs (app.py).
"""
import collections
import csv
import io
import os
import re
import threading
import time
import wave

import numpy as np

from paths import data

SCAN_SPAN = 0.75        # part of the dongle band (around its centre) used for one tuner window (edges roll off)
DC_GAP_HZ = 12000       # a window centre is placed at least this far from every channel when it can be (DC spike)
SETTLE_BLOCKS = 2       # blocks thrown away after retuning the tuner (+ the blocks waiting in the queue)
FLOOR_N = 40            # measurements kept per channel for its own noise floor
FLOOR_MIN_N = 8         # before this many, the floor is taken from the spectrum
FLOOR_PCT = 20          # percentile of the own measurements = noise floor
RELEARN_S = 30.0        # without carrier lockout: a channel open this long without a break learns it as its floor
HYST_DB = 2.0           # an active channel stays active down to its level − HYST_DB
SKIP_S = 300.0          # SKIP leaves the channel out for 5 min
CARRIER_HANG_S = 0.3    # resume "carrier": continue this soon after the signal drops
MAX_CHANNELS = 20000    # a range with more grid channels is refused
EXCLUDED_MAX = 200      # channels left out: at most this many are listed
LIST_MAX = 400          # range: channels listed for the page (heard, active, locked)
LOG_MAX = 1000          # activities kept in memory
STORE_MIN_S = 1.0       # search & store: a shorter activity is not stored
REC_PRE_S = 0.5         # recording: audio from before the signal came back (in the hang)
REC_TAIL_S = 0.5        # recording: audio after the signal dropped
REC_MAX_S = 300.0       # recording: one activity at most this long
BLOCK_S = 0.085         # about one block (for the time away during a priority look)
LOG_DIR = data("logs")
LOG_FIELDS = ("time_utc", "vfo", "freq_hz", "name", "mode", "duration_s", "max_dbfs", "snr_db", "file", "note")
RESUME_MODES = ("delay", "carrier", "time")
SOURCES = ("all", "fav", "group", "range", "view")
PICKS = ("next", "strongest")
MODES = ("AM", "FM", "WFM", "LSB", "USB", "CW")
DEFAULTS = {"source": "all", "group": "", "asq": True, "margin": 6.0, "resume": "delay", "hang_s": 2.0,
            "time_s": 10.0, "from_hz": 118e6, "to_hz": 136.99167e6, "step_hz": 25000 / 3, "mode": "AM",
            "bw": 8000.0, "pick": "next", "store": False, "rec": False, "log": True, "carrier_min": 3.0,
            "prio_s": 3.0}
# ranges offered by the page: (name, from, to, step, mode, bw)
PRESETS = [
    ("Airband 118–137 MHz", 118e6, 136.99167e6, 25000 / 3, "AM", 8000),
    ("PMR446", 446.00625e6, 446.19375e6, 12500, "FM", 12500),
    ("2 m 144–146 MHz", 144e6, 146e6, 12500, "FM", 12500),
    ("70 cm 430–440 MHz", 430e6, 440e6, 12500, "FM", 12500),
    ("LPD433", 433.075e6, 434.775e6, 25000, "FM", 12500),
    ("Marine VHF 156–162 MHz", 156e6, 162.025e6, 25000, "FM", 16000),
    ("CB 27 MHz (FM)", 26.965e6, 27.405e6, 10000, "FM", 10000),
]


def norm_opts(o, base=None):
    """Checked scan options (ValueError on a bad value); missing ones from base / DEFAULTS."""
    out = dict(DEFAULTS, **{k: v for k, v in (base or {}).items() if k in DEFAULTS})
    o = o or {}
    for k, allowed in (("source", SOURCES), ("resume", RESUME_MODES), ("pick", PICKS), ("mode", MODES)):
        if k in o:
            if o[k] not in allowed:
                raise ValueError(f"unknown scan {k}")
            out[k] = o[k]
    if "group" in o:
        out["group"] = str(o["group"] or "")[:40]
    for k in ("asq", "store", "rec", "log"):
        if k in o:
            out[k] = bool(o[k])
    for k, lo, hi in (("margin", 1.0, 30.0), ("hang_s", 0.0, 60.0), ("time_s", 1.0, 600.0), ("from_hz", 0.0, 6e9),
                      ("to_hz", 0.0, 6e9), ("step_hz", 100.0, 1e6), ("bw", 100.0, 250000.0),
                      ("carrier_min", 0.0, 120.0), ("prio_s", 0.0, 60.0)):
        if k in o:
            v = float(o[k])
            if not lo <= v <= hi:
                raise ValueError(f"scan {k} must be {lo:g} to {hi:g}")
            out[k] = v
    return out


def passband(f, mode, bw):
    """(from, to) Hz of the channel, as the demodulator hears it."""
    if mode == "USB":
        return f + 300.0, f + bw
    if mode == "LSB":
        return f - bw, f - 300.0
    return f - bw / 2, f + bw / 2


def safe_name(name):
    return re.sub(r'[\s\\/:*?"<>|\x00-\x1f]+', "_", str(name or "")).strip("_.")[:40]


def rec_folder():
    """WAV files of the scan: the subfolder "scan" of the recordings folder (SETTINGS › GENERAL › RECORDINGS)."""
    from recorder import current_folder
    return os.path.join(current_folder(), "scan")


def log_path(t=None):
    return os.path.join(LOG_DIR, f"scan_{time.strftime('%Y-%m-%d', time.gmtime(t))}.csv")


def read_log(days=1, limit=None, now=None):
    """Activities of the last `days` days (all VFOs), newest first."""
    now = now or time.time()
    rows = []
    for d in range(int(days) - 1, -1, -1):
        try:
            with open(log_path(now - d * 86400), encoding="utf-8", newline="") as f:
                rows.extend(r for r in csv.DictReader(f) if r.get("time_utc"))
        except OSError:
            continue
    rows.reverse()
    return rows[:limit] if limit else rows


def heatmap(days=7, top=60, now=None):
    """Occupancy: frequency × hour of the day (local time) from the log, seconds of activity.
    {"days", "rows": [{"freq_hz", "name", "mode", "total", "count", "hours": [24 × s]}]}: the `top` busiest, by
    frequency."""
    import calendar
    acc = {}
    for r in read_log(days, now=now):
        try:
            hz = int(round(float(r["freq_hz"])))
            t = calendar.timegm(time.strptime(r["time_utc"], "%Y-%m-%d %H:%M:%SZ"))
            dur = max(float(r.get("duration_s") or 0), 0.1)
        except (KeyError, ValueError, TypeError):
            continue
        row = acc.setdefault(hz, {"freq_hz": hz, "name": "", "mode": r.get("mode", ""), "total": 0.0, "count": 0,
                                  "hours": [0.0] * 24})
        if r.get("name") and not row["name"]:
            row["name"] = r["name"]
        row["hours"][time.localtime(t).tm_hour] += dur
        row["total"] += dur
        row["count"] += 1
    rows = sorted(acc.values(), key=lambda x: -x["total"])[:top]
    rows.sort(key=lambda x: x["freq_hz"])
    for row in rows:
        row["total"] = round(row["total"], 1)
        row["hours"] = [round(x, 1) for x in row["hours"]]
    return {"days": days, "rows": rows}


class Scanner:
    def __init__(self):
        self.lock = threading.Lock()
        self.cmds = []                # commands from the web (applied in the receiver thread)
        self.on = False
        self.paused = False
        self.state = "off"            # off / search / listen / peek / hold (paused)
        self.meta = []                # [{"id", "name", "freq", "mode", "bw", "mem"}] per channel
        self.windows = []             # tuner windows [{"center", "tune", "lo"}]; [] = chained VFO (band of the owner)
        self.win = 0
        self.cur = None               # index of the channel being listened to / held
        self.pos = -1                 # index of the last channel stopped on (round robin)
        self.settle = 0
        self.opts = dict(DEFAULTS)
        self.excluded = []            # channels left out at start: [{"id", "name", "freq_hz", "mode", "why"}]
        self.n_excluded = 0
        self.locked = {}              # channel index -> until (monotonic s; inf = until STOP)
        self.audio_open = False
        self.listen_since = self.last_active = 0.0
        self.rate, self._rate_n, self._rate_t = 0.0, 0, 0.0
        self.gain_key = None
        self.message = ""
        self.peek = None              # looking at the priority windows: {"ret", "wins", "k", "t0"}
        self.last_peek = 0.0
        self.prio_wins = []
        self.act = None               # activity being heard (log, recording, store)
        self.log = collections.deque(maxlen=LOG_MAX)
        self.on_store = None          # search & store: callback(entry), set by app.py
        self.stored = 0
        self._stored_ids = set()
        self.vfo = ""
        self.rec_pre = collections.deque()
        self.rec_pre_s = 0.0
        self.rec_wav = None
        self.rec_file = ""
        self.rec_s = 0.0
        self.rec_error = ""
        self._arrays(0)

    def _arrays(self, n):
        self.n = n
        self.f = np.zeros(n)
        self.bw = np.zeros(n)
        self.a = np.zeros(n)
        self.b = np.zeros(n)
        self.sq = np.full(n, np.nan)
        self.asq = np.full(n, np.nan)
        self.prio = np.zeros(n, bool)
        self.lo = np.zeros(n)
        self.mi = np.zeros(n, int)        # index into self.modes
        self.win_of = np.full(n, -1)
        self.hist = np.full((n, FLOOR_N), np.nan, np.float32)
        self.hpos = np.zeros(n, int)
        self.hn = np.zeros(n, int)
        self.power = np.full(n, np.nan)
        self.floor = np.full(n, np.nan)
        self.level = np.full(n, np.nan)
        self.active = np.zeros(n, bool)
        self.vis = np.zeros(n, bool)
        self.since = np.zeros(n)
        self.hits = np.zeros(n, int)
        self.last = np.zeros(n)
        self.modes = []

    # ---------- commands (any thread) ----------

    def command(self, action, **kw):
        with self.lock:
            self.cmds.append((action, kw))

    def start(self, mems, opts, rx):
        """Builds the channels (memories or a range); returns an error text, or None when the scan starts."""
        try:
            chans, excluded = (self._grid(opts, rx) if opts["source"] in ("range", "view")
                               else self._from_mems(mems, opts, rx))
        except ValueError as e:
            return str(e)
        if not chans:
            return "no channel to scan" + (f" ({len(excluded)} left out, see the list)" if excluded else "")
        chans.sort(key=lambda c: (c["lo"], c["freq"]))
        self.command("start", chans=chans, excluded=excluded, opts=opts, chained=rx.chained, fs=rx.fs,
                     vfo=rx.cfg.get("vfo") or "")
        return None

    @staticmethod
    def _check(f, bw, rx):
        """Why a channel cannot be scanned on this VFO, or None."""
        lo_hz, hi_hz = rx.tune_range()
        if not lo_hz <= f <= hi_hz:
            return "outside the range of this VFO"
        if rx.chained and abs(f - rx.cfg["center_hz"]) + bw / 2 > rx.fs / 2 * SCAN_SPAN:
            return "outside the band of the shared dongle (chained VFO)"
        return None

    def _from_mems(self, mems, opts, rx):
        from sdr import DSD_MODE, SQUELCH_OFF
        chans, excluded = [], []
        for m in mems:
            if opts["source"] == "fav" and not m.get("fav"):
                continue
            if opts["source"] == "group" and opts["group"] not in (m.get("groups") or []):
                continue
            f, mode, bw = float(m["freq_hz"]), m["mode"], float(m.get("bw") or 3000)
            sq, asq = m.get("scan_sq"), m.get("scan_asq")
            if not m.get("scan", True):
                why = "SCAN off in the memory"
            elif m.get("dab_channel") or mode == DSD_MODE:
                why = "DAB / DSD memories are not scanned"
            elif sq is None and asq is None and not opts["asq"] and rx.manual_squelch(mode) <= SQUELCH_OFF:
                why = "squelch off: it would stop the scan for good (set SQ or ASQ of the channel, or ASQ FOR ALL)"
            else:
                why = self._check(f, bw, rx)
            if why:
                excluded.append({"id": m["id"], "name": m["name"], "freq_hz": f, "mode": mode, "why": why})
                continue
            chans.append({"id": m["id"], "name": m["name"], "freq": f, "mode": mode, "bw": bw, "mem": True,
                          "sq": sq, "asq": asq, "prio": bool(m.get("scan_prio")),
                          "lo": rx.lo_for(f) if not rx.chained else 0.0})
        return chans, excluded

    def _grid(self, opts, rx):
        from sdr import SQUELCH_OFF
        f0, f1, step = sorted((opts["from_hz"], opts["to_hz"])) + [opts["step_hz"]]
        n = int((f1 - f0) / step + 1e-6) + 1
        if n > MAX_CHANNELS:
            raise ValueError(f"the range has {n} channels, at most {MAX_CHANNELS} (a larger STEP or a smaller range)")
        mode, bw = opts["mode"], opts["bw"]
        if not opts["asq"] and rx.manual_squelch(mode) <= SQUELCH_OFF:
            raise ValueError(f"the squelch of {mode} is off: switch ASQ FOR ALL on or set the SQL bar")
        chans, excluded = [], []
        for k in range(n):
            f = float(round(f0 + k * step))
            why = self._check(f, bw, rx)
            if why:
                excluded.append({"id": f"g{int(f)}", "name": "", "freq_hz": f, "mode": mode, "why": why})
                continue
            chans.append({"id": f"g{int(f)}", "name": "", "freq": f, "mode": mode, "bw": bw, "mem": False,
                          "sq": None, "asq": None, "prio": False, "lo": rx.lo_for(f) if not rx.chained else 0.0})
        return chans, excluded

    def _windows(self, fs):
        """Channels -> tuner windows: neighbours that fit into SCAN_SPAN × fs with the same upconverter LO. The centre
        avoids the channels when it can (DC spike; in a dense range it cannot, the floor of that channel learns it)."""
        span = fs * SCAN_SPAN
        out = []
        start, n = 0, self.n
        while start < n:
            left = self.f[start] - self.bw[start] / 2
            m = (self.lo[start:] == self.lo[start]) & (self.f[start:] + self.bw[start:] / 2 - left <= span)
            k = len(m) if m.all() else max(int(np.argmin(m)), 1)
            g = slice(start, start + k)
            f, bw = self.f[g], self.bw[g]
            lo_e, hi_e = float((f - bw / 2).min()), float((f + bw / 2).max())
            mid = (lo_e + hi_e) / 2
            slack = max(0.0, (span - (hi_e - lo_e)) / 2)
            best, best_gap = mid, -np.inf
            for d in sorted(np.linspace(-slack, slack, 81), key=abs):
                gap = float((np.abs(f - (mid + d)) - bw / 2).min())
                if gap > best_gap:
                    best, best_gap = mid + d, gap
                if gap >= DC_GAP_HZ:
                    break
            out.append({"center": max(float(best), fs / 2), "tune": float(self.f[start]), "lo": float(self.lo[start])})
            self.win_of[g] = len(out) - 1
            start += k
        return out

    # ---------- receiver thread ----------

    def block(self, rx, backlog):
        """Called by the receiver once per block after the waterfall FFT (rx.wf_power is this block's spectrum)."""
        if self.cmds:
            self._commands(rx, backlog)
        if not self.on:
            return
        if self.settle > 0:
            self.settle -= 1
            self.audio_open = False
            return
        pw = rx.wf_power
        if pw is None:
            return
        now = time.monotonic()
        c = rx.cfg
        if c.get("gain") != self.gain_key:          # another gain: the measured floors no longer fit
            self.gain_key = c.get("gain")
            self.hist[:] = np.nan
            self.hn[:] = 0
        mask = getattr(rx, "spur_mask", None)
        if c.get("spur_on") and c.get("spur_lines") and mask is not None and len(mask) == len(pw):
            pw = pw * mask                          # spur mask: known spurs do not open channels
        idx = self._measure(rx, pw, now)
        self._rate_n += len(idx)
        if now - self._rate_t >= 1.0:
            self.rate = self._rate_n / (now - self._rate_t) if self._rate_t else 0.0
            self._rate_n, self._rate_t = 0, now
        if self.paused:
            return
        if self.state == "peek":
            self._peek_step(rx, idx, now, backlog)
            return
        if self.state == "listen":
            self._listen_step(rx, idx, now, backlog)
            return
        # search: the active channels of the band (strongest of overlapping neighbours), priority first
        act = self._candidates(idx, now)
        if act:
            pick = [i for i in act if self.prio[i]] or act
            if self.opts["pick"] == "strongest":
                i = max(pick, key=lambda j: self.power[j])
            else:
                i = min(pick, key=lambda j: (j - self.pos - 1) % self.n)
            self._listen(rx, i, now)
            return
        self.audio_open = False
        if len(self.windows) > 1:
            self._goto(rx, (self.win + 1) % len(self.windows), backlog)

    def _candidates(self, idx, now):
        """Active, not locked channels of the band; of overlapping neighbours only the strongest (a signal between
        two grid channels or leaking into the next one opens only one)."""
        out = []
        for i in idx[self.active[idx]]:
            i = int(i)
            if self._locked(i, now):
                continue
            ok = True
            for j in (i - 1, i + 1):
                if (0 <= j < self.n and self.vis[j] and self.active[j] and self.power[j] > self.power[i]
                        and abs(self.f[j] - self.f[i]) < (self.bw[i] + self.bw[j]) / 2):
                    ok = False
            if ok:
                out.append(i)
        return out

    def _listen_step(self, rx, idx, now, backlog):
        i = self.cur
        if not self.vis[i]:
            self.audio_open = False
            return
        if self.active[i]:
            self.last_active = now
            self.last[i] = time.time()
            if self.act:
                self.act["m_last"] = now
        if self.act and not np.isnan(self.power[i]):
            self.act["max"] = max(self.act["max"], float(self.power[i]))
            self.act["snr"] = max(self.act["snr"], float(self.power[i] - self.floor[i]))
        cm = self.opts["carrier_min"]
        if cm > 0 and self.active[i] and now - self.since[i] > cm * 60:
            self.locked[i] = float("inf")           # an open carrier / spur: out until STOP
            if self.act:
                self.act["note"] = "carrier lockout"
            self.message = f"carrier lockout: {self._label(i)}"
            self._resume(rx, backlog)
            return
        if not self.prio[i]:
            p = [int(j) for j in idx if self.prio[j] and self.active[j] and not self._locked(int(j), now)]
            if p:                                   # a priority channel in the band wins at once
                self._listen(rx, p[0], now)
                return
            if self._start_peek(rx, now, backlog):
                return
        r = self.opts["resume"]
        hang = CARRIER_HANG_S if r == "carrier" else self.opts["hang_s"]
        done = (now - self.last_active > hang or self._locked(i, now)
                or (r == "time" and now - self.listen_since > self.opts["time_s"]))
        if not done:
            self.audio_open = bool(self.active[i])
            return
        self._resume(rx, backlog)

    def _start_peek(self, rx, now, backlog):
        """Priority channels in other windows: a short look every prio_s while another channel is heard."""
        if self.opts["prio_s"] <= 0 or not self.prio_wins or now - self.last_peek < self.opts["prio_s"]:
            return False
        self.last_peek = now
        wins = [w for w in self.prio_wins if w != self.win]
        if not wins:
            return False
        self.peek = {"ret": self.win, "wins": wins, "k": 0, "t0": now}
        self.state, self.audio_open = "peek", False
        self._goto(rx, wins[0], backlog)
        return True

    def _peek_step(self, rx, idx, now, backlog):
        pk = self.peek
        p = [int(j) for j in idx if self.prio[j] and self.active[j] and not self._locked(int(j), now)]
        if p:
            self.peek = None
            self._listen(rx, p[0], now)
            return
        pk["k"] += 1
        if pk["k"] < len(pk["wins"]):
            self._goto(rx, pk["wins"][pk["k"]], backlog)
            return
        # back to the channel heard; the time away does not count into its hang / TIME
        self.peek = None
        self._goto(rx, pk["ret"], backlog)
        i = self.cur
        rx.scan_tune(self.f[i], self.meta[i]["mode"], self.bw[i])
        away = now - pk["t0"] + (SETTLE_BLOCKS + 1) * BLOCK_S
        self.last_active += away
        self.listen_since += away
        self.last_peek = now
        self.state = "listen"

    def _commands(self, rx, backlog):
        with self.lock:
            cmds, self.cmds = self.cmds, []
        now = time.monotonic()
        for action, kw in cmds:
            if action == "start":
                if self.on:
                    self._end_activity()
                self._install(kw)
                self.on, self.paused, self.state, self.cur, self.pos = True, False, "search", None, -1
                self.locked, self.gain_key = {}, rx.cfg.get("gain")
                self.rate, self._rate_n, self._rate_t = 0.0, 0, now
                self.message, self.rec_error, self.peek, self.last_peek = "", "", None, now
                self.stored, self._stored_ids = 0, set()
                if self.windows:
                    self._goto(rx, 0, backlog)
            elif not self.on:
                continue
            elif action == "stop":
                self._end_activity()
                self.on, self.paused, self.state, self.cur, self.audio_open = False, False, "off", None, False
                self.locked, self.peek = {}, None
            elif action == "pause":
                self._end_activity()
                if self.peek and self.cur is not None:   # back on the channel heard before holding there
                    self._goto(rx, self.peek["ret"], backlog)
                    rx.scan_tune(self.f[self.cur], self.meta[self.cur]["mode"], self.bw[self.cur])
                self.peek = None
                self.paused, self.state = True, "hold"
                self.message = kw.get("why", "")
            elif action == "resume":
                if self.paused:
                    self.paused, self.message = False, ""
                    self._resume(rx, backlog)
            elif action in ("skip", "lockout"):
                if self.cur is not None:
                    self.locked[self.cur] = now + SKIP_S if action == "skip" else float("inf")
                    self.paused, self.message, self.peek = False, "", None
                    self._resume(rx, backlog)
            elif action == "unlock":
                self.locked = {}
            elif action == "step":
                self.peek = None
                i = ((self.cur if self.cur is not None else self.pos) + int(kw.get("dir", 1))) % self.n
                self._listen(rx, i, now, count=False)
                self.paused, self.state, self.message = True, "hold", ""
            elif action == "update":                # a memory edited in the SCAN tab while scanning
                m = kw["mem"]
                for i, mt in enumerate(self.meta):
                    if mt["id"] != m["id"]:
                        continue
                    self.sq[i] = np.nan if m.get("scan_sq") is None else float(m["scan_sq"])
                    self.asq[i] = np.nan if m.get("scan_asq") is None else float(m["scan_asq"])
                    self.prio[i] = bool(m.get("scan_prio"))
                    if not m.get("scan", True):
                        self.locked[i] = float("inf")
                        if i == self.cur and not self.paused:
                            self._resume(rx, backlog)
                    elif self.locked.get(i) == float("inf"):
                        del self.locked[i]
                self.prio_wins = sorted({int(w) for w in self.win_of[self.prio] if w >= 0})

    def _install(self, kw):
        chans = kw["chans"]
        self._arrays(len(chans))
        self.meta = [{k: c[k] for k in ("id", "name", "freq", "mode", "bw", "mem")} for c in chans]
        self.modes = sorted({c["mode"] for c in chans})
        for i, c in enumerate(chans):
            self.f[i], self.bw[i], self.lo[i] = c["freq"], c["bw"], c["lo"]
            self.a[i], self.b[i] = passband(c["freq"], c["mode"], c["bw"])
            self.sq[i] = np.nan if c["sq"] is None else float(c["sq"])
            self.asq[i] = np.nan if c["asq"] is None else float(c["asq"])
            self.prio[i] = c["prio"]
            self.mi[i] = self.modes.index(c["mode"])
        self.opts, self.vfo = dict(kw["opts"]), kw["vfo"]
        self.n_excluded = len(kw["excluded"])
        self.excluded = kw["excluded"][:EXCLUDED_MAX]
        self.windows = [] if kw["chained"] else self._windows(kw["fs"])
        self.win = 0
        self.prio_wins = sorted({int(w) for w in self.win_of[self.prio] if w >= 0})

    def _measure(self, rx, pw, now):
        """Power, noise floor, level and activity of every channel in the band received now; returns their indices."""
        from sdr import ASQ_PCT, ASQ_PCT_BIAS_DB, ASQ_WIN_K, SQUELCH_OFF
        c = rx.cfg
        fs, center = rx.fs, c["center_hz"]
        n = len(pw)
        bin_hz = fs / n
        lo_edge = center - fs / 2
        cal = getattr(rx.sdr, "smeter_offset", 0.0)
        vis = np.abs(self.f - center) + self.bw / 2 <= fs / 2 * SCAN_SPAN
        if not rx.chained:
            vis &= self.lo == rx.lo
        self.vis = vis
        idx = np.nonzero(vis)[0]
        if not len(idx):
            return idx
        cs = np.concatenate(([0.0], np.cumsum(pw, dtype=np.float64)))
        lo, hi = int(n * (1 - SCAN_SPAN) / 2), int(n * (1 + SCAN_SPAN) / 2)
        mid = n // 2
        noise_bin = float(np.percentile(np.concatenate((pw[lo:mid - 4], pw[mid + 5:hi])), ASQ_PCT)) * ASQ_WIN_K / n
        i0 = np.clip(((self.a[idx] - lo_edge) / bin_hz).astype(int), 0, n - 1)
        i1 = np.clip(np.maximum(((self.b[idx] - lo_edge) / bin_hz).astype(int), i0 + 1), 0, n)
        db = 10 * np.log10((cs[i1] - cs[i0]) * ASQ_WIN_K / n + 1e-20) + cal
        self.power[idx] = db
        # the floor learns only from the quiet channel (a long transmission must not lift it and end itself); without
        # carrier lockout a channel open for RELEARN_S learns it (a carrier or a spur becomes its floor)
        act = self.active[idx]
        learn = ~act if self.opts["carrier_min"] > 0 else (~act | (now - self.since[idx] > RELEARN_S))
        li = idx[learn]
        self.hist[li, self.hpos[li]] = db[learn]
        self.hpos[li] = (self.hpos[li] + 1) % FLOOR_N
        self.hn[li] = np.minimum(self.hn[li] + 1, FLOOR_N)
        floor = 10 * np.log10(noise_bin * (i1 - i0) + 1e-20) + ASQ_PCT_BIAS_DB + cal
        own = self.hn[idx] >= FLOOR_MIN_N
        if own.any():
            floor[own] = np.nanpercentile(self.hist[idx[own]], FLOOR_PCT, axis=1)
        self.floor[idx] = floor
        asq = self.asq[idx]
        auto = floor + np.where(np.isnan(asq), self.opts["margin"], asq)
        if not self.opts["asq"]:
            man = np.array([rx.manual_squelch(m) for m in self.modes])[self.mi[idx]]
            auto = np.where(np.isnan(asq) & (man > SQUELCH_OFF), man, auto)
        level = np.where(np.isnan(self.sq[idx]), auto, self.sq[idx])
        self.level[idx] = level
        new = db > np.where(act, level - HYST_DB, level)
        self.since[idx[new & ~act]] = now
        self.active[idx] = new
        return idx

    def _locked(self, i, now):
        until = self.locked.get(i)
        if until is None:
            return False
        if until < now:
            del self.locked[i]
            return False
        return True

    def _label(self, i):
        m = self.meta[i]
        return m["name"] or f"{m['freq'] / 1e6:.4f} MHz"

    def _listen(self, rx, i, now, count=True):
        self._end_activity()
        self.pos, self.cur, self.state = i, i, "listen"
        self.listen_since = self.last_active = now
        self.audio_open = count
        if self.win_of[i] >= 0:
            self.win = int(self.win_of[i])
        if count:
            self.hits[i] += 1
            self.last[i] = time.time()
            p = float(self.power[i]) if not np.isnan(self.power[i]) else -150.0
            fl = float(self.floor[i]) if not np.isnan(self.floor[i]) else p
            self.act = {"i": i, "t0": time.time(), "m0": now, "m_last": now, "max": p, "snr": p - fl, "note": "",
                        "file": ""}
        rx.scan_tune(self.f[i], self.meta[i]["mode"], self.bw[i])

    def _resume(self, rx, backlog):
        """After listening: search again; with more windows the next window first (so one busy band does not
        keep the scan for itself)."""
        self._end_activity()
        self.state, self.cur, self.audio_open, self.peek = "search", None, False, None
        if len(self.windows) > 1:
            self._goto(rx, (self.win + 1) % len(self.windows), backlog)

    def _goto(self, rx, k, backlog):
        self.win = k
        w = self.windows[k]
        rx.scan_center(w["center"], w["tune"])
        self.settle = SETTLE_BLOCKS + backlog

    # ---------- activity: log, recording, store ----------

    def _end_activity(self):
        a, self.act = self.act, None
        self._rec_close()
        if not a:
            return
        m = self.meta[a["i"]]
        dur = max(a["m_last"] - a["m0"], 0.0) + BLOCK_S
        entry = {"time_utc": time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(a["t0"])), "vfo": self.vfo,
                 "freq_hz": int(round(m["freq"])), "name": m["name"], "mode": m["mode"], "duration_s": round(dur, 1),
                 "max_dbfs": round(a["max"], 1), "snr_db": round(a["snr"], 1), "file": a["file"], "note": a["note"]}
        self.log.appendleft(entry)
        if self.opts["log"]:
            try:
                os.makedirs(LOG_DIR, exist_ok=True)
                path = log_path(a["t0"])
                buf = io.StringIO()
                w = csv.DictWriter(buf, LOG_FIELDS, lineterminator="\n")
                if not os.path.exists(path):
                    w.writeheader()
                w.writerow(entry)
                with open(path, "a", encoding="utf-8", newline="") as f:
                    f.write(buf.getvalue())
            except OSError:
                pass                                # a full disk / locked file must not stop the scan
        if (self.opts["store"] and not m["mem"] and dur >= STORE_MIN_S and m["id"] not in self._stored_ids
                and self.on_store and not a["note"]):
            self._stored_ids.add(m["id"])
            self.stored += 1
            self.on_store({"name": f"{m['freq'] / 1e6:.5f}".rstrip("0").rstrip("."), "freq_hz": int(round(m["freq"])),
                           "mode": m["mode"], "bw": m["bw"], "groups": [f"Scan {time.strftime('%Y-%m-%d')}"]})

    def audio(self, audio, fs):
        """Demodulated audio of this block before the squelch (receiver thread): recording of the activity heard.
        Blocks while the signal is there (+ REC_TAIL_S) are written; when it comes back in the hang, the last
        REC_PRE_S before it is written first, so the start of the reply is not cut off."""
        a = self.act
        if not (self.opts["rec"] and a and self.state == "listen" and not self.paused):
            return
        mono = audio if audio.ndim == 1 else audio.mean(axis=1)
        pcm = (np.clip(mono, -1, 1) * 32767).astype("<i2").tobytes()
        secs = len(mono) / fs
        on = bool(self.active[a["i"]]) or time.monotonic() - self.last_active <= REC_TAIL_S
        if not on:
            self.rec_pre.append(pcm)
            self.rec_pre_s += secs
            while self.rec_pre and self.rec_pre_s > REC_PRE_S + secs:
                self.rec_pre_s -= len(self.rec_pre.popleft()) / 2 / fs
            return
        if self.rec_wav is None:
            if a["file"]:
                return                              # REC_MAX_S reached: the rest is not recorded
            try:
                folder = rec_folder()
                os.makedirs(folder, exist_ok=True)
                m = self.meta[a["i"]]
                name = safe_name(m["name"])
                fn = (f"{name + '_' if name else ''}{m['freq'] / 1e6:.6f}MHz_{m['mode']}_"
                      f"{time.strftime('%Y%m%d_%H%M%S', time.localtime(a['t0']))}.wav")
                self.rec_wav = wave.open(os.path.join(folder, fn), "wb")
                self.rec_wav.setnchannels(1)
                self.rec_wav.setsampwidth(2)
                self.rec_wav.setframerate(int(round(fs)))
                a["file"], self.rec_file, self.rec_s = fn, fn, 0.0
            except OSError as e:
                self.rec_error, self.rec_wav = f"scan recording off: {e}", None
                self.opts["rec"] = False
                return
        try:
            for p in self.rec_pre:
                self.rec_wav.writeframes(p)
            self.rec_wav.writeframes(pcm)
            self.rec_s += secs
        except OSError as e:
            self.rec_error = f"scan recording: {e}"
            self._rec_close()
            return
        self.rec_pre.clear()
        self.rec_pre_s = 0.0
        if self.rec_s >= REC_MAX_S:
            self._rec_close()

    def _rec_close(self):
        if self.rec_wav is not None:
            try:
                self.rec_wav.close()
            except OSError:
                pass
            self.rec_wav = None
        self.rec_pre.clear()
        self.rec_pre_s = 0.0

    # ---------- for the web page ----------

    def info(self, full=False):
        cur = self.cur if self.on else None
        now = time.monotonic()
        o = self.opts
        rng = [min(o["from_hz"], o["to_hz"]), max(o["from_hz"], o["to_hz"])] if o["source"] in ("range", "view") else None

        def num(v):
            return None if v is None or np.isnan(v) else round(float(v), 1)

        out = {"on": self.on, "paused": self.paused, "state": self.state, "opts": o, "rate": round(self.rate, 1),
               "channels": self.n if self.on else 0, "windows": len(self.windows) or (1 if self.on else 0),
               "window": self.win + 1 if self.windows else (1 if self.on else 0), "excluded": self.n_excluded,
               "locked": len(self.locked), "message": self.message or self.rec_error, "stored": self.stored,
               "range": rng if self.on else None, "rec_file": self.rec_file if self.rec_wav is not None else "",
               "locked_f": [float(self.f[i]) for i in list(self.locked)[:200]] if self.on else [],
               "cur": {"id": self.meta[cur]["id"], "name": self.meta[cur]["name"], "freq_hz": float(self.f[cur]),
                       "mode": self.meta[cur]["mode"], "power": num(self.power[cur]), "level": num(self.level[cur]),
                       "prio": bool(self.prio[cur])} if cur is not None else None}
        if full:
            rows = range(self.n) if self.on else []
            if o["source"] in ("range", "view"):
                rows = [i for i in rows if self.hits[i] or self.active[i] or i in self.locked or i == cur][:LIST_MAX]
            out["list"] = [{"id": self.meta[i]["id"], "name": self.meta[i]["name"], "freq_hz": float(self.f[i]),
                            "mode": self.meta[i]["mode"], "power": num(self.power[i]), "floor": num(self.floor[i]),
                            "level": num(self.level[i]), "active": bool(self.active[i]), "hits": int(self.hits[i]),
                            "last": float(self.last[i]) or None,
                            "locked": i in self.locked and self.locked[i] >= now,
                            "lock_s": None if self.locked.get(i, 0) in (0, float("inf"))
                            else round(self.locked[i] - now)} for i in rows]
            out["excluded_list"] = self.excluded
            out["log"] = list(self.log)[:200]
        return out
