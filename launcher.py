"""VFO A–D launcher: for every VFO in vfos.json it starts a separate receiver process (app.py --vfo X)
with its own dongle (by serial number), port and settings, and itself serves the page and the VFO list
on the main port. The page then talks to the receivers directly through their ports.

VFO settings (config_X.json) are created at the first start from config.json and the "init" entry in vfos.json.
"""
import copy
import json
import os
import subprocess
import sys
import time

from flask import Flask, jsonify, send_from_directory

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
    for v in vfos:
        # Dongles are opened one after another; opening them at the same time through libusb is unreliable.
        procs.append(subprocess.Popen([sys.executable, os.path.join(BASE, "app.py"), "--vfo", v["name"]],
                                      stdin=subprocess.PIPE, cwd=BASE))
        time.sleep(1.5)

    app = Flask(__name__, static_folder="static")

    @app.route("/")
    def index():
        return send_from_directory(app.static_folder, "index.html")

    @app.route("/api/vfos")
    def api_vfos():
        return jsonify([{k: v.get(k) for k in ("name", "port", "serial", "note")} for v in vfos])

    port = int(setup.get("port", 8434))
    print(f"RADIMCOM (VFO {', '.join(v['name'] for v in vfos)}): http://localhost:{port}")
    try:
        app.run(host=setup.get("host", "0.0.0.0"), port=port, threaded=True, use_reloader=False)
    finally:
        for p in procs:
            p.terminate()
