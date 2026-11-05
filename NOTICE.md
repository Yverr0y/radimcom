# Notices

This file is not part of the licence terms in [LICENSE](LICENSE).

## Radio transmission notice

The Software can control radio transmitting hardware. Transmitting is legal only for a holder of a valid licence or
other authorisation required in the country of operation, within its privileges and the applicable regulations (ITU,
CEPT, FCC or the national authority). The operator is fully and solely responsible for every transmission and its
consequences. Anyone who modifies or removes the transmit frequency limits of the Software is solely responsible for
any transmission outside the bands they are licensed for.

## Third-party components

The code of RADIMCOM itself is under the MIT License. The components below keep their own licences. The git repository
does not contain the binaries; the release packages do, except where noted.

| Component | Used for | Licence | Source |
|---|---|---|---|
| dumpvdl2 2.7.0 | VDL2 decoder (separate program) | GPL v3 | <https://github.com/szpajder/dumpvdl2> |
| libacars 2.2.1 | used by dumpvdl2 | MIT | <https://github.com/szpajder/libacars> |
| welle-cli (welle.io 2.7) | DAB / DAB+ decoder (separate program) | GPL v2 or later | <https://github.com/AlbrechtL/welle.io> |
| FFTW, FAAD2 | used by welle-cli | GPL v2 or later | MSYS2 packages |
| mpg123, LAME | used by welle-cli | LGPL | MSYS2 packages |
| MSYS2 runtime | runs dumpvdl2 | LGPL v3 | <https://github.com/msys2/msys2-runtime> |
| GLib, libiconv, gettext (libintl) | used by dumpvdl2 | LGPL | MSYS2 packages |
| libxml2, PCRE2, zlib, winpthreads | used by dumpvdl2 and welle-cli | MIT, BSD, zlib | MSYS2 packages |
| GCC runtime libraries | used by dumpvdl2 and welle-cli | GPL with GCC Runtime Library Exception | MSYS2 packages |
| librtlsdr | RTL-SDR access | GPL v2 or later | see the note below |
| libusb 1.0.29 | USB access for librtlsdr | LGPL v2.1 or later | <https://github.com/libusb/libusb> |
| Zadig 2.4 | installs the WinUSB driver | GPL v3 | <https://github.com/pbatard/libwdi> (tag `b721`) |
| LimeSuite | LimeSDR access | Apache 2.0 | <https://github.com/myriadrf/LimeSuite> |
| FTDI D3XX driver | LimeSDR USB driver | FTDI driver licence | <https://ftdichip.com/drivers/d3xx-drivers/> |
| PyFT8 | FT8 decoder; `install.bat` installs it from PyPI, not in the package | GPL v3 or later | <https://github.com/G1OJS/PyFT8m> |
| Flask, NumPy, SciPy | Python packages; `install.bat` installs them from PyPI, not in the package | BSD | PyPI |

### Not in the package: DSD-FME

The DSD mode uses [DSD-FME](https://github.com/lwvmobile/dsd-fme) (ISC, parts GPL v2; see `COPYRIGHT` there) as a separate
program. It is **not distributed with RADIMCOM**; `install_dsd.bat` downloads the release of its author into `lib\dsd-fme` at
the user's own decision. DSD-FME contains [mbelib](https://github.com/szechyjs/mbelib), an implementation of the AMBE+2 and IMBE
voice codecs. According to the mbelib notice, its functions may be covered by patents owned by Digital Voice Systems, Inc., and compiling or using it
may infringe patent rights in your jurisdiction and/or require a licence. Check this for your country before installing it.

### Source code

Each release from Ver. 0.108 has `RADIMCOM_sources_v<version>.zip` with the source code of the GPL and LGPL components
in that release, in the exact versions used, and the build instructions (`installer/VDL2.txt`, `installer/DAB.txt`,
`installer/build_dab.sh`). The list of its contents is `SOURCES.txt` in that zip. It is built by
`installer/make_sources.py`.

**librtlsdr:** the exact source of the `librtlsdr.dll` in the packages is still being confirmed, so it is not in that
zip yet. To ask for it, or for any other source code, write to radim.mutina@gmail.com.

### Data

- The VDL2 ground station list (`VDL2_Ground_Stations.txt`) comes from <https://acars-vdl2.groups.io/>, redistributed
  with approval.
- The airport tables in `airports.py` come from OurAirports (public domain).
