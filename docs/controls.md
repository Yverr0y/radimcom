[← README](../README.md) · [Documentation](README.md)

# Controls

![The main screen with a yellow callout for each part: S-meter, VFO windows, key groups, monitor and recording, spectrum, waterfall and their controls](images/main_annotated.png)

## Tuning

| Action | How |
|---|---|
| Switch VFO | **VFO-A … VFO-D** button or click on an inactive (grey) display |
| Enter a frequency | click on the active VFO display, type e.g. `7100` (kHz) or `145.5` (MHz), units `k` / `M` / `Hz` also work; Enter (Esc cancels) |
| Tune by one step | ← → arrow keys, or mouse wheel over the spectrum or waterfall (step set by STEP) |
| Next memory | ↑ ↓ arrow keys recall the next memory above / below the tuned frequency, among those visible in the spectrum |
| Tune by a digit | mouse wheel over a digit of a VFO display tunes by that digit's place (1 Hz … 1 GHz); works on inactive VFOs too, without switching |
| Tune to a point | click in the spectrum or waterfall |
| Move the band | drag with the mouse in the waterfall, or in the spectrum outside the passband |
| Move the passband | drag the passband or its label in the spectrum: the spectrum stays in place and the frequency changes |
| Filter width | drag the filter edge in the spectrum |
| Band | buttons in the groups HF HAM, HF BROADCAST, VHF / UHF HAM, OTHER (FM BCAST tunes the last FM station listened to, DAB turns on DAB radio) |

Hovering over the spectrum or waterfall shows the frequency under the mouse.
The label above the passband shows the tuned frequency, and under it the demodulation and bandwidth.
Hovering over that label opens a small audio spectrum of the active VFO, up to the end of the passband (it does not depend on
the volume or MUTE). In WFM it shows the demodulated MPX signal up to 20 kHz instead, with the 19 kHz stereo pilot.
In CW mode the bubble also shows the decoded text (the last two lines), from the CW decoder if it is on, otherwise from a separate
decoder that runs only while the bubble is open; the first characters come after ~1–3 s.

If a band or memory is outside the range of the active VFO, the receiver switches by itself to a VFO that can
receive it (e.g. an HF band to the VFO with the converter).

## VFO window

Each VFO is one dark display window; a click on an inactive window or on its **VFO** key under the window selects
that VFO. The active one is faintly lit with a yellow line towards its key, and its key is lit (yellow LED); the key of an
inactive VFO with an open squelch gets a green LED, a transmitting one turns red. Beside each VFO key is the **CUE** key
of that VFO (orange LED): that VFO stays audible at CUE level while another VFO is selected (the same as CUE in the window).

- **Top row:** VFO-x (boxed and yellow on the active VFO, green on an inactive one with an open squelch), the name of the
  memory / band plan / satellite transponder (lit on the active VFO; a memory with its own tag colour shows its name in that colour), a red dot while recording, a red struck-through speaker
  when a decoder (ACARS, VDL2, HFDL, AIS or ISM) has muted the audio of this VFO, and the connection state as a USB icon: green = SDR running,
  blinking orange = connecting (waiting, opening the dongle, LimeSDR calibration), grey = disconnected or error
  (hover for details). A chained VFO shows CHAIN, one out of the range of its dongle owner OOR.
- **Frequency** in the middle.
- **Tone squelch row** under it: the set **CTCSS** tone and **DCS** code (keys TSQ-C / TSQ-D): dark like the unlit annunciators = off or not FM,
  orange = on, lit orange box = the tone / code is received now.
- **Info row** under that (each item has a fixed place): RX / TX (red while transmitting), the filter width, the audio
  **HPF** and **LPF** with their cutoffs (lit when on), **ST** (WFM: lit while stereo is decoded, grey without the 19 kHz pilot or with S/M set to mono),
  **SQL** (squelch on: grey while closed, green while open) and **CONV / BYPASS**, the required position of the manual
  upconverter switch (VFOs with upconverter mode auto; BYPASS in amber).
- **Annunciators** under it, lit when on and dark when off or not used in the current mode: the mode, AGC / AGC+
  (red while AGC+ sees A/D clipping), NF, SP, ALC, AFI (blinking), ASQ, ATU, the satellite icon (frequency corrected for
  Doppler by satellite tracking) and **CUE** (click to toggle CUE for that VFO without switching).
- **RF** and **SQL** segment bars with their values (squelch only in AM/FM/WFM): drag, click or turn the mouse wheel over
  them. They work on inactive VFOs too, without switching.

## Frequency display

- Below 30 MHz in **kHz**: `7.016.500` kHz, the first dot separates thousands, the second is the decimal point.
- From 30 MHz in **MHz**: `439.475.000` MHz.
- The last three (smaller) digits are Hz.

## Function keys

