"""Own satellite tracking, stage 1: orbital elements (TLE) from CelesTrak, the station location and pass prediction.
Nothing here moves the rotor or tunes a VFO.

Files in data\\, shared by all VFOs:
    sat_tle.txt      TLE of the CelesTrak "amateur" group, downloaded again after 24 hours (the last copy is used
                     when the download fails)
    sat_setup.json   minimum elevation of a pass, the satellites chosen for the timeline and those shown on the
                     world map (the station location is in location.json, see location.py)

Positions: SGP4 (sgp4 package) gives TEME coordinates; they are turned by the Greenwich sidereal time into Earth fixed
coordinates (polar motion and the difference UT1 - UTC are left out: well under 0.1 degree as seen from the ground)
and then into azimuth, elevation, range and range rate for the station (WGS84).
"""
import json
import math
import os
import threading
import time
import urllib.request

import numpy as np
from sgp4.api import Satrec

import location
from paths import data

TLE_URL = "https://celestrak.org/NORAD/elements/gp.php?GROUP={}&FORMAT=tle"
# CelesTrak groups downloaded together (one file, sat_tle.txt); the tabs of SETUP. The amateur group must come.
TLE_GROUPS = [("amateur", "Amateur Radio"), ("weather", "Weather"), ("cubesat", "CubeSats"), ("science", "Space & Earth Science"),
              ("galileo", "Galileo"), ("glo-ops", "GLONASS operational"), ("gps-ops", "GPS operational"), ("iridium-NEXT", "Iridium NEXT")]
TLE_PATH = data("sat_tle.txt")
GROUPS_PATH = data("sat_groups.json")     # {group: [norad]}: which group each satellite came from
SETUP_PATH = data("sat_setup.json")
TLE_MAX_AGE_S = 24 * 3600
TLE_RETRY_S = 15 * 60          # after a failed download, the next try is not sooner than this
TLE_TIMEOUT_S = 15
TLE_MAX_BYTES = 2_000_000
TLE_OLD_DAYS = 7               # elements older than this are marked on the page

DEFAULT_MIN_EL = 5.0
# Active amateur satellites shown on the timeline at first; the choice is changed in SETUP.
DEFAULT_SATS = [7530, 24278, 25544, 27607, 39444, 40908, 43017, 43678, 44909, 50466, 53109, 61781]
DEFAULT_MAP_SATS = [25544, 27607, 43017, 44909]
MAP_SATS_MAX = 20
MAP_POINTS = 240               # samples of the ground track of one satellite (about 1.5 orbits)

HOURS_MAX = 72
COARSE_S = 60.0                # pass search step; a pass shorter than this only grazes the horizon
DETAIL_S = 5.0                 # step of the samples of one pass
EDGE_LIMIT_S = 12 * 3600       # a pass on at the start or the end of the window: its AOS / LOS is looked for this far

EARTH_A_KM, EARTH_F = 6378.137, 1 / 298.257223563
EARTH_W = 7.292115e-5          # Earth rotation, rad/s
C_KM_S = 299792.458

_lock = threading.Lock()
_cache = {"tle_mtime": None, "sats": {}}
_last_try = 0.0
_last_error = ""


# ---------- setup (the station location comes from location.py: MENU › SETUP › LOCATION) ----------

LOCATION_KEYS = ("lat", "lon", "locator", "alt_m")


def _read_setup():
    try:
        with open(SETUP_PATH, encoding="utf-8") as f:
            s = json.load(f)
        return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


def load_setup():
    """The satellite setup together with the station location (lat, lon, locator, alt_m of location.py)."""
    s = {k: v for k, v in _read_setup().items() if k not in LOCATION_KEYS}
    s.setdefault("min_el", DEFAULT_MIN_EL)
    s.setdefault("sats", list(DEFAULT_SATS))
    s.setdefault("map_sats", list(DEFAULT_MAP_SATS))
    s.update(location.load())
    return s


