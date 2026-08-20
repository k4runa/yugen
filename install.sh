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

# ui/package.json is on vite 8, which refuses to run on anything older - and its
# bundler imports styleText from node:util, an export that is not there before
# 20.19 at all. A distro still shipping node 18 therefore cannot build the ui,
# however much npm's EBADENGINE line makes it look like a warning.
NODE_MIN="20.19.0"
NODE_WANTED="22"
NVM_VERSION="v0.40.1"

# set when nvm is the thing that provided node, so the closing message can say
# that the new node lives in the shell rc and not on PATH yet
NODE_FROM_NVM=0

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

# yes unless the answer starts with n. No tty means no answer was possible, and
# stopping there would strand `curl ... | bash` on a question nobody ever saw.
confirm() {
    local reply
    reply=$(ask "$1 [Y/n]: ")
    case "$reply" in
        n*|N*) return 1 ;;
        *)     return 0 ;;
    esac
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

node_version() {
    have node || return 1
    node -v 2>/dev/null | sed 's/^v//'
}

# the ui is the only part that needs a current node, but it is also the first
# thing built, so an old one burns the whole run before the compiler even starts
node_ok() {
    local v
    v=$(node_version) || return 1
    [ -n "$v" ] && version_ge "$v" "$NODE_MIN"
}

# 18.19.1+dfsg-6ubuntu2 -> 18.19.1
apt_node_candidate() {
    apt-cache policy nodejs 2>/dev/null \
        | awk '/Candidate:/ { print $2 }' \
        | sed -e 's/^[0-9]*://' -e 's/[-+~].*$//'
}

# debian and ubuntu freeze node for the life of a release - 24.04 is still on 18
# - while the others track it closely enough to be worth asking for
distro_node_is_current() {
    case "$1" in
        debian)
            local cand
            cand=$(apt_node_candidate)
            [ -n "$cand" ] && version_ge "$cand" "$NODE_MIN"
            ;;
        *) return 0 ;;
    esac
}

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

# glib is named outright even though webkitgtk drags it in anyway: src/mpris.cpp
# asks pkg-config for gio-2.0 by hand, and a distro that splits the .pc file out
# of the webkit dev package would otherwise fail at configure time.
#
# webkit2gtk-4.1 is deliberately absent: `ldd` on the binary shows only
# libwebkitgtk-6.0 and libjavascriptcoregtk-6.0, the 4.1 series is a different
# library that nothing here loads. git is in every list because the clone below
# needs it on a machine that has never built anything.
install_deps() {
    local distro="$1"
    local node_pkgs=(nodejs npm)

    # Two separate reasons to leave node out of this list. Its version may be too
    # old to build the ui at all, and its npm package hard-depends on its nodejs,
    # so asking for both on a machine that already has a newer node from anywhere
    # else is exactly what produces apt's "held broken packages" wall.
    # ensure_node() deals with whatever is left over.
    if node_ok; then
        info "Node $(node_version) is already installed, leaving the package manager out of it"
        node_pkgs=()
    elif ! distro_node_is_current "$distro"; then
        warn "This distro's node package is older than $NODE_MIN and cannot build the ui"
        node_pkgs=()
    fi

    info "Installing build and runtime dependencies for $distro..."

    case "$distro" in
        arch)
            need_root pacman -S --needed --noconfirm \
                base-devel git cmake ninja pkgconf "${node_pkgs[@]}" \
                taglib curl webkitgtk-6.0 glib2 ffmpeg python-pipx
            ;;
        debian)
            need_root apt-get update
            apt_install "${node_pkgs[@]}" \
                build-essential git cmake ninja-build pkg-config \
                libtag1-dev libcurl4-openssl-dev libwebkitgtk-6.0-dev \
                libglib2.0-dev ffmpeg pipx
            ;;
        fedora)
            need_root dnf install -y \
                git cmake ninja-build gcc-c++ pkgconf-pkg-config "${node_pkgs[@]}" \
                taglib-devel libcurl-devel webkitgtk6.0-devel \
                glib2-devel ffmpeg pipx
            ;;
        suse)
            need_root zypper install -y \
                git cmake ninja gcc-c++ pkg-config "${node_pkgs[@]}" \
                taglib-devel libcurl-devel webkitgtk-6.0-devel \
                glib2-devel ffmpeg python3-pipx
            ;;
        *)
            die "Unsupported distro. Install manually: git, cmake, ninja, a C++23 compiler, pkg-config, nodejs, npm, taglib, libcurl, glib2, webkitgtk-6.0, ffmpeg"
            ;;
    esac

    ok "System packages installed"
}

