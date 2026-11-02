# RADIMCOM

A receiver for RTL-SDR dongles and LimeSDR Mini controlled from a web browser: HF through an upconverter, VHF/UHF directly.
The screen looks like a transceiver: S-meter, 7-segment displays, spectrum, waterfall and function keys.
Up to four SDRs work as four VFOs (A, B, C, D), switched with a single button.

## Features

- **Up to four VFOs, A–D.** Each VFO has its own SDR (RTL-SDR or LimeSDR Mini, selected by serial number)
  and its own settings. All frequencies are shown side by side: the active VFO is lit, inactive ones are grey
  but show the actual tuned frequency. The waterfall of every VFO keeps running, so its history is visible
  right after switching. With fewer than four SDRs the remaining VFO windows stay in place, greyed out ("NO SDR").
- **RF GAIN and SQUELCH sliders** under each VFO display.
- **Modes:** AM, FM, WFM, LSB, USB and CW with selectable filter width.
- **WFM stereo** (19 kHz pilot, **ST** flag) and **RDS**: station name (PS), RadioText, PI, PTY, TP/TA and clock (CT).
- **Squelch** for AM, FM and WFM, each mode with its own level. It decides every ~8 ms, so it does not cut off
  the start of a transmission (airband). The level is marked on the S-meter with a yellow tick.
- **Spectrum and waterfall** with 1×–32× zoom.
- **Decoders:** FT8, WEFAX (radio fax with automatic format detection), CW (Morse with AFC and speed estimation), RTTY (Baudot, automatic shift 90–1000 Hz, speed 45.45/50/75/100 Bd and polarity), SSTV (colour images, 14 modes, VIS) and ACARS (aircraft data messages on 131.725 MHz and others, AM, MSK 2400 bit/s, CRC check; aircraft type and position from adsb.fi / adsb.lol).
- **Daily logs:** the LOG checkbox in each decoder card writes to `data\logs\<decoder>_YYYY-MM-DD.txt` (UTC, one line per message; WEFAX/SSTV log the names of saved images), ACARS to `data\acars\acars_YYYY-MM-DD.txt`.
- **Frequency memories** (MEM) with favourites and import from SDR# (`frequencies.xml`).
- **Upconverter:** HF is tuned via the LO (e.g. 100 MHz). For a VFO with a manual converter switch, crossing
  30 MHz shows a warning whether the converter must be switched on (CONV) or set to BYPASS.
- **Audio** starts automatically when the page opens and comes from the active VFO.
- **CUE:** keep listening to other VFOs at a separate CUE level while one VFO is selected;
  MAIN and CUE volume faders, stereo level meter, MUTE.
- **REC:** records the audio of the selected VFO to a WAV file.
- **TX with LimeSDR** (optional, off by default), see below.

## Requirements

- Windows, Python 3 and the packages `flask`, `numpy`, `scipy` and `PyFT8` (needed only for FT8):

  ```bash
  pip install flask numpy scipy PyFT8
  ```

- RTL-SDR dongles with the WinUSB driver (e.g. via Zadig). `librtlsdr.dll` and `libusb-1.0.dll` are in the `lib` folder.
- LimeSDR Mini with the FTDI D3XX driver; `LimeSuite.dll` in the `lib` folder.
- For FT8 the PC clock must be accurate (±1 s).

## Running

```bash
python app.py
```

On Windows just double-click `start.bat`. Then open **http://localhost:8434** in the browser.

- If `data\vfos.json` exists, the **VFO launcher** (`launcher.py`) starts. It opens a separate receiver on its
  own port for each VFO and serves the page itself on port 8434. Closing the launcher also closes the receivers.
- Without `vfos.json` a single receiver runs with the settings from `data\config.json`.
- Only one such server can run at a time, because the dongles are shared.
- If the browser does not allow sound without a click, *"click anywhere to start audio"* blinks next to the MUTE button.
  Sound starts after the first click or key press on the page.

## Controls

### Tuning

| Action | How |
|---|---|
| Switch VFO | **VFO-A … VFO-D** button or click on a grey display |
| Enter a frequency | click on the active VFO display, type e.g. `7100` (kHz) or `145.5` (MHz), Enter (Esc cancels) |
| Step by 1 / 10 steps | `‹ ›` / `« »` buttons under the display, ← → arrow keys |
| Tune to a point | click in the spectrum or waterfall |
| Move the band | drag with the mouse in the waterfall |
| Fine tuning | mouse wheel over the spectrum or waterfall (one step) |
| Band | buttons in the groups HF HAM, HF BROADCAST, VHF/UHF HAM, FM BROADCAST, OTHER |

If a band or memory is outside the range of the active VFO, the receiver switches by itself to a VFO that can
receive it (e.g. an HF band to the VFO with the converter).

### Frequency display

- Below 30 MHz in **kHz**: `7.016.500` kHz, the first dot separates thousands, the second is the decimal point.
- From 30 MHz in **MHz**: `439.475.000` MHz.
- The last three (smaller) digits are Hz.

### Function keys

