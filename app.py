"""RADIMCOM: RTL-SDR (HF via upconverter, VHF/UHF direct), waterfall, tuning and audio in the browser.

Frequencies in the interface are real frequencies. On HF the dongle is tuned to the frequency
+ lo_offset_hz (upconverter LO, e.g. 100 MHz: 3.6 MHz -> 103.6 MHz), above 30 MHz
(upconverter mode "auto") directly.
"""
import base64
import json
import os
import queue
import sys
import threading
import time
import wave

import numpy as np
from flask import Flask, Response, jsonify, request, send_from_directory

from paths import BASE, data

VFOS_PATH = data("vfos.json")

# Without arguments and with vfos.json: the launcher, which starts one receiver (process) per VFO.
if __name__ == "__main__" and "--vfo" not in sys.argv and os.path.exists(VFOS_PATH):
    import launcher
    launcher.main()
    sys.exit(0)

import memories
from ft8 import FT8_FREQS, Ft8Decoder
from cw import CwDecoder
from rtty import RttyDecoder
from daylog import DayLog, TextLog
from wefax import WefaxDecoder
from sstv import SstvDecoder
from acars import ACARS_FREQS, AcarsDecoder
from sdr import MODES, SQUELCH_OFF, UPCONV_MAX_HZ, ZOOMS, Receiver, list_devices, lowpass


def vfo_from_args():
    """--vfo NAME: this process is the receiver of VFO NAME from vfos.json (own dongle, port, settings)."""
    if "--vfo" not in sys.argv:
        return None
    name = sys.argv[sys.argv.index("--vfo") + 1]
    with open(VFOS_PATH, encoding="utf-8") as f:
        return next(v for v in json.load(f)["vfos"] if v["name"] == name)


VFO = vfo_from_args()
CONFIG_PATH = data(VFO["config"] if VFO else "config.json")
SAMPLE_RATES = (1024000, 1536000, 2048000, 2400000)
UPCONV_MODES = ("auto", "on", "off")


def load_config():
    with open(CONFIG_PATH, encoding="utf-8") as f:
        return json.load(f)


class Hub:
    """Broadcasts waterfall/state (SSE) and audio (HTTP stream) to connected browsers."""

    def __init__(self):
        self.lock = threading.Lock()
        self.events = []
        self.audio = []

    def _add(self, lst, maxsize):
        q = queue.Queue(maxsize=maxsize)
        with self.lock:
            lst.append(q)
        return q

    def _remove(self, lst, q):
        with self.lock:
            if q in lst:
                lst.remove(q)

    @staticmethod
    def _put(qs, item):
        for q in qs:
            try:
                q.put_nowait(item)
            except queue.Full:
                # Slow client: drop the oldest item so the delay does not grow.
                try:
                    q.get_nowait()
                    q.put_nowait(item)
                except (queue.Empty, queue.Full):
                    pass

    def event(self, kind, data):
        with self.lock:
            qs = list(self.events)
        self._put(qs, (kind, json.dumps(data)))

    def audio_chunk(self, pcm):
        with self.lock:
            qs = list(self.audio)
        self._put(qs, pcm)


cfg = load_config()
if VFO:
    cfg["vfo"], cfg["serial"], cfg["port"] = VFO["name"], VFO["serial"], VFO["port"]
    cfg["driver"] = VFO.get("driver", "rtl")
hub = Hub()
save_lock = threading.Lock()
save_timer = None


def save_config_later():
    """Saves the settings (frequency, mode…) with a delay, so tuning does not write all the time."""
    global save_timer

    def save():
        with save_lock:
            tmp = CONFIG_PATH + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(cfg, f, indent=2, ensure_ascii=False)
            os.replace(tmp, CONFIG_PATH)

    if save_timer:
        save_timer.cancel()
    save_timer = threading.Timer(2.0, save)
    save_timer.daemon = True
    save_timer.start()


# ---------- daily decoder logs (turned on with LOG in the decoder card) ----------

