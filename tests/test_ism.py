"""ISM decoder: the 256 kS/s channels, one row per packet / repeat, the RAW rows of the pulse analyzer (no rtl_433 needed)."""
import io
import json
import os
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import ism  # noqa: E402

FS = 2048000
N = 262144


class Dec:
    dropped = 0


def tone_u8(freq_off, n, amp=40.0):
    k = np.arange(n)
    z = amp * np.exp(2j * np.pi * freq_off * k / FS)
    raw = np.empty(n * 2)
    raw[0::2], raw[1::2] = z.real + 127.5, z.imag + 127.5
    return np.clip(np.round(raw), 0, 255).astype(np.uint8)


def run_channel(offset, tone):
    c = ism.Channel(Dec(), FS, 433920000, offset, False)
    raw = tone_u8(tone, 4 * N)
    out = b"".join(c.channel(raw[i * 2 * N:(i + 1) * 2 * N]) for i in range(4))
    o = np.frombuffer(out, np.uint8).astype(float) - 127.5
    return c, o[0::2] + 1j * o[1::2]


def test_channel_rate_and_tone():
    for off in (0, -500000):
        c, y = run_channel(off, off + 20000)
        assert c.fs == 256000 and c.start_hz == 433920000 + off
        assert y.size == 4 * N // 8                      # no sample lost or doubled between blocks
        y = y[200:]
        spec = np.abs(np.fft.fft(y))
        f = np.fft.fftfreq(y.size, 1 / 256000)[spec.argmax()]
        assert abs(f - 20000) < 100                      # the tone 20 kHz above the channel centre
        assert abs(np.abs(y).mean() - 40) < 2 and np.abs(y).std() < 2   # continuous across blocks, gain 1


def test_channel_rejects_outside():
    _, y = run_channel(0, 400000)                        # 400 kHz away: filtered out
    assert np.abs(y[200:]).mean() < 1.5


def test_offsets():
    d = ism.IsmDecoder(lambda *a: None, lambda *a: None)
    assert d._offsets(FS, 433920000) == (0, -500000)
    assert d._offsets(FS, 868300000) == (0,)
    assert d._offsets(1000000, 433920000) == (0,)        # not a multiple of 256 kS/s: whole band as before


def make():
    events = []
    d = ism.IsmDecoder(lambda kind, m: events.append(m), lambda i: None)
    d.center_hz = d.start_hz = 433920000
    ch = ism.Channel(Dec(), FS, 433920000, 0, False)
    return d, ch, events


def msg(model, rssi, text_t=8.5, dev=15):
    return {"model": model, "id": dev, "temperature_C": text_t, "freq": 433.92, "rssi": rssi, "snr": 20.0}


def test_same_packet_two_decoders_one_row():
    d, ch, ev = make()
    d._handle(msg("LaCrosse-TX29IT", -5.1), ch)
    d._handle(msg("LaCrosse-TX35DTHIT", -5.1), ch)       # same packet (level), another decoder
    assert len(d.history) == 1 and d.history[0]["model"] == "LaCrosse-TX29IT / LaCrosse-TX35DTHIT"
    assert d.count == 1 and ev[-1]["again"]
    d._handle(msg("LaCrosse-TX35DTHIT", -6.0), ch)       # next packet: a repeat of the row, by either name
    assert len(d.history) == 1 and d.history[0]["n"] == 2 and d.count == 2


def test_repeat_with_another_message_between():
    d, ch, _ = make()
    d._handle(msg("inFactory-TH", -5.0, dev=69), ch)
    d._handle(msg("GT-WT03", -9.0, dev=154), ch)
    d._handle(msg("inFactory-TH", -5.5, dev=69), ch)
    assert [m["n"] for m in d.history] == [2, 1]


def test_raw_rows():
    d, ch, ev = make()
    ch.dec = d
    ch.decoded.append((time.time(), -5.6, 20.0))         # decoded package: no RAW row for it
    blocks = """Detected OOK package\t2026-11-12 21:05:05
Total count:   34,  width: 66.12 ms\t\t(16928 S)
RSSI: -12.1 dB SNR: 7.9 dB Noise: -20.0 dB
Frequency offsets [F1, F2]:    5317,      0\t(+20.8 kHz, +0.0 kHz)
Guessing modulation: Pulse Width Modulation with sync/delimiter
view at https://triq.org/pdv/#AAB1
Attempting demodulation... short_width: 242, long_width: 461, reset_limit: 4039, sync_width: 70
Use a flex decoder with -X 'n=name,m=OOK_PWM,s=242,l=461,r=4039,g=0,t=0,y=70'
Detected OOK package\t2026-11-12 21:05:06
Total count:   40,  width: 50.00 ms\t\t(16928 S)
RSSI: -5.6 dB SNR: 20.0 dB Noise: -25.5 dB
Guessing modulation: Pulse Position Modulation
Attempting demodulation... short_width: 1, long_width: 2, reset_limit: 3, sync_width: 0
Use a flex decoder with -X 'n=name,m=OOK_PPM,s=1,l=2,r=3'
Detected OOK package\t2026-11-12 21:05:07
Total count:    3,  width: 0.90 ms
RSSI: -12.1 dB SNR: 15.4 dB Noise: -27.5 dB
"""

    class P:
        stdout = io.BytesIO(b'pulse_slicer_pwm: Analyzer Device codes [{1}8, {31}060000f6]\n'
                            b'pulse_slicer_ppm: Analyzer Device codes [{37}198050f320]\n'
                            b'SDR: something\n' + json.dumps({"model": "X", "rssi": -1.0, "snr": 3.0}).encode() + b"\n")
        stderr = io.BytesIO(blocks.encode())
        returncode = 0

        def wait(self):
            return 0

    p = P()
    ch.proc = p
    ch._reader(p)                                        # codes lines first (stdout)
    ch._stderr(p)
    ch.pending = [(t - ism.RAW_WAIT_S, b) for t, b in ch.pending]   # as if the wait had passed
    ch._raw_flush()
    raws = [m for m in d.history if m.get("raw")]
    assert len(raws) == 1                                # 2nd was decoded, 3rd has too few pulses
    r = raws[0]
    assert "Pulse Width Modulation" in r["text"] and "{31}060000f6" in r["text"] and "34 pulses" in r["text"]
    assert r["freq_hz"] == 433920000 + 20800 and r["view"].startswith("https://triq.org/") and "OOK_PWM" in r["flex"]
    assert "SDR: something" in ch.log


def test_repeat_found_behind_an_older_row(monkeypatch):
    d, ch, _ = make()
    now = [1000.0]
    monkeypatch.setattr(ism.time, "time", lambda: now[0])
    for t, model, dev, rssi in ((0, "A", 1, -5.0), (0.5, "B", 2, -9.0), (1.0, "A", 1, -5.5), (2.6, "A", 1, -5.7)):
        now[0] = 1000.0 + t
        d._handle(msg(model, rssi, dev=dev), ch)
    assert [m["n"] for m in d.history] == [3, 1]


def test_raw_repeats_one_row():
    d, ch, _ = make()
    b = {"mod": "OOK", "count": ("30", "46.1"), "level": ("-12.1", "15.2"), "foff": ("+20.8",), "guess": ("No clue...",)}
    for k in range(5):
        d._handle_raw(dict(b, foff=(f"+{20 + k}.0",)), ch)
    d._handle_raw(dict(b, guess=("Pulse Width Modulation with sync/delimiter",)), ch)
    assert [m["n"] for m in d.history] == [5, 1] and d.raw_count == 6
