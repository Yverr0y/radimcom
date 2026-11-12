"""Station location (MENU › SETUP › LOCATION), shared by all VFOs: Maidenhead locator, latitude, longitude, altitude.

Used by the satellites (passes, Doppler, rotor), the packet decoder (APRS distances, map), ACARS / VDL2, HFDL and AIS (maps).
File data\\location.json. Until it exists, the location saved by older versions in sat_setup.json is taken over;
a new installation starts at 0.0 / 0.0 (to be set by the user). Needs no extra package (unlike sattrack, sgp4).
"""
import json
import os
import threading

from paths import data

LOCATION_PATH = data("location.json")
OLD_SAT_SETUP_PATH = data("sat_setup.json")   # versions up to 0.113 kept the station there

DEFAULT_LAT = 0.0
DEFAULT_LON = 0.0
DEFAULT_ALT_M = 0.0

_lock = threading.Lock()


def locator_to_latlon(loc):
    """Maidenhead locator (4, 6 or 8 characters) -> centre of the square (lat, lon). ValueError if it is not one."""
    loc = loc.strip().upper()
    if len(loc) not in (4, 6, 8) or not ("A" <= loc[0] <= "R" and "A" <= loc[1] <= "R" and loc[2:4].isdigit()):
        raise ValueError("a locator has 4, 6 or 8 characters, for example JN88WQ")
    lon = (ord(loc[0]) - 65) * 20 - 180 + int(loc[2]) * 2
    lat = (ord(loc[1]) - 65) * 10 - 90 + int(loc[3])
    w, h = 2.0, 1.0
    if len(loc) >= 6:
        if not ("A" <= loc[4] <= "X" and "A" <= loc[5] <= "X"):
            raise ValueError("characters 5 and 6 of a locator are letters A-X")
        w, h = w / 24, h / 24
        lon += (ord(loc[4]) - 65) * w
        lat += (ord(loc[5]) - 65) * h
    if len(loc) == 8:
        if not loc[6:8].isdigit():
            raise ValueError("characters 7 and 8 of a locator are digits")
        w, h = w / 10, h / 10
        lon += int(loc[6]) * w
        lat += int(loc[7]) * h
    return round(lat + h / 2, 5), round(lon + w / 2, 5)


def latlon_to_locator(lat, lon):
    lon, lat = min(lon + 180, 359.99999), min(lat + 90, 179.99999)   # 180° E / 90° N belong to the last square
    out = chr(65 + int(lon // 20)) + chr(65 + int(lat // 10))
    out += str(int(lon % 20 // 2)) + str(int(lat % 10))
    out += chr(65 + int(lon % 2 * 12)) + chr(65 + int(lat % 1 * 24))
    return out


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            s = json.load(f)
        return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


def load():
    """{"lat", "lon", "locator", "alt_m"}; taken over from sat_setup.json of an older version if location.json is missing."""
    s = _read(LOCATION_PATH)
    migrated = False
    if not s:
        old = _read(OLD_SAT_SETUP_PATH)
        s = {k: old[k] for k in ("lat", "lon", "locator", "alt_m") if k in old}
        migrated = "lat" in s and "lon" in s
    try:
        lat, lon = float(s["lat"]), float(s["lon"])
    except (KeyError, TypeError, ValueError):
        lat, lon = DEFAULT_LAT, DEFAULT_LON
        s.pop("locator", None)
    try:
        alt = float(s.get("alt_m", DEFAULT_ALT_M))
    except (TypeError, ValueError):
        alt = DEFAULT_ALT_M
    s = {"lat": lat, "lon": lon, "locator": s.get("locator") or latlon_to_locator(lat, lon), "alt_m": alt}
    if migrated:            # written at once: sattrack drops the location from sat_setup.json on its next save
        try:
            _write(s)
        except OSError:
            pass
    return s


def _write(s):
    tmp = f"{LOCATION_PATH}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(s, f, indent=2)
    os.replace(tmp, LOCATION_PATH)


def save(changes):
    """Checks and saves the changed fields ("locator" wins over "lat"/"lon"); returns the whole location.
    ValueError with the reason if a value is wrong."""
    with _lock:
        s = load()
        if changes.get("locator"):
            s["lat"], s["lon"] = locator_to_latlon(changes["locator"])
            s["locator"] = changes["locator"].strip().upper()
        elif "lat" in changes or "lon" in changes:
            lat, lon = float(changes.get("lat", s["lat"])), float(changes.get("lon", s["lon"]))
            if not (-90 <= lat <= 90 and -180 <= lon <= 180):
                raise ValueError("latitude -90 to 90, longitude -180 to 180")
            s["lat"], s["lon"], s["locator"] = round(lat, 5), round(lon, 5), latlon_to_locator(lat, lon)
        if "alt_m" in changes:
            alt = float(changes["alt_m"])
            if not -500 <= alt <= 9000:
                raise ValueError("altitude -500 to 9000 m")
            s["alt_m"] = alt
        _write(s)
        return s
