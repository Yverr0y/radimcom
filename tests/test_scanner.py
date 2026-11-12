"""Memory scanner (scanner.py) on a synthetic spectrum: noise + carriers, a fake receiver, a simulated clock."""
import os
import sys
import shutil
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import scanner  # noqa: E402
import sdr  # noqa: E402
from scanner import Scanner, norm_opts  # noqa: E402

BLOCK_S = 0.085


class FakeSdr:
    smeter_offset = 0.0

    def set_center_freq(self, hz):
        pass


class FakeRx:
    chained = False
    scan_tune = sdr.Receiver.scan_tune
    scan_center = sdr.Receiver.scan_center
    _recenter = sdr.Receiver._recenter

    def __init__(self):
        self.cfg = {"tune_hz": 118e6, "center_hz": 118.3e6, "mode": "AM", "bandwidth": {}, "squelch": {},
                    "gain": 30, "sample_rate": 1536000}
        self.sdr, self.wf_power, self.wfm, self.sagc = FakeSdr(), None, None, sdr.SmartAgc()

    fs = property(lambda self: float(self.cfg["sample_rate"]))
    lo = property(lambda self: 0.0)

    def lo_for(self, f):
        return 0.0

    def tune_range(self):
        return 24e6, 1766e6

    def manual_squelch(self, mode):
        return sdr.SQUELCH_OFF