- **MODE**: demodulation. **FILTER**: bandwidth for the current mode.
- **STEP**: tuning step. **ZOOM**: spectrum and waterfall span.
- **DECODE**: turns on the FT8, WEFAX, CW, RTTY, SSTV or ACARS decoder. The panels are in the
  **DECODERS** tab next to SPECTRUM; turning a decoder on opens it, a green dot signals a new message/image:
  - FT8: band selection and CLR.
  - WEFAX: stations (DWD Pinneberg 3855/7880/13882.5 kHz, Northwood GYA 2618.5/4610/8040/11086.5 kHz), LPM/IOC, NEW and PNG (images are saved to `data\wefax\`).
  - CW: TUNE tunes to the detected tone, CLR clears the text.
  - SSTV: frequencies (80m–10m, ISS FM), mode selection (Auto by VIS), STOP, PNG and a gallery of recent
    images (saved to `data\sstv\`). Modes Martin M1/M2, Scottie S1/S2/DX, Robot 36/72, PD 50–290;
    AFC and slant correction are automatic. Filter at least 2.7 kHz.
- **AUDIO**: STEREO (WFM) and NOTCH: automatic notch for AM/LSB/USB, finds and removes steady
  tones (whistles, carriers) by ~40 dB and leaves speech. It also feeds the SSTV decoder, so turn it off for SSTV.
  Volume is on the slider at the top right; the speaker icon below it is MUTE.
- **SET**: settings of the active VFO.
  - Squelch for the current mode.
  - Gain (manual or automatic).
  - Upconverter LO and converter mode (off / on / auto).
  - ppm correction.
  - Bias-tee 4.5 V. Turn it on only when the antenna or preamplifier really needs it.
  - RESET DONGLE.
- **MEM**: frequency memories. ＋ SAVE CURRENT stores the frequency, mode and width; ★ marks a favourite.

### Flags next to the S-meter

| Flag | Meaning |
|---|---|
| RX | receiver is running |
| mode, width | current demodulation and filter |
| SQL | squelch is on; lit when open |
| ST | WFM: stereo pilot received |
| ALC | AM/SSB/CW: automatic audio level (grey = off) |
| CONV / BYPASS | required position of the manual upconverter switch |

When squelch is on for an inactive VFO and it opens, that VFO's button lights up green.

## Configuration

### `vfos.json`: assigning dongles to VFOs

```json
{
  "port": 8434,
  "vfos": [
    { "name": "A", "serial": "SDR00001", "port": 8441, "config": "config_A.json",
      "note": "HF via upconverter",
      "init": { "upconv": "auto", "lo_offset_hz": 100000000, "ppm": 0 } },
    { "name": "B", "serial": "SDR00002", "port": 8442, "config": "config_B.json", "init": { "ppm": 0 } },
    { "name": "C", "driver": "lime", "serial": "1D3C...", "port": 8443, "config": "config_C.json",
      "note": "LimeSDR, VHF/UHF direct" }
  ]
}
```

- `serial` is the dongle's serial number in EEPROM (for a LimeSDR its serial number, `driver: "lime"`).
- `port` is the port of that VFO's receiver. The page talks to it directly.
- `config` is the VFO settings file. On first start it is created from `config.json` plus the values from `init`.
  After that each VFO remembers its own tuning, mode, filters, squelch, gain and ppm.

### Initial setup: `setup_sdr.py`

```bash
python setup_sdr.py
```

The wizard (`setup.bat` on Windows) finds the connected RTL-SDRs and LimeSDRs and assigns them to VFO A, B, C, D:
the device for a VFO is chosen by number or by unplugging it for a moment (the wizard detects which one is
missing). Then it asks about the upconverter and ppm and writes `vfos.json`. If the dongles share the same serial
number (commonly `00000001`), it offers to write a unique number to the EEPROM. Old `vfos.json` and `config_X.json`
are moved to `data\config_backup\`. The receiver must be stopped during setup.

ppm correction can also be set later in the SET menu of each VFO.

### Transmitting (LimeSDR)

For a VFO with a LimeSDR, SET has an **Enable TX** switch (off by default). When enabled, PTT is
holding the space bar: in FM a test message from `data\tx_audio\test_message.wav` is sent (if it exists), otherwise a carrier.
Transmitting works only without the upconverter.

### Dongle serial numbers: `eeprom_tool.py`

```bash
python eeprom_tool.py
```

Lists the connected dongles and backs up their EEPROM to `data\eeprom_backup\`.

```bash
python eeprom_tool.py write INDEX SERIAL
```

Writes a new serial number. It must have the same length as the original. After writing, unplug and replug the dongle.

```bash
python eeprom_tool.py restore INDEX FILE
```

Restores the EEPROM from a backup.

### Importing memories from SDR#

```bash
python memories.py C:\sdrsharpSW\frequencies.xml
```

## Files

| File | Contents |
|---|---|
| `app.py` | receiver server (Flask): API, events (SSE) and audio |
| `launcher.py` | VFO A–D launcher |
| `sdr.py` | RTL-SDR via librtlsdr (ctypes) and DSP: tuning, filters, demodulation, squelch, waterfall |
| `rds.py` | RDS decoder |
| `ft8.py`, `wefax.py`, `cw.py`, `rtty.py`, `sstv.py`, `acars.py` | decoders |
| `daylog.py` | daily decoder logs |
| `memories.py` | memories and import from SDR# |
| `eeprom_tool.py` | reading, backing up and writing dongle EEPROM |
| `setup_sdr.py` | initial dongle setup wizard (`vfos.json`) |
| `lime.py` | LimeSDR via LimeSuite.dll (receive and transmit) |
| `static/` | web interface (`index.html`, `style.css`, `app.js`) |
| `paths.py` | data paths (`data\`), migration of data from older versions |
| `installer/` | building the installer package (`make_installer.py`) and the files it contains; the package is created in `dist\` |

The data of this PC is in `data\` (not in git and not in the installer package):

| File / folder | Contents |
|---|---|
| `config.json` | settings for single-receiver mode and template for new VFOs |
| `vfos.json`, `config_A/B/C/D.json` | dongle assignment and settings of each VFO |
| `memories.json` | saved memories |
| `logs\`, `acars\`, `wefax\`, `sstv\` | daily logs and saved images |
| `config_backup\`, `eeprom_backup\` | backups of settings and EEPROM |

Older installations kept these files in the main folder; they are moved to `data\` automatically at first start.
