"""ADS-B / Mode S decoder: raw SDR samples on 1090 MHz -> aircraft (ICAO address, flight, altitude, speed, position).

Aircraft transponders answer the radars (Mode S) and broadcast their own position, speed and identity (ADS-B,
DF17 "extended squitter") on 1090 MHz: pulse position modulation, 1 Mbit/s, a 8 µs preamble (pulses at 0, 1, 3.5 and
4.5 µs) followed by 56 or 112 data bits, each bit a 0.5 µs pulse in the first (1) or the second (0) half of its
microsecond; 24 bits of CRC (parity, polynomial 0xFFF409) at the end.

Everything is done here in numpy, no external program (like the AIS decoder):

    receiver thread --raw block--> queue --worker thread--> magnitude -> preambles -> bits -> CRC -> messages -> aircraft

The magnitude is integrated (cumulative sum) so that the energy of any half-microsecond can be read at a fractional
sample position: the decoder works at any sample rate of 2 MS/s or more (2.4 MS/s on an RTL dongle, 2.5 MS/s on an
Airspy) and tries a few sub-sample phases of each preamble. The CRC is linear, so the parity of all candidates is computed
at once from a table of the syndrome of each bit (and a syndrome equal to that of a single bit fixes that bit).

Messages decoded: DF17 / DF18 ADS-B (identification and category, airborne and surface position with CPR decoding,
velocity, emergency / squawk, target state), DF11 all-call replies (address), DF0 / DF4 / DF16 / DF20 altitude and
DF5 / DF21 squawk replies (their parity is the address of the aircraft: they are accepted only for aircraft already
heard in DF11 / DF17).
"""
import collections
import json
import math
import os
import queue
import threading
import time
import urllib.request

import numpy as np

FREQ_HZ = 1090000000
RATE = 2400000            # RTL dongle: 2.4 MS/s
MIN_FS = 1900000          # the decoder needs about 2 samples per microsecond
SETTLE_S = 0.5            # the VFO must stay this long at a new centre / rate before decoding starts
EDGE_HZ = 600000          # 1090 MHz must be this far inside the received band (the signal is about ±0.5 MHz wide)
MAX_HISTORY = 500         # messages kept for the MESSAGES view
MAX_AIRCRAFT = 1000
TRAIL = 200               # positions kept of each aircraft
STALE_S = 600             # an aircraft not heard for 10 min is dropped
KNOWN_S = 60              # DF0/4/5/20/21 are accepted for an address heard in DF11/17 within this time
CPR_PAIR_S = 10           # an even and an odd position at most this far apart give a global position
PHASES = (-0.4, -0.2, 0.0, 0.2, 0.4)   # sub-sample phases tried for each preamble (in samples)
PREAMBLE_SNR = 1.7        # pulse energy / gap energy of a preamble
MIN_LEVEL = 2.0           # and the pulses this far above the median level of the block
PRESCREEN = 1.5          # quick screen of the starts: a sample this far above the median at the first pulses
PULSE_SNR = 1.3          # and each of the 4 pulses this far above the gaps
MAX_PICKS = 20000         # preamble candidates tried per block at most

POLY = 0xFFF409

KNOWN_DF = (0, 4, 5, 11, 16, 17, 18, 20, 21)
LONG_DF = (16, 17, 18, 19, 20, 21, 22, 24)
SHORT_DF = (0, 4, 5, 11)
DF_NAMES = {0: "Short air-air surveillance", 4: "Altitude reply", 5: "Identity reply", 11: "All-call reply",
            16: "Long air-air surveillance", 17: "ADS-B", 18: "ADS-B (non-transponder / TIS-B)", 20: "Comm-B altitude reply",
            21: "Comm-B identity reply"}

CHARSET = "#ABCDEFGHIJKLMNOPQRSTUVWXYZ##### ###############0123456789######"
CATEGORIES = {
    (4, 1): "light (< 7 t)", (4, 2): "small (7–34 t)", (4, 3): "large (34–136 t)", (4, 4): "high vortex large (B757)",
    (4, 5): "heavy (> 136 t)", (4, 6): "high performance", (4, 7): "rotorcraft",
    (3, 1): "glider / sailplane", (3, 2): "lighter than air", (3, 3): "parachutist / skydiver", (3, 4): "ultralight / hang glider",
    (3, 6): "UAV", (3, 7): "space vehicle",
    (2, 1): "surface emergency vehicle", (2, 3): "surface service vehicle", (2, 4): "ground obstruction", (2, 5): "cluster obstacle",
    (2, 6): "line obstacle",
}
EMERGENCY = {1: "general emergency", 2: "lifeguard / medical", 3: "minimum fuel", 4: "no communications", 5: "unlawful interference",
             6: "downed aircraft"}
# Aircraft heard here but without a position of their own: position, registration and type from the public ADS-B networks
NET_URLS = ("https://opendata.adsb.fi/api/v2/hex/{}", "https://api.adsb.lol/v2/hex/{}")
NET_GAP_S = 1.1           # adsb.fi allows 1 request per second
NET_AGAIN_S = 30          # an aircraft still without its own position is looked up again after this time
NET_RECENT_S = 60         # only aircraft heard within this time are looked up
NET_RANGE_S = 30          # range map from adsb.fi: a message heard here and the adsb.fi position at most this old (s)

SQUAWK_EMERGENCY = {"7500": "hijack", "7600": "radio failure", "7700": "emergency"}


# ---------------------------------------------------------------- CRC (parity) as a table of bit syndromes

def _crc_bytes(data):
    """Mode S CRC of the bytes (24 bits)."""
    c = 0
    for b in data:
        c ^= b << 16
        for _ in range(8):
            c = ((c << 1) ^ POLY) & 0xFFFFFF if c & 0x800000 else (c << 1) & 0xFFFFFF
    return c


def parity(msg):
    """Syndrome of a whole message (bytes): CRC of the data XOR the parity field. 0 = no error (DF11/17/18), the address
    of the aircraft for DF0/4/5/16/20/21."""
    return _crc_bytes(msg[:-3]) ^ int.from_bytes(msg[-3:], "big")


