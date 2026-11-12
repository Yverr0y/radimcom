"""Builds the installer package for another PC: RADIMCOM_install_v<version>.zip in the dist folder,
plus RADIMCOM_upgrade_v<version>.zip for an existing installation (program only: no config.json, install.bat or drivers,
so data/ and the configuration stay untouched).
The version is taken from the logo in static/index.html (<span class="r-ver">Ver. 0.1xx</span>); the folder in the zip stays RADIMCOM.

  python installer/make_installer.py
  python installer/make_installer.py --upgrade-from dist/RADIMCOM_install_v0.103.zip   (upgrade zip from an older full zip)

Only the program, web interface, libraries and drivers go into the package. Not the settings of this PC
(vfos.json, config_X.json, memories, EEPROM backups, recordings); the new PC creates those during installation.
"""
import os
import re
import shutil
import sys
import tempfile
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
TOP = "RADIMCOM"


def read_version():
    html = open(os.path.join(ROOT, "static", "index.html"), encoding="utf-8").read()
    m = re.search(r'class="r-ver">\s*Ver\.\s*([0-9.]+(?:beta\d+)?)\s*<', html)
    if not m:
        sys.exit("version not found in static/index.html (.r-ver)")
    return m.group(1)


VERSION = read_version()
DIST = os.path.join(ROOT, "dist")
OUT = os.path.join(DIST, f"RADIMCOM_install_v{VERSION}.zip")
# left out of the upgrade zip: the configuration template, the installer and the drivers
UPGRADE_SKIP_FILES = ("config.json", "install.bat")
UPGRADE_SKIP_DIRS = ("data/", "drivers/")
UPGRADE_TXT = r"""RADIMCOM - upgrade
==================
This zip updates an existing RADIMCOM installation. It contains only the program;
your settings, memories, logs and recordings (data\ folder) and the configuration are not touched.

1. Close the receiver.
2. Unzip into the folder that CONTAINS your RADIMCOM folder (e.g. C:\ for C:\RADIMCOM)
   and allow overwriting files.
3. Run upgrade.bat in the RADIMCOM folder (updates the Python packages if needed).
4. Start the receiver as usual.

New program folders (e.g. lib\dab with the DAB decoder) come with the zip as well.

DSD mode (digital voice, first test version, it still needs more testing): its decoder DSD-FME is not in this zip.
If you have it in lib\dsd-fme, it stays there and nothing has to be done. If not and you want it, run install_dsd.bat:
it shows a patent notice and downloads it.

What is new: see INSTALL.txt or CHANGELOG.md.
"""
UPGRADE_BAT = r"""@echo off
rem RADIMCOM upgrade: updates the Python packages in .venv; data\ and the configuration stay untouched.
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (echo .venv not found - for a new installation use the install zip and install.bat & pause & exit /b 1)
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check --only-binary=numpy,scipy,lameenc -r requirements.txt
if errorlevel 1 (echo Package installation failed - check the internet connection. & pause & exit /b 1)
echo Upgrade done. Start the receiver with the RADIMCOM shortcut (or start.bat).
if not exist "lib\dsd-fme\dsd-fme.exe" echo Optional, for the DSD mode (digital voice): run install_dsd.bat, it downloads the decoder.
pause
"""


def make_upgrade(full_zip):
    """Upgrade zip from a full install zip: the same files without the configuration, installer and drivers."""
    out = os.path.join(os.path.dirname(full_zip), os.path.basename(full_zip).replace("_install_", "_upgrade_"))
    if out == full_zip:
        sys.exit("not an install zip: " + full_zip)
    n = 0
    with zipfile.ZipFile(full_zip) as src, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as dst:
        for info in src.infolist():
            rel = info.filename.split("/", 1)[1] if "/" in info.filename else info.filename
            if rel in UPGRADE_SKIP_FILES or rel.startswith(UPGRADE_SKIP_DIRS) or info.is_dir():
                continue
            dst.writestr(info, src.read(info))
            n += 1
        dst.writestr(f"{TOP}/UPGRADE.txt", UPGRADE_TXT.replace("\n", "\r\n"))
        dst.writestr(f"{TOP}/upgrade.bat", UPGRADE_BAT.replace("\n", "\r\n"))
    print(f"{out}: {n + 2} files, {os.path.getsize(out) / 1e6:.1f} MB")


CODE = ["app.py", "launcher.py", "paths.py", "sdr.py", "autotune.py", "lime.py", "airspy.py", "rds.py", "cw.py", "rtty.py", "packet.py", "aprs.py", "daylog.py", "ft8.py", "wefax.py", "sstv.py", "acars.py", "cpdlc.py", "cpdlc_schema.py", "adsc.py", "vdl2.py", "hfdl.py", "ais.py", "tonesq.py", "scanner.py", "airports.py", "dab.py", "ism.py", "dsd.py", "recorder.py", "install_dsd.py", "install_dsd.bat",
        "memories.py", "satellites.py", "update_check.py", "upgrade_helper.py", "sattrack.py", "satplan.py", "location.py", "sysload.py", "rotor.py", "iqshare.py", "eeprom_tool.py", "setup_sdr.py", "start.bat", "setup.bat", "README.md", "CHANGELOG.md",
        "LICENSE", "NOTICE.md", "API/API.md"]
LIBS = ["lib/librtlsdr.dll", "lib/libusb-1.0.dll"]
# VDL2: dumpvdl2 built with MSYS2 (see installer/VDL2.txt), with its MSYS2 runtime DLLs
LIBS += ["lib/vdl2/" + f for f in ("dumpvdl2.exe", "msys-2.0.dll", "msys-acars-2-2.dll", "msys-gcc_s-seh-1.dll",
                                   "msys-glib-2.0-0.dll", "msys-iconv-2.dll", "msys-intl-8.dll", "msys-pcre2-8-0.dll",
                                   "msys-xml2-16.dll", "msys-z.dll")]
