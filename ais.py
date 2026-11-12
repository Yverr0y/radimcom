"""AIS decoder: raw SDR samples -> both AIS channels (161.975 / 162.025 MHz) -> ship positions and static data.

AIS (Automatic Identification System, ITU-R M.1371) is the VHF data link of ships, base stations, aids to navigation and
SAR aircraft: GMSK 9600 Bd (BT 0.4), NRZI, HDLC framing (flag 0x7E, bit stuffing, CRC-16/X.25), one message of 168 bits
(class A position report) to 1008 bits (static data) in a 26.7 ms slot, on two channels 50 kHz apart:

    AIS 1 (87B)  161.975 MHz
    AIS 2 (88B)  162.025 MHz

Everything is done here in numpy, no external program: the raw samples of the SDR (uint8 I/Q of an RTL dongle, complex64
of LimeSDR / Airspy) are filtered (complex band-pass per channel, polyphase decimation to ~48 kHz), FM demodulated,
the bit clock recovered (the PLL of the packet decoder) and the HDLC frames taken apart (the deframer of the packet decoder,
with the AIS bit order). The payload is decoded to a record (MMSI, name, position, course, speed...) and also given as
the NMEA !AIVDM sentence, so it can go to other programs.

    receiver thread --raw block--> queue --worker thread--> channels -> frames -> on_event("ais", record)

Like HFDL, the sample rate and centre of the VFO stay as they are (its audio is muted): the AIS channels inside the received
band are decoded; the 162.000 MHz button centres the VFO between the two channels, so both are decoded at once.
"""
import collections
import datetime
import math
import queue
import threading
import time

import numpy as np

import packet
from sdr import lowpass

CHANNELS = {161975000: "A", 162025000: "B"}      # Hz -> channel name (AIS 1 = 87B, AIS 2 = 88B)
CENTER_HZ = 162000000                             # the button: between the channels, neither on the DC spike
BAUD = 9600
OUT_FS = 48000           # rate of one channel after decimation (5 samples per bit)
EDGE_HZ = 15000          # a channel must be this far inside the received band
DC_HZ = 5000             # and this far from the centre (DC spike of the dongle)
SETTLE_S = 1.0           # the VFO must stay this long at a new centre / rate before the channels are set up
MAX_HISTORY = 500
MAX_SHIPS = 2000
MIN_FRAME = 10           # bytes with FCS: nothing in AIS is shorter than 72 bits (message 14 / 25 minimum is 40 + 32)
MAX_FRAME = 130          # 1008 bits + FCS = 128 bytes

FLAGS = {"A": "AIS 1 (161.975 MHz)", "B": "AIS 2 (162.025 MHz)"}


def channels_in(fs, center_hz):
    """AIS channels (Hz) inside the band received at sample rate fs around center_hz."""
    half = fs / 2 - EDGE_HZ
    return [f for f in CHANNELS if abs(f - center_hz) < half and abs(f - center_hz) > DC_HZ]


# ---------------------------------------------------------------- DSP: one AIS channel

class _Channel:
    """One AIS channel out of the raw band: complex band-pass + polyphase decimation to ~48 kHz, the residual carrier
    taken out, FM discriminator, DC removal (tuning error), low-pass, bit clock (PLL), NRZI/HDLC."""

    def __init__(self, fs, offset_hz):
        self.d = max(1, int(round(fs / OUT_FS)))
        self.fs_out = fs / self.d
        taps = 12 * self.d
        n = np.arange(taps)
        h = lowpass(min(11000.0, 0.4 * self.fs_out), fs, taps).astype(np.float64)
        bp = h * np.exp(-2j * np.pi * offset_hz * n / fs)         # band-pass on the channel (a dot product, not a convolution: h reversed)
        # interleaved real taps for [I0 Q0 I1 Q1 ...]: out_re = I*hr - Q*hi, out_im = I*hi + Q*hr
        self.h_re = np.empty(2 * taps, np.float32)
        self.h_im = np.empty(2 * taps, np.float32)
        self.h_re[0::2], self.h_re[1::2] = bp.real, -bp.imag
        self.h_im[0::2], self.h_im[1::2] = bp.imag, bp.real
        self.taps = taps
        self.hist = np.zeros(2 * (taps - 1), np.float32)         # interleaved samples kept from the previous block
        self.off = 0                                              # decimation phase carried over
        # the channel sits at offset_hz: after decimation it aliases to a residual that the NCO takes out
        self.res = -2 * np.pi * (offset_hz % self.fs_out) / self.fs_out
        self.phase = 0.0
        self.disc = packet._Disc(self.fs_out)
        self.afc = packet._Afc(self.fs_out, 0.02)
        self.aud = packet._Fir(lowpass(0.6 * BAUD, self.fs_out, 31))
        self.clock = packet._Clock(self.fs_out / BAUD)
        self.hdlc = packet.HdlcDeframer(nrzi=True, min_frame=MIN_FRAME, max_frame=MAX_FRAME, header_ok=_frame_plausible)
        self.level = -99.0                                        # peak level in the last block, dBFS

    def process(self, iq):
        """iq: interleaved float32 I, Q (±1) of the raw band -> list of HDLC frames (bytes, FCS removed)."""
        buf = np.concatenate((self.hist, iq))
        keep = 2 * (self.taps - 1)
        self.hist = buf[len(buf) - keep:]
        n_in = (len(buf) - keep) // 2                              # new complex samples
        # output m uses samples m*D + off ... m*D + off + taps - 1 (interleaved index 2*(m*D + off))
        first = self.off
        n_out = (n_in - first + self.d - 1) // self.d if n_in > first else 0
        if n_out <= 0:
            self.off = first - n_in
            return []
        st = buf.strides[0]
        win = np.lib.stride_tricks.as_strided(buf[2 * first:], shape=(n_out, 2 * self.taps), strides=(2 * self.d * st, st))
        z = (win @ self.h_re) + 1j * (win @ self.h_im)
        self.off = first + n_out * self.d - n_in
        ph = self.phase + self.res * np.arange(1, n_out + 1)
        self.phase = float(ph[-1] % (2 * np.pi))
        z = (z * np.exp(1j * ph)).astype(np.complex64)
        p = np.abs(z) ** 2
        if len(p) >= 48:
            p = np.convolve(p, np.full(48, 1 / 48, np.float32), mode="valid")     # 1 ms: the peak of a burst
        self.level = float(10 * np.log10(p.max() + 1e-12))
        f = self.disc.process(z)
        bits = self.clock.process(self.aud.process(self.afc.process(f)))
        return self.hdlc.feed(bits)


