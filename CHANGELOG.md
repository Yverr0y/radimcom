# Changelog

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
