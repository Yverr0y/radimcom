"""CPU load and memory use of the PC, for the small indicator under the S-meter.

Windows: GetSystemTimes / GlobalMemoryStatusEx (ctypes, no psutil). Linux: /proc/stat and /proc/meminfo.
CPU load is measured between two calls (the page asks every few seconds); the first call samples 0.2 s.
"""

import sys
import threading
import time

_lock = threading.Lock()
_prev = None        # (idle, total) of the last call
_prev_at = 0.0
_last_cpu = None    # returned again when two calls come too close (several pages open)


def _cpu_times():
    """-> (idle, total) ticks since boot, or None."""
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes
        idle, kernel, user = wintypes.FILETIME(), wintypes.FILETIME(), wintypes.FILETIME()
        if not ctypes.windll.kernel32.GetSystemTimes(ctypes.byref(idle), ctypes.byref(kernel), ctypes.byref(user)):
            return None
        val = lambda ft: (ft.dwHighDateTime << 32) | ft.dwLowDateTime
        return val(idle), val(kernel) + val(user)     # kernel time includes idle
    try:
        with open("/proc/stat") as f:
            v = [int(x) for x in f.readline().split()[1:]]
        return v[3] + v[4], sum(v)                     # idle + iowait
    except (OSError, ValueError, IndexError):
        return None


def _memory():
    """-> (used %, used bytes, total bytes), or None."""
    if sys.platform == "win32":
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [("dwLength", ctypes.c_ulong), ("dwMemoryLoad", ctypes.c_ulong),
                        ("ullTotalPhys", ctypes.c_ulonglong), ("ullAvailPhys", ctypes.c_ulonglong),
                        ("ullTotalPageFile", ctypes.c_ulonglong), ("ullAvailPageFile", ctypes.c_ulonglong),
                        ("ullTotalVirtual", ctypes.c_ulonglong), ("ullAvailVirtual", ctypes.c_ulonglong),
                        ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]

        m = MEMORYSTATUSEX()
        m.dwLength = ctypes.sizeof(m)
        if not ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
            return None
        used = m.ullTotalPhys - m.ullAvailPhys
        return 100.0 * used / m.ullTotalPhys, used, m.ullTotalPhys
    try:
        info = {}
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                info[k] = int(v.split()[0]) * 1024
        total, avail = info["MemTotal"], info.get("MemAvailable", info.get("MemFree", 0))
        return 100.0 * (total - avail) / total, total - avail, total
    except (OSError, ValueError, KeyError, ZeroDivisionError):
        return None


def load():
    """-> {"cpu": %, "mem": %, "mem_used": bytes, "mem_total": bytes}; None for what cannot be read."""
    global _prev, _prev_at, _last_cpu
    with _lock:
        now = _cpu_times()
        if now and _prev is None:
            _prev, _prev_at = now, time.monotonic() - 0.5
            time.sleep(0.2)
            now = _cpu_times()
        cpu = _last_cpu
        if now and _prev:
            d_idle, d_total = now[0] - _prev[0], now[1] - _prev[1]
            if d_total > 0 and time.monotonic() - _prev_at >= 0.5:
                cpu = _last_cpu = max(0.0, min(100.0, 100.0 * (1 - d_idle / d_total)))
                _prev = now
                _prev_at = time.monotonic()
    mem = _memory()
    return {"cpu": None if cpu is None else round(cpu, 1),
            "mem": None if mem is None else round(mem[0], 1),
            "mem_used": mem[1] if mem else None,
            "mem_total": mem[2] if mem else None}