# apt fails as a unit: one unsatisfiable package takes the whole command down
# with it, so a half-migrated node blocks dependencies that have nothing to do
# with node. Clearing that out and going again is the only way through.
apt_install() {
    if need_root apt-get install -y "$@"; then
        return 0
    fi

    warn "apt could not satisfy that set of packages."
    info "That is almost always a node installed from outside the distro fighting the distro's npm."
    if purge_distro_node && need_root apt-get install -y "$@"; then
        return 0
    fi

    err "Could not install the build dependencies."
    die "Repair apt first (sudo apt-get -f install), then run this again."
}

# npm, node-* and libnode* all hang off the distro's own nodejs. A nodejs from
# NodeSource or nvm satisfies none of them, so they have to go rather than be
# upgraded - apt will not do that by itself, it just reports broken packages.
purge_distro_node() {
    have dpkg-query || return 1

    local stale
    stale=$(dpkg-query -W -f '${db:Status-Status} ${binary:Package}\n' \
                nodejs npm 'libnode*' 'node-*' 2>/dev/null \
            | awk '$1 == "installed" { print $2 }' | tr '\n' ' ')
    stale=${stale% }
    [ -n "$stale" ] || return 0

    warn "These packages have to be removed before a newer node can go in:"
    printf "    %s\n" "$stale"
    confirm "  Remove them?" || return 1

    # deliberately unquoted: the list is meant to split into arguments
    # shellcheck disable=SC2086
    need_root apt-get remove --purge -y $stale || return 1
    need_root apt-get autoremove -y || true
    hash -r 2>/dev/null || true
    ok "Removed the conflicting node packages"
}

# Runs after the distro packages, because on most distros that step is what puts
# node there in the first place.
ensure_node() {
    local distro="$1"

    if node_ok; then
        ok "Node $(node_version) is new enough to build the ui"
        return 0
    fi

    printf "\n"
    if have node; then
        warn "Node $(node_version) is installed, but the ui needs $NODE_MIN or newer."
        info "Vite 8 imports styleText from node:util, which older versions do not export,"
        info "so the build dies with a SyntaxError instead of a version complaint."
    else
        warn "Node is not installed, and the ui cannot be built without it."
    fi

    info "nvm puts Node $NODE_WANTED under your home directory, beside the distro's"
    info "packages rather than on top of them, which is what keeps apt out of this."
    confirm "  Install Node $NODE_WANTED with nvm now?" \
        || die "Install Node $NODE_MIN or newer, then run this again."

    if install_node_nvm; then
        NODE_FROM_NVM=1
        ok "Node $(node_version) via nvm"
        return 0
    fi

    warn "The nvm route did not work. Falling back to a system package."
    if install_node_system "$distro" && node_ok; then
        ok "Node $(node_version)"
        return 0
    fi

    err "Could not get a usable Node onto this machine."
    err "Install Node $NODE_MIN or newer by hand and run this again:"
    printf "    ${BOLD}curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/%s/install.sh | bash${RESET}\n" "$NVM_VERSION"
    printf "    ${BOLD}source ~/.nvm/nvm.sh && nvm install %s${RESET}\n" "$NODE_WANTED"
    exit 1
}

