[← Documentation](../README.md)

# AIS: ships

AIS (Automatic Identification System, ITU-R M.1371) is the VHF data link of ships: position reports every 2–10 s under
way (class A) or every 30 s (class B), static and voyage data (name, call sign, type, destination, size, draught, ETA)
every 6 minutes, plus base stations, aids to navigation (buoys, lights) and SAR aircraft. RADIMCOM decodes it itself
(`ais.py`, numpy only, no external program) from the raw samples of the VFO.

## Frequencies

| Channel | Frequency | |
|---|---|---|
| AIS 1 (87B, **A**) | **161.975 MHz** | GMSK 9600 Bd, NRZI, HDLC |
| AIS 2 (88B, **B**) | **162.025 MHz** | the same; a ship alternates between the two |

The **162.000** button centres the VFO between the two channels (FM), so **both are decoded at once**; the sample rate
stays. Any VFO centre works as long as a channel lies inside the received band at least 15 kHz from its edge and
5 kHz from the centre (the DC spike of the dongle): tuned to 161.975 MHz itself only AIS 2 is decoded.

Range is line of sight: 20–40 km from the sea, a river or a lake with a vertical antenna outdoors; inland there is
nothing to hear away from navigable water. A ship under way sends a position report every 2–10 s, a moored ship every
3 min, a base station every 10 s.

## Use

- DECODERS tab → **AIS** page → **ON**, or the **162.000** button: it centres and tunes the VFO on 162.000 MHz in FM
  and turns AIS on (VDL2, DAB, ISM, HFDL and ACARS off).
- **The audio of the VFO is muted** while AIS runs (like HFDL / ACARS / VDL2): the decoder takes the raw samples.
  After the VFO moves, the channels are set up again once it has stayed put for a second.
- The line above the table lists the channels listened to with the peak signal level of the last block of samples
  (dBFS): a burst of a nearby ship reaches −10 to −30 dB, noise alone is around −50 dB and below.
- **Table** (MESSAGES): UTC, channel (A / B), signal, country (flag, from the MMSI), MMSI (a click opens MarineTraffic),
  name (a click opens VesselFinder), call sign, ship type, message type (BASE, AtoN, SAR and STATIC coloured; the
  NMEA `!AIVDM` sentence in its tooltip), navigational status, position (link to OpenStreetMap), SOG, COG, true heading,
  destination and details (IMO, size, draught, ETA, rate of turn, safety text). Name, call sign, type and destination
  come in a message of their own (type 5 / 24, every 6 min), so a ship is shown first by its MMSI only; once known they
  are shown in <span style="color:#6cb8ff">blue</span> in the position reports too (from the earlier message).
  **SHOW** selects All / With position / Static data / Base stations / Other; the filter field searches all columns.
- A click on a message marks it and holds the list still (**SCROLL PAUSED**); the mouse wheel over the messages
  resumes it. **INFO** shows or hides the description of the decoder (remembered in the browser).
- **Views:** **MESSAGES** (the table), **SHIPS** (one row per station: last message, country, MMSI, name, call sign,
  type, status, newest position with its age — a click opens it on the MAP, SOG, COG, HDG, destination, ETA, size and
  draught, number of messages) and **MAP**: OpenStreetMap (darkened, needs internet) with every station that sent a
  position: a ship under way as a yellow arrow turned to its heading (COG when the heading is unknown), a stopped ship
  (moored, at anchor, SOG below 0.3 kt) as a circle, ▲ base station (blue), ◆ aid to navigation (green), SAR aircraft
  (orange); label = name (or MMSI) and speed; a white trail through the reported positions; the selected station and its
  trail red, a station without a message for 30 min grey; your QTH (MENU › SETUP › LOCATION) as a red dot (the map opens there). The list beside the
  map selects a station (centred, popup with all its data and MarineTraffic / VesselFinder links). The □ key in the top
  right corner of the map opens the map with its list alone in a new browser tab (live; no audio there).
- **CLR** clears the list, the stations and the counters; **LOG** writes `data\logs\ais_YYYY-MM-DD.txt`
  (UTC, one line per message: frequency, level, channel, MMSI, name, message type, position, speed, course, details and
  the NMEA sentence).
- **MMSI structure:** the first three digits (MID) give the country; `00` + MID = coast station, `99` + MID = aid to
  navigation, `98` + MID = craft of a mother ship, `111` + MID = SAR aircraft, `970` = AIS-SART, `972` = man overboard,
  `974` = EPIRB. The kind is shown in the tooltip of the MMSI and instead of a missing name.

## How it works

Each channel is taken out of the raw band by a complex band-pass filter with polyphase decimation to about 48 kHz
(5 samples per bit), the residual carrier removed, FM demodulated, the DC (tuning error) removed with a 20 ms window,
low-pass filtered and sampled by the bit clock of the packet decoder (a PLL on the zero crossings). The HDLC deframer of
the packet decoder (NRZI, bit stuffing, CRC-16/X.25) gives the frames; the bits of each byte are reversed (AIS sends
the message MSB first) and the message is decoded: types 1–3 and 18 / 19 / 27 (positions), 4 / 11 (base stations),
5 / 24 (static data), 9 (SAR aircraft), 12 / 14 (safety text), 21 (aids to navigation); the others show their type.
Messages with a wrong CRC are only counted (*bad CRC*). Works with RTL-SDR, LimeSDR and Airspy; not on a chained VFO.

HTTP API: `ais`, `ais_center` in `POST /api/set`; `GET /api/ais` (state, `messages`, `ships`), `POST /api/ais`
`{"action": "clear"}`; event `ais` (a message with `ship`, the newest data of its station) and `aisstate`.
