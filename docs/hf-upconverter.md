[← README](../README.md) · [Documentation](README.md)

# Shortwave (HF) reception with an upconverter

An RTL-SDR dongle on its own tunes only from about 24 MHz up (24–1766 MHz). The **RTL-SDR Blog V4** is the exception: it has an upconverter
built in and RADIMCOM tunes it from 0.5 MHz without an external converter (keep *Upconverter* off for it). Shortwave, medium wave and longwave
(below 30 MHz) are received through an **upconverter**: it shifts HF up by its oscillator frequency (LO), e.g. with
LO = 100 MHz, 7.100 MHz is received at 107.100 MHz. RADIMCOM does the conversion itself: displays, band buttons,
memories and decoders always show the **real frequency**.

Common upconverters (enter the LO of your model):

| Upconverter | LO | Note |
|---|---|---|
| Nooelec Ham It Up (v1.3 / Plus) | 125 MHz | powered by USB |
| Airspy SpyVerter (R2) | 120 MHz | powered by the dongle's bias-tee (turn on Bias-tee in SET) |
| generic HF upconverter boards (e.g. from AliExpress / eBay) | usually 100 or 125 MHz | check the crystal / seller's description |

Setup:
- In the SDR setup (`setup.bat`) answer **Y** to "Is it connected through an HF upconverter?" and enter the LO in MHz.
  Later it can be changed in **SET → Upconverter LO**.
- Mode **auto** (default with a converter): below 30 MHz the receiver tunes through the converter, from 30 MHz directly.
  If your converter has a manual bypass switch (or you swap antennas), the **CONV / BYPASS** indicator in the VFO window and a warning
  show which position is needed when you cross 30 MHz.
- The LO crystal is rarely exact: if stations are slightly off, correct the LO in SET (e.g. 125.0012 MHz) or the ppm.
  A good reference is a station with a known frequency, e.g. DWD RTTY on 4583 / 7646 / 10100.8 kHz.
- HF needs an HF antenna (long wire, dipole, active loop); a VHF/UHF antenna gives very weak HF signals.
- With several dongles, connect the converter to one of them (e.g. VFO A) and keep the others direct for VHF/UHF.
  A band button outside the active VFO's range switches to the VFO that can receive it.
