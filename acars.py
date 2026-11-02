"""ACARS decoder (VHF airband, AM, MSK 2400 bit/s, tones 1200/2400 Hz) from the receiver's baseband.

Method: AM demodulation (envelope) independent of the receiver mode -> coherent MSK demodulation:
mixing the audio with an 1800 Hz carrier (NCO tracked by a phase-locked loop), matched filter (half-wave
600 Hz over 2 bits) and decision alternately from the real and imaginary part (MSK = OQPSK). The bit
clock is tied to the carrier phase (2400 = 4/3 · 1800). Two framers try both bit polarities at once.

Frame (ARINC 618): ... '+' '*' SYN SYN SOH mode address(7) ACK label(2) block STX text ETX/ETB BCS(2) DEL.
Characters: 7-bit ASCII + odd parity, lowest bit first. BCS = CRC-16 (CCITT, reflected) from mode to ETX.
"""
import cmath
import collections
import json
import math
import os
import queue
import threading
import time
import urllib.parse
import urllib.request

import numpy as np

from paths import data
from sdr import lowpass

BAUD = 2400.0
CENTER = 1800.0              # centre between the tones 1200 and 2400 Hz
RATE_MAX = 32000.0           # working sample rate after decimation
PLL_G = 38e-4                # gain of the carrier phase-locked loop
PLL_C = 0.52                 # smoothing of the frequency correction
ACARS_FREQS = (131525000, 131725000, 131825000, 136900000)

# Aircraft type and position by registration from public ADS-B networks (adsb.fi also has the type description).
LOOKUP_URLS = ("https://opendata.adsb.fi/api/v2/registration/{}", "https://api.adsb.lol/v2/reg/{}")
LOOKUP_CACHE_S = 60          # the position changes: the same registration again after a minute at the earliest
LOOKUP_GAP_S = 1.1           # adsb.fi allows 1 request per second
LOG_DIR = data("acars")   # daily log acars_YYYY-MM-DD.txt (UTC)

SYNC = 0x011616             # SYN SYN SOH (with parity), received left to right = lower byte first
SOH, STX, ETX, ETB, DEL = 0x01, 0x82, 0x83, 0x97, 0x7F   # with odd parity
MAX_LEN = 250
MAX_PARITY_ERR = 3


def crc16(data):
    """CRC-16 CCITT reflected (polynomial 0x8408, start 0); including the BCS the result is 0."""
    crc = 0
    for b in data:
        crc ^= b
        for _ in range(8):
            crc = (crc >> 1) ^ 0x8408 if crc & 1 else crc >> 1
    return crc


def odd_parity_ok(b):
    return bin(b).count("1") % 2 == 1


class _Framer:
    """Searches for synchronisation and assembles characters from one bit stream."""

    def __init__(self, on_frame):
        self.on_frame = on_frame
        self.reset()

    def reset(self):
        self.win = 0
        self.inframe = False
        self.byte = 0
        self.nbits = 0
        self.data = []
        self.perr = 0
        self.tail = -1           # how many BCS bytes we still wait for after ETX/ETB

    def bit(self, b):
        if not self.inframe:
            self.win = ((self.win >> 1) | (b << 23)) & 0xFFFFFF
            if self.win == SYNC:
                self.inframe, self.byte, self.nbits, self.data, self.perr, self.tail = True, 0, 0, [SOH], 0, -1
            return
        self.byte = (self.byte >> 1) | (b << 7)
        self.nbits += 1
        if self.nbits < 8:
            return
        c, self.byte, self.nbits = self.byte, 0, 0
        if self.tail < 0 and not odd_parity_ok(c):     # BCS (CRC) has no parity
            self.perr += 1
            if self.perr > MAX_PARITY_ERR:
                self.reset()
                return
        self.data.append(c)
        if self.tail > 0:
            self.tail -= 1
            if self.tail == 0:
                self.on_frame(bytes(self.data), self.perr)
                self.reset()
            return
        if len(self.data) > 12 and c in (ETX, ETB):
            self.tail = 2
        elif len(self.data) > MAX_LEN:
            self.reset()


