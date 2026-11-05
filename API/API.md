# RADIMCOM HTTP API – Ver. 0.109

The web page talks to the receivers through this HTTP API, and you can use it too (scripts, curl, other programs).
Requests and responses are JSON unless stated otherwise. Errors return `{"error": "..."}` with HTTP 400 (bad input),
404 (not found) or 500 (device error).

Frequencies are always the **real** frequency in Hz (the upconverter LO is handled by the receiver).

## Ports

With `data\vfos.json` (several VFOs), the launcher starts one receiver process per VFO, each with its own port and API:

| Port | Process | API |
|---|---|---|
| 8434 | launcher | web page, `/api/vfos` |
| 8441 | VFO A | full receiver API |
| 8442 | VFO B | full receiver API |
| 8443 | VFO C | full receiver API |
| 8444 | VFO D | full receiver API |

Ports and VFO names come from `data\vfos.json` (`port` and `vfos[].port`); the table shows the default setup.
Without `vfos.json` there is a single receiver; its port is in `data\config.json`.

A chained VFO (`"chain": "A"` in `vfos.json`) shares the dongle of VFO A. VFO A sends it the samples on
`127.0.0.1`, port of VFO A + 100 (e.g. 8541; internal, not an HTTP API).

Memories (`data\memories.json`) are shared by all VFOs, so `/api/memories` gives the same data on every VFO port.

## Launcher

| Method | Path | Description |
|---|---|---|
| GET | `/` | web page |
| GET | `/api/vfos` | list of VFOs: `[{"name", "port", "serial", "note", "chain"}]`; `chain` = name of the VFO whose dongle a chained VFO uses, otherwise `null` |

## Receiver: state and control

| Method | Path | Description |
|---|---|---|
| GET | `/` | web page |
| GET | `/api/state` | full state of this VFO (see below) |
| POST | `/api/set` | change settings: send only the keys to change; returns `{"ok": true}` |
| GET | `/api/devices` | connected SDR devices |
| GET | `/api/events` | live event stream (Server-Sent Events) |
| GET | `/api/audio` | endless audio stream (raw PCM) |
| GET | `/api/mpx` | WFM: spectrum of the demodulated MPX signal, 0–20 kHz |
| POST | `/api/tx` | transmitter PTT (LimeSDR only) |

### GET /api/state

Main fields:

| Field | Meaning |
|---|---|
| `tune_hz`, `center_hz` | tuned frequency, centre of the spectrum (Hz) |
| `mode` | `AM`, `FM`, `WFM`, `LSB`, `USB`, `CW` |
| `bandwidth` | filter width per mode, e.g. `{"USB": 2700, "FM": 12500}` |
| `gain`, `gains` | current gain (`"auto"` or dB), available gains |
| `smeter` | signal level (dBFS) |
| `squelch`, `squelch_levels`, `squelch_open` | squelch for the current mode, per mode, open now |
| `sample_rate`, `audio_rate` | dongle sample rate, audio rate (S/s) |
| `zoom`, `zooms` | spectrum zoom, allowed zooms |
| `upconv`, `lo_offset_hz`, `lo_hz` | upconverter mode (`auto`/`on`/`off`), its LO, LO in use now (0 = direct) |
| `range` | tuning range of this VFO |
| `vfo`, `serial`, `driver`, `device` | VFO name, dongle serial, `rtl` or `lime`, device index |
| `chain_owner`, `out_of_band`, `chained_vfos` | chained VFO: VFO that owns the dongle (`null` otherwise), tuned outside the owner's band (silent, OOR); owner VFO: number of chained VFOs connected |
| `ppm`, `rtl_agc`, `audio_agc`, `notch`, `notch_active`, `bias_tee`, `stereo_on`, `stereo`, `rds` | receiver options and WFM stereo / RDS |
| `afi`, `afi_hz` | audio frequency inversion (voice scrambler / descrambler) on/off and its inversion frequency in Hz |
| `lpf`, `lpf_hz`, `hpf`, `hpf_hz` | audio low-pass and high-pass filter on/off and their cutoff frequencies in Hz |
| `status`, `error`, `opened`, `dropped`, `hw` | device status, last error, open flag, dropped blocks, LimeSDR stream info |
| `ft8`, `cw`, `rtty`, `wefax`, `sstv`, `acars`, `vdl2`, `cpdlc` | decoders on/off |
| `ft8_error`, `vdl2_error` | decoder errors |
| `dab`, `dab_channel`, `dab_error` | DAB on/off, Band III channel (e.g. `12C`), welle-cli error |
| `logs` | daily logs on/off: `{"ft8", "wefax", "cw", "rtty", "sstv", "acars"}` (`acars` covers both the ACARS and the VDL2 log) |
| `tx_capable`, `tx_enabled`, `can_tx`, `tx`, `tx_info` | transmitter (LimeSDR) |
| `wf` | waterfall format: `bins`, `db_min`, `db_step`, `rows_per_s` |

`/api/state` also returns the constants `sample_rates`, `modes`, `ft8_freqs`, `acars_freqs`, `vdl2_freqs`,
`vdl2_center`, `vdl2_rate`, `dab_channels` (`[[name, Hz], …]`).

