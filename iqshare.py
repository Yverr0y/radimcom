"""VFO chaining: one dongle serves several VFOs.

The VFO that owns the dongle (the "owner", e.g. VFO A) opens it as usual and also runs an IqServer on
127.0.0.1 (its port + IQ_PORT_OFFSET). Every raw block it reads is sent to the chained VFOs
(e.g. VFO B, C, D), which use ChainedSdr instead of a real dongle. ChainedSdr has the same interface
as RtlSdr / LimeSdr, so the rest of the receiver (DSP, decoders, web page) works unchanged.

The owner controls the dongle: centre frequency, sample rate, gain, ppm, bias-tee. A chained VFO can tune
only inside the band the dongle currently receives (centre ± sample rate / 2). Dongle settings changed on a
chained VFO are forwarded to the owner by app.py.

Frame on the socket: 4 bytes header length (big endian), JSON header, payload of header["n"] bytes.
Payload "u8" = RTL-SDR raw interleaved I/Q bytes, "i16" = LimeSDR complex samples as int16 I/Q (±32767 = ±1.0).
"""
import json
import queue
import socket
import struct
import threading

import numpy as np

IQ_PORT_OFFSET = 100      # IQ port = VFO port + 100 (8441 -> 8541), unless vfos.json gives "iq_port"
CLIENT_QUEUE = 8          # blocks waiting per chained VFO (~0.5 s); a slow one loses the oldest
CONNECT_TIMEOUT_S = 3.0
READ_TIMEOUT_S = 5.0


def iq_port(vfo):
    return int(vfo.get("iq_port") or int(vfo["port"]) + IQ_PORT_OFFSET)


class IqServer:
    """Owner side: sends every raw block with its metadata to all connected chained VFOs."""

    def __init__(self, port, host="127.0.0.1"):
        self.lock = threading.Lock()
        self.clients = []
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.sock.bind((host, port))
        self.sock.listen(8)
        threading.Thread(target=self._accept, name="iq-accept", daemon=True).start()

    @property
    def count(self):
        with self.lock:
            return len(self.clients)

    def _accept(self):
        while True:
            try:
                conn, _ = self.sock.accept()
            except OSError:
                return
            conn.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
            conn.setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 4 << 20)
            q = queue.Queue(maxsize=CLIENT_QUEUE)
            with self.lock:
                self.clients.append(q)
            threading.Thread(target=self._send, args=(conn, q), name="iq-send", daemon=True).start()

    def _send(self, conn, q):
        try:
            while True:
                head, payload = q.get()
                conn.sendall(struct.pack(">I", len(head)) + head)
                conn.sendall(payload)
        except OSError:
            pass                                    # the chained VFO went away
        finally:
            with self.lock:
                if q in self.clients:
                    self.clients.remove(q)
            conn.close()

    def publish(self, raw, meta):
        with self.lock:
            qs = list(self.clients)
        if not qs:
            return
        if raw.dtype == np.complex64:               # LimeSDR: half the data as int16
            payload = (raw.view(np.float32) * 32767).clip(-32767, 32767).astype("<i2").tobytes()
            kind = "i16"
        else:
            payload = raw.tobytes()
            kind = "u8"
        head = json.dumps(dict(meta, kind=kind, n=len(payload))).encode()
        for q in qs:
            try:
                q.put_nowait((head, payload))
            except queue.Full:
                try:                                # slow client: drop the oldest block
                    q.get_nowait()
                    q.put_nowait((head, payload))
                except (queue.Empty, queue.Full):
                    pass


class ChainedSdr:
    """Chained VFO side: a "dongle" that gets its samples from the owner VFO.
    Dongle settings are applied by the owner, so the setters do nothing here."""

    def __init__(self, port, owner, host="127.0.0.1"):
        self.owner = owner
        try:
            self.sock = socket.create_connection((host, port), timeout=CONNECT_TIMEOUT_S)
        except OSError:
            raise RuntimeError(f"VFO {owner} (owner of the shared dongle) is not running") from None
        self.sock.settimeout(READ_TIMEOUT_S)
        self._cancel = False
        self.meta, self._first = self._read()          # the first block gives gains, driver…
        self.gains = self.meta.get("gains", [])
        self.has_bias_tee = self.meta.get("has_bias_tee", True)
        self.has_rtl_agc = self.meta.get("has_rtl_agc", True)
        self.smeter_offset = self.meta.get("smeter_offset", 0.0)

    def _recv(self, n):
        buf = bytearray(n)
        view = memoryview(buf)
        got = 0
        while got < n:
            try:
                k = self.sock.recv_into(view[got:])
            except socket.timeout:
                raise RuntimeError(f"VFO {self.owner} sends no samples") from None
            if not k:
                raise RuntimeError(f"VFO {self.owner} closed the shared dongle")
            got += k
        return buf

    def _read(self):
        (hl,) = struct.unpack(">I", self._recv(4))
        meta = json.loads(bytes(self._recv(hl)))
        payload = self._recv(meta["n"])
        if meta["kind"] == "i16":
            iq = np.frombuffer(payload, "<i2").astype(np.float32) * np.float32(1 / 32767)
            return meta, iq.view(np.complex64)
        return meta, np.frombuffer(payload, np.uint8)

    # same interface as RtlSdr / LimeSdr
    def set_sample_rate(self, rate): pass
    def set_center_freq(self, hz): pass
    def set_gain(self, gain): pass
    def set_rtl_agc(self, on): pass
    def set_bias_tee(self, on): pass
    def set_ppm(self, ppm): pass
    def reset_buffer(self): pass

    def read_async(self, on_block):
        """Blocks until cancel_async; each block goes to on_block as (meta, samples)."""
        on_block((self.meta, self._first))
        try:
            while not self._cancel:
                meta, raw = self._read()
                self.meta = meta
                self.gains = meta.get("gains", self.gains)
                on_block((meta, raw))
        except (RuntimeError, OSError, ValueError):
            if not self._cancel:
                raise

    def cancel_async(self):
        self._cancel = True
        try:
            self.sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass

    def close(self):
        self.sock.close()
