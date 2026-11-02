"""Initial dongle setup: finds the connected RTL-SDRs and LimeSDRs, assigns them to VFO A, B, C…
and writes vfos.json. Dongles are then opened by serial number, so the USB order does not matter.

RTL-SDR dongles often have the same serial number (e.g. 00000001); then they cannot be told apart and the wizard
offers to write a unique number into the EEPROM (the EEPROM backup goes to eeprom_backup/).

  python setup_sdr.py          wizard
  python setup_sdr.py --list   only lists the connected devices

The receiver (start.bat) must be stopped during setup, otherwise the dongles are busy.
"""
import json
import os
import shutil
import string
import sys
import time

import sdr

from paths import BASE, DATA, data

VFOS_PATH = data("vfos.json")
FIRST_PORT = 8441
NAMES = string.ascii_uppercase


def ask(prompt, default=""):
    txt = input(f"{prompt} [{default}]: " if default != "" else f"{prompt}: ").strip().lstrip("﻿")
    return txt or str(default)


def ask_num(prompt, default, kind=float):
    while True:
        try:
            return kind(ask(prompt, default).replace(",", "."))
        except ValueError:
            print("  please enter a number")


def yes(prompt, default=True):
    return ask(prompt + " (y/n)", "y" if default else "n").lower().startswith("y")


def rtl_devices():
    try:
        return sdr.list_devices()
    except OSError as e:
        print(f"  RTL-SDR library could not be loaded: {e}")
        return []


def lime_devices():
    """[{serial, name}] of connected LimeSDRs; empty if LimeSuite.dll is missing."""
    try:
        import lime
        out = []
        for d in lime.list_devices():
            serial = next((p.split("=", 1)[1] for p in d["name"].split(",") if p.strip().startswith("serial=")), "")
            out.append({"serial": serial.strip(), "name": d["name"].split(",")[0]})
        return out
    except Exception as e:  # DLL or D3XX driver missing
        print(f"  (LimeSDR not checked: {e})")
        return []


def show(rtl, limes):
    print()
    if not rtl and not limes:
        print("  No SDR found. Check the USB connection and the driver (see DRIVERS.txt).")
    for d in rtl:
        print(f"  RTL-SDR #{d['index']}: {d.get('vendor', '')} {d.get('product', '')}  serial '{d['serial']}'")
    for d in limes:
        print(f"  LimeSDR: {d['name']}  serial '{d['serial']}'")
    if (rtl or limes) and not any(d["serial"] for d in rtl + limes):
        print("\n  No serial numbers could be read: the receiver is probably still running. Close it and try again.")
    print()


def unique_serial(old, taken):
    """New serial number of the same length as the original (the EEPROM has a fixed place for the string)."""
    n = len(old)
    prefix = "SDR"[:max(n - 2, 0)]
    for i in range(1, 10 ** max(n - len(prefix), 1)):
        s = f"{prefix}{i:0{n - len(prefix)}d}"
        if len(s) == n and s not in taken:
            return s
    return None


def fix_serials(rtl):
    """Offers to write unique serial numbers into the EEPROM when numbers are duplicate or empty."""
    import eeprom_tool
    serials = [d["serial"] for d in rtl]
    bad = [d for d in rtl if not d["serial"] or serials.count(d["serial"]) > 1]
    if not bad:
        return False
    print("Some RTL-SDR dongles share the same serial number, so they cannot be told apart.")
    print("A unique serial can be written into the dongle EEPROM (a backup is saved to eeprom_backup/).")
    if not yes("Write unique serial numbers now?"):
        print("Skipped: dongles with the same serial will be opened by USB order (may swap after replugging).")
        return False
    taken = set(serials)
    os.makedirs(eeprom_tool.BACKUP_DIR, exist_ok=True)
    # keep the first dongle with a given (non-empty) number, rewrite the others
    seen = set()
    for d in bad:
        if d["serial"] and d["serial"] not in seen:
            seen.add(d["serial"])
            continue
        try:
            data = eeprom_tool.read(d["index"])
        except RuntimeError as e:
            print(f"  #{d['index']}: cannot read EEPROM ({e}), skipped")
            continue
        backup = os.path.join(eeprom_tool.BACKUP_DIR, f"dongle{d['index']}_{time.strftime('%Y%m%d_%H%M%S')}.bin")
        with open(backup, "wb") as f:
            f.write(data)
        _, strs = eeprom_tool.describe(data)
        if not strs:
            print(f"  #{d['index']}: EEPROM has no valid string table, skipped")
            continue
        old = strs[2][2]
        new = ask(f"  #{d['index']}: new serial ({len(old)} characters)", unique_serial(old, taken) or "")
        if len(new) != len(old):
            print(f"  must have exactly {len(old)} characters, skipped")
            continue
        eeprom_tool.write(d["index"], new)
        taken.add(new)
    print("\nUnplug all dongles, plug them back in and press Enter to continue.")
    input()
    return True


