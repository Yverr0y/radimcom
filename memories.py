"""Frequency memories (memories.json), their groups (memory_groups.json), import and export.

A memory: {"id", "name", "group", "groups", "freq_hz", "mode", "bw", "fav", "decoder", "record", "note", "color",
"tag"} and "dab_channel" on a DAB memory (mode "DAB"; older files kept the DAB channel with another mode, read as
"DAB"). "groups" is the list of groups the memory belongs to; "group" is kept as the
first of them, so the file stays readable for older versions. "decoder" is switched on when the memory is recalled
("" = none). "record" starts a recording when the memory is recalled: "off", "on" (no squelch), "sq" (with the
squelch) or "asq" (with the auto squelch). "color" is the colour of its tag in the spectrum ("" = default green),
"tag" false hides the tag. "lat" / "lon" is the location of the station on the channel (decimal degrees, WGS84,
north / east positive), both or neither (null).
Scanner (scanner.py, SCAN tab): "scan" false leaves the memory out of every scan (lockout), "scan_sq" its own squelch
level in dBFS (null = by the scan settings), "scan_asq" its own auto squelch margin in dB above the noise (null = the
margin of the scan), "scan_prio" 1 = priority channel.

Groups are the names used by the memories plus the groups in memory_groups.json ([{"name", "note"}]), which keeps
the note of each group and groups without memories.

Import usage:  python memories.py C:\\sdrsharpSW\\frequencies.xml
From the command line only entries shifted by -LO of the upconverter are imported (HF via upconverter);
the MEM window imports entries with any shift.
"""
import csv
import io
import json
import os
import re
import shutil
import sys
import threading
import uuid
import xml.etree.ElementTree as ET

from paths import data

PATH = data("memories.json")
GROUPS_PATH = data("memory_groups.json")
MODES = ("AM", "FM", "WFM", "LSB", "USB", "CW", "DAB", "DSD")
DAB_MODE = "DAB"     # a DAB memory: its channel ("dab_channel") is recalled, the frequency is the centre of the channel
DAB_BW, DSD_BW = 1536000, 12500    # fixed widths: a DAB ensemble, the channel of the digital voice decoder
DAB_SNAP_HZ = 10000  # a DAB memory without a channel (import) takes the channel whose centre is this close
DECODERS = ("", "ft8", "wefax", "cw", "rtty", "sstv", "packet", "acars", "vdl2", "hfdl", "ais", "adsb", "ism")
RECORDS = ("off", "on", "sq", "asq")
DETECTORS = {"AM": "AM", "DSB": "AM", "NFM": "FM", "WFM": "WFM", "LSB": "LSB", "USB": "USB", "CW": "CW"}
NAME_MAX, GROUP_MAX, NOTE_MAX = 80, 40, 200
DEFAULT_GROUP = "Moje"
DUP_HZ = 50          # memories closer than this (same mode) are duplicates, as on the VFO display
FIELDS = ("name", "group", "groups", "freq_hz", "mode", "bw", "fav", "dab_channel", "decoder", "record", "note",
          "color", "tag", "lat", "lon", "scan", "scan_sq", "scan_asq", "scan_prio")
CSV_COLUMNS = ("name", "frequency_hz", "mode", "bandwidth_hz", "groups", "decoder", "record", "dab_channel",
               "favourite", "note", "color", "show_tag", "lat", "lon")

_lock = threading.RLock()


# ---------- files ----------

def _normalize(m):
    """Fills the fields added after 0.111 (groups, decoder, record, note, color, tag, lat, lon) in an entry read from
    the file."""
    groups = m.get("groups")
    if not isinstance(groups, list):
        groups = [m["group"]] if m.get("group") else []
    m["groups"] = groups
    m["group"] = groups[0] if groups else ""
    if m.get("dab_channel"):
        m["mode"] = DAB_MODE    # before the DAB mode a DAB memory kept the mode of the VFO
    m.setdefault("decoder", "")
    m.setdefault("record", "off")
    m.setdefault("note", "")
    m.setdefault("color", "")
    m.setdefault("tag", True)
    m.setdefault("fav", False)
    m.setdefault("lat", None)
    m.setdefault("lon", None)
    m.setdefault("scan", True)
    m.setdefault("scan_sq", None)
    m.setdefault("scan_asq", None)
    m.setdefault("scan_prio", 0)
    return m


