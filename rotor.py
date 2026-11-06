"""Antenna rotor (K3NG Arduino controller, GS-232 commands over USB serial) and the link to Gpredict.

Gpredict does the satellite tracking and talks to RADIMCOM as if it were a rotor and a radio:
    rotctld protocol, TCP 4533: azimuth / elevation -> Rotor -> K3NG
    rigctld protocol, TCP 4532: Doppler corrected frequency -> tuner of this VFO (receive only)

Rotor safety: position readings are noisy, K3NG does not acknowledge commands, so the position is checked here.
A reading that jumps faster than the rotor can move, or a move without progress, stops the rotor and latches a fault
that has to be reset by hand. A lost serial connection or a disconnected Gpredict also stops it.

The rotor follows Gpredict only with rotor control on (CTRL key in the SAT window of the page); until then the position
is read and Gpredict's moves are ignored. A fault, a lost connection and STOP all turn it off, and only CTRL turns it on.
"""
import collections
import re
import socket
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
MAX_RATE_DEG_S = 10.0    # faster than the rotor can move (measured about 6 deg/s)
JUMP_DEG = 15.0          # allowed change between two filtered readings, on top of MAX_RATE_DEG_S
STALL_S = 10.0           # a move without STALL_DEG of progress for this long is a fault
STALL_DEG = 3.0
MAX_EL_DEG = 180.0       # above 90 the antenna goes over the top and looks backwards
ROTCTL_PORT = 4533
RIGCTL_PORT = 4532
RIG_READBACK_S = 1.0     # a retune takes effect a little later; until then the frequency Gpredict set is reported

_REPLY_AZ = re.compile(rb"AZ=\s*(-?\d+(?:\.\d+)?)\s")
_REPLY_EL = re.compile(rb"EL=\s*(-?\d+(?:\.\d+)?)\s")

# Hamlib error codes in the "RPRT x" replies
RPRT_OK, RPRT_INVALID, RPRT_NOT_IMPLEMENTED, RPRT_NO_POSITION, RPRT_REJECTED = 0, -1, -4, -5, -9