def label(d):
    return f"{'LimeSDR' if d['driver'] == 'lime' else 'RTL-SDR'} '{d['serial']}'"


def present():
    """Keys (driver, serial) of the devices connected right now, with a count for duplicate numbers."""
    keys = [("rtl", d["serial"]) for d in rtl_devices()] + [("lime", d["serial"]) for d in lime_devices()]
    return {k: keys.count(k) for k in keys}


def find_unplugged(free, devs):
    """Which of the free devices is missing compared to the original list devs; None if none is missing."""
    keys = [(d["driver"], d["serial"]) for d in devs]
    before = {k: keys.count(k) for k in keys}
    for _ in range(3):
        now = present()
        gone = [d for d in free if now.get((d["driver"], d["serial"]), 0) < before.get((d["driver"], d["serial"]), 0)
                or (d["driver"], d["serial"]) not in now]
        # the same device can be in the list twice (duplicate number): the first one is enough
        gone = list({(d["driver"], d["serial"]): d for d in gone}.values())
        if len(gone) == 1:
            return gone[0]
        if len(gone) > 1:
            print("  more than one device is missing - unplug only one")
            return None
        time.sleep(1)
    return None


def assign(devs):
    """Assigning devices to VFO A, B, C… A device is chosen by its number in the list or by the
    user unplugging it for a moment (the serial number is not visible on the dongle, the connection is)."""
    free = list(devs)
    out = []
    print("Assign the devices to VFOs. For each VFO either type the device number,")
    print("or UNPLUG the device you want for that VFO and press Enter (it is detected automatically).")
    while free:
        name = NAMES[len(out)]
        print()
        for i, d in enumerate(free, 1):
            print(f"  {i}: {label(d)}")
        txt = ask(f"VFO {name}: device number, Enter after unplugging, or 0 to finish", "")
        if txt == "0":
            if yes(f"  {len(free)} device(s) will not be used. Finish the assignment?", False):
                break
            continue
        if txt.isdigit() and 1 <= int(txt) <= len(free):
            d = free[int(txt) - 1]
        elif txt == "":
            print("  looking for the unplugged device...")
            d = find_unplugged(free, devs)
            if d is None:
                print("  nothing was unplugged")
                continue
            print(f"  found: {label(d)} -> VFO {name}. Plug it back in and press Enter.")
            input()
            for _ in range(10):  # wait until Windows reports it again
                if (d["driver"], d["serial"]) in present():
                    break
                time.sleep(1)
            else:
                print("  warning: the device did not come back yet; check it before starting the receiver")
        else:
            print("  invalid choice")
            continue
        free.remove(d)
        out.append((d, name))
    return out