def load():
    try:
        with open(PATH, encoding="utf-8") as f:
            return [_normalize(m) for m in json.load(f)]
    except FileNotFoundError:
        return []


def _save(items):
    # One copy of the file as it was before the first save by this version (with groups, notes, colours).
    backup = PATH + ".bak"
    if os.path.exists(PATH) and not os.path.exists(backup):
        shutil.copy2(PATH, backup)
    tmp = PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(items, f, indent=1, ensure_ascii=False)
    os.replace(tmp, PATH)


def load_groups():
    """[{"name", "note"}] from memory_groups.json."""
    try:
        with open(GROUPS_PATH, encoding="utf-8") as f:
            return [{"name": g["name"], "note": g.get("note", "")} for g in json.load(f) if g.get("name")]
    except FileNotFoundError:
        return []


def _save_groups(groups):
    tmp = GROUPS_PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(groups, f, indent=1, ensure_ascii=False)
    os.replace(tmp, GROUPS_PATH)


# ---------- validation ----------

def _group_name(g):
    g = " ".join(str(g).split())[:GROUP_MAX]
    if not g:
        raise ValueError("group name is missing")
    return g


def _groups(value):
    """List of group names (a string with | or a list), without duplicates, in the given order."""
    if isinstance(value, str):
        value = value.split("|")
    if not isinstance(value, (list, tuple)):
        raise ValueError("groups must be a list")
    out = []
    for g in value:
        g = " ".join(str(g).split())[:GROUP_MAX]
        if g and g not in out:
            out.append(g)
    return out


def _color(value):
    value = str(value or "").strip().lower()
    if value and not re.fullmatch(r"#[0-9a-f]{6}", value):
        raise ValueError("colour must be #rrggbb")
    return value


def _bool(value):
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "y", "on", "x", "★")
    return bool(value)


