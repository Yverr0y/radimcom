"""Builds the installer package for another PC: RADIMCOM_install_v<version>.zip in the dist folder.
The version is taken from the logo in static/index.html (<span class="r-ver">Ver. 0.1xx</span>); the folder in the zip stays RADIMCOM.

  python installer/make_installer.py

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
    m = re.search(r'class="r-ver">\s*Ver\.\s*([0-9.]+)\s*<', html)
    if not m:
        sys.exit("version not found in static/index.html (.r-ver)")
    return m.group(1)


VERSION = read_version()
DIST = os.path.join(ROOT, "dist")
OUT = os.path.join(DIST, f"RADIMCOM_install_v{VERSION}.zip")

CODE = ["app.py", "launcher.py", "paths.py", "sdr.py", "lime.py", "rds.py", "cw.py", "rtty.py", "daylog.py", "ft8.py", "wefax.py", "sstv.py", "acars.py", "cpdlc.py", "cpdlc_schema.py",
        "memories.py", "eeprom_tool.py", "setup_sdr.py", "start.bat", "setup.bat", "README.md", "CHANGELOG.md"]
LIBS = ["lib/librtlsdr.dll", "lib/libusb-1.0.dll"]
FROM_INSTALLER = ["install.bat", "requirements.txt", "config.json", "DRIVERS.txt", "INSTALL.txt"]
# files from this PC that are bundled (target in the package: source)
EXTERNAL = {
    "lib/LimeSuite.dll": r"C:\Program Files\PothosSDR\bin\LimeSuite.dll",
    "drivers/zadig.exe": os.path.expanduser(r"~\Downloads\sdrsharp-x64\zadig.exe"),
}
D3XX_ZIP = os.path.expanduser(r"~\Downloads\FTD3XXDriver_WHQLCertified_v1.3.0.4_Installer.exe_.zip")
D3XX_EXE = "FTD3XXDriver_WHQLCertified_v1.3.0.4_Installer.exe"
# no station marks may remain in the package (serial numbers, recordings…) except the author's signature on the page
FORBIDDEN = [b"OM2AMR", b"om2amr", "OM2AMR".encode("utf-16-le")]
ALLOWED = [b"By Radim Mutina OM2AMR", b"github.com/om2amr/RADIMCOM"]   # signature, public repository link


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


if __name__ == "__main__":
    main()
