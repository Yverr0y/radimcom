[← README](../README.md) · [Documentation](README.md)

# Controls

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

Each VFO window shows a status flag (USB icon = SDR running, WAIT / OPENING / CAL while starting,
OFFLINE on error or disconnection; hover for details), the mode, a **CUE** flag (click to toggle CUE for
that VFO without switching), the frequency display and the **RF GAIN** and **SQUELCH** sliders with their values
(squelch only in AM/FM/WFM). The sliders work on inactive VFOs too, without switching.

## Frequency display

- Below 30 MHz in **kHz**: `7.016.500` kHz, the first dot separates thousands, the second is the decimal point.
- From 30 MHz in **MHz**: `439.475.000` MHz.
- The last three (smaller) digits are Hz.
- **AFI** above the unit is lit while the audio is inverted. A red struck-through speaker above it shows that a decoder (ACARS, VDL2 or ISM) has muted the audio of this VFO.

## Function keys

- **MODE**: demodulation. **FILTER**: bandwidth for the current mode.
- **GAIN**: AGC switches automatic tuner gain on/off (manual gain with the RF GAIN slider or in SET). **AGC+** sets the tuner gain from the level of the A/D converter: as high as possible without clipping it (the tuner AGC of the R820T watches only its LNA and mixer, not the A/D). The gain flag under the display shows `+` and the gain; the AGC+ key gets a red underline while the A/D clips. With the squelch set, AGC+ makes it work as auto squelch (ASQ lights up), because a fixed level would not fit the changing gain; the slider then only turns it on / off, and ASQ pressed in this state turns the squelch off.
- **TUNE**: **ATU** (autotune) in USB, LSB and AM. With ATU on, a click on a signal in the spectrum or waterfall tunes to the clicked point (without the step grid), listens for a moment and moves the tuning onto the carrier; the key blinks while listening and the passband label shows the shift (e.g. *ATU +130 Hz*) or *no signal*. Tuning by the wheel, the arrow keys, dragging or the VFO display digits starts it too, 0.7 s after the tuning rests, when it moved by more than 250 Hz. AM: the carrier is found within a few Hz in under 1 s. SSB: the suppressed carrier is found from the voice, usually within ±10–20 Hz after 2–3 s of speech (up to 6.5 s); a very steady voice can end one pitch step (~100–200 Hz) off, then click again. Tuning elsewhere while listening cancels it.
- **STEP**: tuning step (10 Hz – 10 kHz). **Zoom** (1×–32×) is the bar in the top right corner of the frequency scale: − / +, a click on a cell, or the mouse wheel over it.
- **DECODE**: turns on the FT8, WEFAX, CW, RTTY, SSTV, PACKET, ACARS, VDL2, DAB or ISM decoder. The panels are in the
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
    STATIONS (APRS stations with the distance and bearing from the station set in SATELLITES › SETUP) and MAP
    (OpenStreetMap); the filter field narrows both. Frames with a wrong checksum are only counted.
    Graph on the right: SPECTRUM of the signal around the tuned frequency (averaged, MAX hold; S/N, 99 % bandwidth,
    live 9600 Bd AFC as a green line) or EYE, the eye diagram in real time (9600 / 1200 Bd), with the eye opening now
    and in the last good frame, and at 9600 Bd the deviation and the live AFC.
  - ACARS (classic link, AM 2400 bit/s): channel buttons 131.525 / 131.725 / 131.825 / 136.900 MHz, CLR;
    click the registration or flight to open the ADS-B map. Plain ACARS, FANS-1/A CPDLC and ADS-C are shown
    with coloured tags.

    ![ACARS card on 131.725 MHz: ADS-C position reports with route, track and speed, and plain ACARS messages, aircraft type and position from ADS-B](images/decoders_acars_legacy.png)

  - ISM: see [ISM decoder](decoders/ism.md).
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
  - SP: remove spurs from local sources. Learn them and set the band-stop in SET, DONGLE tab.
  - ASQ: auto squelch in AM/FM/WFM. The squelch level follows the noise in the channel plus a margin (6 dB by default, SET, AUDIO tab, 2–30 dB).
    The noise is measured in the spectrum of the dongle band (the quietest 10 % of its points, converted to the channel bandwidth), so a signal in
    the channel, even a long one, does not raise the level and close it; in a crowded band (e.g. FM broadcast) the quietest channel power over the
    last 15 s is used when it is lower. The measurement starts again after a change of frequency, mode, bandwidth or gain. The SQUELCH slider
    shows AUTO and the level in use; the yellow mark on the S-meter follows it.
  - ALC: automatic audio level in AM/LSB/USB/CW; off = fixed gain.
  - CUE: keep hearing this VFO (at the CUE level) when another VFO is selected.
