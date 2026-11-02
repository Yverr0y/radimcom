"""Pamäte frekvencií (memories.json) a import zo SDR# (frequencies.xml).

Použitie importu:  python memories.py C:\\sdrsharpSW\\frequencies.xml
Importujú sa len záznamy s posunom -LO up-konvertora (KV cez up-konvertor); duplicity sa preskočia.
"""
import json
import os
import sys
import threading
import uuid
import xml.etree.ElementTree as ET

from paths import data

PATH = data("memories.json")
MODES = ("AM", "FM", "WFM", "LSB", "USB", "CW")
DETECTORS = {"AM": "AM", "DSB": "AM", "NFM": "FM", "WFM": "WFM", "LSB": "LSB", "USB": "USB", "CW": "CW"}

_lock = threading.Lock()


def load():
    try:
        with open(PATH, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return []


def _save(items):
    tmp = PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, indent=1, ensure_ascii=False)
    os.replace(tmp, PATH)


def make(name, group, freq_hz, mode, bw, fav=False):
    """Overí a vytvorí záznam; ValueError pri neplatných údajoch."""
    name = str(name).strip()[:80]
    group = (str(group).strip() or "Moje")[:40]
    freq_hz = int(round(float(freq_hz)))
    if not name:
        raise ValueError("name is missing")
    if not 0 <= freq_hz <= 1.766e9:
        raise ValueError("frequency out of range")
    if mode not in MODES:
        raise ValueError("unknown mode")
    lo, hi = {"WFM": (50000, 250000), "FM": (500, 50000)}.get(mode, (100, 18000))
    bw = int(min(max(float(bw), lo), hi))
    return {"id": uuid.uuid4().hex[:12], "name": name, "group": group, "freq_hz": freq_hz,
            "mode": mode, "bw": bw, "fav": bool(fav)}


def add(entry):
    with _lock:
        items = load()
        items.append(entry)
        _save(items)
    return entry


def update(mid, changes):
    with _lock:
        items = load()
        for m in items:
            if m["id"] == mid:
                if "fav" in changes:
                    m["fav"] = bool(changes["fav"])
                if "name" in changes and str(changes["name"]).strip():
                    m["name"] = str(changes["name"]).strip()[:80]
                _save(items)
                return m
    return None


def delete(mid):
    with _lock:
        items = load()
        keep = [m for m in items if m["id"] != mid]
        if len(keep) == len(items):
            return False
        _save(keep)
        return True


def import_sdrsharp(path, lo_offset_hz=100_000_000):
    """Vráti (pridané, preskočené)."""
    root = ET.parse(path).getroot()
    with _lock:
        items = load()
        seen = {(m["freq_hz"], m["name"]) for m in items}
        added = skipped = 0
        for e in root.iter("MemoryEntry"):
            text = lambda tag: (e.findtext(tag) or "").strip()
            shift = int(text("Shift") or 0)
            mode = DETECTORS.get(text("DetectorType").upper())
            if shift != -lo_offset_hz or not mode:
                skipped += 1
                continue
            m = make(" ".join(text("Name").split()), text("GroupName"), text("Frequency"), mode,
                     text("FilterBandwidth") or 3000, text("IsFavourite").lower() == "true")
            if (m["freq_hz"], m["name"]) in seen:
                skipped += 1
                continue
            seen.add((m["freq_hz"], m["name"]))
            items.append(m)
            added += 1
        items.sort(key=lambda m: m["freq_hz"])
        _save(items)
    return added, skipped


if __name__ == "__main__":
    a, s = import_sdrsharp(sys.argv[1])
    print(f"pridané {a}, preskočené {s}, spolu {len(load())}")
