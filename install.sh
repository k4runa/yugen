#!/usr/bin/env bash
#
# Yugen installer. Two paths, and they have deliberately different contracts:
#
#   AppImage      the bundle carries yt-dlp and ffmpeg, so nothing is
#                 installed system-wide and root is never needed. WebKitGTK
#                 stays the host's job and is only checked for.
#   From source   the machine has to become a build host, so the distro
#                 packages, a nightly yt-dlp and ffmpeg all get installed
#
# Works both as ./install.sh and as `curl -sL .../install.sh | bash`.

set -euo pipefail

REPO="k4runa/yugen"
VERSION="v1.0.0"
APPIMAGE_URL="https://github.com/$REPO/releases/download/$VERSION/Yugen-x86_64.AppImage"

# The bundle links against the glibc of whatever machine built it, and glibc is
# the one thing an AppImage can never carry. Keep this in step with what
# packaging/appimage/build.sh reports after a release build.
APPIMAGE_MIN_GLIBC="2.35"

# where the source build lands. assets/yugen.desktop runs plain `yugen`, so
# this only has to be somewhere on PATH - but it has to be the same place every
# time, or old copies pile up and shadow each other.
PREFIX=${PREFIX:-/usr/local}

INSTALL_DIR="$HOME/.local/bin"
LIB_DIR="$HOME/.local/lib/yugen"
DESKTOP_DIR="$HOME/.local/share/applications"
ICON_DIR="$HOME/.local/share/icons/hicolor/256x256/apps"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()  { printf "${CYAN}::${RESET} %s\n" "$*"; }
ok()    { printf "${GREEN}✓${RESET} %s\n" "$*"; }
warn()  { printf "${YELLOW}!${RESET} %s\n" "$*"; }
err()   { printf "${RED}✗${RESET} %s\n" "$*" >&2; }
die()   { err "$*"; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# scratch space for the downloaded bundle, cleaned up however the script ends
TMP_WORK=$(mktemp -d)
trap 'rm -rf "$TMP_WORK"' EXIT

need_root() {
    if have sudo; then
        sudo "$@"
    elif have doas; then
        doas "$@"
    else
        die "sudo or doas is required to install system packages"
    fi
}

# piping the script into bash makes stdin the script itself, so a plain `read`
# would consume the rest of it and return nothing
ask() {
    local prompt="$1" reply=""
    if [ -r /dev/tty ]; then
        read -rp "$prompt" reply < /dev/tty || true
    fi
    printf '%s' "$reply"
}

fetch() {
    local url="$1" out="$2"
    if have curl; then
        curl -fL --retry 3 --progress-bar "$url" -o "$out"
    elif have wget; then
        wget -q --show-progress "$url" -O "$out"
    else
        die "curl or wget is required"
    fi
}

version_ge() { [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" = "$2" ]; }

detect_distro() {
    local id="" like=""
    if [ -r /etc/os-release ]; then
        # a subshell so ID/ID_LIKE do not leak into the rest of the script
        id=$(. /etc/os-release && printf '%s' "${ID:-}")
        like=$(. /etc/os-release && printf '%s' "${ID_LIKE:-}")
    fi

    case "$id" in
        arch|manjaro|endeavouros|garuda|cachyos) echo arch;   return ;;
        ubuntu|debian|linuxmint|pop|zorin)       echo debian; return ;;
        fedora|nobara)                           echo fedora; return ;;
        opensuse*|suse)                          echo suse;   return ;;
    esac

    case "$like" in
        *arch*)   echo arch ;;
        *debian*) echo debian ;;
        *fedora*|*rhel*) echo fedora ;;
        *suse*)   echo suse ;;
        *)        echo unknown ;;
    esac
}

refresh_caches() {
    have update-desktop-database && update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
    have gtk-update-icon-cache && gtk-update-icon-cache -qtf "$HOME/.local/share/icons/hicolor" 2>/dev/null || true
}

write_desktop_entry() {
    local exec_path="$1"
    mkdir -p "$DESKTOP_DIR"
    cat > "$DESKTOP_DIR/yugen.desktop" <<EOF
[Desktop Entry]
Name=Yugen
Comment=Music Player
Exec=$exec_path
Icon=yugen
Type=Application
Categories=Audio;Music;Player;
Keywords=music;player;audio;youtube;soundcloud;
EOF
    ok "Desktop entry written to $DESKTOP_DIR/yugen.desktop"
}

check_path() {
    case ":$PATH:" in
        *":$INSTALL_DIR:"*) ;;
        *)
            warn "$INSTALL_DIR is not on your PATH. Add this to your shell config:"
            printf "    ${BOLD}export PATH=\"%s:\$PATH\"${RESET}\n" "$INSTALL_DIR"
            ;;
    esac
}

# ---------------------------------------------------------------- appimage --

