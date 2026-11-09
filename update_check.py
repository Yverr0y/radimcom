"""After start: is a newer RADIMCOM on GitHub Releases? One request to the GitHub API in the background;
the page asks /api/update, shows the newer version beside its own and offers the upgrade in a small window.
Without internet nothing is shown.

UPGRADE (POST /api/update {"upgrade": true}): the upgrade zip of that release is downloaded to data\\update\\,
checked, and upgrade_helper.py (copied there) is started in its own console window; RADIMCOM then closes. The helper
waits for it, unzips the program over this folder, runs upgrade.bat and starts start.bat again. Not offered in a
development copy (a folder with .git) or without .venv and upgrade.bat.

The own version is the one in the logo of the page (static/index.html, <span class="r-ver">Ver. 0.1xx</span>),
the same that make_installer.py puts into the zip names. Off with "update_check": false (vfos.json, or config.json
of a receiver started without vfos.json).
"""
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile
from urllib.parse import urlsplit

from paths import BASE, data

LATEST_URL = "https://api.github.com/repos/om2amr/RADIMCOM/releases/latest"     # drafts and pre-releases are left out
RELEASES_URL = "https://github.com/om2amr/RADIMCOM/releases"
TIMEOUT_S = 10
DOWNLOAD_TIMEOUT_S = 60
START_DELAY_S = 5        # the receivers open their dongles first
TOP = "RADIMCOM/"        # folder inside the zips (make_installer.py)

_state = {"state": "off"}
_lock = threading.Lock()


def own_version():
    try:
        with open(os.path.join(BASE, "static", "index.html"), encoding="utf-8") as f:
            m = re.search(r'class="r-ver">\s*Ver\.\s*([0-9.]+(?:beta\d+)?)\s*<', f.read())
        return m.group(1) if m else None
    except OSError:
        return None


def _key(v):
    """"v0.111" / "0.111" -> (0, 111, 1, 0), "0.112beta1" -> (0, 112, 0, 1): a beta is older than its release
    and newer than the release before; None for anything else."""
    m = re.fullmatch(r"v?(\d+)\.(\d+)(?:beta(\d+))?", (v or "").strip())
    if not m:
        return None
    return (int(m.group(1)), int(m.group(2))) + ((0, int(m.group(3))) if m.group(3) else (1, 0))


def why_no_upgrade():
    """Why this folder cannot upgrade itself, or "" when it can."""
    if os.path.exists(os.path.join(BASE, ".git")):
        return "this is a development copy (git): upgrade it with git"
    for f in ("upgrade.bat", "start.bat", "upgrade_helper.py", os.path.join(".venv", "Scripts", "python.exe")):
        if not os.path.exists(os.path.join(BASE, f)):
            return f"{f} is missing in the RADIMCOM folder: upgrade by hand from the release page"
    return ""


def _set(**kw):
    with _lock:
        _state.update(kw)