def angle_diff(a, b):
    """Shortest signed difference a - b in degrees, -180 to 180."""
    return (a - b + 180.0) % 360.0 - 180.0


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
        self.target_source = ""    # "gpredict" or "manual"
        self.aim = None            # (az, el) where Gpredict wants the antenna; it sends a move only beyond its threshold
        self.control = False       # rotor control on: Gpredict may move the rotor
        self.sent = None           # (az, el) last sent to K3NG
        self.sent_at = 0.0
        self._filter_az = collections.deque(maxlen=FILTER_LEN)
        self._filter_el = collections.deque(maxlen=FILTER_LEN)
        self._read_at = None
        self._stall_ref = None     # (az, el, time) of the last progress
        self._last_reply = 0.0

    # ---------- control ----------

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
            self.az = self.el = None

    def goto(self, az, el, source="manual"):
        """New target. None = OK, else the reason it was refused."""
        with self.lock:
            if self.fault:
                return self.fault
            if self.port is None:
                return self.error or "rotor not connected"
            if source == "gpredict" and not self.control:
                return None     # accepted and ignored: an error would make Gpredict drop the rotor
            # 360 stays 360: on a rotor with its stop at north, 0 and 360 are the two opposite ends.
            self.target = (360.0 if az == 360 else az % 360.0, min(max(el, 0.0), MAX_EL_DEG))
            self.target_source = source
        return None

    def stop(self):
        with self.lock:
            self._stop_motion()

    def start_control(self):
        """Rotor control on: from now on Gpredict moves the rotor. None = OK, else the reason it was refused."""
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
        """Rotor control off: both motors stop and Gpredict is ignored; the position is still read."""
        with self.lock:
            self.control = False
            self._stop_motion()

    def client_gone(self):
        """Gpredict disconnected: its move must not continue unattended."""
        with self.lock:
            self.aim = None
            if self.target_source == "gpredict":
                self._stop_motion()

    def reset_fault(self):
        with self.lock:
            self.fault = ""
            self._clear_readings()

    def info(self):
        with self.lock:
            return {"on": self.running, "connected": self.port is not None, "device": self.device, "usb_serial": self.usb_serial,
                    "az": self.az, "el": self.el, "target": list(self.target) if self.target else None,
                    "aim": list(self.aim) if self.aim else None, "source": self.target_source, "control": self.control, "fault": self.fault, "error": self.error}

    # ---------- inside (lock held) ----------

    def _write(self, text):
        self.port.write(text.encode("ascii") + b"\r")

    def _stop_motion(self):
        self.target, self.sent, self.target_source, self._stall_ref = None, None, "", None
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
        new_az = median_angle(self._filter_az)
        new_el = statistics.median(self._filter_el) if self._filter_el else self.el
        if self._read_at is not None and not self.fault:
            limit = JUMP_DEG + MAX_RATE_DEG_S * (now - self._read_at)
            jump = max(abs(angle_diff(new_az, self.az)), abs(new_el - self.el) if new_el is not None and self.el is not None else 0)
            if jump > limit:
                self._set_fault(f"position jumped from AZ {self.az:.0f} EL {self.el if self.el is None else round(self.el)} "
                                f"to AZ {new_az:.0f} EL {new_el if new_el is None else round(new_el)}")
        self.az, self.el, self._read_at = new_az, new_el, now

    def _error_to(self, target):
        return max(abs(angle_diff(target[0], self.az)), abs(target[1] - self.el) if self.el is not None else 0)

    def _track(self):
        """Sends the target to K3NG (which drives the motors) and watches that the rotor gets there."""
        now = self.clock()
        if self.target is None or self.az is None or self.fault:
            return
        if self._error_to(self.target) <= DEADBAND_DEG:
            self._stall_ref = None
            return
        command = (round(self.target[0]), round(self.target[1]))
        if command != self.sent and now - self.sent_at >= COMMAND_GAP_S:
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
                    self.az = self.el = None
                self._sleep_while_running(2.0)

    def _sleep_while_running(self, seconds):
        end = time.monotonic() + seconds
        while self.running and time.monotonic() < end:
            time.sleep(0.05)


# ---------- rotctld / rigctld text protocols ----------

def rprt(code):
    return f"RPRT {code}\n"


def _floats(args, count):
    if len(args) < count:
        raise ValueError
    return [float(a) for a in args[:count]]


def rotctl_reply(rotor, line):
    """One line of the rotctld protocol (what Gpredict sends as a rotor) -> reply, None for an unknown command."""
    cmd, *args = line.split()
    if cmd in ("P", "\\set_pos"):
        try:
            az, el = _floats(args, 2)
        except ValueError:
            return rprt(RPRT_INVALID)
        return rprt(RPRT_REJECTED if rotor.goto(az, el, "gpredict") else RPRT_OK)
    if cmd == "\\set_aim":     # only our build of Gpredict sends this; shown in the SAT window, never moves the rotor
        try:
            az, el = _floats(args, 2)
        except ValueError:
            return rprt(RPRT_INVALID)
        rotor.aim = (az % 360.0, el)
        return rprt(RPRT_OK)
    if cmd in ("p", "\\get_pos"):
        info = rotor.info()
        if info["az"] is None:
            return rprt(RPRT_NO_POSITION)
        return f"{info['az']:.2f}\n{info['el'] or 0.0:.2f}\n"
    if cmd in ("S", "\\stop"):
        rotor.stop()
        return rprt(RPRT_OK)
    if cmd in ("_", "\\get_info"):
        return "RADIMCOM K3NG\n"
    return None