LOG_KEYS = ("ft8", "wefax", "cw", "rtty", "sstv", "acars")
_tag = cfg.get("vfo") or ""
logs = {"ft8": DayLog("ft8", _tag), "wefax": DayLog("wefax", _tag), "sstv": DayLog("sstv", _tag),
        "cw": TextLog("cw", _tag), "rtty": TextLog("rtty", _tag)}
_saved_logged = {"wefax": None, "sstv": None}


def log_on(key):
    return bool(cfg.get("logs", {}).get(key, False))


def _mhz(hz):
    return f"{hz / 1e6:.6f} MHz"


def decoder_event(kind, data):
    """Decoder event to the browser and (if LOG is on) a line to the daily log."""
    hub.event(kind, data)
    try:
        if kind == "ft8" and log_on("ft8"):
            logs["ft8"].write(f"{_mhz(data['freq_hz'])} {data['snr']:+d} dB DT {data['dt']:+.1f} "
                              f"{data['df']} Hz | {data['msg']}")
        elif kind == "cwtext" and log_on("cw"):
            f = cw.dial + (cw.tone or 0.0)
            logs["cw"].add(data["t"], f"{_mhz(f)} {round(1200 / cw.dot_ms)} WPM")
        elif kind == "rttytext" and log_on("rtty"):
            logs["rtty"].add(data["t"], f"{_mhz(cfg['tune_hz'])} {cfg['mode']} {rtty.baud} Bd "
                                        f"{round(rtty.shift or 0)} Hz")
        elif kind in ("sstvdone", "wefaxstate", "wefaxnew"):
            # an image was just saved: file name to the log (each only once)
            key = "sstv" if kind == "sstvdone" else "wefax"
            dec = sstv if key == "sstv" else wefax
            name = getattr(dec, "saved", None)
            if name and name != _saved_logged[key]:
                _saved_logged[key] = name
                if log_on(key):
                    logs[key].write(f"{_mhz(cfg['tune_hz'])} {cfg['mode']} | saved {key}/{name}")
    except Exception:
        pass            # a log error must not stop the decoder


ft8 = Ft8Decoder(on_decode=lambda d: decoder_event("ft8", d),
                 on_cycle=lambda t: hub.event("ft8cycle", {"time": t}))


wefax = WefaxDecoder(on_event=decoder_event)
cw = CwDecoder(on_event=decoder_event)
rtty = RttyDecoder(on_event=decoder_event)
sstv = SstvDecoder(on_event=decoder_event)
acars = AcarsDecoder(on_event=hub.event, tag=_tag)
acars.log_on = log_on("acars")
_saved_logged.update(wefax=getattr(wefax, "saved", None), sstv=getattr(sstv, "saved", None))


def tx_capable():
    """The VFO can transmit (LimeSDR); transmitting must still be enabled in SET (tx_enabled)."""
    return cfg.get("driver") == "lime" or hasattr(receiver.sdr, "tx_start")


def state():
    capable = tx_capable()
    return dict(receiver.state(), ft8=ft8.enabled, ft8_error=ft8.error, wefax=wefax.enabled, cw=cw.enabled, rtty=rtty.enabled,
                sstv=sstv.enabled, acars=acars.enabled, logs={k: log_on(k) for k in LOG_KEYS},
                tx_capable=capable, tx_enabled=bool(cfg.get("tx_enabled", False)),
                can_tx=capable and bool(cfg.get("tx_enabled", False)) and hasattr(receiver.sdr, "tx_start"))


def cw_band():
    """Where to look for the CW tone relative to the tuned frequency: in the passband of the current mode."""
    mode = cfg["mode"]
    bw = float(cfg.get("bandwidth", {}).get(mode, 3000))
    if mode == "USB":
        return (150.0, bw)
    if mode == "LSB":
        return (-bw, -150.0)
    return (-bw / 2, bw / 2)


def on_baseband(base, fs, dial_hz):
    ft8.feed(base, fs, dial_hz)
    wefax.feed(base, fs, dial_hz)
    if cw.enabled:
        cw.feed(base, fs, dial_hz, cw_band())
    if rtty.enabled:
        rtty.feed(base, fs, dial_hz, cw_band())
    acars.feed(base, fs, dial_hz)


