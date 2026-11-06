"""GP key of the page: starts and closes Gpredict (satellite tracking, apps\\gpredict\\gpredict.exe, see rotor.py).

Gpredict is one program for the whole PC, so the state is read from the running processes: the key is also right after
a restart of RADIMCOM, or when Gpredict was started or closed by hand.
"""
import os
import subprocess
import threading
import time

from flask import Blueprint, jsonify, request

from paths import BASE

# Not under lib: GLib cuts a program path at a "lib" folder, and Gpredict would look for its data in the wrong place and exit.
EXE = os.path.join(BASE, "apps", "gpredict", "gpredict.exe")
IMAGE = "gpredict.exe"
START_CHECK_S = 1.0    # a program that cannot start (missing DLL...) has exited by then
CLOSE_WAIT_S = 5.0
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

bp = Blueprint("gpredict", __name__)
lock = threading.Lock()


def same_host(req):
    """Only pages of this RADIMCOM may give commands (any port, the VFOs have their own)."""
    from urllib.parse import urlsplit
    origin = req.headers.get("Origin")
    return not origin or urlsplit(origin).hostname == urlsplit(req.host_url).hostname


def running():
    try:
        out = subprocess.run(["tasklist", "/FI", f"IMAGENAME eq {IMAGE}", "/NH"], capture_output=True, text=True,
                             timeout=5, creationflags=NO_WINDOW).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    return IMAGE in out.lower()


def start():
    """None = running, else the reason it did not start."""
    if running():
        return None
    if not os.path.exists(EXE):
        return f"Gpredict is not installed ({EXE})"
    try:
        proc = subprocess.Popen([EXE], cwd=os.path.dirname(EXE), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL)
    except OSError as e:
        return f"Gpredict did not start: {e}"
    try:
        code = proc.wait(START_CHECK_S)
    except subprocess.TimeoutExpired:
        return None
    return f"Gpredict did not start (exit code {code})"


def close():
    """Asks the window to close, as its X button does: Gpredict saves its settings and disconnects from the rotor."""
    if not running():
        return None
    try:
        subprocess.run(["taskkill", "/IM", IMAGE], capture_output=True, timeout=5, creationflags=NO_WINDOW)
    except (OSError, subprocess.SubprocessError) as e:
        return f"Gpredict did not close: {e}"
    end = time.monotonic() + CLOSE_WAIT_S
    while time.monotonic() < end:
        if not running():
            return None
        time.sleep(0.2)
    return "Gpredict did not close, close it in its own window"


def info():
    return {"running": running(), "available": os.path.exists(EXE)}


@bp.route("/api/gpredict", methods=["GET"])
def api_get():
    return jsonify(info())


@bp.route("/api/gpredict", methods=["POST"])
def api_set():
    if not same_host(request):
        return jsonify({"error": "commands are accepted only from this RADIMCOM page"}), 403
    body = request.get_json(silent=True) or {}
    with lock:
        err = start() if body.get("on") else close()
    if err:
        return jsonify({"error": err}), 500
    return jsonify(info())
