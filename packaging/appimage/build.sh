#!/usr/bin/env bash
#
# Builds yugen.AppImage with yt-dlp, ffmpeg and WebKitGTK inside it, so the only
# thing the target machine has to provide is a kernel that allows unprivileged
# user namespaces. See AppRun next to this file for why WebKit needs the extra
# treatment.
#
#   ./packaging/appimage/build.sh
#
# Knobs, all optional:
#   YUGEN_SKIP_UI=1     reuse ui/dist instead of running npm
#   YUGEN_SKIP_BUILD=1  reuse the cmake build tree
#   FFMPEG_URL=...      override the ffmpeg tarball
#   YT_DLP_URL=...      override the yt-dlp binary (pin a release here)

set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
work="$root/build-appimage"
appdir="$work/AppDir"
cache="$work/cache"

# johnvansickle's builds are fully static and made against an old glibc, which
# is exactly what a bundle wants. BtbN's github releases work too if this host
# is ever unreachable.
FFMPEG_URL=${FFMPEG_URL:-https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz}
YT_DLP_URL=${YT_DLP_URL:-https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux}

say() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\n\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# patchelf and strip come from inside the linuxdeploy AppImage, so they are not
# listed here
for tool in cmake curl tar bwrap; do
    command -v "$tool" >/dev/null || die "$tool is not installed"
done

linuxdeploy="$root/linuxdeploy-x86_64.AppImage"
if [ ! -x "$linuxdeploy" ]; then
    say "fetching linuxdeploy"
    curl -fL -o "$linuxdeploy" \
        https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage
    chmod +x "$linuxdeploy"
fi

rm -rf "$appdir"
mkdir -p "$appdir" "$cache"

# --- the app itself -------------------------------------------------------

if [ -z "${YUGEN_SKIP_UI:-}" ]; then
    say "building the ui bundle"
    # saucer_embed() globs ui/dist when cmake configures, so this has to be first
    ( cd "$root/ui" && npm ci && npm run build )
fi

if [ -z "${YUGEN_SKIP_BUILD:-}" ]; then
    say "building yugen"
    cmake -S "$root" -B "$work/build" \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX=/usr
    cmake --build "$work/build" --parallel
fi

DESTDIR="$appdir" cmake --install "$work/build"

desktop="$appdir/usr/share/applications/yugen.desktop"
# assets/yugen.desktop points Exec at /usr/local/bin, which is meaningless in a
# bundle and makes linuxdeploy's validation fail
sed -i 's|^Exec=.*|Exec=yugen|' "$desktop"

# --- yt-dlp and ffmpeg ----------------------------------------------------

say "fetching yt-dlp"
curl -fL --retry 3 -o "$appdir/usr/bin/yt-dlp" "$YT_DLP_URL"
chmod +x "$appdir/usr/bin/yt-dlp"
"$appdir/usr/bin/yt-dlp" --version >/dev/null || die "the yt-dlp binary does not run"
echo "    yt-dlp $("$appdir/usr/bin/yt-dlp" --version)"

say "fetching ffmpeg"
if [ ! -f "$cache/ffmpeg.tar.xz" ]; then
    curl -fL --retry 3 -o "$cache/ffmpeg.tar.xz" "$FFMPEG_URL" \
        || die "could not download $FFMPEG_URL - set FFMPEG_URL to a mirror"
fi
tar -xf "$cache/ffmpeg.tar.xz" -C "$appdir/usr/bin" \
    --strip-components=1 --wildcards '*/ffmpeg' '*/ffprobe'
chmod +x "$appdir/usr/bin/ffmpeg" "$appdir/usr/bin/ffprobe"

# every download runs `yt-dlp -x --audio-format mp3`, so a build without the mp3
# encoder would pass this script and fail on the first song
"$appdir/usr/bin/ffmpeg" -hide_banner -encoders 2>/dev/null | grep -q libmp3lame \
    || die "this ffmpeg build has no libmp3lame, mp3 extraction would fail"
echo "    $("$appdir/usr/bin/ffmpeg" -version 2>/dev/null | head -1)"

# --- webkit ---------------------------------------------------------------

webkit_src=""
for dir in /usr/lib/webkitgtk-6.0 /usr/lib64/webkitgtk-6.0 /usr/libexec/webkitgtk-6.0 \
           /usr/lib/x86_64-linux-gnu/webkitgtk-6.0; do
    [ -x "$dir/WebKitWebProcess" ] && { webkit_src="$dir"; break; }
done
[ -n "$webkit_src" ] || die "no webkitgtk-6.0 helper processes found on this system"

