"""Downloads the DSD-FME decoder for the DSD mode into lib\\dsd-fme (the release file of its author, checked by SHA-256).

It is a separate step on purpose: DSD-FME is not part of the RADIMCOM package because of the patent notice below.
"""
import hashlib
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

BASE = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(BASE, "lib", "dsd-fme")
VERSION = "20260715"
URL = ("https://github.com/lwvmobile/dsd-fme/releases/download/20260715/"
       "dsd-fme-x86-64-cygwin-portable-20260715.zip")
SHA256 = "006cfa420e79033b51ded97ed4d2d0a9715e350ffcfe35c41e89b9e6ef00e9f8"
PROGRAM_PREFIX = "dsd-fme-portable/dsd-fme/"      # program with its Cygwin DLLs
COPYRIGHT = "dsd-fme-portable/sourcecode/COPYRIGHT"
IN_USE = ("The decoder is in use, so it cannot be replaced; the installed version was not changed.\n"
          "Switch every VFO out of the DSD mode (or close RADIMCOM) and run this again.")
NOTICE = f"""
DSD decoder for RADIMCOM: DSD-FME {VERSION}
Author: lwvmobile and contributors - https://github.com/lwvmobile/dsd-fme
Download: about 38 MB, unpacked about 80 MB, into {TARGET}

PLEASE READ
DSD-FME contains mbelib, an implementation of the AMBE+2 and IMBE voice codecs. According to its authors the
functions it describes may be covered by patents owned by Digital Voice Systems, Inc. Compiling or using it
may infringe patent rights in your jurisdiction and/or require a licence. Check this for your country before
you continue; the decision and the responsibility are yours. RADIMCOM does not contain or distribute this decoder.
Listening to some radio services can also be restricted by law.
"""


def download_windows(path):
    """Download with the tools of Windows. Python only reads the certificates already in the Windows store, while these
    use the TLS of Windows, which fetches a missing root certificate by itself. They verify the certificate as well."""
    system = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32")
    commands = (
        [os.path.join(system, "curl.exe"), "-fL", "-o", path, URL],
        [os.path.join(system, "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-Command",
         "$ProgressPreference = 'SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol = 'Tls12'; "
         "Invoke-WebRequest -UseBasicParsing -Uri $env:DSD_URL -OutFile $env:DSD_OUT"],
    )
    env = dict(os.environ, DSD_URL=URL, DSD_OUT=path)
    for command in commands:
        try:
            if subprocess.run(command, env=env, check=False).returncode == 0:
                return True
        except OSError:
            pass                   # this tool is not on this Windows
    return False


def download(path):
    def progress(blocks, size, total):
        if total > 0:
            print(f"\r  {min(blocks * size, total) / 1e6:.1f} / {total / 1e6:.1f} MB", end="", flush=True)
    try:
        urllib.request.urlretrieve(URL, path, progress)
    except OSError as e:           # URLError is an OSError too
        print()
        reason = getattr(e, "reason", e)
        if not isinstance(reason, ssl.SSLCertVerificationError):
            sys.exit(f"The download failed: {reason}\nCheck the internet connection and run this again; nothing was installed.")
        print("Python does not trust the certificate of the server, trying the download tools of Windows...")
        if not download_windows(path):
            sys.exit("The download failed, Windows could not verify the server either. An antivirus or a proxy\n"
                     "may be interfering with secure connections. Nothing was installed.")
    print()
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    if h.hexdigest() != SHA256:
        sys.exit("The downloaded file does not match the expected checksum; nothing was installed.")


def unpack(path):
    """Into a new folder next to the target, which replaces the target only when everything is unpacked."""
    temp = TARGET + ".new"
    shutil.rmtree(temp, ignore_errors=True)
    os.makedirs(temp)
    root = os.path.realpath(temp)
    with zipfile.ZipFile(path) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            if info.filename == COPYRIGHT:
                rel = "COPYRIGHT.txt"
            elif info.filename.startswith(PROGRAM_PREFIX):
                rel = info.filename[len(PROGRAM_PREFIX):]
            else:
                continue
            dst = os.path.realpath(os.path.join(temp, rel))
            if not dst.startswith(root + os.sep):
                sys.exit(f"Unexpected path in the archive: {info.filename}")
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with z.open(info) as s, open(dst, "wb") as d:
                shutil.copyfileobj(s, d)
    if not os.path.exists(os.path.join(temp, "dsd-fme.exe")):
        shutil.rmtree(temp, ignore_errors=True)
        sys.exit("dsd-fme.exe is not in the archive; nothing was installed.")
    replace_target(temp)


def replace_target(new):
    """The old version is moved away first and deleted only at the end, so a failure leaves a working decoder.
    A decoder started after the check in main keeps running from the .old folder; the next run deletes what is left of it."""
    old = TARGET + ".old"
    shutil.rmtree(old, ignore_errors=True)
    try:
        if os.path.exists(TARGET):
            os.replace(TARGET, old)
        os.replace(new, TARGET)
    except OSError:
        if os.path.exists(old) and not os.path.exists(TARGET):
            os.replace(old, TARGET)
        shutil.rmtree(new, ignore_errors=True)
        sys.exit(IN_USE)
    shutil.rmtree(old, ignore_errors=True)


def decoder_running():
    """DSD-FME runs while a VFO is in the DSD mode."""
    try:
        out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq dsd-fme.exe", "/NH"], capture_output=True, text=True,
                             errors="replace", check=False).stdout
    except OSError:
        return False               # cannot tell: replace_target does not harm a running decoder either
    return "dsd-fme.exe" in out.lower()


def main():
    print(NOTICE)
    installed = os.path.exists(os.path.join(TARGET, "dsd-fme.exe"))
    if installed:
        print("It is already installed; continuing will replace it.\n")
    if input("Type YES to download and install it: ").strip() != "YES":
        print("Nothing was installed.")
        return
    if installed and decoder_running():
        sys.exit(IN_USE)
    os.makedirs(os.path.dirname(TARGET), exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "dsd-fme.zip")
        print("Downloading...")
        download(path)
        print("Unpacking...")
        unpack(path)
    print(f"\nDone: {TARGET}\nSelect the DSD mode in RADIMCOM; if it is already selected, the decoder starts by itself in a few seconds.")


if __name__ == "__main__":
    main()