receiver = Receiver(
    cfg,
    on_row=lambda row, center, span: hub.event("wf", {"c": center, "span": span, "row": base64.b64encode(row).decode()}),
    on_audio=hub.audio_chunk,
    on_status=lambda: hub.event("status", state()),
    on_baseband=on_baseband,
    on_demod=sstv.feed,
)
ft8.set_enabled(cfg.get("ft8", False))
wefax.set_enabled(cfg.get("wefax", False))
cw.set_enabled(cfg.get("cw", False))
try:
    rtty.set_options(cfg.get("rtty_opts") or {})
except (TypeError, ValueError):
    pass
rtty.set_enabled(cfg.get("rtty", False))
sstv.set_enabled(cfg.get("sstv", False))
acars.set_enabled(cfg.get("acars", False))

app = Flask(__name__, static_folder="static")


@app.after_request
def cors(resp):
    # The VFO page runs on the launcher's port and talks to the receivers of the individual VFOs through their ports.
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PATCH, DELETE, OPTIONS"
    resp.headers["Access-Control-Expose-Headers"] = "X-Sample-Rate, X-Channels"
    return resp


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/state")
def api_state():
    return jsonify(dict(state(), sample_rates=SAMPLE_RATES, modes=MODES, ft8_freqs=FT8_FREQS, acars_freqs=ACARS_FREQS))


# ---------- transmitting (PTT) ----------
# While PTT is held the browser sends {"ptt": true} every ~300 ms. If they stop coming (closed tab,
# lost connection, missed key release), a watchdog turns transmitting off within TX_HOLD_S. TX_MAX_S is
# a fixed limit for one transmission.
TX_HOLD_S = 1.5
TX_MAX_S = 120
# Transmitting is off by default; it is enabled in SET (cfg "tx_enabled", LimeSDR only).
# In FM mode PTT transmits the test message from tx_audio/test_message.wav in a loop (if it exists),
# otherwise an unmodulated carrier.
TX_AUDIO = data("tx_audio", "test_message.wav")
TX_FM_DEV = 2500.0     # deviation for a 12.5 kHz channel
TX_GAP_S = 0.7         # silence between repetitions of the message
tx_lock = threading.Lock()
tx_seen = 0.0
tx_since = 0.0
tx_audio = None


def load_tx_audio():
    """WAV (mono, 16 bit) -> (audio ±1 limited to 3 kHz, sample rate); loaded once."""
    global tx_audio
    if tx_audio is None:
        with wave.open(TX_AUDIO) as w:
            rate = w.getframerate()
            x = np.frombuffer(w.readframes(w.getnframes()), "<i2").reshape(-1, w.getnchannels())
        x = x.mean(axis=1).astype(np.float32)
        x = np.convolve(x, lowpass(3000.0, rate, 127), mode="same")
        x /= max(float(np.abs(x).max()), 1e-9)
        x = np.concatenate((x, np.zeros(int(TX_GAP_S * rate), np.float32)))
        tx_audio = (x, rate)
    return tx_audio


def tx_off(reason):
    sdr = receiver.sdr
    if sdr is not None and getattr(sdr, "tx_on", False):
        sdr.tx_stop()
        print(f"TX off ({reason})", flush=True)
        hub.event("status", state())


def tx_watchdog():
    while True:
        time.sleep(0.2)
        with tx_lock:
            sdr = receiver.sdr
            if sdr is None or not getattr(sdr, "tx_on", False):
                continue
            now = time.time()
            if now - tx_seen > TX_HOLD_S:
                tx_off("no PTT keepalive")
            elif now - tx_since > TX_MAX_S:
                tx_off("time limit")


