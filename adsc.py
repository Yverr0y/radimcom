"""FANS-1/A ADS-C decoder (Automatic Dependent Surveillance - Contract, ARINC 745) for ARINC 622 messages.

ADS-C reports travel in ACARS like CPDLC, with the IMI "ADS" (cpdlc.split_arinc separates the header and checks
the CRC). The ground station sets up contracts (periodic, event, emergency) and the aircraft sends reports.
The binary data is a sequence of groups, each starting with a one-byte tag:

    /SKYSWSQ.ADS.9V-SWJ 07 2230905353079195AF1D 0E 2720EDC000 10 0A987E52 1814
                        basic report             earth ref.    meteo      CRC

Downlink (aircraft -> ground): 3 ack, 4 nack, 5 noncompliance, 6 cancel emergency, 7 basic report,
9 emergency basic report, 10/18/19/20 event reports (basic report), then optional groups:
12 flight ID, 13 predicted route, 14 earth reference, 15 air reference, 16 meteo, 17 airframe ID,
22 intermediate projected intent, 23 fixed projected intent.
Uplink (ground -> aircraft): 1 cancel all, 2 cancel contract, 6 cancel emergency, 7 periodic contract,
8 event contract, 9 emergency periodic contract (contract number + request groups 10-21).
IMI "DIS" = ADS-C disconnect with a reason code.

Field layouts follow libacars (adsc.c, MIT licence). Altitude 0x8000 and ETA 0x3FFF mean "not available"
(seen in waypoint change events). Unknown tags stop the decoding; the rest is shown in hex.
"""
import time

ACCURACY = {0: "NAV capability lost", 1: "accuracy <30 NM", 2: "accuracy <15 NM", 3: "accuracy <8 NM",
            4: "accuracy <4 NM", 5: "accuracy <1 NM", 6: "accuracy <0.25 NM", 7: "accuracy <0.05 NM"}
NACK_REASONS = {1: "duplicate group tag", 2: "duplicate reporting interval tag",
                3: "event contract request with no data", 4: "improper operational mode tag",
                5: "cancelled contract does not exist", 6: "requested contract already exists",
                7: "undefined contract request tag", 8: "undefined error", 9: "not enough data in request",
                10: "invalid altitude range", 11: "vertical rate threshold is 0",
                12: "aircraft intent projection time is 0", 13: "lateral deviation threshold is 0"}
DIS_REASONS = {0: "reason not specified", 1: "congestion", 2: "application not available", 8: "normal disconnect"}
DOWN_REPORTS = {7: "Basic report", 9: "EMERGENCY basic report", 10: "Lateral deviation event",
                18: "Vertical rate event", 19: "Altitude range event", 20: "Waypoint change event"}
UP_CONTRACTS = {7: "Periodic contract", 8: "Event contract", 9: "Emergency periodic contract"}
UP_GROUPS = {12: "flight ID", 13: "predicted route", 14: "earth reference", 15: "air reference",
             16: "meteo data", 17: "airframe ID"}


class _Short(ValueError):
    pass


class _Bits:
    def __init__(self, data):
        self.v = int.from_bytes(data, "big")
        self.n = len(data) * 8

    def get(self, start, k, signed=False):
        x = (self.v >> (self.n - start - k)) & ((1 << k) - 1)
        return x - (1 << k) if signed and x >> (k - 1) else x


def _take(data, i, n):
    if i + n > len(data):
        raise _Short(f"group is shorter than {n} bytes")
    return data[i:i + n]


def _coord(x):
    return x * 180 / (1 << 20)            # 21 bits signed, MSB = 90°


def _angle(x, bits):
    a = x * 180 / (1 << (bits - 1))       # signed, MSB = 90° -> 0..360
    return a + 360 if a < 0 else a


def _lat(v):
    return f"{abs(v):.4f}{'N' if v >= 0 else 'S'}"


def _lon(v):
    return f"{abs(v):.4f}{'E' if v >= 0 else 'W'}"


def _alt(raw):
    """16-bit signed altitude field (LSB 4 ft); 0x8000 = not available."""
    return "alt n/a" if raw == -32768 else f"{raw * 4} FT"


def _eta(sec):
    """14-bit time in seconds; 0x3FFF = not available."""
    return "ETA n/a" if sec == 0x3FFF else f"in {sec // 60}:{sec % 60:02d} min"


