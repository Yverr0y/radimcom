"""FANS-1/A CPDLC decoder (controller-pilot data link) for messages carried in ACARS.

CPDLC replaces voice between air traffic control and the cockpit with text messages ("CLIMB TO AND MAINTAIN
FL350", "WILCO"). FANS-1/A aircraft send them as ARINC 622 messages in ordinary ACARS messages
(labels AA / BA, sometimes H1 with a sublabel):

    /AKLCDYA.AT1.9M-MTB215B659D84995674293583561CB9906744E9AF40F9EB
     ground   IMI  aircraft  CPDLC message in hex ................ CRC

IMI: AT1 = CPDLC message, CR1 / CC1 / DR1 = connect request / connect confirm / disconnect request,
ADS / DIS = ADS-C (automatic position reports, recognised here but not decoded).
CRC: CRC-16 CCITT (start 0xFFFF) over IMI + aircraft + binary data incl. CRC, result 0x1D0F.
The binary data is the ASN.1 message (RTCA DO-258) in unaligned PER: a header (message number,
reference to the answered message, time stamp) and 1-5 message elements, e.g. uM20 [altitude].
The message types and their standard wording are in cpdlc_schema.py.

Test from the command line:  python cpdlc.py u AA "/AKLCDYA.AT1.9M-MTB215B659D84995674293583561CB9906744E9AF40F9EB"
"""
import re
import sys
import time

from cpdlc_schema import TEXTS, TYPES

IMIS = {"AT1": "CPDLC message", "CR1": "CPDLC connect request", "CC1": "CPDLC connect confirm",
        "DR1": "CPDLC disconnect request", "ADS": "ADS-C report", "DIS": "ADS-C disconnect"}
CPDLC_IMIS = ("AT1", "CR1", "CC1", "DR1")
LABELS = ("AA", "BA", "A6", "B6", "H1")      # ACARS labels that carry ARINC 622 messages
CRC_GOOD = 0x1D0F


def crc16_arinc(data, crc=0xFFFF):
    """CRC-16 CCITT, polynomial 0x1021, not reflected."""
    for b in data:
        crc ^= b << 8
        for _ in range(8):
            crc = ((crc << 1) ^ 0x1021) & 0xFFFF if crc & 0x8000 else (crc << 1) & 0xFFFF
    return crc


def _strip_h1(text, up):
    """H1 messages start with a sublabel ("- #MD" up, "#M1B" down) and optionally an MFI ("/AA ")."""
    if up and text.startswith("- #") and len(text) >= 5:
        text = text[5:]
    elif not up and len(text) >= 4 and text[0] == "#" and text[3] == "B":
        text = text[4:]
    else:
        return text
    if len(text) >= 4 and text[0] == "/" and text[3] == " ":
        text = text[4:]
    return text


def split_arinc(label, text, up):
    """ARINC 622 message -> (ground address, IMI, aircraft, data bytes, CRC ok) or None."""
    if label not in LABELS or not text:
        return None
    t = "".join(text.split())                 # the hex may be broken over lines / blocks
    if label == "H1":
        t = _strip_h1(text.strip(), up).replace("\n", "").replace(" ", "")
    if t.startswith("/"):
        t = t[1:]
    for imi in IMIS:                          # the first IMI found (same order as libacars)
        i = t.find("." + imi)
        if i >= 0:
            break
    else:
        return None
    gs = t[:i]
    if i not in (7, 4) or not all(c.isupper() or c.isdigit() for c in gs):
        return None
    body = t[i + 1:]                          # IMI + aircraft (7) + hex
    if len(body) < 3 + 7 + 4:
        return None
    hexs = body[10:]
    if len(hexs) % 2:
        hexs = hexs[:-1]
    try:
        data = bytes.fromhex(hexs)
    except ValueError:
        return None
    crc_ok = crc16_arinc(body[:10].encode("ascii", "replace") + data) == CRC_GOOD
    return gs, body[:3], body[3:10].lstrip("."), data[:-2], crc_ok


# ---------- unaligned PER (ASN.1) ----------

class _Bits:
    def __init__(self, data):
        self.v = int.from_bytes(data, "big")
        self.n = len(data) * 8
        self.pos = 0

    def read(self, k):
        if k == 0:
            return 0
        if self.pos + k > self.n:
            raise ValueError("message is shorter than its content")
        self.pos += k
        return (self.v >> (self.n - self.pos)) & ((1 << k) - 1)


