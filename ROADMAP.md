# RADIMCOM Roadmap

1. **VFO chaining across dongles:** Let a single USB dongle serve several VFOs. For example, a dongle assigned to VFO-A can also be assigned to VFO-B, VFO-C, and VFO-D. The usable frequency range for each VFO is limited by that dongle's frequency range and bandwidth. Other combinations should also be possible, for example two dongles with two VFOs each.
2. **Release packaging:** When publishing to GitHub, provide both an full installation zip and an upgrade only zip. The upgrade zip keeps the data folder and configuration intact.
from all releases on github.
3. **Responsive web page:** All components resize to the browser window size. The content scales to the window itself, not to the browser's zoom setting.
4. **Memory configuration:** In the memory configuration tab, add an import button for SDR Sharp memories, with a field for the SDR Sharp installation path. Add an export option for the saved memories file, downloadable with one click. Export should work for starred memories or for a whole group.
5. **S-meter calibration:** Calibrate the S-meter so the displayed S values are correct. Try to find the way how to do it for each VFO. KEep in mind RF GAIN settings for each VFO, The function or table for each VFO will be needed probably. Autocalibration must ask for some carrier signal in spectrum, then after confirmation will automaticaly set the RF gain and try to set S values. During autocalibration audio must be MUTED
6. **AGC (automatic gain correction):** Three configurable AGC slopes or curves. Is it possible, or AGC is just turning on RTL SDR AGC ?
7. **Memory names on spectrum:** Show the memory name on the spectrum display.
8. **Band descriptions:** Find band plan information from reliable sources and add band descriptions to the spectrum display, in addition to the existing broadcast, ham, and aviation bands. Examples like - military airband, GSM band, DVB-T, radiosonde band (400 to 406 MHz ?), LoRaWAN, ADS-B etc.
9. **Security skill:** Create a skill for the RADIMCOM project that makes Claude Code check the security of every Python and JavaScript file automatically. For Python, it also checks every library in the import section.
10. **Decoder card design:** Update the decoder cards to match the ACARS and VDL2 design. Apply the same design to the RTTY, CW, WeFax, SSTV and similar decoder windows. The same scrollbar.
11. **CW decoder:** Improve the CW decoder. It should be able to adjust the audio level using the ALC parameter. Or another method to keep the decoding reliable. Probably automatic minimum audio threshold or something like that. Try to propose options.
12. **VHF communication and satellite tracking:** Add VHF communication linked to USB-connected rotor controller so the system can track satellites. Include a satellite tracker that downloads current Kepler data, and let the system change frequency as each satellite moves.