@app.route("/api/tx", methods=["POST"])
def api_tx():
    global tx_seen, tx_since
    body = request.get_json(force=True, silent=True) or {}
    sdr = receiver.sdr
    if sdr is None or not hasattr(sdr, "tx_start"):
        return jsonify(error="this VFO cannot transmit"), 400
    if body.get("ptt") and not cfg.get("tx_enabled", False):
        return jsonify(error="TX is disabled (enable it in SET)"), 400
    with tx_lock:
        if not body.get("ptt"):
            tx_off("PTT released")
            return jsonify(state())
        if receiver.lo:
            return jsonify(error="TX only without the upconverter (set upconverter OFF)"), 400
        tx_seen = time.time()
        if not sdr.tx_on:
            try:
                fm = None
                if cfg["mode"] == "FM" and os.path.exists(TX_AUDIO):
                    audio, rate = load_tx_audio()
                    fm = (audio, rate, TX_FM_DEV)
                info = sdr.tx_start(float(cfg["tune_hz"]), fm=fm)
            except Exception as e:
                return jsonify(error=str(e)), 500
            tx_since = tx_seen
            print(f"TX on {info}", flush=True)
            hub.event("status", state())
    return jsonify(state())


threading.Thread(target=tx_watchdog, name="tx-watchdog", daemon=True).start()


@app.route("/api/ft8")
def api_ft8():
    return jsonify(list(ft8.decodes))


@app.route("/api/wefax", methods=["GET"])
def api_wefax():
    return jsonify(wefax.info())


