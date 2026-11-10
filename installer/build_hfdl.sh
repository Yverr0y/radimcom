#!/bin/bash
# Builds dumphfdl.exe for RADIMCOM (lib\hfdl) in MSYS2, "MSYS" environment (like dumpvdl2, see VDL2.txt).
# Run from the MSYS2 MSYS shell:   bash /c/RADIMCOM/installer/build_hfdl.sh
# Sources go to ~/../../Users/<you>/src (SRC below); libacars must already be installed (VDL2.txt).
# FFTW, libconfig and liquid-dsp are not MSYS packages: they are built here and installed into /usr.
set -e
[ "$MSYSTEM" = "MSYS" ] || { echo "run this in the MSYS2 MSYS shell (MSYSTEM=MSYS, now: $MSYSTEM)"; exit 1; }
SRC=${SRC:-/c/Users/$USER/src}
DEST=${DEST:-/c/RADIMCOM/lib/hfdl}
FLAGS="-D_GNU_SOURCE -include alloca.h"
# CMake 4 refuses projects that declare cmake_minimum_required < 3.5 (FFTW 3.3.10, libconfig): accept them anyway
export CMAKE_POLICY_VERSION_MINIMUM=3.5
mkdir -p "$SRC" && cd "$SRC"

pacman -S --needed --noconfirm gcc cmake ninja pkgconf git glib2-devel

[ -d fftw-3.3.10 ] || { curl -sSLO https://www.fftw.org/fftw-3.3.10.tar.gz && tar xzf fftw-3.3.10.tar.gz; }
[ -d libconfig ] || git clone -q --depth 1 -b v1.7.3 https://github.com/hyperrealm/libconfig.git
[ -d liquid-dsp-1.8.3 ] || git clone -q --depth 1 -b v1.8.3 https://github.com/jgaeddert/liquid-dsp.git liquid-dsp-1.8.3
[ -d dumphfdl ] || git clone -q --depth 1 -b v1.7.0 https://github.com/szpajder/dumphfdl.git

echo "== FFTW 3.3.10 (single precision)"
cmake -S fftw-3.3.10 -B fftw-3.3.10/build-msys -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr \
      -DENABLE_FLOAT=ON -DENABLE_THREADS=ON -DENABLE_SSE=ON -DENABLE_SSE2=ON -DENABLE_AVX=ON -DBUILD_TESTS=OFF \
      -DCMAKE_C_FLAGS="$FLAGS"
ninja -C fftw-3.3.10/build-msys install

echo "== libconfig 1.7.3"
cmake -S libconfig -B libconfig/build-msys -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr \
      -DBUILD_EXAMPLES=OFF -DBUILD_TESTS=OFF -DCMAKE_C_FLAGS="$FLAGS" -DCMAKE_CXX_FLAGS="-D_GNU_SOURCE"
ninja -C libconfig/build-msys install
# the CMake build of libconfig installs no pkg-config files; dumphfdl looks for libconfig++ with pkg-config
for n in libconfig libconfig++; do
  cat > /usr/lib/pkgconfig/$n.pc <<PC
prefix=/usr
libdir=\${prefix}/lib
includedir=\${prefix}/include

Name: $n
Description: C/C++ configuration file library
Version: 1.7.3
Libs: -L\${libdir} -l${n#lib}
Cflags: -I\${includedir}
PC
done

echo "== liquid-dsp 1.8.3"
cmake -S liquid-dsp-1.8.3 -B liquid-dsp-1.8.3/build-msys -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX=/usr \
      -DBUILD_EXAMPLES=OFF -DBUILD_AUTOTESTS=OFF -DBUILD_BENCHMARKS=OFF -DBUILD_SANDBOX=OFF -DBUILD_DOC=OFF \
      -DENABLE_SIMD=OFF -DCMAKE_C_FLAGS="$FLAGS"
ninja -C liquid-dsp-1.8.3/build-msys install

echo "== dumphfdl 1.7.0"
cmake -S dumphfdl -B dumphfdl/build-msys -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_C_FLAGS="$FLAGS" \
      -DSOAPYSDR=OFF -DETSY_STATSD=OFF -DSQLITE=OFF -DZMQ=OFF -DRDKAFKA=OFF -DPROFILING=OFF
ninja -C dumphfdl/build-msys

echo "== copy to $DEST"
mkdir -p "$DEST"
cp dumphfdl/build-msys/src/dumphfdl.exe "$DEST/"
cp dumphfdl/etc/systable.conf "$DEST/"
# every MSYS2 DLL the program needs (msys-2.0, fftw3f, liquid, libconfig, libacars, glib…)
ldd "$DEST/dumphfdl.exe" | awk '$3 ~ /^\/usr\/bin\// {print $3}' | sort -u | xargs -r cp -t "$DEST/"
ls -l "$DEST"
"$DEST/dumphfdl.exe" --version
