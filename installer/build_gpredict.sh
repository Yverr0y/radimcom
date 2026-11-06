#!/bin/bash
# Builds the Gpredict that RADIMCOM ships: release 2.7 with gpredict_radimcom.patch, into apps/gpredict.
# Details and licences: GPREDICT.txt. Run in the MSYS2 "UCRT64" shell, with Gpredict closed:
#   bash installer/build_gpredict.sh [work folder, default /c/gpredict-build]
set -e
VERSION=2.7
SHA256=1d58b0fc4f13173cde6f64277a8b2e36e84cf0f2a27d8b8d0e48b76780b1236c
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=$(dirname "$HERE")/apps/gpredict
WORK=${1:-/c/gpredict-build}
ROOT=/ucrt64

if tasklist | grep -qi '^gpredict'; then
    echo "Close Gpredict first."
    exit 1
fi

pacman -S --needed --noconfirm patch make zip \
    mingw-w64-ucrt-x86_64-{gcc,pkgconf,gtk3,goocanvas,librsvg,adwaita-icon-theme,curl}

mkdir -p "$WORK"
cd "$WORK"
TAR=gpredict-$VERSION.tar.bz2
[ -f "$TAR" ] || curl -fsSL -o "$TAR" "https://github.com/csete/gpredict/releases/download/v$VERSION/$TAR"
echo "$SHA256  $TAR" | sha256sum -c -
rm -rf "gpredict-$VERSION"
tar xjf "$TAR"
cd "gpredict-$VERSION"
sed 's/\r$//' "$HERE/gpredict_radimcom.patch" | patch -p1

# win32/Makefile, not autotools. The tarball has no git tag, so the version is given here.
cd win32
make -j6 MINGW_ROOT=$ROOT PKG_CONFIG_PATH=$ROOT/lib/pkgconfig GITMAJ=2 GITMIN=7 GITBLD=0 all

# A folder that runs without MSYS2, with only the DLLs it needs.
D=$WORK/gpredict-$VERSION-win64
rm -rf "$D"
mkdir -p "$D/doc" "$D/share/gpredict" "$D/share/glib-2.0/schemas" "$D/share/icons" "$D/lib/gdk-pixbuf-2.0/2.10.0" "$D/etc"
cp -p libsgpsdp.dll gpredict.exe gpredict-con.exe "$D/"
cp -p ../AUTHORS ../COPYING ../NEWS ../README "$D/doc/"
cp -rp ../data ../pixmaps "$D/share/gpredict/"
L=$ROOT/lib/gdk-pixbuf-2.0/2.10.0/loaders
cp -p $L/pixbufloader_svg.dll $L/libpixbufloader-png.dll $L/libpixbufloader-jpeg.dll "$D/"
cp -p $ROOT/bin/gspawn-win64-helper.exe $ROOT/bin/gspawn-win64-helper-console.exe "$D/"
for pass in 1 2 3 4; do      # everything the programs link to, until nothing new turns up
    for f in "$D"/*.exe "$D"/*.dll; do
        ldd "$f" 2>/dev/null | awk '{print $3}' | grep -E "^$ROOT/" | while read -r dll; do
            [ -e "$D/$(basename "$dll")" ] || cp -p "$dll" "$D/"
        done
    done
done
[ -d $ROOT/etc/gtk-3.0 ] && cp -rp $ROOT/etc/gtk-3.0 "$D/etc/"
cp -p $ROOT/share/glib-2.0/schemas/gschemas.compiled "$D/share/glib-2.0/schemas/"
cp -rp $ROOT/share/icons/Adwaita "$D/share/icons/"
# Image loader list: bare DLL names, they sit next to the program.
GDK_PIXBUF_MODULEDIR=$L gdk-pixbuf-query-loaders $L/pixbufloader_svg.dll $L/libpixbufloader-png.dll $L/libpixbufloader-jpeg.dll \
    | sed -E 's#^"[^"]*[/\\]([^"/\\]+\.dll)"#"\1"#' | grep -v LoaderDir > "$D/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"

rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
cp -r "$D" "$OUT"
du -sh "$OUT"
