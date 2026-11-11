"""RADIMCOM: RTL-SDR (HF via upconverter, VHF/UHF direct), waterfall, tuning and audio in the browser.

Frequencies in the interface are real frequencies. On HF the dongle is tuned to the frequency
+ lo_offset_hz (upconverter LO, e.g. 100 MHz: 3.6 MHz -> 103.6 MHz), above 30 MHz
(upconverter mode "auto") directly.
"""
import base64
import json
import os
import queue
import re
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

import location
import memories
import scanner as scanner_mod
import satellites
import sysload
import update_check
try:
    import sattrack       # needs the sgp4 package (upgrade.bat installs it)
    import satplan
except ImportError:
    sattrack = None
from ft8 import FT8_FREQS, Ft8Decoder
from cw import CwDecoder
from rtty import RttyDecoder
from packet import PacketDecoder
from daylog import DayLog, TextLog
import recorder as recorder_mod
from recorder import Recorder
import rotor as rotor_module
from wefax import WefaxDecoder
from sstv import SstvDecoder
from acars import ACARS_FREQS, AcarsDecoder
from vdl2 import VDL2_CENTER, VDL2_RATE, VDL2_REGIONS, Vdl2Decoder, region_freqs
from dsd import PROTOCOLS as DSD_PROTOCOLS, SLOTS as DSD_SLOTS, DsdDecoder
from dab import CHANNEL_HZ, DAB_CHANNELS, DAB_DEFAULT, DAB_RATE, DabDecoder
from ism import ISM_DEFAULT, ISM_FREQS, ISM_RATE, IsmDecoder
import hfdl as hfdl_mod
from hfdl import HfdlDecoder
import ais as ais_mod
from ais import AisDecoder
from tonesq import norm_ctcss, norm_dcs
from sdr import (AFI_MAX_HZ, AFI_MIN_HZ, ASQ_MAX_DB, ASQ_MIN_DB, DECIM, DSD_MODE, HPF_MAX_HZ, HPF_MIN_HZ, LPF_MAX_HZ, LPF_MIN_HZ, MODES, SQUELCH_OFF,
                 SAGC_PARAMS, UPCONV_MAX_HZ, ZOOMS, Receiver, list_devices, lowpass, sagc_params)


def vfo_from_args():
    """--vfo NAME: this process is the receiver of VFO NAME from vfos.json (own dongle, port, settings)."""
    if "--vfo" not in sys.argv:
        return None
    name = sys.argv[sys.argv.index("--vfo") + 1]
    with open(VFOS_PATH, encoding="utf-8") as f:
        vfos = json.load(f)["vfos"]
    return next(v for v in vfos if v["name"] == name), vfos


VFO, ALL_VFOS = vfo_from_args() or (None, [])
# VFO chaining (iqshare.py): "chain": "A" in vfos.json = this VFO uses the dongle of VFO A.
OWNER = next((v for v in ALL_VFOS if VFO and v["name"] == VFO.get("chain")), None)
CHAINED = [v["name"] for v in ALL_VFOS if VFO and v.get("chain") == VFO["name"]]   # VFOs fed by this one
# dongle settings: on a chained VFO they are sent to the owner VFO, which applies them to the dongle
DONGLE_KEYS = ("gain", "rtl_agc", "smart_agc", "sagc", "bias_tee", "ppm", "sample_rate")
CONFIG_PATH = data(VFO["config"] if VFO else "config.json")
SAMPLE_RATES = (1024000, 1536000, 2048000, 2100000, 2400000)   # 2.1 MS/s = VDL2 (105 kS/s × 20)
# The Airspy R2 has fixed rates; its 10 MS/s is not offered, the DSP is not made for it (audio = rate / DECIM).
DRIVER_SAMPLE_RATES = {"airspy": (2500000,)}
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
if cfg.get("tx_enabled") and not cfg.get("tx_ack_at"):
    cfg["tx_enabled"] = False      # enabled before the disclaimer existed: it has to be accepted first
if VFO:
    dongle = OWNER or VFO
    cfg["vfo"], cfg["serial"], cfg["port"] = VFO["name"], dongle.get("serial", ""), VFO["port"]
    cfg["driver"] = dongle.get("driver", "rtl")
    if OWNER:
        import iqshare
        cfg["chain"] = {"owner": OWNER["name"], "port": iqshare.iq_port(OWNER)}
        cfg["vdl2"] = False          # VDL2 needs its own centre and sample rate
        cfg["dab"] = False           # DAB too
        cfg["ism"] = False           # ISM too
    else:
        cfg.pop("chain", None)
RTL_DONGLE = cfg.get("driver", "rtl") == "rtl"   # VDL2, DAB and ISM need the rates and raw samples of an RTL dongle
if not RTL_DONGLE:
    cfg["vdl2"] = cfg["dab"] = cfg["ism"] = False
if cfg.get("driver") in DRIVER_SAMPLE_RATES:
    SAMPLE_RATES = DRIVER_SAMPLE_RATES[cfg["driver"]]
    if cfg["sample_rate"] not in SAMPLE_RATES:
        cfg["sample_rate"] = SAMPLE_RATES[0]
if cfg.get("vdl2") and cfg.get("center_hz") == 136850000:
    cfg["center_hz"] = float(VDL2_CENTER)     # VDL2 left on with the centre of older versions: now a channel, on the DC spike
    cfg["tune_hz"] = float(VDL2_CENTER)
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
                f.flush()
                os.fsync(f.fileno())     # without it a power cut can leave a file full of zero bytes
            try:                         # previous good version → .bak (launcher restores it if the file breaks)
                with open(CONFIG_PATH, encoding="utf-8") as f:
                    old = f.read()
                json.loads(old)
                with open(CONFIG_PATH + ".bak", "w", encoding="utf-8") as f:
                    f.write(old)
                    f.flush()
                    os.fsync(f.fileno())
            except (OSError, ValueError):
                pass
            os.replace(tmp, CONFIG_PATH)

    if save_timer:
        save_timer.cancel()
    save_timer = threading.Timer(2.0, save)
    save_timer.daemon = True
    save_timer.start()


# ---------- daily decoder logs (turned on with LOG in the decoder card) ----------

