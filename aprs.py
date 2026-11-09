"""APRS: parse of the information field of an AX.25 UI frame (stage 4 of data/poznamky_packet.md).

parse(dest, info) -> dict with "type" and the fields found, or None when it is not APRS. Types:
  position (with or without a timestamp, uncompressed / compressed / Mic-E), object, item, status, message,
  telemetry, weather, capabilities, thirdparty, other.
Position fields: lat, lon (degrees, + = N/E), sym (2 characters: table + code), comment, optionally
course (deg), speed (km/h), alt_m, ambiguity (number of hidden digits), weather (dict).
Units: the APRS spec uses knots, feet, °F and hundredths of an inch; here km/h, m, °C, mm and hPa.
"""
import math
import re

KNOT_KMH = 1.852
MPH_KMH = 1.609344
FT_M = 0.3048


def _f2c(f):
    return round((f - 32) * 5 / 9, 1)


# ---------------------------------------------------------------- positions

_UNC = re.compile(r"^(\d{2})([\d ]{2})\.([\d ]{2})([NS])(.)(\d{3})([\d ]{2})\.([\d ]{2})([EW])(.)")


def _digits(s):
    """Position ambiguity: spaces instead of the last digits; they count as the middle of the range
    ('03.  ' -> '03.50', '0 .  ' -> '05.00')."""
    i = s.find(" ")
    return s if i < 0 else s[:i] + "5" + s[i + 1:].replace(" ", "0")


def _uncompressed(t):
    """'4903.50N/07201.75W>comment' -> (fields, rest) or None."""
    m = _UNC.match(t)
    if not m:
        return None
    la_d, la_m1, la_m2, ns, table, lo_d, lo_m1, lo_m2, ew, code = m.groups()
    amb = (la_m1 + la_m2).count(" ")
    try:
        lat = int(la_d) + float(_digits(la_m1 + "." + la_m2)) / 60
        lon = int(lo_d) + float(_digits(lo_m1 + "." + lo_m2)) / 60
    except ValueError:
        return None
    if lat > 90 or lon > 180:
        return None
    p = {"lat": round(-lat if ns == "S" else lat, 5), "lon": round(-lon if ew == "W" else lon, 5),
         "sym": table + code}
    if amb:
        p["ambiguity"] = amb
    return p, t[19:]


def _b91(s):
    v = 0
    for c in s:
        if not 33 <= ord(c) <= 124:
            raise ValueError
        v = v * 91 + ord(c) - 33
    return v


def _compressed(t):
    """'/5L!!<*e7>7P[' (13 characters) -> (fields, rest) or None."""
    if len(t) < 13 or not (t[0] in "/\\" or t[0].isalpha() or t[0].isdigit()):
        return None
    try:
        lat = 90 - _b91(t[1:5]) / 380926
        lon = -180 + _b91(t[5:9]) / 190463
    except ValueError:
        return None
    table = "/" if t[0] in "abcdefghij" else t[0]   # a-j = overlay digits 0-9 on the alternate table
    p = {"lat": round(lat, 5), "lon": round(lon, 5), "sym": table + t[9]}
    c, s, typ = t[10], t[11], t[12]
    if c != " ":
        cv, sv = ord(c) - 33, ord(s) - 33
        if (ord(typ) - 33) & 0x18 == 0x10 and 0 <= cv <= 90:       # GGA source: altitude
            p["alt_m"] = round(1.002 ** (cv * 91 + sv) * FT_M)
        elif 0 <= cv <= 89:
            if cv:
                p["course"] = cv * 4
            p["speed"] = round((1.08 ** sv - 1) * KNOT_KMH, 1)
    return p, t[13:]


def _extensions(p, comment):
    """Course/speed 'CCC/SSS', altitude '/A=nnnnnn' and weather of a position comment."""
    if p.get("sym", " _")[1] == "_":
        wx, comment = _weather(comment, pos=True)
        if wx:
            p["weather"] = wx
    else:
        m = re.match(r"^(\d{3})/(\d{3})", comment)
        if m and "course" not in p:
            c, s = int(m.group(1)), int(m.group(2))
            if c:
                p["course"] = c % 360
            p["speed"] = round(s * KNOT_KMH, 1)
            comment = comment[7:]
            m2 = re.match(r"^/(\d{3})/(\d{3})", comment)          # DF report: bearing / NRQ
            if m2:
                comment = comment[8:]
    m = re.search(r"/A=(-?\d{5,6})", comment)
    if m:
        p["alt_m"] = round(int(m.group(1)) * FT_M)
        comment = comment[:m.start()] + comment[m.end():]
    p["comment"] = comment.strip()
    return p


