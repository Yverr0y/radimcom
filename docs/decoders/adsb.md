[← Documentation](../README.md)

# ADS-B: aircraft on 1090 MHz

Aircraft transponders answer the secondary radars (Mode S) and most of them also broadcast their own identity, position,
altitude and speed twice a second or more (ADS-B, "extended squitter"), all on **1090 MHz**. RADIMCOM decodes it itself
(`adsb.py`, numpy only, no external program) from the raw samples of the VFO.

## Turning it on

- **DECODERS › ADS-B › ON** (or the **1090.000** key): the VFO goes to 1090.000 MHz at **2.4 MS/s** (an Airspy stays at
  its 2.5 MS/s), the audio of the VFO is muted.
- ACARS, VDL2, DAB, ISM, HFDL and AIS need the dongle elsewhere: ADS-B turns them off, and each of them turns ADS-B off.
- **OFF** gives the previous sample rate back.
- Not on a chained VFO (one that shares the dongle of another VFO).
- Antenna: anything resonant at 1090 MHz (a 6.9 cm quarter-wave whip over a ground plane, a collinear) outdoors with a clear
  horizon. Range is line of sight: 100–300 km for airliners at cruise level; a short whip indoors hears the nearest aircraft only.
  A 1090 MHz filter / LNA in front of the dongle helps much near strong FM, GSM or DVB-T transmitters.

## What is decoded

| DF | Message | Gives |
|---|---|---|
| 17 | ADS-B (transponder) | flight / call sign and emitter category; airborne position (barometric or GNSS altitude) and surface position; ground speed and track or airspeed and heading, vertical rate; squawk and emergency; selected altitude and QNH (target state); operational status |
| 18 | ADS-B of non-transponder devices, TIS-B / ADS-R (relayed by the ground) | the same; TIS-B / ADS-R aircraft are marked **T** |
| 11 | All-call reply | the address of an aircraft (an unknown address must come twice within 30 s) |
| 0, 4, 16, 20 | Altitude replies | barometric altitude, on the ground |
| 5, 21 | Identity replies | squawk |

DF0 / 4 / 5 / 16 / 20 / 21 carry no address of their own: their CRC is overlaid with it. They are accepted only when that
address belongs to an aircraft heard within the last minute (in DF11 or DF17).

### How

1. The magnitude of every sample (a table lookup for the bytes of an RTL dongle) is integrated: the energy of any half
   microsecond is then the difference of two values, read at fractional sample positions. So the decoder works at any
   sample rate from 2 MS/s, best at 2.4 MS/s or more.
2. Preambles (0.5 µs pulses at 0, 1, 3.5 and 4.5 µs, quiet between them) are looked for at every sample of the block at
   once; the best one within a microsecond is kept.
3. Each preamble is sliced at 5 sub-sample phases into 112 bits: a bit is 1 when its first half has more energy than
   the second.
4. The CRC (24 bits, polynomial 0xFFF409) of all candidates is computed at once: it is linear, so it is the XOR of the
   syndromes of the bits that are 1 (a table of 112 values).
5. A DF17 / DF18 with a wrong CRC: if the syndrome is that of a single bit, that bit is flipped; otherwise up to 3 of the
   5 least certain bits (where both halves had nearly the same energy) are tried. Corrected messages are accepted only
   for an aircraft already heard and counted as **fixed**.
6. Positions (CPR, Compact Position Reporting): the first one from an even and an odd message less than 10 s apart
   (global decoding), the next ones from a single message and the last position (local decoding). A position that would
   mean more than about 1500 kt since the last one, or a first one over 700 km from the station, is thrown away.
   Surface positions need a reference: the station location or the last position.

## The card

- Header: ON, **1090.000**, INFO (this description in short), the counters (aircraft, with a position, messages, messages
  per second, fixed, dropped blocks), the views, a filter, **LOG** and **CLR**.
- **AIRCRAFT**: country flag (from the ICAO address block), ICAO address (→ globe.adsb.fi), flight (→ adsb.lol), squawk
  (7500 / 7600 / 7700 and an emergency in red, the row too, and first in the list), altitude in feet (**G** = GNSS height,
  ▲▼ climbing / descending, "ground"), vertical speed, ground speed (or IAS / TAS), track (or heading), position and its
  age (a click shows it on the MAP), **distance and azimuth from the station location** (SETTINGS › GENERAL › LOCATION),
  emitter category, signal of the last message (dBFS), number of messages and the time since the last one. An aircraft not
  heard for a minute is grey; after 10 minutes it is removed.
- **MAP**: dark OpenStreetMap, the aircraft turned to their track (yellow; ground = dark yellow; emergency = magenta;
  selected = red; grey after a minute) with flight and altitude, their decoded positions as a white trail, the QTH with
  rings at 50, 100, 200 and 300 km, and the list beside it (a click centres the aircraft and opens its details). The
  □ key opens the map alone in a new browser tab (`?map=adsb`).
- **MESSAGES**: the last 300 decoded messages: UTC, signal, ICAO, DF, kind, the decoded data and the hex of the message
  (corrected bits included). A click on a row holds the list still (SCROLL PAUSED); the mouse wheel resumes it.
- **LOG**: `data\logs\adsb_YYYY-MM-DD.txt` (UTC), one line per aircraft at most once a minute: ICAO, flight, squawk,
  altitude, speed, track, vertical rate, position with distance and azimuth, category, signal and number of messages.

## HTTP API

`GET /api/adsb` (state, last messages, aircraft with their trails), `POST /api/adsb {"action": "clear"}`,
`POST /api/set {"adsb": true|false}`; events `adsb` (once a second) and `adsbstate`. See [API](../../API/API.md).