LOG_KEYS = ("ft8", "wefax", "cw", "rtty", "sstv", "acars", "dsd", "ism", "packet", "hfdl", "ais")
_tag = cfg.get("vfo") or ""
logs = {"ft8": DayLog("ft8", _tag), "wefax": DayLog("wefax", _tag), "sstv": DayLog("sstv", _tag), "dsd": DayLog("dsd", _tag), "ism": DayLog("ism", _tag), "packet": DayLog("packet", _tag), "hfdl": DayLog("hfdl", _tag), "ais": DayLog("ais", _tag),
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
        elif kind == "dsdcall" and log_on("dsd"):
            slot = f" slot {data['slot']}" if data["slot"] else ""
            alias = f" | {data['alias']}" if data["alias"] else ""
            logs["dsd"].write(f"{_mhz(data['freq_hz'])} {data['proto']}{slot} {data['type'] or 'call'} to {data['tgt'] or '?'} "
                              f"from {data['src'] or '?'} {data['duration']:.1f} s{' ENC' if data['enc'] else ''}{alias}")
        elif kind == "ism" and data["n"] == 1 and log_on("ism"):     # a repeated message only once
            dev = f" id {data['dev_id']}" if data["dev_id"] else ""
            ch = f" ch {data['channel']}" if data["channel"] else ""
            rssi = f" {data['rssi']} dB" if data["rssi"] is not None else ""
            logs["ism"].write(f"{_mhz(data['freq_hz'])}{rssi} {data['model']}{dev}{ch} | {data['text']}")
        elif kind == "hfdl" and log_on("hfdl"):
            who = " ".join(x for x in (data["flight"], data["reg"], data["icao"] and f"ICAO {data['icao']}") if x)
            pos = f" pos {data['lat']:.3f} {data['lon']:.3f}" if data["lat"] is not None else ""
            lbl = f" label {data['label']}" if data["label"] else ""
            sig = f" {data['sig']} dB" if data["sig"] is not None else ""
            text = data["text"].replace("\n", " / ")
            logs["hfdl"].write(f"{_mhz(data['freq_hz'])}{sig} {'↓' if data['dir'] == 'down' else '↑'} {data['gs'] or '?'} "
                               f"{who or '-'} {data['kind']}{lbl}{pos}" + (f" | {text}" if text else ""))
        elif kind == "ais" and log_on("ais"):
            who = " ".join(x for x in (f"MMSI {data['mmsi']}", data["name"] and f"'{data['name']}'", data["callsign"]) if x)
            pos = f" pos {data['lat']:.4f} {data['lon']:.4f}" if data["lat"] is not None else ""
            nav = " ".join(x for x in (data["sog"] is not None and f"{data['sog']} kt", data["cog"] is not None and f"COG {data['cog']}°",
                                       data["hdg"] is not None and f"HDG {data['hdg']}°") if x)
            lvl = f" {data['level']} dB" if data["level"] is not None else ""
            logs["ais"].write(f"{_mhz(data['freq_hz'])}{lvl} ch {data['channel']} {who} {data['type_name']}{pos}"
                              f"{' ' + nav if nav else ''}{' | ' + data['text'] if data['text'] else ''} | {data['nmea']}")
        elif kind == "packet" and log_on("packet"):
            logs["packet"].write(f"{_mhz(data['freq_hz'])} {data['baud']} Bd | {data['tnc2']}")
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


def wefax_retune(old_hz, new_hz):
    """WEFAX AFC: the signal centre is off 1900 Hz -> retune the VFO (USB only; not while the Doppler correction
    or ATU tunes, nor when somebody tuned elsewhere meanwhile). In its own thread: called from the receiver thread."""
    if cfg["mode"] != "USB" or cfg["tune_hz"] != old_hz or receiver.atune.active:
        return
    if doppler is not None and doppler.on:
        return
    threading.Thread(target=rotor_set_freq, args=(float(new_hz),), name="wefax-afc", daemon=True).start()


wefax = WefaxDecoder(on_event=decoder_event, on_retune=wefax_retune)
cw = CwDecoder(on_event=decoder_event)
# Peek CW decoder for the audio spectrum bubble (the CW decoder itself is off): runs only while a browser keeps
# renewing it (POST /api/cw {"action": "peek"}); its text goes only to the bubble, not to the log or the CW card.
cw_peek = CwDecoder(on_event=lambda kind, data: hub.event("cwpeek", data) if kind == "cwtext" else None)
cw_peek_until = 0.0
CW_PEEK_HOLD = 4.0       # s without renewal and the peek decoder stops
rtty = RttyDecoder(on_event=decoder_event)
_qth_cache = [0.0, None]


def own_station():
    """(lat, lon) of the station (MENU › SETUP › LOCATION), for the APRS distances; read at most once a minute."""
    if time.monotonic() - _qth_cache[0] > 60:
        _qth_cache[0] = time.monotonic()
        try:
            st_ = location.load()
            _qth_cache[1] = (float(st_["lat"]), float(st_["lon"]))
        except Exception:
            _qth_cache[1] = None
    return _qth_cache[1]


packet = PacketDecoder(on_event=decoder_event, station=own_station)
sstv = SstvDecoder(on_event=decoder_event)
acars = AcarsDecoder(on_event=hub.event, tag=_tag)
acars.log_on = log_on("acars")
dsd = DsdDecoder(on_event=decoder_event)
if cfg.get("dsd_protocol") in DSD_PROTOCOLS:
    dsd.protocol = cfg["dsd_protocol"]
if cfg.get("dsd_slot") in DSD_SLOTS:
    dsd.slot = cfg["dsd_slot"]
vdl2 = Vdl2Decoder(on_acars=acars.accept_vdl2, on_atn=acars.accept_atn, on_state=lambda i: hub.event("vdl2state", i),
                  on_pos=acars.accept_pos)


def dab_tune(hz):
    """welle-cli asks for a DAB ensemble: the VFO goes there at 2.048 MS/s (called from the rtl_tcp thread)."""
    if cfg.get("tune_hz") != hz or cfg.get("sample_rate") != DAB_RATE:
        receiver.update({"sample_rate": DAB_RATE, "center_hz": float(hz), "tune_hz": float(hz)})
    cfg["dab_channel"] = dab.channel
    save_config_later()


dab = DabDecoder(on_tune=dab_tune, on_state=lambda i: hub.event("dabstate", i))
ism = IsmDecoder(on_event=decoder_event, on_state=lambda i: hub.event("ismstate", i))
hfdl = HfdlDecoder(on_event=decoder_event, on_state=lambda i: hub.event("hfdlstate", i))
ais = AisDecoder(on_event=decoder_event, on_state=lambda i: hub.event("aisstate", i))
_saved_logged.update(wefax=getattr(wefax, "saved", None), sstv=getattr(sstv, "saved", None))


def tx_capable():
    """The VFO can transmit (LimeSDR); transmitting must still be enabled in SET (tx_enabled)."""
    if OWNER:
        return False                 # chained VFO: the owner VFO has the transmitter
    return cfg.get("driver") == "lime" or hasattr(receiver.sdr, "tx_start")


def audio_muted():
    """These decoders work on the raw samples or the baseband; the audio of their VFO would only be noise.
    A running scan pauses ACARS, so its audio is heard (the raw-sample decoders do not let a scan start)."""
    if receiver.scan.on and not (vdl2.enabled or ism.enabled or hfdl.enabled or ais.enabled):
        return False
    return acars.enabled or vdl2.enabled or ism.enabled or hfdl.enabled or ais.enabled


def state():
    capable = tx_capable()
    return dict(receiver.state(), ft8=ft8.enabled, ft8_error=ft8.error, wefax=wefax.enabled, cw=cw.enabled, rtty=rtty.enabled, packet=packet.enabled,
                sstv=sstv.enabled, acars=acars.enabled, vdl2=vdl2.enabled, vdl2_error=vdl2.error, vdl2_region=vdl2.region, cpdlc=acars.cpdlc_on,
                dsd=dsd.info(), dab=dab.enabled, dab_error=dab.error, dab_channel=dab.channel, dab_sids=cfg.get("dab_sids") or {}, ism=ism.enabled, ism_error=ism.error, hfdl=hfdl.enabled, hfdl_error=hfdl.error, ais=ais.enabled, ais_error=ais.error, ism_hz=cfg.get("ism_hz", ISM_DEFAULT), audio_muted=audio_muted(), recording=recorder.state(), logs={k: log_on(k) for k in LOG_KEYS},
                **doppler_trsp(),
                tx_capable=capable, tx_enabled=bool(cfg.get("tx_enabled", False)),
                can_tx=capable and bool(cfg.get("tx_enabled", False)) and hasattr(receiver.sdr, "tx_start"))


def doppler_trsp():
    """Satellite and transponder shown in blue in the name frame of the VFO while the Doppler correction tunes it."""
    if doppler is not None and doppler.on:
        return {"trsp_sat": doppler.name, "trsp_name": doppler.label or "Doppler"}
    return {"trsp_name": "", "trsp_sat": ""}


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
    if receiver.scan.on:
        return                           # SCAN: the decoders of this VFO are paused (they would get every channel)
    ft8.feed(base, fs, dial_hz)
    wefax.feed(base, fs, dial_hz)
    if cw.enabled:
        cw.feed(base, fs, dial_hz, cw_band())
    if cw_peek.enabled:
        if cw.enabled or cfg["mode"] != "CW" or time.monotonic() > cw_peek_until:
            cw_peek.set_enabled(False)
        else:
            cw_peek.feed(base, fs, dial_hz, cw_band())
    if rtty.enabled:
        rtty.feed(base, fs, dial_hz, cw_band())
    if packet.enabled:
        packet.feed(base, fs, dial_hz)
    acars.feed(base, fs, dial_hz)


recorder = Recorder()


def on_audio(pcm):
    if dab.enabled or audio_muted():      # DAB: the audio is welle-cli's MP3
        return
    hub.audio_chunk(pcm)
    recorder.feed(pcm, receiver.fs / DECIM, cfg["tune_hz"], cfg["mode"])


receiver = Receiver(
    cfg,
    on_row=lambda row, center, span, full, full_c, full_span: hub.event("wf", {
        "c": center, "span": span, "row": base64.b64encode(row).decode(),
        **({"fc": full_c, "fspan": full_span, "full": base64.b64encode(full).decode()} if full else {})}),
    on_audio=on_audio,
    on_status=lambda: hub.event("status", state()),
    on_baseband=on_baseband,
    on_demod=lambda audio, fs: None if receiver.scan.on else sstv.feed(audio, fs),
    on_meter=lambda db: hub.event("meter", {"db": round(db, 1)}),
    on_dsd=dsd.process,
)
dsd.set_enabled(cfg["mode"] == DSD_MODE)
ft8.set_enabled(cfg.get("ft8", False))
wefax.slant_ppm = float(cfg.get("wefax_slant_ppm", 0.0))
wefax.afc_vfo = bool(cfg.get("wefax_afc_vfo", True))
wefax.set_enabled(cfg.get("wefax", False))
cw.set_enabled(cfg.get("cw", False))
try:
    rtty.set_options(cfg.get("rtty_opts") or {})
except (TypeError, ValueError):
    pass
rtty.set_enabled(cfg.get("rtty", False))
packet.set_options(cfg.get("packet_opts") or {})
packet.set_enabled(cfg.get("packet", False))
sstv.set_enabled(cfg.get("sstv", False))
acars.set_enabled(cfg.get("acars", False) and not cfg.get("vdl2", False))


def on_raw(raw, fs, center_hz):
    vdl2.feed_raw(raw, fs, center_hz)
    dab.feed_raw(raw, fs, center_hz, receiver.lo)
    ism.feed_raw(raw, fs, center_hz)
    hfdl.feed_raw(raw, fs, center_hz)
    ais.feed_raw(raw, fs, center_hz)


receiver.on_raw = on_raw
receiver.on_spurs = save_config_later
vdl2.set_region(cfg.get("vdl2_region", "eu"))
vdl2.set_enabled(cfg.get("vdl2", False))
acars.set_vdl2(vdl2.enabled)
if cfg.get("dab_channel") in CHANNEL_HZ:
    dab.channel = cfg["dab_channel"]          # the page shows the saved channel also while DAB is off
if cfg.get("dab") and RTL_DONGLE and not OWNER:
    dab.set_enabled(True, cfg.get("dab_channel", DAB_DEFAULT))
if cfg.get("ism") and RTL_DONGLE and not OWNER:
    ism.set_enabled(True)
if cfg.get("hfdl") and not OWNER:
    hfdl.set_enabled(True)
if cfg.get("ais") and not OWNER:
    ais.set_enabled(True)


def sync_cpdlc():
    """The CPDLC card has no button of its own: it runs with either link (ACARS or VDL2)."""
    acars.set_cpdlc(acars.enabled or vdl2.enabled)


sync_cpdlc()

app = Flask(__name__, static_folder="static")


def same_host(req):
    """Only pages of this RADIMCOM may give rotor commands (any port, the VFOs have their own)."""
    from urllib.parse import urlsplit
    origin = req.headers.get("Origin")
    return not origin or urlsplit(origin).hostname == urlsplit(req.host_url).hostname


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


@app.route("/api/update", methods=["GET", "POST"])
def api_update():
    """Newer version on GitHub Releases (update_check.py); POST {"upgrade": true} installs it.
    With the launcher the page asks the launcher instead."""
    if request.method == "POST":
        if VFO:
            return jsonify({"error": "the launcher does the upgrade"}), 409
        if not update_check.same_host(request):
            return jsonify({"error": "the upgrade is accepted only from this RADIMCOM page"}), 403
        if (request.get_json(force=True, silent=True) or {}).get("upgrade"):
            err = update_check.upgrade(shutdown_for_upgrade)
            if err:
                return jsonify({"error": err}), 409
    return jsonify(update_check.info())


@app.route("/api/state")
def api_state():
    return jsonify(dict(state(), sample_rates=SAMPLE_RATES, modes=MODES, ft8_freqs=FT8_FREQS, acars_freqs=ACARS_FREQS,
                        vdl2_freqs=region_freqs(vdl2.region), vdl2_region_freqs={r: region_freqs(r) for r in VDL2_REGIONS}, vdl2_center=VDL2_CENTER, vdl2_rate=VDL2_RATE, tx_bands=TX_BANDS,
                        dab_channels=DAB_CHANNELS, ism_freqs=ISM_FREQS, hfdl_bands=hfdl_mod.BANDS,
                        hfdl_stations=hfdl_mod.STATIONS, ais_center=ais_mod.CENTER_HZ, ais_channels=sorted(ais_mod.CHANNELS)))


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
# !!! DO NOT EXTEND THESE LIMITS. Anyone who modifies or removes them is solely responsible for any
# !!! transmission outside the bands they are licensed for (see LICENSE, "Radio transmission notice").
# TX is allowed only inside these bands (IARU Region 1 / CEPT). The whole emission must fit in:
# the tuned frequency ± TX_EDGE_HZ (FM ±2.5 kHz deviation + 3 kHz audio). Checked here on the server,
# so no client can transmit outside them. National rules may be narrower - the operator is responsible.
TX_BANDS = [
    (1_810_000, 2_000_000, "160 m"),
    (3_500_000, 3_800_000, "80 m"),
    (5_351_500, 5_366_500, "60 m"),
    (7_000_000, 7_200_000, "40 m"),
    (10_100_000, 10_150_000, "30 m"),
    (14_000_000, 14_350_000, "20 m"),
    (18_068_000, 18_168_000, "17 m"),
    (21_000_000, 21_450_000, "15 m"),
    (24_890_000, 24_990_000, "12 m"),
    (26_960_000, 27_410_000, "CB 27 MHz"),
    (28_000_000, 29_700_000, "10 m"),
    (50_000_000, 52_000_000, "6 m"),
    (70_000_000, 70_500_000, "4 m"),
    (144_000_000, 146_000_000, "2 m"),
    (430_000_000, 440_000_000, "70 cm"),
    (446_000_000, 446_200_000, "PMR446"),
    (1_240_000_000, 1_300_000_000, "23 cm"),
]
TX_EDGE_HZ = 5000


def tx_band(hz):
    """Name of the TX band that holds the whole emission at hz, otherwise None."""
    for lo, hi, name in TX_BANDS:
        if lo + TX_EDGE_HZ <= hz <= hi - TX_EDGE_HZ:
            return name
    return None


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
    if body.get("ptt") and cfg["mode"] == DSD_MODE:
        return jsonify(error="no transmitting in the DSD mode (receive only)"), 400
    if body.get("ptt") and not cfg.get("tx_enabled", False):
        return jsonify(error="TX is disabled (enable it in SET)"), 400
    with tx_lock:
        if not body.get("ptt"):
            tx_off("PTT released")
            return jsonify(state())
        if receiver.lo:
            return jsonify(error="TX only without the upconverter (set upconverter OFF)"), 400
        tune = float(cfg["tune_hz"])
        if not tx_band(tune):
            tx_off("out of TX bands")
            return jsonify(error=f"{tune / 1e6:.4f} MHz is outside the allowed TX bands (ham, CB, PMR446)"), 400
        tx_seen = time.time()
        if not sdr.tx_on:
            try:
                fm = None
                if cfg["mode"] == "FM" and os.path.exists(TX_AUDIO):
                    audio, rate = load_tx_audio()
                    fm = (audio, rate, TX_FM_DEV)
                info = sdr.tx_start(tune, fm=fm)
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
    body = request.get_json(force=True)
    try:
        wefax.command(body)
    except (TypeError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    if "slant_ppm" in body:
        cfg["wefax_slant_ppm"] = wefax.slant_ppm     # clock error of this VFO's SDR: kept across restarts
        save_config_later()
    if "afc_vfo" in body:
        cfg["wefax_afc_vfo"] = wefax.afc_vfo
        save_config_later()
    return jsonify(wefax.info())


@app.route("/api/wefax/image.png")
def api_wefax_image():
    png = wefax.image_png()
    if png is None:
        return "", 204
    return Response(png, mimetype="image/png", headers={"Cache-Control": "no-store"})


@app.route("/api/wefax/files/<name>")
def api_wefax_file(name):
    return send_from_directory(wefax.save_dir, name)


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
    global cw_peek_until
    body = request.get_json(force=True)
    action = body.get("action")
    if action == "clear":
        cw.clear()
    elif action == "peek":
        # bubble open (on, renewed every ~2 s) / closed (off); a new opening starts with empty text
        if body.get("on") and not cw.enabled and cfg["mode"] == "CW":
            cw_peek_until = time.monotonic() + CW_PEEK_HOLD
            if not cw_peek.enabled:
                cw_peek.clear()
                cw_peek.set_enabled(True)
        elif cw_peek.enabled:
            cw_peek_until = 0.0
            cw_peek.set_enabled(False)
        return jsonify({"peek": cw_peek.enabled})
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


@app.route("/api/packet", methods=["GET"])
def api_packet():
    return jsonify(packet.info())


@app.route("/api/packet", methods=["POST"])
def api_packet_cmd():
    body = request.get_json(force=True)
    packet.command(body)
    if isinstance(body.get("opts"), dict):
        cfg["packet_opts"] = packet.opts
        save_config_later()
    return jsonify(packet.info(frames=False))


@app.route("/api/acars", methods=["GET"])
def api_acars():
    return jsonify(acars.info())


@app.route("/api/acars", methods=["POST"])
def api_acars_cmd():
    if request.get_json(force=True).get("action") == "clear":
        acars.clear()
    return jsonify(acars.info())


@app.route("/api/cpdlc", methods=["GET"])
def api_cpdlc():
    return jsonify(acars.cpdlc_info())


@app.route("/api/cpdlc", methods=["POST"])
def api_cpdlc_cmd():
    if request.get_json(force=True).get("action") == "clear":
        acars.clear_cpdlc()
    return jsonify(acars.cpdlc_info())


@app.route("/api/dsd", methods=["GET"])
def api_dsd():
    return jsonify(dict(dsd.info(), calls=dsd.history(), protocols=list(DSD_PROTOCOLS), slots=list(DSD_SLOTS)))


@app.route("/api/dsd", methods=["POST"])
def api_dsd_cmd():
    body = request.get_json(force=True)
    protocol, slot = body.get("protocol"), body.get("slot")
    if protocol is not None and protocol not in DSD_PROTOCOLS:
        return jsonify({"error": "unknown DSD protocol"}), 400
    if slot is not None and slot not in DSD_SLOTS:
        return jsonify({"error": "unknown DSD slot"}), 400
    if body.get("action") == "clear":
        dsd.clear()
    if protocol is not None or slot is not None:
        dsd.set_options(protocol, slot)
        cfg["dsd_protocol"], cfg["dsd_slot"] = dsd.protocol, dsd.slot
        save_config_later()
        hub.event("status", state())
    return jsonify(dsd.info())


@app.route("/api/vdl2", methods=["GET"])
def api_vdl2():
    return jsonify(vdl2.info())


def set_vdl2(on, changes):
    """VDL2 on: the VFO goes to 2.1 MS/s around 136.500 MHz (all VDL2 channels of the region), classic ACARS off.
    VDL2 off: the previous sample rate comes back. RTL-SDR only, not on a chained VFO."""
    if on and (not RTL_DONGLE or OWNER):
        on = False
    if on == vdl2.enabled:
        return
    cfg["vdl2"] = on
    if on:
        cfg["vdl2_prev_rate"] = changes.get("sample_rate", cfg["sample_rate"])   # ISM off may have just given it back
        if cfg.get("acars"):
            cfg["acars"] = False
            acars.set_enabled(False)
        changes.update(sample_rate=VDL2_RATE, center_hz=float(VDL2_CENTER), tune_hz=float(VDL2_CENTER), mode="AM")
    elif cfg.get("vdl2_prev_rate") in SAMPLE_RATES and cfg["vdl2_prev_rate"] != VDL2_RATE:
        changes["sample_rate"] = cfg.pop("vdl2_prev_rate")
    vdl2.set_enabled(on)
    acars.set_vdl2(on)


def set_dab(on, changes, channel=None):
    """DAB on: welle-cli starts and the VFO goes to the ensemble at 2.048 MS/s (ACARS and VDL2 off).
    DAB off: the previous sample rate comes back. RTL-SDR only, not on a chained VFO."""
    if on and (not RTL_DONGLE or OWNER):
        on = False
    if on == dab.enabled:
        if on and channel and channel != dab.channel:
            dab.set_channel(channel)
        return
    cfg["dab"] = on
    if on:
        if cfg.get("acars"):
            cfg["acars"] = False
            acars.set_enabled(False)
        set_vdl2(False, changes)
        cfg["dab_prev_rate"] = changes.pop("sample_rate", cfg["sample_rate"])    # VDL2 or ISM off may have just given it back
        ch = channel if channel in CHANNEL_HZ else cfg.get("dab_channel", DAB_DEFAULT)
        f = float(CHANNEL_HZ.get(ch, CHANNEL_HZ[DAB_DEFAULT]))
        changes.update(sample_rate=DAB_RATE, center_hz=f, tune_hz=f)
        dab.set_enabled(True, ch)
    else:
        dab.set_enabled(False)
        if cfg.get("dab_prev_rate") in SAMPLE_RATES and cfg["dab_prev_rate"] != DAB_RATE:
            changes["sample_rate"] = cfg.pop("dab_prev_rate")


def set_ism(on, changes):
    """ISM on: rtl_433 starts, the audio is muted and the VFO goes to the last ISM frequency at 2.048 MS/s (ACARS, VDL2 and DAB off).
    ISM off: the previous sample rate comes back. RTL-SDR only, not on a chained VFO."""
    if on and (not RTL_DONGLE or OWNER):
        on = False
    if on == ism.enabled:
        return
    cfg["ism"] = on
    if on:
        if cfg.get("acars"):
            cfg["acars"] = False
            acars.set_enabled(False)
        set_vdl2(False, changes)
        set_dab(False, changes)
        sync_cpdlc()
        cfg["ism_prev_rate"] = changes.pop("sample_rate", cfg["sample_rate"])
        f = float(cfg.get("ism_hz", ISM_DEFAULT))
        changes.update(sample_rate=ISM_RATE, center_hz=f, tune_hz=f, mode="AM")
    elif cfg.get("ism_prev_rate") in SAMPLE_RATES and cfg["ism_prev_rate"] != ISM_RATE:
        changes["sample_rate"] = cfg.pop("ism_prev_rate")
    ism.set_enabled(on)


@app.route("/api/hfdl", methods=["GET"])
def api_hfdl():
    return jsonify(dict(hfdl.info(), messages=hfdl.messages()))


@app.route("/api/hfdl", methods=["POST"])
def api_hfdl_cmd():
    if request.get_json(force=True).get("action") == "clear":
        hfdl.clear()
    return jsonify(hfdl.info())


def set_hfdl(on):
    """HFDL on: dumphfdl decodes all HFDL channels inside the band the VFO receives and the audio of the VFO is muted
    (like ACARS / VDL2: the decoder does not use it). The sample rate and centre stay; the band buttons set the centre.
    Not on a chained VFO: the owner VFO decides its centre."""
    on = bool(on) and not OWNER
    cfg["hfdl"] = on
    hfdl.set_enabled(on)


@app.route("/api/ais", methods=["GET"])
def api_ais():
    return jsonify(dict(ais.info(), messages=ais.messages(), ships=ais.ship_list()))


@app.route("/api/ais", methods=["POST"])
def api_ais_cmd():
    if request.get_json(force=True).get("action") == "clear":
        ais.clear()
    return jsonify(ais.info())


def set_ais(on):
    """AIS on: the AIS channels (161.975 / 162.025 MHz) inside the band the VFO receives are decoded from the raw samples
    and the audio of the VFO is muted (like HFDL). The sample rate and centre stay; the 162.000 button centres the VFO
    between the two channels. Not on a chained VFO: the owner VFO decides its centre."""
    on = bool(on) and not OWNER
    cfg["ais"] = on
    ais.set_enabled(on)


@app.route("/api/ism", methods=["GET"])
def api_ism():
    return jsonify(dict(ism.info(), messages=ism.messages()))


@app.route("/api/ism", methods=["POST"])
def api_ism_cmd():
    if request.get_json(force=True).get("action") == "clear":
        ism.clear()
    return jsonify(ism.info())


@app.route("/api/dab")
def api_dab():
    return jsonify(dab.mux())


@app.route("/api/dab/slide/<sid>")
def api_dab_slide(sid):
    r = dab.slide(sid)
    if r is None:
        return "", 204
    return Response(r[0], mimetype=r[1], headers={"Cache-Control": "no-store"})


@app.route("/api/dab/audio/<sid>")
def api_dab_audio(sid):
    try:
        gen = dab.audio(sid)
    except OSError as e:
        return jsonify({"error": f"DAB audio: {e}"}), 503
    return Response(gen, mimetype="audio/mpeg", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.route("/api/sysload")
def api_sysload():
    """CPU load and memory use of the PC (indicator under the S-meter)."""
    return jsonify(sysload.load())


@app.route("/api/devices")
def api_devices():
    try:
        return jsonify(list_devices())
    except OSError as e:  # librtlsdr.dll missing etc.
        return jsonify({"error": str(e)}), 500


@app.route("/api/dongles")
def api_dongles():
    """SETTINGS › SDR DONGLE › ADVANCED: the dongles in vfos.json with their VFOs and the connected RTL dongles."""
    try:
        with open(VFOS_PATH, encoding="utf-8") as f:
            vfos = json.load(f).get("vfos", [])
    except (OSError, ValueError):
        vfos = []
    out = {"vfos": [{k: v.get(k) for k in ("name", "serial", "driver", "chain", "note")} for v in vfos],
           "connected": [], "error": None}
    try:
        out["connected"] = list_devices()
    except OSError as e:  # librtlsdr.dll missing etc.
        out["error"] = str(e)
    return jsonify(out)


@app.route("/api/satellites", methods=["GET", "POST"])
def api_satellites():
    """SATELLITES tab: the lists from amsat.org; POST downloads them again."""
    return jsonify(satellites.load(refresh=request.method == "POST"))


SGP4_MISSING = {"error": "the sgp4 package is not installed: run upgrade.bat"}


@app.route("/api/sat/passes")
def api_sat_passes():
    """Timeline: passes of the chosen satellites over the next hours (default 48)."""
    if sattrack is None:
        return jsonify(SGP4_MISSING), 503
    try:
        hours = float(request.args.get("hours", 48))
    except ValueError:
        return jsonify({"error": "hours must be a number"}), 400
    return jsonify(sattrack.passes(hours))


@app.route("/api/sat/pass")
def api_sat_pass():
    """One pass in detail: samples every 5 s (azimuth, elevation, range, range rate, Doppler shift per MHz)."""
    if sattrack is None:
        return jsonify(SGP4_MISSING), 503
    try:
        return jsonify(sattrack.pass_detail(request.args["norad"], request.args["aos"], request.args["los"]))
    except KeyError as e:
        return jsonify({"error": f"missing or unknown: {e}"}), 404
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/sat/map")
def api_sat_map():
    """World map: ground tracks of the satellites chosen for the map, half an orbit back to one orbit ahead."""
    if sattrack is None:
        return jsonify(SGP4_MISSING), 503
    return jsonify(sattrack.world_map())


@app.route("/api/sat/transmitters")
def api_sat_transmitters():
    """Active transmitters of one satellite with a downlink (SatNOGS DB, kept for 7 days); ?refresh=1 downloads again."""
    if sattrack is None:
        return jsonify(SGP4_MISSING), 503
    try:
        norad = int(request.args["norad"])
    except (KeyError, ValueError):
        return jsonify({"error": "norad must be a number"}), 400
    return jsonify(sattrack.transmitters(norad, refresh=bool(request.args.get("refresh"))))


@app.route("/api/sat/doppler", methods=["GET", "POST"])
def api_sat_doppler():
    """Doppler correction of this VFO: GET the state; POST {"stop": true} or
    {"start": {"norad", "uuid"} or {"norad", "f_hz"}, "set_mode": true/false}."""
    if sattrack is None:
        return jsonify(SGP4_MISSING), 503
    if request.method == "POST":
        body = request.get_json(force=True) or {}
        if body.get("stop"):
            doppler.stop("stopped by hand")
        start = body.get("start")
        if start:
            try:
                norad = int(start["norad"])
                name = next((r["name"] for r in sattrack.catalog()["sats"] if r["norad"] == norad), "")
                if start.get("uuid"):
                    t = sattrack.transmitter(norad, start["uuid"])
                    if not t:
                        return jsonify({"error": "unknown transmitter"}), 404
                    lo, hi = float(t["downlink_low"]), float(t["downlink_high"] or 0) or None
                    f, span, label, mode = (lo + hi) / 2 if hi else lo, (lo, hi), t["description"], t["rx_mode"]
                else:
                    f = float(start["f_hz"])
                    span, label, mode = (None, None), f"{f / 1e6:.4f} MHz", None
                    if not 1e6 <= f <= 6e9:
                        raise ValueError("frequency 1 MHz to 6 GHz")
            except (KeyError, TypeError, ValueError) as e:
                return jsonify({"error": f"wrong start: {e}"}), 400
            err = doppler.start(norad, f, name, label, start.get("uuid", ""), span, mode if body.get("set_mode", True) else None)
            if err:
                return jsonify({"error": err}), 409
            hub.event("status", state())
        elif body.get("stop"):
            hub.event("status", state())
    return jsonify(doppler.info())


@app.route("/api/sat/rotor", methods=["GET", "POST"])
def api_sat_rotor():
    """Own satellite tracking with the rotor (held by the first VFO, see ROTOR_HERE): GET the state and the plan of the pass;
    POST {"start": {"norad", "force": true/false}} or {"stop": true}."""
    if sattrack is None:
        return jsonify(SGP4_MISSING), 503
    if not ROTOR_HERE:
        return rotor_elsewhere()
    if request.method == "POST":
        if not same_host(request):
            return jsonify({"error": "rotor commands are accepted only from this RADIMCOM page"}), 403
        body = request.get_json(force=True) or {}
        if body.get("stop"):
            sat_tracker.stop("stopped by hand")
        start = body.get("start")
        if start:
            try:
                norad = int(start["norad"])
            except (KeyError, TypeError, ValueError):
                return jsonify({"error": "start: norad must be a number"}), 400
            err = sat_tracker.start(norad, force=bool(start.get("force")))
            if err:
                return jsonify({"error": err}), 409
    return jsonify(sat_tracker.info())


@app.route("/api/location", methods=["GET", "POST"])
def api_location():
    """Station location (MENU › SETUP › LOCATION), shared by the satellites, packet, HFDL and AIS:
    POST {"locator"} or {"lat", "lon"}, optionally "alt_m"; returns the whole location."""
    if request.method == "POST":
        body = request.get_json(force=True) or {}
        try:
            location.save({k: body[k] for k in ("locator", "lat", "lon", "alt_m") if k in body})
        except (TypeError, ValueError) as e:
            return jsonify({"error": str(e)}), 400
        _qth_cache[0] = 0.0          # APRS distances use the new place at once
    return jsonify(location.load())


@app.route("/api/sat/setup", methods=["GET", "POST"])
def api_sat_setup():
    """Minimum elevation and the satellites on the timeline (shared by all VFOs), with the station location of
    /api/location; GET also lists all satellites of the orbital elements. POST {"refresh_tle": true} downloads the elements again."""
    if sattrack is None:
        return jsonify(SGP4_MISSING), 503
    if request.method == "POST":
        body = request.get_json(force=True) or {}
        if body.get("refresh_tle"):
            state = sattrack.tle_state(refresh=True)
            if state["error"]:
                return jsonify({"error": f"download failed: {state['error']}"}), 502
        changes = {k: body[k] for k in ("locator", "lat", "lon", "alt_m", "min_el", "sats", "map_sats") if k in body}
        if changes:
            try:
                sattrack.save_setup(changes)
            except (TypeError, ValueError) as e:
                return jsonify({"error": str(e)}), 400
    return jsonify(dict(sattrack.catalog(), setup=sattrack.load_setup()))


@app.route("/api/memories", methods=["GET"])
def api_memories():
    return jsonify(memories.load())


@app.route("/api/memories", methods=["POST"])
def api_memory_add():
    """Adds a memory: {"name", "group" or "groups", "freq_hz" or "dab_channel", "mode", "bw"} and optionally
    "fav", "decoder", "note", "color", "tag"."""
    try:
        m = memories.from_dict(request.get_json(force=True), CHANNEL_HZ)
    except (AttributeError, KeyError, TypeError, ValueError, OverflowError) as e:
        return jsonify({"error": str(e) or "invalid entry"}), 400
    return jsonify(memories.add(m))


# ---------- SCAN tab: memory scanner (scanner.py runs in the receiver thread) ----------

SCAN_RAW_DECODERS = (("DAB", lambda: dab.enabled), ("VDL2", lambda: vdl2.enabled), ("ISM", lambda: ism.enabled),
                     ("HFDL", lambda: hfdl.enabled), ("AIS", lambda: ais.enabled))


def scan_store(entry):
    """Search & store (scanner thread → here): an active frequency of a range into the group "Scan YYYY-MM-DD",
    unless a memory is already there (same mode, within memories.DUP_HZ)."""
    def run():
        try:
            m = memories.from_dict(entry, CHANNEL_HZ)
            if not memories.duplicate_of(m, memories.load()):
                memories.add(m)
                hub.event("memories", {"added": m["id"]})
        except (OSError, ValueError, KeyError, TypeError):
            pass
    threading.Thread(target=run, name="scan-store", daemon=True).start()


receiver.scan.on_store = scan_store


@app.route("/api/scan", methods=["GET"])
def api_scan():
    """State of the scan of this VFO with the live values of the channels (list), the channels left out, the last
    activities of this VFO (log), the saved options and the range presets."""
    return jsonify(dict(receiver.scan.info(full=True), saved_opts=scanner_mod.norm_opts(None, cfg.get("scan")),
                        presets=[dict(zip(("name", "from_hz", "to_hz", "step_hz", "mode", "bw"), p))
                                 for p in scanner_mod.PRESETS]))


@app.route("/api/scan/log")
def api_scan_log():
    """Activity log of all VFOs (data/logs/scan_YYYY-MM-DD.csv, UTC), newest first: ?days=1..31, ?limit."""
    days = min(max(request.args.get("days", 1, type=int), 1), 31)
    limit = min(max(request.args.get("limit", 1000, type=int), 1), 20000)
    return jsonify({"days": days, "rows": scanner_mod.read_log(days, limit), "fields": scanner_mod.LOG_FIELDS})


@app.route("/api/scan/heatmap")
def api_scan_heatmap():
    """Occupancy from the log: frequency × hour of the day (local time), seconds of activity; ?days=1..31."""
    days = min(max(request.args.get("days", 7, type=int), 1), 31)
    return jsonify(scanner_mod.heatmap(days, top=min(max(request.args.get("top", 60, type=int), 1), 300)))


@app.route("/api/scan/rec/<name>")
def api_scan_rec(name):
    """A WAV recording of the scan (subfolder "scan" of the recordings folder)."""
    if not name.lower().endswith(".wav") or "/" in name or "\\" in name:
        return jsonify({"error": "bad name"}), 400
    return send_from_directory(scanner_mod.rec_folder(), name, mimetype="audio/wav", conditional=True)


@app.route("/api/scan", methods=["POST"])
def api_scan_cmd():
    """{"action": "start", "opts": {...}} / "stop" / "pause" / "resume" / "skip" / "lockout" / "unlock" /
    "step" ({"dir": 1 | -1}) / "opts" (only saves the options)."""
    body = request.get_json(force=True, silent=True) or {}
    action = body.get("action")
    try:
        opts = scanner_mod.norm_opts(body.get("opts"), cfg.get("scan"))
    except (TypeError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    if action in ("start", "opts"):
        cfg["scan"] = opts
        save_config_later()
    if action == "start":
        busy = [name for name, on in SCAN_RAW_DECODERS if on()]
        if busy:
            return jsonify({"error": f"switch off {', '.join(busy)} on this VFO first (it holds the dongle)"}), 409
        if receiver.status != "running":
            return jsonify({"error": f"receiver is not running ({receiver.status})"}), 409
        err = receiver.scan.start(memories.load(), opts, receiver)
        if err:
            return jsonify({"error": err}), 400
    elif action in ("stop", "pause", "resume", "skip", "lockout", "unlock"):
        receiver.scan.command(action)
    elif action == "step":
        receiver.scan.command("step", dir=1 if int(body.get("dir", 1)) >= 0 else -1)
    elif action != "opts":
        return jsonify({"error": "unknown scan action"}), 400
    return jsonify({"ok": True})


@app.route("/api/recordings", methods=["GET"])
def api_recordings():
    """The MP3 recordings in the recordings folder (RECORDINGS tab), newest first."""
    return jsonify(recorder.files())


@app.route("/api/recording_folder", methods=["GET", "POST"])
def api_recording_folder():
    """Folder of the recordings (SETTINGS › GENERAL › RECORDINGS), shared by all VFOs: {"folder", "custom", "default"};
    POST {"folder": "<full path>"} sets it, "" = the default data\\recordings. Files being written finish in the old folder."""
    if request.method == "POST":
        if not same_host(request):
            return jsonify({"error": "the folder can be changed only from this RADIMCOM page"}), 403
        body = request.get_json(force=True, silent=True) or {}
        folder = body.get("folder", "")
        if not isinstance(folder, str):
            return jsonify({"error": "folder must be text"}), 400
        try:
            return jsonify(recorder_mod.save_folder(folder))
        except ValueError as e:
            return jsonify({"error": str(e)}), 400
        except OSError as e:
            return jsonify({"error": f"cannot save: {e}"}), 500
    return jsonify(recorder_mod.settings())


@app.route("/api/recordings/<name>", methods=["GET"])
def api_recording_file(name):
    """One recording; Range requests work, so the browser can seek while playing."""
    return send_from_directory(recorder.folder, name, mimetype="audio/mpeg", conditional=True)


@app.route("/api/recordings/<name>", methods=["DELETE"])
def api_recording_delete(name):
    try:
        recorder.delete(name)
    except (ValueError, OSError) as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"deleted": name})


@app.route("/api/memory_groups", methods=["GET"])
def api_memory_groups():
    return jsonify(memories.groups())


@app.route("/api/memory_groups", methods=["POST"])
def api_memory_group_action():
    """Group editor: {"action": "add" | "note" | "rename" | "copy" | "delete" | "merge", ...}; returns
    {"groups", "memories"} after the change."""
    try:
        gs = memories.group_action(request.get_json(force=True, silent=True) or {})
    except (TypeError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"groups": gs, "memories": memories.load()})


@app.route("/api/memories/preview", methods=["POST"])
def api_memory_preview():
    """Reads memories for the import list without saving them: {"format": "auto", "text", "filename"} (any format
    of memories.FORMATS, recognised by its content), {"format": "sdrsharp", "path"} (SDR# folder or
    frequencies.xml), {"format": "sdrsharp_xml", "text"}, {"format": "json", "data"} or {"format": "csv", "text"}.
    Returns {"entries", "groups", "files", "format"}; see memories.preview."""
    b = request.get_json(force=True, silent=True) or {}
    fmt, gs, files = b.get("format"), [], []
    fmt_name = {"sdrsharp": "SDR#", "sdrsharp_xml": "SDR# frequencies.xml", "json": "RADIMCOM JSON",
                "csv": "RADIMCOM CSV"}.get(fmt, "")
    try:
        if fmt == "auto":
            fmt_name, raw, gs = memories.parse_any(str(b.get("text", "")), str(b.get("filename", "")))
        elif fmt == "sdrsharp":
            files = memories.sdrsharp_files(b.get("path", ""))
            raw = [e for f in files for e in memories.parse_sdrsharp_xml(f)]
        elif fmt == "sdrsharp_xml":
            raw = memories.parse_sdrsharp_xml(str(b.get("text", "")))
        elif fmt == "json":
            raw, gs = memories.parse_json(b.get("data"))
        elif fmt == "csv":
            raw = memories.parse_csv(str(b.get("text", "")))
        else:
            raise ValueError("unknown format")
    except (OSError, ValueError, TypeError, memories.ET.ParseError) as e:
        return jsonify({"error": str(e) or "cannot read the file"}), 400
    return jsonify({"entries": memories.preview(raw, CHANNEL_HZ), "groups": gs, "files": files, "format": fmt_name})


@app.route("/api/memories/import_entries", methods=["POST"])
def api_memory_import_entries():
    """Adds the chosen entries of the import list: {"entries": [...], "groups": [{"name", "note"}]}.
    All or nothing; returns {"added": [...]}."""
    b = request.get_json(force=True, silent=True) or {}
    try:
        added = memories.import_entries(b.get("entries"), CHANNEL_HZ, b.get("groups") or [])
    except (TypeError, ValueError) as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"added": added})