def _position(t):
    r = _uncompressed(t) if t[:1].isdigit() else _compressed(t)
    if not r:
        return None
    p, rest = r
    return _extensions(p, rest)


# ---------------------------------------------------------------- weather

_WX = {"g": ("gust", 3), "t": ("temp", 3), "r": ("rain_1h", 3), "p": ("rain_24h", 3), "P": ("rain_midnight", 3),
       "h": ("humidity", 2), "b": ("pressure", 5), "L": ("lum", 3), "l": ("lum", 3), "s": ("snow", 3)}


def _weather(t, pos):
    """'220/004g005t077r000p000P000h50b09900' -> ({...}, rest). Wind direction/speed: after a position
    'DDD/SSS', positionless 'cDDDsSSS'."""
    wx = {}
    if pos:
        m = re.match(r"^(\d{3}|\.{3}| {3})/(\d{3}|\.{3}| {3})", t)
        if m:
            if m.group(1).isdigit():
                wx["wind_dir"] = int(m.group(1))
            if m.group(2).isdigit():
                wx["wind"] = round(int(m.group(2)) * MPH_KMH, 1)
            t = t[7:]
    while t:
        k = t[0]
        if k in "cs" and not pos and k not in wx and len(t) >= 4:
            v = t[1:4]
            if v.isdigit():
                wx["wind_dir" if k == "c" else "wind"] = int(v) if k == "c" else round(int(v) * MPH_KMH, 1)
            t = t[4:]
            continue
        if k not in _WX:
            break
        name, n = _WX[k]
        v = t[1:1 + n]
        if len(v) < n:
            break
        if k in "lL" and v.isdigit():
            wx[name] = int(v) + (1000 if k == "l" else 0)
        elif re.match(r"^-?\d+$", v):
            x = int(v)
            if k in "gs":
                wx[name] = round(x * MPH_KMH, 1) if k == "g" else round(x * 25.4, 1)
            elif k == "t":
                wx["temp"] = _f2c(x)
            elif k in "rpP":
                wx[name] = round(x * 0.254, 1)
            elif k == "h":
                wx["humidity"] = 100 if x == 0 else x
            elif k == "b":
                wx["pressure"] = x / 10
        t = t[1 + n:]
    return wx, t


# ---------------------------------------------------------------- Mic-E

def _mic_e(dest, t):
    """Mic-E: latitude, message and N/S, W/E, longitude offset in the destination callsign; the rest in the info."""
    d = dest.split("-")[0]
    if len(d) != 6 or len(t) < 9:
        return None
    digs = []
    for c in d:
        if c.isdigit():
            digs.append(c)
        elif "A" <= c <= "J":
            digs.append(str(ord(c) - ord("A")))
        elif "P" <= c <= "Y":
            digs.append(str(ord(c) - ord("P")))
        elif c in "KLZ":
            digs.append(" ")
        else:
            return None
    try:
        lat = int(digs[0] + digs[1]) + float(_digits(digs[2] + digs[3] + "." + digs[4] + digs[5])) / 60
    except ValueError:
        return None
    north = "P" <= d[3] <= "Z"
    lon_off = 100 if "P" <= d[4] <= "Z" else 0
    west = "P" <= d[5] <= "Z"
    b = [ord(c) for c in t[1:9]]
    deg = b[0] - 28 + lon_off
    if 180 <= deg <= 189:
        deg -= 80
    elif 190 <= deg <= 199:
        deg -= 190
    mins = b[1] - 28
    if mins >= 60:
        mins -= 60
    hund = b[2] - 28
    lon = deg + (mins + hund / 100) / 60
    if not (0 <= lat <= 90 and 0 <= lon <= 180):
        return None
    sp, dc, se = b[3] - 28, b[4] - 28, b[5] - 28
    speed = sp * 10 + dc // 10
    if speed >= 800:
        speed -= 800
    course = (dc % 10) * 100 + se
    if course >= 400:
        course -= 400
    p = {"lat": round(lat if north else -lat, 5), "lon": round(-lon if west else lon, 5),
         "sym": t[8] + t[7], "mic_e": True}
    if course:
        p["course"] = course % 360
    p["speed"] = round(speed * KNOT_KMH, 1)
    rest = t[9:]
    # type code ('>' handheld, ']' mobile, '`' / ''' ...) and altitude "xxx}" (base 91, metres - 10000)
    if rest[:1] in (">", "]", "`", "'"):
        rest = rest[1:]
    m = re.search(r"(.{3})\}", rest)
    if m:
        try:
            p["alt_m"] = _b91(m.group(1)) - 10000
            rest = rest[:m.start()] + rest[m.end():]
        except ValueError:
            pass
    p["comment"] = rest.strip()
    return p


