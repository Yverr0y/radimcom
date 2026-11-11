# RADIMCOM HTTP API – Ver. 0.112

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
| GET | `/api/vfos` | list of VFOs: `[{"name", "port", "serial", "note", "chain", "rotor"}]`; `chain` = name of the VFO whose dongle a chained VFO uses, otherwise `null`; `rotor` = true on the VFO whose receiver holds the rotor (the first one) |
| GET | `/api/update` | newer version on GitHub Releases, checked once after start: `{"state": "checking" / "done" / "failed" / "off" / "downloading" / "installing", "current", "latest", "newer", "name", "url", "published", "can_upgrade", "why_not", "zip_url", "zip_size", "got", "upgrade_error"}`. Off with `"update_check": false` in `vfos.json`. A receiver started without `vfos.json` answers it itself (`"update_check"` in its config) |
| POST | `/api/update` | `{"upgrade": true}`: downloads the upgrade zip of the newer release to `data\update\`, checks it, starts `upgrade_helper.py` and closes RADIMCOM; the helper unzips the program, runs `upgrade.bat` and starts `start.bat`. Only from a page of this RADIMCOM (Origin); 409 when no upgrade is possible (`why_not`) |

## Receiver: state and control

| Method | Path | Description |
|---|---|---|
| GET | `/` | web page |
| GET | `/api/state` | full state of this VFO (see below) |
| POST | `/api/set` | change settings: send only the keys to change; returns `{"ok": true}` |
| GET | `/api/devices` | connected SDR devices |
| GET | `/api/sysload` | CPU load and memory use of the PC: `{"cpu": %, "mem": %, "mem_used": bytes, "mem_total": bytes}` |
| GET | `/api/events` | live event stream (Server-Sent Events) |
| GET | `/api/audio` | endless audio stream (raw PCM) |
| GET | `/api/mpx` | WFM: spectrum of the demodulated MPX signal, 0–20 kHz |
| POST | `/api/tx` | transmitter PTT (LimeSDR only) |
| GET | `/api/satellites` | SATELLITES tab: lists from amsat.org, `{"pages": [{"key", "title", "url", "html", "fetched", "error"}]}`; `html` is cleaned content, `fetched` is Unix time, `error` is set if the last download of that page failed. Downloads pages older than 12 hours first |
| POST | `/api/satellites` | the same, but downloads pages older than 60 s first |
| GET | `/api/sat/passes` | passes of the satellites chosen in SETUP: `?hours=` (1–72, default 48). `{"now", "hours", "setup", "tle": {"fetched", "error"}, "sats": [{"norad", "name", "tle_age_days", "tle_old"} or {"norad", "missing": true}], "passes": [{"norad", "name", "aos", "los", "max_t", "max_el", "aos_az", "los_az", "max_az", "aos_open", "los_open"}]}`; times are Unix time, angles in degrees; a pass counts when its highest elevation reaches `min_el`; `aos_open` / `los_open`: the pass is already on at the start / still on at the end. Downloads the orbital elements first when they are older than 24 hours. 503 if the sgp4 package is missing |
| GET | `/api/sat/pass` | one pass: `?norad=&aos=&los=` -> `{"norad", "name", "setup", "tle_epoch", "samples": [{"t", "az", "el", "range" (km), "rate" (km/s, + = going away), "doppler_hz_per_mhz"}]}`, a sample every 5 s |
| GET | `/api/sat/map` | world map: `{"now", "setup", "tle", "names": {norad: name}, "fields": ["t", "lat", "lon", "alt", "az", "el", "range", "rate"], "sats": [{"norad", "name", "period_min", "tle_age_days", "samples": [[...fields]]}]}` for the satellites in `map_sats`: the point below the satellite (latitude, longitude in degrees, altitude in km) and its look from the station, from half an orbit back to one orbit ahead, 240 samples each |
| GET | `/api/sat/transmitters?norad=` | active transmitters of the satellite with a downlink, from SatNOGS DB (kept in `data\sat_transmitters.json`, downloaded again after 7 days; `&refresh=1` now): `{"transmitters": [{"uuid", "description", "type", "downlink_low", "downlink_high", "uplink_low", "uplink_high", "mode", "rx_mode", "invert", "baud"}], "fetched", "error"}`, transponders first; `rx_mode` is the RADIMCOM mode used to receive it |
| GET | `/api/sat/doppler` | Doppler correction of this VFO: `{"on", "step" (Hz: the VFO is retuned when it is off by more than this, by the mode), "norad", "name", "label", "uuid", "f_nominal", "f_sat", "span", "last_set", "error", "stopped", "rate", "factor", "az", "el", "f_rx", "shift"}`; `f_sat` is the frequency sent by the satellite (moved by tuning the VFO by hand), `f_rx` the one received now, `shift` = `f_rx − f_sat` (Hz), `rate` the range rate (km/s), `stopped` why it stopped |
| POST | `/api/sat/doppler` | `{"start": {"norad", "uuid"}}` (a transmitter of `/api/sat/transmitters`; the middle of a transponder) or `{"start": {"norad", "f_hz"}}`, with `"set_mode": false` to keep the mode; `{"stop": true}` stops it. Answers like GET; 409 when the VFO refuses, 400 for a wrong start. |
| GET | `/api/sat/rotor` | satellite tracking with the rotor (only on the receiver that holds the rotor, see `/api/vfos` `rotor`; the others answer 409 `{"error", "host"}`): `{"on", "norad", "name", "state" (waiting for the pass, moving to the start, tracking), "pass": {"aos", "los", "max_el", ...}, "plan": {"mode" (normal, overlap, flipped, over top), "max_err", "mean_err" (simulated pointing error, degrees), "raw0", "raw1", "raw_min", "raw_max" (K3NG azimuth 0–450), "el_max", "options": [{"mode", "max_err", "raw0", "raw1", "move_s"}], "path": [[t, k3ng_az, el]] every 5 s}, "prep_at" (when the move to the start begins), "now": {"sat_az", "sat_el", "cmd_az", "cmd_el", "cmd_raw", "err"}, "note", "stopped", "control", "rotor_on"}` |
| POST | `/api/sat/rotor` | `{"start": {"norad", "force": false}}` (`force`: orbital elements older than 14 days) or `{"stop": true}`; only from this RADIMCOM page. 409 when the elements are too old. The rotor moves only while the rotor control is on (`/api/rotor` `{"start": true}`; the TRACK key of the page sends both), otherwise it only calculates; while tracking, `goto` in `/api/rotor` is refused |
| GET | `/api/sat/setup` | station and choice, shared by all VFOs: `{"setup": {"locator", "lat", "lon", "alt_m", "min_el", "sats": [norad], "map_sats": [norad]}, "tle": {"fetched", "error"}, "groups": [{"key", "title"}] (CelesTrak groups downloaded), "sats": [{"norad", "name", "tle_age_days", "groups": [key]}]}` (all satellites of the orbital elements) |
| POST | `/api/sat/setup` | any of `{"locator"}` or `{"lat", "lon"}`, `{"alt_m"}`, `{"min_el"}` (0–60), `{"sats": [norad]}`, `{"map_sats": [norad]}` (up to 20), `{"refresh_tle": true}` (download the orbital elements now); answers like GET, 400 with `error` for a wrong value, 502 if the download fails |

### GET /api/state

Main fields:

| Field | Meaning |
|---|---|
| `tune_hz`, `center_hz` | tuned frequency, centre of the spectrum (Hz) |
| `mode` | `AM`, `FM`, `WFM`, `LSB`, `USB`, `CW` |
| `bandwidth` | filter width per mode, e.g. `{"USB": 2700, "FM": 12500}` |
| `gain`, `gains` | current gain (`"auto"` or dB), available gains |
| `smart_agc`, `adc_peak`, `adc_clip`, `adc_clip_ppm` | AGC+ on; A/D peak of the last block (dBFS), whether it clipped and how many samples per million (measured while AGC+ is on) |
| `sagc` | AGC+ settings `{clip_ppm, heavy_ppm, down_db, heavy_db, low_dbfs, target_dbfs, hold_s, up_db, settle}` |
| `smeter` | signal level (dBFS) |
| `squelch`, `squelch_levels`, `squelch_open` | squelch level in use for the current mode (the auto level while auto squelch runs), levels set per mode, open now |
| `auto_sql`, `auto_sql_on`, `auto_sql_db`, `auto_sql_level` | ASQ key on; auto squelch running (ASQ, or AGC+ with the squelch set); margin above the noise floor in dB; current auto level in dBFS (`null` while not running or not measured yet) |
| `sample_rate`, `audio_rate` | dongle sample rate, audio rate (S/s) |
| `zoom`, `zooms` | spectrum zoom, allowed zooms |
| `upconv`, `lo_offset_hz`, `lo_hz` | upconverter mode (`auto`/`on`/`off`), its LO, LO in use now (0 = direct) |
| `range` | tuning range of this VFO |
| `vfo`, `serial`, `driver`, `device` | VFO name, dongle serial, `rtl`, `lime` or `airspy`, device index |
| `chain_owner`, `out_of_band`, `chained_vfos` | chained VFO: VFO that owns the dongle (`null` otherwise), tuned outside the owner's band (silent, OOR); owner VFO: number of chained VFOs connected |
| `ppm`, `rtl_agc`, `dc_remove`, `dc_hz`, `dc_db`, `spur_on`, `spur_hz`, `spur_edge`, `spur_shift`, `spur_db`, `spur_count`, `spur_learning`, `spur_found`, `audio_agc`, `notch`, `notch_active`, `bias_tee`, `stereo_on`, `stereo` (L−R decoded), `pilot` (19 kHz pilot locked), `rds` | receiver options and WFM stereo / RDS |
| `afi`, `afi_hz` | audio frequency inversion (voice scrambler / descrambler) on/off and its inversion frequency in Hz |
| `autotune`, `autotune_info` | ATU on/off; last autotune job `{id, state: "listen" \| "done" \| "none" \| "", shift_hz, how: "carrier" \| "comb" \| "edge", mode}` |
| `lpf`, `lpf_hz`, `hpf`, `hpf_hz` | audio low-pass and high-pass filter on/off and their cutoff frequencies in Hz |
| `status`, `error`, `opened`, `dropped`, `hw` | device status, last error, open flag, dropped blocks, LimeSDR stream info |
| `ft8`, `cw`, `rtty`, `wefax`, `sstv`, `packet`, `acars`, `vdl2`, `cpdlc` | decoders on/off |
| `ft8_error`, `vdl2_error` | decoder errors |
| `vdl2_region` | selected VDL2 channel set, `"eu"` or `"us"` |
| `audio_muted` | the audio of this VFO is muted because the ACARS, VDL2, HFDL, AIS or ISM decoder runs |
| `recording` | `{"cont": {...}, "squelch": {...}, "dropped": n}`: REC and REC SQ, each with `on`, `open` (a file is being written), `file` (current or last file in `data\recordings`), `secs` (length of the current file), `saved` (files finished since switched on), `error`; `dropped` = audio blocks lost because the disk did not keep up |
| `dab`, `dab_channel`, `dab_sids`, `dab_error` | DAB on/off, Band III channel (e.g. `12C`), last station of each channel (`{"12C": "0x5464"}`, `null` = stopped), welle-cli error |
| `logs` | daily logs on/off: `{"ft8", "wefax", "cw", "rtty", "sstv", "acars", "dsd", "ism", "packet", "hfdl", "ais"}` (`acars` covers both the ACARS and the VDL2 log) |
| `trsp_name`, `trsp_sat` | transmitter and satellite of the Doppler correction (`/api/sat/doppler`) while it is on, empty otherwise |
| `tx_capable`, `tx_enabled`, `can_tx`, `tx`, `tx_info` | transmitter (LimeSDR) |
| `wf` | waterfall format: `bins`, `db_min`, `db_step`, `rows_per_s` |

`/api/state` also returns the constants `sample_rates`, `modes`, `ft8_freqs`, `acars_freqs`, `vdl2_freqs` (channels of the
selected region), `vdl2_region_freqs` (`{"eu": […], "us": […]}`), `vdl2_center`, `vdl2_rate`, `dab_channels` (`[[name, Hz], …]`), `ism_freqs`. The state has `ism`, `ism_error` and `ism_hz`; `GET /api/ism` gives the decoder state with the last `messages`, `POST /api/ism` with `{"action": "clear"}` clears them. HFDL: `hfdl_bands` (`[{lo, hi, center, n}]` in Hz) and
`hfdl_stations` (`[{id, name, lat, lon, freqs_khz}]`); the state has `hfdl` and `hfdl_error`; `GET /api/hfdl` gives the decoder
state (`channels` decoded now, `heard` ground stations, counters) with the last `messages`, `POST /api/hfdl` with `{"action": "clear"}` clears them. Each message has `ac` (ADS-B data, `{"found": false}` when not seen, `null` while
`lookup` is true); the event `hfdlinfo` (`{id, ac}`) brings it later. AIS: `ais_center` (162000000) and `ais_channels` (`[161975000, 162025000]`);
the state has `ais` and `ais_error`; `GET /api/ais` gives the decoder state (`channels` decoded now, `levels` per channel in dBFS, counters) with the last
`messages` (each with `type`, `type_name`, `mmsi`, `cc`, `country`, `station`, `name`, `callsign`, `shiptype`, `status`, `lat`, `lon`, `sog`, `cog`, `hdg`,
`dest`, `text`, `nmea`, `channel`, `freq_hz`, `level`, `time`) and `ships` (the newest data of each station: the same fields plus `pos_time`, `imo`, `size`,
`draught`, `eta`, `first`, `last`, `n`); `POST /api/ais` with `{"action": "clear"}` clears them. The event `ais` carries a message with `ship`,
the newest data of its station; `aisstate` the decoder state.

### POST /api/set

Send any combination of these keys:

| Key | Value |
|---|---|
| `tune_hz` | tuned frequency (Hz); checked against the tuner range and the upconverter. A chained VFO accepts any frequency; outside the owner's band it is silent (`out_of_band`) |
| `center_hz` | centre of the spectrum (Hz) |
| `view_hz` | visible part of the spectrum (Hz) |
| `mode` | `AM`, `FM`, `WFM`, `LSB`, `USB`, `CW` |
| `bandwidth` | Hz, for the current (or the sent) mode: WFM 50000–250000, FM 500–50000, others 100–18000 |
| `gain` | dB or `"auto"`; ends AGC+ |
| `sagc` | AGC+ settings: an object with some of `clip_ppm` (0–1000), `heavy_ppm` (1–100000), `down_db` (0.5–15), `heavy_db` (1–30), `low_dbfs` (−40…−1), `target_dbfs` (−30…0), `hold_s` (0.1–30 s, default 0.2), `up_db` (0.5–30), `settle` (0–20 blocks), merged into the current ones; `null` = all by default |
| `smart_agc` | true = AGC+: the tuner gain is set from the A/D level (no clipping, as high as possible); turns the RTL2832 digital AGC off |
| `rtl_agc`, `dc_remove`, `audio_agc`, `notch`, `afi`, `lpf`, `hpf`, `stereo_on`, `bias_tee`, `autotune` | true / false |
| `autotune_go` | true: find the carrier of the signal at `tune_hz` (send with it) and retune onto it; needs `autotune` on and USB / LSB / AM |
| `dc_hz` | width of the DC peak removal, 0 – 1000 Hz (default 0 = the peak itself only; above 0 = cutoff of a high-pass that also takes out its skirts) |
| `dc_db` | depth of the DC peak removal, 0 – 60 dB (default 60) |
| `spur_on` | use the learned spurs, true / false (default false) |
| `spur_hz`, `spur_edge`, `spur_db` | band-stop on each spur: stopband 100 – 10000 Hz (default 3000), width of each side 0 – 3000 Hz (default 1000), depth at most 0 – 60 dB (default 40; each point goes down to the noise around the band-stop and no further) |
| `spur_shift` | moves all spur band-stops, -1000 – 1000 Hz (default 0) |
| `spur_learn`, `spur_clear` | `true`: learn the spurs of the band received now (5 s; `spur_learning` while running, `spur_found` = lines found); forget all learned spurs |
| `afi_hz` | AFI inversion frequency, 500 – 4000 Hz (default 1750; audio is mirrored f → 2·afi_hz − f) |
| `lpf_hz` | LPF cutoff, 100 – 15000 Hz (default 3000) |
| `hpf_hz` | HPF cutoff, 20 – 5000 Hz (default 300). With both filters on, `hpf_hz` above `lpf_hz` gives silence (the web UI keeps them in order, the API does not) |
| `squelch` | dBFS, -120 (off) to 0; optional `squelch_mode` = the mode it applies to |
| `auto_sql` | ASQ auto squelch on / off (AM, FM, WFM) |
| `auto_sql_db` | auto squelch margin above the noise floor, 2 – 30 dB (default 6) |
| `sample_rate` | 1024000, 1536000, 2048000, 2100000, 2400000; on an Airspy VFO 2500000 |
| `zoom` | 1, 2, 4, 8, 16, 32 |
| `ppm` | frequency correction (integer) |
| `upconv` | `auto`, `on`, `off` |
| `lo_offset_hz` | upconverter LO, 0 to 1 000 000 000 Hz |
| `device` | device index (single-receiver mode) |
| `reset` | `true` = reset the dongle |
| `ft8`, `cw`, `rtty`, `wefax`, `sstv`, `packet`, `acars`, `vdl2` | decoders on / off. `vdl2: true` switches the VFO to 2.1 MS/s around 136.500 MHz and turns ACARS off (RTL-SDR only); `acars: true` turns VDL2 off |
| `vdl2_region` | VDL2 channel set: `"eu"` or `"us"`. Restarts dumpvdl2 with the new channels |
| `dab_sid` | remembers the station of the current DAB channel (`"0x5464"`, `null` = stopped) |
| `dab`, `dab_channel` | DAB on / off and channel. `dab: true` starts welle-cli and switches the VFO to 2.048 MS/s on the channel centre (ACARS and VDL2 off, RTL-SDR only); `dab: false` restores the sample rate; `dab_channel` alone retunes a running DAB |
| `hfdl`, `hfdl_band` | HFDL decoder on / off; `hfdl_band` (index into `hfdl_bands`) centres and tunes the VFO on the middle of that band and turns HFDL on (ACARS, VDL2, DAB and ISM off). HFDL decodes all channels inside the band of the VFO and mutes its audio; not on a chained VFO |
| `ais`, `ais_center` | AIS decoder on / off; `ais_center: true` centres and tunes the VFO on 162.000 MHz in FM (between the two AIS channels, both are decoded) and turns AIS on (ACARS, VDL2, DAB, ISM and HFDL off). AIS decodes the channels inside the band of the VFO and mutes its audio; not on a chained VFO |
| `ism`, `ism_hz` | ISM decoder on / off and preset (one of `ism_freqs`). `ism: true` starts rtl_433, mutes the audio and switches the VFO to 2.048 MS/s on that preset in AM (ACARS, VDL2 and DAB off, RTL-SDR only); `ism: false` restores the sample rate; `ism_hz` alone re-centres a running decoder |
| `rec`, `rec_sq` | MP3 recording on / off: `rec` everything, a new file after 15 min; `rec_sq` only with an open squelch, each session in its own file |
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
| `packet`, `packetstate` | PACKET: one valid AX.25 frame (see `/api/packet`); decoder state (counters, AFC, error) |
| `packetspec` | PACKET spectrum, 4× per second while asked for: `db` (2·`k`+1 values, dB relative to a full-scale carrier, the tuned frequency in the middle), `df` (Hz per value), `afc_live` (9600 Bd AFC, Hz, or null) |
| `packeteye` | PACKET eye diagram, 4× per second while asked for: `rate`, `n` points per trace, `full` (full scale: Hz at 9600, 1.2 at 1200), `data` (base64 int8 traces, value/full·127), `open` and `open_frame` (eye opening % now / in the last good frame), `dev_hz`, `afc_live` (9600 only) |
| `wefaxrow`, `wefaxstate`, `wefaxnew`, `wefaxtrim`, `wefaxreload` | WEFAX image rows, state, new image, trimmed image, image changed (slant correction: load it again) |
| `sstvrow`, `sstvstate`, `sstvnew`, `sstvdone` | SSTV image rows, state, new image, finished image |
| `acars`, `acarsinfo`, `acarsstate` | ACARS / VDL2 message, later added details (ADS-B lookup), state |
| `cpdlc`, `cpdlcstate` | CPDLC message, state |
| `vdl2state` | VDL2 decoder state |
| `dabstate` | DAB state (channel, welle-cli connected, dongle on channel, error) |
| `ism`, `ismstate` | ISM device message (the same `id` again = the repeat count `n` of a message grew); decoder state (`enabled`, `error`, `count`, `dropped`, `running`) |

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
| GET | `/api/packet` | PACKET decoder: state, the last 500 `frames` and the APRS `stations` (newest first) |
| POST | `/api/packet` | `{"action": "clear"}` and/or `{"opts": {"rate": "both" \| "1200" \| "9600", "scrambler": "auto" \| "on" \| "off"}}` (saved to the config); `{"action": "eye", "rate": 9600 \| 1200}` sends `packeteye` events for the next 4 s, `{"action": "spectrum"}` the same for `packetspec` (the page renews it every 2 s) |
| GET | `/api/acars` | ACARS / VDL2 messages; VDL2 ones have `vdl2.gs` (ground station address) and `vdl2.gs_loc` (`BTS/LZIB`, `-` if not known), `vdl2.gs_city` (`Bratislava`, empty if not known) and `vdl2.gs_info` (entry in the ground station list, `LHBP Budapest Hungary 136.825`, empty if not there). A message with `lookup: true` gets an `acarsinfo` event with the ADS-B data; the web page shows its row after that |
| POST | `/api/acars` | `{"action": "clear"}` |
| GET | `/api/cpdlc` | CPDLC messages |
| POST | `/api/cpdlc` | `{"action": "clear"}` |
| GET | `/api/vdl2` | VDL2 decoder info |
| GET | `/api/dab` | DAB ensemble: `ensemble`, `ensemble_short`, `ensemble_id`, `country`, `snr`, `freq_corr`, `fic_errors`, `utc`, `local`, `capacity_cu`, `services` (`sid`, `label`, `short`, `pty`, `language`, `type` DAB / DAB+, `bitrate`, `protection`, `cu`, `subch`, `encrypted`, `channels`, `mode`, `samplerate`, `dls`, `mot_time`, error counters) |
| GET | `/api/dab/audio/<sid>` | MP3 audio stream of a service (welle-cli decodes it while somebody listens) |
| GET | `/api/dab/slide/<sid>` | last slideshow picture (JPEG / PNG), 204 if none |
| GET | `/api/wefax` | WEFAX decoder info |
| POST | `/api/wefax` | `{"action": "new"}` new image, `{"action": "phase", "x": 0.0–1.0}` set the line start, `{"lpm_mode": ...}`, `{"ioc_mode": ...}`, `{"slant_ppm": -3000–3000}` slant correction (saved; the image so far is straightened too), `{"afc_vfo": true/false}` AFC retunes the VFO onto the signal (centre 1900 Hz, USB; saved), `{"delete": "<file name>"}` or `{"delete": "all"}` (saved images) |
| GET | `/api/wefax/image.png` | current WEFAX image (PNG) |
| GET | `/api/wefax/files/<name>` | saved WEFAX image |
| GET | `/api/sstv` | SSTV decoder info |
| POST | `/api/sstv` | `{"mode": "auto"}` or a mode name, `{"action": "stop"}`, `{"delete": "<file name>"}` or `{"delete": "all"}` (saved images) |
| GET | `/api/sstv/image.png` | current SSTV image (PNG) |
| GET | `/api/sstv/files/<name>` | saved SSTV image |

## Memories

A memory: `{"id", "name", "group", "groups", "freq_hz", "mode", "bw", "fav", "decoder", "record", "note", "color", "tag"}`, and `"dab_channel"` (e.g. `"12C"`) on a DAB memory.
`groups` is the list of its groups (may be empty), `group` the first of them (kept for older clients). `decoder` is switched on
when the memory is recalled in the page: `""` (none), `ft8`, `wefax`, `cw`, `rtty`, `sstv`, `packet`, `acars`, `vdl2` or `ism`.
`note` up to 200 characters. `color` is the colour of its tag in the spectrum, `#rrggbb` or `""` (default green); `tag` false hides the tag.

