[← README](../README.md) · [Documentation](README.md)

# Satellite tracking

RADIMCOM predicts the passes, shows them on a timeline and a world map, keeps the VFO on the downlink (Doppler correction, receive
only) and moves a K3NG antenna rotor, all in the **SATELLITES** tab, with no other program. The **SAT** key switches to this tab and back. Positions are calculated with
SGP4 (Python package `sgp4`). The station, the satellites and the downloaded data are shared by all VFOs; the Doppler correction
and the rotor work on one VFO each and go on with the page closed.

## Pages of the SATELLITES tab

| Page | What it does |
|---|---|
| **PASSES** | Timeline of the passes of the chosen satellites over the next 12, 24 or 48 hours, and a list of them. A click on a pass shows its track on a polar plot, the elevation over time, the nearest distance, the Doppler shift at 145.9 and 435 MHz, the position now while it is on, and the transmitters of the satellite. |
| **MAP** | World map (Natural Earth, works offline) with the satellites switched on by the keys above it (up to 20): each with its footprint (yellow while it is above our horizon), the night side and the station. A click on a key or a dot chooses the satellite whose ground track is drawn (half an orbit behind, one ahead); beside the map are its position, altitude, azimuth and elevation from here, distance, Doppler shift, the next pass and its transmitters, and **TRACK** opens it on the TRACK page. Moves every second. |
| **TRACK** | Doppler correction and the rotor for one satellite of the timeline, below. |
| **SETUP** | The station location (shown here; it is set in **SETTINGS › GENERAL › LOCATION**: locator or latitude and longitude, CHOOSE ON MAP, altitude; **LOCATION…** opens it), the lowest highest-elevation of a pass shown, and the satellites on the timeline, chosen in tabs by CelesTrak group: Amateur Radio, Weather, CubeSats, Space & Earth Science, Galileo, GLONASS operational, GPS operational, Iridium NEXT (and Chosen). **SELECT ACTIVE** ticks the satellites of the AMSAT lists LINEAR, FM, IMAGE and MISC (matched by name; it lists those not in the orbital elements), **CLEAR** unticks all. |
| **LINEAR**, **FM**, **IMAGE**, **MISC** | Lists of active satellites from [AMSAT](https://www.amsat.org/), kept for 12 hours in `data\satellites.json`. |

![PASSES page: timeline of five satellites over 12 hours with bars shaded by the highest elevation, the list of passes, and the details of an FO-29 pass with its polar plot, AOS, LOS, nearest distance and Doppler shift](images/sat_passes.png)

![MAP page: world map with the footprints of six satellites, the night side and the station, the ground track of FO-29, and beside it its position, distance, Doppler shift, next pass and transmitters](images/sat_map.png)

![SETUP page: station by locator JN88WQ, latitude and longitude, orbital elements from CelesTrak, and the satellites on the timeline with SELECT ACTIVE, CLEAR and the CelesTrak group tabs](images/sat_setup.png)

![LINEAR page: the AMSAT list of active linear satellites with uplink and downlink frequencies and comments](images/sat_info.png)

Downloaded data (internet needed only for the download; the last copy is used offline):

| File in `data\` | Source | Downloaded |
|---|---|---|
| `sat_tle.txt`, `sat_groups.json` | orbital elements of the 8 CelesTrak groups above | once a day; elements older than 7 days are marked, older than 14 need a confirmation for tracking |
| `sat_transmitters.json` | [SatNOGS DB](https://db.satnogs.org/): downlinks, modes, transponders | once a week |
| `sat_setup.json` | the lowest elevation of a pass and the choice of satellites | saved by SETUP |
| `location.json` | the station location (locator, latitude, longitude, altitude) | saved by SETTINGS › GENERAL › LOCATION |

## Doppler correction (TRACK)

![TRACK page with FO-29: the Doppler correction on its linear transponder (VFO tuned to 435.855 MHz, +5.4 kHz), the transmitters from SatNOGS DB, and the rotor waiting for the pass with an overlap plan, TRACK and STOP and the polar plot of the pass](images/sat_track.png)

A click on a transmitter of the list tunes the VFO to its downlink (the middle of a transponder), sets its mode (FM, USB, CW...) and keeps
the VFO corrected as the satellite comes and goes; **OFF** stops it. The received frequency is the sent one × (1 − range rate / c),
calculated every 0.25 s, half a second ahead; the VFO is retuned when it is off by more than 20 Hz (SSB, CW), 500 Hz (AM) or 1 kHz (FM),
at most once a second. The page shows the frequency the satellite sends, the one the VFO is tuned to and the exact one now. Tuning
the VFO by hand moves the frequency within the transponder and the correction keeps it; tuning more than 50 kHz outside the
transponder stops it. The name frame of the VFO shows the satellite and transponder in blue while the correction is on.

## Rotor

1. In **SETTINGS → GENERAL → ROTOR** press **ON** (one rotor for the whole station, whichever VFO is active; settings in `data\rotor.json`) and choose the serial port of the K3NG controller (GS-232 commands, 9600 baud). The page also has the position on a polar plot and an elevation column (a click moves the antenna there), **STOP**, **RESET**, **MONITOR** (AZ / EL in the additional display under the S-meter) and the azimuth calibration.
2. On the **TRACK** page, the **Rotor** part: **TRACK** follows the passes of the chosen satellite and moves the rotor (it turns the rotor link on), a second press ends it and stops the rotor. Beside it **STOP** stops both motors and ends the tracking. The flag beside *Rotor*: **TRACKING** (the rotor follows), **CALC ONLY** (the tracking runs but the rotor does not move: the link failed, a fault, STOP in SET; TRACK off and on moves it again) or **NOT TRACKING**. The **TRACK** key on the MAP page and in the pass details of PASSES opens that satellite here (one not on the timeline is added to it).
3. The polar plot shows the antenna as a red cross, the elevation chart (0 to 180 degrees on this page) its real elevation, over 90 when it looks back. A click on the polar plot turns the antenna there, a click on the elevation chart sets only the elevation.

Each pass is planned ahead from 1 s samples. K3NG takes the shorter way for every command and would unwind about 360° in the middle
of a pass across the north, so every way of following the pass is simulated with the measured speeds of the rotor (azimuth 5.5°/s,
elevation 2.3°/s) and the one with the smallest pointing error is used:

| Mode | Antenna | When |
|---|---|---|
| normal | azimuth K3NG 0–360°, elevation 0–90° | the track does not cross the north |
| overlap | azimuth through the north past 360° (K3NG up to 450°) | a track across the north that fits into 0–450° |
| flipped | azimuth + 180°, elevation 180° − el: the antenna looks back over the top | a track across the north that does not fit |
| over the top | azimuth stands, elevation 0 → 180° | passes near the zenith |

On a tie (2° or less) the order of the table decides. The plan gives K3NG its own 0–450 azimuth, so the side of the overlap is decided
by the plan; where K3NG would take the other side, the rotor goes through a point 90° before the target first. TRACK turns the rotor
to the start of the next pass in time (the move plus 30 s), follows the pass 2 s ahead and after LOS waits for the next one; the
rotor stays where it is between the passes. While TRACK moves the rotor, the clicks on the plots (here and in SETTINGS → ROTOR) are refused.

**Rotor safety:** position readings can be noisy and K3NG does not acknowledge commands, so RADIMCOM checks the position itself. A reading that jumps faster
than the rotor can move, or a move without progress, stops the rotor and needs **RESET** in SETTINGS → ROTOR. A lost serial connection and STOP also stop it. After these the tracking only calculates (flag CALC ONLY) until TRACK is pressed off and on again.
K3NG ends any move after its operation timeout (60 s here), so an unchanged target is sent again every 30 s.

**Azimuth calibration:** K3NG counts 0–450 degrees from the left stop of the rotor, which need not be exactly north. In **SETTINGS → ROTOR**, enter the true azimuth of the antenna at K3NG 0 and at K3NG 450 (measure it, for example, with the antenna parallel to the walls of a house whose orientation is known from a map; 0 and 450 = no correction). The position, the tracking and the clicks on the plots then use true azimuths. K3NG reports its azimuth only modulo 360, so RADIMCOM follows the whole 0–450 position itself and saves it; for the clicks on the plots it picks the command that ends nearest the wanted direction. A direction just beyond a stop is reached as near as the rotor can get, without a fault.

## Rotor control map

The **RCTRL** key (key group **TRACKING**, beside SAT) shows the **ROTOR CONTROL** tab. It turns the station rotor
(**SETTINGS › GENERAL › ROTOR**, one for all VFOs: the map works from any VFO) to fixed places on the ground, for example a
broadcast transmitter or a repeater, taken from the channels of **MEMORIES** that have a location.

- **MAP:** a dark OpenStreetMap map centred on the station (**SETTINGS › GENERAL › LOCATION**). A click anywhere on it, on a channel
  point or on a row of the list beside it turns the rotor to the azimuth of that place from the QTH (great circle), elevation 0.
  The **dashed line** is the wanted azimuth: it goes to the target and stays there until **CLEAR** (remembered in the browser).
  The **green sector** of the antenna beam width (**BEAM**, default 30°) is where the antenna points now: it follows the position
  the rotor reports and turns with it, so you see the antenna reach the dashed line. **STOP** stops both motors. While the rotor
  cannot take a command (off, not connected, a fault, or TRACK on the TRACK page moves it) the target is still drawn and the
  reason is shown in the top line.
- **Points = channels with a location.** Every channel of **MEMORIES › CHANNELS** with **LAT / LON** (EDIT, **CHOOSE ON MAP**) is a point
  on the map, coloured by its group; on mouse over it shows the name, frequency, mode, groups and note.
- **GROUPS** (beside the map): one row with a checkbox per group of the channels with a location (with the number of channels; channels
  without a group are under *(no group)*); **ALL** / **NONE** switch them all. A channel in several groups is shown while any of its
  groups is on. The choice is remembered in the browser. The list under the groups has the shown channels, nearest first, with
  azimuth and distance, and a filter (name, frequency, group, note); a click on a point scrolls the list to its row. The channel
  aimed at last is selected and scrolled into view in **MEMORIES › CHANNELS** when that tab opens next. A change in MEMORIES shows on the map at once.
