# RADIMCOM

[![Release](https://img.shields.io/github/v/release/om2amr/RADIMCOM)](https://github.com/om2amr/RADIMCOM/releases)
[![License: MIT](https://img.shields.io/github/license/om2amr/RADIMCOM)](LICENSE)
![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6)

A Windows receiver for RTL-SDR, LimeSDR Mini and Airspy R2, controlled from a web browser: up to four SDRs as four VFOs,
with a transceiver-style screen (S-meter, 7-segment displays, spectrum, waterfall, function keys) and built-in decoders.

![RADIMCOM main screen: four VFOs, function keys, band buttons, spectrum and waterfall](docs/images/main.png)

What each part of the screen does: [annotated main screen](docs/images/main_annotated.png).

## Quick start

1. Download `RADIMCOM_install_v<version>.zip` from [Releases](https://github.com/om2amr/RADIMCOM/releases) and unzip it.
2. Run **`install.bat`**: it installs the Python packages, offers the USB drivers and runs the SDR setup.
3. Run **`start.bat`**.
4. Open **http://localhost:8434** in the browser.

The DSD mode (digital voice) needs one extra step: run **`install_dsd.bat`** once, see [DSD](docs/decoders/dsd.md).
Details, drivers and running from the git sources: [Installation](docs/installation.md).

## Supported hardware

| | RTL-SDR | RTL-SDR Blog V4 | LimeSDR Mini \* | Airspy R2 |
|---|---|---|---|---|
| Receive range | 24–1766 MHz | 0.5–1766 MHz (from 0.113) | 1–3500 MHz | 24–1750 MHz |
| Receiver bandwidth (sample rate) in RADIMCOM | up to 2.4 MS/s | up to 2.4 MS/s | up to 2.4 MS/s | 2.5 MS/s (fixed) |
| HF through an upconverter | yes | built-in upconverter, used by its driver below 28.8 MHz | yes | yes |
| Transmit | – | – | yes (optional, off by default) | – |
| All audio modes and FT8, WEFAX, CW, RTTY, SSTV, PACKET, ACARS | yes | yes | yes | yes |
| VDL2, DAB / DAB+, ISM | yes | yes | – | – |
| Driver | WinUSB (Zadig) | WinUSB (Zadig) | FTDI D3XX | WinUSB |

\* Tested with LimeSDR Mini v1.x.

Up to four SDRs at once, each assigned to a VFO by its serial number; one dongle can also serve several VFOs
([VFO chaining](docs/configuration.md#vfo-chaining-one-dongle-for-several-vfos)).

## Features

### Receiver

- **Up to four SDRs as four VFOs (A–D)**, or one dongle shared by several VFOs (chaining). → [Configuration](docs/configuration.md)
- **Modes** AM, FM, WFM (stereo + RDS), LSB, USB, CW, DAB and DSD, with notch, ALC, audio LPF / HPF and AFI (voice inversion). → [Function keys](docs/controls.md#function-keys)
- **Squelch with ASQ (auto squelch)**: the level follows the measured noise floor plus a margin; **CTCSS / DCS tone squelch** (TSQ-C / TSQ-D) in FM. → [AUDIO keys](docs/controls.md#function-keys)
- **AGC+**: tuner gain set from the A/D level, as high as possible without clipping. → [GAIN keys](docs/controls.md#function-keys)
- **ATU (autotune, experimental)**: a click on an AM signal moves the tuning onto its carrier, on an SSB signal it puts the signal edge on the red line. → [TUNE keys](docs/controls.md#function-keys)
- **Shortwave (HF)** through an upconverter, always showing the real frequency. → [HF upconverter](docs/hf-upconverter.md)
- **Digital-mode decoders:** FT8, WEFAX, CW, RTTY, SSTV and PACKET (AX.25 1200 / 9600 Bd, APRS with map). → [DECODE](docs/controls.md#function-keys)
- **Aircraft data link:** ACARS and VDL2 with CPDLC and ADS-C decoded to plain text and a map of the aircraft, and **HFDL** on HF (2.9–22 MHz, all channels of a band at once). → [Aircraft](docs/decoders/aircraft.md) · [HFDL](docs/decoders/hfdl.md)
- **AIS** ships on 161.975 / 162.025 MHz (own decoder, both channels at once) with a map of ships, base stations and aids to navigation. → [AIS](docs/decoders/ais.md)
- **ADS-B** aircraft on 1090 MHz (own Mode S / ADS-B decoder) with a list, a map with tracks and the raw messages. → [ADS-B](docs/decoders/adsb.md)
- **DAB / DAB+ radio**, **digital voice** (DMR, P25, D-Star, YSF, …; test version) and **ISM** 433 / 868 MHz devices. → [DAB](docs/decoders/dab.md) · [DSD](docs/decoders/dsd.md) · [ISM](docs/decoders/ism.md)
- **Satellite tracking:** passes, world map, Doppler correction and a K3NG rotor, no other program needed. → [Satellites](docs/satellites.md)
- **Rotor control map:** click a place or a memory channel with a location (LAT / LON) and the rotor turns there; channels shown by their MEMORIES groups; beam sector on the map turns with the antenna; page CONNECTION disconnects the SAT tracker, memory recall or the map from the rotor. → [Rotor control](docs/satellites.md#rotor-control-map)
- **Scanner** (SCAN tab): memories, a frequency range or the FM broadcast band (FM BCAST, centred on each station) (all 2280 airband 8.33 kHz channels in ~4 s per pass at 1.536 MS/s), all channels in the band of the dongle checked at once from the spectrum; own squelch / ASQ / priority per channel, SKIP, LOCKOUT, carrier lockout, activity log with WAV recordings, search & store, occupancy heatmap. → [SCAN](docs/controls.md#scan)
- **MP3 recording** (REC / REC SQ) with a RECORDINGS tab to play the files in the browser, daily decoder logs, **HTTP API**, optional **TX with LimeSDR**. → [Configuration](docs/configuration.md)

### User interface

- **Transceiver-style screen** in brushed black anodized aluminium (other skins: black or light aluminium, mahogany, RAL paint): S-meter, recessed displays, 3D keys; every VFO is one dark display window with all its state, side by side, each waterfall keeps running. → [Controls](docs/controls.md)
- **Spectrum and waterfall** with 1×–32× zoom and a waterfall speed bar; tune by click, drag, mouse wheel or the wheel over a digit. → [Tuning](docs/controls.md#tuning)
- **Band plan on the frequency axis**, audio spectrum bubble, seven S-meter layouts. → [Tuning](docs/controls.md#tuning)
- **Memories** with favourites, spectrum tags and a memory editor (groups with notes, decoder and recording at recall, import from SDR# / JSON / CSV, export). → [MEM](docs/controls.md#function-keys), [Memory editor](docs/controls.md#memory-editor)
- **CUE**: hear other VFOs while one is selected, with MAIN / CUE faders and a level meter. → [Function keys](docs/controls.md#function-keys)
- **DECODERS**, **SATELLITES**, **MEMORIES** (memory list and memory editor) and **SETTINGS** tabs; SETTINGS has a **GENERAL** page (skins, S-meter, touchpad, location, the one rotor of the station) and a **VFO** page (VFO-A … D keys joined to the settings of that VFO). → [Controls](docs/controls.md)

The complete feature list: [docs/features.md](docs/features.md).

## Screenshots

| | |
|---|---|
| ![WFM broadcast with stereo and RDS](docs/images/fm_with_rds.png) | ![DAB+ card with station list, slideshow and DLS text](docs/images/dab_decoder.png) |
| WFM with stereo and RDS | DAB+ |
| ![Satellite map with footprints and a ground track](docs/images/sat_map.png) | ![VDL2 card with ATN CPDLC and ACARS messages](docs/images/decoders_vdl2.png) |
| Satellite map | VDL2 / CPDLC |

## Security

> [!WARNING]
> **Trusted network only, never expose RADIMCOM to the internet.** It has no login, and by default it listens on all
> network interfaces. See [SECURITY.md](SECURITY.md), which also explains how to report a vulnerability.

Transmitting (LimeSDR) is off by default and legal only with a valid licence, see [Transmitting](docs/configuration.md#transmitting-limesdr).

## Documentation

- [Installation and running](docs/installation.md)
- [Features](docs/features.md)
- [Shortwave (HF) with an upconverter](docs/hf-upconverter.md)
- [Controls](docs/controls.md)
- [Configuration](docs/configuration.md): `vfos.json`, chaining, setup, TX, EEPROM, SDR# import, HTTP API
- Decoders: [Aircraft data link](docs/decoders/aircraft.md) · [DAB / DAB+](docs/decoders/dab.md) · [DSD](docs/decoders/dsd.md) · [ISM](docs/decoders/ism.md)
- [Satellite tracking](docs/satellites.md)
- [Development](docs/development.md): block diagram, files, `data\` folder, backup and upgrade
- [HTTP API](API/API.md) · [Change log](CHANGELOG.md)

## Contributing and support

- **Bugs and feature requests:** [issues](https://github.com/om2amr/RADIMCOM/issues/new/choose)
- **Questions and help with setup:** [Discussions](https://github.com/om2amr/RADIMCOM/discussions)
- **Contributing code:** [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md)
- **Contributors:** Brano ([brjanicek](https://github.com/brjanicek)) – the memory editor (0.113)

## License

RADIMCOM is released under the [MIT License](LICENSE): provided "AS IS", without any warranty, and the author
accepts no liability. [NOTICE.md](NOTICE.md) has the radio transmission notice and lists the third-party components,
which keep their own licences, and where to get their source code.