@app.route("/api/memories/import", methods=["POST"])
def api_memory_import():
    """Imports SDR# memories: {"path": SDR# folder (profile subfolders included) or one frequencies.xml}."""
    try:
        files = memories.sdrsharp_files(request.get_json(force=True).get("path", ""))
    except (ValueError, OSError) as e:
        return jsonify({"error": str(e)}), 400
    added = skipped = 0
    done, errors = [], []
    for path in files:
        try:
            a, s = memories.import_sdrsharp(path, lo_offset_hz=None)
        except (ValueError, OSError, memories.ET.ParseError) as e:
            errors.append(f"{path}: {e}")
            continue
        added, skipped = added + a, skipped + s
        done.append(path)
    if not done:
        return jsonify({"error": "; ".join(errors)}), 400
    return jsonify({"added": added, "skipped": skipped, "files": done, "errors": errors})


@app.route("/api/memories/import_json", methods=["POST"])
def api_memory_import_json():
    """Imports memories from a JSON list (the format of the MEM export)."""
    try:
        added, skipped = memories.import_json(request.get_json(force=True, silent=True), CHANNEL_HZ)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"added": added, "skipped": skipped})


@app.route("/api/memories/bulk", methods=["POST"])
def api_memory_bulk():
    """Several memories at once: {"ids": [...], "delete": true} or {"ids": [...], "changes": {"group": ..., "fav": ...}}."""
    b = request.get_json(force=True, silent=True) or {}
    ids = b.get("ids")
    if not isinstance(ids, list) or not ids:
        return jsonify({"error": "ids missing"}), 400
    if b.get("delete"):
        return jsonify({"deleted": memories.delete_many(ids)})
    try:
        changed = memories.update_many(ids, b.get("changes"), CHANNEL_HZ)
    except (KeyError, TypeError, ValueError, OverflowError) as e:
        return jsonify({"error": str(e) or "invalid entry"}), 400
    return jsonify({"changed": changed})


