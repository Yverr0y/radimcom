# RADIMCOM Roadmap


1. **S-meter calibration:** Calibrate the S-meter so the displayed S values are correct. Try to find the way how to do it for each VFO. KEep in mind RF GAIN settings for each VFO, The function or table for each VFO will be needed probably. Autocalibration must ask for some carrier signal in spectrum, then after confirmation will automaticaly set the RF gain and try to set S values. During autocalibration audio must be MUTED
2. ~~**AGC (automatic gain correction):** Three configurable AGC slopes or curves. Is it possible, or AGC is just turning on RTL SDR AGC ?~~ (replaced by AGC+: tuner gain set from the A/D level, see [Features → AGC+](docs/features.md) and [Function keys → GAIN](docs/controls.md#function-keys))
3. **DCS and CTCSS decoder for FM.**
4. ~~**APRS decoder.**~~ (done: packet decoder on the DECODERS page, 1200 Bd AFSK and 9600 Bd G3RUH)
5. ~~**AIS decoder.**~~ (done in 0.113: DECODERS › AIS, both channels 161.975 / 162.025 MHz at once, own GMSK decoder, ships on a map, see [AIS](docs/decoders/ais.md))
6. ~~**HFDL decoder:** multichannel HFDL (High Frequency Data Link) decoder with dumphfdl.~~ (done in 0.113: DECODERS › HFDL, 2.9–22 MHz, all channels inside the band of the VFO, see [HFDL](docs/decoders/hfdl.md))
7. ~~**RTL-SDR Blog V4 support** - remove the 24 MHz lower limit for the V4; test receive range, HF, all modes and decoders, VDL2, DAB, ISM.~~ (done: tunes from 0.5 MHz since 0.113, HF through its built-in upconverter; receive range, HF, all modes and decoders tested)

