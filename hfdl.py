"""HFDL decoder: raw SDR samples -> dumphfdl.exe (lib\\hfdl\\) -> HFDL messages (ACARS, positions, logons).

HFDL (High Frequency Data Link, ARINC 635) is the aircraft data link on HF: 16 ground stations around the world,
each on several channels between about 2.9 and 22 MHz, USB-like 1800 Bd PSK, 300-1800 bit/s. It carries ACARS
(also CPDLC / ADS-C inside ACARS) of aircraft over oceans and remote areas, and the ground stations send a
"squitter" every 32 s on each active channel, so something is heard even without aircraft traffic.

The decoding (demodulation, FEC, MPDU / LPDU / HFNPDU, ACARS) is done by dumphfdl (Tomasz Lemiech, GPLv3,
https://github.com/szpajder/dumphfdl), which runs as a separate process: it reads I/Q samples on its standard
input and writes one JSON object per message.

    receiver thread --raw bytes--> queue --writer thread--> dumphfdl stdin
    dumphfdl stdout --reader thread--> JSON -> on_event("hfdl", record)

Unlike VDL2, HFDL keeps the sample rate and centre of the VFO (its audio is muted, like ACARS / VDL2): all HFDL channels of the
system table (lib\\hfdl\\systable.conf) that lie inside the received band are decoded at once. A change of
the centre or of the sample rate restarts dumphfdl with the new channel list (after the VFO has settled).
"""
import collections
import json
import os
import queue
import re
import subprocess
import threading
import time

import numpy as np

from paths import BASE

EXE = os.path.join(BASE, "lib", "hfdl", "dumphfdl.exe")
SYSTABLE = os.path.join(BASE, "lib", "hfdl", "systable.conf")    # ground stations: id, name, position, channels
EDGE_HZ = 12000          # a channel must be this far inside the received band (filter edges, anti-alias roll-off)
DC_HZ = 1500             # a channel this close to the centre would sit on the DC spike of the dongle
SETTLE_S = 1.5           # the VFO must stay this long at a new centre / rate before dumphfdl restarts
RETRY_S = 10.0           # dumphfdl ended by itself: the next start not sooner
BAND_GAP_KHZ = 500       # channels closer than this belong to one band (button)
MAX_HISTORY = 500
LOOKUP_CACHE_S = 60      # ADS-B data of an aircraft is fetched again after a minute at the earliest (it moves)
LOOKUP_GAP_S = 1.1       # adsb.fi allows 1 request per second
SPDU_NAME = "Squitter"

# Fallback when the system table is missing: HFDL frequency allocations (ITU aeronautical HF bands), kHz.
DEFAULT_BANDS = ((2941, 3016), (3455, 3497), (4654, 4687), (5451, 5720), (6529, 6712), (8825, 8977),
                 (10027, 10084), (11184, 11387), (13264, 13351), (15025, 15025), (17901, 17985), (21928, 21997))


def load_systable(path=SYSTABLE):
    """Ground stations from dumphfdl's systable.conf (libconfig format): [{id, name, lat, lon, freqs_khz}]."""
    try:
        with open(path, encoding="utf-8") as f:
            text = f.read()
    except OSError:
        return []
    stations = []
    for block in re.findall(r"\{([^{}]*)\}", text):
        sid = re.search(r"\bid\s*=\s*(\d+)", block)
        freqs = re.search(r"frequencies\s*=\s*\(([^)]*)\)", block)
        if not sid or not freqs:
            continue
        name = re.search(r'name\s*=\s*"([^"]*)"', block)
        lat = re.search(r"\blat\s*=\s*(-?[\d.]+)", block)
        lon = re.search(r"\blon\s*=\s*(-?[\d.]+)", block)
        stations.append({"id": int(sid.group(1)), "name": name.group(1) if name else f"GS {sid.group(1)}",
                         "lat": float(lat.group(1)) if lat else None, "lon": float(lon.group(1)) if lon else None,
                         "freqs_khz": sorted(float(x) for x in re.findall(r"[\d.]+", freqs.group(1)))})
    return stations


STATIONS = load_systable()
GS_NAMES = {s["id"]: s["name"] for s in STATIONS}
# every HFDL channel: kHz -> names of the ground stations using it
CHANNELS = collections.defaultdict(list)
for _s in STATIONS:
    for _f in _s["freqs_khz"]:
        CHANNELS[_f].append(_s["name"])
