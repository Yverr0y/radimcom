"""VFO A–D launcher: for every VFO in vfos.json it starts a separate receiver process (app.py --vfo X)
with its own dongle (by serial number), port and settings, and itself serves the page and the VFO list
on the main port. The page then talks to the receivers directly through their ports.
A chained VFO ("chain": "A") has no dongle of its own: it gets the samples of VFO A (iqshare.py).

VFO settings (config_X.json) are created at the first start from config.json and the "init" entry in vfos.json.
"""
import copy
import json
import os
import subprocess
import sys
import time

from flask import Flask, jsonify, request, send_from_directory

import update_check
from paths import BASE, data

VFOS_PATH = data("vfos.json")


def ensure_configs(vfos):
    with open(data("config.json"), encoding="utf-8") as f:
        template = json.load(f)
    for k in ("dongles", "device", "vfo", "serial"):
        template.pop(k, None)
    for v in vfos:
        path = data(v["config"])
        if os.path.exists(path):
            continue
        c = copy.deepcopy(template)
        c.update(v.get("init", {}))
        c["device"] = 0
        with open(path, "w", encoding="utf-8") as f:
            json.dump(c, f, indent=2, ensure_ascii=False)
        print(f"VFO {v['name']}: created {v['config']}")


def main():
    with open(VFOS_PATH, encoding="utf-8") as f:
        setup = json.load(f)
    vfos = setup["vfos"]
    ensure_configs(vfos)

    procs = []
    # VFOs with their own dongle first, chained VFOs (sharing a dongle, "chain": "A") after them.
    for v in sorted(vfos, key=lambda v: bool(v.get("chain"))):
        procs.append(subprocess.Popen([sys.executable, os.path.join(BASE, "app.py"), "--vfo", v["name"]],
                                      stdin=subprocess.PIPE, cwd=BASE))
        # Dongles are opened one after another; opening them at the same time through libusb is unreliable.
        time.sleep(0.5 if v.get("chain") else 1.5)

    app = Flask(__name__, static_folder="static")

    @app.route("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.route("/api/vfos")
    def api_vfos():
        return jsonify([{k: v.get(k) for k in ("name", "port", "serial", "note", "chain")} for v in vfos])

    def shutdown():
        """For the upgrade: the VFO receivers end as with the launcher closed (their input closes), then the launcher."""
        for p in procs:
            try:
                p.stdin.close()
            except OSError:
                pass
        for p in procs:
            try:
                p.wait(10)
            except subprocess.TimeoutExpired:
                p.terminate()
        os._exit(0)

    @app.route("/api/update", methods=["GET", "POST"])
    def api_update():
        """GET: newer version on GitHub; POST {"upgrade": true}: download it, close RADIMCOM and install it."""
        if request.method == "POST":
            if not update_check.same_host(request):
                return jsonify({"error": "the upgrade is accepted only from this RADIMCOM page"}), 403
            if (request.get_json(force=True, silent=True) or {}).get("upgrade"):
                err = update_check.upgrade(shutdown)
                if err:
                    return jsonify({"error": err}), 409
        return jsonify(update_check.info())

    update_check.start(setup.get("update_check", True))

    port = int(setup.get("port", 8434))
    print(f"RADIMCOM (VFO {', '.join(v['name'] for v in vfos)}): http://localhost:{port}")
    try:
        app.run(host=setup.get("host", "0.0.0.0"), port=port, threaded=True, use_reloader=False)
    finally:
        for p in procs:
            p.terminate()
