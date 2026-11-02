"""Spúšťač VFO A/B/C: pre každé VFO z vfos.json pustí samostatný proces prijímača (app.py --vfo X)
s vlastnou kľúčenkou (podľa sériového čísla), portom a nastaveniami, a sám na hlavnom porte
podáva stránku a zoznam VFO. Stránka potom hovorí s prijímačmi priamo cez ich porty.

Nastavenia VFO (config_X.json) vzniknú pri prvom spustení z config.json a z položky "init" vo vfos.json.
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
        # Kľúčenky sa otvárajú postupne; súčasné otváranie cez libusb býva nespoľahlivé.
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