@app.route("/api/memories/<mid>", methods=["PATCH"])
def api_memory_update(mid):
    try:
        m = memories.update(mid, request.get_json(force=True), CHANNEL_HZ)
    except (KeyError, TypeError, ValueError, OverflowError) as e:
        return jsonify({"error": str(e) or "invalid entry"}), 400
    if m and receiver.scan.on:
        receiver.scan.command("update", mem=m)     # SCAN / SQ / ASQ / PRIO take effect in the running scan at once
    return (jsonify(m), 200) if m else (jsonify({"error": "not found"}), 404)


@app.route("/api/memories/<mid>", methods=["DELETE"])
def api_memory_delete(mid):
    return (jsonify({"ok": True}), 200) if memories.delete(mid) else (jsonify({"error": "not found"}), 404)


def forward_to_owner(changes):
    """Chained VFO: a dongle setting (gain, ppm, sample rate…) goes to the owner VFO; None = OK, else the error."""
    import urllib.error
    import urllib.request
    req = urllib.request.Request(f"http://127.0.0.1:{OWNER['port']}/api/set", data=json.dumps(changes).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=3):
            return None
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read()).get("error") or str(e)
        except ValueError:
            return str(e)
    except OSError:
        return f"VFO {OWNER['name']} (owner of the shared dongle) is not reachable"


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
        if OWNER and "tune_hz" in changes:
            # chained VFO: any frequency is accepted; outside the owner's band it is silent and shows OOR
            if changes["tune_hz"] < 0:
                raise ValueError("frequency out of range")
        elif "tune_hz" in changes or "upconv" in changes:
            # HF below the tuner's lower limit (R820T 24 MHz, RTL-SDR Blog V4 0.5 MHz, LimeSDR Mini 10 MHz, Airspy R2 24 MHz) can only be received
            # through an upconverter; upper limit R820T 1766 MHz, LimeSDR Mini 3500 MHz, Airspy R2 1750 MHz.
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
        if "afi" in body:
            changes["afi"] = bool(body["afi"])
        if "autotune" in body:
            changes["autotune"] = bool(body["autotune"])
        if body.get("autotune_go"):
            changes["autotune_go"] = True
        if "auto_sql" in body:
            changes["auto_sql"] = bool(body["auto_sql"])
        if "auto_sql_db" in body:
            changes["auto_sql_db"] = min(max(float(body["auto_sql_db"]), ASQ_MIN_DB), ASQ_MAX_DB)
        for key in ("ctcss", "dcs"):              # TSQ-C / TSQ-D keys (the receiver keeps only one of them on)
            if key in body:
                changes[key] = bool(body[key])
        if "ctcss_hz" in body:
            changes["ctcss_hz"] = norm_ctcss(body["ctcss_hz"])
        if "dcs_code" in body:
            changes["dcs_code"] = norm_dcs(body["dcs_code"])
        if "afi_hz" in body:
            hz = float(body["afi_hz"])
            if not AFI_MIN_HZ <= hz <= AFI_MAX_HZ:
                raise ValueError(f"AFI frequency must be {AFI_MIN_HZ:g} to {AFI_MAX_HZ:g} Hz")
            changes["afi_hz"] = hz
        for key, lo, hi in (("lpf", LPF_MIN_HZ, LPF_MAX_HZ), ("hpf", HPF_MIN_HZ, HPF_MAX_HZ)):
            if key in body:
                changes[key] = bool(body[key])
            if key + "_hz" in body:
                hz = float(body[key + "_hz"])
                if not lo <= hz <= hi:
                    raise ValueError(f"{key.upper()} frequency must be {lo:g} to {hi:g} Hz")
                changes[key + "_hz"] = hz
        if "rtl_agc" in body:
            changes["rtl_agc"] = bool(body["rtl_agc"])
        if "smart_agc" in body:
            changes["smart_agc"] = bool(body["smart_agc"])
        if "sagc" in body:
            # AGC+ settings: given ones are checked and merged into the current ones; null = all by default
            new = {} if body["sagc"] is None else sagc_params(cfg)
            for k, v in (body["sagc"] or {}).items():
                if k not in SAGC_PARAMS:
                    raise ValueError(f"unknown AGC+ setting {k}")
                _d, lo, hi = SAGC_PARAMS[k]
                if not lo <= float(v) <= hi:
                    raise ValueError(f"AGC+ {k} must be {lo:g} to {hi:g}")
                new[k] = float(v)
            changes["sagc"] = new
        if "dc_remove" in body:
            changes["dc_remove"] = bool(body["dc_remove"])
        if "dc_hz" in body:
            hz = int(body["dc_hz"])
            if not 0 <= hz <= 1000:
                raise ValueError("DC peak width must be 0 to 1000 Hz")
            changes["dc_hz"] = hz
        if "dc_db" in body:
            db = int(body["dc_db"])
            if not 0 <= db <= 60:
                raise ValueError("DC peak suppression must be 0 to 60 dB")
            changes["dc_db"] = db
        if "spur_on" in body:
            changes["spur_on"] = bool(body["spur_on"])
        if "spur_hz" in body:
            hz = int(body["spur_hz"])
            if not 100 <= hz <= 10000:
                raise ValueError("Spur width must be 100 to 10000 Hz")
            changes["spur_hz"] = hz
        if "spur_edge" in body:
            hz = int(body["spur_edge"])
            if not 0 <= hz <= 3000:
                raise ValueError("Spur edge must be 0 to 3000 Hz")
            changes["spur_edge"] = hz
        if "spur_shift" in body:
            hz = int(body["spur_shift"])
            if not -1000 <= hz <= 1000:
                raise ValueError("Spur shift must be -1000 to 1000 Hz")
            changes["spur_shift"] = hz
        if "spur_db" in body:
            db = int(body["spur_db"])
            if not 0 <= db <= 60:
                raise ValueError("Spur suppression must be 0 to 60 dB")
            changes["spur_db"] = db
        for key in ("spur_learn", "spur_clear"):
            if body.get(key):
                changes[key] = True
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
    if "packet" in body:
        cfg["packet"] = bool(body["packet"])
        packet.set_enabled(cfg["packet"])
        save_config_later()
        hub.event("status", state())
    if "tx_enabled" in body:
        if not tx_capable():
            return jsonify({"error": "this VFO cannot transmit"}), 400
        if body["tx_enabled"] and not body.get("tx_ack"):
            return jsonify({"error": "TX can be enabled only after accepting the TX disclaimer"}), 400
        cfg["tx_enabled"] = bool(body["tx_enabled"])
        if cfg["tx_enabled"]:
            cfg["tx_ack_at"] = time.strftime("%Y-%m-%d %H:%M:%S")   # when the operator accepted the disclaimer
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
    if body.get("acars") or body.get("vdl2"):
        set_dab(False, changes)                # the dongle cannot be at 131/136 MHz and in Band III at once
        set_ism(False, changes)                # nor at 433 / 868 MHz
    if "acars" in body:
        cfg["acars"] = bool(body["acars"])
        if cfg["acars"]:
            set_vdl2(False, changes)          # one link at a time: the dongle is either at 131.x or 136.x
        acars.set_enabled(cfg["acars"])
        sync_cpdlc()
        save_config_later()
        hub.event("status", state())
    if "vdl2" in body:
        set_vdl2(bool(body["vdl2"]), changes)
        sync_cpdlc()
        save_config_later()
        hub.event("status", state())
    if "vdl2_region" in body:
        if body["vdl2_region"] not in VDL2_REGIONS:
            return jsonify({"error": "vdl2_region must be one of " + ", ".join(VDL2_REGIONS)}), 400
        vdl2.set_region(body["vdl2_region"])
        cfg["vdl2_region"] = vdl2.region
        save_config_later()
        hub.event("status", state())
    if "dab_sid" in body:
        sid = body["dab_sid"]
        if sid is not None and not re.fullmatch(r"0x[0-9a-fA-F]{1,8}", str(sid)):
            return jsonify({"error": "unknown DAB station"}), 400
        cfg["dab_sids"] = dict(cfg.get("dab_sids") or {}, **{dab.channel: sid})    # last station of each channel, None = stopped
        save_config_later()
        hub.event("status", state())
    if body.get("dab"):
        set_ism(False, changes)
    if "dab" in body or "dab_channel" in body:
        ch = body.get("dab_channel")
        if ch is not None and ch not in CHANNEL_HZ:
            return jsonify({"error": "unknown DAB channel"}), 400
        set_dab(bool(body.get("dab", dab.enabled)), changes, ch)
        if ch:
            cfg["dab_channel"] = ch
        save_config_later()
        hub.event("status", state())
    if "ism_hz" in body:
        if body["ism_hz"] not in ISM_FREQS:
            return jsonify({"error": "unknown ISM frequency"}), 400
        cfg["ism_hz"] = body["ism_hz"]
        if ism.enabled:
            changes.update(center_hz=float(body["ism_hz"]), tune_hz=float(body["ism_hz"]))
    if "ism" in body:
        set_ism(bool(body["ism"]), changes)
    if "ism" in body or "ism_hz" in body:
        save_config_later()
        hub.event("status", state())
    if any(body.get(k) for k in ("acars", "vdl2", "dab", "ism", "ais")) and hfdl.enabled:
        set_hfdl(False)                       # those take the dongle to VHF / UHF: no HFDL channel there
        save_config_later()
        hub.event("status", state())
    if any(body.get(k) for k in ("vdl2", "dab", "ism", "hfdl")) and ais.enabled:
        set_ais(False)                        # those move the dongle away from 162 MHz
        save_config_later()
        hub.event("status", state())
    if "hfdl_band" in body:
        try:
            band = hfdl_mod.BANDS[int(body["hfdl_band"])]
        except (TypeError, ValueError, IndexError):
            return jsonify({"error": "unknown HFDL band"}), 400
        set_vdl2(False, changes)
        set_dab(False, changes)
        set_ism(False, changes)
        if cfg.get("acars"):
            cfg["acars"] = False
            acars.set_enabled(False)
        sync_cpdlc()
        changes.update(center_hz=float(band["center"]), tune_hz=float(band["center"]), mode="USB")   # the audio is muted: the whole band is decoded
        if "hfdl" not in body:
            set_hfdl(True)
        save_config_later()
        hub.event("status", state())
    if "hfdl" in body:
        set_hfdl(body["hfdl"])
        save_config_later()
        hub.event("status", state())
    if body.get("ais_center"):
        set_vdl2(False, changes)
        set_dab(False, changes)
        set_ism(False, changes)
        if cfg.get("acars"):
            cfg["acars"] = False
            acars.set_enabled(False)
        sync_cpdlc()
        set_hfdl(False)
        changes.update(center_hz=float(ais_mod.CENTER_HZ), tune_hz=float(ais_mod.CENTER_HZ), mode="FM")   # between the channels: both are decoded
        if "ais" not in body:
            set_ais(True)
        save_config_later()
        hub.event("status", state())
    if "ais" in body:
        set_ais(body["ais"])
        save_config_later()
        hub.event("status", state())
    try:
        if "rec" in body:
            recorder.set("cont", bool(body["rec"]))
        if "rec_sq" in body:
            recorder.set("squelch", bool(body["rec_sq"]))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400
    if "rec" in body or "rec_sq" in body:
        hub.event("status", state())
    if "tune_hz" in changes and changes["tune_hz"] != cfg.get("tune_hz"):
        with tx_lock:
            tx_off("retuned")      # TX stays on the frequency it started on; retuning ends it (new PTT = band check again)
    if OWNER:
        forward = {k: changes.pop(k) for k in DONGLE_KEYS if k in changes}
        for k in ("center_hz", "lo_offset_hz", "upconv", "device"):
            changes.pop(k, None)     # the owner VFO decides where the dongle is
        if forward:
            err = forward_to_owner(forward)
            if err:
                return jsonify({"error": err}), 502
    if changes.get("mode") == DSD_MODE:
        with tx_lock:
            tx_off("DSD mode")     # receive only
    if receiver.scan.on and not receiver.scan.paused and ("tune_hz" in changes or "mode" in changes):
        receiver.scan.command("pause", why="tuned by hand")   # tuning by hand holds the scan (START continues)
    receiver.update(changes)
    if "mode" in changes:
        dsd.set_enabled(changes["mode"] == DSD_MODE)
    if set(changes) - {"reset"}:
        save_config_later()
    return jsonify({"ok": True})


