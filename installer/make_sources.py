"""Builds RADIMCOM_sources_v<version>.zip in the dist folder: the source code of the GPL and LGPL components that the
release packages contain, for the same release page as the install zip.

  python installer/make_sources.py

Downloads are kept in dist/sources_cache. The versions below must match the binaries in lib/ and drivers/: when you
rebuild or replace a binary, update its entry here ("pacman -Qo" shows the package of a DLL).
"""
import hashlib
import os
import urllib.request
import zipfile

from make_installer import DIST, HERE, VERSION

GITHUB = "https://github.com/{}/archive/refs/tags/{}.tar.gz"
MSYS = "https://repo.msys2.org/msys/sources/{}.src.tar.zst"
MINGW = "https://repo.msys2.org/mingw/sources/{}.src.tar.zst"

# component, licence, file name in the zip, url
SOURCES = [
    ("dumpvdl2 2.7.0", "GPL v3", "dumpvdl2-2.7.0.tar.gz", GITHUB.format("szpajder/dumpvdl2", "v2.7.0")),
    ("dumphfdl 1.7.0", "GPL v3", "dumphfdl-1.7.0.tar.gz", GITHUB.format("szpajder/dumphfdl", "v1.7.0")),
    ("liquid-dsp 1.8.3 (for dumphfdl)", "MIT", "liquid-dsp-1.8.3.tar.gz", GITHUB.format("jgaeddert/liquid-dsp", "v1.8.3")),
    ("libconfig 1.7.3 (for dumphfdl)", "LGPL v2.1+", "libconfig-1.7.3.tar.gz", GITHUB.format("hyperrealm/libconfig", "v1.7.3")),
    ("FFTW 3.3.10 (single precision, for dumphfdl)", "GPL v2+", "fftw-3.3.10.tar.gz", "https://www.fftw.org/fftw-3.3.10.tar.gz"),
    ("libacars 2.2.1", "MIT", "libacars-2.2.1.tar.gz", GITHUB.format("szpajder/libacars", "v2.2.1")),
    ("welle.io 2.7 (welle-cli, before our patch, welle_radimcom.patch is in the build folder)", "GPL v2+", "welle.io-2.7.tar.gz", GITHUB.format("AlbrechtL/welle.io", "v2.7")),
    ("rtl_433 25.12", "GPL v2+", "rtl_433-25.12.tar.gz", GITHUB.format("merbanan/rtl_433", "25.12")),
    ("rtl-sdr 2.0.2 (linked into rtl_433.exe)", "GPL v2+", "rtl-sdr-2.0.2.tar.gz", GITHUB.format("osmocom/rtl-sdr", "v2.0.2")),
    ("Zadig 2.4.721 (libwdi)", "GPL v3", "libwdi-b721.tar.gz", GITHUB.format("pbatard/libwdi", "b721")),
    ("libusb 1.0.29 (also linked into rtl_433.exe)", "LGPL v2.1+", "libusb-1.0.29.tar.gz", GITHUB.format("libusb/libusb", "v1.0.29")),
    ("pthreads-win32 2.9.1 (lib\\pthreadVC2.dll from PothosSDR, for airspy.dll)", "LGPL v2.1+", "pthreads-w32-2-9-1-release.tar.gz",
     "https://sourceware.org/pub/pthreads-win32/pthreads-w32-2-9-1-release.tar.gz"),
    ("MSYS2 runtime 3.6.12", "LGPL v3", "msys2-runtime-3.6.12-1.src.tar.zst", MSYS.format("msys2-runtime-3.6.12-1")),
    ("GLib 2.90.1", "LGPL v2.1+", "glib2-2.90.1-1.src.tar.zst", MSYS.format("glib2-2.90.1-1")),
    ("libiconv 1.19", "LGPL", "libiconv-1.19-1.src.tar.zst", MSYS.format("libiconv-1.19-1")),
    ("gettext 0.22.5 (libintl)", "LGPL", "gettext-0.22.5-1.src.tar.zst", MSYS.format("gettext-0.22.5-1")),
    ("FAAD2 2.11.4", "GPL v2+", "mingw-w64-faad2-2.11.4-1.src.tar.zst", MINGW.format("mingw-w64-faad2-2.11.4-1")),
    ("FFTW 3.3.11", "GPL v2+", "mingw-w64-fftw-3.3.11-2.src.tar.zst", MINGW.format("mingw-w64-fftw-3.3.11-2")),
    ("mpg123 1.33.7", "LGPL v2.1", "mingw-w64-mpg123-1.33.7-1.src.tar.zst", MINGW.format("mingw-w64-mpg123-1.33.7-1")),
    ("LAME 4.0", "LGPL v2", "mingw-w64-lame-4.0-1.src.tar.zst", MINGW.format("mingw-w64-lame-4.0-1")),
]
BUILD_FILES = ["VDL2.txt", "DAB.txt", "ISM.txt", "HFDL.txt", "build_hfdl.sh", "build_dab.sh", "welle_radimcom.patch"]
NOT_INCLUDED = """Not in this zip:
- librtlsdr (GPL v2+): the exact source of lib\\librtlsdr.dll is still being confirmed. Ask at radim.mutina@gmail.com.
- GCC runtime libraries: covered by the GCC Runtime Library Exception. Sources: https://github.com/msys2/MSYS2-packages
  and https://github.com/msys2/MINGW-packages (gcc 16.2.0).
- libxml2, PCRE2, zlib, winpthreads, LimeSuite, libairspy: permissive licences. See NOTICE.md in the package.
"""


def fetch(url, path):
    if os.path.exists(path):
        return
    print("downloading", url)
    req = urllib.request.Request(url, headers={"User-Agent": "RADIMCOM-make-sources"})
    with urllib.request.urlopen(req, timeout=120) as r, open(path + ".part", "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    os.replace(path + ".part", path)


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        while chunk := f.read(1 << 20):
            h.update(chunk)
    return h.hexdigest()


def main():
    cache = os.path.join(DIST, "sources_cache")
    os.makedirs(cache, exist_ok=True)
    out = os.path.join(DIST, f"RADIMCOM_sources_v{VERSION}.zip")
    top = f"RADIMCOM_sources_v{VERSION}"
    lines = [f"Source code for the third-party components of RADIMCOM Ver. {VERSION}", ""]
    with zipfile.ZipFile(out, "w", zipfile.ZIP_STORED) as z:     # the archives are compressed already
        for name, licence, file, url in SOURCES:
            path = os.path.join(cache, file)
            fetch(url, path)
            z.write(path, f"{top}/{file}")
            lines += [f"{name} - {licence}", f"  file:   {file}", f"  from:   {url}", f"  sha256: {sha256(path)}", ""]
        for f in BUILD_FILES:
            z.write(os.path.join(HERE, f), f"{top}/build/{f}")
        lines += ["The build folder has the build instructions.", "", NOT_INCLUDED]
        z.writestr(f"{top}/SOURCES.txt", "\r\n".join("\n".join(lines).splitlines()) + "\r\n")
    print(f"{out}: {os.path.getsize(out) / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