def _frame_plausible(frame):
    """Looks like an AIS message (for the bad-FCS counter): known type, length of a whole number of slots."""
    if len(frame) < MIN_FRAME:
        return False
    t = frame[0] >> 2
    return 1 <= t <= 27


# ---------------------------------------------------------------- AIS payload

SIXBIT = "@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_ !\"#$%&'()*+,-./0123456789:;<=>?"


class _Bits:
    def __init__(self, data):
        # each byte goes on the air LSB first and the HDLC deframer assembles it LSB first, so the bytes it gives are
        # already the AIS payload bytes: the payload bit string is their bits MSB first (no reversal)
        self.bits = "".join(f"{b:08b}" for b in data)

    def __len__(self):
        return len(self.bits)

    def u(self, start, n):
        s = self.bits[start:start + n]
        return int(s, 2) if len(s) == n else 0

    def i(self, start, n):
        v = self.u(start, n)
        return v - (1 << n) if v & (1 << (n - 1)) else v

    def text(self, start, n):
        out = []
        for k in range(start, min(start + n, len(self.bits) - 5), 6):
            out.append(SIXBIT[int(self.bits[k:k + 6], 2)])
        return "".join(out).split("@")[0].strip()


def armor(data):
    """Payload bytes -> (NMEA 6-bit ASCII payload, fill bits), as in !AIVDM."""
    bits = "".join(f"{b:08b}" for b in data)
    fill = (-len(bits)) % 6
    bits += "0" * fill
    out = []
    for k in range(0, len(bits), 6):
        v = int(bits[k:k + 6], 2)
        out.append(chr(v + 48 if v < 40 else v + 56))
    return "".join(out), fill


def nmea(payload, fill, channel):
    body = f"AIVDM,1,1,,{channel},{payload},{fill}"
    cs = 0
    for ch in body:
        cs ^= ord(ch)
    return f"!{body}*{cs:02X}"


TYPES = {1: "Position report (class A)", 2: "Position report (class A, assigned)", 3: "Position report (class A, response)",
         4: "Base station report", 5: "Static and voyage data (class A)", 6: "Binary addressed message",
         7: "Binary acknowledge", 8: "Binary broadcast message", 9: "SAR aircraft position report",
         10: "UTC / date inquiry", 11: "UTC / date response", 12: "Addressed safety message",
         13: "Safety acknowledge", 14: "Safety broadcast message", 15: "Interrogation", 16: "Assignment mode command",
         17: "DGNSS broadcast", 18: "Position report (class B)", 19: "Extended position report (class B)",
         20: "Data link management", 21: "Aid to navigation report", 22: "Channel management",
         23: "Group assignment command", 24: "Static data report (class B)", 25: "Single slot binary message",
         26: "Multiple slot binary message", 27: "Long-range position report"}

NAV_STATUS = {0: "under way using engine", 1: "at anchor", 2: "not under command", 3: "restricted manoeuvrability",
              4: "constrained by draught", 5: "moored", 6: "aground", 7: "engaged in fishing", 8: "under way sailing",
              9: "reserved (HSC)", 10: "reserved (WIG)", 11: "towing astern", 12: "pushing ahead / towing alongside",
              13: "reserved", 14: "AIS-SART / MOB / EPIRB", 15: "undefined"}