def save_setup(changes):
    """Checks and saves the changed fields; returns the whole setup. ValueError with the reason if a value is wrong.
    Location fields go to location.py (older pages still send them here)."""
    loc = {k: changes[k] for k in LOCATION_KEYS if k in changes}
    if loc:
        location.save(loc)
    else:
        location.load()           # takes the location over from sat_setup.json before it is dropped there
    s = {k: v for k, v in _read_setup().items() if k not in LOCATION_KEYS}
    if "min_el" in changes:
        el = float(changes["min_el"])
        if not 0 <= el <= 60:
            raise ValueError("minimum elevation 0 to 60 degrees")
        s["min_el"] = el
    if "sats" in changes:
        s["sats"] = sorted({int(n) for n in changes["sats"]})
    if "map_sats" in changes:
        chosen = sorted({int(n) for n in changes["map_sats"]})
        if len(chosen) > MAP_SATS_MAX:
            raise ValueError(f"at most {MAP_SATS_MAX} satellites on the map")
        s["map_sats"] = chosen
    tmp = f"{SETUP_PATH}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=2)
    os.replace(tmp, SETUP_PATH)
    return load_setup()


# ---------- orbital elements ----------

def _download_group(group):
    req = urllib.request.Request(TLE_URL.format(group), headers={"User-Agent": "RADIMCOM"})
    with urllib.request.urlopen(req, timeout=TLE_TIMEOUT_S) as r:
        text = r.read(TLE_MAX_BYTES + 1).decode("ascii", "replace")
    if len(text) > TLE_MAX_BYTES:
        raise ValueError("answer too long")
    sats = parse_tle(text)
    if not sats:
        raise ValueError("no orbital elements in the answer")
    return sats


def _download():
    """All groups -> (TLE text, {group: [norad]}, text of the groups that failed). The amateur group must come."""
    merged, groups, failed = {}, {}, []
    for key, title in TLE_GROUPS:
        try:
            sats = _download_group(key)
        except (OSError, ValueError) as e:
            if key == "amateur":
                raise
            failed.append(f"{title}: {getattr(e, 'reason', e)}")
            continue
        groups[key] = sorted(sats)
        for norad, row in sats.items():
            merged.setdefault(norad, row)
    text = "".join(f"{name}\n{l1}\n{l2}\n" for name, l1, l2 in merged.values())
    return text, groups, "; ".join(failed)


def parse_tle(text):
    """Three-line TLE text -> {norad: (name, line1, line2)}; lines that do not fit are skipped."""
    lines = [l.rstrip() for l in text.splitlines() if l.strip()]
    out = {}
    i = 0
    while i + 2 < len(lines):
        name, l1, l2 = lines[i], lines[i + 1], lines[i + 2]
        if l1.startswith("1 ") and l2.startswith("2 ") and l1[2:7] == l2[2:7]:
            try:
                out[int(l1[2:7])] = (name.strip(), l1, l2)
            except ValueError:
                pass
            i += 3
        else:
            i += 1
    return out


def tle_state(refresh=False):
    """Downloads the elements when they are missing, older than a day or refresh is asked.
    -> {"fetched": unix time of the file or None, "error": text of the last failed download}"""
    global _last_try, _last_error
    with _lock:
        try:
            mtime = os.path.getmtime(TLE_PATH)
        except OSError:
            mtime = None
        stale = mtime is None or time.time() - mtime > TLE_MAX_AGE_S or not os.path.exists(GROUPS_PATH)
        if refresh or (stale and time.time() - _last_try > TLE_RETRY_S):
            _last_try = time.time()
            try:
                text, groups, failed = _download()
                tmp = f"{GROUPS_PATH}.{os.getpid()}.tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(groups, f, separators=(",", ":"))
                os.replace(tmp, GROUPS_PATH)
                tmp = f"{TLE_PATH}.{os.getpid()}.tmp"
                with open(tmp, "w", encoding="ascii") as f:
                    f.write(text)
                os.replace(tmp, TLE_PATH)
                mtime, _last_error = os.path.getmtime(TLE_PATH), failed and f"some groups failed: {failed}"
            except (OSError, ValueError) as e:
                _last_error = str(getattr(e, "reason", e))
        return {"fetched": mtime, "error": _last_error}


def satellites():
    """{norad: {"name", "sat": Satrec, "epoch": unix time}} from the saved file, read again when it changes."""
    with _lock:
        try:
            mtime = os.path.getmtime(TLE_PATH)
        except OSError:
            return {}
        if _cache["tle_mtime"] != mtime:
            with open(TLE_PATH, encoding="ascii", errors="replace") as f:
                parsed = parse_tle(f.read())
            sats = {}
            for norad, (name, l1, l2) in parsed.items():
                try:
                    sat = Satrec.twoline2rv(l1, l2)
                except (ValueError, IndexError):
                    continue
                sats[norad] = {"name": name, "sat": sat, "epoch": (sat.jdsatepoch + sat.jdsatepochF - 2440587.5) * 86400}
            _cache.update(tle_mtime=mtime, sats=sats)
        return _cache["sats"]