# ---------------------------------------------------------------- the field

def parse(dest, info):
    """dest: destination callsign ("APRS", Mic-E encoded...); info: bytes. Returns a dict or None."""
    if not info:
        return None
    t = info.decode("latin-1").rstrip("\r\n")
    k = t[0]
    try:
        if k in "!=":
            p = _position(t[1:])
            if p:
                return dict(p, type="weather" if "weather" in p else "position", messaging=k == "=")
            # '!' may also come up to 40 characters later (old TNCs); only the plain form is handled
            return None
        if k in "/@":
            p = _position(t[8:])
            if p:
                return dict(p, type="weather" if "weather" in p else "position", messaging=k == "@",
                            timestamp=t[1:8])
            return None
        if k in "`'\x1c\x1d":
            p = _mic_e(dest, t)
            return dict(p, type="position") if p else None
        if k == ";" and len(t) >= 18:
            p = _position(t[18:])
            if p:
                return dict(p, type="object", name=t[1:10].strip(), killed=t[10] == "_", timestamp=t[11:18])
            return None
        if k == ")":
            m = re.match(r"^\)([^!_]{3,9})([!_])", t)
            if m:
                p = _position(t[m.end():])
                if p:
                    return dict(p, type="item", name=m.group(1).strip(), killed=m.group(2) == "_")
            return None
        if k == ">":
            return {"type": "status", "text": t[1:]}
        if k == ":" and len(t) >= 11 and t[10] == ":":
            to, text = t[1:10].strip(), t[11:]
            m = re.match(r"^(.*)\{([A-Za-z0-9]{1,5})\}?\s*$", text)
            msg = {"type": "message", "to": to, "text": m.group(1) if m else text}
            if m:
                msg["msgno"] = m.group(2)
            if re.match(r"^(ack|rej)[A-Za-z0-9]{1,5}$", text):
                msg["ack"] = text[:3]
            if re.match(r"^(PARM|UNIT|EQNS|BITS)\.", text):
                msg["type"] = "telemetry"
                msg["definition"] = text.split(".")[0]
            return msg
        if k == "T" and t.startswith("T#"):
            parts = t[2:].split(",")
            vals = []
            for v in parts[1:6]:
                try:
                    vals.append(float(v))
                except ValueError:
                    vals.append(None)
            return {"type": "telemetry", "seq": parts[0], "values": vals,
                    "bits": parts[6][:8] if len(parts) > 6 else ""}
        if k == "_" and len(t) >= 9:
            wx, rest = _weather(t[9:], pos=False)
            return {"type": "weather", "weather": wx, "timestamp": t[1:9], "comment": rest.strip()}
        if k == "<":
            return {"type": "capabilities", "text": t[1:]}
        if k == "}":
            return {"type": "thirdparty", "text": t[1:]}
    except (IndexError, ValueError):
        return None
    return {"type": "other"}


# ---------------------------------------------------------------- geometry

def distance_bearing(lat1, lon1, lat2, lon2):
    """Great circle distance (km) and initial bearing (deg) from point 1 to point 2."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    a = math.sin((p2 - p1) / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    km = 2 * 6371.0 * math.asin(min(1.0, math.sqrt(a)))
    brg = math.degrees(math.atan2(math.sin(dl) * math.cos(p2),
                                  math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)))
    return round(km, 1), round(brg % 360)


def summary(a):
    """Short text of a parsed APRS packet for the list."""
    t = a["type"]
    if t == "message":
        return f"to {a['to']}: {a['text']}"
    if t in ("status", "capabilities", "thirdparty"):
        return a.get("text", "")
    parts = []
    if a.get("name"):
        parts.append(a["name"] + (" (killed)" if a.get("killed") else ""))
    wx = a.get("weather")
    if wx:
        if "temp" in wx:
            parts.append(f"{wx['temp']} °C")
        if "wind" in wx:
            parts.append(f"wind {wx['wind']} km/h" + (f" {wx['wind_dir']}°" if "wind_dir" in wx else ""))
        if "humidity" in wx:
            parts.append(f"{wx['humidity']} %")
        if "pressure" in wx:
            parts.append(f"{wx['pressure']} hPa")
    if "speed" in a and a.get("speed"):
        parts.append(f"{a['speed']:.0f} km/h" + (f" {a['course']}°" if "course" in a else ""))
    if "alt_m" in a:
        parts.append(f"{a['alt_m']} m")
    if a.get("comment"):
        parts.append(a["comment"])
    return " · ".join(parts)