# Meaning of common ACARS labels. Many labels are defined by each airline itself;
# those get a generic description.
LABELS = {
    "_\x7f": "General response / acknowledgement (no data)",
    "Q0": "Data link test",
    "SA": "Data link status (VHF / SATCOM / HF up or down)",
    "5Z": "Airline operations message",
    "B6": "ADS-C position report (air traffic control)",
    "A6": "ADS-C request from air traffic control",
    "AA": "Air traffic control message (CPDLC)",
    "BA": "Air traffic control message (CPDLC)",
    "QA": "Flight event report (gate out / takeoff / landing / gate in)",
    "QB": "Flight event report (gate out / takeoff / landing / gate in)",
    "QC": "Flight event report (gate out / takeoff / landing / gate in)",
    "QD": "Flight event report (gate out / takeoff / landing / gate in)",
    "QE": "Flight event report (gate out / takeoff / landing / gate in)",
    "QF": "Flight event report (gate out / takeoff / landing / gate in)",
}
# H1 = message from/to an onboard system; which one is told by the start of the text
H1_PREFIX = {
    "#CFB": "Maintenance computer report (system status / faults)",
    "#DFB": "Flight data report (engine and performance data)",
    "#M1B": "Flight management computer message",
    "#M2B": "Flight management computer message",
    "#M3B": "Flight management computer message",
}
# by the text content (if the label says nothing)
TEXT_HINTS = (("POS", "Position report"), ("METAR", "Weather (METAR)"), ("TAF", "Weather forecast (TAF)"),
              ("LOADSHEET", "Load sheet"), ("ETA", "Estimated arrival time"), ("FUEL", "Fuel report"))


def describe(label, text):
    """Message description in plain language (approximate: the meaning of some labels depends on the airline)."""
    if label in LABELS:
        return LABELS[label]
    t = text.lstrip()
    if label == "H1":
        for p, d in H1_PREFIX.items():
            if t.startswith(p):
                return d
        return "Message from / to an onboard system"
    for key, d in TEXT_HINTS:
        if t.startswith(key) or f"/{key}" in t[:40]:
            return d
    if not t:
        return "Message without text (label only)"
    return f"Airline-specific message (label {label})"


def parse(frame, perr):
    """frame: SOH ... ETX/ETB BCS BCS (with parity). Returns the message dictionary."""
    body = frame[1:]                                  # from mode to BCS
    crc_ok = crc16(body) == 0
    chars = [b & 0x7F for b in body[:-2]]
    end = chars[-1]
    txt = "".join(chr(c) for c in chars[:-1])
    mode, addr, ack, label, blk = txt[0:1], txt[1:8], txt[8:9], txt[9:11], txt[11:12]
    text = txt[13:] if len(txt) > 12 and chars[12] == 0x02 else ""
    flight = msgno = ""
    if blk.isdigit() and len(text) >= 10:             # downlink (from the aircraft): message number + flight
        msgno, flight, text = text[:4], text[4:10].strip(), text[10:]
    clean = lambda s: "".join(ch if 32 <= ord(ch) < 127 else ("\n" if ch in "\r\n" else "·") for ch in s)
    return {
        "desc": describe(label, text),
        "mode": clean(mode), "reg": clean(addr).lstrip("."), "ack": "NAK" if ack == "\x15" else clean(ack),
        "label": clean(label), "block": clean(blk), "msgno": clean(msgno), "flight": clean(flight),
        "text": clean(text).replace("\n\n", "\n").strip(), "more": end == 0x17,
        "crc_ok": crc_ok, "parity_errors": perr,
        "dir": "down" if blk.isdigit() else "up",
    }