def _nbits(rng):
    return rng.bit_length()       # bits for a constrained number 0..rng


def _decode(bits, t):
    d = TYPES[t]
    k = d[0]
    if k == "i":
        return d[1] + bits.read(_nbits(d[2] - d[1]))
    if k == "e":
        i = bits.read(_nbits(len(d[1]) - 1))
        if i >= len(d[1]):
            raise ValueError(f"{t}: bad value {i}")
        return d[1][i]
    if k == "c":
        i = bits.read(_nbits(len(d[1]) - 1))
        if i >= len(d[1]):
            raise ValueError(f"{t}: bad choice {i}")
        name, sub = d[1][i]
        return (name, _decode(bits, sub))
    if k == "q":
        present = [not opt or bits.read(1) for _, _, opt in d[1]]   # bitmap of the optional members first
        return {name: _decode(bits, sub) for (name, sub, _), p in zip(d[1], present) if p}
    if k == "l":
        n = d[1] + bits.read(_nbits(d[2] - d[1]))
        if n > d[2]:
            raise ValueError(f"{t}: bad length {n}")
        return [_decode(bits, d[3]) for _ in range(n)]
    if k == "s":
        _, lb, ub, cb, clb, cub, c2v = d
        n = lb + bits.read(_nbits(ub - lb))
        if n > ub:
            raise ValueError(f"{t}: bad length {n}")
        out = []
        for _ in range(n):
            c = bits.read(cb)
            if c2v:
                c = c2v[c] if c < len(c2v) else 63
            elif cub > (1 << cb) - 1:
                c += clb
            out.append(chr(c))
        return "".join(out)
    if k == "n":
        return None
    if k == "b":
        return bool(bits.read(1))
    raise ValueError(f"unknown type {t}")


# ---------- text ----------

TIME = TYPES["Time"]
# leaf type -> text of the value (units as in the message set; X10 = in tens)
VALUE_FMT = {
    "AltitudeFlightLevel": lambda v: f"FL{v:03d}",
    "AltitudeFlightLevelMetric": lambda v: f"{v * 10} M STD",
    "AltitudeQNH": lambda v: f"{v * 10} FT",
    "AltitudeQNHMeters": lambda v: f"{v} M",
    "AltitudeQFE": lambda v: f"{v * 10} FT QFE",
    "AltitudeQFEMeters": lambda v: f"{v} M QFE",
    "AltitudeGNSSFeet": lambda v: f"{v} FT GNSS",
    "AltitudeGNSSMeters": lambda v: f"{v} M GNSS",
    "SpeedIndicated": lambda v: f"{v * 10} KT",
    "SpeedIndicatedMetric": lambda v: f"{v * 10} KM/H",
    "SpeedTrue": lambda v: f"TAS {v * 10} KT",
    "SpeedTrueMetric": lambda v: f"TAS {v * 10} KM/H",
    "SpeedGround": lambda v: f"GS {v * 10} KT",
    "SpeedGroundMetric": lambda v: f"GS {v * 10} KM/H",
    "SpeedMach": lambda v: f"M{v / 100:.2f}",
    "SpeedMachLarge": lambda v: f"M{v / 100:.2f}",
    "DegreesMagnetic": lambda v: f"{v:03d}°",
    "DegreesTrue": lambda v: f"{v:03d}° TRUE",
    "DegreeIncrement": lambda v: f"{v}°",
    "LatitudeDegrees": lambda v: f"{v}°",
    "LongitudeDegrees": lambda v: f"{v}°",
    "WindDirection": lambda v: f"{v:03d}°",
    "Frequencyhf": lambda v: f"{v} kHz",
    "Frequencyvhf": lambda v: f"{v / 1000:.3f} MHz",
    "Frequencyuhf": lambda v: f"{v / 1000:.3f} MHz",
    "FrequencyDeparture": lambda v: f"{v / 1000:.3f} MHz",
    "DistanceNm": lambda v: f"{v / 10:.1f} NM",
    "DistanceKm": lambda v: f"{v} KM",
    "DistanceOffsetNm": lambda v: f"{v} NM",
    "DistanceOffsetKm": lambda v: f"{v} KM",
    "LegDistanceEnglish": lambda v: f"{v / 10:.1f} NM",
    "LegDistanceMetric": lambda v: f"{v} KM",
    "LegTime": lambda v: f"{v / 10:.1f} MIN",
    "RTATolerance": lambda v: f"{v / 10:.1f} MIN",
    "VerticalRateEnglish": lambda v: f"{v * 100} FT/MIN",
    "VerticalRateMetric": lambda v: f"{v * 10} M/MIN",
    "AltimeterEnglish": lambda v: f"{v / 100:.2f} INHG",
    "AltimeterMetric": lambda v: f"{v / 10:.1f} HPA",
    "TemperatureC": lambda v: f"{v} °C",
    "TemperatureF": lambda v: f"{v} °F",
    "WindSpeedEnglish": lambda v: f"{v} KT",
    "WindSpeedMetric": lambda v: f"{v} KM/H",
}