# The AppImage carries yt-dlp and ffmpeg. WebKitGTK is not in there - it
# hardcodes the path to its helper processes, so a bundled copy cannot be found
# without mounting it over that path - and it is one distro package away.
check_appimage_host() {
    local glibc=""
    glibc=$(getconf GNU_LIBC_VERSION 2>/dev/null | awk '{print $2}') || true
    [ -n "$glibc" ] || glibc=$(ldd --version 2>/dev/null | head -1 | awk '{print $NF}') || true

    if [ -n "$glibc" ] && ! version_ge "$glibc" "$APPIMAGE_MIN_GLIBC"; then
        err "This system has glibc $glibc, the AppImage needs $APPIMAGE_MIN_GLIBC or newer."
        err "glibc cannot be bundled. Choose the build-from-source option instead."
        exit 1
    fi

    # saying so here is the whole point: without it the app dies at startup with
    # a message about a child process that explains nothing
    if ! pkg-config --exists webkitgtk-6.0 2>/dev/null \
       && ! ls /usr/lib*/libwebkitgtk-6.0.so.* >/dev/null 2>&1 \
       && ! ls /usr/lib/*/libwebkitgtk-6.0.so.* >/dev/null 2>&1; then
        warn "WebKitGTK 6.0 does not look installed. yugen will not start without it:"
        case "$(detect_distro)" in
            arch)   printf "    ${BOLD}sudo pacman -S webkitgtk-6.0${RESET}\n" ;;
            debian) printf "    ${BOLD}sudo apt install libwebkitgtk-6.0-4${RESET}\n" ;;
            fedora) printf "    ${BOLD}sudo dnf install webkitgtk6.0${RESET}\n" ;;
            suse)   printf "    ${BOLD}sudo zypper install libwebkitgtk-6_0-4${RESET}\n" ;;
            *)      printf "    install your distro's webkitgtk-6.0 package\n" ;;
        esac
        printf "\n"
    fi
}

install_appimage() {
    check_appimage_host

    local tmp="$TMP_WORK"

    info "Downloading Yugen $VERSION..."
    fetch "$APPIMAGE_URL" "$tmp/yugen.AppImage"
    chmod +x "$tmp/yugen.AppImage"

    mkdir -p "$INSTALL_DIR" "$ICON_DIR"

    # the icon comes out of the bundle so the launcher entry is not blank.
    # --appimage-extract is handled by the runtime itself and needs no fuse.
    ( cd "$tmp" && ./yugen.AppImage --appimage-extract \
        'usr/share/icons/hicolor/256x256/apps/yugen.png' >/dev/null 2>&1 ) || true
    if [ -f "$tmp/squashfs-root/usr/share/icons/hicolor/256x256/apps/yugen.png" ]; then
        cp "$tmp/squashfs-root/usr/share/icons/hicolor/256x256/apps/yugen.png" "$ICON_DIR/yugen.png"
    fi

    if have fusermount3 || have fusermount; then
        mv "$tmp/yugen.AppImage" "$INSTALL_DIR/yugen"
        ok "Installed to $INSTALL_DIR/yugen"
    else
        # no fuse, and installing it would mean root. Unpacking the bundle costs
        # disk instead and behaves identically.
        info "FUSE is missing, unpacking the bundle instead..."
        rm -rf "$LIB_DIR"
        mkdir -p "$LIB_DIR"
        ( cd "$tmp" && ./yugen.AppImage --appimage-extract >/dev/null )
        mv "$tmp/squashfs-root"/* "$LIB_DIR/"

        cat > "$INSTALL_DIR/yugen" <<EOF
#!/bin/sh
exec "$LIB_DIR/AppRun" "\$@"
EOF
        chmod +x "$INSTALL_DIR/yugen"
        ok "Unpacked to $LIB_DIR, launcher at $INSTALL_DIR/yugen"
    fi

    write_desktop_entry "$INSTALL_DIR/yugen"
    refresh_caches
    check_path
}

# ------------------------------------------------------------------ source --

# webkit2gtk-4.1 is deliberately absent: `ldd` on the binary shows only
# libwebkitgtk-6.0 and libjavascriptcoregtk-6.0, the 4.1 series is a different
# library that nothing here loads. git is in every list because the clone below
# needs it on a machine that has never built anything.
install_deps() {
    local distro="$1"
    info "Installing build and runtime dependencies for $distro..."

    case "$distro" in
        arch)
            need_root pacman -S --needed --noconfirm \
                base-devel git cmake ninja pkgconf nodejs npm \
                taglib curl webkitgtk-6.0 ffmpeg python-pipx
            ;;
        debian)
            need_root apt-get update
            need_root apt-get install -y \
                build-essential git cmake ninja-build pkg-config nodejs npm \
                libtag1-dev libcurl4-openssl-dev libwebkitgtk-6.0-dev \
                ffmpeg pipx
            ;;
        fedora)
            need_root dnf install -y \
                git cmake ninja-build gcc-c++ pkgconf-pkg-config nodejs npm \
                taglib-devel libcurl-devel webkitgtk6.0-devel \
                ffmpeg pipx
            ;;
        suse)
            need_root zypper install -y \
                git cmake ninja gcc-c++ pkg-config nodejs npm \
                taglib-devel libcurl-devel webkitgtk-6.0-devel \
                ffmpeg python3-pipx
            ;;
        *)
            die "Unsupported distro. Install manually: git, cmake, ninja, a C++23 compiler, pkg-config, nodejs, npm, taglib, libcurl, webkitgtk-6.0, ffmpeg"
            ;;
    esac

    ok "System packages installed"
}

install_ytdlp() {
    if have yt-dlp; then
        info "Upgrading yt-dlp..."
    else
        info "Installing yt-dlp..."
        if have pipx; then
            pipx install yt-dlp
        elif have pip; then
            pip install yt-dlp --break-system-packages
        else
            die "Neither pipx nor pip is available, cannot install yt-dlp"
        fi
    fi

    # extractors break whenever youtube changes something, so the nightly
    # channel is the one that keeps downloads working
    yt-dlp --update-to nightly || warn "Could not switch yt-dlp to the nightly channel"

    ok "yt-dlp ready: $(yt-dlp --version 2>/dev/null || echo unknown)"
}

build_from_source() {
    local src cleanup=""

    # when the script sits in a checkout, build that. Piped through bash it does
    # not, so fall back to cloning.
    src=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)
    if [ -z "$src" ] || [ ! -f "$src/CMakeLists.txt" ]; then
        src=$(mktemp -d)/yugen
        cleanup=$src
        info "Cloning $REPO..."
        git clone --depth 1 "https://github.com/$REPO.git" "$src"
    else
        info "Building the checkout at $src"
    fi

    # saucer_embed() globs ui/dist while cmake configures, so the bundle has to
    # exist before the backend is configured
    info "Building the ui..."
    ( cd "$src/ui" && npm install && npm run build )

    info "Building yugen..."
    # the prefix has to be spelled out. Without it cmake reuses whatever is
    # cached in an existing build tree, and installing to a different prefix
    # than last time leaves two binaries on PATH with the stale one winning.
    cmake -S "$src" -B "$src/build" -G Ninja \
        -DCMAKE_BUILD_TYPE=Release \
        -DCMAKE_INSTALL_PREFIX="$PREFIX"

    cmake --build "$src/build" --parallel

    info "Installing to $PREFIX..."
    # CMakeLists installs the binary, assets/yugen.desktop and all six icon
    # sizes, so there is no desktop entry to write by hand here
    need_root cmake --install "$src/build"

    have update-desktop-database && need_root update-desktop-database "$PREFIX/share/applications" 2>/dev/null || true
    have gtk-update-icon-cache && need_root gtk-update-icon-cache -qtf "$PREFIX/share/icons/hicolor" 2>/dev/null || true

    # the desktop entry runs plain `yugen`, so an older copy sitting on an
    # earlier PATH entry would keep being the one that starts
    hash -r 2>/dev/null || true
    local found
    found=$(command -v yugen || true)
    if [ -n "$found" ] && [ "$found" != "$PREFIX/bin/yugen" ]; then
        warn "$found comes first on your PATH and is not the copy just installed."
        warn "Remove it so the new one is the one that runs:"
        printf "    ${BOLD}sudo rm %s${RESET}\n" "$found"
    fi

    [ -n "$cleanup" ] && rm -rf "$(dirname "$cleanup")"

    ok "Installed to $PREFIX/bin/yugen"
}

# -------------------------------------------------------------------- main --

usage() {
    cat <<EOF
Usage: install.sh [--appimage|--source]

  --appimage   Download the bundle. No packages installed, no root.
  --source     Install the toolchain and dependencies, then build and install.

With no argument the script asks.
EOF
}

main() {
    local mode="${1:-}"

    case "$mode" in
        -h|--help) usage; exit 0 ;;
        --appimage) mode=1 ;;
        --source)   mode=2 ;;
        "")         mode="" ;;
        *)          usage; exit 1 ;;
    esac

    printf "\n${BOLD}  ▶ Yugen Installer${RESET}\n\n"

    if [ -z "$mode" ]; then
        printf "  ${BOLD}1)${RESET} AppImage — nothing installed system-wide, needs webkitgtk-6.0\n"
        printf "  ${BOLD}2)${RESET} Build from source — installs dependencies, needs root\n\n"
        mode=$(ask "  Choose [1/2]: ")
        printf "\n"
    fi

    case "$mode" in
        2)
            local distro
            distro=$(detect_distro)
            info "Detected distro family: $distro"
            [ "$distro" = unknown ] && die "Could not identify this distro, install the dependencies manually"

            install_deps "$distro"
            install_ytdlp
            build_from_source
            ;;
        1|"")
            install_appimage
            ;;
        *)
            die "Invalid choice: $mode"
            ;;
    esac

    printf "\n${GREEN}${BOLD}  Done!${RESET} Run ${BOLD}yugen${RESET} to start.\n\n"
}

main "$@"
