[← README](../../README.md) · [Documentation](../README.md)

# ISM decoder (433 / 868 MHz)

The **ISM** key in DECODE decodes devices on 433 and 868 MHz, such as weather sensors, remote controls and tyre sensors, via rtl_433.

ISM (433 / 868 MHz devices such as weather sensors and remote controls, decoded by [rtl_433](https://github.com/merbanan/rtl_433)): buttons 433.92 and 868.30 MHz centre the VFO, which runs at 2.048 MS/s, so about ±1 MHz is decoded at once. The audio of the VFO is muted, and REC records nothing. The table shows the device, ID, channel, level and data; a message the device repeats is one row with ×N. **ISM** again, **OFF** in the card or any band button ends it and restores the sample rate. ISM turns ACARS, VDL2 and DAB off. RTL-SDR only; not on LimeSDR, Airspy or a chained VFO.

rtl_433 is a separate program (`lib\ism\rtl_433.exe`); `ism.py` gives it the raw samples through a local rtl_tcp server and reads its messages. Licences and sources are in `installer\ISM.txt` (`lib\ism\README.txt` in the package).
