#!/usr/bin/env bash
#
# Builds yugen.AppImage with yt-dlp and ffmpeg inside it.
#
#   ./packaging/appimage/build.sh
#
# WebKitGTK and the GTK stack under it are deliberately left to the host. The
# helper-process path is compiled into libwebkitgtk as an absolute string with
# no override outside developer builds, so a bundled copy can only be reached
# by mounting it over that path, and once webkit comes from the system every
# library it shares with the app has to come from there too. One distro package
# is a better trade than that.
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
for tool in cmake curl tar; do
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

# --- deploy ---------------------------------------------------------------

# Everything webkit also links has to come from the same place webkit does.
# Bundling gtk4 next to a system libwebkitgtk built against a different gtk4 is
# how you get missing symbols at startup, so the whole stack is excluded and
# only the libraries that are ours alone - taglib, curl, discord-rpc - travel
# with the bundle.
excludes=(
    'libwebkitgtk-6.0.so*' 'libjavascriptcoregtk-6.0.so*'
    'libgtk-4.so*' 'libadwaita-1.so*' 'libgraphene-1.0.so*'
    'libglib-2.0.so*' 'libgobject-2.0.so*' 'libgio-2.0.so*' 'libgmodule-2.0.so*'
    'libgdk_pixbuf-2.0.so*' 'libjson-glib-1.0.so*' 'libsoup-3.0.so*'
    'libpango*.so*' 'libcairo*.so*' 'libharfbuzz*.so*' 'libepoxy.so*'
    'libgst*.so*' 'libfontconfig.so*' 'libfreetype.so*'
)

exclude_args=()
for pattern in "${excludes[@]}"; do
    exclude_args+=(--exclude-library "$pattern")
done

say "running linuxdeploy"
# One invocation, not two. A second call to pack the AppDir re-runs deployment,
# and without the exclusions repeated it happily puts the whole webkit stack
# back in - which is exactly what the leak check below is here to catch.
#
# yt-dlp and ffmpeg are deliberately not listed: they are self-contained and
# linuxdeploy would try to rewrite their rpath. Only ELF files it is told about
# get touched, so leaving them out of the arguments is enough.
( cd "$work" && OUTPUT="yugen-x86_64.AppImage" "$linuxdeploy" \
    --appdir "$appdir" \
    --deploy-deps-only "$appdir/usr/bin/yugen" \
    "${exclude_args[@]}" \
    --desktop-file "$desktop" \
    --icon-file "$root/assets/icons/yugen_256.png" \
    --icon-filename yugen \
    --custom-apprun "$root/packaging/appimage/AppRun" \
    --output appimage )

# a bundled webkit or gtk would be worse than useless: the system webkit the app
# actually loads was built against the host's gtk, not this one
leaked=$(ls "$appdir/usr/lib" 2>/dev/null \
    | grep -E '^lib(webkitgtk|javascriptcoregtk|gtk-4|adwaita|glib-2|gobject-2|gio-2)' || true)
if [ -n "$leaked" ]; then
    rm -f "$work/yugen-x86_64.AppImage"
    die "these leaked into the bundle: $(echo "$leaked" | tr '\n' ' ')"
fi

out="$work/yugen-x86_64.AppImage"
[ -f "$out" ] || die "linuxdeploy produced no AppImage"

# --- portability report ---------------------------------------------------

# glibc is the one thing that cannot be bundled, so the build host decides the
# oldest distro this will run on. Building on a rolling distro means a very new
# floor; objdump exits non-zero on every non-ELF file in there, and xargs turns
# that into a 123 that would take the whole script down after a good build.
glibc=$(find "$appdir/usr/lib" "$appdir/usr/bin" -type f 2>/dev/null \
    | xargs -r -I{} sh -c 'objdump -T "{}" 2>/dev/null | grep -o "GLIBC_[0-9.]*" || true' \
    | sort -uV | tail -1 || true)

say "done: $out ($(du -h "$out" | cut -f1))"
printf '\n'
printf '  requires glibc %s or newer, and webkitgtk-6.0 from the distro\n' "${glibc#GLIBC_}"
printf '  built on: %s\n' "$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}")"
printf '\n'