class AcarsDecoder:
    def __init__(self, on_event, tag="", log_dir=LOG_DIR):
        self.on_event = on_event
        self.tag = tag            # VFO name in the log (the log is shared by all VFOs)
        self.log_dir = log_dir
        self.log_on = False       # daily log only after LOG is turned on in the ACARS card
        self.enabled = False
        self.lock = threading.Lock()
        self.msgs = collections.deque(maxlen=300)
        self.dial = 0.0
        self.count = 0
        self.crc_errors = 0
        self.level = 0.0
        self._fs = None
        self._recent = collections.deque(maxlen=16)   # (time, bytes) against duplicates from the two streams
        self._next_id = 1
        self._cache = {}                              # registration -> (time, ADS-B data or None)
        self._lookups = queue.Queue(maxsize=50)
        threading.Thread(target=self._lookup_worker, name="acars-adsb", daemon=True).start()

    # ---------- control ----------

    def set_enabled(self, on):
        with self.lock:
            self.enabled = bool(on)
            self._fs = None
        self._emit_state()

    def clear(self):
        with self.lock:
            self.msgs.clear()
            self.count = self.crc_errors = 0

    def info(self):
        return {"enabled": self.enabled, "count": self.count, "crc_errors": self.crc_errors,
                "level_db": round(self.level, 1), "messages": list(self.msgs)}

    # ---------- signal processing ----------

    def _setup(self, fs):
        self._fs = fs
        self.D = max(1, int(fs // RATE_MAX))
        self.r = fs / self.D
        self.h_am = lowpass(4000.0, fs, 127).astype(np.complex64)    # AM channel ±4 kHz
        self.hist_am = np.zeros(len(self.h_am) - 1, np.complex64)
        self.dec_off = 0
        self.dc = 0.0
        # MSK: matched filter = half-wave 600 Hz over 2 bits
        self.flen = int(round(self.r / 1200.0))
        k = np.arange(self.flen) - (self.flen - 1) / 2
        self.h_msk = np.cos(2 * np.pi * 600.0 / self.r * k).astype(np.complex128)
        self.mbuf = np.zeros(self.flen, np.complex128)
        self.midx = 0
        self.step = 2 * np.pi * CENTER / self.r
        self.phi = 0.0            # carrier NCO phase
        self.clk = 0.0            # bit clock in carrier phase (a bit every 3π/2)
        self.df = 0.0             # frequency correction from the phase-locked loop (rad/sample)
        self.ms = 0               # bit order: alternating I/Q and sign
        self.framers = [_Framer(self._frame) for _ in range(2)]
        self.since_state = 0

    def feed(self, base, fs, dial_hz):
        """base: complex baseband (tuned frequency = 0 Hz) at sample rate fs."""
        if not self.enabled:
            return
        with self.lock:
            if fs != self._fs:
                self._setup(fs)
            self.dial = dial_hz
            buf = np.concatenate((self.hist_am, base))
            self.hist_am = buf[-(len(self.h_am) - 1):]
            z = np.convolve(buf, self.h_am, mode="valid")[self.dec_off::self.D]
            self.dec_off = (self.dec_off - len(base)) % self.D
            env = np.abs(z)
            p = float(np.mean(env ** 2)) + 1e-20
            self.level = 10 * np.log10(p)
            # AM: removing the carrier (DC component of the envelope)
            self.dc = float(env.mean()) if self.dc == 0.0 else 0.9 * self.dc + 0.1 * float(env.mean())
            audio = (env - self.dc) / (self.dc + 1e-9)
            self._demod(audio.astype(np.float32))
            self.since_state += len(audio)
        if self.since_state >= self.r:
            self.since_state = 0
            self._emit_state()

    def _demod(self, audio):
        """Coherent MSK demodulation sample by sample (the phase-locked loop adjusts the NCO continuously)."""
        flen, h, buf = self.flen, self.h_msk, self.mbuf
        phi, clk, df, idx, ms = self.phi, self.clk, self.df, self.midx, self.ms
        two_pi, bit_ph = 2 * math.pi, 1.5 * math.pi
        for x in audio.tolist():
            s = self.step + df
            phi += s
            if phi >= two_pi:
                phi -= two_pi
            buf[idx] = x * cmath.exp(-1j * phi)
            idx = idx + 1 if idx + 1 < flen else 0
            clk += s
            if clk < bit_ph:
                continue
            clk -= bit_ph
            v = complex(np.dot(np.roll(buf, -idx), h))       # matched filter over the last 2 bits
            lvl = abs(v) + 1e-12
            vr, vi = v.real / lvl, v.imag / lvl
            if ms & 1:
                vo = vi
                dphi = -vr if vo >= 0 else vr
            else:
                vo = vr
                dphi = vi if vo >= 0 else -vi
            if ms & 2:
                vo = -vo
            ms += 1
            df = PLL_C * df + (1 - PLL_C) * PLL_G * dphi
            b = 1 if vo > 0 else 0
            self.framers[0].bit(b)
            self.framers[1].bit(1 - b)
        self.phi, self.clk, self.df, self.midx, self.ms = phi, clk, df, idx, ms

    def _frame(self, frame, perr):
        now = time.time()
        if any(now - t < 3 and frame == f for t, f in self._recent):
            return
        self._recent.append((now, frame))
        try:
            m = parse(frame, perr)
        except Exception:
            return
        if not m["crc_ok"]:
            self.crc_errors += 1
            if perr:              # bad CRC and parity: noise, not shown
                return
        m["time"] = time.strftime("%H:%M:%S", time.gmtime(now))
        m["freq_hz"] = round(self.dial)
        m["id"] = self._next_id
        self._next_id += 1
        m["ac"] = None
        self.count += 1
        self.msgs.append(m)
        self.on_event("acars", m)
        m["date"] = time.strftime("%Y-%m-%d", time.gmtime(now))
        if len(m["reg"]) >= 3 and self.crc_ok_reg(m):
            try:
                self._lookups.put_nowait(m)      # goes to the log only with the ADS-B data
                return
            except queue.Full:
                pass
        self._log(m)

    def _log(self, m):
        """Line to the daily log (UTC); multi-line text indented. ADS-B data in [ADS-B: ...]."""
        if not self.log_on:
            return
        head = [f"{m['date']} {m['time']}Z", f"{m['freq_hz'] / 1e6:.3f}", f"VFO-{self.tag}" if self.tag else "",
                m["reg"] or "-", m["flight"] or "-", f"label {m['label']}", m["dir"],
                "" if m["crc_ok"] else "CRC-ERROR"]
        line = " ".join(h for h in head if h) + f" | {m['desc']}"
        ac = m.get("ac")
        if ac and ac.get("found"):
            pos = f"{ac['lat']:.3f},{ac['lon']:.3f}" if ac.get("lat") is not None else ""
            alt = "ground" if ac.get("ground") else (f"{ac['alt_ft']} ft" if ac.get("alt_ft") is not None else "")
            ext = ", ".join(x for x in (ac.get("type"), ac.get("desc"), ac.get("callsign"), ac.get("hex"), pos, alt) if x)
            line += f" | [ADS-B {ac.get('src', '')}: {ext}]"
        if m["text"]:
            line += "\n    " + m["text"].replace("\n", "\n    ")
        try:
            os.makedirs(self.log_dir, exist_ok=True)
            with open(os.path.join(self.log_dir, f"acars_{m['date']}.txt"), "a", encoding="utf-8") as f:
                f.write(line + "\n")
        except OSError:
            pass

    @staticmethod
    def crc_ok_reg(m):
        return m["crc_ok"] and m["reg"].replace("-", "").isalnum()

    # ---------- aircraft type and position from ADS-B (adsb.fi, adsb.lol) ----------

    def _lookup_worker(self):
        last = 0.0
        while True:
            m = self._lookups.get()
            reg = m["reg"]
            hit = self._cache.get(reg)
            if hit and time.time() - hit[0] < LOOKUP_CACHE_S:
                info = hit[1]
            else:
                time.sleep(max(0.0, last + LOOKUP_GAP_S - time.time()))
                last = time.time()
                info = self._fetch(reg)
                self._cache[reg] = (time.time(), info)
                if len(self._cache) > 500:
                    self._cache.clear()
            m["ac"] = info or {"found": False}
            self.on_event("acarsinfo", {"id": m["id"], "ac": m["ac"]})
            self._log(m)

    @staticmethod
    def _fetch(reg):
        """Returns data about the aircraft currently seen by the ADS-B network, or None."""
        for url in LOOKUP_URLS:
            try:
                req = urllib.request.Request(url.format(urllib.parse.quote(reg)), headers={"User-Agent": "RADIMCOM"})
                with urllib.request.urlopen(req, timeout=6) as r:
                    ac = json.load(r).get("ac") or []
            except Exception:
                continue
            if not ac:
                continue
            a = ac[0]
            alt = a.get("alt_baro")
            return {
                "found": True, "hex": a.get("hex", ""), "type": a.get("t", ""), "desc": a.get("desc", ""),
                "callsign": (a.get("flight") or "").strip(), "lat": a.get("lat"), "lon": a.get("lon"),
                "alt_ft": alt if isinstance(alt, (int, float)) else None, "ground": alt == "ground",
                "gs_kt": a.get("gs"), "src": "adsb.fi" if "adsb.fi" in url else "adsb.lol",
            }
        return None

    def _emit_state(self):
        i = self.info()
        del i["messages"]
        self.on_event("acarsstate", i)