@app.route("/api/wefax", methods=["POST"])
def api_wefax_cmd():
    try:
        wefax.command(request.get_json(force=True))
    except (TypeError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(wefax.info())


@app.route("/api/wefax/image.png")
def api_wefax_image():
    png = wefax.image_png()
    if png is None:
        return "", 204
    return Response(png, mimetype="image/png", headers={"Cache-Control": "no-store"})


@app.route("/api/sstv", methods=["GET"])
def api_sstv():
    return jsonify(sstv.info())


@app.route("/api/sstv", methods=["POST"])
def api_sstv_cmd():
    try:
        sstv.command(request.get_json(force=True))
    except (TypeError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    return jsonify(sstv.info())


@app.route("/api/sstv/image.png")
def api_sstv_image():
    png = sstv.image_png()
    if png is None:
        return "", 204
    return Response(png, mimetype="image/png", headers={"Cache-Control": "no-store"})


@app.route("/api/sstv/files/<name>")
def api_sstv_file(name):
    return send_from_directory(sstv.save_dir, name)


@app.route("/api/cw", methods=["GET"])
def api_cw():
    return jsonify(cw.info())


@app.route("/api/cw", methods=["POST"])
def api_cw_cmd():
    if request.get_json(force=True).get("action") == "clear":
        cw.clear()
    return jsonify(cw.info())


@app.route("/api/rtty", methods=["GET"])
def api_rtty():
    return jsonify(rtty.info())


@app.route("/api/rtty", methods=["POST"])
def api_rtty_cmd():
    body = request.get_json(force=True)
    if body.get("action") == "clear":
        rtty.clear()
    if "opts" in body:
        try:
            rtty.set_options(body["opts"])
        except (TypeError, ValueError):
            return jsonify({"error": "bad RTTY option"}), 400
        cfg["rtty_opts"] = rtty.opts
        save_config_later()
    return jsonify(rtty.info())


@app.route("/api/acars", methods=["GET"])
def api_acars():
    return jsonify(acars.info())


@app.route("/api/acars", methods=["POST"])
def api_acars_cmd():
    if request.get_json(force=True).get("action") == "clear":
        acars.clear()
    return jsonify(acars.info())


@app.route("/api/devices")
def api_devices():
    try:
        return jsonify(list_devices())
    except OSError as e:  # librtlsdr.dll missing etc.
        return jsonify({"error": str(e)}), 500


@app.route("/api/memories", methods=["GET"])
def api_memories():
    return jsonify(memories.load())


@app.route("/api/memories", methods=["POST"])
def api_memory_add():
    b = request.get_json(force=True)
    try:
        m = memories.make(b.get("name", ""), b.get("group", ""), b["freq_hz"], b["mode"], b.get("bw", 3000))
    except (KeyError, TypeError, ValueError) as e:
        return jsonify({"error": str(e) or "invalid entry"}), 400
    return jsonify(memories.add(m))


@app.route("/api/memories/<mid>", methods=["PATCH"])
def api_memory_update(mid):
    m = memories.update(mid, request.get_json(force=True))
    return (jsonify(m), 200) if m else (jsonify({"error": "not found"}), 404)


@app.route("/api/memories/<mid>", methods=["DELETE"])
def api_memory_delete(mid):
    return (jsonify({"ok": True}), 200) if memories.delete(mid) else (jsonify({"error": "not found"}), 404)


@app.route("/api/set", methods=["POST"])
def api_set():
    body = request.get_json(force=True)
    changes = {}
    try:
        for k in ("tune_hz", "center_hz", "lo_offset_hz", "view_hz"):
            if k in body:
                changes[k] = float(body[k])
        if not 0 <= changes.get("lo_offset_hz", 0) <= 1e9:
            raise ValueError("upconverter LO must be 0 to 1000 MHz")
        if "upconv" in body:
            if body["upconv"] not in UPCONV_MODES:
                raise ValueError("unknown upconverter mode")
            changes["upconv"] = body["upconv"]
        if "tune_hz" in changes or "upconv" in changes:
            # HF below the tuner's lower limit (R820T 24 MHz, LimeSDR Mini 10 MHz) can only be received through
            # an upconverter; upper limit R820T 1766 MHz, LimeSDR Mini 3500 MHz.
            tune = changes.get("tune_hz", cfg["tune_hz"])
            mode = changes.get("upconv", cfg.get("upconv", "auto"))
            lo = 0.0 if mode == "off" or (mode == "auto" and tune >= UPCONV_MAX_HZ) else cfg.get("lo_offset_hz", 0)
            tmin, tmax = receiver.tuner_min, receiver.tuner_max
            if "max_hz" in cfg and tune > cfg["max_hz"]:
                raise ValueError(f"this VFO tunes only up to {cfg['max_hz'] / 1e6:g} MHz")
            if tune < 0 or (lo == 0 and tune < tmin) or tune + lo > tmax:
                raise ValueError("frequency out of range" if lo or tune >= tmin
                                 else f"below {tmin / 1e6:g} MHz an upconverter is needed (enable it in SET)")
        if "device" in body:
            changes["device"] = int(body["device"])
        if "mode" in body:
            if body["mode"] not in MODES:
                raise ValueError("unknown mode")
            changes["mode"] = body["mode"]
        if "bandwidth" in body:
            bw = float(body["bandwidth"])
            m = changes.get("mode", cfg["mode"])
            lo, hi = {"WFM": (50000, 250000), "FM": (500, 50000)}.get(m, (100, 18000))
            if not lo <= bw <= hi:
                raise ValueError(f"{m} bandwidth must be {lo:g} to {hi:g} Hz")
            changes["bandwidth"] = bw
        if "gain" in body:
            g = body["gain"]
            changes["gain"] = "auto" if g in ("auto", "", None) else float(g)
        if "stereo_on" in body:
            changes["stereo_on"] = bool(body["stereo_on"])
        if "notch" in body:
            changes["notch"] = bool(body["notch"])
        if "audio_agc" in body:
            changes["audio_agc"] = bool(body["audio_agc"])
        if "rtl_agc" in body:
            changes["rtl_agc"] = bool(body["rtl_agc"])
        if "ppm" in body:
            changes["ppm"] = int(body["ppm"])
        if "zoom" in body:
            z = int(body["zoom"])
            if z not in ZOOMS:
                raise ValueError("unsupported zoom")
            changes["zoom"] = z
        if "bias_tee" in body:
            changes["bias_tee"] = bool(body["bias_tee"])
        if "squelch" in body:
            changes["squelch"] = min(max(float(body["squelch"]), SQUELCH_OFF), 0.0)
            if body.get("squelch_mode") in MODES:
                changes["squelch_mode"] = body["squelch_mode"]
        if body.get("reset"):
            changes["reset"] = True
        if "sample_rate" in body:
            sr = int(body["sample_rate"])
            if sr not in SAMPLE_RATES:
                raise ValueError("unsupported sample rate")
            changes["sample_rate"] = sr
    except (TypeError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    if "ft8" in body:
        cfg["ft8"] = bool(body["ft8"])
        ft8.set_enabled(cfg["ft8"])
        save_config_later()
        hub.event("status", state())
    if "wefax" in body:
        cfg["wefax"] = bool(body["wefax"])
        wefax.set_enabled(cfg["wefax"])
        save_config_later()
        hub.event("status", state())
    if "cw" in body:
        cfg["cw"] = bool(body["cw"])
        cw.set_enabled(cfg["cw"])
        save_config_later()
        hub.event("status", state())
    if isinstance(body.get("log"), dict):
        cur = dict(cfg.get("logs", {}))
        for k, v in body["log"].items():
            if k in LOG_KEYS:
                cur[k] = bool(v)
                if not v and k in ("cw", "rtty"):
                    logs[k].flush()          # write out the unfinished line
        cfg["logs"] = cur
        acars.log_on = log_on("acars")
        save_config_later()
        hub.event("status", state())
    if "rtty" in body:
        cfg["rtty"] = bool(body["rtty"])
        rtty.set_enabled(cfg["rtty"])
        save_config_later()
        hub.event("status", state())
    if "tx_enabled" in body:
        if not tx_capable():
            return jsonify({"error": "this VFO cannot transmit"}), 400
        cfg["tx_enabled"] = bool(body["tx_enabled"])
        if not cfg["tx_enabled"]:
            with tx_lock:
                tx_off("TX disabled")
        save_config_later()
        hub.event("status", state())
    if "sstv" in body:
        cfg["sstv"] = bool(body["sstv"])
        sstv.set_enabled(cfg["sstv"])
        save_config_later()
        hub.event("status", state())
    if "acars" in body:
        cfg["acars"] = bool(body["acars"])
        acars.set_enabled(cfg["acars"])
        save_config_later()
        hub.event("status", state())
    receiver.update(changes)
    if set(changes) - {"reset"}:
        save_config_later()
    return jsonify({"ok": True})


@app.route("/api/events")
def api_events():
    q = hub._add(hub.events, 60)

    def gen():
        try:
            yield "retry: 2000\n\n"
            yield f"event: status\ndata: {json.dumps(state())}\n\n"
            while True:
                try:
                    kind, data = q.get(timeout=15)
                    yield f"event: {kind}\ndata: {data}\n\n"
                except queue.Empty:
                    yield ": ping\n\n"
        finally:
            hub._remove(hub.events, q)

    return Response(gen(), mimetype="text/event-stream",
                    headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/api/audio")
def api_audio():
    """Endless stream of 16-bit stereo PCM (L, R interleaved, little endian) at audio_rate."""
    q = hub._add(hub.audio, 12)

    def gen():
        try:
            while True:
                try:
                    yield q.get(timeout=5)
                except queue.Empty:
                    yield b""
        finally:
            hub._remove(hub.audio, q)

    return Response(gen(), mimetype="application/octet-stream",
                    headers={"Cache-Control": "no-cache", "X-Sample-Rate": str(int(receiver.state()["audio_rate"])),
                             "X-Channels": "2"})


def exit_with_parent():
    """The VFO process ends when the launcher ends (its input is closed)."""
    sys.stdin.read()
    os._exit(0)


if __name__ == "__main__":
    if VFO:
        threading.Thread(target=exit_with_parent, daemon=True).start()
    receiver.start()
    try:
        port = int(cfg.get("port", 8434))
        print(f"RADIMCOM: http://localhost:{port}")
        app.run(host=cfg.get("host", "0.0.0.0"), port=port, threaded=True, use_reloader=False)
    finally:
        receiver.stop()
