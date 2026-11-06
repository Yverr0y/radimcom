#!/bin/bash
# Builds welle-cli (DAB / DAB+ decoder, welle.io v2.7) for RADIMCOM and copies it with its DLLs to lib\dab.
# Run from Git Bash or PowerShell:  C:\msys64\usr\bin\bash.exe -l C:/RADIMCOM/installer/build_dab.sh
# Needs MSYS2 in C:\msys64 and internet (packages + source). See installer\DAB.txt.
set -e
export MSYSTEM=UCRT64
export PATH=/ucrt64/bin:/usr/bin:$PATH
DEST=${DEST:-/c/RADIMCOM/lib/dab}
SRC=${TMP:-/tmp}/welle-build

pacman -S --noconfirm --needed git vim mingw-w64-ucrt-x86_64-gcc mingw-w64-ucrt-x86_64-cmake mingw-w64-ucrt-x86_64-ninja \
    mingw-w64-ucrt-x86_64-pkgconf mingw-w64-ucrt-x86_64-fftw mingw-w64-ucrt-x86_64-faad2 \
    mingw-w64-ucrt-x86_64-mpg123 mingw-w64-ucrt-x86_64-lame

rm -rf "$SRC"
git clone --depth 1 --branch v2.7 https://github.com/AlbrechtL/welle.io.git "$SRC"
# our change: audio at the right speed on HE-AAC v2 stations
git -C "$SRC" apply --ignore-whitespace "$(dirname "$(readlink -f "$0")")/welle_radimcom.patch"
cmake -S "$SRC" -B "$SRC/build" -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DBUILD_WELLE_IO=OFF -DBUILD_WELLE_CLI=ON -DRTLSDR=OFF -DSOAPYSDR=OFF -DAIRSPY=OFF \
      -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
      -DCMAKE_CXX_STANDARD_LIBRARIES="-lws2_32"
# POLICY_VERSION_MINIMUM: CMake 4.x, welle.io v2.7 still declares an old minimum version
# ws2_32: Winsock (sockets of the web server and rtl_tcp), not linked by welle.io's CMakeLists on Windows
ninja -C "$SRC/build" welle-cli

mkdir -p "$DEST"
cp "$SRC/build/welle-cli.exe" "$DEST/"
# the DLLs it needs from UCRT64 (not the Windows system ones), also the DLLs those need. objdump, not ldd:
# ldd resolves through PATH and can find other copies (Git, WSJT-X…) or miss them.
cd "$DEST"
todo="welle-cli.exe"
while [ -n "$todo" ]; do
    set -- $todo; f=$1; shift; todo="$*"
    for d in $(objdump -p "$f" | awk '/DLL Name:/ {print $3}'); do
        if [ -f "/ucrt64/bin/$d" ] && [ ! -f "$d" ]; then cp "/ucrt64/bin/$d" . && todo="$todo $d"; fi
    done
done
ls -la "$DEST"
"$DEST/welle-cli.exe" -v || true
echo "OK: welle-cli is in C:\\RADIMCOM\\lib\\dab"
