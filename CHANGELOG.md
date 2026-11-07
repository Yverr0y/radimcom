# Changelog

## Ver. 0.111

### Main Features

- **Satellite tracking without Gpredict: everything in the SATELLITES tab.** Gpredict is no longer needed and no longer in the package (the GP key, `apps\gpredict` and the rotctld / rigctld TCP links on ports 4533 / 4532 are gone; an `apps\gpredict` folder left from an older version can be deleted).
  - **The tab:** a new tab next to SPECTRUM and DECODERS, opened also by the **SAT** key. The floating SAT window (dials, 3D view) is gone.
  - **PASSES:** a timeline of the passes of the chosen satellites over the next 12, 24 or 48 hours (brighter bars for higher passes) and a list of them. A click on a pass shows its track on a polar plot, the elevation over time with a hover readout, the nearest distance, the Doppler shift at 145.9 and 435 MHz, the position now and the transmitters of the satellite. A **TRACK** key opens the satellite on the TRACK page.
  - **MAP:** a world map (Natural Earth, in the package, works offline) with the satellites switched on by keys above it, each with its footprint (yellow while it is above our horizon), the night side and the station. The chosen satellite shows its ground track, and beside the map its position, altitude, azimuth and elevation from here, distance, Doppler shift, next pass and transmitters, with a **TRACK** key. Moves every second. TRACK on MAP and PASSES adds a satellite that is not on the timeline yet.
  - **TRACK, Doppler:** a click on a transmitter (SatNOGS DB: downlink, mode, transponder or beacon) tunes the VFO, sets its mode and keeps it on the downlink as the satellite comes and goes (retuned beyond 20 Hz in SSB and CW, 500 Hz in AM, 1 kHz in FM, at most once a second); OFF stops it. Tuning by hand moves the frequency within the transponder.
  - **TRACK, rotor:** each pass is planned ahead and simulated with the measured speeds of the rotor, so a pass across the north no longer makes the K3NG unwind in the middle: it uses the overlap (past 360°, up to K3NG 450°), the flipped way (elevation over 90°, the antenna looking back) or, near the zenith, the azimuth standing still with the elevation going 0 → 180°. **TRACK** turns the rotor to the start of the next pass in time (the move begins its estimated duration plus 30 s before AOS), follows it and waits for the next one. While the rotor follows another satellite, TRACK switches it to the one shown. The rotor moves only while **CTRL** is on; with CTRL off it only calculates. **STOP** stops both motors and turns CTRL off. Tested on the rotor: a pass across the north in the overlap, pointing error median 3.4°, no unwinding.
  - **TRACK, plots:** the polar plot and the elevation chart (0–180°) show the real position of the antenna as a red cross. A click on the polar plot turns the antenna there, a click on the elevation chart sets only the elevation; a purple cross shows where a click would go. Refused while TRACK moves the rotor.
  - **SETUP:** the station by locator, latitude and longitude, or a click on an OpenStreetMap map (CHOOSE ON MAP); the satellites on the timeline, chosen in tabs by CelesTrak group: Amateur Radio, Weather, CubeSats, Space & Earth Science, Galileo, GLONASS, GPS, Iridium NEXT. **SELECT ACTIVE** ticks the satellites of the AMSAT lists (LINEAR, FM, IMAGE, MISC), **CLEAR** unticks all.
  - **LINEAR, FM, IMAGE, MISC:** the lists of active satellites from [AMSAT](https://www.amsat.org/), with frequencies and comments. Links open in a new browser tab. The server downloads the lists when the tab is opened, keeps them for 12 hours in `data\satellites.json` and shows the last copy without internet; **REFRESH** downloads them again.
  - **Data:** the orbital elements come from CelesTrak once a day, the transmitters from SatNOGS DB once a week; both work offline from the last copy. Positions with SGP4 (Python package `sgp4`, installed by `upgrade.bat`).
  - **HTTP API:** `/api/sat/passes`, `/api/sat/pass`, `/api/sat/map`, `/api/sat/setup`, `/api/sat/transmitters`, `/api/sat/doppler`, `/api/sat/rotor`, `/api/satellites`; `/api/gpredict` is gone. Setting the antenna uses `goto` in `/api/rotor` as before.
- **Airspy R2 (first test version, receive only).** A VFO can use an Airspy R2, `setup.bat` finds it. 2.5 MS/s, gain as the presets 0–21 or AGC, bias-tee, upconverter, ppm and chained VFOs work as on the other SDRs. VDL2, DAB and ISM are not available on it (RTL-SDR only); the 10 MS/s rate is not offered yet.

### Minor Fixes

- **Upgrade from the page.** After each start RADIMCOM asks GitHub Releases once for a newer version; if there is one, a small window offers it. **UPGRADE** downloads the upgrade zip to `data\update\`, closes the receiver and installs it in its own console window (unzips the program over the RADIMCOM folder, ends decoders still running from `lib\`, runs `upgrade.bat`), then starts RADIMCOM again and the page reloads. `data\` and the settings stay. **LATER** asks again at the next start, **SKIP THIS VERSION** not before a still newer one; the yellow "→ 0.1xx available" beside the version under the logo opens the window again. Without internet nothing is shown. Off with `"update_check": false` in `data\vfos.json`. Not offered in a development copy (git). It works from this version on: the upgrade to 0.111 itself is still done by hand. HTTP API: `/api/update`.
- **Rotor: azimuth calibration.** New in SET (ROTOR tab): the true azimuth of the antenna at K3NG 0 and at K3NG 450, for a rotor whose left stop is not exactly north. The position, the tracking and GO then use true azimuths. RADIMCOM follows the whole K3NG range 0–450 (K3NG reports only modulo 360) and saves it, and chooses the command so that K3NG, which takes the shorter way, ends nearest the wanted direction. HTTP API: `az_cal` in `/api/rotor`, `k3ng_az` and `k3ng_guess` in its state.
- **Long rotor moves no longer stop halfway.** The K3NG controller ends any single move after its operation timeout (60 s on the tested unit), so a move longer than that, such as the elevation from 0 to 180 degrees (about 72 s), stopped and RADIMCOM reported "no movement". RADIMCOM now sends the same target again every 30 s until the rotor gets there.

## Ver. 0.110

### Main Features

- **Recording to MP3 on the PC, two keys.** The REC key that downloaded a WAV through the browser is replaced by two keys that save to `data\recordings` as MP3, 128 kbps, named by frequency, mode and start time (`145.500000MHz_FM_20261105_155300.mp3`), with the name of the memory first if the frequency is in the memories (`Piestany_TWR_118.575000MHz_AM_20261105_155300.mp3`). **REC** records everything until switched off, with a new file after 15 minutes. **REC SQ** records only while the squelch is open, each session in its own file (a session ends after 1 s of closed squelch; bursts under 0.3 s are dropped). Each VFO records on its own, also with the page closed; a red dot in the corner of its display blinks while writing and is steady while waiting for the squelch. New Python package: lameenc (`upgrade.bat` installs it). HTTP API: `rec`, `rec_sq` in `/api/set`, `recording` in the state.
- **ISM decoder: 433 and 868 MHz devices.** New **ISM** key under DECODE, after DAB, decodes weather sensors, remote controls, tyre sensors and other small devices with [rtl_433](https://github.com/merbanan/rtl_433). The card has preset buttons **433.92** and **868.30** MHz (the VFO runs at 2.048 MS/s around them, so about ±1 MHz is decoded at once, with its audio muted), a table of messages (device, ID, channel, level, data; a message the device repeats is one row with ×N) and a LOG checkbox (`data\logs\ism_YYYY-MM-DD.txt`). ISM turns ACARS, VDL2 and DAB off, and turning it off restores the sample rate. RTL-SDR only, not on a chained VFO. HTTP API: `/api/ism`, `ism` and `ism_hz` in `/api/set`, `ism` and `ismstate` events.
- **Antenna rotor and Gpredict link.** Tested so far only with the [K3NG rotor controller](https://github.com/k3ng/k3ng_rotator_controller); other GS-232 compatible rotors have not been tested yet. New **ROTOR** tab in SET connects a K3NG rotor controller
  (GS-232 commands over USB serial, 9600 baud): position, go to AZ/EL and STOP. RADIMCOM also acts as a rotor (rotctld protocol, TCP 4533) and a receive-only radio
  (rigctld protocol, TCP 4532) for Gpredict, which does the satellite tracking and Doppler VFO frequency correction. The rotor stops on a disconnected Gpredict, an impossible position
  jump or a move without progress. The name frame of the VFO shows the satellite and transponder selected in Gpredict in blue, and the SAT window shows the time to its next AOS or LOS (both need our patched build of Gpredict). New **SAT** key opens a floating window with the azimuth and elevation (0 to 180 degrees) of the antenna on two dials, a 3D view of a 5 element Yagi from the south and from 45 degrees above, and a **CTRL** key for rotor control: the rotor follows Gpredict only with CTRL on; a fault, a lost connection and STOP in SET turn it off, the position stays visible. New **GP** key opens and closes Gpredict (`apps\gpredict`, in the package: Gpredict 2.7 with our changes, see `installer/GPREDICT.txt`). New Python package: pyserial (`upgrade.bat` installs it). HTTP API: `/api/rotor`.
- **Remove DC peak in SET (DONGLE tab).** Removes the peak of the dongle in the centre of the band, from the waterfall and from the received signal. On by default. A **Width** slider (up to 1000 Hz) also takes out the wide skirts of the LimeSDR peak, at the price of weakening signals that close to the centre. A **Suppression** slider (0–60 dB) sets how deep the removal goes. Each VFO keeps its own setting. HTTP API: `dc_remove`, `dc_hz`, `dc_db`.
- **Remove spurs: SP key under AUDIO, settings in SET (DONGLE tab).** For spurs from local sources such as a switching power supply, useful for dongles with an HF upconverter: **LEARN** finds lines at a regular spacing of 12 kHz or more in the band received now and leaves other peaks alone; each line gets a band-stop filter set by the **Width**, **Edge**, **Shift** and **Depth** sliders, which takes the line down to the noise around it, following its shape, so it leaves no hole in the noise. Cleans the waterfall and the channel you listen to (not WFM and wide FM). A signal on a spur is removed with it. Each VFO keeps its own lines. HTTP API: `spur_on`, `spur_hz`, `spur_edge`, `spur_shift`, `spur_db`, `spur_learn`, `spur_clear`.
- **VDL2: EU and US channels, new centre.** New **EU** and **US** buttons in the VDL2 card choose which channels are decoded, one region at a time. EU now decodes 136.700–136.975 MHz in 25 kHz steps (today's channels and those planned from January 2027) plus 136.675 MHz, dropped automatically on 1 January 2027 when it becomes a guard channel. US decodes 136.100, 136.300, 136.650, 136.800 and 136.975 MHz. The VFO centre moves from 136.850 to 136.500 MHz, because 136.850 is now a channel and would sit on the DC spike. The card header shows the number of channels, with the list in the tooltip. See [issue #1](https://github.com/om2amr/RADIMCOM/issues/1); thanks to Sergi for the channel information. HTTP API: `vdl2_region`, `vdl2_region_freqs`.
- **DAB card redesigned.** Station list with coloured tiles and a mark on the station playing; a large now-playing panel with the slideshow picture, chips for programme type, DAB / DAB+, bitrate, language and error protection, the codec and the DLS text. New panels: **SIGNAL** (SNR with a quality mark, frequency correction, FIC errors), **ENSEMBLE** (name, country flag, ID, stations, local time and UTC) and **MULTIPLEX CAPACITY** (share of each station). **The last channel and the last station of each channel are remembered** per VFO, and the station plays again by itself. The slideshow picture keeps its correct proportions. HTTP API: more fields in `/api/dab`, `dab_sids` in the state, `dab_sid` in `/api/set`.

### Minor Fixes

- **Dragging the passband in the spectrum.** Dragging the marked passband or its label now moves only the passband and tunes with it, up to the edge of the shown section; the spectrum stays in place. Dragging elsewhere in the spectrum and in the waterfall moves the band as before.
- **3D logo.** The letters of the logo have depth and shading, and the green ring above the I pulses slowly.
- **Memory import from JSON.** New **⇧ IMPORT JSON** in MEM → Import / export reads a file in the format of EXPORT; duplicates and invalid entries are skipped. The MEM window is a little wider. HTTP API: `POST /api/memories/import_json`.
- **DAB channel in memories.** ＋ SAVE CURRENT in MEM with DAB on stores the channel too. Recalling the memory turns DAB on with that channel, and recalling any other memory ends DAB.
- **DAB: HE-AAC v2 stations play at the right speed.** They played at half speed, because welle-cli took their stereo audio for mono. welle-cli is now built with a small patch (`installer/welle_radimcom.patch`).
- **ACARS and VDL2 mute the audio of the VFO**, like ISM. While one of these decoders runs, a small red struck-through speaker shows in the VFO display above AFI and MHz, which move slightly down. REC records nothing meanwhile. HTTP API: `audio_muted` in the state.
- **ACARS / VDL2: a line appears complete.** A new message is shown only after its ADS-B data and flag have arrived, instead of filling in later. Without an answer it appears after about 15 s (3 s more at most for the flag), and late ADS-B data is still filled in. The rows stay in the order of reception. HTTP API: `lookup` in the messages.
- **ACARS / VDL2: pause the message list.** A click on a message marks it with a lighter background and holds the list still, with **SCROLL PAUSED** in the header of the card; new messages keep coming in above it. Turning the mouse wheel over the messages resumes the list and goes back to the newest message.
- **The SET and MEM windows float.** Move them by the title bar; the radio stays usable behind them, so a click outside no longer closes them (✕, their key or Esc do). They remember their place in the browser. SET has a smaller font, a narrower window and more uniform cards.
- **install_dsd.bat works on a PC without the needed root certificate.** Python stopped with `CERTIFICATE_VERIFY_FAILED`. It now falls back to `curl` or PowerShell of Windows, which verify the certificate too; the SHA-256 check of the file stays. Other download errors give a short message instead of a traceback. Thanks to Dano OM1ATS for finding this issue.
- **install.bat repairs a broken `.venv`.** A `.venv` pointing to a Python that is not there (left from an earlier attempt, or a removed Python) stopped step 2 with "did not find executable" and a wrong hint about the internet. It is now tested by running it and created again if needed; if a new one does not start either, the installer says so and shows which Python it used. Found thanks to tests by Dano OM1ATS.

## Ver. 0.109

- **DSD mode: digital voice (first test version, it still needs more testing).** New **DSD** key under MODE decodes DMR, P25, D-Star, YSF, NXDN, dPMR, M17 and more with
  [DSD-FME](https://github.com/lwvmobile/dsd-fme): voice in the audio output, a list of calls (talk group, ID, talker alias) in the DECODERS tab,
  optional daily log. AUTO finds DMR, P25, D-Star, YSF and X2-TDMA; the others are selected in the card. Encrypted calls are marked and stay
  muted. D-Star: callsigns from the radio header, or the caller from a GPS frame; readable text from the radio in Alias.
  DSD-FME is **not in the package** (patent notice in `NOTICE.md`): **run `install_dsd.bat`** to download it (separate, optional step in the installation; the upgrade
  zip keeps an installed one, and `upgrade.bat` reminds you if it is missing). It refuses to replace a decoder in use and leaves the installed version
  as it was. Tested on real signals with DMR and D-Star; other protocols, both TDMA slots at once and long runs not yet.
  HTTP API: `/api/dsd`, `dsd` in the state, `dsdcall` event.
- **S-meter layouts in SET (DISPLAY tab):** six new layouts besides **Needle**, chosen by clicking a small sample of each: **Bar graph** (curved row of segments),
  **LED bar** (straight row of segments), **VFD display** (glowing cyan bars), **Amber needle** (backlit dial), **7-segment** (large reading with a thin bar) and **Peak bar**
  (continuous bar, a white mark holds the last peak). All have the same scale, calibration and response, and a squelch mark (dark blue on Amber needle, yellow elsewhere).
  **Needle** stays the default; the choice is remembered in the browser, for all VFOs.
- **S-meter reacts faster:** it now gets a level with every block of samples, as often as the spectrum (about 12 times per second at 1.536 MS/s), instead of
  only one block in three. Short peaks are no longer missed, and the attack is faster. HTTP API: new `meter` event in `/api/events`.
- **S-meter reading stays in place:** the text under the meter no longer jumps when the level goes above S9.
- **SET is a large window with tabs** instead of a narrow side panel: **DONGLE** (dongle, upconverter, LO, ppm, gain, bias-tee, reset), **AUDIO** (squelch, LPF, HPF, AFI),
  **DISPLAY** (display width, S-meter, waterfall, touchpad wheel speed) and **TX** (only for a dongle that can transmit). The open tab is remembered in the browser.
- **Block diagram of all components in the README**, updated for this version; `docs/block_diagram.py` draws it.

## Ver. 0.108

- **Project files for GitHub:** code of conduct, contributing guide, security policy, issue forms and pull request template.
- **Licence files:** `LICENSE` is now the plain MIT text. The radio transmission notice moved to the new `NOTICE.md`, which also lists all third-party
  components and their licences. `RADIMCOM_sources_v<version>.zip` on the release page has the source code of the GPL and LGPL components (new `installer/make_sources.py`).
- **ZOOM is one key** instead of a row of buttons. It shows the zoom and is lit only above 1×. A click turns it off (back to 1× at once)
  or on (last value above 1×, remembered in the browser); the **mouse wheel over the key** changes it up and down (1×–32×).
- **LPF and HPF keys** (filter curve icons) in the AUDIO group: audio low-pass and high-pass filter, in all modes except DAB; on/off and
  frequency remembered per VFO. The key shows the cutoff. Change it with the **mouse wheel over the key** or type it in **SET**
  (LPF 100–15000 Hz, default 3000; HPF 20–5000 Hz, default 300). 6th-order Butterworth (36 dB per octave), both on = band-pass;
  HPF always stays below LPF. Changes crossfade without a click. The audio spectrum bubble darkens the part they cut off.
  You hear and REC the filtered audio, decoders still get the full audio (new `PassFilter` in `sdr.py`).
- HTTP API: `lpf`, `lpf_hz`, `hpf`, `hpf_hz` in `/api/set` and `/api/state`.
- **Shorter AUDIO keys** so the key row fits on one line: **STEREO** is now **S/M**, **NOTCH** is now **NF**.
- **DAB key moved to the DECODE group** (from the OTHER band group); the **CB ch19** band button is now just **CB**.
- **Memory name above the VFO:** new frame on top of each VFO window, as wide as the VFO. When the VFO frequency matches
  a memory (within 50 Hz, like the MEM list), it shows the name; the tooltip adds the group, mode and bandwidth. More memories on
  one frequency: the one with the same mode wins, then a favourite. Inactive VFOs too.
- Without a memory on the frequency the frame shows the **band plan** instead (axis label of the narrowest band, e.g. `HAM 70cm`, in grey;
  the tooltip lists all bands on the frequency). Outside the band plan it stays empty.
- **Squelch closes faster:** the hold after the signal drops below the level is 20 ms instead of 200 ms.
- **ACARS / VDL2 Squawk column:** new column between ICAO and ACFT type, the transponder code from ADS-B (adsb.fi / adsb.lol).
- **Emergency squawks:** a row with squawk 7500, 7600 or 7700 gets a red frame in the ACARS / VDL2 table.
- **ACARS / VDL2 daily logs:** the `[ADS-B ...]` part now has all ADS-B values from the table, in the column order: registration
  (ATN messages), callsign, ICAO, squawk, type, model, flight level with feet, speed; position last. The field order changed.
- **ACARS / VDL2 Ground Station column:** new column after Description, also in the daily logs (`| BTS/LZIB` after the description; ATN
  lines after the header). Airport of the VDL2 ground station (IATA/ICAO), found by its address in the ground station list, ARINC and SITA
  stations alike, so all stations of an airport have the same location; classic ACARS shows `-`. ACARS log lines also have the address
  (`| BUD/LHBP (1191BA)`). The card has the city of the airport under it, in small blue (not in the logs).
  New `airports.py` (IATA to ICAO and city tables, OurAirports, public domain).
- **VDL2 Ground Station filter:** pull-down in the card header with the locations of the messages in the table; shows only the selected
  location, together with the type tags. Remembered in the browser; the ✕ of FILTER ON clears it too.
- **Ground station list:** new `VDL2_Ground_Stations.txt` (2519 stations: address, airport, position and channel when known, city), source: [ACARS-VDL2 group](https://acars-vdl2.groups.io/), redistributed with approval. Thank you Sergi for amazing work. If you come across any new ground station that is not included in the list, please let us know. Thank you. The
  tooltip of a Ground Station cell shows the address and the list entry. A station not in the list falls back to decoding the address
  (SITA stations only); the program also works that way without the file.
- HTTP API: `vdl2.gs` (ground station address), `vdl2.gs_loc` (location), `vdl2.gs_city` (city) and `vdl2.gs_info` (list entry) in the `/api/acars` and `/api/cpdlc` messages.
- **One size for all flags:** the flags at the S-meter and in the VFO windows (USB / state, mode, CUE, AGC / gain, squelch) have the
  same height and letter size in every state; the RF GAIN and SQUELCH frames match them.
- **Speaker and REC** under the volume faders are now flag-sized buttons, one above the other, as wide as the faders.
  The speaker is green with sound on and red when muted.
- **Slower wheel on a touchpad:** VFO digits, spectrum and waterfall tuning, ZOOM, LPF and HPF now add up the small touchpad scroll
  movements and take one step per 150 px of scrolling at the default speed. A mouse wheel notch is still exactly one step.
  **SET → Touchpad wheel speed** (1–10, default 4; left = slower) changes it, remembered in the browser.

## Ver. 0.107

- **AFI – audio frequency inversion** (voice inversion scrambler / descrambler): new **AFI** key in the AUDIO group.
  The demodulated audio is mirrored around the inversion frequency F (f → 2·F − f, band 0 … 2·F): low-pass,
  mix with a 2·F carrier, low-pass again (new `FreqInverter` in `sdr.py`). Inversion is its own inverse, so the same
  setting scrambles and descrambles. All modes except WFM; on/off and frequency remembered per VFO.
  Applied before the squelch, so REC and the decoders get the descrambled audio.
- SET: **AFI – inversion frequency (Hz)**, 500–4000 Hz, default 1750 Hz (band up to 3500 Hz).
- HTTP API: `afi` (true / false) and `afi_hz` in `/api/set` and `/api/state`.
- **DAB / DAB+ digital radio**: new **DAB** button in the OTHER band group. The VFO goes to 2.048 MS/s on the
  centre of a Band III channel (5A–13F, default 12C) and a **DAB+** card opens on the DECODERS tab: channel select,
  ensemble name, SNR, station list (DAB / DAB+, bitrate); click a station to play it, with its DLS text
  ("now playing") and slideshow picture. Audio plays through MAIN volume (REC does not record DAB).
  - Decoding by **welle-cli** 2.7 (welle.io, GPLv2+) in `lib\dab\`, built with MSYS2 UCRT64
    (`installer\build_dab.sh`, sources and licences in `installer\DAB.txt`, `lib\dab\README.txt` in the package).
  - The dongle stays in RADIMCOM: new module `dab.py` runs a local rtl_tcp server (127.0.0.1, free port) that
    welle-cli connects to; its tuning requests retune the VFO, the gain stays the VFO's. Services, DLS, slides
    and the MP3 stream come from welle-cli's web server and are passed on by RADIMCOM.
  - DAB turns ACARS and VDL2 off; the DAB button again (toggle), another band button or OFF in the card turns DAB off and restores the
    previous sample rate. RTL-SDR only (not on LimeSDR or a chained VFO).
- HTTP API: `dab`, `dab_channel` in `/api/set` and `/api/state` (+ `dab_error`, `dab_channels`), new
  `GET /api/dab`, `/api/dab/audio/<sid>` (MP3), `/api/dab/slide/<sid>`, event `dabstate`.
- **WEFAX slant correction**: new **SLANT** field (ppm, -3000 to 3000) and **ALIGN** key in the WEFAX card: click two points on a
  line that should be vertical and the correction is computed. It compensates the sample clock error of the VFO's SDR, also
  straightens the image received so far and is kept after a restart. HTTP API: `slant_ppm` in `/api/wefax`, event `wefaxreload`.
- Passband label in the spectrum has two rows: tuned frequency, then demodulation and bandwidth (`LSB · 3 kHz`).
- **Audio spectrum bubble**: hover over the passband label to see the audio spectrum of the active VFO, up to the end of
  the passband. It is taken before the volume and MUTE. In WFM it shows the demodulated MPX signal to 20 kHz, with the
  19 kHz pilot (the audio itself ends at 15 kHz). HTTP API: new `GET /api/mpx`.

## Ver. 0.106

- **VFO chaining: one dongle for several VFOs.** A VFO can use the dongle of another VFO, e.g. one dongle for
  VFO A–D, or two dongles with two VFOs each (`"chain": "A"` in `vfos.json` instead of a serial number).
  - The owner VFO opens the dongle and sends its samples to the chained VFOs over a local socket
    (`127.0.0.1`, VFO port + 100; new module `iqshare.py`). Each chained VFO has its own frequency, mode, filter,
    squelch, decoders, waterfall and audio.
  - The owner's tuning sets the band the dongle receives (centre ± 95 % of half the sample rate). A chained VFO can be
    tuned anywhere: inside the band it shows a green **CHAIN** flag instead of the USB icon; outside (also when the
    owner moves away) it is silent and shows an orange **OOR** flag ("out of range VFO-A" on hover).
  - Gain, RTL AGC, bias-tee, ppm and sample rate belong to the dongle: changed on a chained VFO, they are applied
    on the owner VFO and so to every VFO on that dongle. VDL2 and TX are not available on a chained VFO.
  - SDR setup (`setup.bat`): for each VFO type a device number, unplug a device, or type the letter of an earlier
    VFO (e.g. `A`) to share its dongle; the wizard now offers all four VFOs even with fewer dongles.
  - The launcher starts the VFOs with their own dongle first, then the chained ones.
- ATN CPDLC (VDL2): click a message to see all decoded fields under the compact lines: the CPDLC / CM / ADS-C
  message first (header with date and time, ASN.1 element names and values), then the VDL2 frame
  (AVLC addresses, X.25, CLNP, COTP, session / association). Click again to collapse.
- Direction arrows in the ACARS / VDL2 card coloured: ↓ downlink (from the aircraft) green, ↑ uplink (from the
  ground) orange.
- VDL2 key greyed out on a LimeSDR VFO (VDL2 runs on RTL-SDR only).
- Message filter in the ACARS / VDL2 card: click the ACARS / CPDLC / ADS-C tags at the top of the card
  to show only those messages (tags can be combined; CPDLC and ADS-C include the ATN versions). "FILTER ON · N of M shown" with ✕ to show all again;
  the filter is remembered.
- ACARS / VDL2 card fills the DECODERS tab and only the message list scrolls; the header with the keys,
  filters and notes stays in place.
- ATN CPDLC rows: the Aircraft column waits for the ADS-B lookup ("…") and then shows the registration, instead of
  showing the ICAO address first and rewriting it.
- ATN ADS-C (ADS-C reports over VDL2) decoded like FANS ADS-C: report type, position, altitude, time, accuracy,
  contract; track, ground speed, vertical rate; heading, Mach, IAS; wind and temperature; next waypoints with times;
  planned trajectory (fixes, levels, ETA, Mach, start of climb / descent). Shown with the purple ADS-C tag.
- Tags unified: ATN CPDLC messages have the same green CPDLC tag as FANS CPDLC (the Description column still says
  "ATN CPDLC"); rows, filter and description use the same colours.
- The tag (ACARS / CPDLC / ADS-C) has its own first column "Type" in the message table. Fixed column widths:
  the table keeps its layout when a filter is switched on or off.
- New **Country** column (between Frequency and Aircraft): flag and code of the country of registration, worked out
  from the aircraft's 24-bit ICAO address (ICAO Annex 10 address blocks, `static/icao_countries.js`), like the adsb.fi
  map does. ATN messages: from the address in the message; ACARS: from the ADS-B lookup. Flag images from flagcdn.com.
- Aircraft column renamed **Callsign** (registration only, linked to the map). Column order: Type, UTC, Freq, Country,
  Flight, Callsign, **ICAO** (24-bit address), and from ADS-B **ACFT type**, **Model**, **FL**, **Speed**; then Label,
  Description, Message. The position is no longer shown. "Frequency" shortened to "Freq".
- **Memory names on the spectrum**: memories in the visible part of the spectrum get a green ▲ marker at the top edge
  (under the band-name strip) pointing at their frequency, with a name tag below it. Tags are placed in up to three rows
  so they do not overlap each other or the mode / bandwidth label; favourites get a place first, a memory that does not
  fit shows only its marker. Hover a tag for the full name, frequency, mode and group; click it to recall the memory
  (frequency, mode, bandwidth).
- **One design for all decoder cards** (FT8, ACARS / VDL2, CW, RTTY, WEFAX, SSTV): the card fills the height of the
  DECODERS tab, the header, settings and notes stay in place and only the black content box (table, text, image)
  scrolls with its own scrollbar. Several cards on at once share the height. SSTV: the live image stays in view and
  the gallery of saved images scrolls next to it.
- **Page scales with the window**: the whole page is laid out in a "virtual window" of at least 1920 × 820 px and
  scaled to the browser window, so the layout no longer reflows on small windows and browser zoom has no effect.
  Spectrum and waterfall stay sharp at any scale.
- **CW decoder more reliable** with weak signals, fading (QSB) and static crashes (QRN):
  - automatic minimum threshold from the noise floor measured in the receiver passband, so noise alone does not
    produce characters (no more random E / T / I after the station stops);
  - the mark level is taken from the decoded marks and falls back quickly after a pause, so a fade no longer leaves the
    threshold too high; lower on/off thresholds let faded marks through;
  - noise blanker: short static crashes are removed before the filters (long bursts are kept, a strong station is
    never blanked);
  - the decoder starts on weaker signals (tone SNR from 6 dB instead of 8 dB);
  - the speed estimate no longer locks onto noise (it is used only when at least 80 % of the marks fit dots and dashes).
  On simulated signals the character error rate fell on average from 40 % to 15 % (e.g. 20 WPM at 0 dB / 500 Hz:
  46 % → 15 %, fading 10 dB at 25 WPM: 21 % → 2 %, static crashes with fading: 24 % → 2 %). The ALC setting does
  not affect the decoder: it works on the receiver signal before the audio and has its own level tracking.
- **Band plan on the spectrum axis** extended and moved to a local table `static/bandplan.js` (Europe / ITU Region 1;
  sources: ITU RR Art. 5, CEPT ERC Report 25 / ECA, ERC/REC 70-03, IARU Region 1 band plan, 3GPP / ETSI, ICAO Annex 10,
  WMO). New bands: UHF military airband (225–400 MHz), VOR/ILS, DME/TACAN, SSR 1030, ADS-B 1090, TETRA, VHF low /
  military (30–87.5 MHz), DAB (Band III), DVB-T/T2 (470–694 MHz), LTE 700 / 800, GSM-900 / 1800, UMTS 2100 (UL / DL),
  LPD433, SRD 868 / LoRaWAN, ISM 2.4 GHz / Wi-Fi, weather satellites (137 MHz, HRPT 1.7 GHz), radiosondes
  (400.15–406 MHz and L-band), COSPAS-SARSAT 406, GNSS L1 / L2 / L5, Inmarsat, Iridium, marine VHF, AIS, NAVTEX,
  2182 kHz, paging 169 MHz, DCF77, NDB, LW / MW broadcast, 13 cm ham. Narrow bands are drawn over wide ones
  (e.g. ADS-B inside DME); hover the axis for a tooltip with the descriptions of all bands at that frequency.
- **Memory import / export** (MEM drawer → Import / export):
  - **⇧ IMPORT SDR#**: enter the SDR# installation folder (remembered by the browser) and import its memories. Reads
    `frequencies.xml` in the folder and in profile subfolders of newer SDR# versions (e.g. `Instances\Profile1`); a single
    profile folder or `frequencies.xml` can be given too. Entries with any frequency shift are imported; duplicates
    (same frequency and name), out-of-range frequencies and unsupported modes are skipped; a broken file does not stop
    the others. The note shows how many were imported / skipped and from which profiles. The command-line import
    (`python memories.py …`) still takes only HF upconverter entries.
  - **⇩ EXPORT ★** downloads the starred memories, **⇩ EXPORT <group>** the group selected in the filter (All = every
    memory), with one click, as a JSON file in the `memories.json` format.
- **HTTP API description** in `API/API.md` (ports, state, settings, events, audio, decoders, memories, examples);
  linked from the README and included in the install / upgrade zips.
- **LimeSDR TX limited to allowed bands**: the receiver (server side, not only the page) allows PTT only when the
  whole emission (tuned frequency ±5 kHz) is inside ham 160 m – 10 m, 6 m, 4 m, 2 m, 70 cm, 23 cm (IARU Region 1),
  CB 26.960–27.410 MHz or PMR446 446.0–446.2 MHz. Retuning during TX ends the transmission.
- **TX disclaimer**: red "IMPORTANT – transmitting disclaimer" in SET (licence required under ITU / CEPT / FCC /
  national rules, operator fully responsible, software provided AS IS). Enable TX asks to accept it, the server
  refuses TX without it and remembers when it was accepted; TX enabled by an older version is switched off until
  the disclaimer is accepted.
- **MIT licence** (`LICENSE`, also in the install / upgrade zips) with a radio transmission notice: anyone who
  modifies or removes the TX limits is solely responsible.
- All remaining Slovak comments in the code (`static\app.js`, `style.css`, `index.html`, `bandplan.js`, batch files)
  translated to English.

## Ver. 0.105

- **VDL2 decoder** (VDL Mode 2, 136.725–136.975 MHz): the digital data link that carries most airline ACARS over
  Europe and the European ATN CPDLC. New **VDL2** key under DECODE: the VFO goes to 2.1 MS/s around 136.850 MHz
  and all five European VDL2 channels are decoded at once; spectrum, waterfall and audio keep working.
  Decoding is done by [dumpvdl2](https://github.com/szpajder/dumpvdl2) 2.7.0 (GPLv3, built for Windows with MSYS2,
  `lib\vdl2\`), which runs as a separate program fed with the raw samples (`vdl2.py`).
- ACARS messages from VDL2 go through the same decoding as classic ACARS: FANS-1/A CPDLC and ADS-C inside,
  ADS-B lookup, daily logs (tagged `VDL2`). European **ATN CPDLC** is shown in a compact form:
  message number, answered message, time, "ack required", and the elements with their values
  (e.g. `dM6 REQUEST FL360`, `dM0 WILCO`), plus connect / abort / release.
- **ADS-C decoder** (`adsc.py`, ARINC 745): position reports (position, altitude, time, accuracy), track,
  ground speed and vertical rate, heading and Mach, wind and temperature, predicted route, projected intent,
  flight ID, contract requests and acknowledgements. Field layouts checked against libacars and live reports.
- **One card for all aircraft messages.** ACARS and VDL2 are two keys (one link at a time) that open the same
  card; the CPDLC key and card are gone. Coloured tags: ACARS (plain message), CPDLC, ADS-C, ATN CPDLC.
  The card title and buttons follow the link: ACARS channel buttons, or one 136.850 button for VDL2.
  One LOG writes both `acars_` and `cpdlc_` daily logs.
- ATN CPDLC messages carry only the aircraft's 24-bit ICAO address: registration, type, position and callsign
  are now looked up on ADS-B by that address (adsb.fi / adsb.lol), shown in the Aircraft and Flight columns and
  written to the CPDLC log.
- 2.1 MS/s added to the sample rates (needed by VDL2).

## Ver. 0.104

- **CPDLC decoder** (FANS-1/A, ARINC 622): controller-pilot messages carried in ACARS (labels AA/BA/H1)
  are decoded to the standard message text, e.g. "CLIMB TO AND MAINTAIN FL350",
  "AT VANDA CONTACT CHRISTCHURCH CONTROL 128.100 MHz", and position reports with fixes, ETA, winds and temperature.
  Shows the message number (MIN), the answered message (MRN), the ground station and the CRC check.
  Long messages split into several ACARS blocks are joined.
- CPDLC card with its own **CPDLC** key under DECODE; it works with the ACARS card off. The decoded CPDLC text
  is also shown in the ACARS card. Click a message to see the raw ARINC 622 text.
- CPDLC daily log: `data\acars\cpdlc_YYYY-MM-DD.txt` (UTC) when LOG is on.
- Command-line test: `python cpdlc.py u AA "/AKLCDYA.AT1.9V-SVG21D0755D84AD067448398722949A7521C8AB4A1C8EAB5CE393"`.
- New file `CHANGELOG.md` (this file).

## Ver. 0.103

- Settings, memories, logs, saved images and backups moved to the `data\` folder (program files stay in the
  main folder). Older installations: the files are moved to `data\` automatically at the first start.

## Ver. 0.102

- Decoders (FT8, WEFAX, SSTV, ACARS) moved to a second tab DECODERS next to SPECTRUM, no more scrolling down.
  The tab shows the number of running decoders and a green dot when something new arrives; turning a decoder on
  opens the tab.
- The open tab (SPECTRUM / DECODERS) is remembered for each VFO and restored when switching VFO; a VFO without
  a saved tab opens DECODERS when a decoder is running on it.
- RTTY decoder (Baudot/ITA2) with automatic detection of shift (90–1000 Hz), speed (45.45/50/75/100 Bd) and
  polarity; each can also be set by hand. E.g. amateur RTTY 45.45 Bd / 170 Hz, DWD weather 50 Bd / 450 Hz
  (4583, 7646, 10100.8 kHz). Text shown like on an old green phosphor terminal.
- CW decoder is now a card in the DECODERS tab; CW and RTTY text fills the whole tab.
- LOG checkbox in every decoder card: daily log `logs\<decoder>_YYYY-MM-DD.txt` (UTC, one line per message;
  WEFAX/SSTV log the names of saved images). ACARS logs to `acars\` only when LOG is on.

## Ver. 0.101

- ACARS decoder (VHF airband, 131.725 MHz etc.): coherent MSK demodulation, CRC check, message description in
  plain English, long messages collapsed (click to expand).
- ACARS: aircraft type and position looked up on ADS-B (adsb.fi / adsb.lol), shown in blue; click the
  registration or flight to open the live map.
- ACARS daily log: `acars\acars_YYYY-MM-DD.txt` (UTC), including the ADS-B data.
- SQUELCH slider under RF GAIN for every VFO (dimmed in modes without squelch).
- FM filter widths 500 Hz – 50 kHz (buttons 0.5 / 3 / 6 / 12 / 25 / 50 kHz).
- Grey RDS logo when no RDS is received; inactive ALC/SQL flags no longer larger.
- Setup: upconverter LO is checked (30–1000 MHz, Hz input converted); LO/ppm can be fixed in SET even when the
  dongle is in error.
- FT8 works without PyAudio (newer Python); a missing PyFT8 no longer stops the receiver.
- Installer shows the download progress of the Python packages.

## Ver. 0.1

- First release: 4 VFOs, spectrum/waterfall, AM/FM/WFM/SSB/CW, WFM stereo + RDS, upconverter, CUE, REC,
  FT8/WEFAX/CW/SSTV decoders, memories, LimeSDR TX, installer with SDR setup.