SHIP_TYPES = {0: "", 20: "Wing in ground", 29: "Wing in ground", 30: "Fishing", 31: "Towing", 32: "Towing (long / wide)",
              33: "Dredging / underwater ops", 34: "Diving ops", 35: "Military ops", 36: "Sailing", 37: "Pleasure craft",
              40: "High speed craft", 49: "High speed craft", 50: "Pilot vessel", 51: "Search and rescue vessel", 52: "Tug",
              53: "Port tender", 54: "Anti-pollution equipment", 55: "Law enforcement", 56: "Spare (local)", 57: "Spare (local)",
              58: "Medical transport", 59: "Noncombatant ship", 60: "Passenger", 69: "Passenger", 70: "Cargo", 79: "Cargo",
              80: "Tanker", 89: "Tanker", 90: "Other", 99: "Other"}
HAZARD = {1: "hazardous cat. A", 2: "hazardous cat. B", 3: "hazardous cat. C", 4: "hazardous cat. D"}

ATON_TYPES = {0: "unspecified", 1: "reference point", 2: "RACON", 3: "fixed structure off shore", 4: "reserved",
              5: "light, without sectors", 6: "light, with sectors", 7: "leading light front", 8: "leading light rear",
              9: "beacon, cardinal N", 10: "beacon, cardinal E", 11: "beacon, cardinal S", 12: "beacon, cardinal W",
              13: "beacon, port hand", 14: "beacon, starboard hand", 15: "beacon, preferred channel port hand",
              16: "beacon, preferred channel starboard hand", 17: "beacon, isolated danger", 18: "beacon, safe water",
              19: "beacon, special mark", 20: "cardinal mark N", 21: "cardinal mark E", 22: "cardinal mark S",
              23: "cardinal mark W", 24: "port hand mark", 25: "starboard hand mark", 26: "preferred channel port hand",
              27: "preferred channel starboard hand", 28: "isolated danger", 29: "safe water", 30: "special mark",
              31: "light vessel / LANBY / rig"}

EPFD = {0: "", 1: "GPS", 2: "GLONASS", 3: "GPS/GLONASS", 4: "Loran-C", 5: "Chayka", 6: "integrated", 7: "surveyed",
        8: "Galileo", 15: "internal GNSS"}


def ship_type(code):
    if code in SHIP_TYPES:
        return SHIP_TYPES[code]
    if 20 <= code <= 29:
        return "Wing in ground" + (f", {HAZARD[code - 20]}" if code - 20 in HAZARD else "")
    if 40 <= code <= 49:
        return "High speed craft" + (f", {HAZARD[code - 40]}" if code - 40 in HAZARD else "")
    for base, name in ((60, "Passenger"), (70, "Cargo"), (80, "Tanker"), (90, "Other")):
        if base <= code <= base + 9:
            return name + (f", {HAZARD[code - base]}" if code - base in HAZARD else "")
    return f"type {code}" if code else ""