# readable names of some members (the ASN.1 names are run together)
NAMES = {"positioncurrent": "position", "timeatpositioncurrent": "time", "fixnext": "next fix",
         "timeetaatfixnext": "ETA next fix", "fixnextplusone": "then", "timeetadestination": "ETA destination",
         "routeinformation-seqOf": "route", "routeInformationAdditional": "additional route info"}


def _words(name):
    """camelCase member / enum name -> words ("groundControl" -> "ground control")."""
    if name in NAMES:
        return NAMES[name]
    name = name.replace("-seqOf", "").replace("-", " ")
    return re.sub(r"(?<=[a-z])(?=[A-Z])", " ", name).lower()


def _indent(s, n=1):
    return "\n".join("  " * n + line for line in s.split("\n"))


def _latlon(v, deg, dirn, width):
    d = f"{v[deg]:0{width}d}"
    m = f"{v['minutesLatLon'] / 10:04.1f}'" if "minutesLatLon" in v else ""
    return f"{d}°{m}{'N' if v[dirn] == 'north' else 'S' if v[dirn] == 'south' else 'E' if v[dirn] == 'east' else 'W'}"


def fmt(t, v):
    """Value of type t as text (multi-line for large structures)."""
    d = TYPES[t]
    k = d[0]
    if t in VALUE_FMT and k == "i":
        return VALUE_FMT[t](v)
    if d == TIME or t == "Time":
        return f"{v['hours']:02d}:{v['minutes']:02d}Z"
    if t == "Timestamp":
        return f"{v['hours']:02d}:{v['minutes']:02d}:{v['seconds']:02d}Z"
    if t == "Latitude":
        return _latlon(v, "latitudeDegrees", "latitudeDirection", 2)
    if t == "Longitude":
        return _latlon(v, "longitudeDegrees", "longitudeDirection", 3)
    if t == "BeaconCode":
        return "".join(str(x) for x in v)
    if k == "i":
        return str(v)
    if k == "e":
        return _words(v).upper()
    if k == "s":
        return v
    if k == "b":
        return "YES" if v else "NO"
    if k == "n":
        return ""
    if k == "c":
        name, sub = v
        return fmt(dict(d[1])[name], sub)
    if k == "l":
        items = [fmt(d[3], x) for x in v]
        if any("\n" in s for s in items):
            return "\n".join(f"- {s}" if "\n" not in s else "-\n" + _indent(s) for s in items)
        return " ".join(items)
    # SEQUENCE: small ones on one line, large ones as "name: value" lines
    parts = [(name, fmt(sub, v[name])) for name, sub, _ in d[1] if name in v]
    if len(d[1]) <= 4 and not any("\n" in s for _, s in parts):
        return " ".join(s for _, s in parts if s)
    lines = []
    for name, s in parts:
        if "\n" in s:
            lines.append(f"{_words(name)}:\n{_indent(s)}")
        else:
            lines.append(f"{_words(name)}: {s}")
    return "\n".join(lines)


