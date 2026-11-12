"""Antenna rotor (K3NG Arduino controller, GS-232 commands over USB serial).

The satellite tracking of the SATELLITES tab (satplan.py) and the page (GO, clicks on the dials of the SAT window) give
the targets; this module sends them to K3NG and watches the rotor.

Rotor safety: position readings are noisy, K3NG does not acknowledge commands, so the position is checked here.
A reading that jumps faster than the rotor can move, or a move without progress, stops the rotor and latches a fault
that has to be reset by hand. A lost serial connection also stops it.

The rotor follows the satellite tracking only with rotor control on (CTRL key in the SAT window or on the TRACK page);
until then the position is read and the tracking's moves are ignored. A fault, a lost connection and STOP all turn it
off, and only CTRL turns it on.

Azimuth calibration: K3NG counts 0-450 degrees from its left stop, which need not be north. The true azimuth at
K3NG 0 and at K3NG 450 is set in SETTINGS › GENERAL › ROTOR; everything outside this class (page, tracking, HTTP API) uses true
azimuths, except the K3NG azimuth the tracking may give with a target. K3NG reports its azimuth modulo 360, so the
raw 0-450 value is followed here reading by reading.
"""
import collections
import re
import statistics
import threading
import time

BAUD = 9600
POLL_S = 0.05            # pause between position queries (each query also waits READ_TIMEOUT_S)
READ_TIMEOUT_S = 0.15
NO_REPLY_S = 5.0         # no position for this long: the connection is treated as lost
FILTER_LEN = 5           # median of this many readings removes single spikes
DEADBAND_DEG = 5.0       # sensor noise is 1-5 degrees, so smaller errors do not move the rotor
COMMAND_GAP_S = 1.0      # at most one move command per second
RESEND_S = 30.0          # an unchanged target is sent again: K3NG stops any move after its OPERATION_TIMEOUT (60 s here)
MAX_RATE_DEG_S = 10.0    # faster than the rotor can move (measured about 6 deg/s)
JUMP_DEG = 15.0          # allowed change between two filtered readings, on top of MAX_RATE_DEG_S
STALL_S = 10.0           # a move without STALL_DEG of progress for this long is a fault
STALL_DEG = 3.0
MAX_EL_DEG = 180.0       # above 90 the antenna goes over the top and looks backwards
K3NG_SPAN = 450.0        # K3NG azimuth range from its left stop (rotation capability)
RAW_HINT_DEG = 20.0      # a saved raw azimuth within this of a reading decides between K3NG 0-90 and 360-450
RAW_SLACK_DEG = 8.0      # sensor noise allowed beyond the stops before the raw azimuth is put on the other side

_REPLY_AZ = re.compile(rb"AZ=\s*(-?\d+(?:\.\d+)?)\s")
_REPLY_EL = re.compile(rb"EL=\s*(-?\d+(?:\.\d+)?)\s")



def angle_diff(a, b):
    """Shortest signed difference a - b in degrees, -180 to 180."""
    return (a - b + 180.0) % 360.0 - 180.0


def cal_ok(az0, az450):
    """True azimuths at K3NG 0 and 450 must be numbers that keep the scale near one."""
    return -180.0 <= az0 <= 360.0 and 400.0 <= az450 - az0 <= 500.0


def median_angle(values):
    """Median of azimuths; correct across the 0/360 boundary."""
    ref = values[0]
    return (ref + statistics.median(angle_diff(v, ref) for v in values)) % 360.0


def parse_position(reply):
    """K3NG reply to C2 -> (az or None, el or None). The number must be complete (followed by a line end)."""
    az, el = _REPLY_AZ.search(reply), _REPLY_EL.search(reply)
    return float(az.group(1)) if az else None, float(el.group(1)) if el else None


def list_ports():
    """Serial ports on this PC: [{"device", "usb_serial", "description"}]."""
    from serial.tools import list_ports as lp
    return [{"device": p.device, "usb_serial": p.serial_number or "", "description": p.description or ""}
            for p in sorted(lp.comports(), key=lambda p: p.device)]