# Maritime Identification Digits (the first three digits of an MMSI) -> (ISO 3166 code, country), ITU table.
MID = {
    201: ("al", "Albania"), 202: ("ad", "Andorra"), 203: ("at", "Austria"), 204: ("pt", "Portugal (Azores)"),
    205: ("be", "Belgium"), 206: ("by", "Belarus"), 207: ("bg", "Bulgaria"), 208: ("va", "Vatican"), 209: ("cy", "Cyprus"),
    210: ("cy", "Cyprus"), 211: ("de", "Germany"), 212: ("cy", "Cyprus"), 213: ("ge", "Georgia"), 214: ("md", "Moldova"),
    215: ("mt", "Malta"), 216: ("am", "Armenia"), 218: ("de", "Germany"), 219: ("dk", "Denmark"), 220: ("dk", "Denmark"),
    224: ("es", "Spain"), 225: ("es", "Spain"), 226: ("fr", "France"), 227: ("fr", "France"), 228: ("fr", "France"),
    229: ("mt", "Malta"), 230: ("fi", "Finland"), 231: ("fo", "Faroe Islands"), 232: ("gb", "United Kingdom"),
    233: ("gb", "United Kingdom"), 234: ("gb", "United Kingdom"), 235: ("gb", "United Kingdom"), 236: ("gi", "Gibraltar"),
    237: ("gr", "Greece"), 238: ("hr", "Croatia"), 239: ("gr", "Greece"), 240: ("gr", "Greece"), 241: ("gr", "Greece"),
    242: ("ma", "Morocco"), 243: ("hu", "Hungary"), 244: ("nl", "Netherlands"), 245: ("nl", "Netherlands"),
    246: ("nl", "Netherlands"), 247: ("it", "Italy"), 248: ("mt", "Malta"), 249: ("mt", "Malta"), 250: ("ie", "Ireland"),
    251: ("is", "Iceland"), 252: ("li", "Liechtenstein"), 253: ("lu", "Luxembourg"), 254: ("mc", "Monaco"),
    255: ("pt", "Portugal (Madeira)"), 256: ("mt", "Malta"), 257: ("no", "Norway"), 258: ("no", "Norway"), 259: ("no", "Norway"),
    261: ("pl", "Poland"), 262: ("me", "Montenegro"), 263: ("pt", "Portugal"), 264: ("ro", "Romania"), 265: ("se", "Sweden"),
    266: ("se", "Sweden"), 267: ("sk", "Slovakia"), 268: ("sm", "San Marino"), 269: ("ch", "Switzerland"),
    270: ("cz", "Czechia"), 271: ("tr", "Türkiye"), 272: ("ua", "Ukraine"), 273: ("ru", "Russia"), 274: ("mk", "North Macedonia"),
    275: ("lv", "Latvia"), 276: ("ee", "Estonia"), 277: ("lt", "Lithuania"), 278: ("si", "Slovenia"), 279: ("rs", "Serbia"),
    301: ("ai", "Anguilla"), 303: ("us", "Alaska (USA)"), 304: ("ag", "Antigua and Barbuda"), 305: ("ag", "Antigua and Barbuda"),
    306: ("cw", "Curaçao / Sint Maarten"), 307: ("aw", "Aruba"), 308: ("bs", "Bahamas"), 309: ("bs", "Bahamas"),
    310: ("bm", "Bermuda"), 311: ("bs", "Bahamas"), 312: ("bz", "Belize"), 314: ("bb", "Barbados"), 316: ("ca", "Canada"),
    319: ("ky", "Cayman Islands"), 321: ("cr", "Costa Rica"), 323: ("cu", "Cuba"), 325: ("dm", "Dominica"),
    327: ("do", "Dominican Republic"), 329: ("gp", "Guadeloupe"), 330: ("gd", "Grenada"), 331: ("gl", "Greenland"),
    332: ("gt", "Guatemala"), 334: ("hn", "Honduras"), 336: ("ht", "Haiti"), 338: ("us", "USA"), 339: ("jm", "Jamaica"),
    341: ("kn", "Saint Kitts and Nevis"), 343: ("lc", "Saint Lucia"), 345: ("mx", "Mexico"), 347: ("mq", "Martinique"),
    348: ("ms", "Montserrat"), 350: ("ni", "Nicaragua"), 351: ("pa", "Panama"), 352: ("pa", "Panama"), 353: ("pa", "Panama"),
    354: ("pa", "Panama"), 355: ("pa", "Panama"), 356: ("pa", "Panama"), 357: ("pa", "Panama"), 358: ("pr", "Puerto Rico"),
    359: ("sv", "El Salvador"), 361: ("pm", "Saint Pierre and Miquelon"), 362: ("tt", "Trinidad and Tobago"),
    364: ("tc", "Turks and Caicos"), 366: ("us", "USA"), 367: ("us", "USA"), 368: ("us", "USA"), 369: ("us", "USA"),
    370: ("pa", "Panama"), 371: ("pa", "Panama"), 372: ("pa", "Panama"), 373: ("pa", "Panama"), 374: ("pa", "Panama"),
    375: ("vc", "Saint Vincent and the Grenadines"), 376: ("vc", "Saint Vincent and the Grenadines"),
    377: ("vc", "Saint Vincent and the Grenadines"), 378: ("vg", "British Virgin Islands"), 379: ("vi", "US Virgin Islands"),
    401: ("af", "Afghanistan"), 403: ("sa", "Saudi Arabia"), 405: ("bd", "Bangladesh"), 408: ("bh", "Bahrain"),
    410: ("bt", "Bhutan"), 412: ("cn", "China"), 413: ("cn", "China"), 414: ("cn", "China"), 416: ("tw", "Taiwan"),
    417: ("lk", "Sri Lanka"), 419: ("in", "India"), 422: ("ir", "Iran"), 423: ("az", "Azerbaijan"), 425: ("iq", "Iraq"),
    428: ("il", "Israel"), 431: ("jp", "Japan"), 432: ("jp", "Japan"), 434: ("tm", "Turkmenistan"), 436: ("kz", "Kazakhstan"),
    437: ("uz", "Uzbekistan"), 438: ("jo", "Jordan"), 440: ("kr", "South Korea"), 441: ("kr", "South Korea"),
    443: ("ps", "Palestine"), 445: ("kp", "North Korea"), 447: ("kw", "Kuwait"), 450: ("lb", "Lebanon"),
    451: ("kg", "Kyrgyzstan"), 453: ("mo", "Macao"), 455: ("mv", "Maldives"), 457: ("mn", "Mongolia"), 459: ("np", "Nepal"),
    461: ("om", "Oman"), 463: ("pk", "Pakistan"), 466: ("qa", "Qatar"), 468: ("sy", "Syria"), 470: ("ae", "United Arab Emirates"),
    471: ("ae", "United Arab Emirates"), 472: ("tj", "Tajikistan"), 473: ("ye", "Yemen"), 475: ("ye", "Yemen"),
    477: ("hk", "Hong Kong"), 478: ("ba", "Bosnia and Herzegovina"),
    501: ("aq", "Adélie Land"), 503: ("au", "Australia"), 506: ("mm", "Myanmar"), 508: ("bn", "Brunei"), 510: ("fm", "Micronesia"),
    511: ("pw", "Palau"), 512: ("nz", "New Zealand"), 514: ("kh", "Cambodia"), 515: ("kh", "Cambodia"), 516: ("cx", "Christmas Island"),
    518: ("ck", "Cook Islands"), 520: ("fj", "Fiji"), 523: ("cc", "Cocos (Keeling) Islands"), 525: ("id", "Indonesia"),
    529: ("ki", "Kiribati"), 531: ("la", "Laos"), 533: ("my", "Malaysia"), 536: ("mp", "Northern Mariana Islands"),
    538: ("mh", "Marshall Islands"), 540: ("nc", "New Caledonia"), 542: ("nu", "Niue"), 544: ("nr", "Nauru"),
    546: ("pf", "French Polynesia"), 548: ("ph", "Philippines"), 550: ("tl", "Timor-Leste"), 553: ("pg", "Papua New Guinea"),
    555: ("pn", "Pitcairn"), 557: ("sb", "Solomon Islands"), 559: ("as", "American Samoa"), 561: ("ws", "Samoa"),
    563: ("sg", "Singapore"), 564: ("sg", "Singapore"), 565: ("sg", "Singapore"), 566: ("sg", "Singapore"), 567: ("th", "Thailand"),
    570: ("to", "Tonga"), 572: ("tv", "Tuvalu"), 574: ("vn", "Vietnam"), 576: ("vu", "Vanuatu"), 577: ("vu", "Vanuatu"),
    578: ("wf", "Wallis and Futuna"),
    601: ("za", "South Africa"), 603: ("ao", "Angola"), 605: ("dz", "Algeria"), 607: ("tf", "Saint Paul and Amsterdam Islands"),
    608: ("sh", "Ascension Island"), 609: ("bi", "Burundi"), 610: ("bj", "Benin"), 611: ("bw", "Botswana"), 612: ("cf", "Central African Republic"),
    613: ("cm", "Cameroon"), 615: ("cg", "Congo"), 616: ("km", "Comoros"), 617: ("cv", "Cabo Verde"), 618: ("tf", "Crozet Archipelago"),
    619: ("ci", "Côte d'Ivoire"), 620: ("km", "Comoros"), 621: ("dj", "Djibouti"), 622: ("eg", "Egypt"), 624: ("et", "Ethiopia"),
    625: ("er", "Eritrea"), 626: ("ga", "Gabon"), 627: ("gh", "Ghana"), 629: ("gm", "Gambia"), 630: ("gw", "Guinea-Bissau"),
    631: ("gq", "Equatorial Guinea"), 632: ("gn", "Guinea"), 633: ("bf", "Burkina Faso"), 634: ("ke", "Kenya"),
    635: ("tf", "Kerguelen Islands"), 636: ("lr", "Liberia"), 637: ("lr", "Liberia"), 638: ("ss", "South Sudan"), 642: ("ly", "Libya"),
    644: ("ls", "Lesotho"), 645: ("mu", "Mauritius"), 647: ("mg", "Madagascar"), 649: ("ml", "Mali"), 650: ("mz", "Mozambique"),
    654: ("mr", "Mauritania"), 655: ("mw", "Malawi"), 656: ("ne", "Niger"), 657: ("ng", "Nigeria"), 659: ("na", "Namibia"),
    660: ("re", "Réunion"), 661: ("rw", "Rwanda"), 662: ("sd", "Sudan"), 663: ("sn", "Senegal"), 664: ("sc", "Seychelles"),
    665: ("sh", "Saint Helena"), 666: ("so", "Somalia"), 667: ("sl", "Sierra Leone"), 668: ("st", "São Tomé and Príncipe"),
    669: ("sz", "Eswatini"), 670: ("td", "Chad"), 671: ("tg", "Togo"), 672: ("tn", "Tunisia"), 674: ("tz", "Tanzania"),
    675: ("ug", "Uganda"), 676: ("cd", "DR Congo"), 677: ("tz", "Tanzania"), 678: ("zm", "Zambia"), 679: ("zw", "Zimbabwe"),
    701: ("ar", "Argentina"), 710: ("br", "Brazil"), 720: ("bo", "Bolivia"), 725: ("cl", "Chile"), 730: ("co", "Colombia"),
    735: ("ec", "Ecuador"), 740: ("fk", "Falkland Islands"), 745: ("gf", "French Guiana"), 750: ("gy", "Guyana"),
    755: ("py", "Paraguay"), 760: ("pe", "Peru"), 765: ("sr", "Suriname"), 770: ("uy", "Uruguay"), 775: ("ve", "Venezuela"),
}