def _bit_syndromes(nbits):
    out = np.zeros(nbits, np.int64)
    for k in range(nbits):
        v = 1 << (nbits - 1 - k)
        out[k] = parity(v.to_bytes(nbits // 8, "big"))
    return out


SYN112 = _bit_syndromes(112)
SYN56 = _bit_syndromes(56)
FIX112 = {int(s): k for k, s in enumerate(SYN112) if k >= 5}     # syndrome of a single wrong bit (not in the DF) -> bit
FIX56 = {int(s): k for k, s in enumerate(SYN56) if k >= 5}
FIX112_KEYS = np.array(sorted(FIX112), np.int64)


# ---------------------------------------------------------------- field decoding

def _bits(msg, start, n):
    """n bits from bit start (1 = the first bit of the message, as in the standards) of the message bytes."""
    v = int.from_bytes(msg, "big")
    return (v >> (len(msg) * 8 - (start - 1) - n)) & ((1 << n) - 1)


def gillham(code13):
    """Altitude (ft) from a 13-bit AC field with Q = 0 and M = 0 (Gillham gray code, 100 ft steps); None if invalid."""
    # 13 bits: C1 A1 C2 A2 C4 A4 M B1 Q B2 D2 B4 D4
    c1, a1, c2, a2, c4, a4, _m, b1, _q, b2, d2, b4, d4 = ((code13 >> (12 - i)) & 1 for i in range(13))
    one_hundreds = (c1 << 2) | (c2 << 1) | c4
    five_hundreds = (d2 << 7) | (d4 << 6) | (a1 << 5) | (a2 << 4) | (a4 << 3) | (b1 << 2) | (b2 << 1) | b4

    def gray(g):
        b = 0
        while g:
            b ^= g
            g >>= 1
        return b

    hundreds = gray(one_hundreds)
    if hundreds in (0, 5, 6):
        return None
    if hundreds == 7:
        hundreds = 5
    fives = gray(five_hundreds)
    if fives % 2:
        hundreds = 6 - hundreds
    alt = fives * 500 + hundreds * 100 - 1300
    return alt if -1200 <= alt <= 126700 else None


def ac13_alt(ac):
    """Altitude (ft) of the 13-bit AC field of DF0/4/16/20; None if unknown or metric."""
    if ac == 0:
        return None
    m = (ac >> 6) & 1
    q = (ac >> 4) & 1
    if m:
        return None                                 # metric altitude: not used
    if q:
        n = ((ac & 0x1F80) >> 2) | ((ac & 0x20) >> 1) | (ac & 0x0F)
        return n * 25 - 1000
    return gillham(ac)


def ac12_alt(ac):
    """Altitude (ft) of the 12-bit field of an airborne position (DF17 TC 9–18)."""
    if ac == 0:
        return None
    q = (ac >> 4) & 1
    if q:
        n = ((ac & 0xFE0) >> 1) | (ac & 0x0F)
        return n * 25 - 1000
    # Q = 0: Gillham, the 12 bits are the 13-bit AC field without M
    return gillham(((ac & 0xFC0) << 1) | (ac & 0x3F))


def squawk(id13):
    """Mode A code (4 octal digits) from a 13-bit ID field."""
    c1, a1, c2, a2, c4, a4, _x, b1, d1, b2, d2, b4, d4 = ((id13 >> (12 - i)) & 1 for i in range(13))
    a = a4 * 4 + a2 * 2 + a1
    b = b4 * 4 + b2 * 2 + b1
    c = c4 * 4 + c2 * 2 + c1
    d = d4 * 4 + d2 * 2 + d1
    return f"{a}{b}{c}{d}"


def callsign(me):
    """Flight number / call sign from the ME field (56 bits) of an identification message."""
    s = "".join(CHARSET[(me >> (42 - 6 * i)) & 0x3F] for i in range(8))
    return s.replace("#", "").strip()


# ---------------------------------------------------------------- CPR position decoding

def _nl(lat):
    """Number of longitude zones at a latitude (1090-WP-9-14)."""
    lat = abs(lat)
    if lat >= 87.0:
        return 1 if lat > 87.0 else 2
    if lat < 1e-9:
        return 59
    a = 1 - math.cos(math.pi / 30)
    b = math.cos(math.pi / 180 * lat) ** 2
    return int(math.floor(2 * math.pi / math.acos(1 - a / b)))


def _mod(a, b):
    r = a % b
    return r + b if r < 0 else r


def cpr_global(even, odd, newest_odd, surface=False, ref=None):
    """Global position from an even and an odd frame ((lat_cpr, lon_cpr) of 17 bits each); newest_odd: the odd one is newer.
    Surface positions (90° zones) need a reference (lat, lon) to pick the quadrant. Returns (lat, lon) or None."""
    span = 90.0 if surface else 360.0
    d_lat0, d_lat1 = span / 60, span / 59
    lat0, lon0 = even[0] / 131072, even[1] / 131072
    lat1, lon1 = odd[0] / 131072, odd[1] / 131072
    j = math.floor(59 * lat0 - 60 * lat1 + 0.5)
    rlat0 = d_lat0 * (_mod(j, 60) + lat0)
    rlat1 = d_lat1 * (_mod(j, 59) + lat1)
    if surface:
        if ref is None:
            return None
        # the northern solution is in 0..90; the southern one 90° lower: take the one nearest the reference
        rlat0 = min((rlat0, rlat0 - 90), key=lambda v: abs(v - ref[0]))
        rlat1 = min((rlat1, rlat1 - 90), key=lambda v: abs(v - ref[0]))
    else:
        if rlat0 >= 270:
            rlat0 -= 360
        if rlat1 >= 270:
            rlat1 -= 360
    if not (-90 <= rlat0 <= 90 and -90 <= rlat1 <= 90):
        return None
    if _nl(rlat0) != _nl(rlat1):
        return None                                # the two frames straddle a zone boundary: wait for the next pair
    if newest_odd:
        lat = rlat1
        nl = _nl(lat)
        ni = max(nl - 1, 1)
        m = math.floor(lon0 * (nl - 1) - lon1 * nl + 0.5)
        lon = (span / ni) * (_mod(m, ni) + lon1)
    else:
        lat = rlat0
        nl = _nl(lat)
        ni = max(nl, 1)
        m = math.floor(lon0 * (nl - 1) - lon1 * nl + 0.5)
        lon = (span / ni) * (_mod(m, ni) + lon0)
    if surface:
        lon = min((lon + k * 90 for k in range(-4, 4)), key=lambda v: abs(_wrap(v - ref[1])))
    lon = _wrap(lon)
    return lat, lon


def cpr_local(cpr, odd, ref, surface=False):
    """Position from one frame and a reference within 180 NM (45 NM on the surface)."""
    span = 90.0 if surface else 360.0
    d_lat = span / (59 if odd else 60)
    lat_c, lon_c = cpr[0] / 131072, cpr[1] / 131072
    j = math.floor(ref[0] / d_lat) + math.floor(0.5 + _mod(ref[0], d_lat) / d_lat - lat_c)
    lat = d_lat * (j + lat_c)
    if not -90 <= lat <= 90:
        return None
    ni = max(_nl(lat) - (1 if odd else 0), 1)
    d_lon = span / ni
    m = math.floor(ref[1] / d_lon) + math.floor(0.5 + _mod(ref[1], d_lon) / d_lon - lon_c)
    return lat, _wrap(d_lon * (m + lon_c))


def _wrap(lon):
    return (lon + 180) % 360 - 180


def distance_km(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 6371.0 * 2 * math.asin(min(1.0, math.sqrt(a)))


def bearing(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


# ---------------------------------------------------------------- range (coverage) per azimuth, kept between runs

RANGE_BANDS = (("10000", 10000), ("20000", 20000), ("30000", 30000), ("max", None))   # up to this altitude (ft); max = any
RANGE_BIN_DEG = 2                 # azimuth sectors
RANGE_SAVE_S = 60                 # written to the file at most this often (and when ADS-B is turned off)
RANGE_QTH_KM = 2.0                # the station moved more than this: the old range no longer applies


class RangeMap:
    """The farthest position decoded in each 2° azimuth sector from the station, for altitudes up to 10000, 20000,
    30000 ft and for any altitude. Saved as JSON (merged with the file, so two runs do not overwrite each other's best)."""

    def __init__(self, path=None):
        self.path = path
        self.lock = threading.Lock()
        self.qth = None
        self.bands = {}                   # name -> {bin: [dist_km, lat, lon, alt, time]}
        self.changed = False
        self.saved = 0.0
        self.since = None
        self.reload()

    def _empty(self):
        return {name: {} for name, _ in RANGE_BANDS}

    def _read(self):
        if not self.path or not os.path.exists(self.path):
            return None
        try:
            with open(self.path, encoding="utf-8") as f:
                d = json.load(f)
            return {"qth": d.get("qth"), "since": d.get("since"),
                    "bands": {name: {int(k): v for k, v in (d.get("bands", {}).get(name) or {}).items()} for name, _ in RANGE_BANDS}}
        except (OSError, ValueError, TypeError, AttributeError):
            return None

    def reload(self):
        d = self._read()
        self.bands = d["bands"] if d else self._empty()
        self.qth = tuple(d["qth"]) if d and d.get("qth") else None
        self.since = d.get("since") if d else None

    def add(self, qth, lat, lon, alt, now, net=False):
        if not qth:
            return
        with self.lock:
            if self.qth is None or distance_km(self.qth[0], self.qth[1], *qth) > RANGE_QTH_KM:
                self.qth, self.bands, self.since = (round(qth[0], 5), round(qth[1], 5)), self._empty(), round(now)
                self.changed = True
            if self.since is None:
                self.since = round(now)
            dist = distance_km(qth[0], qth[1], lat, lon)
            b = int(bearing(qth[0], qth[1], lat, lon) // RANGE_BIN_DEG) % (360 // RANGE_BIN_DEG)
            for name, top in RANGE_BANDS:
                if top is not None and (alt is None or alt > top):
                    continue
                cur = self.bands[name].get(b)
                if cur is None or dist > cur[0]:
                    self.bands[name][b] = [round(dist, 1), round(lat, 4), round(lon, 4), alt, round(now)] + ([1] if net else [])
                    self.changed = True

    def info(self):
        with self.lock:
            return {"qth": self.qth, "since": self.since, "bin_deg": RANGE_BIN_DEG,
                    "bands": {name: {str(k): v for k, v in sorted(self.bands[name].items())} for name, _ in RANGE_BANDS},
                    "max_km": {name: max((v[0] for v in self.bands[name].values()), default=None) for name, _ in RANGE_BANDS}}

    def clear(self):
        with self.lock:
            self.bands, self.since, self.changed = self._empty(), round(time.time()), False
        self._write(merge=False)

    def save(self, force=False):
        if not self.changed or not self.path or (not force and time.time() - self.saved < RANGE_SAVE_S):
            return
        self._write(merge=True)

    def _write(self, merge):
        if not self.path:
            return
        with self.lock:
            if merge:
                old = self._read()
                if old and old.get("qth") and self.qth and distance_km(old["qth"][0], old["qth"][1], *self.qth) <= RANGE_QTH_KM:
                    for name, _ in RANGE_BANDS:
                        for b, v in old["bands"][name].items():
                            if b not in self.bands[name] or v[0] > self.bands[name][b][0]:
                                self.bands[name][b] = v
                    if old.get("since") and (self.since is None or old["since"] < self.since):
                        self.since = old["since"]
            d = {"qth": self.qth, "since": self.since, "bin_deg": RANGE_BIN_DEG,
                 "bands": {name: {str(k): v for k, v in sorted(self.bands[name].items())} for name, _ in RANGE_BANDS}}
            self.changed = False
            self.saved = time.time()
        try:
            os.makedirs(os.path.dirname(self.path), exist_ok=True)
            tmp = self.path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(d, f, separators=(",", ":"))
            os.replace(tmp, self.path)
        except OSError:
            self.changed = True


# ---------------------------------------------------------------- one message

def decode(msg):
    """Fields of a message (bytes, parity already checked). Returns a dict: df, icao (hex), and what it carries."""
    df = msg[0] >> 3
    r = {"df": df}
    if df in (17, 18):
        r["icao"] = f"{_bits(msg, 9, 24):06X}"
        if df == 18 and (msg[0] & 7) not in (0, 1, 6):
            r["kind"] = "TIS-B / ADS-R"
            r["tisb"] = True
        me = int.from_bytes(msg[4:11], "big")
        tc = me >> 51
        r["tc"] = tc
        _decode_me(me, tc, r)
    elif df == 11:
        r["icao"] = f"{_bits(msg, 9, 24):06X}"
        r["kind"] = "All-call reply"
    elif df in (0, 4, 16, 20):
        r["alt"] = ac13_alt(_bits(msg, 20, 13))
        if df in (0, 16):
            r["ground"] = bool(_bits(msg, 6, 1))
        elif _bits(msg, 6, 3) in (1, 3):
            r["ground"] = True
        r["kind"] = "Altitude" if df != 0 else "Air-air (altitude)"
        if df == 20:
            _decode_commb(msg, r)
    elif df in (5, 21):
        r["squawk"] = squawk(_bits(msg, 20, 13))
        if _bits(msg, 6, 3) in (1, 3):
            r["ground"] = True
        r["kind"] = "Squawk"
        if df == 21:
            _decode_commb(msg, r)
    return r


def _decode_commb(msg, r):
    """Comm-B reply: only the aircraft identification (BDS 2,0) is read; the other registers need interrogation context."""
    mb = int.from_bytes(msg[4:11], "big")
    if mb >> 48 == 0x20:
        cs = callsign(mb)
        if cs and "#" not in cs and all(c.isalnum() for c in cs):
            r["flight"] = cs


def _decode_me(me, tc, r):
    if 1 <= tc <= 4:
        r["kind"] = "Identification"
        r["flight"] = callsign(me)
        cat = (me >> 48) & 7
        r["category"] = CATEGORIES.get((tc, cat), "")
        r["cat"] = f"{'DCBA'[tc - 1]}{cat}" if cat else ""
    elif 5 <= tc <= 8:
        r["kind"] = "Surface position"
        r["ground"] = True
        mov = (me >> 44) & 0x7F
        if mov == 1:
            r["gs"] = 0.0
        elif 2 <= mov <= 124:
            r["gs"] = _surface_speed(mov)
        if (me >> 43) & 1:
            r["track"] = round(((me >> 36) & 0x7F) * 360 / 128, 1)
        r["cpr"] = ((me >> 17) & 0x1FFFF, me & 0x1FFFF)
        r["odd"] = bool((me >> 34) & 1)
        r["surface"] = True
    elif 9 <= tc <= 18 or 20 <= tc <= 22:
        r["kind"] = "Airborne position"
        alt12 = (me >> 36) & 0xFFF
        if tc <= 18:
            r["alt"] = ac12_alt(alt12)
        elif alt12:
            r["alt_geo"] = round(alt12 * 3.28084)     # GNSS height in metres
        r["cpr"] = ((me >> 17) & 0x1FFFF, me & 0x1FFFF)
        r["odd"] = bool((me >> 34) & 1)
        r["surface"] = False
        ss = (me >> 49) & 3
        if ss == 1:
            r["alert"] = "permanent alert (emergency squawk)"
        elif ss == 2:
            r["alert"] = "temporary alert (squawk changed)"
        elif ss == 3:
            r["alert"] = "SPI (ident)"
    elif tc == 19:
        r["kind"] = "Velocity"
        st = (me >> 48) & 7
        if st in (1, 2):
            mult = 4 if st == 2 else 1
            ew_dir, ew = (me >> 42) & 1, (me >> 32) & 0x3FF
            ns_dir, ns = (me >> 31) & 1, (me >> 21) & 0x3FF
            if ew and ns:
                vx = (ew - 1) * mult * (-1 if ew_dir else 1)
                vy = (ns - 1) * mult * (-1 if ns_dir else 1)
                r["gs"] = round(math.hypot(vx, vy), 1)
                r["track"] = round((math.degrees(math.atan2(vx, vy)) + 360) % 360, 1)
        elif st in (3, 4):
            if (me >> 42) & 1:
                r["hdg"] = round(((me >> 32) & 0x3FF) * 360 / 1024, 1)
            asp = (me >> 21) & 0x3FF
            if asp:
                v = (asp - 1) * (4 if st == 4 else 1)
                r["tas" if (me >> 31) & 1 else "ias"] = v
        vr = (me >> 10) & 0x1FF
        if vr:
            r["vrate"] = (vr - 1) * 64 * (-1 if (me >> 19) & 1 else 1)
        diff = me & 0x7F
        if diff:
            r["geo_diff"] = (diff - 1) * 25 * (-1 if (me >> 7) & 1 else 1)
    elif tc == 28:
        st = (me >> 48) & 7
        if st == 1:
            r["kind"] = "Emergency / squawk"
            em = (me >> 45) & 7
            r["squawk"] = squawk((me >> 32) & 0x1FFF)
            r["emergency"] = EMERGENCY.get(em, "") if em else ""
        elif st == 2:
            r["kind"] = "TCAS resolution advisory"
    elif tc == 29:
        r["kind"] = "Target state"
        if (me >> 49) & 3 == 1:                    # version 2: selected altitude and QNH
            sa = (me >> 36) & 0x7FF
            if sa:
                r["sel_alt"] = (sa - 1) * 32
            qnh = (me >> 27) & 0x1FF
            if qnh:
                r["qnh"] = round(800 + (qnh - 1) * 0.8, 1)
    elif tc == 31:
        r["kind"] = "Operational status"
        r["version"] = (me >> 13) & 7
    else:
        r["kind"] = f"ADS-B type {tc}"


def net_lookup(icao):
    """The aircraft as the public ADS-B networks see it now (adsb.fi, else adsb.lol), or None when not there / no internet."""
    for url in NET_URLS:
        try:
            req = urllib.request.Request(url.format(icao.lower()), headers={"User-Agent": "RADIMCOM"})
            with urllib.request.urlopen(req, timeout=6) as r:
                ac = json.load(r).get("ac") or []
        except Exception:
            continue
        if not ac:
            return {"found": False, "src": "adsb.fi" if "adsb.fi" in url else "adsb.lol", "lat": None, "lon": None}
        a = ac[0]
        alt = a.get("alt_baro")
        lat, lon = a.get("lat"), a.get("lon")
        if lat is None and a.get("lastPosition"):
            lat, lon = a["lastPosition"].get("lat"), a["lastPosition"].get("lon")
        return {"found": True, "src": "adsb.fi" if "adsb.fi" in url else "adsb.lol", "reg": a.get("r", ""), "type": a.get("t", ""),
                "desc": a.get("desc", ""), "callsign": (a.get("flight") or "").strip(), "lat": lat, "lon": lon,
                "seen_pos": a.get("seen_pos"), "alt": alt if isinstance(alt, (int, float)) else None, "ground": alt == "ground",
                "gs": a.get("gs"), "track": a.get("track", a.get("true_heading"))}
    return None


def _surface_speed(mov):
    """Ground speed (kt) of the movement field of a surface position."""
    steps = ((2, 9, 0.125, 0.125), (9, 13, 1.0, 0.5), (13, 39, 2.0, 1.0), (39, 94, 15.0, 2.0), (94, 109, 70.0, 5.0),
             (109, 124, 100.0, 10.0))
    for lo, hi, base, step in steps:
        if lo <= mov < hi:
            return round(base + (mov - lo) * step, 2)
    return 175.0


# ---------------------------------------------------------------- demodulation of a block of samples

class Demod:
    """Finds Mode S messages in the magnitude of the samples. Keeps the end of the previous block, so a message on the
    boundary is not lost."""

    def __init__(self, fs):
        self.fs = float(fs)
        self.spu = self.fs / 1e6                       # samples per microsecond
        self.keep = int(math.ceil(122 * self.spu)) + 4  # preamble 8 µs + 112 bits + margin
        self.tail = np.zeros(0, np.float32)
        self.t_tail = 0.0                              # time of the first sample of the tail
        # bit k of a message starting at sample s: first half [s + (8 + k) µs, + 0.5 µs], second half until + 1 µs
        k = np.arange(112, dtype=np.float64)
        self.b0 = (8.0 + k) * self.spu
        self.b1 = (8.5 + k) * self.spu
        self.b2 = (9.0 + k) * self.spu

    def process(self, mag, t_end):
        """mag: magnitude of the new samples, t_end: time of the end of the block. Returns [(bits (np.uint8 112),
        start offset, level, time)] of the candidates that pass the preamble test (the caller checks their parity)."""
        buf = np.concatenate((self.tail, mag))
        n = len(buf)
        t0 = t_end - n / self.fs
        if n < self.keep + 8:
            self.tail = buf
            return []
        c = np.empty(n + 1, np.float64)
        c[0] = 0.0
        np.cumsum(buf, out=c[1:])
        spu = self.spu
        m = n - self.keep                              # starts examined in this block
        noise = float(np.median(buf[::4])) + 1e-9
        self.tail = buf[m:]
        # quick screen: a sample above 1.5 × the median level at the starts of the pulses at 0, 1 and 3.5 µs
        # (in noise about 5 % of the starts pass; only these are looked at closely)
        thr = PRESCREEN * noise
        hot = buf > thr
        hot2 = hot[:-1] | hot[1:]                      # either of two neighbouring samples (a pulse is ≥ 1 sample long)

        def near(a_us):
            i = int(a_us * spu)
            return hot2[i:i + m]

        idx = np.flatnonzero(near(0) & near(1.0) & near(3.5))
        if not len(idx):
            return None
        cache = {}

        def at(a_us):
            """Cumulative sum at start + a µs for the screened starts (linear between samples)."""
            if a_us not in cache:
                x = a_us * spu
                i = int(x)
                f = x - i
                lo_ = c[idx + i]
                cache[a_us] = lo_ + f * (c[idx + i + 1] - lo_) if f else lo_
            return cache[a_us]

        def energy(a_us, b_us):
            return at(a_us) - at(b_us)

        # pulses at 0, 1, 3.5, 4.5 µs (0.5 µs each); quiet at 0.5–1, 1.5–3.5, 5–7.5 µs
        p1, p2, p3, p4 = energy(0.5, 0), energy(1.5, 1.0), energy(4.0, 3.5), energy(5.0, 4.5)
        hi = (p1 + p2 + p3 + p4) / (2.0 * spu)
        lo = (energy(1.0, 0.5) + energy(3.5, 1.5) + energy(7.5, 5.0)) / (5.0 * spu)
        # every pulse on its own above the quiet parts (the average alone lets noise spikes through)
        pmin = np.minimum(np.minimum(p1, p2), np.minimum(p3, p4)) / (0.5 * spu)
        ok = (hi > PREAMBLE_SNR * lo) & (pmin > PULSE_SNR * lo) & (hi > MIN_LEVEL * noise)
        if not ok.any():
            return None
        idx, hi, lo = idx[ok], hi[ok], lo[ok]
        # one per pulse group: the best score within ±1 µs (non-maximum suppression)
        w = max(1, int(round(spu)))
        score = hi / (lo + 1e-9)
        sel = np.ones(len(idx), bool)
        for d in range(1, 2 * w + 2):                  # neighbours among the screened starts within ±w samples
            if d >= len(idx):
                break
            close = (idx[d:] - idx[:-d]) <= w
            sel[d:] &= ~(close & (score[:-d] > score[d:]))      # a better one before
            sel[:-d] &= ~(close & (score[d:] >= score[:-d]))    # a better or equal one after
        picks, hi_p = idx[sel], hi[sel]
        if len(picks) > 1:
            k = np.diff(picks, prepend=-10 * w) > w
            picks, hi_p = picks[k], hi_p[k]
        hi_p = hi_p[:MAX_PICKS]
        picks = picks[:MAX_PICKS]
        nph = len(PHASES)
        starts = np.repeat(picks.astype(np.float64), nph) + np.tile(PHASES, len(picks))
        group = np.repeat(np.arange(len(picks)), nph)
        # first the 5 bits of the downlink format: only known formats are sliced further
        base = starts[:, None]
        e1 = _interp(c, base + self.b1[:5]) - _interp(c, base + self.b0[:5])
        e2 = _interp(c, base + self.b2[:5]) - _interp(c, base + self.b1[:5])
        b5 = (e1 > e2)
        df = (b5[:, 0] * 16 + b5[:, 1] * 8 + b5[:, 2] * 4 + b5[:, 3] * 2 + b5[:, 4]).astype(np.int64)
        keep = np.isin(df, KNOWN_DF)
        if not keep.any():
            return None
        starts, group = starts[keep], group[keep]
        base = starts[:, None]
        e1 = _interp(c, base + self.b1) - _interp(c, base + self.b0)
        e2 = _interp(c, base + self.b2) - _interp(c, base + self.b1)
        return {"bits": (e1 > e2).astype(np.uint8), "conf": np.abs(e1 - e2) / (e1 + e2 + 1e-12),
                "level": hi_p[group], "start": starts, "time": t0 + starts / self.fs, "group": group}


_u = (np.arange(256, dtype=np.float32) - 127.5) / 127.5
MAG_LUT = np.sqrt(_u[:, None] ** 2 + _u[None, :] ** 2).astype(np.float32).ravel()   # uint16 of an (I, Q) byte pair -> magnitude


def _interp(c, x):
    """Cumulative sum c at fractional positions x (linear)."""
    x = np.clip(x, 0, len(c) - 1.000001)
    i = x.astype(np.int64)
    f = x - i
    return c[i] + f * (c[i + 1] - c[i])


def check(bits):
    """Parity of candidate bit rows (n, 112): returns (df, nbits, syndrome) arrays."""
    df = (bits[:, 0].astype(np.int64) << 4) | (bits[:, 1] << 3) | (bits[:, 2] << 2) | (bits[:, 3] << 1) | bits[:, 4]
    long_ = df >= 16
    syn_l = np.bitwise_xor.reduce(np.where(bits.astype(bool), SYN112, 0), axis=1)
    syn_s = np.bitwise_xor.reduce(np.where(bits[:, :56].astype(bool), SYN56, 0), axis=1)
    return df, np.where(long_, 112, 56), np.where(long_, syn_l, syn_s)


_SUBSETS = [m for m in range(1, 1 << 5) if bin(m).count("1") <= 3]     # up to 3 of the 5 least certain bits
_SUBSET_BITS = np.array([[(m >> i) & 1 for i in range(5)] for m in _SUBSETS], bool)


def lowconf_fix(bits, conf, df, syn):
    """DF17 / DF18 candidates with a wrong parity: tries to flip up to 3 of their 5 least certain bits (the ones where the
    two halves of the bit had nearly the same energy). Returns {row: indices of the bits to flip}."""
    rows = np.flatnonzero(((df == 17) | (df == 18)) & (syn != 0))
    if not len(rows):
        return {}
    c = conf[rows].copy()
    c[:, :5] = 9.0                                  # not in the DF
    low = np.argsort(c, axis=1)[:, :5]              # (n, 5)
    s5 = SYN112[low]                                # (n, 5) syndromes of those bits
    combo = np.zeros((len(rows), len(_SUBSETS)), np.int64)
    for i in range(5):
        combo ^= np.where(_SUBSET_BITS[:, i][None, :], s5[:, i:i + 1], 0)
    hit = combo == syn[rows][:, None]
    out = {}
    for r, k in zip(*np.nonzero(hit)):
        if rows[r] not in out:
            out[int(rows[r])] = low[r][_SUBSET_BITS[k]]
    return out


# ---------------------------------------------------------------- the decoder

class AdsbDecoder:
    def __init__(self, on_event, on_state, station=None, range_path=None):
        self.on_event = on_event          # on_event("adsb", {"ac": [...], "msgs": [...]}) once a second
        self.on_state = on_state
        self.station = station or (lambda: None)   # () -> (lat, lon) of the receiver or None
        self.enabled = False
        self.error = None
        self.range = RangeMap(range_path)
        self.count = 0                    # messages accepted
        self.fixed = 0                    # of them with one bit corrected
        self.dropped = 0
        self.rate = 0.0                   # messages per second
        self.key = None
        self.pending = None
        self.demod = None
        self.aircraft = {}                # icao -> dict
        self.history = collections.deque(maxlen=MAX_HISTORY)
        self.next_id = 1
        self.lock = threading.RLock()
        self.q = queue.Queue(maxsize=24)
        self._changed = set()
        self._new_msgs = []
        self._last_emit = 0.0
        self._rate_n = 0
        self._rate_t = time.monotonic()
        self._last_state = 0.0
        self._df11 = {}                   # icao -> time of a DF11 not yet confirmed (an aircraft needs two)
        threading.Thread(target=self._worker, name="adsb-dsp", daemon=True).start()
        threading.Thread(target=self._net_worker, name="adsb-net", daemon=True).start()

    # ---------- control ----------

    def set_enabled(self, on):
        with self.lock:
            self.enabled = bool(on)
            self.pending = None
            self.key = None
            self.demod = None
            self.error = None
        if not on:
            self.range.save(force=True)
        self._emit_state(force=True)

    def info(self):
        with self.lock:
            n = len(self.aircraft)
            npos = sum(1 for a in self.aircraft.values() if a["lat"] is not None)
        return {"enabled": self.enabled, "error": self.error, "count": self.count, "fixed": self.fixed, "dropped": self.dropped,
                "running": self.demod is not None, "rate": round(self.rate, 1), "aircraft": n, "with_pos": npos,
                "center_hz": self.key[1] if self.key else None, "fs": self.key[0] if self.key else None}

    def messages(self):
        with self.lock:
            return list(self.history)

    def aircraft_list(self, trails=True):
        with self.lock:
            out = []
            for a in sorted(self.aircraft.values(), key=lambda x: -x["last"]):
                d = self._public(a)
                if trails:
                    d["trail"] = [list(p) for p in a["_trail"]]
                out.append(d)
            return out

    def clear(self):
        with self.lock:
            self.history.clear()
            self.aircraft = {}
            self._df11 = {}
            self._changed = set()
            self._new_msgs = []
            self.count = self.fixed = self.dropped = 0
        self._emit_state(force=True)

    # ---------- samples from the receiver thread ----------

    def feed_raw(self, raw, fs, center_hz):
        if not self.enabled:
            return
        key = (int(fs), int(round(center_hz)))
        if key != self.key:
            now = time.monotonic()
            if not self.pending or self.pending[0] != key:
                self.pending = (key, now)
                self.demod = None
                return
            if now - self.pending[1] < SETTLE_S:
                return
            with self.lock:
                if not self.enabled:
                    return
                self.pending = None
                self._setup(*key)
        if self.demod is None:
            return
        try:
            self.q.put_nowait((raw.copy(), self.demod, time.time()))
        except queue.Full:
            self.dropped += 1

    def _setup(self, fs, center):
        self.key = (fs, center)
        if fs < MIN_FS:
            self.demod = None
            self.error = f"the sample rate must be at least 2 MS/s (now {fs / 1e6:g} MS/s)"
        elif abs(FREQ_HZ - center) > fs / 2 - EDGE_HZ:
            self.demod = None
            self.error = f"1090 MHz is outside the band received around {center / 1e6:.3f} MHz: press 1090.000"
        else:
            self.error = None
            self.demod = Demod(fs)
        self._emit_state(force=True)

    def _worker(self):
        while True:
            raw, demod, t = self.q.get()
            if demod is not self.demod:
                continue
            try:
                if raw.dtype == np.uint8:
                    mag = MAG_LUT[raw.view(np.uint16)]       # I and Q bytes of one sample at once
                else:
                    mag = np.abs(raw).astype(np.float32)
                self._block(demod, mag, t)
            except Exception as e:      # one odd block must not stop the decoder
                self.error = f"ADS-B: {e}"
            self._emit()

    # ---------- messages ----------

    def _block(self, demod, mag, t):
        r = demod.process(mag, t)
        if r is None:
            return
        bits = r["bits"]
        df, nbits, syn = check(bits)
        now = time.time()
        with self.lock:
            known = {k for k, a in self.aircraft.items() if now - a["last"] < KNOWN_S}
        known_int = np.array([int(k, 16) for k in known], np.int64)
        flips = lowconf_fix(bits, r["conf"], df, syn)
        flipped = np.zeros(len(df), bool)
        if flips:
            flipped[list(flips)] = True
        es = (df == 17) | (df == 18)
        good = (es & ((syn == 0) | np.isin(syn, FIX112_KEYS) | flipped)) | ((df == 11) & ((syn & ~0x7F) == 0)) \
            | (np.isin(df, (0, 4, 5, 16, 20, 21)) & np.isin(syn, known_int))
        rows = np.flatnonzero(good)
        if not len(rows):
            return
        # the phases of one preamble: a clean one first, then the corrected ones
        rows = rows[np.lexsort((syn[rows] != 0, r["group"][rows]))]
        last_end = -1e9
        done = -1
        for j in rows:
            g = int(r["group"][j])
            if g == done:
                continue
            cand = (None, None, float(r["level"][j]), float(r["start"][j]), float(r["time"][j]))
            if self._try(j, cand, bits[j], int(df[j]), int(nbits[j]), int(syn[j]), flips.get(int(j)), known, now, last_end):
                last_end = cand[3] + (8 + int(nbits[j])) * demod.spu
                done = g

    def _try(self, j, cand, bits, d, nb, s, flip, known, now, last_end):
        """Accepts one candidate if its parity is right (or made right by correcting bits of an aircraft already heard)."""
        start = cand[3]
        if start < last_end:
            return False                     # inside a message already decoded
        b = bits[:nb]
        fixed = False
        if d in (17, 18):
            if s != 0:
                k = FIX112.get(s)
                b = b.copy()
                if k is not None:
                    b[k] ^= 1
                elif flip is not None:
                    b[flip] ^= 1
                else:
                    return False
                fixed = True
            msg = np.packbits(b).tobytes()
            icao = f"{_bits(msg, 9, 24):06X}"
            if fixed and icao not in known:
                return False                 # corrected bits only for an aircraft already heard
        elif d == 11:
            if s & ~0x7F:
                return False
            msg = np.packbits(b).tobytes()
            icao = f"{_bits(msg, 9, 24):06X}"
            if icao not in known:
                seen = self._df11.get(icao)
                self._df11[icao] = now
                if len(self._df11) > 5000:
                    self._df11 = {k: v for k, v in self._df11.items() if now - v < 30}
                if not seen or now - seen > 30:
                    return False             # one DF11 of an unknown address may be noise: wait for a second one
        elif d in (0, 4, 5, 16, 20, 21):
            icao = f"{s:06X}"
            if icao not in known:
                return False
            msg = np.packbits(b).tobytes()
        else:
            return False
        level = 20 * math.log10(max(cand[2], 1e-6))
        self._accept(msg, icao, fixed, level, cand[4])
        known.add(icao)
        return True

    def _accept(self, msg, icao, fixed, level, t):
        r = decode(msg)
        r["icao"] = icao
        now = time.time()
        with self.lock:
            self.count += 1
            self._rate_n += 1
            if fixed:
                self.fixed += 1
            a = self._aircraft(icao, now)
            a["n"] += 1
            a["last"] = now
            a["level"] = round(level, 1)
            text = self._update(a, r, now)
            m = {"id": self.next_id, "time": round(t, 3), "hex": msg.hex().upper(), "df": r["df"], "icao": icao,
                 "kind": r.get("kind", DF_NAMES.get(r["df"], "")), "text": text, "level": round(level, 1), "fixed": fixed}
            self.next_id += 1
            self.history.append(m)
            self._new_msgs.append(m)
            if len(self._new_msgs) > 200:
                del self._new_msgs[:100]
            self._changed.add(icao)

    def _aircraft(self, icao, now):
        a = self.aircraft.get(icao)
        if a is None:
            if len(self.aircraft) >= MAX_AIRCRAFT:
                del self.aircraft[min(self.aircraft, key=lambda k: self.aircraft[k]["last"])]
            a = {"icao": icao, "flight": "", "category": "", "cat": "", "squawk": "", "emergency": "", "alt": None, "alt_geo": None,
                 "gs": None, "track": None, "hdg": None, "ias": None, "tas": None, "vrate": None, "sel_alt": None, "qnh": None,
                 "lat": None, "lon": None, "pos_time": None, "dist_km": None, "az": None, "ground": False, "tisb": False,
                 "first": now, "last": now, "n": 0, "level": None, "logged": 0.0, "net": None, "_net_t": 0.0,
                 "_cpr": [None, None], "_trail": collections.deque(maxlen=TRAIL)}
            self.aircraft[icao] = a
        return a

    def _update(self, a, r, now):
        """Takes the fields of a message into the aircraft; returns a short text of what the message said."""
        parts = []
        for k in ("flight", "category", "cat", "alt", "alt_geo", "gs", "track", "hdg", "ias", "tas", "vrate", "sel_alt", "qnh"):
            if r.get(k) is not None and r.get(k) != "":
                a[k] = r[k]
        if "ground" in r:
            a["ground"] = r["ground"]
        if r.get("tisb"):
            a["tisb"] = True
        if r.get("squawk"):
            a["squawk"] = r["squawk"]
            a["emergency"] = r.get("emergency") or SQUAWK_EMERGENCY.get(r["squawk"], "")
        elif r.get("emergency"):
            a["emergency"] = r["emergency"]
        if r.get("flight"):
            parts.append(r["flight"])
        if r.get("category"):
            parts.append(r["category"])
        if r.get("squawk"):
            parts.append(f"squawk {r['squawk']}")
        if r.get("emergency"):
            parts.append(r["emergency"].upper())
        if r.get("alt") is not None:
            parts.append(f"{r['alt']} ft")
        if r.get("alt_geo") is not None:
            parts.append(f"GNSS {r['alt_geo']} ft")
        if r.get("gs") is not None:
            parts.append(f"{r['gs']:.0f} kt")
        if r.get("track") is not None:
            parts.append(f"trk {r['track']:.0f}°")
        if r.get("hdg") is not None:
            parts.append(f"hdg {r['hdg']:.0f}°")
        for k, name in (("ias", "IAS"), ("tas", "TAS")):
            if r.get(k) is not None:
                parts.append(f"{name} {r[k]} kt")
        if r.get("vrate") is not None:
            parts.append(f"{r['vrate']:+d} ft/min")
        if r.get("sel_alt") is not None:
            parts.append(f"selected {r['sel_alt']} ft")
        if r.get("qnh") is not None:
            parts.append(f"QNH {r['qnh']} hPa")
        if r.get("alert"):
            parts.append(r["alert"])
        if "cpr" in r:
            pos = self._position(a, r, now)
            if pos:
                parts.append(f"{pos[0]:.4f}, {pos[1]:.4f}")
            else:
                parts.append(f"CPR {'odd' if r['odd'] else 'even'}")
        return " · ".join(parts)

    def _position(self, a, r, now):
        surface = r["surface"]
        odd = 1 if r["odd"] else 0
        a["_cpr"][odd] = (r["cpr"], now, surface)
        other = a["_cpr"][1 - odd]
        qth = self.station()
        pos = None
        ref = None
        if a["lat"] is not None and now - a["pos_time"] < 600:
            ref = (a["lat"], a["lon"])
        elif surface and qth:
            ref = qth
        if other and other[2] == surface and now - other[1] < (CPR_PAIR_S if not surface else 25):
            even, oddf = (other[0], r["cpr"]) if odd else (r["cpr"], other[0])
            pos = cpr_global(even, oddf, bool(odd), surface, ref or qth)
        if pos is None and ref is not None:
            pos = cpr_local(r["cpr"], bool(odd), ref, surface)
        if pos is None:
            return None
        if a["lat"] is not None:
            # plausibility: not faster than 1500 kt since the last position (a wrong CPR pair jumps hundreds of km)
            dt = max(now - a["pos_time"], 1.0)
            if distance_km(a["lat"], a["lon"], *pos) > 0.78 * dt + 2 and now - a["pos_time"] < 600:
                return None
        elif qth and distance_km(qth[0], qth[1], *pos) > 700:
            return None                      # first position beyond the radio horizon: a wrong decode
        a["lat"], a["lon"] = round(pos[0], 5), round(pos[1], 5)
        a["pos_time"] = now
        if qth:
            a["dist_km"] = round(distance_km(qth[0], qth[1], *pos), 1)
            a["az"] = round(bearing(qth[0], qth[1], *pos))
            if a["_trail"] and now - a["_trail"][-1][2] < 120:
                # range map: only a position confirmed by an earlier one of the same aircraft (a single bad decode cannot stretch it)
                self.range.add(qth, pos[0], pos[1], a["alt"] if a["alt"] is not None else a["alt_geo"], now)
        a["_trail"].append((a["lat"], a["lon"], round(now, 1), a["alt"]))
        return pos

    # ---------- adsb.fi / adsb.lol: aircraft without a position of their own ----------

    def _net_next(self, now):
        """The aircraft to look up next: never looked up first (also those with a position, once, for the registration
        and type), then those still without their own position, the longest ago first."""
        best = None
        with self.lock:
            for a in self.aircraft.values():
                if now - a["last"] > NET_RECENT_S:
                    continue
                if a["_net_t"] == 0.0:
                    key = (0, a["first"])
                elif a["lat"] is None and now - a["_net_t"] >= NET_AGAIN_S:
                    key = (1, a["_net_t"])
                else:
                    continue
                if best is None or key < best[0]:
                    best = (key, a)
            if best:
                best[1]["_net_t"] = now
                return best[1]["icao"]
        return None

    def _net_worker(self):
        while True:
            time.sleep(NET_GAP_S)
            if not self.enabled:
                continue
            icao = self._net_next(time.time())
            if icao is None:
                continue
            info = net_lookup(icao)
            now = time.time()
            with self.lock:
                a = self.aircraft.get(icao)
                if a is None:
                    continue
                if info is None:
                    a["net"] = dict(a["net"], stale=True) if a["net"] else {"found": False}
                else:
                    qth = self.station()
                    if info["lat"] is not None and qth:
                        info["dist_km"] = round(distance_km(qth[0], qth[1], info["lat"], info["lon"]), 1)
                        info["az"] = round(bearing(qth[0], qth[1], info["lat"], info["lon"]))
                    info["time"] = round(now, 1)
                    a["net"] = info
                    self._net_range(a, info, qth, now)
                self._changed.add(icao)

    def _net_range(self, a, info, qth, now):
        """An aircraft heard here (a valid message within NET_RANGE_S) without a position of its own: the position adsb.fi
        sees goes to the range map too (marked as such) – it shows how far the antenna and receiver hear, also for aircraft
        that only answer the radars or whose position messages do not get through."""
        if not qth or info.get("lat") is None or a["lat"] is not None or info.get("ground") or now - a["last"] > NET_RANGE_S:
            return
        seen = info.get("seen_pos")
        if seen is not None and seen > NET_RANGE_S:
            return
        if distance_km(qth[0], qth[1], info["lat"], info["lon"]) > 700:
            return
        alt = next((x for x in (a["alt"], a["alt_geo"], info.get("alt")) if x is not None), None)
        self.range.add(qth, info["lat"], info["lon"], alt, now, net=True)

    @staticmethod
    def _public(a):
        return {k: v for k, v in a.items() if not k.startswith("_") and k != "logged"}

    def _emit(self):
        now = time.time()
        if now - self._last_emit < 1.0:
            return
        self._last_emit = now
        self.range.save()
        with self.lock:
            stale = [k for k, a in self.aircraft.items() if now - a["last"] > STALE_S]
            for k in stale:
                del self.aircraft[k]
            ac = [self._public(self.aircraft[k]) for k in self._changed if k in self.aircraft]
            msgs = self._new_msgs[-60:]
            logs = []
            for d in ac:
                a = self.aircraft[d["icao"]]
                if now - a["logged"] >= 60:
                    a["logged"] = now
                    logs.append(d)
            self._changed = set()
            self._new_msgs = []
            mono = time.monotonic()
            if mono - self._rate_t >= 5:
                self.rate = self._rate_n / (mono - self._rate_t)
                self._rate_n = 0
                self._rate_t = mono
        if ac or msgs or stale:
            self.on_event("adsb", {"ac": ac, "msgs": msgs, "gone": stale, "info": self.info(), "log": logs})
        self._emit_state()

    def _emit_state(self, force=False):
        now = time.time()
        if force or now - self._last_state > 2.0:
            self._last_state = now
            self.on_state(self.info())