CHANNELS = dict(sorted(CHANNELS.items()))


def _bands():
    """Groups of neighbouring channels: [{lo, hi, center, n}] in Hz, for the band buttons and the page."""
    freqs = list(CHANNELS)
    if not freqs:
        return [{"lo": lo * 1000, "hi": hi * 1000, "center": (lo + hi) * 500, "n": 0}
                for lo, hi in DEFAULT_BANDS]
    groups, cur = [], [freqs[0]]
    for f in freqs[1:]:
        if f - cur[-1] > BAND_GAP_KHZ:
            groups.append(cur)
            cur = []
        cur.append(f)
    groups.append(cur)
    out = []
    for g in groups:
        lo, hi = g[0] * 1000, g[-1] * 1000
        center = (lo + hi) / 2
        while any(abs(center - f * 1000) < 3000 for f in g):    # not on a channel: the DC spike would sit on it
            center += 2500
        out.append({"lo": int(lo), "hi": int(hi), "center": int(center), "n": len(g)})
    return out


BANDS = _bands()
FREQ_MIN_HZ = BANDS[0]["lo"]
FREQ_MAX_HZ = BANDS[-1]["hi"]


def channels_in(fs, center_hz):
    """HFDL channels (Hz) that lie inside the band received at sample rate fs around center_hz."""
    half = fs / 2 - EDGE_HZ
    return [int(f * 1000) for f in CHANNELS if abs(f * 1000 - center_hz) < half and abs(f * 1000 - center_hz) > DC_HZ]


