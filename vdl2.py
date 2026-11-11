"""VDL Mode 2 decoder: raw dongle samples -> dumpvdl2.exe (lib\\vdl2\\) -> ACARS / CPDLC messages.

VDL2 is the digital VHF data link (136.100-136.975 MHz, D8PSK 31.5 kbit/s) that carries most of
today's ACARS traffic and the European ATN CPDLC. The heavy lifting (demodulation, FEC, AVLC / X.25 / CLNP /
COTP, ATN ASN.1) is done by dumpvdl2 (Tomasz Lemiech, GPLv3, https://github.com/szpajder/dumpvdl2), which runs
as a separate process: it reads I/Q samples on its standard input and writes one JSON object per message.

    receiver thread --raw bytes--> queue --writer thread--> dumpvdl2 stdin
    dumpvdl2 stdout --reader thread--> JSON -> on_acars(m)  (ACARS over VDL2: same dict as acars.parse)
                                            -> on_atn(r)    (ATN CPDLC / CM / ADS-C: CPDLC card record)
                                            -> on_pos(p)    (XID frames: position of an aircraft or a ground station)

dumpvdl2 needs a sample rate that is a multiple of 105 000 S/s, so the VFO runs at 2.1 MS/s (oversample 20)
while VDL2 is on. The centre frequency and the channel list are fixed when dumpvdl2 starts; a change of the
centre, the sample rate or the region restarts it. dumpvdl2 decodes at most 16 channels at once.
"""
import datetime
import json
import os
import re
import queue
import subprocess
import threading
import time

import numpy as np

from airports import IATA_CITY, IATA_ICAO
from paths import BASE

EXE = os.path.join(BASE, "lib", "vdl2", "dumpvdl2.exe")
VDL2_EU = tuple(range(136700000, 136975001, 25000))    # European channels: today's and those planned from January 2027
VDL2_EU_GUARD = 136675000     # still a European data channel, a guard channel from VDL2_EU_GUARD_FROM
VDL2_EU_GUARD_FROM = datetime.date(2027, 1, 1)
VDL2_US = (136100000, 136300000, 136650000, 136800000, 136975000)
VDL2_REGIONS = ("eu", "us")
VDL2_RATE = 2100000           # 105 000 * 20
VDL2_CENTER = 136500000       # all channels of both regions within ±475 kHz, the DC spike between 136.300 and 136.650
SYMBOL_RATE = 105000
EDGE_HZ = 20000               # a channel must be this far inside the received band
STATION_FILE = "VDL2_Ground_Stations.txt"    # ground station list: root folder of a package, installer folder while developing


def region_freqs(region):
    """Channels of a region ("eu" or "us") in Hz."""
    if region == "us":
        return list(VDL2_US)
    if datetime.datetime.now(datetime.timezone.utc).date() < VDL2_EU_GUARD_FROM:
        return [VDL2_EU_GUARD, *VDL2_EU]
    return list(VDL2_EU)


