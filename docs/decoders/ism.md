[← README](../../README.md) · [Documentation](../README.md)

# ISM decoder (433 / 868 MHz)

The **ISM** key in DECODE decodes devices on 433 and 868 MHz, such as weather sensors, remote controls and tyre sensors, via rtl_433.

ISM (433 / 868 MHz devices such as weather sensors and remote controls, decoded by [rtl_433](https://github.com/merbanan/rtl_433)): buttons 433.92 and 868.30 MHz centre the VFO, which runs at 2.048 MS/s (see Channels below). The audio of the VFO is muted, and REC records nothing. The table shows the device, ID, channel, level and data; a message the device repeats is one row with ×N. **ISM** again, **OFF** in the card or any band button ends it and restores the sample rate. ISM turns ACARS, VDL2 and DAB off. RTL-SDR only; not on LimeSDR, Airspy or a chained VFO.

**Channels.** rtl_433 gets narrow channels of 256 kS/s that RADIMCOM cuts out of the 2.048 MS/s of the dongle, one rtl_433 each: 433.92 and 433.42 MHz at the 433.92 preset, 868.30 MHz at the 868.30 preset (hover the message counter). With the whole 2 MHz at once, noise and several transmitters merge into long packages and rtl_433 decodes far fewer messages (on a 5 min test recording 107 instead of 236). A device further than about ±110 kHz from a channel centre is not decoded.

**RAW** shows packages of at least 20 pulses that no decoder read, as grey rows: modulation guess, pulses, length and the demodulated bits from rtl_433's pulse analyzer; the tooltip has the flex decoder hint (`-X ...`) and **⧉** shows the pulses at triq.org/pdv. Many are noise or devices rtl_433 does not know. RAW rows are not written to the log.

One packet read by two decoders of rtl_433 is one row with both device names (e.g. *LaCrosse-TX29IT / LaCrosse-TX35DTHIT*). Units are SI (°C, km/h, mm).

rtl_433 is a separate program (`lib\ism\rtl_433.exe`); `ism.py` gives it the raw samples through a local rtl_tcp server and reads its messages. Licences and sources are in `installer\ISM.txt` (`lib\ism\README.txt` in the package).