def _element(alt, t, v):
    """One message element -> (id like "uM20", text with the parameters filled in)."""
    eid = re.match(r"[ud]M\d+", alt).group()
    tpl = TEXTS.get(eid) or f"(reserved element {eid})"
    ph = re.findall(r"\[[^\]]+\]", tpl)
    d = TYPES[t]
    if not ph or d[0] == "n":
        return eid, tpl
    params = None
    if len(ph) == 1:
        params = [fmt(t, v)]
    elif d[0] == "q" and len(d[1]) == len(ph):
        params = [fmt(sub, v[name]) if name in v else "?" for name, sub, _ in d[1]]
    elif d[0] == "l" and len(v) == len(ph):
        params = [fmt(d[3], x) for x in v]
    if params is None:
        return eid, tpl + "\n" + _indent(fmt(t, v))
    extra = []
    it = iter(params)

    def fill(m):
        s = next(it)
        if "\n" in s:            # a large structure (route, position report): below the text
            extra.append(_indent(s))
            return ""
        return s
    text = " ".join(re.sub(r"\[[^\]]+\]", fill, tpl).split())
    return eid, "\n".join([text] + extra)


def decode(label, text, up):
    """ACARS message text -> CPDLC dictionary, or None if it is not an ARINC 622 message."""
    a = split_arinc(label, text, up)
    if not a:
        return None
    gs, imi, air, data, crc_ok = a
    r = {"gs": gs, "imi": imi, "imi_desc": IMIS[imi], "air": air, "crc_ok": crc_ok,
         "dir": "up" if up else "down", "min": None, "mrn": None, "ts": "", "elements": [], "error": ""}
    if imi not in CPDLC_IMIS:
        r["error"] = "ADS-C is not decoded"
        r["text"] = IMIS[imi]
        return r
    if not data:
        r["text"] = IMIS[imi]
        return r
    try:
        msg = _decode(_Bits(data), "ATCUplinkMessage" if up else "ATCDownlinkMessage")
    except (ValueError, KeyError, IndexError) as e:
        r["error"] = f"cannot decode: {e}"
        r["text"] = f"{IMIS[imi]} (undecodable{'' if crc_ok else ', CRC error'})"
        return r
    keys = list(msg)
    hdr = msg[keys[0]]
    r["min"] = hdr.get("msgIdentificationNumber")
    r["mrn"] = hdr.get("msgReferenceNumber")
    if "timestamp" in hdr:
        r["ts"] = fmt("Timestamp", hdr["timestamp"])
    elems = [msg[keys[1]]] + list(msg.get(keys[2], []) if len(keys) > 2 else [])
    choice = dict(TYPES["ATCUplinkMsgElementId" if up else "ATCDownlinkMsgElementId"][1])
    for alt, val in elems:
        eid, txt = _element(alt, choice[alt], val)
        r["elements"].append({"id": eid, "text": txt})
    r["text"] = "\n".join(e["text"] for e in r["elements"])
    if imi != "AT1":
        r["text"] = f"[{IMIS[imi]}] " + r["text"]
    return r


class Reassembler:
    """Long ARINC 622 messages come in several ACARS blocks (ETB = continues): joins their texts."""

    def __init__(self, timeout=120.0):
        self.timeout = timeout
        self.parts = {}           # (reg, label, dir) -> [time, text, last block]

    def push(self, m):
        """ACARS message -> full text when complete (or not split), None while waiting for more."""
        now = time.time()
        for k in [k for k, p in self.parts.items() if now - p[0] > self.timeout]:
            del self.parts[k]
        key = (m["reg"], m["label"], m["dir"])
        p = self.parts.get(key)
        text = m["text"]
        if p:
            if m["block"] == p[2]:            # the same block again (retransmission)
                return None
            text = p[1] + "".join(text.split())
        elif m["more"] and not any("." + i in text for i in IMIS):
            return text                       # not ARINC 622: no need to wait
        if m["more"]:
            self.parts[key] = [now, "".join(text.split()), m["block"]]
            return None
        self.parts.pop(key, None)
        return text


def main(argv):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except (AttributeError, ValueError):
        pass
    if len(argv) < 4 or argv[1] not in ("u", "d"):
        print('usage: python cpdlc.py u|d LABEL "message text"   (u = uplink from the ground, d = downlink)')
        return 1
    r = decode(argv[2], argv[3], argv[1] == "u")
    if not r:
        print("not an ARINC 622 message")
        return 1
    print(f"{r['imi_desc']}  ground {r['gs']}  aircraft {r['air']}  CRC {'OK' if r['crc_ok'] else 'ERROR'}")
    print(f"MIN {r['min']}  MRN {r['mrn']}  {r['ts']}")
    for e in r["elements"]:
        print(f"{e['id']}: " + e["text"].replace("\n", "\n      "))
    if r["error"]:
        print(r["error"])
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
