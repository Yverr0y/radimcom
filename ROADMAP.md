# RADIMCOM Roadmap


1. **S-meter calibration:** Calibrate the S-meter so the displayed S values are correct. Try to find the way how to do it for each VFO. KEep in mind RF GAIN settings for each VFO, The function or table for each VFO will be needed probably. Autocalibration must ask for some carrier signal in spectrum, then after confirmation will automaticaly set the RF gain and try to set S values. During autocalibration audio must be MUTED
2. **AGC (automatic gain correction):** Three configurable AGC slopes or curves. Is it possible, or AGC is just turning on RTL SDR AGC ?
3. **VHF communication and satellite tracking:** Add VHF communication linked to USB-connected rotor controller so the system can track satellites. Include a satellite tracker that downloads current Kepler data, and let the system change frequency as each satellite moves.
4. **More European VDL2 channels:** Add the remaining European VDL2 channels, both the current ones (136.675, 136.850, 136.900 MHz) and those planned from January 2027 (136.700–136.975 MHz in 25 kHz steps). 136.675 MHz becomes a guard channel in January 2027. The VDL2 centre must move away from 136.850 MHz so that channel is not on the DC spike. The VDL2 decoder card should have Europe / US buttons to select the channel set. See [issue #1](https://github.com/om2amr/RADIMCOM/issues/1).

