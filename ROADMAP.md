# RADIMCOM Roadmap


1. **S-meter calibration:** Calibrate the S-meter so the displayed S values are correct. Try to find the way how to do it for each VFO. KEep in mind RF GAIN settings for each VFO, The function or table for each VFO will be needed probably. Autocalibration must ask for some carrier signal in spectrum, then after confirmation will automaticaly set the RF gain and try to set S values. During autocalibration audio must be MUTED
2. **AGC (automatic gain correction):** Three configurable AGC slopes or curves. Is it possible, or AGC is just turning on RTL SDR AGC ?
3. **DCS and CTCSS decoder for FM.**
4. **APRS decoder.**
5. **AIS decoder.**
6. **HFDL decoder:** multichannel HFDL (High Frequency Data Link) decoder with dumphfdl.
7. **RTL-SDR Blog V4 support** - remove the 24 MHz lower limit for the V4, so it can tune down to about 0.5 MHz (R828D tuner, HF through its built-in upconverter, no external converter needed); test receive range, HF, all modes and decoders, VDL2, DAB, ISM.