class ScannerTest(unittest.TestCase):
    def setUp(self):
        self.clock = [1000.0]
        self._mono = scanner.time.monotonic
        scanner.time.monotonic = lambda: self.clock[0]
        self.rx = FakeRx()
        self.rng = np.random.default_rng(1)
        self.win = np.hanning(sdr.WF_FFT).astype(np.float32)
        self.sc = Scanner()
        self.tmp = tempfile.mkdtemp()
        self._log_dir, scanner.LOG_DIR = scanner.LOG_DIR, self.tmp
        self._rec_folder, scanner.rec_folder = scanner.rec_folder, lambda: os.path.join(self.tmp, "scan")

    def tearDown(self):
        scanner.time.monotonic = self._mono
        scanner.LOG_DIR, scanner.rec_folder = self._log_dir, self._rec_folder
        shutil.rmtree(self.tmp, ignore_errors=True)

    def spectrum(self, tones):
        n = sdr.WF_SEGMENTS * sdr.WF_FFT
        t = np.arange(n)
        iq = (self.rng.normal(size=n) + 1j * self.rng.normal(size=n)) * 1e-3
        for tone in tones:
            f, a = tone[:2]
            off = f - self.rx.cfg["center_hz"]
            if abs(off) < self.rx.fs / 2:
                ph = 2 * np.pi * off / self.rx.fs * t
                if len(tone) > 2:                          # ("fm"): broadcast FM, music-like modulation, 75 kHz peak
                    m = np.convolve(self.rng.normal(size=n), np.ones(64) / 8, "same")
                    ph = ph + 2 * np.pi * 75e3 * np.cumsum(np.clip(m / 3, -1, 1)) / self.rx.fs
                iq += a * np.exp(1j * ph)
        segs = iq.reshape(sdr.WF_SEGMENTS, sdr.WF_FFT) * self.win
        return np.fft.fftshift(np.mean(np.abs(np.fft.fft(segs, axis=1)) ** 2, axis=0)) / self.win.sum() ** 2

    def run_blocks(self, n, tones):
        for _ in range(n):
            self.rx.wf_power = self.spectrum(tones)
            self.sc.block(self.rx, 0)
            self.sc.audio(np.full(2040, 0.1, np.float32), 24000.0)
            self.clock[0] += BLOCK_S
        return self.sc.info()

    def cur(self):
        if self.sc.cur is None:
            return None
        m = self.sc.meta[self.sc.cur]
        return m["name"] or int(m["freq"])

    def test_windows_and_exclusions(self):
        mems = [{"id": f"m{i}", "name": f"CH{i}", "freq_hz": f, "mode": "AM", "bw": 8000, "groups": ["Air"]}
                for i, f in enumerate([118.1e6, 118.5e6, 121.5e6, 132.0e6])]
        mems += [{"id": "d", "name": "DSD", "freq_hz": 446e6, "mode": "DSD", "bw": 12500, "groups": []},
                 {"id": "o", "name": "off", "freq_hz": 119e6, "mode": "AM", "bw": 8000, "groups": [], "scan": False}]
        self.assertIsNone(self.sc.start(mems, norm_opts({}), self.rx))
        self.run_blocks(1, [])
        self.assertEqual(self.sc.n, 4)
        self.assertEqual(len(self.sc.windows), 3)          # 118.1 + 118.5 share one window
        self.assertEqual({x["id"] for x in self.sc.excluded}, {"d", "o"})
        for w in self.sc.windows:                          # no channel on the DC spike
            self.assertTrue(all(abs(f - w["center"]) >= scanner.DC_GAP_HZ for f in self.sc.f))

    def test_hold_whole_transmission_then_hang(self):
        mems = [{"id": "a", "name": "A", "freq_hz": 118.1e6, "mode": "AM", "bw": 8000, "groups": []},
                {"id": "b", "name": "B", "freq_hz": 121.5e6, "mode": "AM", "bw": 8000, "groups": []}]
        self.sc.start(mems, norm_opts({"hang_s": 2.0}), self.rx)
        self.run_blocks(20, [])
        self.assertEqual(self.run_blocks(12, [(121.5e6, 0.05)])["state"], "listen")
        self.assertEqual(self.cur(), "B")
        self.run_blocks(80, [(121.5e6, 0.05)])             # 7 s of signal: the floor must not rise and end it
        self.assertEqual(self.cur(), "B")
        self.assertTrue(self.sc.audio_open)
        self.run_blocks(10, [])                            # in the hang: still there, muted
        self.assertEqual(self.cur(), "B")
        self.assertFalse(self.sc.audio_open)
        self.assertEqual(self.run_blocks(20, [])["state"], "search")
        self.assertEqual(self.rx.cfg["tune_hz"], 118.1e6)  # next window

    def test_priority_skip_own_squelch_step(self):
        mems = [{"id": "a", "name": "A", "freq_hz": 118.1e6, "mode": "AM", "bw": 8000, "groups": []},
                {"id": "b", "name": "B", "freq_hz": 118.5e6, "mode": "AM", "bw": 8000, "groups": [], "scan_prio": 1},
                {"id": "c", "name": "C", "freq_hz": 118.7e6, "mode": "FM", "bw": 12500, "groups": [], "scan_sq": -40}]
        self.sc.start(mems, norm_opts({}), self.rx)
        self.run_blocks(15, [])
        self.run_blocks(5, [(118.1e6, 0.02)])
        self.assertEqual(self.cur(), "A")
        self.run_blocks(3, [(118.1e6, 0.02), (118.5e6, 0.02)])
        self.assertEqual(self.cur(), "B")                  # priority wins while A is heard
        self.sc.command("skip")
        self.run_blocks(3, [(118.1e6, 0.02), (118.5e6, 0.02)])
        self.assertEqual(self.cur(), "A")                  # B skipped
        self.run_blocks(40, [(118.7e6, 0.003)])            # C at ~-50 dBFS, below its own SQ -40
        self.assertIsNone(self.cur())
        self.run_blocks(3, [(118.7e6, 0.05)])
        self.assertEqual((self.cur(), self.rx.cfg["mode"], self.rx.cfg["bandwidth"]["FM"]), ("C", "FM", 12500.0))
        self.sc.command("step", dir=1)
        self.run_blocks(1, [])
        self.assertEqual((self.cur(), self.sc.paused), ("A", True))
        self.sc.command("stop")
        self.assertEqual(self.run_blocks(1, [])["state"], "off")

    def test_squelch_off_uses_auto_squelch(self):
        """AUTO SQUELCH off and the squelch of the mode off: the channel is scanned with the auto squelch (it is not
        left out and does not hold the scan on noise); a failed start lists why the channels were left out."""
        mems = [{"id": "a", "name": "A", "freq_hz": 145.5e6, "mode": "FM", "bw": 12500, "groups": []}]
        self.assertIsNone(self.sc.start(mems, norm_opts({"asq": False}), self.rx))
        self.run_blocks(30, [])
        self.assertEqual(self.sc.state, "search")
        self.run_blocks(10, [(145.5e6, 0.05)])
        self.assertEqual(self.cur(), "A")
        sc = Scanner()
        err = sc.start([dict(mems[0], scan=False)], norm_opts({}), self.rx)
        self.assertIn("SCAN off in the memory", err)
        self.assertEqual(sc.info(full=True)["excluded_list"][0]["id"], "a")


    def test_range_airband_strongest_store_log_rec(self):
        stored = []
        self.sc.on_store = stored.append
        opts = norm_opts({"source": "range", "from_hz": 118e6, "to_hz": 136.99167e6, "step_hz": 25000 / 3,
                          "mode": "AM", "bw": 8000, "store": True, "rec": True, "pick": "strongest", "hang_s": 1.0})
        self.assertIsNone(self.sc.start([], opts, self.rx))
        self.run_blocks(1, [])
        self.assertEqual(self.sc.n, 2280)
        w = self.sc.windows
        self.assertGreater(len(w), 10)
        self.run_blocks(60, [])                            # one pass through all windows: floors learned
        # two signals in one window, between grid channels too: the strongest one, on its nearest grid channel
        tones = [(127.4e6 + 2000, 0.02), (127.7e6, 0.05)]
        for _ in range(80):
            self.run_blocks(1, tones)
            if self.sc.state == "listen":
                break
        self.assertEqual(self.cur(), 127700000)
        self.run_blocks(30, tones)
        self.run_blocks(30, [])                            # dropped + hang -> activity ends
        self.assertEqual(stored[0]["freq_hz"], 127700000)
        self.assertEqual(stored[0]["groups"][0][:5], "Scan ")
        rows = scanner.read_log(1)
        self.assertEqual(int(rows[0]["freq_hz"]), 127700000)
        self.assertGreater(float(rows[0]["duration_s"]), 2.0)
        wav = os.path.join(self.tmp, "scan", rows[0]["file"])
        self.assertTrue(rows[0]["file"].endswith(".wav") and os.path.getsize(wav) > 44)
        hm = scanner.heatmap(1)
        self.assertEqual(hm["rows"][0]["freq_hz"], 127700000)

    def test_session_old_rows_prune(self):
        """THIS SCAN shows only its session; rows of older files (no session column) are read; old files are pruned."""
        import time
        now = time.time()
        with open(scanner.log_path(now), "w", encoding="utf-8", newline="") as f:
            f.write("time_utc,vfo,freq_hz,name,mode,duration_s,max_dbfs,snr_db,file,note\n"
                    "2026-11-11 10:00:00Z,D,145500000,old,FM,2.0,-40,20,,\n")
        mems = [{"id": "a", "name": "A", "freq_hz": 118.1e6, "mode": "AM", "bw": 8000, "groups": []}]
        self.sc.start(mems, norm_opts({"hang_s": 0.5}), self.rx, session="S1")
        self.run_blocks(20, [])
        self.run_blocks(15, [(118.1e6, 0.05)])
        self.sc.command("session", session="S2")            # CLR while heard: the activity is closed under S1
        self.run_blocks(15, [(118.1e6, 0.05)])
        self.run_blocks(20, [])
        self.assertEqual(len(scanner.read_log(1, now=now)), 3)
        self.assertEqual([r["name"] for r in scanner.read_log(1, now=now, session="S1")], ["A"])
        self.assertEqual(len(scanner.read_log(1, now=now, session="S2")), 1)
        self.assertEqual(scanner.read_log(1, now=now, session="none"), [])
        self.assertEqual(len(scanner.heatmap(1, now=now, session="S2")["rows"]), 1)
        self.assertEqual(scanner.signature(norm_opts({"source": "fav"})), "mem:fav:")
        self.assertNotEqual(scanner.signature(norm_opts({"source": "view", "from_hz": 145e6, "to_hz": 146e6})),
                            scanner.signature(norm_opts({"source": "view", "from_hz": 145e6, "to_hz": 147e6})))
        old = scanner.log_path(now - 40 * 86400)
        open(old, "w").close()
        self.assertEqual(scanner.prune(31, now=now), 1)
        self.assertFalse(os.path.exists(old))
        self.assertTrue(os.path.exists(scanner.log_path(now)))

    def test_view_keeps_the_centre(self):
        """VISIBLE BAND: the whole band shown is scanned without moving the tuner (no windows), also when listening."""
        centre = self.rx.cfg["center_hz"]
        moved = []
        self.rx.sdr.set_center_freq = moved.append
        half = self.rx.fs / 2
        opts = norm_opts({"source": "view", "from_hz": centre - half, "to_hz": centre + half, "step_hz": 12500,
                          "mode": "FM", "bw": 12500})
        self.assertIsNone(self.sc.start([], opts, self.rx))
        self.run_blocks(30, [])
        self.assertEqual(self.sc.windows, [])
        self.assertEqual(self.rx.cfg["mode"], "FM")        # the VFO takes the mode of the scan at START
        self.assertGreater(self.sc.n, 100)                 # the band but its edges
        self.assertGreater(self.sc.n_excluded, 0)
        f = centre + half * 0.8                            # beyond a range window (0.75), still in the band
        f = float(self.sc.f[np.argmin(np.abs(self.sc.f - f))])
        self.run_blocks(10, [(f, 0.05)])
        self.assertEqual(self.cur(), int(f))
        self.assertEqual(self.rx.cfg["center_hz"], centre)
        self.assertEqual(moved, [])

    def test_lock_row(self):
        """✕ of a row: the channel heard is locked out until STOP (the scan leaves it), again = back in."""
        mems = [{"id": "a", "name": "A", "freq_hz": 118.1e6, "mode": "AM", "bw": 8000, "groups": []},
                {"id": "b", "name": "B", "freq_hz": 118.3e6, "mode": "AM", "bw": 8000, "groups": []}]
        self.sc.start(mems, norm_opts({}), self.rx)
        self.run_blocks(20, [])
        self.run_blocks(10, [(118.1e6, 0.05)])
        self.assertEqual(self.cur(), "A")
        self.sc.command("lock", id="a")
        self.run_blocks(10, [(118.1e6, 0.05)])
        self.assertEqual(self.sc.state, "search")
        self.sc.command("unlock", id="a")
        self.run_blocks(10, [(118.1e6, 0.05)])
        self.assertEqual(self.cur(), "A")

    def test_carrier_lockout(self):
        mems = [{"id": "a", "name": "A", "freq_hz": 118.1e6, "mode": "AM", "bw": 8000, "groups": []}]
        self.sc.start(mems, norm_opts({"carrier_min": 0.1}), self.rx)
        self.run_blocks(15, [])
        self.run_blocks(5, [(118.1e6, 0.05)])
        self.assertEqual(self.cur(), "A")
        self.run_blocks(80, [(118.1e6, 0.05)])             # > 6 s open
        self.assertIsNone(self.cur())
        self.assertIn(0, self.sc.locked)
        self.assertEqual(scanner.read_log(1)[0]["note"], "carrier lockout")

    def test_priority_look_into_other_window(self):
        mems = [{"id": "a", "name": "A", "freq_hz": 118.1e6, "mode": "AM", "bw": 8000, "groups": []},
                {"id": "p", "name": "P", "freq_hz": 125.0e6, "mode": "AM", "bw": 8000, "groups": [], "scan_prio": 1}]
        self.sc.start(mems, norm_opts({"prio_s": 1.0}), self.rx)
        self.run_blocks(30, [])
        self.run_blocks(8, [(118.1e6, 0.05)])
        self.assertEqual(self.cur(), "A")
        self.run_blocks(40, [(118.1e6, 0.05)])             # P quiet: looks, comes back to A
        self.assertEqual((self.cur(), self.sc.state in ("listen", "peek")), ("A", True))
        for _ in range(40):
            self.run_blocks(1, [(118.1e6, 0.05), (125.0e6, 0.05)])
            if self.cur() == "P":
                break
        self.assertEqual(self.cur(), "P")

    def test_rec_switched_on_while_scanning(self):
        mems = [{"id": "a", "name": "A", "freq_hz": 121.5e6, "mode": "AM", "bw": 8000, "groups": []}]
        self.sc.start(mems, norm_opts({"rec": False}), self.rx)
        self.run_blocks(20, [])
        self.sc.command("opts", opts=norm_opts({"rec": True, "source": "fav"}))
        self.run_blocks(30, [(121.5e6, 0.05)])
        self.assertTrue(self.sc.opts["rec"])
        self.assertEqual(self.sc.opts["source"], "all")    # what is scanned changes only with START
        self.assertTrue(self.sc.rec_file and os.listdir(os.path.join(self.tmp, "scan")))

    def test_fm_bcast_finds_the_stations_again_in_every_pass(self):
        # the core power of a station goes up and down with its audio (loud music spreads it): those dips must not be
        # learned as the noise floor of the station, else it is not found in the next pass
        self.assertIsNone(self.sc.start([], norm_opts({"source": "fmbc", "fm_s": 3.0}), self.rx))
        heard, k = [], 0
        for _ in range(900):
            k += 1
            a = 0.004 if k % 3 else 0.0015                 # −8.5 dB every third block
            self.run_blocks(1, [(88.5e6, a, "fm"), (88.9e6, a, "fm"), (95.0e6, a, "fm")])
            if self.sc.state == "listen" and (not heard or heard[-1] != self.rx.cfg["tune_hz"]):
                heard.append(self.rx.cfg["tune_hz"])
            if len(heard) == 9:
                break
        self.assertEqual(heard, [88.5e6, 88.9e6, 95.0e6] * 3)

    def test_fm_bcast_lands_on_the_station_centre(self):
        self.assertEqual(norm_opts({"mode": "AM"}, {"mode": "USB"})["mode"], "AM")
        self.assertEqual(norm_opts(None, {"mode": "WFM"})["mode"], "FM")
        with self.assertRaises(ValueError):
            norm_opts({"mode": "WFM"})
        stations = [(88.5e6, 0.02, "fm"), (89.85e6, 0.01, "fm"), (95.0e6, 0.02, "fm")]
        self.assertIsNone(self.sc.start([], norm_opts({"source": "fmbc", "fm_s": 1.0, "store": True}), self.rx))
        stored = []
        self.sc.on_store = stored.append
        self.run_blocks(1, stations)
        self.assertEqual(self.sc.n, 401)
        self.assertEqual(self.rx.cfg["mode"], "WFM")
        self.assertGreaterEqual(self.rx.cfg["bandwidth"]["WFM"], scanner.FMBC_BW_MIN)
        for w in self.sc.windows:                          # tuner centre halfway between two grid points
            self.assertAlmostEqual((w["center"] - scanner.FMBC_DC_OFF) % scanner.FMBC_STEP, 0.0, delta=1)
        heard = []
        for _ in range(400):
            self.run_blocks(1, stations)
            if self.sc.state == "listen" and (not heard or heard[-1] != self.rx.cfg["tune_hz"]):
                heard.append(self.rx.cfg["tune_hz"])
            if len(heard) == 4:
                break
        self.assertEqual(heard, [88.5e6, 89.85e6, 95.0e6, 88.5e6])   # each centre, up the band, then again
        self.assertEqual([e["freq_hz"] for e in stored], [88500000, 89850000, 95000000])
        self.assertTrue(stored[0]["groups"][0].startswith("FM ") and stored[0]["mode"] == "WFM")


if __name__ == "__main__":
    unittest.main()