def _check():
    time.sleep(START_DELAY_S)
    cur = own_version()
    try:
        req = urllib.request.Request(LATEST_URL, headers={"User-Agent": "RADIMCOM", "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=TIMEOUT_S) as r:
            rel = json.load(r)
        tag = rel.get("tag_name", "")
        latest = tag.lstrip("v")
        newer = _key(tag) is not None and _key(cur) is not None and _key(tag) > _key(cur)
        zip_name = f"RADIMCOM_upgrade_v{latest}.zip"
        asset = next((a for a in rel.get("assets") or [] if a.get("name") == zip_name), None)
        why = why_no_upgrade() or ("" if asset else f"the release has no {zip_name}")
        res = {"state": "done", "current": cur, "latest": latest, "newer": newer, "checked": time.time(),
               "name": rel.get("name") or tag, "url": rel.get("html_url") or RELEASES_URL, "published": rel.get("published_at"),
               "can_upgrade": newer and not why, "why_not": why,
               "zip_url": asset and asset.get("browser_download_url"), "zip_size": asset and asset.get("size")}
        print(f"Update check: version {latest} is available at {res['url']}" if newer
              else f"Update check: {cur} is the newest version")
    except Exception as e:      # offline, GitHub limit, ...: quietly nothing
        res = {"state": "failed", "current": cur, "newer": False, "error": str(e)}
        print(f"Update check: GitHub not reached ({e})")
    with _lock:
        _state.clear()
        _state.update(res)


def start(enabled=True):
    """Starts the check in the background (once per program start)."""
    with _lock:
        if _state.get("state") != "off" or not enabled:
            return
        _state.update({"state": "checking", "current": own_version(), "newer": False})
    threading.Thread(target=_check, name="update_check", daemon=True).start()


def info():
    with _lock:
        return dict(_state)


def same_host(req):
    """Only pages of this RADIMCOM may start the upgrade (no other web site through the browser)."""
    origin = req.headers.get("Origin")
    return not origin or urlsplit(origin).hostname == urlsplit(req.host_url).hostname


def upgrade(shutdown):
    """Downloads and checks the upgrade zip, starts upgrade_helper.py, then calls shutdown() (ends RADIMCOM).
    -> error text, or "" when it has started (it goes on in the background; the state says how far it is)."""
    with _lock:
        s = dict(_state)
        if s.get("state") in ("downloading", "installing"):
            return ""
        if not s.get("newer"):
            return "no newer version is known"
        if not s.get("can_upgrade"):
            return s.get("why_not") or "upgrade not possible"
        _state.update(state="downloading", got=0, upgrade_error="")
    threading.Thread(target=_upgrade, args=(s, shutdown), name="upgrade", daemon=True).start()
    return ""


def _upgrade(s, shutdown):
    folder = data("update")
    path = os.path.join(folder, f"RADIMCOM_upgrade_v{s['latest']}.zip")
    try:
        os.makedirs(folder, exist_ok=True)
        req = urllib.request.Request(s["zip_url"], headers={"User-Agent": "RADIMCOM"})
        with urllib.request.urlopen(req, timeout=DOWNLOAD_TIMEOUT_S) as r, open(path + ".part", "wb") as f:
            got = 0
            while True:
                chunk = r.read(256 * 1024)
                if not chunk:
                    break
                f.write(chunk)
                got += len(chunk)
                _set(got=got)
        if s.get("zip_size") and got != s["zip_size"]:
            raise RuntimeError(f"download incomplete ({got} of {s['zip_size']} bytes)")
        os.replace(path + ".part", path)
        with zipfile.ZipFile(path) as z:
            bad = z.testzip()
            if bad:
                raise RuntimeError(f"the zip is damaged ({bad})")
            names = set(z.namelist())
        for need in ("app.py", "upgrade.bat", "start.bat", "static/index.html"):
            if TOP + need not in names:
                raise RuntimeError(f"the zip has no {TOP}{need}")
        helper = os.path.join(folder, "upgrade_helper.py")
        shutil.copy2(os.path.join(BASE, "upgrade_helper.py"), helper)     # runs from data\, not from the folder it overwrites
        subprocess.Popen([sys.executable, "-I", helper, "--pid", str(os.getpid()), "--base", BASE, "--zip", path,
                          "--version", s["latest"]],
                         cwd=folder, creationflags=subprocess.CREATE_NEW_CONSOLE | subprocess.CREATE_NEW_PROCESS_GROUP,
                         close_fds=True)
    except Exception as e:
        print(f"Upgrade: {e}")
        _set(state="done", upgrade_error=str(e))
        try:
            os.remove(path + ".part")
        except OSError:
            pass
        return
    print(f"Upgrade to {s['latest']}: the receiver closes, the upgrade goes on in its own window")
    _set(state="installing")
    time.sleep(1.0)          # the page gets the state first
    shutdown()