# ---------- antenna rotor (rotor.py), satellite tracking (satplan.py) and Doppler correction (sattrack.py) ----------

def rotor_set_freq(hz):
    """Frequency from the Doppler correction: goes the same way as tuning on the page. None = OK, else the error."""
    with app.test_client() as c:
        res = c.post("/api/set", json={"tune_hz": hz})
    return None if res.status_code == 200 else (res.get_json() or {}).get("error", "refused")


def rotor_set_mode(mode):
    with app.test_client() as c:
        res = c.post("/api/set", json={"mode": mode})
    return None if res.status_code == 200 else (res.get_json() or {}).get("error", "refused")


# One rotor for the whole station (SETTINGS › GENERAL › ROTOR), not tied to a VFO: its settings are in data\rotor.json
# and its serial port is held by one process, the first VFO of vfos.json (or the receiver without vfos.json).
# The page sends all rotor commands and the rotor tracking of the satellites there (/api/vfos: "rotor": true).
ROTOR_PATH = data("rotor.json")
ROTOR_HERE = not VFO or VFO["name"] == ALL_VFOS[0]["name"]
ROTOR_HOST = None if ROTOR_HERE else ALL_VFOS[0]["name"]
if not VFO:
    rotor_module.migrate(ROTOR_PATH, [CONFIG_PATH])    # standalone receiver; with VFOs the launcher does it
