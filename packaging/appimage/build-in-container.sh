#!/usr/bin/env bash
#
# Runs build.sh inside an old base image.
#
# An AppImage inherits the glibc of whatever machine built it, and glibc is the
# one library that cannot be bundled. Building on a rolling distro therefore
# produces something that only runs on rolling distros. This puts the floor on
# a release base instead.
#
#   ./packaging/appimage/build-in-container.sh
#
# Ubuntu 24.04 is as old as this can go: 22.04 and Debian 12 only ship the gtk3
# webkit2gtk-4.1 series, and saucer v8 wants webkitgtk-6.0. That sets the floor
# at glibc 2.39, which covers Ubuntu 24.04+, Debian 13+, Fedora 40+ and the
# rolling distros.

set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
IMAGE=${IMAGE:-docker.io/library/ubuntu:24.04}

# saucer-embed sets policy CMP0174, which arrived in 3.31, and the base image
# carries 3.28. Kitware's own tarball is the least invasive way to get past it.
CMAKE_VERSION=${CMAKE_VERSION:-3.31.6}


if [ -n "${ENGINE:-}" ]; then
    engine=$ENGINE
elif command -v podman >/dev/null; then
    engine=podman
elif command -v docker >/dev/null; then
    engine=docker
else
    echo "error: podman or docker is required" >&2
    exit 1
fi

# The ui bundle is plain static output and needs a much newer node than the base
# image carries, so it is built on the host and only reused in here.
if [ ! -f "$root/ui/dist/index.html" ]; then
    echo "error: no ui bundle - run 'npm run build' in ui/ first" >&2
    exit 1
fi

exec "$engine" run --rm \
    -v "$root:/src" \
    -w /src \
    -e YUGEN_SKIP_UI=1 \
    -e CXX=g++-14 \
    -e APPIMAGE_EXTRACT_AND_RUN=1 \
    -e CMAKE_VERSION="$CMAKE_VERSION" \
    "$IMAGE" \
    bash -euc '
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -qq
        apt-get install -y -qq --no-install-recommends \
            ca-certificates curl xz-utils file git \
            build-essential g++-14 ninja-build pkg-config \
            libtag1-dev libcurl4-openssl-dev \
            libwebkitgtk-6.0-dev libgtk-4-dev libadwaita-1-dev libjson-glib-dev \
            libglib2.0-dev libgdk-pixbuf-2.0-dev \
            desktop-file-utils

        # the base image ships gcc 13, which has no <print>. std::println is
        # used throughout the backend.
        update-alternatives --install /usr/bin/g++ g++ /usr/bin/g++-14 100

        curl -fL --retry 3 -o /tmp/cmake.tar.gz \
            "https://github.com/Kitware/CMake/releases/download/v$CMAKE_VERSION/cmake-$CMAKE_VERSION-linux-x86_64.tar.gz"
        mkdir -p /opt/cmake
        tar -xzf /tmp/cmake.tar.gz -C /opt/cmake --strip-components=1
        export PATH=/opt/cmake/bin:$PATH
        cmake --version | head -1

        exec ./packaging/appimage/build.sh
    '