### POST /api/set

Send any combination of these keys:

| Key | Value |
|---|---|
| `tune_hz` | tuned frequency (Hz); checked against the tuner range and the upconverter. A chained VFO accepts any frequency; outside the owner's band it is silent (`out_of_band`) |
| `center_hz` | centre of the spectrum (Hz) |
| `view_hz` | visible part of the spectrum (Hz) |
| `mode` | `AM`, `FM`, `WFM`, `LSB`, `USB`, `CW` |
| `bandwidth` | Hz, for the current (or the sent) mode: WFM 50000–250000, FM 500–50000, others 100–18000 |
| `gain` | dB or `"auto"` |
| `rtl_agc`, `audio_agc`, `notch`, `afi`, `lpf`, `hpf`, `stereo_on`, `bias_tee` | true / false |
| `afi_hz` | AFI inversion frequency, 500 – 4000 Hz (default 1750; audio is mirrored f → 2·afi_hz − f) |
| `lpf_hz` | LPF cutoff, 100 – 15000 Hz (default 3000) |
| `hpf_hz` | HPF cutoff, 20 – 5000 Hz (default 300). With both filters on, `hpf_hz` above `lpf_hz` gives silence (the web UI keeps them in order, the API does not) |
| `squelch` | dBFS, -120 (off) to 0; optional `squelch_mode` = the mode it applies to |
| `sample_rate` | 1024000, 1536000, 2048000, 2100000, 2400000 |
| `zoom` | 1, 2, 4, 8, 16, 32 |
| `ppm` | frequency correction (integer) |
| `upconv` | `auto`, `on`, `off` |
| `lo_offset_hz` | upconverter LO, 0 to 1 000 000 000 Hz |
| `device` | device index (single-receiver mode) |
| `reset` | `true` = reset the dongle |
| `ft8`, `cw`, `rtty`, `wefax`, `sstv`, `acars`, `vdl2` | decoders on / off. `vdl2: true` switches the VFO to 2.1 MS/s around 136.850 MHz and turns ACARS off (RTL-SDR only); `acars: true` turns VDL2 off |
| `dab`, `dab_channel` | DAB on / off and channel. `dab: true` starts welle-cli and switches the VFO to 2.048 MS/s on the channel centre (ACARS and VDL2 off, RTL-SDR only); `dab: false` restores the sample rate; `dab_channel` alone retunes a running DAB |
| `log` | daily logs, e.g. `{"log": {"cw": true, "ft8": false}}` |
| `tx_enabled` | allow transmitting (only on a VFO that can transmit) |

### GET /api/events (Server-Sent Events)

On connect a `status` event with the full state, then:

| Event | Data |
|---|---|
| `status` | full state (as `/api/state`) after a change |
| `wf` | waterfall row |
| `meter` | S-meter level in dBFS, `{"db": -73.5}`, for every block of samples (as often as `wf`) |
| `ft8`, `ft8cycle` | FT8 decode; start of a 15 s cycle |
| `cwtext`, `cwstate` | CW text; CW decoder state (speed, tone, …) |
| `rttytext`, `rttystate` | RTTY text; decoder state |
| `wefaxrow`, `wefaxstate`, `wefaxnew`, `wefaxtrim`, `wefaxreload` | WEFAX image rows, state, new image, trimmed image, image changed (slant correction: load it again) |
| `sstvrow`, `sstvstate`, `sstvnew`, `sstvdone` | SSTV image rows, state, new image, finished image |
| `acars`, `acarsinfo`, `acarsstate` | ACARS / VDL2 message, later added details (ADS-B lookup), state |
| `cpdlc`, `cpdlcstate` | CPDLC message, state |
| `vdl2state` | VDL2 decoder state |
| `dabstate` | DAB state (channel, welle-cli connected, dongle on channel, error) |

A comment line `: ping` is sent every 15 s when nothing else happens.

### GET /api/audio

Endless stream of 16-bit signed little-endian stereo PCM (L, R interleaved). Headers `X-Sample-Rate` and
`X-Channels` give the format.

### GET /api/mpx

`{"hz_per_bin": 62.5, "db": [...]}`: spectrum of the demodulated MPX signal from 0 to 20 kHz, taken before the 19 kHz pilot
is removed. 0 dB is a sine at 75 kHz deviation. Outside WFM, `db` is empty and `hz_per_bin` is 0.

### POST /api/tx

`{"ptt": true}` starts transmitting on `tune_hz`, `{"ptt": false}` stops. Only on a LimeSDR VFO, with
`tx_enabled` on and the upconverter off. While transmitting, `{"ptt": true}` must be repeated at least every
1.5 s (keepalive), otherwise a watchdog turns TX off; one transmission is limited to 120 s. In FM mode the TX audio file is sent if present. Returns the state.

## Decoders