def mmsi_info(mmsi):
    """(ISO country code or "", country name, kind of station) from the structure of the MMSI."""
    s = f"{mmsi:09d}"
    kinds = (("111", 3, "SAR aircraft"), ("00", 2, "coast station"), ("0", 1, "group of ships"), ("99", 2, "aid to navigation"),
             ("98", 2, "craft of a mother ship"))
    for prefix, at, kind in kinds:
        if s.startswith(prefix):
            cc, name = MID.get(int(s[at:at + 3]), ("", ""))
            return cc, name, kind
    for prefix, kind in (("970", "AIS-SART"), ("972", "MOB device"), ("974", "EPIRB")):
        if s.startswith(prefix):
            return "", "", kind
    cc, name = MID.get(int(s[0:3]), ("", ""))
    return cc, name, "ship"


def _latlon(b, pos_bit, lon_bits=28, lat_bits=27, scale=600000.0):
    lon = b.i(pos_bit, lon_bits) / scale
    lat = b.i(pos_bit + lon_bits, lat_bits) / scale
    if abs(lon) > 180 or abs(lat) > 90 or (lat == 0 and lon == 0):
        return None, None          # 181° / 91° = not available
    return round(lat, 5), round(lon, 5)


def decode(data):
    """AIS message bytes (without FCS) -> record: type, mmsi, and what the type carries. None for too short a frame."""
    b = _Bits(data)
    if len(b) < 40:
        return None
    t = b.u(0, 6)
    mmsi = b.u(8, 30)
    cc, country, kind = mmsi_info(mmsi)
    rec = {"type": t, "type_name": TYPES.get(t, f"Message {t}"), "mmsi": mmsi, "cc": cc, "country": country, "station": kind,
           "bits": len(b), "repeat": b.u(6, 2), "lat": None, "lon": None, "sog": None, "cog": None, "hdg": None,
           "status": "", "name": "", "callsign": "", "shiptype": "", "dest": "", "text": ""}
    if t in (1, 2, 3):
        rec["status"] = NAV_STATUS.get(b.u(38, 4), "")
        rot = b.i(42, 8)
        rec["sog"] = _sog(b.u(50, 10))
        rec["lat"], rec["lon"] = _latlon(b, 61)
        rec["cog"] = _cog(b.u(116, 12))
        rec["hdg"] = _hdg(b.u(128, 9))
        rec["ts"] = b.u(137, 6)
        if rot not in (-128, 0):
            r = (rot / 4.733) ** 2 * (1 if rot > 0 else -1)
            rec["text"] = "turning hard " + ("right" if rot > 0 else "left") if abs(rot) == 127 else f"ROT {r:+.0f}°/min"
    elif t in (4, 11):
        y, mo, d, h, mi, s = b.u(38, 14), b.u(52, 4), b.u(56, 5), b.u(61, 5), b.u(66, 6), b.u(72, 6)
        rec["lat"], rec["lon"] = _latlon(b, 79)
        if 1 <= mo <= 12 and 1 <= d <= 31 and h < 24 and mi < 60 and s < 60 and y:
            rec["text"] = f"UTC {y:04d}-{mo:02d}-{d:02d} {h:02d}:{mi:02d}:{s:02d}"
        rec["text"] = (rec["text"] + f" · {EPFD.get(b.u(134, 4), '')}").strip(" ·")
    elif t == 5:
        imo = b.u(40, 30)
        rec["callsign"] = b.text(70, 42)
        rec["name"] = b.text(112, 120)
        rec["shiptype"] = ship_type(b.u(232, 8))
        a, bb, c, d = b.u(240, 9), b.u(249, 9), b.u(258, 6), b.u(264, 6)
        mo, d_, h, mi = b.u(274, 4), b.u(278, 5), b.u(283, 5), b.u(288, 6)
        draught = b.u(294, 8) / 10
        rec["dest"] = b.text(302, 120)
        rec["imo"] = imo or None
        rec["size"] = f"{a + bb} × {c + d} m" if a + bb and c + d else ""
        rec["draught"] = draught or None
        rec["eta"] = f"{mo:02d}-{d_:02d} {h:02d}:{mi:02d}" if 1 <= mo <= 12 and 1 <= d_ <= 31 and h < 24 and mi < 60 else ""
        parts = [f"IMO {imo}" if imo else "", rec["size"], f"draught {draught:g} m" if draught else "", f"ETA {rec['eta']}" if rec["eta"] else ""]
        rec["text"] = " · ".join(p for p in parts if p)
    elif t == 9:
        alt = b.u(38, 12)
        rec["sog"] = float(b.u(50, 10)) if b.u(50, 10) != 1023 else None
        rec["lat"], rec["lon"] = _latlon(b, 61)
        rec["cog"] = _cog(b.u(116, 12))
        rec["text"] = f"altitude {alt} m" if alt != 4095 else ""
    elif t in (12, 14):
        start = 72 if t == 12 else 40
        rec["text"] = b.text(start, len(b) - start)
    elif t == 18:
        rec["sog"] = _sog(b.u(46, 10))
        rec["lat"], rec["lon"] = _latlon(b, 57)
        rec["cog"] = _cog(b.u(112, 12))
        rec["hdg"] = _hdg(b.u(124, 9))
    elif t == 19:
        rec["sog"] = _sog(b.u(46, 10))
        rec["lat"], rec["lon"] = _latlon(b, 57)
        rec["cog"] = _cog(b.u(112, 12))
        rec["hdg"] = _hdg(b.u(124, 9))
        rec["name"] = b.text(143, 120)
        rec["shiptype"] = ship_type(b.u(263, 8))
    elif t == 21:
        rec["aton"] = ATON_TYPES.get(b.u(38, 5), "")
        rec["name"] = b.text(43, 120)
        rec["lat"], rec["lon"] = _latlon(b, 164)
        off = b.u(259, 1)
        virt = b.u(269, 1)
        if len(b) > 272:
            rec["name"] = (rec["name"] + b.text(272, len(b) - 272)).strip()
        rec["shiptype"] = rec["aton"]
        rec["text"] = " · ".join(p for p in ("virtual" if virt else "", "off position" if off else "") if p)
    elif t == 24:
        part = b.u(38, 2)
        if part == 0:
            rec["name"] = b.text(40, 120)
            rec["part"] = "A"
        else:
            rec["part"] = "B"
            rec["shiptype"] = ship_type(b.u(40, 8))
            rec["callsign"] = b.text(90, 42)
            a, bb, c, d = b.u(132, 9), b.u(141, 9), b.u(150, 6), b.u(156, 6)
            rec["size"] = f"{a + bb} × {c + d} m" if a + bb and c + d else ""
            rec["vendor"] = b.text(48, 18)
            rec["text"] = " · ".join(p for p in (rec["size"], f"vendor {rec['vendor']}" if rec["vendor"] else "") if p)
    elif t == 27:
        rec["status"] = NAV_STATUS.get(b.u(40, 4), "")
        rec["lat"], rec["lon"] = _latlon(b, 44, 18, 17, 600.0)
        rec["sog"] = float(b.u(79, 6)) if b.u(79, 6) != 63 else None
        rec["cog"] = float(b.u(85, 9)) if b.u(85, 9) != 511 else None
    return rec