def _time_past_hour(sec, now):
    """Seconds past the hour -> HH:MM:SS.sZ, the hour taken from the receive time. If the report is not within
    10 minutes before (or 1 minute after) the receive time, the hour is unknown: ":MM:SS past the hour"."""
    t = time.gmtime(now)
    rx = t.tm_min * 60 + t.tm_sec
    m, s = divmod(sec, 60)
    age = (rx - sec) % 3600
    if age > 600 and age < 3600 - 60:
        return f":{int(m):02d}:{s:04.1f} past the hour"
    h = t.tm_hour if sec <= rx + 60 else (t.tm_hour - 1) % 24
    return f"{h:02d}:{int(m):02d}:{s:04.1f}Z"


def _basic(b, now):
    x = _Bits(b)
    lat = _coord(x.get(0, 21, True))
    lon = _coord(x.get(21, 21, True))
    alt = x.get(42, 16, True)
    ts = x.get(58, 15) * 0.125
    fom = b[9] & 0x7F                     # redundancy bit 0, accuracy bits 1-3, TCAS bit 4
    parts = [f"{_lat(lat)} {_lon(lon)}", _alt(alt), _time_past_hour(ts, now), ACCURACY[(fom >> 1) & 7]]
    if not fom & 1:
        parts.append("NAV redundancy lost")
    if not fom & 0x10:
        parts.append("TCAS not available")
    pos = {"lat": round(lat, 5), "lon": round(lon, 5)}
    if alt != -32768:
        pos["alt_ft"] = alt * 4
    return " · ".join(parts), pos


def _earth(b):
    x = _Bits(b)
    trk = "track invalid" if x.get(0, 1) else f"track {_angle(x.get(1, 12, True), 12):.1f}° TRUE"
    gs = x.get(13, 13) / 2
    vs = x.get(26, 12, True) * 16
    return f"{trk} · GS {gs:.1f} KT · vertical rate {vs:+d} FT/MIN"


def _air(b):
    x = _Bits(b)
    hdg = "heading invalid" if x.get(0, 1) else f"heading {_angle(x.get(1, 12, True), 12):.1f}° TRUE"
    mach = x.get(13, 13) * 0.0005
    vs = x.get(26, 12, True) * 16
    return f"{hdg} · M{mach:.3f} · vertical rate {vs:+d} FT/MIN"


def _meteo(b):
    x = _Bits(b)
    ws = x.get(0, 9) / 2
    wd = "direction invalid" if x.get(9, 1) else f"{_angle(x.get(10, 9, True), 9):03.0f}° TRUE"
    temp = x.get(19, 12, True) / 4
    return f"wind {wd} / {ws:.1f} KT · temperature {temp:+.2f} °C"


def _flight_id(b):
    x = _Bits(b)
    out = ""
    for i in range(8):
        c = x.get(i * 6, 6)
        out += chr(c if c & 0x20 else c + 0x40)
    return out.strip()


def _route(b):
    x = _Bits(b)
    p1 = f"{_lat(_coord(x.get(0, 21, True)))} {_lon(_coord(x.get(21, 21, True)))} {_alt(x.get(42, 16, True))}"
    p2 = f"{_lat(_coord(x.get(72, 21, True)))} {_lon(_coord(x.get(93, 21, True)))} {_alt(x.get(114, 16, True))}"
    return f"next {p1} {_eta(x.get(58, 14))}\nthen {p2}"


def _intermediate_intent(b):
    x = _Bits(b)
    trk = "track invalid" if x.get(16, 1) else f"track {_angle(x.get(17, 12, True), 12):.1f}° TRUE"
    return f"{x.get(0, 16) / 8:.1f} NM ahead · {trk} · {_alt(x.get(29, 16, True))} · {_eta(x.get(45, 14))}"


def _fixed_intent(b):
    x = _Bits(b)
    return (f"{_lat(_coord(x.get(0, 21, True)))} {_lon(_coord(x.get(21, 21, True)))} "
            f"{_alt(x.get(42, 16, True))} {_eta(x.get(58, 14))}")