def open_serial(device, usb_serial=""):
    """Opens the port, looked up by the USB serial number first: COM numbers can change. DTR and RTS stay off,
    otherwise the Arduino could restart."""
    import serial
    from serial.tools import list_ports as lp
    if usb_serial:
        device = next((p.device for p in lp.comports() if p.serial_number == usb_serial), device)
    if not device:
        raise OSError("no serial port selected")
    port = serial.Serial()
    port.port, port.baudrate, port.timeout, port.write_timeout = device, BAUD, READ_TIMEOUT_S, 1.0
    port.dtr = port.rts = False
    port.open()
    return port


class Rotor:
    """Owns the serial port: one thread reads the position and sends the moves to the target."""

    def __init__(self, opener=open_serial, clock=time.monotonic):
        self.opener = opener
        self.clock = clock
        self.lock = threading.RLock()
        self.port = None
        self.device = ""
        self.usb_serial = ""
        self.thread = None
        self.running = False
        self.error = ""
        self.fault = ""
        self.az = self.el = None
        self.target = None         # (az, el) the rotor should point at
        self.target_source = ""    # "manual" or "tracker"
        self.target_raw = None     # K3NG azimuth 0-450 of the target, given by the satellite tracker (it chooses the side)
        self.tracker = False       # satellite tracking moves the rotor: GO and the dials are refused
        self.control = False       # rotor control on: the satellite tracking may move the rotor
        self.sent = None           # (az, el) last sent to K3NG
        self.sent_at = 0.0
        self._filter_az = collections.deque(maxlen=FILTER_LEN)
        self._filter_el = collections.deque(maxlen=FILTER_LEN)
        self._read_at = None
        self._stall_ref = None     # (az, el, time) of the last progress
        self._last_reply = 0.0
        self.az_cal = (0.0, K3NG_SPAN)   # true azimuth at K3NG 0 and at K3NG 450
        self.raw = None            # K3NG azimuth 0-450, followed from the readings (K3NG itself reports it modulo 360)
        self.raw_hint = None       # last known raw azimuth, saved: decides 0-90 against 360-450 at the first reading
        self.raw_guess = False     # the first reading was ambiguous and nothing decided it
        self.on_raw = None         # called with the raw azimuth when it changes, for saving it
        self._raw_reported = None
        self._plan = None          # (target, (az, el) sent to K3NG, true azimuth K3NG will end at)

    # ---------- control ----------

    def set_cal(self, az0, az450):
        with self.lock:
            self.az_cal = (float(az0), float(az450))
            self._plan = None
            if self.raw is not None:
                self.az = self.to_true(self.raw) % 360.0

    def to_true(self, raw):
        az0, az450 = self.az_cal
        return az0 + raw * (az450 - az0) / K3NG_SPAN

    def to_raw(self, true_az):
        az0, az450 = self.az_cal
        return (true_az - az0) * K3NG_SPAN / (az450 - az0)

    def start(self, device, usb_serial=""):
        self.close()
        with self.lock:
            self.device, self.usb_serial = device, usb_serial
            self.error, self.fault = "", ""
            self.control = False
            self.running = True
            self.thread = threading.Thread(target=self._run, name="rotor", daemon=True)
            self.thread.start()

    def close(self):
        """Stops the rotor and frees the port."""
        with self.lock:
            thread, self.running = self.thread, False
            self.thread = None
        if thread:
            thread.join(2.0)
        with self.lock:
            self.control = False
            self._stop_motion()
            self._close_port()
            self._clear_readings()
            self.az = self.el = None

    def goto(self, az, el, source="manual", raw=None):
        """New target. None = OK, else the reason it was refused.
        raw: the K3NG azimuth (0-450) to get there, from the satellite tracker; az is then only for showing."""
        with self.lock:
            if self.fault:
                return self.fault
            if self.port is None:
                return self.error or "rotor not connected"
            if self.tracker and source == "manual":
                return "satellite tracking moves the rotor (SATELLITES tab, TRACK): switch it off first"
            if source == "tracker" and not self.control:
                return None     # accepted and ignored: the tracking goes on calculating, the rotor stays
            # 360 stays 360: on a rotor with its stop at north, 0 and 360 are the two opposite ends.
            self.target = (360.0 if az == 360 else az % 360.0, min(max(el, 0.0), MAX_EL_DEG))
            self.target_raw = None if raw is None else min(max(float(raw), 0.0), K3NG_SPAN)
            self.target_source = source
        return None

    def stop(self):
        with self.lock:
            self._stop_motion()

    def start_control(self):
        """Rotor control on: from now on the satellite tracking moves the rotor. None = OK, else the reason it was refused."""
        with self.lock:
            if self.fault:
                return self.fault
            if not self.running:
                return "rotor link is off"
            if self.port is None and self.error:
                return self.error
            self.control = True
        return None

    def stop_control(self):
        """Rotor control off: both motors stop and the tracking is ignored; the position is still read."""
        with self.lock:
            self.control = False
            self._stop_motion()

    def reset_fault(self):
        with self.lock:
            self.fault = ""
            self._clear_readings()

    def info(self):
        with self.lock:
            return {"on": self.running, "connected": self.port is not None, "device": self.device, "usb_serial": self.usb_serial,
                    "az": self.az, "el": self.el, "k3ng_az": self.raw, "k3ng_guess": self.raw_guess, "az_cal": list(self.az_cal), "target": list(self.target) if self.target else None, "target_raw": self.target_raw, "tracker": self.tracker,
                    "source": self.target_source, "control": self.control, "fault": self.fault, "error": self.error}

    # ---------- inside (lock held) ----------

    def _write(self, text):
        self.port.write(text.encode("ascii") + b"\r")

    def _stop_motion(self):
        self.target, self.sent, self.target_source, self._stall_ref, self._plan = None, None, "", None, None
        self.target_raw = None
        if self.port is not None:
            try:
                self._write("S")
            except OSError as e:
                self.error = f"stop failed: {e}"

    def _close_port(self):
        if self.port is not None:
            try:
                self.port.close()
            except OSError:
                pass
            self.port = None

    def _clear_readings(self):
        if self.raw is not None:
            self.raw_hint = self.raw     # the rotor may be turned by hand while disconnected: decided again
        self.raw = None
        self._filter_az.clear()
        self._filter_el.clear()
        self._read_at = None
        self._stall_ref = None

    def _set_fault(self, text):
        print(f"Rotor stopped: {text}")
        self.fault = text
        self.control = False
        self._stop_motion()

    def _take_reading(self, az, el):
        """Adds raw readings to the filters and checks the filtered position for impossible jumps."""
        now = self.clock()
        if az is not None:
            self._filter_az.append(az % 360.0)
        if el is not None:
            self._filter_el.append(el)
        if not self._filter_az:
            return
        self._follow_raw(median_angle(self._filter_az))
        new_az = self.to_true(self.raw) % 360.0
        new_el = statistics.median(self._filter_el) if self._filter_el else self.el
        if self._read_at is not None and not self.fault:
            limit = JUMP_DEG + MAX_RATE_DEG_S * (now - self._read_at)
            jump = max(abs(angle_diff(new_az, self.az)), abs(new_el - self.el) if new_el is not None and self.el is not None else 0)
            if jump > limit:
                self._set_fault(f"position jumped from AZ {self.az:.0f} EL {self.el if self.el is None else round(self.el)} "
                                f"to AZ {new_az:.0f} EL {new_el if new_el is None else round(new_el)}")
        self.az, self.el, self._read_at = new_az, new_el, now

    def _follow_raw(self, k3ng_az):
        """K3NG azimuth (modulo 360) -> self.raw, 0-450."""
        if self.raw is None:
            high = k3ng_az + 360.0
            near = lambda v: self.raw_hint is not None and abs(self.raw_hint - v) < RAW_HINT_DEG
            if high > K3NG_SPAN + 2.0 or near(k3ng_az):
                self.raw, self.raw_guess = k3ng_az, False
            elif near(high):
                self.raw, self.raw_guess = high, False
            else:
                self.raw, self.raw_guess = k3ng_az, True       # the usual side; shown as a guess on the page
        else:
            self.raw += angle_diff(k3ng_az, self.raw % 360.0)
            # Below the left stop or beyond the right one is impossible: the first reading was on the other side.
            if self.raw < -RAW_SLACK_DEG:
                self.raw, self.raw_guess = self.raw + 360.0, False
            elif self.raw > K3NG_SPAN + RAW_SLACK_DEG:
                self.raw, self.raw_guess = self.raw - 360.0, False
        if self.on_raw and (self._raw_reported is None or abs(self.raw - self._raw_reported) >= 1.0):
            self._raw_reported = self.raw
            self.on_raw(round(self.raw, 1))

    @staticmethod
    def k3ng_pick(command, raw):
        """Raw azimuth K3NG turns to for "W command": of command and command + 360 the nearer one, as K3NG does."""
        c = command % 360.0
        return c + 360.0 if c + 360.0 < K3NG_SPAN and abs(c + 360.0 - raw) <= abs(raw - c) else c

    def _plan_for(self, target):
        """Target (true az, el) -> (command az, el) and the true azimuth K3NG will end at. K3NG takes 0-360 and chooses
        between the start and the overlap itself, so of the possible commands the one ending nearest the target is used."""
        best = None
        for turn in (0.0, 360.0):
            k = self.to_raw(target[0] % 360.0 + turn)
            if not -5.0 <= k <= K3NG_SPAN + 5.0:
                continue
            command = int(round(min(max(k, 0.0), K3NG_SPAN)))
            if command > 360:
                command -= 360
            end = self.to_true(self.k3ng_pick(command, self.raw)) % 360.0
            miss = abs(angle_diff(end, target[0]))
            if best is None or miss < best[0] - 0.5:
                best = (miss, command, end)
        if best is None:      # outside the calibrated range: the nearer end of it
            k = min((0.0, K3NG_SPAN), key=lambda v: abs(angle_diff(self.to_true(v), target[0])))
            best = (0.0, int(k) - 360 if k > 360 else int(k), self.to_true(k) % 360.0)
        if self.az_cal == (0.0, K3NG_SPAN):
            best = (0.0, round(target[0]), best[2])      # no calibration: the azimuth as before (360 stays 360)
        return (best[1], round(target[1])), best[2]

    @staticmethod
    def raw_command(raw_target, raw_now):
        """K3NG azimuth wanted -> (command 0-360, K3NG azimuth the command leads to). K3NG takes the nearer of command and
        command + 360, so a target on the far side of that choice goes through a point 90 degrees short of it first."""
        want = int(round(min(max(raw_target, 0.0), K3NG_SPAN)))
        command = want - 360 if want > 360 else want
        if raw_now is None or abs(Rotor.k3ng_pick(command, raw_now) - want) <= 2:
            return command, float(want)
        way = want - 90 if want >= 180 else want + 90       # 270-360 or 90-180: only one K3NG azimuth for it
        return way, float(way)

    def _error_to(self, target):
        """Distance to where the rotor can get for this target: with a calibration a true azimuth may be reachable
        only a little off (K3NG chooses the side itself), then that point counts as reached."""
        if self.target_raw is not None:       # the tracker gives the K3NG azimuth: planned again each time (waypoint)
            command, _ = self.raw_command(self.target_raw, self.raw)
            self._plan = (target, (command, round(target[1])), self.to_true(self.target_raw) % 360.0)
            scale = abs(self.az_cal[1] - self.az_cal[0]) / K3NG_SPAN
            return max(abs(self.raw - self.target_raw) * scale, abs(target[1] - self.el) if self.el is not None else 0)
        if self._plan is None or self._plan[0] != target:
            self._plan = (target,) + self._plan_for(target)
        az = self._plan[2]
        return max(abs(angle_diff(az, self.az)), abs(target[1] - self.el) if self.el is not None else 0)

    def _track(self):
        """Sends the target to K3NG (which drives the motors) and watches that the rotor gets there."""
        now = self.clock()
        if self.target is None or self.az is None or self.fault:
            return
        if self._error_to(self.target) <= DEADBAND_DEG:
            self._stall_ref = None
            return
        command = self._plan[1]
        if (command != self.sent or now - self.sent_at >= RESEND_S) and now - self.sent_at >= COMMAND_GAP_S:
            self._write(f"W{command[0]:03d} {command[1]:03d}")
            self.sent, self.sent_at = command, now
        if self.sent is None:
            return
        if self._stall_ref is None:
            self._stall_ref = (self.az, self.el, now)
            return
        ref_az, ref_el, ref_at = self._stall_ref
        moved = max(abs(angle_diff(self.az, ref_az)), abs(self.el - ref_el) if self.el is not None and ref_el is not None else 0)
        if moved >= STALL_DEG:
            self._stall_ref = (self.az, self.el, now)
        elif now - ref_at > STALL_S:
            self._set_fault(f"no movement for {STALL_S:.0f} s, stuck at AZ {self.az:.0f}")

    def poll(self):
        """One cycle: query, read, check, track. False = the connection is gone."""
        with self.lock:
            self.port.reset_input_buffer()
            self._write("C2")
        reply = self.port.read(128)        # outside the lock: STOP does not have to wait for the reply
        with self.lock:
            az, el = parse_position(reply)
            if az is not None or el is not None:
                self._last_reply = self.clock()
                self._take_reading(az, el)
                self._track()
            return self.clock() - self._last_reply < NO_REPLY_S

    def _run(self):
        while self.running:
            try:
                with self.lock:
                    self.port = self.opener(self.device, self.usb_serial)
                    self._last_reply = self.clock()
                    self._clear_readings()
                    self.error = ""
                while self.running:
                    if not self.poll():
                        raise OSError("K3NG does not reply to position queries (check the baud rate and the firmware)")
                    time.sleep(POLL_S)
            except OSError as e:
                with self.lock:
                    self.error = str(e)
                    self.control = False
                    self.target, self.sent, self.target_source = None, None, ""     # nothing resumes by itself later
                    self._close_port()
                    self._clear_readings()
                    self.az = self.el = None
                self._sleep_while_running(2.0)

    def _sleep_while_running(self, seconds):
        end = time.monotonic() + seconds
        while self.running and time.monotonic() < end:
            time.sleep(0.05)


