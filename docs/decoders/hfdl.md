[← Documentation](../README.md)

# HFDL: aircraft data link on HF

HFDL (High Frequency Data Link, ARINC 635) carries ACARS of aircraft over oceans, polar routes and remote areas,
where VHF (ACARS, VDL2) does not reach. RADIMCOM decodes it with [dumphfdl](https://github.com/szpajder/dumphfdl),
which runs as a separate program (`lib\hfdl\dumphfdl.exe`); `hfdl.py` feeds it the raw samples of the VFO and
reads the decoded messages.

## Frequencies

**2.9–22 MHz.** 16 ground stations around the world (San Francisco, Molokai, Reykjavik, Riverhead, Auckland,
Hat Yai, Shannon, Johannesburg, Barrow, Muan, Albrook, Santa Cruz, Krasnoyarsk, Al Muharraq, Agana, Canarias),
each on 6–19 channels. From Europe the strongest are usually **Shannon** (2998, 3455, 5547, 6532, 8843, 8942,
10081, 11384 kHz), **Reykjavik** (3900–17985 kHz), **Canarias** and **Al Muharraq**. The complete list is in the
card (*HFDL ground stations and frequencies*) and in `lib\hfdl\systable.conf`.

| Band (button) | Channels (kHz) |
|---|---|
| 2.9 | 2941–3900 (2941–3016, 3455, 3497, 3900) |
| 4.7 | 4654–4687 |
| 5.5 | 5451–5720 |
| 6.5 | 6529–6712 |
| 8.8 | 8825–8977 (busiest) |
| 10 | 10027–10093 |
| 11 | 11184–11387 |
| 13 | 13264–13351 |
| 15 | 15025 |
| 18 | 17901–17985 |
| 22 | 21928–21997 |

Best by day on 8–22 MHz, at night on 3–11 MHz (like the HF ham bands).

## Use

- DECODERS tab → **HFDL** page → **ON**, or a **band button**: it centres and tunes the VFO on the middle of that band.
- **The audio of the VFO is muted** while HFDL runs (like ACARS / VDL2): the decoder takes the raw samples of the whole
  band, not the audio. The sample rate stays as it is. All HFDL channels within ±(sample rate / 2)
  of the VFO centre are decoded at once, so 2.4 MS/s covers a whole band, often two (8.8 + 10 MHz, 10 + 11 MHz).
  After the VFO moves, dumphfdl restarts with the new channel list once the VFO has stayed put for 1.5 s.
- The line above the table lists the channels listened to (inside the received band, nothing heard from them yet
  necessarily); **Heard** lists the ground stations actually received (with
  their channels); in the station table, channels in the received band are underlined (listened to, not necessarily
  heard), channels and stations actually received are green with ✓.
- Each ground station sends a **squitter** every 32 s on each active channel: they are counted, they fill the
  *Heard* list, but they are not in the table.
- Table: UTC, channel, signal (dBFS, bit rate 300–1800 bit/s), ↑ uplink from the ground / ↓ downlink from the
  aircraft, ground station, flight, registration, ICAO address, message type (ACARS, Performance data with
  position, Logon request / confirm, Frequency data…), ACARS label, position (link to the map) and text.
  **SHOW** selects All / ACARS / With position / Logon; the filter field searches all columns.
- **ADS-B data** (like the ACARS card): every aircraft is looked up on adsb.fi (adsb.lol as a fallback) by its ICAO
  address, or by the registration from ACARS (needs internet, at most one request per second, the same aircraft
  again after a minute). Shown in blue: country (from the ICAO address), squawk (7500 / 7600 / 7700 = red frame),
  aircraft type, model, flight level and ground speed; a missing ICAO address or registration is filled in from
  ADS-B. **A click on the flight** opens adsb.lol, **on the registration or ICAO** globe.adsb.fi, in a new tab.
  Over the oceans aircraft are often out of ADS-B coverage: "not seen on ADS-B now" (the HFDL position, if sent,
  still has its own map link).
- **To ground station** column: the station the message is addressed to (↓ downlink) or sent by (↑ uplink), taken from
  the HFDL frame header by its ID; the name comes from the system table.
- Long messages show 3 lines with **▾ more** (a click shows all). A click on a message marks it and holds the list
  still (**SCROLL PAUSED**); the mouse wheel over the messages resumes it (like ACARS / VDL2).
- **INFO** (after the band buttons) shows or hides the description of the decoder; hidden by default, so the
  table or the map has the room. Remembered in the browser.
- **Views:** **MESSAGES** (the table), **AIRCRAFT** (one row per aircraft: last message, country, flight, registration,
  ICAO, type, model, FL, speed, squawk, position and where it comes from with its age — the newest position sent over HFDL; the ADS-B one only when the aircraft sent none, ground
  station, number of messages; a click on the position opens it on the MAP) and **MAP**: a map (the OpenStreetMap tiles of the
  PACKET map, darkened; needs internet) with every aircraft that has a position, turned to its heading (ADS-B track, or from its
  last two positions; pointing north while the heading is not known yet), in yellow, labelled with flight and type, with a white trail through the positions it sent over HFDL;
  the selected aircraft and its trail are red, an aircraft without a message for an hour grey; ▲ HFDL ground stations (green = heard) and your QTH (MENU › SETUP › LOCATION). The list beside the map
  selects an aircraft (red, centred, popup with details and adsb.fi / adsb.lol links). The □ key in the top right corner of the
  map opens the map with its list alone in a new browser tab (live; no audio there).
- **LOG** writes `data\logs\hfdl_YYYY-MM-DD.txt` (UTC, one line per message, no squitters).

## Hardware

HFDL needs HF: an **RTL-SDR Blog V4** (from 0.5 MHz), an RTL-SDR with an [upconverter](../hf-upconverter.md),
a LimeSDR or an Airspy with an upconverter. It works with the raw samples of all of them (CU8 / CF32).
It does not run on a chained VFO (its centre is decided by the owner VFO). A good HF antenna matters more
than anything else; HFDL signals are often weak.

## Build

dumphfdl 1.7.0 and its libraries (liquid-dsp, FFTW, libconfig, libacars) are built with MSYS2 by
`installer\build_hfdl.sh`; licences, sources and build steps are in `installer\HFDL.txt`
(`lib\hfdl\README.txt` in the package). Without `lib\hfdl\dumphfdl.exe` the card says it is missing.