- **MODE**: demodulation. **FILTER**: bandwidth for the current mode (WFM: 50, 75, 150 or 200 kHz, default 200 kHz = the full broadcast signal with the best stereo and RDS; 150 kHz is a compromise, 50–75 kHz help with a weak station next to a strong one but distort and usually lose stereo and RDS; any width up to 250 kHz by dragging the filter edge).
- **GAIN**: AGC switches automatic tuner gain on/off (manual gain with the RF GAIN slider or in SET). **AGC+** sets the tuner gain from the level of the A/D converter: as high as possible without clipping it (the tuner AGC of the R820T watches only its LNA and mixer, not the A/D). The gain flag under the display shows `+` and the gain; the AGC+ key gets a red underline while the A/D clips. With the squelch set, AGC+ makes it work as auto squelch (ASQ lights up), because a fixed level would not fit the changing gain; the slider then only turns it on / off, and ASQ pressed in this state turns the squelch off.
- **TUNE**: **ATU** (autotune) in USB, LSB and AM. With ATU on, a click on a signal in the spectrum or waterfall tunes to the clicked point (without the step grid), listens for a moment and moves the tuning onto the carrier; the key blinks while listening and the passband label shows the shift (e.g. *ATU +130 Hz*) or *no signal*. Tuning by the wheel, the arrow keys, dragging or the VFO display digits starts it too, 0.7 s after the tuning rests, when it moved by at least 150 Hz. AM: the carrier is found within a few Hz in under 1 s. SSB: the edge of the voice band goes onto the red line (the tuned frequency): the lower edge in USB, the upper one in LSB, within a few Hz after ~2 s of speech (up to 6.5 s while nobody speaks). Tuning elsewhere while listening cancels it.
- **STEP**: tuning step: 10 Hz, 100 Hz, 1 kHz, 10 kHz in every mode, WFM included. WFM remembers its own chosen step, the other modes share one (in the browser). **Zoom** (1×–32×) is the bar in the top right corner of the frequency scale: − / +, a click on a cell, or the mouse wheel over it. **Waterfall speed** (WF, 1/8 – 4×) is the same bar in the top right corner of the waterfall: below 1× several rows are averaged into one line (slower, longer history), above 1× each row is drawn taller (faster); the setting is kept in the browser. **Waterfall settings**: the gear in a square above the speed bar; with the mouse over it a half transparent window opens with the **colour scheme** (Classic, Inferno, Viridis, Turbo, Ice; only new rows take the new colours), **colour range** and **colour offset**. Kept in the browser.
- **DEC** (group DECODE): turns on the CW, FT8, PACKET, RTTY, SSTV, WEFAX, ACARS, ADS-B, HFDL, VDL2, AIS or ISM decoder (DAB and DSD are keys in MODE with their own tabs). The panels are in the
  **DECODERS** tab next to SPECTRUM; turning a decoder on opens it, a green dot signals a new message/image.
  Every panel has a LOG checkbox for the daily log:
  - FT8: band buttons (160 m – 10 m) and CLR.

    ![DECODERS tab with the FT8 decoder on 80 m: one 15 s cycle of decoded messages, CQ calls in green](images/decoders_ft8.png)

  - WEFAX: stations (DWD Pinneberg 3855/7880/13882.5 kHz, Northwood GYA 2618.5/4610/8040/11086.5 kHz), LPM/IOC (Auto or fixed),
    NEW and PNG; a click in the image sets that spot as the left edge. Finished images are saved to `data\wefax\`.
    **SLANT** (ppm) with **ALIGN** straightens a slanted image: click two points on a line that should be vertical; it is kept after a restart.
    **AFC VFO** (on by default): once the decoder locks, the VFO is retuned so that the signal centre is at 1900 Hz in USB, without a break in the image.
    Next to the live image a gallery of the last 12 saved images: a click opens one, × deletes it, **DEL ALL** deletes all.
  - CW: TUNE switches to CW and tunes to the detected tone, CLR clears the text. The decoder sets its own
    threshold from the measured noise floor and the level of the received marks (follows fading, a noise blanker
    removes static crashes), so it does not depend on the ALC or the volume.
  - RTTY: SHIFT, BAUD and POLARITY (Auto or fixed), CLR.

    ![RTTY decoder receiving the DWD weather broadcast: 50 Bd, 445 Hz shift and reverse polarity detected automatically](images/decoders_rtty.png)

  - SSTV: frequencies (80m–10m, ISS FM), mode selection (Auto by VIS), STOP, PNG and a gallery of recent
    images (saved to `data\sstv\`). Modes Martin M1/M2, Scottie S1/S2/DX, Robot 36/72, PD 50–290;
    AFC and slant correction are automatic. Filter at least 2.7 kHz.
  - PACKET: AX.25 at 1200 Bd AFSK (APRS 144.800 MHz, ISS 145.825 MHz) and 9600 Bd FSK/GFSK/GMSK G3RUH (satellites),
    both at once (BAUD) and independent of the mode and filter (FM is demodulated from the baseband; 9600 Bd needs at
    least 1.536 MS/s). SCRAMBLER Auto tries 9600 Bd with and without the G3RUH scrambler. AFC shows the tuning error of
    the last 9600 Bd frame. Views: FRAMES (APRS meaning in blue over the raw text, binary telemetry as hex),
    STATIONS (APRS stations with the distance and bearing from the station set in SETTINGS › GENERAL › LOCATION) and MAP
    (OpenStreetMap; the □ key in its top right corner opens it alone in a new browser tab); the filter field narrows both. Frames with a wrong checksum are only counted.
    Graph on the right: SPECTRUM of the signal around the tuned frequency (averaged, MAX hold; S/N, 99 % bandwidth,
    live 9600 Bd AFC as a green line) or EYE, the eye diagram in real time (9600 / 1200 Bd), with the eye opening now
    and in the last good frame, and at 9600 Bd the deviation and the live AFC.
  - ACARS (classic link, AM 2400 bit/s): channel buttons 131.525 / 131.725 / 131.825 / 136.900 MHz, CLR;
    click the registration or flight to open the ADS-B map. Plain ACARS, FANS-1/A CPDLC and ADS-C are shown
    with coloured tags.

    ![ACARS card on 131.725 MHz: ADS-C position reports with route, track and speed, and plain ACARS messages, aircraft type and position from ADS-B](images/decoders_acars_legacy.png)

  - ISM: see [ISM decoder](decoders/ism.md).
  - HFDL (aircraft data link on HF, 2.9–22 MHz): band buttons centre the VFO on an HFDL band; all HFDL channels
    inside the band of the VFO are decoded at once and the audio of the VFO is muted. See [HFDL decoder](decoders/hfdl.md).
  - AIS (ships, 161.975 / 162.025 MHz): the 162.000 button centres the VFO between the two channels, both are decoded
    at once from the raw samples and the audio of the VFO is muted; MESSAGES / SHIPS / MAP. See [AIS decoder](decoders/ais.md).
  - VDL2 (VDL Mode 2, digital): one centre button 136.500 MHz (re-centres the VFO at 2.1 MS/s; all channels of the region
    are decoded at once), EU and US region buttons, the number of channels (list in the tooltip) and frame count, CLR. Plain ACARS, CPDLC, ADS-C
    and European ATN CPDLC in one table, see [Aircraft data link](decoders/aircraft.md).
    RTL-SDR only, not supported on LimeSDR or Airspy.

- **AUDIO**:
  - S/M: WFM stereo / mono (mono = less noise on weak stations).
  - AFI: audio frequency inversion (voice inversion scrambler / descrambler) in all modes except WFM. The audio is mirrored around
    the inversion frequency (SET, AUDIO tab, 500–4000 Hz, default 1750 Hz); the same setting scrambles and descrambles. REC and the decoders get the descrambled audio.
  - NF: automatic notch filter for AM/LSB/USB, finds and removes steady tones (whistles, carriers) by ~40 dB and
    leaves speech. It also feeds the SSTV decoder, so turn it off for SSTV.
  - LPF / HPF (keys with the filter curve icon): audio low-pass and high-pass filter in all modes except DAB (36 dB per
    octave; both on = band-pass). The key shows the cutoff; change it with the mouse wheel over the key or type it in SET.
    The audio spectrum bubble darkens what they cut off. You hear and REC the filtered audio, decoders still get the full audio.
  - SP: remove spurs from local sources. A press forgets all stored spur lines of the VFO, learns the band received now
    (LEARN, ~5 s, the key blinks red) and switches the removal on (steady yellow); another press switches it off.
    Learn on a quiet band. The band-stop is set in SETTINGS › VFO › ADVANCED.
  - ASQ: auto squelch in AM/FM/WFM. The squelch level follows the noise in the channel plus a margin (6 dB by default, SET, AUDIO tab, 2–30 dB).
    The noise is measured in the spectrum of the dongle band (the quietest 10 % of its points, converted to the channel bandwidth), so a signal in
    the channel, even a long one, does not raise the level and close it; in a crowded band (e.g. FM broadcast) the quietest channel power over the
    last 15 s is used when it is lower. The measurement starts again after a change of frequency, mode, bandwidth or gain. The SQL bar
    of the VFO window follows the level in use; so does the yellow mark on the S-meter.
  - TSQ-C / TSQ-D: tone squelch in FM – CTCSS (sub-audio tone, 50 standard tones 67.0–254.1 Hz) or DCS (digital code at
    134.4 bit/s, 104 standard codes, polarity N or I). It adds to the squelch of the SQL bar or ASQ: the audio passes only while
    that squelch is open and the set tone / code is received; without the SQL bar and ASQ the tone alone opens it. One of them at
    a time. Opens ~0.3 s after the tone starts, closes ~0.5 s after it stops; the tone is filtered out of what you hear
    (300 Hz high-pass). Tone / code: mouse wheel over the key, or SETTINGS › VFO › AUDIO (the DCS polarity only there).
    As in every radio, a DCS code is the same as its cyclic shifts, so e.g. 023N also opens on 047I.
  - ALC: automatic audio level in AM/LSB/USB/CW; off = fixed gain.
  - CUE: keep hearing this VFO (at the CUE level) when another VFO is selected.
  - RECS: the **RECORDINGS** tab in the bottom part (beside SPECTRUM, DECODERS, SATELLITES), see [Recordings](#recordings) below. Like MEM, the key
    shows or hides the tab for all VFOs and is remembered in the browser.
- **TRACKING** group:
  - **SAT**: the satellite key switches to the SATELLITES tab and back, see [Satellite tracking](satellites.md).
  - **RCTRL**: shows or hides the **ROTOR CONTROL** tab (for all VFOs, remembered in the browser): a map to aim the rotor at a place (page MAP) and the switches of the sources that move the rotor (page CONNECTION), see [Rotor control map](satellites.md#rotor-control-map).
- **Volume** (top right, MONITOR): vertical MAIN (active VFO) and CUE faders with a dB scale between them (+3 … −∞ dB; 0 = no gain),
  stereo L/R level meter with the dB numbers (0 dB = −6 dBFS), a peak hold of 1 s and a round CLIP LED above each column (0 dBFS reached).
  Below them the speaker key is MUTE (green LED = sound on, red = muted). Under it are two recording keys for the active VFO, which work independently of each other and go on with the page closed:
  - **REC** records everything until switched off, also the silence of a closed squelch. After 15 minutes it continues in a new file.
  - **REC SQ** records only while there is audio (open squelch), each session in its own file. A session ends when the squelch stays closed for 1 s; that silence is not saved, and a burst shorter than 0.3 s is dropped. In modes without a squelch, or with the squelch off, one session runs until the key is switched off, with no length limit.

  Files go to the recordings folder (default `data\recordings`, can be changed in **SETTINGS › GENERAL › RECORDINGS**: a full path, created if missing, one folder for all VFOs; a running recording finishes its file in the old folder) as MP3, 128 kbps, named by the frequency and mode at the start of the file and its start time: `145.500000MHz_FM_20261105_155300.mp3`. If that frequency is in the memories, the name of the memory comes first, with `_` instead of spaces: `Piestany_TWR_118.575000MHz_AM_20261105_155300.mp3`. Retuning during a recording does not start a new file; a change of the sample rate does. A key shows the time of the current file while writing, and it is lit without a time while waiting for audio. A red dot in the corner of the VFO display shows the same for each VFO: blinking while writing, steady while waiting for audio. Like the audio of the VFO, recording pauses while ACARS, VDL2 or ISM runs, and DAB is not recorded.

  <a id="recordings"></a>**RECORDINGS tab** (AUDIO → RECS): every MP3 file of the recordings folder (the folder is shared by all VFOs), newest first: start time,
  memory name, frequency, mode, length (from the size, 128 kbps), size and the file name. A file being written has a blinking red dot; its length grows
  while the tab is open (the list is read again every 10 s while a recording runs, ⟳ reads it at once). A click on a row plays the file in the browser
  with the player in the head of the tab: ▶ / ▮▮ (also the PLAY key), seeking in the bar, the player's own volume (not MAIN, so the live audio keeps
  playing; MUTE it if you want). A file being written plays what is saved so far. **NEXT** (on by default) continues with the next older file when one
  ends, so the short sessions of REC SQ play one after another; the filter box narrows the list to rows whose name, memory, kHz, mode or date contains
  the text (NEXT follows the filtered list). ✕ at the end of a row deletes the file after a question; a file being written cannot be deleted.
- **MENU → SET (gear)**: settings. While the gear key is lit, the bottom part has a **SETTINGS** tab
  (beside SPECTRUM, DECODERS and SATELLITES); the open pages are remembered in the browser.
  The gear is one switch for all VFOs; switching it off hides the tab. Two pages:
  - **GENERAL**: settings of the whole station, the same on every VFO.
    - **SKINS**: finish of the panel – dark brushed aluminium (default), black (darker) brushed aluminium, light brushed aluminium, mahogany or paint. A click on a colour of the RAL chart
      (36 common RAL Classic shades, screen approximations) or an own colour sprays the panel with it; on a light colour the print and the logo turn dark.
      Keys, displays and the screen stay the same. Remembered in the browser.
    - **S-METER**: layout (needle, bar graph, LED bar, VFD display, amber needle (default), 7-segment, peak bar), remembered in the browser for all VFOs.
    - **TOUCHPAD**: touchpad wheel speed (1–10, default 4; left = slower), remembered in the browser for all VFOs. A mouse wheel notch is always one step.
    - **LOCATION**: the station location, shared by all VFOs: Maidenhead **locator** (4, 6 or 8 characters; gives the centre of its square) or **latitude** and **longitude**,
      the **altitude**, and **CHOOSE ON MAP** (an OpenStreetMap map, the tiles need internet: click the place of the antenna, then **SAVE**). Used by the satellites
      (passes, Doppler, rotor tracking), the packet decoder (APRS distances and map), HFDL and AIS (maps). A new installation starts at 0.0 / 0.0; an older
      installation takes over the station of SATELLITES › SETUP. Saved in `data\location.json`.
    - **ROTOR**: the antenna rotor of the station, one for all VFOs (it does not change with the active VFO). **ON / OFF** at the top left: OFF only says that the rotor link is off;
      ON opens the link with the serial port chosen under it and shows the rest: a **polar plot** (north up, centre = zenith) and beside it an **elevation column**
      0–180° (over 90° the antenna looks back over the top). The orange cross / orange arrow is the antenna now, the green ring the requested direction (only while the rotor is on its way); beside them the actual AZ / EL (orange) and the requested AZ / EL (green). The shown position is filtered, so the ~1 % noise of the readings does not flicker. A click on the polar plot
      turns the antenna to that azimuth and elevation, a click on the column sets only the elevation (not while TRACK moves the rotor). Keys **STOP** (both motors),
      **RESET** (clears a fault, orange while there is one) and **MONITOR** (shows AZ / EL in the AD, see below; one switch for all VFOs, remembered in the browser).
      Then the **azimuth calibration**. The settings are in `data\rotor.json`; the serial port is held by the receiver of the first VFO in `vfos.json`,
      the page sends the rotor commands there whichever VFO is active. See [Satellite tracking](satellites.md).
  - **VFO**: settings of one VFO. On the left the keys **VFO-A … VFO-D** (like the VFO keys under the VFO windows; one without an SDR is grey);
    the lit one is the active VFO and is joined to the card on the right, which holds its settings. A press on another key switches the
    active VFO (as the keys under the VFO windows) and SETTINGS stays open. The card has the pages:
    - **SDR DONGLE**
      - **Block diagram** at the top: the path of the signal antenna → upconverter → bias-tee → tuner → A/D (RTL2832) → USB → DC removal → SP spurs removal → spectrum / VFOs,
        with the crystal (ppm) clocking the tuner and the A/D, and AGC+, which reads the A/D level and sets the tuner gain (green dashed loop).
        Each block has a number, and the card of its setting has the same number (SP = 10 and AGC+ = 11 on the ADVANCED page);
        a click on a block highlights its card, switching to ADVANCED for SP and AGC+. A grey block has no setting for this dongle or VFO (a VFO with a fixed dongle). Shown for RTL-SDR dongles only, not for LimeSDR or Airspy.
      - Without `vfos.json` (single receiver) the dongle selection and the upconverter mode (auto / on / off).
      - **Bandwidth**: the width of the band the dongle receives (sample rate) = the width of the spectrum and waterfall.
      - **Correction (ppm)** and **Upconverter LO (MHz)**.
      - Tuner gain (manual or automatic) and **RTL2832 digital gain** (its digital AGC, RTL-SDR only).
      - **Remove DC peak** (on by default): removes the peak of the dongle in the centre of the band, from the waterfall and from the received signal. **Width** (up to 1000 Hz) also
        takes out its wide skirts, which LimeSDR needs, but weakens signals that close to the centre. **Suppression** (0–60 dB) sets how deep the removal goes.
      - **Bias-tee** 4.5 V (if the SDR has it). Turn it on only when the upconverter or preamplifier really needs it.
      - **RESET SDR DONGLE**: closes the dongle and opens it again with the same settings (frequency, gain, bandwidth); for a stopped spectrum or a USB error.
    - **ADVANCED**
      - **Dongles and VFOs**: every dongle from `data\vfos.json` with its serial number, the VFOs it serves (chained ones too) and its note; State ✓ when the VFO receiver has the dongle open and running
        (an error with its reason in the tooltip), connected RTL dongles without a VFO as *free*. The dongle these settings apply to is highlighted. Assignment changes need a full server restart.
      - **SP – Spurs removal**: for a switching power supply and the like. **LEARN** finds lines at a regular spacing of 12 kHz or more in the band received now, so learn on a quiet band.
        Each line gets a band-stop set by **Width**, **Edge**, **Shift** and **Depth**, which takes it down to the noise around it. Cleans the waterfall and the channel you listen to (not WFM and wide FM).
        A signal on a spur is removed with it.
      - **AGC+**: its parameters (clipping thresholds, steps down and up, the level for going up, target, hold time, settle blocks, and *Bold: up while clipping ≤* – occasional A/D clipping tolerated for a higher gain) with the gain and A/D level live; **PRESETS** above the sliders, from careful to bold, the matching one lit: **CAREFUL** (no clipping), **MODERATE** (default: peak up to −2…−5 dBFS, short clipping up to 100 ppm tolerated), **BOLD** (climbs while the clipping stays ≤ 20 ppm, down above 300 ppm). With WFM the blocks around a gain step are played in mono, so the stereo does not turn to noise.
      - **S-meter: S9 =**: calibration of the S-meter of this VFO (the level in dBFS shown as S9; was on UI › S-METER).
    - **AUDIO**: AFI inversion frequency, the ASQ (auto squelch) margin above the noise (2–30 dB), the CTCSS tone (TSQ-C) and DCS code with polarity (TSQ-D), HPF and LPF frequency. The squelch level itself is set by the SQL bar of the VFO window.
    - **TX** (LimeSDR only): Enable TX, see [Transmitting (LimeSDR)](configuration.md#transmitting-limesdr).
- **MENU → MEM**: frequency memories. While the MEM key is lit, the bottom part has a **MEMORIES** tab (beside DECODERS,
  SATELLITES and SETTINGS) that covers the spectrum and waterfall like the other tabs; the MEM key is one switch for all VFOs,
  switching it off hides the tab, and the open page is remembered in the browser. The pages:
  - **CHANNELS**, **GROUPS**, **IMPORT**, **EXPORT**: the [memory editor](#memory-editor). CHANNELS is also the list to
    recall memories from: a click on a row selects it (Ctrl+click adds or removes rows), a double click tunes the memory
    (frequency, mode, width; a DAB memory turns DAB on with its channel, and the decoder and recording of a memory are
    switched on), and ✎ at the start of the row opens it in the form. The memory the VFO is
    tuned to is highlighted, and the table scrolls to it (the order stays) when the page opens and when the VFO moves to
    another memory.
  Memories in the visible part of the spectrum show their name on a tag at the top of the spectrum (green, or the colour
  chosen in the editor; a red ● before the name = recalling it starts a recording); click a tag to recall the memory.

- <a id="scan"></a>**MENU → SCAN**: scanner. While the SCAN key is lit, the bottom part has a **SCAN** tab (one switch for all VFOs;
  the tab shows the scan of the active VFO, the LED of the key blinks (in the colour of its lit legend) while it scans and the tab has a green ●). The scan runs on the active VFO only,
  the other VFOs keep working. From the top:
  - **What is scanned – four tiles** (each shows its number of channels); the one chosen is lit and points with an arrow at the card with its settings:
    - **MEMORY**: the stored channels – **CHANNELS** chips: ALL, ★ FAVOURITES and one chip per memory group, each with the number of memories scanned.
      Mode and bandwidth come from each memory. Memories with SCAN unchecked, DAB and DSD memories and channels out of the range of the VFO are left out
      (the reason is in the State column).
    - **VISIBLE BAND**: the part of the spectrum shown now, taken at START (zoom or move the spectrum first). **MODE** keys (AM / FM; SSB and CW have no carrier for the squelch, WFM has FM BCAST)
      choose the demodulation and switch the VFO to it; the bandwidth is the one the VFO uses for that mode, the grid half of it. The tuner is **not moved**:
      the spectrum and waterfall stay as they are and the whole band shown is scanned at once (but ~6 % at each edge of the dongle band, listed as left out).
    - **RANGE**: **PRESET** chips (airband 118–137 MHz AM 8.33 kHz, PMR446, 2 m, 70 cm, LPD433, marine VHF, CB) fill FROM / TO MHz, STEP kHz, MODE and BW kHz;
      the **MODE** keys choose the demodulation (BW is set to the bandwidth the VFO uses for it) and switch the VFO to it too. A range wider than the band of
      the dongle is scanned window by window (the tuner moves).
      **STORE FOUND**: every frequency heard for at least 1 s becomes a memory in the group **Scan YYYY-MM-DD** (not when a memory is already there).
    - **FM BCAST**: the FM broadcast band **88–108 MHz in WFM** (fixed), searched for stations with its own algorithm: grid 50 kHz, only the core ±18 kHz of
      each channel is measured and a station is taken only where it is the strongest point ±100 kHz around, so the VFO lands on the **centre** of the station,
      not on its side (the tuner centre sits halfway between two grid points, away from the DC spike). Each station is heard **LISTEN** s (8), then the scan
      goes on to the next station up the band and after 108 MHz from 88 MHz again. **◀ ▶** step between the stations found. The bandwidth is that of the VFO
      for WFM (at least 150 kHz). **STORE FOUND**: each station becomes a WFM memory in the group **FM YYYY-MM-DD**, named by its RDS PS when it has one.
    A click on another tile while scanning **stops the scan** (START scans the new source); a click on another chip or mode key continues the scan with it at once. At START of a VISIBLE BAND / RANGE scan the VFO shows the mode scanned.
  - **Keys**: **START / STOP** is one key. Only while scanning: **HOLD / CONTINUE** (hold on the channel; the normal squelch of the VFO works), **✕ LOCK OUT** (leave the channel heard now out until STOP, as ✕ in its row), **SKIP** (leave the
    channel and skip it for 5 min), **◀ ▶** (hold on the previous / next channel). Tuning by hand or recalling a memory holds the scan too.
    **● REC**: each activity is recorded to a WAV file (subfolder `scan` of the recordings folder) with the 0.5 s before the signal came back.
  - **⚙** (the key shows a summary; a click opens the settings, mostly set once):
    - **AUTO SQUELCH** (recommended, on by default): a channel without its own SQ opens at its noise floor + **MARGIN** dB; off = the squelch level of the mode
      (when that squelch is off too, the auto squelch is used, so no channel is left out or held open by noise). The noise floor of a channel is learned from its own measurements while it is quiet (spurs, the DC spike and local noise included).
    - **CONTINUE**: **AFTER SIGNAL** = the set seconds after the signal drops (a reply is heard), **AT ONCE**, **AFTER TIME** = after the set seconds even while it lasts.
    - **PRIORITY EVERY**: priority channels in another tuner window are checked this often while another channel is heard (0 = off; in the same window they win at once).
    - **CARRIER LOCKOUT** (OFF, 30 s, 1, 2, 3, 5, 10, 30 min): a channel open longer than this without a break is locked out until STOP.
    - **PICK** (VISIBLE BAND / RANGE): NEXT = the first active channel after the last one heard, STRONGEST = the strongest one.
    - **KEEP HISTORY**: the activities and the WAV recordings of the scan are deleted after this many days (31).
  - The status display beside the keys: SCANNING (a moving line) / LISTENING / PRIORITY LOOK / HOLD, the channel, a bar with its level (green) and squelch
    (yellow line), ● REC, and the numbers of the scan (channels, channels per second, tuner window, locked out, left out, stored).
  - Page **CHANNELS**: memories – **SCAN**, **SQ** (own level, dBFS), **ASQ** (own margin, dB) and **PRIO** are edited in place (saved in the memory, a running scan
    takes them at once); a band / range – only the channels heard, active or locked out, without the memory columns (SCAN, Name, BW, SQ, ASQ, PRIO). Level, Noise and SQL are the live values in dBFS, Hits = how many times it stopped
    there, Last = time of the last activity. **✕** in a row locks the channel out until STOP (red ✕ and the state LOCKED OUT; a click again scans it again; the tooltip says which). The states are coloured labels (🔊 HEARD, HOLD, ● signal, SKIP n min, LOCKED OUT). The columns are as wide as their content.
  - Page **ACTIVITY**: what was heard – time, VFO, frequency, name, mode, length, max. level, SNR, note (carrier lockout); **▶** plays the recording, a double click
    tunes the frequency, **CSV** saves the rows shown. Page **HEATMAP**: seconds of activity per hour of the day (local time) for the 60 busiest frequencies; a click tunes.
  - In **ACTIVITY** a row at the frequency of a memory (within 500 Hz) shows the name of the memory when it has none and the note of the memory in Note.
  - **SHOW** (both pages): **THIS SCAN** (default) = only what the scan of this VFO heard since it was started on this source. A START of **another source, group or
    range** (also another visible band) begins a new scan, so both pages start empty; a STOP and START of the same source continues it. **CLR** empties them by hand.
    Nothing is deleted from the disk: **TODAY / 7 DAYS / 31 DAYS / ALL KEPT** show the history of all VFOs (`data\logs\scan_YYYY-MM-DD.csv`), kept KEEP HISTORY days.
  - How it scans: every block (~85 ms) the power of **all channels in the band of the dongle** is measured from the spectrum, so they are checked at once;
    the tuner moves only to the next window (~¾ of the sample rate). Of overlapping neighbours only the strongest opens. Only frequency, mode and width of a
    memory are used (its decoder and recording are ignored). In the spectrum the range scanned is a blue strip and locked out channels are grey ✕ marks.
  - While a VFO scans, its baseband decoders (FT8, WEFAX, CW, RTTY, PACKET, SSTV, ACARS) pause; DAB, VDL2, ISM, HFDL and AIS must be off.

- **VIEW** (far left of the key row): hides the whole lower part with the tabs (SPECTRUM, DECODERS …) with a slide and shows it again; lit while hidden. A key that opens a tab (DECODE, MEM, SCAN …) shows it again. Remembered in the browser.
- **MENU → BAND**: shows or hides the row of band keys; the spectrum and waterfall take the freed space. Remembered in the browser.

**AD (additional display)**: the part of the glass under the clock shows one thing at a time, by priority:

1. **Error messages** (red), e.g. a refused setting, TX, a recording error, DAB on a dongle that cannot do it. A message stays until it is
   accepted by the small framed **OK**; the frame of the window blinks red (period 0.5 s) meanwhile. More waiting messages show *+n*, the next one comes after OK.
   (Errors used to show for 5 s under the logo.)
2. **Rotor AZ / EL** while **MONITOR** is on (SETTINGS › GENERAL › ROTOR), with the requested direction while the rotor is on its way (or LINK OFF, NOT CONNECTED, FAULT).
3. **DAB now on air** while a DAB station plays: the DAB / DAB+ tag, the station name, the SNR of the ensemble (green from 12 dB, yellow from 8 dB, red below)
   and the DLS text (artist / song) under them; a text wider than the window runs to its end and back (the whole text is in the tooltip).
4. **RDS** (station name, RadioText, PI, PTY, TP/TA); empty without RDS.

The clock (top right) switches between local time and UTC with a click; the date under it is of the same zone. Small bars under the S-meter show the CPU load and
memory use of the PC running RADIMCOM (amber over 70 %, red over 90 %). A click on the RADIMCOM logo opens the project on GitHub. When a newer version is released, the logo turns red; hovering shows the new version and a click opens its release page in a new tab.
The page is laid out for at least 1920 × 820 px and scaled to the browser window, so the layout does not reflow in small windows.

## Memory editor

The memory editor was written by **Brano ([brjanicek](https://github.com/brjanicek))**. It is the pages **CHANNELS**, **GROUPS**, **IMPORT** and
**EXPORT** of the MEMORIES tab. Changes are saved at once (except the IMPORT and EXPORT lists).

- **CHANNELS**: every memory in a table: star, name, frequency, mode, bandwidth, decoder, record, groups, tag and note. Show one group
  or `(no group)`, search name, note, group or kHz, and click a **column header** to sort by it (again = the other way round;
  by **Groups** the table has a section per group, a channel in two groups is listed under both, with the note of the
  group). The columns have fixed widths; a text that does not fit is cut and shown whole as the tooltip. **⧉ duplicates** shows only the channels on the same
  frequency (within 50 Hz) and mode as another one; ⧉ marks them in the list too.
  A click on a row selects it (Ctrl+click adds or removes more rows), a double click recalls the channel, and ✎ at the start of the row opens it in the form on the right (✎ is hidden while more rows are selected; while the form is open the tick boxes are hidden and a click on a row opens that channel in the form; with unsaved changes in the form it asks first). **★ only** shows only the starred channels;
  **＋ SAVE CURRENT** fills a new channel with the tuned frequency, mode and width (and DAB channel), **＋ NEW** an empty one. The form shows the basics: the **name**, the **mode** (AM, FM, WFM, LSB,
  USB, CW, DAB, DSD), the **frequency** – or for the mode **DAB** a dropdown of the **DAB channels** in its place (the
  frequency is the centre of the channel) – and the **groups**. **ADVANCED** shows the other settings under them (the
  basics stay where they are; shown or hidden is remembered in the browser): bandwidth (fixed for DAB and DSD), **decoder** (switched on when the channel is recalled, and its page shown in DECODERS: FT8, WEFAX, CW, RTTY,
  SSTV, PACKET, ACARS, VDL2 or ISM), **record** (a recording to MP3 started when the channel is recalled: **ON** = REC,
  everything; **SQ** = REC SQ, only while the squelch is open; **ASQ** = REC SQ with the auto squelch switched on, AM, FM
  and WFM; **OFF** = none, the default; a recording or ASQ that recalling a channel started stops when the VFO leaves
  the channel (another frequency, mode or channel); one switched on by hand, or a key pressed by hand meanwhile, stays), DAB channel (mode **DAB**: the frequency is
  the centre of the channel; **DAB** and **DSD** have a fixed width), the **groups** (a list, one per line, scrolls when long: tick any number, or type a new one and press Enter),
  a **note**, the **tag in the spectrum** (shown or hidden, default shown) with its **colour** (↺ = the default green) and
  the star, and the **location** of the station on the channel: **LAT** / **LON** in decimal degrees (north and east
  positive, both or neither, empty = none; **CHOOSE ON MAP** opens an OpenStreetMap map in place of the table: a click
  fills LAT / LON, the note shows the azimuth and distance from the station (red dot), SAVE keeps it; the table shows LAT, LON and the **AZ**imuth and **Dist**ance from the
  station location of SETTINGS › GENERAL › LOCATION, empty while that is not set). It warns when another channel is on the same frequency and mode. **＋ NEW** fills it from the tuner.
  Select or tick channels for the bar above the table (with none selected, it acts on the channel open in the form): pick a group in the list (or **＋ new group…** and type its name) and add them to it (**＋ TO GROUP**, they stay in their other groups),
  remove them from it (the group list and both keys are off with no channel selected and while the form is open: the groups of that channel are set in the form), star or unstar them, show or hide their tags, set or reset their
  colour (**SET** / **DEFAULT**), put them on the export list (**⇩ TO EXPORT**) or delete them.
- **GROUPS**: every group with the number of its channels and its **note** (saved when you leave the field). **＋ ADD GROUP**
  adds an empty group. Per group, as icons: **☰** shows its channels in CHANNELS, **✎** renames it, **⎘** copies it (a new group with copies of its
  channels, which can then be changed without touching the original) and **🗑** deletes it (asks whether the channels that are in no
  other group are deleted too, or kept without a group). Tick groups to **MERGE** them into one (asks for its name; the
  notes are joined), to delete them or to put their channels on the export list.
- **IMPORT**: **LOAD FILE…** reads one or more files and recognises their format by the content: a RADIMCOM export
  (JSON, also the older lists of 0.111 and 0.112, or CSV), SDR# `frequencies.xml`, the SDR++ frequency manager
  (`frequency_manager_config.json`, each list becomes a group), gqrx `bookmarks.csv` (tags become groups, the colour of
  the first tag the tag colour) or a CHIRP CSV (name, frequency, mode and comment as the note). Files without groups put
  their channels into a group named after the file (SDR++ / gqrx / CHIRP); the message says which format was found. The channels go to a list first,
  nothing is saved yet: edit any field there, see which are new, which are already in the memories (⧉ with the name) and which
  have an error (red, not selected). All valid channels are selected; **NEW ONLY** selects those not in the memories,
  **SET GROUP** puts the selected ones into one group. **IMPORT SELECTED** saves them; the others stay in the list, so you can
  edit and import them later. Groups of a JSON file are shown with their notes, which are imported with the channels.
- **EXPORT**: put channels on the list: a whole group (**＋ GROUP**), the starred ones, all, or ticked channels and groups from the
  other pages. Changes in the list only go into the file. Untick a channel to leave it out, and choose per channel (or for
  all in the header) whether its tag **colour**, its **tag** shown / hidden, its **note** and its location (**LAT/LON**) are exported. The groups of the
  list are shown above it with their notes, each with a tick whether its note is exported. **JSON** keeps everything,
  **CSV** (`;`, UTF-8, opens in Excel) has the columns `name;frequency_hz;mode;bandwidth_hz;groups;decoder;record;dab_channel;favourite;note;color;show_tag`
  (groups separated by `|`) and is read back by IMPORT; group notes go only into JSON.

The memories are in `data\memories.json`, the groups with their notes and empty groups in `data\memory_groups.json`.
Each memory keeps its first group in the old `group` field, so older versions still read the file; before the first change
the file of the older version is copied to `memories.json.bak`.
