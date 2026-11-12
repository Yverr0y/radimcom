[← README](../README.md)

# RADIMCOM documentation

| Page | Contents |
|---|---|
| [Installation and running](installation.md) | requirements, drivers (Zadig, D3XX), running from the sources, third-party DLLs |
| [Features](features.md) | the complete feature list |
| [Shortwave (HF) with an upconverter](hf-upconverter.md) | LO of common upconverters, CONV / BYPASS, setup |
| [Controls](controls.md) | tuning, VFO window, frequency display, function keys, SETTINGS, MEM |
| [Configuration](configuration.md) | `vfos.json`, VFO chaining, `setup_sdr.py`, TX with LimeSDR, `eeprom_tool.py`, import from SDR#, HTTP API |
| [Satellite tracking](satellites.md) | passes, map, Doppler correction, K3NG rotor, rotor control map (RCTRL) |
| [Development](development.md) | block diagram, files, the `data\` folder, backup and upgrade |

Decoders:

| Page | Contents |
|---|---|
| [Aircraft data link](decoders/aircraft.md) | ACARS, VDL2, CPDLC, ADS-C |
| [HFDL](decoders/hfdl.md) | aircraft data link on HF (2.9–22 MHz) via dumphfdl |
| [AIS](decoders/ais.md) | ships on 161.975 / 162.025 MHz, own GMSK decoder, map |
| [ADS-B](decoders/adsb.md) | aircraft on 1090 MHz, own Mode S / ADS-B decoder, map |
| [DAB / DAB+](decoders/dab.md) | digital broadcast radio via welle-cli |
| [DSD](decoders/dsd.md) | digital voice (DMR, P25, D-Star, YSF, NXDN, …) via DSD-FME |
| [ISM](decoders/ism.md) | 433 / 868 MHz devices via rtl_433 |
| FT8, WEFAX, CW, RTTY, SSTV, PACKET | described under [Function keys → DECODE](controls.md#function-keys) |

HTTP API: [API/API.md](../API/API.md).
