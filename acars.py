"""ACARS decoder (VHF airband, AM, MSK 2400 bit/s, tones 1200/2400 Hz) from the receiver's baseband.

Method: AM demodulation (envelope) independent of the receiver mode -> coherent MSK demodulation:
mixing the audio with an 1800 Hz carrier (NCO tracked by a phase-locked loop), matched filter (half-wave
600 Hz over 2 bits) and decision alternately from the real and imaginary part (MSK = OQPSK). The bit
clock is tied to the carrier phase (2400 = 4/3 · 1800). Two framers try both bit polarities at once.

Frame (ARINC 618): ... '+' '*' SYN SYN SOH mode address(7) ACK label(2) block STX text ETX/ETB BCS(2) DEL.
Characters: 7-bit ASCII + odd parity, lowest bit first. BCS = CRC-16 (CCITT, reflected) from mode to ETX.

CPDLC (FANS-1/A, ARINC 622) messages inside ACARS are decoded by cpdlc.py; the CPDLC card can run alone
(this demodulator then runs even when the ACARS card is off).
"""
import cmath
import collections
import json
import math
import os
import queue
import re
import threading
import time
import urllib.parse
import urllib.request

import numpy as np

import cpdlc
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
# ATN messages (VDL2) carry only the 24-bit ICAO address of the aircraft, no registration
LOOKUP_HEX_URLS = ("https://opendata.adsb.fi/api/v2/hex/{}", "https://api.adsb.lol/v2/hex/{}")
LOOKUP_CACHE_S = 60          # the position changes: the same registration again after a minute at the earliest
LOOKUP_GAP_S = 1.1           # adsb.fi allows 1 request per second
LOG_DIR = data("acars")   # daily logs acars_YYYY-MM-DD.txt and vdl2_YYYY-MM-DD.txt (UTC)

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
        self._log_lock = threading.Lock()   # receiver and ADS-B threads: an append on Windows is not atomic
        self.enabled = False      # ACARS card with the classic ACARS demodulator (131.x MHz)
        self.vdl2_on = False      # messages come from VDL2 (vdl2.py) instead: the demodulator rests
        self.cpdlc_on = False     # CPDLC card (uses the same demodulator)
        self.cpdlc_msgs = collections.deque(maxlen=300)
        self.cpdlc_count = 0
        self._reasm = cpdlc.Reassembler()
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
        # positions from VDL2 XID frames for the MAP of the card: aircraft (by ICAO address) and ground stations
        self.positions = collections.deque(maxlen=3000)
        self._last_pos = {}                           # ICAO address -> (lat, lon) of its last stored position
        self.gs_pos = {}                              # ground station address -> position record
        threading.Thread(target=self._lookup_worker, name="acars-adsb", daemon=True).start()

    # ---------- control ----------

    def set_enabled(self, on):
        with self.lock:
            if not (self.enabled or self.cpdlc_on):
                self._fs = None   # the demodulator starts again from scratch
            self.enabled = bool(on)
        self._emit_state()

    @property
    def shown(self):
        """The ACARS card is shown and collects messages (from either link)."""
        return self.enabled or self.vdl2_on

    def set_vdl2(self, on):
        with self.lock:
            self.vdl2_on = bool(on)
            self._fs = None
        self._emit_state()

    def set_cpdlc(self, on):
        with self.lock:
            if not (self.enabled or self.cpdlc_on):
                self._fs = None
            self.cpdlc_on = bool(on)
        self._emit_cpdlc_state()

    def clear_cpdlc(self):
        with self.lock:
            self.cpdlc_msgs.clear()
            self.cpdlc_count = 0

    def cpdlc_info(self):
        return {"enabled": self.cpdlc_on, "count": self.cpdlc_count, "messages": list(self.cpdlc_msgs)}

    def clear(self):
        with self.lock:
            self.msgs.clear()
            self.count = self.crc_errors = 0
            self.positions.clear()
            self._last_pos.clear()
            self.gs_pos.clear()

    def info(self):
        return {"enabled": self.enabled, "vdl2": self.vdl2_on, "count": self.count, "crc_errors": self.crc_errors,
                "level_db": round(self.level, 1), "messages": list(self.msgs),
                "positions": list(self.positions), "gs_pos": list(self.gs_pos.values())}

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
        if not (self.enabled or self.cpdlc_on) or self.vdl2_on:
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
            if self.enabled:
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
            if self.enabled:
                self.crc_errors += 1
            if perr:              # bad CRC and parity: noise, not shown
                return
        m["freq_hz"] = round(self.dial)
        m["link"] = "ACARS"
        self._accept(m, now)

    # ---------- messages from VDL2 (vdl2.py, dumpvdl2 in its own threads) ----------

    def accept_vdl2(self, m):
        """ACARS message received over VDL2 (dict like parse(), with freq_hz and link "VDL2")."""
        if not self.vdl2_on:
            return
        with self.lock:
            if not m["crc_ok"]:
                self.crc_errors += 1
            m["freq_hz"] = m["vdl2"]["freq_hz"]
            self._accept(m, time.time())
        self._emit_state()

    def accept_pos(self, p):
        """Position from a VDL2 XID frame (vdl2.py): kind "ac" = aircraft (addr = ICAO address), "gs" = ground station.
        An aircraft repeating the same position is stored once; a ground station keeps only its newest record."""
        if not self.vdl2_on:
            return
        now = time.time()
        p["t"] = round(now, 1)
        p["time"] = time.strftime("%H:%M:%S", time.gmtime(now))
        with self.lock:
            if p["kind"] == "gs":
                old = self.gs_pos.get(p["addr"])
                self.gs_pos[p["addr"]] = p
                if old and (old["lat"], old["lon"]) == (p["lat"], p["lon"]) and now - old["t"] < 60:
                    return                               # the browser already has it
            else:
                if not re.fullmatch(r"[0-9A-Fa-f]{6}", p["addr"] or ""):
                    return
                p["addr"] = p["addr"].upper()
                if self._last_pos.get(p["addr"]) == (p["lat"], p["lon"]):
                    return
                self._last_pos[p["addr"]] = (p["lat"], p["lon"])
                if len(self._last_pos) > 5000:
                    self._last_pos.clear()
                self.positions.append(p)
        self.on_event("acarspos", p)

    def accept_atn(self, r):
        """ATN application message over VDL2 (CPDLC card record from vdl2.py)."""
        if not (self.vdl2_on and self.cpdlc_on):
            return
        now = time.time()
        by_hex = re.fullmatch(r"[0-9A-Fa-f]{6}", r["air"] or "")
        with self.lock:
            r.update(id=self._next_id, time=time.strftime("%H:%M:%S", time.gmtime(now)),
                     date=time.strftime("%Y-%m-%d", time.gmtime(now)), freq_hz=r["vdl2"]["freq_hz"],
                     reg=r["air"], flight="", label="", ac=None, atn=True,
                     lookup=bool(by_hex) and not self._lookups.full())    # the browser shows the row after the "acarsinfo"
            self._next_id += 1
            self.cpdlc_count += 1
            self.cpdlc_msgs.append(r)
        self.on_event("cpdlc", r)
        self._emit_cpdlc_state()
        # registration, type and position by the ICAO address; the log line waits for them
        if by_hex:
            try:
                self._lookups.put_nowait(r)
                return
            except queue.Full:
                pass
        self._log_atn(r)

    def _accept(self, m, now):
        """Common path of a received ACARS message (both links): CPDLC, card, ADS-B lookup, log."""
        m["time"] = time.strftime("%H:%M:%S", time.gmtime(now))
        m["date"] = time.strftime("%Y-%m-%d", time.gmtime(now))
        m["id"] = self._next_id
        self._next_id += 1
        m["ac"] = None
        m["cpdlc"] = None
        by_reg = len(m["reg"]) >= 3 and self.crc_ok_reg(m)
        m["lookup"] = by_reg and not self._lookups.full()    # the browser shows the row after the "acarsinfo"
        c = self._cpdlc(m) if m["crc_ok"] else None
        if self.shown:
            self.count += 1
            self.msgs.append(m)
            self.on_event("acars", m)
        if c and self.cpdlc_on:
            self.cpdlc_count += 1
            self.cpdlc_msgs.append(c)
            self.on_event("cpdlc", c)
            self._emit_cpdlc_state()
        if not self.shown and not (c and self.cpdlc_on):
            return
        if by_reg:
            try:
                self._lookups.put_nowait(m)      # goes to the log only with the ADS-B data
                return
            except queue.Full:
                pass
        self._log(m)

    def _cpdlc(self, m):
        """CPDLC inside the ACARS message (long ones joined from several blocks) -> CPDLC record or None."""
        if m["label"] not in cpdlc.LABELS:
            return None
        if m["link"] == "VDL2":
            # dumpvdl2 (libacars) joins the blocks itself: the last block carries the whole text
            if m["more"]:
                return None
            full = m["text"]
        else:
            full = self._reasm.push(m)
        if full is None:
            return None
        try:
            r = cpdlc.decode(m["label"], full, m["dir"] == "up")
        except Exception:
            return None
        if not r:
            return None
        m["cpdlc"] = {k: r[k] for k in ("text", "crc_ok", "imi", "imi_desc", "gs", "min", "mrn", "ts", "elements", "error")}
        r.update(id=m["id"], time=m["time"], date=m["date"], freq_hz=m["freq_hz"], reg=m["reg"] or r["air"],
                 flight=m["flight"], label=m["label"], ac=None, raw=full, link=m["link"])
        return r

    def _log(self, m):
        """Line to the daily log of the decoder it came from (UTC); multi-line text indented.
        ADS-B data in [ADS-B: ...]; decoded CPDLC / ADS-C (FANS) after the raw text."""
        if not (self.log_on and self.shown):
            return
        head = [f"{m['date']} {m['time']}Z", f"{m['freq_hz'] / 1e6:.3f}", f"VFO-{self.tag}" if self.tag else "",
                m["reg"] or "-", m["flight"] or "-", f"label {m['label']}", m["dir"],
                "" if m["crc_ok"] else "CRC-ERROR"]
        gs = (m.get("vdl2") or {}).get("gs")
        line = " ".join(h for h in head if h) + f" | {m['desc']} | {self._gs_loc(m)}" + (f" ({gs})" if gs else "")
        line += self._adsb_ext(m.get("ac"))
        if m["text"]:
            line += "\n    " + m["text"].replace("\n", "\n    ")
        c = m.get("cpdlc")
        if c:
            line += "\n    decoded: " + " ".join(self._cpdlc_head(c, c["imi"]))
            line += "\n    " + (c["text"] or c["error"]).replace("\n", "\n    ")
        self._write_log(m, line)

    def _log_atn(self, r):
        """ATN message (VDL2, not inside ACARS) to the VDL2 daily log."""
        if not self.log_on:
            return
        head = [f"{r['date']} {r['time']}Z", f"{r['freq_hz'] / 1e6:.3f}", f"VFO-{self.tag}" if self.tag else "",
                r["reg"] or "-", "uplink" if r["dir"] == "up" else "downlink"] + self._cpdlc_head(r, r["imi_desc"])
        line = " ".join(h for h in head if h) + f" | {self._gs_loc(r)}"
        line += self._adsb_ext(r.get("ac"), with_reg=True)      # the head has only the ICAO address
        line += "\n    " + (r["text"] or r["error"]).replace("\n", "\n    ")
        self._write_log(r, line)

    @staticmethod
    def _gs_loc(m):
        """Ground Station column: airport of the VDL2 ground station ("BTS/LZIB"), "-" if not known (also classic ACARS)."""
        return (m.get("vdl2") or {}).get("gs_loc") or "-"

    @staticmethod
    def _adsb_ext(ac, with_reg=False):
        """ADS-B part of a log line, in the order of the table columns; position last. Empty if not found."""
        if not (ac and ac.get("found")):
            return ""
        alt = ac.get("alt_ft")
        level = "GND" if ac.get("ground") else f"FL{round(alt / 100):03d} ({alt} ft)" if alt is not None else ""
        gs = ac.get("gs_kt")
        fields = (ac.get("reg") if with_reg else "", ac.get("callsign"), ac.get("hex"),
                  f"squawk {ac['squawk']}" if ac.get("squawk") else "", ac.get("type"), ac.get("desc"), level,
                  f"{round(gs)} kt" if gs is not None and not ac.get("ground") else "",
                  f"{ac['lat']:.3f},{ac['lon']:.3f}" if ac.get("lat") is not None and ac.get("lon") is not None else "")
        return f" | [ADS-B {ac.get('src', '')}: " + ", ".join(x for x in fields if x) + "]"

    @staticmethod
    def _cpdlc_head(c, kind):
        head = [f"ground {c['gs']}", kind, f"MIN {c['min']}" if c["min"] is not None else "",
                f"MRN {c['mrn']}" if c["mrn"] is not None else "", c["ts"], "" if c["crc_ok"] else "CRC-ERROR"]
        return [h for h in head if h]

    def _write_log(self, m, line):
        """Classic ACARS decoder -> acars_YYYY-MM-DD.txt, VDL2 decoder -> vdl2_YYYY-MM-DD.txt."""
        name = "vdl2" if m.get("link") == "VDL2" else "acars"
        try:
            os.makedirs(self.log_dir, exist_ok=True)
            with self._log_lock, open(os.path.join(self.log_dir, f"{name}_{m['date']}.txt"), "a", encoding="utf-8") as f:
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
            atn = bool(m.get("atn"))                 # ATN record: look up by ICAO address
            key = ("hex:" if atn else "") + m["reg"]
            hit = self._cache.get(key)
            if hit and time.time() - hit[0] < LOOKUP_CACHE_S:
                info = hit[1]
            else:
                time.sleep(max(0.0, last + LOOKUP_GAP_S - time.time()))
                last = time.time()
                info = self._fetch(m["reg"].lower() if atn else m["reg"], LOOKUP_HEX_URLS if atn else LOOKUP_URLS)
                self._cache[key] = (time.time(), info)
                if len(self._cache) > 500:
                    self._cache.clear()
            m["ac"] = info or {"found": False}
            for c in list(self.cpdlc_msgs):
                if c["id"] == m["id"]:
                    c["ac"] = m["ac"]
            self.on_event("acarsinfo", {"id": m["id"], "ac": m["ac"]})
            if atn:
                self._log_atn(m)
            else:
                self._log(m)

    @staticmethod
    def _fetch(key, urls=LOOKUP_URLS):
        """Returns data about the aircraft currently seen by the ADS-B network, or None."""
        for url in urls:
            try:
                req = urllib.request.Request(url.format(urllib.parse.quote(key)), headers={"User-Agent": "RADIMCOM"})
                with urllib.request.urlopen(req, timeout=6) as r:
                    ac = json.load(r).get("ac") or []
            except Exception:
                continue
            if not ac:
                continue
            a = ac[0]
            alt = a.get("alt_baro")
            return {
                "found": True, "hex": a.get("hex", ""), "reg": a.get("r", ""), "type": a.get("t", ""), "desc": a.get("desc", ""),
                "callsign": (a.get("flight") or "").strip(), "lat": a.get("lat"), "lon": a.get("lon"),
                "alt_ft": alt if isinstance(alt, (int, float)) else None, "ground": alt == "ground",
                "gs_kt": a.get("gs"), "track": a.get("track", a.get("true_heading")), "squawk": a.get("squawk", ""), "src": "adsb.fi" if "adsb.fi" in url else "adsb.lol",
            }
        return None

    def _emit_cpdlc_state(self):
        self.on_event("cpdlcstate", {"enabled": self.cpdlc_on, "count": self.cpdlc_count})

    def _emit_state(self):
        i = self.info()
        del i["messages"], i["positions"], i["gs_pos"]
        self.on_event("acarsstate", i)
