[← README](../../README.md) · [Documentation](../README.md)

# DSD: digital voice

The **DSD** key in the MODE group decodes digital voice with [DSD-FME](https://github.com/lwvmobile/dsd-fme), which runs as a
separate program (`dsd.py` feeds it the FM discriminator and takes the voice back).

> [!WARNING]
> **First test version, it still needs more testing.**
> - **Tested on real signals:** DMR and D-Star voice and call information, on one multi-mode repeater.
> - **Not tested yet:** P25, YSF, NXDN, dPMR, M17, ProVoice and X2-TDMA; two TDMA slots talking at once; long runs; CUE with a VFO in DSD.
> - One call may show up as several short rows in the list of calls.
>
> Reports are welcome, also when a protocol works: please open an [issue](https://github.com/om2amr/RADIMCOM/issues/new/choose) with the protocol,
> the frequency band and what you saw.

> [!IMPORTANT]
> **Installation: run `install_dsd.bat`.** DSD-FME is **not part of the RADIMCOM package**, neither the install zip nor the upgrade zip.
> `install.bat` does not install it, so this is a separate step. It needs internet.

Why it is separate: the voice codec of DSD-FME (mbelib, AMBE+2) may be covered by patents, see [NOTICE.md](../../NOTICE.md). `install_dsd.bat` shows the
notice, and after you type YES it downloads the release of the author (about 38 MB, checked by SHA-256) into `lib\dsd-fme`. Without it the DSD mode
stays silent and the card says what to do; if the mode is already selected, the decoder starts by itself a few seconds after the installation. To
replace a version, first switch every VFO out of the DSD mode: a decoder in use cannot be replaced, and the script then leaves the installed version as it was.

**Upgrade of RADIMCOM:** the upgrade zip does not touch `lib\dsd-fme`, so an installed DSD-FME stays. If it is not installed yet, run `install_dsd.bat`.
The script always installs the one version tested with this RADIMCOM; if a new RADIMCOM needs a newer one, the change log says to run `install_dsd.bat` again.

**New, empty folder:** `lib\dsd-fme` is not in `data\`, so a clean installation has no decoder. Run `install_dsd.bat` there as well.

- Tune to the centre of the channel and press **DSD**. The channel is fixed at 12.5 kHz. The **DSD** tab (next to SPECTRUM, there only while the mode DSD is on) opens with the DSD card.
- **Protocol:** AUTO finds DMR, P25 (phase 1 and 2), D-Star, YSF and X2-TDMA. NXDN48, NXDN96, dPMR, M17 and ProVoice have to be selected.
- **Slot** (DMR, P25 phase 2): voice of slot 1, slot 2 or both. Both talking at once: slot 1 on the left, slot 2 on the right. A change of the
  protocol or the slot restarts the decoder, which takes about a second.
- The card shows the running calls and a list of the finished ones: protocol, slot, talk group or private ID, caller and talker alias, if the
  radio sends one. **LOG** writes them to `data\logs\dsd_YYYY-MM-DD.txt`. DMR and D-Star have been tested on real signals so far; other protocols may show
  less. D-Star: the radio header gives To and From; without it the caller comes from a GPS frame, if the radio sends one, and To stays empty.
- **ENC** marks an encrypted call: it stays muted, RADIMCOM has no decryption. No trunking: the VFO stays on its frequency.
- Squelch, AFI, notch and ALC do not apply in this mode; LPF and HPF work on the decoded voice. Transmitting is blocked.
- Bad decoding: check the tuning (the channel centre) and the RF gain; too much gain distorts digital signals earlier than it is heard in FM.