# DAB: welle-cli built with MSYS2 UCRT64 (see installer/DAB.txt) with its DLLs - everything in lib/dab
LIBS += sorted("lib/dab/" + f for f in os.listdir(os.path.join(ROOT, "lib", "dab"))
               if f.lower().endswith((".exe", ".dll"))) if os.path.isdir(os.path.join(ROOT, "lib", "dab")) else []
# ISM: the static rtl_433 of its release (see installer/ISM.txt), no DLLs needed
LIBS += ["lib/ism/rtl_433.exe"]
# HFDL: dumphfdl built with MSYS2 (installer/build_hfdl.sh, see installer/HFDL.txt) with its DLLs and ground station table
LIBS += sorted("lib/hfdl/" + f for f in os.listdir(os.path.join(ROOT, "lib", "hfdl"))
               if f.lower().endswith((".exe", ".dll", ".conf"))) if os.path.isdir(os.path.join(ROOT, "lib", "hfdl")) else []
FROM_INSTALLER = ["install.bat", "requirements.txt", "config.json", "DRIVERS.txt", "INSTALL.txt", "VDL2_Ground_Stations.txt"]
# files from this PC that are bundled (target in the package: source)
EXTERNAL = {
    "lib/LimeSuite.dll": r"C:\Program Files\PothosSDR\bin\LimeSuite.dll",
    "lib/airspy.dll": r"C:\Program Files\PothosSDR\bin\airspy.dll",
    "lib/pthreadVC2.dll": r"C:\Program Files\PothosSDR\bin\pthreadVC2.dll",   # needed by airspy.dll
    "drivers/zadig.exe": os.path.expanduser(r"~\Downloads\sdrsharp-x64\zadig.exe"),
}
D3XX_ZIP = os.path.expanduser(r"~\Downloads\FTD3XXDriver_WHQLCertified_v1.3.0.4_Installer.exe_.zip")
D3XX_EXE = "FTD3XXDriver_WHQLCertified_v1.3.0.4_Installer.exe"
# no station marks may remain in the package (serial numbers, recordings…) except the author's signature on the page
FORBIDDEN = [b"OM2AMR", b"om2amr", "OM2AMR".encode("utf-16-le")]
# signature, public repository link, copyright line in LICENSE (wanted by the author)
ALLOWED = [b"By Radim Mutina OM2AMR", b"github.com/om2amr/RADIMCOM", b"api.github.com/repos/om2amr/RADIMCOM", b"Copyright (c) 2026 Radim Mutina (OM2AMR)",
           b"img.shields.io/github/v/release/om2amr/RADIMCOM", b"img.shields.io/github/license/om2amr/RADIMCOM"]   # README badges


def copy(src, dst_rel, build):
    dst = os.path.join(build, dst_rel)
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    shutil.copy2(src, dst)


def main():
    missing = [p for p in list(EXTERNAL.values()) + [D3XX_ZIP] if not os.path.exists(p)]
    if missing:
        sys.exit("missing: " + ", ".join(missing))
    with tempfile.TemporaryDirectory() as tmp:
        build = os.path.join(tmp, TOP)
        for f in CODE + LIBS:
            copy(os.path.join(ROOT, f), f, build)
        for f in FROM_INSTALLER:
            copy(os.path.join(HERE, f), f, build)
        copy(os.path.join(HERE, "VDL2.txt"), "lib/vdl2/README.txt", build)   # licences and sources of dumpvdl2
        copy(os.path.join(HERE, "DAB.txt"), "lib/dab/README.txt", build)     # licences and sources of welle-cli
        copy(os.path.join(HERE, "ISM.txt"), "lib/ism/README.txt", build)     # licences and sources of rtl_433
        copy(os.path.join(HERE, "HFDL.txt"), "lib/hfdl/README.txt", build)   # licences and sources of dumphfdl
        shutil.copytree(os.path.join(ROOT, "static"), os.path.join(build, "static"))
        for dst, src in EXTERNAL.items():
            copy(src, dst, build)
        with zipfile.ZipFile(D3XX_ZIP) as z:
            with z.open(D3XX_EXE) as s, open(os.path.join(build, "drivers", D3XX_EXE), "wb") as d:
                shutil.copyfileobj(s, d)
        # check for traces
        bad = []
        for dirpath, _, files in os.walk(build):
            for f in files:
                data = open(os.path.join(dirpath, f), "rb").read()
                for ok in ALLOWED:
                    data = data.replace(ok, b"")
                if any(x in data for x in FORBIDDEN):
                    bad.append(os.path.relpath(os.path.join(dirpath, f), build))
        if bad:
            sys.exit("forbidden text found in: " + ", ".join(bad))
        os.makedirs(DIST, exist_ok=True)
        if os.path.exists(OUT):
            os.remove(OUT)
        with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
            for dirpath, _, files in os.walk(build):
                for f in sorted(files):
                    p = os.path.join(dirpath, f)
                    z.write(p, os.path.relpath(p, tmp))
        n = sum(len(fs) for _, _, fs in os.walk(build))
    print(f"{OUT}: {n} files, {os.path.getsize(OUT) / 1e6:.1f} MB")
    make_upgrade(OUT)


if __name__ == "__main__":
    if len(sys.argv) == 3 and sys.argv[1] == "--upgrade-from":
        make_upgrade(os.path.abspath(sys.argv[2]))
    else:
        main()