say "bundling webkit helpers from $webkit_src"
mkdir -p "$appdir/usr/lib/webkitgtk-6.0"
cp -r "$webkit_src"/. "$appdir/usr/lib/webkitgtk-6.0/"
# neither is reachable from the player and together they are most of the tree
rm -f "$appdir/usr/lib/webkitgtk-6.0/MiniBrowser" "$appdir/usr/lib/webkitgtk-6.0/jsc"

# --- glib/gtk runtime bits ------------------------------------------------

say "bundling the glib runtime"

if [ -d /usr/lib/gio/modules ]; then
    mkdir -p "$appdir/usr/lib/gio/modules"
    # giomodule.cache stores plain filenames, so it survives the move as-is.
    # libgiognutls is the one that matters: without it webkit has no tls backend.
    cp -r /usr/lib/gio/modules/. "$appdir/usr/lib/gio/modules/"
fi

if [ -f /usr/share/glib-2.0/schemas/gschemas.compiled ]; then
    mkdir -p "$appdir/usr/share/glib-2.0/schemas"
    cp /usr/share/glib-2.0/schemas/gschemas.compiled "$appdir/usr/share/glib-2.0/schemas/"
fi

pixbuf_dir=$(pkg-config --variable=gdk_pixbuf_moduledir gdk-pixbuf-2.0 2>/dev/null || true)
pixbuf_cache=$(pkg-config --variable=gdk_pixbuf_cache_file gdk-pixbuf-2.0 2>/dev/null || true)
if [ -n "$pixbuf_dir" ] && [ -d "$pixbuf_dir" ]; then
    mkdir -p "$appdir/usr/lib/gdk-pixbuf-2.0/loaders"
    cp "$pixbuf_dir"/*.so "$appdir/usr/lib/gdk-pixbuf-2.0/loaders/"
    # the cache holds absolute module paths; AppRun rewrites the placeholder to
    # wherever the AppImage happens to be mounted
    sed "s|$pixbuf_dir|@APPDIR@/usr/lib/gdk-pixbuf-2.0/loaders|g" "$pixbuf_cache" \
        > "$appdir/usr/lib/gdk-pixbuf-2.0/loaders.cache"
fi

# --- deploy ---------------------------------------------------------------

say "running linuxdeploy"
# yt-dlp and ffmpeg are deliberately not listed: they are self-contained and
# linuxdeploy would try to rewrite their rpath. Only ELF files it is told about
# get touched, so leaving them out of the arguments is enough.
"$linuxdeploy" \
    --appdir "$appdir" \
    --deploy-deps-only "$appdir/usr/bin/yugen" \
    --deploy-deps-only "$appdir/usr/lib/webkitgtk-6.0" \
    --deploy-deps-only "$appdir/usr/lib/gio/modules" \
    --deploy-deps-only "$appdir/usr/lib/gdk-pixbuf-2.0/loaders" \
    --executable /usr/bin/bwrap \
    --desktop-file "$desktop" \
    --icon-file "$root/assets/icons/yugen_256.png" \
    --icon-filename yugen \
    --custom-apprun "$root/packaging/appimage/AppRun"

say "packing"
( cd "$work" && OUTPUT="yugen-x86_64.AppImage" "$linuxdeploy" \
    --appdir "$appdir" --output appimage \
    --desktop-file "$desktop" \
    --icon-file "$root/assets/icons/yugen_256.png" \
    --icon-filename yugen \
    --custom-apprun "$root/packaging/appimage/AppRun" )

out="$work/yugen-x86_64.AppImage"
[ -f "$out" ] || die "linuxdeploy produced no AppImage"

# --- portability report ---------------------------------------------------

# glibc is the one thing that cannot be bundled, so the build host decides the
# oldest distro this will run on. Building on Arch means a very new floor.
glibc=$(find "$appdir/usr/lib" "$appdir/usr/bin" -type f 2>/dev/null \
    | xargs -r -I{} sh -c 'objdump -T "{}" 2>/dev/null | grep -o "GLIBC_[0-9.]*"' \
    | sort -uV | tail -1)

say "done: $out ($(du -h "$out" | cut -f1))"
printf '\n'
printf '  requires glibc %s or newer\n' "${glibc#GLIBC_}"
printf '  built on: %s\n' "$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}")"
printf '\n'
printf '  glibc is not bundled and never can be, so this AppImage only runs on\n'
printf '  distros at least as new as the machine that built it. For something to\n'
printf '  hand to other people, run this script inside an older base image.\n'
printf '\n'