class HfdlDecoder:
    def __init__(self, on_event, on_state):
        self.on_event = on_event      # on_event("hfdl", record)
        self.on_state = on_state
        self.enabled = False
        self.error = None
        self.count = 0                # messages in the list (without squitters)
        self.frames = 0               # all decoded HFDL frames, squitters included
        self.squitters = 0
        self.dropped = 0
        self.channels = []
        self.heard = {}               # ground station id -> {name, freqs: {kHz: last time}, sig, last}
        self.history = collections.deque(maxlen=MAX_HISTORY)
        self.next_id = 1
        self.lock = threading.Lock()
        self.proc = None
        self.key = None               # (fs, centre, sample format) of the running dumphfdl
        self.pending = None           # (key, since): a new centre / rate waiting for the VFO to settle
        self.q = queue.Queue(maxsize=64)
        self.not_before = 0.0         # dumphfdl ended by itself: no new start before this (monotonic)
        self._stderr_tail = collections.deque(maxlen=5)
        self._last_state = 0.0
        # aircraft type, level, speed and squawk from ADS-B (adsb.fi / adsb.lol), like the ACARS card
        self.adsb = True              # False: no lookups (tests)
        self._cache = {}              # "hex:4ca7b5" / "reg:EI-FNH" -> (time, ADS-B data or None)
        self._lookups = queue.Queue(maxsize=50)
        threading.Thread(target=self._lookup_worker, name="hfdl-adsb", daemon=True).start()

    # ---------- control ----------

    def set_enabled(self, on):
        with self.lock:
            self.enabled = bool(on)
            self.pending = None
            self.not_before = 0.0
            if not self.enabled:
                self._stop()
                self.error = None
                self.channels = []
        self._emit_state(force=True)

    def info(self):
        return {"enabled": self.enabled, "error": self.error, "count": self.count, "frames": self.frames,
                "squitters": self.squitters, "dropped": self.dropped, "running": self.proc is not None,
                "channels": self.channels, "center_hz": self.key[1] if self.key else None,
                "heard": [{"id": k, "name": v["name"], "freqs": sorted(v["freqs"]), "sig": v["sig"], "last": v["last"]}
                          for k, v in sorted(self.heard.items(), key=lambda kv: -kv[1]["last"])]}

    def messages(self):
        with self.lock:
            return list(self.history)

    def clear(self):
        with self.lock:
            self.history.clear()
            self.count = self.frames = self.squitters = 0
            self.heard = {}
        self._emit_state(force=True)

    # ---------- samples from the receiver thread ----------

    def feed_raw(self, raw, fs, center_hz):
        """raw: uint8 I/Q from an RTL dongle or complex64 from LimeSDR / Airspy; fs and centre of the SDR."""
        if not self.enabled:
            return
        fmt = "CU8" if raw.dtype == np.uint8 else "CF32"
        key = (int(fs), int(round(center_hz)), fmt)
        if key != self.key:
            now = time.monotonic()
            if not self.pending or self.pending[0] != key:
                self.pending = (key, now)      # the VFO is moving: wait until it stays put
                if self.proc is not None:
                    with self.lock:
                        self._stop()
                return
            if now - self.pending[1] < SETTLE_S or now < self.not_before:
                return
            with self.lock:
                if not self.enabled:
                    return
                self.pending = None
                self._start(*key)
        if self.proc is None:
            return
        data = raw.tobytes()
        try:
            self.q.put_nowait(data)
        except queue.Full:
            self.dropped += 1

    # ---------- dumphfdl process ----------

    def _start(self, fs, center, fmt):
        self._stop()
        self.key = (fs, center, fmt)
        self.channels = channels_in(fs, center)
        if not self.channels:
            self.error = (f"no HFDL channel within ±{(fs / 2 - EDGE_HZ) / 1e3:.0f} kHz of {center / 1e6:.3f} MHz: "
                          f"tune to an HFDL band ({FREQ_MIN_HZ / 1e6:.1f}–{FREQ_MAX_HZ / 1e6:.1f} MHz)")
            self._emit_state(force=True)
            return
        if not os.path.exists(EXE):
            self.error = f"{EXE} is missing (see installer\\HFDL.txt)"
            self._emit_state(force=True)
            return
        cmd = [EXE, "--iq-file", "-", "--sample-format", fmt, "--sample-rate", str(fs),
               "--centerfreq", f"{center / 1000:.3f}", "--output", "decoded:json:file:path=-"]
        if os.path.exists(SYSTABLE):
            cmd += ["--system-table", os.path.basename(SYSTABLE)]     # relative to cwd: no Windows path for MSYS
        cmd += [f"{f / 1000:g}" for f in self.channels]
        try:
            self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                         cwd=os.path.dirname(EXE), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except OSError as e:
            self.proc = None
            self.error = f"cannot start dumphfdl: {e}"
            self._emit_state(force=True)
            return
        self.error = None
        self.q = queue.Queue(maxsize=64)
        p, q = self.proc, self.q
        self._stderr_tail = collections.deque(maxlen=5)
        threading.Thread(target=self._writer, args=(p, q), name="hfdl-in", daemon=True).start()
        threading.Thread(target=self._reader, args=(p,), name="hfdl-out", daemon=True).start()
        threading.Thread(target=self._stderr, args=(p, self._stderr_tail), name="hfdl-err", daemon=True).start()
        self._emit_state(force=True)

    def _stop(self):
        p, self.proc, self.key = self.proc, None, None
        if p:
            try:
                self.q.put_nowait(None)
            except queue.Full:
                pass
            try:
                p.stdin.close()
            except OSError:
                pass
            try:
                p.wait(timeout=2)
            except subprocess.TimeoutExpired:
                p.kill()

    def _writer(self, p, q):
        while True:
            data = q.get()
            if data is None or p.poll() is not None:
                return
            try:
                p.stdin.write(data)
            except (OSError, ValueError):
                return

    @staticmethod
    def _stderr(p, tail):
        for line in p.stderr:
            line = line.decode("utf-8", "replace").strip()
            if line:
                tail.append(line)

    def _reader(self, p):
        for line in p.stdout:
            try:
                msg = json.loads(line)["hfdl"]
            except (ValueError, KeyError, TypeError):
                continue
            self.frames += 1
            try:
                self._handle(msg)
            except Exception:
                pass                # one odd message must not stop the decoder
        if self.proc is p and self.enabled:
            p.wait()
            last = self._stderr_tail[-1] if self._stderr_tail else ""
            self.error = f"dumphfdl ended (code {p.returncode})" + (f": {last}" if last else "")
            self.proc, self.key = None, None     # the next samples start it again (after RETRY_S)
            self.not_before = time.monotonic() + RETRY_S
            self._emit_state(force=True)

    # ---------- messages ----------

    def _gs_heard(self, gs, freq_khz, sig, now):
        if not gs or gs.get("id") is None:
            return
        h = self.heard.setdefault(gs["id"], {"name": gs.get("name") or GS_NAMES.get(gs["id"], f"GS {gs['id']}"),
                                             "freqs": set(), "sig": None, "last": 0})
        h["freqs"].add(freq_khz)
        h["sig"] = sig
        h["last"] = now

    def _handle(self, v):
        now = time.time()
        t = v.get("t") or {}
        ts = (t.get("sec") or now) + (t.get("usec") or 0) / 1e6
        freq_hz = int(v.get("freq") or 0)
        sig = _num(v.get("sig_level"))
        meta = {"time": round(ts, 1), "freq_hz": freq_hz, "sig": sig, "noise": _num(v.get("noise_level")),
                "bitrate": v.get("bit_rate"), "skew": _num(v.get("freq_skew"))}
        if "spdu" in v:
            s = v["spdu"] or {}
            if s.get("err"):
                return
            self.squitters += 1
            self._gs_heard(s.get("src"), freq_hz / 1000, sig, now)
            self._emit_state()
            return
        lpdu = v.get("lpdu")
        if not isinstance(lpdu, dict) or lpdu.get("err"):
            return
        rec = _record(lpdu, meta)
        if rec is None:
            return
        gs = (lpdu.get("src") if rec["dir"] == "up" else lpdu.get("dst")) or {}
        if rec["dir"] == "up":
            self._gs_heard(gs, freq_hz / 1000, sig, now)
        key = _lookup_key(rec) if self.adsb else None
        hit = self._cache.get(key) if key else None
        fresh = hit and now - hit[0] < LOOKUP_CACHE_S
        rec["ac"] = (hit[1] or {"found": False}) if fresh else None
        rec["lookup"] = bool(key) and not fresh      # the browser fills the ADS-B columns on "hfdlinfo"
        with self.lock:
            self.count += 1
            rec["id"] = self.next_id
            self.next_id += 1
            self.history.append(rec)
        if rec["lookup"]:
            try:
                self._lookups.put_nowait((key, rec))
            except queue.Full:
                rec["lookup"] = False
        self.on_event("hfdl", dict(rec))
        self._emit_state()

    # ---------- aircraft data from ADS-B ----------

    def _lookup_worker(self):
        import acars            # here, so hfdl.py can be tested without the ACARS decoder
        last = 0.0
        while True:
            key, rec = self._lookups.get()
            hit = self._cache.get(key)
            if hit and time.time() - hit[0] < LOOKUP_CACHE_S:
                info = hit[1]
            else:
                time.sleep(max(0.0, last + LOOKUP_GAP_S - time.time()))
                last = time.time()
                kind, value = key.split(":", 1)
                info = acars.AcarsDecoder._fetch(value.lower() if kind == "hex" else value,
                                                 acars.LOOKUP_HEX_URLS if kind == "hex" else acars.LOOKUP_URLS)
                self._cache[key] = (time.time(), info)
                if len(self._cache) > 500:
                    self._cache.clear()
            rec["ac"] = info or {"found": False}
            rec["lookup"] = False
            self.on_event("hfdlinfo", {"id": rec["id"], "ac": rec["ac"]})

    def _emit_state(self, force=False):
        now = time.time()
        if force or now - self._last_state > 1.0:
            self._last_state = now
            self.on_state(self.info())