class PassCountdown:
    """Time to the next AOS or LOS of the target in Gpredict. Only our build of Gpredict sends it, about once a second:
    "\\set_pass satellite|AOS|seconds", no argument = no such event. It counts on by itself between the updates."""

    COMMAND = "\\set_pass"
    OVERDUE_S = 5.0      # no new time this long after zero: Gpredict has stopped updating it

    def __init__(self, clock=time.monotonic):
        self.clock = clock
        self.value = None     # (satellite, event, seconds, time received)

    def clear(self):
        self.value = None

    def command(self, line):
        """The whole command line -> reply in the rigctld style."""
        text = line[len(self.COMMAND):].strip()
        if not text:
            self.clear()
            return rprt(RPRT_OK)
        try:
            sat, event, seconds = text.rsplit("|", 2)
            self.value = (sat, event, float(seconds), self.clock())
        except ValueError:
            return rprt(RPRT_INVALID)
        return rprt(RPRT_OK)

    def filter(self, reply):
        """A reply function that also takes this command."""
        return lambda line: self.command(line) if line.split()[0] == self.COMMAND else reply(line)

    def info(self):
        value = self.value
        if value is None:
            return None
        sat, event, seconds, at = value
        left = seconds - (self.clock() - at)
        if left < -self.OVERDUE_S:
            return None
        return {"sat": sat, "event": event, "seconds": max(round(left), 0)}


class RigLink:
    """The tuner of this VFO as Gpredict's radio. Receive only: PTT on is refused."""

    def __init__(self, set_freq, get_freq, clock=time.monotonic):
        self.set_freq = set_freq   # hz -> None, or the reason it was refused
        self.get_freq = get_freq
        self.clock = clock
        self.last_hz = None
        self.last_at = 0.0
        self.trsp_sat = ""     # selected in Gpredict (our build sends them), empty otherwise
        self.trsp_name = ""

    def client_gone(self):
        self.trsp_sat = self.trsp_name = ""

    def frequency(self):
        if self.last_hz is not None and self.clock() - self.last_at < RIG_READBACK_S:
            return self.last_hz
        return self.get_freq()

    def reply(self, line):
        """One line of the rigctld protocol -> reply, None for an unknown command."""
        cmd, *args = line.split()
        if cmd == "\\set_trsp":     # only our build of Gpredict sends this: "satellite|transponder", nothing = none
            self.trsp_sat, _, self.trsp_name = line[len(cmd):].strip().partition("|")
            return rprt(RPRT_OK)
        if cmd in ("F", "\\set_freq"):
            try:
                hz = _floats(args, 1)[0]
            except ValueError:
                return rprt(RPRT_INVALID)
            if self.set_freq(hz):
                return rprt(RPRT_REJECTED)
            self.last_hz, self.last_at = hz, self.clock()
            return rprt(RPRT_OK)
        if cmd in ("f", "\\get_freq"):
            return f"{self.frequency():.0f}\n"
        if cmd in ("t", "\\get_ptt"):
            return "0\n"
        if cmd in ("T", "\\set_ptt"):
            return rprt(RPRT_OK if args[:1] == ["0"] else RPRT_REJECTED)
        if cmd in ("v", "\\get_vfo"):
            return "VFOA\n"
        if cmd in ("V", "\\set_vfo", "M", "\\set_mode"):
            return rprt(RPRT_OK)     # one VFO here; the mode is chosen in RADIMCOM
        if cmd in ("_", "\\get_info"):
            return "RADIMCOM\n"
        return None


_HTTP_LINE = re.compile(r"^(GET|POST|PUT|HEAD|OPTIONS|DELETE|PATCH|CONNECT) ")