# ---------- positions ----------

def _station_ecef(lat, lon, alt_m):
    la, lo = math.radians(lat), math.radians(lon)
    e2 = EARTH_F * (2 - EARTH_F)
    n = EARTH_A_KM / math.sqrt(1 - e2 * math.sin(la) ** 2)
    h = alt_m / 1000
    return np.array([(n + h) * math.cos(la) * math.cos(lo), (n + h) * math.cos(la) * math.sin(lo), (n * (1 - e2) + h) * math.sin(la)])


def _gmst(jd):
    """Greenwich mean sidereal time (IAU 1982) in radians, jd = Julian date (UT1 taken as UTC)."""
    t = (jd - 2451545.0) / 36525.0
    s = 67310.54841 + (876600.0 * 3600 + 8640184.812866) * t + 0.093104 * t * t - 6.2e-6 * t ** 3
    return np.radians((s % 86400) / 240.0)


def _ecef(sat, times):
    """SGP4 at the unix times -> (err, x, y, z, vx, vy, vz): Earth fixed position (km) and velocity (km/s)."""
    times = np.asarray(times, float)
    jd = times / 86400.0 + 2440587.5
    jd_i = np.floor(jd)
    err, r, v = sat.sgp4_array(jd_i, jd - jd_i)
    g = _gmst(jd)
    cg, sg = np.cos(g), np.sin(g)
    x = cg * r[:, 0] + sg * r[:, 1]
    y = -sg * r[:, 0] + cg * r[:, 1]
    z = r[:, 2]
    vx = cg * v[:, 0] + sg * v[:, 1] + EARTH_W * y
    vy = -sg * v[:, 0] + cg * v[:, 1] - EARTH_W * x
    return err, x, y, z, vx, vy, v[:, 2]


def subpoint(sat, times):
    """Point below the satellite -> lat, lon (degrees, WGS84), alt (km above the ellipsoid), ok."""
    err, x, y, z = _ecef(sat, times)[:4]
    e2 = EARTH_F * (2 - EARTH_F)
    p = np.sqrt(x * x + y * y)
    lat = np.arctan2(z, p * (1 - e2))
    for _ in range(4):
        n = EARTH_A_KM / np.sqrt(1 - e2 * np.sin(lat) ** 2)
        alt = p / np.cos(lat) - n
        lat = np.arctan2(z, p * (1 - e2 * n / (n + alt)))
    n = EARTH_A_KM / np.sqrt(1 - e2 * np.sin(lat) ** 2)
    alt = p / np.cos(lat) - n
    return {"lat": np.degrees(lat), "lon": np.degrees(np.arctan2(y, x)), "alt": alt, "ok": (err == 0) & np.isfinite(alt)}


def look(sat, times, setup):
    """Satellite seen from the station at the unix times (numpy array) ->
    dict of arrays: az, el (degrees), range (km), rate (km/s, + = going away), ok (False = SGP4 error, e.g. decayed)."""
    err, x, y, z, vx, vy, vz = _ecef(sat, times)
    st = _station_ecef(setup["lat"], setup["lon"], setup["alt_m"])
    dx, dy, dz = x - st[0], y - st[1], z - st[2]
    la, lo = math.radians(setup["lat"]), math.radians(setup["lon"])
    south = math.sin(la) * math.cos(lo) * dx + math.sin(la) * math.sin(lo) * dy - math.cos(la) * dz
    east = -math.sin(lo) * dx + math.cos(lo) * dy
    up = math.cos(la) * math.cos(lo) * dx + math.cos(la) * math.sin(lo) * dy + math.sin(la) * dz
    rng = np.sqrt(dx * dx + dy * dy + dz * dz)
    with np.errstate(invalid="ignore", divide="ignore"):
        el = np.degrees(np.arcsin(np.clip(up / rng, -1, 1)))
        az = np.degrees(np.arctan2(east, -south)) % 360
        rate = (dx * vx + dy * vy + dz * vz) / rng
    ok = (err == 0) & np.isfinite(rng)
    el = np.where(ok, el, -90.0)
    return {"az": az, "el": el, "range": rng, "rate": rate, "ok": ok}