- **SAT**: the satellite key switches to the SATELLITES tab and back, see [Satellite tracking](satellites.md).
- **Volume** (top right): vertical MAIN (active VFO) and CUE faders, stereo L/R level meter. Below them the speaker button
  is MUTE (green = sound on, red = muted). Under it are two recording keys for the active VFO, which work independently of each other and go on with the page closed:
  - **REC** records everything until switched off, also the silence of a closed squelch. After 15 minutes it continues in a new file.
  - **REC SQ** records only while there is audio (open squelch), each session in its own file. A session ends when the squelch stays closed for 1 s; that silence is not saved, and a burst shorter than 0.3 s is dropped. In modes without a squelch, or with the squelch off, one session runs until the key is switched off, with no length limit.

  Files go to `data\recordings` as MP3, 128 kbps, named by the frequency and mode at the start of the file and its start time: `145.500000MHz_FM_20261105_155300.mp3`. If that frequency is in the memories, the name of the memory comes first, with `_` instead of spaces: `Piestany_TWR_118.575000MHz_AM_20261105_155300.mp3`. Retuning during a recording does not start a new file; a change of the sample rate does. A key shows the time of the current file while writing, and it is lit without a time while waiting for audio. A red dot in the corner of the VFO display shows the same for each VFO: blinking while writing, steady while waiting for audio. Like the audio of the VFO, recording pauses while ACARS, VDL2 or ISM runs, and DAB is not recorded.
