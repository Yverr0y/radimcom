"""Rotor plan for a satellite pass and the tracker that follows it (SATELLITES tab, TRACK).

The K3NG controller turns 0-450 degrees from its left stop and chooses the shorter way for every command, knowing
nothing about the pass. A pass across the north would then unwind the rotor by about 360 degrees in the middle.
So the whole pass is planned ahead from 1 s samples: every way of following it is simulated with the real speeds
of the rotor and the one with the smallest pointing error is used:

    normal     azimuth within K3NG 0-360, elevation 0-90
    overlap    azimuth unwound past 360 (K3NG up to 450), elevation 0-90
    flipped    azimuth + 180, elevation 180 - el: the antenna looks over the top, backwards
    over top   azimuth stands still, elevation goes 0 -> 180 (high passes, where the azimuth turns too fast)

The tracker sends the K3NG azimuth of the plan (rotor.goto(..., raw=)), so the plan, not K3NG, decides the side.
It moves the rotor only while CTRL is on; with CTRL off or without the rotor link it only calculates.
"""
import math
import threading
import time

import numpy as np

import rotor as rotor_module
import sattrack

AZ_SPEED = 5.5           # deg/s of true azimuth, measured 5.5-6.5 (slower when starting)
EL_SPEED = 2.3           # deg/s, measured 2.3-2.5
LEAD_S = 2.0             # the antenna is sent this far ahead of the satellite
STEP_S = 1.0             # plan samples
PREP_EXTRA_S = 30.0      # the move to the start of the pass begins this much earlier than it needs
EDGE_DEG = 2.0           # how far a planned K3NG azimuth may be outside 0-450 (it is clamped to the stop)
PREFER_DEG = 2.0         # a mode later in MODES must be better by more than this to be used
MODES = ("normal", "overlap", "flipped", "over top")
TLE_MAX_DAYS = 14.0      # older elements need a confirmation
HORIZON_S = 24 * 3600    # the next pass is looked for this far ahead
TICK_S = 0.5


def _dirs(az, el):
    a, e = np.radians(az), np.radians(el)
    return np.stack([np.cos(e) * np.sin(a), np.cos(e) * np.cos(a), np.sin(e)], axis=-1)


def _sep(az1, el1, az2, el2):
    """Angle between two directions in degrees; elevation over 90 means looking backwards over the top."""
    d = np.sum(_dirs(az1, el1) * _dirs(az2, el2), axis=-1)
    return np.degrees(np.arccos(np.clip(d, -1.0, 1.0)))


class Cal:
    """True azimuth <-> K3NG azimuth, as in rotor.Rotor."""

    def __init__(self, az0=0.0, az450=rotor_module.K3NG_SPAN):
        self.az0, self.az450 = float(az0), float(az450)
        self.scale = (self.az450 - self.az0) / rotor_module.K3NG_SPAN    # true degrees per K3NG degree

    def to_raw(self, true_az):
        return (np.asarray(true_az) - self.az0) / self.scale

    def to_true(self, raw):
        return self.az0 + np.asarray(raw) * self.scale


def _candidates(az, el, cal):
    """All ways of following the pass: [(mode, k3ng azimuth array, elevation array)]."""
    out = []
    span = rotor_module.K3NG_SPAN
    u = np.degrees(np.unwrap(np.radians(az)))           # continuous true azimuth
    for flip in (False, True):
        uu, ee = (u + 180.0, 180.0 - el) if flip else (u, el)
        for k in range(-2, 3):
            raw = cal.to_raw(uu + 360.0 * k)
            if raw.min() < -EDGE_DEG or raw.max() > span + EDGE_DEG:
                continue
            mode = "flipped" if flip else ("overlap" if raw.max() > 360.0 + EDGE_DEG else "normal")
            out.append((mode, np.clip(raw, 0.0, span), ee.copy()))
    # over the top: the vertical plane that keeps the satellite nearest, the antenna turning 0 -> 180 in it
    d = _dirs(az, el)
    for a0 in {round(float(az[0]), 1), round(float(az[np.argmax(el)] - 90.0) % 360.0, 1), round(float(az[np.argmax(el)] + 90.0) % 360.0, 1)}:
        h = np.array([math.sin(math.radians(a0)), math.cos(math.radians(a0)), 0.0])
        ee = np.degrees(np.arctan2(d[:, 2], d @ h))       # 0 = towards a0, 180 = the opposite horizon
        if ee.min() < -1.0:
            continue
        for k in range(-1, 2):
            r = float(cal.to_raw(a0 + 360.0 * k))
            if 0.0 <= r <= span:
                out.append(("over top", np.full(len(az), r), np.clip(ee, 0.0, 180.0)))
    return out