def _el_at(sat, t, setup):
    return float(look(sat, np.array([t]), setup)["el"][0])


def _crossing(sat, t0, t1, setup, rising):
    """Time of the horizon crossing between t0 and t1, to about a second (bisection)."""
    for _ in range(12):
        mid = (t0 + t1) / 2
        above = _el_at(sat, mid, setup) > 0
        if above == rising:
            t1 = mid
        else:
            t0 = mid
    return (t0 + t1) / 2


def _edge(sat, t, direction, setup, limit_s=EDGE_LIMIT_S):
    """First coarse step below the horizon from t going back (-1) or on (+1); None if the satellite stays up
    (geostationary, or a very long pass)."""
    steps = np.arange(1, int(limit_s / COARSE_S) + 1) * COARSE_S * direction + t
    below = np.nonzero(look(sat, steps, setup)["el"] <= 0)[0]
    return float(steps[below[0]]) if len(below) else None


def find_passes(sat, start, hours, setup):
    """Passes above the horizon between start and start + hours whose highest elevation reaches min_el.
    -> [{"aos", "los", "max_t", "max_el", "aos_az", "los_az", "max_az", "aos_open", "los_open"}]
    aos_open / los_open: the pass is already on at start / still on at the end of the window."""
    end = start + hours * 3600
    t = np.arange(start, end + COARSE_S, COARSE_S)
    el = look(sat, t, setup)["el"]
    above = el > 0
    passes = []
    i = 0
    n = len(t)
    while i < n:
        if not above[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and above[j + 1]:
            j += 1
        aos_open, los_open = i == 0, j == n - 1
        if aos_open:      # already on: look back for the real AOS
            tb = _edge(sat, start, -1, setup)
            aos, aos_open = (start, True) if tb is None else (_crossing(sat, tb, tb + COARSE_S, setup, True), False)
        else:
            aos = _crossing(sat, t[i - 1], t[i], setup, True)
        if los_open:      # still on at the end: look on for the real LOS
            tf = _edge(sat, t[j], 1, setup)
            los, los_open = (float(t[j]), True) if tf is None else (_crossing(sat, tf - COARSE_S, tf, setup, False), False)
        else:
            los = _crossing(sat, t[j], t[j + 1], setup, False)
        fine = np.arange(aos, los + DETAIL_S, DETAIL_S)
        fine[-1] = min(fine[-1], los)
        lk = look(sat, fine, setup)
        k = int(np.argmax(lk["el"]))
        if lk["el"][k] >= setup["min_el"]:
            top_t = np.clip(np.arange(fine[k] - DETAIL_S, fine[k] + DETAIL_S + 0.25, 0.25), aos, los)   # the top to 1/4 s
            top = look(sat, top_t, setup)
            m = int(np.argmax(top["el"]))
            passes.append({"aos": round(aos, 1), "los": round(los, 1), "max_t": round(float(top_t[m]), 1),
                           "max_el": round(float(top["el"][m]), 1), "aos_az": round(float(lk["az"][0]), 1),
                           "los_az": round(float(lk["az"][-1]), 1), "max_az": round(float(top["az"][m]), 1),
                           "aos_open": aos_open, "los_open": los_open})
        i = j + 1
    return passes


def passes(hours=48, start=None):
    """Timeline data for the satellites chosen in SETUP."""
    hours = max(1, min(HOURS_MAX, float(hours)))
    start = time.time() if start is None else start
    setup = load_setup()
    tle = tle_state()
    sats = satellites()
    rows, out = [], []
    for norad in setup["sats"]:
        s = sats.get(norad)
        if not s:
            rows.append({"norad": norad, "name": "", "missing": True})
            continue
        age = (start - s["epoch"]) / 86400
        rows.append({"norad": norad, "name": s["name"], "tle_age_days": round(age, 1), "tle_old": age > TLE_OLD_DAYS})
        for p in find_passes(s["sat"], start, hours, setup):
            out.append(dict(p, norad=norad, name=s["name"]))
    out.sort(key=lambda p: p["aos"])
    return {"now": start, "hours": hours, "setup": setup, "tle": tle, "sats": rows, "passes": out}


def pass_detail(norad, aos, los):
    """Samples of one pass every DETAIL_S seconds: t, az, el, range, rate and the Doppler shift per MHz."""
    setup = load_setup()
    s = satellites().get(int(norad))
    if not s:
        raise KeyError(f"satellite {norad} is not in the orbital elements")
    aos, los = float(aos), float(los)
    if not 0 < los - aos <= 24 * 3600:
        raise ValueError("wrong pass times")
    t = np.arange(aos, los + DETAIL_S, DETAIL_S)
    t[-1] = min(t[-1], los)
    lk = look(s["sat"], t, setup)
    return {"norad": int(norad), "name": s["name"], "setup": setup,
            "tle_epoch": s["epoch"],
            "samples": [{"t": round(float(t[i]), 1), "az": round(float(lk["az"][i]), 2), "el": round(float(lk["el"][i]), 2),
                         "range": round(float(lk["range"][i]), 1), "rate": round(float(lk["rate"][i]), 4),
                         "doppler_hz_per_mhz": round(float(-lk["rate"][i] / C_KM_S * 1e6), 1)} for i in range(len(t))]}


def world_map(start=None):
    """Ground tracks of the satellites chosen for the map: from half an orbit back to one orbit ahead, MAP_POINTS
    samples each (the page interpolates between them and draws the footprint around the point below the satellite)."""
    start = time.time() if start is None else start
    setup = load_setup()
    tle = tle_state()
    sats = satellites()
    out = []
    for norad in setup["map_sats"]:
        s = sats.get(norad)
        if not s:
            continue
        period = 2 * math.pi / s["sat"].no_kozai * 60          # no_kozai: mean motion in rad/min
        step = max(10.0, 1.5 * period / MAP_POINTS)
        t = start - period / 2 + np.arange(MAP_POINTS + 1) * step
        sp, lk = subpoint(s["sat"], t), look(s["sat"], t, setup)
        ok = sp["ok"] & lk["ok"]
        out.append({"norad": norad, "name": s["name"], "period_min": round(period / 60, 2),
                    "tle_age_days": round((start - s["epoch"]) / 86400, 1),
                    "samples": [[round(float(t[i]), 1), round(float(sp["lat"][i]), 3), round(float(sp["lon"][i]), 3),
                                 round(float(sp["alt"][i]), 1), round(float(lk["az"][i]), 2), round(float(lk["el"][i]), 2),
                                 round(float(lk["range"][i]), 1), round(float(lk["rate"][i]), 4)] for i in range(len(t)) if ok[i]]})
    names = {n: sats[n]["name"] for n in set(setup["sats"]) | set(setup["map_sats"]) if n in sats}
    return {"now": start, "setup": setup, "tle": tle, "fields": ["t", "lat", "lon", "alt", "az", "el", "range", "rate"],
            "sats": out, "names": names}


def sat_groups():
    """{norad: [group]}; a file from before the groups: everything is amateur."""
    try:
        with open(GROUPS_PATH, encoding="utf-8") as f:
            groups = json.load(f)
    except (OSError, ValueError):
        return {}
    out = {}
    for key, norads in groups.items():
        for n in norads:
            out.setdefault(int(n), []).append(key)
    return out


def catalog():
    """All satellites in the orbital elements, for the choice in SETUP, with their CelesTrak groups."""
    tle = tle_state()
    now = time.time()
    groups = sat_groups()
    return {"tle": tle, "groups": [{"key": k, "title": t} for k, t in TLE_GROUPS],
            "sats": sorted(({"norad": n, "name": s["name"], "tle_age_days": round((now - s["epoch"]) / 86400, 1),
                             "groups": groups.get(n, ["amateur"])}
                            for n, s in satellites().items()), key=lambda r: r["name"].lower())}


# ---------- transmitters (SatNOGS DB) ----------

TX_URL = "https://db.satnogs.org/api/transmitters/?format=json"
TX_PATH = data("sat_transmitters.json")
TX_MAX_AGE_S = 7 * 24 * 3600
TX_TIMEOUT_S = 60
TX_MAX_BYTES = 20_000_000
_tx = {"mtime": None, "by_norad": {}, "last_try": 0.0, "error": ""}

# SatNOGS mode -> RADIMCOM mode; anything else (digital modes) is received in USB for a decoder or a recording
TX_MODES = {"FM": "FM", "FMN": "FM", "AFSK": "FM", "SSTV": "FM", "DUV": "FM", "AFSK S-Net": "FM",
            "GFSK": "FM", "USB": "USB", "LSB": "LSB", "CW": "CW", "AM": "AM"}


def rx_mode(mode):
    """Receive mode for a SatNOGS transmitter mode: data on FSK / GFSK / GMSK / MSK (any variant such as
    "GMSK USP" or "FSK AX.100 Mode 5") is frequency modulation, so FM; unknown modes USB."""
    mode = mode or ""
    if mode in TX_MODES:
        return TX_MODES[mode]
    return "FM" if "FSK" in mode.upper() or "MSK" in mode.upper() else "USB"


def _tx_download():
    req = urllib.request.Request(TX_URL, headers={"User-Agent": "RADIMCOM"})
    with urllib.request.urlopen(req, timeout=TX_TIMEOUT_S) as r:
        raw = r.read(TX_MAX_BYTES + 1)
    if len(raw) > TX_MAX_BYTES:
        raise ValueError("answer too long")
    keep = []
    for t in json.loads(raw.decode("utf-8")):
        if t.get("status") != "active" or not t.get("alive") or not t.get("downlink_low") or not t.get("norad_cat_id"):
            continue
        keep.append({k: t.get(k) for k in ("uuid", "norad_cat_id", "description", "type", "downlink_low", "downlink_high",
                                           "uplink_low", "uplink_high", "mode", "invert", "baud")})
    if not keep:
        raise ValueError("no transmitters in the answer")
    return keep


def transmitters(norad, refresh=False):
    """Active transmitters of a satellite with a downlink, transponders and transceivers first.
    -> {"transmitters": [...], "fetched": unix time or None, "error": text of the last failed download}"""
    with _lock:
        try:
            mtime = os.path.getmtime(TX_PATH)
        except OSError:
            mtime = None
        stale = mtime is None or time.time() - mtime > TX_MAX_AGE_S
        if refresh or (stale and time.time() - _tx["last_try"] > TLE_RETRY_S):
            _tx["last_try"] = time.time()
            try:
                keep = _tx_download()
                tmp = f"{TX_PATH}.{os.getpid()}.tmp"
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(keep, f, separators=(",", ":"))
                os.replace(tmp, TX_PATH)
                mtime, _tx["error"] = os.path.getmtime(TX_PATH), ""
            except (OSError, ValueError) as e:
                _tx["error"] = str(getattr(e, "reason", e))
        if mtime is not None and _tx["mtime"] != mtime:
            try:
                with open(TX_PATH, encoding="utf-8") as f:
                    rows = json.load(f)
            except (OSError, ValueError):
                rows = []
            by = {}
            for t in rows:
                by.setdefault(t["norad_cat_id"], []).append(t)
            _tx.update(mtime=mtime, by_norad=by)
        order = {"Transponder": 0, "Transceiver": 1, "Transmitter": 2}
        rows = sorted(_tx["by_norad"].get(int(norad), []), key=lambda t: (order.get(t["type"], 3), t["downlink_low"]))
        return {"transmitters": [dict(t, rx_mode=rx_mode(t["mode"])) for t in rows],
                "fetched": mtime, "error": _tx["error"]}


def transmitter(norad, uuid):
    return next((t for t in transmitters(norad)["transmitters"] if t["uuid"] == uuid), None)


# ---------- Doppler correction of the receive frequency ----------

class Doppler:
    """Keeps the VFO on the downlink of a satellite: received = sent x (1 - range rate / c).
    Tuning the VFO by hand moves the frequency within the transponder (it is taken back to the satellite frame and kept).
    Runs in a thread of the VFO process, so it goes on when the page is closed."""

    TICK_S = 0.25
    LEAD_S = 0.5          # the frequency for a moment ahead: retuning takes a little time
    MIN_GAP_S = 1.0       # at most one retune per second
    STEP_HZ = {}          # retune steps per mode (none now: all modes use STEP_FINE_HZ)
    STEP_FINE_HZ = 5.0    # retune when the error is this big; keep above HAND_HZ
    HAND_HZ = 3.0         # a VFO frequency this far from the last one set counts as tuned by hand
    AWAY_HZ = 50_000.0    # tuned further than this outside the transponder: Doppler stops

    def __init__(self, set_freq, get_freq, get_mode, set_mode, clock=time.time):
        self.set_freq, self.get_freq, self.get_mode, self.set_mode = set_freq, get_freq, get_mode, set_mode
        self.clock = clock
        self.lock = threading.Lock()
        self.thread = None
        self.on = False
        self.norad = None
        self.name = self.label = self.uuid = ""
        self.f_nominal = self.f_sat = None    # Hz as sent by the satellite: from the transmitter data / now (hand tuning)
        self.span = (None, None)              # transponder downlink range (Hz), None for a single frequency
        self.last_set = None
        self.last_set_at = 0.0
        self.now = {}                         # last calculation: rate, factor, az, el, f_rx
        self.error = ""
        self.stopped = ""                     # why it stopped by itself

    def start(self, norad, f_sat, name, label="", uuid="", span=(None, None), mode=None):
        sat = satellites().get(int(norad))
        if not sat:
            return f"satellite {norad} is not in the orbital elements"
        if mode:
            err = self.set_mode(mode)
            if err:
                return err
        self.stop()
        with self.lock:
            self.norad, self.name, self.label, self.uuid = int(norad), name or sat["name"], label, uuid
            self.f_nominal = self.f_sat = float(f_sat)
            self.span = span
            self.last_set, self.error, self.stopped, self.now = None, "", "", {}
            self.on = True
            self.thread = threading.Thread(target=self._run, name="doppler", daemon=True)
            self.thread.start()
        return None

    def stop(self, reason=""):
        with self.lock:
            thread, self.on = self.thread, False
            self.thread = None
            if reason:
                self.stopped = reason
        if thread and thread is not threading.current_thread():
            thread.join(2.0)

    def info(self):
        try:
            step = self.STEP_HZ.get(self.get_mode(), self.STEP_FINE_HZ)
        except Exception:
            step = self.STEP_FINE_HZ
        with self.lock:
            return {"on": self.on, "step": step, "norad": self.norad, "name": self.name, "label": self.label, "uuid": self.uuid,
                    "f_nominal": self.f_nominal, "f_sat": self.f_sat, "span": list(self.span), "last_set": self.last_set,
                    "error": self.error, "stopped": self.stopped, **self.now}

    def _run(self):
        while True:
            with self.lock:
                if not self.on:
                    return
            try:
                self._tick()
            except Exception as e:        # never leave the VFO tuned by a dead loop without saying so
                print(f"Doppler stopped: {e}")
                self.stop(f"calculation failed: {e}")
                return
            time.sleep(self.TICK_S)

    def _tick(self):
        sat = satellites().get(self.norad)
        if not sat:
            self.stop("the satellite is no longer in the orbital elements")
            return
        now = self.clock()
        lk = look(sat["sat"], np.array([now + self.LEAD_S]), load_setup())
        if not lk["ok"][0]:
            self.stop("SGP4 error (decayed satellite or bad elements)")
            return
        rate = float(lk["rate"][0])
        factor = 1.0 - rate / C_KM_S
        cur = float(self.get_freq())
        with self.lock:
            if not self.on:
                return
            if self.last_set is not None and abs(cur - self.last_set) > self.HAND_HZ:
                f_sat = cur / factor                     # tuned by hand: a new frequency in the transponder
                lo, hi = self.span
                lo, hi = (lo, hi) if lo else (self.f_nominal, self.f_nominal)
                if f_sat < lo - self.AWAY_HZ or f_sat > (hi or lo) + self.AWAY_HZ:
                    self.on = False
                    self.thread = None
                    self.stopped = f"the VFO was tuned away from the satellite ({cur / 1e6:.4f} MHz)"
                    return
                self.f_sat, self.last_set = f_sat, cur
            f_rx = self.f_sat * factor
            self.now = {"rate": round(rate, 4), "factor": factor, "az": round(float(lk["az"][0]), 2),
                        "el": round(float(lk["el"][0]), 2), "f_rx": round(f_rx, 1), "shift": round(f_rx - self.f_sat, 1)}
            step = self.STEP_HZ.get(self.get_mode(), self.STEP_FINE_HZ)
            due = self.last_set is None or (abs(f_rx - self.last_set) >= step and now - self.last_set_at >= self.MIN_GAP_S)
            target = round(f_rx)
        if due:
            err = self.set_freq(target)
            with self.lock:
                if err:
                    self.error = err
                    self.on = False
                    self.thread = None
                    self.stopped = f"the VFO refused the frequency: {err}"
                else:
                    self.error = ""
                    self.last_set, self.last_set_at = float(target), now