- **MENU → SET**: settings of the active VFO, in a floating window with tabs. The open tab is remembered in the browser.
  SET and MEM move by their title bar and remember their place in the browser, and the radio stays usable behind them. ✕, their key or Esc closes them.
  - **DONGLE**
    - Without `vfos.json` (single receiver) the dongle selection and the upconverter mode (auto / on / off).
    - Upconverter LO and ppm correction.
    - Tuner gain (manual or automatic), RTL2832 digital AGC (RTL-SDR only).
    - Bias-tee 4.5 V (if the SDR has it). Turn it on only when the upconverter or preamplifier really needs it.
    - RESET DONGLE.
    - **Remove DC peak** (on by default): removes the peak of the dongle in the centre of the band, from the waterfall and from the received signal. **Width** (up to 1000 Hz) also
      takes out its wide skirts, which LimeSDR needs, but weakens signals that close to the centre. **Suppression** (0–60 dB) sets how deep the removal goes.
    - **Remove spurs**: for a switching power supply and the like. **LEARN** finds lines at a regular spacing of 12 kHz or more in the band received now, so learn on a quiet band.
      Each line gets a band-stop set by **Width**, **Edge**, **Shift** and **Depth**, which takes it down to the noise around it. Cleans the waterfall and the channel you listen to (not WFM and wide FM).
      A signal on a spur is removed with it.
  - **AUDIO**
    - Squelch for the current mode, and the ASQ margin above the noise (2–30 dB).
    - LPF and HPF frequency, AFI inversion frequency.
  - **DISPLAY**
    - Display width (sample rate).
    - S-meter calibration (S9 level) and layout (needle, bar graph, LED bar, VFD display, amber needle, 7-segment, peak bar), waterfall colour range / offset.
    - Touchpad wheel speed (1–10, default 4; left = slower), remembered in the browser for all VFOs. A mouse wheel notch is always one step.
  - **ROTOR**: antenna rotor, see [Satellite tracking](satellites.md).
  - **TX** (LimeSDR only): Enable TX, see [Transmitting (LimeSDR)](configuration.md#transmitting-limesdr).
- **MENU → MEM**: the list of frequency memories to recall them: a click tunes the memory (frequency, mode, width;
  a DAB memory turns DAB on with its channel, and the decoder of a memory is switched on). Search the name, group or kHz,
  show one group, sort by frequency, name or group, or only the starred ones (★). ☆ on a row stars the memory, ✎ opens it in the editor. The memory the VFO is tuned to is highlighted, and the list scrolls to it (the order stays) when the window opens and when the VFO moves to another memory. ⧉ marks a memory on the same frequency
  and mode as another one. **＋ SAVE CURRENT** opens the [memory editor](#memory-editor) with the tuned frequency, mode and
  width (and DAB channel) filled in, **＋ NEW** with an empty channel, **✎ EDITOR** the editor itself: adding, editing,
  deleting, groups, import and export are all there.
  Memories in the visible part of the spectrum show their name on a tag at the top of the spectrum (green, or the colour
  chosen in the editor; a red ● before the name = recalling it starts a recording); click a tag to recall the memory.

- **MENU → BAND**: shows or hides the row of band keys; the spectrum and waterfall take the freed space. Remembered in the browser.

The clock (top right) switches between local time and UTC with a click. Small bars under the S-meter show the CPU load and
memory use of the PC running RADIMCOM (amber over 70 %, red over 90 %). A click on the RADIMCOM logo opens the project on GitHub. When a newer version is released, the logo turns red; hovering shows the new version and a click opens its release page in a new tab.
The page is laid out for at least 1920 × 820 px and scaled to the browser window, so the layout does not reflow in small windows.

## Flags next to the S-meter

| Flag | Meaning |
|---|---|
| RX / TX | receiving; TX (red) while transmitting with the LimeSDR |
| mode, width | current demodulation and filter |
| SQL | squelch is on (shown only then); lit when open |
| ST | WFM only: lit when the stereo pilot is received |
| ALC | AM/SSB/CW: automatic audio level (grey = off) |
| CONV / BYPASS | required position of the manual upconverter switch (VFOs with upconverter mode auto) |

When squelch is on for an inactive VFO and it opens, that VFO's button lights up green.

## Memory editor

MEM → **✎ EDITOR** opens a big floating window with four tabs. Changes are saved at once (except the IMPORT and EXPORT lists).

- **CHANNELS**: every memory in a table: star, name, frequency, mode, bandwidth, decoder, record, groups, tag and note. Show one group
  or `(no group)`, search name, note, group or kHz, and sort by **group** (a channel in two groups is listed under both, with
  the note of the group), **frequency**, **name**, **mode** or **decoder**. **⧉ duplicates** shows only the channels on the same
  frequency (within 50 Hz) and mode as another one; ⧉ marks them in the list too.
  A click on a row opens it in the form on the right; a double click recalls it. The form edits the name, frequency, mode,
  bandwidth, **decoder** (switched on when the channel is recalled, and its page shown in DECODERS: FT8, WEFAX, CW, RTTY,
  SSTV, PACKET, ACARS, VDL2 or ISM), **record** (a recording to MP3 started when the channel is recalled: **ON** = REC,
  everything; **SQ** = REC SQ, only while the squelch is open; **ASQ** = REC SQ with the auto squelch switched on, AM, FM
  and WFM; **OFF** = none, the default; a recording or ASQ that recalling a channel started is stopped by recalling a
  channel without it, one switched on by hand stays), DAB channel, the **groups** (tick any number, or type a new one and press Enter),
  a **note**, the **tag in the spectrum** (shown or hidden, default shown) with its **colour** (↺ = the default green) and
  the star. It warns when another channel is on the same frequency and mode. **＋ NEW** fills it from the tuner.
  Tick channels for the bar above the table: add them to a group (**＋ TO GROUP**, they stay in their other groups),
  remove them from it, **MOVE** them to one group only, star or unstar them, show or hide their tags, set or reset their
  colour (**SET** / **DEFAULT**), put them on the export list (**⇩ TO EXPORT**) or delete them.
- **GROUPS**: every group with the number of its channels and its **note** (saved when you leave the field). **＋ ADD GROUP**
  adds an empty group. Per group, as icons: **☰** shows its channels in CHANNELS, **✎** renames it, **⎘** copies it (a new group with copies of its
  channels, which can then be changed without touching the original) and **🗑** deletes it (asks whether the channels that are in no
  other group are deleted too, or kept without a group). Tick groups to **MERGE** them into one (asks for its name; the
  notes are joined), to delete them or to put their channels on the export list.
- **IMPORT**: **LOAD SDR#** reads the SDR# folder (`frequencies.xml` there and in profile subfolders), **LOAD FILE…** a RADIMCOM
  export (JSON, also the older lists of 0.111 and 0.112), a CSV file or a `frequencies.xml`. The channels go to a list first,
  nothing is saved yet: edit any field there, see which are new, which are already in the memories (⧉ with the name) and which
  have an error (red, not selected). All valid channels are selected; **NEW ONLY** selects those not in the memories,
  **SET GROUP** puts the selected ones into one group. **IMPORT SELECTED** saves them; the others stay in the list, so you can
  edit and import them later. Groups of a JSON file are shown with their notes, which are imported with the channels.
- **EXPORT**: put channels on the list: a whole group (**＋ GROUP**), the starred ones, all, or ticked channels and groups from the
  other tabs. Changes in the list only go into the file. Untick a channel to leave it out, and choose per channel (or for
  all in the header) whether its tag **colour**, its **tag** shown / hidden and its **note** are exported. The groups of the
  list are shown above it with their notes, each with a tick whether its note is exported. **JSON** keeps everything,
  **CSV** (`;`, UTF-8, opens in Excel) has the columns `name;frequency_hz;mode;bandwidth_hz;groups;decoder;record;dab_channel;favourite;note;color;show_tag`
  (groups separated by `|`) and is read back by IMPORT; group notes go only into JSON.

The memories are in `data\memories.json`, the groups with their notes and empty groups in `data\memory_groups.json`.
Each memory keeps its first group in the old `group` field, so older versions still read the file; before the first change
the file of the older version is copied to `memories.json.bak`.