cfg.pop("rotor", None)                                  # kept in the VFO config up to 0.114beta1
rotor_cfg = rotor_module.load_settings(ROTOR_PATH)
rotor_save_lock = threading.Lock()
rotor_save_timer = None


def save_rotor_later():
    """Saves data\\rotor.json with a delay (the K3NG azimuth changes while the rotor turns)."""
    global rotor_save_timer

    def save():
        with rotor_save_lock:
            try:
                rotor_module.save_settings(ROTOR_PATH, rotor_cfg)
            except OSError as e:
                print(f"Rotor: settings not saved: {e}")

    if rotor_save_timer:
        rotor_save_timer.cancel()
    rotor_save_timer = threading.Timer(1.0, save)
    rotor_save_timer.daemon = True
    rotor_save_timer.start()


def rotor_elsewhere():
    """This VFO does not hold the rotor: the error answer of its rotor endpoints."""
    return jsonify({"error": f"the rotor is run by VFO {ROTOR_HOST}", "host": ROTOR_HOST}), 409


rotor_link = rotor_module.RotorLink()
doppler = sattrack.Doppler(rotor_set_freq, lambda: cfg["tune_hz"], lambda: cfg["mode"], rotor_set_mode) if sattrack else None
sat_tracker = satplan.Tracker(rotor_link.rotor) if sattrack else None


