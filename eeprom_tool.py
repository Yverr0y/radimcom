"""Čítanie a zmena sériového čísla v EEPROM RTL-SDR kľúčenky (ako rtl_eeprom, cez librtlsdr.dll).

  python eeprom_tool.py                    vypíše EEPROM všetkých kľúčeniek a uloží zálohy do eeprom_backup/
  python eeprom_tool.py write INDEX SERIAL nastaví sériové číslo kľúčenky INDEX (rovnaká dĺžka ako pôvodné)
  python eeprom_tool.py restore INDEX FILE vráti EEPROM zo zálohy

Server prijímača musí byť zastavený. Nové sériové číslo sa prejaví po odpojení a pripojení kľúčenky.
Formát EEPROM (rtl-sdr rtl_eeprom.c): 0x28 0x32, VID, PID, 0xA5 = sériové číslo zapnuté, príznaky,
od adresy 0x09 tri USB reťazce (výrobca, produkt, sériové číslo) ako dĺžka, 0x03, UTF-16LE.
"""
import ctypes
import os
import sys
import time

import sdr
from paths import data

EEPROM_SIZE = 256
STR_OFFSET = 0x09
BACKUP_DIR = data("eeprom_backup")


def lib():
    lb = sdr.load_lib()
    for name in ("rtlsdr_read_eeprom", "rtlsdr_write_eeprom"):
        getattr(lb, name).argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint8), ctypes.c_uint8, ctypes.c_uint16]
    return lb


def open_dev(index):
    lb = lib()
    dev = ctypes.c_void_p()
    rc = lb.rtlsdr_open(ctypes.byref(dev), index)
    if rc != 0:
        raise RuntimeError(f"cannot open dongle {index} (code {rc})")
    return lb, dev


def read(index):
    lb, dev = open_dev(index)
    try:
        buf = (ctypes.c_uint8 * EEPROM_SIZE)()
        rc = lb.rtlsdr_read_eeprom(dev, buf, 0, EEPROM_SIZE)
        if rc < 0:
            raise RuntimeError(f"read failed (code {rc}{', no EEPROM' if rc == -3 else ''})")
        return bytes(buf)
    finally:
        lb.rtlsdr_close(dev)


def strings(data):
    """[(pozícia, dĺžka, text)] pre výrobcu, produkt a sériové číslo; None pri neplatnom formáte."""
    out, pos = [], STR_OFFSET
    for _ in range(3):
        n = data[pos]
        if pos + n > EEPROM_SIZE or n < 2 or data[pos + 1] != 0x03:
            return None
        out.append((pos, n, data[pos + 2:pos + n].decode("utf-16-le", errors="replace")))
        pos += n
    return out


def describe(data):
    ok = data[0] == 0x28 and data[1] == 0x32
    vid, pid = data[2] | data[3] << 8, data[4] | data[5] << 8
    s = strings(data) if ok else None
    txt = f"header {'OK' if ok else 'INVALID'}  VID {vid:04x} PID {pid:04x}  serial on: {data[6] == 0xA5}"
    if s:
        txt += "  " + "  ".join(f"{k}='{v}'" for k, (_, _, v) in zip(("vendor", "product", "serial"), s))
    return txt, s


def write(index, new_serial):
    old = read(index)
    _, s = describe(old)
    if not s:
        raise RuntimeError("EEPROM has no valid string table, not writing")
    pos, n, serial = s[2]
    if len(new_serial) != len(serial):
        raise RuntimeError(f"new serial must have {len(serial)} characters like '{serial}'")
    data = bytearray(old)
    data[pos + 2:pos + n] = new_serial.encode("utf-16-le")
    data[6] = 0xA5
    changed = [i for i in range(EEPROM_SIZE) if data[i] != old[i]]
    print(f"dongle {index}: '{serial}' -> '{new_serial}', bytes changed at {changed}")
    _write_bytes(index, data, old)


def _write_bytes(index, data, old):
    lb, dev = open_dev(index)
    try:
        buf = (ctypes.c_uint8 * EEPROM_SIZE)(*data)
        rc = lb.rtlsdr_write_eeprom(dev, buf, 0, EEPROM_SIZE)
        if rc < 0:
            raise RuntimeError(f"write failed (code {rc})")
    finally:
        lb.rtlsdr_close(dev)
    time.sleep(0.5)
    back = read(index)
    print("verify:", "OK" if back == bytes(data) else "MISMATCH", "-", describe(back)[0])


def main():
    if len(sys.argv) >= 4 and sys.argv[1] == "write":
        write(int(sys.argv[2]), sys.argv[3])
        return
    if len(sys.argv) >= 4 and sys.argv[1] == "restore":
        data = open(sys.argv[3], "rb").read()
        _write_bytes(int(sys.argv[2]), data, read(int(sys.argv[2])))
        return
    os.makedirs(BACKUP_DIR, exist_ok=True)
    for i in range(lib().rtlsdr_get_device_count()):
        try:
            data = read(i)
        except RuntimeError as e:
            print(f"#{i}: {e}")
            continue
        path = os.path.join(BACKUP_DIR, f"dongle{i}_{time.strftime('%Y%m%d_%H%M%S')}.bin")
        with open(path, "wb") as f:
            f.write(data)
        print(f"#{i}: {describe(data)[0]}\n     backup {path}\n     {data[:48].hex(' ')}")


if __name__ == "__main__":
    main()
