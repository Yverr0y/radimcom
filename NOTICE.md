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
| libacars 2.2.1 | used by dumpvdl2 and dumphfdl | MIT | <https://github.com/szpajder/libacars> |
| dumphfdl 1.7.0 (with its ground station table `systable.conf`) | HFDL decoder (separate program) | GPL v3 | <https://github.com/szpajder/dumphfdl> |
| liquid-dsp 1.8.3 | used by dumphfdl | MIT | <https://github.com/jgaeddert/liquid-dsp> |
| FFTW 3.3.10 | used by dumphfdl | GPL v2 or later | <https://www.fftw.org> |
| libconfig 1.7.3 | used by dumphfdl | LGPL v2.1 or later | <https://github.com/hyperrealm/libconfig> |
| welle-cli (welle.io 2.7), **modified** (`installer/welle_radimcom.patch`) | DAB / DAB+ decoder (separate program) | GPL v2 or later | <https://github.com/AlbrechtL/welle.io> |
| rtl_433 25.12 (release build of its author, not changed) | ISM decoder, 433 / 868 MHz (separate program) | GPL v2 or later | <https://github.com/merbanan/rtl_433> |
| rtl-sdr 2.0.2, libusb 1.0.29 | linked into `rtl_433.exe` | GPL v2 or later; LGPL v2.1 or later | <https://github.com/osmocom/rtl-sdr>, <https://github.com/libusb/libusb> |
| FFTW, FAAD2 | used by welle-cli | GPL v2 or later | MSYS2 packages |
| mpg123, LAME | used by welle-cli | LGPL | MSYS2 packages |
| MSYS2 runtime | runs dumpvdl2 and dumphfdl | LGPL v3 | <https://github.com/msys2/msys2-runtime> |
| GLib, libiconv, gettext (libintl) | used by dumpvdl2 and dumphfdl | LGPL | MSYS2 packages |
| libxml2, PCRE2, zlib, winpthreads | used by dumpvdl2, dumphfdl and welle-cli | MIT, BSD, zlib | MSYS2 packages |
| GCC runtime libraries | used by dumpvdl2, dumphfdl and welle-cli | GPL with GCC Runtime Library Exception | MSYS2 packages |
| librtlsdr | RTL-SDR access | GPL v2 or later | see the note below |
| libusb 1.0.29 | USB access for librtlsdr | LGPL v2.1 or later | <https://github.com/libusb/libusb> |
| Zadig 2.4 | installs the WinUSB driver | GPL v3 | <https://github.com/pbatard/libwdi> (tag `b721`) |
| LimeSuite | LimeSDR access | Apache 2.0 | <https://github.com/myriadrf/LimeSuite> |
| libairspy | Airspy access | BSD 3-Clause | <https://github.com/airspy/airspyone_host> |
| pthreads-win32 | used by airspy.dll | LGPL v2.1 or later | <https://sourceware.org/pthreads-win32/> |
| FTDI D3XX driver | LimeSDR USB driver | FTDI driver licence | <https://ftdichip.com/drivers/d3xx-drivers/> |
| PyFT8 | FT8 decoder; `install.bat` installs it from PyPI, not in the package | GPL v3 or later | <https://github.com/G1OJS/PyFT8m> |
| Flask, NumPy, SciPy, pyserial | Python packages; `install.bat` installs them from PyPI, not in the package | BSD | PyPI |
| Leaflet 1.9.4 | map for choosing the station place (SATELLITES tab, SETUP); in `static/leaflet` | BSD 2-Clause (`static/leaflet/LICENSE`) | <https://leafletjs.com> |
| Natural Earth 1:50m land and country borders | world map (SATELLITES tab, MAP); simplified in `static/world.js` by `installer/make_world.py` | public domain | <https://www.naturalearthdata.com/> |
| sgp4 | satellite positions (SATELLITES tab, PASSES); `install.bat` installs it from PyPI, not in the package | MIT | <https://github.com/brandon-rhodes/python-sgp4> |
| lameenc (with the LAME MP3 encoder) | MP3 recording; `install.bat` installs it from PyPI, not in the package | LGPL v3 or later (LAME: LGPL) | <https://github.com/chrisstaite/lameenc> |

### Not in the package: DSD-FME

The DSD mode uses [DSD-FME](https://github.com/lwvmobile/dsd-fme) (ISC, parts GPL v2; see `COPYRIGHT` there) as a separate
program. It is **not distributed with RADIMCOM**; `install_dsd.bat` downloads the release of its author into `lib\dsd-fme` at
the user's own decision. DSD-FME contains [mbelib](https://github.com/szechyjs/mbelib), an implementation of the AMBE+2 and IMBE
voice codecs. According to the mbelib notice, its functions may be covered by patents owned by Digital Voice Systems, Inc., and compiling or using it
may infringe patent rights in your jurisdiction and/or require a licence. Check this for your country before installing it.

### Source code

Each release from Ver. 0.108 has `RADIMCOM_sources_v<version>.zip` with the source code of the GPL and LGPL components
in that release, in the exact versions used, and the build instructions (`installer/VDL2.txt`, `installer/DAB.txt`,
`installer/build_dab.sh`, `installer/welle_radimcom.patch`). The list of its contents is `SOURCES.txt` in that zip. It is built by
`installer/make_sources.py`.

**librtlsdr:** the exact source of the `librtlsdr.dll` in the packages is still being confirmed, so it is not in that
zip yet. To ask for it, or for any other source code, write to radim.mutina@gmail.com.

### Data

- The VDL2 ground station list (`VDL2_Ground_Stations.txt`) comes from <https://acars-vdl2.groups.io/>, redistributed
  with approval.
- The airport tables in `airports.py` come from OurAirports (public domain).
- The SATELLITES tab shows pages of AMSAT (<https://www.amsat.org/>), downloaded by the running program. They belong to AMSAT and are not in the repository or the release packages.
- The orbital elements for pass prediction (TLE, amateur group) come from CelesTrak (<https://celestrak.org/>), downloaded by the running program once a day into `data\sat_tle.txt`; they are not in the repository or the release packages.
- The list of satellite transmitters (SATELLITES tab, TRACK) comes from SatNOGS DB (<https://db.satnogs.org/>, Libre Space Foundation; data under CC BY-SA 4.0), downloaded by the running program once a week into `data\sat_transmitters.json`; it is not in the repository or the release packages.
- The map for choosing the station place (SATELLITES tab, SETUP, CHOOSE ON MAP) shows tiles of OpenStreetMap (<https://www.openstreetmap.org/copyright>), © OpenStreetMap contributors, loaded by the browser from tile.openstreetmap.org only while that map is open; nothing of it is in the package.