def rotor_raw_moved(raw):
    """Saves the K3NG azimuth (0-450): after a restart it tells 0-90 from 360-450."""
    rotor_cfg["k3ng_az"] = raw
    save_rotor_later()


rotor_link.rotor.on_raw = rotor_raw_moved


def start_rotor():
    r = rotor_cfg
    cal = r.get("az_cal") or [0.0, rotor_module.K3NG_SPAN]
    rotor_link.rotor.set_cal(*cal)
    if rotor_link.rotor.raw is None and r.get("k3ng_az") is not None:
        rotor_link.rotor.raw_hint = float(r["k3ng_az"])
    return rotor_link.start(r.get("port", ""), r.get("usb_serial", ""))


def rotor_info():
    """Rotor state with what the SAT window shows of the satellite tracking: where the satellite is (aim)
    and the time to its next AOS or LOS (next_pass)."""
    info = rotor_link.info()
    info["aim"], info["next_pass"] = None, None
    if sat_tracker is not None and sat_tracker.on:
        t = sat_tracker.info()
        now, p = time.time(), t["pass"]
        if t["now"].get("sat_az") is not None and t["now"].get("sat_el", -1) >= 0:
            info["aim"] = [t["now"]["sat_az"], t["now"]["sat_el"]]
        if p:
            event, at = ("AOS", p["aos"]) if now < p["aos"] else ("LOS", p["los"])
            if at > now:
                info["next_pass"] = {"sat": t["name"], "event": event, "seconds": round(at - now)}
    return info