# A node installed by nvm lives in the shell rc, and a non-interactive run of
# this script never reads that. Without this the machine looks like it has no
# node at all and the whole nvm conversation happens a second time.
load_nvm() {
    local dir="${NVM_DIR:-$HOME/.nvm}"
    [ -s "$dir/nvm.sh" ] || return 0
    node_ok && return 0

    set +eu
    export NVM_DIR="$dir"
    # shellcheck disable=SC1091
    . "$dir/nvm.sh" >/dev/null 2>&1
    nvm use node >/dev/null 2>&1 || nvm use --lts >/dev/null 2>&1
    set -eu

    hash -r 2>/dev/null || true
    node_ok && info "Using Node $(node_version) from nvm"
    return 0
}

install_node_nvm() {
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
        info "Installing nvm $NVM_VERSION..."
        fetch "https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh" \
              "$TMP_WORK/nvm-install.sh" || return 1
        # the installer appends to the shell rc, and that is what makes the new
        # node still be there in the next terminal
        bash "$TMP_WORK/nvm-install.sh" || return 1
    fi

    [ -s "$NVM_DIR/nvm.sh" ] || return 1

    info "Installing Node $NODE_WANTED..."
    local rc=0
    # nvm.sh reads variables it never set and returns non-zero for things it
    # treats as routine. Neither of those survives set -eu.
    set +eu
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh"
    nvm install "$NODE_WANTED" && nvm use "$NODE_WANTED"
    rc=$?
    set -eu

    # nvm use rewrote PATH in this shell, so cmake and npm below inherit it
    hash -r 2>/dev/null || true
    [ "$rc" -eq 0 ] && node_ok
}

# Last resort. Every one of these replaces the distro's node instead of living
# next to it, which is the whole reason nvm is tried first.
install_node_system() {
    case "$1" in
        debian)
            purge_distro_node || return 1
            info "Adding the NodeSource repository for Node $NODE_WANTED..."
            fetch "https://deb.nodesource.com/setup_$NODE_WANTED.x" "$TMP_WORK/nodesource.sh" || return 1
            need_root bash "$TMP_WORK/nodesource.sh" || return 1
            # NodeSource's nodejs carries its own npm, so npm is not asked for
            need_root apt-get install -y nodejs || return 1
            ;;
        fedora)
            need_root dnf install -y "nodejs$NODE_WANTED" \
                || need_root dnf module install -y "nodejs:$NODE_WANTED" \
                || return 1
            ;;
        arch)
            need_root pacman -S --needed --noconfirm nodejs npm || return 1
            ;;
        suse)
            need_root zypper install -y "nodejs$NODE_WANTED" || return 1
            ;;
        *)
            return 1
            ;;
    esac

    hash -r 2>/dev/null || true
}

# A failed npm install leaves a half-populated node_modules behind, and a tree
# fetched by a node that has since been replaced is the other thing that breaks
# the build for a reason the error never mentions. One clean retry covers both.
build_ui() {
    local dir="$1"

    info "Building the ui with Node $(node_version)..."
    if ( cd "$dir" && npm_install_deps && npm run build ); then
        return 0
    fi

    warn "The ui build failed. Retrying with a clean node_modules..."
    rm -rf "$dir/node_modules"
    if ( cd "$dir" && npm_install_deps && npm run build ); then
        return 0
    fi

    err "The ui could not be built with Node $(node_version)."
    err "Everything else is in place, so this one is worth reporting:"
    printf "    ${BOLD}https://github.com/%s/issues${RESET}\n" "$REPO"
    exit 1
}

npm_install_deps() {
    # ci is the reproducible one, but it refuses to run at all when the lockfile
    # has drifted from package.json, and that is not a reason to stop
    if [ -f package-lock.json ]; then
        npm ci --no-audit --no-fund && return 0
        warn "npm ci did not work, falling back to npm install"
    fi
    npm install --no-audit --no-fund
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
    build_ui "$src/ui"

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

            load_nvm
            install_deps "$distro"
            ensure_node "$distro"
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

    if [ "$NODE_FROM_NVM" = 1 ]; then
        printf "  Node $NODE_WANTED came from nvm and only exists in this shell so far.\n"
        printf "  Open a new terminal, or run ${BOLD}source ~/.nvm/nvm.sh${RESET}, before using node yourself.\n\n"
    fi
}

main "$@"
