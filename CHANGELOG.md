# Changelog

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
