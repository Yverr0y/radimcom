"""Overlay groups of the ROTOR CONTROL map: named lists of points to turn the antenna to.

Built-in groups (the defaults): DAB+ SR, FM broadcast SK/CZ, ham repeaters SK/CZ, in static/overlays/<id>.json.
They can be edited (name, colour, points, import): the edited copy is saved to data/overlays/<id>.json and replaces
the built-in list until RESET. Own groups (TRACKING › RCTRL › OVERLAYS, NEW GROUP) live only in data/overlays/<id>.json.

File format (JSON): {"name", "color", "source", "updated", "points": [{"name", "lat", "lon", "info"?, "detail"?, "freq"?, "cc"?}]}
or just the list of points (import).
"""
import json
import math
import os
import re
import time

from paths import BASE, data

BUILTIN = ("dab", "fm", "ham")
KINDS = BUILTIN                     # kept for older callers
TITLES = {"dab": "DAB+ SR", "fm": "FM BCAST SK/CZ", "ham": "HAM repeaters SK/CZ"}
COLORS = {"dab": "#4fc3f7", "fm": "#ffb74d", "ham": "#81c784"}
PALETTE = ("#e57373", "#ba68c8", "#fff176", "#4db6ac", "#f06292", "#9575cd", "#aed581", "#ff8a65", "#90a4ae")
MAX_POINTS = 5000
MAX_GROUPS = 50
TEXT_MAX = 300
ID_RE = re.compile(r"^[a-z0-9_-]{1,40}$")


def builtin_path(gid):
    return os.path.join(BASE, "static", "overlays", f"{gid}.json")


def custom_dir():
    return data("overlays")


def custom_path(gid):
    return os.path.join(custom_dir(), f"{gid}.json")


def _check_id(gid):
    if not isinstance(gid, str) or not ID_RE.match(gid):
        raise ValueError(f"bad group id: {gid!r}")
    return gid


def _text(v, limit=TEXT_MAX):
    return "" if v is None else str(v).strip()[:limit]


def _num(v):
    try:
        f = float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _color(v, default):
    c = _text(v, 20)
    return c if re.match(r"^#[0-9a-fA-F]{3,8}$", c) else default


def normalize(gid, body, allow_empty=False):
    """Checks a group (import or edit); returns the clean group or raises ValueError with the reason."""
    _check_id(gid)
    if isinstance(body, list):
        body = {"points": body}
    if not isinstance(body, dict) or not isinstance(body.get("points", [] if allow_empty else None), list):
        raise ValueError('expected {"points": [...]} or a list of points')
    raw = body.get("points") or []
    if len(raw) > MAX_POINTS:
        raise ValueError(f"too many points (max {MAX_POINTS})")
    points, bad = [], 0
    for p in raw:
        if not isinstance(p, dict):
            bad += 1
            continue
        lat, lon = _num(p.get("lat")), _num(p.get("lon", p.get("lng")))
        name = _text(p.get("name"), 80)
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180) or not name:
            bad += 1
            continue
        q = {"name": name, "lat": round(lat, 6), "lon": round(lon, 6)}
        for k in ("info", "detail", "cc"):
            if p.get(k):
                q[k] = _text(p[k])
        f = _num(p.get("freq"))
        if f is not None and f > 0:
            q["freq"] = f
        points.append(q)
    if not points and (raw or not allow_empty):
        raise ValueError("no valid point (each needs name, lat, lon)")
    out = {
        "name": _text(body.get("name"), 80) or TITLES.get(gid, gid),
        "color": _color(body.get("color"), COLORS.get(gid, PALETTE[0])),
        "source": _text(body.get("source")),
        "updated": _text(body.get("updated"), 40),
        "points": points,
        "skipped": bad,
    }
    if gid not in BUILTIN:
        out["created"] = _num(body.get("created")) or time.time()
    return out


def _read(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def _own_ids():
    try:
        names = os.listdir(custom_dir())
    except OSError:
        return []
    ids = [n[:-5] for n in names if n.endswith(".json") and ID_RE.match(n[:-5])]
    return [i for i in ids if i not in BUILTIN]


def load(gid):
    """The group in use, with "id", "builtin", "custom" (edited / own file) and, on a broken file, "error"."""
    _check_id(gid)
    builtin = gid in BUILTIN
    out = None
    if os.path.exists(custom_path(gid)):
        try:
            out = dict(normalize(gid, _read(custom_path(gid)), allow_empty=True), custom=True)
        except (OSError, ValueError) as e:
            out = {"error": f"saved file is broken ({e})" + (", using the built-in list" if builtin else "")}
    if not builtin:
        if out is None:
            raise ValueError(f"no such group: {gid}")
        if "error" in out:
            out = dict(name=gid, color=PALETTE[0], points=[], custom=True, created=0, **out)
        return dict(out, id=gid, builtin=False)
    try:
        base = dict(normalize(gid, _read(builtin_path(gid))), custom=False)
    except (OSError, ValueError) as e:
        base = {"name": TITLES[gid], "color": COLORS[gid], "points": [], "custom": False, "error": f"built-in list: {e}"}
    if out is None or "error" in out:
        out = dict(base, **({"error": out["error"]} if out else {}))
    return dict(out, id=gid, builtin=True)


def load_all():
    """All groups: the built-in ones first, then the own ones in the order they were made."""
    own = []
    for gid in _own_ids():
        try:
            own.append(load(gid))
        except ValueError:
            pass
    own.sort(key=lambda g: (g.get("created") or 0, g["id"]))
    return [load(g) for g in BUILTIN] + own


def _write(gid, ov):
    os.makedirs(custom_dir(), exist_ok=True)
    tmp = custom_path(gid) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({k: v for k, v in ov.items() if k != "skipped"}, f, ensure_ascii=False, indent=1)
    os.replace(tmp, custom_path(gid))


def save(gid, body):
    """Replaces a group (edit or import). Built-in group: saved as its edited copy; own group: must exist."""
    _check_id(gid)
    if gid not in BUILTIN and not os.path.exists(custom_path(gid)):
        raise ValueError(f"no such group: {gid}")
    if gid not in BUILTIN and isinstance(body, dict) and "created" not in body:
        try:
            body = dict(body, created=_read(custom_path(gid)).get("created"))
        except (OSError, ValueError, AttributeError):
            pass
    ov = normalize(gid, body, allow_empty=True)
    _write(gid, ov)
    return dict(ov, id=gid, builtin=gid in BUILTIN, custom=True)


def create(body):
    """A new own group (name, colour, points may be empty); returns it with its new id."""
    if len(_own_ids()) >= MAX_GROUPS:
        raise ValueError(f"too many groups (max {MAX_GROUPS})")
    body = body if isinstance(body, dict) else {"points": body if isinstance(body, list) else []}
    used = set(_own_ids())
    n = 1
    while f"g{n}" in used:
        n += 1
    gid = f"g{n}"
    color = PALETTE[(len(used)) % len(PALETTE)]
    src = dict({"color": color}, **{k: v for k, v in body.items() if v not in (None, "")})
    src.update(name=_text(body.get("name"), 80) or f"Group {n}", created=time.time())
    ov = normalize(gid, src, allow_empty=True)
    _write(gid, ov)
    return dict(ov, id=gid, builtin=False, custom=True)


def reset(gid):
    """Built-in group: back to the built-in list. Own group: deleted."""
    _check_id(gid)
    if os.path.exists(custom_path(gid)):
        os.remove(custom_path(gid))
    elif gid not in BUILTIN:
        raise ValueError(f"no such group: {gid}")


delete = reset
