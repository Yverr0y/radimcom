"""Scanner (SCAN tab; design in data/poznamky_scan.md, steps 1–5).

It runs inside the receiver thread: Receiver._loop calls block() once per block, right after the waterfall FFT, so it
retunes without the delay of the web API. It does not step through the channels one by one: every block measures the
power of all channels in the band the dongle receives now from the fine FFT of the waterfall (wf_power, spur mask
applied when SP is on), so a whole tuner window is checked in one block (~85 ms at 1.536 MS/s). The tuner is retuned
only to reach the next window; the channels are sorted into windows of SCAN_SPAN × sample rate.

Sources: memories (ALL, FAVOURITES or a group) or a RANGE FROM / TO / STEP / MODE / BW (a grid of channels; MODE only
AM or FM: the modes a squelch can scan). FM BCAST: the broadcast band 88–108 MHz in WFM, its own algorithm (see FMBC_*):
a station is found by the power of the core of its channel and must be the local maximum of its neighbours, so the VFO
lands on the centre of the station and not on its side. VIEW
(VISIBLE BAND) is a grid over the part of the spectrum shown by the page; the tuner is not moved for it (no windows:
the spectrum and waterfall stay as they are), so only what the dongle receives now is scanned. All channels are kept in numpy arrays, so a range of
thousands of channels costs only a few ms per block.

Squelch of a channel: its own level (scan_sq of a memory), or its noise floor + a margin (scan_asq of a memory, or the
margin of the scan with AUTO SQUELCH), or else the squelch level of its mode (when that squelch is off: the noise floor
+ margin again, so a channel never stays open for good). Noise floor: a low percentile of its
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
VIEW_SPAN = 0.88        # VISIBLE BAND: the tuner stays where it is; this part of its band is scanned (below the 0.9
                        # at which tuning a channel would move the centre)
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
# the log is read by position (older files have no "session" column; their header row is skipped)
LOG_FIELDS = ("time_utc", "vfo", "freq_hz", "name", "mode", "duration_s", "max_dbfs", "snr_db", "file", "note",
              "session")
RESUME_MODES = ("delay", "carrier", "time")
# options a running scan takes over at once (the others choose what is scanned: they need START)
LIVE_OPTS = ("asq", "margin", "resume", "hang_s", "time_s", "pick", "store", "rec", "carrier_min", "prio_s", "fm_s")
SOURCES = ("all", "fav", "group", "range", "view", "fmbc")
GRID_SOURCES = ("range", "view", "fmbc")
MEM_SOURCES = ("all", "fav", "group")
PICKS = ("next", "strongest")
MODES = ("AM", "FM")      # RANGE / VISIBLE BAND: SSB / CW have no carrier for a squelch, WFM has FM BCAST
# FM BCAST: a grid of 50 kHz (the 100 kHz raster and the stations between it). Only the core ±FMBC_CORE/2 of a channel
# is measured: the energy of a broadcast FM signal is the densest at its centre, so the channel on the station is
# stronger than those 50 / 100 kHz beside it (on its side), and the cores of the neighbours do not overlap. The tuner
# centre is put between two grid points (FMBC_DC_OFF), out of every core (DC spike). A station stays on the air for
# good: it is heard fm_s seconds (LISTEN) and the scan goes on to the next station up the band (no carrier lockout,
# the floor learns only from a quiet channel).
FMBC_FROM, FMBC_TO, FMBC_STEP = 88e6, 108e6, 50000.0
FMBC_CORE = 36000.0
FMBC_NEAR = 2             # a station is the strongest of the grid channels ±FMBC_NEAR around it (±100 kHz)
FMBC_CHECK = 3            # a station found: its centre = the strongest ±FMBC_NEAR summed over this many blocks (the
                          # core power of FM goes up and down with the audio, one block could pick its side)
FMBC_DC_OFF = 25000.0     # window centre: halfway between two grid points
FMBC_BW_MIN = 150000.0    # tuned bandwidth: that of the VFO for WFM, at least this
DEFAULTS = {"source": "all", "mem": "all", "group": "", "asq": True, "margin": 6.0, "resume": "delay", "hang_s": 2.0,
            "time_s": 10.0, "from_hz": 118e6, "to_hz": 136.99167e6, "step_hz": 25000 / 3, "mode": "AM",
            "bw": 8000.0, "pick": "next", "store": False, "rec": False, "carrier_min": 3.0,
            "prio_s": 3.0, "keep_days": 31, "fm_s": 8.0}
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
    for k, allowed in (("source", SOURCES), ("mem", MEM_SOURCES), ("resume", RESUME_MODES), ("pick", PICKS),
                       ("mode", MODES)):
        if k in o:
            if o[k] not in allowed:
                raise ValueError(f"unknown scan {k}")
            out[k] = o[k]
    if "group" in o:
        out["group"] = str(o["group"] or "")[:40]
    for k in ("asq", "store", "rec"):
        if k in o:
            out[k] = bool(o[k])
    for k, lo, hi in (("margin", 1.0, 30.0), ("hang_s", 0.0, 60.0), ("time_s", 1.0, 600.0), ("from_hz", 0.0, 6e9),
                      ("to_hz", 0.0, 6e9), ("step_hz", 100.0, 1e6), ("bw", 100.0, 250000.0),
                      ("carrier_min", 0.0, 120.0), ("prio_s", 0.0, 60.0), ("keep_days", 1, 365),
                      ("fm_s", 1.0, 600.0)):
        if k in o:
            v = float(o[k])
            if not lo <= v <= hi:
                raise ValueError(f"scan {k} must be {lo:g} to {hi:g}")
            out[k] = int(v) if k == "keep_days" else v
    if out["source"] in MEM_SOURCES:
        out["mem"] = out["source"]
    if out["mode"] not in MODES:                    # saved by an older version (WFM, USB …)
        out["mode"] = "FM" if out["mode"] == "WFM" else "AM"
    return out


def signature(o):
    """What is scanned: a scan of another source / range starts a new session (ACTIVITY and HEATMAP of THIS SCAN)."""
    if o["source"] in MEM_SOURCES:
        return f"mem:{o['source']}:{o['group'] if o['source'] == 'group' else ''}"
    if o["source"] == "fmbc":
        return "fmbc"
    return (f"range:{round(min(o['from_hz'], o['to_hz']))}-{round(max(o['from_hz'], o['to_hz']))}"
            f"/{round(o['step_hz'])}/{o['mode']}/{round(o['bw'])}")


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


def read_log(days=1, limit=None, now=None, session=None):
    """Activities of the last `days` days (all VFOs), newest first; with `session` only those of that scan session."""
    now = now or time.time()
    rows = []
    for d in range(int(days) - 1, -1, -1):
        try:
            with open(log_path(now - d * 86400), encoding="utf-8", newline="") as f:
                for rec in csv.reader(f):
                    if not rec or rec[0] in ("", "time_utc"):
                        continue
                    r = dict(zip(LOG_FIELDS, rec + [""] * (len(LOG_FIELDS) - len(rec))))
                    if session is None or r["session"] == session:
                        rows.append(r)
        except OSError:
            continue
    rows.reverse()
    return rows[:limit] if limit else rows


def prune(keep_days, now=None):
    """History kept keep_days days: older scan_*.csv logs and WAV recordings of the scan are deleted.
    Returns the number of files deleted."""
    now = now or time.time()
    keep = time.strftime("%Y-%m-%d", time.gmtime(now - (int(keep_days) - 1) * 86400))
    gone = 0
    try:
        for fn in os.listdir(LOG_DIR):
            m = re.fullmatch(r"scan_(\d{4}-\d{2}-\d{2})\.csv", fn)
            if m and m.group(1) < keep:
                try:
                    os.remove(os.path.join(LOG_DIR, fn))
                    gone += 1
                except OSError:
                    pass
    except OSError:
        pass
    try:
        folder = rec_folder()
        for fn in os.listdir(folder):
            path = os.path.join(folder, fn)
            if fn.lower().endswith(".wav") and os.path.getmtime(path) < now - int(keep_days) * 86400:
                try:
                    os.remove(path)
                    gone += 1
                except OSError:
                    pass
    except OSError:
        pass
    return gone


def heatmap(days=7, top=60, now=None, session=None):
    """Occupancy: frequency × hour of the day (local time) from the log, seconds of activity.
    {"days", "rows": [{"freq_hz", "name", "mode", "total", "count", "hours": [24 × s]}]}: the `top` busiest, by
    frequency."""
    import calendar
    acc = {}
    for r in read_log(days, now=now, session=session):
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
        self.windows = []             # tuner windows [{"center", "tune", "lo"}]; [] = the tuner is not moved
                                      # (chained VFO: band of the owner; VISIBLE BAND: the spectrum stays as shown)
        self.span = SCAN_SPAN         # part of the dongle band measured
        self.fm = False               # FM BCAST (its own search, see FMBC_*)
        self.fm_chk = None            # FM BCAST: a station found, its centre being checked
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
        self.session = ""             # scan session (app.py): written with each activity
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

    def start(self, mems, opts, rx, session=""):
        """Builds the channels (memories or a range); returns an error text, or None when the scan starts.
        session: id written with each activity (ACTIVITY / HEATMAP of THIS SCAN)."""
        try:
            chans, excluded = (self._fmbc(rx) if opts["source"] == "fmbc"
                               else self._grid(opts, rx) if opts["source"] in GRID_SOURCES
                               else self._from_mems(mems, opts, rx))
        except ValueError as e:
            return str(e)
        if not chans:
            with self.lock:                         # the State column shows why (the scan does not run)
                if not self.on:
                    self.excluded, self.n_excluded = excluded[:EXCLUDED_MAX], len(excluded)
            why = sorted({x["why"] for x in excluded})
            return "no channel to scan" + (f" ({len(excluded)} left out: {'; '.join(why[:2])})" if excluded else "")
        chans.sort(key=lambda c: (c["lo"], c["freq"]))
        fixed = opts["source"] == "view"
        self.command("start", chans=chans, excluded=excluded, opts=opts, chained=rx.chained or fixed, fs=rx.fs,
                     span=VIEW_SPAN if fixed else SCAN_SPAN,
                     vfo=rx.cfg.get("vfo") or "", session=session)
        return None

    @staticmethod
    def _check(f, bw, rx, fixed=False):
        """Why a channel cannot be scanned on this VFO, or None. fixed: VISIBLE BAND, the tuner is not moved."""
        lo_hz, hi_hz = rx.tune_range()
        if not lo_hz <= f <= hi_hz:
            return "outside the range of this VFO"
        if fixed and not rx.chained and abs(f - rx.cfg["center_hz"]) + bw / 2 > rx.fs / 2 * VIEW_SPAN:
            return "at the edge of the band of the dongle (VISIBLE BAND does not move the spectrum)"
        if rx.chained and abs(f - rx.cfg["center_hz"]) + bw / 2 > rx.fs / 2 * SCAN_SPAN:
            return "outside the band of the shared dongle (chained VFO)"
        return None

    def _from_mems(self, mems, opts, rx):
        from sdr import DSD_MODE
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
            elif m.get("dab_channel") or mode in (DSD_MODE, "DAB"):
                why = "DAB / DSD memories are not scanned"
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
        f0, f1, step = sorted((opts["from_hz"], opts["to_hz"])) + [opts["step_hz"]]
        n = int((f1 - f0) / step + 1e-6) + 1
        if n > MAX_CHANNELS:
            raise ValueError(f"the range has {n} channels, at most {MAX_CHANNELS} (a larger STEP or a smaller range)")
        mode, bw = opts["mode"], opts["bw"]
        chans, excluded = [], []
        fixed = opts["source"] == "view"
        for k in range(n):
            f = float(round(f0 + k * step))
            why = self._check(f, bw, rx, fixed)
            if why:
                excluded.append({"id": f"g{int(f)}", "name": "", "freq_hz": f, "mode": mode, "why": why})
                continue
            chans.append({"id": f"g{int(f)}", "name": "", "freq": f, "mode": mode, "bw": bw, "mem": False,
                          "sq": None, "asq": None, "prio": False,
                          "lo": 0.0 if rx.chained else rx.lo if fixed else rx.lo_for(f)})
        return chans, excluded

    def _fmbc(self, rx):
        """FM BCAST: 88–108 MHz every 50 kHz in WFM; mbw = the core measured, bw = the bandwidth tuned."""
        bw = max(float((rx.cfg.get("bandwidth") or {}).get("WFM") or 200000), FMBC_BW_MIN)
        chans, excluded = [], []
        for k in range(int(round((FMBC_TO - FMBC_FROM) / FMBC_STEP)) + 1):
            f = FMBC_FROM + k * FMBC_STEP
            why = self._check(f, FMBC_CORE, rx)
            if why:
                excluded.append({"id": f"g{int(f)}", "name": "", "freq_hz": f, "mode": "WFM", "why": why})
                continue
            chans.append({"id": f"g{int(f)}", "name": "", "freq": f, "mode": "WFM", "bw": bw, "mbw": FMBC_CORE,
                          "mem": False, "sq": None, "asq": None, "prio": False,
                          "lo": 0.0 if rx.chained else rx.lo_for(f)})
        return chans, excluded

    def _windows(self, fs):
        """Channels -> tuner windows: neighbours that fit into SCAN_SPAN × fs with the same upconverter LO. The centre
        avoids the channels when it can (DC spike; in a dense range it cannot, the floor of that channel learns it)."""
        span = fs * SCAN_SPAN - (2 * FMBC_DC_OFF if self.fm else 0.0)   # FM BCAST: room to move the centre
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
            if self.fm:                             # between two grid points: out of every core
                best = round((best - FMBC_DC_OFF) / FMBC_STEP) * FMBC_STEP + FMBC_DC_OFF
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
        if self.fm:
            self._fm_search(rx, act, backlog, now)
            return
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

    def _fm_search(self, rx, act, backlog, now):
        """FM BCAST: the next station up the band in this window, else the next window (from its bottom after the top
        of the band). A station is on the air for good: it is not looked for again in the same sweep."""
        self.audio_open = False
        chk = self.fm_chk
        if chk is not None:                         # the centre: the strongest ±FMBC_NEAR over FMBC_CHECK blocks
            js = chk["js"]
            p = np.where(self.vis[js] & ~np.isnan(self.power[js]), self.power[js], -200.0)
            chk["acc"] += 10 ** (p / 10)
            chk["n"] += 1
            if chk["n"] < FMBC_CHECK:
                return
            self.fm_chk = None
            j = int(js[int(np.argmax(chk["acc"]))])
            if j <= self.pos + 1 or self._locked(j, now):
                j = chk["i"]                        # not back onto the station just heard
            self._listen(rx, j, now)
            return
        # +1: the grid point just above the station heard is its side, not another station
        ahead = [i for i in act if i > self.pos + (1 if self.pos >= 0 else 0)]
        if ahead:
            i = min(ahead)
            js = np.arange(max(i - FMBC_NEAR, 0), min(i + FMBC_NEAR, self.n - 1) + 1)
            self.fm_chk = {"i": i, "js": js, "acc": np.zeros(len(js)), "n": 0}
            return
        if len(self.windows) > 1:
            k = (self.win + 1) % len(self.windows)
            if k == 0:
                self.pos = -1
            self._goto(rx, k, backlog)
        elif act:
            self.pos = -1                           # one window: from the bottom again in the next block

    def _candidates(self, idx, now):
        """Active, not locked channels of the band; of overlapping neighbours only the strongest (a signal between
        two grid channels or leaking into the next one opens only one)."""
        out = []
        for i in idx[self.active[idx]]:
            i = int(i)
            if self._locked(i, now):
                continue
            ok = True
            if self.fm:                             # FM BCAST: the strongest of its neighbours (the station centre)
                for j in range(i - FMBC_NEAR, i + FMBC_NEAR + 1):
                    if j != i and 0 <= j < self.n and self.vis[j] and self.power[j] > self.power[i]:
                        ok = False
                if ok:
                    out.append(i)
                continue
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
        if self.fm and self.act and getattr(rx, "wfm", None) is not None and getattr(rx.wfm, "rds", None) is not None:
            ps = rx.wfm.rds.info().get("ps", "").strip()
            if ps:
                self.act["ps"] = ps                 # RDS: the name of the station (ACTIVITY, STORE FOUND)
        cm = 0 if self.fm else self.opts["carrier_min"]
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
        r = "time" if self.fm else self.opts["resume"]
        hang = CARRIER_HANG_S if r == "carrier" else self.opts["hang_s"]
        done = (now - self.last_active > hang or self._locked(i, now)
                or (r == "time" and now - self.listen_since > self.opts["fm_s" if self.fm else "time_s"]))
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
        rx.scan_tune(self.f[i], self.meta[i]["mode"], self.meta[i]["bw"])
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
                if self.meta and not self.meta[0]["mem"]:   # RANGE / VISIBLE BAND: the VFO shows the mode scanned
                    m = self.meta[0]                        # at once (a memory scan takes the mode of each channel)
                    rx.cfg["mode"] = m["mode"]
                    rx.cfg.setdefault("bandwidth", {})[m["mode"]] = float(m["bw"])
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
                    rx.scan_tune(self.f[self.cur], self.meta[self.cur]["mode"], self.meta[self.cur]["bw"])
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
            elif action == "opts":                 # ⚙ / REC / STORE changed while scanning (not what is scanned)
                for k in LIVE_OPTS:
                    if k in kw["opts"]:
                        self.opts[k] = kw["opts"][k]
                if not self.opts["rec"]:
                    self._rec_close()
                self.rec_error = ""
            elif action == "session":              # CLR: the activities from now on belong to a new session
                a = self.act
                self._end_activity()
                self.session = kw.get("session", "")
                if a:                               # the channel heard goes on as a new activity of the new session
                    self.act = dict(a, t0=time.time(), m0=now, m_last=now, file="", note="")
            elif action == "unlock" and kw.get("id") is None:
                self.locked = {}
            elif action in ("lock", "unlock"):       # x in a row of the CHANNELS table
                for i, mt in enumerate(self.meta):
                    if mt["id"] != kw["id"]:
                        continue
                    if action == "unlock":
                        self.locked.pop(i, None)
                        continue
                    self.locked[i] = float("inf")
                    if i == self.cur:
                        self.paused, self.message, self.peek = False, "", None
                        self._resume(rx, backlog)
            elif action == "step":
                self.peek = None
                d = 1 if int(kw.get("dir", 1)) >= 0 else -1
                i0 = self.cur if self.cur is not None else self.pos
                i = (i0 + d) % self.n
                if self.fm:                         # FM BCAST: to the next station found (else the next grid point)
                    found = [j for j in range(self.n) if self.hits[j] or self.active[j]]
                    nxt = [j for j in found if (j - i0) * d > 0]
                    if nxt:
                        i = min(nxt, key=lambda j: abs(j - i0))
                    elif found:
                        i = min(found) if d > 0 else max(found)
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
        self.fm = kw["opts"].get("source") == "fmbc"
        self.fm_chk = None
        for i, c in enumerate(chans):
            mbw = c.get("mbw", c["bw"])             # width measured (FM BCAST: the core of the channel)
            self.f[i], self.bw[i], self.lo[i] = c["freq"], mbw, c["lo"]
            self.a[i], self.b[i] = passband(c["freq"], c["mode"], mbw)
            self.sq[i] = np.nan if c["sq"] is None else float(c["sq"])
            self.asq[i] = np.nan if c["asq"] is None else float(c["asq"])
            self.prio[i] = c["prio"]
            self.mi[i] = self.modes.index(c["mode"])
        self.opts, self.vfo, self.session = dict(kw["opts"]), kw["vfo"], kw.get("session", "")
        self.n_excluded = len(kw["excluded"])
        self.excluded = kw["excluded"][:EXCLUDED_MAX]
        self.span = kw.get("span", SCAN_SPAN)
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
        vis = np.abs(self.f - center) + self.bw / 2 <= fs / 2 * self.span
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
        learn = ~act if self.opts["carrier_min"] > 0 or self.fm else (~act | (now - self.since[idx] > RELEARN_S))
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
        rx.scan_tune(self.f[i], self.meta[i]["mode"], self.meta[i]["bw"])

    def _resume(self, rx, backlog):
        """After listening: search again; with more windows the next window first (so one busy band does not
        keep the scan for itself)."""
        self._end_activity()
        self.state, self.cur, self.audio_open, self.peek, self.fm_chk = "search", None, False, None, None
        if len(self.windows) > 1 and not self.fm:   # FM BCAST: the next station of this window first
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
        name = m["name"] or a.get("ps", "")
        dur = max(a["m_last"] - a["m0"], 0.0) + BLOCK_S
        entry = {"time_utc": time.strftime("%Y-%m-%d %H:%M:%SZ", time.gmtime(a["t0"])), "vfo": self.vfo,
                 "freq_hz": int(round(m["freq"])), "name": name, "mode": m["mode"], "duration_s": round(dur, 1),
                 "max_dbfs": round(a["max"], 1), "snr_db": round(a["snr"], 1), "file": a["file"], "note": a["note"],
                 "session": self.session}
        self.log.appendleft(entry)
        try:                                        # always written: ACTIVITY and HEATMAP read it
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
            pass                                    # a full disk / locked file must not stop the scan
        if (self.opts["store"] and not m["mem"] and dur >= STORE_MIN_S and m["id"] not in self._stored_ids
                and self.on_store and not a["note"]):
            self._stored_ids.add(m["id"])
            self.stored += 1
            group = "FM" if self.fm else "Scan"
            self.on_store({"name": name or f"{m['freq'] / 1e6:.5f}".rstrip("0").rstrip("."),
                           "freq_hz": int(round(m["freq"])), "mode": m["mode"], "bw": m["bw"],
                           "groups": [f"{group} {time.strftime('%Y-%m-%d')}"]})

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
        rng = [min(o["from_hz"], o["to_hz"]), max(o["from_hz"], o["to_hz"])] if o["source"] in GRID_SOURCES else None
        if o["source"] == "fmbc":
            rng = [FMBC_FROM, FMBC_TO]

        def num(v):
            return None if v is None or np.isnan(v) else round(float(v), 1)

        out = {"on": self.on, "paused": self.paused, "state": self.state, "opts": o, "rate": round(self.rate, 1),
               "channels": self.n if self.on else 0, "windows": len(self.windows) or (1 if self.on else 0),
               "window": self.win + 1 if self.windows else (1 if self.on else 0), "excluded": self.n_excluded,
               "locked": len(self.locked), "session": self.session, "message": self.message or self.rec_error, "stored": self.stored,
               "range": rng if self.on else None, "rec_file": self.rec_file if self.rec_wav is not None else "",
               "locked_f": [float(self.f[i]) for i in list(self.locked)[:200]] if self.on else [],
               "cur": {"id": self.meta[cur]["id"], "name": self.meta[cur]["name"], "freq_hz": float(self.f[cur]),
                       "mode": self.meta[cur]["mode"], "power": num(self.power[cur]), "level": num(self.level[cur]),
                       "prio": bool(self.prio[cur])} if cur is not None else None}
        if full:
            rows = range(self.n) if self.on else []
            if o["source"] in GRID_SOURCES:
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
