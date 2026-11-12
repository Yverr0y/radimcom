[← README](../README.md) · [Documentation](README.md)

# Features

## Receiver features

- **Up to four VFOs, A–D.** Each VFO has its own SDR (RTL-SDR, LimeSDR Mini or Airspy R2, selected by serial number)
  and its own settings.
- **VFO chaining:** one dongle can serve several VFOs, e.g. one dongle for VFO A–D, or two dongles with two VFOs
  each. A chained VFO listens anywhere inside the band its dongle receives and shows a green CHAIN flag
  (see [VFO chaining](configuration.md#vfo-chaining-one-dongle-for-several-vfos)).
- **Modes:** AM, FM, WFM, LSB, USB and CW with selectable filter width, DAB (digital radio) and DSD (digital voice), each of these two with its own tab (see below).
- **WFM stereo** (19 kHz pilot, **ST** indicator) and **RDS**: station name (PS), RadioText, PI, PTY, TP/TA and clock (CT).
- **Squelch** for AM, FM and WFM, each mode with its own level. It decides every ~8 ms, so it does not cut off
  the start of a transmission (airband), and closes about 25 ms after the signal drops below the level. The level is marked on the S-meter with a yellow tick.
  - **ASQ (auto squelch):** the squelch level follows the noise in the channel plus a margin (6 dB by default, 2–30 dB in SET, AUDIO tab).
    The noise is measured in the spectrum of the dongle band, so a signal in the channel, even a long one, does not raise the level and close it.
    See [Function keys → AUDIO](controls.md#function-keys).
  - **Tone squelch TSQ-C (CTCSS) and TSQ-D (DCS)** in FM, in addition to the squelch level or ASQ: the audio passes only while the set
    sub-audio tone (50 standard tones 67.0–254.1 Hz) or DCS code (104 standard codes, N / I) is received; the tone is filtered out of what you hear.
    Shown in the VFO window under the frequency. See [Function keys → AUDIO](controls.md#function-keys).
- **AGC+ (smart gain):** sets the tuner gain from the level of the A/D converter, as high as possible without clipping it,
  also with strong signals outside the channel; presets CAREFUL / MODERATE (default) / BOLD trade clipping for a few dB more gain. With the squelch set, AGC+ switches it to auto squelch. See [Function keys → GAIN](controls.md#function-keys).
- **ATU (autotune), experimental,** in USB, LSB and AM: a click on a signal moves the tuning onto its carrier (AM within a few Hz in under 1 s);
  in SSB the edge of the voice band goes onto the red line (USB lower edge, LSB upper edge, ~2 s). See [Function keys → TUNE](controls.md#function-keys).
- **Audio processing:** automatic notch filter (NF), audio low-pass and high-pass filters (LPF / HPF), automatic audio level (ALC).
- **AFI (audio frequency inversion):** voice inversion scrambler / descrambler, inversion frequency 500–4000 Hz; REC and the decoders get the descrambled audio.
  See [Function keys → AUDIO](controls.md#function-keys).
- **Remove DC peak** and **remove spurs** from local sources, in the waterfall and in the received signal.
- **Upconverter:** HF is tuned via the LO (e.g. 100 MHz), see [Shortwave (HF) reception](hf-upconverter.md). For a VFO with a manual converter switch, crossing
  30 MHz shows a warning whether the converter must be switched on (CONV) or set to BYPASS.
- **Decoders:** 11 decoders, see [Decoders](#decoders) below.
- **Satellite tracking:** pass prediction, world map, Doppler correction of the VFO and a K3NG antenna rotor over USB, planned for passes across the north; no other program needed. See [Satellite tracking](satellites.md).
- **ROTOR CONTROL tab (RCTRL key):** a map where a click (or a click on a channel of MEMORIES with a location) turns the rotor to that azimuth from the QTH, with the wanted azimuth (dashed line) and the antenna now (beam sector turning with the rotor), from any VFO; recalling a channel with a location opens the tab and turns the rotor to it; the channels are shown by their groups (a checkbox per group beside the map); page **CONNECTION** connects / disconnects the three sources of the wanted AZ / EL (SAT TRACKER, MEMORY RECALL, RCTRL MAP) from the rotor in a block diagram (rotor block green = at least one connected). See [Rotor control map](satellites.md#rotor-control-map).
- **REC and REC SQ:** record the audio of the selected VFO to MP3 files in `data\recordings` or an own folder (SETTINGS › GENERAL › RECORDINGS): everything, or only while the squelch is open.
- **SCAN tab (SCAN key, MENU group): scanner** on one VFO. Every ~85 ms it measures all channels in the band of the dongle at once
  from the spectrum, the tuner moves only between windows; memories (ALL / FAVOURITES / group), a RANGE (FROM / TO / STEP / MODE / BW, presets
  such as airband 8.33 kHz) the spectrum shown (VIEW) or the FM broadcast band (FM BCAST: 88–108 MHz, lands on the centre of each station, RDS PS as the name); START / PAUSE / SKIP / LOCKOUT / ◀ ▶ / STOP; own squelch, own ASQ margin and priority
  per memory (ASQ FOR ALL by default); resume DELAY / CARRIER / TIME; priority look into other windows, carrier lockout; activity LOG (CSV),
  WAV recording of each activity, search & store into a memory group, HEATMAP of the occupancy. See [MENU → SCAN](controls.md#scan).
- **RECORDINGS tab (RECS key):** the recorded files in a table (start, memory, frequency, mode, length, size), played in the browser; NEXT plays the next older file, filter, delete. See [RECS](controls.md#function-keys).
- **Daily logs:** the LOG checkbox in each decoder card writes to `data\logs\<decoder>_YYYY-MM-DD.txt` (UTC, one line per message; WEFAX/SSTV log the names of saved images), classic ACARS to `data\acars\acars_YYYY-MM-DD.txt` and VDL2 to `data\acars\vdl2_YYYY-MM-DD.txt`.
- **TX with LimeSDR** (optional, off by default), see [Transmitting (LimeSDR)](configuration.md#transmitting-limesdr).
- **HTTP API:** everything the page does can be done from scripts, see [API/API.md](../API/API.md).
- **Upgrade from the page:** after each start RADIMCOM checks GitHub for a newer version and can download and install it; `data\` and the settings stay. A red RADIMCOM logo shows that a newer version is available; a click on it opens the release page.
  See [Data folder](development.md#data-folder-data).

## Decoders

| Decoder | What it decodes | Details | SDR | More |
|---|---|---|---|---|
| **FT8** | FT8 on the HF ham bands (160–10 m) | band buttons; the PC clock must be accurate (±1 s) | all | [DECODE](controls.md#function-keys) |
| **WEFAX** | radio fax (DWD, Northwood…) | automatic format detection (LPM / IOC), slant correction (SLANT, ALIGN), AFC that retunes the VFO onto the signal, gallery of saved images | all | [DECODE](controls.md#function-keys) |
| **CW** | Morse | AFC, speed estimation, noise blanker; text also in the audio spectrum bubble | all | [DECODE](controls.md#function-keys) |
| **RTTY** | Baudot | automatic shift 90–1000 Hz, speed 45.45 / 50 / 75 / 100 Bd and polarity | all | [DECODE](controls.md#function-keys) |
| **SSTV** | colour images | 14 modes (Martin, Scottie, Robot, PD), VIS, automatic AFC and slant, gallery of saved images | all | [DECODE](controls.md#function-keys) |
| **PACKET** | AX.25 at 1200 Bd AFSK and 9600 Bd FSK / GFSK G3RUH (satellites) | APRS with a station list and map, spectrum and eye diagram | all | [DECODE](controls.md#function-keys) |
| **ACARS** | classic aircraft data link (131.725 MHz and others, AM, MSK 2400 bit/s) | FANS-1/A CPDLC and ADS-C decoded to plain text; MESSAGES / AIRCRAFT / MAP views (aircraft heard, aircraft with a known position) | all | [Aircraft data link](decoders/aircraft.md) |
| **VDL2** | VDL Mode 2, EU or US channels 136.100–136.975 MHz, all channels of the region at once | via dumpvdl2; CPDLC (FANS-1/A and European ATN), ADS-C, VDL2 ground station of each message with a filter; MESSAGES / AIRCRAFT / MAP views (aircraft list; map of aircraft from ADS-B, ADS-C and VDL2 XID positions, tracks, ground stations) | RTL-SDR only | [Aircraft data link](decoders/aircraft.md) |
| **HFDL** | aircraft data link on HF, **2.9–22 MHz**, 16 ground stations; all HFDL channels inside the band of the VFO at once | via dumphfdl; ACARS, positions, logons, frequency data; aircraft data from ADS-B with a map link; heard ground stations, table of stations and frequencies, band buttons | all (needs HF: V4, upconverter) | [HFDL](decoders/hfdl.md) |
| **AIS** | ships: position reports, static and voyage data, base stations, aids to navigation, SAR aircraft on **161.975 / 162.025 MHz** (both channels at once) | own decoder (GMSK 9600 Bd, no external program); country from the MMSI, MarineTraffic / VesselFinder links; MESSAGES / SHIPS / MAP views (ships turned to their heading, tracks), NMEA sentence, LOG | all | [AIS](decoders/ais.md) |
| **ADS-B** | aircraft on **1090 MHz**: ADS-B (DF17 / DF18: flight, category, position, altitude, speed, vertical rate, squawk, emergency) and Mode S replies (DF0 / 4 / 5 / 11 / 16 / 20 / 21) | own decoder (PPM 1 Mbit/s, CRC with bit correction, CPR positions; no external program); country from the ICAO address, distance and azimuth from the QTH, globe.adsb.fi / adsb.lol links; AIRCRAFT / MAP / MESSAGES views, LOG | all (2.4 MS/s; Airspy 2.5 MS/s) | [ADS-B](decoders/adsb.md) |
| **DAB / DAB+** | digital broadcast radio in Band III | via welle-cli: station list of the ensemble, DLS text, slideshow, audio, signal, ensemble and capacity panels, remembered channel and station | RTL-SDR only | [DAB / DAB+](decoders/dab.md) |
| **DSD** (first test version) | digital voice: DMR, P25, D-Star, YSF, NXDN, dPMR, M17 and more | the **DSD** key in MODE, via DSD-FME, list of calls; **separate download: run `install_dsd.bat`** | all | [DSD](decoders/dsd.md) |
| **ISM** | devices on 433 and 868 MHz: weather sensors, remote controls, tyre sensors | via rtl_433 | RTL-SDR only | [ISM](decoders/ism.md) |

ACARS and VDL2 messages show the aircraft type, flight level, speed and squawk from adsb.fi / adsb.lol (emergency squawks 7500, 7600, 7700 framed in red)
and the country flag from the ICAO address; a click on a message pauses the list. Every decoder card has a LOG checkbox for a daily log.

## UI features

- **Transceiver-style screen:** 7-segment frequency displays, function keys and band buttons (the **BAND** key hides the row of band buttons).
- **Skins** (SET → SKINS): dark, black or light brushed aluminium, mahogany, or a panel sprayed in a RAL colour (or any colour). See [SET](controls.md).
- **S-meter in seven layouts** (amber needle by default, needle, bar graph, LED bar, VFD display, 7-segment, peak bar), with the squelch level marked.
  Under it small bars show the CPU load and memory use of the PC.
- **All VFOs side by side:** the active VFO is lit, inactive ones are grey
  but show the actual tuned frequency. The waterfall of every VFO keeps running, so its history is visible
  right after switching. With fewer than four SDRs the remaining VFO windows stay in place, greyed out ("NO SDR").
- **Each VFO is one dark display window:** on top the name of the memory on its frequency, otherwise the band plan label
  (e.g. `HAM 70cm`) or the satellite transponder, lit on the active VFO (a memory name in its own tag colour); the receiver state, recording and mute indicators;
  the frequency; an info row (RX/TX, filter width, HPF and LPF with cutoffs, ST, SQL, CONV/BYPASS); a tone squelch row (CTCSS / DCS); annunciators lit like LCD segments (mode, AGC / AGC+, NF, SP, ALC, AFI, ASQ, ATU, satellite Doppler, CUE);
  **RF and SQL segment bars** (drag, click or mouse wheel; at a manual RF gain the RF bar and its value turn red while the A/D converter clips). See [VFO window](controls.md#vfo-window).
- **Spectrum and waterfall** with 1×–32× zoom (the waterfall keeps the history of the whole band, so after zooming out the hidden parts are shown at once) and a waterfall speed bar (1/8 – 4×) and waterfall settings under a gear (colour scheme, range, offset); tuning by a click, dragging the band or the passband, the mouse wheel or the wheel over a digit of the display. See [Tuning](controls.md#tuning).
- **Band plan on the frequency axis** (Europe / ITU Region 1: ham, broadcast, aviation, marine, satellites, mobile networks, ISM…); hover it for the descriptions of all bands at that frequency.
- **Audio spectrum bubble:** hovering over the passband label shows the audio spectrum of the active VFO (in WFM the MPX signal with the stereo pilot, in CW also the decoded text).
- **Frequency memories** (MEMORIES tab) with groups, favourites, import from SDR# (`frequencies.xml`), JSON and CSV, export to JSON and CSV; memories in view show as tags in the spectrum,
  ↑ ↓ arrow keys recall the next one. A memory can also be a DAB channel (mode DAB) or a DSD (digital voice) channel.
- **Memory editor** (pages of the MEMORIES tab; by Brano, [brjanicek](https://github.com/brjanicek)): channels in several groups, with a decoder and a recording (REC, REC SQ or REC SQ with ASQ) started at recall, a note and their own tag colour
  (or no tag); groups with notes (add, rename, copy, merge, delete); duplicates shown; import from SDR#, JSON or CSV and export to
  JSON or CSV, both through a list to edit and choose from first. See [Memory editor](controls.md#memory-editor).
- **Audio** starts automatically when the page opens and comes from the active VFO.
- **CUE:** keep listening to other VFOs at a separate CUE level while one VFO is selected;
  MAIN and CUE volume faders with a dB scale, stereo level meter with peak hold and CLIP LEDs, MUTE.
- **DECODERS tab** with a page for each decoder, and the **SATELLITES** tab (also the **SAT** key), which shows the active linear, FM, image and other satellites from AMSAT, with clickable links.
- **AD (additional display)** under the S-meter: error messages (red, accepted by OK, the frame blinks), the rotor AZ / EL (MONITOR), DAB now on air (station, SNR, running DLS text) or RDS, by this priority.
- **Rotor page** in SETTINGS › GENERAL: one rotor for the whole station (not tied to a VFO, settings in `data\rotor.json`), ON / OFF, polar plot and elevation column 0–180° with the antenna and its target, a click moves the antenna; STOP, RESET, MONITOR.
- **SETTINGS tab** (gear key) split into **GENERAL** (the whole station: SKINS, S-METER, TOUCHPAD, LOCATION – station locator or latitude / longitude, also chosen on a map, used by the satellites, packet, HFDL and AIS; ROTOR) and **VFO** (keys VFO-A … VFO-D on the left, the lit one joined to its card: SDR DONGLE with a block diagram of the receive chain, ADVANCED with the list of dongles and their VFOs, SP, AGC+ and the S9 calibration, AUDIO, TX); **MEMORIES tab** (MEM key) with the pages CHANNELS (also the list to recall from), GROUPS, IMPORT, EXPORT.
- **Clock** in local time or UTC (a click switches), with the date under it.
- **The page scales with the browser window** (laid out for at least 1920 × 820 px), so the layout does not reflow in small windows.

![WFM broadcast on VFO C: stereo (ST), RDS station name and RadioText, 200 kHz filter](images/fm_with_rds.png)