class Vdl2Decoder:
    def __init__(self, on_acars, on_atn, on_state, on_pos=None):
        self.on_acars = on_acars
        self.on_atn = on_atn
        self.on_pos = on_pos      # position from an XID frame (ACARS card MAP)
        self.on_state = on_state
        self.enabled = False
        self.error = None
        self.count = 0
        self.frames = 0           # all decoded VDL2 frames (also those without ACARS / CPDLC)
        self.channels = []
        self.region = "eu"
        self.lock = threading.Lock()
        self.proc = None
        self.key = None           # (fs, centre, sample format) of the running dumpvdl2
        self.q = queue.Queue(maxsize=48)
        self.dropped = 0
        self._last_state = 0.0

    # ---------- control ----------

    def set_enabled(self, on):
        with self.lock:
            self.enabled = bool(on)
            if not self.enabled:
                self._stop()
                self.error = None
        self._emit_state()

    def set_region(self, region):
        """region: one of VDL2_REGIONS. dumpvdl2 restarts with the new channels on the next samples."""
        if region not in VDL2_REGIONS or region == self.region:
            return
        with self.lock:
            self.region = region
            self._stop()
        self._emit_state()

    def info(self):
        return {"enabled": self.enabled, "error": self.error, "count": self.count, "frames": self.frames,
                "channels": self.channels, "region": self.region, "dropped": self.dropped}

    # ---------- samples from the receiver thread ----------

    def feed_raw(self, raw, fs, center_hz):
        """raw: uint8 I/Q from an RTL dongle (or complex64 from LimeSDR); fs and centre of the dongle."""
        if not self.enabled:
            return
        fmt = "U8" if raw.dtype == np.uint8 else "S16LE"
        key = (int(fs), int(center_hz), fmt)
        if key != self.key:
            with self.lock:
                if not self.enabled:
                    return
                self._start(*key)
        if self.proc is None:
            return
        data = raw.tobytes() if fmt == "U8" else (np.clip(raw.view(np.float32), -1, 1) * 32767).astype("<i2").tobytes()
        try:
            self.q.put_nowait(data)
        except queue.Full:
            self.dropped += 1

    # ---------- dumpvdl2 process ----------

    def _start(self, fs, center, fmt):
        self._stop()
        self.key = (fs, center, fmt)
        if fs % SYMBOL_RATE:
            self.error = f"VDL2 needs a sample rate of {VDL2_RATE / 1e6:g} MS/s (now {fs / 1e6:g} MS/s)"
            self._emit_state(force=True)
            return
        half = fs / 2 - EDGE_HZ
        self.channels = [f for f in region_freqs(self.region) if abs(f - center) < half]
        if not self.channels:
            self.error = f"no VDL2 channel of {self.region.upper()} in the received band"
            self._emit_state(force=True)
            return
        if not os.path.exists(EXE):
            self.error = f"{EXE} is missing"
            self._emit_state(force=True)
            return
        cmd = [EXE, "--iq-file", "-", "--sample-format", fmt, "--oversample", str(fs // SYMBOL_RATE),
               "--centerfreq", str(center), "--output", "decoded:json:file:path=-"] + [str(f) for f in self.channels]
        try:
            self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                         cwd=os.path.dirname(EXE), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except OSError as e:
            self.proc = None
            self.error = f"cannot start dumpvdl2: {e}"
            self._emit_state(force=True)
            return
        self.error = None
        self.q = queue.Queue(maxsize=48)
        p, q = self.proc, self.q
        threading.Thread(target=self._writer, args=(p, q), name="vdl2-in", daemon=True).start()
        threading.Thread(target=self._reader, args=(p,), name="vdl2-out", daemon=True).start()
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

    def _reader(self, p):
        for line in p.stdout:
            try:
                msg = json.loads(line, object_pairs_hook=_keep_duplicates)["vdl2"]
            except (ValueError, KeyError, TypeError):
                continue
            self.frames += 1
            try:
                self._handle(msg)
            except Exception:
                pass                # one odd message must not stop the decoder
        if self.proc is p and self.enabled:
            self.error = f"dumpvdl2 ended (code {p.poll()})"
            self.proc, self.key = None, None     # the next samples start it again
            self._emit_state(force=True)

    # ---------- messages ----------

    def _handle(self, v):
        avlc = v.get("avlc") or {}
        src, dst = avlc.get("src") or {}, avlc.get("dst") or {}
        down = src.get("type") == "Aircraft"
        gs = dst.get("addr", "") if down else src.get("addr", "")
        meta = {"freq_hz": int(v.get("freq") or 0), "sig_db": v.get("sig_level"), "noise_db": v.get("noise_level"),
                "src": src.get("addr", ""), "dst": dst.get("addr", ""),
                "dir": "down" if down else "up", "gs": gs, "gs_loc": gs_location(gs), "gs_city": gs_city(gs), "gs_info": gs_info(gs)}
        a = avlc.get("acars")
        if a is not None:
            if a.get("err"):
                return
            self.count += 1
            self.on_acars(_acars_dict(a, meta))
        else:
            app = _find(avlc, ("cpdlc", "cm", "adsc_v2", "adsc"))
            if app:
                self.count += 1
                self.on_atn(_atn_record(app[0], app[1], meta, avlc))
        xid = avlc.get("xid")
        if xid and self.on_pos:
            p = _xid_position(xid)
            if p:
                p.update(kind="ac" if down else "gs", addr=src.get("addr", ""), freq_hz=meta["freq_hz"],
                         gs=gs, gs_loc=meta["gs_loc"], gs_city=meta["gs_city"])
                self.on_pos(p)
        self._emit_state()

    def _emit_state(self, force=False):
        now = time.time()
        if force or now - self._last_state > 1.0:
            self._last_state = now
            self.on_state(self.info())


def _gs_iata(addr):
    """IATA airport code in the 24-bit address of a ground station, or None. Only SITA (prefix 2): 4 bits prefix,
    3 x 5 bits IATA letters (A=1), 5 bits radio. The other networks (ARINC, prefix 1) number their stations differently."""
    try:
        a = int(addr, 16)
    except (TypeError, ValueError):
        return None
    if not 0 <= a <= 0xFFFFFF or a >> 20 != 2:
        return None
    letters = [(a >> s) & 31 for s in (15, 10, 5)]
    if not all(1 <= x <= 26 for x in letters):
        return None
    return "".join(chr(64 + x) for x in letters)


def _station_loc(addr, code):
    """Location from the first word of a station file entry: "LZIB", "UIA-LICU", "TRH-NONE" or "IATA:BZF/FAA:085".
    The IATA code comes from the ICAO code, so all stations of an airport (ARINC and SITA) get the same location."""
    if code == "NONE":                # placeholder entry ("NONE temporary GS")
        return "-"
    m = re.match(r"IATA:(\w+)", code)
    if m:
        return m.group(1)
    m = re.match(r"(\w+)-(\w+)$", code)
    if m:
        return m.group(1) if m.group(2) == "NONE" else f"{m.group(1)}/{m.group(2)}"
    iata = ICAO_IATA.get(code) or _gs_iata(addr)
    return f"{iata}/{code}" if iata else code


def _load_stations():
    """Station file -> {address: (location, city, description)}. Lines: 1191BA [LHBP Budapest Hungary 136.825] [Budapest]
    An address shared by two regions lists both ("KJFK ... / RKJJ ..."): the location is the first, city and description have both.
    Without the file: empty, the addresses of SITA stations are still decoded."""
    for path in (os.path.join(BASE, STATION_FILE), os.path.join(BASE, "installer", STATION_FILE)):
        try:
            with open(path, encoding="cp1252", errors="replace") as f:
                lines = f.read().splitlines()
        except OSError:
            continue
        found = (re.match(r"([0-9A-Fa-f]{6}) \[(.+)\] \[(.*)\]$", line.strip()) for line in lines)
        return {m[1].upper(): (_station_loc(m[1], m[2].split()[0]), m[3], m[2]) for m in found if m}
    return {}


def _station(addr):
    return STATIONS.get(str(addr or "").upper())


def gs_location(addr):
    """Location of a ground station: "BTS/LZIB" (IATA/ICAO), "XYZ" if only one code is known, "-" if not known."""
    st = _station(addr)
    if st:
        return st[0]
    iata = _gs_iata(addr)
    if not iata:
        return "-"
    icao = IATA_ICAO.get(iata)
    return f"{iata}/{icao}" if icao else iata


def gs_city(addr):
    """City of the ground station's airport ("Bratislava"), "" if not known."""
    st = _station(addr)
    return st[1] if st else IATA_CITY.get(_gs_iata(addr), "")


def gs_info(addr):
    """Whole entry of a ground station in the station file ("LHBP Budapest Hungary 136.825"), "" if not there."""
    st = _station(addr)
    return st[2] if st else ""


ICAO_IATA = {icao: iata for iata, icao in IATA_ICAO.items()}
STATIONS = _load_stations()


def _clean(s):
    return "".join(ch if 32 <= ord(ch) < 127 or ch == "\n" else ("\n" if ch == "\r" else "·") for ch in str(s or ""))


def _acars_dict(a, meta):
    """ACARS inside VDL2 (libacars JSON) -> the same dict as acars.parse() + link and signal info."""
    import acars             # here, so vdl2.py can be tested without the ACARS decoder
    text = _clean(a.get("msg_text", "")).replace("\n\n", "\n").strip()
    sub = a.get("sublabel")
    if sub and a.get("label") == "H1" and not text.startswith(("#", "- #")):
        # libacars cuts the H1 sublabel off the text; put it back so cpdlc.py sees the original message
        text = (f"#{sub}B" if meta["dir"] == "down" else f"- #{sub}") + (f"/{a['mfi']} " if a.get("mfi") else "") + text
    label = _clean(a.get("label", ""))
    return {
        "desc": acars.describe(label, text),
        "mode": _clean(a.get("mode", "")), "reg": _clean(a.get("reg", "")).lstrip("."),
        "ack": "NAK" if a.get("ack") == "\x15" else _clean(a.get("ack", "")),
        "label": label, "block": _clean(a.get("blk_id", "")), "msgno": _clean(a.get("msg_num", "")),
        "flight": _clean(a.get("flight", "")).strip(), "text": text, "more": bool(a.get("more")),
        "crc_ok": bool(a.get("crc_ok", True)), "parity_errors": 0, "dir": meta["dir"],
        "link": "VDL2", "vdl2": meta,
    }


def _find(node, keys, depth=0):
    """First (key, subtree) with a key from keys anywhere in the JSON tree."""
    if depth > 30 or not isinstance(node, (dict, list)):
        return None
    items = node.items() if isinstance(node, dict) else enumerate(node)
    for k, v in items:
        if k in keys and isinstance(v, (dict, list)):
            return k, v
        r = _find(v, keys, depth + 1)
        if r:
            return r
    return None


def _keep_duplicates(pairs):
    """json object_pairs_hook: a key that repeats (dumpvdl2 writes e.g. several "msg_element" in one object)
    becomes a list instead of keeping only the last value."""
    d = {}
    for k, v in pairs:
        if k in d:
            if not (isinstance(d[k], list) and getattr(d[k], "dup", False)):
                d[k] = _DupList([d[k]])
            d[k].append(v)
        else:
            d[k] = v
    return d


class _DupList(list):
    dup = True


def _words(s):
    """ASN.1 name or enum ("insufficientResources", "commanded-termination") -> "insufficient resources"."""
    s = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", str(s)).replace("-", " ").replace("_", " ")
    return s.lower()


# leaf name -> text of the value (ATN CPDLC, libacars JSON names)
LEAF_FMT = {
    "flight_level": lambda v: f"FL{int(v):03d}",
    "altitude_qnh_ft": lambda v: f"{v} FT", "altitude_qnh_meters": lambda v: f"{v} M",
    "free_text": lambda v: str(v).strip(),
    "facility_designation": str, "unit_name": str, "fix": str, "airport": str,
}
SKIP = {"choice", "choice_label", "err"}


def _leaves(v, key=""):
    """Scalar values in a JSON subtree (without the ASN.1 choice names), formatted -> list of (key, text)."""
    out = []
    if isinstance(v, dict):
        for k, x in v.items():
            if k not in SKIP:
                out += _leaves(x, k)
    elif isinstance(v, list):
        for x in v:
            out += _leaves(x, key)
    elif v not in (None, ""):
        if isinstance(v, str):
            v = "".join(ch for ch in v if ch >= " ").strip()     # NUL padding in free text
            if not v:
                return out
        f = LEAF_FMT.get(key)
        if f:
            out.append((key, f(v)))
        elif isinstance(v, str):
            out.append((key, _words(v) if re.fullmatch(r"[A-Za-z][A-Za-z0-9-]*", v) else v))
        else:
            out.append((key, f"{_words(key)} {v}"))
    return out


def _elements(v, out):
    """Message elements (objects with choice_label) in order -> [(id like dM6, text with values filled in)]."""
    if isinstance(v, dict):
        if "choice_label" in v:
            label = str(v["choice_label"])
            m = re.match(r"[ud]M\d+", str(v.get("choice", "")))
            vals = [t for _, t in _leaves(v.get("data"))]
            ph = re.findall(r"\[[^\]]+\]", label)
            if ph and len(vals) == len(ph):
                it = iter(vals)
                text = re.sub(r"\[[^\]]+\]", lambda _: next(it), label)
            elif ph and vals:
                text = re.sub(r"\[[^\]]+\]", " ".join(vals), label, count=1)
                text = re.sub(r"\s*\[[^\]]+\]", "", text)
            else:
                text = label + (" " + " ".join(vals) if vals else "")
            out.append((m.group() if m else "", " ".join(text.split()) if "\n" not in text else text.strip()))
            return
        for x in v.values():
            _elements(x, out)
    elif isinstance(v, list):
        for x in v:
            _elements(x, out)


def _find_key(v, key):
    if isinstance(v, dict):
        if key in v:
            return v[key]
        for x in v.values():
            r = _find_key(x, key)
            if r is not None:
                return r
    elif isinstance(v, list):
        for x in v:
            r = _find_key(x, key)
            if r is not None:
                return r
    return None


ACSE = {"aarq": "connection request", "aare": "connection response", "rlrq": "release request",
        "rlre": "release response", "abrt": "abort"}


def _session(avlc, app):
    """Text of a message without CPDLC elements: abort / connect / release (ACSE, COTP), or the values."""
    parts = []
    if isinstance(app, dict) and app:
        ch = _find_key(app, "choice")
        vals = [t for _, t in _leaves(app)]
        if ch:
            parts.append(_words(ch) + (": " + ", ".join(vals) if vals else ""))
        elif vals:
            parts.append(", ".join(vals))
    acse = _find_key(avlc, "acse_apdu")
    if isinstance(acse, dict) and not (acse.get("choice") == "abrt" and parts):   # abort: the CPDLC reason is enough
        res = _find_key(acse, "value_descr")
        parts.append(ACSE.get(acse.get("choice"), _words(acse.get("choice", "session"))) + (f": {res}" if res else ""))
    if not parts:
        pdus = _find_key(avlc, "pdu_list") or []
        descr = [p.get("tpdu_code_descr") for p in pdus if isinstance(p, dict) and p.get("tpdu_code_descr")]
        if descr:
            parts.append("transport " + ", ".join(d.lower() for d in descr))
    return "; ".join(parts)


def _tree(v, out, ind=0, key="", skip=None):
    """Whole decoded frame as an indented "key: value" tree (the detail shown when an ATN row is clicked)."""
    pad = "  " * ind
    if skip is not None and v is skip:
        out.append(f"{pad}{key}: (above)")
        return
    clean = lambda x: "".join(ch for ch in str(x) if ch >= " ").strip()     # NUL padding in free text
    if isinstance(v, dict):
        scal = all(not isinstance(x, (dict, list)) for x in v.values())
        if key and scal and len(v) <= 5:          # small leaf object on one line
            out.append(f"{pad}{key}: " + ", ".join(f"{k}={clean(x)}" for k, x in v.items()))
            return
        if key:
            out.append(f"{pad}{key}")
            ind += 1
        for k, x in v.items():
            _tree(x, out, ind, k, skip)
    elif isinstance(v, list):
        if all(not isinstance(x, (dict, list)) for x in v):
            out.append(f"{pad}{key}: " + ", ".join(clean(x) for x in v))
            return
        for i, x in enumerate(v):
            _tree(x, out, ind, f"{key}[{i}]" if len(v) > 1 else key, skip)
    else:
        out.append(f"{pad}{key}: {clean(v)}")


def _detail(avlc, kind, app):
    """Application message first (CPDLC / CM / ADS-C), then the link and transport layers of the frame."""
    out = []
    _tree({kind: app}, out)
    out.append("── VDL2 frame (AVLC / X.25 / CLNP / COTP) ──")
    _tree(avlc, out, skip=app)
    out = [x for x in out if x.strip() != "err: False"]
    if len(out) > 400:
        out = out[:400] + ["…"]
    return "\n".join(out)


# ---------- ATN ADS-C (ADS-C v2 over VDL2): reports in the same style as FANS ADS-C (adsc.py) ----------

def _v(x):
    """{"val": 31990.0, "unit": "ft"} -> 31990.0 (or None)."""
    return x.get("val") if isinstance(x, dict) else x


def _coord(c, pos, neg):
    if not isinstance(c, dict) or "deg" not in c:
        return ""
    d = c["deg"] + c.get("min", 0) / 60 + c.get("sec", 0) / 3600
    return f"{d:.4f}{neg if str(c.get('dir', '')).startswith(('s', 'w')) else pos}"


def _deg_val(c):
    """Coordinate -> signed degrees: a number, or {"deg", "min", "sec", "dir"} (ATN ADS-C); None if neither."""
    if isinstance(c, bool):
        return None
    if isinstance(c, (int, float)):
        return float(c)
    if isinstance(c, dict) and isinstance(c.get("deg"), (int, float)):
        d = c["deg"] + c.get("min", 0) / 60 + c.get("sec", 0) / 3600
        return -d if str(c.get("dir", "")).lower().startswith(("s", "w")) else d
    return None


def _latlon(v, depth=0):
    """First object in the JSON tree with a usable "lat" and "lon" -> (lat, lon, that object), or None."""
    if depth > 12:
        return None
    if isinstance(v, dict):
        lat, lon = _deg_val(v.get("lat")), _deg_val(v.get("lon"))
        if lat is not None and lon is not None and -90 <= lat <= 90 and -180 <= lon <= 180 and (lat, lon) != (0, 0):
            return lat, lon, v
        v = list(v.values())
    if isinstance(v, list):
        for x in v:
            r = _latlon(x, depth + 1)
            if r:
                return r
    return None


def _xid_position(xid):
    """XID frame (link setup / handoff / ground station broadcast) -> {lat, lon, alt_ft} or None.
    Aircraft send their approximate location (ac_location), ground stations their own (gs_location)."""
    r = _latlon(xid)
    if not r:
        return None
    lat, lon, node = r
    alt = None
    for holder in (node, xid):
        a = _find_key(holder, "alt")
        a = _v(a)
        if isinstance(a, (int, float)) and not isinstance(a, bool):
            alt = int(a)
            break
    return {"lat": round(lat, 4), "lon": round(lon, 4), "alt_ft": alt}


def _adsc_position(app):
    """ATN ADS-C report -> {lat, lon, alt_ft} of the aircraft, or None."""
    rd = _find_key(app, "report_data")
    pos = rd.get("position") if isinstance(rd, dict) else None
    if not isinstance(pos, dict):
        return None
    lat, lon = _deg_val(pos.get("lat")), _deg_val(pos.get("lon"))
    if lat is None or lon is None:
        return None
    alt = _v(pos.get("alt"))
    return {"lat": round(lat, 5), "lon": round(lon, 5),
            "alt_ft": int(alt) if isinstance(alt, (int, float)) and not isinstance(alt, bool) else None}


def _hms(t, z=True):
    if not isinstance(t, dict) or "hour" not in t:
        return ""
    s = t.get("sec", 0)
    return f"{t['hour']:02d}:{t.get('min', 0):02d}:{s:04.1f}".replace(".0", "") + ("Z" if z else "")


def _dur(t):
    """{"hour": 0, "min": 22, "sec": 18} -> "22:18" (minutes:seconds, hours folded into the minutes)."""
    if not isinstance(t, dict):
        return ""
    return f"{t.get('hour', 0) * 60 + t.get('min', 0)}:{int(t.get('sec', 0)):02d}"


def _alt(a):
    a = _v(a)
    return f"{a:.0f} FT" if isinstance(a, (int, float)) else ""


def _where(p):
    """position {lat, lon, alt} -> "47.3265N 18.4679E 31990 FT"."""
    if not isinstance(p, dict):
        return ""
    return " ".join(x for x in (_coord(p.get("lat"), "N", "S"), _coord(p.get("lon"), "E", "W"), _alt(p.get("alt"))) if x)


def _deg(x):
    x = _v(x)
    return f"{x:.1f}°" if isinstance(x, (int, float)) else ""


def _num(x, unit, fmt="{:.0f}"):
    x = _v(x)
    return f"{fmt.format(x)} {unit}" if isinstance(x, (int, float)) else ""


def _vrate(x):
    x = _v(x)
    return f"vertical rate {x:+.0f} FT/MIN" if isinstance(x, (int, float)) else ""


def _speed(sp):
    """airspeed / speed_ias_mach (ASN.1 choice) -> "M0.77 · IAS 279 KT"."""
    mach, ias = _find_key(sp, "mach"), _find_key(sp, "ias")
    return " · ".join(x for x in ((f"M{_v(mach):.2f}" if _v(mach) is not None else ""),
                                  f"IAS {_num(ias, 'KT')}" if _v(ias) is not None else "") if x)


def _adsc_v2(app):
    """ATN ADS-C report -> [(id, text)] like the FANS ADS-C lines; [] when it is not a report."""
    rd = _find_key(app, "report_data")
    if not isinstance(rd, dict):
        return []
    kind = _words(_find_key(app, "choice") or "report")
    out = []
    pos = rd.get("position")
    fom = rd.get("figure_of_merit") or {}
    acc = _num(fom.get("estimated_position_uncertainty"), "NM", "{:g}")
    t = _find_key(rd.get("timestamp"), "time")
    out.append(("REPORT", " · ".join(x for x in (
        kind[:1].upper() + kind[1:] + ":", _where(pos), _hms(t), f"accuracy {acc}" if acc else "",
        f"contract {rd['contract_number']}" if "contract_number" in rd else "") if x).replace(": · ", ": ")))
    gv = rd.get("ground_vector")
    if isinstance(gv, dict):
        out.append(("EARTH", " · ".join(x for x in (
            f"track {_deg(gv.get('ground_track'))}" if _deg(gv.get("ground_track")) else "",
            f"GS {_num(gv.get('ground_speed'), 'KT', '{:.1f}')}" if _v(gv.get("ground_speed")) is not None else "",
            _vrate(gv.get("vertical_rate"))) if x)))
    av = rd.get("air_vector")
    if isinstance(av, dict):
        out.append(("AIR", " · ".join(x for x in (
            f"heading {_deg(av.get('heading'))}" if _deg(av.get("heading")) else "",
            _speed(av.get("airspeed")), _vrate(av.get("vertical_rate"))) if x)))
    met = rd.get("meteo_data")
    if isinstance(met, dict):
        ws, wd, tmp = _v(_find_key(met.get("wind_speed"), "wind_speed")), _v(met.get("wind_direction")), _v(met.get("temperature"))
        out.append(("METEO", " · ".join(x for x in (
            f"wind {wd:.0f}°/{ws:.0f} KT" if ws is not None and wd is not None else "",
            f"temperature {tmp:.1f} °C" if tmp is not None else "") if x)))
    pp = rd.get("projected_profile")
    if isinstance(pp, dict):           # next waypoints; ETA = time to the first one, then from waypoint to waypoint
        lines = []
        for n, w in enumerate(_find_all(pp, "waypoint_sequence_element")):
            eta = _dur(w.get("eta"))
            lines.append(" ".join(x for x in (w.get("waypoint_name", ""), _where(w.get("position")),
                                               (f"in {eta} min" if n == 0 else f"+{eta} min") if eta else "") if x))
        if lines:
            out.append(("ROUTE", "next " + "\nthen ".join(lines)))
    ep = rd.get("extended_projected_profile")
    if isinstance(ep, dict):           # planned trajectory: fixes, level, ETA, speed, climb/descent points
        lines = []
        for w in _find_all(ep, "waypoint_data"):
            lvl = _find_key(w.get("epp_level"), "alt_qne")
            lines.append(" ".join(x for x in (
                w.get("waypoint_name", "") or "·", _coord(w.get("lat"), "N", "S"), _coord(w.get("lon"), "E", "W"),
                _alt(lvl) if lvl is not None else "", _hms(w.get("eta")), _speed(w.get("speed_ias_mach")),
                f"({w['vertical_type']})" if w.get("vertical_type") else "") if x))
        if lines:
            out.append(("PLAN", "\n".join(lines)))
    known = {"position", "figure_of_merit", "timestamp", "contract_number", "ground_vector", "air_vector",
             "meteo_data", "projected_profile", "extended_projected_profile"}
    for k, x in rd.items():            # anything else (e.g. intent, flight ID): generic values
        if k not in known:
            vals = [t for _, t in _leaves(x)]
            if vals:
                out.append((k.upper()[:8], f"{_words(k)}: " + ", ".join(vals)))
    return [(i, t) for i, t in out if t]


def _find_all(v, key):
    """All values of a key anywhere in a JSON subtree, in order."""
    out = []
    if isinstance(v, dict):
        for k, x in v.items():
            if k == key:
                out.append(x)
            else:
                out += _find_all(x, key)
    elif isinstance(v, list):
        for x in v:
            out += _find_all(x, key)
    return out


def _atn_record(kind, app, meta, avlc):
    """ATN application message (CPDLC, CM = context management, ADS-C v2) -> compact CPDLC card record:
    header (MIN / MRN / time / logical ack) and message elements with their values filled in."""
    names = {"cpdlc": "ATN CPDLC", "cm": "ATN CM", "adsc_v2": "ATN ADS-C", "adsc": "ATN ADS-C"}
    hdr = _find_key(app, "header") or {}
    ts = ""
    t = _find_key(hdr, "time") if isinstance(hdr, dict) else None
    if isinstance(t, dict) and "hour" in t:
        ts = f"{t['hour']:02d}:{t.get('min', 0):02d}:{t.get('sec', 0):02d}Z"
    if isinstance(hdr, dict) and hdr.get("logical_ack") == "required":
        ts = (ts + " · " if ts else "") + "ack required"
    els = _adsc_v2(app) if kind.startswith("adsc") else []
    if not els:
        _elements(app, els)
    if not els:
        txt = _session(avlc, app)
        els = [("", txt or names[kind].lower())]
    up = meta["dir"] == "up"
    return {"gs": meta["src"] if up else meta["dst"], "imi": "ATN", "imi_desc": names[kind],
            "air": meta["dst"] if up else meta["src"], "crc_ok": True, "dir": meta["dir"],
            "min": hdr.get("msg_id") if isinstance(hdr, dict) else None,
            "mrn": hdr.get("msg_ref") if isinstance(hdr, dict) else None, "ts": ts,
            "elements": [{"id": i, "text": t} for i, t in els], "error": "",
            "text": "\n".join((f"{i}: " if i else "") + t for i, t in els),
            "pos": _adsc_position(app) if kind.startswith("adsc") else None, "link": "VDL2",
            "vdl2": meta, "raw": json.dumps(avlc, ensure_ascii=False)[:4000], "detail": _detail(avlc, kind, app)}