def _noncomp(data, i):
    """Noncompliance notification -> (text, new index)."""
    c, n = _take(data, i, 2)
    i += 2
    groups = []
    for _ in range(n):
        tag, f = _take(data, i, 2)
        i += 2
        if f & 0x80:
            groups.append(f"group {tag} not recognised")
        elif f & 0x40:
            groups.append(f"group {tag} not available")
        else:
            k = f & 0x0F
            nib = _take(data, i, (k + 1) // 2).hex()[:k]
            i += (k + 1) // 2
            groups.append(f"group {tag} parameters {', '.join(str(int(h, 16)) for h in nib)} not available")
    return f"Contract {c}: " + ("; ".join(groups) or "noncompliance"), i


def _downlink(data, now, out, pos):
    i = 0
    while i < len(data):
        tag = data[i]
        i += 1
        if tag == 3:
            out.append(("ACK", f"Contract {_take(data, i, 1)[0]} accepted"))
            i += 1
        elif tag == 4:
            c, reason = _take(data, i, 2)
            i += 2
            text = f"Contract {c} rejected: {NACK_REASONS.get(reason, f'reason {reason}')}"
            if reason in (1, 2, 7):
                text += f" ({'tag' if reason == 7 else 'octet'} {_take(data, i, 1)[0]})"
                i += 1
            out.append(("NACK", text))
        elif tag == 5:
            text, i = _noncomp(data, i)
            out.append(("NONCOMP", text))
        elif tag == 6:
            out.append(("CANCEL", "Emergency mode cancelled"))
        elif tag in DOWN_REPORTS:
            text, p = _basic(_take(data, i, 10), now)
            i += 10
            out.append(("BASIC", f"{DOWN_REPORTS[tag]}: {text}"))
            pos.update(p)
        elif tag == 12:
            out.append(("FLT ID", _flight_id(_take(data, i, 6))))
            i += 6
        elif tag == 13:
            out.append(("ROUTE", _route(_take(data, i, 17))))
            i += 17
        elif tag == 14:
            out.append(("EARTH", _earth(_take(data, i, 5))))
            i += 5
        elif tag == 15:
            out.append(("AIR", _air(_take(data, i, 5))))
            i += 5
        elif tag == 16:
            out.append(("METEO", _meteo(_take(data, i, 4))))
            i += 4
        elif tag == 17:
            out.append(("AIRFRAME", "ICAO address " + _take(data, i, 3).hex().upper()))
            i += 3
        elif tag == 22:
            out.append(("INTENT", "Intermediate projected intent: " + _intermediate_intent(_take(data, i, 8))))
            i += 8
        elif tag == 23:
            out.append(("INTENT", "Fixed projected intent: " + _fixed_intent(_take(data, i, 9))))
            i += 9
        else:
            raise _Short(f"unknown tag {tag}, rest {data[i - 1:].hex().upper()}")


def _uplink(data, out):
    i = 0
    while i < len(data):
        tag = data[i]
        i += 1
        if tag == 1:
            out.append(("CANCEL", "Cancel all contracts and terminate connection"))
            continue
        c = _take(data, i, 1)[0]
        i += 1
        if tag == 2:
            out.append(("CANCEL", f"Cancel contract {c}"))
            continue
        if tag == 6:
            out.append(("CANCEL", f"Cancel emergency contract {c}"))
            continue
        if tag not in UP_CONTRACTS:
            raise _Short(f"unknown tag {tag}, rest {data[i - 2:].hex().upper()}")
        req = []
        while i < len(data) and 10 <= data[i] <= 21:     # request groups; another byte starts the next request
            g = data[i]
            i += 1
            if g == 11:
                b = _take(data, i, 1)[0]
                i += 1
                sec = (1, 1, 8, 64)[b >> 6] * ((b & 0x3F) + 1)
                req.append(f"report every {sec // 60}:{sec % 60:02d} min" if sec >= 60 else f"report every {sec} s")
            elif g == 10:
                req.append(f"lateral deviation > {_take(data, i, 1)[0] / 8:.3f} NM")
                i += 1
            elif g == 18:
                v = _take(data, i, 1)[0]
                i += 1
                v = v - 256 if v >= 128 else v
                req.append(f"vertical rate {'>' if v >= 0 else '<'} {v * 64} FT/MIN")
            elif g == 19:
                x = _Bits(_take(data, i, 4))
                i += 4
                req.append(f"altitude outside {_alt(x.get(16, 16, True))} - {_alt(x.get(0, 16, True))}")
            elif g == 20:
                req.append("waypoint change")
            elif g == 21:
                mod, t = _take(data, i, 2)
                i += 2
                req.append(f"aircraft intent ({t} min ahead) every {mod}. report")
            else:
                req.append(f"{UP_GROUPS[g]} every {_take(data, i, 1)[0]}. report")
                i += 1
        out.append(("CONTRACT", f"{UP_CONTRACTS[tag]} {c}" + (":\n  " + "\n  ".join(req) if req else "")))


def decode(data, up, now=None, imi="ADS"):
    """ADS-C binary data (without CRC) -> (elements [(id, text)], position dict, error)."""
    now = time.time() if now is None else now
    out, pos, err = [], {}, ""
    try:
        if imi == "DIS":
            r = _take(data, 0, 1)[0] >> 4
            out.append(("DISCONNECT", DIS_REASONS.get(r, f"reason {r}")))
        elif up:
            _uplink(data, out)
        else:
            _downlink(data, now, out, pos)
    except (_Short, IndexError, KeyError) as e:
        err = f"ADS-C: {e}"
    return out, pos, err