class RotorLink:
    """The rotor of the station, turned on and off in SETTINGS › GENERAL › ROTOR."""

    def __init__(self, opener=open_serial):
        self.rotor = Rotor(opener)

    def start(self, device, usb_serial=""):
        self.rotor.start(device, usb_serial)
        return None

    def stop(self):
        self.rotor.close()

    def info(self):
        return self.rotor.info()


# ---------- rotor settings: one rotor for the whole station (data\rotor.json), not tied to a VFO ----------
# Versions up to 0.114beta1 kept them in the config of one VFO (config_X.json, key "rotor"); migrate() moves them.
SETTINGS_KEYS = ("enabled", "port", "usb_serial", "az_cal", "k3ng_az", "links")
# Sources of the wanted AZ / EL that can be disconnected from the rotor (RCTRL › CONNECTION): the satellite tracker,
# the recall of a memory with a location, the map of RCTRL. Connected unless switched off.
LINK_SOURCES = ("sat", "mem", "map")
LINK_NAMES = {"sat": "SAT TRACKER", "mem": "MEMORY RECALL", "map": "RCTRL MAP"}


def links_of(settings):
    """{"sat", "mem", "map": True / False} from the rotor settings (missing = connected)."""
    links = settings.get("links")
    links = links if isinstance(links, dict) else {}
    return {k: bool(links.get(k, True)) for k in LINK_SOURCES}


