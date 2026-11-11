[← README](../../README.md) · [Documentation](../README.md)

# Aircraft data link: ACARS, VDL2, CPDLC, ADS-C

Airliners exchange data with the ground over two VHF links, and RADIMCOM receives both:

| | **ACARS** (classic) | **VDL2** (VDL Mode 2) |
|---|---|---|
| Frequencies (Europe) | 131.525, 131.725, 131.825, 136.900 MHz | 136.700–136.975 MHz in 25 kHz steps, plus 136.675 MHz until the end of 2026 (US channels: see below) |
| Signal | AM, MSK 2400 bit/s | digital D8PSK, 31.5 kbit/s |
| Carries | ACARS messages, FANS-1/A CPDLC and ADS-C inside them | the same, plus European **ATN CPDLC** (exists only on VDL2) |
| Traffic | older aircraft, long-haul ADS-C, backup | most airline traffic over Europe today |

- The **ACARS** and **VDL2** pages of the DECODERS tab (DECODE key) show the same card. Only one link at a time: the dongle is either at 131.x
  or at 136.x MHz. Turning one on turns the other off. While either runs, the audio of the VFO is muted and its display
  shows a red struck-through speaker above AFI and MHz (the ISM decoder too).
- A new message appears only when its row is complete: ADS-B data first, then the flag. Without an answer it appears after
  about 15 s (3 s more at most for the flag), and late ADS-B data is still filled in. The rows stay in the order of reception.
- A click on a message holds the list still (**SCROLL PAUSED** in the header; new messages keep coming in above it); the mouse wheel over the
  messages resumes it.