| Method | Path | Description |
|---|---|---|
| GET | `/api/rotor` | antenna rotor of the station (settings in `data\rotor.json`; only on the receiver that holds the rotor, see `/api/vfos` `rotor`; the others answer 409 `{"error", "host"}`): `on`, `connected`, `device`, `az`, `el`, `target`, `target_raw` (K3NG azimuth 0–450 given by the satellite tracking, else null), `tracker` (the satellite tracking moves the rotor), `aim` ([az, el] of the tracked satellite while it is above the horizon), `source` (`manual` or `tracker`), `control`, `fault`, `error`, `next_pass` (`{"sat", "event": "AOS" or "LOS", "seconds"}` of the tracked satellite); `k3ng_az` (the K3NG azimuth 0–450 from its left stop, followed by RADIMCOM), `k3ng_guess` (true while it is not yet known whether K3NG is at 0–90 or 360–450), `az_cal` ([true azimuth at K3NG 0, at K3NG 450]); `az`, `target` and `aim` are true azimuths; `?ports=1` adds the serial `ports` |
| POST | `/api/rotor` | any of `{"enabled": true/false, "port", "usb_serial"}` (link on / off, saved), `{"start": true}` (rotor control on: the satellite tracking may move it), `{"stop": true}` (stop the rotor, control off), `{"reset": true}` (clear a fault), `{"goto": [az, el]}` (true azimuth 0–360, elevation 0–180; refused while the satellite tracking moves the rotor), `{"az_cal": [az0, az450]}` (true azimuth at K3NG 0 and at K3NG 450, saved; `[0, 450]` = no correction). **Moves the antenna.** Refused with 403 from a page of another host |
| GET | `/api/memories` | all memories |
| POST | `/api/memories` | add: `{"name", "group" or "groups", "freq_hz", "mode", "bw"}` and optionally `"fav"`, `"decoder"`, `"record"` (`"off"` default, `"on"`, `"sq"` or `"asq"`: recording started at recall), `"note"`, `"color"`, `"tag"`, `"lat"` and `"lon"` (location of the station, decimal degrees, both or neither; `null` = none); returns the new memory with its `id`. Name up to 80 characters, group up to 40, frequency 0–1766 MHz, `bw` clamped to the mode's range. With `dab_channel` the frequency is the centre of that channel |
| PATCH | `/api/memories/<id>` | change any of `{"name", "groups", "group", "freq_hz", "mode", "bw", "fav", "dab_channel", "decoder", "record", "note", "color", "tag", "lat", "lon", "scan", "scan_sq", "scan_asq", "scan_prio"}` (`group` replaces all groups with one), or `{"groups_add": [...]}` / `{"groups_remove": [...]}`; the memory is checked like a new one (400 with `error` if invalid, `bw` clamped to the mode's range). `dab_channel` sets the frequency to the centre of the channel, `null` or `""` removes it. Returns the changed memory |
| POST | `/api/memories/bulk` | several memories at once: `{"ids": [...], "changes": {...}}` applies the same changes (the fields of PATCH, e.g. `{"groups_add": ["HAM"]}`, `{"fav": true}` or `{"color": "#ff8800"}`) to each, all or none; returns `{"changed": [...]}`. `{"ids": [...], "delete": true}` deletes them; returns `{"deleted": n}`. Unknown ids are ignored |
| GET | `/api/memory_groups` | every group, by name: `[{"name", "note", "count"}]` (groups of `data\memory_groups.json` and those used by memories) |
| POST | `/api/memory_groups` | group editor, `{"action": ...}`: `"add"` `{"name", "note"}`, `"note"` `{"name", "note"}`, `"rename"` `{"name", "new"}`, `"copy"` `{"name", "new"}` (copies of its memories in the new group), `"delete"` `{"name", "delete_memories": true/false}` (memories in no other group are deleted, or kept without a group), `"merge"` `{"names": [...], "into", "note"}` (`note` optional: the notes are joined). Returns `{"groups", "memories"}`; 400 with `error` (e.g. the name exists) |
| POST | `/api/memories/preview` | reads memories for an import list, **without saving**: `{"format": "auto", "text", "filename"}` (any supported file, recognised by its content: RADIMCOM JSON / CSV, SDR# `frequencies.xml`, SDR++ frequency manager JSON, gqrx `bookmarks.csv`, CHIRP CSV), `{"format": "sdrsharp", "path"}`, `{"format": "sdrsharp_xml", "text"}`, `{"format": "json", "data"}` (a RADIMCOM export) or `{"format": "csv", "text"}`. Returns `{"entries", "groups", "files", "format"}` (`format`: name of the format found): each entry as a memory with `"duplicate"` (name of a memory on the same frequency and mode, or `""`), or with `"error"` |
| POST | `/api/memories/import_entries` | adds `{"entries": [...], "groups": [{"name", "note"}]}` (entries as for POST `/api/memories`); all or none (400 names the wrong entry). Group notes are added for new groups and for groups without a note. Returns `{"added": [...]}` |
| DELETE | `/api/memories/<id>` | delete |
| POST | `/api/memories/import` | import from SDR#: `{"path": "C:\\SDRSharp"}`. Reads `frequencies.xml` in the folder and in profile subfolders (e.g. `Instances\Profile1`), or a single profile folder / `frequencies.xml`. Duplicates (same frequency and name) are skipped. Returns `{"added", "skipped", "files", "errors"}` |

`POST /api/memories/import_json` imports a RADIMCOM export in one step (a list, or `{"groups", "memories"}` from the editor): each entry needs `freq_hz` (or `dab_channel`) and `mode`, and every imported memory gets a new `id`. Duplicates (same frequency and name) and invalid entries are skipped. Returns `{"added", "skipped"}`.

Export (MEMORIES tab → EXPORT) is done in the browser from `GET /api/memories` and `GET /api/memory_groups`.

## Recordings

The MP3 files of REC / REC SQ in the recordings folder (default `data\recordings`, set in SETTINGS › GENERAL › RECORDINGS) (RECORDINGS tab). The folder is shared by all VFOs, so every VFO port gives the same list.

| Method | Path | Meaning |
|---|---|---|
| GET | `/api/recordings` | the files, newest first: `[{"name", "size", "mtime", "secs", "hz", "mode", "start", "memory", "writing"}]` (`secs` from the size at 128 kbps; `hz`, `mode`, `start` (`YYYY-MM-DD HH:MM:SS`, local time) and `memory` from the file name, empty for a foreign file; `writing` = being recorded now) |
| GET | `/api/recordings/<name>` | the file (`audio/mpeg`, Range requests work) |
| DELETE | `/api/recordings/<name>` | delete; 400 with `error` for a file being written or an unknown name |
| GET | `/api/recording_folder` | `{"folder", "custom", "default"}`: the folder in use, the one set (`""` = default) and the default `data\recordings` |
| POST | `/api/recording_folder` | `{"folder": "<full path>"}` sets it (created if missing, must be writable), `""` = back to the default; 400 with `error` for a relative or unusable path; only from this RADIMCOM page (403 otherwise). Saved in `data\recordings.json`, all VFOs use it at once |

## Scan

Scanner of the VFO (SCAN tab, `scanner.py`). It runs in the receiver of the VFO; `/api/state` and the `status` event carry `scan` (the fields of GET without `list`, `excluded_list` and `log`).

| Method | Path | Meaning |
|---|---|---|
| GET | `/api/scan` | `{"on", "paused", "state"` (`off` / `search` / `listen` / `peek` / `hold`), `"opts", "rate"` (channels measured per second), `"channels", "windows", "window", "excluded", "locked", "stored", "message", "range"` (`[from, to]` Hz of a range scan), `"locked_f"` (Hz of the channels locked out), `"rec_file"` (WAV being written), `"cur"` (channel heard: `{"id", "name", "freq_hz", "mode", "power", "level", "prio"}` or null), `"list"` (memories: every channel; range: the channels heard, active or locked, at most 400: `{"id", "name", "freq_hz", "mode", "power", "floor", "level", "active", "hits", "last", "locked", "lock_s"}`, dBFS), `"excluded_list"` (`[{"id", "name", "freq_hz", "mode", "why"}]`, at most 200), `"log"` (the last 200 activities of this VFO), `"saved_opts"`, `"presets"}` |
| POST | `/api/scan` | `{"action": "start", "opts": {...}}` starts (409 while DAB / VDL2 / ISM / HFDL / AIS is on, 400 without a channel or with more than 20000 grid channels); `"stop"`, `"pause"`, `"resume"`, `"skip"` (5 min), `"lockout"` (until stop), `"step"` with `"dir": 1 / -1`, `"opts"` (only saves). Options: `"source"` (`all` / `fav` / `group` / `range` / `view`), `"group"`, `"from_hz"`, `"to_hz"`, `"step_hz"`, `"mode"`, `"bw"` (range / view), `"pick"` (`next` / `strongest`), `"asq"` (bool), `"margin"` (1–30 dB), `"resume"` (`delay` / `carrier` / `time`), `"hang_s"` (0–60), `"time_s"` (1–600), `"prio_s"` (0–60, 0 = no look into other windows), `"carrier_min"` (0–120, 0 = off), `"rec"`, `"log"`, `"store"` (bool); saved in the VFO config (`scan`) |
| GET | `/api/scan/log` | activities of all VFOs from `data\logs\scan_YYYY-MM-DD.csv`, newest first: `?days=1..31`, `?limit`; `{"days", "rows": [{"time_utc", "vfo", "freq_hz", "name", "mode", "duration_s", "max_dbfs", "snr_db", "file", "note"}], "fields"}` |
| GET | `/api/scan/heatmap` | occupancy from the log, `?days=1..31`, `?top=60`: `{"days", "rows": [{"freq_hz", "name", "mode", "total", "count", "hours": [24 × seconds, local time]}]}` |
| GET | `/api/scan/rec/<file>` | a WAV recording of an activity (subfolder `scan` of the recordings folder) |

The memory fields used by the scan: `"scan"` (false = never scanned), `"scan_sq"` (own level −120…0 dBFS or null), `"scan_asq"` (own ASQ margin 1–30 dB or null), `"scan_prio"` (0 / 1), set by PATCH `/api/memories/<id>`. Search & store adds memories in the group `Scan YYYY-MM-DD` and sends the event `memories`.

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