def _lookup_key(rec):
    """What to look the aircraft up by on ADS-B: its ICAO address, else the registration from ACARS."""
    if re.fullmatch(r"[0-9A-F]{6}", rec["icao"] or ""):
        return "hex:" + rec["icao"]
    if rec["crc_ok"] and len(rec["reg"]) >= 3 and rec["reg"].replace("-", "").isalnum():
        return "reg:" + rec["reg"]
    return None


def _num(x):
    return round(float(x), 1) if isinstance(x, (int, float)) else None


def _clean(s):
    return "".join(ch if 32 <= ord(ch) < 127 or ch == "\n" else ("\n" if ch == "\r" else "·") for ch in str(s or ""))


def _name(node):
    return _clean((node or {}).get("name", ""))


def _record(lpdu, meta):
    """One LPDU (libacars / dumphfdl JSON) -> a row of the HFDL table."""
    src, dst = lpdu.get("src") or {}, lpdu.get("dst") or {}
    down = src.get("type") == "Aircraft"
    ac, gs = (src, dst) if down else (dst, src)
    ac_info = ac.get("ac_info") or lpdu.get("ac_info") or {}
    lpdu_type = _name(lpdu.get("type"))
    hfnpdu = lpdu.get("hfnpdu") or {}
    rec = dict(meta, dir="down" if down else "up", gs_id=gs.get("id"), gs=_clean(gs.get("name") or GS_NAMES.get(gs.get("id"), "")),
               ac_id=ac.get("id"), icao=_clean(ac_info.get("icao", "")).upper(), reg="", flight="",
               kind=lpdu_type or "LPDU", label="", desc="", text="", lat=None, lon=None, crc_ok=True)
    if hfnpdu and not hfnpdu.get("err"):
        rec["kind"] = _name(hfnpdu.get("type")) or rec["kind"]
        rec["flight"] = _clean(hfnpdu.get("flight_id", "")).strip()
        pos = hfnpdu.get("pos") or {}
        if isinstance(pos.get("lat"), (int, float)) and isinstance(pos.get("lon"), (int, float)) \
                and abs(pos["lat"]) <= 90 and abs(pos["lon"]) <= 180 and (pos["lat"], pos["lon"]) != (0, 0):
            rec["lat"], rec["lon"] = round(pos["lat"], 4), round(pos["lon"], 4)
        a = hfnpdu.get("acars")
        if isinstance(a, dict):
            if a.get("err"):
                return None
            import acars          # here, so hfdl.py can be tested without the ACARS decoder
            text = _clean(a.get("msg_text", "")).replace("\n\n", "\n").strip()
            label = _clean(a.get("label", ""))
            rec.update(kind="ACARS", label=label, desc=acars.describe(label, text), text=text,
                       reg=_clean(a.get("reg", "")).lstrip(".").strip(), crc_ok=bool(a.get("crc_ok", True)),
                       flight=_clean(a.get("flight", "")).strip() or rec["flight"])
            if any(k in a for k in ("arinc622", "miam")):
                rec["text"] = (rec["text"] + "\n" + _tree(a.get("arinc622") or a.get("miam"))).strip()
        elif hfnpdu.get("type", {}).get("name") == "Frequency data":
            rec["text"] = _freq_data(hfnpdu.get("freq_data"))
    if lpdu.get("reason"):
        rec["text"] = _clean(lpdu["reason"].get("descr", ""))
    elif "assigned_ac_id" in lpdu:
        rec["text"] = f"aircraft ID {lpdu['assigned_ac_id']}"
    return rec