def simulate(raw_cmd, el_cmd, sat_az, sat_el, cal, start=None):
    """The rotor following the commands (sent LEAD_S ahead, a move when the error exceeds the dead band, K3NG speeds).
    start: (k3ng az, el) at the first sample, else on the first command. -> (antenna k3ng az, antenna el) arrays."""
    n = len(raw_cmd)
    lead = int(round(LEAD_S / STEP_S))
    ci = np.minimum(np.arange(n) + lead, n - 1)
    r, e = (float(raw_cmd[0]), float(el_cmd[0])) if start is None else start
    sent = None
    az_step = AZ_SPEED * STEP_S / cal.scale
    el_step = EL_SPEED * STEP_S
    out_r, out_e = np.empty(n), np.empty(n)
    db = rotor_module.DEADBAND_DEG
    for i in range(n):
        tr, te = raw_cmd[ci[i]], el_cmd[ci[i]]
        if max(abs(tr - r) * cal.scale, abs(te - e)) > db:
            sent = (tr, te)
        if sent is not None:
            r += max(-az_step, min(az_step, sent[0] - r))
            e += max(-el_step, min(el_step, sent[1] - e))
            if abs(sent[0] - r) < 0.5 and abs(sent[1] - e) < 0.5:
                sent = None
        out_r[i], out_e[i] = r, e
    return out_r, out_e


def move_time(cal, frm, to):
    """Seconds to turn from (k3ng az, el) to (k3ng az, el)."""
    if frm is None:
        return 90.0
    return max(abs(to[0] - frm[0]) * cal.scale / AZ_SPEED, abs(to[1] - frm[1]) / EL_SPEED)


def plan_pass(times, az, el, cal, now_pos=None):
    """Plan for one pass (sample arrays). now_pos: (k3ng az, el) of the rotor now, for the shorter move to the start.
    -> {"mode", "max_err", "mean_err", "raw", "el", "err", "options": [{"mode", "max_err", "raw0", "raw1", "move_s"}]}"""
    options = []
    for mode, raw, ee in _candidates(az, el, cal):
        ar, ae = simulate(raw, ee, az, el, cal)
        err = _sep(cal.to_true(ar), ae, az, el)
        options.append({"mode": mode, "raw": raw, "el": ee, "err": err, "max_err": float(err.max()), "mean_err": float(err.mean()),
                        "move_s": move_time(cal, now_pos, (raw[0], ee[0]))})
    if not options:
        raise ValueError("the pass cannot be followed within K3NG 0-450")
    best = min(o["max_err"] for o in options)
    good = [o for o in options if o["max_err"] <= best + PREFER_DEG]
    pick = min(good, key=lambda o: (MODES.index(o["mode"]), round(o["max_err"]), o["move_s"]))
    return dict(pick, options=sorted(({"mode": o["mode"], "max_err": round(o["max_err"], 1), "raw0": round(float(o["raw"][0]), 1),
                                        "raw1": round(float(o["raw"][-1]), 1), "move_s": round(o["move_s"])} for o in options),
                                      key=lambda o: o["max_err"]))