def _coord(value, limit, what):
    """Latitude / longitude in decimal degrees (a number or text, "," as the decimal point too) or None when empty;
    ValueError out of -limit..limit."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        v = float(str(value).strip().replace(",", ".")) if isinstance(value, str) else float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{what} is not a number") from None
    if v != v:
        raise ValueError(f"{what} is not a number")
    if not -limit <= v <= limit:
        raise ValueError(f"{what} out of range (-{limit}..{limit})")
    return round(v, 6)


def _opt_num(value, lo, hi, what):
    """A number in lo..hi, or None when empty (null, "")."""
    if value is None or (isinstance(value, str) and not value.strip()):
        return None
    try:
        v = float(str(value).strip().replace(",", ".")) if isinstance(value, str) else float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{what} is not a number") from None
    if not lo <= v <= hi:
        raise ValueError(f"{what} out of range ({lo:g}..{hi:g})")
    return round(v, 1)


def make(name, group, freq_hz, mode, bw, fav=False, groups=None, decoder="", note="", color="", tag=True,
         record="off", lat=None, lon=None, scan=True, scan_sq=None, scan_asq=None, scan_prio=0):
    """Validates and creates an entry; ValueError on invalid data. groups (list) wins over group (one name)."""
    name = " ".join(str(name).split())[:NAME_MAX]
    freq_hz = int(round(float(freq_hz)))
    if not name:
        raise ValueError("name is missing")
    if not 0 <= freq_hz <= 1.766e9:
        raise ValueError("frequency out of range")
    mode = str(mode).strip().upper()
    if mode not in MODES:
        raise ValueError("unknown mode")
    decoder = str(decoder or "").strip().lower()
    if decoder not in DECODERS:
        raise ValueError(f"unknown decoder (one of {', '.join(d for d in DECODERS if d)})")
    record = str(record or "").strip().lower() or "off"
    if record not in RECORDS:
        raise ValueError(f"unknown record mode (one of {', '.join(RECORDS)})")
    lo, hi = {"WFM": (50000, 250000), "FM": (500, 50000), DAB_MODE: (DAB_BW, DAB_BW),
              "DSD": (DSD_BW, DSD_BW)}.get(mode, (100, 18000))
    bw = int(min(max(float(bw), lo), hi))
    groups = _groups(groups) if groups is not None else [(" ".join(str(group).split()) or DEFAULT_GROUP)[:GROUP_MAX]]
    lat, lon = _coord(lat, 90, "latitude"), _coord(lon, 180, "longitude")
    if (lat is None) != (lon is None):
        raise ValueError("location needs both latitude and longitude")
    return {"id": uuid.uuid4().hex[:12], "name": name, "group": groups[0] if groups else "", "groups": groups,
            "freq_hz": freq_hz, "mode": mode, "bw": bw, "fav": _bool(fav), "decoder": decoder,
            "record": record, "note": str(note or "").strip()[:NOTE_MAX], "color": _color(color), "tag": _bool(tag),
            "lat": lat, "lon": lon, "scan": _bool(scan), "scan_sq": _opt_num(scan_sq, -120, 0, "scan squelch"),
            "scan_asq": _opt_num(scan_asq, 1, 30, "scan ASQ margin"), "scan_prio": 1 if _bool(scan_prio) else 0}


def from_dict(e, dab_channels):
    """A memory from a dict (API, JSON import); ValueError / KeyError / TypeError on invalid data. New id.
    A DAB channel makes it a DAB memory (mode "DAB"); the mode DAB without a channel takes the channel whose centre is
    at the frequency."""
    ch = e.get("dab_channel") or None
    if ch is not None and ch not in dab_channels:
        raise ValueError("unknown DAB channel")
    mode = str(e["mode"]).strip().upper()
    if ch:
        mode = DAB_MODE
    elif mode == DAB_MODE:
        ch = dab_channel_at(e.get("freq_hz"), dab_channels)
        if not ch:
            raise ValueError("DAB needs a DAB channel (or the centre frequency of one)")
    groups = e.get("groups")
    m = make(e.get("name", ""), e.get("group", ""), dab_channels[ch] if ch else e["freq_hz"], mode,
             e.get("bw", 3000), e.get("fav", False), groups=groups, decoder=e.get("decoder", ""),
             note=e.get("note", ""), color=e.get("color", ""), tag=e.get("tag", True),
             record=e.get("record", "off"), lat=e.get("lat"), lon=e.get("lon"), scan=e.get("scan", True),
             scan_sq=e.get("scan_sq"), scan_asq=e.get("scan_asq"), scan_prio=e.get("scan_prio", 0))
    if ch:
        m["dab_channel"] = ch
    return m


def dab_channel_at(freq_hz, dab_channels):
    """The DAB channel whose centre is within DAB_SNAP_HZ of the frequency, or None."""
    try:
        f = float(freq_hz)
    except (TypeError, ValueError):
        return None
    best = min(dab_channels.items(), key=lambda kv: abs(kv[1] - f), default=None)
    return best[0] if best and abs(best[1] - f) <= DAB_SNAP_HZ else None


def _apply(m, changes, dab_channels):
    """Memory m with the changes applied and validated like a new entry (same id); ValueError on invalid data.
    dab_channel: a channel name sets the frequency to its centre, None or "" removes it. groups_add / groups_remove
    add or remove groups; group (one name) replaces all groups."""
    changes = dict(changes)
    add, remove = changes.pop("groups_add", None), changes.pop("groups_remove", None)
    unknown = set(changes) - set(FIELDS)
    if unknown:
        raise ValueError(f"unknown field: {', '.join(sorted(unknown))}")
    if "name" in changes and not str(changes["name"]).strip():
        raise ValueError("name is missing")
    merged = dict(m, **changes)
    if "mode" in changes and str(changes["mode"]).strip().upper() != DAB_MODE and "dab_channel" not in changes:
        merged["dab_channel"] = None    # another mode ends a DAB memory (its frequency stays: the channel centre)
    if "group" in changes and "groups" not in changes:
        merged["groups"] = [changes["group"]]
    groups = _groups(merged.get("groups", []))
    if add is not None:
        groups += [g for g in _groups(add) if g not in groups]
    if remove is not None:
        groups = [g for g in groups if g not in _groups(remove)]
    merged["groups"] = groups
    new = from_dict(merged, dab_channels)
    new["id"] = m["id"]
    return new


# ---------- memories ----------

def name_at(hz, mode):
    """Name of the memory on this frequency, as shown above the VFO display: same mode first, then favourite."""
    best, best_score = "", -1
    for m in load():
        if abs(m["freq_hz"] - hz) < DUP_HZ:
            score = (2 if m["mode"] == mode else 0) + (1 if m.get("fav") else 0)
            if score > best_score:
                best, best_score = m["name"], score
    return best


def add(entry):
    with _lock:
        items = load()
        items.append(entry)
        items.sort(key=lambda m: m["freq_hz"])
        _save(items)
    return entry


def update(mid, changes, dab_channels=None):
    """Changes any of FIELDS of one memory. Returns the memory, None if not found; ValueError on invalid data."""
    return (update_many([mid], changes, dab_channels) or [None])[0]


def update_many(ids, changes, dab_channels=None):
    """Applies the same changes to every memory in ids (e.g. groups_add, fav, color). All or nothing: ValueError if
    any entry would be invalid. Returns the changed memories; ids that do not exist are ignored."""
    if not isinstance(changes, dict) or not changes:
        raise ValueError("nothing to change")
    ids = set(ids)
    with _lock:
        items = load()
        changed = []
        for i, m in enumerate(items):
            if m["id"] in ids:
                items[i] = _apply(m, changes, dab_channels or {})
                changed.append(items[i])
        if changed:
            items.sort(key=lambda m: m["freq_hz"])
            _save(items)
    return changed


def delete_many(ids):
    """Deletes every memory in ids. Returns how many were deleted."""
    ids = set(ids)
    with _lock:
        items = load()
        keep = [m for m in items if m["id"] not in ids]
        if len(keep) != len(items):
            _save(keep)
    return len(items) - len(keep)


def delete(mid):
    return delete_many([mid]) > 0


def duplicate_of(entry, items):
    """Name of a memory in items on the same frequency (within DUP_HZ) and mode as entry, or ""."""
    for m in items:
        if (m.get("id") != entry.get("id") and m["mode"] == entry["mode"] and abs(m["freq_hz"] - entry["freq_hz"]) < DUP_HZ
                and (m.get("dab_channel") or "") == (entry.get("dab_channel") or "")):
            return m["name"]
    return ""


# ---------- groups ----------

def groups():
    """Every group (those of memory_groups.json and those used by memories), by name.
    [{"name", "note", "count"}]; count = memories in the group."""
    with _lock:
        items, saved = load(), load_groups()
    counts = {}
    for m in items:
        for g in m["groups"]:
            counts[g] = counts.get(g, 0) + 1
    out = [dict(g, count=counts.pop(g["name"], 0)) for g in saved]
    out += [{"name": g, "note": "", "count": n} for g, n in counts.items()]
    return sorted(out, key=lambda g: g["name"].lower())


def _known(name, items, saved):
    return any(g["name"] == name for g in saved) or any(name in m["groups"] for m in items)


def group_action(b):
    """Group editor: {"action": "add" | "note" | "rename" | "copy" | "delete" | "merge", ...}. ValueError on error."""
    action = b.get("action")
    with _lock:
        items, saved = load(), load_groups()
        names = [g["name"] for g in saved]
        note_of = {g["name"]: g["note"] for g in saved}

        def keep_saved(name, note):
            if name in names:
                saved[names.index(name)]["note"] = note
            else:
                saved.append({"name": name, "note": note})
                names.append(name)

        if action == "add":
            name = _group_name(b.get("name", ""))
            if _known(name, items, saved):
                raise ValueError(f'group "{name}" already exists')
            keep_saved(name, str(b.get("note", "")).strip()[:NOTE_MAX])
        elif action == "note":
            name = _group_name(b.get("name", ""))
            if not _known(name, items, saved):
                raise ValueError(f'no group "{name}"')
            keep_saved(name, str(b.get("note", "")).strip()[:NOTE_MAX])
        elif action in ("rename", "copy"):
            old, new = _group_name(b.get("name", "")), _group_name(b.get("new", ""))
            if not _known(old, items, saved):
                raise ValueError(f'no group "{old}"')
            if _known(new, items, saved):
                raise ValueError(f'group "{new}" already exists' + (" (use merge)" if action == "rename" else ""))
            if action == "rename":
                for m in items:
                    m["groups"] = [new if g == old else g for g in m["groups"]]
                    m["group"] = m["groups"][0] if m["groups"] else ""
                if old in names:
                    saved[names.index(old)]["name"] = new
            else:   # copy: the memories of the group are copied (new ids) into the new group only
                items += [dict(m, id=uuid.uuid4().hex[:12], groups=[new], group=new) for m in items if old in m["groups"]]
                keep_saved(new, note_of.get(old, ""))
        elif action == "delete":
            name = _group_name(b.get("name", ""))
            if not _known(name, items, saved):
                raise ValueError(f'no group "{name}"')
            if b.get("delete_memories"):   # memories of this group that are in no other group are deleted
                items = [m for m in items if name not in m["groups"] or len(m["groups"]) > 1]
            for m in items:
                if name in m["groups"]:
                    m["groups"] = [g for g in m["groups"] if g != name]
                    m["group"] = m["groups"][0] if m["groups"] else ""
            saved = [g for g in saved if g["name"] != name]
        elif action == "merge":
            src = _groups(b.get("names", []))
            into = _group_name(b.get("into", ""))
            if len(src) < 1 or not all(_known(g, items, saved) for g in src):
                raise ValueError("choose existing groups to merge")
            note = b.get("note")
            if note is None:
                note = " · ".join(n for n in dict.fromkeys(note_of.get(g, "") for g in [into] + src) if n)
            for m in items:
                if any(g in src for g in m["groups"]):
                    gs = [into if g in src else g for g in m["groups"]]
                    m["groups"] = list(dict.fromkeys(gs))
                    m["group"] = m["groups"][0]
            saved = [g for g in saved if g["name"] not in src or g["name"] == into]
            names = [g["name"] for g in saved]
            keep_saved(into, str(note).strip()[:NOTE_MAX])
        else:
            raise ValueError("unknown action")
        items.sort(key=lambda m: m["freq_hz"])
        _save(items)
        _save_groups(saved)
    return groups()


# ---------- import ----------

def sdrsharp_files(path, max_depth=3):
    r"""SDR# installation folder (or one frequencies.xml) -> list of frequencies.xml paths.

    Newer SDR# versions keep memories per profile (e.g. C:\SDRSharp\Instances\Profile1\frequencies.xml),
    so subfolders are searched too, up to max_depth levels below the given folder.
    """
    path = os.path.expandvars(os.path.expanduser(str(path).strip().strip('"')))
    if not os.path.exists(path):
        raise ValueError(f"not found: {path}")
    if os.path.isfile(path):
        if not path.lower().endswith(".xml"):
            raise ValueError("expected the SDR# folder or its frequencies.xml")
        return [path]
    found = []
    for folder, dirs, files in os.walk(path):
        rel = os.path.relpath(folder, path)
        if (0 if rel == "." else rel.count(os.sep) + 1) >= max_depth:
            dirs[:] = []
        dirs.sort()
        found += [os.path.join(folder, f) for f in files if f.lower() == "frequencies.xml"]
    if not found:
        raise ValueError(f"no frequencies.xml in {path} or its profile subfolders")
    return found


def parse_sdrsharp_xml(text_or_path, lo_offset_hz=None):
    """SDR# frequencies.xml -> list of raw entries (dicts as for from_dict). lo_offset_hz: only entries with this
    upconverter shift (None = any). Entries with an unsupported detector get "error"."""
    root = ET.parse(text_or_path).getroot() if os.path.exists(str(text_or_path)) else ET.fromstring(text_or_path)
    out = []
    for e in root.iter("MemoryEntry"):
        text = lambda tag: (e.findtext(tag) or "").strip()
        try:
            shift = int(text("Shift") or 0)
        except ValueError:
            shift = 0
        if lo_offset_hz is not None and shift != -lo_offset_hz:
            continue
        det = text("DetectorType").upper()
        entry = {"name": " ".join(text("Name").split()) or text("Frequency"), "groups": [text("GroupName") or DEFAULT_GROUP],
                 "freq_hz": text("Frequency"), "mode": DETECTORS.get(det, det), "bw": text("FilterBandwidth") or 3000,
                 "fav": text("IsFavourite").lower() == "true"}
        out.append(entry)
    return out


def parse_csv(text):
    """CSV (columns of CSV_COLUMNS, ; or , or tab separated, as written by the export) -> raw entries.
    Also accepts frequency_mhz / frequency_khz and group instead of groups."""
    text = text.lstrip("\ufeff")
    try:
        dialect = csv.Sniffer().sniff(text[:4096], delimiters=";,\t")
    except csv.Error:
        class dialect(csv.excel):
            delimiter = ";"
    rows = csv.DictReader(io.StringIO(text), dialect=dialect)
    out = []
    for r in rows:
        r = {(k or "").strip().lower(): (v or "").strip() for k, v in r.items() if k}
        if not any(r.values()):
            continue
        num = lambda v: float(v.replace(",", ".").replace(" ", "")) if v else None
        try:
            f = (num(r.get("frequency_hz", "")) or (num(r.get("frequency_khz", "")) or 0) * 1e3
                 or (num(r.get("frequency_mhz", "")) or 0) * 1e6)
        except ValueError:
            f = r.get("frequency_hz") or r.get("frequency_mhz") or ""
        bw = r.get("bandwidth_hz", "").replace(",", ".") or 3000
        out.append({"name": r.get("name", ""), "groups": r.get("groups", r.get("group", "")).split("|"),
                    "freq_hz": f, "mode": r.get("mode", ""), "bw": bw, "decoder": r.get("decoder", ""),
                    "record": r.get("record", ""),
                    "dab_channel": r.get("dab_channel", ""), "fav": r.get("favourite", ""), "note": r.get("note", ""),
                    "color": r.get("color", ""), "tag": r.get("show_tag", "1") or "1",
                    "lat": r.get("lat", ""), "lon": r.get("lon", "")})
    return out


def parse_json(obj):
    """A RADIMCOM export: a list of memories (until 0.112) or {"groups": [...], "memories": [...]}.
    Returns (raw entries, groups [{"name", "note"}])."""
    if isinstance(obj, list):
        return obj, []
    if isinstance(obj, dict) and isinstance(obj.get("memories"), list):
        gs = [{"name": str(g.get("name", "")).strip()[:GROUP_MAX], "note": str(g.get("note", "")).strip()[:NOTE_MAX]}
              for g in obj.get("groups") or [] if isinstance(g, dict) and str(g.get("name", "")).strip()]
        return obj["memories"], gs
    raise ValueError("expected a RADIMCOM memories export (JSON)")


# SDR++ frequency manager: mode numbers of its radio module
SDRPP_MODES = {0: ("FM", 12500), 1: ("WFM", 200000), 2: ("AM", 8000), 3: ("AM", 8000), 4: ("USB", 2700),
               5: ("CW", 500), 6: ("LSB", 2700)}
# gqrx bookmarks.csv: modulation names
GQRX_MODES = {"AM": "AM", "AM-SYNC": "AM", "NARROW FM": "FM", "NFM": "FM", "WFM (MONO)": "WFM", "WFM (STEREO)": "WFM",
              "WFM (OIRT)": "WFM", "WFM": "WFM", "LSB": "LSB", "USB": "USB", "CW-L": "CW", "CW-U": "CW", "CW": "CW"}
# CHIRP CSV: modes, with the bandwidth used for them
CHIRP_MODES = {"FM": ("FM", 12500), "NFM": ("FM", 8000), "WFM": ("WFM", 200000), "AM": ("AM", 8000),
               "NAM": ("AM", 6000), "USB": ("USB", 2700), "LSB": ("LSB", 2700), "CW": ("CW", 500),
               "DV": ("DSD", 12500), "DMR": ("DSD", 12500), "DN": ("DSD", 12500), "P25": ("DSD", 12500)}
FORMATS = "RADIMCOM JSON or CSV, SDR# frequencies.xml, SDR++ frequency manager JSON, gqrx bookmarks.csv, CHIRP CSV"


def parse_sdrpp(obj, group=""):
    """SDR++ frequency_manager_config.json ({"lists": {list: {"bookmarks": {name: {frequency, bandwidth, mode}}}}})
    -> (raw entries, groups). Each list becomes a group."""
    out = []
    for lname, lst in (obj.get("lists") or {}).items():
        marks = lst.get("bookmarks") if isinstance(lst, dict) else None
        for name, b in (marks or {}).items():
            if not isinstance(b, dict):
                continue
            mode, bw = SDRPP_MODES.get(b.get("mode"), (f"mode {b.get('mode')}", 0))
            out.append({"name": name, "groups": [lname or group or DEFAULT_GROUP], "freq_hz": b.get("frequency", ""),
                        "mode": mode, "bw": b.get("bandwidth") or bw or 3000})
    return out, []


def parse_gqrx(text, group=""):
    """gqrx bookmarks.csv: a table of tags ("# Tag name ; color") and of bookmarks
    ("# Frequency ; Name ; Modulation ; Bandwidth ; Tags"). Tags become groups, the colour of the first tag
    the tag colour."""
    colors, out, section = {}, [], ""
    for line in text.splitlines():
        cells = [c.strip() for c in line.split(";")]
        if not line.strip():
            continue
        if line.lstrip().startswith("#"):
            section = "tags" if "tag name" in line.lower() else "marks" if "frequency" in line.lower() else section
            continue
        if section == "tags" and len(cells) >= 2:
            colors[cells[0]] = cells[1]
        elif section == "marks" and len(cells) >= 4:
            tags = [t.strip() for t in (cells[4] if len(cells) > 4 else "").split(",") if t.strip()]
            groups = [t for t in tags if t.lower() != "untagged"] or [group or DEFAULT_GROUP]
            mod = cells[2].upper()
            color = colors.get(tags[0], "") if tags and tags[0].lower() != "untagged" else ""
            out.append({"name": cells[1] or cells[0], "groups": groups, "freq_hz": cells[0],
                        "mode": GQRX_MODES.get(mod, cells[2]), "bw": cells[3] or 3000,
                        "color": color if re.fullmatch(r"#[0-9a-fA-F]{6}", color or "") else ""})
    return out


def parse_chirp(text, group=""):
    """CHIRP CSV (Location, Name, Frequency in MHz, ..., Mode, ..., Comment) -> raw entries."""
    out = []
    for r in csv.DictReader(io.StringIO(text)):
        r = {(k or "").strip().lower(): (v or "").strip() for k, v in r.items() if k}
        if not r.get("frequency"):
            continue
        mode, bw = CHIRP_MODES.get(r.get("mode", "FM").upper(), (r.get("mode", ""), 12500))
        try:
            hz = float(r["frequency"].replace(",", ".")) * 1e6
        except ValueError:
            hz = r["frequency"]
        out.append({"name": r.get("name") or r["frequency"], "groups": [group or "CHIRP"], "freq_hz": hz,
                    "mode": mode, "bw": bw, "note": r.get("comment", "")})
    return out


def parse_any(text, filename=""):
    """A file of any supported format (see FORMATS), recognised by its content.
    Returns (name of the format, raw entries, groups [{"name", "note"}]); ValueError if it is none of them.
    Formats without groups put the entries into a group named after the file."""
    text = text.lstrip("\ufeff")
    stem = os.path.splitext(os.path.basename(filename or ""))[0][:GROUP_MAX]
    head = text.lstrip()[:1]
    if head in "[{" and head:
        try:
            obj = json.loads(text)
        except ValueError as e:
            raise ValueError(f"not valid JSON ({e})")
        if isinstance(obj, dict) and isinstance(obj.get("lists"), dict):
            raw, gs = parse_sdrpp(obj, stem)
            return "SDR++ frequency manager", raw, gs
        raw, gs = parse_json(obj)
        return "RADIMCOM JSON", raw, gs
    if head == "<":
        root = ET.fromstring(text)
        if root.find(".//MemoryEntry") is None and root.tag != "MemoryEntry":
            raise ValueError(f"unknown XML (<{root.tag}>); supported: {FORMATS}")
        return "SDR# frequencies.xml", parse_sdrsharp_xml(text), []
    first = next((ln.strip().lower() for ln in text.splitlines() if ln.strip()), "")
    if first.startswith("#") and ("tag name" in first or "frequency" in first):
        return "gqrx bookmarks", parse_gqrx(text, stem), []
    cols = {c.strip().strip('"') for c in re.split(r"[;,\t]", first)}
    if {"location", "name", "frequency"} <= cols:
        return "CHIRP CSV", parse_chirp(text, stem), []
    if "name" in cols and cols & {"frequency_hz", "frequency_khz", "frequency_mhz"}:
        return "RADIMCOM CSV", parse_csv(text), []
    raise ValueError(f"unknown format; supported: {FORMATS}")


def preview(raw, dab_channels):
    """Raw entries -> entries checked like on import, for the import list: each valid one as a memory (with a new
    id) plus "duplicate" (name of an existing memory on the same frequency and mode, or ""); an invalid one keeps
    its values and gets "error"."""
    items = load()
    out = []
    for e in raw:
        if not isinstance(e, dict):
            out.append({"name": str(e)[:NAME_MAX], "error": "not a memory"})
            continue
        try:
            m = from_dict(e, dab_channels)
            m["duplicate"] = duplicate_of(m, items)
        except (KeyError, TypeError, ValueError, OverflowError) as err:
            m = {k: e.get(k) for k in FIELDS if k in e}
            m.setdefault("name", "")
            text = str(err)
            if isinstance(err, KeyError):
                text = f"missing {err}"
            elif text.startswith("could not convert") or text.startswith("invalid literal"):
                text = "not a number: " + text.split(":", 1)[-1].strip()
            m["error"] = text or "invalid"
        out.append(m)
    return out


def import_entries(entries, dab_channels, new_groups=()):
    """Adds the chosen entries of the import list (as edited there). All are checked first: if any is invalid,
    nothing is added and ValueError says which. new_groups: [{"name", "note"}] from the file; groups not known
    yet are added with their note, a known group without a note gets it. Returns the added memories."""
    if not isinstance(entries, list):
        raise ValueError("expected a list of memories")
    made = []
    for i, e in enumerate(entries):
        try:
            made.append(from_dict(e, dab_channels))
        except (AttributeError, KeyError, TypeError, ValueError, OverflowError) as err:
            raise ValueError(f'entry {i + 1} ({(e or {}).get("name", "") if isinstance(e, dict) else ""}): {err}')
    with _lock:
        items, saved = load(), load_groups()
        items += made
        items.sort(key=lambda m: m["freq_hz"])
        _save(items)
        used = {g for m in made for g in m["groups"]}
        changed = False
        for g in new_groups or ():
            name, note = str(g.get("name", "")).strip()[:GROUP_MAX], str(g.get("note", "")).strip()[:NOTE_MAX]
            if not name or name not in used:
                continue
            old = next((x for x in saved if x["name"] == name), None)
            if old is None:
                saved.append({"name": name, "note": note})
                changed = True
            elif note and not old["note"]:
                old["note"] = note
                changed = True
        if changed:
            _save_groups(saved)
    return made


def _import_skip_dups(raw, dab_channels):
    """Old one-step import (CLI, IMPORT without the list): invalid entries and duplicates (same frequency and name)
    are skipped. Returns (added, skipped)."""
    with _lock:
        seen = {(m["freq_hz"], m["name"]) for m in load()}
        good, skipped = [], 0
        for e in raw:
            try:
                m = from_dict(e, dab_channels)
            except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
                skipped += 1
                continue
            if (m["freq_hz"], m["name"]) in seen:
                skipped += 1
                continue
            seen.add((m["freq_hz"], m["name"]))
            good.append({k: v for k, v in m.items() if k != "id"})
        import_entries(good, dab_channels)
    return len(good), skipped


def import_sdrsharp(path, lo_offset_hz=100_000_000):
    """Returns (added, skipped). lo_offset_hz=None imports entries with any Shift."""
    return _import_skip_dups(parse_sdrsharp_xml(path, lo_offset_hz), {})


def import_json(entries, dab_channels):
    """Imports a RADIMCOM export in one step. Returns (added, skipped)."""
    raw, gs = parse_json(entries)
    added, skipped = _import_skip_dups(raw, dab_channels)
    return added, skipped


if __name__ == "__main__":
    a, s = import_sdrsharp(sys.argv[1])
    print(f"added {a}, skipped {s}, total {len(load())}")