def _freq_data(items):
    """Frequency data (which ground stations the aircraft hears): one short line per ground station.
    Flight, position and time of the message have their own columns."""
    lines = []
    for x in items or []:
        if not isinstance(x, dict):
            continue
        gs = x.get("gs") or {}
        name = _clean(gs.get("name") or GS_NAMES.get(gs.get("id"), f"GS {gs.get('id')}")).split(",")[0]
        khz = lambda lst: ", ".join(f"{float(f['freq']):g}" for f in lst or [] if isinstance(f, dict) and f.get("freq"))
        heard, listen = khz(x.get("heard_on_freqs")), khz(x.get("listening_on_freqs"))
        parts = ([f"heard {heard}"] if heard else []) + ([f"tuned {listen}"] if listen else [])
        lines.append(f"{name}: {' · '.join(parts) or '-'}")
    return "\n".join(lines)


def _tree(v, ind=0, depth=0):
    """Nested JSON -> readable indented lines (CPDLC / ADS-C inside ACARS, frequency data)."""
    if depth > 12:
        return ""
    pad = "  " * ind
    lines = []
    if isinstance(v, dict):
        for k, x in v.items():
            if isinstance(x, (dict, list)):
                sub = _tree(x, ind + 1, depth + 1)
                if sub:
                    lines.append(f"{pad}{k}:\n{sub}")
            elif x not in (None, "", False):
                lines.append(f"{pad}{k}: {_clean(x)}")
    elif isinstance(v, list):
        for x in v:
            sub = _tree(x, ind, depth + 1)
            if sub:
                lines.append(sub)
    elif v not in (None, ""):
        lines.append(f"{pad}{_clean(v)}")
    return "\n".join(lines)