class Tracker:
    """Follows the passes of one satellite with the rotor: plans the next pass, turns the rotor to its start in time,
    follows it, after LOS waits for the next one. Runs in a thread of the VFO process."""

    def __init__(self, rotor, clock=time.time):
        self.rotor = rotor
        self.clock = clock
        self.lock = threading.Lock()
        self.thread = None
        self.on = False
        self.norad = None
        self.name = ""
        self.state = ""          # waiting, moving to the start, tracking
        self.pas = None          # the planned pass {"aos", "los", "max_el", ...}
        self.plan = None         # plan_pass() of it, with "t" (sample times)
        self.prep_at = None      # when the move to the start begins
        self.now = {}            # the satellite and the command now
        self.note = ""           # what the rotor said to the last command
        self.stopped = ""
        self._planned_at = 0.0

    def start(self, norad, force=False):
        sat = sattrack.satellites().get(int(norad))
        if not sat:
            return f"satellite {norad} is not in the orbital elements"
        age = (time.time() - sat["epoch"]) / 86400
        if age > TLE_MAX_DAYS and not force:
            return f"the orbital elements of {sat['name']} are {age:.0f} days old: positions may be far off"
        self.stop()
        with self.lock:
            self.norad, self.name = int(norad), sat["name"]
            self.state, self.pas, self.plan, self.prep_at, self.now, self.note, self.stopped = "", None, None, None, {}, "", ""
            self.on = True
            self.rotor.tracker = True
            self.thread = threading.Thread(target=self._run, name="sattrack", daemon=True)
            self.thread.start()
        return None

    def stop(self, reason=""):
        with self.lock:
            thread, self.on = self.thread, False
            self.thread = None
            if reason:
                self.stopped = reason
            was = self.rotor.tracker
            self.rotor.tracker = False
        if was:
            with self.rotor.lock:
                if self.rotor.target_source == "tracker":
                    self.rotor._stop_motion()       # the rotor stays where it is, CTRL stays as it was
        if thread and thread is not threading.current_thread():
            thread.join(2.0)

    def info(self):
        with self.lock:
            plan = None
            if self.plan:
                p = self.plan
                path = [[round(float(t)), round(float(r), 1), round(float(e), 1)] for t, r, e in zip(p["t"][::5], p["raw"][::5], p["el"][::5])]
                plan = {"mode": p["mode"], "max_err": round(p["max_err"], 1), "mean_err": round(p["mean_err"], 1),
                        "raw0": round(float(p["raw"][0]), 1), "raw1": round(float(p["raw"][-1]), 1),
                        "raw_min": round(float(p["raw"].min()), 1), "raw_max": round(float(p["raw"].max()), 1),
                        "el_max": round(float(p["el"].max()), 1), "options": p["options"], "path": path}
            return {"on": self.on, "norad": self.norad, "name": self.name, "state": self.state,
                    "pass": self.pas, "plan": plan, "prep_at": self.prep_at, "now": self.now, "note": self.note,
                    "stopped": self.stopped, "control": self.rotor.control, "rotor_on": self.rotor.running}

    # ---------- inside ----------

    def _run(self):
        while True:
            with self.lock:
                if not self.on:
                    return
            try:
                self._tick()
            except Exception as e:      # a dead loop must not leave the rotor following an old command
                print(f"Satellite tracking stopped: {e}")
                self.stop(f"calculation failed: {e}")
                return
            time.sleep(TICK_S)

    def _cal(self):
        return Cal(*self.rotor.az_cal)

    def _replan(self, now):
        sat = sattrack.satellites().get(self.norad)
        if not sat:
            raise ValueError("the satellite is no longer in the orbital elements")
        setup = sattrack.load_setup()
        found = [p for p in sattrack.find_passes(sat["sat"], now, HORIZON_S / 3600, setup) if p["los"] > now + 5]
        if not found:
            with self.lock:
                self.pas, self.plan, self.prep_at, self.state = None, None, None, f"no pass in the next {HORIZON_S // 3600} hours"
            return
        p = found[0]
        t0 = max(p["aos"], now)
        t = np.arange(t0, p["los"] + STEP_S, STEP_S)
        t[-1] = min(t[-1], p["los"])
        lk = sattrack.look(sat["sat"], t, setup)
        cal = self._cal()
        raw_now = self.rotor.raw
        pos = None if raw_now is None or self.rotor.el is None else (raw_now, self.rotor.el)
        plan = plan_pass(t, lk["az"], np.maximum(lk["el"], 0.0), cal, pos)
        plan["t"] = t
        plan["sat_az"], plan["sat_el"] = lk["az"], lk["el"]
        with self.lock:
            self.pas = p
            self.plan = plan
            self.prep_at = round(p["aos"] - move_time(cal, pos, (plan["raw"][0], plan["el"][0])) - PREP_EXTRA_S, 1)

    def _tick(self):
        now = self.clock()
        if self.plan is None or now > self.pas["los"] + 2:
            if self.plan is None and self.pas is None and self.state.startswith("no pass") and now - self._planned_at < 600:
                return          # nothing in 24 hours: looked for again every 10 minutes
            self._planned_at = now
            self._replan(now)
        if self.plan is None:
            return
        p = self.plan
        t = p["t"]
        if now < self.prep_at:
            state, i = "waiting for the pass", None
        elif now < t[0]:
            state, i = "moving to the start", 0
        else:
            state = "tracking"
            i = int(min(max(round((now + LEAD_S - t[0]) / STEP_S), 0), len(t) - 1))
        j = int(min(max(round((now - t[0]) / STEP_S), 0), len(t) - 1))
        cal = self._cal()
        cur = {"sat_az": round(float(p["sat_az"][j]), 1), "sat_el": round(float(p["sat_el"][j]), 1)} if now >= t[0] else {}
        if i is not None:
            raw, el = float(p["raw"][i]), float(p["el"][i])
            az = float(cal.to_true(raw)) % 360.0
            cur.update(cmd_raw=round(raw, 1), cmd_az=round(az, 1), cmd_el=round(el, 1))
            if not self.rotor.running:
                note = "rotor link off (SETTINGS › GENERAL › ROTOR): only calculated"
            else:
                note = self.rotor.goto(az, el, "tracker", raw=raw)
                note = note or ("" if self.rotor.control else "CTRL is off: the rotor does not move, only calculated")
            if now >= t[0] and self.rotor.az is not None and self.rotor.el is not None and self.rotor.raw is not None:
                cur["err"] = round(float(_sep(np.array([cal.to_true(self.rotor.raw)]), np.array([self.rotor.el]),
                                              np.array([p["sat_az"][j]]), np.array([p["sat_el"][j]]))[0]), 1)
        else:
            note = ""
        with self.lock:
            if self.on:
                self.state, self.now, self.note = state, cur, note