@app.route("/api/rotor", methods=["GET"])
def api_rotor():
    if not ROTOR_HERE:
        return rotor_elsewhere()
    info = rotor_info()
    if request.args.get("ports"):
        try:
            info["ports"] = rotor_module.list_ports()
        except ImportError:
            info["error"] = "pyserial is not installed: run upgrade.bat"
    return jsonify(info)


@app.route("/api/rotor", methods=["POST"])
def api_rotor_cmd():
    if not same_host(request):
        return jsonify({"error": "rotor commands are accepted only from this RADIMCOM page"}), 403
    if not ROTOR_HERE:
        return rotor_elsewhere()
    body = request.get_json(force=True)
    rotor = rotor_link.rotor
    if body.get("stop"):
        rotor.stop_control()
    if body.get("reset"):
        rotor.reset_fault()
    if "az_cal" in body:
        try:
            az0, az450 = (float(v) for v in body["az_cal"])
        except (TypeError, ValueError):
            return jsonify({"error": "calibration: two numbers, true azimuth at K3NG 0 and at K3NG 450"}), 400
        if not rotor_module.cal_ok(az0, az450):
            return jsonify({"error": "calibration: azimuth at K3NG 0 from -180 to 360, at 450 between 400 and 500 more"}), 400
        rotor_cfg["az_cal"] = [az0, az450]
        save_rotor_later()
        rotor.set_cal(az0, az450)
    if body.get("start") and not rotor.running:
        body["enabled"] = True     # rotor control also turns the link on, with the port saved in SET
    if "enabled" in body:
        saved = dict(rotor_cfg, enabled=bool(body["enabled"]))
        for k in ("port", "usb_serial"):
            if k in body:
                saved[k] = str(body[k])
        if saved["enabled"] and not (saved.get("port") or saved.get("usb_serial")):
            return jsonify({"error": "choose the serial port in SETTINGS › GENERAL › ROTOR"}), 409
        rotor_cfg.clear()
        rotor_cfg.update(saved)
        save_rotor_later()
        err = start_rotor() if saved["enabled"] else rotor_link.stop()
        if err:
            return jsonify({"error": err}), 409
    if body.get("start"):
        err = rotor.start_control()
        if err:
            return jsonify({"error": err}), 409
    if "goto" in body:
        try:
            az, el = (float(v) for v in body["goto"])
        except (TypeError, ValueError):
            return jsonify({"error": "azimuth and elevation must be numbers"}), 400
        if not (0 <= az <= 360 and 0 <= el <= rotor_module.MAX_EL_DEG):
            return jsonify({"error": "azimuth must be 0 to 360, elevation 0 to 180"}), 400
        err = rotor.goto(az, el)
        if err:
            return jsonify({"error": err}), 409
    return jsonify(rotor_info())


@app.route("/api/mpx")
def api_mpx():
    """WFM: spectrum of the demodulated MPX signal (0-20 kHz, with the 19 kHz pilot); empty in other modes."""
    r = receiver.mpx_spectrum()
    return jsonify({"hz_per_bin": r[0], "db": r[1]} if r else {"hz_per_bin": 0, "db": []})


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


def shutdown_for_upgrade():
    """A receiver started without vfos.json ends itself for the upgrade."""
    for stop in (recorder.stop_all, rotor_link.stop, receiver.stop):
        try:
            stop()
        except Exception as e:
            print(f"Upgrade: {e}")
    os._exit(0)


def exit_with_parent():
    """The VFO process ends when the launcher ends (its input is closed)."""
    sys.stdin.read()
    recorder.stop_all()
    rotor_link.stop()
    if doppler is not None:
        doppler.stop()
    if sat_tracker is not None:
        sat_tracker.stop()
    os._exit(0)


if __name__ == "__main__":
    if VFO:
        threading.Thread(target=exit_with_parent, daemon=True).start()
    if CHAINED:
        import iqshare
        receiver.iq_server = iqshare.IqServer(iqshare.iq_port(VFO))
        print(f"VFO {VFO['name']}: shares its dongle with VFO {', '.join(CHAINED)} (port {iqshare.iq_port(VFO)})")
    receiver.start()
    if not VFO:
        update_check.start(cfg.get("update_check", True))     # without vfos.json: no launcher to do it
    if ROTOR_HERE and rotor_cfg.get("enabled"):
        err = start_rotor()
        if err:
            print(f"Rotor: {err}")
    try:
        port = int(cfg.get("port", 8434))
        print(f"RADIMCOM: http://localhost:{port}")
        app.run(host=cfg.get("host", "0.0.0.0"), port=port, threaded=True, use_reloader=False)
    finally:
        recorder.stop_all()
        rotor_link.stop()
        receiver.stop()