- **ACARS:** the buttons in the card tune the ACARS channels (AM; 131.725 MHz is the busiest).
- **VDL2:** the VFO switches to 2.1 MS/s around 136.500 MHz and all channels of the selected region are decoded at once (the
  136.500 button re-centres it). **EU** or **US** in the card chooses the channels: EU is 136.700–136.975 MHz in 25 kHz steps
  (today's channels and those planned from January 2027) plus 136.675 MHz until the end of 2026, when it becomes a guard
  channel; US is 136.100, 136.300, 136.650, 136.800 and 136.975 MHz. Spectrum and waterfall keep working. Decoding is done by
  [dumpvdl2](https://github.com/szpajder/dumpvdl2) (`lib\vdl2\dumpvdl2.exe`), which runs as a separate program;
  `vdl2.py` feeds it the raw samples and reads the decoded messages. Turning VDL2 off restores the sample rate.
  VDL2 works with RTL-SDR dongles only; it is not supported on LimeSDR or Airspy.
- Every message shows its type tag, time, frequency, country flag (from the aircraft's ICAO address), flight, callsign
  (registration; click for the live map), ICAO address, squawk, aircraft type, model, flight level and ground speed (from ADS-B,
  in blue), label, description and text. A row with an emergency squawk (7500, 7600, 7700) gets a red frame. On VDL2 the **Ground Station** column shows the airport of the ground station (from `VDL2_Ground_Stations.txt` by its address, the tooltip has the details) and the pull-down at the top filters by it. The **tag** in the first column says what it is (click a tag at the top to filter):

  | Tag | Meaning |
  |---|---|
  | **ACARS** (slate) | plain ACARS message (airline, maintenance, weather…) |
  | **CPDLC** (green) | controller-pilot message: ↑ from ATC (amber text), ↓ from the aircraft (green); FANS-1/A in ACARS, or the European ATN CPDLC over VDL2 (Description column says "ATN CPDLC") |
  | **ADS-C** (violet) | automatic position report to air traffic control (FANS in ACARS, or ATN ADS-C over VDL2) |

- **MESSAGES / AIRCRAFT / MAP** keys at the top of the card switch between the message table, the list of aircraft heard
  (the newest data of each: ADS-B data, newest position with its source and age – a click shows it on the map –, VDL2 ground
  station of the last message, number of messages) and a map (dark OpenStreetMap) of the
  aircraft with a known position: turned to their heading, with their track, flight + type as a label, and a list beside the
  map (a click centres the aircraft and opens its details with adsb.fi / adsb.lol links). Positions come from ADS-B (looked
  up at the time of the message), from ADS-C reports (FANS and ATN) and, on VDL2, from the XID frames, where an aircraft
  sends its approximate location when it sets up or hands off the link (also aircraft that send no ACARS). VDL2 ground
  stations that broadcast their position are green ▲. The □ key in the top right corner opens the map alone in a new tab.

  ![VDL2 card: European ATN CPDLC (WILCO, LOGICAL ACKNOWLEDGEMENT with MIN/MRN) between plain ACARS messages with aircraft type and position from ADS-B](../images/decoders_vdl2.png)

- **CPDLC** (FANS-1/A, ARINC 622): the standard wording with the values filled in ("CLIMB TO AND MAINTAIN FL350",
  "AT VANDA CONTACT CHRISTCHURCH CONTROL 128.100 MHz"), the ground station (e.g. `MSTEC7X` = Maastricht UAC),
  **MIN** (message number) and **MRN** (number of the message it answers, so a clearance pairs with its WILCO).
  Position reports are listed field by field. The ARINC 622 CRC is checked (✗ = CRC error); long messages split
  over several blocks are joined. Connect / disconnect requests (CR1 / CC1 / DR1) are shown too.
- **ADS-C** (`adsc.py`, ARINC 745): position, altitude, time and accuracy, track, ground speed and vertical rate,
  heading and Mach, wind and temperature, predicted route, projected intent, flight ID, the ground's contract
  requests (interval, events) and the aircraft's ACK / NACK.
- **ATN CPDLC** in a compact form: header (MIN, MRN, time, "ack required") and one line per message element,
  e.g. `dM6 REQUEST FL360`, `dM106 PREFERRED LEVEL FL350`, `dM0 WILCO`, plus connect / abort / release.
  ATN messages identify the aircraft only by its 24-bit ICAO address; the registration, type, position and
  callsign are looked up on ADS-B by that address (the address stays under the registration).
- **LOG** writes one daily log per decoder (UTC): everything from classic ACARS to `data\acars\acars_YYYY-MM-DD.txt`,
  everything from VDL2 (ACARS, CPDLC, ADS-C, ATN) to `data\acars\vdl2_YYYY-MM-DD.txt`. Decoded CPDLC / ADS-C follows the raw text.

**What to expect:** on 131.725 MHz mostly long-haul aircraft (ADS-C reports every few minutes); on VDL2 many
messages per minute from all airlines and, near busy airspace, European CPDLC (requests, WILCO, logical
acknowledgements). Ground stations are often too far to hear, so many conversations are one-sided (↓ only).

**Command-line test** (no radio needed; `u` = uplink, `d` = downlink, then the ACARS label and the message text):

```bash
python cpdlc.py u AA "/AKLCDYA.AT1.9V-SVG21D0755D84AD067448398722949A7521C8AB4A1C8EAB5CE393"
python cpdlc.py d B6 "/SKYSWSQ.ADS.9V-SWJ072230905353079195AF1D0E2720EDC000100A987E521814"
```

```
CPDLC message  ground AKLCDYA  aircraft 9V-SVG  CRC OK
MIN 3  MRN None  20:07:21Z
uM118: AT VANDA CONTACT CHRISTCHURCH CONTROL 128.100 MHz

ADS-C report  ground SKYSWSQ  aircraft 9V-SWJ  CRC OK
BASIC: Basic report: 48.0793N 14.6468E · 31000 FT · 23:23:07.8Z · accuracy <0.25 NM
EARTH: track 110.0° TRUE · GS 475.5 KT · vertical rate +0 FT/MIN
METEO: wind 137° TRUE / 10.5 KT · temperature -53.75 °C
```

The FANS-1/A message set and its wording (RTCA DO-258) are in `cpdlc_schema.py`, generated from
[libacars](https://github.com/szpajder/libacars) (MIT licence). dumpvdl2 and libacars for VDL2 are built
with MSYS2; licences, sources and build steps are in `installer\VDL2.txt` (`lib\vdl2\README.txt` in the package).