| Method | Path | Description |
|---|---|---|
| GET | `/api/dsd` | DSD mode: `enabled`, `installed`, `error`, `protocol`, `slot`, detected `proto` and `cc`, running calls in `active`, finished calls in `calls`, the allowed values in `protocols` and `slots` |
| POST | `/api/dsd` | `{"protocol": "auto"}` and/or `{"slot": "both"}` (restarts the decoder), `{"action": "clear"}` |
| GET | `/api/ft8` | recent FT8 decodes |
| GET | `/api/cw` | CW decoder info and text |
| POST | `/api/cw` | `{"action": "clear"}` |
| GET | `/api/rtty` | RTTY decoder info and text |
| POST | `/api/rtty` | `{"action": "clear"}` and/or `{"opts": {...}}` (decoder options, saved to the config) |
| GET | `/api/acars` | ACARS / VDL2 messages; VDL2 ones have `vdl2.gs` (ground station address) and `vdl2.gs_loc` (`BTS/LZIB`, `-` if not known), `vdl2.gs_city` (`Bratislava`, empty if not known) and `vdl2.gs_info` (entry in the ground station list, `LHBP Budapest Hungary 136.825`, empty if not there) |
| POST | `/api/acars` | `{"action": "clear"}` |
| GET | `/api/cpdlc` | CPDLC messages |
| POST | `/api/cpdlc` | `{"action": "clear"}` |
| GET | `/api/vdl2` | VDL2 decoder info |
| GET | `/api/dab` | DAB ensemble: label, SNR, services (`sid`, `label`, `pty`, `type` DAB / DAB+, `bitrate`, `dls`, `mot_time`, error counters) |
| GET | `/api/dab/audio/<sid>` | MP3 audio stream of a service (welle-cli decodes it while somebody listens) |
| GET | `/api/dab/slide/<sid>` | last slideshow picture (JPEG / PNG), 204 if none |
| GET | `/api/wefax` | WEFAX decoder info |
| POST | `/api/wefax` | `{"action": "new"}` new image, `{"action": "phase", "x": 0.0–1.0}` set the line start, `{"lpm_mode": ...}`, `{"ioc_mode": ...}`, `{"slant_ppm": -3000–3000}` slant correction (saved; the image so far is straightened too) |
| GET | `/api/wefax/image.png` | current WEFAX image (PNG) |
| GET | `/api/sstv` | SSTV decoder info |
| POST | `/api/sstv` | `{"mode": "auto"}` or a mode name, `{"action": "stop"}` |
| GET | `/api/sstv/image.png` | current SSTV image (PNG) |
| GET | `/api/sstv/files/<name>` | saved SSTV image |

## Memories

A memory: `{"id", "name", "group", "freq_hz", "mode", "bw", "fav"}`.

| Method | Path | Description |
|---|---|---|
| GET | `/api/memories` | all memories |
| POST | `/api/memories` | add: `{"name", "group", "freq_hz", "mode", "bw"}`; returns the new memory with its `id`. Name up to 80 characters, group up to 40, frequency 0–1766 MHz, `bw` clamped to the mode's range |
| PATCH | `/api/memories/<id>` | change `{"fav": true/false}` and/or `{"name": "..."}` |
| DELETE | `/api/memories/<id>` | delete |
| POST | `/api/memories/import` | import from SDR#: `{"path": "C:\\SDRSharp"}`. Reads `frequencies.xml` in the folder and in profile subfolders (e.g. `Instances\Profile1`), or a single profile folder / `frequencies.xml`. Duplicates (same frequency and name) are skipped. Returns `{"added", "skipped", "files", "errors"}` |

Export (EXPORT ★ / EXPORT group in the MEM drawer) is done in the browser from `GET /api/memories`.

## Examples

```bash
# VFO list
curl http://localhost:8434/api/vfos

# state of VFO A
curl http://localhost:8441/api/state

# tune VFO C to PMR01, FM 12.5 kHz
curl -X POST http://localhost:8443/api/set -H "Content-Type: application/json" -d "{\"tune_hz\":446006250,\"mode\":\"FM\",\"bandwidth\":12500}"

# FT8 decoder on VFO A on
curl -X POST http://localhost:8441/api/set -H "Content-Type: application/json" -d "{\"ft8\":true}"

# add a memory
curl -X POST http://localhost:8441/api/memories -H "Content-Type: application/json" -d "{\"name\":\"CB19\",\"group\":\"CB\",\"freq_hz\":27185000,\"mode\":\"FM\",\"bw\":10000}"

# star a memory
curl -X PATCH http://localhost:8441/api/memories/<id> -H "Content-Type: application/json" -d "{\"fav\":true}"

# follow the events
curl -N http://localhost:8441/api/events
```

```python
import json, urllib.request

def api(port, path, body=None, method=None):
    req = urllib.request.Request(f"http://localhost:{port}{path}", method=method,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req))

print(api(8441, "/api/state")["tune_hz"])
api(8443, "/api/set", {"tune_hz": 145500000, "mode": "FM"})
```

## Security

The API has no login. It listens on all network interfaces (`host` 0.0.0.0, can be changed in `data\vfos.json` /
config) and allows requests from any web page (`Access-Control-Allow-Origin: *`). Anyone on the network can tune
the receivers, change memories or, with TX enabled, key the LimeSDR. Use it on a trusted network only.