class LineServer:
    """A small TCP server for the text protocols, on this PC only: a web page must not be able to move the rotor,
    so a connection that starts like an HTTP request is closed."""

    def __init__(self, name, port, reply, on_disconnect=None, on_unknown=None, host="127.0.0.1"):
        self.name, self.port, self.reply = name, port, reply
        self.on_disconnect, self.on_unknown, self.host = on_disconnect, on_unknown, host
        self.sock = None
        self.conns = set()
        self.lock = threading.Lock()

    @property
    def clients(self):
        with self.lock:
            return len(self.conns)

    def start(self):
        """Raises OSError when the port is taken (for example by another VFO)."""
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        try:
            self.sock.bind((self.host, self.port))
            self.sock.listen(4)
        except OSError:
            self.sock.close()
            self.sock = None
            raise
        threading.Thread(target=self._accept, args=(self.sock,), name=f"{self.name}-server", daemon=True).start()

    def close(self):
        """Also drops connected clients: Gpredict must not keep tuning or moving anything after the link is off."""
        if self.sock:
            self.sock.close()
            self.sock = None
        with self.lock:
            conns = list(self.conns)
        for conn in conns:
            try:
                conn.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def _accept(self, sock):
        while True:
            try:
                conn, _ = sock.accept()
            except OSError:
                return
            threading.Thread(target=self._serve, args=(conn,), name=f"{self.name}-client", daemon=True).start()

    def _serve(self, conn):
        with self.lock:
            self.conns.add(conn)
        buf = b""
        try:
            with conn:
                while self.sock:
                    chunk = conn.recv(1024)
                    if not chunk:
                        return
                    buf += chunk
                    if len(buf) > 4096:
                        return
                    while b"\n" in buf:
                        raw, buf = buf.split(b"\n", 1)
                        line = raw.decode("utf-8", "replace").strip()
                        if _HTTP_LINE.match(line):
                            return
                        if not line:
                            continue
                        if line.split()[0] in ("q", "Q", "\\quit"):
                            return
                        reply = self.reply(line)
                        if reply is None:
                            # Commands Gpredict sends that are not handled yet show up here.
                            print(f"{self.name}: unknown command {line!r}")
                            if self.on_unknown:
                                self.on_unknown(line)
                            reply = rprt(RPRT_NOT_IMPLEMENTED)
                        conn.sendall(reply.encode("ascii"))
        except OSError:
            pass
        finally:
            with self.lock:
                self.conns.discard(conn)
            if self.on_disconnect:
                self.on_disconnect()


class RotorLink:
    """The rotor and both Gpredict servers, turned on and off together."""

    def __init__(self, set_freq, get_freq, opener=open_serial):
        self.rotor = Rotor(opener)
        self.rig = RigLink(set_freq, get_freq)
        self.rot_pass, self.rig_pass = PassCountdown(), PassCountdown()
        self.rot_server = self.rig_server = None
        self.link_error = ""
        self.unknown = collections.deque(maxlen=10)

    def start(self, device, usb_serial="", rot_port=ROTCTL_PORT, rig_port=RIGCTL_PORT):
        self.stop()
        self.rot_server = LineServer("rotctl", rot_port, self.rot_pass.filter(lambda line: rotctl_reply(self.rotor, line)),
                                     on_disconnect=self._rot_gone, on_unknown=self.unknown.append)
        self.rig_server = LineServer("rigctl", rig_port, self.rig_pass.filter(self.rig.reply),
                                     on_disconnect=self._rig_gone, on_unknown=self.unknown.append)
        try:
            self.rot_server.start()
            self.rig_server.start()
        except OSError as e:
            self.stop()
            self.link_error = f"TCP ports {rot_port}/{rig_port} are busy (rotor already on in another VFO?): {e}"
            return self.link_error
        self.rotor.start(device, usb_serial)
        return None

    def _rot_gone(self):
        self.rotor.client_gone()
        self.rot_pass.clear()

    def _rig_gone(self):
        self.rig.client_gone()
        self.rig_pass.clear()

    def stop(self):
        self.rotor.close()
        for server in (self.rot_server, self.rig_server):
            if server:
                server.close()
        self.rot_server = self.rig_server = None
        self.link_error = ""

    def info(self):
        rot, rig = self.rot_server, self.rig_server
        return dict(self.rotor.info(), link_error=self.link_error, gpredict_rotor=bool(rot and rot.clients),
                    gpredict_radio=bool(rig and rig.clients), rot_port=rot.port if rot else ROTCTL_PORT,
                    rig_port=rig.port if rig else RIGCTL_PORT, unknown=list(self.unknown),
                    next_pass=self.rot_pass.info() or self.rig_pass.info())     # the rotator's target comes first