def _sog(v):
    return None if v == 1023 else round(v / 10, 1)


def _cog(v):
    return None if v == 3600 else round(v / 10, 1)


def _hdg(v):
    return None if v == 511 else v


# ---------------------------------------------------------------- decoder

class AisDecoder:
    def __init__(self, on_event, on_state):
        self.on_event = on_event      # on_event("ais", record)
        self.on_state = on_state
        self.enabled = False
        self.error = None
        self.count = 0                # messages in the list
        self.bad = 0                  # frames with a plausible AIS header but a wrong CRC
        self.dropped = 0
        self.channels = []            # Hz decoded now
        self.ships = {}               # mmsi -> the newest data of each station
        self.history = collections.deque(maxlen=MAX_HISTORY)
        self.next_id = 1
        self.lock = threading.RLock()
        self.key = None               # (fs, centre) of the running channels
        self.pending = None           # (key, since): a new centre / rate waiting for the VFO to settle
        self.chans = {}               # Hz -> _Channel
        self.q = queue.Queue(maxsize=16)
        self._last_state = 0.0
        threading.Thread(target=self._worker, name="ais-dsp", daemon=True).start()

    # ---------- control ----------

    def set_enabled(self, on):
        with self.lock:
            self.enabled = bool(on)
            self.pending = None
            if not self.enabled:
                self.key = None
                self.chans = {}
                self.error = None
                self.channels = []
        self._emit_state(force=True)

    def info(self):
        with self.lock:
            ships = sorted(self.ships.values(), key=lambda s: -s["last"])
        return {"enabled": self.enabled, "error": self.error, "count": self.count, "bad": self.bad, "dropped": self.dropped,
                "running": bool(self.chans), "channels": self.channels, "center_hz": self.key[1] if self.key else None,
                "levels": {CHANNELS[f]: round(c.level, 1) for f, c in self.chans.items()}, "ships": len(ships)}

    def messages(self):
        with self.lock:
            return list(self.history)

    def ship_list(self):
        with self.lock:
            return sorted(self.ships.values(), key=lambda s: -s["last"])

    def clear(self):
        with self.lock:
            self.history.clear()
            self.ships = {}
            self.count = self.bad = 0
        self._emit_state(force=True)

    # ---------- samples from the receiver thread ----------

    def feed_raw(self, raw, fs, center_hz):
        """raw: uint8 I/Q from an RTL dongle or complex64 from LimeSDR / Airspy; fs and centre of the SDR."""
        if not self.enabled:
            return
        key = (int(fs), int(round(center_hz)))
        if key != self.key:
            now = time.monotonic()
            if not self.pending or self.pending[0] != key:
                self.pending = (key, now)      # the VFO is moving: wait until it stays put
                self.chans = {}
                return
            if now - self.pending[1] < SETTLE_S:
                return
            with self.lock:
                if not self.enabled:
                    return
                self.pending = None
                self._setup(*key)
        if not self.chans:
            return
        try:
            self.q.put_nowait(raw.copy())
        except queue.Full:
            self.dropped += 1

    def _setup(self, fs, center):
        self.key = (fs, center)
        self.channels = channels_in(fs, center)
        if not self.channels:
            self.chans = {}
            self.error = (f"no AIS channel within ±{(fs / 2 - EDGE_HZ) / 1e3:.0f} kHz of {center / 1e6:.3f} MHz: "
                          f"centre the VFO on 162.000 MHz (both channels) or tune to 161.975 / 162.025 MHz")
        else:
            self.error = None
            self.chans = {f: _Channel(fs, f - center) for f in self.channels}
        self._emit_state(force=True)

    def _worker(self):
        while True:
            raw = self.q.get()
            chans = self.chans
            if not chans:
                continue
            try:
                if raw.dtype == np.uint8:
                    iq = (raw.astype(np.float32) - 127.5) * (1 / 127.5)
                else:
                    iq = raw.view(np.float32)
                for f, ch in chans.items():
                    for frame in ch.process(iq):
                        self._handle(frame, f)
                self.bad = sum(c.hdlc.bad for c in chans.values())
            except Exception as e:          # one odd block must not stop the decoder
                self.error = f"AIS: {e}"
            self._emit_state()

    # ---------- messages ----------

    def _handle(self, frame, freq_hz):
        rec = decode(frame)
        if rec is None:
            return
        now = time.time()
        ch = CHANNELS[freq_hz]
        payload, fill = armor(frame)
        rec.update(time=round(now, 1), freq_hz=freq_hz, channel=ch, nmea=nmea(payload, fill, ch),
                   level=round(self.chans[freq_hz].level, 1) if freq_hz in self.chans else None)
        with self.lock:
            self.count += 1
            rec["id"] = self.next_id
            self.next_id += 1
            self.history.append(rec)
            ship = self._ship(rec, now)
        self.on_event("ais", dict(rec, ship=ship))

    def _ship(self, rec, now):
        """The newest data of the station: static data (name, type, call sign) kept from earlier messages."""
        s = self.ships.get(rec["mmsi"])
        if s is None:
            if len(self.ships) >= MAX_SHIPS:
                oldest = min(self.ships, key=lambda k: self.ships[k]["last"])
                del self.ships[oldest]
            s = {"mmsi": rec["mmsi"], "cc": rec["cc"], "country": rec["country"], "station": rec["station"], "name": "",
                 "callsign": "", "shiptype": "", "dest": "", "imo": None, "size": "", "draught": None, "eta": "", "status": "",
                 "lat": None, "lon": None, "sog": None, "cog": None, "hdg": None, "pos_time": None, "first": now, "last": now,
                 "n": 0, "channel": rec["channel"], "type": rec["type"]}
            self.ships[rec["mmsi"]] = s
        s["n"] += 1
        s["last"] = now
        s["channel"] = rec["channel"]
        s["type"] = rec["type"]
        for k in ("name", "callsign", "shiptype", "dest", "imo", "size", "draught", "eta", "status"):
            if rec.get(k):
                s[k] = rec[k]
        if rec["type"] == 9:
            s["station"] = "SAR aircraft"
        elif rec["type"] == 4:
            s["station"] = "base station"
        elif rec["type"] == 21:
            s["station"] = "aid to navigation"
        if rec["lat"] is not None:
            s["lat"], s["lon"], s["pos_time"] = rec["lat"], rec["lon"], now
            for k in ("sog", "cog", "hdg"):
                s[k] = rec[k]
        return dict(s)

    def _emit_state(self, force=False):
        now = time.time()
        if force or now - self._last_state > 1.0:
            self._last_state = now
            self.on_state(self.info())


def utc(t):
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%H:%M:%S")