def load_settings(path):
    """Rotor settings from data\rotor.json; {} if there are none (or the file is damaged)."""
    import json
    try:
        with open(path, encoding="utf-8") as f:
            s = json.load(f)
    except (OSError, ValueError):
        return {}
    return {k: s[k] for k in SETTINGS_KEYS if k in s} if isinstance(s, dict) else {}


def save_settings(path, settings):
    """Writes the rotor settings (through a temporary file, so a power cut leaves the old file)."""
    import json
    import os
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({k: settings[k] for k in SETTINGS_KEYS if k in settings}, f, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def migrate(path, config_paths):
    """No rotor.json yet: takes the "rotor" section of the VFO configs (the enabled one first) and removes it there.
    Returns the name of the config it came from, or None."""
    import json
    import os
    if os.path.exists(path):
        return None
    found = []
    for p in config_paths:
        try:
            with open(p, encoding="utf-8") as f:
                c = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(c, dict) and isinstance(c.get("rotor"), dict):
            found.append((p, c))
    if not found:
        return None
    src_path, src = next(((p, c) for p, c in found if c["rotor"].get("enabled")), found[0])
    save_settings(path, src["rotor"])
    for p, c in found:
        c.pop("rotor", None)
        with open(p, "w", encoding="utf-8") as f:
            json.dump(c, f, indent=2, ensure_ascii=False)
    return os.path.basename(src_path)