def configure(dev, name, port):
    """Questions about one device -> vfos.json entry."""
    lime = dev["driver"] == "lime"
    print(f"\nVFO {name}: {'LimeSDR' if lime else 'RTL-SDR'} serial '{dev['serial']}'")
    entry = {"name": name, "serial": dev["serial"], "port": port, "config": f"config_{name}.json"}
    if lime:
        entry["driver"] = "lime"
    init = {"ppm": ask_num("  Frequency correction ppm (0 if unknown)", 0, int)}
    if yes("  Is it connected through an HF upconverter (e.g. Ham It Up)?", False):
        while True:
            lo = ask_num("  Upconverter LO in MHz (e.g. 100 or 100.0021)", 100)
            # an LO below 30 MHz would shift HF into a range the tuner cannot receive (below 24 MHz)
            if 30 <= lo / 1e6 <= 1000:   # entered in Hz
                lo /= 1e6
                print(f"  taken as Hz: {f'{lo:.6f}'.rstrip('0').rstrip('.')} MHz")
            if 30 <= lo <= 1000:
                break
            print("  the LO must be between 30 and 1000 MHz (use a decimal point, e.g. 100.00215)")
        init.update(upconv="auto", lo_offset_hz=lo * 1e6, tune_hz=7074000, mode="USB")
        entry["note"] = "HF via upconverter"
    else:
        init.update(upconv="off", lo_offset_hz=0, tune_hz=145500000, mode="FM")
        entry["note"] = ("LimeSDR, " if lime else "") + "VHF/UHF direct"
    init["center_hz"] = init["tune_hz"] + 409600   # tuned frequency off-centre (the centre has a DC spike)
    if lime:
        init.update(gain=35, bias_tee=False, rtl_agc=False)
    note = ask("  Description shown on the VFO button", entry["note"])
    entry["note"] = note
    entry["init"] = init
    return entry


def main():
    print("=== RADIMCOM - SDR setup ===")
    print("The receiver must not be running now (close start.bat).")
    rtl, limes = rtl_devices(), lime_devices()
    show(rtl, limes)
    if "--list" in sys.argv:
        return
    if rtl and fix_serials(rtl):
        rtl, limes = rtl_devices(), lime_devices()
        show(rtl, limes)
    devs = [dict(d, driver="rtl") for d in rtl] + [dict(d, driver="lime") for d in limes]
    if not devs:
        input("Nothing to configure. Press Enter to exit.")
        return
    while True:
        vfos = []
        for d, name in assign(devs):
            if d["driver"] == "rtl" and [x["serial"] for x in rtl].count(d["serial"]) > 1:
                print("  warning: duplicate serial, this VFO may get the other dongle")
            vfos.append(configure(d, name, FIRST_PORT + len(vfos)))
        if not vfos:
            input("No VFO selected. Press Enter to exit.")
            return
        print("\nSummary:")
        for v in vfos:
            i = v["init"]
            mhz = f"{i['lo_offset_hz'] / 1e6:.6f}".rstrip("0").rstrip(".")
            lo = f"upconverter LO {mhz} MHz" if i["upconv"] != "off" else "direct"
            print(f"  VFO {v['name']}: {v.get('driver', 'rtl').upper()} '{v['serial']}', ppm {i['ppm']}, {lo}")
        if len(vfos) < 4:
            print(f"  (VFO {', '.join(NAMES[len(vfos):4])}: no SDR - shown greyed out)")
        if yes("Save this configuration?"):
            break
        print("\nStarting the assignment again.")
    # Old VFO settings belong to other dongles: they are backed up and new ones are created from "init".
    stamp = time.strftime("%Y%m%d_%H%M%S")
    old = [f for f in os.listdir(DATA) if f == "vfos.json" or (f.startswith("config_") and f.endswith(".json"))]
    if old:
        bdir = data("config_backup", stamp)
        os.makedirs(bdir, exist_ok=True)
        for f in old:
            shutil.move(data(f), os.path.join(bdir, f))
        print(f"\nPrevious settings moved to {bdir}")
    with open(VFOS_PATH, "w", encoding="utf-8") as f:
        json.dump({"port": 8434, "vfos": vfos}, f, indent=2, ensure_ascii=False)
    print(f"\nSaved {VFOS_PATH}: " + ", ".join(f"VFO {v['name']} = {v['serial']}" for v in vfos))
    # install.bat asks about starting by itself at the end (--no-start)
    if "--no-start" in sys.argv:
        return
    if yes("Start the receiver now?"):
        os.startfile(os.path.join(BASE, "start.bat"))   # own window; the page opens by itself
    else:
        print("Start it later with the RADIMCOM shortcut (start.bat).")
        input("Press Enter to exit.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\ncancelled")
